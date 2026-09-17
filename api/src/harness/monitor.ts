// Watching the decision log (Royce, 2026-09-15: "Nobody watches the decision
// log in production. A jump in redrafts, stripped replies, blocked sends or
// search timeouts should alert you").
//
// Hourly: each signal's rate over the last 6 hours vs. the previous 7 days.
// It alerts when the recent rate is both above its floor and at least double
// the baseline, with enough volume to mean something. Each signal alerts at
// most once every 12 hours. Alerts go to TEAM_ALERT_EMAIL and the log.
//
// Weekly (buildWeeklyReview): the week's bad moments with the conversation
// around them, for turning into eval cases (scripts/weeklyReview.ts writes
// them locally; the cron emails the summary).
import { Resend } from "resend";
import pool from "../db/db.js";
import { ALLOW_REAL_SENDS } from "../otpActions.js";
import { recordDecision } from "./core.js";

export type Signal = {
  key: string;
  label: string;
  // SQL condition on harness_decisions rows counted as "bad", and the rows
  // it's a share of.
  bad: string;
  total: string;
  floor: number; // minimum recent rate worth alerting on
  minCount: number;
};

export const SIGNALS: Signal[] = [
  { key: "reply_redrafted", label: "Replies rewritten or stripped by the grounding check", bad: `decision = 'reply.grounding' AND action IN ('redrafted','stripped')`, total: `decision = 'reply.grounding'`, floor: 0.25, minCount: 5 },
  { key: "reply_stripped", label: "Replies stripped to a minimal answer", bad: `decision = 'reply.grounding' AND action = 'stripped'`, total: `decision = 'reply.grounding'`, floor: 0.1, minCount: 3 },
  { key: "proactive_blocked", label: "Proactive drafts blocked by checks", bad: `decision = 'proactive.dailyPick' AND reason LIKE 'draft failed checks%'`, total: `decision = 'proactive.dailyPick' AND action IS NOT NULL`, floor: 0.3, minCount: 3 },
  { key: "search_timeout", label: "Searches that hit the time cap or found nothing", bad: `decision = 'recommendation.search' AND outcome = 'skip'`, total: `decision = 'recommendation.search'`, floor: 0.5, minCount: 3 },
  { key: "latency_over", label: "Replies over the latency budget", bad: `decision = 'turn.latency' AND checks @> '[{"pass": false}]'`, total: `decision = 'turn.latency'`, floor: 0.2, minCount: 5 },
  { key: "call_ungrounded", label: "Calls with unsupported promises or facts", bad: `decision = 'call.grounding' AND outcome = 'skip'`, total: `decision = 'call.grounding'`, floor: 0.3, minCount: 2 },
  { key: "snapshot_problems", label: "Person summaries that contradict recent messages", bad: `decision = 'profile.snapshotCheck' AND outcome = 'skip'`, total: `decision = 'profile.snapshotCheck'`, floor: 0.3, minCount: 3 },
  { key: "city_overwritten", label: "Profile city changes blocked (extraction drifting)", bad: `decision = 'profile.city' AND outcome = 'skip'`, total: `decision = 'profile.city'`, floor: 0.5, minCount: 3 },
  { key: "card_misfire", label: "Contact card asked for when they wanted something else", bad: `decision = 'reply.contactCard' AND outcome = 'skip'`, total: `decision = 'reply.contactCard'`, floor: 0.3, minCount: 2 },
  { key: "reaction_withheld", label: "Reactions held back because a reply was still owed", bad: `decision = 'turn.closing' AND outcome = 'skip'`, total: `decision = 'turn.closing'`, floor: 0.4, minCount: 3 },
  // Real events found, none offerable (sold out, already sent, out of range):
  // the answer they get is "nothing", even though the search worked.
  { key: "found_but_unofferable", label: "Searches that found real events but could offer none", bad: `decision = 'recommendation.search' AND action <> 'sent_matches' AND jsonb_array_length(COALESCE(proposal->'scope'->'gatedOut', '[]'::jsonb)) > 0`, total: `decision = 'recommendation.search'`, floor: 0.4, minCount: 3 },
  // The Luma feed stopped before the end of the time frame they asked about.
  { key: "window_partly_searched", label: "Searches whose event feed didn't reach the end of the asked time frame", bad: `decision = 'recommendation.search' AND proposal->'scope'->>'windowCovered' = 'false'`, total: `decision = 'recommendation.search' AND proposal->'scope'->>'windowCovered' IS NOT NULL`, floor: 0.3, minCount: 2 },
  { key: "followup_not_queued", label: "Time-frame follow-ups that failed to queue", bad: `decision = 'proactive.windowFollowUp' AND action = 'enqueue_failed'`, total: `decision = 'proactive.windowFollowUp'`, floor: 0.2, minCount: 2 },
  // Nothing offered and nothing turned away by the gate: the closest miss was
  // the only real thing the person heard about.
  { key: "closest_miss_only", label: "Searches where the closest miss was the only thing shown", bad: `decision = 'recommendation.search' AND action LIKE 'nothing_found%' AND jsonb_typeof(proposal->'scope'->'closest') = 'object' AND jsonb_array_length(COALESCE(proposal->'scope'->'gatedOut', '[]'::jsonb)) = 0`, total: `decision = 'recommendation.search'`, floor: 0.4, minCount: 3 },
  { key: "router_unavailable", label: "Router failures (no actions taken)", bad: `decision = 'router.decideActions' AND checks @> '[{"name": "router_available", "pass": false}]'`, total: `decision = 'router.decideActions'`, floor: 0.05, minCount: 3 },
  // Code review, 2026-09-17: none of the four signals below existed before —
  // send failures, hours/opt-out blocks at send time, announcement
  // give-ups, and call-gate blocks all happened silently as far as
  // monitoring was concerned, even though the harness already recorded a
  // decision for each one.
  { key: "proactive_blocked_at_send", label: "Proactive sends blocked at send time (caps/hours/opt-out changed since the pick)", bad: `decision = 'proactive.dailyPick' AND reason LIKE 'blocked at send:%'`, total: `decision = 'proactive.dailyPick' AND action IS NOT NULL`, floor: 0.1, minCount: 2 },
  { key: "exempt_send_blocked_or_failed", label: "Transactional (exempt) sends blocked by hours/opt-out or failed", bad: `decision = 'proactive.exemptSend' AND outcome = 'skip'`, total: `decision = 'proactive.exemptSend'`, floor: 0.3, minCount: 3 },
  { key: "announcement_gave_up", label: "Co event announcements given up on (event gone/past, or opted out)", bad: `decision = 'tier1.announce' AND action LIKE 'gave_up%'`, total: `decision = 'tier1.announce'`, floor: 0.3, minCount: 2 },
  { key: "call_gate_blocked", label: "Calls blocked at the gate before dialing", bad: `decision = 'call.gate' AND outcome = 'skip'`, total: `decision = 'call.gate'`, floor: 0.3, minCount: 3 },
  // Code review, 2026-09-17: the Tier 2 relevance judge was silently
  // rejecting real events on their format label alone ("pitch night" isn't
  // literally "meetup") for weeks before anyone noticed by feel. These two
  // watch the two failure shapes that fix targeted, so a future prompt
  // change that reintroduces either one shows up here instead of needing
  // another live test session to catch.
  { key: "tier2_relevance_overreject", label: "Real Tier 2 candidates existed but the relevance judge rejected all of them", bad: `decision = 'recommendation.search' AND outcome = 'skip' AND jsonb_array_length(COALESCE(proposal->'scope'->'relevanceRejected', '[]'::jsonb)) > 0 AND COALESCE((proposal->'scope'->>'tier2Nearby')::int, 0) > 0`, total: `decision = 'recommendation.search' AND COALESCE((proposal->'scope'->>'tier2Nearby')::int, 0) > 0`, floor: 0.4, minCount: 3 },
  // Tier 3 genuinely finds nothing often (X's recent-search is only 7 days,
  // and the bar for "real, concrete, not hype" is deliberately strict) —
  // floor set high on purpose so this only fires on a real jump, not on
  // Tier 3's normal baseline scarcity.
  { key: "tier3_searched_found_nothing", label: "Tier 3 (X) was searched but nothing ended up offered", bad: `decision = 'recommendation.search' AND proposal->'scope'->>'xQuery' IS NOT NULL AND (outcome = 'skip' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(proposal->'matches', '[]'::jsonb)) e WHERE e->>'tier' = '3'))`, total: `decision = 'recommendation.search' AND proposal->'scope'->>'xQuery' IS NOT NULL`, floor: 0.6, minCount: 3 },
];

export type SignalReading = { signal: Signal; recentBad: number; recentTotal: number; recentRate: number; baselineRate: number };

// Pure: whether a reading should alert.
export function shouldAlert(r: SignalReading): boolean {
  if (r.recentBad < r.signal.minCount || r.recentTotal === 0) return false;
  if (r.recentRate < r.signal.floor) return false;
  return r.baselineRate === 0 || r.recentRate >= 2 * r.baselineRate;
}

export async function readSignals(): Promise<SignalReading[]> {
  const out: SignalReading[] = [];
  for (const signal of SIGNALS) {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '6 hours' AND (${signal.bad}))::int AS recent_bad,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '6 hours' AND (${signal.total}))::int AS recent_total,
         COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '6 hours' AND (${signal.bad}))::int AS base_bad,
         COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '6 hours' AND (${signal.total}))::int AS base_total
       FROM harness_decisions WHERE created_at > NOW() - INTERVAL '7 days 6 hours'`,
    );
    const r = rows[0];
    out.push({
      signal,
      recentBad: r.recent_bad,
      recentTotal: r.recent_total,
      recentRate: r.recent_total ? r.recent_bad / r.recent_total : 0,
      baselineRate: r.base_total ? r.base_bad / r.base_total : 0,
    });
  }
  return out;
}

async function sendTeamEmail(subject: string, html: string): Promise<void> {
  const to = process.env.TEAM_ALERT_EMAIL ?? "hello@copatible.com";
  if (!ALLOW_REAL_SENDS || !process.env.RESEND_API_KEY) {
    console.log(`[monitor] ${subject}\n${html.replace(/<[^>]+>/g, " ")}`);
    return;
  }
  // Resend reports failures in the result instead of throwing (2026-09-15:
  // an unverified domain made every send fail while this said "sent").
  const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: "Co <hello@copatible.com>", to: [to], subject, html });
  if (error) throw new Error(`Resend: ${error.message}`);
}

export async function runMonitor(): Promise<void> {
  try {
    const readings = await readSignals();
    for (const r of readings.filter(shouldAlert)) {
      const claimed = await pool.query(
        `INSERT INTO harness_alerts (signal_key, sent_at) VALUES ($1, NOW())
         ON CONFLICT (signal_key) DO UPDATE SET sent_at = NOW() WHERE harness_alerts.sent_at < NOW() - INTERVAL '12 hours'
         RETURNING signal_key`,
        [r.signal.key],
      );
      if (!claimed.rows[0]) continue;
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const detail = `${r.signal.label}: ${pct(r.recentRate)} in the last 6 hours (${r.recentBad} of ${r.recentTotal}), vs ${pct(r.baselineRate)} over the past week.`;
      await sendTeamEmail(`Co alert: ${r.signal.label}`, `<p>${detail}</p><p>Look in harness_decisions for the details.</p>`).catch((err: any) =>
        console.error("monitor: alert email failed (non-fatal):", err?.message ?? err),
      );
      await recordDecision({ layer: 3, decision: "monitor.alert", userId: null, outcome: "act", action: r.signal.key, reason: detail });
    }
  } catch (err: any) {
    console.error("monitor: run failed (non-fatal):", err?.message ?? err);
  }
}

// Proves the alert path end to end (Resend, the address, the log) without
// waiting for a real spike.
export async function sendTestAlert(): Promise<void> {
  const readings = await readSignals();
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  await sendTeamEmail(
    "Co alert test: monitoring is on",
    `<p>This is a test from Co's hourly monitoring on co-test. Real alerts look like this, one per signal, at most every 12 hours.</p><ul>${readings
      .map((r) => `<li>${r.signal.label}: ${pct(r.recentRate)} in the last 6 hours (${r.recentBad} of ${r.recentTotal}) vs ${pct(r.baselineRate)} over the week${shouldAlert(r) ? " (would alert)" : ""}</li>`)
      .join("")}</ul>`,
  );
  await recordDecision({ layer: 3, decision: "monitor.alert", userId: null, outcome: "act", action: "test", reason: "test alert sent" });
}

// ---------------------------------------------------------------------------
// Weekly review

export type ReviewMoment = { userId: string | null; at: string; decision: string; action: string | null; reason: string | null; around: string[] };

export async function gatherWeekMoments(days = 7): Promise<ReviewMoment[]> {
  const { rows } = await pool.query(
    `SELECT user_id, created_at, decision, action, reason FROM harness_decisions
     WHERE created_at > NOW() - ($1 || ' days')::interval AND (
       (decision = 'reply.grounding' AND action IN ('redrafted', 'stripped'))
       OR (decision = 'call.grounding' AND outcome = 'skip')
       OR (decision = 'router.decideActions' AND action LIKE 'clarify%')
       OR (decision = 'recommendation.search' AND outcome = 'skip')
       OR (decision = 'turn.latency' AND checks @> '[{"pass": false}]')
       OR decision = 'turn.duplicate'
       OR (decision = 'proactive.dailyPick' AND reason LIKE 'draft failed checks%')
     )
     ORDER BY created_at DESC LIMIT 60`,
    [days],
  );
  const moments: ReviewMoment[] = [];
  for (const r of rows) {
    const around = r.user_id
      ? (
          await pool.query(
            `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange'
             AND created_at BETWEEN $2::timestamptz - INTERVAL '10 minutes' AND $2::timestamptz + INTERVAL '2 minutes'
             ORDER BY created_at LIMIT 12`,
            [r.user_id, r.created_at],
          )
        ).rows.map((m: any) => String(m.content).slice(0, 300))
      : [];
    moments.push({ userId: r.user_id, at: new Date(r.created_at).toISOString(), decision: r.decision, action: r.action, reason: r.reason, around });
  }
  return moments;
}

export function renderWeeklyReview(moments: ReviewMoment[], readings: SignalReading[]): string {
  const byDecision = new Map<string, number>();
  for (const m of moments) byDecision.set(m.decision, (byDecision.get(m.decision) ?? 0) + 1);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    `<h2>Co weekly review</h2>`,
    `<p>${moments.length} moments worth a look this week.</p>`,
    `<ul>${[...byDecision.entries()].map(([d, n]) => `<li>${d}: ${n}</li>`).join("")}</ul>`,
    `<h3>Signals (last 6 hours vs week)</h3><ul>${readings.map((r) => `<li>${r.signal.label}: ${pct(r.recentRate)} vs ${pct(r.baselineRate)}</li>`).join("")}</ul>`,
    `<h3>Moments</h3>`,
    ...moments.slice(0, 20).map((m) => `<p><b>${m.at.slice(0, 16)} ${m.decision} ${m.action ?? ""}</b><br>${(m.reason ?? "").slice(0, 200)}<br><small>${m.around.map((l) => l.replace(/</g, "&lt;")).join("<br>")}</small></p>`),
    `<p>Run <code>npm run weekly-review</code> locally to turn these into eval cases.</p>`,
  ].join("\n");
}

export async function runWeeklyReview(): Promise<void> {
  try {
    const [moments, readings] = await Promise.all([gatherWeekMoments(), readSignals()]);
    await sendTeamEmail(`Co weekly review: ${moments.length} moments`, renderWeeklyReview(moments, readings));
  } catch (err: any) {
    console.error("weekly review failed (non-fatal):", err?.message ?? err);
  }
}
