import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { RecordingSourceDriver } from '../driver';
import { phoneBridgeProfile, type PhoneRecording } from './protocol';
import { PhoneSession, type KeyLookup, type PacketChannel } from './session';
import { importRecordingFile, incomingDirectory, isImportableAudio } from '../../library/recording-library';
import { findRustBridge, isDesktopPlatform } from '../../sync/plaud-bridge';
import { PlaudTransport } from '../../sync/plaud-transport';
import type { MobileClientStore } from '../../sync/mobile-clients';

type Queue = (recording: { recordingId: string; filePath: string }) => Promise<unknown>;
export interface PhoneConnection { channel: PacketChannel; close(): Promise<void> }

/** Extension for a recording whose name has none, by the MIME type Android reports. */
const EXTENSIONS: Record<string, string> = {
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/mp4a-latm': '.m4a', 'audio/aac': '.aac', 'audio/aac-adts': '.aac', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
  'audio/ogg': '.ogg', 'application/ogg': '.ogg', 'audio/opus': '.opus', 'audio/webm': '.webm', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/vnd.wave': '.wav',
  'audio/flac': '.flac', 'audio/x-flac': '.flac', 'audio/amr': '.amr', 'audio/amr-wb': '.awb', 'audio/3gpp': '.3gp', 'audio/3gpp2': '.3g2', 'video/3gpp': '.3gp',
  'audio/x-ms-wma': '.wma', 'audio/aiff': '.aiff', 'audio/x-aiff': '.aiff', 'audio/x-caf': '.caf', 'audio/x-matroska': '.mka', 'audio/ac3': '.ac3',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'video/webm': '.webm',
};

/** The audio file name to stage: the phone's own extension when known, else one from the MIME type. */
export function phoneFileName(recording: PhoneRecording): string {
  const own = extname(recording.name).toLowerCase();
  const extension = own && isImportableAudio(own) ? own : EXTENSIONS[recording.mime.toLowerCase()] ?? '.m4a';
  const base = recording.name.replace(/\.[^.]+$/, '').replace(/[\x00-\x1f/\\:*?"<>|]/g, '_').trim().slice(0, 120) || `Phone-${recording.id}`;
  return `${base}${extension}`;
}

/** Finds the advertising phone with the bridge, then opens a write/notify channel to it. */
async function connectWithBridge(): Promise<PhoneConnection> {
  const bridge = findRustBridge();
  if (!bridge) throw new Error('The OpenPlod Bluetooth bridge is not installed. Reinstall the app, or build it with `bun run build:bridge`.');
  const scan = Bun.spawn([bridge, 'scan', ...phoneBridgeProfile()], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => scan.kill(), 60000);
  const output = await new Response(scan.stdout).text().finally(() => clearTimeout(timer));
  const probe = JSON.parse(output || '{}') as { detected?: boolean; identifier?: string; connectionVerified?: boolean; detail?: string };
  if (!probe.detected || !probe.identifier) throw new Error('No phone found. Open OpenPlod on the phone, turn on “Sync over Bluetooth”, and keep it near this computer.');
  const transport = new PlaudTransport(probe.identifier, bridge, undefined, phoneBridgeProfile());
  await transport.wait(event => event.event === 'ready', 60000);
  return { channel: transport, close: () => transport.close() };
}

/**
 * A paired Android phone as a Bluetooth recording source. The phone must be paired with this
 * desktop (Android page) and have “Sync over Bluetooth” on; recordings are copied, never
 * removed from the phone, and identified as `${clientId}:${recordingId}`.
 */
export function phoneDriver(deps: {
  clients: () => MobileClientStore; queue: Queue; connect?: () => Promise<PhoneConnection>; bridgeAvailable?: () => boolean;
  /** Which of these `clientId:recordingId` source ids the vault already holds. */
  inVault?: (sourceIds: string[]) => string[];
}): RecordingSourceDriver {
  const connect = deps.connect ?? connectWithBridge;
  const bridgeAvailable = deps.bridgeAvailable ?? (() => isDesktopPlatform() && findRustBridge() !== null);
  const keys: KeyLookup = clientId => deps.clients().bluetoothKey(clientId);
  let active: Promise<unknown> = Promise.resolve();

  /** One Bluetooth conversation at a time; a phone serves a single central. */
  const withSession = <T>(work: (session: PhoneSession) => Promise<T>): Promise<T> => {
    const run = active.catch(() => undefined).then(async () => {
      const connection = await connect();
      const session = new PhoneSession(connection.channel, keys);
      try { await session.open(); return await work(session); }
      finally { await session.close(); await connection.close(); }
    });
    active = run;
    return run;
  };

  return {
    id: 'phone', label: 'Android phone', provider: 'phone',
    notConfiguredMessage: 'Pair an Android phone on the Android page first. Bluetooth sync also needs the OpenPlod Bluetooth bridge.',
    configured: () => bridgeAvailable() && deps.clients().bluetoothClients().length > 0,
    list: () => withSession(async session => {
      const recordings = await session.list();
      // Recordings this vault already holds (from an earlier sync, before a reinstall, or over Wi-Fi)
      // are confirmed to the phone so it can show them as on the desktop.
      const held = new Set(deps.inVault?.(recordings.map(recording => `${session.clientId}:${recording.id}`)) ?? []);
      await session.acknowledge(recordings.filter(recording => held.has(`${session.clientId}:${recording.id}`)).map(recording => recording.id));
      return { serial: session.clientId, checkedAt: new Date().toISOString(), sessions: recordings.map(recording => ({ sessionId: recording.id, size: recording.size })) };
    }),
    import: sessionId => withSession(async session => {
      const recording = (await session.list()).find(item => item.id === sessionId);
      if (!recording) throw new Error('The recording is no longer on the phone.');
      const bytes = await session.download(recording);
      await mkdir(incomingDirectory(), { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(incomingDirectory(), 'phone-'));
      try {
        const name = phoneFileName(recording);
        const received = join(directory, name);
        await writeFile(received, bytes, { mode: 0o600 });
        // The import converts formats such as Opus or AMR and keeps the file as the phone sent it.
        const result = await importRecordingFile({
          sourcePath: received, originalFilename: name,
          provenance: { sourceProvider: 'phone', sourceTransport: 'ble', sourceRecordingId: `${session.clientId}:${recording.id}`, recordedAt: recording.recordedAt },
        });
        if (result.added) await deps.queue({ recordingId: result.recording.id, filePath: result.recording.filePath });
        deps.clients().markSynced(session.clientId);
        await session.acknowledge([recording.id]);
        return result;
      } finally { await rm(directory, { recursive: true, force: true }); }
    }),
  };
}
