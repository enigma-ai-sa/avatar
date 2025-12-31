import { NextResponse } from "next/server"

export async function GET() {
  return NextResponse.json({
    apiKey: process.env.ELEVENLABS_API_KEY || null,
    voiceId: process.env.ELEVENLABS_VOICE_ID || null,
  })
}
