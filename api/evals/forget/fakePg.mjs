// A fake pg client for evals/forget/residueAudit.ts: answers the audit's reads from fixtures and records every statement.
import pg from "pg";
const asked = [];
pg.Client.prototype.connect = async function () {};
pg.Client.prototype.end = async function () {};
pg.Client.prototype.query = async function (sql) {
  asked.push(sql);
  if (/current_database\(\) AS db/.test(sql)) return { rows: [{ db: process.env.FAKE_DB, port: 5432, v: "PostgreSQL 16.4 x" }] };
  if (/transaction_read_only/.test(sql)) return { rows: [{ ro: "on" }] };
  if (/information_schema.columns/.test(sql)) return { rows: [{ table_name: "member_claims", column_name: "user_id" }, { table_name: "member_claims", column_name: "text" }] };
  if (/count\(DISTINCT r.user_id\)/.test(sql)) return { rows: [{ g: "real", removals: 2, members: 1 }] };
  if (/JOIN member_claims t/.test(sql)) return { rows: [{ g: "real", rows: 3, removals: 1 }, { g: "test", rows: 1, removals: 1 }] };
  return { rows: [] };
};
process.on("exit", () => console.log("ASKED " + JSON.stringify(asked.map((s) => s.trim().replace(/\s+/g, " ").slice(0, 20)))));
