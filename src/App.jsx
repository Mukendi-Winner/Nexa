import { useEffect, useRef, useState } from 'react'
import { GoogleGenAI, MediaResolution, Modality } from '@google/genai'
import './App.css'

const INPUT_RATE = 16000
const OUTPUT_RATE = 24000
const VIDEO_FPS_MS = 1000
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

function toBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToInt16(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Int16Array(bytes.buffer)
}

function App() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const sessionRef = useRef(null)
  const streamRef = useRef(null)
  const audioContextRef = useRef(null)
  const inputContextRef = useRef(null)
  const processorRef = useRef(null)
  const sourceRef = useRef(null)
  const frameTimerRef = useRef(null)
  const nextAudioTimeRef = useRef(0)
  const liveOpenRef = useRef(false)

  const [screen, setScreen] = useState('home')
  const [status, setStatus] = useState('idle')
  const [cameraReady, setCameraReady] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [errorText, setErrorText] = useState('')

  const connected = status === 'connected'

  async function ensureMedia() {
    if (streamRef.current) return streamRef.current

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })

    streamRef.current = stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      await videoRef.current.play()
    }
    setCameraReady(true)
    return stream
  }

  async function fetchLiveToken() {
    if (import.meta.env.PROD && !API_BASE_URL) {
      throw new Error(
        'VITE_API_BASE_URL manque sur Netlify. Ajoute l URL Render dans les variables Netlify puis redeploie.',
      )
    }

    const response = await fetch(`${API_BASE_URL}/api/live-token`, { method: 'POST' })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload.error || 'Le backend Live ne repond pas.')
    }
    return payload
  }

  async function connectLive() {
    setIsConnecting(true)
    setStatus('connecting')
    setErrorText('')

    try {
      const stream = await ensureMedia()
      const { token, model } = await fetchLiveToken()

      const ai = new GoogleGenAI({
        apiKey: token,
        apiVersion: 'v1alpha',
      })

      audioContextRef.current = new AudioContext({ sampleRate: OUTPUT_RATE })
      await audioContextRef.current.resume()
      nextAudioTimeRef.current = audioContextRef.current.currentTime

      const config = {
        responseModalities: [Modality.AUDIO],
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
        outputAudioTranscription: {},
        systemInstruction:
          'Tu es Nexa, un assistant visuel et vocal en direct. Reponds en francais, avec des phrases courtes et naturelles. Quand la camera apporte du contexte, decris ce que tu vois.',
      }

      let resolveOpen
      let rejectOpen
      const opened = new Promise((resolve, reject) => {
        resolveOpen = resolve
        rejectOpen = reject
      })
      const timeout = window.setTimeout(
        () => rejectOpen(new Error('La connexion Live a expire.')),
        12000,
      )

      const session = await ai.live.connect({
        model,
        config,
        callbacks: {
          onopen: () => {
            window.clearTimeout(timeout)
            liveOpenRef.current = true
            setStatus('connected')
            setScreen('live')
            resolveOpen()
          },
          onmessage: handleLiveMessage,
          onerror: (error) => {
            window.clearTimeout(timeout)
            liveOpenRef.current = false
            rejectOpen(error)
          },
          onclose: () => {
            liveOpenRef.current = false
            stopStreams()
            setStatus('idle')
            setScreen('ready')
          },
        },
      })

      sessionRef.current = session
      await opened
      await startAudioStream(stream)
      startVideoFrames()
    } catch (error) {
      liveOpenRef.current = false
      setStatus('error')
      setScreen('ready')
      setErrorText(error.message || 'Impossible de connecter Gemini Live.')
      stopLive()
    } finally {
      setIsConnecting(false)
    }
  }

  function handleLiveMessage(message) {
    const serverContent = message.serverContent
    const parts = serverContent?.modelTurn?.parts || []
    for (const part of parts) {
      const inlineData = part.inlineData || part.inline_data
      const data = inlineData?.data
      if (data) playPcmAudio(data)
    }
  }

  function sendRealtimeInput(payload) {
    if (!sessionRef.current || !liveOpenRef.current) return

    try {
      sessionRef.current.sendRealtimeInput(payload)
    } catch (error) {
      liveOpenRef.current = false
      setStatus('error')
      setErrorText(error.message || 'Flux Live interrompu.')
      stopStreams()
    }
  }

  async function startAudioStream(stream) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    const inputContext = new AudioContextCtor()
    const source = inputContext.createMediaStreamSource(stream)
    inputContextRef.current = inputContext
    sourceRef.current = source

    if (inputContext.audioWorklet) {
      await inputContext.audioWorklet.addModule('/nexa-mic-processor.js')
      const processor = new AudioWorkletNode(inputContext, 'nexa-mic-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: { targetSampleRate: INPUT_RATE },
      })

      processor.port.onmessage = (event) => {
        if (!liveOpenRef.current) return

        sendRealtimeInput({
          audio: {
            data: toBase64(new Uint8Array(event.data)),
            mimeType: `audio/pcm;rate=${INPUT_RATE}`,
          },
        })
      }

      source.connect(processor)
      processor.connect(inputContext.destination)
      processorRef.current = processor
      return
    }

    const processor = inputContext.createScriptProcessor(4096, 1, 1)

    processor.onaudioprocess = (event) => {
      if (!liveOpenRef.current) return

      const input = event.inputBuffer.getChannelData(0)
      const pcm = new Int16Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]))
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      sendRealtimeInput({
        audio: {
          data: toBase64(new Uint8Array(pcm.buffer)),
          mimeType: `audio/pcm;rate=${inputContext.sampleRate}`,
        },
      })
    }

    source.connect(processor)
    processor.connect(inputContext.destination)
    processorRef.current = processor
  }

  function startVideoFrames() {
    frameTimerRef.current = window.setInterval(async () => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < 2 || !liveOpenRef.current) return

      const size = 768
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      const sourceSize = Math.min(video.videoWidth, video.videoHeight)
      const sx = (video.videoWidth - sourceSize) / 2
      const sy = (video.videoHeight - sourceSize) / 2
      ctx.drawImage(video, sx, sy, sourceSize, sourceSize, 0, 0, size, size)

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72))
      if (!blob || !liveOpenRef.current) return

      const bytes = new Uint8Array(await blob.arrayBuffer())
      sendRealtimeInput({
        video: {
          data: toBase64(bytes),
          mimeType: 'image/jpeg',
        },
      })
    }, VIDEO_FPS_MS)
  }

  function playPcmAudio(base64Audio) {
    const audioContext = audioContextRef.current
    if (!audioContext) return

    const pcm = base64ToInt16(base64Audio)
    const audioBuffer = audioContext.createBuffer(1, pcm.length, OUTPUT_RATE)
    const channel = audioBuffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = pcm[i] / 0x8000
    }

    const source = audioContext.createBufferSource()
    source.buffer = audioBuffer
    source.connect(audioContext.destination)

    const startAt = Math.max(audioContext.currentTime, nextAudioTimeRef.current)
    source.start(startAt)
    nextAudioTimeRef.current = startAt + audioBuffer.duration
  }

  function stopStreams() {
    if (frameTimerRef.current) {
      window.clearInterval(frameTimerRef.current)
      frameTimerRef.current = null
    }

    processorRef.current?.port?.close()
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    inputContextRef.current?.close()
    processorRef.current = null
    sourceRef.current = null
    inputContextRef.current = null
  }

  function stopLive() {
    liveOpenRef.current = false
    stopStreams()
    sessionRef.current?.close()
    sessionRef.current = null
    if (screen === 'live') setScreen('ready')
    setStatus('idle')
  }

  function stopCamera() {
    stopLive()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setCameraReady(false)
  }

  useEffect(() => {
    return () => {
      liveOpenRef.current = false
      stopStreams()
      sessionRef.current?.close()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      audioContextRef.current?.close()
    }
  }, [])

  if (screen === 'home') {
    return (
      <main className="app-shell">
        <section className="home-screen">
          <h1>
            Découvrez
            <br />
            Le monde
            <br />
            avec
            <br />
            <span>Nexa</span>
          </h1>
          <button type="button" className="primary-button" onClick={() => setScreen('ready')}>
            Commencer
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <section className={screen === 'live' ? 'camera-screen is-live' : 'camera-screen'}>
        <div className="camera-frame">
          <video ref={videoRef} playsInline muted className="camera-feed" />
          <canvas ref={canvasRef} className="capture-canvas" />
          {!cameraReady && <div className="camera-placeholder" />}
        </div>

        {screen === 'live' ? (
          <button
            type="button"
            className="stop-button"
            onClick={stopCamera}
            aria-label="Arreter le live"
          >
            X
          </button>
        ) : (
          <button
            type="button"
            className="primary-button live-button"
            onClick={connectLive}
            disabled={connected || isConnecting}
          >
            {isConnecting ? 'Connexion...' : 'Commencer le live'}
          </button>
        )}

        {status === 'error' && errorText && <p className="error-text">{errorText}</p>}
      </section>
    </main>
  )
}

export default App
