// An on-demand 9am-style run for one member (services/dailySweep.ts runDailySweepNow): the same search across all three tiers, pick and
// morning send as the daily floor, now. Every run writes its own summary line (sweep.daily, trigger "manual"), on the dashboard beside
// the day's 9am run; at most one morning text goes out a day, whatever ran the sweep.
//
//   node dist/api/src/scripts/sweepNow.js <user id>
import pool from "../db/db.js";
import { runDailySweepNow } from "../services/dailySweep.js";

async function main() {
  const userId = process.argv[2];
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("usage: sweepNow.js <user id>");
  console.log(JSON.stringify(await runDailySweepNow(userId)));
  await pool.end();
}
main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
