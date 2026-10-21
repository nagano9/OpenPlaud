import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { initializeMobileSync } from './mobile-schema';

/**
 * Paired-client credentials (MOB-06). Each pairing creates its own client row holding only a
 * SHA-256 hash of a 256-bit random token. The desktop's global pairing token keeps working for
 * phones paired before per-client credentials existed, as the revocable "legacy client".
 *
 * Presence is never inferred: `lastSeenAt` is the last authenticated request, not a live signal.
 */
export const CLIENT_PERMISSIONS = ['read', 'write', 'upload', 'sync'] as const;
export type ClientPermission = typeof CLIENT_PERMISSIONS[number];
export const LEGACY_CLIENT_ID = 'legacy';
/** A QR/manual pairing code that was never used stops working after this long. */
export const PAIRING_CODE_TTL_MS = 60 * 60 * 1000;
const SEEN_WRITE_INTERVAL_MS = 60 * 1000;

export type MobileClient = {
  id: string;
  name: string;
  platform: string;
  permissions: ClientPermission[];
  legacy: boolean;
  createdAt: string;
  pairingExpiresAt: string | null;
  lastSeenAt: string | null;
  lastSuccessfulSyncAt: string | null;
  revokedAt: string | null;
};

type ClientRow = {
  id: string; name: string; platform: string; token_hash: string; permissions: string; legacy: number;
  created_at: string; pairing_expires_at: string | null; last_seen_at: string | null;
  last_successful_sync_at: string | null; revoked_at: string | null;
};

export class ClientNotFound extends Error {}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time string comparison that does not leak the expected length through early exit. */
export function tokensEqual(expected: string, supplied: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(a, b) && expected.length === supplied.length;
}

function parsePermissions(value: string): ClientPermission[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((p): p is ClientPermission => (CLIENT_PERMISSIONS as readonly string[]).includes(p)) : [];
  } catch { return []; }
}

export function normalizePermissions(value: unknown): ClientPermission[] {
  if (!Array.isArray(value)) throw new Error('Permissions must be a list.');
  const unknown = value.filter(p => !(CLIENT_PERMISSIONS as readonly unknown[]).includes(p));
  if (unknown.length) throw new Error(`Unknown permission: ${String(unknown[0])}.`);
  return CLIENT_PERMISSIONS.filter(p => value.includes(p));
}

function cleanName(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error('Client name must be text.');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  if (!name) throw new Error('Client name is required.');
  return name;
}

function cleanPlatform(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  return value.replace(/[^a-zA-Z0-9 ._()-]/g, '').trim().slice(0, 40) || 'unknown';
}

function toClient(row: ClientRow): MobileClient {
  return {
    id: row.id, name: row.name, platform: row.platform, permissions: parsePermissions(row.permissions),
    legacy: row.legacy === 1, createdAt: row.created_at, pairingExpiresAt: row.pairing_expires_at,
    lastSeenAt: row.last_seen_at, lastSuccessfulSyncAt: row.last_successful_sync_at, revokedAt: row.revoked_at,
  };
}

export class MobileClientStore {
  constructor(private readonly sqlite: Database, private readonly now: () => Date = () => new Date()) {
    initializeMobileSync(sqlite);
  }

  private row(id: string): ClientRow | null {
    return this.sqlite.query('SELECT * FROM mobile_clients WHERE id = ?').get(id) as ClientRow | null;
  }

  get(id: string): MobileClient | null {
    const row = this.row(id);
    return row ? toClient(row) : null;
  }

  list(): MobileClient[] {
    return (this.sqlite.query('SELECT * FROM mobile_clients ORDER BY revoked_at IS NOT NULL, created_at DESC').all() as ClientRow[]).map(toClient);
  }

  /** Issues a new client and returns its token. The token is never stored or shown again. */
  create(input: { name?: unknown; platform?: unknown; permissions?: unknown } = {}): { client: MobileClient; token: string } {
    const token = randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    const now = this.now();
    const permissions = input.permissions === undefined ? [...CLIENT_PERMISSIONS] : normalizePermissions(input.permissions);
    this.sqlite.query(`INSERT INTO mobile_clients (id, name, platform, token_hash, permissions, legacy, created_at, pairing_expires_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(id, cleanName(input.name, 'New phone'), cleanPlatform(input.platform),
      hashToken(token), JSON.stringify(permissions), now.toISOString(), new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString());
    return { client: this.get(id)!, token };
  }

  /**
   * The desktop's global pairing token as a client. Its row is created on first use and is reset
   * (un-revoked) only if the desktop itself generated a different global token.
   */
  ensureLegacy(globalToken: string): MobileClient {
    const hash = hashToken(globalToken);
    const existing = this.row(LEGACY_CLIENT_ID);
    if (!existing) {
      this.sqlite.query(`INSERT INTO mobile_clients (id, name, platform, token_hash, permissions, legacy, created_at)
        VALUES (?, 'Legacy pairing', 'unknown', ?, ?, 1, ?)`).run(LEGACY_CLIENT_ID, `legacy:${hash}`, JSON.stringify(CLIENT_PERMISSIONS), this.now().toISOString());
    } else if (existing.token_hash !== `legacy:${hash}`) {
      this.sqlite.query('UPDATE mobile_clients SET token_hash = ?, revoked_at = NULL, last_seen_at = NULL, last_successful_sync_at = NULL WHERE id = ?')
        .run(`legacy:${hash}`, LEGACY_CLIENT_ID);
    }
    return this.get(LEGACY_CLIENT_ID)!;
  }

  /** Resolves a per-client token. Revoked clients and expired, never-used pairing codes fail. */
  authenticate(token: string): MobileClient | null {
    if (!token || token.length > 256) return null;
    const hash = hashToken(token);
    const row = this.sqlite.query('SELECT * FROM mobile_clients WHERE token_hash = ? AND legacy = 0').get(hash) as ClientRow | null;
    // The indexed lookup is on a hash of the secret; compare again in constant time.
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) return null;
    if (row.revoked_at) return null;
    if (row.pairing_expires_at && new Date(row.pairing_expires_at) <= this.now()) return null;
    return toClient(row);
  }

  /**
   * The key a paired phone and this desktop prove themselves with over Bluetooth: SHA-256 of
   * the phone's token, which both sides hold without the token itself crossing the radio.
   * Only active per-client credentials allowed to upload qualify.
   */
  bluetoothKey(id: string): { client: MobileClient; key: Buffer } | null {
    const row = this.row(id);
    if (!row || row.legacy === 1 || row.revoked_at || !/^[0-9a-f]{64}$/.test(row.token_hash)) return null;
    const client = toClient(row);
    if (!client.permissions.includes('upload')) return null;
    return { client, key: Buffer.from(row.token_hash, 'hex') };
  }

  /** Active per-client credentials that can sync over Bluetooth. */
  bluetoothClients(): MobileClient[] {
    return this.list().filter(client => this.bluetoothKey(client.id) !== null);
  }

  /** Records an authenticated request. Throttled so ordinary browsing does not write on every call. */
  touch(client: MobileClient): void {
    const now = this.now();
    if (client.lastSeenAt && now.getTime() - new Date(client.lastSeenAt).getTime() < SEEN_WRITE_INTERVAL_MS && !client.pairingExpiresAt) return;
    this.sqlite.query('UPDATE mobile_clients SET last_seen_at = ?, pairing_expires_at = NULL WHERE id = ?').run(now.toISOString(), client.id);
  }

  markSynced(clientId: string): void {
    this.sqlite.query('UPDATE mobile_clients SET last_successful_sync_at = ? WHERE id = ?').run(this.now().toISOString(), clientId);
  }

  update(id: string, input: { name?: unknown; platform?: unknown; permissions?: unknown }): MobileClient {
    const row = this.row(id);
    if (!row) throw new ClientNotFound('Client not found.');
    const name = cleanName(input.name, row.name);
    const platform = input.platform === undefined ? row.platform : cleanPlatform(input.platform);
    const permissions = input.permissions === undefined ? parsePermissions(row.permissions) : normalizePermissions(input.permissions);
    this.sqlite.query('UPDATE mobile_clients SET name = ?, platform = ?, permissions = ? WHERE id = ?')
      .run(name, platform, JSON.stringify(permissions), id);
    return this.get(id)!;
  }

  revoke(id: string): MobileClient {
    const row = this.row(id);
    if (!row) throw new ClientNotFound('Client not found.');
    if (!row.revoked_at) this.sqlite.query('UPDATE mobile_clients SET revoked_at = ? WHERE id = ?').run(this.now().toISOString(), id);
    return this.get(id)!;
  }

  /**
   * Replaces a client's credential; the old token stops working immediately. The legacy client's
   * token belongs to the desktop, so rotating it revokes the legacy client and issues a new
   * per-client credential carrying the same name and permissions.
   */
  rotate(id: string): { client: MobileClient; token: string } {
    const row = this.row(id);
    if (!row) throw new ClientNotFound('Client not found.');
    if (row.revoked_at) throw new Error('A revoked client cannot be rotated. Pair the phone again.');
    if (row.legacy === 1) {
      return this.sqlite.transaction(() => {
        this.revoke(id);
        return this.create({ name: row.name === 'Legacy pairing' ? 'Phone (re-paired)' : row.name, platform: row.platform, permissions: parsePermissions(row.permissions) });
      })();
    }
    const token = randomBytes(32).toString('base64url');
    this.sqlite.query('UPDATE mobile_clients SET token_hash = ?, pairing_expires_at = ? WHERE id = ?')
      .run(hashToken(token), new Date(this.now().getTime() + PAIRING_CODE_TTL_MS).toISOString(), id);
    return { client: this.get(id)!, token };
  }
}
