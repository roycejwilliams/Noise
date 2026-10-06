import "dotenv/config";
import { writeFileSync } from "node:fs";
import { gatherStats, renderHtml, renderText } from "../services/partnerReadout.js";
import pool from "../db/db.js";

// The partner readout for one Co event (services/partnerReadout.ts). Preview only: it builds the readout, prints it
// and saves an HTML file. Sending it to the event host is paused (Royce, 2026-10-05: "may just create an API for
// it"), so there is no send path here at all.
//
//   npx tsx src/scripts/partnerReadout.ts <eventApiId> "<event name>"
async function main() {
  const [, , eventId, eventName] = process.argv;
  if (!eventId || !eventName) {
    console.error('usage: partnerReadout.ts <eventApiId> "<event name>"');
    process.exit(1);
  }
  const stats = await gatherStats(eventId, eventName);
  const html = renderHtml(stats);
  console.log(renderText(stats));
  const file = `partner-readout-${eventId.replace(/[^a-z0-9]+/gi, "-")}.preview.html`;
  writeFileSync(file, html);
  console.log(`\nPreview saved to ${file}. Nothing was sent.`);
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
