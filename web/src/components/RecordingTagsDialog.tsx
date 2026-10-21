import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Plus, RefreshCw, Sparkles, Tag, X } from "@/components/icons"
import { NoteDialog } from './NoteDialogs'
import { Button } from './ui/button'
import { api, type Recording } from '@/lib/api'
import { addRecordingTags } from '@/lib/recording-tags'
import { knowledgeApi, type RecordingSuggestions } from '@/lib/knowledge'
import { t } from '@/i18n'
import './recording-tags.css'
import './knowledge.css'

export function RecordingTagsDialog({ recording, onSaved, onClose }: {
  recording: Recording
  onSaved: (recording: Recording) => void
  onClose: () => void
}) {
  const [saved, setSaved] = useState<Recording | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // KB-05: reviewable suggestions. Nothing changes until the person ticks one and saves.
  const [suggestion, setSuggestion] = useState<RecordingSuggestions | null>(null)
  const [useTitle, setUseTitle] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const suggestAbort = useRef<AbortController | null>(null)
  useEffect(() => () => suggestAbort.current?.abort(), [])
  const suggest = async () => {
    const controller = new AbortController(); suggestAbort.current = controller
    setSuggesting(true); setError('')
    try { const next = await knowledgeApi.suggestRecording(recording.id, controller.signal); setSuggestion(next); setUseTitle(false) }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('Suggestions failed.')) }
    finally { if (!controller.signal.aborted) setSuggesting(false) }
  }

  useEffect(() => {
    let disposed = false
    api.getRecording(recording.id).then(row => {
      if (disposed) return
      setSaved(row); setTags(row.tags); setInput('')
    }).catch(failure => {
      if (!disposed) setError(failure instanceof Error ? failure.message : t('Could not load tags.'))
    }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [recording.id, reload])
  useEffect(() => { if (!loading) inputRef.current?.focus() }, [loading])

  const pendingTags = addRecordingTags(tags, input)
  const title = useTitle && suggestion?.title ? suggestion.title : null
  const changed = saved && (JSON.stringify(pendingTags) !== JSON.stringify(saved.tags) || title !== null)
  const add = () => { setTags(pendingTags); setInput(''); inputRef.current?.focus() }
  return <NoteDialog title={t('Edit tags')} description={recording.title} onClose={onClose} busy={busy}>
    <form onSubmit={async event => {
      event.preventDefault()
      if (!saved || !changed || loading || busy) return
      setBusy(true); setError('')
      try {
        const updated = await api.updateRecording(recording.id, { tags: pendingTags, ...(title ? { title } : {}), revision: saved.revision })
        onSaved(updated); onClose()
      } catch (failure) {
        setError(failure instanceof Error && failure.message === 'revision_conflict'
          ? t('This recording changed elsewhere. Reload tags before saving again.')
          : failure instanceof Error ? failure.message : t('Could not save tags.'))
      } finally { setBusy(false) }
    }}>
      {loading ? <p role="status" className="recording-tags-loading"><Loader2 className="animate-spin" />{t('Loading tags...')}</p> : <>
        <ul className="recording-tag-list" aria-label={t('Recording tags')}>
          {tags.map(tag => <li key={tag}><Tag aria-hidden="true" /><span>{tag}</span><button type="button" disabled={busy} aria-label={t('Remove tag {tag}', { tag })} title={t('Remove {tag}', { tag })} onClick={() => setTags(current => current.filter(value => value !== tag))}><X /></button></li>)}
        </ul>
        <label htmlFor="recording-tag-input">{t('Add a tag')}</label>
        <div className="recording-tag-input">
          <input ref={inputRef} id="recording-tag-input" value={input} disabled={busy || !saved} autoComplete="off" onChange={event => setInput(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && input.trim()) { event.preventDefault(); add() }
          }} />
          <Button type="button" variant="outline" size="icon" aria-label={t('Add tag')} title={t('Add tag')} disabled={busy || !saved || !input.trim()} onClick={add}><Plus /></Button>
        </div>
        {saved?.hasTranscript !== false && <div className="knowledge-suggestion">
          <div className="knowledge-row">
            <Button type="button" variant="outline" size="sm" disabled={busy || suggesting || !saved} onClick={() => void suggest()}>{suggesting ? <Loader2 className="animate-spin" /> : <Sparkles />}{t('Suggest title and tags')}</Button>
          </div>
          <p className="knowledge-note">{t('Sends the beginning of this transcript to your analysis provider. Suggestions are only applied when you tick them and save.')}</p>
          {suggestion && <>
            {suggestion.title && <label><input type="checkbox" checked={useTitle} disabled={busy} onChange={event => setUseTitle(event.target.checked)} />{t('Rename to “{title}”', { title: suggestion.title })}</label>}
            {suggestion.tags.length > 0 && <div className="knowledge-chips" aria-label={t('Suggested tags')}>{suggestion.tags.map(tag => <button key={tag} type="button" disabled={busy || tags.some(value => value.toLocaleLowerCase() === tag)} onClick={() => setTags(current => addRecordingTags(current, tag))}><Plus aria-hidden="true" />{tag}</button>)}</div>}
            {!suggestion.title && !suggestion.tags.length && <p className="knowledge-note">{t('No new title or tags were suggested.')}</p>}
            <p className="knowledge-note">{suggestion.provider} / {suggestion.model}{suggestion.truncated ? ` / ${t('excerpts across the transcript were read; some content was omitted')}` : ''}</p>
          </>}
        </div>}
      </>}
      {error && <div className="recording-tags-error"><p role="alert" className="note-error">{error}</p><Button type="button" size="sm" variant="ghost" disabled={busy || loading} onClick={() => { setLoading(true); setError(''); setSaved(null); setReload(value => value + 1) }}><RefreshCw />{t('Reload tags')}</Button></div>}
      <footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />{t('Cancel')}</Button><Button disabled={loading || busy || !changed}>{busy ? <Loader2 className="animate-spin" /> : <Check />}{title ? t('Save') : t('Save tags')}</Button></footer>
    </form>
  </NoteDialog>
}
