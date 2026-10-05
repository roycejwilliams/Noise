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

// A tease-stage outcome is recorded without the name ("... (name not shared)",
// routes/sendblue.ts): they hadn't been told who. When the reveal is sent and
// they answer, the same item records again and the named label replaces it;
// otherwise the first row stands (DO NOTHING before, and still for all else).
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
       ON CONFLICT (user_id, item_key, result) DO UPDATE SET item_name = EXCLUDED.item_name
         WHERE suggestion_outcomes.item_name LIKE '%(name not shared)'`,
      [userId, kind, itemKey, itemName, result, note ?? null],
    )
    .catch((err: any) => console.error("recordSuggestionOutcome failed (non-fatal):", err?.message ?? err));
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
      `SELECT item_name, result FROM suggestion_outcomes WHERE user_id = $1 AND created_at > NOW() - ($2 || ' days')::interval AND result <> 'no_signal' ORDER BY created_at DESC LIMIT 40`,
      [userId, days],
    )
    .catch(() => ({ rows: [] as any[] }));
  if (!rows.length) return null;
  const pick = (results: string[]) => [...new Set(rows.filter((r: any) => results.includes(r.result)).map((r: any) => r.item_name as string))].slice(0, 6);
  const liked = pick(["helped", "acted"]);
  const keen = pick(["interested"]).filter((n) => !liked.includes(n));
  const not = pick(["declined", "didnt_help"]);
  const parts = [
    liked.length ? `went to or liked: ${liked.join(", ")}` : null,
    keen.length ? `were interested in: ${keen.join(", ")}` : null,
    not.length ? `said weren't for them or didn't help: ${not.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? `From what they've told Co about things it sent, they ${parts.join("; and ")}.` : null;
}
