// Pure account decisions used by routes/auth.ts, routes/users.ts,
// routes/stripe.ts and middleware/auth.ts (2026-09-17 code review). No
// database, network or env access here, so evals/auth/rules.ts can check
// every rule without a model or a live service.

export type RuleCheck = { name: string; pass: boolean; reason?: string };

// ---- Stripe subscription status ---------------------------------------------

// users.subscription_status has a CHECK constraint allowing only these four
// (db/migrations.ts). The webhook used to write Stripe's raw status, so
// 'incomplete', 'trialing', 'unpaid', 'paused' or 'incomplete_expired' hit
// the constraint, the webhook 500ed, Stripe retried until it gave up, and a
// user who stopped paying stayed 'active'.
export const SUBSCRIPTION_STATUSES = ["active", "inactive", "past_due", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: "active",
  trialing: "active",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  incomplete_expired: "canceled",
  incomplete: "inactive",
  paused: "inactive",
};

// known=false means Stripe sent a status this map has never seen: the caller
// logs it and stores 'inactive' instead of failing the webhook.
export function mapStripeSubscriptionStatus(status: string | null | undefined): {
  status: SubscriptionStatus;
  known: boolean;
} {
  const mapped = status ? STRIPE_STATUS_MAP[status] : undefined;
  return mapped ? { status: mapped, known: true } : { status: "inactive", known: false };
}

// ---- One-time login codes ---------------------------------------------------

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_TTL_SECONDS = 300;
// Wrong guesses count across every code issued inside this window, so asking
// for a new code doesn't hand out five fresh guesses.
export const OTP_ATTEMPT_WINDOW_MINUTES = 60;
// Per account, server side. The app's own 30s button cooldown was the only
// limit before, and /auth/login had none at all.
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
// First lock is 15 minutes, doubling on each lock after that, capped at a
// day. A lock used to always lift after 15 minutes, which allowed ~480
// guesses a day forever.
export const OTP_BASE_LOCK_MINUTES = 15;
export const OTP_MAX_LOCK_MINUTES = 24 * 60;
// A lock more than this long ago no longer counts toward escalation.
export const OTP_LOCK_COUNT_RESET_DAYS = 7;

const MIN = 60 * 1000;

export type OtpAccountState = {
  storedCode: string | null;
  expiresAt: Date | null;
  // When the current code went out. Older rows only have expiresAt, so the
  // send time falls back to expiresAt - TTL.
  sentAt: Date | null;
  attempts: number;
  attemptsWindowStart: Date | null;
  locked: boolean;
  lockedAt: Date | null;
  lockCount: number;
};

export function otpLockMinutes(lockCount: number): number {
  const n = Math.max(1, Math.floor(lockCount));
  return Math.min(OTP_BASE_LOCK_MINUTES * 2 ** (n - 1), OTP_MAX_LOCK_MINUTES);
}

// A lock with no locked_at predates that column; it's treated as lifted, as
// before, rather than permanent.
export function otpLockedUntil(state: Pick<OtpAccountState, "locked" | "lockedAt" | "lockCount">): Date | null {
  if (!state.locked || !state.lockedAt) return null;
  return new Date(state.lockedAt.getTime() + otpLockMinutes(state.lockCount) * MIN);
}

export function isOtpLocked(state: Pick<OtpAccountState, "locked" | "lockedAt" | "lockCount">, now: Date): boolean {
  const until = otpLockedUntil(state);
  return !!until && now.getTime() < until.getTime();
}

export type OtpVerifyDecision = {
  result: "verified" | "wrong" | "expired" | "locked" | "no_code";
  // Values to write back. Unchanged from state for locked/no_code/expired.
  attempts: number;
  attemptsWindowStart: Date | null;
  lockCount: number;
  lockNow: boolean;
  // Wipe the stored code (on success, and when a lock starts so nobody keeps
  // guessing at it after the lock lifts).
  clearCode: boolean;
  // true only on the attempt that starts a lock, so the team is alerted once.
  alertTeam: boolean;
  // The previous lock has run out; clear locked before judging this attempt.
  clearExpiredLock: boolean;
  checks: RuleCheck[];
};

export function decideOtpVerify(state: OtpAccountState, submitted: string, now: Date): OtpVerifyDecision {
  const checks: RuleCheck[] = [];
  const locked = isOtpLocked(state, now);
  const clearExpiredLock = state.locked && !locked;
  const windowActive =
    !!state.attemptsWindowStart && now.getTime() - state.attemptsWindowStart.getTime() < OTP_ATTEMPT_WINDOW_MINUTES * MIN;
  const attempts = windowActive ? state.attempts : 0;
  const windowStart = windowActive ? state.attemptsWindowStart : null;
  const base = {
    attempts,
    attemptsWindowStart: windowStart,
    lockCount: state.lockCount,
    lockNow: false,
    clearCode: false,
    alertTeam: false,
    clearExpiredLock,
  };

  checks.push({ name: "not_locked", pass: !locked, reason: locked ? "account is locked" : undefined });
  if (locked) return { ...base, result: "locked", attempts: state.attempts, attemptsWindowStart: state.attemptsWindowStart, clearExpiredLock: false, checks };

  if (!state.storedCode || !state.expiresAt) {
    checks.push({ name: "code_issued", pass: false, reason: "no active code" });
    return { ...base, result: "no_code", checks };
  }

  const expired = state.expiresAt.getTime() <= now.getTime();
  const matches = String(submitted).trim() !== "" && String(submitted).trim() === String(state.storedCode).trim();
  checks.push({ name: "code_not_expired", pass: !expired, reason: expired ? "code expired" : undefined });
  checks.push({ name: "code_matches", pass: matches });

  if (matches && !expired) {
    return { ...base, result: "verified", attempts: 0, attemptsWindowStart: null, lockCount: 0, clearCode: true, checks };
  }
  // A correct-but-expired code isn't a guess; it doesn't count toward the lock.
  if (matches && expired) return { ...base, result: "expired", checks };

  const next = attempts + 1;
  const lockNow = next >= OTP_MAX_ATTEMPTS;
  if (!lockNow) {
    return { ...base, result: "wrong", attempts: next, attemptsWindowStart: windowStart ?? now, checks };
  }
  const recentLock =
    !!state.lockedAt && now.getTime() - state.lockedAt.getTime() < OTP_LOCK_COUNT_RESET_DAYS * 24 * 60 * MIN;
  const lockCount = (recentLock ? state.lockCount : 0) + 1;
  checks.push({ name: "attempts_left", pass: false, reason: `locked for ${otpLockMinutes(lockCount)} minutes` });
  return {
    ...base,
    result: "wrong",
    attempts: 0,
    attemptsWindowStart: null,
    lockCount,
    lockNow: true,
    clearCode: true,
    alertTeam: true,
    checks,
  };
}

export type OtpIssueDecision = {
  send: boolean;
  reason: "locked" | "cooldown" | null;
  checks: RuleCheck[];
};

// Whether /auth/login or /auth/send-otp may mint and send a new code.
// Issuing a code never resets attempts or the lock.
export function decideOtpIssue(
  state: Pick<OtpAccountState, "expiresAt" | "sentAt" | "locked" | "lockedAt" | "lockCount">,
  now: Date,
): OtpIssueDecision {
  const locked = isOtpLocked(state, now);
  const sentAt = state.sentAt ?? (state.expiresAt ? new Date(state.expiresAt.getTime() - OTP_TTL_SECONDS * 1000) : null);
  const tooSoon = !!sentAt && now.getTime() - sentAt.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000;
  const checks: RuleCheck[] = [
    { name: "not_locked", pass: !locked, reason: locked ? "account is locked" : undefined },
    { name: "resend_cooldown", pass: !tooSoon, reason: tooSoon ? "a code was sent under a minute ago" : undefined },
  ];
  if (locked) return { send: false, reason: "locked", checks };
  if (tooSoon) return { send: false, reason: "cooldown", checks };
  return { send: true, reason: null, checks };
}

// ---- Session tokens ---------------------------------------------------------

// Was a year with no way to revoke one.
export const TOKEN_LIFETIME_DAYS = 30;

// users.token_version goes up on logout and on an OTP lock; a token carrying
// an older version is refused. Tokens issued before the tv claim existed are
// treated as version 0, so they keep working until the first bump.
export function tokenVersionValid(claim: unknown, current: number | null | undefined): boolean {
  const tokenVersion = claim === undefined || claim === null ? 0 : Number(claim);
  return Number.isInteger(tokenVersion) && tokenVersion === (current ?? 0);
}

// ---- User fields ------------------------------------------------------------

// What the users routes may send back. Never otp_code, otp_expiry, lock
// state, token_version or stripe_customer_id (PUT used to return RETURNING *).
export const SAFE_USER_FIELDS = [
  "id",
  "username",
  "created_at",
  "first_name",
  "last_name",
  "description",
  "email",
  "phone_number",
  "location",
  "instagram",
  "twitter",
  "linkedin",
  "role",
  "profile_image",
] as const;

export function pickSafeUser(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SAFE_USER_FIELDS) if (key in row) out[key] = row[key];
  return out;
}

// phone_number is not updatable here (2026-09-17): nothing verified the new
// number, so an account could be pointed at someone else's phone and Co's
// texts and calls would go to them. A number change needs a verification flow.
export const UPDATABLE_USER_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "description",
  "username",
  "location",
  "instagram",
  "twitter",
  "linkedin",
  "profile_image",
] as const;

// Returns null when the body has no updatable field, so the route can 400
// instead of running "UPDATE users SET  WHERE ..." (a 500).
export function buildUserUpdate(body: unknown): { columns: string[]; values: unknown[] } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const columns = UPDATABLE_USER_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(b, key) && b[key] !== undefined);
  if (columns.length === 0) return null;
  return { columns: [...columns], values: columns.map((key) => b[key]) };
}
