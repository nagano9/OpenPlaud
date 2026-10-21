import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { sqlite } = await import('../db/client');
const { initializeDatabase } = await import('../db/setup');
const { BluetoothInbox } = await import('./bluetooth-inbox');

const root = mkdtempSync(join(tmpdir(), 'openplod-bt-inbox-'));
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold the folder */ } });
initializeDatabase();

const ffmpeg = Bun.spawnSync(['ffmpeg', '-version']).exitCode === 0;

test('a received phone recording is converted, imported as a Bluetooth file and queued once', async () => {
  if (!ffmpeg) return;
  const queued: string[] = [];
  const inbox = new BluetoothInbox(sqlite, async ({ recordingId }) => { queued.push(recordingId); });
  const amr = join(root, 'Voice 001.3gp');
  expect(Bun.spawnSync(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb', amr]).exitCode === 0
    || Bun.spawnSync(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-f', '3gp', amr]).exitCode === 0).toBe(true);
  const id = await inbox.importFile(amr);
  expect(id).toBeString();
  const row = sqlite.query('SELECT original_filename AS name, source_provider AS provider, source_transport AS transport FROM recordings WHERE id=?').get(id!) as Record<string, string>;
  expect(row).toEqual({ name: 'Voice 001.m4a', provider: 'device', transport: 'bluetooth-file' });
  expect(queued).toEqual([id!]);
  // The same file again is a duplicate, not a second recording.
  expect(await inbox.importFile(amr)).toBeNull();
});

test('settings reject a relative folder and report the configured path', async () => {
  const inbox = new BluetoothInbox(sqlite, async () => undefined);
  await expect(inbox.configure({ path: 'relative/folder' })).rejects.toThrow('absolute');
  const folder = join(root, 'inbox');
  const status = await inbox.configure({ path: folder, enabled: false });
  expect(status).toMatchObject({ enabled: false, watching: false, path: folder });
});

test('unsupported files are ignored', async () => {
  const inbox = new BluetoothInbox(sqlite, async () => undefined);
  const text = join(root, 'notes.txt'); writeFileSync(text, 'hello');
  await expect(inbox.importFile(text)).rejects.toThrow();
});
