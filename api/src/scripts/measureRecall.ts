// Conversation recall latency, measured (read-only). For the three members with the most stored rows, runs the lookup's own queries under
// EXPLAIN (ANALYZE, BUFFERS) inside a READ ONLY transaction and prints timings and plan nodes only: never a row, a message, a name or a
// query's words. Also prints counts (no content) of text rows that have no stored vector, by the kind of line.
//
//   DATABASE_URL=postgres://...@127.0.0.1:<port>/railway tsx src/scripts/measureRecall.ts
// Point DATABASE_URL at a tunnel to the DEV database (see the notes in memory: feedback_evals_on_local_dev_db). The script prints the
// host and database name first and stops unless the host is local (a tunnel). It never writes, and it never calls a model: the meaning
// query runs with a fixed unit vector, so there is no embedding call.
import pg from "pg";
import { recallConversation, type RecallDeps } from "../services/conversationRecall.js";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(2); }
const u = new URL(url);
console.log(`host ${u.hostname}:${u.port} database ${u.pathname.slice(1)}`);
if (!["127.0.0.1", "localhost"].includes(u.hostname)) { console.error("not a local tunnel; stopping"); process.exit(2); }

type Plan = { kind: string; exec: number; plan: number; nodes: string[]; hit: number; read: number; rows: number };
const plans: Plan[] = [];
const kindOf = (sql: string): string =>
  /<=>/.test(sql) ? "meaning" : /hit_id/.test(sql) ? "context" : /MIN\(created_at\)/.test(sql) ? "cover" : /count\(\*\) OVER\(\)/.test(sql) ? (/~\* ANY/.test(sql) ? "keyword page" : "date page") : /ORDER BY created_at DESC, id DESC LIMIT 1/.test(sql) ? "newest" : "other";

const nodesOf = (n: any, out: string[] = []): string[] => {
  out.push(`${n["Node Type"]}${n["Index Name"] ? `(${n["Index Name"]})` : ""}`);
  for (const c of n.Plans ?? []) nodesOf(c, out);
  return out;
};
const buffers = (n: any, acc = { hit: 0, read: 0 }) => {
  acc.hit += n["Shared Hit Blocks"] ?? 0;
  acc.read += n["Shared Read Blocks"] ?? 0;
  return acc;
};

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("BEGIN READ ONLY");
await client.query("SET LOCAL statement_timeout = '30s'");

const explainer: RecallDeps["db"] = {
  query: async (sql, args) => {
    const kind = kindOf(sql);
    const ex = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, args as any[]);
    const root = ex.rows[0]["QUERY PLAN"][0];
    const b = buffers(root.Plan);
    plans.push({ kind, exec: root["Execution Time"], plan: root["Planning Time"], nodes: [...new Set(nodesOf(root.Plan))], hit: b.hit, read: b.read, rows: root.Plan["Actual Rows"] });
    return client.query(sql, args as any[]);
  },
};
const unit = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
const timings: any[] = [];
const deps: RecallDeps = {
  db: explainer,
  now: () => new Date(),
  zone: async () => "America/Los_Angeles",
  forgotten: async () => [],
  guard: (t) => t,
  fence: async () => ({ strip: (s: string) => s }),
  embed: async () => unit,
  onTiming: (t) => timings.push(t),
};

// Counts only.
const tot = await client.query(`SELECT memory_type, count(*)::int AS n, count(content_embedding)::int AS embedded, round(avg(length(content)))::int AS avg_len, max(length(content))::int AS max_len FROM co_memories WHERE memory_type IN ('text_exchange','call_transcript') GROUP BY 1 ORDER BY 1`);
console.log("\nrows by type: ", JSON.stringify(tot.rows));
const gap = await client.query(`SELECT CASE WHEN content LIKE 'User said:%' THEN 'member line' WHEN content LIKE 'Co replied:%' THEN 'cue line' WHEN content LIKE '[Call]%' THEN '[Call] note' WHEN content LIKE 'User sent a voice memo:%' THEN 'voice memo' WHEN content LIKE 'Co is looking:%' THEN 'hold line' ELSE 'other' END AS kind, count(*)::int AS missing FROM co_memories WHERE memory_type = 'text_exchange' AND content_embedding IS NULL AND created_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 2 DESC`);
console.log("text rows with no vector, last 30 days, by line kind: ", JSON.stringify(gap.rows));
const gapAll = await client.query(`SELECT count(*)::int AS missing_30d, count(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int AS missing_1d FROM co_memories WHERE memory_type = 'text_exchange' AND content_embedding IS NULL AND created_at > NOW() - INTERVAL '30 days'`);
console.log("text rows with no vector: ", JSON.stringify(gapAll.rows[0]));

const top = await client.query(`SELECT user_id::text AS user_id, count(*)::int AS n FROM co_memories WHERE memory_type IN ('text_exchange','call_transcript') GROUP BY 1 ORDER BY 2 DESC LIMIT 3`);
const label = ["member A", "member B", "member C"];
const asks: { name: string; input: any }[] = [
  { name: "topic, common word", input: { topic: "week" } },
  { name: "topic, rare word (no hits)", input: { topic: "zzyzxq" } },
  { name: "topic + yesterday", input: { topic: "week", when: "last month" } },
  { name: "date only, last month", input: { when: "last month" } },
  { name: "date only, whole year", input: { when: "2026-01-01..2026-12-31" } },
];
for (const [i, m] of top.rows.entries()) {
  console.log(`\n== ${label[i]}: ${m.n} text and call rows ==`);
  for (const a of asks) {
    plans.length = 0;
    timings.length = 0;
    await recallConversation(m.user_id, a.input, deps).catch((e) => console.log(`  (${a.name}: ${String(e?.message ?? e).slice(0, 80)})`));
    const t = timings[0];
    console.log(`-- ${a.name}: total ${t?.totalMs ?? "?"} ms`);
    for (const p of plans) console.log(`   ${p.kind.padEnd(13)} exec ${p.exec.toFixed(1).padStart(8)} ms  plan ${p.plan.toFixed(1).padStart(6)} ms  rows ${String(p.rows).padStart(5)}  buffers hit ${p.hit} read ${p.read}  nodes: ${p.nodes.join(" > ")}`);
  }
}
await client.query("ROLLBACK");
await client.end();
