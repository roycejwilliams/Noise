// The voice-read results kept before consent was a recorded fact (services/voiceReadConsent.ts, 2026-10-28). NOT RUN: Royce runs it,
// or doesn't, after reading the dry run.
//
// Before this change the voice read ran for anyone with users.voice_read_ok = true (set by hand) and for test numbers, and after each
// call it kept a few moments in emotion_signals (basis 'voice': a feeling's label and up to 140 characters of what they were saying).
// Nobody behind those rows said yes through Cue's question. Forget by default: rows kept with no reason on file are deleted.
// A member with a yes on file now (voice_read_consents.answer = 'yes', not withdrawn) keeps theirs.
//
//   npx tsx src/scripts/forgetVoiceReadsWithoutConsent.ts            dry run: lists every row it would delete, deletes nothing
//   npx tsx src/scripts/forgetVoiceReadsWithoutConsent.ts --apply    deletes exactly those rows, in one transaction
//
// Back up first (memory: dry run shows removals, back up before a cleanup).
import pool from "../db/db.js";

const WHERE = `e.basis = 'voice' AND NOT EXISTS (
  SELECT 1 FROM voice_read_consents c WHERE c.user_id = e.user_id AND c.answer = 'yes' AND c.withdrawn_at IS NULL)`;

async function main() {
  const apply = process.argv.includes("--apply");
  const { rows } = await pool.query(
    `SELECT e.id, e.user_id, u.first_name, e.created_at, e.emotion, e.intensity, e.valence, e.about, e.quote
     FROM emotion_signals e JOIN users u ON u.id = e.user_id WHERE ${WHERE} ORDER BY e.user_id, e.created_at`,
  );
  console.log(`${rows.length} voice-read row(s) kept without a recorded yes${apply ? "; deleting them" : " (dry run; nothing deleted)"}:`);
  // Every row in full, so the dry run shows exactly what would go (never acted on here: it only lists and deletes).
  for (const r of rows) console.log(`  ${JSON.stringify({ ...r, user_id: String(r.user_id).slice(0, 8) })}`);
  if (!apply || !rows.length) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const del = await client.query(`DELETE FROM emotion_signals e WHERE e.id = ANY($1::bigint[]) AND ${WHERE}`, [rows.map((r) => r.id)]);
    await client.query("COMMIT");
    console.log(`deleted ${del.rowCount}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("forgetVoiceReadsWithoutConsent failed:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
