import "dotenv/config";
import pool from "../db/db.js";
import { stripTextlessIntent } from "../harness/profileWrite.js";

// Cleanup (2026-09-20) — removes entries from co_profiles.intent that carry
// no ask text. captureIntent writes one of these whenever a conversation
// produced preferences/wants/availability but no ask: no text, no type, but
// status "active", so everything reading intent for open asks counted them.
// The read paths ignore them now (harness/profileWrite.ts's isOpenAsk), and
// this clears the ones already on file.
//
// Idempotent: a second run finds nothing left to strip. Dry run by default —
// nothing is written without --apply.
//
// Usage:
//   tsx src/scripts/stripTextlessIntent.ts                 # report only
//   tsx src/scripts/stripTextlessIntent.ts --apply         # write
//   tsx src/scripts/stripTextlessIntent.ts --user <uuid>   # one member
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const userIdx = args.indexOf("--user");
  const onlyUser = userIdx >= 0 ? args[userIdx + 1] : null;

  const { rows } = await pool.query(
    `SELECT user_id, intent FROM co_profiles
     WHERE ($1::uuid IS NULL OR user_id = $1::uuid)
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(intent, '[]'::jsonb)) AS e
         WHERE COALESCE(btrim(e->>'text'), '') = ''
       )
     ORDER BY user_id`,
    [onlyUser],
  );

  if (!rows.length) {
    console.log("[stripTextlessIntent] nothing to strip — every intent entry has ask text");
    await pool.end();
    return;
  }

  let stripped = 0;
  for (const row of rows) {
    const before = Array.isArray(row.intent) ? row.intent : [];
    const after = stripTextlessIntent(before);
    stripped += before.length - after.length;
    console.log(
      `[stripTextlessIntent] ${row.user_id}: ${before.length} entries -> ${after.length} (${before.length - after.length} text-less)`,
    );
    if (apply) {
      await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [
        row.user_id,
        JSON.stringify(after),
      ]);
    }
  }

  console.log(
    apply
      ? `[stripTextlessIntent] stripped ${stripped} entries across ${rows.length} profile(s)`
      : `[stripTextlessIntent] would strip ${stripped} entries across ${rows.length} profile(s) — re-run with --apply to write`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error("[stripTextlessIntent] failed:", err);
  process.exit(1);
});
