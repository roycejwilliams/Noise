import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import pool from "../../../api/src/db/db.js";
import { matchablePhone } from "../../../api/src/utils/phone.js";
import { archiveAccount } from "./accountArchive.js";

// Tool-access login: text-to-sign-in. The page asks for a short code, opens
// iMessage prefilled with it, and polls until the text arrives. The inbound
// webhook (api/src/services/textLogin.ts) claims the code for the sending
// number, which proves the tester controls that phone. No phone form, no
// outbound OTP, which co-test's inbound-only Sendblue plan couldn't send to
// a number that hadn't texted Co first anyway.
//
// The code is bound to a number (security review, 2026-10-12): the browser
// types its phone number first, and the code only counts when it arrives
// from that number. Before, whichever phone texted a code signed the
// browser that asked for it in, so anyone could start a sign-in and talk a
// member into texting their code. The number typed is never checked
// against members here, so the page never says who is one.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_REQUEST_TTL_MINUTES = 15;
// No 0/O/1/I so a code typed by hand on desktop isn't ambiguous.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// The number a browser says it will text from, in the form Sendblue sends (E.164), or null.
export function loginPhone(raw: unknown): string | null {
  return typeof raw === "string" && raw.length <= 40 ? matchablePhone(raw) : null;
}

export async function startTextLogin(phoneRaw: unknown): Promise<{ token: string; code: string; textInNumber: string } | { error: string }> {
  const phone = loginPhone(phoneRaw);
  if (!phone) return { error: "Enter the phone number you'll text from." };
  const token = randomBytes(32).toString("hex");
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const { rowCount } = await pool.query(
      `INSERT INTO text_login_requests (token, code, expires_at, expected_phone)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, $4)
       ON CONFLICT (code) DO NOTHING`,
      [token, code, LOGIN_REQUEST_TTL_MINUTES, phone],
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

  // Only an existing, invited member signs in. A login never creates a users
  // row (security review, 2026-10-12: it used to, for any number, which
  // walked around the invite gate). A number that's new to Co gets its row
  // from the normal text pipeline and is asked for an invite code there;
  // once that's redeemed, this poll finds them.
  const user = (
    await pool.query(`SELECT id FROM users WHERE phone_number = $1 AND invite_verified = true AND archived_at IS NULL`, [req.phone_number])
  ).rows[0];
  if (!user) return { status: new Date(req.expires_at) < new Date() ? "expired" : "pending" };

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
// "Start over" sets the account aside instead of deleting it (2026-09-19):
// deleting cascaded to all of a tester's history, and co-test has no backups.
export async function resetOwnData(userId: string): Promise<{ success: boolean }> {
  await archiveAccount(userId);
  return { success: true };
}
