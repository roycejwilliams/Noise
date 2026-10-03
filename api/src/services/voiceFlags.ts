// Voice flags (Royce, 2026-10-03): after a call, one Gemini pass over the
// recording listens for moments where the caller's voice says something their
// words don't: a sigh on "yeah, I'm fine", forced cheer, sarcasm, a laugh. The
// text read (harness/emotion.ts callEmotionMoments) still carries the call's
// feelings; these ride alongside it, never in place of it.
//
// Why only these four: the voice-emotion pilot (evals/voice-emotion-pilot)
// found per-line tone scores were noise on real calls (Hume and Gemini barely
// agreed, and short clips can't be judged by ear), but on acted clips the audio
// caught sighs, laughs and sarcasm the words hid (31% of hidden feelings vs
// 0-19% from the words; 88% on sarcasm vs 50%).
//
// Proven on the clean test member first: VOICE_FLAGS=test runs it only for
// test numbers (services/testNumbers.ts, never in production); anything else
// is off. Every pass is logged (voice_flag_runs) and every flag it raises,
// kept or dropped (voice_flags), so what it catches can be audited before it
// goes near a member. Flags stay out of emotion_signals: the sweep, member
// threads and metrics read that table, and an unaudited read shouldn't reach
// them. Co sees kept flags only in its emotional-context block.
import pool from "../db/db.js";
import { isTestNumber } from "./testNumbers.js";
import type { ElevenLabsTurn } from "./elevenLabsCalls.js";

export type VoiceCue = "sigh" | "forced_cheer" | "sarcasm" | "laugh";
export const VOICE_CUES: VoiceCue[] = ["sigh", "forced_cheer", "sarcasm", "laugh"];

export type VoiceFlag = {
  atSecs: number | null;
  quote: string;
  cue: VoiceCue;
  feeling: string;
  valence: "negative" | "positive" | "mixed";
  reading: string;
  confidence: number;
};
export type CheckedFlag = VoiceFlag & { kept: boolean; dropReason: string | null };

export const VOICE_FLAG = {
  model: "gemini-3.8-flash",
  minConfidence: 0.7,
  maxKept: 3,
  // Inline audio limit is 20MB per request; base64 adds a third.
  maxAudioBytes: 14_000_000,
  audioTries: 4,
  audioWaitMs: 15_000,
  listenTimeoutMs: 120_000,
  // How long a call's kept flags stay in Co's context.
  showDays: 7,
};

// Off unless VOICE_FLAGS=test, and then only for test numbers. There is no
// "on" yet: real members wait until the audit says it's worth it.
export function voiceFlagsAllowed(phone: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VOICE_FLAGS === "test" && !!env.CO_GEMINI_KEY && isTestNumber(phone, env);
}

type TimedTurn = ElevenLabsTurn & { time_in_call_secs?: number | null };
export type CallerLine = { atSecs: number | null; text: string };

// Pure: what the caller said, with when.
export function callerLines(turns: TimedTurn[]): CallerLine[] {
  return turns
    .filter((t) => t.role === "user" && typeof t.message === "string" && t.message.trim())
    .map((t) => ({ atSecs: typeof t.time_in_call_secs === "number" ? t.time_in_call_secs : null, text: t.message!.trim() }));
}

const clock = (s: number | null | undefined) => (typeof s === "number" ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "?:??");

// Pure: the transcript Gemini reads next to the audio.
export function transcriptForListening(turns: TimedTurn[]): string {
  return turns
    .filter((t) => typeof t.message === "string" && t.message.trim())
    .map((t) => `[${clock(t.time_in_call_secs)}] ${t.role === "user" ? "Caller" : "Co"}: ${t.message!.trim()}`)
    .join("\n");
}

export const LISTEN_PROMPT = `You're listening to a phone call between Co (an AI companion) and a caller. The transcript, with times, is below the audio.

Listen only to the CALLER. Find moments where the caller's voice says something their words don't:
- sigh: an audible sigh, or a heavy, deflated delivery on words that read fine on paper ("yeah, I'm fine")
- forced_cheer: upbeat words said in a flat, strained or hollow way
- sarcasm: words said to mean the opposite ("oh, perfect")
- laugh: a laugh or chuckle that changes what the words mean: warmth or delight the words don't show, or a nervous laugh over something hard

Only flag a moment when the voice adds something the transcript alone would miss. If the words already say the feeling ("I'm so stressed", "I got the job!"), don't flag it. Most moments have nothing to flag: when you're unsure, leave it out rather than guess.

For each moment: at (seconds into the call), quote (the caller's exact words, copied from the transcript), cue, feeling (one or two words for what the voice shows), valence, reading (a few words on what you heard), confidence (0 to 1).`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    flags: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          at: { type: "NUMBER" },
          quote: { type: "STRING" },
          cue: { type: "STRING", enum: VOICE_CUES },
          feeling: { type: "STRING" },
          valence: { type: "STRING", enum: ["negative", "positive", "mixed"] },
          reading: { type: "STRING" },
          confidence: { type: "NUMBER" },
        },
        required: ["at", "quote", "cue", "feeling", "valence", "reading", "confidence"],
      },
    },
  },
  required: ["flags"],
};

const words = (s: string) => s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

// Pure: whether a quote is something the caller actually said: inside one of
// their lines, or most of its words in one (Gemini trims and re-punctuates).
export function quoteFromCaller(quote: string, lines: CallerLine[]): CallerLine | null {
  const q = words(quote);
  if (!q.length) return null;
  const joined = q.join(" ");
  for (const l of lines) {
    const w = words(l.text);
    if (w.join(" ").includes(joined)) return l;
    const set = new Set(w);
    if (q.length >= 3 && q.filter((x) => set.has(x)).length / q.length >= 0.8) return l;
  }
  return null;
}

// Pure: Gemini's answer checked against the call. A flag is kept only when its
// cue is one of the four, its quote is the caller's own words, and it's sure
// enough; at most VOICE_FLAG.maxKept, surest first. Dropped flags keep their
// reason for the audit.
export function checkFlags(raw: unknown, lines: CallerLine[], opts = VOICE_FLAG): CheckedFlag[] {
  const list: any[] = Array.isArray((raw as any)?.flags) ? (raw as any).flags : [];
  const checked: CheckedFlag[] = list.map((f) => {
    const confidence = typeof f?.confidence === "number" && isFinite(f.confidence) ? Math.max(0, Math.min(1, f.confidence)) : 0;
    const base: VoiceFlag = {
      atSecs: typeof f?.at === "number" && isFinite(f.at) ? f.at : null,
      quote: typeof f?.quote === "string" ? f.quote.trim().slice(0, 200) : "",
      cue: f?.cue,
      feeling: typeof f?.feeling === "string" ? f.feeling.toLowerCase().trim().slice(0, 40) : "",
      valence: f?.valence === "negative" || f?.valence === "positive" ? f.valence : "mixed",
      reading: typeof f?.reading === "string" ? f.reading.trim().slice(0, 160) : "",
      confidence,
    };
    let dropReason: string | null = null;
    if (!VOICE_CUES.includes(base.cue)) dropReason = "not one of the four cues";
    else if (!base.quote || !quoteFromCaller(base.quote, lines)) dropReason = "quote isn't something the caller said";
    else if (!base.feeling) dropReason = "no feeling named";
    else if (confidence < opts.minConfidence) dropReason = `confidence ${confidence} below ${opts.minConfidence}`;
    return { ...base, kept: !dropReason, dropReason };
  });
  const keep = checked.filter((f) => f.kept).sort((a, b) => b.confidence - a.confidence);
  for (const f of keep.slice(opts.maxKept)) {
    f.kept = false;
    f.dropReason = `beyond the ${opts.maxKept} surest`;
  }
  return checked;
}

async function fetchCallAudio(conversationId: string): Promise<{ bytes: Buffer; mime: string } | null> {
  for (let i = 0; i < VOICE_FLAG.audioTries; i++) {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}/audio`, {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" },
    });
    if (r.ok) return { bytes: Buffer.from(await r.arrayBuffer()), mime: r.headers.get("content-type")?.split(";")[0] || "audio/mpeg" };
    // The recording can lag the post-call webhook; anything else is final.
    if (r.status !== 404 && r.status !== 425 && r.status < 500) throw new Error(`audio ${r.status}`);
    await new Promise((res) => setTimeout(res, VOICE_FLAG.audioWaitMs));
  }
  return null;
}

// One Gemini pass over the audio and the timed transcript.
export async function listenForFlags(audio: { bytes: Buffer; mime: string }, transcript: string, key = process.env.CO_GEMINI_KEY ?? ""): Promise<unknown> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${VOICE_FLAG.model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(VOICE_FLAG.listenTimeoutMs),
    body: JSON.stringify({
      contents: [{ parts: [{ text: LISTEN_PROMPT }, { inlineData: { mimeType: audio.mime, data: audio.bytes.toString("base64") } }, { text: `Transcript:\n${transcript}` }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
    }),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  return JSON.parse(text);
}

// After a real conversation: once per call (a retried webhook finds the run
// already claimed), never fails the call, logs the pass whatever happens.
export async function flagVoiceMoments(o: { userId: string; phone: unknown; conversationId: string; turns: TimedTurn[] }): Promise<void> {
  if (!o.conversationId || !voiceFlagsAllowed(o.phone)) return;
  const lines = callerLines(o.turns);
  if (!lines.length) return;
  const claimed = await pool.query(
    `INSERT INTO voice_flag_runs (conversation_id, user_id, status, model) VALUES ($1, $2, 'running', $3) ON CONFLICT (conversation_id) DO NOTHING RETURNING conversation_id`,
    [o.conversationId, o.userId, VOICE_FLAG.model],
  );
  if (!claimed.rows.length) return;
  const started = Date.now();
  const finish = (status: string, extra: { audioBytes?: number; flags?: number; kept?: number; error?: string } = {}) =>
    pool.query(`UPDATE voice_flag_runs SET status = $2, audio_bytes = $3, flags = $4, kept = $5, error = $6, ms = $7, finished_at = NOW() WHERE conversation_id = $1`, [
      o.conversationId,
      status,
      extra.audioBytes ?? null,
      extra.flags ?? null,
      extra.kept ?? null,
      extra.error?.slice(0, 300) ?? null,
      Date.now() - started,
    ]);
  try {
    const audio = await fetchCallAudio(o.conversationId);
    if (!audio) return void (await finish("no_audio"));
    if (audio.bytes.length > VOICE_FLAG.maxAudioBytes) return void (await finish("too_long", { audioBytes: audio.bytes.length }));
    const flags = checkFlags(await listenForFlags(audio, transcriptForListening(o.turns)), lines);
    if (flags.length) {
      await pool.query(
        `INSERT INTO voice_flags (conversation_id, user_id, at_secs, quote, cue, feeling, valence, reading, confidence, kept, drop_reason)
         SELECT $1, $2, x.at_secs, x.quote, x.cue, x.feeling, x.valence, x.reading, x.confidence, x.kept, x.drop_reason
         FROM jsonb_to_recordset($3::jsonb) AS x(at_secs real, quote text, cue text, feeling text, valence text, reading text, confidence real, kept boolean, drop_reason text)`,
        [
          o.conversationId,
          o.userId,
          JSON.stringify(flags.map((f) => ({ at_secs: f.atSecs, quote: f.quote, cue: f.cue, feeling: f.feeling, valence: f.valence, reading: f.reading, confidence: f.confidence, kept: f.kept, drop_reason: f.dropReason }))),
        ],
      );
    }
    await finish("done", { audioBytes: audio.bytes.length, flags: flags.length, kept: flags.filter((f) => f.kept).length });
  } catch (err: any) {
    await finish("failed", { error: String(err?.message ?? err) }).catch(() => {});
    console.error("voice flags failed (non-fatal):", err?.message ?? err);
  }
}

export type ShownVoiceFlags = { at: Date; flags: Pick<VoiceFlag, "quote" | "cue" | "feeling" | "reading">[] };

// The kept flags from their latest flagged call in the last week.
export async function recentVoiceFlags(userId: string): Promise<ShownVoiceFlags | null> {
  const { rows } = await pool
    .query(
      `SELECT f.quote, f.cue, f.feeling, f.reading, f.created_at FROM voice_flags f
       WHERE f.user_id = $1 AND f.kept AND f.created_at > NOW() - ($2 || ' days')::interval
         AND f.conversation_id = (SELECT conversation_id FROM voice_flags WHERE user_id = $1 AND kept ORDER BY created_at DESC LIMIT 1)
       ORDER BY f.confidence DESC`,
      [userId, VOICE_FLAG.showDays],
    )
    .catch(() => ({ rows: [] as any[] }));
  if (!rows.length) return null;
  return { at: new Date(rows[0].created_at), flags: rows.map((r: any) => ({ quote: r.quote, cue: r.cue, feeling: r.feeling, reading: r.reading })) };
}

const CUE_WORDS: Record<VoiceCue, string> = { sigh: "sighed", forced_cheer: "sounded forced", sarcasm: "was being sarcastic", laugh: "laughed" };

// Pure: the line Co reads, next to the text read's call line.
export function renderVoiceFlags(v: ShownVoiceFlags | null, ago: string): string | null {
  if (!v?.flags.length) return null;
  const parts = v.flags.map((f) => `${CUE_WORDS[f.cue] ?? f.cue} when they said "${f.quote}" (${f.feeling})`);
  return `On your call ${ago}, their voice said more than their words: they ${parts.join("; ")}. That's one read of their tone, not something they told you: let it shape how you follow up, and never name it back to them.`;
}
