// The nightly rule check (Royce, 2026-11-02): what Cue sent in the last 24 hours against each member's own rules as they stood at each
// send's moment, and the team's holds. Read-only: it fixes nothing, it flags. A flag lands on the review (harness/devReview.ts
// reviewWindow, so `npm run broke` and the morning review show it; stored in review_flags by the nightly job when the review is on)
// and on the co-test /sweeps page, with the send path that caused it (the ledger row's type and class, or the call gate's kind).
// Logs carry ids, types, classes and field names only, never anyone's words.
//
// The same judgment the send gate makes (harness/notifyGate.ts memberRuleCheck / ruleBlocks), replayed: their rules in force at t
// (set by then, not retired or expired by then), what had been sent before t, their zone (today's; a move inside the window reads in the
// new zone). What it can't know from the record is said, never guessed into a violation:
//   - a requested notice about something within hours passes a held rule on purpose (R2): such a type is flagged low, "may be the
//     time-sensitive exception";
//   - a call they booked is held only by rules set after the booking: flagged low, "check when it was booked";
//   - a safety follow-up goes whatever the rule (the send's own candidate, by its ledger row's candidate_id, says so): never flagged.
import pool from "../db/db.js";
import { countedRows, callClassOf, memberRuleCheck, RIDING, teamHoldCheck, teamHoldCovers, type Counted, type SendClass } from "./notifyGate.js";
import type { Preference } from "../services/memberPreferences.js";
import type { TeamHold } from "../services/teamHold.js";

export type SentItem = { ref: string; at: Date; type: string; cls: SendClass; channel: "text" | "call"; safety?: boolean };
export type HistPref = Preference & { retiredAt: Date | null };
export type RuleBreak = { userId: string; ref: string; at: string; path: string; cls: SendClass; channel: "text" | "call"; why: string; severity: "low" | "medium" | "high"; caveat: string | null };

// Requested types whose notice can be about something within hours (notifyGate.ts soonAt).
export const SOON_TYPES = new Set(["call_reminder", "event_change", "pre_arrival", "event_brief"]);

// Pure: their rules as they stood at a moment.
export function rulesAt(prefs: HistPref[], at: Date): Preference[] {
  const t = at.getTime();
  return prefs
    .filter((p) => Date.parse(p.setAt) <= t && (!p.retiredAt || p.retiredAt.getTime() > t))
    .map(({ retiredAt: _r, ...p }) => ({ ...p, state: "active" as const }));
}

// Pure: one member's sends in the window checked against their rules and the team's holds. history: every counted send of theirs (the
// window's and the 8 days before it, for the caps); window: the sends to check.
export function checkMember(o: { userId: string; prefs: HistPref[]; holds: Pick<TeamHold, "id" | "setAt" | "expiresAt" | "liftedAt">[]; history: Counted[]; window: SentItem[]; zone: string | null }): RuleBreak[] {
  const out: RuleBreak[] = [];
  for (const s of o.window) {
    if (s.cls === "reply" || s.safety) continue;
    const t = s.at.getTime();
    const hold = teamHoldCovers(s.cls) ? o.holds.find((h) => h.setAt.getTime() <= t && h.expiresAt.getTime() > t && (!h.liftedAt || h.liftedAt.getTime() > t)) : undefined;
    const path = `${s.channel}:${s.type}`;
    if (hold) {
      out.push({ userId: o.userId, ref: s.ref, at: s.at.toISOString(), path, cls: s.cls, channel: s.channel, why: String(teamHoldCheck({ id: hold.id, expiresAt: hold.expiresAt }).reason), severity: "high", caveat: null });
      continue;
    }
    const before = o.history.filter((h) => h.at.getTime() < t);
    const r = memberRuleCheck(rulesAt(o.prefs, s.at), { now: s.at, cls: s.cls, channel: s.channel, sent: before, zone: o.zone });
    if (r.pass) continue;
    const why = String(r.reason ?? "").replace(/^the member's own rule holds it \((.*)\)$/, "$1");
    const caveat = s.cls === "requested" && SOON_TYPES.has(s.type) ? "may be the time-sensitive exception (a notice about something within hours)" : s.channel === "call" && s.type === "scheduled_call" ? "a call they booked: held only by rules set after the booking; check when it was booked" : null;
    out.push({ userId: o.userId, ref: s.ref, at: s.at.toISOString(), path, cls: s.cls, channel: s.channel, why, severity: caveat ? "low" : "high", caveat });
  }
  return out;
}

// ---------------------------------------------------------------- reading the record (one member's rows each)

type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

export async function loadHistPrefs(userId: string, db: Q = pool): Promise<HistPref[]> {
  const { loadPreferences } = await import("../services/memberPreferences.js");
  const [prefs, { rows }] = await Promise.all([
    loadPreferences(userId, db as any, { withRetired: true }),
    db.query(`SELECT id, retired_at FROM co_facts WHERE owner_user_id = $1 AND relation = 'prefers' AND subject = 'member' AND retired_at IS NOT NULL`, [userId]),
  ]);
  const retired = new Map<string, Date>(rows.map((r: any) => [String(r.id), new Date(r.retired_at)]));
  return prefs.map((p) => ({ ...p, retiredAt: retired.get(p.id) ?? null }));
}

export async function membersWithSends(since: Date, until: Date, db: Q = pool): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT user_id FROM proactive_sends WHERE sent_at > $1 AND sent_at <= $2
     UNION SELECT DISTINCT user_id FROM harness_decisions WHERE decision = 'call.gate' AND action = 'place_call' AND created_at > $1 AND created_at <= $2 AND user_id IS NOT NULL`,
    [since, until],
  );
  return rows.map((r: any) => String(r.user_id));
}

export async function loadMemberSends(userId: string, since: Date, until: Date, db: Q = pool): Promise<{ history: Counted[]; window: SentItem[] }> {
  const histFrom = new Date(since.getTime() - 8 * 86_400_000);
  const [{ rows: sends }, { rows: calls }] = await Promise.all([
    db.query(
      `SELECT s.id, s.type, s.sent_at, s.notify_class, (c.payload->>'safetyFollowUp') = 'true' AS safety
       FROM proactive_sends s LEFT JOIN proactive_candidates c ON c.id = s.candidate_id AND c.user_id = s.user_id
       WHERE s.user_id = $1 AND s.sent_at > $2 AND s.sent_at <= $3 ORDER BY s.sent_at`,
      [userId, histFrom, until],
    ),
    db.query(`SELECT id, created_at, reason FROM harness_decisions WHERE user_id = $1 AND decision = 'call.gate' AND action = 'place_call' AND created_at > $2 AND created_at <= $3`, [userId, histFrom, until]),
  ]);
  const textRows = sends.map((r: any) => ({ sentAt: new Date(r.sent_at), type: String(r.type), cls: r.notify_class ?? null }));
  const history: Counted[] = [
    ...countedRows(textRows),
    ...calls.map((r: any) => ({ at: new Date(r.created_at), cls: callClassOf(String(r.reason ?? "")), channel: "call" as const })).filter((c) => c.cls !== "reply"),
  ];
  // The window: one item per message (rows riding in another send aren't messages; older rows count once per send time).
  const seen = new Set<number>();
  const window: SentItem[] = [];
  for (const r of sends) {
    const at = new Date(r.sent_at);
    if (at.getTime() <= since.getTime() || r.notify_class === RIDING) continue;
    const counted = countedRows([{ sentAt: at, type: String(r.type), cls: r.notify_class ?? null }])[0];
    if (!r.notify_class) {
      if (seen.has(at.getTime())) continue;
      seen.add(at.getTime());
    }
    window.push({ ref: `send ${r.id}`, at, type: String(r.type), cls: counted.cls, channel: "text", safety: r.safety === true });
  }
  for (const r of calls) {
    const at = new Date(r.created_at);
    if (at.getTime() <= since.getTime()) continue;
    const kind = String(r.reason ?? "").replace(/^inferred /, "").trim();
    window.push({ ref: `call decision ${r.id}`, at, type: kind || "call", cls: callClassOf(String(r.reason ?? "")), channel: "call" });
  }
  return { history, window: window.sort((a, b) => a.at.getTime() - b.at.getTime()) };
}

// The check for a window, every member who was sent anything in it (or the ones given).
export async function ruleBreaks(since: Date, until: Date, o: { userIds?: string[]; db?: Q } = {}): Promise<RuleBreak[]> {
  const db = o.db ?? pool;
  const { memberZone } = await import("../services/memberTime.js");
  const { teamHoldsBetween } = await import("../services/teamHold.js");
  const out: RuleBreak[] = [];
  for (const userId of o.userIds ?? (await membersWithSends(since, until, db))) {
    const [prefs, holds, sends, zone] = await Promise.all([loadHistPrefs(userId, db), teamHoldsBetween(userId, since, until, db as any), loadMemberSends(userId, since, until, db), memberZone(userId).catch(() => null)]);
    if (!prefs.length && !holds.length) continue;
    out.push(...checkMember({ userId, prefs, holds, history: sends.history, window: sends.window, zone }));
  }
  return out;
}

// Pure: a break as a review flag (harness/devReview.ts), ids and paths only.
export function breakFlag(b: RuleBreak): import("./devReview.js").ReviewFlag {
  return {
    userId: b.userId,
    at: b.at,
    type: "member_rule_broken",
    severity: b.severity,
    snippet: `${b.ref} via ${b.path} (${b.cls})`.slice(0, 200),
    decisionIds: [],
    cause: `send path ${b.path}, class ${b.cls}: ${b.why}${b.caveat ? `; ${b.caveat}` : ""}`.slice(0, 400),
    causeConfirmed: !b.caveat,
    source: "log",
  };
}

// The nightly run: the last 24 hours, stored as review flags (only where the review is on: co-test) and logged with counts and ids.
export async function runNightlyRuleCheck(now: Date = new Date()): Promise<RuleBreak[]> {
  const since = new Date(now.getTime() - 86_400_000);
  const { recordDecision } = await import("./core.js");
  try {
    const breaks = await ruleBreaks(since, now);
    const D = await import("./devReview.js");
    const stored = await D.storeFlags(breaks.map(breakFlag)).catch(() => 0);
    await recordDecision({ layer: 3, decision: "rules.nightly_check", userId: null, outcome: breaks.length ? "act" : "skip", action: breaks.length ? "flagged" : "clean", proposal: { since: since.toISOString(), until: now.toISOString(), flagged: breaks.length, stored, breaks: breaks.slice(0, 50).map((b) => ({ userId: b.userId, ref: b.ref, path: b.path, cls: b.cls, severity: b.severity })) } }).catch(() => {});
    return breaks;
  } catch (err: any) {
    await recordDecision({ layer: 3, decision: "rules.nightly_check", userId: null, outcome: "skip", action: "failed", reason: String(err?.name ?? "Error") }).catch(() => {});
    return [];
  }
}
