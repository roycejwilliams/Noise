// Promises Co makes, kept (Royce, 2026-10-04, brand fix 2). "I'll flag you the
// second someone with real space turns up" passed the follow-up check with
// nothing behind it: no task, no schedule, so nothing would ever flag them.
// Now a concrete promise of a later action opens a task Co owns (co_tasks.owner
// = 'co'), so it is true: Co wakes on it, does it or says where it stands, and
// the reply that made the promise cites the task like any other scheduled work.
//
// What this is not: "I'll keep an eye out" with an ask open is already kept by
// the daily sweep, and a bare "keep looking" is not a task. Those stay as they
// were (harness/replyGrounding.ts). Co's wording is never rewritten here.
import { TASK_LIMITS, startTask, type CoTask } from "./coTasks.js";

// A concrete later action Co says it will take. Wider than the old matcher,
// which missed "flag you", "come back the moment" and "dig into".
const ACTION = String.raw`(?:flag(?: (?:you|me|it|that|this|one|the (?:second|moment)))?|dig(?:ging)? (?:into|in)|come back(?: to you)?|check (?:back|in|on)|circle back|follow up|get back to you|report back|keep you (?:posted|in the loop|updated)|let you know|update you|text you|ping you|reach out|be in touch|track (?:it|that|one|this) down|look into|find out|send (?:it|one|you|that|the link|over))`;
export const PROMISE_RE = new RegExp(String.raw`\b(?:i'?ll|i will|let me|will|i'?m going to)\s+(?:\w+\s+){0,2}?${ACTION}\b`, "i");
// "Keep an eye out / keep looking" is not in ACTION: that is the sweep's job
// (an ask open), never a task. Offers ("want me to flag you?") have no "I'll".
// The moment something happens: Co cannot be instant, so it checks often.
const EVENT_DRIVEN = /\b(?:the (?:second|moment)|as soon as|right when)\b/i;

const sentencesOf = (t: string) => (t.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

// Pure: the one sentence of a reply that promises a concrete later action, or null.
export function promiseSentence(reply: string): string | null {
  for (const s of sentencesOf(reply)) {
    if (PROMISE_RE.test(s)) return s.slice(0, 220);
  }
  return null;
}

// Pure: when Co should next look at it, from the wording of the promise.
export function promiseHours(sentence: string): number {
  if (EVENT_DRIVEN.test(sentence)) return 3;
  if (/\b(?:in (?:an|one) hour|within the hour)\b/i.test(sentence)) return TASK_LIMITS.minHours;
  if (/\b(?:later today|today|tonight|this (?:afternoon|evening))\b/i.test(sentence)) return 4;
  if (/\btomorrow\b/i.test(sentence)) return 20;
  if (/\bthis week\b/i.test(sentence)) return 48;
  return 24;
}

export function promiseGoal(sentence: string): string {
  return `Keep your promise: "${sentence.replace(/\s+/g, " ").trim().slice(0, 170)}"`;
}

// Their message, as the words the promise answers (the task shows it to Co when it wakes).
export function theirWordsFor(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "(their message)";
}

export type TrackedPromise = { ok: true; task: CoTask; sentence: string } | { ok: false; why: string };

// Opens the task. A member's own open work already covering it, or the limit,
// leaves the reply to the existing checks (which cut a promise nothing backs).
export async function trackPromise(o: { userId: string; reply: string; theirMessage: string; now?: Date }): Promise<TrackedPromise> {
  const sentence = promiseSentence(o.reply);
  if (!sentence) return { ok: false, why: "no promise" };
  const r = await startTask({
    userId: o.userId,
    goal: promiseGoal(sentence),
    theirWords: theirWordsFor(o.theirMessage),
    steps: [{ text: "Do what you said, or tell them plainly where it stands" }],
    firstPlan: "Do what you promised them; if there's nothing yet, say where it stands only if they'd want to hear it",
    inHours: promiseHours(sentence),
    owner: "co",
  });
  return r.ok ? { ok: true, task: r.task, sentence } : { ok: false, why: r.why };
}

export const promiseFact = (t: CoTask) => `Started task #${t.id}: ${t.goal}. Co will work on it first around ${t.nextCheckAt?.slice(0, 16).replace("T", " ")} UTC, and tell them if there's anything to say.`;

