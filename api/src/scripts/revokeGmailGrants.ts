// One-time cleanup after Gmail and Google Docs were removed (Royce, 2026-11-04; "forget by default"). Cue no longer reads email or
// saves to a member's Drive, so two Google grants are dead weight: the old combined connection (google_connections, the gmail.metadata
// scope) and the Docs grant (docs_grants, drive.file; the Docs removal is #387). For each, this revokes the stored token with Google
// and deletes the row; it also nulls google_snapshots.waiting (the "emails waiting on a reply" summary). The calendar grant
// (calendar_grants, free/busy) is NOT touched.
//
// THIS DELETES REAL DATA. It does nothing unless run with --apply, and --dry-run only prints counts.
//   npx tsx src/scripts/revokeGmailGrants.ts --dry-run     counts only, nothing changes
//   npx tsx src/scripts/revokeGmailGrants.ts --apply       revoke with Google, delete, null
// Output is counts only: never a member id, an email, a token or an error's text.
import pool from "../db/db.js";
import { decryptToken, revokeToken } from "../services/googleAuth.js";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
const TABLES = ["google_connections", "docs_grants"] as const;
export type Cleanup = { connections: number; withGmailScope: number; waitingSnapshots: number; docsGrants: number };
export type Applied = Cleanup & { revoked: number; revokeFailed: number; deleted: number; nulled: number };

export async function countGmailGrants(db: Db): Promise<Cleanup> {
  const c = await db.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE scopes LIKE '%gmail.metadata%')::int AS gmail FROM google_connections`);
  const d = await db.query(`SELECT COUNT(*)::int AS n FROM docs_grants`);
  const w = await db.query(`SELECT COUNT(*)::int AS n FROM google_snapshots WHERE waiting IS NOT NULL`);
  return { connections: Number(c.rows[0]?.n ?? 0), withGmailScope: Number(c.rows[0]?.gmail ?? 0), waitingSnapshots: Number(w.rows[0]?.n ?? 0), docsGrants: Number(d.rows[0]?.n ?? 0) };
}

export async function applyGmailCleanup(db: Db, revoke: (token: string) => Promise<void> = revokeToken): Promise<Applied> {
  const before = await countGmailGrants(db);
  let revoked = 0, revokeFailed = 0, deleted = 0;
  for (const table of TABLES) {
    const { rows } = await db.query(`SELECT user_id, refresh_token_enc, access_token_enc FROM ${table}`);
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
      deleted += d.rowCount ?? 0;
    }
  }
  const n = await db.query(`UPDATE google_snapshots SET waiting = NULL WHERE waiting IS NOT NULL`);
  return { ...before, revoked, revokeFailed, deleted, nulled: n.rowCount ?? 0 };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dry = args.includes("--dry-run");
  if (apply === dry) {
    console.log("Pass exactly one of --dry-run (counts only) or --apply (revokes with Google and deletes). Nothing was done.");
    return;
  }
  if (dry) {
    console.log("dry run (nothing changed):", JSON.stringify(await countGmailGrants(pool)));
    return;
  }
  console.log("applied:", JSON.stringify(await applyGmailCleanup(pool)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error("revokeGmailGrants failed:", err?.name ?? "error"); process.exitCode = 1; }).finally(() => pool.end());
}
