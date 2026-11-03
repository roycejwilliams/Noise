// Layer 1 harness: identity intake over text, and the OTP / lock path.
//
// gather   gatherIntakeState reads what's already on file, including a
//          partial email saved from an earlier turn
// propose  a Haiku extraction proposes name / email (narrow, code-checked)
// gate     decideIntake: email format, email not on another account, never
//          re-ask a field already on file, retry cap
// record   recordDecision(layer 1, "intake.identity")
//
// decideIntake and decideOtpAttempt are pure so evals/intake runs them
// without a database or a model.
import pool from "../db/db.js";
import { hasPendingEmail } from "../services/identity.js";
import type { GateCheck, Outcome } from "./core.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";

// Narrow extraction checked by code below, so Haiku (Royce's model policy).
export const INTAKE_EXTRACT_MODEL = MODELS.haiku;

// After this many retry messages in a row without capturing identity, Co
// stops asking the same way and explains in one plain line why it needs it.
// (Since 2026-11-02 the text door sends none of these: decideIntake still gates what's captured, and the reply asks once,
// intakeAskFor below.)
export const INTAKE_MAX_RETRIES = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function isValidEmail(email: string | null | undefined): email is string {
  return !!email && EMAIL_RE.test(email.trim()) && !hasPendingEmail(email.trim());
}

// The email has to be in what they actually wrote (spoken forms like
// "alex at gmail dot com" count). Stops the model filling in an address
// from a name.
export function emailAppearsInReply(email: string, reply: string): boolean {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/\s*\(?\bat\b\)?\s*/g, "@")
      .replace(/\s*\(?\bdot\b\)?\s*/g, ".")
      .replace(/\s+/g, "");
  const e = email.trim().toLowerCase();
  return reply.toLowerCase().includes(e) || norm(reply).includes(e);
}

export type IntakeState = {
  userId: string;
  knownName: string | null;
  // A real email already on the users row (not the placeholder).
  knownEmail: string | null;
  // A valid email sent earlier on its own, before the name. Held here
  // because users.email is UNIQUE and only written together with the name.
  partialEmail: string | null;
  // Consecutive retry messages already sent.
  retries: number;
  lastCoLine: string | null;
};

export type IntakeProposal = {
  full_name: string | null;
  email: string | null;
  is_acknowledgment?: boolean;
};

export type IntakeDecision = {
  outcome: Outcome;
  action: "capture" | "ask";
  name: string | null;
  email: string | null;
  // Valid email to hold for a later turn (only set when not capturing).
  savePartialEmail: string | null;
  // What to ask for when action is "ask".
  missing: ("name" | "email")[];
  reply: string | null;
  checks: GateCheck[];
  reason: string;
};

const RETRY_LINES = {
  both_ack: ["Of course. What's your full name and email?", "Glad you're here. What name and email should I use for you?"],
  both: [
    "Before we get into it, what's your full name and email?",
    "I want to hear about that. First, what name and email should I have for you?",
    "Let's get you set up first. What's your full name and email?",
  ],
  email_invalid: ["That email didn't look quite right. Mind double-checking it?", "I think that email has a typo. Can you send it again?"],
  email_taken: [
    "That email is already on another account. Is there a different one you use?",
    "Looks like that email's already on file. Mind sending a different one?",
  ],
  email_only: ["Got your name. What's the best email for you?", "Thanks. What email should I use for you?"],
  name_only: ["Got your email. What's your full name?", "Thanks for that. And your full name?"],
  explain_both: [
    "I only use your name and email to set up your account and send you event details. What's your full name and email?",
    "Quick reason I'm asking: your name and email are how I set you up and send things like event links. What are they?",
  ],
  explain_email: [
    "I only use your email to send you things like event links and details. What's the best one for you?",
    "Your email is how I send event links and details, nothing else. Which one should I use?",
  ],
  explain_name: [
    "I just need your name so I know what to call you and can set you up. What's your full name?",
    "Your name is how I set you up and what I'll call you. What is it?",
  ],
} as const;

export function pickFresh(options: readonly string[], lastCoLine: string | null, seed = Math.random()): string {
  const fresh = options.filter((o) => o !== lastCoLine);
  const pool = fresh.length ? fresh : options;
  return pool[Math.floor(seed * pool.length) % pool.length];
}

export function decideIntake(
  state: IntakeState,
  proposal: IntakeProposal,
  opts: { emailTakenByOtherAccount: boolean; seed?: number; replyText?: string | null },
): IntakeDecision {
  const checks: GateCheck[] = [];
  let proposedEmail = proposal.email?.trim() || null;
  if (proposedEmail && typeof opts.replyText === "string" && !emailAppearsInReply(proposedEmail, opts.replyText)) {
    checks.push({ name: "email_in_reply", pass: false, reason: `"${proposedEmail}" isn't in what they wrote` });
    proposedEmail = null;
  }
  const proposedEmailValid = isValidEmail(proposedEmail);
  checks.push({
    name: "email_format",
    pass: !proposedEmail || proposedEmailValid,
    reason: proposedEmail && !proposedEmailValid ? `"${proposedEmail}" isn't a valid email` : undefined,
  });

  const emailTaken = proposedEmailValid && opts.emailTakenByOtherAccount;
  checks.push({
    name: "email_not_on_other_account",
    pass: !emailTaken,
    reason: emailTaken ? "that email belongs to another account" : undefined,
  });

  // Fields already on file win over anything the model didn't actually get
  // this turn; a newly proposed valid value can still correct them.
  const proposedName = proposal.full_name?.trim() || null;
  const nameInReply =
    !proposedName ||
    typeof opts.replyText !== "string" ||
    proposedName.split(/\s+/).every((part) => opts.replyText!.toLowerCase().includes(part.toLowerCase()));
  if (!nameInReply) checks.push({ name: "name_in_reply", pass: false, reason: `"${proposedName}" isn't in what they wrote` });
  const name = (nameInReply ? proposedName : null) || state.knownName || null;
  const email = (proposedEmailValid && !emailTaken ? proposedEmail : null) ?? state.knownEmail ?? state.partialEmail ?? null;

  if (name && email) {
    return {
      outcome: "act",
      action: "capture",
      name,
      email,
      savePartialEmail: null,
      missing: [],
      reply: null,
      checks,
      reason: "name and a valid, unused email are both on hand",
    };
  }

  const missing: ("name" | "email")[] = [];
  if (!name) missing.push("name");
  if (!email) missing.push("email");

  const overCap = state.retries >= INTAKE_MAX_RETRIES;
  checks.push({
    name: "retry_cap",
    pass: !overCap,
    reason: overCap ? `already asked ${state.retries} times; explaining why instead of repeating` : undefined,
  });

  let lines: readonly string[];
  if (emailTaken) lines = RETRY_LINES.email_taken;
  else if (proposedEmail && !proposedEmailValid) lines = RETRY_LINES.email_invalid;
  else if (overCap) lines = missing.length === 2 ? RETRY_LINES.explain_both : missing[0] === "email" ? RETRY_LINES.explain_email : RETRY_LINES.explain_name;
  else if (missing.length === 2) lines = proposal.is_acknowledgment ? RETRY_LINES.both_ack : RETRY_LINES.both;
  else lines = missing[0] === "email" ? RETRY_LINES.email_only : RETRY_LINES.name_only;

  return {
    outcome: "ask",
    action: "ask",
    name,
    email: null,
    savePartialEmail: proposedEmailValid && !emailTaken && !name ? proposedEmail : null,
    missing,
    reply: pickFresh(lines, state.lastCoLine, opts.seed),
    checks,
    reason: `still missing ${missing.join(" and ")}`,
  };
}

// ---- ruling A: Cue answers while it collects ---------------------------------
// Royce, 2026-10-14 ruling A ("the hostage version dies, the requirement stays"), shipped 2026-11-02 (onboarding ruling 3): name
// and email are still required, but asked once, inside the conversation, while Cue keeps answering. Every text a new member sends
// is answered by the reply agent; nothing waits on name or email. What the extraction finds is saved whenever it comes. The ask
// is an instruction to the reply (Cue's own words, never a set line), given until a reply that went out asked it once
// (users.intake_retries counts asks made, by text or on a call; the retry lines above are no longer sent).

// Pure: what the reply should ask for this turn: the fields not on file, only while nothing has asked yet.
export function intakeAskFor(o: { knownName: string | null; knownEmail: string | null; partialEmail: string | null; asked: boolean }): ("name" | "email")[] {
  if (o.asked) return [];
  const missing: ("name" | "email")[] = [];
  if (!o.knownName) missing.push("name");
  if (!o.knownEmail && !o.partialEmail) missing.push("email");
  return missing;
}

// Pure: an email they just sent that can't be used, from the gate's checks (the extraction saw one in their words).
export function intakeCorrection(d: Pick<IntakeDecision, "checks">): "email_taken" | "email_invalid" | null {
  if (d.checks.some((c) => c.name === "email_not_on_other_account" && !c.pass)) return "email_taken";
  if (d.checks.some((c) => c.name === "email_format" && !c.pass)) return "email_invalid";
  return null;
}

// Pure: the reply's instruction for the ask and any correction. Guidance, never a line to send.
export function intakeInstruction(ask: ("name" | "email")[], correction: "email_taken" | "email_invalid" | null): string | null {
  const parts: string[] = [];
  if (correction === "email_invalid") parts.push("The email they just sent doesn't look complete: after answering anything else they said, say so in a few words, once.");
  if (correction === "email_taken") parts.push("The email they just sent is already on another account: after answering anything else they said, say so in a few words and ask if there's another one they use.");
  if (ask.length) {
    const what = ask.length === 2 ? "full name and email" : ask[0] === "name" ? "full name" : "email";
    parts.push(`Their ${what} ${ask.length === 2 ? "aren't" : "isn't"} on file yet. Once, after you've answered what they said, ask for their ${what} in a few words, and say why in a few words: it's how Cue sets them up and sends them things like event details. It's never a condition: help them fully either way, don't hold anything back for it, and if they skip it, leave it. When this reply's move is close, feeling or quiet, leave the ask for a later reply.`);
  }
  return parts.length ? parts.join(" ") : null;
}

// Pure: whether a reply that went out asked for what was missing (so it's never asked again).
export function replyAskedFor(ask: ("name" | "email")[], replyText: string | null | undefined): boolean {
  if (!ask.length || !replyText) return false;
  return ask.includes("email") ? /\be-?mail\b/i.test(replyText) : /\bname\b/i.test(replyText);
}

export function buildIntakeExtractionPrompt(state: Pick<IntakeState, "knownName" | "knownEmail" | "partialEmail">, reply: string | null): string {
  return `Cue asked a new contact for their full name and email. Extract what's in their reply.

Already known — name: ${state.knownName ?? "not yet given"}, email: ${state.knownEmail ?? state.partialEmail ?? "not yet given"}

Their reply: "${reply ?? "[no text — sent a photo or voice memo instead]"}"

Return ONLY strict JSON: {"full_name": string or null, "email": string or null, "is_acknowledgment": boolean}. Only set full_name/email when this reply actually contains them — don't repeat an already-known value and don't guess at a missing one. A first name alone counts as a name. Set is_acknowledgment true when the reply is just a social acknowledgment of Cue's welcome (e.g. "thanks", "ok", "sounds good") with no attempt to give a name or email — false otherwise, including when they did attempt an answer that just didn't parse.`;
}

export function parseIntakeProposal(raw: string): IntakeProposal {
  const parsed = parseModelJson(raw);
  return {
    full_name: typeof parsed?.full_name === "string" && parsed.full_name.trim() ? parsed.full_name.trim() : null,
    email: typeof parsed?.email === "string" && parsed.email.trim() ? parsed.email.trim() : null,
    is_acknowledgment: parsed?.is_acknowledgment === true,
  };
}

// Both parts: a name saved as "Sam" + "Rivera" is "Sam Rivera" (2026-10-01
// next-live run: the email turn re-read it as "Sam" and blanked the last name).
export function knownNameOf(u: { first_name?: string | null; last_name?: string | null }): string | null {
  return [u.first_name, u.last_name].map((x) => x?.trim()).filter(Boolean).join(" ") || null;
}

export async function gatherIntakeState(user: {
  id: string;
  first_name: string | null;
  last_name?: string | null;
  email: string;
  intake_partial_email?: string | null;
  intake_retries?: number | null;
}): Promise<IntakeState> {
  const lastCo = await pool
    .query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'Co replied:%' ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    )
    .catch(() => ({ rows: [] as { content: string }[] }));
  return {
    userId: user.id,
    knownName: knownNameOf(user),
    knownEmail: user.email && !hasPendingEmail(user.email) ? user.email : null,
    partialEmail: user.intake_partial_email ?? null,
    retries: user.intake_retries ?? 0,
    lastCoLine: lastCo.rows[0]?.content?.replace(/^Co replied: /, "") ?? null,
  };
}

export async function isEmailOnOtherAccount(email: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2 LIMIT 1`, [email.trim(), userId]);
  return rows.length > 0;
}

// ---- OTP / lock ------------------------------------------------------------

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LOCK_MINUTES = 15;
// A resend inside this window returns the existing code's success without
// minting and texting a new one.
export const OTP_RESEND_COOLDOWN_SECONDS = 30;
export const OTP_TTL_SECONDS = 300;

export type OtpState = {
  storedCode: string | null;
  expiresAt: Date | null;
  attempts: number;
  locked: boolean;
  lockedAt: Date | null;
};

export type OtpDecision = {
  result: "verified" | "wrong" | "expired" | "locked" | "no_code";
  // Attempt count to write back (unchanged for verified/locked/no_code).
  attempts: number;
  lockNow: boolean;
  // true only on the attempt that transitions the account into a lock, so
  // the team is alerted once per lock.
  alertTeam: boolean;
  // A lock that has run its course is cleared before judging this attempt.
  clearExpiredLock: boolean;
  checks: GateCheck[];
};

export function decideOtpAttempt(state: OtpState, submitted: string, now: Date): OtpDecision {
  const checks: GateCheck[] = [];
  const lockExpired =
    state.locked && (!state.lockedAt || now.getTime() - state.lockedAt.getTime() >= OTP_LOCK_MINUTES * 60 * 1000);
  const locked = state.locked && !lockExpired;
  const attempts = lockExpired ? 0 : state.attempts;
  checks.push({ name: "not_locked", pass: !locked, reason: locked ? "account is locked" : undefined });
  if (locked) return { result: "locked", attempts, lockNow: false, alertTeam: false, clearExpiredLock: false, checks };

  if (!state.storedCode || !state.expiresAt) {
    checks.push({ name: "code_issued", pass: false, reason: "no active code" });
    return { result: "no_code", attempts, lockNow: false, alertTeam: false, clearExpiredLock: lockExpired, checks };
  }

  const expired = state.expiresAt.getTime() <= now.getTime();
  const matches = String(submitted).trim() === String(state.storedCode).trim();
  checks.push({ name: "code_not_expired", pass: !expired, reason: expired ? "code expired" : undefined });
  checks.push({ name: "code_matches", pass: matches });

  if (matches && !expired) {
    return { result: "verified", attempts: 0, lockNow: false, alertTeam: false, clearExpiredLock: lockExpired, checks };
  }
  // A correct-but-expired code isn't a guess; it doesn't count toward the lock.
  if (matches && expired) {
    return { result: "expired", attempts, lockNow: false, alertTeam: false, clearExpiredLock: lockExpired, checks };
  }
  const next = attempts + 1;
  const lockNow = next >= OTP_MAX_ATTEMPTS;
  return { result: "wrong", attempts: next, lockNow, alertTeam: lockNow, clearExpiredLock: lockExpired, checks };
}

export function decideOtpResend(state: { expiresAt: Date | null; locked: boolean; lockedAt: Date | null }, now: Date): {
  send: boolean;
  checks: GateCheck[];
} {
  const locked = state.locked && !!state.lockedAt && now.getTime() - state.lockedAt.getTime() < OTP_LOCK_MINUTES * 60 * 1000;
  const issuedAgoMs = state.expiresAt ? now.getTime() - (state.expiresAt.getTime() - OTP_TTL_SECONDS * 1000) : Infinity;
  const tooSoon = issuedAgoMs < OTP_RESEND_COOLDOWN_SECONDS * 1000;
  const checks: GateCheck[] = [
    { name: "not_locked", pass: !locked, reason: locked ? "account is locked" : undefined },
    { name: "resend_cooldown", pass: !tooSoon, reason: tooSoon ? "a code was sent seconds ago" : undefined },
  ];
  return { send: !locked && !tooSoon, checks };
}
