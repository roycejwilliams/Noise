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
      modelId: "eleven_turbo_v2_5",
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

// Shared by both generateVoiceNote (ElevenLabs, above) and
// generateHumeVoiceLine (below) — same cache, same eviction, same /audio/:id
// route serves either. Pulled out since the caching logic has nothing to do
// with which TTS provider produced the bytes.
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

// Synthesizes one line using Co's own attached Hume voice (HUME_VOICE_ID —
// the exact voice_id on whichever HUME_CONFIG_ID this environment points
// at, not a separate voice system). Needed specifically for TwiML said
// while a call is still live but Hume itself is no longer on the line (the
// AMD-misfire voicemail redirect in webhooks.ts/co.ts) — Twilio's <Say> only
// offers its own built-in voices, which don't match Co's real voice at all.
// Hume's /v0/tts is a standalone synthesis endpoint, separate from live EVI
// chat, but accepts the same voice_id.
export async function generateHumeVoiceLine(text: string): Promise<string> {
  const res = await fetch("https://api.hume.ai/v0/tts", {
    method: "POST",
    headers: {
      "X-Hume-Api-Key": process.env.HUME_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      utterances: [{ text, voice: { id: process.env.HUME_VOICE_ID!, provider: "HUME_AI" } }],
    }),
  });
  if (!res.ok) throw new Error(`Hume TTS failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const base64Audio = data.generations?.[0]?.audio;
  if (!base64Audio) throw new Error("Hume TTS returned no audio");
  return cacheAudioBuffer(Buffer.from(base64Audio, "base64"));
}
