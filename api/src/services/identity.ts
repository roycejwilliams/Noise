import pool from "../db/db.js";

// Reserved domain for placeholder emails on a users row created before we
// actually know someone's real email — never meant to receive mail. Both
// api/src/routes/sendblue.ts and co-test's own webhooks.ts check against
// this to tell "not captured yet" apart from a real address.
export const PENDING_EMAIL_DOMAIN = "@copatible.pending";

export function hasPendingEmail(email: string): boolean {
  return email.endsWith(PENDING_EMAIL_DOMAIN);
}

// Finds the user row for a phone number, creating a bare placeholder if this
// number has never been seen before. CoPatible no longer collects name/email
// through a separate form (Framer or otherwise) before someone starts
// texting Co, so a brand-new number can't wait for a pre-populated row —
// but users.first_name/last_name/email/username are all NOT NULL, and
// email/username are UNIQUE, so a placeholder row needs throwaway-but-valid
// values until the real ones are known. identity_captured and intake_asked
// (both default true on the column, explicitly false only here) are what
// actually track collection progress — the placeholder values themselves are
// never read as real data anywhere.
export async function findOrCreateUserByPhone(phoneNumber: string): Promise<any> {
  const existing = await pool.query(`SELECT * FROM users WHERE phone_number = $1`, [phoneNumber]);
  if (existing.rows[0]) return existing.rows[0];

  // Co is referral-only (2026-09-17) — a brand-new number starts
  // unverified and gets asked for an invite code before intake begins
  // (routes/sendblue.ts). Same false-only-on-placeholder-creation
  // convention as identity_captured/intake_asked below.
  const suffix = Math.random().toString(36).slice(2, 10);
  const created = await pool.query(
    `INSERT INTO users (first_name, last_name, email, phone_number, username, contact_verified, identity_captured, intake_asked, invite_verified, invite_asked)
     VALUES ('', '', $1, $2, $3, true, false, false, false, false)
     RETURNING *`,
    [`pending-${suffix}${PENDING_EMAIL_DOMAIN}`, phoneNumber, `pending_${suffix}`],
  );
  return created.rows[0];
}

export function splitFullName(fullName: string): { first_name: string; last_name: string } {
  const [first_name, ...rest] = fullName.trim().split(/\s+/);
  return { first_name, last_name: rest.join(" ") };
}
