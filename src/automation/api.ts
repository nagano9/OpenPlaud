import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AutomationError } from './common';
import { WEBHOOK_EVENT_TYPES, type WebhookService } from './webhooks';
import { RECORDING_TYPES, RULE_SOURCES, type RuleEngine } from './rules';
import { CONNECTORS, TASK_EXECUTION_STATUSES, type TaskService } from './tasks';
import { DOCUMENT_STYLES } from '../organizer/document-templates';

function onError(error: Error, c: Context) {
  if (error instanceof z.ZodError) return c.json({ success: false, code: 'invalid_input', error: error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ') }, 400);
  if (error instanceof AutomationError) return c.json({ success: false, code: error.code, error: error.message }, error.status);
  console.error('[Automation] API error:', error);
  return c.json({ success: false, code: 'automation_error', error: 'The automation request failed.' }, 500);
}
const body = (c: Context) => c.req.json().catch(() => { throw new AutomationError(400, 'invalid_json', 'Send a JSON body.'); });
const limit = (value: string | undefined) => Math.min(Math.max(Number.parseInt(value || '50', 10) || 50, 1), 200);

/** `/api/v1/webhooks`: subscriptions, delivery history, redelivery and test pings (KB-08). */
export function createWebhooksApi(webhooks: WebhookService) {
  const app = new Hono();
  app.onError(onError);
  app.get('/', c => c.json({ success: true, data: { subscriptions: webhooks.list(), eventTypes: WEBHOOK_EVENT_TYPES } }));
  app.post('/', async c => c.json({ success: true, data: webhooks.create(await body(c)) }, 201));
  app.get('/deliveries/:deliveryId', c => c.json({ success: true, data: webhooks.delivery(c.req.param('deliveryId')) }));
  app.post('/deliveries/:deliveryId/redeliver', async c => c.json({ success: true, data: await webhooks.redeliver(c.req.param('deliveryId')) }));
  app.get('/:id', c => c.json({ success: true, data: webhooks.get(c.req.param('id')) }));
  app.patch('/:id', async c => c.json({ success: true, data: webhooks.update(c.req.param('id'), await body(c)) }));
  app.delete('/:id', c => { webhooks.remove(c.req.param('id')); return c.json({ success: true, data: null }); });
  app.post('/:id/rotate-secret', c => c.json({ success: true, data: webhooks.rotateSecret(c.req.param('id')) }));
  app.post('/:id/test', async c => c.json({ success: true, data: await webhooks.ping(c.req.param('id')) }));
  app.get('/:id/deliveries', c => c.json({ success: true, data: webhooks.deliveries(c.req.param('id'), limit(c.req.query('limit'))) }));
  return app;
}

/** `/api/v1/automations`: rules, previews, run history (KB-09) and reviewed tasks (KB-10). */
export function createAutomationsApi(rules: RuleEngine, tasks: TaskService) {
  const app = new Hono();
  app.onError(onError);
  app.get('/catalog', c => c.json({ success: true, data: { sources: RULE_SOURCES, recordingTypes: RECORDING_TYPES, templates: DOCUMENT_STYLES, connectors: CONNECTORS } }));
  app.get('/rules', c => c.json({ success: true, data: rules.list() }));
  app.post('/rules', async c => c.json({ success: true, data: rules.create(await body(c)) }, 201));
  app.post('/rules/preview', async c => c.json({ success: true, data: rules.preview(await body(c)) }));
  app.get('/rules/:id', c => c.json({ success: true, data: rules.get(c.req.param('id')) }));
  app.patch('/rules/:id', async c => c.json({ success: true, data: rules.update(c.req.param('id'), await body(c)) }));
  app.delete('/rules/:id', c => { rules.remove(c.req.param('id')); return c.json({ success: true, data: null }); });
  app.get('/rules/:id/preview', c => {
    const { id: _id, revision: _revision, acknowledgedAt: _at, createdAt: _created, updatedAt: _updated, ...input } = rules.get(c.req.param('id'));
    return c.json({ success: true, data: rules.preview(input) });
  });
  app.get('/rules/:id/runs', c => { rules.get(c.req.param('id')); return c.json({ success: true, data: rules.runs(c.req.param('id'), limit(c.req.query('limit'))) }); });
  app.get('/runs', c => c.json({ success: true, data: rules.runs(undefined, limit(c.req.query('limit'))) }));
  app.get('/runs/:id', c => c.json({ success: true, data: rules.run(c.req.param('id')) }));
  app.post('/runs/:id/retry', async c => c.json({ success: true, data: await rules.retry(c.req.param('id')) }));

  app.get('/tasks', c => {
    const status = z.enum(['draft', 'approved', 'dismissed']).optional().parse(c.req.query('status'));
    const executionStatus = z.enum(TASK_EXECUTION_STATUSES).optional().parse(c.req.query('executionStatus'));
    const recordingId = z.string().uuid().optional().parse(c.req.query('recordingId'));
    return c.json({ success: true, data: tasks.list({ status, executionStatus, recordingId }) });
  });
  app.post('/tasks', async c => c.json({ success: true, data: tasks.create(await body(c)) }, 201));
  app.post('/tasks/extract', async c => c.json({ success: true, data: tasks.extract(await body(c)) }));
  app.post('/tasks/export', async c => c.json({ success: true, data: await tasks.export(await body(c)) }));
  app.get('/tasks/calendar.ics', c => {
    const ids = (c.req.query('ids') || '').split(',').filter(Boolean);
    z.array(z.string().uuid()).max(200).parse(ids);
    return c.body(tasks.calendar(ids), 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="openplod-tasks.ics"' });
  });
  app.get('/tasks/connectors', c => c.json({ success: true, data: tasks.connectorSettings() }));
  app.put('/tasks/connectors', async c => c.json({ success: true, data: tasks.saveConnectorSettings(await body(c)) }));
  app.get('/tasks/:id', c => c.json({ success: true, data: tasks.get(c.req.param('id')) }));
  app.patch('/tasks/:id', async c => c.json({ success: true, data: tasks.update(c.req.param('id'), await body(c)) }));
  app.delete('/tasks/:id', c => { tasks.remove(c.req.param('id')); return c.json({ success: true, data: null }); });
  return app;
}
