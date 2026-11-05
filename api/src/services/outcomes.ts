// Did it help? (Royce, 2026-09-15: "every intro, event or opportunity gets
// a 'did it help?' result, and that result shapes the next search").
//
// One row per result for anything Co suggested: an event or opportunity
// teased or recommended, an intro offered, a debrief answered. The person
// snapshot (harness/personSnapshot.ts) turns these into "suggestions that
// helped / didn't", and the sweep's search brief leans toward what worked
// and away from what didn't. Tier weighting (getTierBias) still reads its
// own co_memories rows.
import pool from "../db/db.js";
import { isDidResult, isStated, UNCONFIRMED_RULE, type Provenance } from "./provenance.js";

export type SuggestionKind = "event" | "opportunity" | "intro";
// acted: they said they signed up, applied, or went (a reaction to something
// Co sent, services/offerReactions.ts).
export type SuggestionResult = "interested" | "declined" | "acted" | "helped" | "didnt_help" | "no_signal";

// A tease-stage outcome is recorded without the name ("... (name not shared)",
// routes/sendblue.ts): they hadn't been told who. When the reveal is sent and
// they answer, the same item records again and the named label replaces it;
// otherwise the first row stands (DO NOTHING before, and still for all else).
// from: where a result about what they did comes from (services/provenance.ts). "stated" only with their own explicit words; left
// out, the row's provenance is unknown and every reader treats a did-result as unconfirmed. A stated row upgrades an earlier one.
export async function recordSuggestionOutcome(
  userId: string,
  kind: SuggestionKind,
  itemKey: string,
  itemName: string,
  result: SuggestionResult,
  note?: string | null,
  from?: { provenance: Provenance; quote?: string | null } | null,
): Promise<void> {
  await pool
    .query(
      `INSERT INTO suggestion_outcomes (user_id, kind, item_key, item_name, result, note, provenance, quote) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, item_key, result) DO UPDATE SET item_name = EXCLUDED.item_name
         WHERE suggestion_outcomes.item_name LIKE '%(name not shared)'`,
      [userId, kind, itemKey, itemName, result, note ?? null, from?.provenance ?? null, from?.quote ? from.quote.slice(0, 300) : null],
    )
    .catch((err: any) => console.error("recordSuggestionOutcome failed (non-fatal):", err?.message ?? err));
  await settleFollowUpForResult(userId, itemKey, result);
  // Their own words later confirm a row that was there already: it becomes stated, with those words.
  if (from?.provenance === "stated") {
    await pool
      .query(`UPDATE suggestion_outcomes SET provenance = 'stated', quote = $4 WHERE user_id = $1 AND item_key = $2 AND result = $3 AND provenance IS DISTINCT FROM 'stated'`, [userId, itemKey, result, from.quote ? from.quote.slice(0, 300) : null])
      .catch((err: any) => console.error("recordSuggestionOutcome: confirming the row failed (non-fatal):", err?.message ?? err));
  }
}

// What a recorded result does to the find's follow-up (Royce, 2026-11-04: never assume a member went). A stated plan (acted) arms the
// parked follow-up, which asks only whether they went. A stated went / didn't help is already the outcome: the row is closed, since a
// debrief would re-ask what they told Cue. A no drops it with the reason. "interested" is a yes to hearing more, not a plan to go, so it
// arms nothing. Never throws.
export async function settleFollowUpForResult(userId: string, itemKey: string, result: SuggestionResult): Promise<void> {
  try {
    const R = await import("./recommendationOutcome.js");
    if (result === "acted") await R.armOutcomeFollowUp(userId, itemKey);
    else if (result === "helped" || result === "didnt_help") await R.dropOutcomeFollowUp(userId, itemKey, "they already told Cue how it went");
    else if (result === "declined") await R.dropOutcomeFollowUp(userId, itemKey, "they said it isn't for them");
  } catch (err: any) {
    console.error("settleFollowUpForResult failed (non-fatal):", err?.message ?? err);
  }
}

// Named outcome from a "how did it go?" answer.
export function resultFromNamedOutcome(outcome: string): SuggestionResult {
  return outcome === "named_positive" ? "helped" : outcome === "named_critical" ? "didnt_help" : "no_signal";
}

// What's landed with them and what hasn't (2026-09-26: make Co more
// adaptable). Until Co recorded reactions itself (conversationTools.ts
// noteReaction), this table had one row, so nothing downstream had anything
// to learn from. Read into replies (harness/replyGrounding.ts) and into which
// message Co chooses to send first (harness/proactive.ts choosePick).
export async function tasteSummary(userId: string, days = 120): Promise<string | null> {
  const { rows } = await pool
    .query(
      `SELECT item_name, result, provenance FROM suggestion_outcomes WHERE user_id = $1 AND created_at > NOW() - ($2 || ' days')::interval AND result <> 'no_signal' ORDER BY created_at DESC LIMIT 40`,
      [userId, days],
    )
    .catch(() => ({ rows: [] as any[] }));
  return tasteFrom(rows);
}

// Pure: the summary from outcome rows. What they did (went, signed up, liked it) is said only when they stated it; a did-result
// they never confirmed is listed as unconfirmed, to ask about at most (services/provenance.ts).
export function tasteFrom(rows: { item_name: string; result: string; provenance?: string | null }[]): string | null {
  if (!rows.length) return null;
  const did = (r: { result: string; provenance?: string | null }) => isDidResult(r.result) && isStated(r.provenance);
  const names = (xs: typeof rows) => [...new Set(xs.map((r) => r.item_name))].slice(0, 6);
  // Went to and liked: their stated word that they went and it helped. A stated "going" is a plan, said as one (2026-10-12 review).
  const liked = names(rows.filter((r) => did(r) && r.result === "helped"));
  const planned = names(rows.filter((r) => did(r) && r.result === "acted")).filter((n) => !liked.includes(n));
  const unconfirmed = names(rows.filter((r) => isDidResult(r.result) && !isStated(r.provenance) && r.result !== "didnt_help")).filter((n) => !liked.includes(n) && !planned.includes(n));
  const keen = names(rows.filter((r) => r.result === "interested")).filter((n) => !liked.includes(n) && !planned.includes(n) && !unconfirmed.includes(n));
  const not = names(rows.filter((r) => r.result === "declined" || (r.result === "didnt_help" && isStated(r.provenance))));
  const parts = [
    liked.length ? `went to and liked: ${liked.join(", ")}` : null,
    planned.length ? `said they were going to or signed up for (not that they went; ask whether they made it): ${planned.join(", ")}` : null,
    keen.length ? `were interested in: ${keen.join(", ")}` : null,
    not.length ? `said weren't for them or didn't help: ${not.join(", ")}` : null,
  ].filter(Boolean);
  const head = parts.length ? `From what they've told Cue about things it sent, they ${parts.join("; and ")}.` : "";
  const tail = unconfirmed.length ? ` Possibly went to or signed up for (${UNCONFIRMED_RULE}): ${unconfirmed.join(", ")}.` : "";
  return head || tail ? `${head}${tail}`.trim() : null;
}
