import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeOrganizer, OrganizerStore } from './store';
import { MANIFEST_NAME, MarkdownExporter, exportedMarkdown, safeSegment } from './markdown-export';
import { createOrganizerApi } from '../api/organizer';
import { NoteDeliveryService } from './delivery';
import { DocumentGenerationService } from './generation';

let database: Database, store: OrganizerStore, root: string, exporter: MarkdownExporter;
beforeEach(() => {
  database = new Database(':memory:'); database.exec('PRAGMA foreign_keys=ON'); initializeOrganizer(database); store = new OrganizerStore(database);
  root = mkdtempSync(join(tmpdir(), 'openplod-export-'));
  exporter = new MarkdownExporter(store, () => root);
});
afterEach(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
const note = (input = {}) => store.create({ title: 'Meeting notes', content: '# Decisions\n\nKeep the audio.', idempotencyKey: crypto.randomUUID(), ...input });
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const run = (options: Record<string, unknown> = {}) => exporter.run({ confirm: true, ...options });

describe('Managed Markdown export (KB-02)', () => {
  test('writes folders, front matter, and a manifest; a dry run writes nothing', async () => {
    const projects = store.createFolder({ name: 'Projects', parentId: null });
    const inner = store.createFolder({ name: 'Q4: plans', parentId: projects.id });
    const document = note({ folderId: inner.id, tags: ['b', 'A'], properties: { status: 'draft', score: 3 } });
    const preview = await exporter.run({ dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, counts: { created: 1 }, items: [{ documentId: document.id, path: 'Projects/Q4- plans/Meeting notes.md', action: 'created' }] });
    expect(existsSync(join(root, MANIFEST_NAME))).toBe(false);
    expect(existsSync(join(root, 'Projects'))).toBe(false);

    const result = await run();
    expect(result.counts).toMatchObject({ created: 1, conflict: 0 });
    const text = read('Projects/Q4- plans/Meeting notes.md');
    expect(text).toBe(exportedMarkdown({ ...store.get(document.id) }));
    expect(text).toStartWith(`---\nopenplod_id: "${document.id}"\ntitle: "Meeting notes"\nrevision: 1\n`);
    expect(text).toContain('tags: ["A","b"]\nproperties: {"status":"draft","score":3}\n---\n# Decisions');
    const manifest = JSON.parse(read(MANIFEST_NAME));
    expect(manifest.documents[document.id]).toMatchObject({ path: 'Projects/Q4- plans/Meeting notes.md', revision: 1 });
    expect(await exporter.status()).toMatchObject({ configured: true, documentCount: 1, lastExportedAt: result.exportedAt });
  });

  test('re-runs are idempotent, edits update in place, and renames move the file', async () => {
    const document = note();
    await run();
    expect((await run()).counts).toMatchObject({ unchanged: 1, created: 0, updated: 0 });
    const edited = store.update(document.id, { content: 'New body', revision: 1 });
    expect((await run()).items).toEqual([{ documentId: document.id, title: 'Meeting notes', path: 'Meeting notes.md', action: 'updated' }]);
    expect(read('Meeting notes.md')).toEndWith('---\nNew body\n');
    store.update(document.id, { title: 'Renamed', revision: edited.revision });
    expect((await run()).items[0]).toMatchObject({ path: 'Renamed.md', action: 'moved' });
    expect(existsSync(join(root, 'Meeting notes.md'))).toBe(false);
    expect(read('Renamed.md')).toContain('title: "Renamed"');
  });

  test('never overwrites external edits or deletions unless that document is named', async () => {
    const document = note();
    await run();
    writeFileSync(join(root, 'Meeting notes.md'), 'Edited in Obsidian');
    store.update(document.id, { content: 'Vault edit', revision: 1 });
    expect((await run()).items).toEqual([{ documentId: document.id, title: 'Meeting notes', path: 'Meeting notes.md', action: 'conflict', reason: 'modified_externally' }]);
    expect(read('Meeting notes.md')).toBe('Edited in Obsidian');
    expect((await run({ overwrite: [document.id] })).items[0]).toMatchObject({ action: 'updated' });
    expect(read('Meeting notes.md')).toContain('Vault edit');

    rmSync(join(root, 'Meeting notes.md'));
    expect((await run()).items[0]).toMatchObject({ action: 'conflict', reason: 'deleted_externally' });
    expect(existsSync(join(root, 'Meeting notes.md'))).toBe(false);
    expect((await run({ overwrite: [document.id] })).items[0]).toMatchObject({ action: 'updated' });
    expect(existsSync(join(root, 'Meeting notes.md'))).toBe(true);
  });

  test('foreign files and duplicate titles get distinct names; Trash keeps its file', async () => {
    writeFileSync(join(root, 'Meeting notes.md'), 'Not ours');
    const first = note(), second = note();
    const result = await run();
    expect(result.items.map(item => item.path).sort()).toEqual(['Meeting notes (2).md', 'Meeting notes (3).md']);
    expect(read('Meeting notes.md')).toBe('Not ours');
    const paths = JSON.parse(read(MANIFEST_NAME)).documents;
    store.trash(first.id, 1);
    const after = await run();
    expect(after.counts).toMatchObject({ orphaned: 1, unchanged: 1 });
    expect(after.items).toEqual([{ documentId: first.id, title: null, path: paths[first.id].path, action: 'orphaned' }]);
    expect(existsSync(join(root, paths[first.id].path))).toBe(true);
    expect(JSON.parse(read(MANIFEST_NAME)).documents[second.id].path).toBe(paths[second.id].path);
  });

  test('refuses symlinks, invalid manifests, missing confirmation, and an unset folder', async () => {
    const document = note();
    await run();
    const outside = mkdtempSync(join(tmpdir(), 'openplod-outside-'));
    // Windows only creates symlinks with Developer Mode or elevation; the rest of the test still runs.
    let symlinks = true;
    try { symlinkSync(join(outside, 'probe-target'), join(outside, 'probe')); } catch { symlinks = false; }
    try {
      if (symlinks) {
        rmSync(join(root, 'Meeting notes.md'));
        symlinkSync(join(outside, 'target.md'), join(root, 'Meeting notes.md'));
        expect((await run({ overwrite: [document.id] })).items[0]).toMatchObject({ action: 'conflict', reason: 'not_a_file' });
        expect(existsSync(join(outside, 'target.md'))).toBe(false);
      }
    } finally { rmSync(outside, { recursive: true, force: true }); }

    writeFileSync(join(root, MANIFEST_NAME), JSON.stringify({ schemaVersion: 1, exportedAt: 'x', documents: { [document.id]: { path: '../escape.md', base: 'x.md', revision: 1, sha256: '0'.repeat(64) } } }));
    await expect(run()).rejects.toThrow('not a valid OpenPlod manifest');
    writeFileSync(join(root, MANIFEST_NAME), '{broken');
    await expect(run()).rejects.toThrow('not a valid OpenPlod manifest');
    await expect(exporter.run({})).rejects.toThrow();

    const unset = new MarkdownExporter(store, () => null);
    expect(await unset.status()).toMatchObject({ configured: false });
    await expect(unset.run({ confirm: true })).rejects.toThrow('OPENPLOD_EXPORT_DIR');
    const relative = new MarkdownExporter(store, () => 'relative/path');
    expect((await relative.status()).error).toContain('absolute');
  });

  test('portable names and the HTTP contract', async () => {
    expect(safeSegment('a/b\\c:d*?"<>|')).toBe('a-b-c-d------');
    expect(safeSegment('CON')).toBe('CON_');
    expect(safeSegment('.hidden')).toBe('_.hidden');
    expect(safeSegment('   ')).toBe('Untitled');
    mkdirSync(join(root, 'nested'));
    note();
    const api = createOrganizerApi(store, new NoteDeliveryService(store), new DocumentGenerationService(store), exporter);
    const post = (body: unknown) => api.request('/exports/markdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({})).status).toBe(400);
    expect((await post({ dryRun: true })).status).toBe(200);
    const done = await post({ confirm: true });
    expect(((await done.json()) as { data: { counts: { created: number } } }).data.counts.created).toBe(1);
    expect(((await (await api.request('/exports/markdown')).json()) as { data: { documentCount: number } }).data.documentCount).toBe(1);
  });
});
