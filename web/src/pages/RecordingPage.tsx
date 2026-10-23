import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, FileAudio, Loader2, Mic, Pause, Play, RotateCcw, Square, UploadCloud, WifiOff, X } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { PlaudImportDialog } from '@/components/PlaudImportDialog'
import { Input } from '@/components/ui/input'
import { getRuntime } from '@/lib/runtime'
import { cleanupStoredCaptures, latestPendingCapture, removePendingCapture, savePendingCapture, updateCapture, type PendingCapture } from '@/lib/recording-outbox'
import { deliverCapture } from '@/lib/outbox-delivery'
import { OutboxPanel } from '@/components/OutboxPanel'
import { formatDuration } from '@/lib/utils'
import { completePendingAndroidShare, readPendingAndroidShare } from '@/lib/android-share'
import { formatDate, t } from '@/i18n'
import { useAudioInputs } from '@/lib/audio-inputs'
import { hasPhoneLibrary, phoneLibrary, saveToPhone } from '@/lib/phone-library'

type CaptureState = 'idle' | 'requesting' | 'recording' | 'paused' | 'review' | 'uploading' | 'stored'

const WAVE_BAR_COUNT = 48

export function RecordingPage() {
  const navigate = useNavigate()
  const runtime = getRuntime()
  const [state, setState] = useState<CaptureState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [capture, setCapture] = useState<PendingCapture | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [title, setTitle] = useState(defaultTitle)
  const [context, setContext] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [outboxVersion, setOutboxVersion] = useState(0)
  const [storedText, setStoredText] = useState('')
  const [autoSend, setAutoSend] = useState(false)
  useEffect(() => { if (hasPhoneLibrary()) phoneLibrary.list().then(library => setAutoSend(library.autoSend)).catch(() => undefined) }, [])
  const { inputs, inputId, chooseInput, refreshInputs } = useAudioInputs()
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const animationRef = useRef<number | null>(null)
  const activeStartedAtRef = useRef(0)
  const accumulatedMsRef = useRef(0)
  const recordedAtRef = useRef('')

  const releaseMicrophone = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
    animationRef.current = null
    void audioContextRef.current?.close()
    audioContextRef.current = null
    analyserRef.current = null
  }, [])

  useEffect(() => {
    const restoreCapture = async () => {
      const shared = await readPendingAndroidShare()
      const pending = shared ?? await latestPendingCapture()
      if (!pending) return
      if (shared) {
        await savePendingCapture(shared)
        if (shared.nativeShareId) completePendingAndroidShare(shared.nativeShareId)
      }
      setCapture(pending)
      setTitle(pending.title)
      setContext(pending.context)
      setElapsedMs(pending.durationMs)
      setAudioUrl(URL.createObjectURL(pending.blob))
      setState('review')
    }
    void restoreCapture().catch(importError => {
      setError(importError instanceof Error ? importError.message : t('The shared recording could not be opened.'))
    })
  }, [])

  useEffect(() => {
    if (state !== 'recording') return
    const update = () => setElapsedMs(accumulatedMsRef.current + performance.now() - activeStartedAtRef.current)
    update()
    const timer = window.setInterval(update, 200)
    return () => window.clearInterval(timer)
  }, [state])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (state !== 'recording' && state !== 'paused') return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [state])

  useEffect(() => () => {
    releaseMicrophone()
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }, [audioUrl, releaseMicrophone])

  const drawWaveform = useCallback(function draw() {
    const canvas = canvasRef.current
    const analyser = analyserRef.current
    if (!canvas || !analyser) return
    const ratio = window.devicePixelRatio || 1
    const width = Math.max(1, canvas.clientWidth)
    const height = Math.max(1, canvas.clientHeight)
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio
      canvas.height = height * ratio
    }
    const context2d = canvas.getContext('2d')
    if (!context2d) return
    context2d.setTransform(ratio, 0, 0, ratio, 0, 0)
    context2d.clearRect(0, 0, width, height)
    const samples = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(samples)
    const gap = 4
    const barWidth = Math.max(2, (width - gap * (WAVE_BAR_COUNT - 1)) / WAVE_BAR_COUNT)
    const step = Math.max(1, Math.floor(samples.length / WAVE_BAR_COUNT))
    context2d.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
    for (let index = 0; index < WAVE_BAR_COUNT; index += 1) {
      const strength = samples[index * step] / 255
      const barHeight = Math.max(4, strength * height * 0.9)
      const x = index * (barWidth + gap)
      const y = (height - barHeight) / 2
      context2d.beginPath()
      context2d.roundRect(x, y, barWidth, barHeight, barWidth / 2)
      context2d.fill()
    }
    animationRef.current = requestAnimationFrame(draw)
  }, [])

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(t('Microphone recording is not supported on this device.'))
      return
    }
    setState('requesting')
    setError('')
    try {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: inputId ? { ...audio, deviceId: { exact: inputId } } : audio })
      } catch (failure) {
        // A chosen headset that was switched off or unpaired: record with the default microphone instead.
        if (!inputId || (failure as DOMException).name !== 'OverconstrainedError' && (failure as DOMException).name !== 'NotFoundError') throw failure
        chooseInput('')
        stream = await navigator.mediaDevices.getUserMedia({ audio })
      }
      void refreshInputs()
      streamRef.current = stream
      const mimeType = preferredMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      chunksRef.current = []
      accumulatedMsRef.current = 0
      activeStartedAtRef.current = monotonicNow()
      recordedAtRef.current = new Date().toISOString()
      const audioContext = new AudioContext()
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.78
      audioContext.createMediaStreamSource(stream).connect(analyser)
      audioContextRef.current = audioContext
      analyserRef.current = analyser
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => void finalizeCapture(recorder.mimeType || mimeType || 'audio/webm')
      recorder.start(1000)
      setElapsedMs(0)
      setState('recording')
      animationRef.current = requestAnimationFrame(drawWaveform)
    } catch (permissionError) {
      releaseMicrophone()
      setState('idle')
      setError(permissionError instanceof Error && permissionError.name === 'NotAllowedError'
        ? t('Microphone access is off. Allow OpenPlod in your system settings, then try again.')
        : t('The microphone could not be started.'))
    }
  }

  const pauseRecording = () => {
    const recorder = recorderRef.current
    if (!recorder) return
    if (state === 'recording') {
      recorder.pause()
      accumulatedMsRef.current += monotonicNow() - activeStartedAtRef.current
      setElapsedMs(accumulatedMsRef.current)
      setState('paused')
    } else if (state === 'paused') {
      recorder.resume()
      activeStartedAtRef.current = monotonicNow()
      setState('recording')
    }
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    if (state === 'recording') accumulatedMsRef.current += monotonicNow() - activeStartedAtRef.current
    setElapsedMs(accumulatedMsRef.current)
    recorder.stop()
    releaseMicrophone()
  }

  const finalizeCapture = async (mimeType: string) => {
    const blob = new Blob(chunksRef.current, { type: mimeType })
    const pending: PendingCapture = {
      id: crypto.randomUUID(),
      blob,
      filename: `${slugify(title)}.${extensionForMimeType(mimeType)}`,
      title,
      context,
      recordedAt: recordedAtRef.current || new Date().toISOString(),
      durationMs: accumulatedMsRef.current,
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setCapture(pending)
    setAudioUrl(URL.createObjectURL(blob))
    setState('review')
    try {
      await savePendingCapture(pending)
    } catch {
      setError(t('The recording is ready, but an offline copy could not be saved. Export or store it before leaving.'))
    }
  }

  const upload = async () => {
    if (!capture) return
    setState('uploading')
    setError('')
    setProgress(null)
    const extension = extensionForMimeType(capture.blob.type)
    const filename = `${slugify(title)}.${extension}`
    try {
      // Keep the outbox row (transfer ID, retry history) and only refresh the edited fields.
      let pending = await updateCapture(capture.id, { title, context, filename })
      if (!pending) {
        pending = { ...capture, title, context, filename }
        await savePendingCapture(pending)
      }
      const acknowledgement = await deliverCapture(pending, runtime.mode === 'mobile', (sent, total) => setProgress(total ? sent / total : null))
      // The local copy stays until the configured retention window; removal requires the verified acknowledgement.
      await cleanupStoredCaptures().catch(() => 0)
      setState('stored')
      window.setTimeout(() => navigate(`/recording/${acknowledgement.recordingId}`, { replace: true }), 550)
    } catch (uploadError) {
      setState('review')
      setOutboxVersion(v => v + 1)
      setError(uploadError instanceof Error
        ? t('Local recording retained in the outbox. {error}', { error: uploadError.message })
        : t('Local recording retained in the outbox. Check the vault connection and retry.'))
    } finally {
      setProgress(null)
    }
  }

  /**
   * Android: the recording is kept permanently on this phone first. Sending it to the computer is a
   * choice; when the vault is not reachable now, Bluetooth sync delivers it later.
   */
  const keepOnPhone = async (send: boolean) => {
    if (!capture) return
    setState('uploading'); setError(''); setProgress(null)
    const filename = `${slugify(title)}.${extensionForMimeType(capture.blob.type)}`
    try {
      await saveToPhone(capture.blob, filename, send, (done, total) => setProgress(total ? done / total : null))
      let delivered = false
      if (send && runtime.paired) {
        const pending = (await updateCapture(capture.id, { title, context, filename }).catch(() => null)) ?? { ...capture, title, context, filename }
        delivered = await deliverCapture(pending, true).then(() => true, () => false)
      }
      // The phone library now holds the recording, so the temporary browser copy is not needed.
      await removePendingCapture(capture.id).catch(() => undefined)
      setStoredText(!send ? t('Saved on this phone. Send it to the computer any time from Recordings on this phone.')
        : delivered ? t('Saved on this phone and sent to the computer.')
          : t('Saved on this phone. It will be sent to the computer over Bluetooth.'))
      // No automatic jump to the phone list: a late tap there could land on "Send to computer".
      setState('stored')
    } catch (saveError) {
      setState('review')
      setError(t('Could not save on this phone: {error}. The recording is still in the outbox.', { error: saveError instanceof Error ? saveError.message : String(saveError) }))
    } finally { setProgress(null) }
  }

  const discard = async () => {
    if (capture && !window.confirm(t('Discard this local recording?'))) return
    if (capture) await removePendingCapture(capture.id).catch(() => undefined)
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setCapture(null)
    setAudioUrl('')
    setElapsedMs(0)
    setError('')
    setTitle(defaultTitle())
    setContext('')
    setState('idle')
  }

  const goBack = () => {
    if ((state === 'recording' || state === 'paused') && !window.confirm(t('Stop and leave this recording?'))) return
    if (state === 'recording' || state === 'paused') stopRecording()
    navigate('/')
  }

  const isCapturing = state === 'recording' || state === 'paused'

  return (
    <div className="capture-page">
      <header className="capture-header">
        <Button variant="ghost" size="icon" onClick={goBack} aria-label={t('Back to library')} title={t('Back to library')}><ArrowLeft /></Button>
        <span>{capture?.sourceProvider === 'plaud' ? t('Import Plaud recording') : state === 'review' || state === 'uploading' ? t('Review recording') : t('New recording')}</span>
        {state === 'review' ? <Button variant="ghost" size="icon" onClick={() => void discard()} aria-label={t('Discard recording')} title={t('Discard recording')}><X /></Button> : <span className="h-10 w-10" />}
      </header>

      <main className="capture-stage">
        {state === 'idle' || state === 'requesting' ? (
          <div className="capture-ready">
            <div className="capture-orbit"><Mic aria-hidden="true" /></div>
            <div>
              <h1>{t('New recording')}</h1>
            </div>
            <button className="record-trigger" type="button" onClick={() => void startRecording()} disabled={state === 'requesting'} aria-label={t('Start recording')}>
              {state === 'requesting' ? <Loader2 className="animate-spin" /> : <Mic />}
            </button>
            {inputs.length > 1 && <label className="capture-input">{t('Microphone')}
              <select value={inputId} disabled={state === 'requesting'} onChange={event => chooseInput(event.target.value)}>
                <option value="">{t('System default')}</option>
                {inputs.map((input, index) => <option key={input.deviceId} value={input.deviceId}>{input.label || t('Microphone {number}', { number: index + 1 })}</option>)}
              </select>
              <small>{t('Bluetooth headsets and earbuds appear here once paired with this device.')}</small>
            </label>}
            <div className="capture-import-option"><span>{t('or')}</span><PlaudImportDialog variant="outline" /></div>
            <OutboxPanel fromMobile={runtime.mode === 'mobile'} refreshKey={outboxVersion} />
          </div>
        ) : isCapturing ? (
          <div className="capture-live">
            <div className="capture-state"><span className={state === 'paused' ? 'paused' : ''} />{state === 'paused' ? t('Paused') : t('Recording')}</div>
            <div className="capture-timer">{formatDuration(elapsedMs / 1000)}</div>
            <canvas ref={canvasRef} className={state === 'paused' ? 'capture-wave paused' : 'capture-wave'} aria-hidden="true" />
            <div className="capture-controls">
              <button type="button" className="capture-control secondary" onClick={pauseRecording} aria-label={state === 'paused' ? t('Resume recording') : t('Pause recording')}>
                {state === 'paused' ? <Play /> : <Pause />}
              </button>
              <button type="button" className="capture-control stop" onClick={stopRecording} aria-label={t('Stop recording')}><Square /></button>
            </div>
          </div>
        ) : state === 'stored' ? (
          <div className="capture-stored" role="status"><span><Check /></span>
            {storedText ? <><h1>{t('Saved on this phone')}</h1><p>{storedText}</p><Button variant="outline" onClick={() => navigate('/devices', { replace: true })}>{t('Recordings on this phone')}</Button></> :<><h1>{t('Stored in your vault')}</h1><p>{t('Opening the recording...')}</p></>}
          </div>
        ) : (
          <div className="capture-review">
            {capture?.sourceProvider === 'plaud' && <div className="capture-source"><FileAudio />{t('Plaud audio received')}</div>}
            <div className="capture-review-time">{formatDuration(elapsedMs / 1000)}</div>
            {audioUrl && <audio className="capture-audio" src={audioUrl} controls preload="metadata" />}
            <div className="capture-fields">
              <label>{t('Title')}<Input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} /></label>
              <label>{t('Context')}<textarea value={context} onChange={event => setContext(event.target.value)} placeholder={t('Meeting, idea, voice note...')} rows={3} /></label>
            </div>
            {hasPhoneLibrary() && capture?.sourceProvider !== 'plaud' ? <>
              {/* On the phone, saving keeps the recording here; sending to the computer is a choice. */}
              <Button size="lg" className="capture-upload" onClick={() => void keepOnPhone(autoSend)} disabled={state === 'uploading' || !title.trim()}>
                {state === 'uploading' ? <Loader2 className="animate-spin" /> : <Check />}
                {state === 'uploading' ? progress !== null && progress < 1 ? t('Saving {percent}%...', { percent: Math.round(progress * 100) }) : t('Saving on this phone...') : autoSend ? t('Save on phone and send') : t('Save on this phone')}
              </Button>
              {!autoSend && <Button variant="outline" onClick={() => void keepOnPhone(true)} disabled={state === 'uploading' || !title.trim()}><UploadCloud />{t('Save and send to computer')}</Button>}
              <p className="capture-note">{autoSend ? t('New recordings are sent to the computer automatically. Change this in Recordings on this phone.') : t('Recordings stay on this phone unless you send them.')}</p>
            </> : <Button size="lg" className="capture-upload" onClick={() => void upload()} disabled={state === 'uploading' || !title.trim()}>
              {state === 'uploading' ? <Loader2 className="animate-spin" /> : <UploadCloud />}
              {state === 'uploading' ? progress !== null && progress < 1 ? t('Sending {percent}%...', { percent: Math.round(progress * 100) }) : t('Storing in vault...') : t('Store in desktop vault')}
            </Button>}
            {error && <div className="capture-offline" role="alert"><WifiOff /><span>{error}</span></div>}
            <Button variant="ghost" onClick={() => void discard()} disabled={state === 'uploading'}><RotateCcw />{t('Record again')}</Button>
          </div>
        )}
        {error && state === 'idle' && <div className="capture-error" role="alert">{error}</div>}
      </main>
    </div>
  )
}

function preferredMimeType(): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find(type => MediaRecorder.isTypeSupported(type)) ?? ''
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('ogg')) return 'ogg'
  return 'webm'
}

function slugify(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-').slice(0, 90) || 'recording'
}

function defaultTitle(): string {
  const now = new Date()
  return t('Recording {date} {time}', { date: formatDate(now, { month: 'short', day: 'numeric' }), time: formatDate(now, { hour: '2-digit', minute: '2-digit' }) })
}

function monotonicNow(): number {
  return performance.now()
}
