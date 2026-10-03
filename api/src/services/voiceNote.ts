import { randomUUID } from "crypto";
import elevenlabs from "./elevenlabs.js";

interface AudioEntry {
  buffer: Buffer;
  expiresAt: number;
}

// In-memory store for generated audio files — Sendblue fetches from the served URL.
// 30-minute TTL to survive transient Sendblue delivery delays.
// Railway filesystem is ephemeral so memory is safer than disk.
// Hard cap of 100 entries prevents unbounded growth; oldest entry is evicted first.
const MAX_CACHE_ENTRIES = 100;
const AUDIO_TTL_MS = 30 * 60 * 1000;
const audioCache = new Map<string, AudioEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of audioCache.entries()) {
    if (entry.expiresAt < now) audioCache.delete(id);
  }
}, AUDIO_TTL_MS);

export async function generateVoiceNote(text: string): Promise<string> {
  const stream = await elevenlabs.textToSpeech.convert(
    process.env.ELEVENLABS_VOICE_ID!,
    {
      text,
      // Eleven v4 (2026-10-03): #1 on quality, and a voice note isn't live, so
      // its speed doesn't matter. Same ELEVENLABS_VOICE_ID as Co's call agent,
      // so Co sounds the same on a call and in a note. eleven_turbo_v2_5 was deprecated.
      modelId: process.env.VOICE_NOTE_MODEL || "eleven_v4",
      outputFormat: "mp3_44100_128",
    },
  );

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return cacheAudioBuffer(Buffer.concat(chunks));
}

export function getAudioEntry(id: string): AudioEntry | undefined {
  return audioCache.get(id);
}

// The cache /audio/:id serves from (voice notes, above).
function cacheAudioBuffer(buffer: Buffer): string {
  if (audioCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = audioCache.keys().next().value;
    if (oldestKey) audioCache.delete(oldestKey);
  }
  const id = randomUUID();
  audioCache.set(id, { buffer, expiresAt: Date.now() + AUDIO_TTL_MS });
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.API_URL!;
  return `${baseUrl}/audio/${id}`;
}
