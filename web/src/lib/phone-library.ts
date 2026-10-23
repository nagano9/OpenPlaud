import { api } from './api'
import { sha256Hex } from './mobile-upload'
import { deviceCommand, supportsPlaudDevice } from './plaud-device'
import { apiUrl, authenticatedHeaders, getRuntime } from './runtime'

/** The Android app's own recording library (PhoneRecordings.kt). */
export interface PhoneRecording { id: string; name: string; size: number; addedAt: number | null; onDesktop: boolean; send: boolean; inFolder?: boolean; transcribed?: boolean }
export interface PhoneLibrary { recordings: PhoneRecording[]; autoSend: boolean; folder?: string; added?: number; skipped?: string[] }

/** Recordings made in OpenPlod on an Android phone are kept in the phone library. */
export const hasPhoneLibrary = supportsPlaudDevice

const CHUNK_BYTES = 384 * 1024

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

/**
 * Saves a recording permanently on this phone. `send` marks it for the paired computer; when false
 * it stays on the phone until the person chooses "Send to computer".
 */
export async function saveToPhone(blob: Blob, name: string, send: boolean, onProgress?: (done: number, total: number) => void): Promise<PhoneLibrary> {
  const { upload } = await deviceCommand<{ upload: string }>('phoneRecordingBegin')
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
    await deviceCommand('phoneRecordingAppend', { upload, data: base64(chunk) })
    onProgress?.(Math.min(blob.size, offset + CHUNK_BYTES), blob.size)
  }
  return deviceCommand<PhoneLibrary>('phoneRecordingFinish', { upload, name, send })
}

const READ_BYTES = 768 * 1024

const mimeFor = (name: string) => ({ webm: 'audio/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', '3gp': 'audio/3gpp', amr: 'audio/amr' } as Record<string, string>)[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

async function readChunks(command: string, args: Record<string, unknown>, size: number, type: string, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const parts: BlobPart[] = []
  for (let offset = 0; offset < size; offset += READ_BYTES) {
    const { data } = await deviceCommand<{ data: string }>(command, { ...args, offset, length: READ_BYTES })
    parts.push(Uint8Array.from(atob(data), char => char.charCodeAt(0)))
    onProgress?.(Math.min(size, offset + READ_BYTES), size)
  }
  return new Blob(parts, { type })
}

const readRecording = (item: PhoneRecording, onProgress?: (done: number, total: number) => void) =>
  readChunks('phoneRecordingRead', { id: item.id }, item.size, mimeFor(item.name), onProgress)

/** The native recorder (RecordingService.kt): keeps recording with the screen off or the phone locked. */
export interface NativeRecorderStatus {
  state: 'idle' | 'starting' | 'recording' | 'paused' | 'stopped'
  error: string | null
  elapsedMs?: number
  level?: number
  startedAt?: number
  /** A finished take waiting for Save or Discard. */
  take?: string
  size?: number
}

export const nativeRecorder = {
  status: () => deviceCommand<NativeRecorderStatus>('recordStatus'),
  start: () => deviceCommand<NativeRecorderStatus>('recordStart'),
  pause: () => deviceCommand<NativeRecorderStatus>('recordPause'),
  resume: () => deviceCommand<NativeRecorderStatus>('recordResume'),
  stop: () => deviceCommand<NativeRecorderStatus>('recordStop'),
  read: (take: string, size: number) => readChunks('recordRead', { take }, size, 'audio/mp4'),
  keep: (take: string, name: string, send: boolean) => deviceCommand<PhoneLibrary>('recordKeep', { take, name, send }),
  discard: (take: string) => deviceCommand<NativeRecorderStatus>('recordDiscard', { take }),
}

/**
 * "Send to computer": uploads now over Wi-Fi when the paired computer is reachable; otherwise the
 * recording is marked for Bluetooth sync. Resolves with how it went and the updated library.
 */
export async function sendToComputer(item: PhoneRecording, onProgress?: (done: number, total: number) => void): Promise<{ via: 'wifi' | 'bluetooth'; library: PhoneLibrary; reason?: string }> {
  let reason: string | undefined
  if (getRuntime().paired) {
    try {
      const blob = await readRecording(item, onProgress)
      const fingerprint = await sha256Hex(blob)
      // A transcript made on the phone goes first, so the computer stores it instead of paying again.
      if (item.transcribed) await offerTranscript(item, fingerprint).catch(() => undefined)
      await api.uploadRecording(new File([blob], item.name, { type: blob.type }), true,
        { recordedAt: item.addedAt ? new Date(item.addedAt).toISOString() : undefined, recordingType: 'other' },
        { fingerprint })
      return { via: 'wifi', library: await deviceCommand<PhoneLibrary>('phoneMarkOnDesktop', { id: item.id }) }
    } catch (error) {
      // Kept for the person: Bluetooth sync delivers it later, but they should know why Wi-Fi failed.
      reason = error instanceof Error ? error.message : String(error)
    }
  }
  return { via: 'bluetooth', library: await phoneLibrary.setSend(item.id, true), reason }
}

export const phoneLibrary = {
  list: () => deviceCommand<PhoneLibrary>('phoneLibrary'),
  pick: () => deviceCommand<PhoneLibrary>('phonePickRecordings'),
  setSend: (id: string, send: boolean) => deviceCommand<PhoneLibrary>('phoneSetSend', { id, send }),
  setAutoSend: (enabled: boolean) => deviceCommand<PhoneLibrary>('phoneSetAutoSend', { enabled }),
}

/** Phone transcription (PhoneTranscriber.kt) with the person's own OpenAI key. */
export interface TranscriptionJob { state: 'queued' | 'running' | 'failed'; done?: number; total?: number; error?: string }
export interface PhoneTranscription { hasKey: boolean; keyHint: string | null; language: string; model: string; jobs: Record<string, TranscriptionJob> }
export interface PhoneTranscript { text: string; segments: { start: number; end: number; text: string }[]; model: string; language: string | null; durationSeconds: number; createdAt: number }

export const phoneTranscription = {
  status: () => deviceCommand<PhoneTranscription>('transcriptionStatus'),
  setKey: (key: string) => deviceCommand<PhoneTranscription>('transcriptionSetKey', { key }),
  clearKey: () => deviceCommand<PhoneTranscription>('transcriptionClearKey'),
  setLanguage: (language: string) => deviceCommand<PhoneTranscription>('transcriptionSetLanguage', { language }),
  transcribe: (id: string) => deviceCommand<PhoneTranscription>('transcribe', { id }),
  get: (id: string) => deviceCommand<PhoneTranscript>('transcriptGet', { id }),
}

async function offerTranscript(item: PhoneRecording, fingerprint: string) {
  const transcript = await phoneTranscription.get(item.id)
  const response = await fetch(apiUrl('/mobile/transcripts'), {
    method: 'POST',
    headers: authenticatedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ fingerprint, fullText: transcript.text, segments: transcript.segments, provider: 'openai', model: transcript.model, language: transcript.language, durationSeconds: transcript.durationSeconds }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}
