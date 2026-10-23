import { useCallback, useEffect, useState } from 'react'
import { hasPhoneLibrary, phoneTranscription, type PhoneTranscription } from './phone-library'

/**
 * Phone transcription state, refreshed while a transcription runs. `finished` holds recordings
 * whose transcript appeared since the list was loaded, so their button changes without a reload.
 */
export function usePhoneTranscription() {
  const [status, setStatus] = useState<PhoneTranscription | null>(null)
  const [finished, setFinished] = useState<Set<string>>(() => new Set())
  const apply = useCallback((next: PhoneTranscription) => setStatus(previous => {
    const done = Object.keys(previous?.jobs ?? {}).filter(id => !next.jobs[id])
    if (done.length) setFinished(current => new Set([...current, ...done]))
    return next
  }), [])
  const refresh = useCallback(() => phoneTranscription.status().then(apply).catch(() => undefined), [apply])
  const running = Object.values(status?.jobs ?? {}).some(job => job.state !== 'failed')
  useEffect(() => { if (hasPhoneLibrary()) void refresh() }, [refresh])
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [running, refresh])
  const transcribe = async (id: string) => apply(await phoneTranscription.transcribe(id))
  return { status, apply, finished, transcribe }
}

export type PhoneTranscriptionState = ReturnType<typeof usePhoneTranscription>
