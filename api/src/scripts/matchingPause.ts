// The matching kill switch (services/roomMatching.ts): stops all matching and intro sends, everywhere or for one event,
// the moment it's set. Not a feature toggle: it's for stopping something going wrong.
//
//   npx tsx src/scripts/matchingPause.ts on all "why"
//   npx tsx src/scripts/matchingPause.ts on <eventId> "why"
//   npx tsx src/scripts/matchingPause.ts off all|<eventId>
//   npx tsx src/scripts/matchingPause.ts status
import "dotenv/config";
import pool from "../db/db.js";
import { PAUSE_ALL, setMatchingPause } from "../services/roomMatching.js";

const [cmd, scopeArg, ...why] = process.argv.slice(2);
const scope = scopeArg === "all" || !scopeArg ? PAUSE_ALL : scopeArg;
if (cmd === "on" || cmd === "off") {
  await setMatchingPause(scope, cmd === "on", why.join(" ") || null);
  console.log(`matching ${cmd === "on" ? "PAUSED" : "resumed"} for ${scope === PAUSE_ALL ? "all events" : scope}`);
} else if (cmd !== "status") {
  console.log("usage: matchingPause.ts on|off all|<eventId> [why] | status");
  process.exitCode = 1;
}
const { rows } = await pool.query(`SELECT scope, paused, reason, updated_at FROM matching_pauses ORDER BY updated_at DESC`);
for (const r of rows) console.log(`${r.paused ? "PAUSED " : "running"}  ${r.scope}  ${r.reason ?? ""}  (${new Date(r.updated_at).toISOString()})`);
await pool.end();
