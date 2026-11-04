// The one gate every message Cue sends a member passes, right before it goes (Royce, 2026-11-02, preferences spec section 3-4; PR B).
// The rules are the member's own (services/memberPreferences.ts): read fresh at send time, inside the send's own lock where the path
// has one, so a rule set or withdrawn after something was queued or scheduled still decides it.
//
// Message classes (what a rule covers is the member's choice, read from their words: PrefCovers):
//   reply        the turn's own answer to their text (or what Cue says on a call they're on). Never held and never counted (Royce,
//                2026-11-02, R1). Only the turn's answer is a reply: a delivery that lands later, even minutes later, is requested.
//   requested    something they asked for or signed up for, arriving later: an answer to their ask, a task's result, a document,
//                a reminder they set, an event change or a reminder for a call they booked. A notification all the same: held by a
//                rule that covers "all", never by one that covers only what Cue starts.
//   unsolicited  what Cue starts on its own: finds, nudges, announcements, intro asks to them, in-room nudges, calls Cue places.
//   checkin      check-ins (a kind of unsolicited): the one class a "no check-ins" rule covers.
//
// Counting unit: one message is one send, however many bubbles it has: a send writes one ledger row with its class, and what rides in
// it (another find, a note) writes rows marked 'riding', which never count. Rows from before the class existed count once per send
// time (a send's rows share their transaction's time). Days are the member's local day (their zone, Pacific when unknown); "a week" is the last 7 x 24 hours.
// Only explicit standing rules hold a send: an inferred one stays tentative (spec section 2), a one-time exception never restricts or
// loosens, and a vague "less" has no number to hold to.
//
// What wins over this gate: opt-out (checked by every path before it), the safety holds (they only ever hold more), and a safety
// follow-up, which keeps its current precedence (it goes; it still counts).
import { DateTime } from "luxon";
import { ENFORCED_AREAS, inForce, type Preference, type PrefCovers } from "../services/memberPreferences.js";
import { wordsZone } from "../services/memberTime.js";
import type { GateCheck } from "./core.js";

export type SendClass = "reply" | "requested" | "unsolicited" | "checkin";
export type NotifyChannel = "text" | "call";
// One earlier send as the gate counts it.
export type Counted = { at: Date; cls: SendClass; channel: NotifyChannel };

export const MEMBER_RULE = "member_rule";

// Pure: whether a rule's coverage reaches a send of this class.
export function covers(c: PrefCovers, cls: SendClass): boolean {
  if (cls === "reply") return false;
  if (c === "all") return true;
  if (c === "unsolicited") return cls === "unsolicited" || cls === "checkin";
  return cls === "checkin";
}

// Pure: the rules that hold sends (enforced area, explicit, standing, in force).
export function holdingRules(prefs: Preference[], now: Date): Preference[] {
  return prefs.filter((p) => ENFORCED_AREAS.has(p.area) && p.basis === "explicit" && p.type === "standing" && inForce(p, now));
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

// Pure: one rule against one send. Null when it allows it; else why (ids and field names only, never their words) and when it could
// go. Sends counted are those of the same channel scope and a class the rule covers.
export function ruleBlocks(p: Preference, o: { now: Date; cls: SendClass; channel: NotifyChannel; sent: Counted[]; zone?: string | null }): { why: string; retryAt: Date | null } | null {
  if (!covers(p.area === "checkins" ? "checkins" : p.covers, o.cls)) return null;
  if (p.channel !== "all" && p.channel !== o.channel) return null;
  // Their zone now (a member who moved keeps "not before 10" at 10 where they are); the rule's own zone when it isn't known.
  const zone = wordsZone(o.zone ?? p.zone);
  const local = DateTime.fromJSDate(o.now).setZone(zone);
  const tomorrow = local.plus({ days: 1 }).startOf("day");
  const r = p.rule;
  const id = `rule ${p.id}`;
  if (r.none) return { why: `${id}: none while it lasts`, retryAt: p.expiresAt ? new Date(p.expiresAt) : tomorrow.toJSDate() };
  const nextOkDay = (ok: (wd: number) => boolean) => {
    for (let d = 1; d <= 7; d++) {
      const day = local.plus({ days: d }).startOf("day");
      if (ok(day.weekday)) return day.toJSDate();
    }
    return null;
  };
  if (r.noDays?.includes(local.weekday)) return { why: `${id}: not on this weekday`, retryAt: nextOkDay((wd) => !r.noDays!.includes(wd)) };
  if (r.onlyDays && !r.onlyDays.includes(local.weekday)) return { why: `${id}: only on other weekdays`, retryAt: nextOkDay((wd) => r.onlyDays!.includes(wd)) };
  const mins = local.hour * 60 + local.minute;
  if (r.earliest && mins < minutes(r.earliest)) return { why: `${id}: before their earliest`, retryAt: local.set({ hour: Number(r.earliest.slice(0, 2)), minute: Number(r.earliest.slice(3)), second: 0, millisecond: 0 }).toJSDate() };
  if (r.latest && mins >= minutes(r.latest)) {
    const back = tomorrow.set({ hour: r.earliest ? Number(r.earliest.slice(0, 2)) : 0, minute: r.earliest ? Number(r.earliest.slice(3)) : 0 });
    return { why: `${id}: after their latest`, retryAt: back.toJSDate() };
  }
  const mine = o.sent.filter((s) => covers(p.area === "checkins" ? "checkins" : p.covers, s.cls) && (p.channel === "all" || p.channel === s.channel) && s.at.getTime() <= o.now.getTime());
  if (r.maxPerDay !== undefined) {
    const start = local.startOf("day").toJSDate().getTime();
    const today = mine.filter((s) => s.at.getTime() >= start).length;
    if (today >= r.maxPerDay) return { why: `${id}: ${today} of ${r.maxPerDay} today`, retryAt: tomorrow.toJSDate() };
  }
  if (r.maxPerWeek !== undefined) {
    const since = o.now.getTime() - 7 * 86_400_000;
    const week = mine.filter((s) => s.at.getTime() > since).map((s) => s.at.getTime()).sort((x, y) => x - y);
    if (week.length >= r.maxPerWeek) return { why: `${id}: ${week.length} of ${r.maxPerWeek} in 7 days`, retryAt: new Date(week[week.length - r.maxPerWeek] + 7 * 86_400_000) };
  }
  return null;
}

// Pure: the gate's check for one send. pass when no rule holds it; retryAt: the soonest moment every rule that held it could allow it.
// soonAt: when what this send is about happens (a call they booked, an event they're going to). Within NOTICE_SOON_HOURS of it, a notice
// gets through a held rule rather than arriving late (Royce, 2026-11-02, R2); it still counts. rulesAfter: only rules set after this
// moment hold it (a call they booked is their own exception to the rules they had then).
export const NOTICE_SOON_HOURS = 6;
export function noticeIsSoon(soonAt: Date | null | undefined, now: Date): boolean {
  if (!soonAt) return false;
  const ms = soonAt.getTime() - now.getTime();
  return ms <= NOTICE_SOON_HOURS * 3_600_000 && ms >= -3 * 3_600_000;
}
export function memberRuleCheck(prefs: Preference[], o: { now: Date; cls: SendClass; channel: NotifyChannel; sent: Counted[]; zone?: string | null; soonAt?: Date | null; rulesAfter?: Date | null }): GateCheck & { retryAt?: Date } {
  if (o.cls === "reply") return { name: MEMBER_RULE, pass: true };
  if (o.cls === "requested" && noticeIsSoon(o.soonAt, o.now)) return { name: MEMBER_RULE, pass: true, reason: "soon: what it's about happens within hours" };
  const rules = o.rulesAfter ? holdingRules(prefs, o.now).filter((p) => Date.parse(p.setAt) > o.rulesAfter!.getTime()) : holdingRules(prefs, o.now);
  const held = rules.map((p) => ruleBlocks(p, o)).filter((x): x is NonNullable<typeof x> => !!x);
  if (!held.length) return { name: MEMBER_RULE, pass: true };
  const at = Math.max(...held.map((h) => (h.retryAt ?? new Date(o.now.getTime() + 86_400_000)).getTime()));
  return { name: MEMBER_RULE, pass: false, reason: `the member's own rule holds it (${held.map((h) => h.why).join("; ")})`, retryAt: new Date(at) };
}

// ---------------------------------------------------------------- classes of what Cue sends

// Every proactive type has a class here (evals/preferences/enforce.ts fails on a type with none, so a new type is a conscious choice).
export const PROACTIVE_CLASS: Record<string, SendClass> = {
  companion: "checkin",
  ask_checkin: "checkin",
  goal_checkin: "checkin",
  loop_check: "checkin",
  goal_recheck: "checkin",
  debrief: "checkin",
  window_followup: "checkin",
  goal_nudge: "checkin",
  // Tied to what they asked for or signed up for.
  post_call: "requested",
  pre_arrival: "requested",
  event_brief: "requested",
  brief_name_ask: "requested",
  room_share_ask: "requested",
  event_followthrough: "requested",
  noshow_note: "requested",
  artifact_expiry: "requested",
  bounce_watch: "requested",
  deadline_nudge: "requested",
  commitment_nudge: "requested",
  intro_close: "requested",
  goal_closed: "requested",
  // Cue's own.
  event_offer: "unsolicited",
  network_tease: "requested",
  calendar_follow: "unsolicited",
  ask_solicitation: "unsolicited",
  product_update: "unsolicited",
  event_match_nudge: "unsolicited",
  bounce_proposal: "unsolicited",
  bounce_calendar_offer: "unsolicited",
  intro_nudge: "unsolicited",
  name_change: "unsolicited",
  announcement: "unsolicited",
  voice_read_ask: "unsolicited",
  in_room: "unsolicited",
  // Transactional texts (sendExempt). A task text is requested unless Cue started it (coInitiated: unsolicited).
  event_change: "requested",
  call_reminder: "requested",
  missed_call: "requested",
  co_event: "unsolicited",
  direct_ask: "unsolicited",
  search_result: "requested",
  task_update: "requested",
  call_confirm: "requested",
  task_window: "requested",
  // A watching offer logged from a reply: the reply itself.
  watch_offer: "reply",
};

// Pure: a candidate's class. An event offer for an open ask they made is a requested delivery; any other find is Cue's own.
// A text waiting at the door (harness/door.ts) carries the class its own path gave it (a look-out Cue started is its own, a task they
// asked for is requested, a goal check-in a check-in).
export function candidateClass(type: string, answering: boolean, payload?: unknown): SendClass {
  if (type === "event_offer") return answering ? "requested" : "unsolicited";
  const own = (payload as { door?: boolean; cls?: string } | null | undefined);
  if (own?.door === true && (["requested", "unsolicited", "checkin"] as const).some((c) => c === own.cls)) return own.cls as SendClass;
  return PROACTIVE_CLASS[type] ?? "unsolicited";
}

// Pure: the ledger rows as the gate counts them, one per message. The class written with the row wins (notify_class); a row riding in
// another send ('riding') isn't a message of its own; older rows take their type's class, once per send time.
export const RIDING = "riding";
export function countedRows(rows: { sentAt: Date; type: string; cls?: string | null }[]): Counted[] {
  const out: Counted[] = [];
  const legacy = new Set<number>();
  for (const r of rows) {
    if (r.cls === RIDING) continue;
    const known = (["reply", "requested", "unsolicited", "checkin"] as const).find((c) => c === r.cls);
    if (!known) {
      if (legacy.has(r.sentAt.getTime())) continue;
      legacy.add(r.sentAt.getTime());
    }
    out.push({ at: r.sentAt, cls: known ?? PROACTIVE_CLASS[r.type] ?? "unsolicited", channel: r.type === "call" ? "call" : "text" });
  }
  return out;
}

// The ledger read the gate needs (inside the caller's lock when it has one), and the member's rules, one member's rows each.
type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
export async function loadCounted(db: Q, userId: string): Promise<Counted[]> {
  const [{ rows }, { rows: calls }] = await Promise.all([
    db.query(`SELECT type, sent_at, notify_class FROM proactive_sends WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '8 days'`, [userId])
      // Before the column's migration has run: every row by its type's class.
      .catch(() => db.query(`SELECT type, sent_at FROM proactive_sends WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '8 days'`, [userId])),
    // Calls placed, by the kind the call gate decided them as (harness/callGate.ts records it): one they asked for now is a reply (not
    // counted), one they booked is requested, a check-in call a check-in, an intake call Cue's own.
    db.query(`SELECT created_at, reason FROM harness_decisions WHERE user_id = $1 AND decision = 'call.gate' AND action = 'place_call' AND created_at > NOW() - INTERVAL '8 days'`, [userId]).catch(() => ({ rows: [] as any[] })),
  ]);
  return [
    ...countedRows(rows.map((r: any) => ({ sentAt: new Date(r.sent_at), type: String(r.type), cls: r.notify_class ?? null }))),
    ...calls.flatMap((r: any) => {
      const cls = callClassOf(String(r.reason ?? ""));
      return cls === "reply" ? [] : [{ at: new Date(r.created_at), cls, channel: "call" as const }];
    }),
  ];
}

// Pure: a placed call's class from the call gate's recorded authorization ("scheduled_call", "inferred auto_intake", ...).
export function callClassOf(reason: string): SendClass {
  const kind = reason.replace(/^inferred /, "").trim();
  return ({ user_initiated: "reply", router_decision: "reply", scheduled_call: "requested", checkin_cadence: "checkin", auto_intake: "unsolicited" } as Record<string, SendClass>)[kind] ?? "unsolicited";
}

// Pure: a team hold's answer for a send it covers (teamHoldCovers). Its id only, never the
// reason's words; it may go once the hold expires.
export const TEAM_HOLD = "team_hold";
// Pure: the classes a team hold quiets: Cue's own outreach (unsolicited, check-ins). Never a reply or a requested delivery.
export const teamHoldCovers = (cls: SendClass): boolean => cls === "unsolicited" || cls === "checkin";
// Pure: a relay (another member's words, services/relay.ts) by its ledger key.
export const isRelayKey = (targetKey: string | null | undefined): boolean => /^relay:/.test(String(targetKey ?? ""));
export function teamHoldCheck(h: { id: string; expiresAt: Date }): GateCheck & { retryAt?: Date } {
  return { name: MEMBER_RULE, pass: false, reason: `${TEAM_HOLD} ${h.id} holds it`, retryAt: h.expiresAt };
}

// Whether the team holds what Cue starts for this member now (a pull reads it before picking); a read that fails holds.
export async function teamHoldNow(userId: string, now: Date): Promise<boolean> {
  return import("../services/teamHold.js").then((T) => T.activeTeamHold(userId, now)).then((h) => !!h).catch(() => true);
}

// The whole gate for one send, read fresh: their rules and what's been sent. A rules read that fails holds the send (it can't know a
// rule isn't there) and says so; it's retried like any hold.
// throughTeamHold: another member's own words passed along (a relay): stale if a team hold kept it for weeks, so it goes through the
// hold, still under the receiving member's own rules (review of #363, round 2).
export async function memberRuleGate(db: Q, o: { userId: string; now: Date; cls: SendClass; channel: NotifyChannel; soonAt?: Date | null; rulesAfter?: Date | null; throughTeamHold?: boolean }): Promise<GateCheck & { retryAt?: Date }> {
  if (o.cls === "reply") return { name: MEMBER_RULE, pass: true };
  const { activePreferences } = await import("../services/memberPreferences.js");
  try {
    const [prefs, sent, zone, hold] = await Promise.all([activePreferences(o.userId, o.now, db), loadCounted(db, o.userId), import("../services/memberTime.js").then((M) => M.memberZone(o.userId)).catch(() => null), import("../services/teamHold.js").then((T) => T.activeTeamHold(o.userId, o.now, db))]);
    // The team's hold (services/teamHold.ts), apart from their own rules: only what Cue starts on its own (review of #363). What they
    // asked for (a document, a reminder they set, a call they booked, a notice about something soon) still goes, under their own rules.
    if (hold && teamHoldCovers(o.cls) && !o.throughTeamHold) return teamHoldCheck(hold);
    return memberRuleCheck(prefs, { now: o.now, cls: o.cls, channel: o.channel, sent, zone, soonAt: o.soonAt, rulesAfter: o.rulesAfter });
  } catch (err: any) {
    return { name: MEMBER_RULE, pass: false, reason: `couldn't read their rules (${String(err?.message ?? err).slice(0, 60)})`, retryAt: new Date(o.now.getTime() + 15 * 60_000) };
  }
}
