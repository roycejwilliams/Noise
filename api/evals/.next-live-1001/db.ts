// The one database session every production query runs through.
//  - One physical client, one outer BEGIN, every public base table shadowed by
//    an empty session-local TEMP copy (metadata only: no rows are ever copied),
//    then SET TRANSACTION READ ONLY: Postgres itself refuses any write that
//    isn't to a TEMP table (25006). Unqualified names resolve to pg_temp first,
//    so production SQL reads and writes the shadows, never real data.
//  - Every statement runs in its own savepoint, so an error never poisons the
//    session; production BEGIN/COMMIT/ROLLBACK become SAVEPOINT/RELEASE/ROLLBACK TO.
//  - A SQL gate refuses schema-qualified permanent names, DDL, COPY, sequence
//    calls, file/dblink/admin functions and multiple statements, and counts it.
//  - Only the owner may ROLLBACK the outer transaction.
import { pg, OWNER, setAdapter, H } from "./boot.js";

export const DBC = {
  refusedWrites: 0, // unexpected refusals (gate or Postgres 25006) during scenarios
  probeRefusals: 0, // deliberate guard probes
  refusedSamples: [] as { why: string; sql: string; caseId: string | null }[],
  statements: 0,
  pending: 0,
  errors: [] as { code: string; msg: string; sql: string; caseId: string | null }[],
  probing: false,
  shadowTables: [] as string[],
  lateQueries: 0,
  opens: 0,
  openMs: [] as number[],
  nowDefaultsRewritten: 0,
  faults: [] as RegExp[], // injected failures for the next matching statements (per case)
  faultHits: 0,
};

let owner: any = null;
let sp = 0;
let txnOpen = false;
let chain: Promise<any> = Promise.resolve();
// Transaction scopes from production clients run one at a time.
let scopeTail: Promise<void> = Promise.resolve();

const strip = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''").replace(/\$\$[\s\S]*?\$\$/g, "''");
const FORBIDDEN = [
  [/\b(public|"public")\s*\.\s*"?[a-z_]/i, "schema-qualified permanent name"],
  [/\b(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|VACUUM|CLUSTER|REINDEX|LISTEN|NOTIFY|UNLISTEN|LOAD|CALL|DISCARD|REFRESH|SECURITY|IMPORT|COMMENT\s+ON)\b/i, "DDL or session command"],
  [/^\s*(COPY|DO|PREPARE|EXECUTE|DEALLOCATE|RESET)\b/i, "COPY/DO/PREPARE"],
  [/\b(nextval|setval|currval|dblink\w*|pg_read_\w+|pg_ls_\w+|pg_stat_file|lo_\w+|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config|pg_sleep\w*|pg_logical_\w+|pg_switch_wal|pg_promote|query_to_xml|pg_file_\w+)\s*\(/i, "forbidden function"],
] as const;

export function gate(sql: string): { ok: true; kind: "stmt" | "begin" | "commit" | "rollback" | "set_local" } | { ok: false; why: string } {
  const s = strip(sql).trim().replace(/;\s*$/, "");
  if (!s) return { ok: false, why: "empty statement" };
  if (s.includes(";")) return { ok: false, why: "multiple statements" };
  if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(s)) return { ok: true, kind: "begin" };
  if (/^(COMMIT|END)\b/i.test(s)) return { ok: true, kind: "commit" };
  if (/^ROLLBACK\s*$/i.test(s)) return { ok: true, kind: "rollback" };
  if (/^(SAVEPOINT|RELEASE|ROLLBACK\s+TO)\b/i.test(s)) return { ok: false, why: "production savepoint (not supported by adapter)" };
  if (/^SET\s+LOCAL\s+statement_timeout\b/i.test(s)) return { ok: true, kind: "set_local" };
  if (/^SET\b/i.test(s)) return { ok: false, why: "SET" };
  for (const [re, why] of FORBIDDEN) if (re.test(s)) return { ok: false, why };
  if (!/^(SELECT|WITH|INSERT|UPDATE|DELETE|VALUES|TABLE|LOCK)\b/i.test(s)) return { ok: false, why: "unrecognized statement" };
  return { ok: true, kind: "stmt" };
}

function refuse(why: string, sql: string): never {
  if (DBC.probing) DBC.probeRefusals++;
  else {
    DBC.refusedWrites++;
    if (DBC.refusedSamples.length < 50) DBC.refusedSamples.push({ why, sql: sql.replace(/\s+/g, " ").slice(0, 200), caseId: H.caseId });
  }
  const e: any = new Error(`harness: refused (${why})`);
  e.code = "HARNESS_REFUSED";
  throw e;
}

// Serialize on the owner client; each statement in its own savepoint.
function run(text: string, values?: any[]): Promise<any> {
  // Between cases there is no transaction: nothing may run in autocommit.
  if (!txnOpen) { DBC.lateQueries = (DBC.lateQueries ?? 0) + 1; return Promise.reject(Object.assign(new Error("harness: no open case transaction (late query refused)"), { code: "HARNESS_REFUSED" })); }
  if (DBC.faults.some((re) => re.test(text))) { DBC.faultHits++; return Promise.reject(Object.assign(new Error("harness: injected failure"), { code: "HARNESS_FAULT" })); }
  DBC.pending++;
  const p = chain.then(async () => {
    const name = `h_${++sp}`;
    await owner.query(`SAVEPOINT ${name}`);
    try {
      const r = await owner.query(text, values);
      await owner.query(`RELEASE SAVEPOINT ${name}`);
      DBC.statements++;
      return r;
    } catch (e: any) {
      await owner.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
      await owner.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
      if (e?.code === "25006") refuse("Postgres read-only: permanent write", text);
      if (!DBC.probing && DBC.errors.length < 80) DBC.errors.push({ code: String(e?.code ?? ""), msg: String(e?.message ?? "").slice(0, 160), sql: text.replace(/\s+/g, " ").slice(0, 160), caseId: H.caseId });
      throw e;
    }
  });
  chain = p.catch(() => {});
  return p.finally(() => { DBC.pending--; });
}

export async function query(text: string, values?: any[]): Promise<any> {
  const g = gate(text ?? "");
  if (!g.ok) refuse(g.why, text ?? "");
  // A bare pool.query BEGIN/COMMIT outside a client has no scope: nothing to do.
  if (g.kind === "begin" || g.kind === "commit" || g.kind === "rollback") return { rows: [], rowCount: 0 };
  if (g.kind === "set_local") return { rows: [], rowCount: 0 };
  return run(text, values);
}

// A production client: its BEGIN..COMMIT is a savepoint scope on the owner.
async function connect() {
  let releaseScope: (() => void) | null = null;
  let scopeName: string | null = null;
  let released = false;
  const endScope = async (how: "commit" | "rollback") => {
    if (!scopeName) return;
    const n = scopeName;
    scopeName = null;
    await (chain = chain.then(async () => {
      if (how === "commit") await owner.query(`RELEASE SAVEPOINT ${n}`).catch(() => {});
      else { await owner.query(`ROLLBACK TO SAVEPOINT ${n}`).catch(() => {}); await owner.query(`RELEASE SAVEPOINT ${n}`).catch(() => {}); }
    }));
    releaseScope?.();
    releaseScope = null;
  };
  const client = {
    query: async (t: any, v?: any) => {
      if (released) throw new Error("harness: query on a released client");
      const text = typeof t === "string" ? t : t?.text;
      const values = typeof t === "object" && t?.values ? t.values : v;
      const g = gate(text ?? "");
      if (!g.ok) refuse(g.why, text ?? "");
      if (g.kind === "begin") {
        if (scopeName) throw new Error("harness: nested BEGIN on one client");
        let r!: () => void;
        const mine = new Promise<void>((res) => (r = res));
        const wait = scopeTail;
        scopeTail = wait.then(() => mine);
        await wait;
        releaseScope = r;
        scopeName = `tx_${++sp}`;
        const n = scopeName;
        await (chain = chain.then(() => owner.query(`SAVEPOINT ${n}`)));
        return { rows: [], rowCount: 0 };
      }
      if (g.kind === "commit") { await endScope("commit"); return { rows: [], rowCount: 0 }; }
      if (g.kind === "rollback") { await endScope("rollback"); return { rows: [], rowCount: 0 }; }
      if (g.kind === "set_local") return { rows: [], rowCount: 0 };
      return run(text, values);
    },
    release: (_err?: any) => {
      if (released) return;
      released = true;
      if (scopeName) void endScope("rollback");
    },
    on: () => client,
    removeListener: () => client,
  };
  return client;
}

// ---------------------------------------------------------------- setup and teardown
export async function open(): Promise<{ tables: number; sequencesRebuilt: number; readOnly: boolean; nowDefaults: number; openMs: number }> {
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
  owner[OWNER] = true;
  await owner.connect();
  const r = await openTxn();
  setAdapter({ query, connect });
  return r;
}

// One outer transaction per case: NOW() is the case's own start time.
async function openTxn() {
  const t0 = Date.now();
  await owner.query("BEGIN");
  await owner.query("SET LOCAL statement_timeout = '20s'");
  if (!DBC.shadowTables.length) {
    const { rows: tables } = await owner.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
    DBC.shadowTables = tables.map((t: any) => t.relname);
  }
  for (const relname of DBC.shadowTables) {
    await owner.query(`CREATE TEMP TABLE "${relname}" (LIKE public."${relname}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES INCLUDING GENERATED INCLUDING IDENTITY) ON COMMIT DROP`);
  }
  // Defaults that call a permanent sequence would advance it (a rollback doesn't
  // undo that): rebuild them on TEMP sequences. Found through pg_depend, by the
  // sequence's actual schema, not by how the default prints.
  const PERM_SEQ_DEFAULTS = `SELECT c.relname AS t, a.attname AS col
     FROM pg_depend dep
     JOIN pg_attrdef d ON dep.classid = 'pg_attrdef'::regclass AND dep.objid = d.oid
     JOIN pg_class s ON s.oid = dep.refobjid AND s.relkind = 'S'
     JOIN pg_class c ON c.oid = d.adrelid
     JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE c.relnamespace = pg_my_temp_schema() AND s.relnamespace <> pg_my_temp_schema()`;
  const { rows: seqCols } = await owner.query(PERM_SEQ_DEFAULTS);
  let rebuilt = 0;
  for (const r of seqCols) {
    const seq = `hseq_${r.t}_${r.col}`.replace(/\W/g, "_").slice(0, 60);
    await owner.query(`CREATE TEMP SEQUENCE "${seq}"`);
    await owner.query(`ALTER TABLE pg_temp."${r.t}" ALTER COLUMN "${r.col}" SET DEFAULT nextval('pg_temp."${seq}"')`);
    rebuilt++;
  }
  const { rows: left } = await owner.query(`SELECT count(*)::int AS n FROM (${PERM_SEQ_DEFAULTS}) x`);
  if (left[0].n) throw new Error(`NEXT_SETUP: ${left[0].n} TEMP defaults still use a permanent sequence`);
  // NOW() is fixed for a transaction; defaults use the wall clock instead, so
  // rows written during a case still order by when they were written.
  const { rows: nowCols } = await owner.query(
    `SELECT c.relname AS t, a.attname AS col, pg_get_expr(d.adbin, d.adrelid) AS def
     FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE c.relnamespace = pg_my_temp_schema() AND (pg_get_expr(d.adbin, d.adrelid) ILIKE '%now()%' OR pg_get_expr(d.adbin, d.adrelid) ILIKE '%CURRENT_TIMESTAMP%')`,
  );
  for (const r of nowCols) {
    const def = String(r.def).replace(/now\(\)/gi, "clock_timestamp()").replace(/CURRENT_TIMESTAMP/gi, "clock_timestamp()");
    await owner.query(`ALTER TABLE pg_temp."${r.t}" ALTER COLUMN "${r.col}" SET DEFAULT ${def}`);
  }
  DBC.nowDefaultsRewritten = nowCols.length;
  // Every shadow must resolve to the TEMP schema.
  const { rows: res } = await owner.query(
    `SELECT count(*)::int AS n FROM unnest($1::text[]) t WHERE (SELECT relnamespace FROM pg_class WHERE oid = to_regclass(quote_ident(t))) <> pg_my_temp_schema()`,
    [DBC.shadowTables],
  );
  if (res[0].n) throw new Error(`NEXT_SETUP: ${res[0].n} names don't resolve to TEMP`);
  await owner.query("SET TRANSACTION READ ONLY");
  const ro = (await owner.query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on";
  if (!ro) throw new Error("NEXT_SETUP: transaction not read-only");
  txnOpen = true;
  DBC.opens++;
  DBC.openMs.push(Date.now() - t0);
  return { tables: DBC.shadowTables.length, sequencesRebuilt: rebuilt, readOnly: ro, nowDefaults: nowCols.length, openMs: Date.now() - t0 };
}

async function rollbackTxn() {
  await chain.catch(() => {});
  txnOpen = false;
  await owner.query("ROLLBACK");
}

// Raw owner access for fixtures and assertions (still TEMP-only by Postgres).
export async function raw(text: string, values?: any[]) {
  return run(text, values);
}

let first = true;
export async function caseBegin(id: string) {
  await settle();
  if (!first || !txnOpen) {
    if (txnOpen) await rollbackTxn();
    await openTxn();
  }
  first = false;
  H.caseId = id;
}
export async function caseEnd() {
  await settle();
  DBC.faults = [];
  await rollbackTxn();
  H.caseId = null;
}
// Wait for fire-and-forget production writes to land before rolling back.
export async function settle(quietMs = 400, maxMs = 15000) {
  const t0 = Date.now();
  let quietSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
    if (DBC.pending > 0 || H.inflight > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return true;
  }
  return false;
}

export async function close(): Promise<{ rolledBack: boolean; tempGone: boolean; pendingAtClose: number; lateQueries: number }> {
  const settled = await settle(800, 20000);
  if (txnOpen) await rollbackTxn();
  setAdapter(null);
  const g = await owner.query(`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relkind IN ('r','S')`);
  const out = { rolledBack: true, tempGone: g.rows[0].n === 0, pendingAtClose: settled ? 0 : DBC.pending, lateQueries: DBC.lateQueries };
  await owner.end();
  return out;
}
