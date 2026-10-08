// Layer 8 harness: the last check before Co dials anyone, and missed-call
// follow-ups.
//
// gather   gatherCallState reads call status, opt-out, timezone, recent
//          calls, and what authorizes this call (a scheduled_calls row, a
//          Layer 2 call decision on an inbound text, a check-in cadence the
//          person asked for, auto-intake, or the person pressing call)
//          and, for a call Co starts itself, the reason from the member's own
//          life (services/callReason.ts; 2026-10-08: no reason, no call)
// gate     decideCall / decideMissedCallFollowUp (pure, run by evals/voice)
// record   recordDecision(layer 8, "call.gate")
//
// FOR OTHER CALL SITES: pass an explicit authorization as the third argument
// to triggerCallForUser, e.g. { kind: "router_decision" } from
// routes/sendblue.ts, { kind: "scheduled_call", scheduledCallId } from
// jobs/scheduledCall.ts. Without one, the gate infers it from the database,
// which works but records "inferred".
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { isReasonableLocalHour } from "../services/localHours.js";
import { memberZone } from "../services/memberTime.js";
import type { GateCheck } from "./core.js";
import { callReasonForCall, needsMemberReason, type CallReasonResult } from "../services/callReason.js";

export type CallAuthKind = "router_decision" | "scheduled_call" | "user_initiated" | "checkin_cadence" | "auto_intake";

export type CallAuthorization = { kind: CallAuthKind; scheduledCallId?: string };

export const LIVE_CALL_STATUSES = ["initiated", "ringing", "in-progress"];
export const LIVE_CALL_RECLAIM_MINUTES = 30;
// Minimum gap since the last call Co placed. Short for calls the person just
// asked for (only stops a double-fire); long for anything Co starts itself.
export const RECENT_CALL_MINUTES: Record<CallAuthKind, number> = {
  user_initiated: 2,
  router_decision: 2,
  scheduled_call: 10,
  checkin_cadence: 60 * 12,
  auto_intake: 60 * 24,
};
// Calls Co starts on its own only go out in local daytime. A call the person
// asked for (now, or at a time they picked) goes out when they asked.
const NEEDS_LOCAL_HOURS: Record<CallAuthKind, boolean> = {
  user_initiated: false,
  router_decision: false,
  scheduled_call: false,
  checkin_cadence: true,
  auto_intake: true,
};

export type CallState = {
  callStatus: string | null;
  callStatusUpdatedAt: Date | null;
  optedOut: boolean;
  subscriptionActive: boolean;
  requireSubscription: boolean;
  localHourOk: boolean;
  // False when no timezone could be resolved for them, so localHourOk came
  // from the conservative UTC window (see callHourOk). Optional so older
  // eval cases without it still read as "timezone known".
  timezoneKnown?: boolean;
  lastCallAt: Date | null;
  // Evidence for each authorization kind, filled in by gatherCallState.
  evidence: {
    scheduledCallDue: boolean;
    recentInboundText: boolean;
    routerPlaceCallDecision: boolean;
    cadenceSet: boolean;
    autoIntakeEligible: boolean;
    // The reason from their life for a call Co starts itself (services/callReason.ts), with everything considered. Filled by
    // gatherCallState; logged with the gate's decision. Undefined only in older pure eval cases (no read happened).
    callReason?: CallReasonResult;
  };
};

export type CallDecision = {
  allowed: boolean;
  authorization: CallAuthKind | null;
  inferred: boolean;
  checks: GateCheck[];
  error: string | null;
};

function authorized(kind: CallAuthKind, e: CallState["evidence"]): { ok: boolean; reason: string } {
  switch (kind) {
    case "user_initiated":
      return { ok: true, reason: "the person started it from the app" };
    case "scheduled_call":
      return e.scheduledCallDue ? { ok: true, reason: "a scheduled call is due" } : { ok: false, reason: "no due scheduled call" };
    case "router_decision":
      return e.routerPlaceCallDecision || e.recentInboundText
        ? { ok: true, reason: e.routerPlaceCallDecision ? "Layer 2 decided to place a call" : "they texted in the last few minutes" }
        : { ok: false, reason: "no recent message asking for a call" };
    case "checkin_cadence":
      return e.cadenceSet ? { ok: true, reason: "they asked for check-in calls" } : { ok: false, reason: "no check-in cadence on file" };
    case "auto_intake":
      return e.autoIntakeEligible ? { ok: true, reason: "new subscriber with no profile yet" } : { ok: false, reason: "not eligible for an intake call" };
  }
}

const INFER_ORDER: CallAuthKind[] = ["scheduled_call", "router_decision", "checkin_cadence", "auto_intake"];

export function decideCall(state: CallState, requested: CallAuthorization | null, now: Date): CallDecision {
  const checks: GateCheck[] = [];

  let kind: CallAuthKind | null = null;
  let inferred = false;
  if (requested) {
    const a = authorized(requested.kind, state.evidence);
    checks.push({ name: "authorized", pass: a.ok, reason: `${requested.kind}: ${a.reason}` });
    if (a.ok) kind = requested.kind;
  } else {
    const found = INFER_ORDER.find((k) => authorized(k, state.evidence).ok) ?? null;
    checks.push({
      name: "authorized",
      pass: !!found,
      reason: found ? `inferred ${found}: ${authorized(found, state.evidence).reason}` : "nothing authorizes this call",
    });
    kind = found;
    inferred = !!found;
  }

  const isLive = !!state.callStatus && LIVE_CALL_STATUSES.includes(state.callStatus);
  const liveForMs = state.callStatusUpdatedAt ? now.getTime() - state.callStatusUpdatedAt.getTime() : Infinity;
  const liveBlocks = isLive && liveForMs < LIVE_CALL_RECLAIM_MINUTES * 60 * 1000;
  checks.push({
    name: "no_live_call",
    pass: !liveBlocks,
    reason: liveBlocks ? "a call is already in progress" : isLive ? `stale ${state.callStatus} status reclaimed` : undefined,
  });

  const optOutBlocks = state.optedOut && kind !== "user_initiated";
  checks.push({ name: "not_opted_out", pass: !optOutBlocks, reason: optOutBlocks ? "they opted out" : undefined });

  const subBlocks = state.requireSubscription && !state.subscriptionActive;
  checks.push({ name: "subscription_active", pass: !subBlocks, reason: subBlocks ? "no active subscription" : undefined });

  const hoursBlock = !!kind && NEEDS_LOCAL_HOURS[kind] && !state.localHourOk;
  checks.push({
    name: "local_hours",
    pass: !hoursBlock,
    reason: hoursBlock
      ? state.timezoneKnown === false
        ? "outside 8am-9pm Pacific (no timezone on file, so Pacific, where the club is)"
        : "outside 8am-9pm their time"
      : undefined,
  });

  // A call Co starts on its own needs a reason from their life (Royce, 2026-10-08): never Co's own homework. If the only
  // thing on file is Co's deliverable, no call: silence beats a homework call. A call they asked for never needs one.
  if (needsMemberReason(kind) && state.evidence.callReason) {
    const r = state.evidence.callReason;
    const passed = r.considered.filter((c) => !c.kept);
    checks.push({
      name: "member_reason",
      pass: !!r.reason,
      // Kinds and whys only: this reason reaches the job's console log; the texts ride in the decision's proposal.
      reason: r.reason
        ? r.reason.kind
        : `${NO_REASON}${passed.length ? ` (considered: ${passed.slice(0, 4).map((c) => `${c.kind}: ${String(c.why ?? "").split(":")[0]}`).join("; ")})` : " (nothing in their life on file to call about)"}`,
    });
  }

  const gapMin = RECENT_CALL_MINUTES[kind ?? "auto_intake"];
  const sinceLastMs = state.lastCallAt ? now.getTime() - state.lastCallAt.getTime() : Infinity;
  const recentBlocks = sinceLastMs < gapMin * 60 * 1000;
  checks.push({
    name: "no_recent_call",
    pass: !recentBlocks,
    reason: recentBlocks ? `Co called ${Math.round(sinceLastMs / 60000)} min ago (needs ${gapMin})` : undefined,
  });

  const failed = checks.filter((c) => !c.pass);
  const allowed = failed.length === 0 && !!kind;
  let error: string | null = null;
  if (!allowed) {
    if (liveBlocks) error = "A call is already in progress for this user.";
    else if (subBlocks) error = "User does not have an active subscription.";
    else error = `Call blocked: ${failed.map((c) => c.reason ?? c.name).join("; ")}`;
  }
  return { allowed, authorization: kind, inferred, checks, error };
}

// The start of a blocked call's error when the only thing missing is a reason from their life (jobs read it to log the skip).
export const NO_REASON = "no reason from their life to call";
export function blockedForNoReason(error: string | null | undefined): boolean {
  return String(error ?? "").includes(NO_REASON);
}

// ---- local hours ---------------------------------------------------------------

// One rule for texts and calls (Royce, 2026-10-07): 8am-9pm their time, and with no zone on file, 8am-9pm in the fallback zone
// (Pacific, where the club is, DST-correct; services/localHours.ts). Calls used to get a fixed 17:00-24:00 UTC window for an
// unknown zone and texts 16:00-24:00 UTC: Pacific in summer only.
export function callHourOk(timezone: string | null, now: Date): boolean {
  return isReasonableLocalHour(timezone, now);
}

// The start of the next hour a Co-started call is allowed (now, if it already
// is one). Used to retry a blocked check-in call instead of dropping it.
export function nextAllowedCallTime(timezone: string | null, now: Date): Date {
  if (callHourOk(timezone, now)) return now;
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    t.setUTCHours(t.getUTCHours() + 1);
    if (callHourOk(timezone, t)) return t;
  }
  return t;
}

// ---- auto-intake -------------------------------------------------------------

// Fixed 2026-09-17: auto-intake judged "no profile yet" by an empty
// life_chapters, which only accepts four values, so most people who had a
// real intake call still looked profile-less and got called again every 24h
// with no end. Intake is done once a real call conversation happened or a real
// profile exists, and Co gives up after a few unanswered tries.
export const AUTO_INTAKE_MAX_ATTEMPTS = 3;
export const AUTO_INTAKE_MIN_GAP_HOURS = 48;

export type AutoIntakeState = {
  subscriptionActive: boolean;
  // False only for a placeholder row still doing name/email intake by text.
  identityCaptured: boolean;
  // A stored call transcript that isn't just the dial marker.
  hadRealCall: boolean;
  // Goals, activities, blockers, or a long-term direction on file.
  hasRealProfile: boolean;
  attempts: number;
  lastAttemptAt: Date | null;
};

export function decideAutoIntake(s: AutoIntakeState, now: Date): { eligible: boolean; reason: string } {
  if (!s.subscriptionActive) return { eligible: false, reason: "no active subscription" };
  if (!s.identityCaptured) return { eligible: false, reason: "still getting their name and email by text" };
  if (s.hadRealCall) return { eligible: false, reason: "intake call already happened" };
  if (s.hasRealProfile) return { eligible: false, reason: "a real profile already exists" };
  if (s.attempts >= AUTO_INTAKE_MAX_ATTEMPTS) return { eligible: false, reason: `already tried ${s.attempts} intake calls` };
  if (s.lastAttemptAt && now.getTime() - s.lastAttemptAt.getTime() < AUTO_INTAKE_MIN_GAP_HOURS * 3600 * 1000) {
    return { eligible: false, reason: `last intake try was under ${AUTO_INTAKE_MIN_GAP_HOURS}h ago` };
  }
  return { eligible: true, reason: "new subscriber with no intake conversation yet" };
}

export async function gatherCallState(
  userId: string,
  user: { call_status: string | null; call_status_updated_at: string | Date | null; subscription_status: string | null },
  requested: CallAuthorization | null,
): Promise<CallState> {
  const [extra, lastCall, scheduled, inbound, routerDecision, intakeAttempts] = await Promise.all([
    pool.query(
      `SELECT u.sms_opted_out, COALESCE(u.identity_captured, true) AS identity_captured, cp.city, cp.checkin_call_cadence_days,
              (cp.user_id IS NOT NULL AND (
                 COALESCE(array_length(cp.goals, 1), 0) > 0
                 OR COALESCE(array_length(cp.activity_preferences, 1), 0) > 0
                 OR COALESCE(array_length(cp.blockers, 1), 0) > 0
                 OR COALESCE(cp.long_term_direction, '') <> ''
              )) AS has_real_profile,
              EXISTS (
                SELECT 1 FROM co_memories cm
                WHERE cm.user_id = u.id AND cm.memory_type = 'call_transcript' AND cm.content NOT LIKE 'Co initiated call%'
              ) AS had_real_call
       FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`,
      [userId],
    ),
    pool.query(
      `SELECT MAX(created_at) AS at FROM co_memories
       WHERE user_id = $1 AND memory_type = 'call_transcript' AND content LIKE 'Co initiated call%'`,
      [userId],
    ),
    pool.query(
      `SELECT 1 FROM scheduled_calls
       WHERE user_id = $1 AND status IN ('pending', 'processing') AND scheduled_for <= NOW() + INTERVAL '2 minutes'
         AND scheduled_for > NOW() - INTERVAL '2 hours' ${requested?.scheduledCallId ? "AND id = $2" : ""}
       LIMIT 1`,
      requested?.scheduledCallId ? [userId, requested.scheduledCallId] : [userId],
    ),
    pool.query(
      `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange'
         AND (content LIKE 'User said:%' OR content LIKE 'User sent a voice memo:%') AND created_at > NOW() - INTERVAL '3 minutes' LIMIT 1`,
      [userId],
    ),
    pool
      .query(
        `SELECT 1 FROM harness_decisions WHERE user_id = $1 AND layer = 2 AND created_at > NOW() - INTERVAL '3 minutes'
           AND (action ILIKE '%place_call%' OR proposal::text ILIKE '%place_call%') LIMIT 1`,
        [userId],
      )
      .catch(() => ({ rows: [] })),
    // Auto-intake calls actually dialed (triggerCallForUser records
    // place_call with reason "auto_intake" or "inferred auto_intake").
    pool
      .query(
        `SELECT COUNT(*)::int AS n, MAX(created_at) AS at FROM harness_decisions
         WHERE user_id = $1 AND layer = 8 AND decision = 'call.gate' AND action = 'place_call'
           AND reason IN ('auto_intake', 'inferred auto_intake')`,
        [userId],
      )
      .catch(() => ({ rows: [{ n: AUTO_INTAKE_MAX_ATTEMPTS, at: null }] })),
  ]);
  const x = extra.rows[0] ?? {};
  const timezone = await memberZone(userId);
  const now = new Date();
  const intake = decideAutoIntake(
    {
      subscriptionActive: user.subscription_status === "active",
      identityCaptured: x.identity_captured !== false,
      hadRealCall: x.had_real_call === true,
      hasRealProfile: x.has_real_profile === true,
      attempts: Number(intakeAttempts.rows[0]?.n ?? 0),
      lastAttemptAt: intakeAttempts.rows[0]?.at ? new Date(intakeAttempts.rows[0].at) : null,
    },
    now,
  );
  const evidence: CallState["evidence"] = {
    scheduledCallDue: scheduled.rows.length > 0,
    recentInboundText: inbound.rows.length > 0,
    routerPlaceCallDecision: routerDecision.rows.length > 0,
    cadenceSet: Number(x.checkin_call_cadence_days) > 0,
    autoIntakeEligible: intake.eligible,
  };
  // The kind this call will be decided as (the requested one, or the one the gate would infer), and its reason. Held for the
  // opening writer and the call's {{call_reason}} (services/callReason.ts) whatever the kind: a call they asked for holds "they
  // asked", so nothing stale from an earlier read rides into it.
  const kind = requested?.kind ?? INFER_ORDER.find((k) => authorized(k, evidence).ok) ?? null;
  evidence.callReason = await callReasonForCall(userId, kind, now);
  return {
    callStatus: user.call_status,
    callStatusUpdatedAt: user.call_status_updated_at ? new Date(user.call_status_updated_at) : null,
    optedOut: x.sms_opted_out === true,
    subscriptionActive: user.subscription_status === "active",
    requireSubscription: process.env.NODE_ENV === "production",
    localHourOk: callHourOk(timezone, now),
    timezoneKnown: !!timezone && DateTime.now().setZone(timezone).isValid,
    lastCallAt: lastCall.rows[0]?.at ? new Date(lastCall.rows[0].at) : null,
    evidence,
  };
}

// ---- what counts as a real conversation on a call ----------------------------

// Fixed 2026-09-17: voicemail detection was effectively off. Hume transcribes
// the voicemail greeting as a user message, which flipped "a real person is
// talking", so Co kept talking into voicemail and the greeting became the
// person's words in their profile. These lines are never the person talking
// to Co: voicemail greetings, carrier messages, and call screening prompts.
const VOICEMAIL_GREETING =
  /you(?:'ve| have) reached|leave (?:me |us )?(?:a |your )?(?:message|name|number|voicemail)|after the (?:tone|beep)|at the (?:tone|beep)|is not available|isn'?t available|are not available|aren'?t available|is unavailable|not available right now|can'?t (?:come to|get to|take) (?:the|my|your) (?:phone|call)|unable to (?:take|answer) (?:your|the) call|get back to you|voice ?mail|mailbox|record your (?:message|name)|when you(?:'ve| have| are) finished recording|forwarded to (?:an )?automated|press (?:pound|star|any key|one|two|\d)|hang up or press|the (?:person|party|number|subscriber) you (?:are |were )?(?:trying to reach|calling|have dialed|dialed)|google (?:voice|subscriber)|screening (?:service|your call|this call)|state your name|say your name|who(?:'s| is) calling|what you(?:'re| are) calling about/i;

// Short pickups that say nothing on their own ("hello?", "yeah").
const FILLER_ONLY = /^(?:hello|hi|hey|yeah|yes|yep|ok|okay|uh+|um+|hm+|mhm|what|huh)[\s?.!,]*(?:hello|hi|hey)?[\s?.!,]*$/i;

export function isVoicemailGreeting(text: string): boolean {
  return VOICEMAIL_GREETING.test(text);
}

// A person on the line (any words, "hello?" included), not a recording.
export function isCallerVoice(text: string): boolean {
  const t = text.trim();
  return /[a-z]/i.test(t) && !VOICEMAIL_GREETING.test(t);
}

function isSubstantiveUserLine(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !VOICEMAIL_GREETING.test(t) && !FILLER_ONLY.test(t);
}

// A real conversation: after Co has said something, the person answered with
// something that isn't a greeting, a carrier message, or a bare "hello?".
// Transcript lines are "user: ..." / "assistant: ..." as built from Hume's
// chat events.
export function hasRealUserTurn(transcript: string): boolean {
  let coSpoke = false;
  for (const raw of transcript.split("\n")) {
    const line = raw.trim();
    if (/^assistant:/i.test(line)) {
      coSpoke = true;
    } else if (/^user:/i.test(line) && coSpoke && isSubstantiveUserLine(line.replace(/^user:\s*/i, ""))) {
      return true;
    }
  }
  return false;
}

// The live bridge's version of the same test, one utterance at a time.
export function isRealUserUtterance(text: string, coHasSpoken: boolean): boolean {
  return coHasSpoken && isSubstantiveUserLine(text);
}

// Drops greeting-like "user" lines so a voicemail greeting is never extracted
// as something the person said about themselves.
export function stripVoicemailGreetingLines(transcript: string): string {
  return transcript
    .split("\n")
    .filter((line) => !(/^user:/i.test(line.trim()) && VOICEMAIL_GREETING.test(line)))
    .join("\n");
}

// ---- inbound caller ID -------------------------------------------------------

// Fixed 2026-09-17: inbound calls were matched on From alone, and caller ID is
// trivially spoofed, so anyone could call in as a user and hear Co talk
// through their private context. Only full carrier attestation (STIR/SHAKEN
// "A": the carrier vouches the caller owns this number) loads a person.
// ALLOW_UNVERIFIED_INBOUND_CALLERS=true is an escape hatch for testing on
// lines whose carrier doesn't attest.
export function inboundCallerVerified(stirVerstat: string | null | undefined, allowUnverified = false): boolean {
  if (allowUnverified) return true;
  return stirVerstat === "TN-Validation-Passed-A";
}

// ---- contact since a missed call ---------------------------------------------

// Whether the person reached Co after `since`: a text, a voice memo, or a
// call that actually had a conversation. Used so "tried calling but missed
// you" doesn't go out after they already texted or called back.
export async function hadContactSince(userId: string, since: Date): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM co_memories
     WHERE user_id = $1 AND created_at > $2
       AND (
         (memory_type = 'text_exchange' AND (content LIKE 'User said:%' OR content LIKE 'User sent a voice memo:%' OR content LIKE '[Call]%'))
         OR (memory_type = 'call_transcript' AND content NOT LIKE 'Co initiated call%')
       )
     LIMIT 1`,
    [userId, since],
  );
  return rows.length > 0;
}

// ---- missed calls ------------------------------------------------------------

export const MISSED_CALL_FOLLOWUP_WINDOW_HOURS = 24;

// The text after a call nobody picked up (jobs/index.ts, pending_call_followups). Nothing schedules a second call after a miss,
// so it never says Co will try again (2026-10-07: it promised "I'll try again soon" and no retry ever came). It's an open
// invitation instead: they can reply, or text "call me", which places a call through the ordinary call-me path. Pure.
export function missedCallText(firstName: string | null | undefined): string {
  const name = String(firstName ?? "").trim();
  return `${name ? `${name}, I` : "I"} tried calling but must have missed you. Reply here whenever suits, or text "call me" when you're free to talk.`;
}

export type MissedCallState = {
  // This exact call already got a follow-up (voicemail text, or a queued row).
  alreadyHandledThisCall: boolean;
  // An unsent missed-call follow-up is already queued for this person.
  pendingQueued: boolean;
  lastMissedFollowUpAt: Date | null;
};

export function decideMissedCallFollowUp(state: MissedCallState, now: Date): { send: boolean; checks: GateCheck[] } {
  const recent =
    !!state.lastMissedFollowUpAt && now.getTime() - state.lastMissedFollowUpAt.getTime() < MISSED_CALL_FOLLOWUP_WINDOW_HOURS * 3600 * 1000;
  const checks: GateCheck[] = [
    { name: "once_per_call", pass: !state.alreadyHandledThisCall, reason: state.alreadyHandledThisCall ? "this call already got a follow-up" : undefined },
    { name: "none_queued", pass: !state.pendingQueued, reason: state.pendingQueued ? "a missed-call text is already waiting to send" : undefined },
    { name: "none_recent", pass: !recent, reason: recent ? `already followed up on a missed call in the last ${MISSED_CALL_FOLLOWUP_WINDOW_HOURS}h` : undefined },
  ];
  return { send: checks.every((c) => c.pass), checks };
}

export async function gatherMissedCallState(userId: string, callSid: string): Promise<MissedCallState> {
  const [thisCall, queued, lastSent] = await Promise.all([
    pool.query(
      `SELECT 1 FROM pending_call_followups WHERE call_sid = $1
       UNION ALL
       SELECT 1 FROM co_memories WHERE user_id = $2 AND memory_type = 'text_exchange' AND content LIKE $3
       LIMIT 1`,
      [callSid, userId, `Co called % (${callSid}). Followed up%`],
    ),
    pool.query(`SELECT 1 FROM pending_call_followups WHERE user_id = $1 AND sent_at IS NULL LIMIT 1`, [userId]),
    pool.query(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(sent_at) AS at FROM pending_call_followups WHERE user_id = $1
         UNION ALL
         SELECT MAX(created_at) FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'Co called % Followed up%'
       ) t`,
      [userId],
    ),
  ]);
  return {
    alreadyHandledThisCall: thisCall.rows.length > 0,
    pendingQueued: queued.rows.length > 0,
    lastMissedFollowUpAt: lastSent.rows[0]?.at ? new Date(lastSent.rows[0].at) : null,
  };
}
