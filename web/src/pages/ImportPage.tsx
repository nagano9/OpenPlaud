import { useEffect, useRef, useState } from 'react'
import { FileAudio, FolderOpen, Loader2, RefreshCw, Upload } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { PlaudImportDialog } from '@/components/PlaudImportDialog'
import { api, type AvailableRecording } from '@/lib/api'
import { getRuntime } from '@/lib/runtime'
import { RECORDING_ACCEPT, isRecordingFile } from '@/lib/audio-formats'
import { t, tn } from '@/i18n'
export function ImportPage() {
  const [files, setFiles] = useState<AvailableRecording[]>([]), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const refresh = async () => { setBusy(true); setError(''); try { setFiles(await api.getAvailableRecordings()) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  useEffect(() => { let stopped = false; api.getAvailableRecordings().then(rows => { if (!stopped) setFiles(rows) }).catch(e => { if (!stopped) setError(e.message) }); return () => { stopped = true } }, [])
  const upload = async (picked: File[]) => {
    setBusy(true); setError(''); setMessage('')
    const failed: string[] = []
    let saved = 0
    try {
      for (const file of picked) {
        if (!isRecordingFile(file.name) && !file.type.startsWith('audio/')) { failed.push(`${file.name}: ${t('not a recording format')}`); continue }
        try { await api.uploadRecording(file, getRuntime().mode === 'mobile'); saved++ } catch (e) { failed.push(`${file.name}: ${(e as Error).message}`) }
      }
      if (saved) { setMessage(tn(saved, '{count} recording saved to your vault.', '{count} recordings saved to your vault.')); window.dispatchEvent(new CustomEvent('plaud:sync-complete')) }
      if (failed.length) setError(failed.join(' · '))
    } finally { setBusy(false); if (picker.current) picker.current.value = '' }
  }
  const importFiles = async () => { if (!selected.length || !window.confirm(tn(selected.length, 'Import {count} selected file into your vault?', 'Import {count} selected files into your vault?'))) return; setBusy(true); setError(''); try { await api.importRecordings(selected); setSelected([]); setMessage(t('Import completed.')); window.dispatchEvent(new CustomEvent('plaud:sync-complete')); await refresh() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  return <div className="studio-secondary-page"><header><h1>{t('Import')}</h1><div><Button disabled={busy} onClick={() => picker.current?.click()}>{busy ? <Loader2 className="animate-spin" /> : <Upload />}{t('Upload audio')}</Button><PlaudImportDialog variant="outline" /></div></header><input className="sr-only" ref={picker} type="file" multiple accept={RECORDING_ACCEPT} aria-label={t('Upload audio')} tabIndex={-1} onChange={e => { const picked = [...(e.target.files ?? [])]; if (picked.length) void upload(picked) }} />
    <p className="device-muted">{t('Accepted: MP3, M4A, WAV, AAC, FLAC, OGG, Opus, WebM, AMR, 3GP, WMA, AIFF, CAF, and the audio of MP4, MOV and MKV videos. Formats other than the first seven are converted to M4A; the original file is kept.')}</p>
    {error && <p role="alert" className="device-error">{error}</p>}{message && <p role="status">{message}</p>}
    <section><div className="studio-section-heading"><h2><FolderOpen />{t('Export folder')}</h2><Button variant="ghost" size="icon" aria-label={t('Refresh folder')} title={t('Refresh folder')} disabled={busy} onClick={() => void refresh()}><RefreshCw /></Button></div>
      {!files.length ? <div className="studio-empty"><FileAudio /><h2>{t('No audio files available')}</h2><p>{t('Choose an audio file or connect your Plaud.')}</p></div> : files.map(file => <label className="device-recording-row" key={file.fingerprint}><input type="checkbox" disabled={busy || file.imported} checked={selected.includes(file.path)} onChange={e => setSelected(rows => e.target.checked ? [...rows, file.path] : rows.filter(path => path !== file.path))} /><span><strong>{file.filename}</strong><small>{file.imported ? t('Already imported') : `${Math.round(file.size / 1024)} KB`}</small></span></label>)}
      {!!files.length && <Button disabled={busy || !selected.length} onClick={() => void importFiles()}><Upload />{t('Import selected')}</Button>}
    </section></div>
}
