import "dotenv/config";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pool from "../db/db.js";
import * as P from "../services/partners.js";
import { pendingCopy } from "../services/partnerCopy.js";

// Partners as configuration (services/partners.ts): the team's tool. A new partner is a row, never code. Nothing here texts or
// emails anyone; it only reads and writes the config and prints what the partner needs (their blurb, their link, their QR).
//
//   npx tsx src/scripts/partners.ts list
//   npx tsx src/scripts/partners.ts add <slug> "<name>" --blurb "<text with {link}>" [--host-name <name>] [--host-email <email>]
//   npx tsx src/scripts/partners.ts set <slug> [--name ..] [--blurb ..] [--host-name ..] [--host-email ..]   (new blurb words lose their sign-off)
//   npx tsx src/scripts/partners.ts approve-blurb <slug> --by <name>       the sign-off on the blurb as it reads now
//   npx tsx src/scripts/partners.ts end <slug>                            the agreement ended: every link of theirs stops
//   npx tsx src/scripts/partners.ts event <slug> "<event name>" --start <ISO with offset> [--end <ISO>] [--tz <Zone>] [--venue ..] [--address ..]
//   npx tsx src/scripts/partners.ts open <eventId>                        the partner opens intake: the code goes live
//   npx tsx src/scripts/partners.ts close <eventId>                       the night is called off: the code dies for good
//   npx tsx src/scripts/partners.ts show <slug>                           config, each night's state, link, blurb, and its door QR file
const flag = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const opt = (args: string[], name: string) => (args.includes(`--${name}`) ? flag(args, name) ?? "" : undefined);

async function doorQr(code: string, url: string): Promise<string> {
  const QR = await import("qrcode");
  const file = join(tmpdir(), `door-qr-${code}.svg`);
  writeFileSync(file, await QR.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 }));
  return file;
}

async function show(slug: string) {
  const partner = await P.partnerBySlug(slug);
  if (!partner) return console.log(`No partner "${slug}".`);
  console.log(`${partner.name} (${partner.slug})${partner.ended_at ? `, ended ${new Date(partner.ended_at).toISOString()}` : ""}`);
  console.log(`host read goes to: ${partner.host_name ?? "(no name)"} <${partner.host_email ?? "no email"}>`);
  console.log(`blurb: ${partner.rsvp_blurb}`);
  console.log(`blurb sign-off: ${partner.rsvp_blurb_approved_by ?? "NOT SIGNED OFF (it isn't handed out until it is)"}`);
  const pending = pendingCopy();
  if (pending.length) console.log(`guest copy still waiting on Royce (services/partnerCopy.ts): ${pending.join(", ")}`);
  const now = new Date();
  for (const e of await P.partnerEvents(partner.id)) {
    const url = P.entryUrl(e.code);
    console.log(`\n${e.name}  [${e.api_id}]  ${e.start_at}${e.end_at ? ` to ${e.end_at}` : ""}${e.timezone ? ` ${e.timezone}` : ""}`);
    console.log(`  code ${e.code}: ${P.entryState(partner, e, now)}`);
    if (!url) {
      console.log("  API_URL isn't set, so there's no link or QR to give.");
      continue;
    }
    console.log(`  link (RSVP page and door QR): ${url}`);
    const blurb = P.renderBlurb(partner, e, url);
    if (blurb) console.log(`  blurb for the RSVP page:\n    ${blurb}`);
    console.log(`  door QR: ${await doorQr(e.code, url)}`);
  }
}

async function main() {
  const [, , cmd, a, ...rest] = process.argv;
  if (cmd === "list") {
    for (const p of await P.listPartners()) console.log(`${p.slug}\t${p.name}${p.ended_at ? "\t(ended)" : ""}`);
  } else if (cmd === "add" && a && rest[0]) {
    const r = await P.addPartner({ slug: a, name: rest[0], rsvp_blurb: flag(rest, "blurb") ?? "", host_name: flag(rest, "host-name"), host_email: flag(rest, "host-email") });
    console.log(r.ok ? `Added ${r.partner.name}. Its blurb needs a sign-off: approve-blurb ${r.partner.slug} --by <name>` : `Not added: ${r.why}.`);
  } else if (cmd === "set" && a) {
    const r = await P.updatePartner(a, { name: opt(rest, "name"), rsvp_blurb: opt(rest, "blurb"), host_name: opt(rest, "host-name"), host_email: opt(rest, "host-email") });
    console.log(r.ok ? `Updated.${r.partner.rsvp_blurb_approved_by ? "" : " The blurb needs a sign-off before it's handed out."}` : `Not updated: ${r.why}.`);
  } else if (cmd === "approve-blurb" && a) {
    const r = await P.approveBlurb(a, flag(rest, "by") ?? "");
    console.log(r.ok ? "Signed off." : `Not signed off: ${r.why}.`);
  } else if (cmd === "end" && a) {
    console.log((await P.endPartner(a)) ? "Ended: every link of theirs has stopped." : "Nothing to end.");
  } else if (cmd === "event" && a && rest[0]) {
    const r = await P.addPartnerEvent(a, { name: rest[0], start_at: flag(rest, "start") ?? "", end_at: flag(rest, "end"), timezone: flag(rest, "tz"), venue: flag(rest, "venue"), address: flag(rest, "address") });
    if (!r.ok) console.log(`Not added: ${r.why}.`);
    else console.log(`Added ${r.event.name} [${r.event.api_id}], code ${r.event.code}. Intake isn't open yet: open ${r.event.api_id}`);
    if (r.ok) await show(a);
  } else if (cmd === "open" && a) {
    const r = await P.openIntake(a);
    console.log(r.ok ? "Open: the code is live." : `Not opened: ${r.why}.`);
  } else if (cmd === "close" && a) {
    console.log((await P.closePartnerEvent(a)) ? "Closed: the code is dead for good." : "Nothing to close.");
  } else if (cmd === "show" && a) {
    await show(a);
  } else {
    console.error("usage: partners.ts list | add <slug> \"<name>\" --blurb .. | set <slug> .. | approve-blurb <slug> --by <name> | end <slug> | event <slug> \"<name>\" --start <ISO> .. | open|close <eventId> | show <slug>");
    process.exitCode = 1;
  }
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
