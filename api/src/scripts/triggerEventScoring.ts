import "dotenv/config";
import pool from "../db/db.js";
import { scoreGuestListForEvent } from "../services/eventScoring.js";

// Reusable test tool (Royce, 2026-09-05) — manually replays what a real
// guest.registered/guest.updated Luma webhook triggers (routes/luma.ts's
// runScoringPass -> scoreGuestListForEvent), so scoring can be re-run
// against the same real event across different stated-ask variations
// (see setStatedAsk.ts) without needing a real webhook delivery each time.
//
// Usage: tsx src/scripts/triggerEventScoring.ts <event_api_id>
async function main() {
  const [, , eventId] = process.argv;
  if (!eventId) {
    console.error("Usage: tsx src/scripts/triggerEventScoring.ts <event_api_id>");
    process.exit(1);
  }

  const result = await scoreGuestListForEvent(eventId);
  console.log("[triggerEventScoring] scoreGuestListForEvent result:", result);

  const { rows } = await pool.query(
    `SELECT egr.person_id, u.first_name, egr.ranked_candidates, egr.method_summary, egr.computed_at
     FROM event_guest_rankings egr
     JOIN users u ON u.id = egr.person_id
     WHERE egr.event_id = $1
     ORDER BY egr.computed_at DESC`,
    [eventId],
  );
  console.log("[triggerEventScoring] rankings:", JSON.stringify(rows, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error("[triggerEventScoring] failed:", err);
  process.exit(1);
});
