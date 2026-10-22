import { useCallback, useEffect, useState } from 'react'
import { Bluetooth, Check, Loader2, Upload } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { deviceCommand } from '@/lib/plaud-device'
import { authenticatedHeaders, apiUrl, getRuntime } from '@/lib/runtime'
import { formatDate, t } from '@/i18n'

interface PhoneBleState { enabled: boolean; active: boolean; status: string; clientId: string | null }
interface PhoneRecording { id: string; name: string; size: number; addedAt: number | null; onDesktop: boolean }
interface PhoneLibrary { recordings: PhoneRecording[]; added?: number; skipped?: string[] }

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
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')

  const loadLibrary = useCallback(() => deviceCommand<PhoneLibrary>('phoneLibrary').then(value => setLibrary(value.recordings)).catch(() => undefined), [])
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
      const result = await deviceCommand<PhoneLibrary>('phonePickRecordings')
      setLibrary(result.recordings)
      if (result.added) setNotice(t('{count} recording(s) added to this phone.', { count: result.added }))
      if (result.skipped?.length) setError(t('Not audio, or could not be read: {files}', { files: result.skipped.join(', ') }))
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setBusy(false) }
  }

  const waiting = library?.filter(item => !item.onDesktop).length ?? 0
  return <section className="device-section" aria-label={t('Recordings on this phone')}>
    <div className="device-section-heading"><h2>{t('Recordings on this phone')}</h2>
      <Button size="sm" disabled={busy} onClick={() => void pick()}>{busy ? <Loader2 className="animate-spin" /> : <Upload />}{t('Add from files')}</Button>
    </div>
    <p className="device-muted">{t('Pick recordings from your phone’s files, or share a recording to OpenPlod from any app. They stay on this phone; the desktop keeps its own copy.')}</p>
    {notice && <p className="device-muted" role="status">{notice}</p>}
    {library && library.length === 0 && <p className="device-muted">{t('No recordings added yet.')}</p>}
    {library?.map(item => <article className="device-recording-row" key={item.id}>
      <span><strong>{item.name}</strong><small>{item.addedAt ? formatDate(item.addedAt) : ''} · {t('{value} KB', { value: (item.size / 1024).toFixed(0) })} · {item.onDesktop ? t('On the desktop') : state?.enabled ? t('Waiting for the desktop') : t('Turn on Bluetooth sync to send')}</small></span>
      {item.onDesktop && <Check aria-label={t('On the desktop')} />}
    </article>)}

    <label className="device-recording-row">
      <input type="checkbox" checked={state?.enabled ?? false} disabled={busy || !state} onChange={event => void toggle(event.target.checked)} />
      <span><strong>{busy ? <Loader2 className="animate-spin" /> : <Bluetooth />} {t('Sync over Bluetooth')}</strong>
        <small>{t('Your desktop copies this phone’s voice recorder files over Bluetooth, even without Wi-Fi. Nothing is deleted from the phone.')}</small>
        {state?.enabled && <small role="status">{state.status}{waiting ? ` · ${t('{count} waiting', { count: waiting })}` : ''}</small>}
      </span>
    </label>
    {state?.enabled && <p className="device-muted">{t('No Bluetooth pairing dialog is needed: your computer proves it is the desktop this phone is paired with, and recordings travel encrypted.')}</p>}
    {error && <p className="device-error" role="alert">{error}</p>}
  </section>
}
