// Design metrics (services/designSystem.ts): per medium, artifacts made, first-shot acceptance (made and never revised within 48
// hours, over the ones at least 48 hours old), keeps, shares, and what design QA found. npm run metrics:design [days]
import "dotenv/config";
import { designMetrics } from "../services/designSystem.js";

const days = Number(process.argv[2] ?? 30) || 30;
const rows = await designMetrics(days);
console.log(`Design metrics, last ${days} days`);
for (const r of rows) console.log(`${r.medium.padEnd(5)} made ${r.made}  first-shot ${r.firstShot}/${r.settled}${r.firstShotRate !== null ? ` (${Math.round(r.firstShotRate * 100)}%)` : ""}  kept ${r.kept}  shared ${r.shared}  QA findings ${r.qaFindings}`);
if (!rows.length) console.log("(nothing made yet)");
process.exit(0);
