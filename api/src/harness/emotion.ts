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
import { JEV_SURE, noteRaceOutcome, raceWithJev, readTextSignals } from "../services/jevGateway.js";

export type Valence = "negative" | "positive" | "mixed";
export type Intensity = "low" | "medium" | "high";

// Who a feeling is about. "co": Co itself (what it found or didn't, its
// replies, speed, mistakes). "life": everything else. Frustration with Co was
// being read as someone struggling, which held back the very events they were
// frustrated about not getting (2026-09-18).
export type EmotionTarget = "co" | "life";

export type EmotionSignal = {
  source: "call" | "text";
  emotion: string;
  intensity: Intensity;
  valence: Valence;
  about: string | null;
  quote: string | null;
  at: Date;
  // Absent on signals recorded before the target existed; see signalTarget.
  target?: EmotionTarget | null;
};

// Signals from before target was recorded are classified from what they
// were about. Calls are always about their life (voice prosody can't tell).
const ABOUT_CO = /\bco\b|\bco's\b|\bsearch|\bresults?\b|recommend|suggestion|surfac|\bsweep|contact card|\bleads\b|not finding|\breply\b|\breplies\b|\bresponse\b/i;
export function signalTarget(s: Pick<EmotionSignal, "source" | "about" | "target">): EmotionTarget {
  if (s.target === "co" || s.target === "life") return s.target;
  if (s.source === "call") return "life";
  return s.about && ABOUT_CO.test(s.about) ? "co" : "life";
}

// ---------------------------------------------------------------------------
// Capture: texts

export type TextEmotion = { emotion: string; intensity: Intensity; valence: Valence; about: string | null; target: EmotionTarget } | null;

// Narrow structured read of one message, so Haiku. Returns null for ordinary
// neutral texts, which is most of them.
// Jev (zero data retention) races Haiku (services/jevGateway.ts): a sure "no
// real feeling" (most texts) answers at once and cancels Haiku; otherwise
// Haiku names the feeling.

export async function readTextEmotion(message: string, recentConversation: string, functionId: string): Promise<TextEmotion> {
  const jevSure = readTextSignals(message, recentConversation).then((j) => (j && j.feeling <= JEV_SURE.no ? { value: null } : null));
  const { value, from } = await raceWithJev<TextEmotion>(jevSure, (abortSignal) => haikuTextEmotion(message, recentConversation, functionId, abortSignal));
  noteRaceOutcome(message, recentConversation, "feeling", from, value !== null);
  return value;
}

async function haikuTextEmotion(message: string, recentConversation: string, functionId: string, abortSignal: AbortSignal): Promise<TextEmotion> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      abortSignal,
      experimental_telemetry: { isEnabled: true, functionId },
      prompt: `Read the latest text someone sent Co, with the conversation before it for context.

Recent conversation, in order:
${recentConversation.slice(-1500) || "(start of the conversation)"}

Latest message: "${message}"

Does the latest message carry a real feeling Co should respond to (for example stressed, anxious, discouraged, lonely, frustrated, excited, proud, relieved)? Use the conversation to read it correctly: "fine" after bad news isn't fine. Ignore plain logistics, greetings, and tone you aren't confident about; most messages have none. "about" uses only what they actually said, never an assumed circumstance.

"target" is who the feeling is about: "co" when it's about Co itself (what Co found or didn't find, Co's suggestions, replies, speed, or mistakes, like "you keep finding nothing" or "that's not what I asked"), otherwise "life" (their work, people, plans, health, anything else).

Return ONLY JSON: {"emotion": "one or two words" or null, "intensity": "low" | "medium" | "high", "valence": "negative" | "positive" | "mixed", "about": "what the feeling is about, in a few words, or null", "target": "co" | "life"}`,
    });
    const p = parseModelJson<{ emotion: string | null; intensity?: string; valence?: string; about?: string | null; target?: string }>(text);
    if (!p.emotion || typeof p.emotion !== "string") return null;
    const intensity: Intensity = p.intensity === "high" || p.intensity === "medium" ? p.intensity : "low";
    const valence: Valence = p.valence === "negative" || p.valence === "positive" ? p.valence : "mixed";
    const about = typeof p.about === "string" ? p.about.slice(0, 80) : null;
    const target: EmotionTarget = p.target === "co" || p.target === "life" ? p.target : signalTarget({ source: "text", about, target: null });
    return { emotion: p.emotion.toLowerCase().slice(0, 40), intensity, valence, about, target };
  } catch (err: any) {
    if (!abortSignal.aborted) console.error("readTextEmotion failed (non-fatal):", err?.message ?? err);
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
      `INSERT INTO emotion_signals (user_id, source, emotion, intensity, valence, about, quote, memory_id, target)
       SELECT $1, x.source, x.emotion, x.intensity, x.valence, x.about, x.quote, x.memory_id, x.target
       FROM jsonb_to_recordset($2::jsonb) AS x(source text, emotion text, intensity text, valence text, about text, quote text, memory_id uuid, target text)`,
      [
        userId,
        JSON.stringify(
          signals.map((s) => ({ source: s.source, emotion: s.emotion, intensity: s.intensity, valence: s.valence, about: s.about, quote: s.quote, memory_id: s.memoryId ?? null, target: signalTarget(s) })),
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
  // Struggling in their life recently: a medium/high negative signal about
  // their life in the last 24 hours with no positive signal after it. Shapes
  // how Co talks and which rooms it picks; never whether they get one.
  needsCare: boolean;
  // Frustrated with Co itself in the last 48 hours (what it has or hasn't
  // found, its replies). Makes Co search wider and try harder; not a hard day.
  withCo: { frustrated: boolean; about: string | null; count: number };
};

const HOUR = 3600_000;

export function summarizeSignals(allSignals: EmotionSignal[], now: Date): EmotionalContext {
  const all = [...allSignals].sort((a, b) => b.at.getTime() - a.at.getTime());
  const sorted = all.filter((s) => signalTarget(s) === "life");
  const aboutCo = all.filter((s) => signalTarget(s) === "co");
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

  const coNeg = aboutCo.filter((s) => s.valence === "negative" && s.intensity !== "low" && age(s) <= 48 * HOUR);
  const coPositiveAfter = coNeg.length ? aboutCo.some((s) => s.valence === "positive" && s.at > coNeg[0].at) : false;

  return {
    current,
    lastCall: lastCallAt ? { at: lastCallAt, moments: lastCallMoments } : null,
    recurring,
    needsCare: !!recentNeg && !positiveAfter,
    withCo: { frustrated: coNeg.length > 0 && !coPositiveAfter, about: coNeg[0]?.about ?? null, count: coNeg.length },
  };
}

// What kind of room would suit how they've been, from feelings about their
// life only. Orders search results (the ask still decides what's eligible),
// so a hard stretch changes which rooms Co picks, not whether it picks one.
const ROOM_FOR_FEELING: { re: RegExp; room: string }[] = [
  { re: /burn|drain|exhaust|tired|overwhelm|stress|swamp|spent|fried/, room: "small, low-key, relaxed gatherings, not big networking events" },
  { re: /lonel|isolat|disconnect|left out|alone|new (?:to|in) (?:the )?city|moved/, room: "recurring community gatherings where people get to know each other, over one-off networking" },
  { re: /anx|worr|stuck|nervous|uncertain|discourag|rejected|doubt/, room: "rooms with people who've been through the same thing and can help" },
  { re: /excit|proud|thrill|hopeful|energi|pumped/, room: "rooms that build on what's going well for them" },
];

export function roomPreferenceFromFeelings(ctx: EmotionalContext): string | null {
  const life = [ctx.current, ...(ctx.lastCall?.moments ?? [])].filter((s): s is EmotionSignal => !!s && s.intensity !== "low");
  const recurring = ctx.recurring.flatMap((r) => r.emotions.map((emotion) => ({ emotion, about: r.about })));
  const pool = [...life.map((s) => ({ emotion: s.emotion, about: s.about })), ...recurring];
  for (const { re, room } of ROOM_FOR_FEELING) {
    const hit = pool.find((p) => re.test(`${p.emotion} ${p.about ?? ""}`.toLowerCase()));
    if (hit) return `Right now, ${room}${hit.about ? ` (they've been feeling ${hit.emotion} about ${hit.about})` : ""}.`;
  }
  return null;
}

function rank(i: Intensity): number {
  return i === "high" ? 3 : i === "medium" ? 2 : 1;
}

export async function getEmotionalContext(userId: string, now = new Date()): Promise<EmotionalContext> {
  const { rows } = await pool
    .query(
      `SELECT source, emotion, intensity, valence, about, quote, created_at, target FROM emotion_signals
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '14 days' ORDER BY created_at DESC LIMIT 100`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return summarizeSignals(
    rows.map((r: any) => ({ source: r.source, emotion: r.emotion, intensity: r.intensity, valence: r.valence, about: r.about, quote: r.quote, at: new Date(r.created_at), target: r.target ?? null })),
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
  // A low-intensity read ("low clarifying") is noise in a prompt; only show
  // feelings strong enough to change how Co should respond.
  if (ctx.current?.source === "text" && ctx.current.intensity !== "low") {
    lines.push(`Right now (their texts, ${ago(ctx.current.at, now)}): ${ctx.current.intensity} ${ctx.current.emotion}${ctx.current.about ? ` about ${ctx.current.about}` : ""}.`);
  }
  if (ctx.lastCall?.moments.some((m) => m.intensity !== "low")) {
    lines.push(
      `On your call ${ago(ctx.lastCall.at, now)}, their voice showed: ${ctx.lastCall.moments
        .filter((m) => m.intensity !== "low")
        .map((m) => `${m.emotion} (${m.intensity})${m.quote ? ` when they said "${m.quote}"` : ""}`)
        .join("; ")}.`,
    );
  }
  for (const r of ctx.recurring) lines.push(`Keeps coming up: ${r.emotions.join(", ")} about ${r.about} (${r.count} times in two weeks).`);
  if (ctx.needsCare) lines.push("They've been struggling in the last day.");
  if (ctx.withCo?.frustrated) {
    lines.push(
      `They're frustrated with what Co has turned up lately${ctx.withCo.about ? ` (${ctx.withCo.about})` : ""}. That's about Co, not a hard day in their life: look wider and try harder rather than going quiet or getting smaller.`,
    );
  }
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
