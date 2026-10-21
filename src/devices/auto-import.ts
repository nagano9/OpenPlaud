import type { Database } from 'bun:sqlite';
import { sourceRecordingId, type RecordingSourceDriver } from './driver';

/**
 * Opt-in polling import for one Bluetooth driver. A recording is imported only after two
 * observations with the same size, so recordings still in progress are left alone, and a
 * failure backs off exponentially instead of hammering the radio.
 */
export class DeviceAutoImport {
  private running = false;
  private previous = new Map<string, number>();
  private lastChecked: string | null = null;
  private error: string | null = null;
  private failures = 0;
  private retryAt = 0;
  constructor(private database: Database, readonly driver: RecordingSourceDriver, private settingKey = `${driver.id}AutoImport`) {
    database.exec(`CREATE TABLE IF NOT EXISTS plaud_import_events (id INTEGER PRIMARY KEY AUTOINCREMENT, recording_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
    // Events predate other drivers; existing rows belong to Plaud.
    const columns = database.query('PRAGMA table_info(plaud_import_events)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'driver')) database.exec("ALTER TABLE plaud_import_events ADD COLUMN driver TEXT NOT NULL DEFAULT 'plaud'");
  }
  enabled() { return (this.database.query('SELECT value FROM user_settings WHERE key=?').get(this.settingKey) as { value: string } | null)?.value === 'true'; }
  set(enabled: boolean) {
    if (enabled && !this.driver.configured()) throw new Error(this.driver.notConfiguredMessage);
    this.database.query('INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.settingKey, String(enabled));
    return this.status();
  }
  status() {
    return { driver: this.driver.id, label: this.driver.label, configured: this.driver.configured(), enabled: this.enabled(), running: this.running, lastChecked: this.lastChecked, error: this.error,
      events: this.database.query('SELECT id,recording_id AS recordingId,created_at AS createdAt FROM plaud_import_events WHERE driver=? ORDER BY id DESC LIMIT 10').all(this.driver.id) };
  }
  async tick() {
    if (this.running || !this.enabled() || Date.now() < this.retryAt) return;
    this.running = true;
    try {
      const result = await this.driver.list(); this.lastChecked = result.checkedAt;
      const observed = new Map<string, number>();
      const existing = new Set((this.database.query(
        'SELECT source_recording_id AS sourceId FROM recordings WHERE source_provider=? AND source_recording_id IS NOT NULL',
      ).all(this.driver.provider) as { sourceId: string }[]).map(row => row.sourceId));
      for (const session of result.sessions) {
        const source = sourceRecordingId(result, session); observed.set(source, session.size);
        if (!this.enabled()) break;
        if (session.size <= 512 || this.previous.get(source) !== session.size) continue;
        if (existing.has(source)) continue;
        const imported = await this.driver.import(session.sessionId);
        if (imported.added || imported.recording.sourceRecordingId === source) existing.add(source);
        if (imported.added) this.database.query('INSERT INTO plaud_import_events(recording_id,created_at,driver) VALUES(?,?,?)').run(imported.recording.id, new Date().toISOString(), this.driver.id);
      }
      this.previous = observed; this.failures = 0; this.error = null; this.retryAt = 0;
      this.database.query('DELETE FROM plaud_import_events WHERE driver=? AND id NOT IN (SELECT id FROM plaud_import_events WHERE driver=? ORDER BY id DESC LIMIT 100)').run(this.driver.id, this.driver.id);
    } catch (e) {
      this.error = e instanceof Error ? e.message : `${this.driver.label} automatic import unavailable.`;
      this.retryAt = Date.now() + Math.min(15 * 60000, 30000 * 2 ** Math.min(this.failures++, 5));
    } finally { this.running = false; }
  }
}
