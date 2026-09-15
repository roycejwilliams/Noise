// Emotion loop (Royce, 2026-09-15: "Emotion needs to be a common loop with
// our agent, we must emphasize reasoning based off the user's emotion").
//
// One shared record of how a person has been feeling, fed from both
// channels and read by every layer that talks to them:
//
//   capture  — calls: Hume's per-utterance voice (prosody) scores, kept as
//              the strongest moments with what was said, not a whole-call
//              average. texts: one structured read per inbound message.
//   store    — emotion_signals (source, emotion, intensity, valence, what
//              it was about, when)
//   read     — getEmotionalContext: how they feel right now, how they
//              sounded on the latest call, what keeps coming up
//   reason   — the reply decides what they need (to be heard, help, or
//              lightness) from this before writing; the proactive pick
//              holds promotional texts while someone is struggling; the
//              Hume call prompt gets it too
//   guard    — Co never names the feeling back ("you sound stressed");
//              evals/emotion covers capture, the hold, and the reply
//
// Before this, Hume's scores were averaged into one list, written to a
// column nothing read, and text tone was a one-word hint that never left the
// turn it was read in.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import type { GateCheck } from "./core.js";

export type Valence = "negative" | "positive" | "mixed";
export type Intensity = "low" | "medium" | "high";

export type EmotionSignal = {
  source: "call" | "text";
  emotion: string;
  intensity: Intensity;
  valence: Valence;
  about: string | null;
  quote: string | null;
  at: Date;
};

// ---------------------------------------------------------------------------
// Capture: calls (Hume prosody)

// Hume's prosody model names. States that don't call for a different
// response (focus, calm, interest) aren't emotional moments.
const HUME_NEUTRAL = new Set([
  "Calmness", "Concentration", "Contemplation", "Interest", "Realization", "Boredom", "Determination", "Satisfaction",
]);
const HUME_NEGATIVE = new Set([
  "Anger", "Anxiety", "Awkwardness", "Contempt", "Confusion", "Disappointment", "Disapproval", "Disgust", "Distress",
  "Doubt", "Embarrassment", "Empathic Pain", "Envy", "Fear", "Guilt", "Horror", "Pain", "Sadness", "Shame", "Tiredness",
]);
const HUME_POSITIVE = new Set([
  "Admiration", "Adoration", "Aesthetic Appreciation", "Amusement", "Awe", "Craving", "Ecstasy", "Enthusiasm",
  "Entrancement", "Excitement", "Joy", "Love", "Pride", "Relief", "Romance", "Triumph", "Sympathy", "Nostalgia",
]);

// Prosody scores run 0-1 and rarely pass 0.6; below this a "top" emotion is
// noise.
export const HUME_MOMENT_MIN_SCORE = 0.3;

export type HumeUtterance = { text: string; scores: Record<string, number> };

function humeValence(name: string): Valence | null {
  if (HUME_NEUTRAL.has(name)) return null;
  if (HUME_NEGATIVE.has(name)) return "negative";
  if (HUME_POSITIVE.has(name)) return "positive";
  return "mixed";
}

function humeIntensity(score: number): Intensity {
  return score >= 0.55 ? "high" : score >= 0.4 ? "medium" : "low";
}

// The few most emotionally loaded things they said on the call: for each
// utterance its strongest non-neutral emotion, then the top moments overall,
// at most one per emotion so one feeling doesn't crowd out the rest.
export function humeMoments(utterances: HumeUtterance[], max = 3): Omit<EmotionSignal, "at" | "about">[] {
  const candidates = utterances
    .map((u) => {
      const top = Object.entries(u.scores)
        .filter(([name]) => humeValence(name) !== null)
        .sort((a, b) => b[1] - a[1])[0];
      return top && top[1] >= HUME_MOMENT_MIN_SCORE && u.text.trim().split(/\s+/).length >= 3 ? { u, name: top[0], score: top[1] } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: Omit<EmotionSignal, "at" | "about">[] = [];
  for (const c of candidates) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      source: "call",
      emotion: c.name.toLowerCase(),
      intensity: humeIntensity(c.score),
      valence: humeValence(c.name)!,
      quote: c.u.text.trim().slice(0, 140),
    });
    if (out.length >= max) break;
  }
  return out;
}

export function renderHumeMoments(moments: Omit<EmotionSignal, "at" | "about">[]): string {
  return moments.map((m) => `${m.emotion} (${m.intensity}) when they said: "${m.quote}"`).join("\n");
}

// ---------------------------------------------------------------------------
// Capture: texts

export type TextEmotion = { emotion: string; intensity: Intensity; valence: Valence; about: string | null } | null;

// Narrow structured read of one message, so Haiku. Returns null for ordinary
// neutral texts, which is most of them.
export async function readTextEmotion(message: string, recentConversation: string, functionId: string): Promise<TextEmotion> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId },
      prompt: `Read the latest text someone sent Co, with the conversation before it for context.

Recent conversation, in order:
${recentConversation.slice(-1500) || "(start of the conversation)"}

Latest message: "${message}"

Does the latest message carry a real feeling Co should respond to (for example stressed, anxious, discouraged, lonely, frustrated, excited, proud, relieved)? Use the conversation to read it correctly: "fine" after bad news isn't fine. Ignore plain logistics, greetings, and tone you aren't confident about; most messages have none. "about" uses only what they actually said, never an assumed circumstance.

Return ONLY JSON: {"emotion": "one or two words" or null, "intensity": "low" | "medium" | "high", "valence": "negative" | "positive" | "mixed", "about": "what the feeling is about, in a few words, or null"}`,
    });
    const p = parseModelJson<{ emotion: string | null; intensity?: string; valence?: string; about?: string | null }>(text);
    if (!p.emotion || typeof p.emotion !== "string") return null;
    const intensity: Intensity = p.intensity === "high" || p.intensity === "medium" ? p.intensity : "low";
    const valence: Valence = p.valence === "negative" || p.valence === "positive" ? p.valence : "mixed";
    return { emotion: p.emotion.toLowerCase().slice(0, 40), intensity, valence, about: typeof p.about === "string" ? p.about.slice(0, 80) : null };
  } catch (err: any) {
    console.error("readTextEmotion failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Store

export async function recordEmotionSignals(
  userId: string,
  signals: (Omit<EmotionSignal, "at"> & { memoryId?: string | null })[],
): Promise<void> {
  if (!signals.length) return;
  await pool
    .query(
      `INSERT INTO emotion_signals (user_id, source, emotion, intensity, valence, about, quote, memory_id)
       SELECT $1, x.source, x.emotion, x.intensity, x.valence, x.about, x.quote, x.memory_id
       FROM jsonb_to_recordset($2::jsonb) AS x(source text, emotion text, intensity text, valence text, about text, quote text, memory_id uuid)`,
      [
        userId,
        JSON.stringify(
          signals.map((s) => ({ source: s.source, emotion: s.emotion, intensity: s.intensity, valence: s.valence, about: s.about, quote: s.quote, memory_id: s.memoryId ?? null })),
        ),
      ],
    )
    .catch((err: any) => console.error("recordEmotionSignals failed (non-fatal):", err?.message ?? err));
}

// ---------------------------------------------------------------------------
// Read

export type EmotionalContext = {
  // Their latest text-read feeling in the last 6 hours, or the latest call's
  // strongest moment in the last 48 hours.
  current: EmotionSignal | null;
  lastCall: { at: Date; moments: EmotionSignal[] } | null;
  // Negative feelings that came up more than once in the last 14 days.
  recurring: { about: string; emotions: string[]; count: number }[];
  // Struggling recently enough that promotional or logistical outreach would
  // land badly: a medium/high negative signal in the last 24 hours with no
  // positive signal after it.
  needsCare: boolean;
};

const HOUR = 3600_000;

export function summarizeSignals(signals: EmotionSignal[], now: Date): EmotionalContext {
  const sorted = [...signals].sort((a, b) => b.at.getTime() - a.at.getTime());
  const age = (s: EmotionSignal) => now.getTime() - s.at.getTime();

  const latestText = sorted.find((s) => s.source === "text" && age(s) <= 6 * HOUR) ?? null;
  const calls = sorted.filter((s) => s.source === "call" && age(s) <= 7 * 24 * HOUR);
  const lastCallAt = calls[0]?.at ?? null;
  const lastCallMoments = lastCallAt ? calls.filter((s) => Math.abs(s.at.getTime() - lastCallAt.getTime()) < 10 * 60_000) : [];
  const strongestCall = [...lastCallMoments].sort((a, b) => rank(b.intensity) - rank(a.intensity))[0] ?? null;
  const current = latestText ?? (strongestCall && age(strongestCall) <= 48 * HOUR ? strongestCall : null);

  const recentNeg = sorted.find((s) => s.valence === "negative" && s.intensity !== "low" && age(s) <= 24 * HOUR);
  const positiveAfter = recentNeg ? sorted.some((s) => s.valence === "positive" && s.at > recentNeg.at) : false;

  const byTopic = new Map<string, { about: string; emotions: Set<string>; count: number }>();
  for (const s of sorted.filter((x) => x.valence === "negative" && age(x) <= 14 * 24 * HOUR && x.about)) {
    const key = s.about!.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 3).slice(0, 2).join(" ");
    if (!key) continue;
    const t = byTopic.get(key) ?? { about: s.about!, emotions: new Set<string>(), count: 0 };
    t.emotions.add(s.emotion);
    t.count++;
    byTopic.set(key, t);
  }
  const recurring = [...byTopic.values()]
    .filter((t) => t.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((t) => ({ about: t.about, emotions: [...t.emotions], count: t.count }));

  return {
    current,
    lastCall: lastCallAt ? { at: lastCallAt, moments: lastCallMoments } : null,
    recurring,
    needsCare: !!recentNeg && !positiveAfter,
  };
}

function rank(i: Intensity): number {
  return i === "high" ? 3 : i === "medium" ? 2 : 1;
}

export async function getEmotionalContext(userId: string, now = new Date()): Promise<EmotionalContext> {
  const { rows } = await pool
    .query(
      `SELECT source, emotion, intensity, valence, about, quote, created_at FROM emotion_signals
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '14 days' ORDER BY created_at DESC LIMIT 100`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return summarizeSignals(
    rows.map((r: any) => ({ source: r.source, emotion: r.emotion, intensity: r.intensity, valence: r.valence, about: r.about, quote: r.quote, at: new Date(r.created_at) })),
    now,
  );
}

function ago(at: Date, now: Date): string {
  const h = Math.round((now.getTime() - at.getTime()) / HOUR);
  if (h < 1) return "just now";
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// Plain-language block for any prompt that talks to or about this person.
// Empty when there's nothing to go on.
export function renderEmotionalContext(ctx: EmotionalContext, now = new Date()): string {
  const lines: string[] = [];
  if (ctx.current?.source === "text") {
    lines.push(`Right now (their texts, ${ago(ctx.current.at, now)}): ${ctx.current.intensity} ${ctx.current.emotion}${ctx.current.about ? ` about ${ctx.current.about}` : ""}.`);
  }
  if (ctx.lastCall?.moments.length) {
    lines.push(
      `On your call ${ago(ctx.lastCall.at, now)}, their voice showed: ${ctx.lastCall.moments
        .map((m) => `${m.emotion} (${m.intensity})${m.quote ? ` when they said "${m.quote}"` : ""}`)
        .join("; ")}.`,
    );
  }
  for (const r of ctx.recurring) lines.push(`Keeps coming up: ${r.emotions.join(", ")} about ${r.about} (${r.count} times in two weeks).`);
  if (ctx.needsCare) lines.push("They've been struggling in the last day.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Guard

// Naming or diagnosing the feeling back at them reads as clinical, not as
// someone who knows them. Show it in how you respond instead.
const EMOTION_WORDS =
  "stressed|anxious|upset|frustrated|overwhelmed|sad|angry|nervous|down|worried|exhausted|hurt|lonely|scared|discouraged|burnt out|burned out|depressed|defeated|disappointed";
const LABEL_RE = new RegExp(
  `\\b(you (sound|seem|must be|feel like you're)|you're (clearly|obviously)|i can (tell|sense|hear)( that)? you('re| are)?|it sounds like you('re| are)( feeling)?)\\s+(so |really |pretty |a bit |a little |kind of |very )?(${EMOTION_WORDS})\\b`,
  "i",
);

export function checkNoEmotionLabel(draft: string): GateCheck {
  const m = draft.match(LABEL_RE);
  return m
    ? { name: "no_emotion_label", pass: false, reason: `names their feeling back at them: "${m[0]}"` }
    : { name: "no_emotion_label", pass: true };
}
