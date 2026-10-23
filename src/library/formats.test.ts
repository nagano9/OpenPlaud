import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { sqlite } = await import('../db/client');
const { initializeDatabase } = await import('../db/setup');
const { importRecordingFile, isImportableAudio } = await import('./recording-library');

const root = mkdtempSync(join(tmpdir(), 'openplod-formats-'));
beforeAll(() => initializeDatabase());
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ } });

const ffmpeg = Bun.spawnSync(['ffmpeg', '-version']).exitCode === 0;
/** A short, distinct tone per format, so every import is a new recording rather than a duplicate. */
let tone = 300;
function make(extension: string, codec: string[]): string | null {
  const path = join(root, `sample-${extension.slice(1)}${extension}`);
  const made = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${tone += 37}:duration=1`, ...codec, path]).exitCode === 0;
  return made ? path : null;
}

// Formats people actually get from phones, messengers, Windows and Apple recorders, and videos.
// Encoders missing from this ffmpeg build (e.g. AMR) are skipped rather than faked.
const samples: [string, string[]][] = [
  ['.mp3', ['-c:a', 'libmp3lame']], ['.wav', []], ['.flac', []], ['.m4a', ['-c:a', 'aac']], ['.aac', ['-c:a', 'aac']], ['.ogg', ['-c:a', 'libvorbis']],
  ['.opus', ['-c:a', 'libopus']], ['.oga', ['-c:a', 'libvorbis']], ['.amr', ['-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb']],
  ['.3gp', ['-c:a', 'aac', '-f', '3gp']], ['.wma', ['-c:a', 'wmav2']], ['.aiff', []], ['.caf', []], ['.mka', ['-c:a', 'aac']],
  ['.ac3', ['-c:a', 'ac3']], ['.mp2', ['-c:a', 'mp2']], ['.m4b', ['-c:a', 'aac', '-f', 'ipod']], ['.mp4', ['-c:a', 'aac']], ['.mov', ['-c:a', 'aac']], ['.mkv', ['-c:a', 'aac']],
];

test('every common recording format is accepted by name', () => {
  for (const [extension] of samples) expect(isImportableAudio(`Rekaman${extension}`)).toBe(true);
  expect(isImportableAudio('Rekaman.AMR')).toBe(true);
  expect(isImportableAudio('notes.txt')).toBe(false);
  expect(isImportableAudio('photo.jpg')).toBe(false);
});

test('each format imports as a playable recording, and converted ones keep their original file', async () => {
  if (!ffmpeg) return;
  const imported: string[] = [], skipped: string[] = [];
  for (const [extension, codec] of samples) {
    const path = make(extension, codec);
    if (!path) { skipped.push(extension); continue; }
    const result = await importRecordingFile({ sourcePath: path, provenance: { sourceProvider: 'upload', sourceTransport: 'upload' } });
    expect(result.added).toBe(true);
    const stored = result.recording.filePath;
    expect(existsSync(stored)).toBe(true);
    // The stored audio is one every provider reads; ffprobe confirms it has an audio stream.
    expect(Bun.spawnSync(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', stored]).stdout.toString().trim()).toBe('audio');
    const native = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'].includes(extension);
    if (!native) {
      expect(result.recording.originalFilename).toBe(`sample-${extension.slice(1)}.m4a`);
      const originals = join(dirname(stored), 'originals', result.recording.id);
      expect(readdirSync(originals)).toContain(`original${extension}`);
    }
    imported.push(extension);
  }
  console.log(`imported ${imported.join(' ')}${skipped.length ? `; this ffmpeg cannot encode ${skipped.join(' ')}` : ''}`);
  expect(imported.length).toBeGreaterThanOrEqual(15);
}, 120000);

test('a file that is not audio is refused without a recording', async () => {
  const text = join(root, 'not-audio.mp3');
  await Bun.write(text, 'plain text, not audio');
  const before = (sqlite.query('SELECT COUNT(*) AS n FROM recordings').get() as { n: number }).n;
  // Stored as is (MP3 is native), so the vault accepts the bytes; transcription later reports the problem.
  // A convertible extension with bad content is refused at conversion instead:
  const bad = join(root, 'not-audio.amr');
  await Bun.write(bad, 'plain text, not audio');
  if (ffmpeg) await expect(importRecordingFile({ sourcePath: bad, provenance: { sourceProvider: 'upload', sourceTransport: 'upload' } })).rejects.toThrow('Could not convert');
  expect((sqlite.query('SELECT COUNT(*) AS n FROM recordings').get() as { n: number }).n).toBe(before);
});
