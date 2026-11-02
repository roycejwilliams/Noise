// Cue's contact card: whether a new version is needed, what it changes, who it would reach, and (only with Royce's approval) the push.
// services/cardReissue.ts holds the rules; this only runs them.
//
//   node dist/api/src/scripts/cardReissue.js check                       is a revision needed, and on what basis ($0, no DB)
//   node dist/api/src/scripts/cardReissue.js diff [--version 2]          the field diff against the card members hold ($0, no DB)
//   node dist/api/src/scripts/cardReissue.js preview --version 2 --out <dir>
//                                                                        writes Cue-v2.vcf with fictional 555-01xx numbers ($0, no DB)
//   node dist/api/src/scripts/cardReissue.js dry-run --version 2         coverage: eligible, excluded by reason. Reads the DB, sends nothing.
//   node dist/api/src/scripts/cardReissue.js send  --version 2 --approved v2:<hash12>
//   node dist/api/src/scripts/cardReissue.js retry --version 2 --approved v2:<hash12>
//
// send and retry refuse unless the version carries Royce's approval record (utils/vcard.ts) and --approved matches it. send tries only
// members never tried for that version; retry only those whose last attempt failed or was held.
import fs from "node:fs";
import path from "node:path";
import { approvalFlag, diffFromPrevious, realPushDeps, reissueCheck, runPush, type Mode } from "../services/cardReissue.js";
import { cardDiff, cardSha, cardVersion, liveVersion, renderCard } from "../utils/vcard.js";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
};

async function main() {
  const cmd = process.argv[2];
  const n = Number(arg("version") ?? 2);
  if (cmd === "check") {
    const r = reissueCheck();
    console.log(JSON.stringify({ held: r.held.version, revise: r.decision.revise, basis: r.decision.basis, notABasis: r.decision.notABasis, waitingOnRoyce: r.waiting ? { version: r.waiting.version, contentSha: cardSha(r.waiting) } : null }, null, 2));
    return;
  }
  if (cmd === "diff") {
    const v = cardVersion(n);
    if (!v) throw new Error(`no card version ${n}`);
    const rows = diffFromPrevious(n) ?? cardDiff(liveVersion(), v);
    for (const d of rows) console.log(`${d.changed ? "*" : " "} ${d.field.padEnd(5)} ${d.from.slice(0, 90)}\n        -> ${d.to.slice(0, 90)}`);
    console.log(`\ncontentSha ${cardSha(v)}  flag ${approvalFlag(v)}`);
    return;
  }
  if (cmd === "preview") {
    const v = cardVersion(n);
    const out = arg("out");
    if (!v || !out) throw new Error("usage: preview --version <n> --out <dir>");
    // Fictional numbers (555-0100..0199 are reserved for fiction): the real ones come from the env when the card is served.
    const vcf = renderCard(v, { SENDBLUE_PHONE_NUMBER: "+14155550100", TWILIO_PHONE_NUMBER: "+14155550101" });
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, `Cue-v${n}.vcf`);
    fs.writeFileSync(file, vcf);
    console.log(`${file} (${Buffer.byteLength(vcf)} bytes)`);
    return;
  }
  const modes: Record<string, Mode> = { "dry-run": "dry_run", send: "send", retry: "retry" };
  const mode = modes[cmd ?? ""];
  if (!mode) throw new Error("usage: cardReissue.js check | diff | preview | dry-run | send | retry (see the top of this file)");
  const { default: pool } = await import("../db/db.js");
  try {
    const report = await runPush({ version: n, mode, flag: arg("approved") }, await realPushDeps());
    console.log(JSON.stringify(report, null, 2));
    if (report.refused) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
