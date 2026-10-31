// Dry run of the daily words job (services/ledgerWords.ts): how many of Cue's action rows it would reduce right now, per kind and per
// member group, with a few examples that show the kind only (never a label, a link or a member). Reads only: BEGIN READ ONLY
// (checked), always rolled back (scripts/ledgerDb.ts).
//
//   DATABASE_URL=postgres://...@127.0.0.1:55432/railway npx tsx src/scripts/ledgerWordsDryRun.ts --confirm-db railway [--as-of 2026-12-01]
// --as-of: what a run on that day would reduce, from the rows there today (still read only). Dev server only.
import { ageLedgerWords, WORDS_DAYS } from "../services/ledgerWords.js";
import { arg, members, openDevDb } from "./ledgerDb.js";

async function main() {
  const args = process.argv.slice(2);
  const asOf = arg(args, "--as-of");
  const now = asOf ? new Date(`${asOf}T12:00:00Z`) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("--as-of takes a date (YYYY-MM-DD)");
  const db = await openDevDb(args, { readOnly: true });
  try {
    const group = new Map((await members(db.query)).map((m) => [m.id, m.group]));
    const byGroup: Record<string, number> = {};
    const examples: Record<string, string[]> = {};
    const counts = await ageLedgerWords(db.query, {
      now,
      dryRun: true,
      onRow: (r, a) => {
        const g = group.get(r.ownerUserId) ?? "unknown";
        byGroup[g] = (byGroup[g] ?? 0) + 1;
        const tool = r.meta?.tool ?? (r.source.startsWith("tool.") ? r.source.replace(/^tool\./, "").split(/[.:]/)[0] : "");
        const list = (examples[a.kind] ??= []);
        const age = Math.floor((now.getTime() - r.at.getTime()) / 86_400_000);
        if (list.length < 2) list.push(`${a.kind}${tool ? ` (${tool})` : ""}, ${age} days old: label ${r.label.length} chars -> ${a.label === r.label ? "unchanged (no words in it)" : `the act${a.label.includes("(http") ? " + its link" : ""}`}${a.objectKey !== r.objectKey ? ", key replaced" : ""}`);
      },
    });
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM co_facts WHERE subject = 'co' AND meta ? 'words_aged'`);
    console.log(`DRY RUN (read only; nothing is written)${asOf ? `, as of ${asOf}` : ""}. Window: ${WORDS_DAYS} days, cutoff ${new Date(now.getTime() - WORDS_DAYS * 86_400_000).toISOString().slice(0, 10)}\n`);
    console.log(`Rows the job would mark: ${counts.rows} (label or key actually changes on ${counts.changed}); already reduced: ${rows[0]?.n ?? 0}`);
    console.log("\nBy kind:");
    for (const [k, n] of Object.entries(counts.byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${String(n).padStart(6)}`);
    console.log("\nBy member group:");
    for (const [g, n] of Object.entries(byGroup)) console.log(`  ${g.padEnd(28)} ${String(n).padStart(6)}`);
    console.log("\nExamples (kind only; no label, link or member):");
    for (const list of Object.values(examples)) for (const e of list) console.log(`  ${e}`);
  } finally {
    await db.close(false);
  }
}

if (process.argv[1] && /ledgerWordsDryRun\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err?.message ?? err);
      process.exit(1);
    },
  );
}
