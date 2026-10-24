// Flagged calls (the after-call health check, services/callHealth.ts): list the ones nobody has reviewed, or mark one reviewed.
// A flagged call is held at ElevenLabs until it is marked reviewed; after that its normal deletion applies (7 days for a member,
// 30 for the team and test numbers, counted from when our copy was stored), so one already past its window goes on the next pass.
//
//   npx tsx src/scripts/callReviewed.ts                     list: conversation id, member id, when, reason codes (no words)
//   npx tsx src/scripts/callReviewed.ts <conversation id>   mark that call reviewed
//
// On co-test, where this scripts folder isn't built:
//   node --input-type=module -e "const m = await import('/app/co-test/dist/api/src/services/callHealth.js'); console.log(await m.markCallReviewed('<conversation id>'))"
import "dotenv/config";
import pool from "../db/db.js";
import { flaggedCalls, markCallReviewed } from "../services/callHealth.js";

const id = process.argv.slice(2).find((a) => !a.startsWith("--"));
try {
  if (id) {
    console.log((await markCallReviewed(id)) ? `marked ${id} reviewed` : `no flagged call ${id}`);
  } else {
    // Every one still held, however old (the morning review shows the last 30 days).
    const calls = await flaggedCalls({ days: 3650 });
    if (!calls.length) console.log("No flagged calls waiting for review.");
    for (const c of calls) console.log(`${c.conversationId}  ${c.userId}  ${c.endedAt}  ${c.reasons.join(", ")}`);
  }
} catch (err: any) {
  console.error("callReviewed failed:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
