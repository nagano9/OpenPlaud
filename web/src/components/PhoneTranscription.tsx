import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertCircle, Copy, FileText, KeyRound, Loader2, Search, Share2, Speech, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { exportDocument } from '@/lib/document-export'
import { phoneTranscription, type PhoneRecording, type PhoneTranscript, type PhoneTranscription } from '@/lib/phone-library'
import type { PhoneTranscriptionState } from '@/lib/use-phone-transcription'
import { formatDuration } from '@/lib/utils'
import { t } from '@/i18n'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** "Transcribe" for one phone recording, its progress, or "Transcript" once it is done. */
export function TranscriptActions({ item, transcription }: { item: PhoneRecording; transcription: PhoneTranscriptionState }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const job = transcription.status?.jobs[item.id]
  const done = item.transcribed || transcription.finished.has(item.id)
  if (!transcription.status) return null
  if (job && job.state !== 'failed') return <Button size="sm" variant="ghost" disabled><Loader2 className="animate-spin" />
    {job.state === 'running' && job.total ? t('Transcribing {done}/{total}', { done: Math.min((job.done ?? 0) + 1, job.total), total: job.total }) : t('Transcribing...')}</Button>
  if (done) return <>
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}><FileText />{t('Transcript')}</Button>
    {open && <TranscriptDialog item={item} onClose={() => setOpen(false)} />}
  </>
  const failure = error || (job?.state === 'failed' ? job.error ?? '' : '')
  const start = async () => {
    setError('')
    try { await transcription.transcribe(item.id) } catch (startError) { setError(message(startError)) }
  }
  return <span className="phone-transcribe">
    <Button size="sm" variant="outline" disabled={!transcription.status.hasKey} title={transcription.status.hasKey ? undefined : t('Add your OpenAI API key in Transcription on this phone first.')}
      onClick={() => void start()}><Speech />{failure ? t('Try again') : t('Transcribe')}</Button>
    {failure && <small className="device-error" role="alert"><AlertCircle />{failure}</small>}
  </span>
}

function TranscriptDialog({ item, onClose }: { item: PhoneRecording; onClose: () => void }) {
  const [transcript, setTranscript] = useState<PhoneTranscript | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { phoneTranscription.get(item.id).then(setTranscript).catch(failure => setError(message(failure))) }, [item.id])
  const paragraphs = useMemo(() => transcript?.segments.length ? transcript.segments : transcript ? [{ start: 0, end: transcript.durationSeconds, text: transcript.text }] : [], [transcript])
  const needle = query.trim().toLowerCase()
  const shown = needle ? paragraphs.filter(paragraph => paragraph.text.toLowerCase().includes(needle)) : paragraphs
  const title = item.name.replace(/\.[^.]+$/, '')

  const copy = async () => {
    try { await navigator.clipboard.writeText(transcript?.text ?? ''); setNotice(t('Copied.')) } catch (failure) { setError(message(failure)) }
  }
  const share = async () => {
    try { await exportDocument({ filename: `${title}.txt`, content: `${title}\n\n${transcript?.text ?? ''}\n`, mime: 'text/plain' }) } catch (failure) { setError(message(failure)) }
  }

  return <Dialog.Root open onOpenChange={value => { if (!value) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="phone-transcript-overlay" />
      <Dialog.Content className="phone-transcript-dialog">
        <header>
          <div><Dialog.Title>{t('Transcript')}</Dialog.Title><Dialog.Description>{item.name}</Dialog.Description></div>
          <Dialog.Close asChild><Button size="icon" variant="ghost" aria-label={t('Close')} title={t('Close')}><X /></Button></Dialog.Close>
        </header>
        {transcript && <div className="phone-transcript-tools">
          <label><Search aria-hidden="true" /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search the transcript')} aria-label={t('Search the transcript')} /></label>
          <Button size="sm" variant="outline" onClick={() => void copy()}><Copy />{t('Copy')}</Button>
          <Button size="sm" variant="outline" onClick={() => void share()}><Share2 />{t('Share')}</Button>
        </div>}
        <div className="phone-transcript-body">
          {!transcript && !error && <p className="device-muted"><Loader2 className="animate-spin" /> {t('Loading transcript...')}</p>}
          {error && <p className="device-error" role="alert">{error}</p>}
          {notice && <p className="device-muted" role="status">{notice}</p>}
          {transcript && !transcript.text.trim() && <p className="device-muted">{t('No speech was found in this recording.')}</p>}
          {needle && transcript && shown.length === 0 && <p className="device-muted">{t('No matches.')}</p>}
          {shown.map(paragraph => <p key={paragraph.start}>
            {paragraphs.length > 1 && <time>{formatDuration(paragraph.start)}</time>}
            <Highlight text={paragraph.text} needle={needle} />
          </p>)}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>
  const parts: React.ReactNode[] = []
  let from = 0
  const lower = text.toLowerCase()
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    parts.push(text.slice(from, at), <mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}

const LANGUAGES = [['', 'Detect automatically'], ['id', 'Indonesian'], ['en', 'English']] as const

/** The OpenAI key and language for transcribing on this phone, without the computer. */
export function PhoneTranscriptionSettings({ transcription }: { transcription: PhoneTranscriptionState }) {
  const { status, apply } = transcription
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const run = async (work: () => Promise<PhoneTranscription>, done?: string) => {
    setBusy(true); setError(''); setNotice('')
    try { apply(await work()); if (done) setNotice(done) } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  if (!status) return null
  return <section className="device-section phone-transcription" aria-label={t('Transcription on this phone')}>
    <div className="device-section-heading"><h2>{t('Transcription on this phone')}</h2></div>
    <p className="device-muted">{t('Transcribe recordings on this phone with your own OpenAI API key, without the computer. The key is stored encrypted on this phone and is never sent to the computer.')}</p>
    {status.hasKey ? <div className="device-recording-row">
      <span><strong><KeyRound /> {t('OpenAI key saved')}</strong><small>{status.keyHint ? t('Ends in {hint}', { hint: status.keyHint }) : ''}</small></span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(t('Remove the OpenAI key from this phone?'))) void run(phoneTranscription.clearKey) }}>{t('Remove')}</Button>
    </div> : <form className="phone-transcription-key" onSubmit={event => { event.preventDefault(); void run(() => phoneTranscription.setKey(key), t('Key checked and saved.')).then(() => setKey('')) }}>
      <Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="sk-..." aria-label={t('OpenAI API key')} />
      <Button type="submit" size="sm" disabled={busy || !key.trim()}>{busy ? <Loader2 className="animate-spin" /> : <KeyRound />}{t('Check and save')}</Button>
    </form>}
    <label className="capture-input">{t('Language')}
      <select value={status.language} disabled={busy} onChange={event => void run(() => phoneTranscription.setLanguage(event.target.value))}>
        {LANGUAGES.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
      </select>
    </label>
    {notice && <p className="device-muted" role="status">{notice}</p>}
    {error && <p className="device-error" role="alert">{error}</p>}
  </section>
}
