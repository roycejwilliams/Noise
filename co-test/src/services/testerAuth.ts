import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import pool from "../../../api/src/db/db.js";
import { normalizePhone } from "../../../api/src/utils/phone.js";
import { sendSMS } from "../../../api/src/otpActions.js";

// Tool-access login — proves a tester controls a real phone number before
// test.copatible.com shows them anything but the login form. Deliberately
// separate from phone.ts's own OTP step (which gates "request a real call"
// within the app, once already inside) — that step exists to test
// production's real text-in-first onboarding UX and is unchanged by this.
// This one just answers "should this browser be let in at all."
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OTP_LOCKOUT_ATTEMPTS = 5;

export async function startLogin(rawPhone: string): Promise<{ success: boolean; error?: string }> {
  const phone_number = normalizePhone(rawPhone);
  if (!phone_number || phone_number === rawPhone.trim()) {
    // normalizePhone falls back to the raw input on a parse failure — that's
    // the signal an invalid number was submitted, not a US number we just
    // failed to prettify.
    if (!/^\+\d{8,15}$/.test(phone_number)) {
      return { success: false, error: "Enter a valid phone number." };
    }
  }

  const existing = await pool.query(`SELECT id FROM users WHERE phone_number = $1`, [phone_number]);
  let userId: string;
  if (existing.rows[0]) {
    userId = existing.rows[0].id;
  } else {
    // contact_verified stays false here (the column's own schema default) —
    // this row is created the moment someone proves phone ownership to the
    // WEB TOOL, not by texting the Sendblue number. Those are different
    // facts: webhooks.ts's /phone flow keys its one-time welcome/intro
    // sequence off this same column for a row matched by the same
    // (phone_number, test_channel='phone') pair, and phone.ts's own
    // /resend-otp route gates on it too ("Text the number in first"). This
    // used to hardcode true, which silently satisfied both checks for
    // anyone who'd only ever logged into the tool — the welcome/intro
    // messages never fired on a real first text-in, no matter how many
    // times the test data was reset, since logging back in (required to
    // reach /phone at all) immediately recreated the row already
    // "verified."
    const suffix = Math.random().toString(36).slice(2, 8);
    const created = await pool.query(
      `INSERT INTO users (first_name, last_name, email, phone_number, username, test_channel, contact_verified)
       VALUES ('Tester', 'Tester', $1, $2, $3, 'phone', false) RETURNING id`,
      [`co-test-login-${suffix}@copatible.test`, phone_number, `co_test_login_${suffix}`],
    );
    userId = created.rows[0].id;
  }

  const otp = randomInt(100000, 1000000);
  await pool.query(
    `UPDATE users SET otp_code = $2, otp_expiry = NOW() + INTERVAL '5 minutes', otp_attempts = 0 WHERE id = $1`,
    [userId, otp],
  );

  // sendSMS catches its own errors internally and never throws (matches
  // every other Sendblue send in this codebase) — a delivery failure here
  // just means the tester never gets a code and retries "Send code".
  //
  // login: true is required, not decorative — sendSMS is one big if-chain
  // keyed entirely on boolean flags (login/register/resent/etc.); with none
  // set, it matches no branch, never calls Sendblue, and still resolves
  // successfully. Confirmed the hard way: this call used to omit it, so
  // /api/login/start always reported success with zero messages ever
  // reaching Sendblue's own API — not a delivery failure, a send that never
  // happened.
  await sendSMS({ phone_number, otp_code: otp.toString(), login: true });

  return { success: true };
}

export async function verifyLogin(
  rawPhone: string,
  otpCode: string,
): Promise<{ success: boolean; error?: string; sessionToken?: string }> {
  const phone_number = normalizePhone(rawPhone);

  const attemptsCheck = await pool.query(`SELECT id, otp_attempts FROM users WHERE phone_number = $1`, [
    phone_number,
  ]);
  const user = attemptsCheck.rows[0];
  if (!user) return { success: false, error: "Request a code first." };
  if (user.otp_attempts >= OTP_LOCKOUT_ATTEMPTS) {
    return { success: false, error: "Too many incorrect attempts — request a new code." };
  }

  const match = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND otp_code = $2 AND otp_expiry > NOW()`,
    [user.id, otpCode],
  );
  if (!match.rows[0]) {
    await pool.query(`UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1`, [user.id]);
    return { success: false, error: "Incorrect or expired code." };
  }

  const sessionToken = randomBytes(32).toString("hex");
  await pool.query(
    `UPDATE users
     SET otp_code = NULL, otp_expiry = NULL, otp_attempts = 0,
         login_session_token = $2, login_session_expiry = NOW() + INTERVAL '30 days'
     WHERE id = $1`,
    [user.id, sessionToken],
  );

  return { success: true, sessionToken };
}

export async function verifyTesterSession(token: string | undefined): Promise<{ userId: string } | null> {
  if (!token) return null;
  const result = await pool.query(
    `SELECT id, login_session_token FROM users WHERE login_session_token = $1 AND login_session_expiry > NOW()`,
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;
  // Belt-and-suspenders timing-safe compare — the DB lookup above is already
  // an exact match, but this avoids a length/content oracle on the token
  // itself if that query path ever changes to a prefix/LIKE lookup later.
  try {
    if (!timingSafeEqual(Buffer.from(row.login_session_token), Buffer.from(token))) return null;
  } catch {
    return null;
  }
  return { userId: row.id };
}

export async function logoutTester(userId: string): Promise<void> {
  await pool.query(
    `UPDATE users SET login_session_token = NULL, login_session_expiry = NULL WHERE id = $1`,
    [userId],
  );
}

// Self-service "start over" — deletes only the calling tester's own data,
// unlike dynamicPlacementTest.ts's resetRealTestUser (dashboard-only, wipes
// every real tester at once for the "hand it to the next person" flow).
// Logs the tester out too — their old row's identity is gone, so the
// session token pointing at it must go with it.
export async function resetOwnData(userId: string): Promise<{ success: boolean }> {
  await pool.query(`DELETE FROM moments WHERE creator_id = $1`, [userId]);
  await pool.query(`DELETE FROM circles WHERE owner_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  return { success: true };
}
