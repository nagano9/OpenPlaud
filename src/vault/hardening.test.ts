import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { decryptSecret, encryptSecret, migratePlaintextSecrets, protectSetting, resetSecretKeyCache, revealSettings, secretKey } from './secrets';
import { redactingLogger, redactUrl } from './redacting-logger';
import { hardenVaultPermissions, tlsOptions } from './startup';

const root = mkdtempSync(join(tmpdir(), 'openplod-hardening-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); resetSecretKeyCache(); });

test('secrets are encrypted with a 0600 key file and bound to their setting name', () => {
  resetSecretKeyCache();
  const keyFile = join(root, 'key', 'vault.key');
  const key = secretKey(keyFile);
  if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  const stored = encryptSecret('mistralApiKey', 'sk-test-123', key);
  expect(stored.startsWith('enc:v1:')).toBe(true);
  expect(stored).not.toContain('sk-test');
  expect(decryptSecret('mistralApiKey', stored, key)).toBe('sk-test-123');
  expect(decryptSecret('openaiApiKey', stored, key)).toBe('');
  expect(decryptSecret('mistralApiKey', 'legacy-plain', key)).toBe('legacy-plain');
  expect(encryptSecret('mistralApiKey', '', key)).toBe('');
});

test('plaintext keys migrate in place and are revealed transparently', () => {
  resetSecretKeyCache();
  const previous = process.env.OPENPLOD_SECRET_KEY_FILE;
  process.env.OPENPLOD_SECRET_KEY_FILE = join(root, 'migrate.key');
  try {
    const database = new Database(':memory:');
    database.exec("CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO user_settings VALUES('deepgramApiKey','dg-plain'),('autoImport','true'),('openaiApiKey','')");
    expect(migratePlaintextSecrets(database)).toBe(1);
    expect(migratePlaintextSecrets(database)).toBe(0);
    const rows = Object.fromEntries((database.query('SELECT key,value FROM user_settings').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
    expect(rows.deepgramApiKey!.startsWith('enc:v1:')).toBe(true);
    expect(revealSettings(rows)).toEqual({ deepgramApiKey: 'dg-plain', autoImport: 'true', openaiApiKey: '' });
    expect(protectSetting('autoImport', 'false')).toBe('false');
    expect(protectSetting('openWhistleApiKey', 'owk_1').startsWith('enc:v1:')).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.OPENPLOD_SECRET_KEY_FILE; else process.env.OPENPLOD_SECRET_KEY_FILE = previous;
    resetSecretKeyCache();
  }
});

test('request logs never include tokens, keys or long opaque values', async () => {
  expect(redactUrl('http://h/api/audio/1?token=abc&download=1')).toBe('/api/audio/1?token=[redacted]&download=1');
  expect(redactUrl('/api/x?api_key=k&Key=2&q=hello')).toBe('/api/x?api_key=[redacted]&Key=[redacted]&q=hello');
  expect(redactUrl('/api/mobile/pair/0123456789abcdef')).toBe('/api/mobile/pair/[redacted]');
  expect(redactUrl('/api/recordings/aaaaaaaa-1111-4111-8111-111111111111')).toBe('/api/recordings/aaaaaaaa-1111-4111-8111-111111111111');
  expect(redactUrl(`/api/r/${'x'.repeat(40)}`)).toBe('/api/r/[redacted]');
  const lines: string[] = [];
  const app = new Hono().use('*', redactingLogger(line => lines.push(line))).get('/a', c => c.text('ok'));
  await app.request('/a?passphrase=hunter2hunter2&x=1');
  expect(lines.join('\n')).not.toContain('hunter2');
  expect(lines[1]).toContain('200');
});

test('vault permissions are tightened and TLS needs both files', () => {
  if (process.platform === 'win32') return;
  const data = join(root, 'data'), library = join(data, 'recordings');
  mkdirSync(library, { recursive: true, mode: 0o755 });
  writeFileSync(join(data, 'vault.db'), '', { mode: 0o644 });
  const changed = hardenVaultPermissions({ dataDirectory: data, database: join(data, 'vault.db'), library });
  expect(changed.length).toBe(3);
  expect(statSync(data).mode & 0o777).toBe(0o700);
  expect(statSync(join(data, 'vault.db')).mode & 0o777).toBe(0o600);
  const previous = { cert: process.env.OPENPLOD_TLS_CERT, key: process.env.OPENPLOD_TLS_KEY };
  try {
    delete process.env.OPENPLOD_TLS_CERT; delete process.env.OPENPLOD_TLS_KEY;
    expect(tlsOptions()).toEqual({});
    process.env.OPENPLOD_TLS_CERT = join(root, 'cert.pem');
    expect(() => tlsOptions()).toThrow('both');
  } finally {
    if (previous.cert === undefined) delete process.env.OPENPLOD_TLS_CERT; else process.env.OPENPLOD_TLS_CERT = previous.cert;
    if (previous.key === undefined) delete process.env.OPENPLOD_TLS_KEY; else process.env.OPENPLOD_TLS_KEY = previous.key;
  }
});
