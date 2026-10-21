import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertCircle, ArrowUp, Check, Copy, Download, History, KeyRound, ListChecks, Loader2, Pencil, Plus, RefreshCw, RotateCcw, Save, Send, ShieldCheck, Trash2, Undo2, Wand2, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { NoteDialog, FolderSelect } from '@/components/NoteDialogs'
import { notesApi, DOCUMENT_STYLES, documentStyleLabel, type DocumentStyle, type NoteFolder } from '@/lib/notes-api'
import { aiSettingsApi, profilesApi, type AiSettings, type TranscriptionProfile } from '@/lib/ai-settings'
import { api, type Recording } from '@/lib/api'
import {
  CONNECTORS, RECORDING_TYPES, RULE_SOURCES, TASK_EXECUTION_STATUSES, VERIFY_SNIPPET, WEBHOOK_EVENT_TYPES, blankRule, pendingAcknowledgements,
  buildTaskPatch, rulesApi, tasksApi, webhooksApi,
  type AutomationRule, type Connector, type ConnectorSettings, type RuleAction, type RuleInput, type RulePreview, type RuleRun, type RuleTrigger, type TaskDraft, type TaskExecutionStatus,
  type WebhookDelivery, type WebhookEventType, type WebhookSubscription,
} from '@/lib/automation-api'
import { formatDate, t, tn } from '@/i18n'
import './automations.css'

type Tab = 'rules' | 'history' | 'webhooks' | 'tasks'
const tabs = (): [Tab, string][] => [['rules', t('Rules')], ['history', t('History')], ['webhooks', 'Webhooks'], ['tasks', t('Tasks')]]
const message = (error: unknown) => error instanceof Error ? error.message : t('Something went wrong.')
const when = (iso: string | null) => iso ? formatDate(iso) : '—'
const sourceLabel = (source: string) => ({ plaud: 'Plaud', upload: t('Uploads'), mobile: t('Phone') } as Record<string, string>)[source] ?? source
const recordingTypeLabel = (type: string) => ({ meeting: t('Meeting'), conversation: t('Conversation'), class: t('Class'), other: t('Other') } as Record<string, string>)[type] ?? type
const templateLabel = (template: string) => DOCUMENT_STYLES.includes(template as DocumentStyle) ? documentStyleLabel(template as DocumentStyle) : template
/** API status values shown as pills. */
const statusLabel = (status: string) => ({
  pending: t('pending'), running: t('running'), waiting: t('waiting'), done: t('done'), complete: t('complete'), skipped: t('skipped'), failed: t('failed'), unknown: t('unknown'),
  cancelled: t('cancelled'), delivering: t('delivering'), delivered: t('delivered'), blocked: t('blocked'), created: t('created'), draft: t('draft'), approved: t('approved'), dismissed: t('dismissed'),
} as Record<string, string>)[status] ?? status
const executionStatusLabel = (status: TaskExecutionStatus) => ({ todo: t('To do'), in_progress: t('In progress'), blocked: t('Blocked'), done: t('Done') } as Record<TaskExecutionStatus, string>)[status]
const connectorName = (connector: string) => connector[0].toUpperCase() + connector.slice(1)
/** Fills `{name}` placeholders of an already translated sentence with React nodes. */
const rich = (text: string, nodes: Record<string, ReactNode>) => text.split(/(\{\w+\})/).map((part, index) => {
  const name = /^\{(\w+)\}$/.exec(part)?.[1]
  return <Fragment key={index}>{name && name in nodes ? nodes[name] : part}</Fragment>
})
/** "New recording: Plaud, Meeting, at least 5 min, tagged client" in the UI language. */
function describeTrigger(trigger: RuleTrigger): string {
  const parts = [
    trigger.sources.length ? trigger.sources.map(sourceLabel).join(t(' or ')) : t('Any source'),
    trigger.recordingTypes.length ? trigger.recordingTypes.map(recordingTypeLabel).join(t(' or ')) : t('any type'),
  ]
  if (trigger.minDurationSeconds) parts.push(t('at least {minutes} min', { minutes: Math.round(trigger.minDurationSeconds / 60) }))
  if (trigger.tag) parts.push(t('tagged {tag}', { tag: trigger.tag }))
  return t('New recording: {conditions}', { conditions: parts.join(', ') })
}
function describeAction(action: RuleAction, names: { webhooks?: Record<string, string>; profiles?: Record<string, string> } = {}): string {
  switch (action.type) {
    case 'transcribe': return action.profileId
      ? t('Transcribe with {provider} ({profile})', { provider: action.provider ?? t('the default provider'), profile: names.profiles?.[action.profileId] ?? t('profile') })
      : t('Transcribe with {provider}', { provider: action.provider ?? t('the default provider') })
    case 'generate_document': return t('Draft {template}', { template: templateLabel(action.template) ?? action.template })
    case 'add_tags': return t('Tag {tags}', { tags: action.tags.join(', ') })
    case 'add_to_collection': return t('Add to collection {collection}', { collection: action.collectionId })
    case 'notify_webhook': return t('Notify {webhook}', { webhook: names.webhooks?.[action.subscriptionId] ?? 'webhook' })
  }
}

/**
 * Automations (roadmap KB-08..KB-10): opt-in rules with a preview and explicit
 * approval for anything that leaves the computer, their execution history,
 * signed webhooks, and reviewed task exports. Nothing here runs or posts until
 * the person turns it on or presses the button.
 */
export function AutomationsPage() {
  const [tab, setTab] = useState<Tab>('rules')
  return <div className="studio-secondary-page automations-page">
    <header><div className="automations-title"><h1>{t('Automations')}</h1>
      <p>{t('Opt-in rules for new recordings, signed webhooks, and reviewed task exports. Transcript text never triggers or changes an action, and nothing is sent anywhere you have not approved.')}</p></div></header>
    <div className="automations-tabs" role="tablist" aria-label={t('Automation sections')}>
      {tabs().map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    <div role="tabpanel">
      {tab === 'rules' && <RulesPanel />}
      {tab === 'history' && <HistoryPanel />}
      {tab === 'webhooks' && <WebhooksPanel />}
      {tab === 'tasks' && <TasksPanel />}
    </div>
  </div>
}

// ============================================================ rules

interface RuleContext { settings: AiSettings | null; profiles: TranscriptionProfile[]; folders: NoteFolder[]; webhooks: WebhookSubscription[] }

function RulesPanel() {
  const [rules, setRules] = useState<AutomationRule[] | null>(null)
  const [context, setContext] = useState<RuleContext>({ settings: null, profiles: [], folders: [], webhooks: [] })
  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    const [list, settings, profiles, folders, hooks] = await Promise.all([rulesApi.list(), aiSettingsApi.get().catch(() => null),
      profilesApi.list().catch(() => ({ profiles: [] })), notesApi.folders().catch(() => []), webhooksApi.list().catch(() => ({ subscriptions: [] }))])
    setRules(list); setContext({ settings, profiles: profiles.profiles, folders, webhooks: hooks.subscriptions })
  }, [])
  useEffect(() => { load().catch(failure => setError(message(failure))) }, [load])
  const names = useMemo(() => ({ webhooks: Object.fromEntries(context.webhooks.map(hook => [hook.id, hook.name])), profiles: Object.fromEntries(context.profiles.map(profile => [profile.id, profile.name])) }), [context])
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('')
    try { await action(); await load() } catch (failure) { setError(message(failure)) } finally { setBusy('') }
  }
  return <section aria-labelledby="rules-title">
    <div className="automations-head"><div><h2 id="rules-title"><Wand2 />{t('Rules')}</h2>
      <p>{t('A rule runs once per new matching recording. Each step is recorded in History and is never repeated on retry.')}</p></div>
      <Button variant="outline" onClick={() => setEditing('new')}><Plus />{t('New rule')}</Button></div>
    {error && <p role="alert" className="note-error">{error}</p>}
    {!rules ? <p role="status" className="automations-empty">{error ? t('Rules unavailable.') : t('Loading rules…')}</p>
      : rules.length === 0 ? <p className="automations-empty">{t('No rules yet. Example: Plaud meetings → transcribe with your chosen provider → draft meeting minutes into Documents/Meetings.')}</p>
      : <ul className="automations-list">{rules.map(rule => <li key={rule.id} className="automation-card">
        <header><h3>{rule.name}</h3><span className="automation-pill" data-state={rule.enabled ? 'on' : 'off'}>{rule.enabled ? t('On') : t('Off')}</span></header>
        <p>{describeTrigger(rule.trigger)}</p>
        <ol className="automation-steps">{rule.actions.map((action, index) => <li key={index}>{describeAction(action, names)}</li>)}</ol>
        {rule.acknowledgements.length > 0 && <p className="automation-hint"><ShieldCheck />{t('Approved to send to {destinations}', { destinations: rule.acknowledgements.join(', ') })}</p>}
        <footer>
          <Button size="sm" variant="ghost" onClick={() => setEditing(rule)}><Pencil />{t('Edit')}</Button>
          <Button size="sm" variant="ghost" disabled={busy === rule.id} onClick={() => void run(rule.id, () => rulesApi.update(rule.id, { enabled: !rule.enabled, revision: rule.revision }))}>
            {busy === rule.id ? <Loader2 className="animate-spin" /> : rule.enabled ? <X /> : <Check />}{rule.enabled ? t('Turn off') : t('Turn on')}</Button>
          <Button size="sm" variant="ghost" disabled={busy === `delete:${rule.id}`} onClick={() => { if (window.confirm(t('Delete the rule “{name}”? Its history is kept.', { name: rule.name }))) void run(`delete:${rule.id}`, () => rulesApi.remove(rule.id)) }}><Trash2 />{t('Delete')}</Button>
        </footer>
      </li>)}</ul>}
    {editing && <RuleEditor rule={editing === 'new' ? null : editing} context={context} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load() }} />}
  </section>
}

function defaultAction(type: RuleAction['type'], context: RuleContext): RuleAction {
  switch (type) {
    case 'transcribe': return { type, provider: null, profileId: null }
    case 'generate_document': return { type, template: 'meeting', folderId: null }
    case 'add_tags': return { type, tags: [] }
    case 'add_to_collection': return { type, collectionId: '' }
    case 'notify_webhook': return { type, subscriptionId: context.webhooks[0]?.id ?? '' }
  }
}
const actionLabels = (): Record<RuleAction['type'], string> => ({ transcribe: t('Transcribe'), generate_document: t('Generate document'), add_tags: t('Add tags'), add_to_collection: t('Add to collection'), notify_webhook: t('Notify webhook') })

function RuleEditor({ rule, context, onClose, onSaved }: { rule: AutomationRule | null; context: RuleContext; onClose: () => void; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<RuleInput>(() => rule ? { name: rule.name, enabled: rule.enabled, trigger: rule.trigger, actions: rule.actions, acknowledgements: rule.acknowledgements } : blankRule())
  const [tagText, setTagText] = useState<Record<number, string>>(() => Object.fromEntries(draft.actions.map((action, index) => [index, action.type === 'add_tags' ? action.tags.join(', ') : ''])))
  const [preview, setPreview] = useState<RulePreview | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const set = (patch: Partial<RuleInput>) => { setDraft(value => ({ ...value, ...patch })); setPreview(null) }
  const setTrigger = (patch: Partial<RuleInput['trigger']>) => set({ trigger: { ...draft.trigger, ...patch } })
  const setAction = (index: number, action: RuleAction) => set({ actions: draft.actions.map((item, position) => position === index ? action : item) })
  const toggle = <T extends string>(list: T[], value: T) => list.includes(value) ? list.filter(item => item !== value) : [...list, value]
  const normalized = (): RuleInput => ({ ...draft, actions: draft.actions.map((action, index) => action.type === 'add_tags'
    ? { ...action, tags: (tagText[index] ?? '').split(',').map(tag => tag.trim()).filter(Boolean) } : action) })
  const runPreview = async () => {
    setBusy(true); setError('')
    try { setPreview(await rulesApi.preview(normalized())) } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  const pending = preview ? pendingAcknowledgements(preview.requirements, draft.acknowledgements) : []
  const capabilities = context.settings?.capabilities
  const localOnly = context.settings?.privacyMode === 'local-only'
  return <NoteDialog title={rule ? t('Edit rule') : t('New automation rule')} description={t('Runs only for recordings imported after it is turned on')} onClose={onClose} busy={busy}>
    <form className="rule-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try {
        const input = normalized()
        await (rule ? rulesApi.update(rule.id, { ...input, revision: rule.revision }) : rulesApi.create(input))
        await onSaved()
      } catch (failure) { setError(message(failure)); setBusy(false) }
    }}>
      <label>{t('Name')}<input required maxLength={80} value={draft.name} onChange={event => set({ name: event.target.value })} placeholder={t('Plaud meetings to minutes')} /></label>
      <fieldset><legend>{t('When a new recording is imported')}</legend>
        <div className="rule-checks"><span>{t('Source')}</span>{RULE_SOURCES.map(source => <label key={source}><input type="checkbox" checked={draft.trigger.sources.includes(source)} onChange={() => setTrigger({ sources: toggle(draft.trigger.sources, source) })} />{sourceLabel(source)}</label>)}</div>
        <div className="rule-checks"><span>{t('Type')}</span>{RECORDING_TYPES.map(type => <label key={type}><input type="checkbox" checked={draft.trigger.recordingTypes.includes(type)} onChange={() => setTrigger({ recordingTypes: toggle(draft.trigger.recordingTypes, type) })} />{recordingTypeLabel(type)}</label>)}</div>
        <div className="rule-row">
          <label>{t('Has tag')}<input maxLength={64} value={draft.trigger.tag ?? ''} onChange={event => setTrigger({ tag: event.target.value.trim() ? event.target.value : null })} placeholder={t('Any')} /></label>
          <label>{t('Minimum length (minutes)')}<input type="number" min={0} max={1440} value={draft.trigger.minDurationSeconds === null ? '' : Math.round(draft.trigger.minDurationSeconds / 60)} onChange={event => setTrigger({ minDurationSeconds: event.target.value === '' ? null : Math.max(0, Number(event.target.value)) * 60 })} placeholder={t('Any')} /></label>
        </div>
        <p className="automation-hint">{t('Empty filters match everything. Leave the source empty to include all imports.')}</p>
      </fieldset>
      <fieldset><legend>{t('Then, in order')}</legend>
        <ol className="rule-actions">{draft.actions.map((action, index) => <li key={index}>
          <div className="rule-action-head">
            <select aria-label={t('Step {step} action', { step: index + 1 })} value={action.type} onChange={event => setAction(index, defaultAction(event.target.value as RuleAction['type'], context))}>
              {Object.entries(actionLabels()).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <Button type="button" size="icon" variant="ghost" aria-label={t('Move step up')} title={t('Move up')} disabled={index === 0} onClick={() => { const next = [...draft.actions]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; set({ actions: next }) }}><ArrowUp /></Button>
            <Button type="button" size="icon" variant="ghost" aria-label={t('Move step down')} title={t('Move down')} disabled={index === draft.actions.length - 1} onClick={() => { const next = [...draft.actions]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; set({ actions: next }) }}><ArrowUp className="icon-flip" /></Button>
            <Button type="button" size="icon" variant="ghost" aria-label={t('Remove step')} title={t('Remove')} disabled={draft.actions.length === 1} onClick={() => set({ actions: draft.actions.filter((_, position) => position !== index) })}><Trash2 /></Button>
          </div>
          {action.type === 'transcribe' && <div className="rule-row">
            <label>{t('Provider')}<select value={action.provider ?? ''} onChange={event => setAction(index, { ...action, provider: event.target.value || null })}>
              <option value="">{t('Default provider')}</option>
              {capabilities && Object.entries(capabilities).map(([id, item]) => <option key={id} value={id} disabled={localOnly && !item.local}>{item.local ? t('{name} (on this computer)', { name: item.label }) : item.label}</option>)}</select></label>
            <label>{t('Profile')}<select value={action.profileId ?? ''} onChange={event => setAction(index, { ...action, profileId: event.target.value || null })}>
              <option value="">{t('Default')}</option>{context.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
          </div>}
          {action.type === 'generate_document' && <div className="rule-row">
            <label>{t('Template')}<select value={action.template} onChange={event => setAction(index, { ...action, template: event.target.value })}>
              {DOCUMENT_STYLES.map(value => <option key={value} value={value}>{templateLabel(value)}</option>)}</select></label>
            <label>{t('Save into')}<FolderSelect folders={context.folders} value={action.folderId ?? ''} onChange={value => setAction(index, { ...action, folderId: value || null })} /></label>
          </div>}
          {action.type === 'add_tags' && <label>{t('Tags')}<input value={tagText[index] ?? ''} onChange={event => { setTagText(value => ({ ...value, [index]: event.target.value })); setPreview(null) }} placeholder={t('meeting, auto')} /></label>}
          {action.type === 'add_to_collection' && <label>{t('Collection id')}<input value={action.collectionId} onChange={event => setAction(index, { ...action, collectionId: event.target.value })} placeholder={t('Skipped if collections are unavailable')} /></label>}
          {action.type === 'notify_webhook' && (context.webhooks.length
            ? <label>Webhook<select value={action.subscriptionId} onChange={event => setAction(index, { ...action, subscriptionId: event.target.value })}>
              {context.webhooks.map(hook => <option key={hook.id} value={hook.id}>{hook.name} ({hook.host})</option>)}</select></label>
            : <p className="automation-hint" data-warn>{t('Create a webhook first in the Webhooks tab.')}</p>)}
        </li>)}</ol>
        {draft.actions.length < 8 && <Button type="button" size="sm" variant="ghost" onClick={() => set({ actions: [...draft.actions, defaultAction('add_tags', context)] })}><Plus />{t('Add step')}</Button>}
      </fieldset>
      <div className="rule-preview-bar"><Button type="button" variant="outline" disabled={busy} onClick={() => void runPreview()}>{busy ? <Loader2 className="animate-spin" /> : <ListChecks />}{t('Preview scope and data use')}</Button></div>
      {preview && <div className="rule-preview" aria-live="polite">
        <p>{rich(t('{matches} of {scanned} existing recordings match.'), { matches: <strong>{preview.totalMatches}</strong>, scanned: preview.scanned })} {preview.note}</p>
        {preview.matches.length > 0 && <ul className="rule-matches">{preview.matches.slice(0, 8).map(match => <li key={match.id}>{match.title ?? match.id}<small>{match.recordingType}{match.durationSeconds ? ` · ${t('{minutes} min', { minutes: Math.round(match.durationSeconds / 60) })}` : ''}</small></li>)}</ul>}
        {preview.problems.map(problem => <p key={problem} role="alert" className="note-error">{problem}</p>)}
        <h4>{t('Where data goes')}</h4>
        {preview.requirements.length === 0 ? <p className="automation-hint">{t('Nothing leaves this computer.')}</p>
          : <ul className="rule-requirements">{preview.requirements.map(item => <li key={`${item.key}:${item.step}`}>
            {item.local ? <span className="automation-hint"><ShieldCheck />{t('Step {step}: {label} (on this computer)', { step: item.step + 1, label: item.label })}</span>
              : <label><input type="checkbox" checked={draft.acknowledgements.includes(item.key)} onChange={() => setDraft(value => ({ ...value, acknowledgements: toggle(value.acknowledgements, item.key) }))} />
                {rich(preview.blockedByLocalOnly.includes(item.key) ? t('Step {step}: I approve that {label} (currently blocked by local-only mode)') : t('Step {step}: I approve that {label}'), { step: item.step + 1, label: <strong>{item.label}</strong> })}</label>}
          </li>)}</ul>}
        <p className="automation-hint">{t('Estimated cost: unknown.')} {preview.estimatedCost.reason}</p>
      </div>}
      <label className="rule-enable"><input type="checkbox" checked={draft.enabled} onChange={event => set({ enabled: event.target.checked })} />{t('Turn this rule on')}</label>
      {draft.enabled && !preview && <p className="automation-hint">{t('Preview before turning on to review and approve where data goes.')}</p>}
      {draft.enabled && pending.length > 0 && <p className="automation-hint" data-warn><AlertCircle />{t('Approve {items} above, or leave the rule off.', { items: pending.join(', ') })}</p>}
      {error && <p role="alert" className="note-error">{error}</p>}
      <footer>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />{t('Cancel')}</Button>
        <Button disabled={busy || !draft.name.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Save />}{rule ? t('Save rule') : t('Create rule')}</Button>
      </footer>
    </form>
  </NoteDialog>
}

// ============================================================ history

function HistoryPanel() {
  const [runs, setRuns] = useState<RuleRun[] | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState('')
  const load = useCallback(async () => setRuns(await rulesApi.runs()), [])
  useEffect(() => { load().catch(failure => setError(message(failure))) }, [load])
  return <section aria-labelledby="history-title">
    <div className="automations-head"><div><h2 id="history-title"><History />{t('Execution history')}</h2>
      <p>{t("Every rule run and each of its steps. Retrying reuses each step's id, so finished work is never repeated.")}</p></div>
      <Button variant="ghost" onClick={() => { setError(''); load().catch(failure => setError(message(failure))) }}><RefreshCw />{t('Refresh')}</Button></div>
    {error && <p role="alert" className="note-error">{error}</p>}
    {!runs ? <p role="status" className="automations-empty">{error ? t('History unavailable.') : t('Loading…')}</p>
      : runs.length === 0 ? <p className="automations-empty">{t('No rule has run yet.')}</p>
      : <ul className="automations-list single">{runs.map(run => <li key={run.id} className="automation-card">
        <header><h3>{run.ruleName ?? t('Deleted rule')} · {run.recordingTitle ?? run.recordingId}</h3><span className="automation-pill" data-state={run.status}>{statusLabel(run.status)}</span></header>
        <small className="automation-hint">{when(run.createdAt)}</small>
        <ol className="automation-steps">{run.steps.map(step => <li key={step.id}><span className="automation-pill" data-state={step.status}>{statusLabel(step.status)}</span> {actionLabels()[step.type] ?? step.type}{step.detail ? ` — ${step.detail}` : ''}</li>)}</ol>
        {(run.status === 'failed' || run.status === 'cancelled') && <footer><Button size="sm" variant="ghost" disabled={busy === run.id} onClick={async () => {
          setBusy(run.id); setError('')
          try { await rulesApi.retry(run.id); await load() } catch (failure) { setError(message(failure)) } finally { setBusy('') }
        }}>{busy === run.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}{t('Retry failed steps')}</Button></footer>}
      </li>)}</ul>}
  </section>
}

// ============================================================ webhooks

function WebhooksPanel() {
  const [hooks, setHooks] = useState<WebhookSubscription[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState('')
  const load = useCallback(async () => setHooks((await webhooksApi.list()).subscriptions), [])
  useEffect(() => { load().catch(failure => setError(message(failure))) }, [load])
  const showDeliveries = async (id: string) => { setOpen(id); setDeliveries(await webhooksApi.deliveries(id)) }
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('')
    try { await action(); await load(); if (open) await showDeliveries(open) } catch (failure) { setError(message(failure)) } finally { setBusy('') }
  }
  return <section aria-labelledby="webhooks-title">
    <div className="automations-head"><div><h2 id="webhooks-title"><Send />Webhooks</h2>
      <p>{t('Signed event notifications with ids and metadata. Transcript and document text is only included when you turn it on for a webhook.')}</p></div>
      <Button variant="outline" onClick={() => setCreating(true)}><Plus />{t('New webhook')}</Button></div>
    {error && <p role="alert" className="note-error">{error}</p>}
    {secret && <div className="webhook-secret" role="status"><KeyRound /><div><strong>{t('Signing secret for {name}', { name: secret.name })}</strong><p>{t('Copy it now. It is not shown again.')}</p><code>{secret.value}</code></div>
      <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(secret.value).catch(() => setError(t('Clipboard unavailable'))) }}><Copy />{t('Copy')}</Button>
      <Button size="icon" variant="ghost" aria-label={t('Dismiss secret')} onClick={() => setSecret(null)}><X /></Button></div>}
    {!hooks ? <p role="status" className="automations-empty">{error ? t('Webhooks unavailable.') : t('Loading…')}</p>
      : hooks.length === 0 ? <p className="automations-empty">{t('No webhooks yet.')}</p>
      : <ul className="automations-list single">{hooks.map(hook => <li key={hook.id} className="automation-card">
        <header><h3>{hook.name}</h3><span className="automation-pill" data-state={hook.enabled ? 'on' : 'off'}>{hook.enabled ? t('On') : t('Off')}</span></header>
        <p><code>{hook.url}</code> · {hook.external ? t('leaves this computer') : t('this computer')}{hook.includeText ? ` · ${t('includes text')}` : ''}</p>
        <p className="automation-hint">{hook.eventTypes.join(', ')}</p>
        {hook.disabledReason && <p className="automation-hint" data-warn><AlertCircle />{hook.disabledReason}</p>}
        <footer>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(`test:${hook.id}`, () => webhooksApi.test(hook.id))}>{busy === `test:${hook.id}` ? <Loader2 className="animate-spin" /> : <Send />}{t('Send test')}</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(hook.id, () => webhooksApi.update(hook.id, { enabled: !hook.enabled }))}>{hook.enabled ? <X /> : <Check />}{hook.enabled ? t('Turn off') : t('Turn on')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { if (open === hook.id) setOpen(null); else void showDeliveries(hook.id).catch(failure => setError(message(failure))) }}><History />{t('Deliveries')}</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { if (window.confirm(t('Rotate the signing secret? The receiver must be updated.'))) void run(`rotate:${hook.id}`, async () => { const next = await webhooksApi.rotate(hook.id); setSecret({ name: next.name, value: next.secret }) }) }}><KeyRound />{t('Rotate secret')}</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { if (window.confirm(t('Delete the webhook “{name}” and its delivery history?', { name: hook.name }))) void run(`delete:${hook.id}`, () => webhooksApi.remove(hook.id)) }}><Trash2 />{t('Delete')}</Button>
        </footer>
        {open === hook.id && <DeliveryList deliveries={deliveries} busy={busy} onRedeliver={id => void run(`redeliver:${id}`, () => webhooksApi.redeliver(id))} />}
      </li>)}</ul>}
    <details className="webhook-verify"><summary>{t('Verify signatures')}</summary>
      <p className="automation-hint">{rich(t('Each request carries {signature}, an HMAC-SHA256 of {body} with your secret, plus {eventId} and {deliveryId}. Retries reuse both ids.'), { signature: <code>OpenPlod-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, body: <code>t.rawBody</code>, eventId: <code>OpenPlod-Event-Id</code>, deliveryId: <code>OpenPlod-Delivery-Id</code> })}</p>
      <pre>{VERIFY_SNIPPET}</pre></details>
    {creating && <WebhookEditor onClose={() => setCreating(false)} onCreated={async created => { setCreating(false); setSecret({ name: created.name, value: created.secret }); await load() }} />}
  </section>
}

function DeliveryList({ deliveries, busy, onRedeliver }: { deliveries: WebhookDelivery[]; busy: string; onRedeliver: (id: string) => void }) {
  if (!deliveries.length) return <p className="automation-hint">{t('No deliveries yet.')}</p>
  return <ul className="webhook-deliveries">{deliveries.map(delivery => <li key={delivery.id}>
    <div><span className="automation-pill" data-state={delivery.status}>{statusLabel(delivery.status)}</span> <strong>{delivery.eventType}</strong> <small>{when(delivery.createdAt)} · {t('delivery {id}', { id: delivery.id.slice(0, 8) })}</small></div>
    {delivery.lastError && <p className="automation-hint">{delivery.lastError}</p>}
    {delivery.nextAttemptAt && <p className="automation-hint">{t('Next attempt {date}', { date: when(delivery.nextAttemptAt) })}</p>}
    <ol>{delivery.attempts.map(attempt => <li key={attempt.attempt}>#{attempt.attempt} {attempt.trigger === 'manual' ? t('manual') : t('auto')} · {attempt.outcome ? statusLabel(attempt.outcome) : t('sending')}{attempt.statusCode ? ` · HTTP ${attempt.statusCode}` : ''}{attempt.durationMs !== null ? ` · ${attempt.durationMs} ms` : ''}</li>)}</ol>
    {['failed', 'unknown', 'blocked', 'skipped', 'delivered'].includes(delivery.status) && <Button size="sm" variant="ghost" disabled={busy === `redeliver:${delivery.id}`} onClick={() => {
      if (delivery.status !== 'delivered' || window.confirm(t('This event was already delivered. Send it again with the same ids?'))) onRedeliver(delivery.id)
    }}><RotateCcw />{t('Redeliver')}</Button>}
  </li>)}</ul>
}

function WebhookEditor({ onClose, onCreated }: { onClose: () => void; onCreated: (created: WebhookSubscription & { secret: string }) => Promise<void> }) {
  const [name, setName] = useState(''), [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEventType[]>(['recording.transcribed', 'document.created'])
  const [includeText, setIncludeText] = useState(false), [ackExternal, setAckExternal] = useState(false), [ackText, setAckText] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const external = (() => { try { return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) } catch { return false } })()
  return <NoteDialog title={t('New webhook')} description={t('HTTPS, or plain HTTP to localhost only')} onClose={onClose} busy={busy}>
    <form className="rule-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { await onCreated(await webhooksApi.create({ name, url, eventTypes: events, includeText, acknowledgeExternal: ackExternal, acknowledgeText: ackText })) }
      catch (failure) { setError(message(failure)); setBusy(false) }
    }}>
      <label>{t('Name')}<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={t('Team automation')} /></label>
      <label>URL<input required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/openplod" /></label>
      <fieldset><legend>{t('Events')}</legend><div className="rule-checks">{WEBHOOK_EVENT_TYPES.map(type => <label key={type}><input type="checkbox" checked={events.includes(type)} onChange={() => setEvents(list => list.includes(type) ? list.filter(item => item !== type) : [...list, type])} />{type}</label>)}</div></fieldset>
      <label className="rule-enable"><input type="checkbox" checked={includeText} onChange={event => setIncludeText(event.target.checked)} />{t('Include transcript and document text in payloads')}</label>
      {includeText && <label className="rule-enable"><input type="checkbox" checked={ackText} onChange={event => setAckText(event.target.checked)} />{t('I understand full text will be sent to this URL')}</label>}
      {external && <label className="rule-enable"><input type="checkbox" checked={ackExternal} onChange={event => setAckExternal(event.target.checked)} />{t('I approve sending event data to {host}, outside this computer', { host: (() => { try { return new URL(url).host } catch { return t('this host') } })() })}</label>}
      {error && <p role="alert" className="note-error">{error}</p>}
      <footer>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />{t('Cancel')}</Button>
        <Button disabled={busy || !name.trim() || !url || !events.length || (external && !ackExternal) || (includeText && !ackText)}>{busy ? <Loader2 className="animate-spin" /> : <Plus />}{t('Create webhook')}</Button>
      </footer>
    </form>
  </NoteDialog>
}

// ============================================================ tasks

function TasksPanel() {
  const [tasks, setTasks] = useState<TaskDraft[] | null>(null)
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [connectors, setConnectors] = useState<ConnectorSettings | null>(null)
  const [recordingId, setRecordingId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [connector, setConnector] = useState<Connector>('todoist')
  const [newTitle, setNewTitle] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    const [list, settings] = await Promise.all([tasksApi.list(), tasksApi.connectors()])
    setTasks(list); setConnectors(settings)
  }, [])
  useEffect(() => {
    load().catch(failure => setError(message(failure)))
    api.getRecordings().then(list => setRecordings(list.filter(item => item.hasTranscript !== false))).catch(() => {})
  }, [load])
  const run = async (key: string, action: () => Promise<string | void>) => {
    setBusy(key); setError(''); setNotice('')
    try { const result = await action(); if (result) setNotice(result); await load() } catch (failure) { setError(message(failure)) } finally { setBusy('') }
  }
  const approved = (tasks ?? []).filter(task => selected.includes(task.id) && task.status === 'approved')
  const dated = (tasks ?? []).filter(task => selected.includes(task.id) && task.dueDate)
  return <section aria-labelledby="tasks-title">
    <div className="automations-head"><div><h2 id="tasks-title"><ListChecks />{t('Reviewed tasks')}</h2>
      <p>{t('Action items become local drafts. Edit and approve each one, then export the ones you choose. Nothing is posted automatically.')}</p></div></div>
    {error && <p role="alert" className="note-error">{error}</p>}
    {notice && <p role="status" className="automation-hint">{notice}</p>}
    <div className="tasks-toolbar">
      <select aria-label={t('Recording')} value={recordingId} onChange={event => setRecordingId(event.target.value)}>
        <option value="">{t('Choose a recording…')}</option>{recordings.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      <Button variant="outline" disabled={!recordingId || !!busy} onClick={() => void run('extract', async () => {
        const result = await tasksApi.extract(recordingId)
        return result.existing ? tn(result.created.length, '{count} new draft, {existing} already listed.', '{count} new drafts, {existing} already listed.', { existing: result.existing }) : tn(result.created.length, '{count} new draft.', '{count} new drafts.')
      })}>{busy === 'extract' ? <Loader2 className="animate-spin" /> : <ListChecks />}{t('Import action items')}</Button>
      <form className="tasks-add" onSubmit={event => { event.preventDefault(); if (newTitle.trim()) void run('add', async () => { await tasksApi.create({ title: newTitle.trim(), recordingId: recordingId || null }); setNewTitle('') }) }}>
        <input aria-label={t('New task')} value={newTitle} maxLength={500} onChange={event => setNewTitle(event.target.value)} placeholder={t('Add a task by hand')} />
        <Button variant="ghost" disabled={!newTitle.trim() || !!busy}><Plus />{t('Add')}</Button></form>
    </div>
    {!tasks ? <p role="status" className="automations-empty">{error ? t('Tasks unavailable.') : t('Loading…')}</p>
      : tasks.length === 0 ? <p className="automations-empty">{t('No task drafts yet. Import action items from an analyzed recording, or add one by hand.')}</p>
      : <ul className="tasks-list">{tasks.map(task => <TaskRow key={task.id} task={task} selected={selected.includes(task.id)}
        onSelect={value => setSelected(list => value ? [...list, task.id] : list.filter(id => id !== task.id))}
        onSave={(patch, label) => run(`${label}:${task.id}`, async () => { await tasksApi.update(task.id, { ...patch, revision: task.revision }) })}
        onDelete={() => run(`delete:${task.id}`, async () => { await tasksApi.remove(task.id); setSelected(list => list.filter(id => id !== task.id)) })} busy={busy} />)}</ul>}
    <div className="tasks-export">
      <select aria-label={t('Connector')} value={connector} onChange={event => setConnector(event.target.value as Connector)}>
        {CONNECTORS.map(item => <option key={item} value={item} disabled={!connectors?.[item].configured}>{connectors?.[item].configured ? connectorName(item) : t('{name} (not set up)', { name: connectorName(item) })}</option>)}</select>
      <Button disabled={!approved.length || !connectors?.[connector].configured || !!busy} onClick={() => {
        if (!window.confirm(tn(approved.length, 'Create {count} approved task in {connector}? Task titles and notes are sent to {connector}.', 'Create {count} approved tasks in {connector}? Task titles and notes are sent to {connector}.', { connector: connectorName(connector) }))) return
        void run('export', async () => {
          const { results } = await tasksApi.export(connector, approved.map(task => task.id))
          const unknown = results.filter(item => item.status === 'unknown')
          if (unknown.length && window.confirm(tn(unknown.length, '{count} export may already exist in {connector} (no confirmation was received). Check {connector} first. Send again anyway? This can create duplicates.', '{count} exports may already exist in {connector} (no confirmation was received). Check {connector} first. Send again anyway? This can create duplicates.', { connector: connectorName(connector) })))
            await tasksApi.export(connector, unknown.map(item => item.taskId), true)
          return t('{created} created, {failed} failed, {unknown} unknown, {skipped} skipped.', { created: results.filter(item => item.status === 'created').length, failed: results.filter(item => item.status === 'failed').length, unknown: unknown.length, skipped: results.filter(item => item.status === 'skipped').length })
        })
      }}>{busy === 'export' ? <Loader2 className="animate-spin" /> : <Send />}{approved.length ? tn(approved.length, 'Export {count} approved task', 'Export {count} approved tasks') : t('Export approved tasks')}</Button>
      <Button variant="outline" disabled={!dated.length || !!busy} onClick={() => void run('ics', async () => {
        const blob = await tasksApi.calendar(dated.map(task => task.id)), link = document.createElement('a')
        link.href = URL.createObjectURL(blob); link.download = 'openplod-tasks.ics'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      })}><Download />{t('Calendar file ({count})', { count: dated.length })}</Button>
    </div>
    {connectors && <ConnectorSettingsForm settings={connectors} onSaved={setConnectors} />}
  </section>
}

function TaskRow({ task, selected, busy, onSelect, onSave, onDelete }: { task: TaskDraft; selected: boolean; busy: string; onSelect: (value: boolean) => void; onSave: (patch: Partial<TaskDraft>, label: string) => Promise<void>; onDelete: () => Promise<void> }) {
  const [draft, setDraft] = useState({ title: task.title, notes: task.notes, owner: task.owner ?? '', dueDate: task.dueDate ?? '', executionStatus: task.executionStatus ?? 'todo' as TaskExecutionStatus })
  const dirty = draft.title !== task.title || draft.notes !== task.notes || draft.owner !== (task.owner ?? '') || draft.dueDate !== (task.dueDate ?? '') || draft.executionStatus !== (task.executionStatus ?? 'todo')
  return <li className="task-row" data-status={task.status}>
    <input type="checkbox" aria-label={t('Select {title}', { title: task.title })} checked={selected} onChange={event => onSelect(event.target.checked)} />
    <div className="task-fields">
      <input aria-label={t('Title')} value={draft.title} maxLength={500} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} />
      <div className="rule-row">
        <input aria-label={t('Owner')} value={draft.owner} maxLength={120} placeholder={t('Owner')} onChange={event => setDraft(value => ({ ...value, owner: event.target.value }))} />
        <input aria-label={t('Due date')} type="date" value={draft.dueDate} onChange={event => setDraft(value => ({ ...value, dueDate: event.target.value }))} />
      </div>
      <label className="task-progress">{t('Execution status')}
        <select aria-label={t('Execution status')} value={draft.executionStatus} onChange={event => setDraft(value => ({ ...value, executionStatus: event.target.value as TaskExecutionStatus }))}>
          {TASK_EXECUTION_STATUSES.map(status => <option key={status} value={status}>{executionStatusLabel(status)}</option>)}
        </select>
      </label>
      {task.dueText && !task.dueDate && <small className="automation-hint">{t('Said: “{text}”. Set a date if you want one.', { text: task.dueText })}</small>}
      <textarea aria-label={t('Notes')} rows={2} value={draft.notes} maxLength={4000} placeholder={t('Notes')} onChange={event => setDraft(value => ({ ...value, notes: event.target.value }))} />
      <div className="task-meta"><span className="automation-pill" data-state={task.status}>{statusLabel(task.status)}</span>
        {task.overdue && <span className="automation-pill task-overdue" data-state="blocked"><AlertCircle />{t('Overdue')}</span>}
        {task.executionStatus && <span className="automation-pill" data-state={task.executionStatus}>{executionStatusLabel(task.executionStatus)}</span>}
        {task.exports.map(item => <span key={item.connector} className="automation-pill" data-state={item.status}>{connectorName(item.connector)}: {statusLabel(item.status)}{item.remoteUrl ? <> · <a href={item.remoteUrl} target="_blank" rel="noreferrer">{item.remoteId}</a></> : item.remoteId ? ` · ${item.remoteId}` : ''}</span>)}</div>
    </div>
    <div className="task-actions">
      {dirty && <Button size="sm" variant="ghost" disabled={!!busy || !draft.title.trim()} onClick={() => void onSave(buildTaskPatch(task, draft), 'save')}><Save />{t('Save')}</Button>}
      {!dirty && task.status !== 'approved' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void onSave({ status: 'approved' }, 'approve')}><Check />{t('Approve')}</Button>}
      {!dirty && task.status === 'approved' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void onSave({ status: 'draft' }, 'unapprove')}><Undo2 />{t('Back to draft')}</Button>}
      {task.status !== 'dismissed' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void onSave({ status: 'dismissed' }, 'dismiss')}><X />{t('Dismiss')}</Button>}
      {!task.exports.length && <Button size="sm" variant="ghost" aria-label={t('Delete task')} disabled={!!busy} onClick={() => void onDelete()}><Trash2 /></Button>}
    </div>
  </li>
}

function ConnectorSettingsForm({ settings, onSaved }: { settings: ConnectorSettings; onSaved: (settings: ConnectorSettings) => void }) {
  const [values, setValues] = useState<Record<string, string>>({ linearTeamId: settings.linear.teamId, notionDatabaseId: settings.notion.databaseId, notionTitleProperty: settings.notion.titleProperty, notionDateProperty: settings.notion.dateProperty })
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  const field = (key: string, label: string, secret = false, placeholder = '') => <label>{label}<input type={secret ? 'password' : 'text'} autoComplete="off" value={values[key] ?? ''} placeholder={placeholder}
    onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} /></label>
  return <details className="tasks-connectors"><summary><KeyRound />{t('Connector credentials')}</summary>
    <form className="rule-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setStatus('')
      try {
        // Blank secret fields keep the stored value; other blank fields clear it.
        const input = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== '' || !['todoistApiToken', 'linearApiKey', 'notionApiKey'].includes(key)))
        onSaved(await tasksApi.saveConnectors(input)); setStatus(t('Saved.'))
        setValues(current => ({ ...current, todoistApiToken: '', linearApiKey: '', notionApiKey: '' }))
      } catch (failure) { setStatus(message(failure)) } finally { setBusy(false) }
    }}>
      <p className="automation-hint">{t('Stored with your other settings on this computer and never shown again. Tasks are only sent when you press Export.')}</p>
      <div className="rule-row">{field('todoistApiToken', settings.todoist.configured ? t('Todoist API token (saved)') : t('Todoist API token'), true)}</div>
      <div className="rule-row">{field('linearApiKey', settings.linear.configured ? t('Linear API key (saved)') : t('Linear API key'), true)}{field('linearTeamId', t('Linear team id'))}</div>
      <div className="rule-row">{field('notionApiKey', settings.notion.configured ? t('Notion integration secret (saved)') : t('Notion integration secret'), true)}{field('notionDatabaseId', t('Notion database id'))}</div>
      <div className="rule-row">{field('notionTitleProperty', t('Notion title property'), false, 'Name')}{field('notionDateProperty', t('Notion date property (optional)'))}</div>
      {status && <p role="status" className="automation-hint">{status}</p>}
      <footer><Button disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Save />}{t('Save credentials')}</Button></footer>
    </form>
  </details>
}
