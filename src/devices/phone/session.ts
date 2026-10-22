import { chunkReply, errorReply, FrameReader, helloReply, listReply, nonce, open, PHONE_CHUNK_BYTES, PHONE_PROTOCOL_VERSION, proof, readyReply, recordingList, sessionKey, sha256Hex, verifyProof, type PhoneRecording } from './protocol';

/** The part of the Bluetooth bridge transport a phone session uses (`PlaudTransport` fits). */
export interface PacketChannel {
  write(packet: Uint8Array): Promise<void>;
  packet(timeoutMs?: number): Promise<Buffer>;
}
export type KeyLookup = (clientId: string) => { key: Buffer } | null;

const REPLY_TIMEOUT_MS = 15000;
const CHUNK_ATTEMPTS = 3;

/** One authenticated conversation with a paired phone over Bluetooth (see `protocol.ts`). */
export class PhoneSession {
  private reader = new FrameReader();
  private key: Buffer | null = null;
  clientId = '';
  device = '';
  constructor(private channel: PacketChannel, private keys: KeyLookup) {}

  private async send(request: Record<string, unknown>) {
    await this.channel.write(Buffer.from(JSON.stringify(request), 'utf8'));
  }

  private async reply(timeoutMs = REPLY_TIMEOUT_MS): Promise<unknown> {
    for (;;) {
      const message = this.reader.push(await this.channel.packet(timeoutMs));
      if (message === null) continue;
      const failure = errorReply.safeParse(message);
      if (failure.success) throw new Error(`Phone: ${failure.data.message}`);
      return message;
    }
  }

  /** Mutual proof of the pairing credential. Throws unless this phone is paired with this desktop. */
  async open() {
    const desktopNonce = nonce();
    await this.send({ op: 'hello', version: PHONE_PROTOCOL_VERSION, nonce: desktopNonce });
    const hello = helloReply.safeParse(await this.reply());
    if (!hello.success) throw new Error('The phone answered with an unexpected greeting. Update OpenPlod on the phone.');
    if (hello.data.version !== PHONE_PROTOCOL_VERSION) throw new Error(`The phone speaks protocol ${hello.data.version}; this desktop speaks ${PHONE_PROTOCOL_VERSION}. Update both apps.`);
    const credential = this.keys(hello.data.clientId);
    if (!credential) throw new Error('This phone is not paired with this desktop, or its pairing was revoked. Pair it again on the Android page.');
    if (!verifyProof(credential.key, 'phone', desktopNonce, hello.data.nonce, hello.data.proof)) throw new Error('The phone could not prove its pairing. Pair it again on the Android page.');
    await this.send({ op: 'auth', proof: proof(credential.key, 'desktop', desktopNonce, hello.data.nonce) });
    if (!readyReply.safeParse(await this.reply()).success) throw new Error('The phone did not accept this desktop.');
    this.key = sessionKey(credential.key, desktopNonce, hello.data.nonce);
    this.clientId = hello.data.clientId; this.device = hello.data.device;
    return { clientId: this.clientId, device: this.device };
  }

  async list(): Promise<PhoneRecording[]> {
    await this.send({ op: 'list' });
    const reply = listReply.safeParse(await this.reply());
    if (!reply.success || !this.key) throw new Error('The phone sent an invalid recording list.');
    let recordings;
    try { recordings = recordingList.safeParse(JSON.parse(open(this.key, Buffer.from(reply.data.sealed, 'base64')).toString('utf8'))); }
    catch { throw new Error('The phone’s recording list could not be decrypted. Pair the phone again.'); }
    if (!recordings.success) throw new Error('The phone sent an invalid recording list.');
    return recordings.data;
  }

  /** Decrypts one sealed chunk; a damaged one returns null so it is asked for again. */
  private unseal(bytes: Buffer): Buffer | null {
    try { return open(this.key!, bytes); } catch { return null; }
  }

  /** Downloads a recording in checksummed chunks; a corrupted or short chunk is asked for again. */
  async download(recording: PhoneRecording, options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<Buffer> {
    if (!this.key) throw new Error('Open the phone session first.');
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < recording.size) {
      options.signal?.throwIfAborted();
      const length = Math.min(PHONE_CHUNK_BYTES, recording.size - offset);
      let received: Buffer | null = null;
      for (let attempt = 1; attempt <= CHUNK_ATTEMPTS && !received; attempt++) {
        this.reader.takeBinary();
        await this.send({ op: 'get', id: recording.id, offset, length });
        const reply = chunkReply.safeParse(await this.reply(60000));
        const bytes = this.unseal(this.reader.takeBinary());
        if (bytes && reply.success && reply.data.id === recording.id && reply.data.offset === offset && reply.data.length === bytes.length && bytes.length === length && reply.data.sha256 === sha256Hex(bytes)) received = bytes;
      }
      if (!received) throw new Error(`Bluetooth transfer of ${recording.name} kept failing at ${offset} bytes. Move the phone closer and retry.`);
      parts.push(received); offset += received.length;
      options.onProgress?.(offset, recording.size);
    }
    return Buffer.concat(parts);
  }

  async close() { await this.send({ op: 'bye' }).catch(() => undefined); }
}
