import { randomUUID } from "crypto";
import elevenlabs from "./elevenlabs.js";

interface AudioEntry {
  buffer: Buffer;
  expiresAt: number;
}

// In-memory store for generated audio files — Sendblue fetches from the served URL
// 10-minute TTL is enough for delivery; Railway filesystem is ephemeral so memory is safer
const audioCache = new Map<string, AudioEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of audioCache.entries()) {
    if (entry.expiresAt < now) audioCache.delete(id);
  }
}, 10 * 60 * 1000);

export async function generateVoiceNote(text: string): Promise<string> {
  const stream = await elevenlabs.textToSpeech.convert(
    process.env.ELEVENLABS_VOICE_ID!,
    {
      text,
      modelId: "eleven_turbo_v2_5",
      outputFormat: "mp3_44100_128",
    },
  );

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);

  const id = randomUUID();
  audioCache.set(id, {
    buffer,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  // Railway sets RAILWAY_PUBLIC_DOMAIN automatically; fall back to API_URL for local dev
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.API_URL!;

  return `${baseUrl}/audio/${id}`;
}

export function getAudioEntry(id: string): AudioEntry | undefined {
  return audioCache.get(id);
}
