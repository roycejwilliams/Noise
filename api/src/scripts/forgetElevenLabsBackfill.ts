// One-off backfill (2026-10-18; schedule 2026-10-23): queue for deletion at ElevenLabs the conversations of calls we already stored
// before the scheduled delete shipped (services/elevenLabsForget.ts). Same rule as the post-call path: only a conversation whose
// transcript is stored on our side and whose processing completed, due 7 days (member) or 30 days (team, test numbers) after our
// copy was stored. Prints counts only, never ids, names or text.
//
//   npx tsx src/scripts/forgetElevenLabsBackfill.ts            dry run (the default): reads and counts, writes and deletes nothing
//   npx tsx src/scripts/forgetElevenLabsBackfill.ts --apply    queues them; the scheduled pass deletes each once due. Needs
//                                                              Royce's yes first. Respects ELEVENLABS_DELETE=off.
//
// Runs against whichever database DATABASE_URL points at (dev locally; co-test via `railway run`). The elevenlabs_deletions
// and call_health tables come from the server's migrations (db/migrations.ts), so the server must have started once on this code.
import "dotenv/config";
import pool from "../db/db.js";
import { backfillMode, realForgetDeps, runBackfill } from "../services/elevenLabsForget.js";

const mode = backfillMode(process.argv.slice(2));
try {
  await runBackfill(realForgetDeps(), mode);
  if (mode === "dry-run") console.log("\nDry run: nothing was written or deleted. Deleting needs Royce's yes, then --apply.");
} catch (err: any) {
  console.error("backfill failed:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
