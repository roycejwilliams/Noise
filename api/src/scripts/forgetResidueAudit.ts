// Forgetting residue audit, counts only (forget-delete-spec.md section 7; context-across-cue-plan.md 3b). READ ONLY.
//
// For every removal a member made (profile_corrections rows with removed = true), counts the rows in each store that still contain
// the removed text as a phrase, after the same normalization on both sides: lower case, punctuation and runs of spaces folded to one
// space, and Cue's own lead-ins ("my read: ", "looking out for: ", ...) taken off the removed text. A paraphrase isn't counted: these
// are exact-phrase counts (a floor). Output is counts by store and by kind of member (real, test, archived): never a member's text,
// id, name or phone, never the removed text, and never a database error's text (its class only).
//
//   DATABASE_URL=postgres://...@127.0.0.1:55441/railway npx tsx src/scripts/forgetResidueAudit.ts --confirm-db railway [--expect-port 55441]
//
// It only ever runs against the dev server: DEV_SYSTEM_ID below is that server's identifier, set in the code, and every other server
// is refused (an operator can't pass another one in, so a tunnel pointed anywhere else fails). --print-id reads only
// pg_control_system() and prints the identifier; it's there to set DEV_SYSTEM_ID up again if the dev server is ever rebuilt.
//
// Safety, in this order:
//   - not production (NODE_ENV or RAILWAY_ENVIRONMENT_NAME), and a local tunnel: host 127.0.0.1 or localhost, on the expected port
//     (default 55441). Both are checked before connecting.
//   - the server's system identifier is DEV_SYSTEM_ID, and current_database() is --confirm-db (both databases are named "railway",
//     so the name alone can't tell dev from anything else). Checked before any table is read.
//   - inside BEGIN READ ONLY (checked), the server holds test members (555-01xx numbers), which only dev/co-test ever creates
//     (services/testNumbers.ts). This is one count of the users table, read before refusing; it runs only after the identifier
//     check passed, and nothing but the count leaves it.
//   - every read is inside BEGIN READ ONLY ... ROLLBACK, with a statement timeout. No write, no DDL, no temp table.
// Each store's columns are checked in information_schema first; a store whose table or columns aren't there is reported n/a.
import pg from "pg";

// The dev server's identifier (Railway helpful-stillness, environment dev, service Postgres-J3wd; pg_control_system()), read
// 2026-10-19 over a read-only tunnel. The audit refuses every other server.
export const DEV_SYSTEM_ID = "7676947357376430135";

type Store = { name: string; table: string; owner: string; cols: string[]; where?: string; note?: string };
// The stores in forget-delete-spec.md section 2 that hold text. Each row is matched on its owner (the member who removed it).
export const STORES: Store[] = [
  { name: "co_memories: texts and Cue's lines (text_exchange)", table: "co_memories", owner: "user_id", cols: ["content"], where: "t.memory_type = 'text_exchange'" },
  { name: "co_memories: call transcripts", table: "co_memories", owner: "user_id", cols: ["content"], where: "t.memory_type = 'call_transcript'" },
  { name: "co_memories: recaps (any age)", table: "co_memories", owner: "user_id", cols: ["content"], where: "t.memory_type = 'recap'" },
  { name: "co_memories: lessons, recommendations, promise results", table: "co_memories", owner: "user_id", cols: ["content"], where: "t.memory_type IN ('co_lesson', 'recommendation', 'promise_result')" },
  { name: "co_memories: other types", table: "co_memories", owner: "user_id", cols: ["content"], where: "t.memory_type NOT IN ('text_exchange', 'call_transcript', 'recap', 'co_lesson', 'recommendation', 'promise_result')" },
  { name: "co_memories: rows with an embedding (any type)", table: "co_memories", owner: "user_id", cols: ["content"], where: "t.content_embedding IS NOT NULL" },
  { name: "member_claims", table: "member_claims", owner: "user_id", cols: ["text", "quote"] },
  { name: "member_threads: open or waiting", table: "member_threads", owner: "user_id", cols: ["text", "opened_quote", "closed_quote"], where: "t.status IN ('open', 'waiting')" },
  { name: "member_threads: any status", table: "member_threads", owner: "user_id", cols: ["text", "opened_quote", "closed_quote"] },
  { name: "person_snapshots", table: "person_snapshots", owner: "user_id", cols: ["snapshot"] },
  { name: "co_profiles (fields and intent)", table: "co_profiles", owner: "user_id", cols: ["goals", "intent", "blockers", "activity_preferences", "life_chapters", "long_term_direction", "city", "avoid"] },
  { name: "co_goals", table: "co_goals", owner: "user_id", cols: ["title", "their_words", "items"] },
  { name: "open_loops: open", table: "open_loops", owner: "user_id", cols: ["title", "detail"], where: "t.closed_at IS NULL" },
  { name: "open_loops: closed", table: "open_loops", owner: "user_id", cols: ["title", "detail"], where: "t.closed_at IS NOT NULL" },
  { name: "co_tasks: open", table: "co_tasks", owner: "user_id", cols: ["goal", "their_words", "notes", "outcome"], where: "t.status = 'open'" },
  { name: "co_tasks: closed", table: "co_tasks", owner: "user_id", cols: ["goal", "their_words", "notes", "outcome"], where: "t.status <> 'open'" },
  { name: "proactive_candidates (any status)", table: "proactive_candidates", owner: "user_id", cols: ["summary", "payload"] },
  { name: "deferred_sends (any status)", table: "deferred_sends", owner: "user_id", cols: ["messages", "after_payload"] },
  { name: "co_facts: live", table: "co_facts", owner: "owner_user_id", cols: ["object_label"], where: "t.retired_at IS NULL" },
  { name: "co_facts: retired (label kept)", table: "co_facts", owner: "owner_user_id", cols: ["object_label"], where: "t.retired_at IS NOT NULL" },
  { name: "relevance_edges: they're the asker", table: "relevance_edges", owner: "person_id", cols: ["match_reason", "share_reason"] },
  { name: "relevance_edges: they're the candidate", table: "relevance_edges", owner: "candidate_id", cols: ["match_reason", "share_reason"] },
  { name: "event_guest_rankings", table: "event_guest_rankings", owner: "person_id", cols: ["method_summary", "ranked_candidates"] },
  { name: "document_deliveries", table: "document_deliveries", owner: "user_id", cols: ["content"] },
  { name: "co_pages", table: "co_pages", owner: "owner_user_id", cols: ["data"] },
  { name: "research_finds", table: "research_finds", owner: "user_id", cols: ["name", "fields"] },
  { name: "search_briefs", table: "search_briefs", owner: "user_id", cols: ["brief"] },
  { name: "link_reads", table: "link_reads", owner: "owner_user_id", cols: ["summary", "fields"] },
  { name: "emotion_signals", table: "emotion_signals", owner: "user_id", cols: ["about", "quote"] },
  { name: "member_advice", table: "member_advice", owner: "user_id", cols: ["topic", "gist"] },
  { name: "member_milestones", table: "member_milestones", owner: "user_id", cols: ["text", "then_quote", "now_quote"] },
  { name: "ask_checkins (ask and closing evidence)", table: "ask_checkins", owner: "user_id", cols: ["ask_text", "closed_evidence"] },
  { name: "harness_decisions: other logs", table: "harness_decisions", owner: "user_id", cols: ["proposal", "reason"], where: "t.decision NOT LIKE 'knowledge.%'" },
  { name: "harness_decisions: the removal's own logs (knowledge.*)", table: "harness_decisions", owner: "user_id", cols: ["proposal", "reason"], where: "t.decision LIKE 'knowledge.%'" },
];

// The member groups: test (a 555-01xx number or simulated), archived (team/test resets since #214), real. Only the group leaves SQL.
const GROUP = `CASE WHEN coalesce((to_jsonb(u)->>'is_simulated')::boolean, false) OR regexp_replace(coalesce(u.phone_number, ''), '\\D', '', 'g') ~ '^1?[0-9]{3}55501[0-9]{2}$' THEN 'test' WHEN u.archived_at IS NOT NULL THEN 'archived' ELSE 'real' END`;
// Normalized on both sides: lower case, anything but letters and digits folded to one space, trimmed. The removed text also loses
// Cue's own lead-ins (whatCoKnows.ts plainOf), which are never in the member's words.
// JSON escapes (\n, \t, \r in a jsonb column's text) become spaces first, so "\nThe custody" doesn't read as "nthe custody".
export const NORM = (sql: string) => `btrim(regexp_replace(lower(regexp_replace(${sql}, '\\\\[nrt]', ' ', 'g')), '[^a-z0-9]+', ' ', 'g'))`;
const LEAD_INS = `^(my read|looking out for|not for you|what your decks and pages take their look from):\\s*`;
const REMOVED = `SELECT id, user_id, p FROM (SELECT pc.id, pc.user_id, ${NORM(`regexp_replace(btrim(pc.old_value), '${LEAD_INS}', '', 'i')`)} AS p FROM profile_corrections pc WHERE (to_jsonb(pc)->>'removed') = 'true') x WHERE length(p) >= 8`;
const GROUPS = ["real", "test", "archived"] as const;
type Counts = Record<(typeof GROUPS)[number], { rows: number; removals: number }>;
const zero = (): Counts => ({ real: { rows: 0, removals: 0 }, test: { rows: 0, removals: 0 }, archived: { rows: 0, removals: 0 } });
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`not a plain identifier: ${s}`);
  return s;
};

// Pure: whether the connection string is a local tunnel on the expected port.
export function localTunnel(url: string, port: number): boolean {
  const u = new URL(url);
  return ["127.0.0.1", "localhost"].includes(u.hostname) && Number(u.port) === port;
}
const arg = (args: string[], k: string) => (args.indexOf(k) === -1 ? undefined : args[args.indexOf(k) + 1]);

async function main() {
  const args = process.argv.slice(2);
  const confirm = arg(args, "--confirm-db");
  const port = Number(arg(args, "--expect-port") ?? 55441);
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT_NAME === "production") throw new Error("refusing: production");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const url = new URL(process.env.DATABASE_URL);
  if (!localTunnel(process.env.DATABASE_URL, port)) throw new Error(`refusing: not a local tunnel on port ${port} (host ${url.hostname}:${url.port || "5432"})`);
  const printId = args.includes("--print-id");
  if (!printId && !confirm) throw new Error("pass --confirm-db <database name>");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const sysId = await client
      .query(`SELECT system_identifier::text AS id FROM pg_control_system()`)
      .then((r) => String(r.rows[0]?.id ?? ""))
      .catch(() => "");
    if (!sysId) throw new Error("refusing: the server's system identifier couldn't be read");
    if (printId) {
      console.log(`system identifier: ${sysId}`);
      return;
    }
    const who = (await client.query(`SELECT current_database() AS db, inet_server_port() AS port, version() AS v`)).rows[0];
    console.log(`connected: host ${url.hostname}:${url.port} (server port ${who.port}), database ${who.db}, system ${sysId}, ${String(who.v).split(" ").slice(0, 2).join(" ")}`);
    if (who.db !== confirm) throw new Error(`refusing: connected to "${who.db}", --confirm-db says "${confirm}"`);
    if (sysId !== DEV_SYSTEM_ID) throw new Error(`refusing: server ${sysId} is not the dev server ${DEV_SYSTEM_ID}`);
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const ro = (await client.query(`SELECT current_setting('transaction_read_only') AS ro`)).rows[0].ro;
    if (ro !== "on") throw new Error("refusing: the transaction is not read-only");
    // A second dev marker, after the identifier check passed: only dev/co-test ever creates 555-01xx test members
    // (services/testNumbers.ts is off on production). This count is read first and refused on after: none here, not dev.
    const testMembers = (await client.query(`SELECT count(*)::int AS n FROM users WHERE regexp_replace(coalesce(phone_number, ''), '\\D', '', 'g') ~ '^1?[0-9]{3}55501[0-9]{2}$'`)).rows[0]?.n ?? 0;
    if (!testMembers) throw new Error("refusing: no 555-01xx test members on this server, so it isn't the dev/co-test database");
    console.log("transaction: READ ONLY; dev markers: system identifier matches, test members present\n");
    console.log("Counts are exact-phrase matches after normalizing case, punctuation and spacing on both sides (a floor: a paraphrase isn't counted).\n");

    const totals = (await client.query(`WITH removed AS (${REMOVED}) SELECT ${GROUP} AS g, count(*)::int AS removals, count(DISTINCT r.user_id)::int AS members FROM removed r JOIN users u ON u.id = r.user_id GROUP BY 1`)).rows;
    const allRemovals = (await client.query(`SELECT ${GROUP} AS g, count(*)::int AS n FROM profile_corrections pc JOIN users u ON u.id = pc.user_id WHERE (to_jsonb(pc)->>'removed') = 'true' GROUP BY 1`)).rows;
    console.log("Removals on file (profile_corrections, removed = true):");
    for (const g of GROUPS) {
      const t = totals.find((x: any) => x.g === g);
      const a = allRemovals.find((x: any) => x.g === g);
      console.log(`  ${g.padEnd(8)} ${a?.n ?? 0} removals (${t?.removals ?? 0} with 8+ characters of text, across ${t?.members ?? 0} members)`);
    }

    // The marker today (spec section 4): removal rows still holding the text, the quote, or a hash in item_ref.
    const marker = (await client.query(`SELECT ${GROUP} AS g, count(*) FILTER (WHERE btrim(pc.old_value) <> '')::int AS old_value, count(*) FILTER (WHERE btrim(coalesce(pc.quote, '')) <> '')::int AS quote, count(*) FILTER (WHERE coalesce(to_jsonb(pc)->>'item_ref', '') ~ '[0-9a-f]{8}$')::int AS hashed FROM profile_corrections pc JOIN users u ON u.id = pc.user_id WHERE (to_jsonb(pc)->>'removed') = 'true' GROUP BY 1`)).rows;
    console.log("\nThe marker (profile_corrections removal rows that still hold): old_value / quote / a hash in item_ref");
    for (const g of GROUPS) {
      const m = marker.find((x: any) => x.g === g);
      console.log(`  ${g.padEnd(8)} ${m?.old_value ?? 0} / ${m?.quote ?? 0} / ${m?.hashed ?? 0}`);
    }

    const cols = new Map<string, Set<string>>();
    for (const r of (await client.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`)).rows) {
      if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
      cols.get(r.table_name)!.add(r.column_name);
    }
    console.log("\nRows that still hold a removed text as a phrase, normalized (rows / removals with any), real | test | archived:");
    for (const s of STORES) {
      const have = cols.get(s.table);
      const textCols = s.cols.filter((c) => have?.has(c));
      const whereCols = [...(s.where ?? "").matchAll(/\bt\.([a-z_]+)/g)].map((m) => m[1]);
      if (!have || !have.has(s.owner) || !textCols.length || whereCols.some((c) => !have.has(c))) {
        console.log(`  ${s.name.padEnd(58)} n/a (table or columns not here)`);
        continue;
      }
      const text = textCols.map((c) => `coalesce(t.${ident(c)}::text, '')`).join(` || ' ' || `);
      const sql = `WITH removed AS (${REMOVED})
        SELECT ${GROUP} AS g, count(*)::int AS rows, count(DISTINCT r.id)::int AS removals
        FROM removed r JOIN users u ON u.id = r.user_id
        JOIN ${ident(s.table)} t ON t.${ident(s.owner)} = r.user_id ${s.where ? `AND ${s.where}` : ""} AND position(' ' || r.p || ' ' IN ' ' || ${NORM(text)} || ' ') > 0
        GROUP BY 1`;
      const c = zero();
      try {
        await client.query("SAVEPOINT store");
        for (const r of (await client.query(sql)).rows) if (r.g in c) c[r.g as keyof Counts] = { rows: r.rows, removals: r.removals };
        await client.query("RELEASE SAVEPOINT store");
      } catch (err: any) {
        await client.query("ROLLBACK TO SAVEPOINT store");
        // The error's class only (its SQLSTATE), never its text: a message can quote a value.
        console.log(`  ${s.name.padEnd(58)} error (class ${String(err?.code ?? "unknown").slice(0, 5)})`);
        continue;
      }
      console.log(`  ${s.name.padEnd(58)} ${GROUPS.map((g) => `${c[g].rows}/${c[g].removals}`).join(" | ")}`);
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

if (process.argv[1] && /forgetResidueAudit\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      // Our own refusals are printed; a database error only by its class.
      const msg = String(err?.message ?? err);
      console.error(/^(refusing|pass |DATABASE_URL)/.test(msg) ? msg : `failed (class ${String(err?.code ?? "unknown").slice(0, 5)})`);
      process.exit(1);
    },
  );
}
