import { expect, test } from 'bun:test';
import { sampleTranscript } from './transcript-sample';
import { contentTokens, ftsOrQuery } from './text';

test('short transcripts stay intact; long samples include beginning, middle and final decision within budget', () => {
  expect(sampleTranscript('Rapat selesai.')).toBe('Rapat selesai.');
  const text = 'PEMBUKAAN ' + 'a'.repeat(30000) + 'TENGAH ' + 'b'.repeat(30000) + 'KEPUTUSAN FINAL: proyek ditunda.';
  const sampled = sampleTranscript(text);
  expect(sampled.length).toBeLessThanOrEqual(24000);
  expect(sampled).toContain('PEMBUKAAN');
  expect(sampled).toContain('TENGAH');
  expect(sampled).toContain('KEPUTUSAN FINAL: proyek ditunda.');
  expect(sampled).toContain('[... omitted transcript ...]');
  expect(sampleTranscript('😀'.repeat(30000)).isWellFormed()).toBe(true);
});

test('Indonesian search removes filler but retains domain terms and negation', () => {
  expect(contentTokens('yang dan untuk proyek belum selesai')).toEqual(['proyek', 'belum', 'selesai']);
  expect(ftsOrQuery('Apa keputusan untuk proyek yang belum selesai?')).toContain('"keputusan"*');
  expect(ftsOrQuery('dan yang untuk')).toBe('');
  expect(contentTokens('risiko tidak disetujui')).toEqual(['risiko', 'tidak', 'disetujui']);
});
