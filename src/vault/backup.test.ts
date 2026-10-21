import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, restoreBackup, RestoreTargetNotEmpty, verifyBackup } from './backup';
import { BackupPassphraseError } from './backup-crypto';

const root = mkdtempSync(join(tmpdir(), 'openplod-backup-test-'));
// Windows keeps restored SQLite files locked until the process exits; leftover temp files are harmless.
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch (error) { if (process.platform !== 'win32') throw error; } });
const fastScrypt = { N: 1 << 10, r: 8, p: 1 };

function makeVault(name: string) {
  const directory = join(root, name), library = join(directory, 'recordings');
  mkdirSync(join(library, 'originals', 'rec-1'), { recursive: true });
  writeFileSync(join(library, 'rec-1.m4a'), Buffer.alloc(70000, 7));
  writeFileSync(join(library, 'originals', 'rec-1', 'device-original.plaud'), 'device bytes');
  writeFileSync(join(directory, 'vault.key'), 'a'.repeat(64));
  const databasePath = join(directory, 'openplod.db');
  const database = new Database(databasePath);
  database.exec(`CREATE TABLE recordings (id TEXT PRIMARY KEY, file_path TEXT NOT NULL);
    CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO vault_meta VALUES('schema_generation','1');`);
  database.query('INSERT INTO recordings VALUES(?,?)').run('rec-1', join(library, 'rec-1.m4a'));
  database.query("INSERT INTO user_settings VALUES('mistralApiKey','enc:v1:secret'),('autoImport','true')").run();
  return { directory, library, databasePath, database, secretKeyPath: join(directory, 'vault.key') };
}

test('plain backup excludes credentials, verifies, and restores into a new folder with repointed paths', async () => {
  const vault = makeVault('plain');
  const backup = await createBackup(vault, { outputDirectory: join(root, 'out-plain') });
  expect(backup.path.endsWith('.tar')).toBe(true);
  expect(readFileSync(`${backup.path}.sha256`, 'utf8')).toContain(backup.sha256);
  expect(backup.manifest.credentialsIncluded).toBe(false);
  expect(backup.manifest.files.map(file => file.path)).toEqual(['database/openplod.db', 'library/originals/rec-1/device-original.plaud', 'library/rec-1.m4a']);
  const verified = await verifyBackup(backup.path);
  expect(verified.databaseIntegrity).toBe('ok');
  expect(verified.manifest.counts.recordings).toBe(1);

  const target = join(root, 'restored-plain');
  const restored = await restoreBackup(backup.path, { targetDirectory: target, liveDirectories: [vault.directory] });
  expect(restored.repointedRecordings).toBe(1);
  expect(restored.credentialsRestored).toBe(false);
  const database = new Database(restored.databasePath);
  expect(database.query('SELECT file_path AS path FROM recordings').get()).toEqual({ path: join(target, 'recordings', 'rec-1.m4a') });
  expect(database.query("SELECT key FROM user_settings").all()).toEqual([{ key: 'autoImport' }]);
  database.close();
  expect(readFileSync(join(target, 'recordings', 'rec-1.m4a')).length).toBe(70000);
  expect(readFileSync(join(target, 'recordings', 'originals', 'rec-1', 'device-original.plaud'), 'utf8')).toBe('device bytes');
});

test('tampered or truncated archives fail verification', async () => {
  const vault = makeVault('tamper');
  const backup = await createBackup(vault, { outputDirectory: join(root, 'out-tamper') });
  const bytes = readFileSync(backup.path);
  const index = bytes.indexOf(Buffer.alloc(100, 7));
  const tampered = Buffer.from(bytes); tampered[index + 10] = 8;
  writeFileSync(join(root, 'tampered.tar'), tampered);
  await expect(verifyBackup(join(root, 'tampered.tar'))).rejects.toThrow('Checksum mismatch: library/rec-1.m4a');
  writeFileSync(join(root, 'truncated.tar'), bytes.subarray(0, 4096));
  await expect(verifyBackup(join(root, 'truncated.tar'))).rejects.toThrow();
});

test('encrypted backup round-trips credentials and rejects a wrong passphrase or damage', async () => {
  const vault = makeVault('encrypted');
  const passphrase = 'correct horse battery';
  await expect(createBackup(vault, { outputDirectory: join(root, 'out-enc'), passphrase: 'short' })).rejects.toThrow('at least');
  const backup = await createBackup(vault, { outputDirectory: join(root, 'out-enc'), passphrase, scrypt: fastScrypt });
  expect(backup.path.endsWith('.tar.opbk')).toBe(true);
  expect(readFileSync(backup.path).includes(Buffer.from('device bytes'))).toBe(false);
  await expect(verifyBackup(backup.path)).rejects.toThrow('passphrase');
  await expect(verifyBackup(backup.path, { passphrase: 'wrong passphrase!!' })).rejects.toBeInstanceOf(BackupPassphraseError);
  const verified = await verifyBackup(backup.path, { passphrase });
  expect(verified.encrypted).toBe(true);
  expect(verified.manifest.files.map(file => file.path)).toContain('secrets/vault.key');

  const damaged = Buffer.from(readFileSync(backup.path)); damaged[damaged.length - 40] ^= 1;
  writeFileSync(join(root, 'damaged.opbk'), damaged);
  await expect(verifyBackup(join(root, 'damaged.opbk'), { passphrase })).rejects.toThrow('damaged');
  writeFileSync(join(root, 'cut.opbk'), readFileSync(backup.path).subarray(0, -30));
  await expect(verifyBackup(join(root, 'cut.opbk'), { passphrase })).rejects.toThrow('truncated');

  const target = join(root, 'restored-enc');
  const restored = await restoreBackup(backup.path, { targetDirectory: target, passphrase });
  expect(restored.credentialsRestored).toBe(true);
  expect(readFileSync(join(target, 'vault.key'), 'utf8')).toBe('a'.repeat(64));
  const database = new Database(restored.databasePath);
  expect(database.query("SELECT value FROM user_settings WHERE key='mistralApiKey'").get()).toEqual({ value: 'enc:v1:secret' });
  database.close();
});

test('restore refuses a non-empty folder or the live vault, and only moves existing files aside when confirmed', async () => {
  const vault = makeVault('refuse');
  const backup = await createBackup(vault, { outputDirectory: join(root, 'out-refuse') });
  const target = join(root, 'occupied');
  mkdirSync(target); writeFileSync(join(target, 'keep.m4a'), 'precious');
  await expect(restoreBackup(backup.path, { targetDirectory: target })).rejects.toBeInstanceOf(RestoreTargetNotEmpty);
  await expect(restoreBackup(backup.path, { targetDirectory: vault.directory, liveDirectories: [vault.directory] })).rejects.toThrow('currently running');
  const restored = await restoreBackup(backup.path, { targetDirectory: target, confirmOverwrite: true });
  expect(readFileSync(join(restored.movedAside!, 'keep.m4a'), 'utf8')).toBe('precious');
  expect(existsSync(join(target, 'openplod.db'))).toBe(true);
  expect(readdirSync(target).some(name => name.startsWith('.restore-'))).toBe(false);
});
