import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Smartphone, UploadCloud } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { hasPhoneLibrary, phoneLibrary, sendToComputer, type PhoneRecording } from '@/lib/phone-library'
import { formatDate, t } from '@/i18n'
import { TranscriptActions } from '@/components/PhoneTranscription'
import { usePhoneTranscription } from '@/lib/use-phone-transcription'

/**
 * On the phone, the Recordings list is the computer's vault. Recordings saved only on this phone
 * are listed above it, so a recording never seems lost; "Send to computer" uploads it.
 */
export function PhoneOnlyRecordings({ onSent }: { onSent?: () => void }) {
  const [items, setItems] = useState<PhoneRecording[]>([])
  const [sending, setSending] = useState<{ id: string; percent: number | null } | null>(null)
  const [message, setMessage] = useState('')
  const transcription = usePhoneTranscription()
  const load = useCallback(() => phoneLibrary.list().then(value => setItems(value.recordings.filter(item => !item.onDesktop))).catch(() => undefined), [])
  useEffect(() => { if (hasPhoneLibrary()) void load() }, [load])
  if (!hasPhoneLibrary() || items.length === 0) return null

  const send = async (item: PhoneRecording) => {
    setSending({ id: item.id, percent: null }); setMessage('')
    try {
      const result = await sendToComputer(item, (done, total) => setSending({ id: item.id, percent: Math.round(done / total * 100) }))
      setItems(result.library.recordings.filter(entry => !entry.onDesktop))
      setMessage(result.via === 'wifi' ? t('{name} is now on the computer.', { name: item.name })
        : `${t('The computer is not reachable over Wi-Fi. {name} will be sent over Bluetooth.', { name: item.name })}${result.reason ? ` (${result.reason})` : ''}`)
      if (result.via === 'wifi') onSent?.()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setSending(null) }
  }

  return <section className="phone-only-recordings" aria-label={t('On this phone only')}>
    <header><Smartphone /><strong>{t('On this phone only')}</strong><Link to="/devices">{t('Recordings on this phone')}</Link></header>
    <p className="device-muted">{t('These recordings are saved on this phone and are not on the computer yet.')}</p>
    {items.map(item => <article key={item.id}>
      <span><strong>{item.name}</strong><small>{item.addedAt ? formatDate(item.addedAt) : ''} · {t('{value} KB', { value: (item.size / 1024).toFixed(0) })}
        {item.send ? ` · ${t('Waiting for the computer')}` : ''}</small></span>
      <TranscriptActions item={item} transcription={transcription} />
      <Button size="sm" variant="outline" disabled={sending !== null} onClick={() => void send(item)}>
        {sending?.id === item.id ? <><Loader2 className="animate-spin" />{sending.percent === null ? t('Sending...') : `${sending.percent}%`}</> : <><UploadCloud />{t('Send to computer')}</>}
      </Button>
    </article>)}
    {message && <p className="device-muted" role="status">{message}</p>}
  </section>
}
