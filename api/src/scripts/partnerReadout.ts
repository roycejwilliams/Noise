import "dotenv/config";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherStats, renderHtml, renderText } from "../services/partnerReadout.js";
import pool from "../db/db.js";

// The partner readout for one Co event (services/partnerReadout.ts, services/partnerReadoutSend.ts). The team's tool: nothing here
// runs on its own, and nothing reaches a host except by `approve` and then `send`, each run by a person.
//
//   npx tsx src/scripts/partnerReadout.ts preview <eventApiId> "<event name>"   build it now and show it; stores and sends nothing
//   npx tsx src/scripts/partnerReadout.ts show <eventApiId>                      the stored draft (or approved/sent readout)
//   npx tsx src/scripts/partnerReadout.ts draft <eventApiId> "<event name>"     build and store the draft now (the hourly job does this)
//   npx tsx src/scripts/partnerReadout.ts approve <eventApiId> --by <name> [--host <email>]   the team's yes; prints the host's link
//   npx tsx src/scripts/partnerReadout.ts send <eventApiId>                      the one email to the host, only once approved
//   npx tsx src/scripts/partnerReadout.ts withdraw <eventApiId>                  the link stops working
const flag = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? null : null;
};

async function main() {
  const [, , cmd, eventId, ...rest] = process.argv;
  const R = await import("../services/partnerReadoutSend.js");
  if (cmd === "preview" && eventId && rest[0]) {
    const stats = await gatherStats(eventId, rest[0]);
    console.log(renderText(stats));
    const file = join(tmpdir(), `partner-readout-${eventId.replace(/[^a-z0-9]+/gi, "-")}.preview.html`);
    writeFileSync(file, renderHtml(stats));
    console.log(`\nPreview saved to ${file}. Nothing was stored or sent.`);
  } else if (cmd === "show" && eventId) {
    const r = await R.readoutFor(eventId);
    console.log(r ? `${r.text}\n\nstatus: ${r.status}${r.approved_by ? `, approved by ${r.approved_by}` : ""}${r.host_email ? `, host ${r.host_email}` : ""}${r.sent_at ? `, sent ${new Date(r.sent_at).toISOString()}` : ""}` : "No readout stored for that event.");
  } else if (cmd === "draft" && eventId && rest[0]) {
    console.log(await R.draftReadout(eventId, rest[0]));
  } else if (cmd === "approve" && eventId) {
    const r = await R.approveReadout(eventId, { by: flag(rest, "by") ?? "", hostEmail: flag(rest, "host") });
    console.log(r.ok ? `Approved. The host's read-only link (shown once, good for 30 days):\n${r.link}\nNothing has been emailed. To email it: send ${eventId}` : `Not approved: ${r.why}.`);
  } else if (cmd === "send" && eventId) {
    const r = await R.sendReadout(eventId);
    console.log(r.ok ? "Sent to the host." : `Not sent: ${r.why}.`);
  } else if (cmd === "withdraw" && eventId) {
    console.log((await R.withdrawReadout(eventId)) ? "Withdrawn: the link no longer works." : "Nothing to withdraw.");
  } else {
    console.error('usage: partnerReadout.ts preview|draft <eventApiId> "<event name>" | show|send|withdraw <eventApiId> | approve <eventApiId> --by <name> [--host <email>]');
    process.exitCode = 1;
  }
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
