// Changing a member's phone number by text (Royce, 2026-09-17 plan, built
// 2026-09-18). PUT /users/:id refuses phone_number changes (it had no
// verification at all), so this is the one way to change it:
//
//   1. From their current number: "change my number to 415 555 0123".
//   2. Co emails a 6-digit code to the email on their account, with the same
//      lock and resend cooldown as login codes (routes/accountRules.ts).
//   3. They text the code back from the current number; the number changes,
//      and Co confirms on the old number, so a change they didn't ask for is
//      seen there.
//
// Co can't text a number first (Sendblue only replies), so the member texts
// Co from the new number afterward. Covers the "still have the old phone"
// case; a lost phone still goes through the team.
import { randomInt } from "crypto";
import { findPhoneNumbersInText } from "libphonenumber-js";
import pool from "../db/db.js";
import { decideOtpIssue, decideOtpVerify, OTP_TTL_SECONDS, otpLockMinutes } from "../routes/accountRules.js";
import { recordDecision } from "../harness/core.js";
import { normalizePhone } from "../utils/phone.js";

// Only first-person asks about their own number: a match takes over the whole
// turn, so "any new events? my phone died" must never land here.
const CHANGE_INTENT = /\b(change|update|switch|swap|move)\s+(my|the)\s+(phone\s+|cell\s+)?(number|phone number|cell)\b|\bmy new (phone |cell )?number (is|will be)\b|\b(got|have|getting) a new (phone |cell )?number\b|\buse (this|my new|a new) (phone |cell )?number\b/i;

export type ChangeRequestParse = { intent: false } | { intent: true; newNumber: string | null };

// Pure: whether the text asks to change their number, and to what.
export function parseNumberChange(text: string): ChangeRequestParse {
  if (!CHANGE_INTENT.test(text)) return { intent: false };
  const found = findPhoneNumbersInText(text, "US")[0];
  return { intent: true, newNumber: found ? found.number.number : null };
}

// Pure: a bare 6-digit code.
export function parseCode(text: string): string | null {
  const m = text.trim().match(/^(\d{3})\s?-?\s?(\d{3})$/);
  return m ? `${m[1]}${m[2]}` : null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "your email";
  return `${local.slice(0, 1)}•••@${domain}`;
}

export const lastFour = (e164: string) => `•••${e164.slice(-4)}`;

type Member = { id: string; phone_number: string; email: string | null; first_name: string | null };
type Pending = { id: number; new_number: string; code: string | null; expires_at: Date | null; sent_at: Date | null; attempts: number; attempts_window_start: Date | null; locked: boolean; locked_at: Date | null; lock_count: number };

async function pendingFor(userId: string): Promise<Pending | null> {
  const { rows } = await pool.query(`SELECT * FROM phone_change_requests WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [userId]);
  const r = rows[0];
  if (!r) return null;
  return { ...r, id: Number(r.id), expires_at: r.expires_at ? new Date(r.expires_at) : null, sent_at: r.sent_at ? new Date(r.sent_at) : null, attempts_window_start: r.attempts_window_start ? new Date(r.attempts_window_start) : null, locked_at: r.locked_at ? new Date(r.locked_at) : null };
}

// Same generator as login codes (routes/auth.ts).
function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

async function emailCode(email: string, code: string, newNumber: string): Promise<void> {
  const { sendEmail } = await import("../otpActions.js");
  await sendEmail({ email, otp_code: code, phoneChange: { newNumberLast4: newNumber.slice(-4) } });
}

// Handles a phone-change text if this is one. Returns what Co should text
// back (and nothing else runs this turn), or null when it isn't about a
// number change.
export async function handlePhoneChange(member: Member, text: string, now = new Date()): Promise<string | null> {
  const pending = await pendingFor(member.id);
  const code = parseCode(text);

  // Step 3: the code, while a change is pending.
  if (pending && code) {
    const verify = decideOtpVerify(
      {
        storedCode: pending.code,
        expiresAt: pending.expires_at,
        sentAt: pending.sent_at,
        attempts: pending.attempts,
        attemptsWindowStart: pending.attempts_window_start,
        locked: pending.locked,
        lockedAt: pending.locked_at,
        lockCount: pending.lock_count,
      },
      code,
      now,
    );
    await pool.query(
      `UPDATE phone_change_requests SET attempts = $2, attempts_window_start = $3, lock_count = $4,
         locked = CASE WHEN $5 THEN true WHEN $6 THEN false ELSE locked END,
         locked_at = CASE WHEN $5 THEN NOW() WHEN $6 THEN NULL ELSE locked_at END,
         code = CASE WHEN $7 THEN NULL ELSE code END
       WHERE id = $1`,
      [pending.id, verify.attempts, verify.attemptsWindowStart, verify.lockCount, verify.lockNow, verify.clearExpiredLock, verify.clearCode],
    );
    const record = (action: string) =>
      recordDecision({ layer: 3, decision: "account.phoneChange", userId: member.id, outcome: action === "changed" ? "act" : "skip", action, checks: verify.checks, proposal: { to: lastFour(pending.new_number) } }).catch(() => {});
    if (verify.result === "verified") {
      // Checked again at the moment of change: the number may have been taken since.
      const taken = await pool.query(`SELECT 1 FROM users WHERE phone_number = $1 AND id <> $2`, [pending.new_number, member.id]);
      if (taken.rows.length) {
        await pool.query(`UPDATE phone_change_requests SET status = 'cancelled' WHERE id = $1`, [pending.id]);
        await record("taken_at_change");
        return "I can't move your account to that number. If you think that's wrong, email team@copatible.com.";
      }
      await pool.query(`UPDATE users SET phone_number = $2 WHERE id = $1`, [member.id, pending.new_number]);
      await pool.query(`UPDATE phone_change_requests SET status = 'done', completed_at = NOW() WHERE id = $1`, [pending.id]);
      await record("changed");
      return `Done, your number is now ${lastFour(pending.new_number)}. Text me from it to pick up where we left off. If you didn't ask for this, email team@copatible.com right away.`;
    }
    await record(verify.result);
    if (verify.result === "locked" || verify.lockNow) return `Too many wrong codes, so number changes are locked for ${otpLockMinutes(verify.lockCount || pending.lock_count)} minutes.`;
    if (verify.result === "expired") return "That code expired. Text \"change my number to\" and the new number again for a fresh one.";
    if (verify.result === "no_code") return "There's no code waiting. Text \"change my number to\" and the new number to get one.";
    return "That code didn't match. Check the email and try again.";
  }

  // Step 1: asking to change it.
  const ask = parseNumberChange(text);
  if (!ask.intent) return null;
  const record = (action: string, extra: Record<string, unknown> = {}) =>
    recordDecision({ layer: 3, decision: "account.phoneChange", userId: member.id, outcome: action === "code_sent" ? "act" : "skip", action, proposal: extra }).catch(() => {});
  if (!ask.newNumber) {
    await record("no_number");
    return "Sure. What's the new number? Text it like \"change my number to 415 555 0123\".";
  }
  const newNumber = normalizePhone(ask.newNumber);
  if (!/^\+\d{10,15}$/.test(newNumber)) {
    await record("invalid_number");
    return "That number doesn't look right. Send it again with the area code.";
  }
  if (newNumber === member.phone_number) {
    await record("same_number");
    return "That's already the number you're texting from, so nothing to change.";
  }
  if (!member.email) {
    await record("no_email");
    return "I need an email on your account to confirm a number change, and there isn't one. Email team@copatible.com and the team will switch it.";
  }
  const taken = await pool.query(`SELECT 1 FROM users WHERE phone_number = $1 AND id <> $2`, [newNumber, member.id]);
  if (taken.rows.length) {
    await record("taken");
    return "I can't move your account to that number. If you think that's wrong, email team@copatible.com.";
  }
  const issue = decideOtpIssue(
    { expiresAt: pending?.expires_at ?? null, sentAt: pending?.sent_at ?? null, locked: pending?.locked ?? false, lockedAt: pending?.locked_at ?? null, lockCount: pending?.lock_count ?? 0 },
    now,
  );
  if (!issue.send) {
    await record(issue.reason ?? "not_sent");
    return issue.reason === "cooldown" ? `I just emailed a code to ${maskEmail(member.email)}. Text it here when it lands.` : "Number changes are locked for a bit after too many wrong codes. Try again later.";
  }
  const fresh = generateCode();
  const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);
  // One pending change at a time; asking again replaces it but keeps the lock state.
  if (pending) {
    await pool.query(`UPDATE phone_change_requests SET new_number = $2, code = $3, expires_at = $4, sent_at = $5 WHERE id = $1`, [pending.id, newNumber, fresh, expiresAt, now]);
  } else {
    await pool.query(`INSERT INTO phone_change_requests (user_id, new_number, code, expires_at, sent_at) VALUES ($1, $2, $3, $4, $5)`, [member.id, newNumber, fresh, expiresAt, now]);
  }
  await emailCode(member.email, fresh, newNumber);
  await record("code_sent", { to: lastFour(newNumber) });
  return `I emailed a 6-digit code to ${maskEmail(member.email)}. Text it here in the next ${Math.round(OTP_TTL_SECONDS / 60)} minutes to switch your number to ${lastFour(newNumber)}.`;
}
