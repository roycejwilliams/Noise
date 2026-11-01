// The member snapshot against a real Postgres (services/memberSnapshot.ts, services/memberSnapshotSchema.ts; snapshot design step 2,
// shadow). A throwaway cluster (evals/snapshot/cluster.ts); the source tables are made from db/migrations.ts' own DDL.
//   - every source table's trigger marks the member stale on INSERT, UPDATE and DELETE, inside the writer's transaction (a rolled-back
//     write leaves no mark); a transcript line (text_exchange) doesn't; a bulk statement leaves one mark per member it touched
//   - rebuild-if-dirty: a fresh snapshot is served as stored; a write, a removal or 24h makes the next read rebuild version N+1
//   - the lock: a read during another build waits for it and serves what it stored; past the wait it builds from the database
//     unstored; a write that commits while a build reads keeps its mark
//   - the fence: a linked member's name is taken out of every line; another member's user id planted in a ledger line blocks the build
//     (nothing served, no older version, logged with counts only); a names read that fails fails the build
//   - forgetting: a removal marks the snapshot stale and the next build no longer says it; a deleted source row is gone from it
//   - size: 600 ledger rows collapse the oldest into dated lines, within the ledger budget, nothing lost from the count
//   - deleting the account deletes the snapshot and never fails on the marks; the upkeep rebuilds stale stored snapshots and prunes
//   - the trigger's overhead per statement, measured (printed)
//   TZ=UTC node evals/runLayer1.mjs evals/snapshot/snapshotSql.ts
import fs from "node:fs";
import { startCluster, shmSegmentsOf, tableDdl, tableAlters } from "./cluster.js";
const { default: pool } = await import("../../src/db/db.js");
const S = await import("../../src/services/memberSnapshot.js");
const Schema = await import("../../src/services/memberSnapshotSchema.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, JSON.stringify(detail ?? "").slice(0, 600)); } };
const mig = fs.readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");

// The migration step is wired into runMigrations, after every source table it triggers on.
check("the migration runs the snapshot's tables and triggers, at the end of runMigrations", /snapshotMigrations\(pool\)[\s\S]{0,600}await concurrencyMigrations\(\);\n\}/.test(mig));

const started = await startCluster();
if ("skip" in started) {
  console.log(`SKIP snapshotSql: ${started.skip}; the database part didn't run`);
} else if ("fail" in started) {
  check(`the throwaway database starts where postgres is installed: ${started.fail}`, false);
} else {
  const cluster = started.ok;
  const { default: pg } = await import("pg");
  const db = new pg.Pool({ host: cluster.sock, user: "postgres", database: "postgres", max: 12 });
  // An idle connection the cluster's own shutdown ends is not a test failure.
  db.on("error", () => {});
  // Every read the builder makes through the shared pool goes to the throwaway database.
  (pool as any).query = (sql: string, p?: unknown[]) => db.query(sql, p as any[]);
  (pool as any).connect = () => db.connect();
  const q = (sql: string, p?: unknown[]) => db.query(sql, p as any[]);
  try {
    const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b2", C = "00000000-0000-4000-8000-0000000000c3";
    await q(`CREATE TABLE users (id UUID PRIMARY KEY, first_name TEXT, last_name TEXT, mo_approver BOOLEAN NOT NULL DEFAULT false)`);
    await q(`CREATE TABLE co_profiles (user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, city TEXT, goals JSONB, intent JSONB, life_chapters JSONB, long_term_direction TEXT,
      activity_preferences JSONB, blockers JSONB, availability_pattern TEXT, texting_style JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE co_memories (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE, memory_type TEXT, content TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE harness_decisions (id BIGSERIAL PRIMARY KEY, layer SMALLINT, decision TEXT, user_id UUID, outcome TEXT, action TEXT, proposal JSONB, checks JSONB, confidence TEXT, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const made: string[] = [];
    for (const t of Schema.SNAPSHOT_SOURCES.map((s) => s.table).filter((t) => !["co_profiles", "co_memories"].includes(t))) {
      const ddl = tableDdl(mig, t);
      if (!ddl) continue;
      await q(ddl).then(() => made.push(t)).catch((e: any) => console.log(`(ddl ${t}: ${e.message})`));
      for (const a of tableAlters(mig, t)) await q(a).catch(() => {});
    }
    for (const a of tableAlters(mig, "co_profiles")) await q(a).catch(() => {});
    check("every source table is made from the migrations' own DDL", made.length === Schema.SNAPSHOT_SOURCES.length - 2, { made });
    const m = await Schema.snapshotMigrations(db);
    check("the migration makes both tables and a trigger on every source table", m.tables && m.triggers.length === Schema.SNAPSHOT_SOURCES.length && !m.missing.length && !m.failed.length, m);
    check("the first boot ran the DDL (2 tables, the index, and a function and 3 triggers per source table)", m.ran.length === 3 + Schema.SNAPSHOT_SOURCES.length * 4, m.ran.length);
    const again = await Schema.snapshotMigrations(db);
    check("a second boot runs no DDL at all (everything is already in place, so no table lock is taken)", again.tables && again.triggers.length === Schema.SNAPSHOT_SOURCES.length && again.ran.length === 0 && !again.failed.length && !again.deferred.length, again);
    // A trigger missing while a writer holds its table: the boot waits at most the lock timeout, leaves it for the next boot, goes on.
    await q(`DROP TRIGGER co_goals_snapshot_upd ON co_goals`);
    const lockHolder = await db.connect();
    await lockHolder.query("BEGIN");
    await lockHolder.query("LOCK TABLE co_goals IN ROW EXCLUSIVE MODE");
    const t0 = Date.now();
    const blockedBoot = await Schema.snapshotMigrations(db);
    const bootMs = Date.now() - t0;
    await lockHolder.query("ROLLBACK");
    lockHolder.release();
    check("a DDL statement stuck behind a writer's lock gives up after the lock timeout; the boot goes on and logs it", blockedBoot.tables && blockedBoot.deferred.includes("co_goals_snapshot_upd") && !blockedBoot.failed.length && bootMs < Schema.DDL_LOCK_TIMEOUT_MS + 3000, { deferred: blockedBoot.deferred, bootMs });
    const nextBoot = await Schema.snapshotMigrations(db);
    check("the next boot puts it back, and only it", nextBoot.ran.join() === "co_goals_snapshot_upd" && nextBoot.triggers.length === Schema.SNAPSHOT_SOURCES.length, nextBoot.ran);
    await q(`INSERT INTO users (id, first_name, last_name) VALUES ($1, 'Avery', 'Stone'), ($2, 'Marisol', 'Vega'), ($3, 'Theo', 'Lind')`, [A, B, C]);

    // ---- every source write marks the member stale, in the writer's own transaction
    const marks = async (who = A, source?: string) => Number((await q(`SELECT count(*)::int AS n FROM member_snapshot_dirty WHERE user_id = $1 ${source ? "AND source = $2" : ""}`, source ? [who, source] : [who])).rows[0].n);
    const clear = () => q(`DELETE FROM member_snapshot_dirty`);
    const INSERTS: Record<string, string> = {
      co_facts: `INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, visibility, source) VALUES ('${A}', 'co', 'texted', 'hi', 'k-${Math.random()}', 'owner', 't')`,
      co_profiles: `INSERT INTO co_profiles (user_id, city) VALUES ('${A}', 'Oakland') ON CONFLICT (user_id) DO NOTHING`,
      profile_corrections: `INSERT INTO profile_corrections (user_id, field, old_value, new_value, quote) VALUES ('${A}', 'city', 'Berkeley', 'Oakland', 'I moved')`,
      member_claims: `INSERT INTO member_claims (user_id, text, provenance, kind, said_on, confirmed_on) VALUES ('${A}', 'Runs on Sundays', 'user_said', 'routine', CURRENT_DATE, CURRENT_DATE)`,
      member_threads: `INSERT INTO member_threads (user_id, text, opened_quote, opened_at) VALUES ('${A}', 'the move', 'we move in May', NOW())`,
      co_goals: `INSERT INTO co_goals (user_id, title, their_words) VALUES ('${A}', 'a cofounder', 'I need a cofounder')`,
      goal_states: `INSERT INTO goal_states (user_id, goal_hash, goal_text, state, source) VALUES ('${A}', 'h-${Math.random()}', 'a cofounder', 'active', 'member')`,
      co_tasks: `INSERT INTO co_tasks (user_id, goal, their_words) VALUES ('${A}', 'find a venue', 'find me a venue')`,
      open_loops: `INSERT INTO open_loops (user_id, source, source_ref, title) VALUES ('${A}', 'note', 'r-${Math.random()}', 'the venue')`,
      scheduled_calls: `INSERT INTO scheduled_calls (user_id, requested_text, timezone, scheduled_for) VALUES ('${A}', 'call me Friday', 'America/Los_Angeles', NOW() + INTERVAL '2 days')`,
      document_deliveries: `INSERT INTO document_deliveries (user_id, doc_key, title, content, content_hash, channel, source) VALUES ('${A}', 'plan', 'The plan', '{}', 'x', 'pdf_text', 'test')`,
      ask_checkins: `INSERT INTO ask_checkins (user_id, ask_id, ask_text) VALUES ('${A}', 'a-${Math.random()}', 'jazz nights')`,
      emotion_signals: `INSERT INTO emotion_signals (user_id, source, emotion, intensity, valence) VALUES ('${A}', 'text', 'nervous', 'medium', 'negative')`,
      suggestion_outcomes: `INSERT INTO suggestion_outcomes (user_id, kind, item_key, item_name, result) VALUES ('${A}', 'event', 'k', 'Jazz', 'went')`,
      co_memories: `INSERT INTO co_memories (user_id, memory_type, content) VALUES ('${A}', 'co_lesson', 'keep it short')`,
      co_pairs: `INSERT INTO co_pairs (event_id, a_id, b_id) VALUES ('ev-${Math.random()}', '${A}', '${B}')`,
      event_guest_match_nudges: `INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score) VALUES ('ev-${Math.random()}', '${A}', '${B}', 80)`,
      event_match_offers: `INSERT INTO event_match_offers (event_id, person_id, candidate_key, kind, status) VALUES ('ev-${Math.random()}', '${A}', 'c', 'nudge', 'open')`,
      event_guest_match_opt_ins: `INSERT INTO event_guest_match_opt_ins (event_id, person_id, candidate_id, status) VALUES ('ev-${Math.random()}', '${A}', '${B}', 'interested')`,
      network_introductions: `INSERT INTO network_introductions (person_a_id, person_b_id, match_reason) VALUES ('${A}', '${B}', 'both building')`,
    };
    const userCol = (t: string) => Schema.SNAPSHOT_SOURCES.find((s) => s.table === t)!.cols[0];
    const missed: string[] = [];
    for (const src of Schema.SNAPSHOT_SOURCES) {
      const t = src.table;
      for (const op of ["insert", "update", "delete"] as const) {
        await clear();
        const sql = op === "insert" ? INSERTS[t] : op === "update" ? `UPDATE ${t} SET ${userCol(t)} = ${userCol(t)} WHERE ${userCol(t)} = '${A}'` : `DELETE FROM ${t} WHERE ${userCol(t)} = '${A}'`;
        if (!sql) { missed.push(`${t}:no insert`); continue; }
        if (op === "delete") await q(INSERTS[t]).catch(() => {});
        if (op === "delete") await clear();
        await q(sql).catch((e: any) => missed.push(`${t}:${op}:${e.message}`));
        if ((await marks(A, t)) < 1) missed.push(`${t}:${op}`);
        // Both sides of a link are marked (their names enter each other's fence).
        if (src.cols.length > 1 && op === "insert" && (await marks(B, t)) < 1) missed.push(`${t}:${op}:other side`);
      }
      await q(INSERTS[t]).catch(() => {});
    }
    check("every source table: an insert, an update and a delete each mark the member stale (both sides of a link)", missed.length === 0, missed);
    await clear();
    await q(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', 'User said: hi')`, [A]);
    check("a transcript line (text_exchange) leaves no mark: the snapshot never holds the transcript", (await marks(A)) === 0);
    const c1 = await db.connect();
    await c1.query("BEGIN");
    await c1.query(INSERTS.member_claims);
    check("inside the writer's transaction the mark isn't visible to anyone else yet", (await marks(A)) === 0);
    await c1.query("ROLLBACK");
    c1.release();
    check("a write that rolls back leaves no mark", (await marks(A)) === 0);
    await q(`INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, visibility, source) SELECT $1, 'co', 'searched', 'x' || g, 'bulk-' || g, 'owner', 't' FROM generate_series(1, 500) g`, [A]);
    check("a 500-row statement leaves one mark for the member, not 500", (await marks(A)) === 1, await marks(A));

    // ---- rebuild-if-dirty
    await q(`DELETE FROM co_facts`);
    await clear();
    const decisions = async (d: string, who = A) => (await q(`SELECT proposal, reason FROM harness_decisions WHERE decision = $1 AND user_id = $2 ORDER BY id`, [d, who])).rows;
    let loads = 0;
    const counting = { load: async (u: string, now: Date) => { loads++; return S.loadSources(u, now); } };
    const r1 = await S.readSnapshot(A, { db, deps: counting });
    check("no snapshot yet: the read builds and stores version 1", r1.state === "rebuilt" && r1.snapshot?.version === 1 && loads === 1, { state: r1.state, v: r1.snapshot?.version, loads });
    check("the stored body has the header and the six sections", !!r1.snapshot && /^# Cue's snapshot of Avery · v1 · zone /.test(r1.snapshot.body) && S.SECTION_IDS.every((id) => r1.snapshot!.body.includes(`## ${S.SECTION_TITLES[id]}`)), r1.snapshot?.body.slice(0, 300));
    const r2 = await S.readSnapshot(A, { db, deps: counting });
    check("nothing changed: the next read serves what's stored, without building", r2.state === "fresh" && r2.snapshot?.version === 1 && loads === 1, { state: r2.state, loads });
    await q(`INSERT INTO member_threads (user_id, text, opened_quote, opened_at) VALUES ($1, 'Training for the Oakland half', 'doing the half in March', NOW())`, [A]);
    const r3 = await S.readSnapshot(A, { db, deps: counting });
    check("a write since: the read rebuilds first, version 2, and it has the new line", r3.state === "rebuilt" && r3.snapshot?.version === 2 && loads === 2 && /Training for the Oakland half/.test(r3.snapshot!.body), { state: r3.state, v: r3.snapshot?.version });
    check("the build took the marks it saw: none left", (await marks(A)) === 0);
    const later = () => new Date(Date.now() + 25 * 3_600_000);
    const r4 = await S.readSnapshot(A, { db, deps: counting, now: later });
    check("a snapshot older than 24h is rebuilt on read (the safety rebuild)", r4.state === "rebuilt" && r4.snapshot?.version === 3, { state: r4.state, v: r4.snapshot?.version });
    const learn = await S.rebuildSnapshot(A, "learn", { db });
    check("LEARN stores version N+1 even when nothing is stale", learn === "stored" && (await q(`SELECT version FROM member_snapshots WHERE user_id = $1`, [A])).rows[0].version === 4, learn);
    const builds = await decisions("snapshot.build");
    check("each stored build is logged with counts only (no line of the body)", builds.length === 4 && builds.every((b) => typeof b.proposal?.ms === "number" && b.proposal?.tokens?.total > 0 && !JSON.stringify(b.proposal).includes("Oakland half")), builds.map((b) => b.proposal));

    // ---- the lock
    const slow = (ms: number) => ({ load: async (u: string, now: Date) => { loads++; await new Promise((r) => setTimeout(r, ms)); return S.loadSources(u, now); } });
    await q(INSERTS.member_claims);
    loads = 0;
    const holder = S.storeBuild(A, { reason: "learn", force: true, waitMs: 2000, db, deps: slow(700) });
    await new Promise((r) => setTimeout(r, 150));
    const waiting = await S.readSnapshot(A, { db, deps: slow(0) });
    const held = await holder;
    check("a read during another build waits for it and serves what it stored (one build, not two)", held.state === "stored" && waiting.state === "fresh" && waiting.snapshot?.version === held.snapshot?.version && waiting.waitedMs >= 300 && loads === 1, { held: held.state, waiting: waiting.state, waited: waiting.waitedMs, loads });
    await q(INSERTS.member_claims);
    loads = 0;
    const holder2 = S.storeBuild(A, { reason: "learn", force: true, waitMs: 2000, db, deps: slow(1500) });
    await new Promise((r) => setTimeout(r, 150));
    const vBefore = (await q(`SELECT version FROM member_snapshots WHERE user_id = $1`, [A])).rows[0].version;
    const impatient = await S.readSnapshot(A, { db, waitMs: 300, deps: slow(0) });
    const vDuring = (await q(`SELECT version FROM member_snapshots WHERE user_id = $1`, [A])).rows[0].version;
    await holder2;
    check("past the wait, the read builds from the database itself and stores nothing", impatient.state === "built_unstored" && !!impatient.snapshot?.body && vDuring === vBefore && impatient.waitedMs >= 300 && impatient.waitedMs < 1200, { state: impatient.state, waited: impatient.waitedMs, vBefore, vDuring });
    // A write that commits while a build reads keeps its mark: the next read rebuilds.
    const writeDuring = { load: async (u: string, now: Date) => { const src = await S.loadSources(u, now); await q(INSERTS.member_claims); return src; } };
    const mid = await S.storeBuild(A, { reason: "learn", force: true, db, deps: writeDuring });
    check("a write that commits during a build keeps its mark (stale right after the store)", mid.state === "stored" && (await marks(A)) === 1, { state: mid.state, marks: await marks(A) });
    const after = await S.readSnapshot(A, { db });
    check("so the next read rebuilds", after.state === "rebuilt");
    const failing = { load: async () => { throw new Error("boom"); } };
    await q(INSERTS.member_claims);
    const bad = await S.readSnapshot(A, { db, deps: failing });
    check("a build that fails serves nothing and leaves the marks where they were", bad.state === "failed" && !bad.snapshot && (await marks(A)) >= 1, { state: bad.state });
    check("no advisory lock is left held", Number((await q(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`)).rows[0].n) === 0);

    // ---- the fence
    // Marisol (B) is linked to Avery: the intro email went to both (memberSafeMemories MEMBER_NAMES_SQL).
    await q(`UPDATE co_pairs SET intro_sent_at = NOW() WHERE a_id = $1 AND b_id = $2`, [A, B]);
    await q(`INSERT INTO member_claims (user_id, text, provenance, kind, quote, said_on, confirmed_on) VALUES ($1, 'Had coffee with Marisol Vega about her gallery', 'user_said', 'event', 'coffee with Marisol Vega was great', CURRENT_DATE, CURRENT_DATE)`, [A]);
    await q(`INSERT INTO member_threads (user_id, text, opened_quote, opened_at) VALUES ($1, 'Vega is building grid storage and left Tesla', 'vega left tesla to build grid storage', NOW())`, [A]);
    await q(`INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, visibility, source, meta) VALUES ($1, 'co', 'texted', 'I introduced you to Marisol, she runs a gallery', 'L|m1', 'owner', 'outbound:h1', '{"ledger": 1, "kind": "text"}')`, [A]);
    const f1 = await S.readSnapshot(A, { db });
    const f1body = f1.snapshot?.body ?? "";
    check("a full name is out whole: neither the first nor the last name is left (never \"another member Vega\")", f1.state === "rebuilt" && !!f1.snapshot && !/marisol|vega/i.test(f1body), f1body.split("\n").filter((l) => /marisol|vega|another member/i.test(l)));
    check("a line with another member's details becomes a details-free line (safeMemory's policy), not the same sentence without the name", !/grid storage|tesla|gallery/i.test(f1body.split("## 5.")[0]) && /Another member came up here; their details aren't kept\./.test(f1body), f1body.split("\n").filter((l) => /another member/i.test(l)));
    check("Cue's own intro stays as history, nameless", /Cue introduced them to another member\./.test(f1body) && !/runs a gallery/.test(f1body));
    await q(`INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, visibility, source, meta) VALUES ($1, 'co', 'did', $2, 'L|m2', 'owner', 'tool.x', '{"ledger": 1, "kind": "tool"}')`, [A, `matched with ${B}`]);
    const f2 = await S.readSnapshot(A, { db });
    const stored = (await q(`SELECT version, body, blocked, sections FROM member_snapshots WHERE user_id = $1`, [A])).rows[0];
    check("another member's user id planted in a ledger line blocks the build: nothing served, no older version", f2.state === "blocked" && !f2.snapshot && stored.blocked === "user_id" && stored.body === "" && JSON.stringify(stored.sections) === "[]", { state: f2.state, blocked: stored.blocked });
    const fb = await decisions("snapshot.fence_block");
    check("the fence block is logged with counts only", fb.length === 1 && fb[0].proposal?.kind === "user_id" && fb[0].proposal?.hits === 1 && !JSON.stringify(fb).includes(B), fb);
    const f3 = await S.readSnapshot(A, { db });
    check("blocked and nothing changed: still nothing served (no rebuild loop)", f3.state === "blocked" && !f3.snapshot);
    await q(`DELETE FROM co_facts WHERE object_key = 'L|m2'`);
    const f4 = await S.readSnapshot(A, { db });
    check("the planted line removed: the next read builds clean again", f4.state === "rebuilt" && !!f4.snapshot && !f4.snapshot.body.includes(B));
    // Their own user id is theirs.
    await q(INSERTS.member_claims);
    await q(`ALTER TABLE co_pairs RENAME TO co_pairs_away`);
    const f5 = await S.readSnapshot(A, { db });
    await q(`ALTER TABLE co_pairs_away RENAME TO co_pairs`);
    check("the linked names can't be read: the build fails closed (nothing served)", f5.state === "failed" && !f5.snapshot, f5.state);

    // ---- forgetting
    await q(`INSERT INTO member_claims (user_id, text, provenance, kind, said_on, confirmed_on) VALUES ($1, 'Learning salsa for my birthday', 'user_said', 'plan', CURRENT_DATE, CURRENT_DATE)`, [A]);
    await q(`INSERT INTO member_threads (user_id, text, opened_quote, opened_at) VALUES ($1, 'Learning salsa for my birthday', 'learning salsa for my birthday', NOW())`, [A]);
    const g1 = await S.readSnapshot(A, { db });
    check("before the removal, the snapshot says it (claim and thread)", (g1.snapshot?.body.match(/salsa/gi) ?? []).length >= 2, g1.state);
    await clear();
    const claimId = (await q(`SELECT id FROM member_claims WHERE user_id = $1 AND text LIKE 'Learning salsa%'`, [A])).rows[0].id;
    await q(`INSERT INTO profile_corrections (user_id, field, old_value, new_value, quote, item_ref, removed) VALUES ($1, 'claim', 'Learning salsa for my birthday', NULL, 'please forget the salsa thing', $2, true)`, [A, `claim:${claimId}`]);
    check("the removal marks the snapshot stale in the same transaction (the trigger)", (await marks(A, "profile_corrections")) === 1);
    const g2 = await S.readSnapshot(A, { db });
    check("the next build no longer says it anywhere (claim, thread)", g2.state === "rebuilt" && !!g2.snapshot && !/salsa/i.test(g2.snapshot.body), g2.snapshot?.body.split("\n").filter((l) => /salsa/i.test(l)));
    const doneBuilds = await decisions("snapshot.build");
    check("the build counts what the guards took out", (doneBuilds[doneBuilds.length - 1]?.proposal?.forgotten ?? 0) >= 1, doneBuilds[doneBuilds.length - 1]?.proposal);
    await q(`INSERT INTO member_claims (user_id, text, provenance, kind, said_on, confirmed_on) VALUES ($1, 'Volunteers at the food bank', 'user_said', 'routine', CURRENT_DATE, CURRENT_DATE)`, [A]);
    const g3 = await S.readSnapshot(A, { db });
    await q(`DELETE FROM member_claims WHERE user_id = $1 AND text = 'Volunteers at the food bank'`, [A]);
    const g4 = await S.readSnapshot(A, { db });
    check("a deleted source row marks it stale and is gone from the next build", /food bank/.test(g3.snapshot?.body ?? "") && g4.state === "rebuilt" && !/food bank/.test(g4.snapshot?.body ?? ""), { g3: g3.state, g4: g4.state });

    // ---- size
    await q(`INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, visibility, source, happened_at, meta)
      SELECT $1, 'co', CASE WHEN g % 3 = 0 THEN 'sent' ELSE 'texted' END, 'Here is the thing I found for you about the jazz trio on Friday night, number ' || g, 'L|bulk' || g, 'owner', 'outbound:b' || g,
        NOW() - (g || ' hours')::interval, '{"ledger": 1, "kind": "text"}' FROM generate_series(1, 600) g`, [A]);
    const z1 = await S.readSnapshot(A, { db });
    const zs = (await q(`SELECT tokens, compactions, sections FROM member_snapshots WHERE user_id = $1`, [A])).rows[0];
    const ledgerSec = zs.sections.find((x: any) => x.id === "ledger");
    const collapsedN = ledgerSec.collapsed.reduce((n: number, c: any) => n + c.count, 0);
    check("600 ledger rows: the oldest collapse into dated lines, the section within its 12k budget", z1.state === "rebuilt" && zs.tokens.ledger <= S.SECTION_BUDGETS.ledger && collapsedN > 0 && /\[Earlier \d{4}-\d{2}-\d{2}/.test(z1.snapshot!.body), { tokens: zs.tokens, collapsedN });
    check("nothing lost: kept + collapsed = every ledger row, and the collapse keeps each source id", ledgerSec.entries.length + collapsedN === 600 + 1 && ledgerSec.collapsed.flatMap((c: any) => c.ids).every((id: string) => /^co_facts:\d+$/.test(id)), { kept: ledgerSec.entries.length, collapsedN });
    const comp = await decisions("snapshot.compacted");
    check("the collapse is logged: section, count, id range, tokens before and after", comp.length >= 1 && comp[comp.length - 1].proposal.sections.some((c: any) => c.section === "ledger" && c.count === collapsedN && c.tokensBefore > c.tokensAfter && c.idRange?.length === 2), comp[comp.length - 1]?.proposal);

    // ---- upkeep, backoff, marks
    await q(`UPDATE member_snapshots SET built_at = NOW() - INTERVAL '25 hours' WHERE user_id = $1`, [A]);
    await q(`INSERT INTO member_snapshot_dirty (user_id, source, dirty_at) VALUES ($1, 'test', NOW() - INTERVAL '2 hours')`, [C]);
    const up = await S.snapshotUpkeep({ db });
    check("upkeep rebuilds a stored snapshot past 24h, and prunes marks of members with none stored after an hour", up.rebuilt === 1 && up.pruned === 1 && (await marks(C)) === 0, up);
    // C gets a stored snapshot, then its builds start failing.
    await S.rebuildSnapshot(C, "learn", { db });
    await q(`INSERT INTO co_goals (user_id, title, their_words) VALUES ($1, 'x', 'y')`, [C]);
    const fail1 = await S.storeBuild(C, { reason: "upkeep", db, deps: failing });
    const st1 = (await q(`SELECT fail_count, EXTRACT(EPOCH FROM next_attempt_at - NOW())::int AS wait FROM member_snapshots WHERE user_id = $1`, [C])).rows[0];
    const fail2 = await S.storeBuild(C, { reason: "upkeep", db, deps: failing });
    const st2 = (await q(`SELECT fail_count, EXTRACT(EPOCH FROM next_attempt_at - NOW())::int AS wait FROM member_snapshots WHERE user_id = $1`, [C])).rows[0];
    check("a failing member backs off: 15 minutes, then 30 (each failure doubles it)", fail1.state === "failed" && fail2.state === "failed" && st1.fail_count === 1 && Math.abs(st1.wait - 900) < 30 && st2.fail_count === 2 && Math.abs(st2.wait - 1800) < 30, { st1, st2 });
    check("each failure is logged with its count", (await decisions("snapshot.build_failed", C)).map((r) => r.proposal.failCount).join() === "1,2");
    const up2 = await S.snapshotUpkeep({ db, deps: failing });
    check("the upkeep skips a member until their next attempt (no slot taken)", up2.rebuilt === 0 && up2.skipped === 0 && (await decisions("snapshot.build_failed", C)).length === 2, up2);
    await q(`UPDATE member_snapshot_dirty SET dirty_at = NOW() - INTERVAL '49 hours' WHERE user_id = $1`, [C]);
    const up3 = await S.snapshotUpkeep({ db });
    check("every mark older than 48h is dropped, whoever it's for (a snapshot that old is past 24h anyway)", up3.pruned >= 1 && (await marks(C)) === 0, up3);
    await q(`UPDATE member_snapshots SET next_attempt_at = NULL WHERE user_id = $1`, [C]);
    await S.rebuildSnapshot(C, "learn", { db });
    check("a stored build resets the backoff", (await q(`SELECT fail_count, next_attempt_at FROM member_snapshots WHERE user_id = $1`, [C])).rows[0].fail_count === 0);
    // A removal while a member is backing off: the next upkeep pass tries them again, not up to 24h later.
    await q(`INSERT INTO co_goals (user_id, title, their_words) VALUES ($1, 'x', 'y')`, [C]);
    await S.storeBuild(C, { reason: "upkeep", db, deps: failing });
    await S.storeBuild(C, { reason: "upkeep", db, deps: failing });
    const beforeRemoval = await S.snapshotUpkeep({ db });
    check("(backing off before the removal: the pass leaves them alone)", beforeRemoval.retried === 0 && beforeRemoval.rebuilt === 0, beforeRemoval);
    await q(`INSERT INTO profile_corrections (user_id, field, old_value, new_value, quote, item_ref, removed) VALUES ($1, 'claim', 'Learning salsa', NULL, 'forget the salsa thing', 'claim:x', true)`, [C]);
    const retry = await S.snapshotUpkeep({ db });
    const cRow = (await q(`SELECT fail_count, next_attempt_at FROM member_snapshots WHERE user_id = $1`, [C])).rows[0];
    check("a removal or correction ends the member's backoff: the next pass rebuilds them", retry.retried === 1 && retry.rebuilt === 1 && cRow.fail_count === 0 && cRow.next_attempt_at === null && (await marks(C)) === 0, { retry, cRow });

    // ---- the trigger never fails the member's write
    const notices: string[] = [];
    const w = await db.connect();
    w.on("notice", (n: any) => notices.push(String(n.message)));
    await q(`ALTER TABLE member_snapshot_dirty RENAME TO member_snapshot_dirty_away`);
    let wrote = false;
    try {
      await w.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'co_lesson', 'keep it short')`, [C]);
      wrote = Number((await w.query(`SELECT count(*)::int AS n FROM co_memories WHERE user_id = $1 AND content = 'keep it short'`, [C])).rows[0].n) === 1;
    } catch (e: any) {
      notices.push(`ERROR ${e.message}`);
    }
    await q(`ALTER TABLE member_snapshot_dirty_away RENAME TO member_snapshot_dirty`);
    w.release();
    check("with the marks table gone, the member's write still lands, with only a warning", wrote && notices.some((n) => /member snapshot mark on co_memories failed; the write goes on/.test(n)) && !notices.some((n) => n.startsWith("ERROR")), notices);

    await q(`DELETE FROM users WHERE id = $1`, [A]);
    check("deleting the account deletes the snapshot (cascade) and never fails on the marks the cascade leaves", Number((await q(`SELECT count(*)::int AS n FROM member_snapshots WHERE user_id = $1`, [A])).rows[0].n) === 0);

    // ---- the trigger's overhead (measured, printed): single-row statements and one bulk statement, with and without the trigger.
    await q(`CREATE TABLE co_facts_bare (LIKE co_facts INCLUDING DEFAULTS)`);
    const N = 1500;
    const timeIt = async (table: string) => {
      const c = await db.connect();
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) await c.query(`INSERT INTO ${table} (owner_user_id, subject, relation, object_label, object_key, visibility, source) VALUES ($1, 'co', 'texted', 'hello there', $2, 'owner', 't')`, [B, `${table}-${i}`]);
      const single = Number(process.hrtime.bigint() - t0) / 1e3 / N;
      const t1 = process.hrtime.bigint();
      await c.query(`INSERT INTO ${table} (owner_user_id, subject, relation, object_label, object_key, visibility, source) SELECT $1, 'co', 'texted', 'x', '${table}-bulk-' || g, 'owner', 't' FROM generate_series(1, 20000) g`, [B]);
      const bulk = Number(process.hrtime.bigint() - t1) / 1e3;
      const t2 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) await c.query(`UPDATE ${table} SET object_label = 'hi' WHERE object_key = $1`, [`${table}-${i}`]);
      const upd = Number(process.hrtime.bigint() - t2) / 1e3 / N;
      c.release();
      return { single, bulk, upd };
    };
    // Twice each, alternating, the second pair kept (the first warms the cache).
    await timeIt("co_facts_bare"); await timeIt("co_facts");
    await q(`DELETE FROM co_facts_bare`); await q(`DELETE FROM co_facts WHERE owner_user_id = $1`, [B]);
    const bare = await timeIt("co_facts_bare");
    const trig = await timeIt("co_facts");
    console.log(`TRIGGER OVERHEAD (local postgres, co_facts): single-row insert ${bare.single.toFixed(0)}us -> ${trig.single.toFixed(0)}us (+${(trig.single - bare.single).toFixed(0)}us); single-row update ${bare.upd.toFixed(0)}us -> ${trig.upd.toFixed(0)}us (+${(trig.upd - bare.upd).toFixed(0)}us); 20,000-row insert ${(bare.bulk / 1000).toFixed(1)}ms -> ${(trig.bulk / 1000).toFixed(1)}ms`);
    check("the trigger adds well under a millisecond to a single-row write", trig.single - bare.single < 1000 && trig.upd - bare.upd < 1000, { bare, trig });
  } catch (err: any) {
    check("the throwaway database ran", false, err?.stack ?? err?.message ?? err);
  } finally {
    await db.end().catch(() => {});
    await cluster.stop();
  }
  const leftBehind = shmSegmentsOf(cluster.pid);
  if (leftBehind !== null) check("stopping the cluster leaks no shared memory", leftBehind === 0, { leftBehind });
}

console.log(`snapshot sql: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
