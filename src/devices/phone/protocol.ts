import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * "OpenPlod Phone": the Bluetooth LE protocol between this desktop (GATT central, through the
 * Rust bridge) and the OpenPlod Android app (GATT peripheral). The phone exposes one service
 * with a write characteristic for requests and a notify characteristic for replies.
 *
 * Requests are one UTF-8 JSON object per write. Replies are notifications, each starting with
 * a kind byte: `J` (JSON fragment, more follow), `j` (last JSON fragment) or `B` (binary audio
 * bytes for the current `get`). A `get` streams `B` frames and ends with a `j` reply carrying
 * the SHA-256 of the audio bytes, so a dropped notification is detected and retried.
 *
 * Both sides prove they hold the pairing credential: the key is SHA-256 of the phone's token,
 * and each side returns an HMAC over both nonces, so neither the token nor a replayable proof
 * crosses the radio. The radio link itself is not bonded (Windows does not pair a phone's
 * rotating LE address on its own), so everything private is sealed by the app instead: the
 * recording list and every audio chunk are AES-256-GCM with a per-session key derived (HKDF)
 * from the pairing key and both nonces. Keep in sync with `PhoneBleProtocol.kt`.
 */
export const PHONE_SERVICE_UUID = '7f1e0001-5c6a-4b8e-9d1a-0a9e0f9c4f10';
export const PHONE_NOTIFY_UUID = '7f1e0002-5c6a-4b8e-9d1a-0a9e0f9c4f10';
export const PHONE_WRITE_UUID = '7f1e0003-5c6a-4b8e-9d1a-0a9e0f9c4f10';
export const PHONE_PROTOCOL_VERSION = 1;
/** Bytes asked for per `get`; small enough to retry cheaply after a dropped notification. */
export const PHONE_CHUNK_BYTES = 64 * 1024;

export const FRAME_JSON_MORE = 0x4a; // 'J'
export const FRAME_JSON_LAST = 0x6a; // 'j'
export const FRAME_BINARY = 0x42; // 'B'

/** Bridge arguments that select the OpenPlod Phone GATT profile. */
export const phoneBridgeProfile = () => ['--service', PHONE_SERVICE_UUID, '--notify', PHONE_NOTIFY_UUID, '--write', PHONE_WRITE_UUID, '--name-hint', 'openplod'];

export const nonce = () => randomBytes(16).toString('base64');

/** `role` binds a proof to its direction, so the phone's proof can never be replayed as the desktop's. */
export function proof(key: Buffer, role: 'phone' | 'desktop', desktopNonce: string, phoneNonce: string): string {
  return createHmac('sha256', key).update(`openplod-phone/v1|${role}|${desktopNonce}|${phoneNonce}`).digest('base64');
}

export function verifyProof(key: Buffer, role: 'phone' | 'desktop', desktopNonce: string, phoneNonce: string, supplied: string): boolean {
  const expected = Buffer.from(proof(key, role, desktopNonce, phoneNonce), 'base64');
  const actual = Buffer.from(supplied, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The per-session AES key; new nonces on every connection mean a new key every session. */
export function sessionKey(key: Buffer, desktopNonce: string, phoneNonce: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.from(`${desktopNonce}|${phoneNonce}`, 'utf8'), Buffer.from('openplod-phone/v1 session', 'utf8'), 32));
}

/** `iv(12) | ciphertext | tag(16)`. */
export function seal(key: Buffer, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function open(key: Buffer, sealed: Uint8Array): Buffer {
  if (sealed.length < 28) throw new Error('Sealed phone data is too short');
  const bytes = Buffer.from(sealed);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
}

export const helloReply = z.object({
  op: z.literal('hello'), version: z.number().int(), clientId: z.string().min(1).max(64),
  device: z.string().max(120), nonce: z.string().min(16).max(64), proof: z.string().min(16).max(128),
}).strict();
export const readyReply = z.object({ op: z.literal('ready') }).strict();
export const phoneRecording = z.object({
  id: z.number().int().nonnegative().max(2 ** 53 - 1), size: z.number().int().nonnegative(),
  name: z.string().max(240), recordedAt: z.string().max(40).nullable(), mime: z.string().max(80),
}).strict();
export type PhoneRecording = z.infer<typeof phoneRecording>;
/** `sealed` is the base64 `seal()` of the JSON array of recordings. */
export const listReply = z.object({ op: z.literal('list'), sealed: z.string().min(1).max(4 * 1024 * 1024) }).strict();
export const recordingList = z.array(phoneRecording).max(5000);
export const chunkReply = z.object({ op: z.literal('chunk'), id: z.number().int(), offset: z.number().int().nonnegative(), length: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const errorReply = z.object({ op: z.literal('error'), code: z.string().max(64), message: z.string().max(500) }).strict();

/** Reassembles notifications into JSON replies and audio bytes. */
export class FrameReader {
  private json: Buffer[] = [];
  private binary: Buffer[] = [];
  /** Returns a completed JSON reply, or null while more frames are needed. */
  push(frame: Buffer): unknown | null {
    if (frame.length === 0) throw new Error('Empty phone frame');
    const kind = frame[0], body = frame.subarray(1);
    if (kind === FRAME_BINARY) { this.binary.push(Buffer.from(body)); return null; }
    if (kind !== FRAME_JSON_MORE && kind !== FRAME_JSON_LAST) throw new Error(`Unknown phone frame kind ${kind}`);
    this.json.push(Buffer.from(body));
    if (this.json.reduce((total, part) => total + part.length, 0) > 2 * 1024 * 1024) throw new Error('Phone reply is too large');
    if (kind === FRAME_JSON_MORE) return null;
    const text = Buffer.concat(this.json).toString('utf8'); this.json = [];
    try { return JSON.parse(text); } catch { throw new Error('Phone sent invalid JSON'); }
  }
  /** Audio bytes received since the last call. */
  takeBinary(): Buffer { const bytes = Buffer.concat(this.binary); this.binary = []; return bytes; }
}

/** Splits a reply into notification frames (used by tests and as the reference for the phone side). */
export function encodeReply(value: unknown, frameBytes = 180): Buffer[] {
  const body = Buffer.from(JSON.stringify(value), 'utf8'), frames: Buffer[] = [];
  for (let offset = 0; offset < body.length || frames.length === 0; offset += frameBytes - 1) {
    const part = body.subarray(offset, offset + frameBytes - 1);
    frames.push(Buffer.concat([Buffer.from([offset + frameBytes - 1 >= body.length ? FRAME_JSON_LAST : FRAME_JSON_MORE]), part]));
  }
  return frames;
}

export function encodeBinary(bytes: Uint8Array, frameBytes = 180): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += frameBytes - 1) frames.push(Buffer.concat([Buffer.from([FRAME_BINARY]), bytes.subarray(offset, offset + frameBytes - 1)]));
  return frames;
}
