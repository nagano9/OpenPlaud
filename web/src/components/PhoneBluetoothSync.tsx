import { useEffect, useState } from 'react'
import { Bluetooth, Loader2 } from '@/components/icons'
import { deviceCommand } from '@/lib/plaud-device'
import { authenticatedHeaders, apiUrl, getRuntime } from '@/lib/runtime'
import { t } from '@/i18n'

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
 * "Sync over Bluetooth": the phone advertises its voice recordings so the paired desktop can
 * copy them without Wi-Fi. Turning it on needs the desktop once, to learn this phone's id.
 */
export function PhoneBluetoothSync() {
  const [state, setState] = useState<PhoneBleState | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = () => deviceCommand<PhoneBleState>('phoneBleStatus').then(value => { if (active) setState(value) }).catch(() => undefined)
    void load()
    const timer = window.setInterval(load, 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('')
    try {
      const args = enabled ? { enabled, clientId: await pairedClientId(), pairingToken: getRuntime().pairingToken } : { enabled }
      setState(await deviceCommand<PhoneBleState>('phoneBleSync', args))
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setBusy(false) }
  }

  return <section className="device-section" aria-label={t('Sync over Bluetooth')}>
    <label className="device-recording-row">
      <input type="checkbox" checked={state?.enabled ?? false} disabled={busy || !state} onChange={event => void toggle(event.target.checked)} />
      <span><strong>{busy ? <Loader2 className="animate-spin" /> : <Bluetooth />} {t('Sync over Bluetooth')}</strong>
        <small>{t('Your desktop copies this phone’s voice recorder files over Bluetooth, even without Wi-Fi. Nothing is deleted from the phone.')}</small>
        {state?.enabled && <small role="status">{state.status}</small>}
      </span>
    </label>
    {state?.enabled && <p className="device-muted">{t('The first time, Android asks to pair with your computer. Accept it on both devices.')}</p>}
    {error && <p className="device-error" role="alert">{error}</p>}
  </section>
}
