// Sighs and laughs on a call (Royce, 2026-10-04: "yes to the Scribe laugh/sigh
// tags at a cent a call"). After a call, ElevenLabs' Scribe transcribes the
// recording with audio-event tags, and each sigh or laugh is matched to the
// caller line it came with. It's recorded as a call moment beside the text read
// and the frustration score: "sighed" or "laughed" with their own words. The
// sound, not its meaning: a sigh can be relief and a laugh can be nerves, so
// it's never read as a feeling and never marks a hard day (needsCare).
//
// Why Scribe: on the voice pilot's 8 driven calls (phone-quality caller audio)
// it tagged 4 of 8 acted laughs and 9 of 16 acted sighs, none on calm lines or
// on Co; Gemini caught 0 and 2. The recording already sits with ElevenLabs, so
// no new party sees audio. About $0.22 an hour of audio (~1 cent a 3-minute call).
//
// Matching uses Scribe's own words around a tag, not ElevenLabs' turn times
// (they don't line up), and a tag next to Co's words is dropped, so Co's own
// [laughs] cue (services/voiceCues.ts) is never read as the member laughing.
// On unless SCRIBE_TAGS=off. Once per call; never fails or slows the call.
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { recordEmotionSignals, type EmotionSignal } from "../harness/emotion.js";
import type { ElevenLabsTurn } from "./elevenLabsCalls.js";

export const CALL_SOUNDS = {
  model: "scribe_v2",
  maxMoments: 3,
  match: 0.6,
  window: 6,
  maxAudioBytes: 45 * 60 * 16_000, // ~45 minutes at ElevenLabs' 128 kbps mono
  audioTries: 4,
  audioWaitMs: 15_000,
  timeoutMs: 120_000,
};

export function callSoundsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCRIBE_TAGS !== "off" && !!env.ELEVENLABS_API_KEY;
}

export type ScribeWord = { text: string; type?: string; start?: number };
export type Sound = "sighed" | "laughed";
export type SoundMoment = { sound: Sound; line: string };

export function soundOf(tag: string): Sound | null {
  const t = tag.toLowerCase();
  if (/laugh|chuckl|giggl/.test(t)) return "laughed";
  if (/sigh/.test(t)) return "sighed";
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

// Pure: which line a run of Scribe's words belongs to: the share of the run's
// words found in the line, best line first. Co's lines compete with the
// caller's, so words that are Co's never land on the caller.
function bestLine(words: string[], lines: { who: "caller" | "co"; text: string }[]): { who: "caller" | "co"; text: string; score: number } | null {
  const run = norm(words.join(" "));
  if (run.length < 2) return null;
  let best: { who: "caller" | "co"; text: string; score: number } | null = null;
  for (const l of lines) {
    const set = new Set(norm(l.text));
    const score = run.filter((w) => set.has(w)).length / run.length;
    if (!best || score > best.score) best = { ...l, score };
  }
  return best;
}

// Pure: the sighs and laughs on a call, each with the caller line it came
// with: the words right after the tag, or right before it for a tag at the end
// of a line. Dropped when those words are Co's or match nothing. At most
// CALL_SOUNDS.maxMoments, one per line and sound.
export function soundMoments(words: ScribeWord[], turns: ElevenLabsTurn[], opts = CALL_SOUNDS): SoundMoment[] {
  const lines = turns
    .filter((t) => typeof t.message === "string" && t.message.trim())
    .map((t) => ({ who: (t.role === "user" ? "caller" : "co") as "caller" | "co", text: t.message!.trim() }));
  if (!lines.some((l) => l.who === "caller")) return [];
  const spoken = words.map((w, i) => ({ w, i })).filter((x) => x.w.type === "word");
  const out: SoundMoment[] = [];
  const seen = new Set<string>();
  words.forEach((w, i) => {
    if (w.type !== "audio_event" || out.length >= opts.maxMoments) return;
    const sound = soundOf(w.text);
    if (!sound) return;
    const after = spoken.filter((x) => x.i > i).slice(0, opts.window).map((x) => x.w.text);
    const before = spoken.filter((x) => x.i < i).slice(-opts.window).map((x) => x.w.text);
    let hit = bestLine(after, lines);
    if (!hit || hit.score < opts.match) hit = bestLine(before, lines);
    if (!hit || hit.score < opts.match || hit.who !== "caller") return;
    const key = `${sound}:${hit.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ sound, line: hit.text });
  });
  return out;
}

// Pure: as call moments, tagged so nothing reads them as a feeling.
export function soundSignals(moments: SoundMoment[]): Omit<EmotionSignal, "at">[] {
  return moments.map((m) => ({ source: "call" as const, emotion: m.sound, intensity: "medium" as const, valence: "mixed" as const, about: null, quote: m.line.slice(0, 140), basis: "sound_tag" as const }));
}

async function fetchAudio(conversationId: string): Promise<Blob | null> {
  for (let i = 0; i < CALL_SOUNDS.audioTries; i++) {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}/audio`, {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" },
      signal: AbortSignal.timeout(30_000),
    });
    if (r.ok) return await r.blob();
    if (r.status !== 404 && r.status < 500) throw new Error(`audio ${r.status}`);
    if (i < CALL_SOUNDS.audioTries - 1) await new Promise((res) => setTimeout(res, CALL_SOUNDS.audioWaitMs));
  }
  return null;
}

async function scribe(audio: Blob): Promise<ScribeWord[]> {
  const form = new FormData();
  form.append("model_id", CALL_SOUNDS.model);
  form.append("tag_audio_events", "true");
  form.append("file", audio, "call.mp3");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" },
    body: form,
    signal: AbortSignal.timeout(CALL_SOUNDS.timeoutMs),
  });
  if (!r.ok) throw new Error(`scribe ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return Array.isArray(j?.words) ? j.words : [];
}

// After a real conversation (routes/co.ts). Recorded with the call's stored
// transcript; skipped if this call's sounds are already on file (a retried
// webhook). Logged whatever happens.
export async function recordCallSounds(o: { userId: string; conversationId: string; turns: ElevenLabsTurn[] }): Promise<void> {
  if (!o.conversationId || !callSoundsOn()) return;
  if (!o.turns.some((t) => t.role === "user" && typeof t.message === "string" && t.message.trim())) return;
  const started = Date.now();
  const log = (outcome: "act" | "skip", action: string, proposal: Record<string, unknown>) =>
    recordDecision({ layer: 8, decision: "call.sound_tags", userId: o.userId, outcome, action, proposal: { conversationId: o.conversationId, ms: Date.now() - started, ...proposal } }).catch(() => {});
  try {
    const { rows } = await pool.query(
      `SELECT m.id, EXISTS (SELECT 1 FROM emotion_signals es WHERE es.memory_id = m.id AND es.basis = 'sound_tag') AS done
       FROM co_memories m WHERE m.user_id = $1 AND m.memory_type = 'call_transcript' AND m.audio_url LIKE '%' || $2 ORDER BY m.created_at DESC LIMIT 1`,
      [o.userId, o.conversationId],
    );
    if (!rows[0]) return void (await log("skip", "no_transcript", {}));
    if (rows[0].done) return;
    const audio = await fetchAudio(o.conversationId);
    if (!audio) return void (await log("skip", "no_audio", {}));
    if (audio.size > CALL_SOUNDS.maxAudioBytes) return void (await log("skip", "too_long", { bytes: audio.size }));
    const words = await scribe(audio);
    const tags = words.filter((w) => w.type === "audio_event").map((w) => w.text);
    const moments = soundMoments(words, o.turns);
    if (moments.length) await recordEmotionSignals(o.userId, soundSignals(moments).map((s) => ({ ...s, memoryId: rows[0].id })));
    await log("act", moments.length ? "recorded" : "none", { bytes: audio.size, tags, moments });
  } catch (err: any) {
    await log("skip", "failed", { error: String(err?.message ?? err).slice(0, 300) });
    console.error("call sounds failed (non-fatal):", err?.message ?? err);
  }
}
