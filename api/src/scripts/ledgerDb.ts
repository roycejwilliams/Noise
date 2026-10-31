// The connection the ledger scripts (ledgerBackfill.ts, ledgerReconcile.ts) use: the dev server only, through a local tunnel, the
// same markers the residue audit checks (scripts/forgetResidueAudit.ts). A read-only run happens inside BEGIN READ ONLY (checked)
// and always ends in ROLLBACK, so nothing it does can write.
import pg from "pg";
import { DEV_SYSTEM_ID, localTunnel } from "./forgetResidueAudit.js";

export const arg = (args: string[], k: string) => (args.indexOf(k) === -1 ? undefined : args[args.indexOf(k) + 1]);

export type DevDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; readOnly: boolean; close: (commit?: boolean) => Promise<void> };

export async function openDevDb(args: string[], o: { readOnly: boolean }): Promise<DevDb> {
  const confirm = arg(args, "--confirm-db");
  const port = Number(arg(args, "--expect-port") ?? 55432);
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT_NAME === "production") throw new Error("refusing: production");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (!localTunnel(process.env.DATABASE_URL, port)) throw new Error(`refusing: not a local tunnel on port ${port}`);
  if (!confirm) throw new Error("pass --confirm-db <database name>");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const sysId = await client.query(`SELECT system_identifier::text AS id FROM pg_control_system()`).then((r) => String(r.rows[0]?.id ?? "")).catch(() => "");
    if (sysId !== DEV_SYSTEM_ID) throw new Error(`refusing: server ${sysId || "(unreadable)"} is not the dev server`);
    const db = (await client.query(`SELECT current_database() AS db`)).rows[0]?.db;
    if (db !== confirm) throw new Error(`refusing: connected to "${db}", --confirm-db says "${confirm}"`);
    await client.query(o.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query("SET LOCAL statement_timeout = '120s'");
    if (o.readOnly) {
      const ro = (await client.query(`SELECT current_setting('transaction_read_only') AS ro`)).rows[0]?.ro;
      if (ro !== "on") throw new Error("refusing: the transaction is not read-only");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
    throw err;
  }
  return {
    query: (sql, params) => client.query(sql, params as any[]),
    readOnly: o.readOnly,
    close: async (commit = false) => {
      await client.query(commit && !o.readOnly ? "COMMIT" : "ROLLBACK").catch(() => {});
      await client.end();
    },
  };
}

// Every member, by id only, with the group the residue audit uses (test, archived, real), oldest first.
export async function members(q: DevDb["query"]): Promise<{ id: string; group: string }[]> {
  const { rows } = await q(
    `SELECT u.id, CASE WHEN coalesce((to_jsonb(u)->>'is_simulated')::boolean, false) OR regexp_replace(coalesce(u.phone_number, ''), '\\D', '', 'g') ~ '^1?[0-9]{3}55501[0-9]{2}$' THEN 'test'
            WHEN u.archived_at IS NOT NULL THEN 'archived' ELSE 'real' END AS g
     FROM users u ORDER BY u.created_at, u.id`,
  );
  return rows.map((r) => ({ id: String(r.id), group: String(r.g) }));
}

export const short = (id: string) => id.slice(0, 8);
