import pool from "../db/db.js";

// Text-to-sign-in for the co-test site (test.copatible.com). The login page
// opens iMessage prefilled with "Hi Co! (test site code: ABC12)". When that
// text arrives here, the code is claimed for the sender's number and the
// browser polling that code gets signed in. Texting first is also what
// co-test's inbound-only Sendblue plan requires before Co can text back.
//
// text_login_requests only exists in co-test's database (co-test's
// testMigrations.ts); in production this regex never matches a real text,
// and a missing table is caught.
//
// A code only counts from the number the browser typed when it asked for it
// (security review, 2026-10-12: any phone could claim any code, so a member
// talked into texting someone else's code signed that person in as them).
// Claiming never creates a users row: the normal text pipeline handles a
// new number, invite gate and all.
const CODE_RE = /\(?\s*test site code:?\s*([A-Z0-9]{5})\s*\)?/i;

// Per-phone claim rate limit (2026-09-17) — a faked/compromised webhook call
// (the real fix for that is Sendblue signature verification on the route
// that calls this, being added separately) could otherwise cycle through
// codes as fast as it likes trying to land a hit on someone else's pending
// login. The code itself is already single-use and expiry-bound (the UPDATE
// below only ever claims a row that's still `verified_at IS NULL AND
// expires_at > NOW()`, atomically, so two simultaneous claims for the same
// code can't both win) — this adds the missing piece: capping how many
// distinct claim attempts any one phone number gets in a window, in memory
// since co-test runs as a single instance and this only needs to survive
// one process's uptime, not a redeploy.
const CLAIM_ATTEMPT_LIMIT = 5;
const CLAIM_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const recentClaimAttempts = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(phoneNumber: string): boolean {
  const now = Date.now();
  const entry = recentClaimAttempts.get(phoneNumber);
  if (!entry || now - entry.windowStart > CLAIM_ATTEMPT_WINDOW_MS) {
    recentClaimAttempts.set(phoneNumber, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > CLAIM_ATTEMPT_LIMIT;
}

// Returns the message with the code removed, so the rest of the pipeline
// sees a normal "Hi Co!" and starts intake as usual.
export async function claimTextLogin(phoneNumber: string, content: string): Promise<string> {
  const m = content.match(CODE_RE);
  if (!m) return content;
  try {
    if (isRateLimited(phoneNumber)) {
      console.error(`claimTextLogin: rate limited ${phoneNumber} after too many code attempts.`);
      return content.replace(CODE_RE, " ").replace(/\s+/g, " ").trim() || "Hi Co!";
    }
    // Single-use, expiry-bound and bound to the number the browser typed, in
    // one atomic statement: claimed only by a text from that number, before
    // it expires, and never again after.
    await pool.query(
      `UPDATE text_login_requests SET phone_number = $1, verified_at = NOW()
       WHERE code = $2 AND expected_phone = $1 AND verified_at IS NULL AND expires_at > NOW()`,
      [phoneNumber, m[1].toUpperCase()],
    );
  } catch (err: any) {
    console.error("claimTextLogin failed (non-fatal):", err?.message ?? err);
  }
  return content.replace(CODE_RE, " ").replace(/\s+/g, " ").trim() || "Hi Co!";
}
