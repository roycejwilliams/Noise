// The member snapshot's tables and staleness triggers (snapshot design 2026-10-29 §2 "Build triggers", step 2: shadow).
//
// member_snapshots       one row per member: the last stored build (a cache, never a source; rebuildable at any time).
// member_snapshot_dirty  one row per write to a source table, written by the trigger INSIDE the writer's own transaction. A member's
//                        snapshot is stale while any row of theirs is here; the build that stores a new version deletes the rows it
//                        saw, in the same transaction as the store.
//
// Why the marks go to their own table instead of an UPDATE of member_snapshots.dirty_at (the design's wording): an UPDATE takes the
// snapshot row's lock in every writer's transaction. Two writers for one member would then wait on each other until the first commits,
// and two transactions that each write rows for two members in opposite order (an intro writes both sides) would deadlock, which
// fails a writer's transaction that never failed before. An INSERT into a table with no unique key and no foreign key takes no lock
// another writer waits on and can't conflict. It also can't miss a write: a mark commits or rolls back with the write it marks, and
// the build only deletes marks that were committed when it started reading (see services/memberSnapshot.ts storeBuild).
//   - no foreign key on purpose: deleting an account cascades into the source tables, whose triggers then mark a user that no longer
//     exists; a foreign key would fail that delete. Orphan marks hold an id and a time only, and the upkeep job deletes them.
//   - statement-level triggers with transition tables: one INSERT per statement (one row per member it touched), however many rows the
//     statement wrote, so a bulk write pays once.
//   - the trigger never fails the member's write: its insert runs in an EXCEPTION block that turns any error (the marks table gone,
//     a disk error) into a WARNING in the server log, and the write goes on. That write's mark is then lost, so the snapshot isn't
//     marked stale by it: the 24h safety rebuild and the upkeep still bound how long a stored copy can lag. The block costs a
//     subtransaction per statement (~0.3us measured in review); a bulk job running many statements in one transaction can overflow
//     the subtransaction cache, which is the accepted trade for never failing a write.
//   - every boot re-runs nothing that is already in place: each table, index, function and trigger is checked first (to_regclass,
//     pg_proc's body, pg_get_triggerdef) and only created or replaced when missing or different. What does run runs with a short
//     lock_timeout, so a DDL statement can't queue members' writes behind it; one that times out is logged, the rest of the trigger
//     DDL waits for the next boot, and startup goes on.
//   - teardown: drop the triggers (and their functions) BEFORE the marks table. Dropped the other way round, every write to a source
//     table logs a warning until the triggers go.
// Every source table the builder reads is listed here, so a writer added later is covered without anyone remembering to mark it.
// co_memories: every type except text_exchange (the transcript is read from the tail, never the snapshot). The matching tables are
// here because a new link adds a name the snapshot must be stripped of.

export type SourceTable = { table: string; cols: string[]; where?: string };
export const SNAPSHOT_SOURCES: SourceTable[] = [
  { table: "co_facts", cols: ["owner_user_id"] },
  { table: "co_profiles", cols: ["user_id"] },
  { table: "profile_corrections", cols: ["user_id"] },
  { table: "member_claims", cols: ["user_id"] },
  { table: "member_threads", cols: ["user_id"] },
  { table: "co_goals", cols: ["user_id"] },
  { table: "goal_states", cols: ["user_id"] },
  { table: "co_tasks", cols: ["user_id"] },
  { table: "open_loops", cols: ["user_id"] },
  { table: "scheduled_calls", cols: ["user_id"] },
  { table: "document_deliveries", cols: ["user_id"] },
  { table: "ask_checkins", cols: ["user_id"] },
  { table: "emotion_signals", cols: ["user_id"] },
  { table: "suggestion_outcomes", cols: ["user_id"] },
  { table: "co_memories", cols: ["user_id"], where: "memory_type IS DISTINCT FROM 'text_exchange'" },
  // Whose names are stripped (services/memberSafeMemories.ts MEMBER_NAMES_SQL, NETWORK_NAMES_SQL): both sides of a link.
  { table: "co_pairs", cols: ["a_id", "b_id"] },
  { table: "event_guest_match_nudges", cols: ["person_id"] },
  { table: "event_match_offers", cols: ["person_id"] },
  { table: "event_guest_match_opt_ins", cols: ["person_id"] },
  { table: "network_introductions", cols: ["person_a_id", "person_b_id"] },
];

// Each object with the name it is checked by (to_regclass).
export const SNAPSHOT_TABLES_SQL: { name: string; sql: string }[] = [
  { name: "member_snapshots", sql: `CREATE TABLE IF NOT EXISTS member_snapshots (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    built_at TIMESTAMPTZ NOT NULL,
    build_ms INTEGER,
    sections JSONB NOT NULL DEFAULT '[]',
    body TEXT NOT NULL DEFAULT '',
    tokens JSONB NOT NULL DEFAULT '{}',
    chars JSONB NOT NULL DEFAULT '{}',
    compactions JSONB NOT NULL DEFAULT '[]',
    over_budget TEXT[] NOT NULL DEFAULT '{}',
    blocked TEXT,
    pinned_version INTEGER,
    pinned_at TIMESTAMPTZ,
    fail_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` },
  { name: "member_snapshot_dirty", sql: `CREATE TABLE IF NOT EXISTS member_snapshot_dirty (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    source TEXT NOT NULL,
    dirty_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` },
  { name: "member_snapshot_dirty_user", sql: `CREATE INDEX IF NOT EXISTS member_snapshot_dirty_user ON member_snapshot_dirty (user_id, id)` },
];

const fn = (t: string) => `member_snapshot_mark_${t}`;
// The rows a statement touched, as user ids (the transition table's columns, non-null).
const ids = (t: SourceTable, rel: string) => t.cols.map((c) => `SELECT ${c} AS uid FROM ${rel}${t.where ? ` WHERE ${t.where}` : ""}`).join(" UNION ");

// Pure: the trigger function's body and its three triggers for one source table.
export function functionBody(t: SourceTable): string {
  const mark = (rels: string[]) =>
    `INSERT INTO member_snapshot_dirty (user_id, source) SELECT DISTINCT uid, '${t.table}' FROM (${rels.map((r) => ids(t, r)).join(" UNION ")}) x WHERE uid IS NOT NULL;`;
  return `
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN ${mark(["snap_new"])}
    ELSIF TG_OP = 'UPDATE' THEN ${mark(["snap_new", "snap_old"])}
    ELSE ${mark(["snap_old"])}
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'member snapshot mark on % failed; the write goes on: %', TG_TABLE_NAME, SQLERRM;
  END;
  RETURN NULL;
END `;
}
export const functionName = fn;
export function triggerDefs(t: SourceTable): { name: string; sql: string }[] {
  return [
    { name: `${t.table}_snapshot_ins`, sql: `CREATE OR REPLACE TRIGGER ${t.table}_snapshot_ins AFTER INSERT ON ${t.table} REFERENCING NEW TABLE AS snap_new FOR EACH STATEMENT EXECUTE FUNCTION ${fn(t.table)}()` },
    { name: `${t.table}_snapshot_upd`, sql: `CREATE OR REPLACE TRIGGER ${t.table}_snapshot_upd AFTER UPDATE ON ${t.table} REFERENCING OLD TABLE AS snap_old NEW TABLE AS snap_new FOR EACH STATEMENT EXECUTE FUNCTION ${fn(t.table)}()` },
    { name: `${t.table}_snapshot_del`, sql: `CREATE OR REPLACE TRIGGER ${t.table}_snapshot_del AFTER DELETE ON ${t.table} REFERENCING OLD TABLE AS snap_old FOR EACH STATEMENT EXECUTE FUNCTION ${fn(t.table)}()` },
  ];
}
// Pure: a trigger definition as compared (pg_get_triggerdef's form and ours read the same).
export const sameTriggerDef = (a: string, b: string) => {
  const n = (x: string) => x.toLowerCase().replace(/\bor replace\s+/, "").replace(/\bpublic\./g, "").replace(/\s+/g, " ").trim();
  return n(a) === n(b);
};

type Client = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }>; release: () => void };
type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }>; connect: () => Promise<Client> };
// How long a DDL statement may wait for a table's lock before it gives up for this boot.
export const DDL_LOCK_TIMEOUT_MS = 1500;
export type MigrationResult = { tables: boolean; triggers: string[]; ran: string[]; missing: string[]; failed: string[]; deferred: string[] };

// The migration: additive (two new tables, an index, a function and three triggers per source table that exists). Nothing already in
// place is touched; what runs, runs under lock_timeout (see the header). Never throws.
export async function snapshotMigrations(db: Db): Promise<MigrationResult> {
  const out: MigrationResult = { tables: false, triggers: [], ran: [], missing: [], failed: [], deferred: [] };
  let gaveUp = false;
  // One DDL statement in its own transaction with a short lock wait. false: it didn't run (logged).
  const run = async (name: string, sql: string): Promise<boolean> => {
    if (gaveUp) {
      out.deferred.push(name);
      return false;
    }
    let c: Client | null = null;
    try {
      c = await db.connect();
      await c.query("BEGIN");
      await c.query(`SET LOCAL lock_timeout = '${DDL_LOCK_TIMEOUT_MS}ms'`);
      await c.query(sql);
      await c.query("COMMIT");
      out.ran.push(name);
      return true;
    } catch (err: any) {
      await c?.query("ROLLBACK").catch(() => {});
      if (err?.code === "55P03") {
        // A table's lock didn't come free in time: the rest of the DDL waits for the next boot, and startup goes on.
        gaveUp = true;
        out.deferred.push(name);
        console.error(`member snapshot DDL ${name} waited past ${DDL_LOCK_TIMEOUT_MS}ms for a lock; it and the rest run on the next boot`);
      } else {
        out.failed.push(name);
        console.error(`member snapshot DDL ${name} failed:`, err?.message ?? err);
      }
      return false;
    } finally {
      c?.release();
    }
  };
  const one = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0] ?? null;
  try {
    let ok = true;
    for (const t of SNAPSHOT_TABLES_SQL) {
      const there = (await one(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t.name}`]))?.ok === true;
      if (!there && !(await run(t.name, t.sql))) ok = false;
    }
    out.tables = ok;
    if (!ok) return out;
    for (const t of SNAPSHOT_SOURCES) {
      if ((await one(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t.table}`]))?.ok !== true) {
        out.missing.push(t.table);
        continue;
      }
      let all = true;
      const body = functionBody(t);
      const have = (await one(`SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [fn(t.table)]))?.prosrc;
      if (have !== body && !(await run(fn(t.table), `CREATE OR REPLACE FUNCTION ${fn(t.table)}() RETURNS trigger LANGUAGE plpgsql AS $f$${body}$f$`))) all = false;
      for (const d of triggerDefs(t)) {
        if (!all) break;
        const def = (await one(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass`, [d.name, `public.${t.table}`]))?.def;
        if (!(def && sameTriggerDef(def, d.sql)) && !(await run(d.name, d.sql))) all = false;
      }
      if (all) out.triggers.push(t.table);
    }
  } catch (err: any) {
    console.error("member snapshot migration failed (non-fatal):", err?.message ?? err);
  }
  return out;
}
