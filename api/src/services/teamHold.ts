// A team-side hold (Royce, 2026-11-02): the team quiets one member for a reason (a tester, a hard moment), until it expires.
//
//   - Separate from the member's own rules (services/memberPreferences.ts): its own table (team_holds), never co_facts, so nothing
//     member-facing (what Cue knows, the reply's facts, the call's context) reads it and it never shows as their words.
//   - Recorded with who set it and why, and always with an expiry (at most MAX_HOLD_DAYS out). Lifting it early keeps the row.
//   - Enforced by the one send gate (harness/notifyGate.ts memberRuleGate) on every path that gate covers: texts Cue starts, deliveries,
//     notices, in-room texts and calls Cue places. The turn's reply to their own text is never held (class "reply"), and a safety
//     follow-up keeps its precedence (the callers skip the gate for it), so both still go.
//   - Set and lifted by the team only: scripts/teamHold.ts. Logs carry the hold's id, never the reason's words.
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";

export const MAX_HOLD_DAYS = 30;
export type TeamHold = { id: string; userId: string; setBy: string; reason: string; setAt: Date; expiresAt: Date; liftedAt: Date | null };
type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const rowToHold = (r: any): TeamHold => ({ id: String(r.id), userId: String(r.user_id), setBy: String(r.set_by), reason: String(r.reason), setAt: new Date(r.set_at), expiresAt: new Date(r.expires_at), liftedAt: r.lifted_at ? new Date(r.lifted_at) : null });

// Pure: whether a hold is in force at a moment.
export function holdInForce(h: Pick<TeamHold, "setAt" | "expiresAt" | "liftedAt">, at: Date): boolean {
  const t = at.getTime();
  return h.setAt.getTime() <= t && h.expiresAt.getTime() > t && (!h.liftedAt || h.liftedAt.getTime() > t);
}

// The hold in force for a member now (the latest-ending one when several overlap), or null. A table that isn't there yet is no hold.
export async function activeTeamHold(userId: string, now: Date = new Date(), db: Q = pool): Promise<TeamHold | null> {
  const { rows } = await db
    .query(`SELECT id, user_id, set_by, reason, set_at, expires_at, lifted_at FROM team_holds WHERE user_id = $1 AND lifted_at IS NULL AND set_at <= $2 AND expires_at > $2 ORDER BY expires_at DESC LIMIT 1`, [userId, now])
    .catch((err: any) => {
      if (/team_holds/.test(String(err?.message ?? "")) && /does not exist/.test(String(err?.message ?? ""))) return { rows: [] as any[] };
      throw err;
    });
  return rows[0] ? rowToHold(rows[0]) : null;
}

// Every hold that touched a window (the nightly rule check reads holds in force at each send's time).
export async function teamHoldsBetween(userId: string, since: Date, until: Date, db: Q = pool): Promise<TeamHold[]> {
  const { rows } = await db
    .query(`SELECT id, user_id, set_by, reason, set_at, expires_at, lifted_at FROM team_holds WHERE user_id = $1 AND set_at <= $3 AND expires_at > $2 AND (lifted_at IS NULL OR lifted_at > $2)`, [userId, since, until])
    .catch(() => ({ rows: [] as any[] }));
  return rows.map(rowToHold);
}

// Pure: a hold request checked for facts only (a reason, who, a real expiry within MAX_HOLD_DAYS). Null when fine; else what's wrong.
export function holdProblem(o: { setBy: string; reason: string; expiresAt: Date; now: Date }): string | null {
  if (!o.setBy.trim()) return "who is setting it (--by) is required";
  if (!o.reason.trim()) return "a reason (--reason) is required";
  if (Number.isNaN(o.expiresAt.getTime())) return "the expiry isn't a real time";
  if (o.expiresAt.getTime() <= o.now.getTime()) return "the expiry has to be in the future";
  if (o.expiresAt.getTime() - o.now.getTime() > MAX_HOLD_DAYS * 86_400_000) return `a hold lasts at most ${MAX_HOLD_DAYS} days`;
  return null;
}

export async function setTeamHold(o: { userId: string; setBy: string; reason: string; expiresAt: Date; now?: Date }, db: Q = pool): Promise<TeamHold> {
  const now = o.now ?? new Date();
  const bad = holdProblem({ ...o, now });
  if (bad) throw new Error(bad);
  const { rows } = await db.query(
    `INSERT INTO team_holds (user_id, set_by, reason, set_at, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, user_id, set_by, reason, set_at, expires_at, lifted_at`,
    [o.userId, o.setBy.trim().slice(0, 80), o.reason.trim().slice(0, 500), now, o.expiresAt],
  );
  const hold = rowToHold(rows[0]);
  await recordDecision({ layer: 7, decision: "team.hold", userId: o.userId, outcome: "act", action: "set", proposal: { holdId: hold.id, expiresAt: hold.expiresAt.toISOString() } }).catch(() => {});
  return hold;
}

export async function liftTeamHold(o: { userId: string; liftedBy: string; now?: Date }, db: Q = pool): Promise<number> {
  if (!o.liftedBy.trim()) throw new Error("who is lifting it (--by) is required");
  const now = o.now ?? new Date();
  const r = await db.query(`UPDATE team_holds SET lifted_at = $2, lifted_by = $3 WHERE user_id = $1 AND lifted_at IS NULL AND expires_at > $2 RETURNING id`, [o.userId, now, o.liftedBy.trim().slice(0, 80)]);
  if (r.rows.length) await recordDecision({ layer: 7, decision: "team.hold", userId: o.userId, outcome: "act", action: "lifted", proposal: { holdIds: r.rows.map((x: any) => String(x.id)) } }).catch(() => {});
  return r.rows.length;
}
