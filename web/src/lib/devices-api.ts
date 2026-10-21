import { apiUrl, authenticatedHeaders } from './runtime'

/** Client for `/api/devices`: Bluetooth recording sources and the Bluetooth file inbox. Types mirror `src/devices/*`. */
export interface DeviceSourceStatus {
  driver: string; label: string; configured: boolean; enabled: boolean; running: boolean
  lastChecked: string | null; error: string | null; events: { id: number; recordingId: string; createdAt: string }[]
}
export interface InboxStatus {
  enabled: boolean; watching: boolean; path: string
  events: { file: string; recordingId: string | null; error: string | null; at: string }[]
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(`/devices${path}`), { ...init, headers: authenticatedHeaders({ 'Content-Type': 'application/json' }) })
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T; error?: string } | null
  if (!response.ok || !payload?.success) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload.data as T
}

export const devicesApi = {
  list: () => request<{ sources: DeviceSourceStatus[]; inbox: InboxStatus }>(''),
  setAutoImport: (driver: string, enabled: boolean) => request<DeviceSourceStatus>(`/${encodeURIComponent(driver)}/auto-import`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  configureInbox: (input: { enabled?: boolean; path?: string }) => request<InboxStatus>('/bluetooth-inbox', { method: 'PUT', body: JSON.stringify(input) }),
}
