import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'openplod.audioInput'

function stored(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? '' } catch { return '' }
}

/**
 * The microphones this browser can record from, including paired Bluetooth headsets,
 * and the one the person chose last ('' = system default). Labels are only exposed
 * after microphone permission, so call `refreshInputs` once a stream has started.
 */
export function useAudioInputs() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [inputId, setInputId] = useState(stored)

  const refreshInputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
    setInputs(devices)
    // A remembered device that is gone falls back to the default without forgetting the choice.
    setInputId(current => current && devices.length && !devices.some(device => device.deviceId === current) ? '' : current)
  }, [])

  useEffect(() => {
    void refreshInputs()
    const devices = navigator.mediaDevices
    devices?.addEventListener?.('devicechange', refreshInputs)
    return () => devices?.removeEventListener?.('devicechange', refreshInputs)
  }, [refreshInputs])

  const chooseInput = useCallback((deviceId: string) => {
    setInputId(deviceId)
    try { if (deviceId) localStorage.setItem(STORAGE_KEY, deviceId); else localStorage.removeItem(STORAGE_KEY) } catch { /* choice lasts for this session */ }
  }, [])

  return { inputs, inputId, chooseInput, refreshInputs }
}
