import type { ImportedRecording, RecordingProvenance } from '../library/recording-library';

/**
 * A hardware source of recordings reached over Bluetooth (Plaud, a paired phone, a future
 * recorder). Drivers own their protocol; the auto-import loop, deduplication and the API
 * are shared. A recording is identified by `${listing.serial}:${session.sessionId}`, which is
 * what the driver stores as `sourceRecordingId` with its `provider`.
 */
export interface DeviceSession { sessionId: number; size: number }
export interface DeviceListing { serial: string; checkedAt: string; sessions: DeviceSession[] }
export interface DeviceImportResult { added: boolean; recording: ImportedRecording }

export interface RecordingSourceDriver {
  /** Stable id used in settings keys and URLs, e.g. `plaud`, `phone`. */
  id: string;
  label: string;
  provider: RecordingProvenance['sourceProvider'];
  /** Whether this computer holds what the driver needs to connect (identity, pairing). */
  configured(): boolean;
  /** Shown when automatic import is switched on before the driver is configured. */
  notConfiguredMessage: string;
  list(): Promise<DeviceListing>;
  import(sessionId: number): Promise<DeviceImportResult>;
}

export const sourceRecordingId = (listing: Pick<DeviceListing, 'serial'>, session: Pick<DeviceSession, 'sessionId'>) => `${listing.serial}:${session.sessionId}`;
