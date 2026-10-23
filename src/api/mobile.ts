import { Hono, type Context } from 'hono';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sqlite } from '../db/client';
import { importRecordingFile, RecordingImportConflict, safeFilename } from '../library/recording-library';
import { offerTranscript, queueRecordingProcessing, type ProvidedTranscript } from '../library/processing';
import { jobQueue } from '../jobs/queue';
import { PlaudDeviceAuth, readDeviceCredentials } from '../sync/plaud-device-auth';
import { ClientNotFound, type ClientPermission } from '../sync/mobile-clients';
import { MobileUploads, UploadError, MAX_CHUNK_BYTES } from '../sync/mobile-uploads';
import { ChangeFeed, CursorExpired } from '../sync/change-feed';
import { allows, credentialsConfigured, isAdmin, mobileClients, principalKey, principalOf, type Principal } from './access';

const app = new Hono();
const deviceAuth = new PlaudDeviceAuth();
let uploadsStore: MobileUploads | null = null;
const uploads = () => uploadsStore ??= new MobileUploads(sqlite, {
  onImported: recording => queueRecordingProcessing({ recordingId: recording.id, filePath: recording.filePath }),
});
let feedStore: ChangeFeed | null = null;
const feed = () => feedStore ??= new ChangeFeed(sqlite);

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const principal = principalOf(c);
  if (!principal || principal.kind === 'open') {
    // Mobile routes always require pairing, even on an otherwise open development server.
    if (!credentialsConfigured()) return c.json({ success: false, error: 'Mobile pairing is not configured.' }, 503);
    return c.json({ success: false, code: 'unauthorized', error: 'Invalid pairing token.' }, 401);
  }
  c.set('principal', principal);
  await next();
});

const caller = (c: Context): Principal => c.get('principal');
function forbidden(c: Context, permission: ClientPermission | 'admin') {
  return c.json({ success: false, code: 'forbidden', error: permission === 'admin'
    ? 'Manage paired devices from the desktop app.'
    : `This paired device does not have ${permission} access.` }, 403);
}
function markSynced(principal: Principal) {
  if (principal.kind === 'client') mobileClients().markSynced(principal.client.id);
}

app.get('/health', c => c.json({ success: true, data: { vault: 'ready' } }));

app.post('/plaud/session', async c => {
  try {
    return c.json({ success: true, data: await deviceAuth.session(await readDeviceCredentials()) });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Plaud SDK authentication failed.' }, 503);
  }
});

// ---------------------------------------------------------------------------
// Paired clients (MOB-06). Only the desktop manages clients; a client may read and name itself.
// ---------------------------------------------------------------------------

app.get('/clients/me', c => {
  const principal = caller(c);
  if (principal.kind !== 'client') return c.json({ success: true, data: { kind: principal.kind } });
  return c.json({ success: true, data: { kind: 'client', ...mobileClients().get(principal.client.id) } });
});

app.patch('/clients/me', async c => {
  const principal = caller(c);
  if (principal.kind !== 'client') return c.json({ success: false, error: 'Only a paired device has a client record.' }, 400);
  const body = await c.req.json().catch(() => ({})) as { name?: unknown; platform?: unknown };
  try { return c.json({ success: true, data: mobileClients().update(principal.client.id, { name: body.name, platform: body.platform }) }); }
  catch (error) { return c.json({ success: false, error: (error as Error).message }, 400); }
});

app.use('/clients', async (c, next) => isAdmin(caller(c)) ? next() : forbidden(c, 'admin'));
app.use('/clients/*', async (c, next) => c.req.path.endsWith('/clients/me') || isAdmin(caller(c)) ? next() : forbidden(c, 'admin'));

app.get('/clients', c => {
  // The legacy row exists only once used; show it whenever the global token can still pair.
  if (process.env.OPENPLOD_PAIRING_TOKEN) mobileClients().ensureLegacy(process.env.OPENPLOD_PAIRING_TOKEN);
  return c.json({ success: true, data: mobileClients().list() });
});

app.post('/clients', async c => {
  const body = await c.req.json().catch(() => ({})) as { name?: unknown; platform?: unknown; permissions?: unknown };
  try { return c.json({ success: true, data: mobileClients().create(body) }, 201); }
  catch (error) { return c.json({ success: false, error: (error as Error).message }, 400); }
});

function clientError(c: Context, error: unknown) {
  return c.json({ success: false, error: (error as Error).message }, error instanceof ClientNotFound ? 404 : 400);
}

app.patch('/clients/:id', async c => {
  const body = await c.req.json().catch(() => ({})) as { name?: unknown; permissions?: unknown };
  try { return c.json({ success: true, data: mobileClients().update(c.req.param('id'), { name: body.name, permissions: body.permissions }) }); }
  catch (error) { return clientError(c, error); }
});

app.post('/clients/:id/revoke', c => {
  try { return c.json({ success: true, data: mobileClients().revoke(c.req.param('id')) }); }
  catch (error) { return clientError(c, error); }
});

app.post('/clients/:id/rotate', c => {
  try { return c.json({ success: true, data: mobileClients().rotate(c.req.param('id')) }); }
  catch (error) { return clientError(c, error); }
});

// ---------------------------------------------------------------------------
// Resumable uploads (MOB-02). Transfers are scoped to the calling client (MOB-05).
// ---------------------------------------------------------------------------

app.use('/uploads', async (c, next) => allows(caller(c), 'upload') ? next() : forbidden(c, 'upload'));
app.use('/uploads/*', async (c, next) => allows(caller(c), 'upload') ? next() : forbidden(c, 'upload'));
app.use('/recordings', async (c, next) => allows(caller(c), 'upload') ? next() : forbidden(c, 'upload'));

function uploadError(c: Context, error: unknown) {
  if (error instanceof UploadError) {
    if (error.offset !== undefined) c.header('Upload-Offset', String(error.offset));
    return c.json({ success: false, code: error.code, error: error.message, data: error.offset === undefined ? undefined : { offset: error.offset } }, error.status);
  }
  throw error;
}

app.post('/uploads', async c => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ success: false, error: 'A JSON body is required.' }, 400);
  try {
    const state = await uploads().create(principalKey(caller(c)), body);
    c.header('Upload-Offset', String(state.offset));
    return c.json({ success: true, data: state }, state.offset === 0 && state.state === 'open' ? 201 : 200);
  } catch (error) { return uploadError(c, error); }
});

async function transferStatus(c: Context) {
  try {
    const state = await uploads().status(principalKey(caller(c)), c.req.param('id')!);
    c.header('Upload-Offset', String(state.offset));
    return c.json({ success: true, data: state });
  } catch (error) { return uploadError(c, error); }
}
app.get('/uploads/:id', transferStatus);

app.put('/uploads/:id', async c => {
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > MAX_CHUNK_BYTES) return c.json({ success: false, code: 'chunk_too_large', error: 'Chunk exceeds the maximum chunk size.' }, 413);
  try {
    const body = new Uint8Array(await c.req.arrayBuffer());
    const state = await uploads().append(principalKey(caller(c)), c.req.param('id'), {
      contentRange: c.req.header('Content-Range'), chunkSha256: c.req.header('X-Chunk-SHA256'), body,
    });
    c.header('Upload-Offset', String(state.offset));
    return c.json({ success: true, data: state });
  } catch (error) { return uploadError(c, error); }
});

app.post('/uploads/:id/complete', async c => {
  const principal = caller(c);
  try {
    const ack = await uploads().complete(principalKey(principal), c.req.param('id'));
    markSynced(principal);
    return c.json({ success: true, data: ack }, ack.added ? 201 : 200);
  } catch (error) { return uploadError(c, error); }
});

app.delete('/uploads/:id', async c => {
  try { return c.json({ success: true, data: await uploads().cancel(principalKey(caller(c)), c.req.param('id')) }); }
  catch (error) { return uploadError(c, error); }
});

// Single-request upload, kept for clients that predate resumable transfers.
app.post('/recordings', async c => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ success: false, error: 'Audio file is required.' }, 400);
  if (!file.size) return c.json({ success: false, error: 'Audio file is empty.' }, 400);
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : undefined;
  if (fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(fingerprint)) {
    return c.json({ success: false, error: 'A SHA-256 fingerprint is required.' }, 400);
  }
  const durationMs = body.duration_ms === undefined ? undefined : Number(body.duration_ms);
  if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 0)) {
    return c.json({ success: false, error: 'Invalid recording duration.' }, 400);
  }
  const libraryPath = process.env.OPENPLOD_LIBRARY_PATH;
  const incomingDir = libraryPath ? resolve(dirname(libraryPath), 'incoming') : resolve('./data/incoming');
  mkdirSync(incomingDir, { recursive: true });
  const incomingPath = resolve(incomingDir, `${crypto.randomUUID()}-${safeFilename(file.name)}`);
  await Bun.write(incomingPath, file);
  try {
    const result = await importRecordingFile({
      sourcePath: incomingPath,
      originalFilename: safeFilename(file.name),
      expectedFingerprint: fingerprint,
      provenance: {
        sourceProvider: body.source_provider === 'plaud' ? 'plaud' : 'opennotes',
        sourceRecordingId: typeof body.source_recording_id === 'string' ? body.source_recording_id : null,
        sourceTransport: 'mobile',
        recordedAt: typeof body.recorded_at === 'string' ? body.recorded_at : null,
      },
      metadata: {
        durationMs,
        context: typeof body.context === 'string' ? body.context : null,
        recordingType: typeof body.recording_type === 'string' ? body.recording_type : undefined,
      },
    });
    if (result.added) {
      await queueRecordingProcessing({
        recordingId: result.recording.id,
        filePath: result.recording.filePath,
      });
    }
    markSynced(caller(c));
    return c.json({
      success: true,
      data: { recordingId: result.recording.id, fingerprint: result.recording.fingerprint, added: result.added },
    }, result.added ? 201 : 200);
  } catch (error) {
    if (error instanceof RecordingImportConflict) return c.json({ success: false, error: error.message }, 409);
    throw error;
  } finally {
    await Bun.file(incomingPath).delete().catch(() => undefined);
  }
});

/**
 * The phone transcribed a recording with its own API key. Sent before the audio; when the audio
 * arrives (or is already here without a transcript), the vault stores this text instead of
 * transcribing again.
 */
app.post('/transcripts', async c => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const fingerprint = typeof body?.fingerprint === 'string' ? body.fingerprint : '';
  const fullText = typeof body?.fullText === 'string' ? body.fullText : '';
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return c.json({ success: false, error: 'A SHA-256 fingerprint is required.' }, 400);
  if (!fullText.trim() || fullText.length > 2_000_000) return c.json({ success: false, error: 'Transcript text is required.' }, 400);
  const segments = (Array.isArray(body?.segments) ? body.segments : []).flatMap(item => {
    const segment = item as Record<string, unknown>;
    return typeof segment?.text === 'string' && Number.isFinite(segment.start) && Number.isFinite(segment.end)
      ? [{ start: Number(segment.start), end: Number(segment.end), text: segment.text }] : [];
  }).slice(0, 20_000);
  const text = (value: unknown) => typeof value === 'string' && value ? value.slice(0, 80) : null;
  const duration = Number(body?.durationSeconds);
  const transcript: ProvidedTranscript = { fullText, segments, provider: text(body?.provider) ?? 'openai', model: text(body?.model),
    language: text(body?.language), durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null };
  offerTranscript(fingerprint, transcript);
  // Audio that reached the vault earlier (Bluetooth sync, a failed transcription) gets it now.
  const waiting = sqlite.query(`SELECT r.id, r.file_path AS filePath FROM recordings r LEFT JOIN transcripts t ON t.recording_id = r.id
    WHERE r.fingerprint = ? AND r.retention_state = 'active' AND t.id IS NULL`).get(fingerprint) as { id: string; filePath: string } | null;
  const attached = Boolean(waiting && !jobQueue.activeJob('process-recording', waiting.id));
  if (waiting && attached) await queueRecordingProcessing({ recordingId: waiting.id, filePath: waiting.filePath });
  return c.json({ success: true, data: { attached } });
});

// ---------------------------------------------------------------------------
// Synchronization (MOB-04): change feed, tombstones, and revision-checked metadata push.
// ---------------------------------------------------------------------------

app.get('/changes', c => {
  const principal = caller(c);
  if (!allows(principal, 'sync') || !allows(principal, 'read')) return forbidden(c, 'sync');
  try {
    const page = feed().changes(c.req.query('since'), Number(c.req.query('limit') ?? 200));
    markSynced(principal);
    return c.json({ success: true, data: page });
  } catch (error) {
    if (error instanceof CursorExpired) return c.json({ success: false, code: 'cursor_expired', error: error.message }, 410);
    throw error;
  }
});

app.post('/changes', async c => {
  const principal = caller(c);
  if (!allows(principal, 'sync') || !allows(principal, 'write')) return forbidden(c, 'sync');
  const body = await c.req.json().catch(() => null) as { changes?: unknown } | null;
  try {
    const results = feed().push(principalKey(principal), body?.changes);
    markSynced(principal);
    return c.json({ success: true, data: { results, cursor: String(feed().head()) } });
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 400);
  }
});

export default app;
