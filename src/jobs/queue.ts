import type { Database } from 'bun:sqlite';
import { sqlite } from '../db/client';
import { readAiConfig } from '../ai/config';
import { emitAutomationEvent } from '../automation/hooks';
import type { LongCheckpoint } from '../transcription/long-audio';
import { registerPurgeHook } from '../library/purge-hooks';

export interface Job<T = unknown> {
  id: string; type: string; data: T; status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  error?: string; createdAt: Date; startedAt?: Date; completedAt?: Date; priority: number;
  /** `inFlight: false` means no remote submission is outstanding, so restarting cannot double-submit paid work. */
  checkpoint?: LongCheckpoint;
  /** Automatic retries already made, and the earliest time the next one may run (ms since epoch). */
  attempts?: number; notBefore?: number;
  /**
   * Set only for explicit extra runs (a provider comparison). Such a job is
   * deduplicated by this key instead of by recording, never counts as the
   * recording's processing job, and never changes the recording's status.
   */
  dedupeKey?: string;
}
/** Best-effort remote clean-up after a cancel; resolves to a sentence describing the outcome, or null. */
export type CancelHook = (job: Job) => Promise<string | null>;
export type JobContext = { id: string; signal: AbortSignal; checkpoint?: Job['checkpoint']; saveCheckpoint: (checkpoint: NonNullable<Job['checkpoint']>) => void };
type JobHandler<T = unknown> = (data: T, context: JobContext) => Promise<void>;
const TERMINAL: Job['status'][] = ['complete', 'failed', 'cancelled'];
/** Finished jobs are kept this long for status and audit, then dropped on startup. */
const RETAIN_FINISHED_MS = 30 * 86400000;
const RETAIN_FINISHED_COUNT = 1000;
/** Bounded automatic retries: two, with backoff, and only for errors marked retryable before anything was sent. */
const RETRY_DELAYS_MS = [5000, 30000];
const restartable = (checkpoint: Job['checkpoint']) => Boolean(checkpoint?.remoteId) || checkpoint?.inFlight === false;

export class JobQueue {
  private jobs: Job[] = [];
  private handlers = new Map<string, JobHandler<any>>();
  private processing = false;
  private controllers = new Map<string, AbortController>();
  private cancelHooks: CancelHook[] = [];
  constructor(private database: Database, private retryDelaysMs: number[] = RETRY_DELAYS_MS) {
    database.exec('CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    const rows = database.query('SELECT id, payload FROM processing_jobs ORDER BY rowid').all() as { id: string; payload: string }[];
    const loaded = rows.flatMap(row => {
      // One unreadable row must not stop the server from starting; it is left in place for inspection.
      let value;
      try { value = JSON.parse(row.payload); } catch { console.error(`[Jobs] Skipping unreadable job ${row.id}`); return []; }
      if (!value || typeof value !== 'object') { console.error(`[Jobs] Skipping unreadable job ${row.id}`); return []; }
      return [{ ...value, createdAt: new Date(value.createdAt), startedAt: value.startedAt ? new Date(value.startedAt) : undefined,
        completedAt: value.completedAt ? new Date(value.completedAt) : undefined } as Job];
    });
    // Without pruning, every job ever run stays in memory and is rescanned on each queue step.
    const finished = loaded.filter(job => TERMINAL.includes(job.status));
    const cutoff = Date.now() - RETAIN_FINISHED_MS;
    const expired = new Set(finished.filter((job, index) => index < finished.length - RETAIN_FINISHED_COUNT
      || (job.completedAt ?? job.createdAt).getTime() < cutoff).map(job => job.id));
    if (expired.size) database.query('DELETE FROM processing_jobs WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify([...expired]));
    for (const job of loaded) {
      if (expired.has(job.id)) continue;
      if (job.status === 'running') {
        job.status = restartable(job.checkpoint) ? 'pending' : 'failed';
        job.error = job.status === 'failed' ? 'Interrupted during processing. Provider outcome may be unknown; check usage before retrying.' : undefined;
        this.persist(job);
        // Otherwise the recording would show "transcribing" forever after a crash.
        if (job.status === 'failed' && job.type === 'process-recording' && !job.dedupeKey) database.query("UPDATE recordings SET status='failed', error_message=? WHERE id=? AND retention_state='active'")
          .run(job.error!, String((job.data as { recordingId?: unknown }).recordingId));
      }
      this.jobs.push(job);
    }
  }
  private forgotten = new Set<string>();
  private persist(job: Job) { if (this.forgotten.has(job.id)) return; this.database.query('INSERT INTO processing_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(job.id, JSON.stringify(job)); }
  register<T>(type: string, handler: JobHandler<T>) { this.handlers.set(type, handler); queueMicrotask(() => { void this.processNext(); }); }
  async add<T>(type: string, data: T, priority = 0, options: { dedupeKey?: string } = {}): Promise<Job<T>> {
    const input = data as Record<string, unknown>;
    const existing = options.dedupeKey
      ? this.jobs.find(job => job.type === type && job.dedupeKey === options.dedupeKey && ['pending', 'running'].includes(job.status))
      : typeof input.recordingId === 'string' ? this.activeJob(type, input.recordingId) : undefined;
    if (existing) return existing as Job<T>;
    let savedData = data;
    if (type === 'process-recording') {
      const recording = this.database.query('SELECT fingerprint FROM recordings WHERE id=?').get(String(input.recordingId)) as { fingerprint: string | null } | null;
      savedData = { ...input, config: input.config ?? readAiConfig(this.database), fingerprint: recording?.fingerprint ?? null } as T;
    }
    const job: Job<T> = { id: crypto.randomUUID(), type, data: savedData, priority, status: 'pending', createdAt: new Date(),
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}) };
    this.persist(job); this.jobs.push(job);
    queueMicrotask(() => { void this.processNext(); });
    return job;
  }
  cancel(id: string) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || !['pending', 'running'].includes(job.status)) return false;
    job.status = 'cancelled'; job.completedAt = new Date();
    job.error = job.checkpoint?.remoteId ? 'Local polling cancelled. Remote processing may continue.' : 'Cancelled. Any submitted provider request may still be billed.';
    if (job.type === 'process-recording' && !job.dedupeKey) this.database.query("UPDATE recordings SET status='failed',error_message='Processing cancelled.' WHERE id=? AND retention_state='active'").run(String((job.data as any).recordingId));
    this.persist(job); this.controllers.get(id)?.abort();
    for (const hook of this.cancelHooks) void hook(job).then(outcome => { if (outcome) { job.error = `${job.error} ${outcome}`; this.persist(job); } }).catch(() => {});
    return true;
  }
  /** Register best-effort remote cancellation (for example AssemblyAI). Hooks never change the cancelled state. */
  onCancel(hook: CancelHook) { this.cancelHooks.push(hook); }
  resume(id: string) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || !restartable(job.checkpoint) || !['failed', 'cancelled'].includes(job.status) || this.controllers.has(id)) return false;
    const other = this.jobs.some(item => item.id !== id && item.dedupeKey === job.dedupeKey && ['pending', 'running'].includes(item.status) && (item.data as any).recordingId === (job.data as any).recordingId);
    if (other) return false;
    job.status = 'pending'; job.error = undefined; job.completedAt = undefined; this.persist(job);
    if (job.type === 'process-recording' && !job.dedupeKey) this.database.query("UPDATE recordings SET status='pending',error_message=NULL WHERE id=? AND retention_state='active'").run(String((job.data as any).recordingId));
    queueMicrotask(() => { void this.processNext(); }); return true;
  }
  setPriority(id: string, priority: number) {
    const job = this.jobs.find(item => item.id === id && item.status === 'pending');
    if (!job || !Number.isInteger(priority) || priority < -10 || priority > 10) return false;
    job.priority = priority; this.persist(job); return true;
  }
  private async processNext() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const now = Date.now();
        const job = this.jobs.filter(j => j.status === 'pending' && this.handlers.has(j.type) && (j.notBefore ?? 0) <= now).sort((a, b) => b.priority - a.priority)[0];
        if (!job) break;
        job.notBefore = undefined;
        const controller = new AbortController(); this.controllers.set(job.id, controller);
        job.status = 'running'; job.startedAt = new Date(); this.persist(job);
        try {
          await this.handlers.get(job.type)!(job.data, { id: job.id, signal: controller.signal, checkpoint: job.checkpoint,
            saveCheckpoint: checkpoint => { job.checkpoint = checkpoint; this.persist(job); } });
          if (!controller.signal.aborted) { job.status = 'complete'; job.error = undefined; }
        } catch (error) {
          if (!controller.signal.aborted) { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Processing failed.'; this.scheduleRetry(job, error); }
        } finally {
          job.completedAt = (job.status as Job['status']) === 'pending' ? undefined : new Date(); this.persist(job); this.controllers.delete(job.id);
          // A failure rescheduled for retry is pending again, so only a final failure emits the event.
          if (job.status === 'failed') void emitAutomationEvent({ type: 'job.failed', jobId: job.id, jobType: job.type, error: job.error ?? null,
            recordingId: typeof (job.data as { recordingId?: unknown })?.recordingId === 'string' ? (job.data as { recordingId: string }).recordingId : null });
        }
      }
    } finally { this.processing = false; }
  }
  /** Retry a failed job only when its error is marked retryable and its checkpoint shows nothing outstanding remotely. */
  private scheduleRetry(job: Job, error: unknown) {
    const attempts = job.attempts ?? 0;
    if ((error as { retryable?: unknown })?.retryable !== true || job.checkpoint?.inFlight !== false || job.checkpoint.remoteId || attempts >= this.retryDelaysMs.length) return;
    const delay = this.retryDelaysMs[attempts];
    job.attempts = attempts + 1; job.status = 'pending'; job.notBefore = Date.now() + delay;
    job.error = `Retry ${job.attempts} of ${this.retryDelaysMs.length} scheduled after: ${job.error}`;
    setTimeout(() => { void this.processNext(); }, delay + 1).unref?.();
  }
  /** REL-04: drops every job (and its persisted payload) for a purged recording, aborting any still running. */
  forgetRecording(recordingId: string) {
    const removed = this.jobs.filter(job => (job.data as { recordingId?: unknown })?.recordingId === recordingId);
    for (const job of removed) { this.forgotten.add(job.id); this.controllers.get(job.id)?.abort(); }
    this.jobs = this.jobs.filter(job => !removed.includes(job));
    if (removed.length) this.database.query('DELETE FROM processing_jobs WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(removed.map(job => job.id)));
    return removed.length;
  }
  getJob(id: string) { return this.jobs.find(job => job.id === id); }
  /** The queued or running job of this type for a recording, if any. */
  activeJob(type: string, recordingId: string) {
    return this.jobs.find(job => job.type === type && !job.dedupeKey && ['pending', 'running'].includes(job.status) && (job.data as { recordingId?: unknown })?.recordingId === recordingId);
  }
  /** Every retained job in submission order. Callers must not mutate it. */
  getAllJobs(): readonly Job[] { return this.jobs; }
  getJobs(status?: Job['status']) { return this.jobs.filter(job => !status || job.status === status).slice(-200); }
  getStats(): Record<Job['status'] | 'total', number> { return { total: this.jobs.length, ...Object.fromEntries(['pending', 'running', 'complete', 'failed', 'cancelled'].map(status => [status, this.jobs.filter(job => job.status === status).length])) } as Record<Job['status'] | 'total', number>; }
}
export const jobQueue = new JobQueue(sqlite);
registerPurgeHook({ name: 'job-queue', afterCommit: ({ recordingId }) => { jobQueue.forgetRecording(recordingId); } });
