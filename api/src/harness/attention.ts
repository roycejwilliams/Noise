// A member's attention (Royce, 2026-11-02, notification grouping PR B: items 3, 6, 7 and 8 of the approved plan). PR A (harness/door.ts)
// made every send Cue starts a candidate at one door; this is what the pick then asks of each one, and of what goes together.
//
//   3  thread    Grouped by the member's thread, never by source. "Same thread" is the ask, goal, task or member thread an item serves,
//                by id; only when the ids don't settle it, one model read maps the item onto their open threads (once per item,
//                stored on it as payload.threadRead). Never a regex over their words. Two finds for one ask become the better one; a
//                find and a check-in about the same thing become one message about that thing (the check-in is covered, foldPlan,
//                from what was delivered only). A requested find is never covered: it waits and goes as itself. Possible intros
//                are never held by the defaults, the back-off or the one-thread day (matching first);
//                a thread that already had its message today waits for another day, and so does another thread (unless they reply
//                often: then their second message of the day may be about something else).
//   6  back-off  If Cue's last unrequested message went unanswered, the next unrequested one waits longer: two days after one, four
//                after two, a week after three or more (bounded). The interest question never goes twice in a row unanswered: the
//                second message drops it (dropRepeatInterest). Silence is never consent and never a preference: nothing is recorded
//                from it, it only spaces Cue out.
//   7  defaults  With no rule of their own: the first day is quiet; at most 1 unrequested message a day, 2 when they reply often
//                (repliesOften); no Cue-started call and Cue-started text on the same day. A member's own rule about how often always
//                wins over these, in both directions (memberSetsFrequency); their rule itself is enforced by harness/notifyGate.ts.
//   8  state     On a hard day finds and offers Cue starts go to the send-time read (2026-11-09: judged per message, never a class
//                hold; harness/momentFit.ts). A check-in never asserts a feeling the member didn't share: Cue's own draft is read against
//                their own words (feelingCheck).
//
//  10  send time Learned from the hour they usually write back (their own inbound times, no new store): an unrequested text waits for those
//               hours (inside Cue's own 8am to 9pm and what their rules allow), never a requested one, a possible intro, a time-sensitive
//               one, one that would expire first, or the morning sweep's find. Too little to learn from: the current default stands.
//
// Never touched by any of it: requested deliveries, replies, safety follow-ups and notices about something soon (their class is
// "requested" or "reply", or the payload says safety). Calls Cue starts read the same defaults (harness/callGate.ts pickerBudget).
// Pure, apart from the two model reads at the end (readThreads, feelingCheck).
import { DateTime } from "luxon";
import type { GateCheck } from "./core.js";
import type { Counted, NotifyChannel, SendClass } from "./notifyGate.js";
import { holdingRules, covers } from "./notifyGate.js";
import type { Preference } from "../services/memberPreferences.js";
import { hoursZone } from "../services/localHours.js";
import { wordsZone } from "../services/memberTime.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const zoneOf = (z: string | null | undefined) => hoursZone(z);

// What Cue starts on its own: the classes every default here reads. Requested and replies never.
export const isUnrequested = (cls: SendClass): boolean => cls === "unsolicited" || cls === "checkin";

// ---------------------------------------------------------------- 3. the member's thread

type Item = { type: string; targetKey: string; payload: unknown; expiresAt?: Date | null };
// One model read's answer, stored on the candidate: the member thread it serves, or null for none of them.
export type ThreadRead = { thread: string | null; at: string };
export type ThreadIds = { thread: string | null; ask: string | null; goal: string | null; task: string | null; profile: boolean; read: boolean };

// Pure: the ids an item carries for what it serves. thread: a member thread (a check-in's own threadId, else the stored read);
// ask: a real ask (never "profile"); goal; task: the task whose text it is.
export function threadIds(c: Item): ThreadIds {
  const p = (c.payload ?? {}) as { threadId?: string | null; threadRead?: ThreadRead | null; askId?: string | null; fromProfile?: boolean; goalId?: string | number | null; taskId?: number | string | null; thread?: { id?: string } | null };
  const read = p.threadRead && typeof p.threadRead === "object" ? p.threadRead : null;
  const ownThread = p.threadId ? String(p.threadId) : null;
  const ask = p.askId && p.askId !== "profile" && p.fromProfile !== true ? String(p.askId) : null;
  return {
    thread: ownThread ?? (read?.thread ? String(read.thread) : null),
    ask,
    goal: p.goalId != null ? String(p.goalId) : null,
    task: p.taskId != null ? String(p.taskId) : null,
    profile: c.type === "event_offer" && (p.askId === "profile" || p.fromProfile === true),
    read: !!read,
  };
}

// Pure: the one key an item groups under. Their own thread first; then the ask, goal or task it serves; finds that only fit their
// profile share one key ("things that fit who you are", so a morning's tiers still go together); anything else is its own.
export function threadKey(c: Item): string {
  const i = threadIds(c);
  if (i.thread) return `thread:${i.thread}`;
  if (i.ask) return `ask:${i.ask}`;
  if (i.goal) return `goal:${i.goal}`;
  if (i.task) return `task:${i.task}`;
  if (i.profile) return "profile";
  return `item:${c.targetKey}`;
}

// Pure: two items serve the same ask (by id).
export function sameAsk(a: Item, b: Item): boolean {
  const x = threadIds(a).ask;
  return !!x && x === threadIds(b).ask;
}

// Pure: two items are on the same thread. A shared ask, goal or task settles it; otherwise their keys (a member thread when they have one).
export function sameThread(a: Item, b: Item): boolean {
  const x = threadIds(a);
  const y = threadIds(b);
  if ((x.ask && x.ask === y.ask) || (x.goal && x.goal === y.goal) || (x.task && x.task === y.task)) return true;
  return threadKey(a) === threadKey(b);
}

// Pure: whether the ids don't settle this item's thread: no member thread of its own, and no read yet. Only then is it read.
export function needsThreadRead(c: Item): boolean {
  const i = threadIds(c);
  return !i.thread && !i.read;
}

// Pure: whether a read is worth making at all now: they have open threads, and there's something to group the item with (another
// waiting item, or something that went today). A lone item on a quiet day is settled by its ids.
export function threadReadDue(o: { pending: Item[]; sentToday: Item[]; openThreads: number }): Item[] {
  if (!o.openThreads) return [];
  if (o.pending.length < 2 && !o.sentToday.length) return [];
  return o.pending.filter(needsThreadRead);
}

// Pure: the finds that ride with a find lead. Only from the lead's thread; two for one ask become the better one (the lead, or the
// earlier of two siblings in the pick's own order).
export function threadRiders<T extends Item>(lead: T, sibs: T[]): { riders: T[]; sameAskLeft: T[]; otherThread: T[] } {
  const riders: T[] = [];
  const sameAskLeft: T[] = [];
  const otherThread: T[] = [];
  for (const s of sibs) {
    if (!sameThread(lead, s)) otherThread.push(s);
    else if (sameAsk(lead, s) || riders.some((r) => sameAsk(r, s))) sameAskLeft.push(s);
    else riders.push(s);
  }
  return { riders, sameAskLeft, otherThread };
}

// What a message covers once it went (review of #367): only from what was actually delivered in it (included: the lead and the extras
// whose words went). Covered: a check-in Cue started about the same thing (never a safety follow-up, never the day-after check-in after a
// heavy moment), and an unrequested find for the same ask as a find that went. A requested find is never covered: unless its own words
// went in this message, it waits and goes as itself. Nothing requested that isn't a find is ever touched.
export type Fold = { candidate: Item & { id: string }; why: string };
export function foldPlan<T extends Item & { id: string }>(o: { included: T[]; pending: T[]; classOf: (c: T) => SendClass }): Fold[] {
  if (!o.included.length) return [];
  const ids = new Set(o.included.map((x) => x.id));
  const out: Fold[] = [];
  for (const p of o.pending) {
    if (ids.has(p.id)) continue;
    const pay = (p.payload ?? {}) as { safetyFollowUp?: boolean; heavy?: unknown; reminder?: boolean; door?: boolean };
    if (pay.safetyFollowUp === true || pay.heavy) continue;
    const cls = o.classOf(p);
    if (!isUnrequested(cls)) continue;
    if (cls === "checkin" && pay.door !== true) {
      const on = o.included.find((m) => sameThread(m, p));
      if (on) out.push({ candidate: p, why: `a check-in about the same thing: the message that went (${on.id}) was about it` });
      continue;
    }
    const sameAskFind = p.type === "event_offer" && !pay.reminder ? o.included.find((m) => m.type === "event_offer" && sameAsk(m, p)) : undefined;
    if (sameAskFind) out.push({ candidate: p, why: `a find Cue started for the same ask: the better one went (${sameAskFind.id})` });
  }
  return out;
}

// Pure: what of a send was delivered: the lead when its first bubble went, an extra only when every one of its bubbles went (a partial
// send never covers what didn't arrive).
export function deliveredItems<T>(lead: T, extras: { candidate: T; messages: string[] }[], delivered: string[]): T[] {
  if (!delivered.length) return [];
  return [lead, ...extras.filter((e) => e.messages.length > 0 && e.messages.every((m) => delivered.includes(m))).map((e) => e.candidate)];
}

// Pure: a possible intro (harness/door.ts doorBand's intro band): matching comes first, so the defaults, the back-off and the one-thread
// day never hold it. Their own rules still time it. On a hard day an event_match_nudge, or an intro ask Cue sends at the door, goes to
// the send-time read like any offer (harness/momentFit.ts hardDayRead); network_tease is requested and intro_nudge keeps its own rules.
export const INTRO_ITEM_TYPES: ReadonlySet<string> = new Set(["network_tease", "event_match_nudge", "intro_nudge"]);
export function isPossibleIntro(c: Item): boolean {
  return INTRO_ITEM_TYPES.has(c.type) || (c.payload as { intro?: boolean } | null)?.intro === true;
}

// ---------------------------------------------------------------- 6 and 7. back-off and the defaults

// What went to them, as the one send gate counts it (harness/notifyGate.ts loadCounted), and when they wrote back.
export type AttentionState = {
  sent: Counted[];
  // Their own messages (a text, a call where they spoke): times only.
  inbound: Date[];
  // What went today, as candidates (their thread ids on them): the pick's own sends, door texts included.
  sentToday: Item[];
  // Cue's last message: whether it closed with the interest question, and when.
  lastAsked: { at: Date; asked: boolean } | null;
  // Their own messages over a longer stretch (SEND_TIME.lookbackDays), times only: what the usual reply hour is learned from. Missing: the
  // learning has nothing to read, so the current default stands (item 10).
  history?: Date[];
};

export const answeredWithin = (at: Date, inbound: Date[], ms: number) => inbound.some((i) => i.getTime() > at.getTime() && i.getTime() - at.getTime() <= ms);

// "Often" (item 7): of the unrequested texts in the window the ledger read covers (8 days), at least REPLY_OFTEN.min, and at least
// REPLY_OFTEN.rate of them answered within a day. A member Cue hasn't written to enough yet is not "often".
export const REPLY_OFTEN = { min: 3, rate: 2 / 3, withinHours: 24 } as const;
export function repliesOften(a: Pick<AttentionState, "sent" | "inbound">, now: Date): { often: boolean; sent: number; answered: number } {
  const mine = a.sent.filter((s) => s.channel === "text" && isUnrequested(s.cls) && s.at.getTime() <= now.getTime() - REPLY_OFTEN.withinHours * HOUR);
  const answered = mine.filter((s) => answeredWithin(s.at, a.inbound, REPLY_OFTEN.withinHours * HOUR)).length;
  return { often: mine.length >= REPLY_OFTEN.min && answered / mine.length >= REPLY_OFTEN.rate, sent: mine.length, answered };
}
export const DEFAULT_PER_DAY = { usual: 1, repliesOften: 2 } as const;

// The back-off (item 6): hours the next unrequested message waits after k unanswered in a row. Bounded at a week.
export const BACKOFF_HOURS = [0, 48, 96, 168] as const;
export function backoffHours(k: number): number {
  return BACKOFF_HOURS[Math.min(Math.max(k, 0), BACKOFF_HOURS.length - 1)];
}
// Pure: how many of Cue's unrequested texts in a row, newest first, went unanswered, and the last one's time.
export function unansweredRun(a: Pick<AttentionState, "sent" | "inbound">, now: Date): { k: number; last: Date | null } {
  const mine = a.sent.filter((s) => s.channel === "text" && isUnrequested(s.cls) && s.at.getTime() <= now.getTime()).sort((x, y) => y.at.getTime() - x.at.getTime());
  let k = 0;
  for (const s of mine) {
    if (a.inbound.some((i) => i.getTime() > s.at.getTime())) break;
    k++;
  }
  return { k, last: mine[0]?.at ?? null };
}

// Pure: a member's own rule about how often (a number a day or a week, or none at all) that reaches this class and channel. When there
// is one, it decides, not the defaults: it can allow more than the default, or less (its own gate enforces it).
export function memberSetsFrequency(prefs: Preference[], cls: SendClass, channel: NotifyChannel, now: Date): Preference | null {
  return holdingRules(prefs, now).find((p) => covers(p.area === "checkins" ? "checkins" : p.covers, cls) && (p.channel === "all" || p.channel === channel) && (p.rule.maxPerDay !== undefined || p.rule.maxPerWeek !== undefined || p.rule.none === true)) ?? null;
}

export const FIRST_DAY_HOURS = 24;
export type AttentionCheck = GateCheck & { retryAt?: Date };

// Pure: the checks one unrequested send reads (a candidate in the pick, or a call Cue would place). Empty for anything else.
// item: the candidate (its thread), absent for a call.
export function attentionChecks(o: { now: Date; zone: string | null; cls: SendClass; channel: NotifyChannel; joinedAt: Date | null; att: AttentionState; prefs: Preference[]; safety?: boolean; item?: Item | null }): AttentionCheck[] {
  if (!isUnrequested(o.cls) || o.safety) return [];
  // Matching first (review of #367): a possible intro is never held by the defaults, the back-off or the one-thread day.
  if (o.item && isPossibleIntro(o.item)) return [];
  const local = DateTime.fromJSDate(o.now).setZone(zoneOf(o.zone));
  const dayStart = local.startOf("day").toJSDate().getTime();
  const tomorrow = local.plus({ days: 1 }).startOf("day").toJSDate();
  const theirRule = memberSetsFrequency(o.prefs, o.cls, o.channel, o.now);
  const often = repliesOften(o.att, o.now);
  const out: AttentionCheck[] = [];
  if (!theirRule) {
    // 7: the first day is quiet.
    if (o.joinedAt && o.now.getTime() - o.joinedAt.getTime() < FIRST_DAY_HOURS * HOUR) {
      out.push({ name: "first_day_quiet", pass: false, reason: `their first day: nothing Cue starts until ${FIRST_DAY_HOURS}h after they joined`, retryAt: new Date(o.joinedAt.getTime() + FIRST_DAY_HOURS * HOUR) });
    }
    // 7: at most 1 a day (2 when they reply often), texts and calls together.
    const cap = often.often ? DEFAULT_PER_DAY.repliesOften : DEFAULT_PER_DAY.usual;
    const today = o.att.sent.filter((s) => isUnrequested(s.cls) && s.at.getTime() >= dayStart && s.at.getTime() <= o.now.getTime()).length;
    if (today >= cap) out.push({ name: "default_daily", pass: false, reason: `${today} of ${cap} unrequested today (the default with no rule of theirs${often.often ? "; they reply often" : ""})`, retryAt: tomorrow });
    // 7: never a Cue-started call and a Cue-started text the same day.
    const other = o.att.sent.find((s) => isUnrequested(s.cls) && s.channel !== o.channel && s.at.getTime() >= dayStart && s.at.getTime() <= o.now.getTime());
    if (other) out.push({ name: "call_text_same_day", pass: false, reason: `Cue already started a ${other.channel} today`, retryAt: tomorrow });
  }
  // 6: after their silence, the next one waits longer.
  const run = unansweredRun(o.att, o.now);
  if (run.k > 0 && run.last) {
    const until = run.last.getTime() + backoffHours(run.k) * HOUR;
    if (o.now.getTime() < until) out.push({ name: "quiet_backoff", pass: false, reason: `${run.k} unrequested in a row unanswered: the next waits ${backoffHours(run.k)}h after the last`, retryAt: new Date(until) });
  }
  // 3: one message about a thing a day; another thing waits for another day (unless they reply often).
  if (o.item) {
    const today = o.att.sentToday;
    const same = today.find((s) => sameThread(s, o.item!));
    const other = today.find((s) => !sameThread(s, o.item!));
    if (same) out.push({ name: "thread_today", pass: false, reason: `its thread (${threadKey(o.item)}) already had its message today`, retryAt: tomorrow });
    else if (other && !often.often && !theirRule) out.push({ name: "thread_today", pass: false, reason: `a message about something else (${threadKey(other)}) went today: a different thing waits for another day`, retryAt: tomorrow });
    // 10: unrequested texts go in the hours they usually write back (learned from their own messages; nothing to learn from: no check).
    const usual = sendTimeCheck({ now: o.now, zone: o.zone, cls: o.cls, channel: o.channel, att: o.att, prefs: o.prefs, item: o.item });
    if (usual) out.push(usual);
  }
  return out;
}

// ---------------------------------------------------------------- 10. send time

// Learned from the member's own inbound timestamps (the texts and calls they started), never asked. A reply is the first message of a run
// (messages under clusterMinutes apart are one). Too little to go on (fewer than minReplies, or on fewer than minDays different days)
// keeps the current default: no learned hour. The usual window is the narrowest run of hours (at least minWidth, at most maxWidth) that
// holds at least `coverage` of their replies; a member who writes all day has none. It is then cut to Cue's own hours
// (services/localHours.ts, 8am to 9pm) and to what their own rules allow, and when nothing is left it is no window at all.
export const SEND_TIME = { minReplies: 12, minDays: 5, lookbackDays: 45, coverage: 0.7, minWidth: 3, maxWidth: 8, clusterMinutes: 30, minLeadHours: 6, startHour: 8, endHour: 21 } as const;
export type UsualHours = { hours: number[]; replies: number; days: number };

// Pure: the hours (0-23, their zone) they usually write in, or null when there is too little to say.
export function usualReplyHours(times: Date[], zone: string | null | undefined, now: Date): UsualHours | null {
  const since = now.getTime() - SEND_TIME.lookbackDays * DAY;
  const sorted = times.filter((t) => t.getTime() > since && t.getTime() <= now.getTime()).sort((a, b) => a.getTime() - b.getTime());
  const replies: DateTime[] = [];
  let last = -Infinity;
  for (const t of sorted) {
    if (t.getTime() - last >= SEND_TIME.clusterMinutes * 60_000) replies.push(DateTime.fromJSDate(t).setZone(zoneOf(zone)));
    last = t.getTime();
  }
  const days = new Set(replies.map((r) => r.toISODate())).size;
  if (replies.length < SEND_TIME.minReplies || days < SEND_TIME.minDays) return null;
  const counts = new Array<number>(24).fill(0);
  for (const r of replies) counts[r.hour]++;
  for (let w = SEND_TIME.minWidth; w <= SEND_TIME.maxWidth; w++) {
    let best = -1;
    let bestSum = -1;
    for (let start = 0; start < 24; start++) {
      let sum = 0;
      for (let i = 0; i < w; i++) sum += counts[(start + i) % 24];
      if (sum > bestSum) (bestSum = sum, (best = start));
    }
    if (bestSum / replies.length >= SEND_TIME.coverage) {
      const hours = Array.from({ length: w }, (_, i) => (best + i) % 24).filter((h) => h >= SEND_TIME.startHour && h < SEND_TIME.endHour);
      return hours.length ? { hours, replies: replies.length, days } : null;
    }
  }
  return null;
}

// Pure: whether a member's own explicit rules allow a send of this class at this hour of their day (an "earliest" or a "latest" time of
// day). Their rules always win over the learned hour: an hour they forbid is never one Cue waits for.
export function hourAllowedByRules(prefs: Preference[], cls: SendClass, channel: NotifyChannel, hour: number, now: Date, zone?: string | null): boolean {
  return holdingRules(prefs, now).every((p) => {
    if (!covers(p.area === "checkins" ? "checkins" : p.covers, cls) || (p.channel !== "all" && p.channel !== channel)) return true;
    const m = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
    // The rule's clock is read in the zone the gate reads it in (notifyGate.ruleBlocks: their zone now, else the rule's own).
    const at = DateTime.fromJSDate(now).setZone(zoneOf(zone)).set({ hour, minute: 0, second: 0, millisecond: 0 }).setZone(wordsZone(zone ?? p.zone));
    const start = at.hour * 60 + at.minute;
    const end = start + 59;
    if (p.rule.earliest && end < m(p.rule.earliest)) return false;
    if (p.rule.latest && start >= m(p.rule.latest)) return false;
    return true;
  });
}

// Pure: the send-time check for one unrequested text. Null: nothing to say (no learned hour, already inside it, a rule of theirs leaves
// no usual hour, the item can't wait for it, or it's one that never waits). Else a failing check with when the next usual hour begins.
// Never for a requested delivery, a reply, a safety follow-up, a possible intro (matching first), a find from the morning sweep (it has
// its own hour), or anything that would expire before the next usual hour.
export function sendTimeCheck(o: { now: Date; zone: string | null; cls: SendClass; channel: NotifyChannel; att: Pick<AttentionState, "inbound" | "history">; prefs: Preference[]; item: Item }): AttentionCheck | null {
  if (!isUnrequested(o.cls) || o.channel !== "text" || isPossibleIntro(o.item)) return null;
  const pay = (o.item.payload ?? {}) as { safetyFollowUp?: boolean; morningDay?: string; soonAt?: string | null };
  if (pay.safetyFollowUp === true || pay.soonAt) return null;
  const local = DateTime.fromJSDate(o.now).setZone(zoneOf(o.zone));
  if (typeof pay.morningDay === "string" && pay.morningDay === local.toISODate()) return null;
  const usual = usualReplyHours(o.att.history ?? o.att.inbound, o.zone, o.now);
  if (!usual) return null;
  const hours = usual.hours.filter((h) => hourAllowedByRules(o.prefs, o.cls, o.channel, h, o.now, o.zone));
  if (!hours.length || hours.includes(local.hour)) return null;
  let next = local.startOf("hour");
  for (let i = 0; i < 48 && !hours.includes(next.hour); i++) next = next.plus({ hours: 1 });
  if (!hours.includes(next.hour)) return null;
  const at = next.toJSDate();
  // Anything happening today is never moved, and a find needs at least SEND_TIME.minLeadHours between the usual hour and its end (the
  // event's start, else its valid-until), or it goes now.
  const match = ((o.item.payload ?? {}) as { match?: { details?: { startAt?: string | null } | null; startAt?: string | null } | null }).match;
  const startMs = Date.parse(String(match?.details?.startAt ?? match?.startAt ?? ""));
  const ends = [Number.isFinite(startMs) ? startMs : null, o.item.expiresAt ? o.item.expiresAt.getTime() : null].filter((x): x is number => x !== null);
  if (Number.isFinite(startMs) && DateTime.fromMillis(startMs).setZone(zoneOf(o.zone)).toISODate() === local.toISODate()) return null;
  if (ends.length && Math.min(...ends) < at.getTime() + SEND_TIME.minLeadHours * HOUR) return null;
  return { name: "usual_hour", pass: false, reason: `their usual reply hours (${usual.replies} replies over ${usual.days} days): it waits for the next one`, retryAt: at };
}

// ---------------------------------------------------------------- 8. their state

// No class hold on a hard day (Royce, 2026-11-09, replacing the 2026-11-02 "only companionship goes"): a find or an offer Cue starts
// goes to the send-time read, told of the hard stretch (harness/momentFit.ts momentFitApplies, hardDayRead), which judges whether this
// message helps them now. Check-ins and nudges keep their own capped wait (proactive.ts HOLD_WHILE_STRUGGLING); safety holds are apart.

// Pure (item 6): the interest question never goes twice in a row unanswered. When Cue's last message closed with it and they haven't
// written since, this one goes without its closing question.
export function dropRepeatInterest<T extends { messages: string[]; closing: string | null; text: string }>(composed: T, lastAsked: AttentionState["lastAsked"], lastInboundAt: Date | null): { composed: T; dropped: boolean } {
  if (!composed.closing || !lastAsked?.asked) return { composed, dropped: false };
  if (lastInboundAt && lastInboundAt.getTime() > lastAsked.at.getTime()) return { composed, dropped: false };
  const i = composed.messages.lastIndexOf(composed.closing);
  if (i < 0) return { composed, dropped: false };
  const messages = [...composed.messages.slice(0, i), ...composed.messages.slice(i + 1)];
  const text = composed.text.split("\n").filter((l) => l !== composed.closing).join("\n");
  return { composed: { ...composed, messages, text, closing: null }, dropped: true };
}

// ---------------------------------------------------------------- the two model reads (Haiku)

// Layer 1's answer for both reads when a test sets one (the dispatch tests that stub every model call); null: the real model.
let modelForTests: ((prompt: string) => Promise<string>) | null = null;
export function setAttentionModelForTests(fn: typeof modelForTests): void {
  modelForTests = fn;
}

export function threadReadPrompt(items: { n: number; line: string }[], threads: { label: string; text: string }[]): string {
  return `Which of this member's open threads does each item serve?

Their open threads:
${threads.map((t) => `${t.label}. ${t.text}`).join("\n")}

Items Cue has waiting for them:
${items.map((i) => `${i.n}. ${i.line}`).join("\n")}

An item serves a thread only when it's plainly about that thread: the same thing they're working on or looking for. If it's about something else, or you can't tell, say null.

Return ONLY JSON: {"items": [{"n": 1, "thread": "T1"}, {"n": 2, "thread": null}]}`;
}
// Pure: the read's answer, checked in code: every label must be one of the threads given; anything else is no answer for that item.
export function readThreadAnswer(text: string, labels: Map<string, string>, ns: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return out;
  try {
    const j = JSON.parse(m[0]);
    for (const it of Array.isArray(j?.items) ? j.items : []) {
      const n = Number(it?.n);
      if (!ns.includes(n)) continue;
      if (it.thread === null) out.set(n, null);
      else if (typeof it.thread === "string" && labels.has(it.thread.trim())) out.set(n, labels.get(it.thread.trim())!);
    }
  } catch {
    return new Map();
  }
  return out;
}
// One line per item for the read: what Cue would send, never another member's details (the candidate summary and the find's name).
export function threadItemLine(c: Item & { summary?: string }): string {
  const p = (c.payload ?? {}) as { askText?: string; match?: { name?: string } };
  return [`[${c.type}] ${String(c.summary ?? "").slice(0, 200)}`, p.match?.name ? `(${String(p.match.name).slice(0, 120)})` : "", p.askText ? `for what they asked: ${String(p.askText).slice(0, 160)}` : ""].filter(Boolean).join(" ");
}

// The read: once per item, the member thread it serves (or none), stored on the item. A read that fails stores nothing (the item
// groups by its ids; it's read again on a later pick).
export async function readThreads(o: { userId: string; items: (Item & { id: string; summary?: string })[]; threads: { id: string; text: string }[]; write?: boolean; generate?: (prompt: string) => Promise<string> }): Promise<Map<string, ThreadRead>> {
  const done = new Map<string, ThreadRead>();
  if (!o.items.length || !o.threads.length) return done;
  const labels = new Map(o.threads.map((t, i) => [`T${i + 1}`, t.id] as const));
  const prompt = threadReadPrompt(o.items.map((c, i) => ({ n: i + 1, line: threadItemLine(c) })), o.threads.map((t, i) => ({ label: `T${i + 1}`, text: t.text.slice(0, 200) })));
  const gen = o.generate ?? modelForTests ?? (async (p: string) => {
    const [{ generateText }, { anthropic }, { MODELS }, { withMember }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js"), import("../services/llmUsage.js")]);
    return withMember(o.userId, () => generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 300, abortSignal: AbortSignal.timeout(15_000), experimental_telemetry: { isEnabled: true, functionId: "attention.threadRead" }, prompt: p })).then((r) => r.text);
  });
  const text = await gen(prompt).catch(() => "");
  const answers = readThreadAnswer(text, labels, o.items.map((_, i) => i + 1));
  const at = new Date().toISOString();
  for (const [n, thread] of answers) {
    const c = o.items[n - 1];
    const read: ThreadRead = { thread, at };
    done.set(c.id, read);
    (c.payload as Record<string, unknown>).threadRead = read;
    if (o.write !== false) {
      const { default: pool } = await import("../db/db.js");
      await pool.query(`UPDATE proactive_candidates SET payload = payload || jsonb_build_object('threadRead', $2::jsonb), updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [c.id, JSON.stringify(read)]).catch(() => {});
    }
  }
  return done;
}

export function feelingPrompt(draft: string, ownWords: string[]): string {
  return `Cue wrote this check-in to a member:
"${draft}"

The member's own words (their texts and what they said on calls, oldest first):
${ownWords.length ? ownWords.map((w) => `- ${w}`).join("\n") : "(none)"}

Does the check-in say or imply how the member feels, or how something weighs on them, beyond what their own words say? Naming a feeling in the words they used is fine, and asking how they feel is fine. Stating one they didn't share is not: for example "both still heavy" when they never said heavy, hard or anything like it.

Return ONLY JSON: {"asserts": true or false, "phrase": "the words in the check-in that do it, or empty"}`;
}
// Pure: the read's answer. Null: no usable answer.
export function readFeelingAnswer(text: string): { asserts: boolean; phrase: string } | null {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j?.asserts !== "boolean") return null;
    return { asserts: j.asserts, phrase: String(j.phrase ?? "").slice(0, 120) };
  } catch {
    return null;
  }
}
export const NO_ASSERTED_FEELING = "no_asserted_feeling";
// Pure: which check-ins the feeling read covers: never a safety follow-up, never the check-in after a heavy or hard moment (their own
// careful paths decide those words), never anything that isn't a check-in Cue started.
export function feelingCheckApplies(cls: SendClass, payload: unknown): boolean {
  const p = (payload ?? {}) as { safetyFollowUp?: boolean; heavy?: unknown; hardMoment?: unknown };
  return cls === "checkin" && p.safetyFollowUp !== true && !p.heavy && !p.hardMoment;
}
// The check on Cue's own check-in draft. infra: the read couldn't answer (the model failed, or their words couldn't be read; ownWords
// null): the caller holds the check-in and tries again later, never counting it as a failed draft (review of #367).
export type FeelingCheck = GateCheck & { infra?: true; phrase?: string };
export async function feelingCheck(o: { userId: string; draft: string; ownWords: string[] | null; generate?: (prompt: string) => Promise<string> }): Promise<FeelingCheck> {
  if (o.ownWords === null) return { name: NO_ASSERTED_FEELING, pass: false, infra: true, reason: "couldn't read their own words to check the check-in against; it waits" };
  const gen = o.generate ?? modelForTests ?? (async (p: string) => {
    const [{ generateText }, { anthropic }, { MODELS }, { withMember }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js"), import("../services/llmUsage.js")]);
    return withMember(o.userId, () => generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 150, abortSignal: AbortSignal.timeout(15_000), experimental_telemetry: { isEnabled: true, functionId: "attention.feelingCheck" }, prompt: p })).then((r) => r.text);
  });
  const answer = readFeelingAnswer(await gen(feelingPrompt(o.draft, o.ownWords.slice(-30).map((w) => w.slice(0, 300)))).catch(() => ""));
  if (!answer) return { name: NO_ASSERTED_FEELING, pass: false, infra: true, reason: "couldn't check that the check-in states no feeling they didn't share; it waits" };
  return answer.asserts ? { name: NO_ASSERTED_FEELING, pass: false, phrase: answer.phrase, reason: `it says how they feel beyond their own words ("${answer.phrase}"); say only what they said, or ask` } : { name: NO_ASSERTED_FEELING, pass: true };
}
// Pure: a check-in written elsewhere (a door text goes as its path wrote it) without the sentence the read named. Null: the phrase isn't
// found in it as written, or nothing would be left.
export function withoutPhrase(messages: string[], phrase: string): string[] | null {
  const needle = phrase.trim().toLowerCase();
  if (!needle) return null;
  let hit = false;
  const out = messages
    .map((m) => {
      if (!m.toLowerCase().includes(needle)) return m;
      hit = true;
      return m.split(/(?<=[.!?])\s+/).filter((sentence) => !sentence.toLowerCase().includes(needle)).join(" ").trim();
    })
    .filter((m) => m.length > 0);
  return hit && out.length ? out : null;
}
