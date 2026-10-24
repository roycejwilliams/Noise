// A promise with a time binds to the ledger, or it isn't said (Royce, 2026-10-13, goal ownership 2): "Every commitment Co makes in
// chat ('I'll check back Friday') must create a ledger entry with a fire time, and the status-grounding check blocks any promise that
// has none. If Co can't schedule it, Co can't say it."
//
// What already held: a regex promise sentence opens a promise task (services/promises.ts), and the claim read needs a scheduled fact
// behind any future_promise (harness/replyGrounding.ts). What this adds, as a fact guard at send time:
//   1. Detection by a Haiku read, not a pattern: every promise in the reply that Co itself will do something at or by a stated time,
//      in Co's exact words, and which open ledger entry it is about (if any). Offers, questions, the member's own actions and things
//      done this turn aren't promises. Calls and meetings are left to the claim read, which sees scheduled calls.
//   2. The time is resolved in code, in their zone (services/memberTime.ts windowFromWords). Bound means a ledger entry (an open task)
//      fires by then. Unbound, code binds it: the entry it's about is pulled earlier to fire by then, or a promise task opens for it.
//      It can't be bound when the time has passed, can't be read, is beyond what a task can hold, or is something Co can't do
//      (promiseBinding.ts cantKeep, the lines promises.ts holds), or Co is at its promise cap: then it is a failed claim_future_promise check, and the reply's
//      usual path cuts or redrafts that sentence.
//   3. Fail-safe: a read that doesn't come back can't vouch for anything. A sentence that looks like a timed first-person promise
//      (the cheap prefilter below, which only decides whether to spend on the read) and has no entry firing by its time is cut.
// Only on a real send (a user and a recorded turn). Every read is the member's own (user_id).
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import type { GateCheck } from "../harness/core.js";
import { parseModelJson } from "./modelJson.js";
import { DateTime } from "luxon";
import { parseAskWindow } from "./askWindow.js";
import { INSTANT, atPromiseCap, theirWordsFor, promiseGoal, promiseCovered } from "./promises.js";
import { TASK_LIMITS, type CoTask } from "./coTasks.js";
import { OFFERS_WHAT_CO_CANT } from "./taskWeb.js";
import { localStamp, warnByFor, windowFromWords, commitmentWindow, wordsZone } from "./memberTime.js";

// Pure: the end of the time some words name, in their zone: Co's commitment words first ("Friday", "tomorrow morning"), then a
// date ("Oct 17", "the 20th") the way asks read them. Null when no time can be placed.
// Widened after review (2026-10-13): end of the week, in/within N days, a bare short weekday, a clock time ("5pm", "by noon"), and
// "the 20th" all resolve; anything else is null, and an unplaceable time is never vouched for (bindPromises fails it closed).
const DAYS_WORD: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, couple: 2, "a couple of": 2, "a couple": 2, few: 3, "a few": 3 };
export function deadlineFromWhen(when: string, now: Date, zone: string | null): { words: string; deadline: Date } | null {
  const s = String(when ?? "").toLowerCase().replace(/[’‘]/g, "'").trim();
  const L = DateTime.fromJSDate(now).setZone(wordsZone(zone));
  if (/\b(?:(?:by |at )?(?:the )?end of (?:the |this )?week|eow)\b/.test(s)) return windowFromWords("this week", now, zone);
  const nd = s.match(/\b(?:in|within)\s+(?:the next\s+)?(\d+|a couple(?: of)?|a few|few|couple|one|two|three|four|five|six|seven)\s+days?\b/);
  if (nd) {
    const n = /^\d+$/.test(nd[1]) ? Number(nd[1]) : DAYS_WORD[nd[1]] ?? 3;
    return { words: nd[0], deadline: L.plus({ days: n }).endOf("day").toJSDate() };
  }
  const w = windowFromWords(s, now, zone);
  if (w) return w;
  // A bare short weekday ("mon", "tues", "thurs"): read as "by" that day.
  const short = s.match(/\b(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b/);
  if (short) {
    const w2 = windowFromWords(`by ${short[1]}`, now, zone);
    if (w2) return w2;
  }
  // A clock time today, or tomorrow when it has passed: "5pm", "by 5:30 pm", "noon".
  const clock = s.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b|\b(noon|midday)\b/);
  if (clock) {
    const h = clock[4] ? 12 : (Number(clock[1]) % 12) + (clock[3] === "pm" ? 12 : 0);
    let t = L.set({ hour: h, minute: clock[2] ? Number(clock[2]) : 0, second: 0, millisecond: 0 });
    if (t <= L) t = t.plus({ days: 1 });
    return { words: clock[0], deadline: t.toJSDate() };
  }
  // "the 20th": this month, or next month when it has passed.
  const nth = s.match(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/);
  if (nth) {
    let d = L.set({ day: Math.min(Number(nth[1]), L.daysInMonth ?? 28) }).endOf("day");
    if (d < L || Number(nth[1]) > (L.daysInMonth ?? 31)) d = L.plus({ months: 1 }).set({ day: Math.min(Number(nth[1]), L.plus({ months: 1 }).daysInMonth ?? 28) }).endOf("day");
    return { words: nth[0], deadline: d.toJSDate() };
  }
  const a = parseAskWindow(s, L);
  return a ? { words: s.slice(0, 40), deadline: a.end.toJSDate() } : null;
}

// Pure: the read's own time for a promise, validated by code: a real ISO instant, ahead, within what a task can hold.
export function readTime(iso: unknown, now: Date): Date | null {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const d = DateTime.fromISO(iso.trim(), { setZone: true });
  if (!d.isValid) return null;
  const t = d.toJSDate();
  return t.getTime() > now.getTime() && t.getTime() - now.getTime() <= (TASK_LIMITS.maxHours + 24) * 3_600_000 ? t : null;
}

export const BINDING_LIMITS = { readMs: 8_000, graceMin: 15 };

// The prefilter: a first-person (or "you'll hear/have") future with a time word. It never vetoes anything by itself; it only decides
// whether the read runs, and which sentences a failed read leaves unvouched for.
const FUTURE = /\b(?:i'?ll|i will|i'?m going to|i'?m gonna|i can have|you'?ll (?:have|hear|get)|expect (?:it|them|something)|i'?ll be back)\b/i;
const WHEN = /\b(?:today|tonight|tomorrow|this (?:morning|afternoon|evening|week|weekend)|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thurs?|fri|sat|sun|(?:in|within) (?:an?|one|two|three|a few|\d+) (?:hours?|days?)|by (?:end of|the end of|noon|\d)|\d{1,2}(?::\d\d)?\s?(?:am|pm)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b/i;
const sentencesOf = (t: string) => (t.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
export function timedPromiseShaped(text: string): string[] {
  return sentencesOf(text).filter((s) => FUTURE.test(s) && WHEN.test(s) && !/\?\s*$/.test(s));
}

// Pure: why a task can't keep a promise, whatever its verb: an instant result, or something Co can't do (contact, book or pay for
// anyone; sponsors and investors), the same lines promises.ts holds for the promises it tracks.
const CANT = /\b(?:sponsors?|sponsorships?|investors?|funders?|funding|grants?|donors?)\b/i;
export function cantKeep(sentence: string): string | null {
  if (INSTANT.test(sentence)) return "promises an instant result";
  if (CANT.test(sentence) || OFFERS_WHAT_CO_CANT.test(sentence)) return "something Cue can't do";
  return null;
}

export type LedgerEntry = { id: number; what: string; fires: Date[] };
// Pure: an open task's fire times: its next check, its last check before a deadline, and its window's warn-by.
// A next check that is only the wake's lease (coTasks.ts claimDueTasks: leased at followup.leasedAt, 45 minutes out) is not a fire time.
export const LEASE_MINUTES = 45;
export function isLease(nextCheckAt: string | null | undefined, followup: any): boolean {
  const at = followup?.leasedAt;
  if (!nextCheckAt || typeof at !== "string") return false;
  return Math.abs(new Date(nextCheckAt).getTime() - (new Date(at).getTime() + LEASE_MINUTES * 60_000)) <= 2 * 60_000;
}
export function entryOf(t: Pick<CoTask, "id" | "goal" | "status" | "nextCheckAt" | "finalCheckAt" | "finalTold" | "window"> & { followup?: any }): LedgerEntry {
  const fires = [isLease(t.nextCheckAt, t.followup) ? null : t.nextCheckAt, t.finalCheckAt && !t.finalTold ? t.finalCheckAt : null, t.window && !t.window.closedAt ? t.window.warnBy : null].filter((x): x is string => !!x).map((x) => new Date(x));
  return { id: t.id, what: t.goal, fires };
}

export type ReadPromise = { sentence: string; when: string; about: "call" | "other"; entry: number | null; by?: string | null };
export function bindingPrompt(reply: string, entries: LedgerEntry[], zone: string | null, now: Date = new Date()): string {
  return `Cue (a companion texting a member) is about to send this reply:
"""
${reply.slice(0, 2000)}
"""

What Cue already has scheduled for this member (its ledger):
${entries.length ? entries.map((e) => `#${e.id}: ${e.what} (fires ${e.fires.map((f) => localStamp(f, zone)).join(", ") || "unscheduled"})`).join("\n") : "(nothing)"}

List every promise in the reply that Cue ITSELF will do something at or by a stated time ("I'll check back Friday", "you'll have the shortlist by Thursday", "I'll text you tomorrow"). Not offers or questions ("want me to...?"), not the member's own actions, not things done in this reply, not promises with no time. For each: the sentence exactly as written, the time words exactly as written, the latest moment those words mean as an ISO 8601 time with its offset (now is ${DateTime.fromJSDate(now).setZone(wordsZone(zone)).toISO()}, in ${wordsZone(zone)}), whether it's about a phone call or meeting ("call") or anything else ("other"), and the ledger number it's about, or null if none.

Return ONLY JSON: {"promises": [{"sentence": "...", "when": "...", "by": "2026-10-16T21:00:00-07:00", "about": "call"|"other", "entry": 12|null}]}`;
}
// Pure: the read's promises, held to the reply: the sentence and its time words must be in it.
export function parseBindingRead(text: string, reply: string): ReadPromise[] | null {
  let j: any = null;
  try { j = parseModelJson(text); } catch { return null; }
  if (!j || !Array.isArray(j.promises)) return null;
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const out: ReadPromise[] = [];
  for (const p of j.promises) {
    const sentence = String(p?.sentence ?? "").trim();
    const when = String(p?.when ?? "").trim();
    if (sentence.length < 6 || !n(reply).includes(n(sentence).replace(/[.!?]+$/, ""))) continue;
    if (!when || !n(sentence).includes(n(when))) continue;
    out.push({ sentence, when, about: p?.about === "call" ? "call" : "other", entry: Number.isFinite(Number(p?.entry)) && p?.entry !== null ? Number(p.entry) : null, by: typeof p?.by === "string" ? p.by : null });
  }
  return out;
}

export type Verdict = { sentence: string; bound: true; entry: number; how: "already" | "pulled" | "opened" } | { sentence: string; bound: false; why: string };

// Pure: does an entry fire by a promise's time? (On or before its end, with a little grace; never in the past.)
export function firesBy(e: LedgerEntry, by: Date, now: Date): boolean {
  return e.fires.some((f) => f.getTime() >= now.getTime() - 5 * 60_000 && f.getTime() <= by.getTime() + BINDING_LIMITS.graceMin * 60_000);
}

export type BindDeps = {
  now: () => Date;
  zone: string | null;
  open: () => Promise<CoTask[]>;
  // Pull an entry earlier so it fires by `at`: false when it couldn't, else its earlier time (null when it already fired in time), so
  // the caller can put it back if the sentence is cut.
  pullEarlier: (taskId: number, at: Date, plan: string) => Promise<false | { previous: string | null; plan: string | null }>;
  // When Co's scheduled calls with them are (a call promise is kept by one of these, never by a task).
  scheduledCalls?: () => Promise<Date[]>;
  // Text replies: a call promise with no scheduled call goes to the claim read (which sees scheduled-call facts) instead of being cut
  // here; the caller cuts it if that read didn't run. Calls: unset, so it's unbound.
  deferCallsToClaimRead?: boolean;
  // Open a promise task for it (services/coTasks.ts startTask, source 'promise'), or why not.
  openPromise: (o: { sentence: string; inHours: number; window: ReturnType<typeof commitmentWindow> }) => Promise<{ ok: true; id: number } | { ok: false; why: string }>;
  read: (prompt: string) => Promise<string>;
};

// The guard. Returns the verdict for each timed promise, the failed checks for the unbound ones, and the tasks it opened (dropped by
// the caller if the sentence isn't in what finally goes out).
export const CALL_PROMISE = /\b(?:call|ring|phone)\s+(?:you|them|him|her)\b|\bgive (?:you|them) a (?:call|ring)\b|\b(?:hop|jump|get) on (?:a|the) (?:call|phone)\b|\bcall you back\b/i;
export type Pulled = { id: number; sentence: string; previous: string; plan: string | null };
export async function bindPromises(reply: string, deps: BindDeps): Promise<{ verdicts: Verdict[]; checks: GateCheck[]; opened: { id: number; sentence: string }[]; pulled: Pulled[]; deferred: string[]; read: boolean }> {
  const shaped = timedPromiseShaped(reply);
  if (!shaped.length) return { verdicts: [], checks: [], opened: [], pulled: [], deferred: [], read: true };
  const now = deps.now();
  let tasks = await deps.open();
  const calls = deps.scheduledCalls ? await deps.scheduledCalls().catch(() => [] as Date[]) : [];
  const entries = () => tasks.filter((t) => t.status === "open").map(entryOf);
  const raw = await deps.read(bindingPrompt(reply, entries(), deps.zone, now)).catch(() => "");
  const parsed = parseBindingRead(raw, reply);
  const read = parsed !== null;
  // Fail-safe: no read, so each promise-shaped sentence is read from its own words, and nothing new is opened for it.
  const promises: ReadPromise[] = parsed ?? shaped.map((s) => ({ sentence: s, when: s, about: "other" as const, entry: null }));
  const verdicts: Verdict[] = [];
  const opened: { id: number; sentence: string }[] = [];
  const pulled: Pulled[] = [];
  const deferred: string[] = [];
  const callBy = (by: Date) => calls.some((c) => c.getTime() >= now.getTime() - 5 * 60_000 && c.getTime() <= by.getTime() + BINDING_LIMITS.graceMin * 60_000);
  for (const p of promises) {
    // Its time: code's reading of the words first; else the read's own time, validated. Neither: it can't be scheduled, so it can't
    // be said, read or not (fail closed in both branches).
    const fromWords = deadlineFromWhen(p.when, now, deps.zone) ?? deadlineFromWhen(p.sentence, now, deps.zone);
    const by = fromWords?.deadline ?? (read ? readTime(p.by, now) : null);
    if (!by) { verdicts.push({ sentence: p.sentence, bound: false, why: `"${p.when}" isn't a time Cue can place` }); continue; }
    if (by.getTime() <= now.getTime()) { verdicts.push({ sentence: p.sentence, bound: false, why: "that time has already passed" }); continue; }
    // A call or meeting: kept by a scheduled call, never by the read's label alone.
    // A call or meeting by the read's label, or by Co's own words whatever the label says (a real call promise labelled "other" must
    // never open a task, which can't place a call).
    if (p.about === "call" || CALL_PROMISE.test(p.sentence)) {
      if (callBy(by)) { verdicts.push({ sentence: p.sentence, bound: true, entry: 0, how: "already" }); continue; }
      if (deps.deferCallsToClaimRead && read) { deferred.push(p.sentence); continue; }
      verdicts.push({ sentence: p.sentence, bound: false, why: "no call with them is scheduled for then" });
      continue;
    }
    const already = entries().find((e) => (p.entry === null || e.id === p.entry) && firesBy(e, by, now));
    if (already && (p.entry !== null || !read)) { verdicts.push({ sentence: p.sentence, bound: true, entry: already.id, how: "already" }); continue; }
    if (!read) { verdicts.push({ sentence: p.sentence, bound: false, why: "the promise check couldn't run, and nothing on the ledger fires by then" }); continue; }
    if ((by.getTime() - now.getTime()) / 3_600_000 > TASK_LIMITS.maxHours) { verdicts.push({ sentence: p.sentence, bound: false, why: "that's further out than Cue can hold a commitment" }); continue; }
    const fireAt = warnByFor(by, now, deps.zone);
    if (p.entry !== null) {
      const e = entries().find((x) => x.id === p.entry);
      const r = e ? await deps.pullEarlier(e.id, fireAt, `You told them: "${p.sentence.slice(0, 160)}". Do it by then.`).catch(() => false as const) : false;
      if (e && r) {
        verdicts.push({ sentence: p.sentence, bound: true, entry: e.id, how: "pulled" });
        if (r.previous) pulled.push({ id: e.id, sentence: p.sentence, previous: r.previous, plan: r.plan });
        tasks = await deps.open();
        continue;
      }
    }
    const problem = cantKeep(p.sentence);
    if (problem) { verdicts.push({ sentence: p.sentence, bound: false, why: problem }); continue; }
    // A promise the regex tracker already opened a task for this turn (services/promises.ts trackPromise), or an open promise about
    // the same thing that the read didn't name: that task keeps it if it fires by then.
    if (promiseCovered(p.sentence, { open: tasks })) {
      const same = entries().find((e) => firesBy(e, by, now) && tasks.some((t) => t.id === e.id && (t.source === "promise" || t.source === "lookout")));
      if (same) { verdicts.push({ sentence: p.sentence, bound: true, entry: same.id, how: "already" }); continue; }
    }
    if (atPromiseCap(tasks)) { verdicts.push({ sentence: p.sentence, bound: false, why: "Cue is already keeping as many promises as it can hold" }); continue; }
    const r = await deps.openPromise({ sentence: p.sentence, inHours: Math.max(TASK_LIMITS.minHours, (fireAt.getTime() - now.getTime()) / 3_600_000), window: commitmentWindow(p.when, now, deps.zone) }).catch((err: any) => ({ ok: false as const, why: String(err?.message ?? err).slice(0, 120) }));
    if (r.ok) {
      verdicts.push({ sentence: p.sentence, bound: true, entry: r.id, how: "opened" });
      opened.push({ id: r.id, sentence: p.sentence });
      tasks = await deps.open();
    } else verdicts.push({ sentence: p.sentence, bound: false, why: r.why });
  }
  const checks: GateCheck[] = verdicts.filter((v): v is Extract<Verdict, { bound: false }> => !v.bound).map((v) => ({ name: "claim_future_promise", pass: false, reason: `future_promise: "${v.sentence}" (nothing on Cue's schedule fires by then: ${v.why})` }));
  return { verdicts, checks, opened, pulled, deferred, read };
}

// ---------------------------------------------------------------- calls (Royce, 2026-10-13: "A false promise is a false promise in any medium")
// A spoken promise can't be held back once said, so on a call the guard runs the moment it ends, over everything Co said (bind or
// admit): each timed promise Co spoke is bound to the ledger the same way as a text's (an entry that fires by then, pulled earlier,
// or a promise task opened), and what can't be bound comes back to be admitted to them in one text (services/callFollowThrough.ts).
// Pure: Co's lines of a call transcript ("assistant:" / "agent:"), and their last line.
export function callLines(transcript: string): { co: string[]; theirLast: string } {
  const lines = transcript.split("\n");
  const co = lines.filter((l) => /^\s*(?:assistant|agent)\s*:/i.test(l)).map((l) => l.replace(/^\s*(?:assistant|agent)\s*:\s*/i, ""));
  const theirs = lines.filter((l) => /^\s*user\s*:/i.test(l)).map((l) => l.replace(/^\s*user\s*:\s*/i, ""));
  return { co, theirLast: theirs[theirs.length - 1] ?? "" };
}
export async function bindCallPromises(userId: string, transcript: string, deps?: BindDeps, o: { memberNames?: string[] | null } = {}): Promise<{ verdicts: Verdict[]; unbound: { sentence: string; why: string }[]; opened: { id: number; sentence: string }[]; read: boolean }> {
  const { co, theirLast } = callLines(transcript);
  const shaped = co.flatMap((l) => timedPromiseShaped(l));
  if (!shaped.length) return { verdicts: [], unbound: [], opened: [], read: true };
  const d = deps ?? (await realBindDeps(userId, theirLast || "(said on a call)"));
  // Fails closed (review, 2026-10-13): if the member names can't be read, no promise task opens for anything said, and what comes back
  // to be admitted is paraphrased with no names at all.
  const names: string[] | null = o.memberNames !== undefined ? o.memberNames : await import("./memberSafeMemories.js").then((m) => m.memberNamesStrict(userId)).catch(() => null);
  const open = d.openPromise;
  // Never a task for a sentence that names another member (the same line a text's promise holds).
  d.openPromise = (p) =>
    names === null
      ? Promise.resolve({ ok: false as const, why: "the member names couldn't be checked, so nothing was opened" })
      : names.some((n) => n && new RegExp(`\\b${n.split(/[^\w]+/).filter(Boolean).join("[-\\s]?")}\\b`, "i").test(p.sentence))
        ? Promise.resolve({ ok: false as const, why: "it names a member it can't" })
        : open(p);
  // Only the promise-shaped sentences go to the read: a long call stays inside its budget.
  const r = await bindPromises(shaped.join("\n"), d);
  // What comes back to be admitted (a text to them, a ledger row) never carries another member's name: it's paraphrased out.
  return { verdicts: r.verdicts, unbound: r.verdicts.filter((v): v is Extract<Verdict, { bound: false }> => !v.bound).map((v) => ({ sentence: names === null ? withoutAnyNames(v.sentence) : withoutMemberNames(v.sentence, names), why: v.why })), opened: r.opened, read: r.read };
}

// Pure: a sentence with every linked member's name taken out ("I'll ask Jordan Reyes for the deck Friday" -> "I'll ask someone you
// know for the deck Friday"), so a take-back never repeats another member's name.
export function withoutMemberNames(sentence: string, names: string[]): string {
  let out = sentence;
  for (const n of names.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const parts = n.split(/[^\w]+/).filter(Boolean);
    if (!parts.length) continue;
    // A possessive keeps its sense: "Jordan's friend" -> "a friend of someone you know".
    for (const who of [parts.join("[-\\s]?"), ...(parts.length > 1 ? [parts[0]] : [])]) {
      out = out.replace(new RegExp(`\\b(?:the\\s+)?${who}['’]s\\s+(\\w+)`, "gi"), "a $1 of someone you know");
      out = out.replace(new RegExp(`\\b${who}['’]s\\b`, "gi"), "someone you know's");
      out = out.replace(new RegExp(`\\b${who}\\b`, "gi"), "someone you know");
    }
  }
  return out;
}

// Pure: with no member list to go on (the read failed), every name-shaped word is taken out: a capitalized word that doesn't start the
// sentence and isn't a day, month or "I".
const NOT_NAMES = /^(?:I|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thurs|Fri|Sat|Sun|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|PDF|Co)$/;
export function withoutAnyNames(sentence: string): string {
  return sentence
    .replace(/(?<=\S\s+)[A-Z][\w’'-]*(?:\s+[A-Z][\w’'-]*)*/g, (m) => (m.split(/\s+/).every((w) => NOT_NAMES.test(w.replace(/['’]s$/, ""))) ? m : /['’]s$/.test(m) ? "someone you know's" : "someone you know"))
    .replace(/someone you know's\s+(\w+)/g, "a $1 of someone you know");
}

// Pure: the plain line that takes back a promise Co can't hold, when no draft holds up. Never a new promise, never an excuse.
export function admissionFallback(unbound: { sentence: string; why: string }[]): string {
  const one = unbound[0];
  const theirs = /can't do/.test(one.why) ? "That one's yours to do, so don't wait on me for it." : "I can't hold that one, so don't count on it from me.";
  // Paraphrased, never quoted: the sentence has already had any other member's name taken out (withoutMemberNames).
  const said = one.sentence.replace(/[.!]+$/, "").replace(/^\s*(?:and|so|also)\s+/i, "").replace(/^\s*i'?ll\s+/i, "").replace(/^\s*i will\s+/i, "");
  return `One thing from our call I need to take back: I said I'd ${said}. ${theirs}`;
}

// The real dependencies, for one member.
export async function realBindDeps(userId: string, theirMessage: string): Promise<BindDeps> {
  const T = await import("./coTasks.js");
  const { memberZone } = await import("./memberTime.js");
  const zone = await memberZone(userId).catch(() => null);
  return {
    now: () => new Date(),
    zone,
    open: () => T.openTasks(userId),
    pullEarlier: async (taskId, at, plan) => {
      const t = await T.getTask(userId, taskId);
      if (!t || t.status !== "open") return false;
      if (t.nextCheckAt && new Date(t.nextCheckAt).getTime() <= at.getTime()) return { previous: null, plan: null };
      return (await T.scheduleTaskAt(userId, taskId, at, plan)) ? { previous: t.nextCheckAt, plan: t.planNext } : false;
    },
    scheduledCalls: async () => {
      const { default: pool } = await import("../db/db.js");
      const { rows } = await pool.query(`SELECT scheduled_for FROM scheduled_calls WHERE user_id = $1 AND status = 'pending' AND scheduled_for > NOW() - INTERVAL '5 minutes'`, [userId]);
      return rows.map((r: any) => new Date(r.scheduled_for));
    },
    openPromise: async ({ sentence, inHours, window }) => {
      const r = await T.startTask({ userId, goal: promiseGoal(sentence), theirWords: theirWordsFor(theirMessage), steps: [{ text: "Do what you said, or tell them plainly where it stands" }], firstPlan: "Do what you promised them; if there's nothing yet, say where it stands only if they'd want to hear it", inHours, source: "promise", window });
      return r.ok ? { ok: true, id: r.task.id } : { ok: false, why: r.why };
    },
    read: async (prompt) => (await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 500, abortSignal: AbortSignal.timeout(BINDING_LIMITS.readMs), experimental_telemetry: { isEnabled: true, functionId: "reply.promiseBinding", metadata: { userId } }, prompt })).text,
  };
}
