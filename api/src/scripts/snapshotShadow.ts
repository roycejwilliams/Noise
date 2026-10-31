// The member snapshot in shadow, measured on dev (snapshot design step 2). READ ONLY: builds every real member's snapshot in memory
// (services/memberSnapshot.ts buildInMemory: the same loaders, builder and fence as a stored build) and writes nothing, logs nothing.
// Prints counts and sizes only: never a member's text, id, name or phone.
//
//   DATABASE_URL=postgres://...@127.0.0.1:55432/railway npx tsx src/scripts/snapshotShadow.ts [--expect-port 55432] [--include-test]
//
// Safety, in this order (the same as scripts/forgetResidueAudit.ts):
//   - not production (NODE_ENV or RAILWAY_ENVIRONMENT_NAME), and a local tunnel on the expected port; checked before connecting.
//   - every connection opens read only (PGOPTIONS default_transaction_read_only=on, set before the pool exists), checked on a
//     connection before anything is read, so no loader can write (memberZone's stored derived zone fails and is read as unknown).
//   - the server's system identifier is the dev server's (forgetResidueAudit DEV_SYSTEM_ID); any other server is refused.
// Members: not archived, and not a test number (555-01xx) unless --include-test.
// --project-ledger: the ledger section as it will be once PR 1's backfill has run (scripts/ledgerBackfill.ts): each member's backfill
// is run against an in-memory store seeded with their ledger rows (the backfill's own dry run) and its rows are added to what the
// builder reads. Nothing is written.
const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT_NAME === "production") throw new Error("refusing: production");
const port = Number(arg("--expect-port") ?? 55432);
const url = new URL(process.env.DATABASE_URL ?? "postgres://none@nowhere:1/none");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || Number(url.port) !== port) {
  console.error(`refusing: DATABASE_URL must be a local tunnel on port ${port}`);
  process.exit(2);
}
process.env.PGOPTIONS = `${process.env.PGOPTIONS ?? ""} -c default_transaction_read_only=on -c statement_timeout=30000`.trim();

const { default: pool } = await import("../db/db.js");
const { DEV_SYSTEM_ID } = await import("./forgetResidueAudit.js");
const S = await import("../services/memberSnapshot.js");
const { isTestNumber } = await import("../services/testNumbers.js");
const project = args.includes("--project-ledger");
const LS = await import("../services/ledgerSources.js");
const L = await import("../services/ledger.js");
// Builds read as a stored build does; with --project-ledger, plus the rows the backfill would write (ids "p1", "p2"...: not co_facts ids).
const load = async (userId: string, now: Date) => {
  const src = await S.loadSources(userId, now);
  if (!project) return src;
  const old = await LS.loadSources((sql, p) => pool.query(sql, p as any[]), userId);
  const store = L.memoryLedgerStore(old.ledger);
  const before = store.rows.length;
  await LS.runBackfill(store, old);
  const added = store.rows.slice(before).map((r, i) => ({ id: `p${i + 1}`, relation: r.relation, label: r.label, url: r.url, at: r.at, source: r.source, meta: r.meta }));
  src.ledger = [...src.ledger, ...added].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 4000);
  return src;
};

const ro = (await pool.query(`SHOW default_transaction_read_only`)).rows[0]?.default_transaction_read_only;
if (ro !== "on") {
  console.error("refusing: the connection didn't open read only");
  process.exit(2);
}
const sys = (await pool.query(`SELECT system_identifier::text AS id FROM pg_control_system()`)).rows[0]?.id;
if (sys !== DEV_SYSTEM_ID) {
  console.error("refusing: not the dev server");
  process.exit(2);
}

const users = (await pool.query(`SELECT id, phone_number FROM users WHERE archived_at IS NULL ORDER BY id`)).rows as { id: string; phone_number: string | null }[];
const members = users.filter((u) => args.includes("--include-test") || !isTestNumber(u.phone_number, { NODE_ENV: "development" } as NodeJS.ProcessEnv));

type Row = { total: number; sec: Record<string, number>; ms: number; compacted: Record<string, number>; over: string[]; fence: string; entries: number; forgotten: number; redacted: number };
const out: Row[] = [];
const errors: Record<string, number> = {};
const now = new Date();
// One at a time (the dev server is shared; this is a measure, not a load test). A first build warms the module graph and isn't timed.
if (members[0]) await S.buildInMemory(members[0].id, { now, deps: { load } });
for (const m of members) {
  const r = await S.buildInMemory(m.id, { now, deps: { load } });
  if (!r.built || !r.fence) {
    errors[r.error ?? "Error"] = (errors[r.error ?? "Error"] ?? 0) + 1;
    continue;
  }
  const b = r.built;
  out.push({
    total: b.tokens.total,
    sec: Object.fromEntries(S.SECTION_IDS.map((id) => [id, b.tokens[id]])),
    ms: r.ms,
    compacted: Object.fromEntries(b.compactions.map((c) => [c.section, c.count])),
    over: b.overBudget,
    fence: r.fence.ok ? "ok" : r.fence.kind,
    entries: b.sections.reduce((n, s) => n + s.sourceCount, 0),
    forgotten: b.forgotten,
    redacted: b.namesRedacted,
  });
}
await pool.end();

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0);
  return { median: at(0.5), p90: at(0.9), max: s.length ? s[s.length - 1] : 0 };
};
const fmt = (o: { median: number; p90: number; max: number }) => `median ${o.median.toLocaleString()} | p90 ${o.p90.toLocaleString()} | max ${o.max.toLocaleString()}`;
console.log(project ? "ledger section: projected (as after PR 1's backfill; in memory)" : "ledger section: as on file now");
console.log(`members: ${members.length} (of ${users.length} unarchived${args.includes("--include-test") ? ", test numbers included" : ", test numbers left out"}); built ${out.length}; failed ${members.length - out.length}${Object.keys(errors).length ? ` (${Object.entries(errors).map(([k, n]) => `${k} x${n}`).join(", ")})` : ""}`);
console.log(`tokens per member (est., ${S.CHARS_PER_TOKEN} chars/token): ${fmt(stats(out.map((r) => r.total)))}`);
for (const id of S.SECTION_IDS) console.log(`  ${id.padEnd(9)} (budget ${S.SECTION_BUDGETS[id].toLocaleString().padStart(6)}): ${fmt(stats(out.map((r) => r.sec[id])))}`);
console.log(`build ms: ${fmt(stats(out.map((r) => r.ms)))}`);
console.log(`entries per member: ${fmt(stats(out.map((r) => r.entries)))}`);
console.log(`fence blocks: ${out.filter((r) => r.fence !== "ok").length} (name ${out.filter((r) => r.fence === "name").length}, user id ${out.filter((r) => r.fence === "user_id").length})`);
console.log(`linked names taken out of lines: ${out.reduce((n, r) => n + r.redacted, 0)} across ${out.filter((r) => r.redacted).length} members`);
console.log(`lines the forgetting guards took out: ${out.reduce((n, r) => n + r.forgotten, 0)} across ${out.filter((r) => r.forgotten).length} members`);
const compactedMembers = out.filter((r) => Object.keys(r.compacted).length);
console.log(`compactions: ${compactedMembers.length} members; entries collapsed by section: ${S.SECTION_IDS.map((id) => `${id} ${out.reduce((n, r) => n + (r.compacted[id] ?? 0), 0)}`).join(", ")}`);
const over: Record<string, number> = {};
for (const r of out) for (const o of r.over) over[o] = (over[o] ?? 0) + 1;
console.log(`over budget (members): ${Object.keys(over).length ? Object.entries(over).map(([k, n]) => `${k} ${n}`).join(", ") : "none"}`);
process.exit(0);
