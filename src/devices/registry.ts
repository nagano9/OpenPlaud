import type { DeviceAutoImport } from './auto-import';

/** Every Bluetooth recording source with automatic import, polled together. */
export class DeviceRegistry {
  private sources = new Map<string, DeviceAutoImport>();
  register(source: DeviceAutoImport) { this.sources.set(source.driver.id, source); return source; }
  get(id: string) { return this.sources.get(id) ?? null; }
  list() { return [...this.sources.values()].map(source => source.status()); }
  /** Sources are polled one after another: they may share one Bluetooth radio. */
  async tick() { for (const source of this.sources.values()) await source.tick(); }
}
