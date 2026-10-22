import { afterEach, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { loopbackHost, resolvePrincipal } from './access';

const saved = { pairing: process.env.OPENPLOD_PAIRING_TOKEN, api: process.env.OPENPLOD_API_TOKEN, trust: process.env.OPENPLOD_TRUST_LOCAL_BROWSER };
afterEach(() => {
  for (const [key, value] of [['OPENPLOD_PAIRING_TOKEN', saved.pairing], ['OPENPLOD_API_TOKEN', saved.api], ['OPENPLOD_TRUST_LOCAL_BROWSER', saved.trust]] as const)
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

/** A request as Hono's Bun adapter sees it: headers plus the peer address. */
const request = (address: string, host: string, token?: string) => ({
  req: { header: (name: string) => name === 'Host' ? host : name === 'X-OpenPlod-Token' ? token : undefined, raw: new Request('http://x/') },
  env: { requestIP: () => ({ address, family: 'IPv4', port: 1 }) },
}) as unknown as Context;

test('Host must name this computer, so a DNS-rebinding page is refused', () => {
  expect(loopbackHost(request('127.0.0.1', 'localhost:3487'))).toBe(true);
  expect(loopbackHost(request('127.0.0.1', '127.0.0.1:3487'))).toBe(true);
  expect(loopbackHost(request('127.0.0.1', 'evil.example:3487'))).toBe(false);
});

test('an open development server serves only this computer and only loopback hosts', () => {
  delete process.env.OPENPLOD_PAIRING_TOKEN; delete process.env.OPENPLOD_API_TOKEN;
  expect(resolvePrincipal(request('127.0.0.1', 'localhost:3487'))).toEqual({ kind: 'open' });
  expect(resolvePrincipal(request('127.0.0.1', 'evil.example'))).toBeNull();
  expect(resolvePrincipal(request('192.168.1.20', 'localhost:3487'))).toBeNull();
});

test('with a pairing token, a local browser is trusted only when opted in, and the network never is', () => {
  process.env.OPENPLOD_PAIRING_TOKEN = 'desktop-token-for-tests';
  delete process.env.OPENPLOD_TRUST_LOCAL_BROWSER;
  expect(resolvePrincipal(request('127.0.0.1', 'localhost:3487'))).toBeNull();
  process.env.OPENPLOD_TRUST_LOCAL_BROWSER = 'true';
  expect(resolvePrincipal(request('127.0.0.1', 'localhost:3487'))).toEqual({ kind: 'desktop' });
  expect(resolvePrincipal(request('127.0.0.1', 'evil.example'))).toBeNull();
  expect(resolvePrincipal(request('192.168.1.20', 'localhost:3487'))).toBeNull();
  // The desktop token itself still works from this computer.
  expect(resolvePrincipal(request('127.0.0.1', 'localhost:3487', 'desktop-token-for-tests'))).toEqual({ kind: 'desktop' });
});
