import pool from "../db/db.js";
import { findOrCreateUserByPhone } from "./identity.js";

// Text-to-sign-in for the co-test site (test.copatible.com). The login page
// opens iMessage prefilled with "Hi Co! (test site code: ABC12)". When that
// text arrives here, the code is claimed for the sender's number and the
// browser polling that code gets signed in. Texting first is also what
// co-test's inbound-only Sendblue plan requires before Co can text back.
//
// text_login_requests only exists in co-test's database (co-test's
// testMigrations.ts); in production this regex never matches a real text,
// and a missing table is caught.
const CODE_RE = /\(?\s*test site code:?\s*([A-Z0-9]{5})\s*\)?/i;

// Returns the message with the code removed, so the rest of the pipeline
// sees a normal "Hi Co!" and starts intake as usual.
export async function claimTextLogin(phoneNumber: string, content: string): Promise<string> {
  const m = content.match(CODE_RE);
  if (!m) return content;
  try {
    const { rows } = await pool.query(
      `UPDATE text_login_requests SET phone_number = $1, verified_at = NOW()
       WHERE code = $2 AND verified_at IS NULL AND expires_at > NOW()
       RETURNING code`,
      [phoneNumber, m[1].toUpperCase()],
    );
    // Created here, before the normal pipeline runs, so the browser's poll
    // and the webhook both find the same row instead of racing to create one.
    if (rows[0]) await findOrCreateUserByPhone(phoneNumber);
  } catch (err: any) {
    console.error("claimTextLogin failed (non-fatal):", err?.message ?? err);
  }
  return content.replace(CODE_RE, " ").replace(/\s+/g, " ").trim() || "Hi Co!";
}
