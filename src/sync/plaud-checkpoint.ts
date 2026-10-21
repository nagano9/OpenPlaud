import { open } from 'node:fs/promises';

/** Opens for positioned writes: an append-mode handle cannot be truncated on Windows (EPERM). */
async function openForUpdate(path: string) {
  try { return await open(path, 'r+'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return open(path, 'w+', 0o600);
  }
}

export async function openPlaudCheckpoint(path: string, prefixLength: number) {
  const file = await openForUpdate(path);
  let written = prefixLength;
  try { await file.truncate(written); } catch (error) { await file.close(); throw error; }
  return {
    async save(bytes: Uint8Array) {
      if (bytes.length < written) throw new Error('Plaud checkpoint cannot shrink');
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, written);
        if (!result.bytesWritten) throw new Error('Plaud checkpoint write made no progress');
        written += result.bytesWritten;
      }
      await file.sync();
    },
    close: () => file.close(),
  };
}
