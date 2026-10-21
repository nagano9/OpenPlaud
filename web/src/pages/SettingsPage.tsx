import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Save, Loader2, AlertCircle, Smartphone, Rocket } from "@/components/icons"
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { api, type Settings } from '@/lib/api'
import { getRuntime } from '@/lib/runtime'
import { buildInfo, buildLabel } from '@/lib/build-info'
import { AiSettingsPanel } from '@/components/AiSettingsPanel'
import { TranscriptionProfilesPanel } from '@/components/TranscriptionProfilesPanel'
import { UpdatePanel } from '@/components/UpdatePanel'
import { BackupRestorePanel } from '@/components/BackupRestorePanel'
import { SearchIndexPanel } from '@/components/SearchIndexPanel'
import { ONBOARDING_EVENT, onboardingApi } from '@/lib/ai-settings'
import { LOCALES, setLocale, t, useLocale, type Locale } from '@/i18n'

function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description: string }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-secondary'}`}
      >
        <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform shadow-sm ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

export function SettingsPage() {
  const { hash } = useLocation()
  const pairingSection = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (hash === '#pairing' && pairingSection.current) {
      pairingSection.current.open = true
      pairingSection.current.scrollIntoView({ block: 'start' })
    }
    // Sections that load asynchronously (profiles) are scrolled to once they render.
    else if (hash.length > 1) {
      const timer = window.setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' }), 300)
      return () => window.clearTimeout(timer)
    }
  }, [hash])
  const runtime = getRuntime()
  const locale = useLocale()
  const [settings, setSettings] = useState<Settings>({
    transcriptionEngine: 'whisper',
    mistralApiKey: '',
    deepgramApiKey: '',
    mistralApiKeyConfigured: false,
    deepgramApiKeyConfigured: false,
    syncFolderPath: '~/Documents/PlaudSync',
    autoTranscribe: true,
    autoSummarize: true,
    autoImport: false,
    plaudRecordingTypes: ['class', 'meeting', 'conversation', 'other'],
    deleteSourceAfterImport: false,
    openWhistleForwarding: false,
    openWhistleBaseUrl: '',
    openWhistleApiKey: '',
    openWhistleApiKeyConfigured: false,
    openWhistleAgentId: '',
  })
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const savedTimer = useRef<number | null>(null)

  useEffect(() => {
    api.getSettings().then(value => { setSettings(value); setLoaded(true) }).catch(loadError => {
      setError(loadError instanceof Error ? loadError.message : t('Could not load settings'))
    })
    return () => {
      if (savedTimer.current) window.clearTimeout(savedTimer.current)
    }
  }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const general = Object.fromEntries(Object.entries(settings).filter(([key]) => !['transcriptionEngine', 'mistralApiKey', 'deepgramApiKey'].includes(key))) as Partial<Settings>
      setSettings(await api.updateSettings(general))
      setSaved(true)
      if (savedTimer.current) window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSaved(false), 2000)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('Could not save settings'))
    } finally {
      setSaving(false)
    }
  }

  const update = (patch: Partial<Settings>) => setSettings(s => ({ ...s, ...patch }))

  return (
    <div className="settings-page">
      <div className="flex items-center justify-between">
        <div>
          <h1>{t('Settings')}</h1>
        </div>
        <Button onClick={save} disabled={saving || !loaded}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
          {saved ? t('Saved!') : t('Save')}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 border-b pb-4">
        <label htmlFor="settings-language" className="text-sm font-medium">{t('Language')}</label>
        <select id="settings-language" className="rounded-md border bg-background px-2 py-1 text-sm" value={locale} onChange={event => setLocale(event.target.value as Locale)}>
          {LOCALES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </div>

      <details className="border-b pb-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">{t('About OpenPlod')}</summary>
        <dl className="grid gap-3 py-4 text-sm"><div><dt className="text-muted-foreground">{t('Version')}</dt><dd>{buildInfo.version}</dd></div><div><dt className="text-muted-foreground">{t('Installed build')}</dt><dd><time dateTime={buildInfo.builtAt}>{buildLabel}</time></dd></div><div><dt className="text-muted-foreground">{t('Platform')}</dt><dd>{runtime.mode === 'desktop' ? t('Desktop') : runtime.mode === 'mobile' ? t('Mobile') : t('Browser')}</dd></div></dl>
        <Button variant="outline" onClick={() => { void onboardingApi.reset().catch(() => {}).finally(() => window.dispatchEvent(new Event(ONBOARDING_EVENT))) }}><Rocket />{t('Run the setup guide again')}</Button>
        <UpdatePanel />
      </details>

      <details id="pairing" ref={pairingSection} className="border-b pb-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">{t('Mobile pairing')}</summary>
        <Button asChild variant="outline" className="mt-4"><Link to="/android"><Smartphone />{t('Android connection')}</Link></Button>
      </details>

      <AiSettingsPanel />
      <TranscriptionProfilesPanel />
      <BackupRestorePanel />
      <SearchIndexPanel />

      {/* Sync */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('Sync')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="settings-sync-folder" className="text-sm font-medium">{t('Plaud Sync Folder')}</label>
            <Input
              id="settings-sync-folder"
              value={settings.syncFolderPath}
              onChange={e => update({ syncFolderPath: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t('Path to your PlaudSync folder on this machine')}</p>
          </div>
        </CardContent>
      </Card>

      {/* Automation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('Automation')}</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <Toggle
            checked={settings.autoImport}
            onChange={v => update({ autoImport: v })}
            label={t('Auto-import Plaud recordings')}
            description={t('Import new files when they appear in the Plaud sync folder')}
          />
          <div className="py-3">
            <p className="text-sm font-medium">{t('Recording types')}</p>
            <p className="mb-3 text-xs text-muted-foreground">{t('Choose which detected Plaud exports are imported automatically')}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {['class', 'meeting', 'conversation', 'other'].map(type => (
                <label key={type} className="flex items-center gap-2 text-sm capitalize">
                  <input
                    type="checkbox"
                    checked={settings.plaudRecordingTypes.includes(type)}
                    onChange={() => update({
                      plaudRecordingTypes: settings.plaudRecordingTypes.includes(type)
                        ? settings.plaudRecordingTypes.filter(value => value !== type)
                        : [...settings.plaudRecordingTypes, type],
                    })}
                  />
                  {({ class: t('Class'), meeting: t('Meeting'), conversation: t('Conversation'), other: t('Other') } as Record<string, string>)[type]}
                </label>
              ))}
            </div>
          </div>
          <Toggle
            checked={settings.deleteSourceAfterImport}
            onChange={v => update({ deleteSourceAfterImport: v })}
            label={t('Delete exported file after import')}
            description={t('Keep the durable vault copy and remove the source export')}
          />
          <Toggle
            checked={settings.autoTranscribe}
            onChange={v => update({ autoTranscribe: v })}
            label={t('Auto-transcribe')}
            description={t('Automatically transcribe new recordings when synced')}
          />
          <Toggle
            checked={settings.autoSummarize}
            onChange={v => update({ autoSummarize: v })}
            label={t('Auto-summarize')}
            description={t('Generate AI summary after transcription completes')}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">OpenWhistle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Toggle
            checked={settings.openWhistleForwarding}
            onChange={v => update({ openWhistleForwarding: v })}
            label={t('Forward recordings')}
            description={t('Send imported audio to OpenWhistle for agents and connectors')}
          />
          <div className="space-y-2">
            <label htmlFor="settings-ow-url" className="text-sm font-medium">{t('API base URL')}</label>
            <Input id="settings-ow-url" value={settings.openWhistleBaseUrl} onChange={e => update({ openWhistleBaseUrl: e.target.value })} placeholder="https://openwhistle.pro/api/v1" />
          </div>
          <div className="space-y-2">
            <label htmlFor="settings-ow-agent" className="text-sm font-medium">{t('Agent ID')}</label>
            <Input id="settings-ow-agent" value={settings.openWhistleAgentId} onChange={e => update({ openWhistleAgentId: e.target.value })} />
          </div>
          <div className="space-y-2">
            <label htmlFor="settings-ow-key" className="text-sm font-medium">{t('API key')}</label>
            <Input id="settings-ow-key" type="password" value={settings.openWhistleApiKey || ''} onChange={e => update({ openWhistleApiKey: e.target.value })} placeholder={settings.openWhistleApiKeyConfigured ? t('Saved key (enter a new key to replace)') : 'owk_...'} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
