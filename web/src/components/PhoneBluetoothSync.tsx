import { useCallback, useEffect, useState } from 'react'
import { Bluetooth, Check, Loader2, Upload, UploadCloud, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { deviceCommand } from '@/lib/plaud-device'
import { phoneLibrary, sendToComputer, type PhoneLibrary, type PhoneRecording } from '@/lib/phone-library'
import { authenticatedHeaders, apiUrl, getRuntime } from '@/lib/runtime'
import { formatDate, t } from '@/i18n'
import { PhoneTranscriptionSettings, TranscriptActions } from '@/components/PhoneTranscription'
import { usePhoneTranscription } from '@/lib/use-phone-transcription'

interface PhoneBleState { enabled: boolean; active: boolean; status: string; clientId: string | null }

/** This phone's own pairing id on the desktop, needed to prove the pairing over Bluetooth. */
async function pairedClientId(): Promise<string> {
  const response = await fetch(apiUrl('/mobile/clients/me'), { headers: authenticatedHeaders() })
  const payload = await response.json().catch(() => null) as { data?: { kind?: string; id?: string } } | null
  if (!response.ok || payload?.data?.kind !== 'client' || !payload.data.id) throw new Error(t('Connect to the desktop once on the same Wi-Fi to turn on Bluetooth sync.'))
  if (payload.data.id === 'legacy') throw new Error(t('This phone uses an old pairing code. Pair it again from the desktop’s Android page.'))
  return payload.data.id
}

/**
 * The phone's own recording library and "Sync over Bluetooth". Recordings added here (from files
 * or by sharing to OpenPlod) stay on the phone; the paired desktop copies them over Bluetooth and
 * confirms, so each side keeps its own copy and pairing never deletes anything.
 */
export function PhoneBluetoothSync() {
  const [state, setState] = useState<PhoneBleState | null>(null)
  const [library, setLibrary] = useState<PhoneRecording[] | null>(null)
  const [autoSend, setAutoSend] = useState(false)
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const transcription = usePhoneTranscription()

  const apply = useCallback((value: PhoneLibrary) => { setLibrary(value.recordings); setAutoSend(value.autoSend); setFolder(value.folder ?? '') }, [])
  const loadLibrary = useCallback(() => phoneLibrary.list().then(apply).catch(() => undefined), [apply])
  const change = async (work: () => Promise<PhoneLibrary>) => {
    setBusy(true); setError('')
    try { apply(await work()) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setBusy(false) }
  }
  useEffect(() => {
    let active = true
    const load = () => {
      deviceCommand<PhoneBleState>('phoneBleStatus').then(value => { if (active) setState(value) }).catch(() => undefined)
      void loadLibrary()
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [loadLibrary])

  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('')
    try {
      const args = enabled ? { enabled, clientId: await pairedClientId(), pairingToken: getRuntime().pairingToken } : { enabled }
      setState(await deviceCommand<PhoneBleState>('phoneBleSync', args))
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setBusy(false) }
  }

  const pick = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await phoneLibrary.pick()
      apply(result)
      if (result.added) setNotice(t('{count} recording(s) added to this phone.', { count: result.added }))
      if (result.skipped?.length) setError(t('Not audio, or could not be read: {files}', { files: result.skipped.join(', ') }))
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setBusy(false) }
  }

  const waiting = library?.filter(item => item.send && !item.onDesktop).length ?? 0
  const status = (item: PhoneRecording) => item.onDesktop ? t('On the computer')
    : !item.send ? t('Only on this phone')
      : state?.enabled ? t('Waiting for the computer') : t('Turn on Bluetooth sync to send')
  return <><PhoneTranscriptionSettings transcription={transcription} />
  <section className="device-section" aria-label={t('Recordings on this phone')}>
    <div className="device-section-heading"><h2>{t('Recordings on this phone')}</h2>
      <Button size="sm" disabled={busy} onClick={() => void pick()}>{busy ? <Loader2 className="animate-spin" /> : <Upload />}{t('Add from files')}</Button>
    </div>
    <p className="device-muted">{t('Recordings made in OpenPlod, picked from files, or shared from any app are saved on this phone. Nothing leaves the phone unless you send it.')}</p>
    {folder && <p className="device-muted">{t('Recordings made in OpenPlod are also copied to the {folder} folder, so they stay even if the app is removed.', { folder })}</p>}
    <label className="device-recording-row">
      <input type="checkbox" checked={autoSend} disabled={busy || library === null} onChange={event => void change(() => phoneLibrary.setAutoSend(event.target.checked))} />
      <span><strong>{t('Send new recordings to the computer automatically')}</strong>
        <small>{autoSend ? t('New recordings are marked for the computer as soon as they are saved.') : t('Off: new recordings stay only on this phone until you tap Send.')}</small></span>
    </label>
    {notice && <p className="device-muted" role="status">{notice}</p>}
    {library && library.length === 0 && <p className="device-muted">{t('No recordings yet.')}</p>}
    {library?.map(item => <article className="device-recording-row" key={item.id}>
      <span><strong>{item.name}</strong><small>{item.addedAt ? formatDate(item.addedAt) : ''} · {t('{value} KB', { value: (item.size / 1024).toFixed(0) })} · {status(item)}{item.inFolder ? ` · ${t('In {folder}', { folder })}` : ''}</small></span>
      <TranscriptActions item={item} transcription={transcription} />
      {item.onDesktop ? <Check aria-label={t('On the computer')} />
        : item.send ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change(() => phoneLibrary.setSend(item.id, false))}><X />{t('Don’t send')}</Button>
          : <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(async () => { const result = await sendToComputer(item); setNotice(result.via === 'wifi' ? t('{name} is now on the computer.', { name: item.name }) : `${t('The computer is not reachable over Wi-Fi. {name} will be sent over Bluetooth.', { name: item.name })}${result.reason ? ` (${result.reason})` : ''}`); return result.library })}><UploadCloud />{t('Send to computer')}</Button>}
    </article>)}

    <label className="device-recording-row">
      <input type="checkbox" checked={state?.enabled ?? false} disabled={busy || !state} onChange={event => void toggle(event.target.checked)} />
      <span><strong>{busy ? <Loader2 className="animate-spin" /> : <Bluetooth />} {t('Sync over Bluetooth')}</strong>
        <small>{t('Your computer copies the recordings you send over Bluetooth, even without Wi-Fi. Nothing is deleted from the phone.')}</small>
        {state?.enabled && <small role="status">{state.status}{waiting ? ` · ${t('{count} waiting', { count: waiting })}` : ''}</small>}
      </span>
    </label>
    {state?.enabled && <p className="device-muted">{t('No Bluetooth pairing dialog is needed: your computer proves it is the desktop this phone is paired with, and recordings travel encrypted.')}</p>}
    {error && <p className="device-error" role="alert">{error}</p>}
  </section></>
}
