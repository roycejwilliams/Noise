import { randomUUID } from "crypto";
import { speak } from "./openaiAudio.js";

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

// Cue's words as a voice note: OpenAI speech (services/openaiAudio.ts) in the calls' voice (GPT-Live's, services/gptLive.ts
// gptLiveVoice: marin unless GPT_LIVE_VOICE says otherwise), so Cue sounds the same on a call and in a note. mp3, served at
// /audio/:id as audio/mpeg, as the ElevenLabs note was. Throws on any failure; callers send the words as a text instead.
export async function generateVoiceNote(text: string): Promise<string> {
  // Loaded here, not at the top: gptLive.ts pulls in the whole call stack, and this file is imported by the routes it imports.
  const { gptLiveVoice } = await import("./gptLive.js");
  return cacheAudioBuffer(await speak(text, gptLiveVoice()));
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
