// Update announcements (Royce, 2026-10-19): the one-time rename notice (services/nameChange.ts), generalized. When something changes
// for members, Cue tells each member it applies to once, in a text of its own, and only says what changed, what it means for them,
// and one thing to try. Royce's complaint about the rename: members got "Quick one: I'm going by Cue now. Same me, new name." and
// nothing about what the shift means or what Cue can do now.
//
// Each announcement here is fixed, approved wording. No model writes any of it (Cue has a history of overclaiming its own actions,
// so the words that say what it does are set by hand and checked against the code). Never a changelog, never stats, never "I
// shipped X" (feedback: no system-stats texts about Cue itself).
//   key       its ledger target_key: one proactive_sends row per member (unique on user_id + target_key) means once, ever.
//   approved  a code constant, no env switch: an announcement whose wording Royce hasn't approved is never queued, and its draft,
//             if it were ever reached, defers without reading anything.
//   audience  members who knew what it changes: joined before the change (the rename's cutoff, or a fixed moment for a later one).
//             Someone who joined after only ever knew the new behavior and is never told about a change they didn't live through. The
//             rest of who is left out is the same for every announcement: no phone, a test number (555-01xx) or simulated member,
//             archived, opted out, never finished joining, already told or already queued.
//   texts     fixed texts sent as separate messages, in order, in place of lead + body + try line (one send, one ledger row).
//   monthly   at most one announcement a calendar month (Pacific), across every key: one is never queued while another went to a
//             member this month or still waits to (monthlyLimit). The rename is its own notice and isn't counted.
//   expiry    when what hasn't gone by then never goes: a fixed day, or a number of days after the first one was queued.
//   tryLines  the one "thing to try" line, picked from approved lines by the member's situation, in code, at send time ($0). What
//             Cue knows about them only picks among approved words; it never decides whether they get it.
//   changes   (2026-11-08) one text, one change: several approved one-text lines, each with the situation it fits and a priority.
//             The member gets the first that fits (lowest priority number first), picked in code at send time ($0), or NOTHING:
//             no fit is no send, never a generic fallback. A signal that couldn't be read fits nothing (pickChange, changeSituationOf).
//   overrideMonthly  an explicit, dated exception to the monthly limit for this one announcement (who said so, and when). The rule
//             itself stays: every announcement without it is still held by monthlyLimit.
//   foldLead  for an announcement that follows the rename: a member the rename notice hasn't reached yet gets ONE text that opens
//             with the rename's own words instead of the follow-up's lead, and the rename's ledger key is claimed with it, inside
//             the send lock (harness/proactive.ts sendWithLedger's ride). Never two texts.
//
// Delivery is the normal proactive path (harness/proactive.ts), exactly as the rename notice: hours, opt-out, the conversation hold,
// the safety hold, pacing, a quiet member's taper, archived accounts skipped. A full announcement is too long to ride in another text
// and never does: it goes as its own text, at the lowest priority, only on a day nothing else is ready (quietDayOnly), and nothing rides
// in it except the rename it carries. It never stacks: while another of their candidates is due today, or a deferred send of theirs is
// queued, its draft waits (othersWaitingOf, STACK_WAIT_HOURS).
// A hard day (2026-11-08): no longer a class hold (announcements left HOLD_WHILE_STRUGGLING). Every announcement is judged right before
// it goes by the send-time read (harness/momentFit.ts: send, wait or drop), which is told when they've had a hard stretch: a reason to
// be more thoughtful about whether this particular message helps now, not a blanket silence.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { isTestNumber } from "./testNumbers.js";
import { notToTeammate } from "./teamLines.js";
import { goalTexts } from "./goalJourney.js";
import { NAME_CHANGE_EXPIRES, NAME_CHANGE_KEY, NAME_CHANGE_TEXT, carriesNameChange } from "./nameChange.js";
import type { Candidate, DraftResult, EnqueueInput, ProactiveType } from "../harness/proactive.js";

// What the "thing to try" line is picked by. Read at send time from the member's own record; a read that fails is the default.
export type Situation = { hasOwnGoal: boolean };
export type TryLine = { when: "default" | "own_goal"; line: string };

// What the one change is picked by (2026-11-08), read at send time from the member's own record. null: that signal couldn't be read,
// and a change that needs it doesn't fit (fail closed: nothing goes rather than the wrong line).
//   joinedAt          when they joined: a change they never lived through (they joined after it landed) never fits;
//   talkDays          how many different days they've texted Cue (their own texts, within the daily notes' lookback);
//   usedRemovedMaker  Cue made a page, deck, document or email draft for them before the makers were removed;
//   hadCalls          they've had at least one call with Cue (a stored call transcript or call summary);
//   makerChangeTold   they've already been told the makers changed (the first-use note in a reply, services/firstUseNotes.ts).
export type ChangeSituation = { joinedAt: Date | null; talkDays: number | null; usedRemovedMaker: boolean | null; hadCalls: boolean | null; makerChangeTold: boolean | null };
// One change: its approved one-text line, the moment it landed, the situation it fits, and its priority (lower goes first when more
// than one fits).
export type Change = { id: string; line: string; landed: Date; priority: number; fits: (s: ChangeSituation) => boolean };

export type Announcement = {
  key: string;
  type: Extract<ProactiveType, "name_change" | "announcement">;
  approved: boolean;
  // Team-facing: what it is, for the decision log and the pick (never sent).
  summary: string;
  // The fixed text, in order: what changed, then what it means for them. The try line goes last.
  lead: string;
  body: string;
  tryLines: TryLine[];
  foldLead?: string;
  // Sentences of the approved wording the draft check's narration rule would otherwise refuse (harness/proactive.ts checkDraft,
  // approvedSentences): admitted by exact match only, each named here so the exception is visible.
  narrationApproved?: readonly string[];
  // Separate fixed texts, in order, sent in place of lead + body + try line (one send).
  texts?: readonly string[];
  // "knew_co": joined before the rename's first notice. joinedBefore: joined before this change landed.
  audience: "knew_co" | { joinedBefore: Date };
  expires: { at: Date } | { daysAfterFirstQueued: number };
  // One text, one change (2026-11-08): the approved changes; the member gets the first that fits, or nothing. Sent in place of lead +
  // body + try line.
  changes?: readonly Change[];
  // An explicit exception to the monthly limit for this announcement: who said so and on what day (YYYY-MM-DD). Never an env switch.
  overrideMonthly?: { by: string; on: string };
};

// ---------------------------------------------------------------- the registry

// The rename notice, ported as it was (services/nameChange.ts holds its words, its riding line and its end): approved and live since
// 2026-10-14, queued by queueNameChange, drafted by proactiveRegistry.name_change, riding in other texts on the stop-note terms.
// Nothing about it changes for any member it has reached or will reach.
export const RENAME: Announcement = {
  key: NAME_CHANGE_KEY,
  type: "name_change",
  approved: true,
  summary: "Tell them, once, that it goes by Cue now",
  lead: NAME_CHANGE_TEXT,
  body: "",
  tryLines: [],
  audience: "knew_co",
  expires: { at: NAME_CHANGE_EXPIRES },
};

// "The shift": the follow-up to the rename for members who knew Co. Wording approved by Royce 2026-10-23 (option A; opening "We're
// Noise now, and I'm Cue."; "Noise night"; both try lines reworded so every claim is true in code). SHIFT_APPROVED false stops it.
// The claims were checked against the code on 2026-10-19; see the PR.
export const SHIFT_APPROVED = true;
export const SHIFT_KEY = "announcement:shift";
export const SHIFT_LEAD = "We're Noise now, and I'm Cue.";
export const SHIFT_BODY =
  "Noise is for the stretches when life is shifting: a new city, a new role, starting something. My part is knowing what you're in the middle of and finding the person worth meeting for it, at a Noise night or between them. I only introduce you when you both say yes.";
export const SHIFT_TRY_DEFAULT = "If something's shifting for you right now, tell me who'd be good to meet for it and I'll start looking.";
export const SHIFT_TRY_GOAL = "Tell me who'd be good to meet for what you're working on, and I'll start looking.";
export const SHIFT_LIVE_DAYS = 21;
export const SHIFT: Announcement = {
  key: SHIFT_KEY,
  type: "announcement",
  approved: SHIFT_APPROVED,
  summary: "Tell them, once, what the new name means for them and one thing to try",
  lead: SHIFT_LEAD,
  body: SHIFT_BODY,
  // First match wins; the default is last.
  tryLines: [
    { when: "own_goal", line: SHIFT_TRY_GOAL },
    { when: "default", line: SHIFT_TRY_DEFAULT },
  ],
  // The opening already says the new name, so a member the rename hasn't reached gets the same opening; the rename's key is still
  // claimed with it (carriesNameChange knows this opening), so the old notice never follows as a second text.
  foldLead: SHIFT_LEAD,
  audience: "knew_co",
  expires: { daysAfterFirstQueued: SHIFT_LIVE_DAYS },
};

// The 2026-11-02 update: calls, contact rules, voice memos. Wording approved by Royce 2026-11-02 ("go with the list, drop the page"):
// version B, three texts, no link or page. UPDATE_1102_APPROVED false stops it. Every claim was checked against co-test on 2026-11-02
// (see the PR): calls on GPT-Live with answers streamed sentence by sentence (#337, #345); the member's own contact rules enforced on
// every text and call Cue starts (#355, #356, #362); voice memos transcribed and answered in kind in the calls' voice, marin (#360).
// For members who joined before the first of those landed (#345, 2026-11-02 18:45 UTC): a later joiner only ever knew the new way.
export const UPDATE_1102_APPROVED = true;
export const UPDATE_1102_KEY = "announcement:update-2026-11";
export const UPDATE_1102_JOINED_BEFORE = new Date("2026-11-02T18:45:06Z");
export const UPDATE_1102_TEXTS = [
  "A few things changed on my side:",
  '· Calls feel like a real conversation now, and I answer sooner\n· Tell me how often or when to reach you, like "once a day" or "not on Sundays", and I\'ll keep to it\n· Send a voice memo anytime. If I reply in kind, it\'s the same voice as my calls',
  "Ask me to call you if you want to hear it.",
] as const;
export const UPDATE_1102_LIVE_DAYS = 21;
export const UPDATE_1102: Announcement = {
  key: UPDATE_1102_KEY,
  type: "announcement",
  approved: UPDATE_1102_APPROVED,
  summary: "Tell them, once, what changed on Cue's side: calls, when to reach them, voice memos",
  lead: UPDATE_1102_TEXTS[0],
  body: "",
  tryLines: [],
  texts: UPDATE_1102_TEXTS,
  // "on my side" is on the narration rule's list (speakable.ts NARRATION_RULES, machinery talk). Royce approved this opening as written
  // on 2026-11-02; without this the draft check would refuse it on every try and the update would never go. See the PR.
  narrationApproved: [UPDATE_1102_TEXTS[0]],
  audience: { joinedBefore: UPDATE_1102_JOINED_BEFORE },
  expires: { daysAfterFirstQueued: UPDATE_1102_LIVE_DAYS },
};

// One text, one change (drafted 2026-11-08; ONE_CHANGE_APPROVED false: the wording waits on approval, so nothing is queued). Each member
// gets the one change most relevant to them, or nothing. No list, no "on my side" lead. Every claim checked against the code (see the PR):
//   helpers  the makers were removed (#386-#388); a person to meet for it is an intro ask (askKind.ts "person", routed to network
//            surfacing in jobs/index.ts), which is a look among the people Cue knows, never a promised find;
//   recall   lookBack over their own texts and calls (services/conversationRecall.ts; capabilities.ts look_back, onCall): a keyword and
//            meaning lookup that can miss, so the line promises a look;
//   notes    the nightly daily notes (services/daySummaries.ts, switched on 2026-11-07), each shown in what Cue knows and removable
//            (services/whatCoKnows.ts summary:<day>). A day too short to summarize gets no note, so the line doesn't say "each day";
//            and not every line of what Cue knows is removable (an arrival record stays), so it says the notes go, not "anything".
export const ONE_CHANGE_APPROVED = false;
export const ONE_CHANGE_KEY = "announcement:one-change-2026-11";
export const ONE_CHANGE_LIVE_DAYS = 21;
// When each change landed (the merge, or the switch-on), so a member who joined after it only ever knew the new way.
export const HELPERS_REMOVED_AT = new Date("2026-11-05T03:45:40Z");
export const RECALL_LANDED_AT = new Date("2026-11-06T18:37:59Z");
export const DAILY_NOTES_LANDED_AT = new Date("2026-11-07T17:09:21Z");
// Daily notes: they've texted Cue on at least this many different days, so there are notes worth seeing.
export const NOTES_MIN_DAYS = 3;
export const ONE_CHANGE_HELPERS =
  "I've stopped making decks, pages and email drafts so I can put that time into who you should meet. If you need one made, tell me and I'll look for someone you could meet who does that.";
export const ONE_CHANGE_RECALL =
  "I can look back on what we've talked about before now, by text or on a call. Ask me about something from a while ago and I'll look for it.";
export const ONE_CHANGE_NOTES =
  "I keep short notes on what we talk about now, and you can see every one. Ask me what I know about you, and any note you'd rather I didn't keep is gone when you say so.";
const knewBefore = (s: ChangeSituation, at: Date) => !!s.joinedAt && s.joinedAt.getTime() < at.getTime();
export const ONE_CHANGE_CHANGES: readonly Change[] = [
  // Most relevant first: something they used is gone (and a reply hasn't already told them).
  { id: "helpers", line: ONE_CHANGE_HELPERS, landed: HELPERS_REMOVED_AT, priority: 1, fits: (s) => knewBefore(s, HELPERS_REMOVED_AT) && s.usedRemovedMaker === true && s.makerChangeTold === false },
  { id: "recall", line: ONE_CHANGE_RECALL, landed: RECALL_LANDED_AT, priority: 2, fits: (s) => knewBefore(s, RECALL_LANDED_AT) && s.hadCalls === true },
  { id: "notes", line: ONE_CHANGE_NOTES, landed: DAILY_NOTES_LANDED_AT, priority: 3, fits: (s) => knewBefore(s, DAILY_NOTES_LANDED_AT) && s.talkDays !== null && s.talkDays >= NOTES_MIN_DAYS },
];
export const ONE_CHANGE: Announcement = {
  key: ONE_CHANGE_KEY,
  type: "announcement",
  approved: ONE_CHANGE_APPROVED,
  summary: "Tell them, once, the one change most relevant to them (makers gone, looking back, daily notes), or nothing",
  lead: "",
  body: "",
  tryLines: [],
  changes: ONE_CHANGE_CHANGES,
  // The latest change: anyone who joined before it lived through at least one; each change's own moment is checked again at the pick.
  audience: { joinedBefore: DAILY_NOTES_LANDED_AT },
  expires: { daysAfterFirstQueued: ONE_CHANGE_LIVE_DAYS },
};

// Every announcement, in the order they are queued. The rename is queued by its own job first (jobs/index.ts), so a member's rename
// candidate exists before a follow-up that carries it.
export const ANNOUNCEMENTS: readonly Announcement[] = [RENAME, SHIFT, UPDATE_1102, ONE_CHANGE];
export function announcementByKey(key: string): Announcement | null {
  return ANNOUNCEMENTS.find((a) => a.key === key) ?? null;
}

// Proactive drafting rules for an announcement's own text: it is longer than a check-in, one paragraph, no question, no link.
export const ANNOUNCEMENT_RULES = { maxChars: 520, maxSentences: 6 } as const;

// ---------------------------------------------------------------- pure

// The try line for this member: the first approved line their situation fits, else the default. Never null when the announcement
// has lines.
export function pickTryLine(a: Pick<Announcement, "tryLines">, s: Situation): string | null {
  const fits = (t: TryLine) => t.when === "default" || (t.when === "own_goal" && s.hasOwnGoal);
  return a.tryLines.find(fits)?.line ?? null;
}

// The one change for this member: the first (by priority, then registry order) whose situation fits, or null (nothing goes). A
// predicate that throws fits nothing.
export function pickChange(a: Pick<Announcement, "changes">, s: ChangeSituation): Change | null {
  const ordered = [...(a.changes ?? [])].map((c, i) => ({ c, i })).sort((x, y) => x.c.priority - y.c.priority || x.i - y.i);
  for (const { c } of ordered) {
    let ok = false;
    try {
      ok = c.fits(s) === true;
    } catch {
      ok = false;
    }
    if (ok) return c;
  }
  return null;
}

// The text: the lead (or, for a member the rename hasn't reached, the rename's words), the body, the try line. One text.
export function announcementText(a: Announcement, s: Situation, o: { nameTold: boolean }): string {
  const lead = a.foldLead && !o.nameTold ? a.foldLead : a.lead;
  return [lead, a.body, pickTryLine(a, s)].filter((x): x is string => !!x && !!x.trim()).join(" ");
}

// The messages that go: an announcement's own separate texts when it has them, else its one text.
export function announcementMessages(a: Announcement, s: Situation, o: { nameTold: boolean }): string[] {
  return a.texts?.length ? [...a.texts] : [announcementText(a, s, o)];
}

// The same text as if the rename had already reached them: what goes if, inside the send lock, the rename's key was already taken
// (another text carried it a moment ago). Null if this text doesn't open with the rename's words.
export function unfolded(a: Announcement, messages: string[]): string[] | null {
  if (!a.foldLead || messages.length !== 1 || !messages[0].startsWith(a.foldLead)) return null;
  return [`${a.lead}${messages[0].slice(a.foldLead.length)}`];
}

// The rename riding in this announcement's own text, claimed with it inside the send lock (sendWithLedger's ride): the member's
// queued rename notice when there is one (it is then marked sent with this text), or, when none is queued (it was dropped, or never
// queued), the rename's key claimed under this announcement's own row, so the rename is never queued or sent after it.
// null: nothing to claim (this text doesn't carry the rename). "unfoldable": it carries the rename but its fallback can't be built,
// so it must not go this time.
export function nameFold(c: Candidate, messages: string[], pending: Candidate[]): { candidate: Candidate; without: string[] } | "unfoldable" | null {
  const a = announcementByKey(c.targetKey);
  if (!a?.foldLead || !carriesNameChange(messages.join("\n"))) return null;
  const without = unfolded(a, messages);
  if (!without) return "unfoldable";
  const queued = pending.find((x) => x.type === "name_change" && x.targetKey === NAME_CHANGE_KEY && x.userId === c.userId);
  return { candidate: queued ?? { ...c, type: "name_change", targetKey: NAME_CHANGE_KEY, topicKey: NAME_CHANGE_KEY }, without };
}

// What the day's pick sees (harness/proactive.ts dispatch): an announcement only on a day nothing else is ready, and then one at a
// time, the oldest first. It never competes with, or rides in, anything else.
export function quietDayOnly<T extends Pick<Candidate, "type" | "createdAt">>(eligible: T[]): T[] {
  const others = eligible.filter((x) => x.type !== "announcement");
  if (others.length) return others;
  const first = [...eligible].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0];
  return first ? [first] : [];
}

// When it ends: a fixed day, or so many days after its first candidate was queued (so a member queued later gets no fresh window).
export function expiryOf(a: Pick<Announcement, "expires">, firstQueuedAt: Date | null, now: Date): Date {
  if ("at" in a.expires) return a.expires.at;
  return new Date((firstQueuedAt ?? now).getTime() + a.expires.daysAfterFirstQueued * 86_400_000);
}

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

// A member row from the audience query. The query already leaves these out; this is the same rule in code, so a wrong row is still
// never queued.
export type AudienceRow = { id: string; created_at: Date | string; archived_at: Date | string | null; sms_opted_out: boolean | null; has_phone: boolean; invite_verified: boolean | null; told: boolean; queued: boolean; phone_number?: string | null; simulated?: boolean | null };
// Why a member is left out, or null when they are in. The first reason that applies, in this order.
export type Exclusion = "joined_after" | "archived" | "opted_out" | "no_phone" | "test_number" | "unfinished" | "told" | "queued";
export function exclusionOf(r: AudienceRow, cutoff: Date): Exclusion | null {
  if (new Date(r.created_at).getTime() >= cutoff.getTime()) return "joined_after";
  if (r.archived_at) return "archived";
  if (r.sms_opted_out === true) return "opted_out";
  if (!r.has_phone) return "no_phone";
  // A 555-01xx number is fiction on any server (services/testNumbers.ts), so the env switch is ignored here.
  if (r.simulated === true || isTestNumber(r.phone_number ?? null, {})) return "test_number";
  // "unfinished" is no invite: a verified member gets it with or without a name or email on file (Royce, 2026-11-03; ruling A).
  if (r.invite_verified !== true) return "unfinished";
  if (r.told) return "told";
  if (r.queued) return "queued";
  return null;
}
export function inAudience(r: AudienceRow, cutoff: Date): boolean {
  return exclusionOf(r, cutoff) === null;
}

// ---------------------------------------------------------------- the monthly limit

// The calendar month is Pacific's, as the queue job's (jobs/index.ts, 09:40 America/Los_Angeles).
export const MONTH_ZONE = "America/Los_Angeles";
export function monthStart(now: Date): Date {
  return DateTime.fromJSDate(now).setZone(MONTH_ZONE).startOf("month").toJSDate();
}
// Pure: why this announcement can't be queued this month (another one went to a member this month, or still waits to go), or null.
export type OtherAnnouncement = { target_key: string; state: "sent" | "pending"; n: number | string };
export function monthlyBlock(key: string, others: OtherAnnouncement[]): string | null {
  const o = others.filter((x) => x.target_key !== key && Number(x.n) > 0);
  if (!o.length) return null;
  return `one announcement a month: ${o.map((x) => `${x.target_key} ${x.state === "sent" ? "went to" : "still waits for"} ${Number(x.n)} member(s)`).join("; ")}`;
}
const OTHERS_SQL = `SELECT target_key, 'sent' AS state, COUNT(*) AS n FROM proactive_sends
                     WHERE type = 'announcement' AND target_key <> $1 AND sent_at >= $2 GROUP BY target_key
                    UNION ALL
                    SELECT target_key, 'pending' AS state, COUNT(*) AS n FROM proactive_candidates
                     WHERE type = 'announcement' AND target_key <> $1 AND status = 'pending' GROUP BY target_key`;
// Pure: this announcement's explicit, dated exception (who, and a YYYY-MM-DD day), or null. A malformed one is no exception.
export function monthlyOverride(a: Pick<Announcement, "overrideMonthly">): { by: string; on: string } | null {
  const o = a.overrideMonthly;
  return o && String(o.by ?? "").trim() && /^\d{4}-\d{2}-\d{2}$/.test(String(o.on ?? "")) ? o : null;
}
export async function monthlyLimit(db: Db, a: Pick<Announcement, "key" | "type" | "overrideMonthly">, now: Date): Promise<string | null> {
  if (a.type !== "announcement") return null;
  // The rule stays the default; only an announcement given an explicit exception skips it (said in the queue's log).
  if (monthlyOverride(a)) return null;
  const { rows } = await db.query(OTHERS_SQL, [a.key, monthStart(now)]);
  return monthlyBlock(a.key, rows as OtherAnnouncement[]);
}

// ---------------------------------------------------------------- queue

export type QueueDeps = { db: Db; enqueue: (input: EnqueueInput) => Promise<{ queued: boolean }>; log: (line: string) => void };
const realQueueDeps = async (): Promise<QueueDeps> => ({ db: pool, enqueue: (await import("../harness/proactive.js")).enqueueCandidate, log: (l) => console.log(l) });

// Who knew Co: members who joined before the rename's first notice was queued. The first time the rename is queued fixes it, so a
// member who joins after the rename, and only ever heard "Cue", is never told about a name they never knew. Null before then.
export async function renameCutoff(db: Db = pool): Promise<Date | null> {
  const { rows } = await db.query(`SELECT MIN(created_at) AS at FROM proactive_candidates WHERE type = 'name_change'`);
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

// The join cutoff: the rename's (it fixes its own the first time it runs; a follow-up waits until it has started), or the fixed moment.
export async function audienceCutoff(a: Announcement, now: Date, db: Db): Promise<Date | null> {
  if (a.audience !== "knew_co") return a.audience.joinedBefore;
  return (await renameCutoff(db)) ?? (a.key === NAME_CHANGE_KEY ? now : null);
}

// Queues one announcement for everyone it is for. Idempotent: a member already queued or told is skipped (and enqueueCandidate
// refuses a key that was sent, skipped or expired). Returns how many were queued.
export async function queueAnnouncement(a: Announcement, now: Date = new Date(), deps?: Partial<QueueDeps> & { approved?: boolean }): Promise<number> {
  const d = { ...(await realQueueDeps()), ...deps };
  if (!(deps?.approved ?? a.approved)) {
    d.log(`announcement ${a.key}: its wording is waiting on Royce's approval; nothing queued`);
    return 0;
  }
  const cutoff = await audienceCutoff(a, now, d.db);
  if (!cutoff) return 0;
  const { rows: first } = await d.db.query(`SELECT MIN(created_at) AS at FROM proactive_candidates WHERE target_key = $1`, [a.key]);
  const expiresAt = expiryOf(a, first[0]?.at ? new Date(first[0].at) : null, now);
  if (expiresAt.getTime() <= now.getTime()) return 0;
  // One a month: never while another announcement went to a member this calendar month or still waits to go.
  const block = await monthlyLimit(d.db, a, now);
  if (block) {
    d.log(`announcement ${a.key}: ${block}; nothing queued`);
    return 0;
  }
  const override = monthlyOverride(a);
  if (override) d.log(`announcement ${a.key}: the monthly limit is waived for it (said by ${override.by} on ${override.on})`);
  const { rows } = await d.db.query(
    `SELECT u.id, u.created_at, u.archived_at, u.sms_opted_out, (u.phone_number IS NOT NULL) AS has_phone, u.invite_verified,
            u.phone_number, COALESCE((to_jsonb(u)->>'is_simulated')::boolean, false) AS simulated,
            EXISTS (SELECT 1 FROM proactive_sends s WHERE s.user_id = u.id AND s.target_key = $2) AS told,
            EXISTS (SELECT 1 FROM proactive_candidates c WHERE c.user_id = u.id AND c.target_key = $2) AS queued
       FROM users u
      WHERE u.created_at < $1 AND u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false
        AND u.phone_number IS NOT NULL AND u.invite_verified = true
        AND NOT EXISTS (SELECT 1 FROM proactive_sends s WHERE s.user_id = u.id AND s.target_key = $2)
        AND NOT EXISTS (SELECT 1 FROM proactive_candidates c WHERE c.user_id = u.id AND c.target_key = $2)`,
    [cutoff, a.key],
  );
  let queued = 0;
  for (const r of rows as AudienceRow[]) {
    if (!inAudience(r, cutoff)) continue;
    const q = await d
      .enqueue({ userId: r.id, type: a.type, targetKey: a.key, summary: a.summary, payload: {}, dueAt: now, expiresAt })
      .catch((err: any) => {
        console.error(`announcement ${a.key}: queueing failed (non-fatal):`, err?.message ?? err);
        return { queued: false };
      });
    if (q.queued) queued++;
  }
  return queued;
}

// Every announcement after the rename (the rename keeps its own job, services/nameChange.ts queueNameChange, which runs first).
export async function queueUpdateAnnouncements(now: Date = new Date()): Promise<number> {
  let n = 0;
  for (const a of ANNOUNCEMENTS) if (a.key !== NAME_CHANGE_KEY) n += await queueAnnouncement(a, now);
  return n;
}

// ---------------------------------------------------------------- draft (send time)

export type DraftDeps = {
  told: (userId: string, key: string) => Promise<boolean>;
  situation: (userId: string) => Promise<Situation>;
  // The one-change pick's reads (changeSituationOf): each signal null when it couldn't be read.
  changeSituation: (userId: string) => Promise<ChangeSituation>;
  // Anything else of theirs about to go (othersWaitingOf). Throws when it can't be read.
  othersWaiting: (o: { userId: string; candidateId: string | null; zone: string | null; now: Date; carriesRename: boolean }) => Promise<boolean>;
  now: () => Date;
};

// Their own goals, as the record holds them now: goals and goal entries, minus any done or set aside, minus Cue's own tasks.
export async function situationOf(userId: string): Promise<Situation> {
  try {
    const [{ rows }, GE] = await Promise.all([pool.query(`SELECT goals, intent FROM co_profiles WHERE user_id = $1`, [userId]), import("./goalEdges.js")]);
    const states = await GE.goalStates(userId);
    const own = GE.liveGoals(goalTexts(rows[0]?.intent, rows[0]?.goals), null, states).filter((g) => !GE.isCoTaskGoal(g));
    return { hasOwnGoal: own.length > 0 };
  } catch {
    return { hasOwnGoal: false };
  }
}

// The days they texted Cue, in the notes' lookback (services/daySummaries.ts SUMMARY.lookbackDays, 60): their own texts and voice
// memos, never a line to a teammate. Days are Pacific's, as the monthly limit's.
export const TALK_DAYS_SQL = `SELECT COUNT(DISTINCT (created_at AT TIME ZONE '${MONTH_ZONE}')::date)::int AS n FROM co_memories
  WHERE user_id = $1 AND memory_type = 'text_exchange' AND (content LIKE 'User said:%' OR content LIKE 'User sent a voice memo:%')
    AND created_at > NOW() - INTERVAL '60 days' AND ${notToTeammate()}`;
// A call with Cue on file: its stored transcript, or the summary note written after it.
export const HAD_CALLS_SQL = `SELECT EXISTS (SELECT 1 FROM co_memories WHERE user_id = $1 AND (memory_type = 'call_transcript' OR (memory_type = 'text_exchange' AND content LIKE '[Call] %'))) AS had`;

// Every signal read on its own; one that fails is null and only the change that needs it is out.
export async function changeSituationOf(userId: string, db: Db = pool): Promise<ChangeSituation> {
  const F = await import("./firstUseNotes.js").catch(() => null);
  const [joinedAt, talkDays, hadCalls, usedRemovedMaker, makerChangeTold] = await Promise.all([
    db.query(`SELECT created_at FROM users WHERE id = $1`, [userId]).then((r) => (r.rows[0]?.created_at ? new Date(r.rows[0].created_at) : null)).catch(() => null),
    db.query(TALK_DAYS_SQL, [userId]).then((r) => (r.rows[0] && Number.isFinite(Number(r.rows[0].n)) ? Number(r.rows[0].n) : null)).catch(() => null),
    db.query(HAD_CALLS_SQL, [userId]).then((r) => (typeof r.rows[0]?.had === "boolean" ? (r.rows[0].had as boolean) : null)).catch(() => null),
    F ? F.usedRemovedMaker(userId, db).catch(() => null) : Promise.resolve(null),
    F ? F.makerChangeTold(userId, db).catch(() => null) : Promise.resolve(null),
  ]);
  return { joinedAt: joinedAt && !Number.isNaN(joinedAt.getTime()) ? joinedAt : null, talkDays, hadCalls, usedRemovedMaker, makerChangeTold };
}

// Never stacked (2026-11-08): an announcement doesn't go while anything else of theirs is about to: another of their pending
// candidates that could actually go today (due from STALE_DUE_HOURS ago up to the end of their local day, and not past its end), or a
// deferred send of theirs queued or going out (services/deferredSends.ts). A candidate long past due that never became eligible (a
// gate keeps it back, a NULL expiry) doesn't count: it would hold every announcement for as long as it sits there. Other announcements
// aren't counted (quietDayOnly already sends those one at a time, oldest first, a week apart, and counting them would hold both
// forever), nor, for one that carries the rename, the rename notice it claims.
export const STACK_WAIT_HOURS = 3;
export const STALE_DUE_HOURS = 6;
export const OTHERS_WAITING_SQL = `SELECT EXISTS (SELECT 1 FROM proactive_candidates WHERE user_id = $1 AND status = 'pending' AND ($2::text IS NULL OR id::text <> $2)
         AND type <> 'announcement' AND NOT ($4::boolean AND type = 'name_change') AND due_at >= $5 AND due_at < $3 AND (expires_at IS NULL OR expires_at > $6))
    OR EXISTS (SELECT 1 FROM deferred_sends WHERE user_id = $1 AND status IN ('queued', 'sending')) AS waiting`;
// Pure: the end of their local day (their zone, else Pacific's).
export function endOfLocalDay(now: Date, zone: string | null): Date {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : MONTH_ZONE;
  return DateTime.fromJSDate(now).setZone(z).endOf("day").toJSDate();
}
// Pure: the window a pending candidate's due time must fall in to count (from STALE_DUE_HOURS ago to the end of their day), and the
// same rule in code: due inside it, and not past its end.
export function waitingWindow(now: Date, zone: string | null): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - STALE_DUE_HOURS * 3_600_000), to: endOfLocalDay(now, zone) };
}
export function countsAsWaiting(c: { dueAt: Date; expiresAt: Date | null }, now: Date, zone: string | null): boolean {
  const w = waitingWindow(now, zone);
  return c.dueAt.getTime() >= w.from.getTime() && c.dueAt.getTime() < w.to.getTime() && (!c.expiresAt || c.expiresAt.getTime() > now.getTime());
}
export async function othersWaitingOf(o: { userId: string; candidateId: string | null; zone: string | null; now: Date; carriesRename: boolean }, db: Db = pool): Promise<boolean> {
  const w = waitingWindow(o.now, o.zone);
  const { rows } = await db.query(OTHERS_WAITING_SQL, [o.userId, o.candidateId, w.to, o.carriesRename, w.from, o.now]);
  if (typeof rows[0]?.waiting !== "boolean") throw new Error("no answer");
  return rows[0].waiting;
}

const realDraftDeps: DraftDeps = {
  told: async (userId, key) => (await pool.query(`SELECT 1 FROM proactive_sends WHERE user_id = $1 AND target_key = $2`, [userId, key])).rows.length > 0,
  situation: situationOf,
  changeSituation: (userId) => changeSituationOf(userId),
  othersWaiting: (o) => othersWaitingOf(o),
  now: () => new Date(),
};
const UNREAD_SITUATION: ChangeSituation = { joinedAt: null, talkDays: null, usedRemovedMaker: null, hadCalls: null, makerChangeTold: null };

// The announcement's own text, re-read at send time: unapproved waits (it can't be queued, so this is a backstop), past its end it
// never goes, already told means nothing goes, anything else of theirs about to go means it waits (never stacked; a failed read waits
// too), and a member the rename hasn't reached gets the rename's words in the same text. One with changes goes as the one change that
// fits them, or not at all.
export async function draftAnnouncement(
  c: Pick<Candidate, "userId" | "targetKey" | "expiresAt"> & { id?: string },
  deps: Partial<DraftDeps> & { approved?: boolean; zone?: string | null } = {},
): Promise<DraftResult> {
  const d = { ...realDraftDeps, ...deps };
  const a = announcementByKey(c.targetKey);
  if (!a || a.type !== "announcement") return { skip: "not an announcement Cue has" };
  const now = d.now();
  if (!(deps.approved ?? a.approved)) return { defer: new Date(now.getTime() + 24 * 3_600_000), reason: "its wording is waiting on Royce's approval" };
  const ends = "at" in a.expires ? a.expires.at : c.expiresAt;
  if (ends && ends.getTime() <= now.getTime()) return { skip: "past its end" };
  if (await d.told(c.userId, a.key)) return { skip: "already told" };
  const waiting = await d.othersWaiting({ userId: c.userId, candidateId: c.id ?? null, zone: deps.zone ?? null, now, carriesRename: !!a.foldLead }).catch(() => null);
  if (waiting !== false) {
    return { defer: new Date(now.getTime() + STACK_WAIT_HOURS * 3_600_000), reason: waiting === null ? "couldn't read what else of theirs is about to go, so it waits" : "something else of theirs is about to go today; an announcement never goes beside it" };
  }
  // One text, one change: the first that fits them, or nothing at all (never a generic fallback).
  if (a.changes?.length) {
    const change = pickChange(a, await d.changeSituation(c.userId).catch(() => UNREAD_SITUATION));
    if (!change) return { skip: "none of its changes fits them" };
    return { messages: [change.line], text: change.line, rules: { ...ANNOUNCEMENT_RULES }, meta: { change: change.id } };
  }
  // Separate fixed texts need no situation read (there is no try line to pick).
  if (a.texts?.length) {
    const messages = announcementMessages(a, { hasOwnGoal: false }, { nameTold: true });
    return { messages, text: messages.join("\n"), rules: { ...ANNOUNCEMENT_RULES, ...(a.narrationApproved?.length ? { approvedSentences: a.narrationApproved } : {}) } };
  }
  const nameTold = a.foldLead ? await d.told(c.userId, NAME_CHANGE_KEY) : true;
  const text = announcementText(a, await d.situation(c.userId), { nameTold });
  return { messages: [text], text, rules: { ...ANNOUNCEMENT_RULES } };
}

