// Backfill of the action ledger (snapshot design 2026-10-29 §3 step 2; services/ledger.ts): every act the old stores hold becomes
// its one co_facts row. Sources, per member: "Co replied:" lines (source memory:<id>, only when no outbound_messages row holds the
// same text), outbound_messages, harness_decisions tool.* rows of every outcome, the event offer triples (one row each, the answer
// on it), the recommendation pairs (one row per find) and document_deliveries.
//
// Idempotent: each row's object_key is "L|" + the old-store row it mirrors and its happened_at is that row's time, so a second run,
// or a run after the live dual write already wrote an act, meets co_facts' unique key and ON CONFLICT DO NOTHING keeps one. A thing
// already sent within two minutes collapses into the row that has it (a find logged as a recommendation and as a shareFinds call).
//
//   --dry-run   reads only (BEGIN READ ONLY ... ROLLBACK): the same rules run against an in-memory copy of each member's ledger
//               rows; prints what would be written, per source, with samples
//   --write     writes, in one transaction, committed at the end. Not approved yet: run only with Royce's yes.
//
//   DATABASE_URL=postgres://...@127.0.0.1:55432/railway npx tsx src/scripts/ledgerBackfill.ts --dry-run --confirm-db railway [--member <id>]
// Dev server only (scripts/ledgerDb.ts). Every read is scoped to one member.
import { memoryLedgerStore, pgLedgerStore, type WriteResult } from "../services/ledger.js";
import { loadSources, runBackfill, type BackfillCounts, type BackfillItem } from "../services/ledgerSources.js";
import { arg, members, openDevDb, short } from "./ledgerDb.js";

export function addCounts(into: BackfillCounts, from: BackfillCounts): void {
  for (const [k, v] of Object.entries(from)) {
    const c = (into[k] ??= { candidates: 0, written: 0, conflict: 0, collapsed: 0 });
    c.candidates += v.candidates;
    c.written += v.written;
    c.conflict += v.conflict;
    c.collapsed += v.collapsed;
  }
}

export function countsTable(counts: BackfillCounts): string {
  const rows = Object.entries(counts);
  const total = rows.reduce((a, [, v]) => ({ candidates: a.candidates + v.candidates, written: a.written + v.written, conflict: a.conflict + v.conflict, collapsed: a.collapsed + v.collapsed }), { candidates: 0, written: 0, conflict: 0, collapsed: 0 });
  const line = (name: string, v: typeof total) => `  ${name.padEnd(26)} ${String(v.candidates).padStart(6)} ${String(v.written).padStart(8)} ${String(v.conflict).padStart(9)} ${String(v.collapsed).padStart(10)}`;
  return [`  ${"source".padEnd(26)} ${"rows".padStart(6)} ${"written".padStart(8)} ${"already".padStart(9)} ${"collapsed".padStart(10)}`, ...rows.map(([k, v]) => line(k, v)), line("total", total)].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const write = args.includes("--write");
  if (dry === write) throw new Error("pass exactly one of --dry-run or --write");
  const only = arg(args, "--member");
  const db = await openDevDb(args, { readOnly: dry });
  let commit = false;
  try {
    console.log(`${dry ? "DRY RUN (read only; nothing is written)" : "WRITE"}\n`);
    const all = (await members(db.query)).filter((m) => !only || m.id === only);
    const totals: BackfillCounts = {};
    const byGroup: Record<string, BackfillCounts> = {};
    const samples: Record<string, string[]> = {};
    const sample = (m: { id: string }) => (item: BackfillItem, result: WriteResult) => {
      if (result !== "written") return;
      const list = (samples[item.source] ??= []);
      if (list.length < 3) list.push(`${short(m.id)} ${item.row.at.toISOString().slice(0, 16)} ${item.row.relation.padEnd(8)} ${item.row.parts.map((p) => p.label).join("; ").replace(/\s+/g, " ").slice(0, 90)}`);
    };
    let other = 0;
    for (const m of all) {
      const src = await loadSources(db.query, m.id);
      other += src.outboundOther;
      const store = dry ? memoryLedgerStore(src.ledger) : pgLedgerStore(db.query);
      const counts = await runBackfill(store, src, sample(m));
      addCounts(totals, counts);
      addCounts((byGroup[m.group] ??= {}), counts);
    }
    console.log(`${all.length} members\n\nAll members (rows = candidates; written = new rows; already = in the ledger; collapsed = the same act as a row already there):`);
    console.log(countsTable(totals));
    for (const [g, c] of Object.entries(byGroup)) console.log(`\n${g} members:\n${countsTable(c)}`);
    console.log(`\nNot Cue's acts toward the member, left out: ${other} outbound rows under another sender (mo, ops).`);
    console.log("\nSamples (member, time UTC, relation, label):");
    for (const [k, list] of Object.entries(samples)) console.log(`  ${k}:\n    ${list.join("\n    ")}`);
    commit = write;
  } finally {
    await db.close(commit);
  }
}

if (process.argv[1] && /ledgerBackfill\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      const msg = String(err?.message ?? err);
      console.error(/^(refusing|pass |DATABASE_URL)/.test(msg) ? msg : `failed (class ${String(err?.code ?? "unknown").slice(0, 5)})`);
      process.exit(1);
    },
  );
}
