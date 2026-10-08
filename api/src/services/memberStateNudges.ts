// Member-state proactiveness (Royce, 2026-10-08). Co keeps track of what it is carrying for each member; now it acts when one of
// those things changes, the way a friend who was paying attention would. Each hourly pass reads ONE member's own state and finds:
//   a. intro_nudge       an intro Co made by email a few days ago that the member hasn't mentioned since (offer to help it along);
//   b. deadline_nudge    something they said yes to (a reaction, a kept find) whose date or deadline is close: one heads-up,
//                        timed inside their send window with enough lead;
//   c. goal_nudge        a goal gone quiet (not restated, not mentioned, nothing kept lately): at most one gentle surface, never
//                        for a done or set-aside goal, never inside the seasonal goal window (goalJourney.ts GOAL_CHECKIN);
//   d. commitment_nudge  something they said they'd do by a date ("I'll send them the deck Friday"), on the morning it's due.
// Each becomes a proactive CANDIDATE in the one dispatcher (harness/proactive.ts), so quiet hours, the pause switches, opt-out,
// caps, spacing, dedupe and the kind restraint (services/kindRestraint.ts) all apply. Nothing here sends.
//
// Once per state: every entry carries a fingerprint of the facts that define it (member_state_nudges). An entry nudges at most
// once per fingerprint (the candidate's target key carries it, and a sent, skipped or expired target is never re-queued); a new
// fingerprint (the deadline moved, a new intro, a goal said again and gone quiet again) re-arms it once.
//
// Co decides, code guards: the model writes each nudge from the facts below (and may SKIP); code decides that the state is real,
// when it may go, and checks the words (harness/proactive.ts checkDraft: no "just checking in", no em dash, the thing named).
//
// No cross-member leaks (top priority). An intro has two members. Whether a nudge exists, and everything in it, comes from the
// recipient's OWN state only: their own texts, their own record. The other member's replies, reads, reactions, words or status
// are never read here, never in the facts, and the draft is checked for any claim about them (INTRO_STATUS_FORBIDDEN, the
// consent check and privateFactLeak) before it can go.
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { localDay, memberZone, wordsZone } from "./memberTime.js";
import { loopsMentioned } from "./openLoops.js";
import { notToTeammate } from "./teamLines.js";
import { GOAL_CHECKIN, dueGoalCheckin } from "./goalJourney.js";
import type { ProactiveKind } from "./kindRestraint.js";

export type NudgeType = "intro_nudge" | "deadline_nudge" | "goal_nudge" | "commitment_nudge";
export const NUDGE_TYPES: NudgeType[] = ["intro_nudge", "deadline_nudge", "goal_nudge", "commitment_nudge"];
export const NUDGE_KIND: Record<NudgeType, ProactiveKind> = { intro_nudge: "intro_followup", deadline_nudge: "deadline", goal_nudge: "goal_nudge", commitment_nudge: "member_commitment" };

export const NUDGE = {
  // An intro is worth a word once it has had this long, and not after this long.
  introAfterDays: 3,
  // An event intro email can go out before the event: its nudge waits this long, so the event has passed.
  eventIntroAfterDays: 5,
  introWithinDays: 21,
  // A deadline heads-up goes this many days before an opportunity's deadline, the day before an event.
  opportunityLeadDays: 2,
  eventLeadDays: 1,
  // Not when they told Co they cared less than this long before the heads-up would go (they just said it).
  caredMinHoursBefore: 24,
  caredWithinDays: 45,
  // A goal is slipping after this long with no restating, no mention and nothing kept.
  goalQuietDays: 21,
  // They're on a commitment when they mentioned it this recently.
  commitmentMentionHours: 36,
  // The hour Co aims for in their day (inside the send window, services/localHours.ts), and how early a candidate is queued.
  sendHour: 10,
  commitmentHour: 9,
  commitmentLastHour: 17,
  queueAheadHours: 24,
};

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type NudgeEntry = {
  type: NudgeType;
  kind: ProactiveKind;
  // The carrying-list entry this is about, stable across states (intro:<otherId>, deadline:<itemKey>, goal:<hash>, commitment:<id>).
  entryKey: string;
  // The state it is about; a new one re-arms the entry.
  fingerprint: string;
  summary: string;
  // What the draft may state. Built only from the recipient's own record (see the *Facts builders).
  facts: Record<string, string | number | null>;
  // Not facts: what code needs at draft time (the other member's id for the leak check, a link to send as its own message).
  meta: Record<string, string | null>;
  dueAt: Date;
  expiresAt: Date;
};

export function fingerprint(parts: (string | number | null | undefined)[]): string {
  return createHash("sha1").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- snapshot (one member's own state)

export type OwnLine = { at: Date; text: string };
export type IntroFact = {
  otherId: string;
  otherFirstName: string;
  introducedAt: Date;
  // "event": the intro email from a Co event (its name in the email); "network": the network intro email (its reason in the email).
  how: "event" | "network";
  eventName: string | null;
  // The reason exactly as the intro email both of them received said it, or null.
  reasonAsEmailed: string | null;
  // The intro already has its own "did it help?" follow-up (services/networkIntroNudge.ts): one topic, one follow-up.
  hasOutcomeFollowup: boolean;
  // The other member is still a member (archived members are never named back).
  otherActive: boolean;
};
export type CaredItem = {
  itemKey: string;
  name: string;
  kind: "event" | "opportunity";
  // YYYY-MM-DD, or an ISO time when the start is known.
  date: string;
  caredAt: Date;
  // What they said when they reacted, their own words.
  theirWords: string | null;
  url: string | null;
  // A day-before reminder for it is already queued or sent by the sweep (services/eventSurfacingSweep.ts): one heads-up, not two.
  reminderQueued: boolean;
};
export type GoalFact = { id: string; text: string; confirmedAt: Date | null; state: "active" | "done" | "stale"; coTask: boolean };
export type CommitmentFact = { threadId: string; text: string; quote: string; openedAt: Date; dueDate: string; status: string; followedUp: boolean };
export type Snapshot = {
  userId: string;
  zone: string | null;
  now: Date;
  ownLines: OwnLine[];
  intros: IntroFact[];
  cared: CaredItem[];
  goals: GoalFact[];
  intent: unknown;
  // The last goal_checkin or goal_nudge that went out (the seasonal window covers both).
  lastGoalSurfaceAt: Date | null;
  // The last time they kept a find or said yes to something (movement).
  lastKeptAt: Date | null;
  commitments: CommitmentFact[];
};

// ---------------------------------------------------------------- pure helpers

// A local hour on a local day, in their zone.
export function localAt(day: string, hour: number, zone: string | null, minute = 0): Date {
  return DateTime.fromISO(day, { zone: wordsZone(zone) }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
}
const dayWords = (day: string, zone: string | null) => DateTime.fromISO(day, { zone: wordsZone(zone) }).toFormat("cccc, LLLL d");
// Late morning to early evening in their day; otherwise their next 10am.
export function wellTimed(now: Date, zone: string | null): Date {
  const h = DateTime.fromJSDate(now).setZone(wordsZone(zone)).hour;
  if (h >= NUDGE.sendHour && h < 18) return now;
  const today = localDay(now, zone);
  const at = localAt(today, NUDGE.sendHour, zone);
  return at > now ? at : localAt(DateTime.fromISO(today).plus({ days: 1 }).toISODate()!, NUDGE.sendHour, zone);
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function namesPerson(text: string, firstName: string): boolean {
  return !!firstName.trim() && new RegExp(`\\b${escape(firstName.trim())}\\b`, "i").test(text);
}
// Their own words about a thing, by the same word overlap the carrying list uses (services/openLoops.ts loopsMentioned).
export function mentionedSince(lines: OwnLine[], about: string, since: Date): OwnLine | null {
  return [...lines].reverse().find((l) => l.at.getTime() > since.getTime() && loopsMentioned([{ id: 1, title: about, detail: null }], l.text).length > 0) ?? null;
}
// A date as their local day, or null. Accepts YYYY-MM-DD, an ISO time, or a written date with a year ("October 12, 2026").
export function dayOf(value: string | null | undefined, zone: string | null): string | null {
  if (!value) return null;
  const v = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const iso = DateTime.fromISO(v, { setZone: true });
  if (iso.isValid) return iso.setZone(wordsZone(zone)).toISODate();
  if (!/\b\d{4}\b/.test(v)) return null; // no year: never guessed
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : localDay(new Date(t), zone);
}

// ---------------------------------------------------------------- facts (what the draft may state)

// Pure. The recipient's own view of the intro: who, how long ago, and what the email they received said. Never the other
// member's replies, reads or words: those aren't inputs to this function at all.
export function introNudgeFacts(i: Pick<IntroFact, "otherFirstName" | "how" | "eventName" | "reasonAsEmailed" | "introducedAt">, now: Date): Record<string, string | number | null> {
  return {
    their_name: i.otherFirstName,
    // "around": an event intro can go out before or after the event, and the facts never say which (review, 2026-10-08).
    co_introduced_you_two_by_email: i.how === "event" && i.eventName ? `around ${i.eventName}` : "yes",
    days_since_the_intro_email: Math.max(1, Math.floor((now.getTime() - i.introducedAt.getTime()) / DAY)),
    why_the_intro_email_said_you_should_meet: i.reasonAsEmailed ? i.reasonAsEmailed.slice(0, 240) : null,
    you_have_not_mentioned_them_since: "true",
  };
}

// Anything a draft could say about the other member's side of an intro: seen, replied, heard back, waiting, silent.
export const INTRO_STATUS_FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\b(?:hasn'?t|has not|haven'?t|have not|didn'?t|did not|never|not yet)\s+(?:heard|replied|responded|written|answered|gotten back|got back|seen|read|opened|reached out)\b|\b(?:heard back|hear back|wrote back|written back|replied|responded|got back to|gets back to|gotten back to|no word|radio silen\w*|ghost\w*|on read|left (?:you|it) on|saw (?:it|the email|your)|seen (?:it|the email)|opened (?:it|the email)|waiting (?:on|for) you|waiting to hear|expecting (?:you|to hear))\b/i,
    reason: "says something about the other member's side of the intro (seen, replied, waiting); the member's nudge never carries that",
  },
];

// ---------------------------------------------------------------- detectors (pure)

export function detectIntroNudges(s: Snapshot): NudgeEntry[] {
  const out: NudgeEntry[] = [];
  for (const i of s.intros) {
    if (!i.otherActive || i.hasOutcomeFollowup || !i.otherFirstName.trim()) continue;
    const age = s.now.getTime() - i.introducedAt.getTime();
    // An event intro can go out ahead of the event: wait long enough that the event has come and gone.
    const after = i.how === "event" ? Math.max(NUDGE.introAfterDays, NUDGE.eventIntroAfterDays) : NUDGE.introAfterDays;
    if (age < after * DAY || age > NUDGE.introWithinDays * DAY) continue;
    // Their own texts only: have THEY brought the person up since the intro.
    if (s.ownLines.some((l) => l.at.getTime() > i.introducedAt.getTime() && namesPerson(l.text, i.otherFirstName))) continue;
    const dueAt = wellTimed(s.now, s.zone);
    out.push({
      type: "intro_nudge",
      kind: "intro_followup",
      entryKey: `intro:${i.otherId}`,
      fingerprint: fingerprint(["intro", i.otherId, localDay(i.introducedAt, s.zone)]),
      summary: `The intro to ${i.otherFirstName} by email ${Math.floor(age / DAY)} days ago; they haven't brought it up since`,
      facts: introNudgeFacts(i, s.now),
      meta: { otherId: i.otherId, otherFirstName: i.otherFirstName },
      dueAt,
      expiresAt: new Date(dueAt.getTime() + 4 * DAY),
    });
  }
  return out;
}

// When the heads-up goes and when it's too late, from the item's own date. null: no lead left.
export function deadlineTiming(item: Pick<CaredItem, "kind" | "date">, zone: string | null, now: Date): { day: string; dueAt: Date; expiresAt: Date } | null {
  const day = dayOf(item.date, zone);
  if (!day) return null;
  const lead = item.kind === "event" ? NUDGE.eventLeadDays : NUDGE.opportunityLeadDays;
  const dueDay = DateTime.fromISO(day).minus({ days: lead }).toISODate()!;
  let expiresAt = localAt(day, 12, zone);
  // An event with a known start: never later than three hours before it.
  const start = /T\d{2}:\d{2}/.test(item.date) ? DateTime.fromISO(item.date, { setZone: true }) : null;
  if (start?.isValid) expiresAt = new Date(Math.min(expiresAt.getTime(), start.toJSDate().getTime() - 3 * HOUR));
  let dueAt = localAt(dueDay, NUDGE.sendHour, zone);
  if (dueAt < now) dueAt = now;
  if (expiresAt.getTime() - dueAt.getTime() < HOUR) return null;
  return { day, dueAt, expiresAt };
}

export function detectDeadlineNudges(s: Snapshot): NudgeEntry[] {
  const out: NudgeEntry[] = [];
  for (const item of s.cared) {
    if (item.reminderQueued) continue;
    const t = deadlineTiming(item, s.zone, s.now);
    if (!t) continue;
    // They told Co they cared too close to the heads-up: they know.
    if (item.caredAt.getTime() > localAt(DateTime.fromISO(t.day).minus({ days: item.kind === "event" ? NUDGE.eventLeadDays : NUDGE.opportunityLeadDays }).toISODate()!, NUDGE.sendHour, s.zone).getTime() - NUDGE.caredMinHoursBefore * HOUR) continue;
    const today = localDay(s.now, s.zone);
    const daysLeft = Math.round(DateTime.fromISO(t.day).diff(DateTime.fromISO(today), "days").days);
    out.push({
      type: "deadline_nudge",
      kind: "deadline",
      entryKey: `deadline:${item.itemKey}`,
      fingerprint: fingerprint(["deadline", item.itemKey, t.day]),
      summary: `"${item.name.slice(0, 80)}", which they said yes to, is ${item.kind === "event" ? "on" : "due"} ${t.day}`,
      facts: {
        the_thing: item.name,
        what_it_is: item.kind === "event" ? "an event" : "an opportunity with a deadline",
        [item.kind === "event" ? "the_event_date" : "the_deadline_date"]: `${dayWords(t.day, s.zone)} (${t.day})`,
        when_relative_to_today: daysLeft <= 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`,
        what_they_said_when_co_sent_it: item.theirWords ? item.theirWords.slice(0, 160) : null,
        today: `${dayWords(today, s.zone)} (${today})`,
      },
      meta: { url: item.url, name: item.name },
      dueAt: t.dueAt,
      expiresAt: t.expiresAt,
    });
  }
  return out;
}

// At most one goal: the one quiet longest. A goal unconfirmed for the full season belongs to the seasonal check-in instead.
export function detectGoalNudge(s: Snapshot): NudgeEntry[] {
  if (s.lastGoalSurfaceAt && s.now.getTime() - s.lastGoalSurfaceAt.getTime() < GOAL_CHECKIN.everyDays * DAY) return [];
  if (s.lastKeptAt && s.now.getTime() - s.lastKeptAt.getTime() < NUDGE.goalQuietDays * DAY) return [];
  if (dueGoalCheckin(s.intent, s.lastGoalSurfaceAt, s.now)) return [];
  const quietSince = new Date(s.now.getTime() - NUDGE.goalQuietDays * DAY);
  const slipping = s.goals
    .filter((g) => g.state === "active" && !g.coTask && g.confirmedAt)
    .filter((g) => {
      const age = s.now.getTime() - g.confirmedAt!.getTime();
      return age >= NUDGE.goalQuietDays * DAY && age < GOAL_CHECKIN.minAgeDays * DAY;
    })
    .filter((g) => !mentionedSince(s.ownLines, g.text, quietSince))
    .sort((a, b) => a.confirmedAt!.getTime() - b.confirmedAt!.getTime());
  const g = slipping[0];
  if (!g) return [];
  const lastSaid = mentionedSince(s.ownLines, g.text, new Date(0));
  const dueAt = wellTimed(s.now, s.zone);
  return [
    {
      type: "goal_nudge",
      kind: "goal_nudge",
      entryKey: `goal:${g.id}`,
      fingerprint: fingerprint(["goal", g.id, g.text.trim().toLowerCase(), g.confirmedAt ? localDay(g.confirmedAt, s.zone) : null, lastSaid ? localDay(lastSaid.at, s.zone) : null]),
      summary: `A goal gone quiet for ${Math.floor((s.now.getTime() - g.confirmedAt!.getTime()) / DAY)} days: "${g.text.slice(0, 80)}"`,
      facts: { the_goal_in_their_words: g.text.slice(0, 200) },
      meta: { goalId: g.id },
      dueAt,
      expiresAt: new Date(dueAt.getTime() + 5 * DAY),
    },
  ];
}

export function detectCommitmentNudges(s: Snapshot): NudgeEntry[] {
  const out: NudgeEntry[] = [];
  const today = localDay(s.now, s.zone);
  for (const t of s.commitments) {
    if (!["open", "waiting"].includes(t.status) || t.followedUp) continue;
    if (t.dueDate < today) continue;
    // Said on the day it's due: they know.
    if (localDay(t.openedAt, s.zone) >= t.dueDate) continue;
    const dueAt0 = localAt(t.dueDate, NUDGE.commitmentHour, s.zone);
    const expiresAt = localAt(t.dueDate, NUDGE.commitmentLastHour, s.zone);
    if (expiresAt <= s.now) continue;
    // They're on it: they talked about it lately.
    if (mentionedSince(s.ownLines, `${t.text} ${t.quote}`, new Date(Math.max(t.openedAt.getTime(), s.now.getTime() - NUDGE.commitmentMentionHours * HOUR)))) continue;
    const dueAt = dueAt0 < s.now ? s.now : dueAt0;
    out.push({
      type: "commitment_nudge",
      kind: "member_commitment",
      entryKey: `commitment:${t.threadId}`,
      fingerprint: fingerprint(["commitment", t.threadId, t.dueDate, t.status]),
      summary: `They said they'd ${t.text.slice(0, 80)} by ${t.dueDate}`,
      facts: {
        what_they_said_they_would_do: t.text.slice(0, 200),
        their_own_words: t.quote.slice(0, 200),
        the_due_date: `${dayWords(t.dueDate, s.zone)} (${t.dueDate})`,
        when_relative_to_today: t.dueDate === today ? "today" : "tomorrow or later",
        today: `${dayWords(today, s.zone)} (${today})`,
      },
      meta: { threadId: t.threadId },
      dueAt,
      expiresAt,
    });
  }
  return out;
}

export function detectAll(s: Snapshot): NudgeEntry[] {
  return [...detectIntroNudges(s), ...detectDeadlineNudges(s), ...detectGoalNudge(s), ...detectCommitmentNudges(s)];
}

// Pure: what to queue now. An entry whose stored fingerprint matches already nudged (or tried) for this state; one due more than
// queueAheadHours out waits for a later pass.
export type StoredEntry = { entryKey: string; fingerprint: string; status: string };
export function planNudges(s: Snapshot, stored: StoredEntry[]): { queue: NudgeEntry[]; held: { entry: NudgeEntry; why: string }[] } {
  const queue: NudgeEntry[] = [];
  const held: { entry: NudgeEntry; why: string }[] = [];
  for (const e of detectAll(s)) {
    const prior = stored.find((x) => x.entryKey === e.entryKey);
    if (prior && prior.fingerprint === e.fingerprint) {
      held.push({ entry: e, why: `already ${prior.status} for this state` });
      continue;
    }
    if (e.dueAt.getTime() - s.now.getTime() > NUDGE.queueAheadHours * HOUR) {
      held.push({ entry: e, why: "not close enough to its time yet" });
      continue;
    }
    queue.push(e);
  }
  return { queue, held };
}

export function targetKeyOf(e: Pick<NudgeEntry, "type" | "entryKey" | "fingerprint">): string {
  return `${e.type}:${e.entryKey}:${e.fingerprint}`;
}

// ---------------------------------------------------------------- reads (one member's own record)

const DEFAULT_LOOKBACK_DAYS = 60;

async function ownLinesOf(userId: string): Promise<OwnLine[]> {
  const { rows } = await pool.query(
    `SELECT created_at, memory_type, content FROM co_memories
     WHERE user_id = $1 AND created_at > NOW() - ($2 || ' days')::interval
       AND ((memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}) OR memory_type = 'call_transcript')
     ORDER BY created_at DESC LIMIT 400`,
    [userId, DEFAULT_LOOKBACK_DAYS],
  );
  const out: OwnLine[] = [];
  for (const r of rows.reverse()) {
    const at = new Date(r.created_at);
    if (r.memory_type === "call_transcript") {
      for (const l of String(r.content).split("\n")) {
        const m = l.match(/^\s*user\s*:\s*(.+)$/i);
        if (m) out.push({ at, text: m[1].slice(0, 500) });
      }
    } else out.push({ at, text: String(r.content).replace(/^User said:\s*/, "").slice(0, 500) });
  }
  return out;
}

async function introsOf(userId: string): Promise<IntroFact[]> {
  const [conn, net] = await Promise.all([
    pool.query(
      `SELECT CASE WHEN person_a = $1 THEN person_b ELSE person_a END AS other, source, created_at FROM member_connections
       WHERE (person_a = $1 OR person_b = $1) AND created_at > NOW() - ($2 || ' days')::interval`,
      [userId, NUDGE.introWithinDays + 2],
    ),
    pool.query(
      `SELECT CASE WHEN person_a_id = $1 THEN person_b_id ELSE person_a_id END AS other, match_reason, introduced_at FROM network_introductions
       WHERE status = 'introduced' AND (person_a_id = $1 OR person_b_id = $1) AND introduced_at > NOW() - ($2 || ' days')::interval`,
      [userId, NUDGE.introWithinDays + 2],
    ),
  ]);
  const byOther = new Map<string, { at: Date; how: "event" | "network"; reason: string | null }>();
  for (const r of conn.rows) byOther.set(String(r.other), { at: new Date(r.created_at), how: r.source === "event_intro" ? "event" : "network", reason: null });
  // Only an intro whose email actually went (member_connections is written after a successful send; network_introductions is
  // marked 'introduced' before it, review of the branch 2026-10-08): the network row only adds the reason the email gave.
  for (const r of net.rows) {
    const prev = byOther.get(String(r.other));
    if (prev) byOther.set(String(r.other), { ...prev, reason: r.match_reason ?? null });
  }
  if (!byOther.size) return [];
  const ids = [...byOther.keys()];
  const { rows: people } = await pool.query(`SELECT id, first_name, archived_at FROM users WHERE id = ANY($1::uuid[])`, [ids]);
  const out: IntroFact[] = [];
  for (const p of people) {
    const i = byOther.get(String(p.id))!;
    const first = String(p.first_name ?? "").trim();
    if (!first) continue;
    // The email the recipient received names the event (services/eventGuestMatchHandoff.ts sendIntroEmail); read from their own record.
    const ev = i.how === "event"
      ? await pool
          .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'event_intro_email_sent' AND content LIKE '%' || $2 || '%' ORDER BY created_at DESC LIMIT 1`, [userId, first])
          .then((r) => String(r.rows[0]?.content ?? "").match(/ahead of "(.+?)"/)?.[1] ?? null)
          .catch(() => null)
      : null;
    const follow = await pool
      .query(`SELECT 1 FROM recommendation_outcome_followups WHERE user_id = $1 AND lower(match_name) = lower($2) LIMIT 1`, [userId, `your intro to ${first}`])
      .then((r) => r.rows.length > 0)
      .catch(() => true);
    out.push({ otherId: String(p.id), otherFirstName: first, introducedAt: i.at, how: i.how, eventName: ev, reasonAsEmailed: i.how === "network" ? i.reason : null, hasOutcomeFollowup: follow, otherActive: !p.archived_at });
  }
  return out;
}

async function caredOf(userId: string, zone: string | null): Promise<CaredItem[]> {
  const out: CaredItem[] = [];
  const [liked, offered, reminders, kept] = await Promise.all([
    pool.query(
      `SELECT so.item_key, so.item_name, so.kind, so.note, so.created_at FROM suggestion_outcomes so
       WHERE so.user_id = $1 AND so.result = 'interested' AND so.created_at > NOW() - ($2 || ' days')::interval
         AND NOT EXISTS (SELECT 1 FROM suggestion_outcomes x WHERE x.user_id = so.user_id AND x.item_key = so.item_key
                         AND x.result IN ('declined', 'acted', 'helped', 'didnt_help') AND x.created_at >= so.created_at)`,
      [userId, NUDGE.caredWithinDays],
    ),
    pool.query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type IN ('event_offer_pending', 'recommendation_offered') AND created_at > NOW() - INTERVAL '90 days' ORDER BY created_at DESC LIMIT 200`,
      [userId],
    ),
    pool.query(
      `SELECT lower(payload->'match'->>'name') AS name FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND payload->>'reminder' = 'true' AND status IN ('pending', 'sent')`,
      [userId],
    ),
    pool.query(
      `SELECT id, name, url, find_type, fields, outcome_note, outcome_at FROM research_finds WHERE user_id = $1 AND outcome = 'yes' AND outcome_at > NOW() - ($2 || ' days')::interval`,
      [userId, NUDGE.caredWithinDays],
    ),
  ]);
  const matches: any[] = [];
  for (const r of offered.rows) {
    try {
      const j = JSON.parse(String(r.content));
      matches.push(j?.match ?? j);
    } catch {}
  }
  const reminded = new Set(reminders.rows.map((r: any) => String(r.name ?? "")));
  for (const r of liked.rows) {
    const key = String(r.item_key);
    const m = matches.find((x) => x && ((x.event_api_id && key === `event:${x.event_api_id}`) || String(x.name ?? "").toLowerCase() === String(r.item_name).toLowerCase()));
    const date = m?.event_date ?? m?.deadline ?? m?.start_at ?? null;
    if (!date) continue;
    out.push({ itemKey: key, name: String(r.item_name), kind: r.kind === "opportunity" || m?.tier === 3 ? "opportunity" : "event", date: String(date), caredAt: new Date(r.created_at), theirWords: r.note ?? null, url: m?.url ?? null, reminderQueued: reminded.has(String(r.item_name).toLowerCase()) });
  }
  for (const f of kept.rows) {
    const fields: any[] = Array.isArray(f.fields) ? f.fields : [];
    const date = fields.find((x) => x?.key === "date")?.value ?? null;
    if (!date || !dayOf(String(date), zone)) continue;
    out.push({ itemKey: `find:${f.id}`, name: String(f.name), kind: f.find_type === "event" ? "event" : "opportunity", date: String(date), caredAt: new Date(f.outcome_at), theirWords: f.outcome_note ?? null, url: f.url ?? null, reminderQueued: reminded.has(String(f.name).toLowerCase()) });
  }
  return out;
}

export async function loadSnapshot(userId: string, now = new Date()): Promise<Snapshot> {
  const zone = await memberZone(userId).catch(() => null);
  const { goalEntries } = await import("../harness/profileWrite.js");
  const { goalHash, goalStates, isCoTaskGoal } = await import("./goalEdges.js");
  const [ownLines, intros, cared, prof, states, surface, kept, threads] = await Promise.all([
    ownLinesOf(userId),
    introsOf(userId).catch(() => [] as IntroFact[]),
    caredOf(userId, zone).catch(() => [] as CaredItem[]),
    pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]),
    goalStates(userId).catch(() => new Map()),
    pool.query(`SELECT max(sent_at) AS at FROM proactive_sends WHERE user_id = $1 AND type IN ('goal_checkin', 'goal_nudge')`, [userId]),
    pool.query(
      `SELECT GREATEST((SELECT max(outcome_at) FROM research_finds WHERE user_id = $1 AND outcome = 'yes'),
                       (SELECT max(created_at) FROM suggestion_outcomes WHERE user_id = $1 AND result IN ('interested', 'acted', 'helped'))) AS at`,
      [userId],
    ),
    pool.query(
      `SELECT t.id, t.text, t.opened_quote, t.opened_at, t.due_date, t.status,
              EXISTS (SELECT 1 FROM proactive_sends s WHERE s.user_id = t.user_id AND s.target_key = 'thread:' || t.id) AS followed_up
       FROM member_threads t WHERE t.user_id = $1 AND t.kind = 'commitment' AND t.status IN ('open', 'waiting') AND t.due_date IS NOT NULL AND t.due_date >= CURRENT_DATE - 1`,
      [userId],
    ),
  ]);
  const intent = prof.rows[0]?.intent ?? null;
  const goals: GoalFact[] = goalEntries(intent).map((g: any) => {
    const st = states.get(goalHash(String(g.text)));
    const confirmed = g.confirmed_at ?? g.created_at ?? null;
    return { id: String(g.id ?? goalHash(String(g.text))), text: String(g.text), confirmedAt: confirmed ? new Date(confirmed) : null, state: st?.state ?? "active", coTask: isCoTaskGoal(String(g.text)) };
  });
  return {
    userId,
    zone,
    now,
    ownLines,
    intros,
    cared,
    goals,
    intent,
    lastGoalSurfaceAt: surface.rows[0]?.at ? new Date(surface.rows[0].at) : null,
    lastKeptAt: kept.rows[0]?.at ? new Date(kept.rows[0].at) : null,
    commitments: threads.rows.map((t: any) => ({
      threadId: String(t.id),
      text: String(t.text),
      quote: String(t.opened_quote ?? ""),
      openedAt: new Date(t.opened_at),
      dueDate: t.due_date instanceof Date ? DateTime.fromJSDate(t.due_date, { zone: "utc" }).toISODate()! : String(t.due_date).slice(0, 10),
      status: String(t.status),
      followedUp: !!t.followed_up,
    })),
  };
}

async function storedOf(userId: string): Promise<StoredEntry[]> {
  const { rows } = await pool.query(`SELECT entry_key, fingerprint, status FROM member_state_nudges WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ entryKey: String(r.entry_key), fingerprint: String(r.fingerprint), status: String(r.status) }));
}

// The entry as it stands right now, if the state a candidate was queued for still holds (re-read at draft time, never trusted from
// the queue). Its facts are today's: "tomorrow" at queue time is "today" when it goes.
export async function currentEntry(userId: string, entryKey: string, fp: string, now = new Date()): Promise<NudgeEntry | null> {
  const s = await loadSnapshot(userId, now);
  return detectAll(s).find((e) => e.entryKey === entryKey && e.fingerprint === fp) ?? null;
}

// Only the row for this state: a candidate for an older state, dropped after a newer one was queued, leaves the newer one alone.
export async function markEntry(userId: string, entryKey: string, fp: string, status: "sent" | "dropped", reason: string | null = null): Promise<void> {
  await pool
    .query(`UPDATE member_state_nudges SET status = $4, reason = COALESCE($5, reason), updated_at = NOW()${status === "sent" ? ", sent_at = NOW()" : ""} WHERE user_id = $1 AND entry_key = $2 AND fingerprint = $3`, [userId, entryKey, fp, status, reason])
    .catch((err: any) => console.error("memberStateNudges: marking an entry failed (non-fatal):", err?.message ?? err));
}

// ---------------------------------------------------------------- the hourly pass

export async function runMemberStateNudges(now = new Date()): Promise<{ members: number; queued: number }> {
  const { proactivePaused } = await import("./proactivePause.js");
  if (proactivePaused()) return { members: 0, queued: 0 };
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
     WHERE u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false AND u.phone_number IS NOT NULL
       AND (EXISTS (SELECT 1 FROM member_connections c WHERE (c.person_a = u.id OR c.person_b = u.id) AND c.created_at > NOW() - INTERVAL '30 days')
         OR EXISTS (SELECT 1 FROM network_introductions n WHERE (n.person_a_id = u.id OR n.person_b_id = u.id) AND n.introduced_at > NOW() - INTERVAL '30 days')
         OR EXISTS (SELECT 1 FROM suggestion_outcomes s WHERE s.user_id = u.id AND s.result = 'interested' AND s.created_at > NOW() - INTERVAL '45 days')
         OR EXISTS (SELECT 1 FROM research_finds f WHERE f.user_id = u.id AND f.outcome = 'yes' AND f.outcome_at > NOW() - INTERVAL '45 days')
         OR EXISTS (SELECT 1 FROM member_threads t WHERE t.user_id = u.id AND t.kind = 'commitment' AND t.status IN ('open', 'waiting'))
         OR EXISTS (SELECT 1 FROM co_profiles p WHERE p.user_id = u.id AND jsonb_typeof(p.intent) = 'array'
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.intent) e WHERE e->>'kind' = 'goal' AND e->>'status' = 'active')))
     LIMIT 500`,
  );
  const { enqueueCandidate } = await import("../harness/proactive.js");
  const { recordDecision } = await import("../harness/core.js");
  let queued = 0;
  for (const r of rows) {
    const userId = String(r.id);
    try {
      const snap = await loadSnapshot(userId, now);
      const plan = planNudges(snap, await storedOf(userId));
      for (const e of plan.queue) {
        const targetKey = targetKeyOf(e);
        const res = await enqueueCandidate({
          userId,
          type: e.type,
          targetKey,
          topicKey: `msn:${e.entryKey}:${e.fingerprint}`,
          summary: e.summary,
          payload: { entryKey: e.entryKey, fingerprint: e.fingerprint, kind: e.kind, facts: e.facts, meta: e.meta },
          dueAt: e.dueAt,
          expiresAt: e.expiresAt,
        }).catch((err: any) => {
          console.error("memberStateNudges: enqueue failed (non-fatal, tried again next pass):", err?.message ?? err);
          return null;
        });
        if (!res) continue;
        // Recorded as tried whether it queued or its target was already used (a used target never re-queues for the same state).
        await pool.query(
          `INSERT INTO member_state_nudges (user_id, entry_key, kind, fingerprint, target_key, status, queued_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'queued', NOW(), NOW())
           ON CONFLICT (user_id, entry_key) DO UPDATE SET kind = EXCLUDED.kind, fingerprint = EXCLUDED.fingerprint, target_key = EXCLUDED.target_key,
             status = 'queued', queued_at = NOW(), sent_at = NULL, reason = NULL, updated_at = NOW()`,
          [userId, e.entryKey, e.kind, e.fingerprint, targetKey],
        );
        // A pending nudge for an older state of the same entry is stale now.
        await pool.query(
          `UPDATE proactive_candidates SET status = 'skipped', skip_reason = 'state changed', decided_at = NOW(), updated_at = NOW()
           WHERE user_id = $1 AND type = $2 AND status = 'pending' AND payload->>'entryKey' = $3 AND target_key <> $4`,
          [userId, e.type, e.entryKey, targetKey],
        );
        if (res.queued) queued++;
        await recordDecision({ layer: 7, decision: "proactive.memberState", userId, outcome: res.queued ? "act" : "skip", action: `queue:${e.type}`, reason: e.summary, proposal: { entryKey: e.entryKey, fingerprint: e.fingerprint, dueAt: e.dueAt.toISOString(), expiresAt: e.expiresAt.toISOString() } }).catch(() => {});
      }
    } catch (err: any) {
      console.error("memberStateNudges: a member's pass failed (non-fatal):", err?.message ?? err);
    }
  }
  return { members: rows.length, queued };
}

// ---------------------------------------------------------------- drafting (the registry entries, harness/proactiveRegistry.ts)

type Facts = Record<string, string | number | null>;
const TASKS: Record<NudgeType, (f: Facts) => string> = {
  intro_nudge: (f) =>
    `Co introduced them to ${f.their_name} by email a few days ago and they haven't brought it up since. Write one short text about it, from what's above: either ask lightly whether the two of them got a chance to connect, or offer one concrete thing you could do for it right now (for example, drafting a short note they could send ${f.their_name}). Say nothing at all about ${f.their_name}: not whether they saw the email, replied, are waiting, or did anything, and nothing they said or want. Name ${f.their_name}. If nothing natural comes, SKIP.`,
  deadline_nudge: (f) =>
    `They told you they were interested in "${f.the_thing}". Its ${f.the_event_date ? "date" : "deadline"} is close (${f.when_relative_to_today}). Write one short heads-up so it doesn't slip by: name it and when, and if it needs an RSVP, a ticket or an application, say so plainly. No pitch, nothing new, no promise. At most one yes or no question, only if there's something you could do for them with it.`,
  goal_nudge: () =>
    `This is something they told you they're working toward, and it has gone quiet for a few weeks. Surface it once, gently, the way a friend who remembered would: name it in their own plain words, then either offer one concrete thing you could do for it now, or ask one light question about where it stands that makes it easy to say it has shifted. No dates, no guilt, no pressure, no advice, never a generic check-in.`,
  commitment_nudge: (f) =>
    `They told you they would do this, in their own words above, and it's due ${f.when_relative_to_today}. Write one light nudge so it doesn't slip: name the thing in their words, and if there's an obvious way you could help get it done (a draft, a quick read of it), offer that in a few words. Encouraging, never a lecture, nothing about how long ago they said it.`,
};
const RULES: Record<NudgeType, { maxSentences: number; maxChars: number }> = {
  intro_nudge: { maxSentences: 2, maxChars: 240 },
  deadline_nudge: { maxSentences: 2, maxChars: 260 },
  goal_nudge: { maxSentences: 2, maxChars: 220 },
  commitment_nudge: { maxSentences: 2, maxChars: 240 },
};

// What the model may state for this candidate: the facts stored at queue time, and nothing from anyone else.
export function draftFactsOf(c: { payload: any }): Facts {
  const f = (c.payload?.facts ?? {}) as Facts;
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

type Cand = { id: string; userId: string; type: string; payload: any };
type Person = { firstName: string };
type Draft = { messages: string[]; text: string; rules: any } | { skip: string };

export async function draftStateNudge(c: Cand, person: Person, deps: { current?: typeof currentEntry; leak?: (text: string, otherId: string) => Promise<string | null> } = {}): Promise<Draft> {
  const type = c.type as NudgeType;
  const p = c.payload ?? {};
  if (!NUDGE_TYPES.includes(type) || !p.entryKey || !p.fingerprint) return { skip: "not a member-state nudge" };
  // Re-read: the state it was queued for must still hold (they brought it up, the deadline passed, the goal closed...).
  const now = await (deps.current ?? currentEntry)(c.userId, String(p.entryKey), String(p.fingerprint)).catch(() => null);
  if (!now) return { skip: "the state it was about has changed" };
  const { draftProactive, nameTokens } = await import("../harness/proactive.js");
  // Today's facts for the same state (built the same way, from the recipient's own record); the queued ones only if they're missing.
  const facts = Object.keys(now.facts).length ? draftFactsOf({ payload: { facts: now.facts } }) : draftFactsOf(c);
  const text = await draftProactive({ functionId: `memberState.${type}.draft`, firstName: person.firstName, facts, task: TASKS[type](facts) });
  if (!text) return { skip: "model chose SKIP" };
  const rules: any = { ...RULES[type] };
  if (type === "intro_nudge") {
    const other = String(p.meta?.otherFirstName ?? facts.their_name ?? "");
    const { checkInterestClaim } = await import("../harness/introConsent.js");
    const claim = checkInterestClaim(text, { otherFirstName: other, otherOptedIn: true, recipientOptedIn: true, recipientFirstName: person.firstName });
    if (!claim.pass) return { skip: `says more about ${other} than the member knows: ${claim.reason}` };
    const leak = await (deps.leak ?? (async (t: string, id: string) => (await import("./coFacts.js")).privateFactLeak(t, id)))(text, String(p.meta?.otherId ?? "")).catch(() => "the leak check could not run");
    if (leak) return { skip: `carries something only ${other} may see` };
    rules.mustIncludeAny = [other];
    rules.forbidden = INTRO_STATUS_FORBIDDEN;
  }
  if (type === "deadline_nudge") {
    const name = String(facts.the_thing ?? "");
    rules.mustIncludeAny = nameTokens(name).length ? nameTokens(name) : [name];
  }
  // A link on file goes as its own message, after the words.
  const url = type === "deadline_nudge" && typeof p.meta?.url === "string" && /^https?:\/\//.test(p.meta.url) ? [p.meta.url as string] : [];
  return { messages: [text, ...url], text, rules };
}

export async function onStateNudgeSent(c: Cand, messages: string[]): Promise<void> {
  await markEntry(c.userId, String(c.payload?.entryKey ?? ""), String(c.payload?.fingerprint ?? ""), "sent");
  const { writeMemory } = await import("./memory.js");
  await writeMemory(c.userId, "check_in", `Co noticed on its own (${c.type.replace(/_nudge$/, "")}): ${messages[0] ?? ""}`).catch(() => {});
}

export async function onStateNudgeDropped(c: Cand, status: string, reason?: string): Promise<void> {
  await markEntry(c.userId, String(c.payload?.entryKey ?? ""), String(c.payload?.fingerprint ?? ""), "dropped", `${status}${reason ? `: ${reason}` : ""}`.slice(0, 300));
}
