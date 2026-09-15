import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import pool from "../../../api/src/db/db.js";

// Tool-access login: text-to-sign-in. The page asks for a short code, opens
// iMessage prefilled with it, and polls until the text arrives. The inbound
// webhook (api/src/services/textLogin.ts) claims the code for the sending
// number, which proves the tester controls that phone. No phone form, no
// outbound OTP, which co-test's inbound-only Sendblue plan couldn't send to
// a number that hadn't texted Co first anyway.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_REQUEST_TTL_MINUTES = 15;
// No 0/O/1/I so a code typed by hand on desktop isn't ambiguous.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function startTextLogin(): Promise<{ token: string; code: string; textInNumber: string }> {
  const token = randomBytes(32).toString("hex");
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const { rowCount } = await pool.query(
      `INSERT INTO text_login_requests (token, code, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)
       ON CONFLICT (code) DO NOTHING`,
      [token, code, LOGIN_REQUEST_TTL_MINUTES],
    );
    if (rowCount) return { token, code, textInNumber: process.env.SENDBLUE_PHONE_NUMBER ?? "" };
  }
  throw new Error("Couldn't create a sign-in code.");
}

// Signs the browser in once its code has been texted in. Returns a session
// token, "pending" while waiting, or "expired".
export async function checkTextLogin(token: string): Promise<{ status: "pending" | "expired" } | { status: "signed_in"; sessionToken: string }> {
  const { rows } = await pool.query(
    `SELECT phone_number, verified_at, expires_at FROM text_login_requests WHERE token = $1`,
    [token],
  );
  const req = rows[0];
  if (!req) return { status: "expired" };
  if (!req.verified_at) return { status: new Date(req.expires_at) < new Date() ? "expired" : "pending" };

  // claimTextLogin already created the user if the number was new.
  const user = (await pool.query(`SELECT id FROM users WHERE phone_number = $1`, [req.phone_number])).rows[0];
  if (!user) return { status: "pending" };

  const sessionToken = randomBytes(32).toString("hex");
  await pool.query(
    `UPDATE users
     SET login_session_token = $2, login_session_expiry = NOW() + ($3 || ' milliseconds')::interval,
         test_channel = 'phone'
     WHERE id = $1`,
    [user.id, sessionToken, SESSION_TTL_MS],
  );
  await pool.query(`DELETE FROM text_login_requests WHERE token = $1 OR expires_at < NOW() - INTERVAL '1 day'`, [token]);
  return { status: "signed_in", sessionToken };
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
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  return { success: true };
}
