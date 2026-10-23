import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { recordings, userSettings } from '../db/schema';
import { jobQueue } from '../jobs/queue';
import { aiConfigFromSettings } from '../ai/config';
import { emitAutomationEvent } from '../automation/hooks';

export type ProcessingRoute = 'openwhistle' | 'local' | 'disabled';

/** A transcript the phone already made with its own API key, waiting for its audio to arrive. */
export interface ProvidedTranscript {
  fullText: string;
  segments: { start: number; end: number; text: string }[];
  provider: string;
  model: string | null;
  language: string | null;
  durationSeconds: number | null;
}

// Kept in memory only: if the vault restarts before the audio arrives, it simply transcribes it.
const provided = new Map<string, { transcript: ProvidedTranscript; expires: number }>();
const PROVIDED_TTL_MS = 6 * 60 * 60 * 1000;

export function offerTranscript(fingerprint: string, transcript: ProvidedTranscript) {
  const now = Date.now();
  for (const [key, entry] of provided) if (entry.expires < now) provided.delete(key);
  provided.set(fingerprint, { transcript, expires: now + PROVIDED_TTL_MS });
}

function takeTranscript(fingerprint: string): ProvidedTranscript | null {
  const entry = provided.get(fingerprint);
  provided.delete(fingerprint);
  return entry && entry.expires >= Date.now() ? entry.transcript : null;
}

export async function queueRecordingProcessing(params: {
  recordingId: string;
  filePath: string;
  settings?: Record<string, string>;
}): Promise<ProcessingRoute> {
  // KB-08/KB-09: webhooks and opt-in rules first, so a rule's transcription choice is queued before the default.
  await emitAutomationEvent({ type: 'recording.imported', recordingId: params.recordingId });
  const settings = params.settings ?? Object.fromEntries(
    (await db.select().from(userSettings)).map(setting => [setting.key, setting.value]),
  );

  // The phone already transcribed this audio: store that transcript instead of paying again.
  const fingerprint = db.select({ fingerprint: recordings.fingerprint }).from(recordings).where(eq(recordings.id, params.recordingId)).get()?.fingerprint;
  const transcript = fingerprint ? takeTranscript(fingerprint) : null;
  if (transcript) {
    await jobQueue.add('process-recording', {
      recordingId: params.recordingId,
      filePath: params.filePath,
      config: aiConfigFromSettings(settings),
      provided: transcript,
    });
    return 'local';
  }

  if (settings.openWhistleForwarding === 'true' && aiConfigFromSettings(settings).privacyMode !== 'local-only') {
    await db.update(recordings).set({ forwardingStatus: 'queued', forwardingError: null })
      .where(eq(recordings.id, params.recordingId));
    await jobQueue.add('forward-recording', { recordingId: params.recordingId });
    return 'openwhistle';
  }

  if (settings.autoTranscribe !== 'false') {
    await jobQueue.add('process-recording', {
      recordingId: params.recordingId,
      filePath: params.filePath,
      config: aiConfigFromSettings(settings),
    });
    return 'local';
  }

  return 'disabled';
}
