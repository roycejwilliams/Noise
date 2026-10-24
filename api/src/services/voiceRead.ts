// The live voice read on calls (Royce approved 2026-10-23; plan: ~/cue-worktrees/voice-read-plan.md, phases 1-2).
//
// Hume's Expression Measurement realtime endpoint hears the caller's side of a call (services/mediaStreamBridge.ts) and
// scores each stretch of speech. This file is the pure part: what those scores mean, when they are strong enough to
// matter, the one line the call brain gets per turn, the few moments kept after the call, the noisy-call rule, and who
// it runs for. No I/O here.
//
// Rules it keeps (from the plan and the existing emotion loop, harness/emotion.ts):
// - A rolling read over about 30 seconds, smoothed over several windows. One window never decides anything.
// - The call brain hears about it only when the voice adds something the words don't (a flat voice under "it's fine",
//   a voice that lifts while the words make little of it). When voice and words agree, or the signal is weak: nothing.
// - The line never names a feeling. It says how they sound and what to do with it, so there is nothing for Cue to
//   repeat back ("you sound stressed" is never said; harness/emotion.ts checkNoEmotionLabel).
// - Voice shapes how, never whether: it is a supporting signal, never the only trigger for anything (see emotion.ts
//   isScoreBasis, which keeps it out of needsCare and the next-day check-in), and on a safety call it is not used.
// - Noisy or multi-voice calls: the read is ignored for the whole call (voiceCrosstalk).
// - Audio is never stored. Only a few moments are written after the call, to the member's own emotion record.
import { isCallerVoice } from "../harness/callGate.js";
import type { EmotionSignal, Intensity, Valence } from "../harness/emotion.js";
import { isTestNumber, testNumbersEnabled } from "./testNumbers.js";

// ---------------------------------------------------------------- what Hume sends, as we keep it

export type HumeScore = { name: string; probability: number };
// One measurement.result: a window of up to 10s of one utterance, measured every 3s of speech.
export type VoiceWindow = {
  utteranceId: number;
  startMs: number; // audio_start_ms, from the start of the audio we sent
  endMs: number;
  receivedAt: number; // wall clock (ms) when the score arrived
  expressions: HumeScore[];
  voiceAttributes: HumeScore[];
};

// ---------------------------------------------------------------- what the scores mean

// Five ways a voice can say something on a call, each from Hume's own names (expression-measurement docs, audio
// measurements: 415 expressions, 190 voice attributes; a name is only present when it passed Hume's cutoff).
export type VoiceDim = "flat" | "tight" | "low" | "sharp" | "bright";
export const VOICE_DIMS: VoiceDim[] = ["flat", "tight", "low", "sharp", "bright"];
export const DIM_NAMES: Record<VoiceDim, { expressions: string[]; voice: string[] }> = {
  flat: {
    expressions: ["tiredness", "weariness", "fatigue", "exhaustion", "apathy", "low spirits", "feeling empty", "feeling worn out", "feeling dull", "sense of inertia", "boredom", "disinterest"],
    voice: ["flat", "monotone", "droning", "dull", "lifeless", "tired", "worn"],
  },
  tight: {
    expressions: ["strain", "stress", "anxiety", "worry", "nervousness", "distress", "feeling overwhelmed", "agitation", "restlessness", "dread", "feeling apprehensive"],
    voice: ["nervous", "hesitant", "stuttering", "rushed", "timid", "faint"],
  },
  low: {
    expressions: ["sadness", "sorrow", "melancholy", "gloom", "despair", "dejection", "despondency", "unhappiness", "hopelessness", "feeling downhearted", "feeling disheartened", "disappointment", "defeat", "discouragement", "feeling let down"],
    voice: ["muffled", "soft-spoken", "mumbling"],
  },
  sharp: {
    expressions: ["anger", "frustration", "impatience", "feeling irritable", "displeasure", "indignation", "crankiness", "grumpiness", "hostility"],
    voice: ["harsh", "abrasive", "gruff", "grating", "argumentative"],
  },
  bright: {
    expressions: ["excitement", "enthusiasm", "eagerness", "elation", "joy", "happiness", "delight", "high spirits", "exuberance", "feeling lively", "anticipation"],
    voice: ["bright", "upbeat", "animated", "energetic", "enthusiastic", "lively", "cheerful", "bubbly", "peppy", "spirited"],
  },
};

// The starting bar, to be tuned on the phase 3 test calls (it is a guess until then, on purpose a high one).
export const VOICE_READ = {
  spanMs: 30_000, // the rolling read covers the last ~30s of their speech
  minWindows: 3, // never one window: at least 3 measurements (~9s of speech) before anything is said
  bar: 0.6, // the smoothed score a dimension needs
  presentAt: 0.5, // a window "has" a dimension at this score...
  presentShare: 0.6, // ...and this share of the windows in the span must have it (steady, not one spike)
  staleMs: 45_000, // a read older than this (wall clock) says nothing about now
  momentMinWindows: 2, // an after-call moment is an utterance with at least 2 windows
  highAt: 0.75,
  maxMoments: 2,
};

// Pure: each dimension's score in one window (the strongest of its names; absent names are 0).
export function windowDims(w: Pick<VoiceWindow, "expressions" | "voiceAttributes">): Record<VoiceDim, number> {
  const ex = new Map((w.expressions ?? []).map((s) => [String(s.name).toLowerCase(), Number(s.probability) || 0]));
  const va = new Map((w.voiceAttributes ?? []).map((s) => [String(s.name).toLowerCase(), Number(s.probability) || 0]));
  const out = {} as Record<VoiceDim, number>;
  for (const d of VOICE_DIMS) {
    out[d] = Math.max(0, ...DIM_NAMES[d].expressions.map((n) => ex.get(n) ?? 0), ...DIM_NAMES[d].voice.map((n) => va.get(n) ?? 0));
  }
  return out;
}

export type SmoothedRead = { windows: number; dims: Record<VoiceDim, number>; strongest: VoiceDim | null; score: number };

// Pure: windows smoothed (the mean per dimension; a window without it counts as 0), and the one dimension, if any, that is
// strong (over the bar) and steady (present in most windows). Needs at least `minWindows`.
export function smooth(windows: Pick<VoiceWindow, "expressions" | "voiceAttributes">[], minWindows: number, opts = VOICE_READ): SmoothedRead {
  const per = windows.map(windowDims);
  const dims = {} as Record<VoiceDim, number>;
  for (const d of VOICE_DIMS) dims[d] = per.length ? per.reduce((a, p) => a + p[d], 0) / per.length : 0;
  if (per.length < minWindows) return { windows: per.length, dims, strongest: null, score: 0 };
  let strongest: VoiceDim | null = null;
  for (const d of VOICE_DIMS) {
    const steady = per.filter((p) => p[d] >= opts.presentAt).length / per.length >= opts.presentShare;
    if (dims[d] >= opts.bar && steady && (!strongest || dims[d] > dims[strongest])) strongest = d;
  }
  return { windows: per.length, dims, strongest, score: strongest ? dims[strongest] : 0 };
}

// Pure: the rolling read: the windows in the last `spanMs` of their speech, smoothed. Nothing when the newest score is stale.
export function rollingRead(windows: VoiceWindow[], now: number, opts = VOICE_READ): SmoothedRead {
  const empty = smooth([], opts.minWindows, opts);
  if (!windows.length) return empty;
  const latest = windows.reduce((a, w) => (w.endMs > a.endMs ? w : a), windows[0]);
  if (now - latest.receivedAt > opts.staleMs) return empty;
  return smooth(windows.filter((w) => w.endMs >= latest.endMs - opts.spanMs), opts.minWindows, opts);
}

// ---------------------------------------------------------------- their words

export type WordsTone = "positive" | "negative" | "neutral";
const NEG_WORDS = /\b(?:not (?:good|great|okay|ok|fine|well|really)|bad|awful|terrible|horrible|hard|rough|tough|stress\w*|tired|exhausted|drained|sad|upset|angry|mad|frustrat\w*|annoy\w*|irritat\w*|worried|anxious|nervous|scared|afraid|hate|sucks?|struggl\w*|overwhelm\w*|ugh|miserable|lonely|depress\w*|burn(?:ed|t) out|can'?t (?:do|deal|handle|take)|falling apart|messed up|a mess|crap|shit\w*)\b/i;
const POS_WORDS = /\b(?:fine|good|great|okay|ok|alright|all right|all good|totally|excited|love|loving|awesome|perfect|amazing|wonderful|fantastic|no worries|happy|glad|not bad|doing well|can'?t wait|sounds good)\b/i;

// Pure: the plain tone of what they said (a negative word wins over a positive one: "fine, just tired" is not upbeat).
export function wordsTone(text: string): WordsTone {
  const t = String(text ?? "");
  if (NEG_WORDS.test(t.replace(/\bnot (?:too |that |so )?bad\b/gi, "fine"))) return "negative";
  if (POS_WORDS.test(t)) return "positive";
  return "neutral";
}

// Whether the voice says the same as the words (then the words already carry it and the voice adds nothing).
const agrees = (d: VoiceDim, w: WordsTone): boolean => (d === "bright" ? w === "positive" : w === "negative");
// A true mismatch: the voice says the opposite of the words.
const opposes = (d: VoiceDim, w: WordsTone): boolean => (d === "bright" ? w === "negative" : w === "positive");

// ---------------------------------------------------------------- the line for the call brain

// What the call brain is told. Voice words only (flat, tight, quiet, an edge, lifts) and what to do: no feeling is named,
// so there is nothing to say back. The lead says it is never to be mentioned.
export const VOICE_LINE_LEAD = "How they sound right now, from their voice (never mention or hint that you can hear this, and never describe their voice to them):";
const LINES: Record<VoiceDim, { mismatch: string; neutral: string }> = {
  flat: {
    mismatch: "their voice has gone flat while the words stay positive. Don't take the upbeat words at face value: take it slower, leave room, and ask one open question rather than moving on.",
    neutral: "their voice has gone flat and slow. Go easy on asks and give them room.",
  },
  tight: {
    mismatch: "their voice is tight and quick while the words say it's fine. Don't rush past it: keep your reply short and calm, and let them lead.",
    neutral: "their voice has tightened. Keep your reply short and calm, and let them lead.",
  },
  low: {
    mismatch: "their voice is low and quiet while the words stay positive. Be gentle: one open question, no agenda.",
    neutral: "their voice is low and quiet. Be gentle and unhurried.",
  },
  sharp: {
    mismatch: "their voice has an edge the words don't. Get to the point, no padding.",
    neutral: "their voice has an edge. Get to the point, no padding.",
  },
  bright: {
    mismatch: "their voice lifts while the words make little of it. This matters to them: stay on it and let them tell you more.",
    neutral: "their voice lifts on this. It matters to them: stay with it a little longer.",
  },
};

export type LineDecision = { line: string | null; dim: VoiceDim | null; mismatch: boolean; why: string };

// Pure: the one line for this turn, or nothing. `turnWords` is what they said this turn.
export function voiceLine(read: SmoothedRead, turnWords: string, o: { noisy: boolean; safety: boolean }): LineDecision {
  if (o.safety) return { line: null, dim: null, mismatch: false, why: "safety call: voice is never used" };
  if (o.noisy) return { line: null, dim: null, mismatch: false, why: "noisy call: voice ignored" };
  if (!read.strongest) return { line: null, dim: null, mismatch: false, why: read.windows < VOICE_READ.minWindows ? "not enough windows yet" : "nothing strong" };
  const tone = wordsTone(turnWords);
  if (agrees(read.strongest, tone)) return { line: null, dim: read.strongest, mismatch: false, why: "the words already say it" };
  const mismatch = opposes(read.strongest, tone);
  const l = LINES[read.strongest];
  return { line: `${VOICE_LINE_LEAD} ${mismatch ? l.mismatch : l.neutral}`, dim: read.strongest, mismatch, why: mismatch ? "voice and words disagree" : "voice adds to neutral words" };
}

// ---------------------------------------------------------------- noisy or multi-voice calls

// The rule (fact-based, from what the call already records):
//   1. A caller line that is a recording, not a person (harness/callGate.ts isCallerVoice: an announcement or voicemail-style
//      prompt on their side) means something else is speaking on their line.
//   2. Hume hears more speech on their line than their own transcribed words account for: at least 20s of speech heard
//      and under 0.8 of their words per second of it (one person talking runs ~2-3 words a second). Other voices, a TV,
//      or Cue's own voice coming back through a speakerphone all show up this way.
// Either one: the voice read is ignored for the whole call (live and after). Hume's v1 realtime endpoint has no speaker
// separation (none in its docs), so this can't keep only the caller's voice; it drops the read instead.
export const CROSSTALK = { minHeardMs: 20_000, minWordsPerSec: 0.8 };
export function voiceCrosstalk(o: { heardSpeechMs: number; callerLines: string[] }, opts = CROSSTALK): { noisy: boolean; why: string | null } {
  const lines = o.callerLines.map((l) => String(l ?? "").trim()).filter((l) => /[a-z]/i.test(l));
  if (lines.some((l) => !isCallerVoice(l))) return { noisy: true, why: "a recording or announcement on their line" };
  const words = lines.join(" ").split(/\s+/).filter(Boolean).length;
  if (o.heardSpeechMs >= opts.minHeardMs && words / (o.heardSpeechMs / 1000) < opts.minWordsPerSec) {
    return { noisy: true, why: `more speech on their line than their words account for (${words} words in ${Math.round(o.heardSpeechMs / 1000)}s)` };
  }
  return { noisy: false, why: null };
}

// ---------------------------------------------------------------- after the call: the few strong moments

export type CallerTurn = { atSecs: number | null; text: string; before?: string | null };
// Pure: the caller's own lines from ElevenLabs' post-call turns, with when they started. Cue's line just before each is
// kept only as `before`, context for the after-call judge; it is never a quote and never stored (Cue's lines can name
// other people).
export function callerTurnsFrom(turns: unknown): CallerTurn[] {
  if (!Array.isArray(turns)) return [];
  const out: CallerTurn[] = [];
  let lastCue: string | null = null;
  for (const t of turns as any[]) {
    if (typeof t?.message !== "string" || !t.message.trim()) continue;
    if (t?.role === "user") out.push({ atSecs: typeof t.time_in_call_secs === "number" ? t.time_in_call_secs : null, text: String(t.message), before: lastCue });
    else lastCue = String(t.message).trim().slice(0, 240);
  }
  return out;
}
const MOMENT_LABEL: Record<VoiceDim, { emotion: string; valence: Valence; mismatch: string }> = {
  flat: { emotion: "flat", valence: "negative", mismatch: "flat under upbeat words" },
  tight: { emotion: "tense", valence: "negative", mismatch: "tense under upbeat words" },
  low: { emotion: "low", valence: "negative", mismatch: "low under upbeat words" },
  sharp: { emotion: "irritated", valence: "negative", mismatch: "an edge under easy words" },
  bright: { emotion: "lit up", valence: "positive", mismatch: "lit up, more than the words let on" },
};

// Pure: the caller's own line nearest an utterance's start (ElevenLabs' time_in_call_secs and Hume's audio time both count
// from the call connecting), within 6 seconds. Only the caller's lines are ever given: Cue's lines can name other people.
export function quoteFor(startMs: number, turns: CallerTurn[], withinMs = 6000): CallerTurn | null {
  let best: CallerTurn | null = null;
  let gap = Infinity;
  for (const t of turns) {
    if (t.atSecs == null || !t.text.trim()) continue;
    const g = Math.abs(t.atSecs * 1000 - startMs);
    if (g <= withinMs && g < gap) { best = t; gap = g; }
  }
  return best;
}

// ---- the after-call judge (Royce, 2026-10-23: a clean slot for Jev here, not on the live per-turn path)
//
// Every utterance with at least two windows is a candidate; one judge decides which to keep, in ONE batched call per call
// (the Jev gateway is rate-limited). The default is the rule bar above (no model, $0). JEV SEAM: a Jev-backed judge plugs in
// with setVoiceMomentJudge: one askJevZdr request (services/jevGateway.ts, zero data retention) with one boolean question
// per candidate, p as Jev's probability against JEV_SURE, falling back to RULE_JUDGE on null, like readTextSignals. It is
// not wired: nothing here calls Jev. Which judge decided each kept moment is logged, so phase 3 can compare rule vs Jev on
// the same calls. The live per-turn line stays rule-based (voiceLine).
export type VoiceMomentCandidate = {
  startSec: number;
  endSec: number;
  scores: Partial<Record<VoiceDim, number>>; // the top dimensions only (smoothed over the utterance's windows)
  callerText: string | null; // their own words at that moment
  contextLine: string | null; // Cue's line just before (context for the judge only, never stored)
};
export type VoiceJudgement = { keep: boolean; kind: "mismatch" | "strain" | "lift" | "noise"; p: number; why: string };
export type VoiceMomentJudge = { name: string; judge: (moments: VoiceMomentCandidate[]) => Promise<VoiceJudgement[]> };

type Candidate = VoiceMomentCandidate & { read: SmoothedRead; turn: CallerTurn | null };

// Pure: every utterance with enough windows, as the judge sees it.
function momentCandidates(windows: VoiceWindow[], callerTurns: CallerTurn[], opts = VOICE_READ): Candidate[] {
  const byUtt = new Map<number, VoiceWindow[]>();
  for (const w of windows) byUtt.set(w.utteranceId, [...(byUtt.get(w.utteranceId) ?? []), w]);
  const out: Candidate[] = [];
  for (const ws of byUtt.values()) {
    if (ws.length < opts.momentMinWindows) continue;
    const read = smooth(ws, opts.momentMinWindows, opts);
    const startMs = Math.min(...ws.map((w) => w.startMs));
    const endMs = Math.max(...ws.map((w) => w.endMs));
    const top = [...VOICE_DIMS].sort((a, b) => read.dims[b] - read.dims[a]).slice(0, 2).filter((d) => read.dims[d] > 0);
    const turn = quoteFor(startMs, callerTurns);
    out.push({ startSec: startMs / 1000, endSec: endMs / 1000, scores: Object.fromEntries(top.map((d) => [d, Math.round(read.dims[d] * 1000) / 1000])), callerText: turn ? turn.text.trim() : null, contextLine: turn?.before ?? null, read, turn });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

// Pure: the rule bar as a judgement: strong and steady, and saying something the words don't.
function ruleJudgement(c: Pick<Candidate, "read" | "callerText">): VoiceJudgement {
  const d = c.read.strongest;
  if (!d) return { keep: false, kind: "noise", p: c.read.score, why: "under the bar or not steady" };
  const tone = c.callerText ? wordsTone(c.callerText) : "neutral";
  if (agrees(d, tone)) return { keep: false, kind: d === "bright" ? "lift" : "strain", p: c.read.score, why: "the words already say it" };
  if (opposes(d, tone)) return { keep: true, kind: "mismatch", p: c.read.score, why: "voice and words disagree" };
  return { keep: true, kind: d === "bright" ? "lift" : "strain", p: c.read.score, why: "voice adds to neutral words" };
}
export const RULE_JUDGE: VoiceMomentJudge = {
  name: "rule",
  judge: async (moments) => moments.map((m) => ruleJudgement(m as Candidate)),
};
let currentJudge: VoiceMomentJudge = RULE_JUDGE;
export const voiceMomentJudge = (): VoiceMomentJudge => currentJudge;
// The seam: a Jev-backed judge (or a test's fake) replaces the rule here; null restores the rule.
export function setVoiceMomentJudge(j: VoiceMomentJudge | null): void {
  currentJudge = j ?? RULE_JUDGE;
}

export type VoiceMoment = Omit<EmotionSignal, "at"> & { dim: VoiceDim; mismatch: boolean; score: number; judge: string; kind: VoiceJudgement["kind"]; p: number };

function toMoment(c: Candidate, j: VoiceJudgement, judge: string): VoiceMoment | null {
  const dim = c.read.strongest ?? ([...VOICE_DIMS].sort((a, b) => c.read.dims[b] - c.read.dims[a])[0] as VoiceDim);
  if (!j.keep || !(c.read.dims[dim] > 0)) return null;
  const mismatch = j.kind === "mismatch";
  const label = MOMENT_LABEL[dim];
  const score = c.read.dims[dim];
  const intensity: Intensity = score >= VOICE_READ.highAt ? "high" : "medium";
  return { source: "call", emotion: mismatch ? label.mismatch : label.emotion, intensity, valence: label.valence, about: null, quote: c.callerText ? c.callerText.slice(0, 140) : null, target: "life", basis: "voice", dim, mismatch, score, judge, kind: j.kind, p: j.p };
}
const keepOrder = (ms: VoiceMoment[], max: number) => ms.sort((a, b) => Number(b.mismatch) - Number(a.mismatch) || b.score - a.score).slice(0, max);

// Pure (the rule): at most two moments where the voice said something the words didn't, mismatches first, then strength.
export function voiceMoments(windows: VoiceWindow[], callerTurns: CallerTurn[], opts = VOICE_READ): VoiceMoment[] {
  const cs = momentCandidates(windows, callerTurns, opts);
  return keepOrder(cs.map((c) => toMoment(c, ruleJudgement(c), RULE_JUDGE.name)).filter((m): m is VoiceMoment => !!m), opts.maxMoments);
}

// The after-call path: one judge call for all of the call's candidates. A judge that fails, or answers the wrong number of
// moments, falls back to the rule (logged as "rule (fallback from <name>)").
export async function judgeVoiceMoments(windows: VoiceWindow[], callerTurns: CallerTurn[], judge: VoiceMomentJudge = currentJudge, opts = VOICE_READ): Promise<{ moments: VoiceMoment[]; judgedBy: string; candidates: number }> {
  const cs = momentCandidates(windows, callerTurns, opts);
  if (!cs.length) return { moments: [], judgedBy: judge.name, candidates: 0 };
  let judgedBy = judge.name;
  let js: VoiceJudgement[] | null = null;
  try {
    const got = await judge.judge(cs.map(({ startSec, endSec, scores, callerText, contextLine }) => ({ startSec, endSec, scores, callerText, contextLine })));
    js = Array.isArray(got) && got.length === cs.length ? got : null;
  } catch {
    js = null;
  }
  if (!js) { js = cs.map(ruleJudgement); judgedBy = judge === RULE_JUDGE ? RULE_JUDGE.name : `rule (fallback from ${judge.name})`; }
  const moments = cs.map((c, i) => toMoment(c, js![i], judgedBy)).filter((m): m is VoiceMoment => !!m);
  return { moments: keepOrder(moments, opts.maxMoments), judgedBy, candidates: cs.length };
}

// The rows as recordEmotionSignals takes them (nothing else from the read goes to the database).
export const momentSignals = (m: VoiceMoment[]): Omit<EmotionSignal, "at">[] => m.map(({ dim, mismatch, score, judge, kind, p, ...s }) => (void dim, void mismatch, void score, void judge, void kind, void p, s));

// ---------------------------------------------------------------- who it runs for

// No switch (Royce: gate on what the feature needs). It needs the Hume key, a public URL for Twilio to stream to, and
// Twilio's auth token to check the stream's signature (voiceReadPrereqs), and runs only off production. Who: a test
// member (a 555-01xx number, services/testNumbers.ts), or a member who agreed to it, one by one (users.voice_read_ok,
// default false; nobody is opted in by code, review of #269). Being on the team is not consent.
export function voiceReadPrereqs(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.HUME_API_KEY && !!env.API_URL && !!env.TWILIO_AUTH && testNumbersEnabled(env);
}
export function voiceReadAllowed(o: { memberPhone: unknown; consented: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!voiceReadPrereqs(env)) return false;
  return isTestNumber(o.memberPhone, env) || o.consented === true;
}

// ---------------------------------------------------------------- the fork in the call's TwiML

export const VOICE_STREAM_PATH = "/co/voice-stream";
export const VOICE_STREAM_NAME = "cue-voice-read";
const xmlAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The wss:// URL Twilio streams to, from API_URL (https://host -> wss://host/co/voice-stream). Null when there is none.
export function voiceStreamUrl(apiUrl: string | undefined): string | null {
  if (!apiUrl) return null;
  try {
    const u = new URL(apiUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}${u.pathname.replace(/\/+$/, "")}${VOICE_STREAM_PATH}`;
  } catch {
    return null;
  }
}

// Pure: ElevenLabs' TwiML with a listen-only fork of the caller's audio added before it. <Start><Stream> is unidirectional
// and non-blocking (Twilio starts it and goes straight on to ElevenLabs' <Connect><Stream>); track="inbound_track" is the
// caller only. The call's own verbs are untouched; anything we can't place the fork in comes back exactly as it was.
// The fork carries one opaque, one-time stream id (services/voiceStreamLink.ts): never the member's id or the call token,
// since Twilio keeps the TwiML in its logs.
export function withVoiceFork(twiml: string, o: { streamUrl: string; streamId: string }): string {
  const open = /<Response(?:\s[^>]*)?>/.exec(twiml);
  if (!open || /\/>$/.test(open[0])) return twiml;
  const fork =
    `<Start><Stream name="${VOICE_STREAM_NAME}" url="${xmlAttr(o.streamUrl)}" track="inbound_track">` +
    `<Parameter name="stream" value="${xmlAttr(o.streamId)}"/>` +
    `</Stream></Start>`;
  const at = open.index + open[0].length;
  return twiml.slice(0, at) + fork + twiml.slice(at);
}

// ---------------------------------------------------------------- the session log

export type VoiceSessionStats = {
  callSid: string | null;
  streamSid: string | null;
  humeSessionId: string | null;
  startedAt: number;
  humeOpenMs: number | null; // from the stream starting to Hume's session ready
  framesIn: number; // Twilio media frames received
  framesSent: number; // frames sent to Hume
  framesDropped: number; // dropped (Hume not ready past the buffer, rate-limited, or closed)
  audioSentMs: number;
  windows: number;
  utterances: number;
  heardSpeechMs: number;
  latencies: number[]; // ms from the end of a window's audio being sent to its score arriving
  linesOffered: number; // turns that got a line
  passed: Partial<Record<VoiceDim, number>>; // turns where each dimension passed the bar
  noisy: string | null;
  error: string | null;
  closedBy: string | null;
};
export const newSessionStats = (now = Date.now()): VoiceSessionStats => ({ callSid: null, streamSid: null, humeSessionId: null, startedAt: now, humeOpenMs: null, framesIn: 0, framesSent: 0, framesDropped: 0, audioSentMs: 0, windows: 0, utterances: 0, heardSpeechMs: 0, latencies: [], linesOffered: 0, passed: {}, noisy: null, error: null, closedBy: null });

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// Pure: what is logged for a session. Ids, timings, counts and which signals passed the bar; never audio, never their words.
export function sessionSummary(s: VoiceSessionStats, now = Date.now()) {
  return {
    callSid: s.callSid,
    streamSid: s.streamSid,
    humeSessionId: s.humeSessionId,
    totalMs: now - s.startedAt,
    humeOpenMs: s.humeOpenMs,
    framesIn: s.framesIn,
    framesSent: s.framesSent,
    framesDropped: s.framesDropped,
    audioSentSecs: Math.round(s.audioSentMs / 100) / 10,
    windows: s.windows,
    utterances: s.utterances,
    heardSpeechSecs: Math.round(s.heardSpeechMs / 100) / 10,
    readLatencyMs: { p50: pct(s.latencies, 50), p90: pct(s.latencies, 90), max: s.latencies.length ? Math.max(...s.latencies) : null, n: s.latencies.length },
    linesOffered: s.linesOffered,
    passed: s.passed,
    noisy: s.noisy,
    error: s.error,
    closedBy: s.closedBy,
  };
}
