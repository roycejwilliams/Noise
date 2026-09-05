import "dotenv/config";
import pool from "../db/db.js";

// Debug tool (Royce, 2026-09-05) — prints a user's full co_profiles.intent
// array, newest last (matching captureIntent's append order), so a real
// extraction result can be inspected directly instead of guessing from the
// reply text alone.
//
// Usage: tsx src/scripts/showIntent.ts <email_or_phone>
async function main() {
  const [, , identifier] = process.argv;
  if (!identifier) {
    console.error("Usage: tsx src/scripts/showIntent.ts <email_or_phone>");
    process.exit(1);
  }
  const { rows } = await pool.query(
    `SELECT cp.intent FROM users u JOIN co_profiles cp ON cp.user_id = u.id
     WHERE u.phone_number = $1 OR LOWER(u.email) = LOWER($1)`,
    [identifier],
  );
  if (!rows[0]) {
    console.error(`[showIntent] no profile found for ${identifier}`);
    process.exit(1);
  }
  const intent = rows[0].intent ?? [];
  for (const entry of intent) {
    const { embedding, ...rest } = entry;
    console.log(JSON.stringify(rest));
  }
  await pool.end();
}

main().catch((err) => {
  console.error("[showIntent] failed:", err);
  process.exit(1);
});
