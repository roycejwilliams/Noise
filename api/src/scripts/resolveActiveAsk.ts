import "dotenv/config";
import pool from "../db/db.js";

// Test tool (Royce, 2026-09-05) — marks a user's active "seeking" ask
// entries as resolved, so scoreMatchedGroup routes them to ask-solicitation
// instead of scoring (matching.ts's getActiveSeekingAsk only matches
// status === "active"). Lets that branch be exercised against a real Luma
// guest-list event without waiting on a live conversation to naturally
// resolve an ask.
//
// Usage: tsx src/scripts/resolveActiveAsk.ts <email_or_phone>
async function main() {
  const [, , identifier] = process.argv;
  if (!identifier) {
    console.error("Usage: tsx src/scripts/resolveActiveAsk.ts <email_or_phone>");
    process.exit(1);
  }
  const { rows } = await pool.query(
    `SELECT u.id, cp.intent FROM users u JOIN co_profiles cp ON cp.user_id = u.id
     WHERE u.phone_number = $1 OR LOWER(u.email) = LOWER($1)`,
    [identifier],
  );
  const user = rows[0];
  if (!user) {
    console.error(`[resolveActiveAsk] no user/profile found for ${identifier}`);
    process.exit(1);
  }
  const intent = (user.intent ?? []).map((i: any) =>
    i.type === "seeking" && i.status === "active" ? { ...i, status: "resolved" } : i,
  );
  await pool.query(`UPDATE co_profiles SET intent = $1::jsonb WHERE user_id = $2`, [JSON.stringify(intent), user.id]);
  console.log(`[resolveActiveAsk] resolved active seeking asks for ${identifier}`);
  await pool.end();
}

main().catch((err) => {
  console.error("[resolveActiveAsk] failed:", err);
  process.exit(1);
});
