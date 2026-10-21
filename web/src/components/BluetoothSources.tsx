import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bluetooth, Check, Inbox, Loader2, Smartphone } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { devicesApi, type DeviceSourceStatus, type InboxStatus } from '@/lib/devices-api'
import { formatDate, t } from '@/i18n'
import './bluetooth-sources.css'

/**
 * Bluetooth recording sources other than the Plaud panel above it: recordings a phone
 * sends with Bluetooth file transfer, and drivers such as a paired Android phone.
 */
export function BluetoothSources() {
  const [sources, setSources] = useState<DeviceSourceStatus[]>([])
  const [inbox, setInbox] = useState<InboxStatus | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')

  const load = useCallback(async () => {
    const data = await devicesApi.list()
    setSources(data.sources.filter(source => source.driver !== 'plaud')); setInbox(data.inbox); setPath(current => current || data.inbox.path)
  }, [])
  useEffect(() => {
    void load().catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
    const timer = window.setInterval(() => { void load().catch(() => undefined) }, 10000)
    return () => window.clearInterval(timer)
  }, [load])

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await work(); await load() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setBusy(false) }
  }

  return <section className="bt-sources" aria-label={t('Other Bluetooth sources')}>
    <header className="bt-sources-heading"><Bluetooth /><div><h2>{t('Other Bluetooth sources')}</h2><p>{t('Recordings from your phone and other Bluetooth recorders.')}</p></div></header>

    {sources.map(source => <article key={source.driver} className="bt-source-card">
      <header><Smartphone /><div><h3>{source.label}</h3><small>{source.configured ? source.lastChecked ? t('Last checked {time}', { time: formatDate(source.lastChecked) }) : t('Paired') : t('Not paired yet')}</small></div></header>
      <label className="bt-toggle"><input type="checkbox" checked={source.enabled} disabled={busy || !source.configured} onChange={event => void act(() => devicesApi.setAutoImport(source.driver, event.target.checked))} /><span><strong>{t('Automatic import over Bluetooth')}</strong><small>{t('New finished recordings are copied to this computer; originals stay on the device.')}</small></span></label>
      {!source.configured && <p className="bt-note">{t('Pair the phone first on the Android page, then keep OpenPlaud open on the phone.')} <Link to="/android">{t('Open Android pairing')}</Link></p>}
      {source.error && <p className="bt-error" role="alert">{source.error}</p>}
    </article>)}

    {inbox && <article className="bt-source-card">
      <header><Inbox /><div><h3>{t('Bluetooth file inbox')}</h3><small>{inbox.watching ? t('Watching for received files') : t('Off')}</small></div></header>
      <label className="bt-toggle"><input type="checkbox" checked={inbox.enabled} disabled={busy} onChange={event => void act(() => devicesApi.configureInbox({ enabled: event.target.checked, path }))} /><span><strong>{t('Import audio sent over Bluetooth')}</strong><small>{t('AMR, 3GP and Opus phone recordings are converted to M4A. Received files are never deleted.')}</small></span></label>
      <div className="bt-path"><label>{t('Folder')}<input value={path} onChange={event => setPath(event.target.value)} spellCheck={false} /></label><Button size="sm" variant="outline" disabled={busy || path === inbox.path} onClick={() => void act(() => devicesApi.configureInbox({ path }))}>{busy ? <Loader2 className="animate-spin" /> : null}{t('Save')}</Button></div>
      <ol className="bt-steps">
        <li>{t('On Windows, open Bluetooth settings, choose “Send or receive files via Bluetooth”, then “Receive files”.')}</li>
        <li>{t('On the phone, share the recording, choose Bluetooth and select this computer.')}</li>
        <li>{t('When Windows asks where to save, choose the folder above. The recording appears in your library within seconds.')}</li>
      </ol>
      {inbox.events.length > 0 && <ul className="bt-events">{inbox.events.map(event => <li key={`${event.file}-${event.at}`}>
        {event.error ? <span className="bt-error">{event.file}: {event.error}</span> : event.recordingId ? <><Check /><Link to={`/recording/${event.recordingId}`}>{event.file}</Link></> : <span>{t('{file} is already in your library', { file: event.file })}</span>}
      </li>)}</ul>}
    </article>}
    {error && <p className="bt-error" role="alert">{error}</p>}
  </section>
}
