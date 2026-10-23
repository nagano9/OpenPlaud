import type { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { isLocalProvider, type AiConfig } from '../ai/config';
import { speechCapabilities, timestampGranularity } from '../ai/capabilities';
import { costGate, estimateTranscription, recordingCostInput, recordSpend, settleSpend } from '../ai/spending';
import { chunkPlan, ffmpegSplitter, transcribeChunks, type AudioSplitter, type LongCheckpoint } from './long-audio';
import { transcriptionFailure } from './openai';
import type { TranscriptionRouter } from './router';
import type { TranscriptionOptions, TranscriptionResult } from './types';

export interface TranscriptionRun {
  jobId: string; recordingId: string; filePath: string;
  /** The effective configuration (profile already applied). */
  config: AiConfig; options: TranscriptionOptions;
  /** The user confirmed this job's cost estimate when it was queued. */
  costConfirmed?: boolean;
  signal: AbortSignal; checkpoint?: LongCheckpoint; saveCheckpoint: (checkpoint: LongCheckpoint) => void;
}
export class CostConfirmationError extends Error {}

const STREAMED_CONTAINERS = new Set(['.webm', '.ogg', '.oga', '.opus']);
/**
 * Browser and phone recorders write WebM/Ogg as a stream with no duration in the header, which
 * OpenAI and other providers reject (HTTP 400). Such a file is sent as a clean MP3 copy instead;
 * the stored recording is not changed.
 */
async function repairedCopy(filePath: string, duration: number | null, splitter: AudioSplitter, signal: AbortSignal) {
  if (!STREAMED_CONTAINERS.has(extname(filePath).toLowerCase())) return null;
  if (duration ?? await splitter.probe(filePath, signal)) return null;
  const directory = await mkdtemp(join(tmpdir(), 'openplod-repair-'));
  const cleanup = () => rm(directory, { recursive: true, force: true }).catch(() => undefined);
  try {
    const path = join(directory, 'audio.mp3');
    await splitter.extract(filePath, 0, 24 * 3600, path, signal);
    return { path, cleanup };
  } catch { await cleanup(); return null; }
}

/**
 * One recording's transcription for the job queue: cost gate and ledger (AI-10),
 * then either the whole file through the router, or the chunked path (AI-08)
 * when the provider's size limit or the configured duration requires it.
 * Checkpoints say whether a remote submission may be in flight (`inFlight`), so
 * the queue only restarts or retries work that is known not to be outstanding.
 */
export async function runTranscription(database: Database, router: TranscriptionRouter, run: TranscriptionRun, splitter: AudioSplitter = ffmpegSplitter): Promise<TranscriptionResult> {
  const { config, options, signal, checkpoint } = run, provider = config.transcriptionEngine;
  const stored = recordingCostInput(database, run.recordingId);
  let fileBytes = stored.fileBytes;
  try { const size = Bun.file(run.filePath).size; if (size > 0) fileBytes = size; } catch { /* keep the stored size */ }
  const maxBytes = speechCapabilities[provider].maxBytes, tooLarge = maxBytes !== null && fileBytes !== null && fileBytes > maxBytes;
  const chainLocal = [provider, ...config.transcriptionFallback].every(name => isLocalProvider(config, name));
  const resumedPlan = checkpoint?.chunks?.plan.at(-1);
  let duration = resumedPlan ? resumedPlan.start + resumedPlan.duration : stored.durationSeconds;
  const needsDuration = tooLarge || config.transcriptionChunkAboveMinutes > 0 || (!chainLocal && (config.monthlyBudgetUsd !== null || config.confirmAboveUsd !== null));
  if (duration === null && needsDuration) duration = await splitter.probe(run.filePath, signal);
  const estimate = estimateTranscription(config, { durationSeconds: duration, fileBytes, model: options.model ?? null, diarize: options.diarize });
  const resuming = Boolean(checkpoint?.remoteId || checkpoint?.chunks?.results.length);
  if (!resuming && !run.costConfirmed) {
    const gate = costGate(database, estimate.usd, estimate.local);
    if (gate.required) throw new CostConfirmationError(`Cost confirmation required: ${gate.reasons.join(' ')} Nothing was sent. Start this transcription again and confirm the estimate.`);
  }
  const ledgerId = `transcription:${run.jobId}`;
  if (!estimate.local) recordSpend(database, { id: ledgerId, jobId: run.jobId, task: 'transcription', provider, model: estimate.model, estimatedUsd: estimate.usd, basis: estimate.usd === null ? 'unknown' : 'audio-seconds', units: estimate.billedSeconds, usage: null, status: 'estimated' });
  let everSent = Boolean(checkpoint?.inFlight || checkpoint?.remoteId || checkpoint?.chunks?.results.length);
  const save = (next: LongCheckpoint) => { if (next.inFlight) everSent = true; run.saveCheckpoint(next); };
  const settle = (status: 'complete' | 'failed' | 'cancelled', usage: Record<string, number> | null = null) => {
    if (!estimate.local) settleSpend(database, ledgerId, status !== 'complete' && !everSent ? 'not-sent' : status, usage);
  };
  try {
    const plan = chunkPlan(provider, { durationSeconds: duration, fileBytes, chunkAboveMinutes: config.transcriptionChunkAboveMinutes });
    let result: TranscriptionResult;
    if (!plan && tooLarge) result = transcriptionFailure('router', `This file exceeds ${speechCapabilities[provider].label}'s ${Math.round(maxBytes! / 1_000_000)} MB limit and its duration could not be read, so it cannot be split. Nothing was sent.`);
    else if (plan && options.diarize) result = transcriptionFailure('router', 'Speaker labels cannot be kept consistent across audio chunks. Turn off speaker labels for this long recording, or choose a provider that accepts the whole file. Nothing was sent.');
    else if (plan && timestampGranularity(provider, options.model, options.diarize) === 'none') result = transcriptionFailure('router', `${speechCapabilities[provider].label}${options.model ? ` ${options.model}` : ''} returns no timestamps, so a long recording cannot be split and merged without duplicating speech. Choose a model with segment timestamps. Nothing was sent.`);
    else if (plan) {
      const single = router.primaryOnly();
      result = await transcribeChunks((path, opts) => single.transcribeFile(path, opts), run.filePath, plan, duration!, { ...options, signal, checkpoint, save, local: isLocalProvider(config, provider), provider }, splitter);
    } else {
      const repaired = await repairedCopy(run.filePath, duration, splitter, signal);
      try { result = await router.transcribeFile(repaired?.path ?? run.filePath, { ...options, signal, checkpoint, onCheckpoint: next => save({ ...next, inFlight: !chainLocal }) }); }
      finally { await repaired?.cleanup(); }
    }
    signal.throwIfAborted();
    settle(result.success ? 'complete' : 'failed', result.success ? (result.metadata?.usage as Record<string, number> | null | undefined) ?? null : null);
    return result;
  } catch (error) {
    settle(signal.aborted ? 'cancelled' : 'failed');
    throw error;
  }
}
