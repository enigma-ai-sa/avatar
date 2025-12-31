import { NextResponse } from "next/server"

export async function GET() {
  // Return the API key to the client
  // In production, consider using ephemeral tokens instead
  return NextResponse.json({
    apiKey: process.env.GEMINI_API_KEY || "",
  })
}
