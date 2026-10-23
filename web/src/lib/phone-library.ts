import { deviceCommand, supportsPlaudDevice } from './plaud-device'

/** The Android app's own recording library (PhoneRecordings.kt). */
export interface PhoneRecording { id: string; name: string; size: number; addedAt: number | null; onDesktop: boolean; send: boolean; inFolder?: boolean }
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

export const phoneLibrary = {
  list: () => deviceCommand<PhoneLibrary>('phoneLibrary'),
  pick: () => deviceCommand<PhoneLibrary>('phonePickRecordings'),
  setSend: (id: string, send: boolean) => deviceCommand<PhoneLibrary>('phoneSetSend', { id, send }),
  setAutoSend: (enabled: boolean) => deviceCommand<PhoneLibrary>('phoneSetAutoSend', { enabled }),
}
