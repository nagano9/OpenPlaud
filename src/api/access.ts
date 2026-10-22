import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';
import { sqlite } from '../db/client';
import { MobileClientStore, tokensEqual, type ClientPermission, type MobileClient } from '../sync/mobile-clients';

/**
 * Who made a request.
 * - `desktop`: the global pairing token from this computer (the desktop app itself).
 * - `api`: the separate `OPENPLOD_API_TOKEN` (MCP and scripts).
 * - `client`: a paired phone, either with its own credential or the revocable legacy token.
 * - `open`: no credentials are configured at all (development server).
 */
export type Principal =
  | { kind: 'desktop' | 'api' | 'open' }
  | { kind: 'client'; client: MobileClient };

declare module 'hono' {
  interface ContextVariableMap { principal: Principal }
}

let store: MobileClientStore | null = null;
export function mobileClients(): MobileClientStore {
  return store ??= new MobileClientStore(sqlite);
}

export function isLoopback(c: Context): boolean {
  try { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(getConnInfo(c).remote.address ?? ''); } catch { return false; }
}

/**
 * The request names this computer in its Host header. A page on another site that rebinds its
 * DNS name to 127.0.0.1 still sends its own name, so this check stops DNS-rebinding attacks.
 */
export function loopbackHost(c: Context): boolean {
  const host = (c.req.header('Host') ?? '').toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * A source-run vault opened in a browser on this computer cannot send the pairing token, yet phones
 * need one. With OPENPLOD_TRUST_LOCAL_BROWSER=true, tokenless requests from this computer (loopback
 * address and loopback Host) get the same rights as the desktop app; the network still needs a token.
 */
const trustLocalBrowser = () => process.env.OPENPLOD_TRUST_LOCAL_BROWSER === 'true';

/** True when no request credential is configured, so the server is open (development only). */
export function credentialsConfigured(): boolean {
  return Boolean(process.env.OPENPLOD_PAIRING_TOKEN || process.env.OPENPLOD_API_TOKEN);
}

/** Resolves the caller's identity, or null when the token is missing, unknown, or revoked. */
export function resolvePrincipal(c: Context): Principal | null {
  const supplied = c.req.header('X-OpenPlod-Token') || '';
  const apiToken = process.env.OPENPLOD_API_TOKEN;
  const pairingToken = process.env.OPENPLOD_PAIRING_TOKEN;
  // An unconfigured development server is open to this computer only, never to the network.
  if (!supplied) {
    if (!isLoopback(c) || !loopbackHost(c)) return null;
    if (!credentialsConfigured()) return { kind: 'open' };
    return trustLocalBrowser() ? { kind: 'desktop' } : null;
  }
  if (apiToken && tokensEqual(apiToken, supplied)) return { kind: 'api' };
  if (pairingToken && tokensEqual(pairingToken, supplied)) {
    // The desktop app talks to its own service over loopback. From the network the same token is
    // a phone paired before per-client credentials, which the owner can revoke.
    if (isLoopback(c)) return { kind: 'desktop' };
    const legacy = mobileClients().ensureLegacy(pairingToken);
    if (legacy.revokedAt) return null;
    mobileClients().touch(legacy);
    return { kind: 'client', client: legacy };
  }
  let client: MobileClient | null;
  try { client = mobileClients().authenticate(supplied); }
  catch (error) {
    // Fail closed: an unreadable client table never grants access.
    console.error('[Access] Paired-client lookup failed:', error instanceof Error ? error.message : error);
    return null;
  }
  if (!client) return null;
  mobileClients().touch(client);
  return { kind: 'client', client };
}

export function principalOf(c: Context): Principal | null {
  return c.get('principal') ?? resolvePrincipal(c);
}

export function isAdmin(principal: Principal | null): boolean {
  return principal?.kind === 'desktop' || principal?.kind === 'api' || principal?.kind === 'open';
}

export function allows(principal: Principal | null, permission: ClientPermission): boolean {
  if (!principal) return false;
  return principal.kind !== 'client' || principal.client.permissions.includes(permission);
}

/** The owner key for client-scoped state such as resumable transfers. */
export function principalKey(principal: Principal): string {
  return principal.kind === 'client' ? principal.client.id : principal.kind;
}

const unauthorized = (c: Context) => c.json({ success: false, code: 'unauthorized', error: 'This device is not paired with OpenPlod.' }, 401);

export const apiAccess: MiddlewareHandler = async (c, next) => {
  const principal = resolvePrincipal(c);
  if (!principal) return unauthorized(c);
  c.set('principal', principal);
  // Mobile routes check their own, finer permissions.
  if (principal.kind === 'client' && !c.req.path.startsWith('/api/mobile')) {
    const needed: ClientPermission = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) ? 'read' : 'write';
    if (!allows(principal, needed)) return c.json({ success: false, code: 'forbidden', error: `This paired device does not have ${needed} access.` }, 403);
  }
  c.header('Cache-Control', 'no-store');
  return next();
};
