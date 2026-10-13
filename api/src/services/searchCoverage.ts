// What Co's daily search is really covering for one member right now (Royce, 2026-10-13: "The grounding rule reads real current
// state, not a hardcoded list. Open find asks and lookouts searched by the 9am floor count as running work"). The reply check reads
// it every turn (harness/replyGrounding.ts runningWorkLine), so "nothing's running" is only said when nothing is.
//   - asks: every open ask of kind 'find' (questions and look-outs alike), read with the same filter the 9am floor uses
//     (services/dailySweep.ts: person and unclassified asks are skipped there, and so here), with no cap: the floor searches them all.
//   - goals: the goals the latest daily run actually searched (its sweep.daily record: a goal its pace held shows as skipped there).
//   - held: why the floor won't search at all (paused, no phone, opted out, a safety hold). A held member's asks and goals are listed
//     as nothing; the codes stay internal and are never put in front of Co (runningWorkLine words it neutrally).
import pool from "../db/db.js";

// hidden: how many searched asks or goals the member-safe strip left out (another member named in them, or the strip failing closed).
// They are still searched, so they still count as running, without their words.
export type SearchCoverage = { asks: string[]; goals: string[]; held: string[]; hidden?: number };
export const NO_COVERAGE: SearchCoverage = { asks: [], goals: [], held: [] };

// How far back a daily run still says what is being searched: a day and a half covers one missed morning's retry window.
const DAILY_RUN_MAX_AGE_HOURS = 36;

// Pure: the goals a sweep.daily record searched (status "searched"), by their text.
export function searchedGoals(proposal: any): string[] {
  const items = Array.isArray(proposal?.items) ? proposal.items : [];
  return [...new Set<string>(items.filter((i: any) => i?.kind === "goal" && i?.status === "searched" && typeof i.text === "string" && i.text.trim()).map((i: any) => String(i.text).trim()))];
}

// When their asks can't be read, nothing is known to be idle: one unnamed item counts as running, so a failed read never becomes a
// "nothing's running" denial (review of the 10-13 fixes).
export const UNREADABLE: SearchCoverage = { asks: [], goals: [], held: [], hidden: 1 };

export async function searchCoverage(userId: string): Promise<SearchCoverage> {
  const asksRead = await pool
    .query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND kind = 'find' ORDER BY COALESCE(last_mentioned_at, created_at) DESC`, [userId])
    .then((r) => r.rows.map((x: any) => String(x.ask_text ?? "").trim()).filter(Boolean))
    .catch(() => null);
  if (!asksRead) return UNREADABLE;
  const [asks, goals] = await Promise.all([
    Promise.resolve(asksRead),
    pool
      .query(`SELECT proposal FROM harness_decisions WHERE decision = 'sweep.daily' AND user_id = $1 AND created_at > NOW() - ($2 || ' hours')::interval ORDER BY created_at DESC LIMIT 1`, [userId, String(DAILY_RUN_MAX_AGE_HOURS)])
      .then((r) => searchedGoals(r.rows[0]?.proposal))
      .catch(() => [] as string[]),
  ]);
  // What holds every search (the same reader the floor uses for asks): nothing is being searched while it holds, goals included.
  const held = asks.length || goals.length ? await import("../harness/proactive.js").then((P) => P.sweepHold(userId, "ask")).catch(() => ["unreadable"]) : [];
  return held.length ? { asks: [], goals: [], held } : { asks, goals, held };
}
