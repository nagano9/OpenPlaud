import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { encodeBinary, encodeReply, FrameReader, proof, sha256Hex, verifyProof, type PhoneRecording } from './protocol';
import { PhoneSession, type PacketChannel } from './session';
import { phoneFileName } from './driver';

const token = 'phone-token-for-tests';
const key = createHash('sha256').update(token).digest();
const audio = Buffer.from(Array.from({ length: 150_000 }, (_, index) => index % 251));
const recording: PhoneRecording = { id: 42, size: audio.length, name: 'Rapat 1.m4a', recordedAt: '2026-10-20T03:00:00.000Z', mime: 'audio/mp4' };

/** A phone that follows protocol.ts, as the Android app must. `corruptOnce` damages the first chunk. */
function fakePhone(options: { key?: Buffer; corruptOnce?: boolean } = {}): PacketChannel & { requests: Record<string, unknown>[] } {
  const queue: Buffer[] = [], requests: Record<string, unknown>[] = [];
  let desktopNonce = '', phoneNonce = 'cGhvbmUtbm9uY2UtMTIzNA==', authed = false, corrupt = options.corruptOnce ?? false;
  const reply = (value: unknown) => queue.push(...encodeReply(value, 23));
  return {
    requests,
    async write(packet) {
      const request = JSON.parse(Buffer.from(packet).toString('utf8'));
      requests.push(request);
      if (request.op === 'hello') { desktopNonce = request.nonce; reply({ op: 'hello', version: 1, clientId: 'client-1', device: 'Pixel 8', nonce: phoneNonce, proof: proof(options.key ?? key, 'phone', desktopNonce, phoneNonce) }); }
      else if (request.op === 'auth') { authed = verifyProof(key, 'desktop', desktopNonce, phoneNonce, request.proof); reply(authed ? { op: 'ready' } : { op: 'error', code: 'auth', message: 'Desktop proof rejected' }); }
      else if (!authed) reply({ op: 'error', code: 'auth', message: 'Not authenticated' });
      else if (request.op === 'list') reply({ op: 'list', recordings: [recording] });
      else if (request.op === 'get') {
        const slice = Buffer.from(audio.subarray(request.offset, request.offset + request.length));
        const sent = Buffer.from(slice);
        if (corrupt) { sent[0] ^= 0xff; corrupt = false; }
        queue.push(...encodeBinary(sent, 180));
        reply({ op: 'chunk', id: request.id, offset: request.offset, length: slice.length, sha256: sha256Hex(slice) });
      }
    },
    async packet() { const next = queue.shift(); if (!next) throw new Error('Bluetooth response timeout'); return next; },
  };
}

test('desktop and phone prove the same pairing key in both directions, without sending it', async () => {
  const phone = fakePhone();
  const session = new PhoneSession(phone, id => id === 'client-1' ? { key } : null);
  expect(await session.open()).toEqual({ clientId: 'client-1', device: 'Pixel 8' });
  expect(JSON.stringify(phone.requests)).not.toContain(token);
  expect(JSON.stringify(phone.requests)).not.toContain(key.toString('hex'));
  expect(await session.list()).toEqual([recording]);
});

test('a phone with another key, or an unpaired client id, is refused before any recording is read', async () => {
  const wrongKey = createHash('sha256').update('other').digest();
  await expect(new PhoneSession(fakePhone({ key: wrongKey }), () => ({ key })).open()).rejects.toThrow('could not prove');
  await expect(new PhoneSession(fakePhone(), () => null).open()).rejects.toThrow('not paired');
});

test('downloads verify every chunk and ask again for a corrupted one', async () => {
  const phone = fakePhone({ corruptOnce: true });
  const session = new PhoneSession(phone, () => ({ key }));
  await session.open();
  const progress: number[] = [];
  const bytes = await session.download(recording, { onProgress: done => progress.push(done) });
  expect(bytes.equals(audio)).toBe(true);
  expect(phone.requests.filter(request => request.op === 'get' && request.offset === 0)).toHaveLength(2);
  expect(progress.at(-1)).toBe(audio.length);
});

test('frames reassemble across notifications and reject unknown kinds', () => {
  const reader = new FrameReader();
  const frames = encodeReply({ op: 'list', recordings: [] }, 8);
  expect(frames.length).toBeGreaterThan(2);
  const results = frames.map(frame => reader.push(frame));
  expect(results.slice(0, -1).every(value => value === null)).toBe(true);
  expect(results.at(-1)).toEqual({ op: 'list', recordings: [] });
  expect(() => reader.push(Buffer.from([0x00, 1]))).toThrow('Unknown phone frame');
});

test('phone file names keep a usable extension and lose path characters', () => {
  expect(phoneFileName({ ...recording, name: 'Voice 001.amr', mime: 'audio/amr' })).toBe('Voice 001.amr');
  expect(phoneFileName({ ...recording, name: 'a/b:c', mime: 'audio/3gpp' })).toBe('a_b_c.3gp');
  expect(phoneFileName({ ...recording, name: '', mime: 'application/octet-stream' })).toBe('Phone-42.m4a');
});
