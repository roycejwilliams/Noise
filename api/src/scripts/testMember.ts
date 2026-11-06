// A clean test member for live tests (services/testNumbers.ts). Its texts are
// logged but never sent, and each reset starts from an empty history.
//
//   node dist/api/src/scripts/testMember.js reset   archive the current test member, create a fresh one
//   node dist/api/src/scripts/testMember.js show    print the current test member
//
// Archived, never deleted (the reset-keeps-test-data rule). Co-test and local only.
import pool from "../db/db.js";
import { LIVE_TEST_CANDIDATES_SQL, LIVE_TEST_PHONE_LIKE, liveTestEmail, pickLiveTestMember, testNumbersEnabled, freeTestSlot } from "../services/testNumbers.js";

// One definition, shared with the paid-search exception (services/testMemberSpend.ts): the live-test member is the newest
// unarchived account with both the number range and the email reset writes.
const TEST_PHONE_LIKE = LIVE_TEST_PHONE_LIKE;

async function current(): Promise<{ id: string; phone_number: string; first_name: string } | null> {
  const { rows } = await pool.query(LIVE_TEST_CANDIDATES_SQL);
  const r = pickLiveTestMember(rows as any[]);
  return r ? { id: r.id, phone_number: r.phone_number, first_name: r.first_name } : null;
}

async function reset(): Promise<void> {
  // One transaction: the old test member is archived only when the new one is created, so a failed reset leaves the current one in place.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const archived = await client.query(`UPDATE users SET archived_at = NOW() WHERE phone_number LIKE $1 AND archived_at IS NULL RETURNING phone_number`, [TEST_PHONE_LIKE]);
    const phones = (await client.query(`SELECT phone_number FROM users WHERE phone_number LIKE $1`, [TEST_PHONE_LIKE])).rows.map((r: any) => r.phone_number);
    const taken = (await client.query(`SELECT email, username FROM users WHERE email LIKE 'jordan.test%@example.test' OR username LIKE 'jordan_test_%'`)).rows;
    const slot = freeTestSlot(phones, taken.map((r: any) => r.email), taken.map((r: any) => r.username));
    if (!slot) throw new Error("all 100 test numbers are used; clear archived test members first");
    const { tag, phone } = slot;
    const { rows } = await client.query(
      `INSERT INTO users (first_name, last_name, email, phone_number, username, contact_verified, identity_captured, intake_asked, invite_verified, invite_asked)
       VALUES ('Jordan', 'Test', $1, $2, $3, true, true, true, true, true) RETURNING id`,
      [liveTestEmail(tag), phone, `jordan_test_${tag}`],
    );
    await client.query(`INSERT INTO co_profiles (user_id, city, updated_at) VALUES ($1, 'San Francisco', NOW()) ON CONFLICT (user_id) DO UPDATE SET city = EXCLUDED.city`, [rows[0].id]);
    await client.query("COMMIT");
    console.log(JSON.stringify({ archived: archived.rows.map((r: any) => r.phone_number), created: { id: rows[0].id, phone, name: "Jordan Test", city: "San Francisco" } }));
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
