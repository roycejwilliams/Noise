// A clean test member for live tests (services/testNumbers.ts). Its texts are
// logged but never sent, and each reset starts from an empty history.
//
//   node dist/api/src/scripts/testMember.js reset   archive the current test member, create a fresh one
//   node dist/api/src/scripts/testMember.js show    print the current test member
//
// Archived, never deleted (the reset-keeps-test-data rule). Co-test and local only.
import pool from "../db/db.js";
import { LIVE_TEST_PHONE_LIKE, testNumbersEnabled } from "../services/testNumbers.js";

// One definition, shared with the paid-search exception (services/testMemberSpend.ts): the newest unarchived one is the live-test member.
const TEST_PHONE_LIKE = LIVE_TEST_PHONE_LIKE;

async function current(): Promise<{ id: string; phone_number: string; first_name: string } | null> {
  const { rows } = await pool.query(`SELECT id, phone_number, first_name FROM users WHERE phone_number LIKE $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [TEST_PHONE_LIKE]);
  return rows[0] ?? null;
}

async function reset(): Promise<void> {
  const archived = await pool.query(`UPDATE users SET archived_at = NOW() WHERE phone_number LIKE $1 AND archived_at IS NULL RETURNING phone_number`, [TEST_PHONE_LIKE]);
  const used = new Set((await pool.query(`SELECT phone_number FROM users WHERE phone_number LIKE $1`, [TEST_PHONE_LIKE])).rows.map((r: any) => r.phone_number));
  let phone: string | null = null;
  for (let n = 100; n <= 199; n++) {
    const p = `+1415555${String(n).padStart(4, "0")}`;
    if (!used.has(p)) {
      phone = p;
      break;
    }
  }
  if (!phone) throw new Error("all 100 test numbers are used; clear archived test members first");
  const tag = phone.slice(-2);
  const { rows } = await pool.query(
    `INSERT INTO users (first_name, last_name, email, phone_number, username, contact_verified, identity_captured, intake_asked, invite_verified, invite_asked)
     VALUES ('Jordan', 'Test', $1, $2, $3, true, true, true, true, true) RETURNING id`,
    [`jordan.test${tag}@example.test`, phone, `jordan_test_${tag}`],
  );
  await pool.query(`INSERT INTO co_profiles (user_id, city, updated_at) VALUES ($1, 'San Francisco', NOW()) ON CONFLICT (user_id) DO UPDATE SET city = EXCLUDED.city`, [rows[0].id]);
  console.log(JSON.stringify({ archived: archived.rows.map((r: any) => r.phone_number), created: { id: rows[0].id, phone, name: "Jordan Test", city: "San Francisco" } }));
}

async function main() {
  if (!testNumbersEnabled()) throw new Error("test members are for co-test and local only");
  const cmd = process.argv[2];
  if (cmd === "reset") await reset();
  else console.log(JSON.stringify(await current()));
  await pool.end();
}
main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
