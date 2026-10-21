import { describe, expect, test } from 'bun:test'
import { blankRule, buildTaskPatch, describeAction, describeTrigger, pendingAcknowledgements, type Requirement, type TaskDraft } from './automation-api'

describe('automation display helpers', () => {
  test('describe triggers and actions in plain words', () => {
    expect(describeTrigger(blankRule().trigger)).toBe('New recording: Any source, any type')
    expect(describeTrigger({ type: 'recording.imported', sources: ['plaud'], recordingTypes: ['meeting'], tag: 'client', minDurationSeconds: 300 }))
      .toBe('New recording: Plaud, meeting, at least 5 min, tagged client')
    expect(describeAction({ type: 'generate_document', template: 'meeting', folderId: null })).toBe('Draft Meeting minutes')
    expect(describeAction({ type: 'notify_webhook', subscriptionId: 'w1' }, { webhooks: { w1: 'Zapier' } })).toBe('Notify Zapier')
    expect(describeAction({ type: 'transcribe', provider: null, profileId: null })).toBe('Transcribe with the default provider')
  })
  test('only non-local, unacknowledged requirements need a confirmation', () => {
    const requirement = (key: string, local: boolean): Requirement => ({ key, kind: key.split(':')[0] as Requirement['kind'], target: key.split(':')[1], label: key, local, acknowledged: false, step: 0 })
    expect(pendingAcknowledgements([requirement('audio:whisper', true), requirement('audio:mistral', false), requirement('text:mistral', false), requirement('text:mistral', false)], ['text:mistral']))
      .toEqual(['audio:mistral'])
  })
  test('task edits send only changed fields', () => {
    const task: Pick<TaskDraft, 'title' | 'notes' | 'owner' | 'dueDate' | 'executionStatus'> = {
      title: 'Send the deck', notes: 'Final version', owner: 'Ana', dueDate: '2026-11-02', executionStatus: 'todo',
    }
    expect(buildTaskPatch(task, { ...task, owner: 'Ana', dueDate: '2026-11-02', executionStatus: 'in_progress' })).toEqual({ executionStatus: 'in_progress' })
    expect(buildTaskPatch(task, { ...task, owner: '', dueDate: '', executionStatus: 'todo' })).toEqual({ owner: null, dueDate: null })
  })
})
