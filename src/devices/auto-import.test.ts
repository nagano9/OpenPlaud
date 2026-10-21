import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DeviceAutoImport } from './auto-import';
import { DeviceRegistry } from './registry';
import type { RecordingSourceDriver } from './driver';

test('each driver deduplicates against its own provider and keeps its own events', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE recordings(id TEXT,source_provider TEXT,source_recording_id TEXT)');
  // A Plaud recording with the same source id must not hide the phone's recording.
  db.query("INSERT INTO recordings VALUES('plaud-row','plaud','pixel:1')").run();
  const imports: number[] = [];
  const phone: RecordingSourceDriver = {
    id: 'phone', label: 'Android phone', provider: 'phone', notConfiguredMessage: 'Pair a phone first.', configured: () => true,
    list: async () => ({ serial: 'pixel', checkedAt: new Date().toISOString(), sessions: [{ sessionId: 1, size: 4096 }] }),
    import: async sessionId => { imports.push(sessionId); db.query("INSERT INTO recordings VALUES('phone-row','phone','pixel:1')").run();
      return { added: true, recording: { id: 'phone-row', filePath: 'x', originalFilename: 'x', fingerprint: 'x', sourceRecordingId: 'pixel:1' } }; },
  };
  const registry = new DeviceRegistry();
  const source = registry.register(new DeviceAutoImport(db, phone));
  expect(() => new DeviceAutoImport(db, { ...phone, id: 'off', configured: () => false }).set(true)).toThrow('Pair a phone first.');
  source.set(true);
  await registry.tick(); await registry.tick(); await registry.tick();
  expect(imports).toEqual([1]);
  expect(registry.list()).toEqual([expect.objectContaining({ driver: 'phone', enabled: true, events: [expect.objectContaining({ recordingId: 'phone-row' })] })]);
  expect(db.query("SELECT value FROM user_settings WHERE key='phoneAutoImport'").get()).toEqual({ value: 'true' });
  db.close();
});
