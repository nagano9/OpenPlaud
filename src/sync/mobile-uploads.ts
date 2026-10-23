import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  fingerprintFile, importRecordingFile, incomingDirectory, isImportableAudio, RecordingImportConflict, safeFilename,
  type RecordingProvenance,
} from '../library/recording-library';
import { initializeMobileSync } from './mobile-schema';

/**
 * Byte-offset resumable uploads from paired clients (MOB-02).
 *
 * - `create` returns a stable transfer ID per (client, fingerprint); a retry after a lost response
 *   resumes the same transfer instead of starting another.
 * - Each chunk carries its SHA-256 and must start exactly at the committed offset. It is written,
 *   fsynced, and only then is the offset advanced, so an interruption never commits unseen bytes.
 * - `complete` re-hashes the whole staged file, imports it, and returns the durable
 *   acknowledgement. It is idempotent: once complete, it returns the same acknowledgement.
 * - Every transfer belongs to the client that created it. Other clients get "not found", so one
 *   client cannot read, resume, or cancel another's transfer (MOB-05).
 */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
/** Open transfers untouched for this long are abandoned: their staged bytes are deleted. */
export const UPLOAD_EXPIRY_MS = 48 * 60 * 60 * 1000;
/** Completed transfer records stay this long so a client can re-read its acknowledgement. */
export const COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type UploadMetadata = {
  sourceProvider?: 'plaud' | 'opennotes' | 'upload';
  sourceRecordingId?: string | null;
  recordedAt?: string | null;
  durationMs?: number;
  context?: string | null;
  recordingType?: string;
};

export type TransferState = {
  transferId: string;
  offset: number;
  size: number;
  fingerprint: string;
  state: 'open' | 'complete';
  maxChunkBytes: number;
  recordingId: string | null;
};

export type UploadAcknowledgement = { transferId: string; recordingId: string; fingerprint: string; added: boolean };

export class UploadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 416 | 422, readonly code: string, readonly offset?: number) { super(message); }
}

type UploadRow = {
  id: string; client_id: string; fingerprint: string; size: number; filename: string; metadata: string;
  received_bytes: number; state: string; recording_id: string | null; added: number | null; created_at: string; updated_at: string;
};

const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const current = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}

export function parseMetadata(input: unknown): UploadMetadata {
  const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const text = (key: string, max = 2000) => typeof value[key] === 'string' ? (value[key] as string).slice(0, max) : undefined;
  const durationMs = value.durationMs === undefined || value.durationMs === null ? undefined : Number(value.durationMs);
  if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 0)) throw new UploadError('Invalid recording duration.', 400, 'invalid_metadata');
  const provider = value.sourceProvider;
  return {
    sourceProvider: provider === 'plaud' || provider === 'upload' ? provider : 'opennotes',
    sourceRecordingId: text('sourceRecordingId', 200) ?? null,
    recordedAt: text('recordedAt', 64) ?? null,
    durationMs,
    context: text('context') ?? null,
    recordingType: text('recordingType', 40),
  };
}

export class MobileUploads {
  constructor(
    private readonly sqlite: Database,
    private readonly options: {
      directory?: () => string;
      now?: () => Date;
      /** Called after a new recording is stored; queues processing in the server. */
      onImported?: (recording: { id: string; filePath: string }) => Promise<unknown> | void;
    } = {},
  ) { initializeMobileSync(sqlite); }

  private now() { return this.options.now?.() ?? new Date(); }
  private directory() {
    const directory = this.options.directory?.() ?? join(incomingDirectory(), 'uploads');
    mkdirSync(directory, { recursive: true });
    return directory;
  }
  private stagingPath(row: Pick<UploadRow, 'id' | 'filename'>) {
    return join(this.directory(), `${row.id}${extname(row.filename).toLowerCase()}`);
  }

  private row(clientId: string, id: string): UploadRow {
    const row = this.sqlite.query('SELECT * FROM mobile_uploads WHERE id = ? AND client_id = ?').get(id, clientId) as UploadRow | null;
    if (!row) throw new UploadError('Transfer not found.', 404, 'transfer_not_found');
    return row;
  }

  private state(row: UploadRow, offset = row.received_bytes): TransferState {
    return {
      transferId: row.id, offset, size: row.size, fingerprint: row.fingerprint,
      state: row.state === 'complete' ? 'complete' : 'open', maxChunkBytes: MAX_CHUNK_BYTES, recordingId: row.recording_id,
    };
  }

  /** Committed offset: the database offset, lowered if the staged file is shorter (lost tail). */
  private async committedOffset(row: UploadRow): Promise<number> {
    if (row.state === 'complete') return row.size;
    const path = this.stagingPath(row);
    const length = existsSync(path) ? statSync(path).size : 0;
    if (length >= row.received_bytes) return row.received_bytes;
    this.sqlite.query('UPDATE mobile_uploads SET received_bytes = ?, updated_at = ? WHERE id = ?').run(length, this.now().toISOString(), row.id);
    return length;
  }

  async create(clientId: string, input: { fingerprint?: unknown; size?: unknown; filename?: unknown; metadata?: unknown }): Promise<TransferState> {
    await this.cleanup();
    const fingerprint = typeof input.fingerprint === 'string' ? input.fingerprint.toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new UploadError('A SHA-256 fingerprint is required.', 400, 'invalid_fingerprint');
    const size = Number(input.size);
    if (!Number.isSafeInteger(size) || size <= 0) throw new UploadError('A positive file size is required.', 400, 'invalid_size');
    if (size > MAX_UPLOAD_BYTES) throw new UploadError('The recording exceeds the upload limit.', 413, 'too_large');
    const filename = safeFilename(typeof input.filename === 'string' ? input.filename : '');
    if (!isImportableAudio(filename)) throw new UploadError('The file is not a supported audio format.', 400, 'unsupported_format');
    const metadata = parseMetadata(input.metadata);
    return withLock(`create:${clientId}:${fingerprint}`, async () => {
      const existing = this.sqlite.query(`SELECT * FROM mobile_uploads WHERE client_id = ? AND fingerprint = ? AND state IN ('open', 'complete')
        ORDER BY state = 'complete' DESC, updated_at DESC LIMIT 1`).get(clientId, fingerprint) as UploadRow | null;
      const stillStored = existing?.state !== 'complete' || Boolean(this.sqlite.query('SELECT 1 FROM recordings WHERE id = ?').get(existing.recording_id));
      if (existing && existing.size === size && stillStored) return this.state(existing, await this.committedOffset(existing));
      if (existing && existing.state === 'open') await this.discard(existing);
      const id = crypto.randomUUID();
      const now = this.now().toISOString();
      this.sqlite.query(`INSERT INTO mobile_uploads (id, client_id, fingerprint, size, filename, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, clientId, fingerprint, size, filename, JSON.stringify(metadata), now, now);
      return this.state(this.row(clientId, id), 0);
    });
  }

  async status(clientId: string, id: string): Promise<TransferState> {
    const row = this.row(clientId, id);
    return this.state(row, await this.committedOffset(row));
  }

  async append(clientId: string, id: string, input: { contentRange?: string; chunkSha256?: string; body: Uint8Array }): Promise<TransferState> {
    this.row(clientId, id);
    return withLock(`transfer:${id}`, async () => {
      const row = this.row(clientId, id);
      if (row.state === 'complete') throw new UploadError('Transfer is already complete.', 409, 'transfer_complete', row.size);
      const offset = await this.committedOffset(row);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(input.contentRange?.trim() ?? '');
      if (!range) throw new UploadError('Content-Range "bytes start-end/total" is required.', 400, 'invalid_range', offset);
      const start = Number(range[1]); const end = Number(range[2]); const total = Number(range[3]);
      if (total !== row.size || end < start || end >= total) throw new UploadError('Content-Range does not match the transfer.', 416, 'invalid_range', offset);
      const length = end - start + 1;
      if (length > MAX_CHUNK_BYTES) throw new UploadError('Chunk exceeds the maximum chunk size.', 413, 'chunk_too_large', offset);
      if (input.body.byteLength !== length) throw new UploadError('Chunk length does not match Content-Range.', 400, 'length_mismatch', offset);
      const digest = createHash('sha256').update(input.body).digest('hex');
      if (!input.chunkSha256 || input.chunkSha256.toLowerCase() !== digest) throw new UploadError('Chunk checksum mismatch. Resend this chunk.', 422, 'chunk_checksum_mismatch', offset);
      // A retried chunk the server already committed is acknowledged without rewriting it.
      if (start < offset && end < offset) return this.state(row, offset);
      if (start !== offset) throw new UploadError('Chunk does not start at the committed offset.', 409, 'offset_mismatch', offset);
      const handle = await open(this.stagingPath(row), existsSync(this.stagingPath(row)) ? 'r+' : 'w+');
      try {
        await handle.truncate(offset);
        await handle.write(input.body, 0, length, offset);
        await handle.sync();
      } finally { await handle.close(); }
      const next = offset + length;
      this.sqlite.query('UPDATE mobile_uploads SET received_bytes = ?, updated_at = ? WHERE id = ?').run(next, this.now().toISOString(), id);
      return this.state(row, next);
    });
  }

  async complete(clientId: string, id: string): Promise<UploadAcknowledgement> {
    this.row(clientId, id);
    return withLock(`transfer:${id}`, async () => {
      const row = this.row(clientId, id);
      if (row.state === 'complete' && row.recording_id) {
        return { transferId: id, recordingId: row.recording_id, fingerprint: row.fingerprint, added: row.added === 1 };
      }
      const offset = await this.committedOffset(row);
      if (offset !== row.size) throw new UploadError('The transfer is incomplete.', 409, 'incomplete', offset);
      const path = this.stagingPath(row);
      if (await fingerprintFile(path) !== row.fingerprint) {
        // The staged bytes are unusable; restart from zero rather than import the wrong audio.
        await unlink(path).catch(() => undefined);
        this.sqlite.query('UPDATE mobile_uploads SET received_bytes = 0, updated_at = ? WHERE id = ?').run(this.now().toISOString(), id);
        throw new UploadError('The uploaded audio does not match its fingerprint. Upload it again.', 422, 'fingerprint_mismatch', 0);
      }
      const metadata = JSON.parse(row.metadata) as UploadMetadata;
      let result;
      try {
        result = await importRecordingFile({
          sourcePath: path,
          originalFilename: row.filename,
          expectedFingerprint: row.fingerprint,
          provenance: {
            sourceProvider: (metadata.sourceProvider ?? 'opennotes') as RecordingProvenance['sourceProvider'],
            sourceRecordingId: metadata.sourceRecordingId ?? null,
            sourceTransport: 'mobile',
            recordedAt: metadata.recordedAt ?? null,
          },
          metadata: { durationMs: metadata.durationMs, context: metadata.context ?? null, recordingType: metadata.recordingType },
        });
      } catch (error) {
        if (error instanceof RecordingImportConflict) throw new UploadError(error.message, 409, 'import_conflict', offset);
        throw error;
      }
      // The import is durable (fsynced file and committed row) before this acknowledgement is recorded.
      this.sqlite.query(`UPDATE mobile_uploads SET state = 'complete', recording_id = ?, added = ?, received_bytes = size, updated_at = ? WHERE id = ?`)
        .run(result.recording.id, result.added ? 1 : 0, this.now().toISOString(), id);
      await unlink(path).catch(() => undefined);
      if (result.added) await this.options.onImported?.({ id: result.recording.id, filePath: result.recording.filePath });
      return { transferId: id, recordingId: result.recording.id, fingerprint: result.recording.fingerprint, added: result.added };
    });
  }

  /** Cancels the caller's own open transfer. Completed transfers are not undone. */
  async cancel(clientId: string, id: string): Promise<{ cancelled: boolean }> {
    this.row(clientId, id);
    return withLock(`transfer:${id}`, async () => {
      const row = this.row(clientId, id);
      if (row.state === 'complete') return { cancelled: false };
      await this.discard(row);
      return { cancelled: true };
    });
  }

  private async discard(row: UploadRow) {
    await unlink(this.stagingPath(row)).catch(() => undefined);
    this.sqlite.query('DELETE FROM mobile_uploads WHERE id = ?').run(row.id);
  }

  /** Deletes abandoned staging files and old completion records. Returns the number removed. */
  async cleanup(): Promise<number> {
    const now = this.now().getTime();
    const stale = this.sqlite.query(`SELECT * FROM mobile_uploads WHERE (state = 'open' AND updated_at < ?) OR (state = 'complete' AND updated_at < ?)`)
      .all(new Date(now - UPLOAD_EXPIRY_MS).toISOString(), new Date(now - COMPLETED_RETENTION_MS).toISOString()) as UploadRow[];
    for (const row of stale) {
      if (locks.has(`transfer:${row.id}`)) continue;
      await this.discard(row);
    }
    // Staged files with no transfer row (a crash between file creation and insert) are orphans.
    let orphans = 0;
    const directory = this.directory();
    const known = new Set((this.sqlite.query(`SELECT id FROM mobile_uploads WHERE state = 'open'`).all() as { id: string }[]).map(r => r.id));
    for (const name of readdirSync(directory)) {
      const id = name.replace(/\.[^.]+$/, '');
      if (known.has(id)) continue;
      const path = join(directory, name);
      try { if (now - statSync(path).mtimeMs > UPLOAD_EXPIRY_MS) { await unlink(path); orphans += 1; } } catch { /* already gone */ }
    }
    return stale.length + orphans;
  }
}
