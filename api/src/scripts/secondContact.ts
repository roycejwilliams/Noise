// The second-contact number (services/secondContact.ts): of Co's introductions whose email went, how many led to meeting or talking
// again within 30 days, by what either side told Co. Read only.
//   npx tsx src/scripts/secondContact.ts [--days 180] [--include-recent]
import pool from "../db/db.js";
import { SECOND_CONTACT_DAYS, secondContactRate } from "../services/secondContact.js";

const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 180;
const r = await secondContactRate({ sinceDays: days, includeRecent: process.argv.includes("--include-recent") });
const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
console.log(`Introductions in the last ${days} days${process.argv.includes("--include-recent") ? "" : ` (at least ${SECOND_CONTACT_DAYS} days old)`}: ${r.intros}`);
console.log(`Either side told Cue how it went: ${r.answered}`);
console.log(`Met or talked again within ${SECOND_CONTACT_DAYS} days: ${r.metAgain}  →  ${pct(r.rate)} of introductions (${pct(r.answeredRate)} of those Cue heard about)`);
await pool.end();
