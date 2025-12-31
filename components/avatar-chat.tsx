"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Mic, MicOff, Phone, PhoneOff, Volume2, VolumeX } from "lucide-react"
import { SimliClient } from "simli-client"

const SIMLI_FACE_ID = "e0d70631-9035-4d2b-8438-ea06a9af2767"

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

const audioWorkletCode = `
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0]) {
      const inputChannel = input[0];
      for (let i = 0; i < inputChannel.length; i++) {
        this.buffer[this.bufferIndex++] = inputChannel[i];
        if (this.bufferIndex >= this.bufferSize) {
          this.port.postMessage(this.buffer.slice());
          this.bufferIndex = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
`

export function AvatarChat() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected")
  const [isMuted, setIsMuted] = useState(false)
  const [isAvatarMuted, setIsAvatarMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<string[]>([])

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const simliClientRef = useRef<SimliClient | null>(null)
  const geminiWsRef = useRef<WebSocket | null>(null)
  const elevenLabsWsRef = useRef<WebSocket | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const elevenLabsApiKeyRef = useRef<string | null>(null)
  const elevenLabsVoiceIdRef = useRef<string | null>(null)
  const isSessionActiveRef = useRef(false)

  const currentTurnTextRef = useRef<string>("")
  const isSpeakingRef = useRef(false)
  const isGeneratingRef = useRef(false)
  const isInterruptedRef = useRef(false)

  const processAudioForGemini = useCallback((audioData: Float32Array): string => {
    const targetSampleRate = 16000
    const sourceSampleRate = 48000
    const ratio = sourceSampleRate / targetSampleRate
    const targetLength = Math.floor(audioData.length / ratio)
    const resampled = new Float32Array(targetLength)

    for (let i = 0; i < targetLength; i++) {
      resampled[i] = audioData[Math.floor(i * ratio)]
    }

    const pcm16 = new Int16Array(resampled.length)
    for (let i = 0; i < resampled.length; i++) {
      const s = Math.max(-1, Math.min(1, resampled[i]))
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    const uint8Array = new Uint8Array(pcm16.buffer)
    let binary = ""
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i])
    }
    return btoa(binary)
  }, [])

  const processElevenLabsAudioForSimli = useCallback((base64Audio: string): Uint8Array => {
    const binaryString = atob(base64Audio)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    return bytes
  }, [])

  const interruptAvatarSpeech = useCallback(() => {
    console.log("[v0] INTERRUPT: Stopping avatar speech immediately")

    isInterruptedRef.current = true
    isSpeakingRef.current = false
    isGeneratingRef.current = false
    currentTurnTextRef.current = ""

    // Force close ElevenLabs WebSocket to stop any pending audio generation
    if (elevenLabsWsRef.current) {
      elevenLabsWsRef.current.onmessage = null // Remove message handler to prevent more audio
      elevenLabsWsRef.current.onclose = null // Prevent auto-reconnect
      elevenLabsWsRef.current.close()
      elevenLabsWsRef.current = null
    }

    // Clear Simli's audio buffer immediately
    if (simliClientRef.current) {
      simliClientRef.current.ClearBuffer()
    }

    // Reconnect ElevenLabs after a brief delay
    setTimeout(() => {
      isInterruptedRef.current = false
      if (isSessionActiveRef.current) {
        connectElevenLabs()
      }
    }, 100)
  }, [])

  const speakText = useCallback((text: string) => {
    if (!text.trim() || isInterruptedRef.current) return

    if (!elevenLabsWsRef.current || elevenLabsWsRef.current.readyState !== WebSocket.OPEN) {
      return
    }

    console.log("[v0] Sending to ElevenLabs:", text)
    isGeneratingRef.current = true
    isSpeakingRef.current = true

    elevenLabsWsRef.current.send(
      JSON.stringify({
        text: text + " ",
        try_trigger_generation: true,
      }),
    )
  }, [])

  const flushSpeech = useCallback(() => {
    if (isInterruptedRef.current) return

    if (elevenLabsWsRef.current && elevenLabsWsRef.current.readyState === WebSocket.OPEN) {
      elevenLabsWsRef.current.send(
        JSON.stringify({
          text: "",
        }),
      )
    }
  }, [])

  const connectElevenLabs = useCallback(() => {
    const apiKey = elevenLabsApiKeyRef.current
    const voiceId = elevenLabsVoiceIdRef.current

    if (!apiKey || !voiceId) {
      console.error("[v0] ElevenLabs API key or voice ID not set")
      return
    }

    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_multilingual_v2&output_format=pcm_16000&optimize_streaming_latency=4`

    elevenLabsWsRef.current = new WebSocket(wsUrl)

    elevenLabsWsRef.current.onopen = () => {
      console.log("[v0] ElevenLabs WebSocket connected")

      const initMessage = {
        text: " ",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
          use_speaker_boost: true,
        },
        generation_config: {
          chunk_length_schedule: [50, 90, 120, 150, 200],
        },
        xi_api_key: apiKey,
        try_trigger_generation: false,
      }
      elevenLabsWsRef.current?.send(JSON.stringify(initMessage))
    }

    elevenLabsWsRef.current.onmessage = (event) => {
      if (isInterruptedRef.current) return

      try {
        const response = JSON.parse(event.data)

        if (response.audio) {
          const audioData = processElevenLabsAudioForSimli(response.audio)
          simliClientRef.current?.sendAudioData(audioData)
        }

        if (response.isFinal) {
          console.log("[v0] ElevenLabs finished speaking")
          isSpeakingRef.current = false
          isGeneratingRef.current = false
        }
      } catch (e) {
        console.error("[v0] Error processing ElevenLabs response:", e)
        isSpeakingRef.current = false
        isGeneratingRef.current = false
      }
    }

    elevenLabsWsRef.current.onerror = (error) => {
      console.error("[v0] ElevenLabs WebSocket error:", error)
      isSpeakingRef.current = false
      isGeneratingRef.current = false
    }

    elevenLabsWsRef.current.onclose = () => {
      console.log("[v0] ElevenLabs WebSocket closed")
      isSpeakingRef.current = false
      isGeneratingRef.current = false
      // Only reconnect if session is active and not interrupted
      if (isSessionActiveRef.current && !isInterruptedRef.current) {
        setTimeout(() => connectElevenLabs(), 100)
      }
    }
  }, [processElevenLabsAudioForSimli])

  const startSession = useCallback(async () => {
    try {
      setConnectionStatus("connecting")
      setError(null)
      isSessionActiveRef.current = true
      isSpeakingRef.current = false
      isGeneratingRef.current = false
      isInterruptedRef.current = false
      currentTurnTextRef.current = ""

      const [keyResponse, simliResponse, elevenLabsResponse] = await Promise.all([
        fetch("/api/gemini-key"),
        fetch("/api/simli-key"),
        fetch("/api/elevenlabs-key"),
      ])

      const { apiKey } = await keyResponse.json()
      const { apiKey: simliApiKey } = await simliResponse.json()
      const { apiKey: elevenLabsApiKey, voiceId: elevenLabsVoiceId } = await elevenLabsResponse.json()

      if (!apiKey) {
        throw new Error("Gemini API key not configured. Please add GEMINI_API_KEY to your environment variables.")
      }

      if (!simliApiKey) {
        throw new Error("Simli API key not configured. Please add SIMLI_API_KEY to your environment variables.")
      }

      if (!elevenLabsApiKey) {
        throw new Error(
          "ElevenLabs API key not configured. Please add ELEVENLABS_API_KEY to your environment variables.",
        )
      }

      if (!elevenLabsVoiceId) {
        throw new Error(
          "ElevenLabs voice ID not configured. Please add ELEVENLABS_VOICE_ID to your environment variables.",
        )
      }

      elevenLabsApiKeyRef.current = elevenLabsApiKey
      elevenLabsVoiceIdRef.current = elevenLabsVoiceId

      if (videoRef.current && audioRef.current) {
        simliClientRef.current = new SimliClient()

        simliClientRef.current.Initialize({
          apiKey: simliApiKey,
          faceID: SIMLI_FACE_ID,
          handleSilence: true,
          maxSessionLength: 3600,
          maxIdleTime: 600,
          videoRef: videoRef.current,
          audioRef: audioRef.current,
        })

        simliClientRef.current.on("connected", () => {
          console.log("[v0] Simli connected")
        })

        simliClientRef.current.on("disconnected", () => {
          console.log("[v0] Simli disconnected")
        })

        await simliClientRef.current.start()
      }

      connectElevenLabs()

      const model = "gemini-2.0-flash-exp"
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`

      geminiWsRef.current = new WebSocket(wsUrl)

      geminiWsRef.current.onopen = () => {
        console.log("[v0] Gemini WebSocket connected")

        const setupMessage = {
          setup: {
            model: `models/${model}`,
            generation_config: {
              response_modalities: ["TEXT"],
            },
            system_instruction: {
              parts: [
                {
                  text: "You are a friendly and helpful AI assistant. Keep your responses concise and conversational - ideally 1-2 sentences. You only speak in Arabic, Saudi Dialect specifically from the region of Riyadh. You're name is ahmad, and you work at Engima.",
                },
              ],
            },
          },
        }

        geminiWsRef.current?.send(JSON.stringify(setupMessage))
      }

      geminiWsRef.current.onmessage = async (event) => {
        try {
          let data: string
          if (event.data instanceof Blob) {
            data = await event.data.text()
          } else {
            data = event.data
          }

          const response = JSON.parse(data)

          if (response.setupComplete) {
            console.log("[v0] Gemini setup complete")
            setConnectionStatus("connected")
            startMicrophone()
            // ADD THIS: Send initial prompt to trigger a greeting
            const initialPrompt = {
              clientContent: {
                turns: [
                  {
                    role: "user",
                    parts: [{ text: "عرف بنفسك" }]
                  }
                ],
                turnComplete: true
              }
            }
            geminiWsRef.current?.send(JSON.stringify(initialPrompt))
          }

          if (response.serverContent?.interrupted) {
            console.log("[v0] Gemini detected user interruption")
            interruptAvatarSpeech()
            return // Don't process any more from this message
          }

          if (isInterruptedRef.current) return

          if (response.serverContent?.modelTurn?.parts) {
            for (const part of response.serverContent.modelTurn.parts) {
              if (part.text) {
                currentTurnTextRef.current += part.text
                // Stream to ElevenLabs immediately for real-time feel
                speakText(part.text)
              }
            }
          }

          if (response.serverContent?.turnComplete) {
            const fullText = currentTurnTextRef.current.trim()
            if (fullText) {
              console.log("[v0] Turn complete:", fullText)
              setTranscript((prev) => [...prev.slice(-9), `AI: ${fullText}`])
              flushSpeech()
            }
            currentTurnTextRef.current = ""
          }
        } catch (e) {
          console.error("[v0] Error parsing Gemini response:", e)
        }
      }

      geminiWsRef.current.onerror = (error) => {
        console.error("[v0] Gemini WebSocket error:", error)
        setError("Connection error occurred")
        setConnectionStatus("error")
      }

      geminiWsRef.current.onclose = () => {
        console.log("[v0] Gemini WebSocket closed")
        if (connectionStatus === "connected") {
          setConnectionStatus("disconnected")
        }
      }
    } catch (err) {
      console.error("[v0] Error starting session:", err)
      setError(err instanceof Error ? err.message : "Failed to start session")
      setConnectionStatus("error")
      isSessionActiveRef.current = false
    }
  }, [connectionStatus, connectElevenLabs, speakText, flushSpeech, interruptAvatarSpeech])

  const startMicrophone = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      mediaStreamRef.current = stream
      audioContextRef.current = new AudioContext({ sampleRate: 48000 })

      const blob = new Blob([audioWorkletCode], { type: "application/javascript" })
      const workletUrl = URL.createObjectURL(blob)

      await audioContextRef.current.audioWorklet.addModule(workletUrl)
      URL.revokeObjectURL(workletUrl)

      const source = audioContextRef.current.createMediaStreamSource(stream)
      workletNodeRef.current = new AudioWorkletNode(audioContextRef.current, "audio-processor")

      workletNodeRef.current.port.onmessage = (event) => {
        if (isMuted) return

        const audioData = event.data as Float32Array
        const base64Audio = processAudioForGemini(audioData)

        if (geminiWsRef.current?.readyState === WebSocket.OPEN) {
          const audioMessage = {
            realtimeInput: {
              mediaChunks: [
                {
                  mimeType: "audio/pcm;rate=16000",
                  data: base64Audio,
                },
              ],
            },
          }
          geminiWsRef.current.send(JSON.stringify(audioMessage))
        }
      }

      source.connect(workletNodeRef.current)
    } catch (err) {
      console.error("[v0] Error accessing microphone:", err)
      setError("Failed to access microphone")
    }
  }, [isMuted, processAudioForGemini])

  const stopSession = useCallback(() => {
    isSessionActiveRef.current = false
    isSpeakingRef.current = false
    isGeneratingRef.current = false
    isInterruptedRef.current = false
    currentTurnTextRef.current = ""

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    workletNodeRef.current?.disconnect()
    audioContextRef.current?.close()

    geminiWsRef.current?.close()
    if (elevenLabsWsRef.current) {
      elevenLabsWsRef.current.onclose = null
      elevenLabsWsRef.current.close()
    }
    simliClientRef.current?.close()

    setConnectionStatus("disconnected")
    setTranscript([])
  }, [])

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev)
  }, [])

  const toggleAvatarMute = useCallback(() => {
    setIsAvatarMuted((prev) => {
      if (audioRef.current) {
        audioRef.current.muted = !prev
      }
      return !prev
    })
  }, [])

  useEffect(() => {
    return () => {
      stopSession()
    }
  }, [stopSession])

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black">
      {/* Full screen video */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="absolute inset-0 w-full h-full object-contain"
      />
      <audio ref={audioRef} autoPlay className="hidden" />
  
      {/* Connection status overlays */}
      {connectionStatus === "disconnected" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <p className="text-white/70 text-lg">Click Connect to begin</p>
        </div>
      )}
  
      {connectionStatus === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white" />
            <p className="text-white/70">Connecting...</p>
          </div>
        </div>
      )}
  
      {/* Live indicator */}
      {connectionStatus === "connected" && (
        <div className="absolute top-6 left-6 flex items-center gap-2 bg-black/50 backdrop-blur-sm rounded-full px-4 py-2">
          <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
          <span className="text-sm text-white font-medium">Live</span>
        </div>
      )}
  
      {/* Error display */}
      {error && (
        <div className="absolute top-6 right-6 bg-red-500/90 backdrop-blur-sm rounded-lg px-4 py-2 max-w-sm">
          <p className="text-sm text-white">{error}</p>
        </div>
      )}
  
      {/* Floating control buttons at bottom center */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-4">
        {connectionStatus === "disconnected" || connectionStatus === "error" ? (
          <Button
            size="lg"
            onClick={startSession}
            className="gap-2 rounded-full px-8 py-6 bg-green-600 hover:bg-green-700 text-white shadow-lg"
          >
            <Phone className="h-6 w-6" />
            Connect
          </Button>
        ) : (
          <>
            <Button
              size="lg"
              variant="ghost"
              onClick={toggleMute}
              disabled={connectionStatus !== "connected"}
              className={`rounded-full w-14 h-14 ${
                isMuted 
                  ? "bg-red-500 hover:bg-red-600 text-white" 
                  : "bg-white/20 hover:bg-white/30 text-white backdrop-blur-sm"
              }`}
            >
              {isMuted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
            </Button>
  
            <Button
              size="lg"
              onClick={stopSession}
              className="rounded-full w-16 h-16 bg-red-500 hover:bg-red-600 text-white shadow-lg"
            >
              <PhoneOff className="h-7 w-7" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
