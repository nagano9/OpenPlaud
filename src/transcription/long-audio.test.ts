import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chunkPlan, mergeChunks, transcribeChunks, type AudioSplitter, type LongCheckpoint, type StoredChunk } from './long-audio';
import { runTranscription } from './job-runner';
import type { TranscriptionRouter } from './router';
import type { TranscriptionOptions, TranscriptionResult } from './types';
import { aiConfigSchema } from '../ai/config';

const ok = (segments: TranscriptionResult['segments'], extra: Partial<TranscriptionResult> = {}): TranscriptionResult => ({ success: true, engine: 'openai', fullText: segments.map(s => s.text).join(' '), segments, wordCount: 0, speakerCount: null, confidence: null, duration: 0, metadata: { model: 'whisper-1', usage: null }, ...extra });
const splitter = (log: string[] = [], duration: number | null = null): AudioSplitter => ({
  probe: async () => duration,
  extract: async (_path, start, length, output) => { log.push(`${start}+${length}`); await Bun.write(output, 'chunk'); },
});

test('chunks only when the provider limit or configured duration requires it, with overlap', () => {
  expect(chunkPlan('openai', { durationSeconds: 3600, fileBytes: 20_000_000, chunkAboveMinutes: 0 })).toBeNull();
  expect(chunkPlan('whisper', { durationSeconds: 3600, fileBytes: 900_000_000, chunkAboveMinutes: 0 })).toBeNull();
  expect(chunkPlan('openai', { durationSeconds: 1500, fileBytes: 30_000_000, chunkAboveMinutes: 0 })).toEqual([
    { index: 0, start: 0, duration: 602 }, { index: 1, start: 600, duration: 602 }, { index: 2, start: 1200, duration: 300 }]);
  expect(chunkPlan('whisper', { durationSeconds: 1300, fileBytes: 1000, chunkAboveMinutes: 20 })).toHaveLength(3);
  expect(chunkPlan('openai', { durationSeconds: null, fileBytes: 30_000_000, chunkAboveMinutes: 0 })).toBeNull();
});

test('merge offsets times and drops overlap speech instead of duplicating it', () => {
  const plan = [{ index: 0, start: 0, duration: 12 }, { index: 1, start: 10, duration: 12 }, { index: 2, start: 20, duration: 5 }];
  const chunk = (index: number, segments: StoredChunk['segments'], usage: Record<string, number> | null = { seconds: 10 }): StoredChunk => ({ index, engine: 'openai', fullText: '', segments, duration: 10, confidence: null, metadata: { model: 'whisper-1', language: 'en', usage } });
  const merged = mergeChunks(plan, [
    chunk(0, [{ start: 0, end: 5, text: 'one two', confidence: null }, { start: 5, end: 11, text: 'three four', confidence: null }]),
    // Starts at 10 s (offset), before the kept end of 11 s: the duplicate of "three four" is dropped.
    chunk(1, [{ start: 0, end: 1.5, text: 'four', confidence: null }, { start: 1.5, end: 9, text: 'five six', confidence: null },
      // Ends in the next overlap; trimmed at word level there.
      { start: 9, end: 11.5, text: 'seven eight', confidence: null }]),
    chunk(2, [{ start: 0, end: 1.5, text: 'seven eight nine', confidence: null, words: [{ start: 0, end: 0.5, text: 'seven' }, { start: 0.6, end: 1.2, text: 'eight' }, { start: 1.6, end: 2, text: 'nine' }] }]),
  ], 25);
  expect(merged.fullText).toBe('one two three four five six seven eight nine');
  expect(merged.segments.map(s => [s.start, s.end])).toEqual([[0, 5], [5, 11], [11.5, 19], [19, 21.5], [21.6, 22]]);
  expect(merged.segments.at(-1)!.words).toEqual([{ start: 21.6, end: 22, text: 'nine' }]);
  expect(merged).toMatchObject({ duration: 25, speakerCount: null, metadata: { usage: { seconds: 30 }, language: 'en', chunking: { chunks: 3, chunkSeconds: 10, overlapSeconds: 2 } } });
  expect(mergeChunks(plan, [chunk(0, [], null), chunk(1, [])], 20).metadata!.usage).toBeNull();
});

test('chunked transcription checkpoints each chunk and resumes after completed ones', async () => {
  const plan = chunkPlan('openai', { durationSeconds: 1500, fileBytes: 30_000_000, chunkAboveMinutes: 0 })!;
  const saved: LongCheckpoint[] = [], calls: string[] = [], log: string[] = [];
  let failAt = 1;
  const transcribe = async (path: string, options: TranscriptionOptions) => {
    calls.push(path.split(/[\\/]/).at(-1)!); options.onCheckpoint?.({ phase: 'submitting' });
    if (calls.length - 1 === failAt) return { ...ok([]), success: false, error: 'HTTP 500' };
    return ok([{ start: 0, end: 3, text: `chunk ${calls.length}`, confidence: null }]);
  };
  const base = { save: (c: LongCheckpoint) => saved.push(structuredClone(c)), local: false, provider: 'openai' };
  const failed = await transcribeChunks(transcribe, '/audio.mp3', plan, 1500, base, splitter(log));
  expect(failed.success).toBe(false); expect(failed.error).toContain('Chunk 2 of 3 failed'); expect(failed.error).toContain('1 earlier chunk was kept');
  expect(saved.find(c => c.phase === 'submitting')?.inFlight).toBe(true);
  const resumeFrom = saved.filter(c => c.phase === 'chunk-done').at(-1)!;
  expect(resumeFrom).toMatchObject({ inFlight: false, progress: { done: 1, total: 3 } });
  calls.length = 0; failAt = -1; log.length = 0;
  const resumed = await transcribeChunks(transcribe, '/audio.mp3', plan, 1500, { ...base, checkpoint: resumeFrom }, splitter(log));
  expect(resumed.success).toBe(true); expect(calls).toEqual(['chunk-1.mp3', 'chunk-2.mp3']); expect(log).toEqual(['600+602', '1200+300']);
  expect(resumed.segments.map(s => s.start)).toEqual([0, 600, 1200]);
});

test('a chunk with a known remote job resumes polling, and providers without timestamps are refused', async () => {
  const plan = chunkPlan('assemblyai', { durationSeconds: 700, fileBytes: 200_000_000, chunkAboveMinutes: 0 })!;
  const seen: (string | undefined)[] = [];
  const checkpoint: LongCheckpoint = { phase: 'polling', remoteId: 'remote-1', inFlight: true, chunks: { plan, results: [{ index: 0, engine: 'assemblyai', fullText: 'a', segments: [{ start: 0, end: 1, text: 'a', confidence: null }], duration: 600, confidence: null, metadata: {} }] } };
  const result = await transcribeChunks(async (_path, options) => { seen.push(options.checkpoint?.remoteId); return ok([{ start: 0, end: 1, text: 'b', confidence: null }]); }, '/a.wav', plan, 700, { checkpoint, save: () => {}, local: false, provider: 'assemblyai' }, splitter());
  expect(seen).toEqual(['remote-1']); expect(result.fullText).toBe('a b');
  const textOnly = await transcribeChunks(async () => ok([], { fullText: 'no times' }), '/a.wav', plan, 700, { save: () => {}, local: false, provider: 'openai' }, splitter());
  expect(textOnly.error).toContain('no timestamps');
});

test('splitting failures are retryable and cancellation stops before the next chunk', async () => {
  const plan = chunkPlan('openai', { durationSeconds: 1500, fileBytes: 30_000_000, chunkAboveMinutes: 0 })!;
  const broken: AudioSplitter = { probe: async () => 1500, extract: async () => { throw new Error('ffmpeg missing'); } };
  const error = await transcribeChunks(async () => ok([]), '/a.mp3', plan, 1500, { save: () => {}, local: false, provider: 'openai' }, broken).catch(e => e);
  expect(error.retryable).toBe(true); expect(error.message).toContain('Nothing was sent');
  const controller = new AbortController(); let calls = 0;
  await expect(transcribeChunks(async () => { calls++; controller.abort(); return ok([{ start: 0, end: 1, text: 'x', confidence: null }]); }, '/a.mp3', plan, 1500, { signal: controller.signal, save: () => {}, local: false, provider: 'openai' }, splitter())).rejects.toThrow();
  expect(calls).toBe(1);
});

function runnerDb(config: object) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT); CREATE TABLE recordings(id TEXT PRIMARY KEY, duration_seconds INTEGER, file_path TEXT, file_size_bytes INTEGER)');
  db.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('aiConfig', JSON.stringify(config));
  db.query('INSERT INTO recordings VALUES(?,?,?,?)').run('rec', 1500, '/missing.mp3', 30_000_000);
  return db;
}
const fakeRouter = (calls: string[]) => {
  const router = { transcribeFile: async (path: string, options: TranscriptionOptions) => { calls.push(path); options.onCheckpoint?.({ phase: 'submitting' }); return ok([{ start: 0, end: 2, text: 'hi', confidence: null }], { metadata: { model: 'whisper-1', usage: { seconds: 2 } } }); }, primaryOnly: () => router };
  return router as unknown as TranscriptionRouter;
};

test('runner blocks over-threshold work before sending, then chunks and records the ledger once confirmed', async () => {
  const settings = { transcriptionEngine: 'openai', transcriptionModel: 'whisper-1', confirmAboveUsd: 0.05 };
  const db = runnerDb(settings), config = aiConfigSchema.parse(settings), calls: string[] = [], checkpoints: LongCheckpoint[] = [];
  const run = { jobId: 'job-1', recordingId: 'rec', filePath: '/missing.mp3', config, options: { model: 'whisper-1' }, signal: new AbortController().signal, saveCheckpoint: (c: LongCheckpoint) => checkpoints.push(c) };
  await expect(runTranscription(db, fakeRouter(calls), run, splitter())).rejects.toThrow('Cost confirmation required');
  expect(calls).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='ai_spend_ledger'").get() && db.query('SELECT COUNT(*) AS n FROM ai_spend_ledger').get()).toMatchObject({ n: 0 });
  const result = await runTranscription(db, fakeRouter(calls), { ...run, costConfirmed: true }, splitter());
  expect(calls).toHaveLength(3); expect(result.success).toBe(true);
  expect(result.metadata).toMatchObject({ chunking: { chunks: 3 }, usage: { seconds: 6 } });
  expect(checkpoints.at(-1)).toMatchObject({ progress: { done: 3, total: 3 }, inFlight: false });
  expect(db.query('SELECT status, estimated_usd AS usd, units FROM ai_spend_ledger').get()).toEqual({ status: 'complete', usd: 0.1504, units: 1504 });
  db.close();
});

test('runner refuses chunking that would drop requested speaker labels', async () => {
  const settings = { transcriptionEngine: 'openai' };
  const db = runnerDb(settings), calls: string[] = [];
  const result = await runTranscription(db, fakeRouter(calls), { jobId: 'job-2', recordingId: 'rec', filePath: '/missing.mp3', config: aiConfigSchema.parse(settings), options: { diarize: true }, signal: new AbortController().signal, saveCheckpoint: () => {} }, splitter());
  expect(result.success).toBe(false); expect(result.error).toContain('Speaker labels'); expect(calls).toEqual([]);
  expect(db.query('SELECT status FROM ai_spend_ledger').get()).toEqual({ status: 'not-sent' });
  db.close();
});

test('runner sends a clean copy of a WebM recording whose header has no duration', async () => {
  const settings = { transcriptionEngine: 'openai' };
  const db = runnerDb(settings), calls: string[] = [], log: string[] = [];
  db.query('INSERT INTO recordings VALUES(?,?,?,?)').run('web', null, '/browser.webm', 800_000);
  const result = await runTranscription(db, fakeRouter(calls), { jobId: 'job-3', recordingId: 'web', filePath: '/browser.webm', config: aiConfigSchema.parse(settings), options: {}, signal: new AbortController().signal, saveCheckpoint: () => {} }, splitter(log));
  expect(result.success).toBe(true); expect(log).toEqual(['0+86400']);
  expect(calls).toHaveLength(1); expect(calls[0]).toEndWith('audio.mp3');
  expect(await Bun.file(calls[0]).exists()).toBe(false);
  // A WebM file whose duration can be read is sent as stored.
  await runTranscription(db, fakeRouter(calls), { jobId: 'job-4', recordingId: 'web', filePath: '/browser.webm', config: aiConfigSchema.parse(settings), options: {}, signal: new AbortController().signal, saveCheckpoint: () => {} }, splitter(log, 12));
  expect(calls[1]).toBe('/browser.webm');
  db.close();
});
