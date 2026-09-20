import "dotenv/config";
import pool from "../db/db.js";
import { hasAskText, hasIntentPayload, settleTextlessIntent } from "../harness/profileWrite.js";

// Cleanup (2026-09-20) — settles entries in co_profiles.intent that carry no
// ask text. captureIntent used to write one of these whenever a conversation
// produced preferences/wants/availability but no ask: no text, no type, but
// status "active", so everything reading intent for open asks counted them.
// The read paths ignore them now (harness/profileWrite.ts's isOpenAsk).
//
// This KEEPS what the member said. An entry with preferences becomes
// "preferences_only"; only an entry with no ask text AND nothing else is
// removed. (The first version deleted the preferences too, and had to be
// restored from a backup.) It prints the full content of everything it would
// remove or change, so what you approve is what you saw.
//
// Idempotent: a second run finds nothing to settle. Dry run by default —
// nothing is written without --apply.
//
// Usage:
//   tsx src/scripts/settleTextlessIntent.ts                 # report only
//   tsx src/scripts/settleTextlessIntent.ts --apply         # write
//   tsx src/scripts/settleTextlessIntent.ts --user <uuid>   # one member
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
    console.log("[settleTextlessIntent] nothing to settle — every intent entry has ask text");
    await pool.end();
    return;
  }

  const show = (e: Record<string, unknown>) => {
    const { embedding: _embedding, ...rest } = e as any;
    return JSON.stringify(rest);
  };
  let removed = 0;
  let converted = 0;
  for (const row of rows) {
    const before = Array.isArray(row.intent) ? row.intent : [];
    const after = settleTextlessIntent(before);
    const kept = new Set(after.map((e: any) => e.id));
    const dropped = before.filter((e: any) => !hasAskText(e) && !kept.has(e.id));
    const toConvert = before.filter((e: any) => !hasAskText(e) && hasIntentPayload(e) && e.status !== "preferences_only");
    removed += dropped.length;
    converted += toConvert.length;
    console.log(`[settleTextlessIntent] ${row.user_id}: ${before.length} entries -> ${after.length}`);
    for (const e of toConvert) console.log(`  KEEP as preferences_only (had status ${e.status}): ${show(e)}`);
    for (const e of dropped) console.log(`  REMOVE (no ask text and nothing else): ${show(e)}`);
    if (apply) {
      await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [
        row.user_id,
        JSON.stringify(after),
      ]);
    }
  }

  console.log(
    apply
      ? `[settleTextlessIntent] converted ${converted}, removed ${removed} across ${rows.length} profile(s)`
      : `[settleTextlessIntent] would convert ${converted} and remove ${removed} across ${rows.length} profile(s) — re-run with --apply to write`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error("[settleTextlessIntent] failed:", err);
  process.exit(1);
});
