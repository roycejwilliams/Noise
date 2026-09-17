// Model-free tests for src/routes/accountRules.ts (2026-09-17 code review):
// the pure decisions behind Stripe status mapping, OTP resend/lock timing,
// and which user fields are safe to read or write. No database, network or
// model call — every case here is a plain function call, so this runs in
// CI on every push with no live dependency and no flakiness budget.
//
//   npx tsx evals/auth/rules.ts
import {
  SAFE_USER_FIELDS,
  UPDATABLE_USER_FIELDS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_LOCK_COUNT_RESET_DAYS,
  buildUserUpdate,
  decideOtpIssue,
  decideOtpVerify,
  isOtpLocked,
  mapStripeSubscriptionStatus,
  otpLockMinutes,
  pickSafeUser,
  tokenVersionValid,
  type OtpAccountState,
} from "../../src/routes/accountRules.js";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---- mapStripeSubscriptionStatus -------------------------------------------

eq("stripe active -> active", mapStripeSubscriptionStatus("active"), { status: "active", known: true });
eq("stripe trialing -> active", mapStripeSubscriptionStatus("trialing"), { status: "active", known: true });
eq("stripe past_due -> past_due", mapStripeSubscriptionStatus("past_due"), { status: "past_due", known: true });
eq("stripe unpaid -> past_due", mapStripeSubscriptionStatus("unpaid"), { status: "past_due", known: true });
eq("stripe canceled -> canceled", mapStripeSubscriptionStatus("canceled"), { status: "canceled", known: true });
eq(
  "stripe incomplete_expired -> canceled",
  mapStripeSubscriptionStatus("incomplete_expired"),
  { status: "canceled", known: true },
);
// The exact bug this fixes: Checkout subscriptions start 'incomplete', and
// subscription.created used to hardcode 'active' regardless.
eq("stripe incomplete -> inactive", mapStripeSubscriptionStatus("incomplete"), { status: "inactive", known: true });
eq("stripe paused -> inactive", mapStripeSubscriptionStatus("paused"), { status: "inactive", known: true });
// Never 500 on a status this map has never seen — fall back to inactive,
// flagged unknown so the caller logs it instead of silently mis-mapping.
eq(
  "unknown stripe status never throws, maps to inactive",
  mapStripeSubscriptionStatus("some_future_status"),
  { status: "inactive", known: false },
);
eq("null stripe status -> inactive, unknown", mapStripeSubscriptionStatus(null), { status: "inactive", known: false });
check(
  "every mapped status is one of the four the DB constraint allows",
  ["active", "trialing", "past_due", "unpaid", "canceled", "incomplete_expired", "incomplete", "paused"].every((s) =>
    ["active", "inactive", "past_due", "canceled"].includes(mapStripeSubscriptionStatus(s).status),
  ),
);

// ---- decideOtpIssue (resend cooldown / lock check) -------------------------

const now = new Date("2026-09-17T12:00:00Z");
const baseState: OtpAccountState = {
  storedCode: "123456",
  expiresAt: null,
  sentAt: null,
  attempts: 0,
  attemptsWindowStart: null,
  locked: false,
  lockedAt: null,
  lockCount: 0,
};

check(
  "decideOtpIssue: sends when nothing sent yet and not locked",
  decideOtpIssue({ ...baseState }, now).send === true,
);
check(
  "decideOtpIssue: refuses within the resend cooldown",
  decideOtpIssue({ ...baseState, sentAt: new Date(now.getTime() - 10_000) }, now).send === false,
);
eq(
  "decideOtpIssue: cooldown reason is 'cooldown'",
  decideOtpIssue({ ...baseState, sentAt: new Date(now.getTime() - 10_000) }, now).reason,
  "cooldown",
);
check(
  "decideOtpIssue: sends again once the cooldown has fully elapsed",
  decideOtpIssue({ ...baseState, sentAt: new Date(now.getTime() - (OTP_RESEND_COOLDOWN_SECONDS + 1) * 1000) }, now).send === true,
);
check(
  "decideOtpIssue: refuses a new code while locked",
  decideOtpIssue({ ...baseState, locked: true, lockedAt: now, lockCount: 1 }, now).send === false,
);
eq(
  "decideOtpIssue: locked reason is 'locked'",
  decideOtpIssue({ ...baseState, locked: true, lockedAt: now, lockCount: 1 }, now).reason,
  "locked",
);
check(
  "decideOtpIssue: sends again once a lock has actually lifted",
  decideOtpIssue(
    { ...baseState, locked: true, lockedAt: new Date(now.getTime() - (otpLockMinutes(1) + 1) * 60_000), lockCount: 1 },
    now,
  ).send === true,
);

// ---- decideOtpVerify (attempts tied to a window, escalating lock) ---------

check(
  "decideOtpVerify: correct code verifies",
  decideOtpVerify({ ...baseState, expiresAt: new Date(now.getTime() + 60_000) }, "123456", now).result === "verified",
);
check(
  "decideOtpVerify: wrong code increments attempts, doesn't lock before the max",
  (() => {
    const d = decideOtpVerify(
      { ...baseState, expiresAt: new Date(now.getTime() + 60_000), attempts: OTP_MAX_ATTEMPTS - 2, attemptsWindowStart: now },
      "000000",
      now,
    );
    return d.result === "wrong" && d.lockNow === false && d.attempts === OTP_MAX_ATTEMPTS - 1;
  })(),
);
check(
  "decideOtpVerify: the attempt that hits OTP_MAX_ATTEMPTS locks",
  (() => {
    const d = decideOtpVerify(
      { ...baseState, expiresAt: new Date(now.getTime() + 60_000), attempts: OTP_MAX_ATTEMPTS - 1, attemptsWindowStart: now },
      "000000",
      now,
    );
    return d.result === "wrong" && d.lockNow === true && d.alertTeam === true;
  })(),
);
check(
  "decideOtpVerify: a locked account refuses a guess even with a correct code",
  decideOtpVerify(
    { ...baseState, expiresAt: new Date(now.getTime() + 60_000), locked: true, lockedAt: now, lockCount: 1 },
    "123456",
    now,
  ).result === "locked",
);
check(
  "decideOtpVerify: a lock lifts once its escalated duration has passed",
  decideOtpVerify(
    {
      ...baseState,
      expiresAt: new Date(now.getTime() + 60_000),
      locked: true,
      lockedAt: new Date(now.getTime() - (otpLockMinutes(1) + 1) * 60_000),
      lockCount: 1,
    },
    "123456",
    now,
  ).result === "verified",
);
check(
  "decideOtpVerify: attempts outside the window don't carry over (a stale count resets)",
  (() => {
    const d = decideOtpVerify(
      {
        ...baseState,
        expiresAt: new Date(now.getTime() + 60_000),
        attempts: OTP_MAX_ATTEMPTS - 1,
        attemptsWindowStart: new Date(now.getTime() - 2 * 60 * 60_000), // 2h old, window is 1h
      },
      "000000",
      now,
    );
    return d.result === "wrong" && d.lockNow === false && d.attempts === 1;
  })(),
);
check(
  "decideOtpVerify: a second lockout within the reset window escalates the lock duration",
  (() => {
    const d = decideOtpVerify(
      {
        ...baseState,
        expiresAt: new Date(now.getTime() + 60_000),
        attempts: OTP_MAX_ATTEMPTS - 1,
        attemptsWindowStart: now,
        lockedAt: new Date(now.getTime() - 60_000), // locked a minute ago (previous lock)
        lockCount: 1,
      },
      "000000",
      now,
    );
    return d.lockNow === true && d.lockCount === 2 && otpLockMinutes(2) > otpLockMinutes(1);
  })(),
);
check(
  "decideOtpVerify: a lockout long after the reset window starts escalation over",
  (() => {
    const d = decideOtpVerify(
      {
        ...baseState,
        expiresAt: new Date(now.getTime() + 60_000),
        attempts: OTP_MAX_ATTEMPTS - 1,
        attemptsWindowStart: now,
        lockedAt: new Date(now.getTime() - (OTP_LOCK_COUNT_RESET_DAYS + 1) * 24 * 60 * 60_000),
        lockCount: 3,
      },
      "000000",
      now,
    );
    return d.lockCount === 1;
  })(),
);
check(
  "otpLockMinutes: escalates and caps",
  otpLockMinutes(1) < otpLockMinutes(2) && otpLockMinutes(2) < otpLockMinutes(3) && otpLockMinutes(50) === otpLockMinutes(8),
);
check(
  "isOtpLocked: true right after locking, false once the window passes",
  isOtpLocked({ locked: true, lockedAt: now, lockCount: 1 }, now) === true &&
    isOtpLocked({ locked: true, lockedAt: now, lockCount: 1 }, new Date(now.getTime() + (otpLockMinutes(1) + 1) * 60_000)) === false,
);

// ---- tokenVersionValid ------------------------------------------------------

check("tokenVersionValid: matching versions pass", tokenVersionValid(2, 2));
check("tokenVersionValid: stale token fails after a bump", !tokenVersionValid(1, 2));
check("tokenVersionValid: a token with no tv claim is treated as version 0", tokenVersionValid(undefined, 0));
check("tokenVersionValid: a version-0 token fails once the account has been bumped", !tokenVersionValid(undefined, 1));

// ---- Safe user fields --------------------------------------------------------

check("SAFE_USER_FIELDS never includes otp_code", !(SAFE_USER_FIELDS as readonly string[]).includes("otp_code"));
check("SAFE_USER_FIELDS never includes otp_expiry", !(SAFE_USER_FIELDS as readonly string[]).includes("otp_expiry"));
check("SAFE_USER_FIELDS never includes locked", !(SAFE_USER_FIELDS as readonly string[]).includes("locked"));
check("SAFE_USER_FIELDS never includes stripe_customer_id", !(SAFE_USER_FIELDS as readonly string[]).includes("stripe_customer_id"));
check("SAFE_USER_FIELDS never includes token_version", !(SAFE_USER_FIELDS as readonly string[]).includes("token_version"));
check("UPDATABLE_USER_FIELDS never includes phone_number", !(UPDATABLE_USER_FIELDS as readonly string[]).includes("phone_number"));

eq(
  "pickSafeUser strips everything not on the allowlist",
  pickSafeUser({
    id: "u1",
    username: "alice",
    otp_code: "999999",
    otp_expiry: "2026-01-01",
    locked: true,
    locked_at: "2026-01-01",
    stripe_customer_id: "cus_123",
    token_version: 4,
  }),
  { id: "u1", username: "alice" },
);

check(
  "buildUserUpdate: empty body is null (400, not a broken SQL SET clause)",
  buildUserUpdate({}) === null,
);
check("buildUserUpdate: undefined body is null", buildUserUpdate(undefined) === null);
check(
  "buildUserUpdate: a body with only phone_number is null (not updatable here)",
  buildUserUpdate({ phone_number: "+15555550100" }) === null,
);
eq(
  "buildUserUpdate: picks only allowed, present fields in order",
  buildUserUpdate({ first_name: "Jo", not_a_field: "x", last_name: "Lee" }),
  { columns: ["first_name", "last_name"], values: ["Jo", "Lee"] },
);

const total = pass + fail;
console.log(`auth rules: ${pass}/${total} passed`);
if (fail > 0) process.exitCode = 1;
