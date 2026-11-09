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
import { LAST_CALL_MOMENTS_HEADER } from "../services/callMomentsLine.js";

export type Valence = "negative" | "positive" | "mixed";
export type Intensity = "low" | "medium" | "high";

// Who a feeling is about. "co": Co itself (what it found or didn't, its
// replies, speed, mistakes). "life": everything else. Frustration with Co was
// being read as someone struggling, which held back the very events they were
// frustrated about not getting (2026-09-18).
export type EmotionTarget = "co" | "life";

// What a read understood beyond the word (Royce, 2026-11-09: a calm call working through a business decision read as three medium
// negative feelings and held his finds and offers for up to 48 hours: "understanding, not a stronger word list"). The model judges all
// of it; code never reads the words.
//   readKind "distress": they're hurting or not coping. "concern": they're working something through and holding steady (a decision,
//            a risk, a person, a practical or business worry). "unsure": the model can't tell which; never hard on its own.
//            "settled": their own word that they're okay or just thinking ("I'm fine, just thinking"): it corrects an earlier read
//            (summarizeSignals), and is set only by says_okay, never chosen as a kind. Distress always wins over says_okay: "I'm fine,
//            I just don't see the point of anything" stays distress (review of #430). Their word clears a medium distress read before it,
//            never a high one (summarizeSignals).
//   feltBy   "member", or "other" when they're describing someone else's feeling.
//   framing  "own" (they feel it now), "quoted" (recounted or repeated), "hypothetical" (an if).
// Only distress that is the member's own, felt now, is a hard read (isHardRead). Every read keeps its intensity and valence, so tone
// still sees a concern; renderEmotionalContext hands the nuance on to whatever decides a message.
// Null on rows from before these existed, and when the model gave none: see isHardRead.
export type EmotionKind = "distress" | "concern" | "unsure" | "settled";
export type FeltBy = "member" | "other";
export type Framing = "own" | "quoted" | "hypothetical";
export const parseEmotionKind = (v: unknown): EmotionKind | null => (v === "distress" || v === "concern" || v === "unsure" || v === "settled" ? v : null);
export const parseFeltBy = (v: unknown): FeltBy | null => (v === "member" || v === "other" ? v : null);
export const parseFraming = (v: unknown): Framing | null => (v === "own" || v === "quoted" || v === "hypothetical" ? v : null);
// Model-facing, shared word for word by both reads that produce emotion_signals: the text turn (services/readTurn.ts) and a call's
// lines (haikuTextEmotion below).
export const EMOTION_READ_GUIDE = `For a feeling, read who feels it and how, not just the word:
"felt_by": "member" when it's their own feeling (their worry for someone else is theirs too), "other" when they're describing what someone else feels ("my co-founder is panicking").
"framing": "own" when they feel it now, "quoted" when they're recounting or repeating it ("she said I seemed stressed", "I was a wreck last year"), "hypothetical" when it's an if ("I'd be crushed if it fell through").
"kind", for a negative or mixed feeling: "distress" when they're hurting or not coping (grief, overwhelm, feeling low or hopeless, panic, being hurt, a crisis, a struggle that has gone on for a while); "concern" when they're working something through and holding steady (weighing a decision or a risk, unsure about a person, a plan or a deal, a practical or business worry); "unsure" when you can't tell which. Judge how they're holding up, not how big the stakes are: "the deal could sink the company, but I've got a plan" is concern; "I haven't slept in days and I can't stop crying" is distress. Anything about their safety is distress. null when the feeling is positive.
"says_okay" (beside "emotion", even when "emotion" is null): true when the latest message tells Cue they're okay, not upset, or just thinking it through ("I'm fine, just thinking", "honestly I'm not stressed about it"), even if they still name a worry, and you believe them; "fine" after bad news, or "I'm fine" with signs they aren't ("I'm fine, I just can't see why I'd bother anymore"), is false, and that message's kind is distress. Otherwise false.`;
// Pure: the read's base fields plus what it understood (EMOTION_READ_GUIDE). raw: the model's emotion object; saysOkay: its says_okay.
// Their word that they're okay makes the read "settled" (a read with no feeling becomes a low "okay" one, so the correction is kept),
// unless the model read distress: then it stays distress, whatever they said about being fine.
export function withReadFields(base: NonNullable<TextEmotion> | null, raw: any, saysOkay: unknown): TextEmotion {
  const okay = saysOkay === true;
  if (!base) return okay ? { emotion: "okay", intensity: "low", valence: "mixed", about: null, target: "life", readKind: "settled", feltBy: "member", framing: "own" } : null;
  const modelKind = raw?.kind === "distress" || raw?.kind === "concern" || raw?.kind === "unsure" ? (raw.kind as EmotionKind) : null;
  const kind: EmotionKind | null = modelKind === "distress" && base.valence !== "positive" ? "distress" : okay && base.target === "life" ? "settled" : base.valence === "positive" ? null : modelKind;
  return { ...base, readKind: kind, feltBy: parseFeltBy(raw?.felt_by), framing: parseFraming(raw?.framing) };
}

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
  // What the read understood (EmotionKind above). Absent on rows from before them.
  readKind?: EmotionKind | null;
  feltBy?: FeltBy | null;
  framing?: Framing | null;
  // Where a signal came from when it isn't a model's read of what they said:
  // "frustration_score" is ElevenLabs' per-line score (frustrationMoments);
  // "voice" is Hume's read of how they sounded (services/voiceRead.ts
  // voiceMoments). Absent on everything else.
  basis?: "frustration_score" | "voice" | null;
};

// A score of how they sounded, not a read of what they said. Supporting only:
// it shows in the call's moments (tone, timing), but never marks a hard day,
// starts a check-in, or clears one on its own (the plan's safety rule: voice
// is never the sole trigger, and never used to dismiss serious words).
export const isScoreBasis = (basis: EmotionSignal["basis"] | undefined): boolean => basis === "frustration_score" || basis === "voice";

// Signals from before target was recorded are classified from what they
// were about. Calls are always about their life (voice prosody can't tell).
const ABOUT_CO = /\bco\b|\bco's\b|\bsearch|\bresults?\b|recommend|suggestion|surfac|\bsweep|contact card|\bleads\b|not finding|\breply\b|\breplies\b|\bresponse\b/i;
export function signalTarget(s: Pick<EmotionSignal, "source" | "about" | "target">): EmotionTarget {
  if (s.target === "co" || s.target === "life") return s.target;
  if (s.source === "call") return "life";
  // "Cue" only as the name: "missed my cue" is their life.
  return s.about && (ABOUT_CO.test(s.about) || /\bCue\b(?!\s+up\b)/.test(s.about)) ? "co" : "life";
}

// ---------------------------------------------------------------------------
// Capture: texts

export type TextEmotion = { emotion: string; intensity: Intensity; valence: Valence; about: string | null; target: EmotionTarget; readKind?: EmotionKind | null; feltBy?: FeltBy | null; framing?: Framing | null } | null;

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

// A call's line, read by Haiku alone: Jev's sure "no feeling" would cancel the read before it could hear "I'm fine, just thinking"
// (says_okay), the line that corrects the call's earlier reads. After the call, so the race's speed buys nothing; Haiku already ran on
// every line the race read (it is started, then cancelled).
export function readCallLineEmotion(message: string, recentConversation: string, functionId: string): Promise<TextEmotion> {
  return haikuTextEmotion(message, recentConversation, functionId, new AbortController().signal);
}

async function haikuTextEmotion(message: string, recentConversation: string, functionId: string, abortSignal: AbortSignal): Promise<TextEmotion> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      abortSignal,
      experimental_telemetry: { isEnabled: true, functionId },
      prompt: `Read the latest text someone sent Cue, with the conversation before it for context.

Recent conversation, in order:
${recentConversation.slice(-1500) || "(start of the conversation)"}

Latest message: "${message}"

Does the latest message carry a real feeling Cue should respond to (for example stressed, anxious, discouraged, lonely, frustrated, excited, proud, relieved)? Use the conversation to read it correctly: "fine" after bad news isn't fine. Ignore plain logistics, greetings, and tone you aren't confident about; most messages have none. "about" uses only what they actually said, never an assumed circumstance.

"target" is who the feeling is about: "co" when it's about Cue itself (what Cue found or didn't find, Cue's suggestions, replies, speed, or mistakes, like "you keep finding nothing" or "that's not what I asked"), otherwise "life" (their work, people, plans, health, anything else).

${EMOTION_READ_GUIDE}

Return ONLY JSON: {"emotion": "one or two words" or null, "intensity": "low" | "medium" | "high", "valence": "negative" | "positive" | "mixed", "about": "what the feeling is about, in a few words, or null", "target": "co" | "life", "felt_by": "member" | "other", "framing": "own" | "quoted" | "hypothetical", "kind": "distress" | "concern" | "unsure" | null, "says_okay": true | false}`,
    });
    const p = parseModelJson<{ emotion: string | null; intensity?: string; valence?: string; about?: string | null; target?: string; felt_by?: string; framing?: string; kind?: string | null; says_okay?: boolean }>(text);
    if (!p.emotion || typeof p.emotion !== "string") return withReadFields(null, p, p.says_okay);
    const intensity: Intensity = p.intensity === "high" || p.intensity === "medium" ? p.intensity : "low";
    const valence: Valence = p.valence === "negative" || p.valence === "positive" ? p.valence : "mixed";
    const about = typeof p.about === "string" ? p.about.slice(0, 80) : null;
    const target: EmotionTarget = p.target === "co" || p.target === "life" ? p.target : signalTarget({ source: "text", about, target: null });
    return withReadFields({ emotion: p.emotion.toLowerCase().slice(0, 40), intensity, valence, about, target }, p, p.says_okay);
  } catch (err: any) {
    if (!abortSignal.aborted) console.error("readTextEmotion failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capture: calls (read from what they said)
//
// Calls used to bring Hume's voice scores. ElevenLabs sends none, so a call's
// feelings are read from the member's own lines with the text read's prompt (readCallLineEmotion: the
// labels, intensity and target the text turn's read uses), each
// with the lines before it for context. Words only: tone isn't heard (the
// voice-layer pilot is looking at that). Only longer lines are read (a short
// "yeah" has no feeling to name, and each read is a model call), the strongest
// few are kept, at most one per emotion so one feeling doesn't crowd out the
// rest, and they're recorded as source "call" so the loop treats them as it
// treated Hume's moments.
export const CALL_EMOTION_MIN_WORDS = 3;
export const CALL_EMOTION_MAX_READS = 30;
export const CALL_EMOTION_MAX_MOMENTS = 3;

type CallLine = { index: number; text: string; context: string };

// Pure: the member's lines worth reading, longest first (capped), each with the
// few lines before it.
export function callLinesToRead(transcript: string, max = CALL_EMOTION_MAX_READS): CallLine[] {
  const lines = transcript
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^user:/i.test(l) ? { who: "Them", text: l.replace(/^user:\s*/i, "") } : { who: "Cue", text: l.replace(/^assistant:\s*/i, "") }));
  const out: CallLine[] = [];
  lines.forEach((l, i) => {
    if (l.who !== "Them" || l.text.split(/\s+/).filter(Boolean).length < CALL_EMOTION_MIN_WORDS) return;
    out.push({ index: i, text: l.text, context: lines.slice(Math.max(0, i - 6), i).map((c) => `${c.who}: ${c.text}`).join("\n") });
  });
  return out
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);
}

// The call's feeling moments, strongest first. read is injectable for tests.
export async function callEmotionMoments(
  transcript: string,
  read: (message: string, recentConversation: string, functionId: string) => Promise<TextEmotion> = readCallLineEmotion,
  opts: { max?: number; concurrency?: number } = {},
): Promise<Omit<EmotionSignal, "at">[]> {
  const todo = callLinesToRead(transcript);
  const found: { sig: Omit<EmotionSignal, "at">; order: number }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const l = todo[next++];
      const e = await read(l.text, l.context, "call.readTextEmotion").catch(() => null);
      if (e) found.push({ order: l.index, sig: { source: "call", emotion: e.emotion, intensity: e.intensity, valence: e.valence, about: e.about, target: e.target, readKind: e.readKind ?? null, feltBy: e.feltBy ?? null, framing: e.framing ?? null, quote: l.text.slice(0, 140) } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 5, todo.length) }, worker));
  const seen = new Set<string>();
  const out: Omit<EmotionSignal, "at">[] = [];
  // Their word on the call that they're okay ("my gut's calm", "I'm fine, just thinking") is kept beside the strongest moments, outside
  // the cap, when it came after every worry read on the call: a call's lines land together, so it then corrects them (summarizeSignals).
  const lastWorry = Math.max(-1, ...found.filter((f) => f.sig.readKind !== "settled" && f.sig.valence === "negative" && f.sig.intensity !== "low").map((f) => f.order));
  const settled = found.filter((f) => f.sig.readKind === "settled" && f.order > lastWorry).sort((a, b) => b.order - a.order)[0] ?? null;
  for (const f of found.sort((a, b) => rank(b.sig.intensity) - rank(a.sig.intensity) || a.order - b.order)) {
    if (f.sig.readKind === "settled") continue;
    if (seen.has(f.sig.emotion)) continue;
    seen.add(f.sig.emotion);
    out.push(f.sig);
    if (out.length >= (opts.max ?? CALL_EMOTION_MAX_MOMENTS)) break;
  }
  if (settled) out.push(settled.sig);
  return out;
}

// ---------------------------------------------------------------------------
// Capture: calls (ElevenLabs' frustration score)
//
// ElevenLabs scores each thing the caller says for frustration (Royce,
// 2026-10-04: "catching 'that's just perfect' at 0.4-0.6 is exactly the signal
// that matters"). It reads the words too (the same words acted sad or happy
// scored the same, evals/voice-emotion-pilot), but it catches frustration the
// text read misses on a line, e.g. sarcasm. Kept beside the text read, never in
// place of it: a line the text read already found a negative feeling on isn't
// counted twice. Free: it comes with the call.
export const CALL_FRUSTRATION = { min: 0.4, high: 0.6, maxMoments: 2 };
export type ScoredLine = { text: string; frustration: number };

// Pure: the caller's lines with ElevenLabs' frustration score.
export function frustrationScores(turns: unknown): ScoredLine[] {
  if (!Array.isArray(turns)) return [];
  return turns
    .filter((t: any) => t?.role === "user" && typeof t?.message === "string" && t.message.trim() && typeof t?.analysis?.user_frustration_score === "number")
    .map((t: any) => ({ text: t.message.trim(), frustration: t.analysis.user_frustration_score as number }));
}

const lineWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
function sameLine(a: string, b: string): boolean {
  const A = lineWords(a);
  const B = new Set(lineWords(b));
  if (!A.length || !B.size) return false;
  return A.filter((w) => B.has(w)).length / Math.min(A.length, B.size) >= 0.6;
}

// Pure: the frustrated moments to add beside the text read's: sure enough,
// not a line the text read already called negative, strongest first.
export function frustrationMoments(scored: ScoredLine[], textRead: Pick<EmotionSignal, "valence" | "quote">[]): Omit<EmotionSignal, "at">[] {
  return scored
    .filter((l) => l.frustration >= CALL_FRUSTRATION.min)
    .filter((l) => !textRead.some((m) => m.valence === "negative" && m.quote && sameLine(m.quote, l.text)))
    .sort((a, b) => b.frustration - a.frustration)
    .slice(0, CALL_FRUSTRATION.maxMoments)
    .map((l) => ({ source: "call" as const, emotion: "frustrated", intensity: l.frustration >= CALL_FRUSTRATION.high ? ("high" as const) : ("medium" as const), valence: "negative" as const, about: null, quote: l.text.slice(0, 140), basis: "frustration_score" as const }));
}

// ---------------------------------------------------------------------------
// Store

// A voice-read row (basis "voice") never lands once they've said no or taken their yes back, decided in the insert itself, so a stop
// racing a call's post-call write keeps nothing: the stop writes the withdrawal before it deletes (services/voiceReadConsent.ts).
export async function recordEmotionSignals(
  userId: string,
  signals: (Omit<EmotionSignal, "at"> & { memoryId?: string | null })[],
): Promise<void> {
  if (!signals.length) return;
  await pool
    .query(
      `INSERT INTO emotion_signals (user_id, source, emotion, intensity, valence, about, quote, memory_id, target, read_kind, felt_by, framing, basis)
       SELECT $1, x.source, x.emotion, x.intensity, x.valence, x.about, x.quote, x.memory_id, x.target, x.read_kind, x.felt_by, x.framing, x.basis
       FROM jsonb_to_recordset($2::jsonb) AS x(source text, emotion text, intensity text, valence text, about text, quote text, memory_id uuid, target text, read_kind text, felt_by text, framing text, basis text)
       WHERE x.basis IS DISTINCT FROM 'voice'
          OR NOT EXISTS (SELECT 1 FROM voice_read_consents c WHERE c.user_id = $1 AND (c.answer = 'no' OR c.withdrawn_at IS NOT NULL))`,
      [
        userId,
        JSON.stringify(
          signals.map((s) => ({ source: s.source, emotion: s.emotion, intensity: s.intensity, valence: s.valence, about: s.about, quote: s.quote, memory_id: s.memoryId ?? null, target: signalTarget(s), read_kind: parseEmotionKind(s.readKind), felt_by: parseFeltBy(s.feltBy), framing: parseFraming(s.framing), basis: s.basis ?? null })),
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
  // Struggling in their life recently: a hard read about their life (isHardRead: their own distress, felt now) in the last 24 hours
  // with no positive read after it, and no word from them since that they're okay (kind "settled"). Shapes how Co talks and which
  // rooms it picks; never whether they get one.
  needsCare: boolean;
  // When needsCare: the hard read that holds it (the latest isHardRead one about their life), and when the hard stretch it
  // belongs to began (the earliest hard read linked to it by gaps of at most a day, with no positive read between). Timestamps only.
  // The holds that wait on a hard day read them (services/moodHold.ts: okay again, and the cap).
  hardAt?: Date | null;
  hardSince?: Date | null;
  // They told Cue they're okay or just thinking it through (a "settled" read) after a negative read in the last day: their word
  // corrects the inference. When, or null.
  saidOkayAt?: Date | null;
  // Frustrated with Co itself in the last 48 hours (what it has or hasn't
  // found, its replies). Makes Co search wider and try harder; not a hard day.
  withCo: { frustrated: boolean; about: string | null; count: number; at?: Date | null; reads?: Date[] };
};

const HOUR = 3600_000;
// How far back a text's feeling still counts as how they feel right now (current, below; services/moodHold.ts reads it too).
export const RIGHT_NOW_HOURS = 6;

export function summarizeSignals(allSignals: EmotionSignal[], now: Date): EmotionalContext {
  const all = [...allSignals].sort((a, b) => b.at.getTime() - a.at.getTime());
  const sorted = all.filter((s) => signalTarget(s) === "life");
  const aboutCo = all.filter((s) => signalTarget(s) === "co");
  const age = (s: EmotionSignal) => now.getTime() - s.at.getTime();

  const latestText = sorted.find((s) => s.source === "text" && age(s) <= RIGHT_NOW_HOURS * HOUR) ?? null;
  const calls = sorted.filter((s) => s.source === "call" && age(s) <= 7 * 24 * HOUR);
  const lastCallAt = calls[0]?.at ?? null;
  const lastCallMoments = lastCallAt ? calls.filter((s) => Math.abs(s.at.getTime() - lastCallAt.getTime()) < 10 * 60_000) : [];
  // A score of how they sounded (isScoreBasis) stays in lastCall.moments for tone, but is never their "current" feeling:
  // current feeds heavyMoment (replyGrounding.ts), which holds the door, the cold-start question and doc offers (review of #269).
  const strongestCall = lastCallMoments.filter((s) => !isScoreBasis(s.basis)).sort((a, b) => rank(b.intensity) - rank(a.intensity))[0] ?? null;
  const current = latestText ?? (strongestCall && age(strongestCall) <= 48 * HOUR ? strongestCall : null);

  // A frustration score alone doesn't mark a hard day: it can't tell frustration
  // with Co from frustration with life, and needsCare holds some check-ins
  // (review of #61). Co still sees it as a call moment, with their words.
  // Nor does a concern they're working through, someone else's feeling, a recounted or hypothetical one, or an unsure read: isHardRead.
  // Their own word since that they're okay (a settled read at or after it; a call's lines land together, and a call keeps a settled
  // line only when it came after the call's worries, callEmotionMoments) corrects a medium distress read, never a high one: a high
  // distress read the same day stands whatever they say after it (review of #430).
  const corrected = (h: EmotionSignal) => h.intensity !== "high" && sorted.some((s) => s !== h && s.readKind === "settled" && s.at >= h.at);
  const recentNeg = sorted.find((s) => isHardRead(s) && age(s) <= 24 * HOUR && !corrected(s));
  const positiveAfter = recentNeg ? sorted.some((s) => s.valence === "positive" && !isScoreBasis(s.basis) && s.at > recentNeg.at) : false;
  const saidOkay = sorted.find((s) => s.readKind === "settled" && age(s) <= 24 * HOUR && sorted.some((n) => n !== s && n.valence === "negative" && n.intensity !== "low" && !isScoreBasis(n.basis) && n.at <= s.at && age(n) <= 24 * HOUR));
  // The hard stretch recentNeg belongs to (hardStretchSince). getEmotionalContext reads it again from its own window, so a member with
  // more than a hundred reads in it still reaches the cap.
  const hardSince = recentNeg && !positiveAfter ? hardStretchSince(sorted, recentNeg.at) : null;

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
    hardAt: recentNeg && !positiveAfter ? recentNeg.at : null,
    hardSince: recentNeg && !positiveAfter ? hardSince : null,
    // Only when it left no hard read standing: "take their word" never sits beside a high distress read it couldn't clear.
    saidOkayAt: recentNeg && !positiveAfter ? null : saidOkay?.at ?? null,
    // at: the latest frustration read; reads: every one in the window, newest first (timestamps only; services/moodHold.ts, the
    // frustration hold's one capped wait).
    withCo: { frustrated: coNeg.length > 0 && !coPositiveAfter, about: coNeg[0]?.about ?? null, count: coNeg.length, at: coNeg[0]?.at ?? null, reads: aboutCo.filter((s) => s.valence === "negative" && s.intensity !== "low").map((s) => s.at) },
  };
}

// A hard read: a medium or high negative feeling about their life that the model judged distress, their own and felt now (EmotionKind).
// Never a concern they're working through (at any intensity), an unsure read, someone else's feeling, or a recounted or hypothetical
// one: the model's read decides, never the words. A score of how they sounded alone never is one (isScoreBasis). No kind (rows from
// before it existed, or a read the model left without one): only a high one counts, so the old medium reads that held calm
// deliberation stop, and a strong one still counts.
// Safety is not here: a crisis or self-harm line is held by services/safety.ts on the words themselves, whatever any read says.
export function isHardRead(s: Pick<EmotionSignal, "valence" | "intensity" | "basis" | "readKind" | "feltBy" | "framing">): boolean {
  if (s.valence !== "negative" || s.intensity === "low" || isScoreBasis(s.basis)) return false;
  if (s.feltBy === "other" || s.framing === "quoted" || s.framing === "hypothetical") return false;
  const kind = parseEmotionKind(s.readKind);
  if (kind) return kind === "distress";
  return s.intensity === "high";
}
const isHard = isHardRead;
// Pure: when the hard stretch ending at hardAt began: back through hard reads at most a day apart, stopping at a positive read between
// two. lifeSignals: their reads about their life, any order.
export function hardStretchSince(lifeSignals: Pick<EmotionSignal, "valence" | "intensity" | "basis" | "readKind" | "feltBy" | "framing" | "at">[], hardAt: Date): Date {
  const desc = [...lifeSignals].sort((a, b) => b.at.getTime() - a.at.getTime());
  let since = hardAt;
  for (const s of desc.filter((x) => isHard(x) && x.at < hardAt)) {
    const later = since;
    // A voice score never breaks a stretch either (voice never dismisses what they said).
    // Their word that they were okay between two breaks it too.
    if (later.getTime() - s.at.getTime() > 24 * HOUR || desc.some((p) => (p.readKind === "settled" || (p.valence === "positive" && !isScoreBasis(p.basis))) && p.at > s.at && p.at < later)) break;
    since = s.at;
  }
  return since;
}
// How far back the stretch's own read looks: past the cap (48h, services/moodHold.ts) plus a day's gap, so a stretch that began before
// it reads as at least the cap.
export const STRETCH_LOOKBACK_HOURS = 96;

function rank(i: Intensity): number {
  return i === "high" ? 3 : i === "medium" ? 2 : 1;
}

// Their words in an emotion read (about, quote) through the forget guard (services/whatCoKnows.ts): words a removal or correction
// touches are left out, and the feeling's labels (emotion, intensity, valence, when) stay, so timing and tone still read the hard day.
// Nothing here deletes (forget-delete-spec.md row 24 waits on Royce). forgotten null: the guard couldn't be read, so every word is left
// out (fails closed). Context-sources review, 2026-10-27: emotion_signals had no forget guard on any reader.
export function guardSignalWords<T extends { about?: unknown; quote?: unknown }>(rows: T[], forgotten: import("../services/whatCoKnows.js").ForgottenRow[] | null, guardText: (text: string, rows: any[]) => string | null): T[] {
  const keep = (x: unknown) => {
    if (x == null || String(x).trim() === "") return x ?? null;
    if (!forgotten) return null;
    return guardText(String(x), forgotten) === String(x) ? x : null;
  };
  return rows.map((r) => ("about" in r || "quote" in r ? { ...r, ...("about" in r ? { about: keep(r.about) } : {}), ...("quote" in r ? { quote: keep(r.quote) } : {}) } : r));
}
// The same, reading their removals (q: a replay's own reader).
export async function forgetGuardedSignals<T extends { about?: unknown; quote?: unknown }>(userId: string, rows: T[], q?: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> }): Promise<T[]> {
  if (!rows.some((r) => (r.about != null && String(r.about).trim()) || (r.quote != null && String(r.quote).trim()))) return rows;
  const W = await import("../services/whatCoKnows.js").catch(() => null);
  const forgotten = W ? await W.forgottenRows(userId, q).catch(() => null) : null;
  return guardSignalWords(rows, forgotten, W ? W.guardText : () => null);
}

export async function getEmotionalContext(userId: string, now = new Date()): Promise<EmotionalContext> {
  const { rows } = await pool
    .query(
      `SELECT source, emotion, intensity, valence, about, quote, created_at, read_kind, felt_by, framing, target, basis FROM emotion_signals
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '14 days' ORDER BY created_at DESC LIMIT 100`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  const guarded = await forgetGuardedSignals(userId, rows);
  const summary = summarizeSignals(
    guarded.map((r: any) => ({ source: r.source, emotion: r.emotion, intensity: r.intensity, valence: r.valence, about: r.about, quote: r.quote, at: new Date(r.created_at), target: r.target ?? null, readKind: parseEmotionKind(r.read_kind), feltBy: parseFeltBy(r.felt_by), framing: parseFraming(r.framing), basis: r.basis ?? null })),
    now,
  );
  // The stretch's start from its own read (review of #253: the newest hundred reads alone could hold a heavy texter's stretch under the
  // cap forever): every hard or positive read in the lookback, timestamps and labels only, no words.
  if (summary.hardAt) {
    const { rows: stretch } = await pool
      .query(
        `SELECT source, intensity, valence, read_kind, felt_by, framing, about, target, basis, created_at FROM emotion_signals
         WHERE user_id = $1 AND created_at > $2::timestamptz - make_interval(hours => $3) AND created_at <= $2::timestamptz
           AND (basis IS NULL OR basis NOT IN ('frustration_score', 'voice'))
           AND (valence = 'positive' OR read_kind = 'settled' OR (valence = 'negative' AND intensity <> 'low'))
         ORDER BY created_at DESC LIMIT 5000`,
        [userId, now.toISOString(), STRETCH_LOOKBACK_HOURS],
      )
      .catch(() => ({ rows: [] as any[] }));
    const life = stretch
      .map((r: any) => ({ source: r.source, intensity: r.intensity, valence: r.valence, readKind: parseEmotionKind(r.read_kind), feltBy: parseFeltBy(r.felt_by), framing: parseFraming(r.framing), about: r.about, target: r.target ?? null, basis: r.basis ?? null, at: new Date(r.created_at) }))
      .filter((s: any) => signalTarget(s) === "life");
    if (life.length) {
      const since = hardStretchSince(life, summary.hardAt);
      if (!summary.hardSince || since < summary.hardSince) summary.hardSince = since;
    }
  }
  return summary;
}

function ago(at: Date, now: Date): string {
  const h = Math.round((now.getTime() - at.getTime()) / HOUR);
  if (h < 1) return "just now";
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// Pure: what the read understood, for a prompt (model-facing). Empty for a row without it, so older reads render as before.
export function readNote(s: Pick<EmotionSignal, "readKind" | "feltBy" | "framing">): string {
  const parts: string[] = [];
  if (s.feltBy === "other") parts.push("someone they described, not them");
  if (s.framing === "quoted") parts.push("recounted, not how they feel now");
  else if (s.framing === "hypothetical") parts.push("an if, not something happening");
  const k = parseEmotionKind(s.readKind);
  if (k === "distress") parts.push("distress");
  else if (k === "concern") parts.push("working it through, holding steady");
  else if (k === "unsure") parts.push("unclear whether it's distress");
  else if (k === "settled") parts.push("they said they're okay");
  return parts.length ? ` [${parts.join("; ")}]` : "";
}

// Plain-language block for any prompt that talks to or about this person.
// Empty when there's nothing to go on.
export function renderEmotionalContext(ctx: EmotionalContext, now = new Date()): string {
  const lines: string[] = [];
  // A low-intensity read ("low clarifying") is noise in a prompt; only show
  // feelings strong enough to change how Co should respond.
  if (ctx.current?.source === "text" && ctx.current.intensity !== "low") {
    lines.push(`Right now (read from their texts, ${ago(ctx.current.at, now)}): ${ctx.current.intensity} ${ctx.current.emotion}${ctx.current.about ? ` about ${ctx.current.about}` : ""}${readNote(ctx.current)}.`);
  }
  if (ctx.lastCall?.moments.some((m) => m.intensity !== "low")) {
    lines.push(
      `On your call ${ago(ctx.lastCall.at, now)}, ${LAST_CALL_MOMENTS_HEADER} ${ctx.lastCall.moments
        .filter((m) => m.intensity !== "low")
        .map((m) => `${m.emotion} (${m.intensity})${m.quote ? ` when they said "${m.quote}"` : ""}${readNote(m)}`)
        .join("; ")}.`,
    );
  }
  for (const r of ctx.recurring) lines.push(`Keeps coming up: ${r.emotions.join(", ")} about ${r.about} (${r.count} times in two weeks).`);
  if (ctx.needsCare) lines.push("The last day's reads point to a hard time.");
  if (ctx.saidOkayAt) lines.push(`They told Cue ${ago(ctx.saidOkayAt, now)} that they're okay or just thinking it through: take their word over the earlier read.`);
  if (ctx.withCo?.frustrated) {
    lines.push(
      `Reads suggest they're frustrated with what Cue has turned up lately${ctx.withCo.about ? ` (${ctx.withCo.about})` : ""}. If so, that's about Cue, not a hard day in their life: look wider and try harder rather than going quiet or getting smaller.`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Guard

// Naming or diagnosing the feeling back at them reads as clinical, not as
// someone who knows them. Show it in how you respond instead.
const EMOTION_WORDS =
  "stressed|anxious|upset|frustrated|overwhelmed|sad|angry|nervous|down|worried|exhausted|hurt|lonely|scared|discouraged|burnt out|burned out|depressed|defeated|disappointed|annoyed|irritated|tired|drained|furious|miserable";
const LABEL_RE = new RegExp(
  `\\b(you (sound|seem|must be|feel like you're)|you're (clearly|obviously)|i can (tell|sense|hear)( that)? you('re| are)?|(?:it )?sounds like you('re| are)( feeling)?|i (?:hear|notice|sense) (?:that )?you('re| are)( feeling)?)\\s+(so |really |pretty |a bit |a little |kind of |very )?(${EMOTION_WORDS})\\b`,
  "i",
);

// The noun form, telling them what Co hears or notices in them (Royce,
// 2026-10-04: a call said "I'm hearing frustration there"; Co never tells
// members what they feel).
//
// Two strengths, because they do different jobs. The text gate drops a whole
// sentence, and "I hear" is also hearsay ("I hear the excitement around
// Friday's show is real", "I hear grief groups meet Tuesdays", review of #64),
// so it only takes the forms that are about the person: "I'm hearing
// frustration", "I can hear/sense/feel some sadness", "there's tension in your
// voice", with the noun standing alone (not followed by about/around/for/is...).
// The call audit and the simulation only log, so they also take the plain "I
// hear / sense / notice the exhaustion underneath that".
const EMOTION_NOUNS =
  "frustration|stress|anxiety|sadness|anger|tension|hurt|disappointment|exhaustion|worry|nervousness|fear|loneliness|grief|excitement|resentment|irritation|annoyance|defeat|overwhelm|pain|heaviness|sarcasm|bitterness|weariness|tiredness|discouragement|dread";
const QUAL = "(?:(?:some|a lot of|real|a little|a bit of|so much|quite a bit of|a ton of) )*";
const NOT_ABOUT = "(?!\\s+(?:about|around|between|for|of|from|among|over|at|points|is|are|was|were|in the|in this|in that (?:room|plan|schedule|crowd)))";
const NOUN_LABEL_RE = new RegExp(
  `\\b(?:(?:i'?m|i am) (?:hearing|sensing|picking up(?: on)?|noticing|detecting)|i can (?:hear|sense|feel))\\s+${QUAL}(?:${EMOTION_NOUNS})\\b${NOT_ABOUT}|\\b(?:there's|there is) ${QUAL}(?:${EMOTION_NOUNS}) in your (?:voice|tone|words)\\b(?! (?:note|memo|message|text|email|reply))`,
  "i",
);
const CALL_NOUN_LABEL_RE = new RegExp(`\\b(?:i'?m|i am) (?:hearing|sensing|picking up(?: on)?|noticing|detecting)\\s+(?:the |that |a |an )?${QUAL}(?:${EMOTION_NOUNS})\\b|\\bi (?:can )?(?:hear|sense|notice|detect|feel)\\s+(?:the |that |a |an )?${QUAL}(?:${EMOTION_NOUNS})\\b|\\bthere's ${QUAL}(?:${EMOTION_NOUNS}) there\\b`, "i");

export function checkNoEmotionLabel(draft: string): GateCheck {
  const m = draft.match(LABEL_RE) ?? draft.match(NOUN_LABEL_RE);
  return m
    ? { name: "no_emotion_label", pass: false, reason: `names their feeling back at them: "${m[0]}"` }
    : { name: "no_emotion_label", pass: true };
}

// The same check for what Co says on a call, which is only logged: it also
// takes the plain "I hear the exhaustion underneath that".
export function checkNoEmotionLabelOnCall(line: string): GateCheck {
  const m = line.match(LABEL_RE) ?? line.match(NOUN_LABEL_RE) ?? line.match(CALL_NOUN_LABEL_RE);
  return m
    ? { name: "no_emotion_label", pass: false, reason: `names their feeling back at them: "${m[0]}"` }
    : { name: "no_emotion_label", pass: true };
}
