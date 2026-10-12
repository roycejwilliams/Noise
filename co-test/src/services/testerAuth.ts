import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
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

// After the text arrives, Co texts the member back a one-time code that must
// be typed into this same browser (security review, 2026-10-12: anyone could
// type a member's number and talk them into texting the first code, and a
// teammate's sign-in reaches every member's thread). The code goes only to
// the member's own phone, so whoever holds the browser has to hold the phone
// too. Test numbers are logged, never sent (services/sendblue.ts).
const CONFIRM_TTL_MINUTES = 10;
const CONFIRM_MAX_ATTEMPTS = 5;
export const confirmText = (code: string) =>
  `Your Co test dashboard sign-in code is ${code}. If you didn't just try to sign in, ignore this and don't share it with anyone.`;
const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");
type Send = (to: string, content: string) => Promise<unknown>;
const defaultSend: Send = async (to, content) => {
  const { default: sendblue } = await import("../../../api/src/services/sendblue.js");
  return sendblue.messages.send({ number: to, content, from_number: process.env.SENDBLUE_PHONE_NUMBER! } as any);
};

async function memberFor(phone: string): Promise<{ id: string } | null> {
  // Only an existing, invited member signs in. A login never creates a users
  // row (security review, 2026-10-12: it used to, for any number, which
  // walked around the invite gate). A number that's new to Co gets its row
  // from the normal text pipeline and is asked for an invite code there;
  // once that's redeemed, this poll finds them.
  return (await pool.query(`SELECT id FROM users WHERE phone_number = $1 AND invite_verified = true AND archived_at IS NULL`, [phone])).rows[0] ?? null;
}

// Polled by the browser. "pending" until the text arrives (and the number is
// an invited member), then "confirm" once Co has texted the one-time code.
export async function checkTextLogin(token: string, send: Send = defaultSend): Promise<{ status: "pending" | "expired" | "confirm" }> {
  const { rows } = await pool.query(
    `SELECT phone_number, verified_at, expires_at, confirm_hash, confirm_expires_at FROM text_login_requests WHERE token = $1`,
    [token],
  );
  const req = rows[0];
  if (!req) return { status: "expired" };
  const expired = new Date(req.expires_at) < new Date();
  if (!req.verified_at) return { status: expired ? "expired" : "pending" };
  if (req.confirm_hash) return { status: new Date(req.confirm_expires_at) < new Date() ? "expired" : "confirm" };
  if (!(await memberFor(req.phone_number))) return { status: expired ? "expired" : "pending" };
  if (expired) return { status: "expired" };

  // One code per request, claimed atomically so two polls can't both send.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const { rowCount } = await pool.query(
    `UPDATE text_login_requests SET confirm_hash = $2, confirm_expires_at = NOW() + ($3 || ' minutes')::interval, confirm_attempts = 0
     WHERE token = $1 AND confirm_hash IS NULL`,
    [token, hashCode(code), CONFIRM_TTL_MINUTES],
  );
  if (!rowCount) return { status: "confirm" };
  try {
    await send(req.phone_number, confirmText(code));
  } catch (err: any) {
    console.error("checkTextLogin: confirm code not sent:", err?.message ?? err);
    await pool.query(`DELETE FROM text_login_requests WHERE token = $1`, [token]);
    return { status: "expired" };
  }
  return { status: "confirm" };
}

// The code Co texted, typed into the browser that started the sign-in.
export async function confirmTextLogin(token: string, codeRaw: unknown): Promise<{ status: "signed_in"; sessionToken: string } | { status: "wrong" | "expired" }> {
  const code = typeof codeRaw === "string" ? codeRaw.replace(/\D/g, "") : "";
  // Counts the attempt first, atomically; a request past its attempts or its expiry is gone.
  const { rows } = await pool.query(
    `UPDATE text_login_requests SET confirm_attempts = confirm_attempts + 1
     WHERE token = $1 AND confirm_hash IS NOT NULL AND confirm_expires_at > NOW() AND confirm_attempts < $2
     RETURNING phone_number, confirm_hash`,
    [token, CONFIRM_MAX_ATTEMPTS],
  );
  const req = rows[0];
  if (!req) {
    await pool.query(`DELETE FROM text_login_requests WHERE token = $1`, [token]);
    return { status: "expired" };
  }
  const a = Buffer.from(hashCode(code)), b = Buffer.from(String(req.confirm_hash));
  if (code.length !== 6 || a.length !== b.length || !timingSafeEqual(a, b)) return { status: "wrong" };
  const user = await memberFor(req.phone_number);
  if (!user) return { status: "expired" };

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
