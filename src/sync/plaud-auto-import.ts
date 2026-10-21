import type { Database } from 'bun:sqlite';
import { DeviceAutoImport } from '../devices/auto-import';
import type { RecordingSourceDriver } from '../devices/driver';
import { directPlaudConfigured, importDirectPlaudRecording, readDirectPlaudRecordings } from './plaud-direct';

type PlaudAdapter = Pick<RecordingSourceDriver, 'configured' | 'list' | 'import'>;

/** The Plaud Note Pro as a Bluetooth recording-source driver. */
export function plaudDriver(adapter: PlaudAdapter = { configured: directPlaudConfigured, list: readDirectPlaudRecordings, import: importDirectPlaudRecording }): RecordingSourceDriver {
  return { id: 'plaud', label: 'Plaud Note Pro', provider: 'plaud', notConfiguredMessage: 'Authorize this Note Pro on the Mac first.', ...adapter };
}

/** Plaud automatic import; keeps its original `directPlaudAutoImport` setting. */
export class PlaudAutoImport extends DeviceAutoImport {
  constructor(database: Database, adapter?: PlaudAdapter) {
    super(database, plaudDriver(adapter), 'directPlaudAutoImport');
  }
}
