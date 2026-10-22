import type { Database } from 'bun:sqlite';

/**
 * Who named a recording. An AI title replaces only the import filename, once: never a title the
 * person typed (`title_edited`), and never twice (`auto_titled_at`). Revision numbers cannot say
 * this, because saving a transcript also bumps the revision.
 */
export function ensureTitleColumns(database: Database) {
  const columns = database.query('PRAGMA table_info(recordings)').all() as { name: string }[];
  if (!columns.length) return;
  if (!columns.some(column => column.name === 'title_edited')) database.exec('ALTER TABLE recordings ADD COLUMN title_edited INTEGER NOT NULL DEFAULT 0');
  if (!columns.some(column => column.name === 'auto_titled_at')) database.exec('ALTER TABLE recordings ADD COLUMN auto_titled_at TEXT');
}

/** Records that the person chose this recording's title. */
export function markTitleEdited(database: Database, recordingId: string) {
  ensureTitleColumns(database);
  database.query('UPDATE recordings SET title_edited=1 WHERE id=?').run(recordingId);
}

/** Whether an AI title may still replace the import filename. */
export function mayAutoTitle(database: Database, recordingId: string): boolean {
  ensureTitleColumns(database);
  const row = database.query('SELECT title_edited AS edited, auto_titled_at AS titled FROM recordings WHERE id=?').get(recordingId) as { edited: number; titled: string | null } | null;
  return Boolean(row && !row.edited && !row.titled);
}
