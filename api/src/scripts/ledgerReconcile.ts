// Reconcile of the action ledger, READ ONLY (snapshot design 2026-10-29 §3 step 3; services/ledgerSources.ts reconcileMember). Per
// member, every act the old stores hold is matched against that member's ledger rows in co_facts. It reports counts per source,
// the contents of every act left unmatched, and any act the ledger holds twice. No reader moves to the ledger until it reports
// nothing unmatched and no doubles.
//
//   --assume-backfill   also runs the backfill (scripts/ledgerBackfill.ts rules) against an in-memory copy of each member's ledger
//                       rows first, and reconciles against that: what would still be unmatched if the backfill ran. Writes nothing.
//   --limit <n>         unmatched rows printed per member (default 20; counts are always complete)
//
//   DATABASE_URL=postgres://...@127.0.0.1:55432/railway npx tsx src/scripts/ledgerReconcile.ts --confirm-db railway [--assume-backfill] [--member <id>]
// Dev server only, inside BEGIN READ ONLY ... ROLLBACK (scripts/ledgerDb.ts). Every read is scoped to one member.
import { memoryLedgerStore } from "../services/ledger.js";
import { loadSources, reconcileMember, runBackfill, type ReconcileResult } from "../services/ledgerSources.js";
import { arg, members, openDevDb, short } from "./ledgerDb.js";

// Pure: the report for a set of member results.
export function reconcileReport(results: (ReconcileResult & { group?: string })[], limit = 20): string {
  const out: string[] = [];
  const totals: Record<string, { total: number; matched: number }> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.bySource)) {
    const t = (totals[k] ??= { total: 0, matched: 0 });
    t.total += v.total;
    t.matched += v.matched;
  }
  const unmatched = results.reduce((a, r) => a + r.unmatched.length, 0);
  const doubles = results.reduce((a, r) => a + r.doubles.length, 0);
  out.push(`${results.length} members; old-store acts ${Object.values(totals).reduce((a, t) => a + t.total, 0)}; unmatched ${unmatched}; doubles in the ledger ${doubles}`);
  out.push(`  ${"source".padEnd(26)} ${"acts".padStart(6)} ${"matched".padStart(8)} ${"unmatched".padStart(10)}`);
  for (const [k, t] of Object.entries(totals)) out.push(`  ${k.padEnd(26)} ${String(t.total).padStart(6)} ${String(t.matched).padStart(8)} ${String(t.total - t.matched).padStart(10)}`);
  out.push(`  (transcript notes, recorded by their own source: ${results.reduce((a, r) => a + r.notes, 0)}; outbound rows under another sender, left out: ${results.reduce((a, r) => a + r.outboundOther, 0)})`);
  for (const r of results) {
    if (!r.unmatched.length && !r.doubles.length) continue;
    out.push(`\nmember ${short(r.userId)}${r.group ? ` (${r.group})` : ""}: ${r.unmatched.length} unmatched, ${r.doubles.length} doubles, ${r.ledgerRows} ledger rows`);
    for (const u of r.unmatched.slice(0, limit)) out.push(`  unmatched ${u.source} ${u.ref.slice(0, 12)} ${u.at.toISOString().slice(0, 19)}: ${u.text}`);
    if (r.unmatched.length > limit) out.push(`  ... ${r.unmatched.length - limit} more`);
    for (const d of r.doubles.slice(0, limit)) out.push(`  double ${d.key.slice(0, 80)} at ${d.at.toISOString().slice(0, 19)}: ${d.a} / ${d.b}`);
  }
  return out.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const assume = args.includes("--assume-backfill");
  const only = arg(args, "--member");
  const limit = Number(arg(args, "--limit") ?? 20);
  const db = await openDevDb(args, { readOnly: true });
  try {
    console.log(`READ ONLY reconcile${assume ? ", as if the backfill had run (in memory; nothing is written)" : ", against the ledger as it is"}\n`);
    const results: (ReconcileResult & { group: string })[] = [];
    for (const m of (await members(db.query)).filter((x) => !only || x.id === only)) {
      const src = await loadSources(db.query, m.id);
      let ledger = src.ledger;
      if (assume) {
        const store = memoryLedgerStore(src.ledger);
        await runBackfill(store, src);
        ledger = store.rows;
      }
      results.push({ ...reconcileMember(src, ledger), group: m.group });
    }
    console.log(reconcileReport(results, limit));
  } finally {
    await db.close(false);
  }
}

if (process.argv[1] && /ledgerReconcile\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      const msg = String(err?.message ?? err);
      console.error(/^(refusing|pass |DATABASE_URL)/.test(msg) ? msg : `failed (class ${String(err?.code ?? "unknown").slice(0, 5)})`);
      process.exit(1);
    },
  );
}
