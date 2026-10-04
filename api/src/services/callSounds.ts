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

// Pure: which turn each of Scribe's spoken words belongs to, walking the call
// in order. Each turn's words are used up as they're heard, so a turn already
// spoken in full stops attracting words that merely look like it. Each word
// goes to whichever of the current turn and the next two still holds it and
// the few words after it best; a tie stays put. -1 before any word matches.
export function alignWords(spoken: string[], turnWords: string[][], ahead = 4): number[] {
  const left = turnWords.map((ws) => {
    const m = new Map<string, number>();
    for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  });
  const has = (k: number, w: string) => (left[k].get(w) ?? 0) > 0;
  const ws = spoken.map((raw) => norm(raw)[0] ?? "");
  let t = -1;
  return ws.map((w, j) => {
    if (!w) return t;
    const run = ws.slice(j, j + ahead).filter(Boolean);
    let best = t;
    let bestScore = t >= 0 && has(t, w) ? run.filter((x) => has(t, x)).length : -1;
    for (const k of [t + 1, t + 2]) {
      if (k < 0 || k >= left.length || !has(k, w)) continue;
      const score = run.filter((x) => has(k, x)).length;
      if (score > bestScore) {
        best = k;
        bestScore = score;
      }
    }
    t = best;
    if (t >= 0 && has(t, w)) left[t].set(w, left[t].get(w)! - 1);
    return t;
  });
}

const LAUGH_CUE = /\[(?:laughs?|laughing|chuckles?)\]/i;

// Pure: the sighs and laughs on a call, each with the caller line it came
// with. Each of Scribe's words is placed in its turn along the call
// (alignWords). A sound belongs to the line it opens or sits inside: a tag
// inside a caller's turn is theirs; a tag between turns belongs to the next
// turn, so it counts only when that's the caller's. Co's cues open its own
// lines (services/voiceCues.ts), so Co's laugh is never handed to the caller;
// a sound at the very end of a caller's line, right before Co speaks, can't be
// told from Co opening with one, so it's dropped (review of #63: a
// nearest-words match handed Co's laugh to the caller). At most
// CALL_SOUNDS.maxMoments, one per line and sound.
export function soundMoments(words: ScribeWord[], turns: ElevenLabsTurn[], opts = CALL_SOUNDS): SoundMoment[] {
  const lines = turns
    .filter((t) => typeof t.message === "string" && t.message.trim())
    .map((t) => ({ who: (t.role === "user" ? "caller" : "co") as "caller" | "co", text: t.message!.trim() }));
  if (!lines.some((l) => l.who === "caller")) return [];
  const idx = words.map((w, i) => ({ w, i })).filter((x) => x.w.type === "word");
  const at = alignWords(idx.map((x) => x.w.text), lines.map((l) => norm(l.text)));
  const turnOf = new Map<number, number>(idx.map((x, j) => [x.i, at[j]]));
  const out: SoundMoment[] = [];
  const seen = new Set<string>();
  words.forEach((w, i) => {
    if (w.type !== "audio_event" || out.length >= opts.maxMoments) return;
    const sound = soundOf(w.text);
    if (!sound) return;
    const prev = idx.filter((x) => x.i < i).map((x) => turnOf.get(x.i) ?? -1).pop() ?? -1;
    const next = idx.filter((x) => x.i > i).map((x) => turnOf.get(x.i) ?? -1).find((t) => t >= 0) ?? -1;
    const turn = prev >= 0 && prev === next ? prev : next;
    if (turn < 0 || lines[turn].who !== "caller") return;
    // Right after a Co line where Co itself laughed (its [laughs] cue is in the
    // transcript), a laugh is Co's.
    if (sound === "laughed" && prev >= 0 && prev !== turn && lines[prev].who === "co" && LAUGH_CUE.test(lines[prev].text)) return;
    const line = lines[turn].text;
    const key = `${sound}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ sound, line });
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
