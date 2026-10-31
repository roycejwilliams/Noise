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
//   - no EXCEPTION block in the trigger: each one would open a subtransaction per statement (a bulk job in one transaction would
//     overflow the subtransaction cache and slow every session). The one statement inside has nothing to fail on: no key, no foreign
//     key, no check, and the user column is filtered to non-null.
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

export const SNAPSHOT_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS member_snapshots (
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS member_snapshot_dirty (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    source TEXT NOT NULL,
    dirty_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS member_snapshot_dirty_user ON member_snapshot_dirty (user_id, id)`,
];

const fn = (t: string) => `member_snapshot_mark_${t}`;
// The rows a statement touched, as user ids (the transition table's columns, non-null).
const ids = (t: SourceTable, rel: string) => t.cols.map((c) => `SELECT ${c} AS uid FROM ${rel}${t.where ? ` WHERE ${t.where}` : ""}`).join(" UNION ");

// Pure: the trigger function and its three triggers for one source table.
export function triggerSql(t: SourceTable): string[] {
  const mark = (rels: string[]) =>
    `INSERT INTO member_snapshot_dirty (user_id, source) SELECT DISTINCT uid, '${t.table}' FROM (${rels.map((r) => ids(t, r)).join(" UNION ")}) x WHERE uid IS NOT NULL;`;
  return [
    `CREATE OR REPLACE FUNCTION ${fn(t.table)}() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP = 'INSERT' THEN ${mark(["snap_new"])}
  ELSIF TG_OP = 'UPDATE' THEN ${mark(["snap_new", "snap_old"])}
  ELSE ${mark(["snap_old"])}
  END IF;
  RETURN NULL;
END $f$`,
    `CREATE OR REPLACE TRIGGER ${t.table}_snapshot_ins AFTER INSERT ON ${t.table} REFERENCING NEW TABLE AS snap_new FOR EACH STATEMENT EXECUTE FUNCTION ${fn(t.table)}()`,
    `CREATE OR REPLACE TRIGGER ${t.table}_snapshot_upd AFTER UPDATE ON ${t.table} REFERENCING OLD TABLE AS snap_old NEW TABLE AS snap_new FOR EACH STATEMENT EXECUTE FUNCTION ${fn(t.table)}()`,
    `CREATE OR REPLACE TRIGGER ${t.table}_snapshot_del AFTER DELETE ON ${t.table} REFERENCING OLD TABLE AS snap_old FOR EACH STATEMENT EXECUTE FUNCTION ${fn(t.table)}()`,
  ];
}

type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

// The migration: additive (two new tables, a function and three triggers per source table that exists). Each table's triggers are
// their own step: one failing is logged and never blocks the rest or startup (the file's convention).
export async function snapshotMigrations(q: Q): Promise<{ tables: boolean; triggers: string[]; missing: string[]; failed: string[] }> {
  const out = { tables: false, triggers: [] as string[], missing: [] as string[], failed: [] as string[] };
  try {
    for (const s of SNAPSHOT_TABLES_SQL) await q.query(s);
    out.tables = true;
  } catch (err: any) {
    console.error("member_snapshots init failed:", err?.message ?? err);
    return out;
  }
  for (const t of SNAPSHOT_SOURCES) {
    try {
      const exists = (await q.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t.table}`])).rows[0]?.ok === true;
      if (!exists) {
        out.missing.push(t.table);
        continue;
      }
      for (const s of triggerSql(t)) await q.query(s);
      out.triggers.push(t.table);
    } catch (err: any) {
      out.failed.push(t.table);
      console.error(`member snapshot trigger on ${t.table} failed:`, err?.message ?? err);
    }
  }
  return out;
}
