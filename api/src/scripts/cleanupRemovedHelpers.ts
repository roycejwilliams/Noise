// One-time cleanup after Cue's general-assistant helpers were removed (Royce, 2026-11-04; "forget by default").
//
//   Google (revoked with Google, then deleted):
//     google_connections   the old combined connection (gmail.metadata)      docs_grants   the Docs grant (drive.file)
//     google_snapshots.waiting   the "emails waiting on a reply" summary, nulled
//   Removed-feature content (deleted):
//     co_page_shares, co_pages (page and deck content, link-card preview blobs), artifact_design_log, member_design_signals (look,
//     fonts, Pinterest/inspiration reads), co_memories rows of type design_taste / design_taste_asked.
//   Never touched: member_assets (their photos), member files (readDocument), calendar_grants, document_deliveries (still read by the
//   ledger), or anything else still in use.
//
// THIS DELETES REAL DATA. It does nothing unless run with exactly one of --dry-run or --apply, and --dry-run prints counts per table
// only (never a member id, name, email, token, content or an error's text).
//   npx tsx src/scripts/cleanupRemovedHelpers.ts --dry-run     counts only, nothing changes
//   npx tsx src/scripts/cleanupRemovedHelpers.ts --apply       revoke with Google, delete, null
import pool from "../db/db.js";
import { decryptToken, revokeToken } from "../services/googleAuth.js";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
// The Google grants: a token to revoke, a row to delete.
const GRANTS = ["google_connections", "docs_grants"] as const;
// Removed-feature content: a table to empty, or the design-taste memory rows.
const CONTENT: { name: string; count: string; del: string }[] = [
  { name: "co_page_shares", count: `SELECT COUNT(*)::int AS n FROM co_page_shares`, del: `DELETE FROM co_page_shares` },
  { name: "co_pages", count: `SELECT COUNT(*)::int AS n FROM co_pages`, del: `DELETE FROM co_pages` },
  { name: "artifact_design_log", count: `SELECT COUNT(*)::int AS n FROM artifact_design_log`, del: `DELETE FROM artifact_design_log` },
  { name: "member_design_signals", count: `SELECT COUNT(*)::int AS n FROM member_design_signals`, del: `DELETE FROM member_design_signals` },
  { name: "co_memories(design_taste)", count: `SELECT COUNT(*)::int AS n FROM co_memories WHERE memory_type IN ('design_taste', 'design_taste_asked')`, del: `DELETE FROM co_memories WHERE memory_type IN ('design_taste', 'design_taste_asked')` },
];

export type Counts = Record<string, number | null>; // null: the table isn't there
export type Applied = { before: Counts; revoked: number; revokeFailed: number; deleted: Counts; nulled: number };

const countOf = async (db: Db, sql: string): Promise<number | null> => db.query(sql).then((r) => Number(r.rows[0]?.n ?? 0)).catch(() => null);

export async function countRemovedHelpers(db: Db): Promise<Counts> {
  const out: Counts = {};
  out.google_connections = await countOf(db, `SELECT COUNT(*)::int AS n FROM google_connections`);
  out["google_connections(gmail scope)"] = await countOf(db, `SELECT COUNT(*)::int AS n FROM google_connections WHERE scopes LIKE '%gmail.metadata%'`);
  out.docs_grants = await countOf(db, `SELECT COUNT(*)::int AS n FROM docs_grants`);
  out["google_snapshots(waiting)"] = await countOf(db, `SELECT COUNT(*)::int AS n FROM google_snapshots WHERE waiting IS NOT NULL`);
  for (const c of CONTENT) out[c.name] = await countOf(db, c.count);
  return out;
}

export async function applyRemovedHelpersCleanup(db: Db, revoke: (token: string) => Promise<void> = revokeToken): Promise<Applied> {
  const before = await countRemovedHelpers(db);
  let revoked = 0, revokeFailed = 0;
  const deleted: Counts = {};
  for (const table of GRANTS) {
    const rows = await db.query(`SELECT user_id, refresh_token_enc, access_token_enc FROM ${table}`).then((r) => r.rows).catch(() => null);
    if (rows === null) { deleted[table] = null; continue; }
    let n = 0;
    for (const r of rows) {
      try {
        const sealed = r.refresh_token_enc ?? r.access_token_enc;
        if (sealed) {
          await revoke(decryptToken(sealed));
          revoked++;
        }
      } catch {
        revokeFailed++; // already revoked on Google's side, or unreadable: the row goes either way
      }
      const d = await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [r.user_id]);
      n += d.rowCount ?? 0;
    }
    deleted[table] = n;
  }
  const nulled = await db.query(`UPDATE google_snapshots SET waiting = NULL WHERE waiting IS NOT NULL`).then((r) => r.rowCount ?? 0).catch(() => 0);
  for (const c of CONTENT) deleted[c.name] = await db.query(c.del).then((r) => r.rowCount ?? 0).catch(() => null);
  return { before, revoked, revokeFailed, deleted, nulled };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dry = args.includes("--dry-run");
  if (apply === dry) {
    console.log("Pass exactly one of --dry-run (counts per table only) or --apply (revokes with Google and deletes). Nothing was done.");
    return;
  }
  if (dry) {
    console.log("dry run (nothing changed):", JSON.stringify(await countRemovedHelpers(pool)));
    return;
  }
  console.log("applied:", JSON.stringify(await applyRemovedHelpersCleanup(pool)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error("cleanupRemovedHelpers failed:", err?.name ?? "error"); process.exitCode = 1; }).finally(() => pool.end());
}
