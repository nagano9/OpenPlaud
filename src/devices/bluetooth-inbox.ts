import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { convertForImport, importRecordingFile, incomingDirectory, isConvertibleAudio, isSupportedAudio } from '../library/recording-library';

export const DEFAULT_BLUETOOTH_INBOX = join(homedir(), 'Documents', 'OpenPlaud Bluetooth');
const STABLE_MS = 3000;

type Queue = (recording: { recordingId: string; filePath: string }) => Promise<unknown>;
export interface InboxEvent { file: string; recordingId: string | null; error: string | null; at: string }

/**
 * Imports audio that a phone sends with the operating system's Bluetooth file transfer
 * (Android: Share → Bluetooth → this computer; Windows saves it to the chosen folder).
 * Files are imported only once their size has stopped changing, phone formats such as
 * AMR, 3GP and Opus are converted to M4A, and the received files are never deleted.
 */
export class BluetoothInbox {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private known = new Map<string, string>();
  private busy = new Set<string>();
  private events: InboxEvent[] = [];

  constructor(private database: Database, private queue: Queue) {
    // Remembered across restarts so a converted file is not converted again on every scan.
    database.exec('CREATE TABLE IF NOT EXISTS bluetooth_inbox_files (path TEXT PRIMARY KEY, stamp TEXT NOT NULL, recording_id TEXT, imported_at TEXT NOT NULL)');
    for (const row of database.query('SELECT path, stamp FROM bluetooth_inbox_files').all() as { path: string; stamp: string }[]) this.known.set(row.path, row.stamp);
  }

  private setting(key: string) { return (this.database.query('SELECT value FROM user_settings WHERE key=?').get(key) as { value: string } | null)?.value; }
  private put(key: string, value: string) { this.database.query('INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  enabled() { return this.setting('bluetoothInboxEnabled') === 'true'; }
  path() {
    const raw = this.setting('bluetoothInboxPath') || DEFAULT_BLUETOOTH_INBOX;
    return resolve(raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw);
  }
  status() { return { enabled: this.enabled(), watching: this.watcher !== null, path: this.path(), events: this.events.slice(0, 10) }; }

  /** Saves the settings and (re)starts watching. The folder is created when enabled. */
  async configure(input: { enabled?: boolean; path?: string }) {
    if (input.path !== undefined) {
      const path = input.path.trim();
      if (path && !/^(~\/|[a-zA-Z]:[\\/]|\/)/.test(path)) throw new Error('Use an absolute folder path.');
      this.put('bluetoothInboxPath', path);
    }
    if (input.enabled !== undefined) this.put('bluetoothInboxEnabled', String(input.enabled));
    this.stop();
    if (this.enabled()) await this.start();
    return this.status();
  }

  async start() {
    if (!this.enabled() || this.watcher) return;
    const folder = this.path();
    mkdirSync(folder, { recursive: true });
    this.watcher = watch(folder, { recursive: true }, (_event, name) => { if (name) this.schedule(join(folder, name.toString())); });
    await this.scan();
  }

  stop() {
    this.watcher?.close(); this.watcher = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Imports every finished file already in the folder (startup, or after enabling). */
  async scan() {
    const folder = this.path();
    if (!existsSync(folder)) return;
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else this.schedule(path);
      }
    };
    await walk(folder);
  }

  private schedule(path: string) {
    if (!isSupportedAudio(path) && !isConvertibleAudio(path)) return;
    clearTimeout(this.timers.get(path));
    this.timers.set(path, setTimeout(() => { this.timers.delete(path); void this.importWhenStable(path); }, STABLE_MS));
  }

  /** Bluetooth writes the file progressively; wait until two looks agree on its size. */
  private async importWhenStable(path: string) {
    if (this.busy.has(path) || !existsSync(path)) return;
    const first = await stat(path).catch(() => null);
    if (!first?.isFile() || first.size === 0) return;
    const stamp = `${first.size}:${first.mtimeMs}`;
    if (this.known.get(path) === stamp) return;
    await new Promise(done => setTimeout(done, STABLE_MS));
    const second = await stat(path).catch(() => null);
    if (!second || second.size !== first.size) { this.schedule(path); return; }
    this.busy.add(path);
    try {
      const recordingId = await this.importFile(path);
      this.known.set(path, stamp);
      this.database.query('INSERT INTO bluetooth_inbox_files(path,stamp,recording_id,imported_at) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET stamp=excluded.stamp, recording_id=excluded.recording_id, imported_at=excluded.imported_at')
        .run(path, stamp, recordingId, new Date().toISOString());
      this.record(path, recordingId);
    }
    catch (error) { this.record(path, null, error instanceof Error ? error.message : String(error)); }
    finally { this.busy.delete(path); }
  }

  /** Imports one received file; returns the recording id, or null when it was already in the vault. */
  async importFile(path: string): Promise<string | null> {
    const convert = isConvertibleAudio(path);
    const staged = convert ? await convertForImport(path, join(incomingDirectory(), 'bluetooth')) : path;
    try {
      const name = convert ? `${basename(path, extname(path))}.m4a` : basename(path);
      const result = await importRecordingFile({ sourcePath: staged, originalFilename: name, provenance: { sourceProvider: 'device', sourceTransport: 'bluetooth-file' } });
      if (!result.added) return null;
      await this.queue({ recordingId: result.recording.id, filePath: result.recording.filePath });
      return result.recording.id;
    } finally { if (convert) await rm(staged, { force: true }); }
  }

  private record(path: string, recordingId: string | null, error: string | null = null) {
    this.events.unshift({ file: basename(path), recordingId, error, at: new Date().toISOString() });
    this.events.length = Math.min(this.events.length, 50);
    if (error) console.error(`[BluetoothInbox] ${basename(path)}: ${error}`);
    else if (recordingId) console.log(`[BluetoothInbox] Imported ${basename(path)} as ${recordingId}`);
  }
}
