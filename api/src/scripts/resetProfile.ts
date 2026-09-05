import "dotenv/config";
import pool from "../db/db.js";

// Test tool (Royce, 2026-09-05) — deletes a user's co_profiles row entirely
// (not nulling individual columns) so the next real profile write
// (storeProfile/captureIntent's own ON CONFLICT DO UPDATE upserts) creates a
// genuinely fresh row, identical to a brand-new user who's never had a
// profile built. Keeps the users row itself intact (phone/email/login), so
// the account stays a real, findable Co user for guest-list matching —
// just with no prior history clouding what a controlled test run is
// actually scoring against.
//
// Usage: tsx src/scripts/resetProfile.ts <email_or_phone>
async function main() {
  const [, , identifier] = process.argv;
  if (!identifier) {
    console.error("Usage: tsx src/scripts/resetProfile.ts <email_or_phone>");
    process.exit(1);
  }
  const { rows } = await pool.query(
    `SELECT id, first_name FROM users WHERE phone_number = $1 OR LOWER(email) = LOWER($1)`,
    [identifier],
  );
  const user = rows[0];
  if (!user) {
    console.error(`[resetProfile] no user found for ${identifier}`);
    process.exit(1);
  }
  const result = await pool.query(`DELETE FROM co_profiles WHERE user_id = $1`, [user.id]);
  console.log(`[resetProfile] deleted co_profiles row for ${user.first_name} (${user.id}) — rowCount: ${result.rowCount}`);
  await pool.end();
}

main().catch((err) => {
  console.error("[resetProfile] failed:", err);
  process.exit(1);
});
