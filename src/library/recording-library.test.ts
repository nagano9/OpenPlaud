import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';

const testRoot = mkdtempSync(join(tmpdir(), 'openplod-library-'));
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousLibraryPath = process.env.OPENPLOD_LIBRARY_PATH;
const previousPairingToken = process.env.OPENPLOD_PAIRING_TOKEN;
process.env.DATABASE_URL = join(testRoot, 'library.db');
process.env.OPENPLOD_LIBRARY_PATH = join(testRoot, 'vault');
process.env.OPENPLOD_PAIRING_TOKEN = 'test-pairing-token';

const { db, sqlite } = await import('../db/client');
const { initializeDatabase } = await import('../db/setup');
const { recordings, transcripts, transcriptVersions } = await import('../db/schema');
const {
  importRecordingFile,
  purgeRecording,
  purgeExpiredTrash,
  restoreRecording,
  softDeleteRecording,
  updateTranscript,
} = await import('./recording-library');
const { default: mobileApi } = await import('../api/mobile');
const { default: recordingsApi } = await import('../api/recordings');
const { default: transcriptsApi } = await import('../api/transcripts');
const { saveGeneratedTranscript } = await import('./transcript-history');
const { FolderWatcher } = await import('../sync/folder-watcher');

beforeAll(() => initializeDatabase());

afterAll(() => {
  // The database client is shared by every test file in this process, and whichever file
  // imports it first fixes its path. Closing it or deleting its folder here breaks the files
  // that run afterwards, so the temporary vault is left for the OS to clean up.
  restoreEnv('DATABASE_URL', previousDatabaseUrl);
  restoreEnv('OPENPLOD_LIBRARY_PATH', previousLibraryPath);
  restoreEnv('OPENPLOD_PAIRING_TOKEN', previousPairingToken);
});

describe('recording library', () => {
  test('lists transcript documents with Plaud provenance and excludes Trash', async () => {
    const sourcePath = join(testRoot, 'markdown-document.ogg');
    writeFileSync(sourcePath, 'transcript-library-audio');
    const imported = await importRecordingFile({ sourcePath, provenance: {
      sourceProvider: 'plaud', sourceTransport: 'mobile', sourceRecordingId: 'device-document',
    } });
    await db.insert(transcripts).values({ recordingId: imported.recording.id, fullText: '# Field notes\n\nActual text', wordCount: 5 });
    const listed = await transcriptsApi.request('/?source=plaud');
    expect(await listed.json()).toMatchObject({ data: [expect.objectContaining({
      recordingId: imported.recording.id, sourceProvider: 'plaud', excerpt: '# Field notes\n\nActual text', wordCount: 5,
    })], pagination: { hasMore: false } });
    expect(await (await transcriptsApi.request('/?source=opennotes')).json()).toMatchObject({ data: [] });
    await softDeleteRecording(imported.recording.id);
    expect(await (await transcriptsApi.request('/?source=plaud')).json()).toMatchObject({ data: [] });
    await restoreRecording(imported.recording.id);
    expect(await (await transcriptsApi.request('/?source=plaud&offset=1')).json()).toMatchObject({ data: [] });
  });

  test('discovers nested Plaud exports, including converted formats, and ignores non-audio files', async () => {
    const exportRoot = join(testRoot, 'plaud-exports');
    const nested = join(exportRoot, '2026-09-05_voice-note');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(exportRoot, 'meeting.M4A'), 'audio-one');
    writeFileSync(join(nested, 'voice-note.opus'), 'audio-three');
    writeFileSync(join(nested, 'voice-note.wav'), 'audio-two');
    writeFileSync(join(nested, 'cover.jpg'), 'image');
    writeFileSync(join(exportRoot, 'metadata.json'), '{}');

    const recordings = await new FolderWatcher(exportRoot).listRecordings();

    expect(recordings.map(recording => recording.filename).sort()).toEqual([
      'meeting.M4A',
      'voice-note.opus',
      'voice-note.wav',
    ]);
    expect(recordings.every(recording => recording.size > 0)).toBe(true);
  });

  test('reports a missing Plaud export folder as not configured', async () => {
    const watcher = new FolderWatcher(join(testRoot, 'missing-plaud-folder'));

    expect(watcher.isConfigured()).toBe(false);
    expect(await watcher.listRecordings()).toEqual([]);
    expect(await watcher.getStatus()).toMatchObject({ configured: false, recordingCount: 0 });
  });

  test('deduplicates imports by content fingerprint and provider id', async () => {
    const firstPath = join(testRoot, 'first.m4a');
    const sameAudioPath = join(testRoot, 'same-audio.m4a');
    const sameProviderPath = join(testRoot, 'same-provider.m4a');
    writeFileSync(firstPath, 'audio-one');
    writeFileSync(sameAudioPath, 'audio-one');
    writeFileSync(sameProviderPath, 'different-audio');

    const first = await importRecordingFile({
      sourcePath: firstPath,
      provenance: {
        sourceProvider: 'plaud',
        sourceRecordingId: 'plaud-1',
        sourceTransport: 'folder',
      },
    });
    const fingerprintDuplicate = await importRecordingFile({
      sourcePath: sameAudioPath,
      provenance: { sourceProvider: 'plaud', sourceTransport: 'folder' },
    });
    const providerDuplicate = await importRecordingFile({
      sourcePath: sameProviderPath,
      provenance: {
        sourceProvider: 'plaud',
        sourceRecordingId: 'plaud-1',
        sourceTransport: 'folder',
      },
    });

    expect(first.added).toBe(true);
    expect(fingerprintDuplicate).toMatchObject({ added: false, recording: { id: first.recording.id } });
    expect(providerDuplicate).toMatchObject({ added: false, recording: { id: first.recording.id } });
  });

  test('versions transcript edits without replacing their provenance', async () => {
    const sourcePath = join(testRoot, 'transcript.m4a');
    writeFileSync(sourcePath, 'transcript-audio');
    const imported = await importRecordingFile({
      sourcePath,
      provenance: { sourceProvider: 'upload', sourceTransport: 'upload' },
    });
    await db.insert(transcripts).values({
      recordingId: imported.recording.id,
      fullText: 'Generated text',
      wordCount: 2,
    });

    await updateTranscript({ recordingId: imported.recording.id, fullText: 'User corrected text' });

    const [current] = await db.select().from(transcripts)
      .where(eq(transcripts.recordingId, imported.recording.id));
    const versions = await db.select().from(transcriptVersions)
      .where(eq(transcriptVersions.recordingId, imported.recording.id));
    expect(current.fullText).toBe('User corrected text');
    expect(current.wordCount).toBe(3);
    expect(versions).toHaveLength(2);
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ fullText: 'Generated text', origin: 'generated' }),
      expect.objectContaining({ fullText: 'User corrected text', origin: 'edited' }),
    ]));
    const regenerated = saveGeneratedTranscript({ recordingId: imported.recording.id, fullText: 'Regenerated text',
      segments: [], wordCount: 2, speakerCount: 1, confidence: 1 });
    expect(regenerated).toBe(false);
    expect((await db.select().from(transcripts).where(eq(transcripts.recordingId, imported.recording.id)))[0])
      .toMatchObject({ fullText: 'User corrected text', origin: 'edited' });
    expect(await db.select().from(transcriptVersions).where(eq(transcriptVersions.recordingId, imported.recording.id)))
      .toHaveLength(3);
    const generated = { recordingId: imported.recording.id, fullText: 'Provider text', segments: [], wordCount: 2, speakerCount: null, confidence: null,
      generationId: crypto.randomUUID(), fingerprint: imported.recording.fingerprint, provenance: { provider: 'openai', model: 'whisper-1', usage: null } };
    saveGeneratedTranscript(generated); saveGeneratedTranscript(generated);
    expect(await db.select().from(transcriptVersions).where(eq(transcriptVersions.recordingId, imported.recording.id))).toHaveLength(4);
    expect(() => saveGeneratedTranscript({ ...generated, generationId: crypto.randomUUID(), fingerprint: 'wrong' })).toThrow('Audio changed');
    await softDeleteRecording(imported.recording.id);
    expect(() => saveGeneratedTranscript({ ...generated, generationId: crypto.randomUUID() })).toThrow('Trash');
    await restoreRecording(imported.recording.id);
    const stale = await recordingsApi.request(`/${imported.recording.id}/transcript`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullText: 'Stale edit', revision: 1 }),
    });
    expect(stale.status).toBe(409);
    const malformed = await recordingsApi.request(`/${imported.recording.id}/transcript`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullText: 42 }),
    });
    expect(malformed.status).toBe(400);
  });

  test('soft deletes, restores, and purges expired trash with its audio', async () => {
    const sourcePath = join(testRoot, 'retention.m4a');
    writeFileSync(sourcePath, 'retention-audio');
    const imported = await importRecordingFile({
      sourcePath,
      provenance: { sourceProvider: 'upload', sourceTransport: 'upload' },
    });

    expect(await softDeleteRecording(imported.recording.id)).toBe(true);
    expect(await restoreRecording(imported.recording.id)).toBe(true);
    expect(await softDeleteRecording(imported.recording.id)).toBe(true);
    await db.update(recordings).set({ deletedAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(recordings.id, imported.recording.id));

    expect(await purgeExpiredTrash(new Date('2026-02-01T00:00:00.000Z'))).toBe(1);
    expect(await Bun.file(imported.recording.filePath).exists()).toBe(false);
    expect(await db.select().from(recordings).where(eq(recordings.id, imported.recording.id))).toEqual([]);
  });

  test('requires explicit confirmation before permanently purging audio', async () => {
    const sourcePath = join(testRoot, 'confirmed-purge.m4a');
    writeFileSync(sourcePath, 'confirmed-purge-audio');
    const imported = await importRecordingFile({
      sourcePath,
      provenance: { sourceProvider: 'upload', sourceTransport: 'upload' },
    });
    await softDeleteRecording(imported.recording.id);

    const rejected = await recordingsApi.request(`/${imported.recording.id}?permanent=true`, {
      method: 'DELETE',
    });
    expect(rejected.status).toBe(400);
    expect(await Bun.file(imported.recording.filePath).exists()).toBe(true);

    const confirmed = await recordingsApi.request(
      `/${imported.recording.id}?permanent=true&confirm=true`,
      { method: 'DELETE' },
    );
    expect(confirmed.status).toBe(200);
    expect(await Bun.file(imported.recording.filePath).exists()).toBe(false);
  });

  test('lists recordings by collection, and a purge removes collection membership (KB-01)', async () => {
    const { RecordingCollections } = await import('../knowledge/collections');
    const collections = new RecordingCollections(sqlite);
    const ids: string[] = [];
    for (const name of ['collection-a.m4a', 'collection-b.m4a']) {
      const sourcePath = join(testRoot, name);
      writeFileSync(sourcePath, `${name}-audio`);
      ids.push((await importRecordingFile({ sourcePath, provenance: { sourceProvider: 'upload', sourceTransport: 'upload' } })).recording.id);
    }
    const collection = collections.create({ name: `Library ${crypto.randomUUID()}` });
    collections.add(collection.id, { recordingIds: [ids[0]], revision: 1 });
    const listed = await (await recordingsApi.request(`/?collection=${collection.id}`)).json() as { data: { id: string; collectionIds: string[] }[]; pagination: { total: number } };
    expect(listed.data.map(row => row.id)).toEqual([ids[0]]);
    expect(listed.data[0].collectionIds).toEqual([collection.id]);
    expect(listed.pagination.total).toBe(1);
    expect((await recordingsApi.request('/?collection=not-a-uuid')).status).toBe(400);
    await softDeleteRecording(ids[0]);
    expect(((await (await recordingsApi.request(`/?collection=${collection.id}`)).json()) as { data: unknown[] }).data).toEqual([]);
    expect(collections.get(collection.id).recordingCount).toBe(0);
    await recordingsApi.request(`/${ids[0]}?permanent=true&confirm=true`, { method: 'DELETE' });
    expect(collections.membership([ids[0]]).size).toBe(0);
  });

  test('reprocess honours Idempotency-Key and reports the job (KB-06)', async () => {
    const sourcePath = join(testRoot, 'idempotent-reprocess.m4a');
    writeFileSync(sourcePath, 'idempotent-reprocess-audio');
    const { recording } = await importRecordingFile({ sourcePath, provenance: { sourceProvider: 'upload', sourceTransport: 'upload' } });
    const send = (key: string, body = '') => recordingsApi.request(`/${recording.id}/reprocess`, { method: 'POST', headers: { 'Idempotency-Key': key }, body });
    const first = await (await send('reprocess-key-1')).json() as { data: { jobId: string; replayed: boolean } };
    expect(first.data.replayed).toBe(false);
    const again = await (await send('reprocess-key-1')).json() as { data: { jobId: string; state: string; replayed: boolean } };
    expect(again.data).toEqual({ jobId: first.data.jobId, state: 'pending', replayed: true });
    const conflict = await send('reprocess-key-1', JSON.stringify({ transcriptionLanguage: 'fr' }));
    expect(conflict.status).toBe(409);
    expect((await send('reprocess-key-2')).status).toBe(409);
    expect((await recordingsApi.request(`/${crypto.randomUUID()}/reprocess`, { method: 'POST' })).status).toBe(404);
    expect((await recordingsApi.request(`/${recording.id}/reprocess`, { method: 'POST', body: '{"chatProvider":"openai"}' })).status).toBe(400);
  });
});

describe('mobile pairing', () => {
  test('validates audio bytes before durable acknowledgement and preserves duration', async () => {
    const sourceId = '881-test:1788589200';
    const content = 'native-note-pro-audio';
    const fingerprint = createHash('sha256').update(content).digest('hex');
    const first = await uploadPlaud({ content, fingerprint, sourceId });
    const payload = await first.json() as { data: { recordingId: string; fingerprint: string } };
    expect(first.status).toBe(201);
    expect(payload.data.fingerprint).toBe(fingerprint);
    const [stored] = await db.select().from(recordings).where(eq(recordings.id, payload.data.recordingId));
    expect(stored.durationSeconds).toBe(14);
    expect(await Bun.file(stored.filePath).text()).toBe(content);
    const retry = await uploadPlaud({ content, fingerprint, sourceId });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ data: { recordingId: stored.id, added: false } });
  });

  test('rejects corrupted uploads without inserting a recording', async () => {
    const sourceId = '881-test:corrupt';
    const response = await uploadPlaud({ content: 'corrupted', fingerprint: 'a'.repeat(64), sourceId });
    expect(response.status).toBe(409);
    expect(await db.select().from(recordings).where(eq(recordings.sourceRecordingId, sourceId))).toHaveLength(0);
  });

  test('rejects a reused device ID with different audio without overwriting the vault', async () => {
    const sourceId = '881-test:conflict';
    const fingerprint = createHash('sha256').update('original').digest('hex');
    const first = await uploadPlaud({ content: 'original', fingerprint, sourceId });
    const payload = await first.json() as { data: { recordingId: string } };
    const changed = await uploadPlaud({ content: 'different', fingerprint: createHash('sha256').update('different').digest('hex'), sourceId });
    expect(changed.status).toBe(409);
    const [stored] = await db.select().from(recordings).where(eq(recordings.id, payload.data.recordingId));
    expect(await Bun.file(stored.filePath).text()).toBe('original');
  });

  test('rejects empty audio and malformed fingerprints', async () => {
    expect((await uploadPlaud({ content: '', fingerprint: 'a'.repeat(64), sourceId: 'empty' })).status).toBe(400);
    expect((await uploadPlaud({ content: 'audio', fingerprint: 'invalid', sourceId: 'invalid' })).status).toBe(400);
  });

  test('rejects missing or invalid pairing tokens', async () => {
    const missing = await mobileApi.request('/health');
    const invalid = await mobileApi.request('/health', {
      headers: { 'X-OpenPlod-Token': 'wrong' },
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  test('accepts the configured pairing token', async () => {
    const response = await mobileApi.request('/health', {
      headers: { 'X-OpenPlod-Token': 'test-pairing-token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { vault: 'ready' } });
  });

  test('returns a durable recording id after storing a mobile capture', async () => {
    const body = new FormData();
    body.append('file', new File(['mobile-audio'], 'phone-note.webm', { type: 'audio/webm' }));
    body.append('source_provider', 'opennotes');
    body.append('recorded_at', '2026-09-05T08:30:00.000Z');
    body.append('context', 'Captured from the phone');

    const response = await mobileApi.request('/recordings', {
      method: 'POST',
      headers: { 'X-OpenPlod-Token': 'test-pairing-token' },
      body,
    });
    const payload = await response.json() as {
      success: boolean;
      data: { recordingId: string; added: boolean };
    };

    expect(response.status).toBe(201);
    expect(payload.success).toBe(true);
    expect(payload.data.added).toBe(true);
    expect(payload.data.recordingId).toBeString();
    const [stored] = await db.select().from(recordings)
      .where(eq(recordings.id, payload.data.recordingId));
    expect(stored).toMatchObject({
      sourceProvider: 'opennotes',
      sourceTransport: 'mobile',
      context: 'Captured from the phone',
    });
    expect(await Bun.file(stored.filePath).exists()).toBe(true);
  });
});

function uploadPlaud(input: { content: string; fingerprint: string; sourceId: string }) {
  const body = new FormData();
  body.append('file', new File([input.content], 'note-pro.mp3', { type: 'audio/mpeg' }));
  body.append('source_provider', 'plaud');
  body.append('source_recording_id', input.sourceId);
  body.append('fingerprint', input.fingerprint);
  body.append('duration_ms', '14000');
  return mobileApi.request('/recordings', {
    method: 'POST', headers: { 'X-OpenPlod-Token': 'test-pairing-token' }, body,
  });
}

describe('atomic import and complete purge (REL-03, REL-04)', () => {
test('sidecars are committed with the recording and the journal is cleared', async () => {
  const source = join(testRoot, 'atomic-source.m4a'), device = join(testRoot, 'atomic-device.plaud');
  writeFileSync(source, `atomic-${Date.now()}`); writeFileSync(device, 'device bytes');
  const sidecars = [{ name: 'device-original.plaud', sourcePath: device }, { name: 'provenance.json', data: '{"ok":true}' }];
  const result = await importRecordingFile({ sourcePath: source, provenance: { sourceProvider: 'plaud', sourceTransport: 'ble', sourceRecordingId: `SN9:${Date.now()}` }, sidecars });
  expect(result.added).toBe(true);
  const originals = join(testRoot, 'vault', 'originals', result.recording.id);
  expect(readFileSync(join(originals, 'device-original.plaud'), 'utf8')).toBe('device bytes');
  expect(readFileSync(join(originals, 'provenance.json'), 'utf8')).toBe('{"ok":true}');
  expect(sqlite.query('SELECT count(*) AS n FROM import_journal').get()).toEqual({ n: 0 });
  expect(readdirSync(join(testRoot, 'vault', '.staging'))).toEqual([]);
  // A duplicate import never replaces existing evidence.
  writeFileSync(device, 'different');
  const again = await importRecordingFile({ sourcePath: source, provenance: { sourceProvider: 'plaud', sourceTransport: 'ble' }, sidecars });
  expect(again.added).toBe(false);
  expect(readFileSync(join(originals, 'device-original.plaud'), 'utf8')).toBe('device bytes');

  expect(await softDeleteRecording(result.recording.id)).toBe(true);
  expect(await purgeRecording(result.recording.id)).toBe(true);
  expect(existsSync(originals)).toBe(false);
  expect(existsSync(result.recording.filePath)).toBe(false);
  expect(sqlite.query('SELECT reason FROM recording_purges WHERE recording_id=?').get(result.recording.id)).toEqual({ reason: 'manual' });
});

test('a failed import leaves no partial vault files and keeps the source', async () => {
  const source = join(testRoot, 'atomic-bad.m4a');
  writeFileSync(source, `bad-${Date.now()}`);
  await expect(importRecordingFile({ sourcePath: source, provenance: { sourceProvider: 'upload', sourceTransport: 'upload' },
    sidecars: [{ name: '../escape', data: 'x' }] })).rejects.toThrow('Invalid sidecar name');
  expect(existsSync(source)).toBe(true);
  const files = readdirSync(join(testRoot, 'vault')).filter(name => name.endsWith('.m4a'));
  expect(sqlite.query('SELECT count(*) AS n FROM import_journal').get()).toEqual({ n: 0 });
  expect(files.every(name => sqlite.query('SELECT 1 FROM recordings WHERE file_path=?').get(join(testRoot, 'vault', name)))).toBe(true);
});
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
