import "dotenv/config";
import pool from "../db/db.js";

// Read-only diagnostic tool (Royce, 2026-09-06) — prints a user's real
// co_memories rows (all types) plus their current users.call_status/call_sid,
// in chronological order, so a reported bug can be diagnosed against actual
// production data instead of guessed at. No writes.
//
// Usage: tsx src/scripts/dumpUserActivity.ts <email_or_phone> [hours_back=6]
async function main() {
  const [, , identifier, hoursArg] = process.argv;
  if (!identifier) {
    console.error("Usage: tsx src/scripts/dumpUserActivity.ts <email_or_phone> [hours_back=6]");
    process.exit(1);
  }
  const hoursBack = Number(hoursArg ?? 6);

  const { rows: users } = await pool.query(
    `SELECT id, first_name, phone_number, email, call_status, call_sid FROM users
     WHERE phone_number = $1 OR LOWER(email) = LOWER($1) OR LOWER(first_name) = LOWER($1)`,
    [identifier],
  );
  const user = users[0];
  if (!user) {
    console.error(`[dumpUserActivity] no user found for ${identifier}`);
    process.exit(1);
  }
  console.log(`[dumpUserActivity] ${user.first_name} (${user.id}) — phone: ${user.phone_number}, email: ${user.email}`);
  console.log(`[dumpUserActivity] call_status: ${user.call_status}, call_sid: ${user.call_sid}`);

  const { rows: memories } = await pool.query(
    `SELECT memory_type, content, created_at FROM co_memories
     WHERE user_id = $1 AND created_at > NOW() - ($2 || ' hours')::interval
     ORDER BY created_at ASC`,
    [user.id, hoursBack],
  );
  console.log(`[dumpUserActivity] ${memories.length} memories in the last ${hoursBack}h:`);
  for (const m of memories) {
    console.log(`  [${m.created_at.toISOString()}] (${m.memory_type}) ${m.content}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error("[dumpUserActivity] failed:", err);
  process.exit(1);
});
