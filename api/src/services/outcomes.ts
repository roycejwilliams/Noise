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

export type SuggestionKind = "event" | "opportunity" | "intro";
// acted: they said they signed up, applied, or went (a reaction to something
// Co sent, services/offerReactions.ts).
export type SuggestionResult = "interested" | "declined" | "acted" | "helped" | "didnt_help" | "no_signal";

export async function recordSuggestionOutcome(
  userId: string,
  kind: SuggestionKind,
  itemKey: string,
  itemName: string,
  result: SuggestionResult,
  note?: string | null,
): Promise<void> {
  await pool
    .query(
      `INSERT INTO suggestion_outcomes (user_id, kind, item_key, item_name, result, note) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, item_key, result) DO NOTHING`,
      [userId, kind, itemKey, itemName, result, note ?? null],
    )
    .catch((err: any) => console.error("recordSuggestionOutcome failed (non-fatal):", err?.message ?? err));
}

// Named outcome from a "how did it go?" answer.
export function resultFromNamedOutcome(outcome: string): SuggestionResult {
  return outcome === "named_positive" ? "helped" : outcome === "named_critical" ? "didnt_help" : "no_signal";
}
