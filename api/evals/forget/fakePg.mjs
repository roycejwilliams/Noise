// A fake pg client for evals/forget/residueAudit.ts: answers the audit's reads from fixtures and records every statement.
import pg from "pg";
const asked = [];
pg.Client.prototype.connect = async function () {};
pg.Client.prototype.end = async function () {};
pg.Client.prototype.query = async function (sql) {
  asked.push(sql);
  if (/pg_control_system/.test(sql)) return { rows: [{ id: process.env.FAKE_SYSID ?? "7000000000000000001" }] };
  if (/FROM users WHERE regexp_replace/.test(sql)) return { rows: [{ n: Number(process.env.FAKE_TEST_MEMBERS ?? 2) }] };
  if (/^\s*SELECT broken/.test(sql)) throw Object.assign(new Error("value 'Ellis custody' is bad"), { code: "22P02" });
  if (/JOIN co_memories t/.test(sql)) throw Object.assign(new Error("invalid input syntax: \"the custody hearing in May\""), { code: "22P02" });
  if (/current_database\(\) AS db/.test(sql)) return { rows: [{ db: process.env.FAKE_DB, port: 5432, v: "PostgreSQL 16.4 x" }] };
  if (/transaction_read_only/.test(sql)) return { rows: [{ ro: "on" }] };
  if (/information_schema.columns/.test(sql)) return { rows: [{ table_name: "member_claims", column_name: "user_id" }, { table_name: "member_claims", column_name: "text" }, { table_name: "co_memories", column_name: "user_id" }, { table_name: "co_memories", column_name: "content" }, { table_name: "co_memories", column_name: "memory_type" }] };
  if (/count\(DISTINCT r.user_id\)/.test(sql)) return { rows: [{ g: "real", removals: 2, members: 1 }] };
  if (/JOIN member_claims t/.test(sql)) return { rows: [{ g: "real", rows: 3, removals: 1 }, { g: "test", rows: 1, removals: 1 }] };
  return { rows: [] };
};
process.on("exit", () => console.log("ASKED " + JSON.stringify(asked.map((s) => s.trim().replace(/\s+/g, " ").slice(0, 20)))));
