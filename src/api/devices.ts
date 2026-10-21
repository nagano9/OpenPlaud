import { Hono } from 'hono';
import { z } from 'zod';
import type { DeviceRegistry } from '../devices/registry';
import type { BluetoothInbox } from '../devices/bluetooth-inbox';

const toggle = z.object({ enabled: z.boolean() }).strict();
const inboxInput = z.object({ enabled: z.boolean().optional(), path: z.string().max(500).optional() }).strict();
const failure = (error: unknown) => error instanceof Error ? error.message : 'Request failed.';

/** Bluetooth recording sources: drivers with automatic import, and the Bluetooth file inbox. */
export function createDevicesApi(registry: DeviceRegistry, inbox: BluetoothInbox) {
  const app = new Hono();
  app.get('/', c => c.json({ success: true, data: { sources: registry.list(), inbox: inbox.status() } }));
  app.put('/:id/auto-import', async c => {
    const source = registry.get(c.req.param('id'));
    if (!source) return c.json({ success: false, error: 'Unknown device source.' }, 404);
    const input = toggle.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ success: false, error: 'Send {"enabled": true|false}.' }, 400);
    try { return c.json({ success: true, data: source.set(input.data.enabled) }); }
    catch (error) { return c.json({ success: false, error: failure(error) }, 400); }
  });
  app.get('/bluetooth-inbox', c => c.json({ success: true, data: inbox.status() }));
  app.put('/bluetooth-inbox', async c => {
    const input = inboxInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ success: false, error: 'Invalid Bluetooth inbox settings.' }, 400);
    try { return c.json({ success: true, data: await inbox.configure(input.data) }); }
    catch (error) { return c.json({ success: false, error: failure(error) }, 400); }
  });
  return app;
}
