// Jev in shadow, reading FEELING (2026-10-29). It began as routing labels next
// to the Sonnet read (Royce, 2026-09-28: "Couldn't we use jev to start
// labeling what function it needs to go to?"); a month of jev.shadow.turn rows
// (674) showed Jev fast (~319ms vs ~3.6s) but sure enough to take over routing
// on under 1% of texts, and it missed plain greetings. Royce, 2026-10-28: "I do
// think jev could help, if not don't force it." So the routing questions are
// gone and Jev is asked how the text FEELS instead, to see whether it's good
// enough to shape Cue's tone later.
//
// DECISION DATE: review on 2026-11-12 -- promote (let it feed tone) or drop
// (delete this file and its call in routes/sendblue.ts).
//
// Logged only (jev.shadow.feeling). Nothing here reaches a prompt, a reply or a
// decision: routes/sendblue.ts starts it next to the read and hands it to
// logJevShadow without awaiting it. No message text is stored, only Jev's
// probabilities and the Sonnet read's own labels (closed sets, booleans).
// Member text goes to Jev only through the zero-retention gateway, and only
// when JEV_MEMBER=on (services/jevGateway.ts).
import { recordDecision } from "../harness/core.js";
import { askJevZdr, jevForMemberText, type JevBool } from "./jevGateway.js";
import type { TurnRead } from "./readTurn.js";

// Bump when a question's wording changes, so rows from different wordings aren't compared as one.
export const JEV_FEELING_VERSION = "feeling-1";

// One request, every question (the gateway rate-limits requests, not questions).
// Each is a Noul: the probability that the answer is yes. Playful and serious are
// two questions, not one scale: a single yes/no near 0.5 means "unsure", not
// "neutral", and plain logistics is neither playful nor serious.
export const JEV_FEELING_QUESTIONS = {
  hopeful: {
    type: "boolean",
    instructions: "Does `latest_message` sound hopeful or excited about something?",
    criteria: {
      true: "Looking forward to something, energized, optimistic about where something is going, or glad about news.",
      false: "Neutral, logistics, flat, tired, worried, or a polite \"sounds good\" with no real lift.",
    },
  },
  drained: {
    type: "boolean",
    instructions: "Does `latest_message` sound tired, stretched thin, or drained?",
    criteria: {
      true: "Worn out, overloaded, too much on their plate, running on empty, short on sleep or energy, even if said lightly.",
      false: "Busy but fine, neutral, upbeat, or just brief.",
    },
  },
  playful: {
    type: "boolean",
    instructions: "Is `latest_message` playful in tone?",
    criteria: {
      true: "Joking, teasing, banter, wordplay, a laugh, light irony.",
      false: "Plain, earnest, or serious, even if friendly.",
    },
  },
  serious: {
    type: "boolean",
    instructions: "Is `latest_message` serious in tone?",
    criteria: {
      true: "Earnest about something that matters to them: a worry, a decision, a loss, a real ask, or a correction they mean.",
      false: "Joking, light chat, quick logistics, or a casual acknowledgment.",
    },
  },
  wants_heard: {
    type: "boolean",
    instructions: "In `latest_message`, does the person mainly want to be listened to, venting or sharing how something feels?",
    criteria: {
      true: "Venting, unloading, or sharing a feeling or a story, where a good reply listens and reflects rather than fixes.",
      false: "Asking for advice, an answer, or help doing or finding something; logistics; or a quick acknowledgment.",
    },
  },
  wants_advice: {
    type: "boolean",
    instructions: "In `latest_message`, does the person want advice or help from Cue: an answer, a view on what to do, or something done or found?",
    criteria: {
      true: "A real question, weighing options and asking what to do, stuck on a decision, or asking Cue to find, draft, or do something.",
      false: "Venting, sharing news, reacting, or closing the exchange.",
    },
  },
  complete: {
    type: "boolean",
    instructions: "With `latest_message`, is the exchange complete, so it needs nothing more back from Cue?",
    criteria: {
      true: "Thanks, ok, sounds good, a laugh, a sign-off, or an acknowledgment that closes what `co_last_message` said.",
      false: "A question, new news, a feeling worth answering, a request, or a correction.",
    },
  },
} satisfies Record<string, JevBool>;

export type JevFeeling = Record<keyof typeof JEV_FEELING_QUESTIONS, number>;

export function startJevShadow(message: string, coLastMessage: string | null, repliedToCo: boolean): Promise<{ answers: JevFeeling | null; ms: number }> | null {
  if (!jevForMemberText() || !message.trim()) return null;
  const started = Date.now();
  return askJevZdr({ latest_message: message.slice(0, 1000), co_last_message: (coLastMessage ?? "").slice(0, 600), replied_inline_to_co: repliedToCo }, JEV_FEELING_QUESTIONS, 3000)
    .then((p) => ({ answers: p as JevFeeling | null, ms: Date.now() - started }))
    .catch(() => ({ answers: null, ms: Date.now() - started }));
}

// The emotion word from the read, kept only when it's one of these; anything
// else is "other", so a free-text label never carries words from their message.
export const FEELING_WORDS = [
  "stressed", "anxious", "discouraged", "lonely", "frustrated", "excited", "proud", "relieved", "tired", "exhausted", "drained",
  "overwhelmed", "burned out", "burnt out", "hopeful", "happy", "sad", "grateful", "nervous", "annoyed", "disappointed", "worried",
  "calm", "content", "angry", "hurt", "curious", "bored", "confused", "energized", "optimistic", "upset", "down", "stuck",
  "restless", "amused", "playful", "eager", "thrilled", "glad", "scared", "uncertain", "impatient", "determined",
] as const;

// What the Sonnet read said about the same text, in closed sets only: the
// moment's mode, whether there was pushback, whether they're seeking a real
// answer, and the emotion read (harness/emotion.ts TextEmotion) without its
// free-text "about".
export function sonnetSide(read: TurnRead) {
  const e = read.emotion;
  const word = e ? (FEELING_WORDS as readonly string[]).find((w) => w === e.emotion.trim().toLowerCase()) ?? "other" : null;
  return {
    mode: read.moment?.mode ?? null,
    pushback: !!read.moment?.pushback,
    seeking: read.seeking,
    emotion: e ? { word, valence: e.valence, intensity: e.intensity, target: e.target } : null,
  };
}

const round = (p: JevFeeling): JevFeeling => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) as JevFeeling;

// The row, pure so its shape can be checked (evals/jev/feelingShadow.ts).
// proposal keys: v (question wording version), jev (probability per question,
// or null when Jev didn't answer), sonnet (sonnetSide), jevMs, sonnetMs.
export function buildFeelingRow(userId: string, answers: JevFeeling | null, ms: number, read: TurnRead) {
  return {
    layer: 2 as const,
    decision: "jev.shadow.feeling",
    userId,
    outcome: answers ? ("act" as const) : ("skip" as const),
    action: answers ? "read" : "unavailable",
    proposal: { v: JEV_FEELING_VERSION, jev: answers ? round(answers) : null, sonnet: sonnetSide(read), jevMs: ms, sonnetMs: read.latencyMs },
  };
}

// Fire and forget: returns at once, logs when Jev answers (or fails).
export function logJevShadow(userId: string, jevP: ReturnType<typeof startJevShadow>, read: TurnRead | null): void {
  if (!jevP || !read) return;
  jevP.then(({ answers, ms }) => recordDecision(buildFeelingRow(userId, answers, ms, read))).catch(() => {});
}
