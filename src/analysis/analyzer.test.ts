import { afterAll, beforeAll, expect, test } from 'bun:test';

const { sqlite } = await import('../db/client');
const { initializeDatabase } = await import('../db/setup');
const { RecordingAnalyzer } = await import('./analyzer');
const { ensureTitleColumns, markTitleEdited } = await import('../library/title-state');

const recordingId = crypto.randomUUID();
let previousConfig: string | null = null, previousKey: string | null = null;
const setting = (key: string) => (sqlite.query('SELECT value FROM user_settings WHERE key=?').get(key) as { value: string } | null)?.value ?? null;
const put = (key: string, value: string | null) => value === null ? sqlite.query('DELETE FROM user_settings WHERE key=?').run(key)
  : sqlite.query('INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
beforeAll(() => {
  initializeDatabase();
  previousConfig = setting('aiConfig'); previousKey = setting('openaiApiKey');
  put('aiConfig', JSON.stringify({ analysisProvider: 'openai' })); put('openaiApiKey', 'synthetic-key');
  sqlite.query("INSERT INTO recordings(id,file_path,original_filename,recording_type,status) VALUES(?,?,?,'meeting','complete')").run(recordingId, '/missing.wav', 'Standup.wav');
  sqlite.query('INSERT INTO transcripts(id,recording_id,full_text) VALUES(?,?,?)').run(crypto.randomUUID(), recordingId, 'Alice will send the report.');
});
afterAll(() => {
  sqlite.query('DELETE FROM recordings WHERE id=?').run(recordingId);
  put('aiConfig', previousConfig); put('openaiApiKey', previousKey);
});

test('summaries record provider, model, reported usage and timing, and return them for cached results (AI-09)', async () => {
  const analyzer = new RecordingAnalyzer((async () => Response.json({ model: 'gpt-4.1-mini-2025', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: { overview: 'Report due.', keyPoints: ['Alice sends report'] }, extractedTasks: [{ title: 'Send report', context: 'Alice will send the report.' }] }) } }], usage: { prompt_tokens: 40, completion_tokens: 20 } })) as unknown as typeof fetch);
  const result = await analyzer.analyze(recordingId, true);
  expect(result.provenance).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini-2025', usage: { prompt_tokens: 40, completion_tokens: 20 }, fallbackFrom: [] });
  expect(result.provenance!.completedAt).toBeString();
  const stored = sqlite.query('SELECT provenance FROM analyses WHERE recording_id=?').get(recordingId) as { provenance: string };
  expect(JSON.parse(stored.provenance).provider).toBe('openai');
  expect((await analyzer.analyze(recordingId)).provenance).toEqual(result.provenance!);
});

const titled = (title: string) => new RecordingAnalyzer((async () => Response.json({ model: 'gpt-4.1-mini', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title, summary: { overview: 'Report due.', keyPoints: [] }, extractedTasks: [] }) } }] })) as unknown as typeof fetch);
const row = () => sqlite.query('SELECT original_filename AS name, revision FROM recordings WHERE id=?').get(recordingId) as { name: string; revision: number };

test('auto title replaces the import filename once, even after the transcript save bumped the revision', async () => {
  ensureTitleColumns(sqlite);
  // As in a real import: saving the transcript already raised the revision before analysis runs.
  sqlite.query('UPDATE recordings SET original_filename=?, revision=2, title_edited=0, auto_titled_at=NULL WHERE id=?').run('Standup.wav', recordingId);
  await titled('Laporan mingguan').analyze(recordingId, true);
  expect(row()).toEqual({ name: 'Standup.wav', revision: 2 });
  await titled('# Laporan mingguan').analyze(recordingId, true, { autoTitle: true });
  expect(row()).toEqual({ name: 'Laporan mingguan.wav', revision: 3 });
  // A second analysis never renames again.
  await titled('Judul lain').analyze(recordingId, true, { autoTitle: true });
  expect(row().name).toBe('Laporan mingguan.wav');
});

test('auto title never replaces a title the person typed', async () => {
  ensureTitleColumns(sqlite);
  sqlite.query('UPDATE recordings SET original_filename=?, revision=4, title_edited=0, auto_titled_at=NULL WHERE id=?').run('Rapat direksi.wav', recordingId);
  markTitleEdited(sqlite, recordingId);
  await titled('Judul dari AI').analyze(recordingId, true, { autoTitle: true });
  expect(row().name).toBe('Rapat direksi.wav');
});
