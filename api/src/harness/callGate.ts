// Layer 8 harness: the last check before Co dials anyone, and missed-call
// follow-ups.
//
// gather   gatherCallState reads call status, opt-out, timezone, recent
//          calls, and what authorizes this call (a scheduled_calls row, a
//          Layer 2 call decision on an inbound text, a check-in cadence the
//          person asked for, auto-intake, or the person pressing call)
// gate     decideCall / decideMissedCallFollowUp (pure, run by evals/voice)
// record   recordDecision(layer 8, "call.gate")
//
// FOR OTHER CALL SITES: pass an explicit authorization as the third argument
// to triggerCallForUser, e.g. { kind: "router_decision" } from
// routes/sendblue.ts, { kind: "scheduled_call", scheduledCallId } from
// jobs/scheduledCall.ts. Without one, the gate infers it from the database,
// which works but records "inferred".
import pool from "../db/db.js";
import { getTimezoneForCity } from "../services/geocoding.js";
import { isReasonableLocalHour } from "../services/localHours.js";
import type { GateCheck } from "./core.js";

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
  lastCallAt: Date | null;
  // Evidence for each authorization kind, filled in by gatherCallState.
  evidence: {
    scheduledCallDue: boolean;
    recentInboundText: boolean;
    routerPlaceCallDecision: boolean;
    cadenceSet: boolean;
    autoIntakeEligible: boolean;
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
  checks.push({ name: "local_hours", pass: !hoursBlock, reason: hoursBlock ? "outside 9am-8pm their time" : undefined });

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

export async function gatherCallState(
  userId: string,
  user: { call_status: string | null; call_status_updated_at: string | Date | null; subscription_status: string | null },
  requested: CallAuthorization | null,
): Promise<CallState> {
  const [extra, lastCall, scheduled, inbound, routerDecision] = await Promise.all([
    pool.query(
      `SELECT u.sms_opted_out, cp.city, cp.checkin_call_cadence_days,
              (cp.user_id IS NULL OR cp.life_chapters IS NULL OR array_length(cp.life_chapters, 1) IS NULL) AS no_profile
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
  ]);
  const x = extra.rows[0] ?? {};
  const timezone = x.city ? await getTimezoneForCity(x.city).catch(() => null) : null;
  return {
    callStatus: user.call_status,
    callStatusUpdatedAt: user.call_status_updated_at ? new Date(user.call_status_updated_at) : null,
    optedOut: x.sms_opted_out === true,
    subscriptionActive: user.subscription_status === "active",
    requireSubscription: process.env.NODE_ENV === "production",
    localHourOk: isReasonableLocalHour(timezone),
    lastCallAt: lastCall.rows[0]?.at ? new Date(lastCall.rows[0].at) : null,
    evidence: {
      scheduledCallDue: scheduled.rows.length > 0,
      recentInboundText: inbound.rows.length > 0,
      routerPlaceCallDecision: routerDecision.rows.length > 0,
      cadenceSet: Number(x.checkin_call_cadence_days) > 0,
      autoIntakeEligible: user.subscription_status === "active" && x.no_profile === true,
    },
  };
}

// ---- missed calls ------------------------------------------------------------

export const MISSED_CALL_FOLLOWUP_WINDOW_HOURS = 24;

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
