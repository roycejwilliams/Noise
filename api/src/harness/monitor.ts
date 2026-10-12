// Watching the decision log (Royce, 2026-09-15: "Nobody watches the decision
// log in production. A jump in redrafts, stripped replies, blocked sends or
// search timeouts should alert you").
//
// Hourly: each signal's rate over the last 6 hours vs. the previous 7 days.
// It alerts when the recent rate is both above its floor and at least double
// the baseline, with enough volume to mean something. Each signal alerts at
// most once every 12 hours. Alerts go to the decision log only (monitor.alert): Royce, 2026-10-11: "Remove the co alerts those are
// not helpful. I don't understand why they were being sent to my email." The emails were rate statistics (a tool used more than its
// week, often from a test run); read them in harness_decisions instead. The two alerts a person must act on still email
// (alertTeamNow): a member who may not be safe, and texts to someone paused.
//
// Weekly (buildWeeklyReview): the week's bad moments with the conversation
// around them, for turning into eval cases (scripts/weeklyReview.ts writes
// them locally; the cron emails the summary).
import { sendReportEmail } from "../services/reportEmail.js";
import { ABILITIES } from "../services/capabilities.js";
import { EXTENSIONS } from "../services/extensions.js";
import { Resend } from "resend";
import pool from "../db/db.js";
import { recordDecision } from "./core.js";
import { computeMetrics, renderMetricsHtml } from "./metrics.js";

export type Signal = {
  key: string;
  label: string;
  // SQL condition on harness_decisions rows counted as "bad", and the rows
  // it's a share of.
  bad: string;
  total: string;
  floor: number; // minimum recent rate worth alerting on
  minCount: number;
  // A slow outage rather than a spike (2026-10-07): read `recent` over this
  // window instead of 6 hours, alert on the level alone (a week of nothing
  // looks "steady" against its own baseline), and repeat at most every
  // repeatHours instead of 12.
  steady?: { window: string; repeatHours: number };
};

export const SIGNALS: Signal[] = [
  { key: "reply_redrafted", label: "Replies cut, rewritten or stripped by the grounding check", bad: `decision = 'reply.grounding' AND action IN ('cut','redrafted','stripped')`, total: `decision = 'reply.grounding'`, floor: 0.25, minCount: 5 },
  { key: "reply_stripped", label: "Replies stripped to a minimal answer", bad: `decision = 'reply.grounding' AND action = 'stripped'`, total: `decision = 'reply.grounding'`, floor: 0.1, minCount: 3 },
  { key: "proactive_blocked", label: "Proactive drafts blocked by checks", bad: `decision = 'proactive.dailyPick' AND reason LIKE 'draft failed checks%'`, total: `decision = 'proactive.dailyPick' AND action IS NOT NULL`, floor: 0.3, minCount: 3 },
  { key: "search_timeout", label: "Searches that hit the time cap or found nothing", bad: `decision = 'recommendation.search' AND outcome = 'skip'`, total: `decision = 'recommendation.search'`, floor: 0.5, minCount: 3 },
  { key: "latency_over", label: "Replies over the latency budget", bad: `decision = 'turn.latency' AND checks @> '[{"pass": false}]'`, total: `decision = 'turn.latency'`, floor: 0.2, minCount: 5 },
  { key: "call_ungrounded", label: "Calls with unsupported promises or facts", bad: `decision = 'call.grounding' AND outcome = 'skip'`, total: `decision = 'call.grounding'`, floor: 0.3, minCount: 2 },
  { key: "snapshot_problems", label: "Person summaries that contradict recent messages", bad: `decision = 'profile.snapshotCheck' AND outcome = 'skip'`, total: `decision = 'profile.snapshotCheck'`, floor: 0.3, minCount: 3 },
  { key: "city_overwritten", label: "Profile city changes blocked (extraction drifting)", bad: `decision = 'profile.city' AND outcome = 'skip'`, total: `decision = 'profile.city'`, floor: 0.5, minCount: 3 },
  // Co still paying attention (2026-09-28, services/understanding.ts): members
  // it hasn't learned anything new about in three weeks.
  { key: "understanding_quiet", label: "Members Co hasn't learned anything new about in 3 weeks", bad: `decision = 'understanding.check' AND outcome = 'skip'`, total: `decision = 'understanding.check'`, floor: 0.5, minCount: 2 },
  { key: "reaction_withheld", label: "Tapbacks Co chose but had to withhold (a reply was still owed)", bad: `decision = 'tool.reactInsteadOfReplying' AND action = 'not_done'`, total: `decision = 'tool.reactInsteadOfReplying'`, floor: 0.4, minCount: 3 },
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
  // Tier 3 from X. Since Co's own loop (2026-10-01) X is searched inside the
  // daily sweep, logged on sweep.find ("x: <query>" in did, xKept). The old
  // signal read recommendation.search's scope.xQuery, which nothing writes any
  // more, so a week of nothing kept from X went unseen (2026-10-07). One X
  // search often finds nothing, so this watches the level over a week: every
  // sweep that searched X in 7 days (at least 8 of them) kept nothing from it.
  { key: "tier3_x_nothing_kept", label: "A week of sweeps searched X and kept nothing from it", bad: `decision = 'sweep.find' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(proposal->'did', '[]'::jsonb)) d WHERE d LIKE 'x: %') AND COALESCE((proposal->>'xKept')::int, 0) = 0 AND proposal->'xError' IS NULL`, total: `decision = 'sweep.find' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(proposal->'did', '[]'::jsonb)) d WHERE d LIKE 'x: %')`, floor: 1, minCount: 8, steady: { window: "7 days", repeatHours: 72 } },
  // A failed X search (auth, rate limit, outage: sweepFind.ts xFailure) is its own flag, never counted as "nothing kept".
  { key: "tier3_x_failed", label: "Sweeps whose X search failed (auth, rate limit or outage)", bad: `decision = 'sweep.find' AND proposal->'xError' IS NOT NULL`, total: `decision = 'sweep.find' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(proposal->'did', '[]'::jsonb)) d WHERE d LIKE 'x: %')`, floor: 0.25, minCount: 3, steady: { window: "7 days", repeatHours: 24 } },
  // Cold start (services/coldStart.ts, 2026-10-08): a sweep for a member in their first week that came back with nothing for them
  // is a product failure, not a quiet day. Any one is worth a look: the level over the last day, at most one alert a day. The
  // decision carries their seeds, what was tried and why.
  { key: "cold_start_miss", label: "New members (first week) whose sweep found nothing for them", bad: `decision = 'sweep.cold_start_miss'`, total: `decision IN ('sweep.cold_start_miss', 'sweep.cold_start_hit')`, floor: 0.01, minCount: 1, steady: { window: "24 hours", repeatHours: 24 } },
  // Steering toward findable interests that read like a quiz: a steering reply with more than one question in it.
  { key: "cold_start_quiz", label: "Cold-start steering replies that asked more than one question", bad: `decision = 'coldstart.reply' AND action = 'steered' AND COALESCE((proposal->>'questions')::int, 0) > 1`, total: `decision = 'coldstart.reply' AND action = 'steered'`, floor: 0.3, minCount: 2, steady: { window: "7 days", repeatHours: 72 } },
  // Drift in Co's own choices (2026-09-25, toolGuard.ts): how often a tool
  // it chose didn't actually happen, and how often it hit a hard limit.
  { key: "tool_not_done", label: "Tools Co (or an extension) chose that didn't go through", bad: `decision LIKE 'tool.%' AND action = 'not_done'`, total: `decision LIKE 'tool.%'`, floor: 0.2, minCount: 3 },
  { key: "tool_limited", label: "Tool calls refused by a limit or missing yes", bad: `decision LIKE 'tool.%' AND action IN ('limited', 'needs_yes')`, total: `decision LIKE 'tool.%'`, floor: 0.25, minCount: 3 },
  // How often each tool is used per reply, so a sudden jump in any one shows.
  ...ABILITIES.filter((a) => a.tool && !["sendReply", "markTopicAsked"].includes(a.tool)).map((a) => ({
    key: `tool_use_${a.tool}`,
    label: `Replies where Co used ${a.tool}`,
    bad: `decision = 'tool.${a.tool}'`,
    total: `decision = 'turn.latency'`,
    floor: 0.35,
    minCount: 3,
  })),
  // The same for each extension's tools (services/extensions.ts), per turn
  // it took with the team (logged as <id>.teamTurn).
  ...EXTENSIONS.flatMap((e) =>
    e.abilities.filter((a) => a.tool).map((a) => ({
      key: `tool_use_${a.tool}`,
      label: `${e.name} turns that used ${a.tool}`,
      bad: `decision = 'tool.${a.tool}'`,
      total: `decision = '${e.id}.teamTurn'`,
      floor: 0.5,
      minCount: 3,
    })),
  ),
];

export type SignalReading = { signal: Signal; recentBad: number; recentTotal: number; recentRate: number; baselineRate: number };

// Pure: whether a reading should alert.
export function shouldAlert(r: SignalReading): boolean {
  if (r.recentBad < r.signal.minCount || r.recentTotal === 0) return false;
  if (r.recentRate < r.signal.floor) return false;
  if (r.signal.steady) return true;
  return r.baselineRate === 0 || r.recentRate >= 2 * r.baselineRate;
}

// The recent window a signal is read over; the query reads it plus a week of baseline.
export function signalWindow(signal: Signal): { recent: string } {
  return { recent: signal.steady?.window ?? "6 hours" };
}

export async function readSignals(): Promise<SignalReading[]> {
  const out: SignalReading[] = [];
  for (const signal of SIGNALS) {
    const w = signalWindow(signal);
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${w.recent}' AND (${signal.bad}))::int AS recent_bad,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${w.recent}' AND (${signal.total}))::int AS recent_total,
         COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '${w.recent}' AND (${signal.bad}))::int AS base_bad,
         COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '${w.recent}' AND (${signal.total}))::int AS base_total
       FROM harness_decisions WHERE created_at > NOW() - INTERVAL '7 days' - INTERVAL '${w.recent}'`,
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

// To Royce only, never the team inbox (services/reportEmail.ts, 2026-09-30).
async function sendTeamEmail(subject: string, html: string): Promise<void> {
  await sendReportEmail(subject, html);
}

export async function runMonitor(): Promise<void> {
  try {
    const readings = await readSignals();
    for (const r of readings.filter(shouldAlert)) {
      const claimed = await pool.query(
        `INSERT INTO harness_alerts (signal_key, sent_at) VALUES ($1, NOW())
         ON CONFLICT (signal_key) DO UPDATE SET sent_at = NOW() WHERE harness_alerts.sent_at < NOW() - make_interval(hours => $2::int)
         RETURNING signal_key`,
        [r.signal.key, r.signal.steady?.repeatHours ?? 12],
      );
      if (!claimed.rows[0]) continue;
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const detail = r.signal.steady
        ? `${r.signal.label}: ${pct(r.recentRate)} over the last ${r.signal.steady.window} (${r.recentBad} of ${r.recentTotal}).`
        : `${r.signal.label}: ${pct(r.recentRate)} in the last 6 hours (${r.recentBad} of ${r.recentTotal}), vs ${pct(r.baselineRate)} over the past week.`;
      await recordDecision({ layer: 3, decision: "monitor.alert", userId: null, outcome: "act", action: r.signal.key, reason: detail });
    }
  } catch (err: any) {
    console.error("monitor: run failed (non-fatal):", err?.message ?? err);
  }
}

// An alert that can't wait for the hourly signal check (the send breaker,
// 2026-09-24). One email per key per hour at most.
export async function alertTeamNow(key: string, subject: string, detail: string): Promise<void> {
  const claimed = await pool.query(
    `INSERT INTO harness_alerts (signal_key, sent_at) VALUES ($1, NOW())
     ON CONFLICT (signal_key) DO UPDATE SET sent_at = NOW() WHERE harness_alerts.sent_at < NOW() - INTERVAL '1 hour'
     RETURNING signal_key`,
    [key],
  );
  if (!claimed.rows[0]) return;
  await sendTeamEmail(subject, `<p>${detail}</p>`).catch((err: any) => console.error("monitor: alert email failed (non-fatal):", err?.message ?? err));
  await recordDecision({ layer: 3, decision: "monitor.alert", userId: null, outcome: "act", action: key, reason: detail }).catch(() => {});
}


// ---------------------------------------------------------------------------
// Weekly review

export type ReviewMoment = { userId: string | null; at: string; decision: string; action: string | null; reason: string | null; around: string[] };

export async function gatherWeekMoments(days = 7): Promise<ReviewMoment[]> {
  const { rows } = await pool.query(
    `SELECT user_id, created_at, decision, action, reason FROM harness_decisions
     WHERE created_at > NOW() - ($1 || ' days')::interval AND (
       (decision = 'reply.grounding' AND action IN ('cut', 'redrafted', 'stripped'))
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
    const [moments, readings, metrics] = await Promise.all([
      gatherWeekMoments(),
      readSignals(),
      // The business numbers ride along weekly (2026-09-22); a failure here
      // never blocks the review itself.
      computeMetrics(30).catch((err: any) => (console.error("weekly review: metrics failed (non-fatal):", err?.message ?? err), null)),
    ]);
    await sendTeamEmail(`Co weekly review: ${moments.length} moments`, renderWeeklyReview(moments, readings) + (metrics ? `\n${renderMetricsHtml(metrics)}` : ""));
  } catch (err: any) {
    console.error("weekly review failed (non-fatal):", err?.message ?? err);
  }
}
