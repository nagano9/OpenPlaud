import { apiUrl, authenticatedHeaders } from './runtime'

/**
 * Client for `/api/v1/webhooks` and `/api/v1/automations` (roadmap KB-08..KB-10).
 * Types mirror `src/automation/*`; they are declared here so the web build does
 * not type-check server modules.
 */
export const WEBHOOK_EVENT_TYPES = ['recording.imported', 'recording.transcribed', 'document.created', 'job.failed'] as const
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number]
export const RULE_SOURCES = ['plaud', 'upload', 'mobile'] as const
export const RECORDING_TYPES = ['meeting', 'conversation', 'class', 'other'] as const
export const CONNECTORS = ['todoist', 'linear', 'notion'] as const
export type Connector = typeof CONNECTORS[number]
export const TASK_EXECUTION_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const
export type TaskExecutionStatus = typeof TASK_EXECUTION_STATUSES[number]

export interface WebhookSubscription {
  id: string; name: string; url: string; host: string; external: boolean; eventTypes: WebhookEventType[]; includeText: boolean
  enabled: boolean; disabledReason: string | null; consecutiveFailures: number; createdAt: string; updatedAt: string
}
export interface WebhookAttempt { attempt: number; trigger: 'auto' | 'manual'; startedAt: string; finishedAt: string | null; outcome: 'delivered' | 'failed' | 'unknown' | 'blocked' | null; statusCode: number | null; error: string | null; durationMs: number | null }
export interface WebhookDelivery {
  id: string; eventId: string; eventType: string; subscriptionId: string; status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'unknown' | 'blocked' | 'skipped'
  attemptCount: number; nextAttemptAt: string | null; lastStatusCode: number | null; lastError: string | null; createdAt: string; updatedAt: string; attempts: WebhookAttempt[]
}
export interface SubscriptionInput { name: string; url: string; eventTypes: WebhookEventType[]; includeText: boolean; acknowledgeExternal?: boolean; acknowledgeText?: boolean }

export type RuleAction =
  | { type: 'transcribe'; provider: string | null; profileId: string | null }
  | { type: 'generate_document'; template: string; folderId: string | null }
  | { type: 'add_tags'; tags: string[] }
  | { type: 'add_to_collection'; collectionId: string }
  | { type: 'notify_webhook'; subscriptionId: string }
export interface RuleTrigger { type: 'recording.imported'; sources: string[]; recordingTypes: string[]; tag: string | null; minDurationSeconds: number | null }
export interface RuleInput { name: string; enabled: boolean; trigger: RuleTrigger; actions: RuleAction[]; acknowledgements: string[] }
export interface AutomationRule extends RuleInput { id: string; revision: number; acknowledgedAt: string | null; createdAt: string; updatedAt: string }
export interface Requirement { key: string; kind: 'audio' | 'text' | 'webhook'; target: string; label: string; local: boolean; acknowledged: boolean; step: number }
export interface RulePreview {
  matches: { id: string; title: string | null; sourceProvider: string | null; sourceTransport: string | null; recordingType: string; durationSeconds: number | null; recordedAt: string | null }[]
  totalMatches: number; scanned: number; requirements: Requirement[]; missingAcknowledgements: string[]; localOnly: boolean; blockedByLocalOnly: string[]
  estimatedCost: { status: 'unknown'; amount: null; currency: null; reason: string }; problems: string[]; note: string
}
export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'skipped' | 'failed' | 'unknown'
export interface RuleRun {
  id: string; ruleId: string; ruleName: string | null; recordingId: string; recordingTitle: string | null; status: 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled'
  createdAt: string; updatedAt: string; steps: { id: string; index: number; type: RuleAction['type']; status: StepStatus; detail: string | null; resultRef: string | null; attempts: number; updatedAt: string }[]
}
export interface TaskExport { connector: Connector; status: 'pending' | 'created' | 'failed' | 'unknown'; remoteId: string | null; remoteUrl: string | null; error: string | null; attempts: number; updatedAt: string }
export interface TaskDraft {
  id: string; recordingId: string | null; title: string; notes: string; owner: string | null; dueDate: string | null; dueText: string | null
  source: 'extracted' | 'manual'; status: 'draft' | 'approved' | 'dismissed'; executionStatus: TaskExecutionStatus; overdue: boolean
  revision: number; createdAt: string; updatedAt: string; exports: TaskExport[]
}
export interface TaskDraftEdit { title: string; notes: string; owner: string; dueDate: string; executionStatus: TaskExecutionStatus }

/** Return only changed editable fields so execution progress does not look like content editing. */
export function buildTaskPatch(task: Pick<TaskDraft, 'title' | 'notes' | 'owner' | 'dueDate' | 'executionStatus'>, draft: TaskDraftEdit) {
  const patch: Partial<Pick<TaskDraft, 'title' | 'notes' | 'owner' | 'dueDate' | 'executionStatus'>> = {}
  if (draft.title !== task.title) patch.title = draft.title
  if (draft.notes !== task.notes) patch.notes = draft.notes
  const owner = draft.owner || null
  if (owner !== task.owner) patch.owner = owner
  const dueDate = draft.dueDate || null
  if (dueDate !== task.dueDate) patch.dueDate = dueDate
  if (draft.executionStatus !== (task.executionStatus ?? 'todo')) patch.executionStatus = draft.executionStatus
  return patch
}
export interface ConnectorSettings {
  todoist: { configured: boolean }; linear: { configured: boolean; teamId: string }
  notion: { configured: boolean; databaseId: string; titleProperty: string; dateProperty: string }
}
export interface ExportResult { taskId: string; status: TaskExport['status'] | 'skipped'; remoteId: string | null; remoteUrl: string | null; error: string | null }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`/v1${path}`), { method, headers: authenticatedHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.success) throw new Error(payload?.error || `Request failed (HTTP ${response.status}).`)
  return payload.data as T
}

export const webhooksApi = {
  list: () => request<{ subscriptions: WebhookSubscription[] }>('/webhooks'),
  create: (input: SubscriptionInput) => request<WebhookSubscription & { secret: string }>('/webhooks', 'POST', input),
  update: (id: string, patch: Partial<SubscriptionInput> & { enabled?: boolean }) => request<WebhookSubscription>(`/webhooks/${id}`, 'PATCH', patch),
  remove: (id: string) => request<null>(`/webhooks/${id}`, 'DELETE'),
  rotate: (id: string) => request<WebhookSubscription & { secret: string }>(`/webhooks/${id}/rotate-secret`, 'POST'),
  test: (id: string) => request<WebhookDelivery>(`/webhooks/${id}/test`, 'POST'),
  deliveries: (id: string) => request<WebhookDelivery[]>(`/webhooks/${id}/deliveries`),
  redeliver: (deliveryId: string) => request<WebhookDelivery>(`/webhooks/deliveries/${deliveryId}/redeliver`, 'POST'),
}

export const rulesApi = {
  list: () => request<AutomationRule[]>('/automations/rules'),
  create: (input: RuleInput) => request<AutomationRule>('/automations/rules', 'POST', input),
  update: (id: string, patch: Partial<RuleInput> & { revision: number }) => request<AutomationRule>(`/automations/rules/${id}`, 'PATCH', patch),
  remove: (id: string) => request<null>(`/automations/rules/${id}`, 'DELETE'),
  preview: (input: RuleInput) => request<RulePreview>('/automations/rules/preview', 'POST', input),
  runs: (ruleId?: string) => request<RuleRun[]>(ruleId ? `/automations/rules/${ruleId}/runs` : '/automations/runs'),
  retry: (runId: string) => request<RuleRun>(`/automations/runs/${runId}/retry`, 'POST'),
}

export const tasksApi = {
  list: () => request<TaskDraft[]>('/automations/tasks'),
  create: (input: { title: string; notes?: string; owner?: string | null; dueDate?: string | null; recordingId?: string | null }) => request<TaskDraft>('/automations/tasks', 'POST', input),
  extract: (recordingId: string) => request<{ created: TaskDraft[]; existing: number }>('/automations/tasks/extract', 'POST', { recordingId }),
  update: (id: string, patch: Partial<Pick<TaskDraft, 'title' | 'notes' | 'owner' | 'dueDate' | 'status' | 'executionStatus'>> & { revision: number }) => request<TaskDraft>(`/automations/tasks/${id}`, 'PATCH', patch),
  remove: (id: string) => request<null>(`/automations/tasks/${id}`, 'DELETE'),
  export: (connector: Connector, taskIds: string[], retryUnknown = false) => request<{ results: ExportResult[] }>('/automations/tasks/export', 'POST', { connector, taskIds, confirm: true, retryUnknown }),
  connectors: () => request<ConnectorSettings>('/automations/tasks/connectors'),
  saveConnectors: (input: Record<string, string>) => request<ConnectorSettings>('/automations/tasks/connectors', 'PUT', input),
  /** Fetched with the pairing header, then saved by the browser; nothing leaves the computer. */
  calendar: async (ids: string[]) => {
    const response = await fetch(apiUrl(`/v1/automations/tasks/calendar.ics?ids=${ids.join(',')}`), { headers: authenticatedHeaders(), signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Calendar export failed (HTTP ${response.status}).`)
    return response.blob()
  },
}

// ---------------------------------------------------------------- display helpers

const SOURCE_LABELS: Record<string, string> = { plaud: 'Plaud', upload: 'Uploads', mobile: 'Phone' }
export const TEMPLATE_LABELS: Record<string, string> = { notes: 'Structured notes', meeting: 'Meeting minutes', interview: 'Interview notes', lecture: 'Lecture notes', brief: 'Project brief', prd: 'Product requirements', email: 'Follow-up email', 'meeting-id': 'Indonesian meeting minutes' }

/** "Plaud meetings, at least 5 min, tagged client" */
export function describeTrigger(trigger: RuleTrigger): string {
  const parts = [
    trigger.sources.length ? trigger.sources.map(source => SOURCE_LABELS[source] ?? source).join(' or ') : 'Any source',
    trigger.recordingTypes.length ? trigger.recordingTypes.join(' or ') : 'any type',
  ]
  if (trigger.minDurationSeconds) parts.push(`at least ${Math.round(trigger.minDurationSeconds / 60)} min`)
  if (trigger.tag) parts.push(`tagged ${trigger.tag}`)
  return `New recording: ${parts.join(', ')}`
}

export function describeAction(action: RuleAction, names: { webhooks?: Record<string, string>; profiles?: Record<string, string> } = {}): string {
  switch (action.type) {
    case 'transcribe': return `Transcribe with ${action.provider ?? 'the default provider'}${action.profileId ? ` (${names.profiles?.[action.profileId] ?? 'profile'})` : ''}`
    case 'generate_document': return `Draft ${TEMPLATE_LABELS[action.template] ?? action.template}`
    case 'add_tags': return `Tag ${action.tags.join(', ')}`
    case 'add_to_collection': return `Add to collection ${action.collectionId}`
    case 'notify_webhook': return `Notify ${names.webhooks?.[action.subscriptionId] ?? 'webhook'}`
  }
}

/** Requirement keys that still need the person's acknowledgement before enabling. */
export function pendingAcknowledgements(requirements: Requirement[], acknowledged: string[]): string[] {
  const given = new Set(acknowledged)
  return [...new Set(requirements.filter(item => !item.local && !given.has(item.key)).map(item => item.key))]
}

export const blankRule = (): RuleInput => ({
  name: '', enabled: false, acknowledgements: [],
  trigger: { type: 'recording.imported', sources: [], recordingTypes: [], tag: null, minDurationSeconds: null },
  actions: [{ type: 'transcribe', provider: null, profileId: null }],
})

/** How a receiver verifies a delivery; shown next to the webhook secret. */
export const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from 'node:crypto'

// header: OpenPlod-Signature: t=<unix seconds>,v1=<hex>
function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map(part => part.split('=')))
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex')
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
}
// Deduplicate on the OpenPlod-Event-Id header: retries reuse it.`
