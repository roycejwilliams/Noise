// Promises Co makes, kept (Royce, 2026-10-04, brand fix 2). "I'll flag you when
// it opens up" passed the follow-up check with nothing behind it: no task, no
// schedule, so nothing would ever flag them. Now a concrete promise of a later
// action opens a task (co_tasks.source = 'promise'), so it is true: Co wakes on
// it, does it or says where it stands, and the reply that made the promise cites
// the task like any other scheduled work.
//
// What it will not do (review of #67): track a promise Co could not keep.
//   - instant results ("the second someone turns up"): Co checks every few
//     hours, so those stay cut by the existing timing rule;
//   - things Co can't do (sponsors, investors, calling or emailing anyone);
//   - "keep an eye out" / "keep looking": the sweep's job while an ask is open;
//   - "let me ..." and "now": those happen this turn, they are not later;
//   - questions, other people ("Jordan will reach out"), offers;
//   - a turn that kept a confidence, or a sentence naming that other member.
// Co's wording is never rewritten. A task opened for a promise that then isn't
// in the final text (cut, redrafted, swapped for a discreet line) is dropped.
import { DateTime } from "luxon";
import { TASK_LIMITS, closeTask, openTasks, startTask, type CoTask } from "./coTasks.js";
import { OFFERS_WHAT_CO_CANT } from "./taskWeb.js";
import { commitmentWindow, FALLBACK_ZONE, localStamp, memberZone, wordsZone } from "./memberTime.js";

// A concrete later action Co says it will take, in the first person.
const ACTION = String.raw`(?:flag(?: (?:you|me|it|that|this|one))?|dig(?:ging)? (?:into|in)|come back(?: to you)?|check (?:back|in|on)|circle back|follow up|get back to you|report back|keep you (?:posted|in the loop|updated)|let you know|update you|text you|ping you)`;
export const PROMISE_RE = new RegExp(String.raw`\b(?:i'?ll|i will|i'?m going to)\s+(?:\w+\s+){0,2}?${ACTION}\b`, "i");
// The moment something happens: Co is not instant, so those stay cut.
export const INSTANT = /\b(?:the (?:second|moment|minute)|as soon as|right when|right away|immediately|instantly)\b/i;
// Happens this turn, not later.
const THIS_TURN = /\b(?:now|right now|real quick|one sec(?:ond)?|just a (?:sec|second|moment)|in a (?:sec|second|moment))\b/i;
// Co cannot find or approach these for them (capabilities.ts); a promise about them is not kept by a task.
const CANT = /\b(?:sponsors?|sponsorships?|investors?|funders?|funding|grants?|donors?)\b/i;

const sentencesOf = (t: string) => (t.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

// Pure: why a sentence is not a promise a task can keep, or null when it is one.
export function promiseProblem(s: string): string | null {
  if (!PROMISE_RE.test(s)) return "not a promise of a later action";
  if (/\?\s*$/.test(s)) return "a question";
  if (INSTANT.test(s)) return "promises an instant result";
  if (THIS_TURN.test(s)) return "happens this turn";
  if (CANT.test(s) || OFFERS_WHAT_CO_CANT.test(s)) return "something Cue can't do";
  return null;
}

// Pure: the one sentence of a reply that promises a concrete later action Co can keep, or null.
export function promiseSentence(reply: string): string | null {
  for (const s of sentencesOf(reply)) if (promiseProblem(s) === null) return s.slice(0, 220);
  return null;
}

// Pure: when Co should next look at it, from the wording of the promise.
export function promiseHours(sentence: string, now: Date = new Date(), zone: string | null = FALLBACK_ZONE): number {
  zone = wordsZone(zone);
  const clamp = (h: number) => Math.min(TASK_LIMITS.maxHours, Math.max(TASK_LIMITS.minHours, Math.round(h)));
  if (/\b(?:in (?:an|one) hour|within the hour)\b/i.test(sentence)) return TASK_LIMITS.minHours;
  if (/\b(?:later today|today|tonight|this (?:afternoon|evening))\b/i.test(sentence)) return 4;
  if (/\btomorrow\b/i.test(sentence)) return 20;
  const day = sentence.match(/\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b/i);
  if (day) {
    const names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const target = names.indexOf(day[1].slice(0, 3).toLowerCase()) + 1;
    const local = DateTime.fromJSDate(now).setZone(zone);
    let add = (target - local.weekday + 7) % 7;
    if (add === 0) add = 7;
    // The morning of that day, so it can be done before they need it.
    return clamp(local.plus({ days: add }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).diff(local, "hours").hours);
  }
  if (/\bnext week\b/i.test(sentence)) return 72;
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

// Pure: whether a promise task should stay: the final text still makes the promise.
export function promiseStays(final: string): boolean {
  return promiseSentence(final) !== null;
}

// How many promise tasks one member can have open, so they never starve work they asked for.
export const MAX_OPEN_PROMISES = 2;
export const atPromiseCap = (open: { source?: string }[]) => open.filter((t) => t.source === "promise").length >= MAX_OPEN_PROMISES;

// Work started this turn, by its receipt ("Started task #4: ...", "Started researching a venue brief ..."): it already keeps whatever
// the reply promises about it (2026-10-08 review F1: a research brief's "I'll text you the brief" opened a second, duplicate task).
export const STARTED_WORK = /^(?:Started task\b|Started researching\b|Started (?:a )?research brief\b)/;

const topicWords = (s: string) => new Set(s.toLowerCase().replace(/^keep your promise:\s*/i, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !/^(?:that|this|them|they|their|with|what|when|once|will|text|send|back|know|soon|ready|have|from|your|about|let's)$/.test(w)));
// Pure: why a promise needs no task of its own, or null when it does. Any work this turn started covers it; so does an open promise
// task about the same thing (most of the new promise's words are in it).
export function promiseCovered(sentence: string, o: { startedThisTurn?: string[]; open?: Pick<CoTask, "goal" | "source" | "status">[] }): string | null {
  if ((o.startedThisTurn ?? []).some((t) => STARTED_WORK.test(t.trim()))) return "work started this turn already keeps it";
  const mine = topicWords(sentence);
  if (!mine.size) return null;
  for (const t of o.open ?? []) {
    // A call look-out on the same subject keeps it too (review of #113: a later text promise opened a second task).
    if ((t.source !== "promise" && t.source !== "lookout") || t.status !== "open") continue;
    const theirs = topicWords(t.goal);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    if (shared && shared / Math.min(mine.size, theirs.size || 1) >= 0.5) return "an open promise task already keeps it";
  }
  return null;
}

export type TrackedPromise = { ok: true; task: CoTask; sentence: string } | { ok: false; why: string };

export async function trackPromise(o: { userId: string; reply: string; theirMessage: string; privateNames?: string[]; discreet?: boolean; startedThisTurn?: string[] }): Promise<TrackedPromise> {
  if (o.discreet) return { ok: false, why: "a turn that kept a confidence" };
  const sentence = promiseSentence(o.reply);
  if (!sentence) return { ok: false, why: "no promise a task can keep" };
  if ((o.privateNames ?? []).some((n) => n && new RegExp(`\\b${n.split(/[^\w]+/).filter(Boolean).join("[-\\s]?")}\\b`, "i").test(sentence))) return { ok: false, why: "names a member it can't" };
  const startedNow = promiseCovered(sentence, { startedThisTurn: o.startedThisTurn });
  if (startedNow) return { ok: false, why: startedNow };
  const open = await openTasks(o.userId);
  const covered = promiseCovered(sentence, { open });
  if (covered) return { ok: false, why: covered };
  if (atPromiseCap(open)) return { ok: false, why: `already keeping ${MAX_OPEN_PROMISES} promises` };
  // Its window in their local time: what the promise said ("tonight", "by Friday"), or within a day (services/memberTime.ts).
  const now = new Date();
  const zone = await memberZone(o.userId);
  const r = await startTask({
    userId: o.userId,
    goal: promiseGoal(sentence),
    theirWords: theirWordsFor(o.theirMessage),
    steps: [{ text: "Do what you said, or tell them plainly where it stands" }],
    firstPlan: "Do what you promised them; if there's nothing yet, say where it stands only if they'd want to hear it",
    inHours: promiseHours(sentence, now, zone),
    source: "promise",
    window: commitmentWindow(sentence, now, zone),
  });
  return r.ok ? { ok: true, task: r.task, sentence } : { ok: false, why: r.why };
}

// The promise never went out as written: drop its task.
export async function dropPromise(userId: string, taskId: number): Promise<void> {
  await closeTask(userId, taskId, "dropped", "The promise was not in the text that went out.").catch(() => {});
}

// In their local time (the window's zone, or the fallback), never bare UTC.
export const promiseFact = (t: CoTask) =>
  `Started task #${t.id}: ${t.goal}. Cue will work on it first around ${t.nextCheckAt ? localStamp(t.nextCheckAt, t.window?.zone ?? null) : "soon"}, and tell them if there's anything to say.${t.window ? ` They'll have it ${t.window.words} (by ${localStamp(t.window.deadline, t.window.zone)}), or hear before then that it's moving and to when.` : ""}`;
