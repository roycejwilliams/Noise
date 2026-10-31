// The action ledger's SQL (services/ledger.ts pgLedgerStore, applyOfferState) run against a real Postgres: a throwaway cluster on a
// Unix socket in a temp folder, the same way as evals/silence/failureRowsSql.ts. co_facts is made from the DDL in db/migrations.ts
// (its embedding column left out: pgvector isn't needed here). Where the binaries aren't installed, the run says the database part
// was skipped.
//   - two finds with one name at two different pages are two rows; a find recorded twice (recommendation, then shareFinds) is one
//   - a write is idempotent on co_facts' own unique key; a call that sent two finds, one already recorded, keeps the other
//   - an offer's answer lands on its row, or on the row it collapsed into, or is logged; never a silent no-op
//   - deleting the account deletes every ledger row of theirs (ON DELETE CASCADE), and nobody else's
//   - the daily words job (services/ledgerWords.ts): a 61-day-old label is reduced to the act, a 59-day-old one isn't, another
//     member's rows are untouched by a run scoped to one member, a second run changes nothing, the backfill never brings the words
//     back, and the reconcile still matches every act after the reduction
//   TZ=UTC node evals/runLayer1.mjs evals/ledger/ledgerSql.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
const { default: pool } = await import("../../src/db/db.js");
const decisions: any[][] = [];
(pool as any).query = async (sql: string, p: any[] = []) => { if (/INSERT INTO harness_decisions/.test(sql)) decisions.push(p); return { rows: [] }; };
const L = await import("../../src/services/ledger.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, JSON.stringify(detail ?? "").slice(0, 400)); } };

const mig = fs.readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
const ddl = mig.match(/CREATE TABLE IF NOT EXISTS co_facts \([\s\S]*?\n\s*\)`/)?.[0]?.replace(/`$/, "").replace(/\n\s*embedding vector\(1536\),/, "");
check("co_facts' DDL is read from the migrations, its owner cascading on account delete", !!ddl && /owner_user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/.test(ddl) && /UNIQUE \(owner_user_id, relation, object_key, happened_at\)/.test(ddl), ddl);

// The words job runs in the daily retention job, right after the decision log prune (same 60 days), and the every-boot tool backfill
// reads no further back than that window, so a reduced row is never rebuilt with its words.
const jobs = fs.readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
const retention = jobs.slice(jobs.indexOf("DELETE FROM harness_decisions WHERE created_at < NOW() - INTERVAL '60 days'"));
check("words: the daily retention job runs the words job after the decision log prune", retention.length > 0 && /ageLedgerWords\(\)/.test(retention.slice(0, 1600)));
// Each step in its own try: a failing prune or handles delete never skips the words job (review of #329).
const retentionBlock = retention.slice(0, retention.indexOf("co_facts word-aging cron error") + 40);
check("words: the words job has its own try, separate from the prune and the handles delete", (retentionBlock.match(/catch \(error\)/g) ?? []).length === 3 && retentionBlock.includes("co_facts word-aging cron error"));
const cfSrc = fs.readFileSync(new URL("../../src/services/coFacts.ts", import.meta.url), "utf8");
check("words: the every-boot tool backfill reads decisions inside the words window only", /decision LIKE 'tool\.%' AND action = 'done' AND user_id IS NOT NULL AND created_at > NOW\(\) - make_interval\(days => \$\{WORDS_DAYS\}\)/.test(cfSrc));
const { WORDS_DAYS } = await import("../../src/services/ledgerWords.js");
const { DECISION_LOG_DAYS } = await import("../../src/services/ledgerSources.js");
check("words: the words window is the decision log's", WORDS_DAYS === 60 && DECISION_LOG_DAYS === 60);

// ---- against a real Postgres
const bin = (name: string) => {
  for (const dir of [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin"]) {
    const p = path.join(dir, name);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
};
const initdb = bin("initdb"), postgres = bin("postgres");
// Set up a throwaway cluster. Missing binaries skip the database part, visibly (a SKIP line the layer-1 summary lists); binaries that
// are there but won't set up or start a cluster fail the run, so a full shared-memory table (or anything else) never turns into a
// quiet skip behind a green layer 1.
// postgres runs as this test's own child, in its process group, never daemonized: the layer-1 runner's timeout kills the whole group,
// so it can't be left running. It is stopped with SIGINT (a fast shutdown that releases its SysV shared memory; SIGKILL leaks one
// segment per run, and macOS allows 32), waited for, and killed only if it doesn't stop in time. Folders a killed run left behind are
// swept on the next run.
type Cluster = { sock: string; stop: () => Promise<void> };
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
async function startCluster(): Promise<{ ok: Cluster } | { skip: string } | { fail: string }> {
  if (!initdb || !postgres) return { skip: "no local postgres binaries (initdb, postgres)" };
  for (const old of fs.readdirSync(os.tmpdir()).filter((n) => /^cue-ledger-/.test(n))) {
    const at = path.join(os.tmpdir(), old);
    try { if (Date.now() - fs.statSync(at).mtimeMs > 60 * 60_000) fs.rmSync(at, { recursive: true, force: true }); } catch {}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-ledger-"));
  const data = path.join(dir, "d");
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  const init = spawnSync(initdb, ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync"], { encoding: "utf8", timeout: 60_000 });
  if (init.status !== 0) { remove(); return { fail: `initdb is installed but failed (${(init.stderr || init.error?.message || "").split("\n").filter(Boolean)[0]?.slice(0, 160) ?? "no output"})` }; }
  const child = spawn(postgres, ["-D", data, "-k", dir, "-c", "listen_addresses=", "-c", "fsync=off"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));
  const alive = () => child.exitCode === null && child.signalCode === null;
  // A normal stop: fast shutdown, then SIGKILL only if it hasn't exited in 10s.
  const stop = async () => {
    if (alive()) {
      child.kill("SIGINT");
      for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
      if (alive()) child.kill("SIGKILL");
    }
    remove();
  };
  // An exit that skips the finally below: the same, synchronously.
  process.on("exit", () => {
    if (alive()) {
      try { child.kill("SIGINT"); } catch {}
      for (let i = 0; i < 50; i++) { try { process.kill(child.pid!, 0); } catch { break; } sleepSync(100); }
      try { process.kill(child.pid!, 0); child.kill("SIGKILL"); } catch {}
    }
    remove();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(1));
  const sockFile = path.join(dir, ".s.PGSQL.5432");
  for (let i = 0; i < 100 && !fs.existsSync(sockFile); i++) {
    if (!alive()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(sockFile)) { await stop(); return { fail: `postgres is installed but didn't start (${stderr.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? "no output"})` }; }
  return { ok: { sock: dir, stop, pid: child.pid! } };
}
// SysV shared-memory segments this cluster's postgres created (CPID), still there (null where ipcs isn't there). Counting only
// its own keeps the check true when another layer-1 run (another worktree's merge gate) has a cluster up at the same time.
const shmSegmentsOf = (pid: number) => {
  const r = spawnSync("ipcs", ["-m", "-p"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const head = r.stdout.split("\n").find((l) => /\bCPID\b/.test(l));
  const col = head ? head.trim().split(/\s+/).indexOf("CPID") : -1;
  if (col < 0) return null;
  return r.stdout.split("\n").filter((l) => /^\s*m\s/.test(l)).filter((l) => Number(l.trim().split(/\s+/)[col]) === pid).length;
};
// The daily words job against the real table (services/ledgerWords.ts).
async function wordsAge(q: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }>) {
  const W = await import("../../src/services/ledgerWords.js");
  const S = await import("../../src/services/ledgerSources.js");
  const C = "00000000-0000-4000-8000-0000000000c3", D = "00000000-0000-4000-8000-0000000000d4";
  await q(`INSERT INTO users (id) VALUES ($1), ($2)`, [C, D]);
  const now = new Date("2026-10-31T12:00:00.000Z");
  const daysAgo = (d: number, ms = 0) => new Date(now.getTime() - d * 86_400_000 + ms);
  const OLD = 61, YOUNG = 59;
  // Their words, which must be gone from every reduced row: in labels, keys and meta.
  const WORDS = ["date with sam", "jazz nights for a date", "sister", "anniversary", "salsa for my birthday"];
  const src = (userId: string, young: boolean): any => ({
    userId, outboundOther: 0, memories: [], ledger: [],
    outbound: [
      { handle: `${userId}-h1`, at: daysAgo(OLD), content: "Found a jazz trio for your date with Sam on Friday." },
      ...(young ? [{ handle: `${userId}-h2`, at: daysAgo(YOUNG), content: "Here's the one for your date with Sam." }] : []),
    ],
    replied: [
      // The transcript line of the outbound text above (the backfill skips it: one act), and a line with no outbound row (its own row),
      // 30s apart, so two reduced texts sit inside the doubles window.
      { id: "aaaaaaaa-0000-4000-8000-000000000001", at: daysAgo(OLD, 1_000), text: "Found a jazz trio for your date with Sam on Friday." },
      { id: "aaaaaaaa-0000-4000-8000-000000000002", at: daysAgo(OLD, 30_000), text: "How did your sister's toast go?" },
    ].map((r) => ({ ...r, id: userId === C ? r.id : r.id.replace("aaaaaaaa", "bbbbbbbb") })),
    tools: [
      { id: `${userId}-1`, decision: "tool.searchEvents", action: "done", at: daysAgo(OLD, 5_000), proposal: { input: { what: userId === C ? "jazz nights for a date" : "salsa for my birthday" } } },
      { id: `${userId}-2`, decision: "tool.shareFinds", action: "done", at: daysAgo(OLD, 6_000), proposal: { input: { items: [{ link: "https://lu.ma/e/evt111", caption: "A jazz trio Friday, good for a date with Sam." }, { link: "https://lu.ma/e/evt222", caption: "Wine bar for the anniversary." }] } } },
      { id: `${userId}-3`, decision: "tool.writeDocument", action: "not_done", at: daysAgo(OLD, 7_000), proposal: { input: { title: "Anniversary plan" }, made: "the anniversary plan" } },
      ...(young ? [{ id: `${userId}-4`, decision: "tool.saveAsk", action: "done", at: daysAgo(YOUNG), proposal: { input: { what: "jazz nights for a date" } } }] : []),
    ],
    docs: [{ id: `${userId}-doc`, at: daysAgo(OLD, 8_000), title: "Anniversary dinner plan", channel: "pdf_text", version: 1, docKey: "anniversary-dinner-plan", link: "https://cue.example/d/AbCdEfGhIjKlMnOpQrStUvWx", status: "delivered" }],
  });
  // The decision ids are numeric in the real log; here any text is an anchor.
  const sc = src(C, true), sd = src(D, false);
  sc.memories = [{ id: "offer-1", type: "event_offer_pending", at: daysAgo(OLD, 20 * 60_000), content: JSON.stringify({ match: { name: "Friday Jazz Trio", url: "https://lu.ma/e/evt333" } }) }];
  const store = L.pgLedgerStore(q);
  await S.runBackfill(store, sc);
  await S.runBackfill(store, sd);
  // An offer (the event's own name, kept), and content-keyed rows: tool rows (reduced) and a proactive text (not touched here).
  await L.writeLedgerRow(store, L.offerRow({ userId: C, memoryId: "offer-1", at: daysAgo(OLD, 20 * 60_000), match: { name: "Friday Jazz Trio", url: "https://lu.ma/e/evt333" }, offerState: "pending" }));
  const fact = (owner: string, relation: string, label: string, key: string, url: string | null, source: string, at: Date) =>
    q(`INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, url, visibility, source, happened_at, meta) VALUES ($1, 'co', $2, $3, $4, $5, 'owner', $6, $7, '{}')`, [owner, relation, label, key, url, source, at]);
  for (const who of [C, D]) {
    await fact(who, "did", "saved an ask to keep looking for: jazz nights for a date", "saved an ask to keep looking for: jazz nights for a date", null, "tool.saveAsk", daysAgo(OLD));
    await fact(who, "sent", "A jazz trio Friday, good for a date with Sam.", "https://lu.ma/e/evt111", "https://lu.ma/e/evt111", "tool.shareFinds:backfill", daysAgo(OLD));
    await fact(who, "searched", "jazz nights for a date", "jazz nights for a date", null, "tool.searchEvents", daysAgo(YOUNG));
    await fact(who, "texted", "Still thinking about your date with Sam?", "still thinking about your date with sam?", null, "proactive_sends:1", daysAgo(OLD));
    await fact(who, "did", "reacted with a tapback", "reacted with a tapback", null, "tool.reactInsteadOfReplying", daysAgo(OLD));
    await fact(who, "searched", "jazz nights for a date with Sam", "jazz nights for a date with sam", null, "tool.searchNow:backfill", daysAgo(OLD));
  }
  const rowsOf = async (who: string) => (await q(`SELECT id::text, relation, object_label, object_key, url, source, happened_at, meta FROM co_facts WHERE owner_user_id = $1 ORDER BY co_facts.id`, [who])).rows;
  const ledgerOf = async (who: string) =>
    (await rowsOf(who)).filter((r) => r.meta?.ledger).map((r) => ({ userId: who, relation: r.relation, objectKey: r.object_key, label: r.object_label, url: r.url, at: new Date(r.happened_at), source: r.source, meta: r.meta }));
  const wordsIn = (r: any) => WORDS.filter((w) => `${r.object_label} ${r.object_key} ${JSON.stringify(r.meta)}`.toLowerCase().includes(w));
  const rec0 = S.reconcileMember(sc, await ledgerOf(C), now);
  check("words: before the job, the reconcile matches every act (the baseline)", rec0.unmatched.length === 0 && rec0.doubles.length === 0 && rec0.orphans.length === 0, rec0);
  const beforeD = JSON.stringify(await rowsOf(D));

  // A run scoped to one member, in pages of two.
  const first = await W.ageLedgerWords(q, { now, owner: C, batch: 2 });
  const after = await rowsOf(C);
  const byKey = (k: string) => after.find((r) => r.object_key === k);
  const old = after.filter((r) => new Date(r.happened_at) < daysAgo(W.WORDS_DAYS));
  const young = after.filter((r) => new Date(r.happened_at) >= daysAgo(W.WORDS_DAYS));
  check("words: a 61-day-old ledger search keeps the act, not their words", byKey(`L|decision:${C}-1`)?.object_label === "events" && byKey(`L|decision:${C}-1`)?.relation === "searched" && !!byKey(`L|decision:${C}-1`)?.meta?.words_aged, byKey(`L|decision:${C}-1`));
  const share = byKey(`L|decision:${C}-2`);
  check("words: a 61-day-old ledger send keeps each link it sent, and its keys keep only the links", share?.object_label === "a find (https://lu.ma/e/evt111); a find (https://lu.ma/e/evt222)" && JSON.stringify(share?.meta?.items) === JSON.stringify(["u:https://lu.ma/e/evt111", "u:https://lu.ma/e/evt222"]) && share?.meta?.groups?.length === 2, share);
  const nd = byKey(`L|decision:${C}-3`);
  check("words: a not_done tool row names the tool only, and its made title goes", nd?.relation === "not_done" && nd?.object_label === "used writeDocument" && !("made" in (nd?.meta ?? {})), nd);
  check("words: a 61-day-old text keeps that it was sent (its handle), not its words", byKey(`L|outbound:${C}-h1`)?.object_label === "a text" && byKey(`L|outbound:${C}-h1`)?.meta?.handle === `${C}-h1` && byKey("L|memory:aaaaaaaa-0000-4000-8000-000000000002")?.object_label === "a text");
  const doc = byKey(`L|document_deliveries:${C}-doc`);
  check("words: a document keeps its kind, version and link; its title and doc_key go", doc?.object_label === "a document (PDF)" && doc?.url === "https://cue.example/d/AbCdEfGhIjKlMnOpQrStUvWx" && doc?.meta?.version === 1 && !("doc_key" in doc.meta) && !doc.meta.items.some((k: string) => k.startsWith("n:")), doc);
  check("words: the offer keeps the event's own name", byKey("L|memory:offer-1")?.object_label === "Friday Jazz Trio" && !byKey("L|memory:offer-1")?.meta?.words_aged);
  const did = after.find((r) => r.source === "tool.saveAsk" && !r.meta?.ledger);
  const sentFact = after.find((r) => r.source === "tool.shareFinds:backfill");
  check("words: a content-keyed tool row is reduced the same way; its label key is replaced, its link key kept", did?.object_label === "saved an ask" && did?.object_key === `aged|${did?.id}` && sentFact?.object_label === "a find (https://lu.ma/e/evt111)" && sentFact?.object_key === "https://lu.ma/e/evt111", { did, sentFact });
  const tap = after.find((r) => r.source === "tool.reactInsteadOfReplying");
  check("words: a tool whose label never held their words keeps its label and key (marked only)", tap?.object_label === "reacted with a tapback" && tap?.object_key === "reacted with a tapback" && !!tap?.meta?.words_aged, tap);
  const older = after.find((r) => r.source === "tool.searchNow:backfill");
  check("words: an older tool's row (searchNow) is reduced to its act", older?.object_label === "events" && older?.object_key === `aged|${older?.id}`, older);
  check("words: a content-keyed proactive text isn't touched here (its source still holds the words; see the PR)", after.find((r) => r.source === "proactive_sends:1")?.object_label === "Still thinking about your date with Sam?");
  const leftover = old.filter((r) => r.source !== "proactive_sends:1" && !(r.meta?.kind === "offer")).flatMap(wordsIn);
  check("words: no reduced row holds their words anywhere (label, key, meta)", leftover.length === 0, leftover);
  check("words: a 59-day-old row is untouched (ledger and content-keyed)", young.length === 3 && young.every((r) => !r.meta?.words_aged) && young.some((r) => r.object_label === "jazz nights for a date") && young.some((r) => r.object_key === `L|outbound:${C}-h2` && r.object_label === "Here's the one for your date with Sam."), young.map((r) => [r.object_key, r.object_label]));
  check("words: another member's rows are untouched by a run scoped to this one", JSON.stringify(await rowsOf(D)) === beforeD);
  check("words: the counts say what changed (the tapback is marked, not changed)", first.rows === 10 && first.changed === 9, first);

  // Idempotent, and the backfill never brings the words back.
  const snap = JSON.stringify(after);
  const second = await W.ageLedgerWords(q, { now, owner: C });
  const again = await S.runBackfill(store, sc);
  check("words: a second run changes nothing", second.rows === 0 && JSON.stringify(await rowsOf(C)) === snap, second);
  check("words: the ledger backfill re-run writes nothing back (every act meets its own row)", Object.values(again).every((c) => c.written === 0) && JSON.stringify(await rowsOf(C)) === snap, again);
  const rec = S.reconcileMember(sc, await ledgerOf(C), now);
  check("words: after the reduction, the reconcile still matches every act, with no doubles or orphans", rec.unmatched.length === 0 && rec.doubles.length === 0 && rec.orphans.length === 0 && rec.repeatedTexts === 0, rec);
  // The whole job (every member), as the daily job runs it: now the other member's old rows too.
  const all = await W.ageLedgerWords(q, { now });
  const dRows = await rowsOf(D);
  check("words: the daily job (all members) reduces the other member's old rows too, and leaves this member's alone", all.rows === 10 && dRows.filter((r) => r.meta?.words_aged).every((r) => wordsIn(r).length === 0) && JSON.stringify(await rowsOf(C)) === snap, all);
  const recD = S.reconcileMember(sd, await ledgerOf(D), now);
  check("words: the other member's reconcile matches after the job too", recD.unmatched.length === 0 && recD.doubles.length === 0 && recD.orphans.length === 0, recD);
}

const started = await startCluster();
if ("skip" in started) {
  console.log(`SKIP ledgerSql: ${started.skip}; the database part didn't run`);
} else if ("fail" in started) {
  check(`the throwaway database starts where postgres is installed: ${started.fail}`, false);
} else {
  const cluster = started.ok;
  try {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ host: cluster.sock, user: "postgres", database: "postgres" });
    await c.connect();
    const q = (sql: string, p?: unknown[]) => c.query(sql, p as any[]);
    const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b2";
    await q(`CREATE TABLE users (id UUID PRIMARY KEY)`);
    await q(ddl!);
    await q(`CREATE TABLE co_memories (id UUID PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE, memory_type TEXT, content TEXT, created_at TIMESTAMPTZ)`);
    await q(`INSERT INTO users (id) VALUES ($1), ($2)`, [A, B]);
    const store = L.pgLedgerStore(q);
    const t = new Date("2026-10-30T18:00:00.000Z");
    const plus = (ms: number) => new Date(t.getTime() + ms);
    const count = async (who = A, where = "TRUE") => Number((await q(`SELECT count(*)::int AS n FROM co_facts WHERE owner_user_id = $1 AND meta ? 'ledger' AND ${where}`, [who])).rows[0].n);

    // The review's case: one call, two finds, one name, two pages.
    const r1 = await L.writeLedgerRow(store, L.recommendationRow({ userId: A, memoryId: "m1", at: t, name: "Sunday Run Club", url: "https://lu.ma/run-sf" }));
    const r2 = await L.writeLedgerRow(store, L.recommendationRow({ userId: A, memoryId: "m2", at: t, name: "Sunday Run Club", url: "https://lu.ma/run-oakland" }));
    check("two finds with one name at two different pages are two rows", r1 === "written" && r2 === "written" && (await count(A, "relation = 'sent'")) === 2, { r1, r2 });
    // A find recorded as a recommendation, then as the shareFinds call that sent it: one row.
    const r3 = await L.writeLedgerRow(store, L.toolOutcomeRow({ userId: A, tool: "shareFinds", receipt: "done", input: { items: [{ link: "https://lu.ma/run-sf", caption: "Sunday Run Club, 8am" }] }, decisionId: "9", at: plus(2_000) }));
    check("a find recorded as a recommendation and as the shareFinds call is one row", r3 === "collapsed" && (await count(A, "relation = 'sent'")) === 2, r3);
    // A name match with no link on one side is the same thing (a surfacing line beside its offer).
    const r4 = await L.writeLedgerRow(store, L.surfacingRow({ userId: A, memoryId: "m3", at: plus(2_400), name: "Sunday Run Club" }));
    check("a name with no link beside a row of that name is the same thing", r4 === "collapsed", r4);
    check("idempotent: the same act again meets the unique key", (await L.writeLedgerRow(store, L.recommendationRow({ userId: A, memoryId: "m1", at: t, name: "Sunday Run Club", url: "https://lu.ma/run-sf" }))) === "conflict" && (await count()) === 2);
    // Partly recorded: two finds in one call, one already there.
    const r5 = await L.writeLedgerRow(store, L.toolOutcomeRow({ userId: A, tool: "shareFinds", receipt: "done", input: { items: [{ link: "https://lu.ma/run-oakland", caption: "Oakland run" }, { link: "https://lu.ma/jazz", caption: "Jazz night" }] }, decisionId: "10", at: plus(3_000) }));
    const partRow = (await q(`SELECT object_label, url, meta FROM co_facts WHERE owner_user_id = $1 AND object_key = 'L|decision:10'`, [A])).rows[0];
    check("a call that sent two finds, one already recorded, keeps only the other", r5 === "written" && partRow?.object_label === "Jazz night" && partRow?.url === "https://lu.ma/jazz" && partRow?.meta?.collapsed === 1, partRow);
    // Another member's rows never cover this member's acts.
    check("another member's row never collapses this member's act", (await L.writeLedgerRow(store, L.recommendationRow({ userId: B, memoryId: "m9", at: t, name: "Sunday Run Club", url: "https://lu.ma/run-sf" }))) === "written");

    // An offer's answer: on its own row; on the row it collapsed into; or logged.
    const pend = "11111111-1111-4111-8111-111111111111", pend2 = "22222222-2222-4222-8222-222222222222", pend3 = "33333333-3333-4333-8333-333333333333";
    await q(`INSERT INTO co_memories VALUES ($1, $2, 'event_offer_pending', $3, $4), ($5, $2, 'event_offer_pending', $6, $7), ($8, $2, 'event_offer_pending', $9, $4)`, [
      pend, A, JSON.stringify({ match: { name: "Rooftop Mixer", url: "https://lu.ma/roof" } }), plus(60_000),
      pend2, JSON.stringify({ match: { name: "Jazz Night", url: "https://lu.ma/jazz" } }), plus(4_000),
      pend3, JSON.stringify({ match: { name: "Nowhere", url: "https://lu.ma/none" } }),
    ]);
    await L.writeLedgerRow(store, L.offerRow({ userId: A, memoryId: pend, at: plus(60_000), match: { name: "Rooftop Mixer", url: "https://lu.ma/roof" }, offerState: "pending" }));
    const collapsedOffer = await L.writeLedgerRow(store, L.offerRow({ userId: A, memoryId: pend2, at: plus(4_000), match: { name: "Jazz Night", url: "https://lu.ma/jazz" }, offerState: "pending" }));
    const s1 = await L.applyOfferState(q, A, pend, "interested");
    const s2 = await L.applyOfferState(q, A, pend2, "not_interested");
    const s3 = await L.applyOfferState(q, A, pend3, "interested");
    const states = (await q(`SELECT object_key, meta->>'offer_state' AS s FROM co_facts WHERE owner_user_id = $1 AND meta ? 'offer_state'`, [A])).rows;
    check("an offer's answer lands on its own row", s1 === "own" && states.some((r) => r.object_key === `L|memory:${pend}` && r.s === "interested"), { s1, states });
    check("an offer that collapsed: its answer lands on the row it collapsed into", collapsedOffer === "collapsed" && s2 === "survivor" && (await q(`SELECT meta->>'offer_state' AS s FROM co_facts WHERE owner_user_id = $1 AND object_key = 'L|decision:10'`, [A])).rows[0]?.s === "not_interested", { collapsedOffer, s2 });
    check("an answer with no row anywhere is logged as a decision, never a silent no-op", s3 === "unmatched" && decisions.some((p) => p[1] === "ledger.offer_state_unmatched" && p[2] === A));

    await wordsAge(q);

    // Deleting the account (routes/users.ts DELETE FROM users) deletes every ledger row of theirs, and only theirs.
    const before = await count(A);
    await q(`DELETE FROM users WHERE id = $1`, [A]);
    check("account deletion removes all of the member's ledger rows (cascade), and nobody else's", before > 0 && (await count(A)) === 0 && (await count(B)) === 1, { before });
    await c.end();
  } catch (err: any) {
    check("the throwaway database ran", false, err?.message ?? err);
  } finally {
    await cluster.stop();
  }
  const leftBehind = shmSegmentsOf(cluster.pid);
  if (leftBehind !== null) check("stopping the cluster leaks no shared memory (SIGINT, not SIGKILL)", leftBehind === 0, { leftBehind, pid: cluster.pid });
}

console.log(`ledger sql: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
