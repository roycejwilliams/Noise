// The shadow week (Royce, 2026-10-02): Co's sweep selection
// (services/sweepSelect.ts) runs every day next to the live sweep, on the real
// candidates with their full details, and sends nothing. Each run is logged
// (sweep.select.shadow) with every candidate's verdict and reason. The report
// is internal, not emailed (Royce, 2026-10-02: daily emails cost too much):
// `npm run shadow` prints what the old rules queued and texted beside what Co
// would have sent, and why. Royce judges at the end of the week and decides
// the switch.
//
// Royce's account only (SWEEP_SHADOW_USER_IDS, else the morning-report
// recipient), and only on co-test with the dev review on (reviewEnabled), so
// it can never run in production.
import pool from "../db/db.js";
import { DateTime } from "luxon";
import { recordDecision } from "../harness/core.js";
import { judgeSweepItem } from "../brain/index.js";
import { digestRecipient, reviewEnabled } from "../harness/devReview.js";
import { holdDueDates, selectForMember, selectSignature, SELECT_MODEL, type Judgment, type PoolItem, type SelectContext } from "./sweepSelect.js";
import { dayOf, loadAsks, loadKnowledge, loadMemberContext, type Q } from "./sweepSelectContext.js";
import { memberZone } from "./memberTime.js";
import { exitKey } from "./findForm.js";
import { closedAskRefs, servesClosedAsk } from "./askLifecycle.js";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const shadowKey = (name: string, date: string | null) => `${norm(name)}|${date ?? ""}`;

// Live since 2026-10-09 (Royce, 2026-10-08: "switch the shadow picker to live for my account"): for these accounts the picker
// decides WHAT is sent and the queue decides HOW. The per-ask sweep only feeds the backlog (eventSurfacingSweep.ts
// pickerDecides); each "send" verdict is queued through the same send step as every find (queuePickedOffer). co-test only.
export const pickerLive = () => reviewEnabled();
// Every member since 2026-10-13 (Royce: "turn it on for all members, but not as a once-a-day 10am gate. The picker runs after each sweep
// completes for a member (floor and hourly)"; later: "I want the sweeps to run for everyone"): everyone's picker runs after each of
// their sweeps (runPickerAfterSweep), and the shadow accounts (shadowUserIds) also keep their 10am run.
export const pickerUserIds = async (_env: NodeJS.ProcessEnv = process.env): Promise<string[]> =>
  (await pool.query(`SELECT id FROM users WHERE archived_at IS NULL AND phone_number IS NOT NULL AND phone_number NOT LIKE '%#%' AND identity_captured = true AND invite_verified = true`)).rows.map((r: any) => String(r.id));

export async function shadowUserIds(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const ids = (env.SWEEP_SHADOW_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) return ids;
  const me = await digestRecipient(env);
  return me ? [me] : [];
}

type RawCandidate = { name: string; date: string | null; tier: number; askId: string | null; fromProfile: boolean; reminder: boolean; again?: boolean; details: string | null };

// Pure: the pool from what's waiting (the event backlogs and the queued
// offers): deduped by name + date, past ones and things already sent dropped
// (a reminder, or a month-later resurface, of a sent thing stays, as in the
// live sweep), each tagged with the asks it serves. A find for an ask that has closed is dead and left out (a reminder stays).
export function buildShadowPool(raw: RawCandidate[], today: string, askNumber: Map<string, string>, sentNames: Set<string>, closedAsks: ReadonlySet<string> = new Set()): PoolItem[] {
  const items = new Map<string, PoolItem>();
  for (const r of raw) {
    if (!r.name || (r.date && r.date < today)) continue;
    if (servesClosedAsk(r, closedAsks)) continue;
    if (sentNames.has(norm(r.name)) && !r.reminder && !r.again) continue;
    const key = shadowKey(r.name, r.date);
    const it = items.get(key) ?? { id: "", key, name: r.name, date: r.date, tier: r.tier, kind: "discovery" as const, asks: [] as string[], shortNotice: !!r.date && DateTime.fromISO(r.date).diff(DateTime.fromISO(today), "days").days <= 2, details: r.details };
    const a = !r.fromProfile && r.askId ? askNumber.get(r.askId) : undefined;
    if (a && !it.asks.includes(a)) it.asks.push(a);
    if (a) it.kind = "answer";
    if (!it.details && r.details) it.details = r.details;
    items.set(key, it);
  }
  return [...items.values()].map((it, i) => ({ ...it, id: `C${i + 1}` }));
}

// Pure: the backlogs with every find waiting for a closed ask taken out (a reminder stays), and what came out, by the key each
// backlog item is stored under (findForm.ts exitKey), per ask.
export function splitDeadBacklog<B extends { ask_id: string; items: any }>(backlogs: B[], closed: ReadonlySet<string>): { live: B[]; dead: { askId: string; keys: string[]; names: string[] }[] } {
  const dead: { askId: string; keys: string[]; names: string[] }[] = [];
  const live = backlogs.map((b) => {
    const items = Array.isArray(b.items) ? b.items : [];
    const out = items.filter((it: any) => servesClosedAsk({ askId: b.ask_id, reminder: !!it?.reminder }, closed));
    const kept = items.filter((it: any) => !out.includes(it));
    // The backlog is changed by key: a key a kept reminder shares stays.
    const keptKeys = new Set(kept.map((it: any) => exitKey(it?.match ?? {})));
    if (out.length) dead.push({ askId: String(b.ask_id), keys: [...new Set(out.map((it: any) => exitKey(it?.match ?? {})))].filter((k) => !keptKeys.has(k)), names: out.map((it: any) => String(it?.match?.name ?? "")) });
    return out.length ? { ...b, items: kept } : b;
  });
  return { live, dead };
}

// The date that matters: the event's, or an opening's deadline (eventSurfacingSweep relevantDate).
const dateOf = (m: any): string | null => (m?.event_date ? String(m.event_date).slice(0, 10) : m?.deadline ? String(m.deadline).slice(0, 10) : null);

// Pure: what the thing's own record says, for the prompt. Events carry a
// structured EventDetails in `details` (venue, time, hosts, price, sold out,
// description); openings carry the source post's text in `opportunity`
// (tieredRecommendation.ts MatchExtras, eventDetails.ts). The finder's own
// "why it fits" is left out on purpose: Co judges fresh. (Review of #57: only
// plain-string fields were read, so events reached the model as a name.)
export function describeMatch(m: any): string | null {
  const d = m?.details && typeof m.details === "object" ? m.details : null;
  const parts: string[] = [];
  if (d) {
    if (d.soldOut) parts.push("SOLD OUT");
    if (typeof d.spotsRemaining === "number") parts.push(`${d.spotsRemaining} spots left`);
    if (d.requiresApproval) parts.push("needs host approval");
    if (d.startAt) parts.push(`starts ${String(d.startAt).replace("T", " ").slice(0, 16)}${d.endAt ? `, ends ${String(d.endAt).replace("T", " ").slice(11, 16)}` : ""}`);
    if (d.online) parts.push("online");
    const where = [d.venue, d.address, d.city].filter(Boolean).join(", ");
    if (where) parts.push(where);
    if (Array.isArray(d.hosts) && d.hosts.length) parts.push(`hosted by ${d.hosts.slice(0, 3).join(", ")}`);
    if (d.price) parts.push(String(d.price));
    if (typeof d.guestCount === "number") parts.push(`${d.guestCount} going`);
    if (d.description) parts.push(String(d.description));
  } else if (typeof m?.details === "string") parts.push(m.details);
  const post = typeof m?.opportunity?.postText === "string" ? m.opportunity.postText.trim() : "";
  if (post) parts.push(post);
  // evidence is often the same text the post was filled from; don't say it twice.
  if (typeof m?.evidence === "string" && m.evidence.trim() && m.evidence.trim() !== post) parts.push(m.evidence);
  if (typeof m?.category === "string" && m.category.trim()) parts.push(m.category);
  if (!d?.city && typeof m?.city === "string") parts.push(m.city);
  if (m?.url) parts.push(`(${String(m.url).replace(/^https?:\/\//, "").split("/")[0]})`);
  return parts.length ? parts.join("; ").replace(/\s+/g, " ").slice(0, 500) : null;
}

export type ShadowRun = { day: string; signature: string; skipped: boolean; judgments: Judgment[]; pool: PoolItem[]; error?: string };

// dryRun: decide and return, but write nothing (a local check).
// Goal finds that haven't produced anything for this long, while their asks keep getting sends, are logged for review.
export const GOAL_STARVE_DAYS = 7;
const DAY_MS = 86_400_000;

// Pure: are their goals being starved? They have active goals, what they asked for got sends in the window, and no goal find has
// gone out in GOAL_STARVE_DAYS (or ever, for someone with goals on file that long).
export function goalsStarved(o: { now: Date; activeGoals: number; askSends: number; lastGoalSend: Date | null; goalsSince: Date | null }): { starved: boolean; days: number | null } {
  const since = o.lastGoalSend ?? o.goalsSince;
  const days = since ? Math.floor((o.now.getTime() - since.getTime()) / DAY_MS) : null;
  if (!o.activeGoals || !o.askSends || days === null) return { starved: false, days };
  return { starved: days >= GOAL_STARVE_DAYS, days };
}

async function noteGoalStarvation(q: Q, userId: string, now: Date, today: string): Promise<void> {
  const [prof] = await q(`SELECT goals, intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const { goalSweepGoals } = await import("./goalSweep.js");
  const goals = prof ? goalSweepGoals(prof) ?? [] : [];
  const { goalHash } = await import("./goalEdges.js");
  const closed = new Set((await q(`SELECT goal_hash FROM goal_states WHERE user_id = $1 AND state <> 'active'`, [userId])).map((r: any) => String(r.goal_hash)));
  const activeGoals = goals.filter((g) => !closed.has(goalHash(g))).length;
  const sent = await q(
    `SELECT COALESCE(payload->>'fromProfile', 'false') = 'true' AS goal, COUNT(*) FILTER (WHERE COALESCE(decided_at, updated_at) >= $2::timestamptz - make_interval(days => $3))::int AS recent, MAX(COALESCE(decided_at, updated_at)) AS last
     FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' GROUP BY 1`,
    [userId, now, GOAL_STARVE_DAYS],
  );
  const goalRow = sent.find((r: any) => r.goal === true);
  const askRow = sent.find((r: any) => r.goal === false);
  // How long their goals have been on file for the sweep: its first plan for them.
  const [first] = await q(`SELECT MIN(created_at) AS at FROM harness_decisions WHERE user_id = $1 AND decision = 'goal_sweep.plan'`, [userId]);
  const v = goalsStarved({ now, activeGoals, askSends: Number(askRow?.recent ?? 0), lastGoalSend: goalRow?.last ? new Date(goalRow.last) : null, goalsSince: first?.at ? new Date(first.at) : null });
  if (!v.starved) return;
  const [already] = await q(`SELECT 1 FROM harness_decisions WHERE user_id = $1 AND decision = 'sweep.goals_starved' AND proposal->>'day' = $2 LIMIT 1`, [userId, today]);
  if (already) return;
  await recordDecision({
    layer: 5, decision: "sweep.goals_starved", userId, outcome: "skip", action: "flag",
    reason: `no goal find sent in ${v.days} days while ${askRow?.recent ?? 0} ask find(s) went out in the last ${GOAL_STARVE_DAYS}`,
    proposal: { day: today, days: v.days, activeGoals, askSends: Number(askRow?.recent ?? 0), lastGoalSend: goalRow?.last ?? null },
  });
}

// trigger "urgent_find": a sweep found something that ends before the next scheduled pick (eventSurfacingSweep.ts endsBeforeNextPick);
// it runs the pick now, at most URGENT_PICK_RUNS_PER_DAY times a day.
export const URGENT_PICK_RUNS_PER_DAY = 3;
// trigger "retry": the hourly retry (jobs/index.ts) of a day whose run errored, or never ran. A day that keeps failing stops after
// PICK_ERRORS_PER_DAY errors, so a failure that won't clear doesn't pay for a picker run every hour.
export const PICK_ERRORS_PER_DAY = 3;
export async function runSweepShadow(userId: string, now = new Date(), opts: { dryRun?: boolean; trigger?: "urgent_find" | "retry" | "after_sweep" } = {}): Promise<ShadowRun | null> {
  const q: Q = async (sql, args = []) => (await pool.query(sql, args as any[])).rows;
  // Their day, in their zone (memberTime.ts, the one source; Pacific only when none is known).
  const zone = await memberZone(userId);
  const { today, weekday } = dayOf(now, zone);
  // Once a day, unless they told Co what kind of room they want since today's run: that re-runs it (Royce, 2026-10-09).
  const done = await q(
    `SELECT 1 FROM harness_decisions d WHERE d.decision = 'sweep.select.shadow' AND d.user_id = $1 AND d.proposal->>'day' = $2 AND d.action IS DISTINCT FROM 'error'
       AND NOT EXISTS (SELECT 1 FROM co_memories m WHERE m.user_id = $1 AND m.memory_type = 'room_taste' AND m.created_at > d.created_at)
     LIMIT 1`,
    [userId, today],
  );
  if (opts.trigger === "retry" && !done.length && !opts.dryRun) {
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM harness_decisions WHERE decision = 'sweep.select.shadow' AND user_id = $1 AND proposal->>'day' = $2 AND action = 'error'`, [userId, today]);
    if (Number(n) >= PICK_ERRORS_PER_DAY) return null;
  }
  // After a sweep (runPickerAfterSweep), the picker runs again whenever the pool changed: not once a day (the unchanged check below
  // skips it cheaply when nothing new came in).
  if (done.length && !opts.dryRun && opts.trigger !== "after_sweep") {
    if (opts.trigger !== "urgent_find") return null;
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM harness_decisions WHERE decision = 'sweep.select.shadow' AND user_id = $1 AND proposal->>'day' = $2`, [userId, today]);
    if (Number(n) >= URGENT_PICK_RUNS_PER_DAY + 1) return null;
  }
  // Dead backlog: a find waiting for an ask that has closed (done, dropped or declined) leaves the pool, the picks and its backlog
  // (Royce, 2026-10-12: 4 of 7 picks on Oct 9 were for asks already closed). A reminder is exempt. A queued one is dropped at
  // dispatch (harness/proactive.ts). The member's ask state is the source. Cleared before the prune, so it pays no page reads.
  const closed = await closedAskRefs(userId, now, { query: async (sql, args) => ({ rows: await q(sql, args) }) });
  if (!opts.dryRun) {
    const { dead } = splitDeadBacklog(await q(`SELECT ask_id, items FROM event_backlogs WHERE user_id = $1`, [userId]), closed);
    for (const d of dead) await realPruneDeps.merge(userId, d.askId, { remove: new Set(d.keys), replace: new Map() }).catch((err: any) => console.error("picker: clearing a closed ask's backlog failed (non-fatal):", err?.message ?? err));
  }
  // The working set (services/workingSet.ts): past and undated backlog items exit, with their facts, before the pool is built, so
  // the picker never re-judges them.
  if (!opts.dryRun) await import("./workingSet.js").then((W) => W.pruneBacklogs(userId, today, realPruneDeps)).catch((err: any) => console.error("picker: backlog prune failed (non-fatal):", err?.message ?? err));
  // Asks win contested slots, and goals must not starve for it (Royce, 2026-10-09): logged for review, once a day, nothing held.
  if (!opts.dryRun) await noteGoalStarvation(q, userId, now, today).catch((err: any) => console.error("picker: goal starvation check failed (non-fatal):", err?.message ?? err));

  const { live: backlogs } = splitDeadBacklog(await q(`SELECT ask_id, items FROM event_backlogs WHERE user_id = $1`, [userId]), closed);
  const queued = (await q(`SELECT payload FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'pending'`, [userId])).filter((c: any) => !servesClosedAsk({ askId: c.payload?.askId, reminder: c.payload?.reminder }, closed));
  const raw: RawCandidate[] = [
    ...backlogs.flatMap((b: any) =>
      (Array.isArray(b.items) ? b.items : []).filter((it: any) => !it?.unread).map((it: any) => ({
        name: String(it?.match?.name ?? ""),
        date: dateOf(it?.match),
        tier: Number(it?.match?.tier ?? 0),
        askId: b.ask_id && b.ask_id !== "profile" ? String(b.ask_id) : null,
        fromProfile: b.ask_id === "profile",
        reminder: !!it?.reminder,
        details: describeMatch(it?.match),
        again: !!it?.again,
      })),
    ),
    ...queued.map((c: any) => {
      const p = c.payload ?? {};
      const m = p.match ?? {};
      return { name: String(m.name ?? ""), date: dateOf(m), tier: Number(m.tier ?? 0), askId: p.askId && p.askId !== "profile" ? String(p.askId) : null, fromProfile: p.fromProfile === true, reminder: !!p.reminder, again: !!p.again, details: describeMatch(m) };
    }),
  ];
  const askIds = [...new Set(raw.map((r) => r.askId).filter((x): x is string => !!x))];
  const { asks, idFor } = await loadAsks(q, userId, now, askIds, zone);
  // What they know about: the shared member layer (services/memberKnowledge.ts), read once for this run. null = it failed closed.
  const knowledge = await loadKnowledge(userId, now);
  // The layer failed closed: no picking blind (review of #120: with no goals, texts or delivered list the picker could send what
  // they'd declined or already have, on a live account). The day is logged as an error, which the once-a-day check retries.
  if (!knowledge) {
    if (!opts.dryRun) await recordDecision({ layer: 5, decision: "sweep.select.shadow", userId, outcome: "skip", action: "error", reason: "member knowledge unavailable (failed closed); no picks today", proposal: { day: today } });
    return { day: today, signature: "", skipped: true, judgments: [], pool: [], error: "member knowledge unavailable" };
  }
  // Never re-pick what they already have: the offers Co sent, plus everything the layer has as delivered (receipts, Co's ledger,
  // sent offers). A reminder or a month-later resurface still stays (buildShadowPool).
  const sentNames = new Set(
    [
      ...(await q(`SELECT payload->'match'->>'name' AS name FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent'`, [userId])).map((r: any) => String(r.name ?? "")),
      ...(knowledge?.delivered ?? []).map((d) => d.what),
    ].map(norm).filter(Boolean),
  );
  const ctx: SelectContext = { ...(await loadMemberContext(q, userId, now, { knowledge })), today, weekday, asks, pool: buildShadowPool(raw, today, idFor, sentNames, closed) };

  // Skip unchanged days: same signature as the last run (holds that came due count as a change).
  const [last] = await q(`SELECT proposal FROM harness_decisions WHERE decision = 'sweep.select.shadow' AND user_id = $1 AND outcome = 'act' ORDER BY created_at DESC LIMIT 1`, [userId]);
  const holds = holdDueDates((last?.proposal?.judgments ?? []) as Judgment[], String(last?.proposal?.day ?? today));
  const signature = selectSignature(ctx, holds);
  if (!ctx.pool.length || (last?.proposal?.signature === signature && !opts.dryRun)) {
    if (!opts.dryRun) await recordDecision({ layer: 5, decision: "sweep.select.shadow", userId, outcome: "skip", action: ctx.pool.length ? "unchanged" : "empty_pool", proposal: { day: today, signature, poolSize: ctx.pool.length } });
    return { day: today, signature, skipped: true, judgments: [], pool: ctx.pool };
  }

  const r = await selectForMember(ctx, { model: process.env.SWEEP_SELECT_MODEL || SELECT_MODEL, userId });
  // A failed selection is logged as an error, never as a run: it isn't the
  // "last run" tomorrow's unchanged check compares against, so it can't be
  // silently skipped (review of #57).
  if (r.error) {
    if (!opts.dryRun) await recordDecision({ layer: 5, decision: "sweep.select.shadow", userId, outcome: "skip", action: "error", reason: r.error, proposal: { day: today, model: r.model, usage: r.usage, raw: r.raw.slice(0, 20_000), poolSize: ctx.pool.length } });
    return { day: today, signature, skipped: true, judgments: r.judgments, pool: ctx.pool, error: r.error };
  }
  const count = (v: string) => r.judgments.filter((j) => j.verdict === v).length;
  // The picks go in before the run is recorded: the record is what marks today done (review of #116). What applying them did is
  // reported (chosen, queued, error); a failed apply, or one that queued none of its picks, logs the day as an error, so the retry
  // runs it again (Royce, 2026-10-12: it swallowed its errors and still marked the day done). The retry is idempotent: a pick a
  // partial apply already queued merges into its own row (one per thing), and one already sent is out of the pool.
  const applied = newApplyReport(r.judgments);
  if (!opts.dryRun) await applyPicks(userId, r.judgments, backlogs, today, r.set ?? null, applied);
  const applyError = opts.dryRun ? null : applyFailed(applied);
  if (applyError) {
    await recordDecision({ layer: 5, decision: "sweep.select.shadow", userId, outcome: "skip", action: "error", reason: applyError, proposal: { day: today, signature, model: r.model, usage: r.usage, poolSize: ctx.pool.length, judgments: r.judgments, applied } });
    return { day: today, signature, skipped: false, judgments: r.judgments, pool: ctx.pool, error: applyError };
  }
  if (!opts.dryRun) await recordDecision({
    layer: 5,
    decision: "sweep.select.shadow",
    userId,
    outcome: "act",
    action: `${count("send")} send, ${count("hold")} hold, ${count("reject")} reject`,
    proposal: {
      day: today,
      signature,
      model: r.model,
      usage: r.usage,
      pool: ctx.pool.map((p) => ({ id: p.id, key: p.key, name: p.name, date: p.date, kind: p.kind, asks: p.asks })),
      asks: asks.map((a) => ({ id: a.id, text: a.text.slice(0, 160) })),
      judgments: r.judgments,
      raw: r.raw.slice(0, 20_000),
      applied,
    },
  });
  return { day: today, signature, skipped: false, judgments: r.judgments, pool: ctx.pool };
}

type Waiting = { askId: string; askText: string; fromProfile: boolean; match: any; reminder?: boolean; again?: boolean };

// Pure: the picker's reason, as a member may read it. Its judgments cite records by internal id (A17, T3, S2, O1, C9), which
// must never reach a text (review of #116).
export function memberSafeWhy(why: string): string {
  return why
    .replace(/\s*[([]\s*(?:[ATSOC]\d+\s*(?:[,/\-\u2013]|and)?\s*)+[)\]]/g, "")
    .replace(/\b[ATSOC]\d+\s*[-\u2013]\s*[ATSOC]\d+\b/g, "")
    .replace(/\b(?:asks?|texts?|outcomes?|sends?)\s+[ATSOC]\d+(?:\s*(?:,|and|\/)\s*[ATSOC]\d+)*\b/gi, (m) => m.replace(/\s+[ATSOC]\d+.*$/i, ""))
    .replace(/\b[ATSOC]\d+(?:\s*(?:,|\/|and)\s*[ATSOC]\d+)*(?:'s)?\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

// Pure: what the picker's verdicts do to the queue (review of #116).
//   - each "send" queues its thing: a reminder or month-later resurface first (its original pitch is already sent), then an
//     ask's copy, then a goal find;
//   - a waiting find the picker rejected comes out for good;
//   - a waiting find the picker held (its own hold, or over the day's send limit) goes back to waiting in the backlog only,
//     so a later "send" can queue it again; it never sends while held.
//   - a waiting find the picker never saw is left alone.
// whyMember and whyNow stay apart for the composer (Phase C3: they were joined into one string, the "why now" lost as such); `why` is
// both, for the find's own whyItFits.
type Queued = Waiting & { why: string; whyMember: string; whyNow: string; lastDay?: string | null };
export function planPicks(judgments: Pick<Judgment, "key" | "verdict" | "why" | "whyNow" | "name" | "lastDay">[], backlog: Waiting[], waitingKeys: { id: string; key: string }[]): { queue: Queued[]; reject: { id: string; why: string }[]; unqueue: { id: string; why: string }[] } {
  const verdictOf = new Map(judgments.map((j) => [j.key, j]));
  // What each guarded verdict does is the brain's decision (brain/index.ts judgeSweepItem): deliver queues, a drop comes out for good,
  // a wait goes back to waiting. The queue acts only on those.
  const decided = new Map(judgments.map((j) => [j.key, judgeSweepItem(j)]));
  const queue: Queued[] = [];
  const rank = (b: Waiting) => (b.reminder || b.again ? 0 : 1) * 2 + Number(b.fromProfile);
  for (const j of judgments.filter((x) => decided.get(x.key)?.kind === "deliver")) {
    const from = backlog.filter((b) => shadowKey(String(b.match?.name ?? ""), dateOf(b.match)) === j.key).sort((a, b) => rank(a) - rank(b))[0];
    if (from) queue.push({ ...from, why: memberSafeWhy([j.why, j.whyNow].filter(Boolean).join(" ")), whyMember: memberSafeWhy(j.why ?? ""), whyNow: memberSafeWhy(j.whyNow ?? ""), lastDay: j.lastDay ?? null });
  }
  const why = (j: { verdict: string; why?: string } | undefined) => `Co's daily pick: ${j?.verdict}${j?.why ? `, ${String(j.why).slice(0, 160)}` : ""}`;
  const reject = waitingKeys.filter((w) => decided.get(w.key)?.drop === true).map((w) => ({ id: w.id, why: why(verdictOf.get(w.key)) }));
  // A hold waits; a find the picker gave no verdict is left alone (never seen).
  const unqueue = waitingKeys.filter((w) => { const d = decided.get(w.key); return d?.kind === "wait" && !d.drop && !d.leave; }).map((w) => ({ id: w.id, why: why(verdictOf.get(w.key)) }));
  return { queue, reject, unqueue };
}

// What applying the picks did, for the run's record and the queue record: what the picker chose, what queued, what didn't and why,
// and the error that stopped it. live: false for a member the picker only shadows (nothing is queued for them).
export type ApplyReport = { live: boolean; chosen: string[]; queued: string[]; notQueued: { name: string; why: string }[]; error: string | null };
export function newApplyReport(judgments: Pick<Judgment, "verdict" | "name">[]): ApplyReport {
  return { live: false, chosen: judgments.filter((j) => j.verdict === "send").map((j) => j.name), queued: [], notQueued: [], error: null };
}
// Pure: why the day's apply failed, or null. It failed when it threw, a pick errored, or it queued none of what it chose for a real
// error. Picks that were already decided, past or already there are a finished day, not a failure: a retry would change nothing
// (review of the sweep fixes).
export function applyFailed(a: ApplyReport): string | null {
  if (!a.live) return null;
  if (a.error) return `applying the picks failed: ${a.error}`.slice(0, 300);
  if (a.chosen.length && !a.queued.length && a.notQueued.some((n) => /^error:/.test(n.why))) return `none of the ${a.chosen.length} chosen picks queued${a.notQueued.length ? ` (${a.notQueued.map((n) => `${n.name}: ${n.why}`).join("; ")})` : ""}`.slice(0, 300);
  return null;
}

export async function applyPicks(userId: string, judgments: Judgment[], backlogs: any[], today: string, set: string | null, report: ApplyReport): Promise<void> {
  let plan: ReturnType<typeof planPicks> | null = null;
  try {
    if (!pickerLive() || !(await pickerUserIds()).includes(userId)) return;
    report.live = true;
    plan = await applyPicksInner(userId, judgments, backlogs, set, report);
  } catch (err: any) {
    report.error = String(err?.message ?? err).slice(0, 200);
    console.error("picker: applying the picks failed:", report.error);
  } finally {
    // Always written, whatever happened above.
    await recordDecision({ layer: 5, decision: "sweep.select.queue", userId, outcome: report.queued.length ? "act" : "skip", action: !report.live ? "not live" : report.error ? "error" : `queued ${report.queued.length}, rejected ${plan?.reject.length ?? 0}, held back ${plan?.unqueue.length ?? 0}`, reason: report.error, proposal: { day: today, queued: report.queued, chosen: report.chosen, notQueued: report.notQueued, rejected: plan?.reject ?? [], heldBack: plan?.unqueue ?? [] } });
  }
}

async function applyPicksInner(userId: string, judgments: Judgment[], backlogs: any[], set: string | null, report: ApplyReport): Promise<ReturnType<typeof planPicks>> {
  const { queuePickedOffer, onEventOfferDropped } = await import("./eventSurfacingSweep.js");
  const backlog: Waiting[] = backlogs.flatMap((b: any) =>
    (Array.isArray(b.items) ? b.items : []).map((it: any) => ({ askId: String(b.ask_id), askText: String(it?.askText ?? ""), fromProfile: b.ask_id === "profile", match: it?.match, reminder: !!it?.reminder, again: !!it?.again })),
  );
  const rows = (await pool.query(`SELECT id, payload FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'pending'`, [userId])).rows;
  const waiting = rows.map((r: any) => ({ id: String(r.id), key: shadowKey(String(r.payload?.match?.name ?? ""), dateOf(r.payload?.match)) }));
  const plan = planPicks(judgments, backlog, waiting);
  // Out first, so a held row doesn't block its own re-queue later.
  for (const d of plan.reject) {
    await pool.query(`UPDATE proactive_candidates SET status = 'skipped', skip_reason = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [d.id, d.why.slice(0, 300)]);
    // Out of every ask's backlog that holds the same thing, not only the one that queued it (re-review of #116).
    const k = waiting.find((w) => w.id === d.id)?.key;
    for (const b of backlog.filter((x) => k && shadowKey(String(x.match?.name ?? ""), dateOf(x.match)) === k)) await onEventOfferDropped(userId, { askId: b.askId, match: b.match } as any).catch(() => null);
  }
  // Held: the row goes (it would send), the thing stays in the backlog for the picker to judge again.
  for (const d of plan.unqueue) await pool.query(`DELETE FROM proactive_candidates WHERE id = $1 AND status = 'pending'`, [d.id]);
  // Every find the picker rejected, queued or not, leaves every backlog for good with its fact (services/workingSet.ts): before, only
  // queued rows came out, so the rest were judged again every morning.
  const rejectedFinds = judgments
    .filter((j) => j.verdict === "reject")
    // The reason goes through the member-safe filter: no record ids (A17), no internal labels (review of #133).
    .flatMap((j) => backlog.filter((b) => shadowKey(String(b.match?.name ?? ""), dateOf(b.match)) === j.key).map((b) => ({ key: exitKeyOf(b.match), name: String(b.match?.name ?? j.name), why: memberSafeWhy(String(j.why ?? j.reason ?? "")), askText: b.askText })));
  const uniq = [...new Map(rejectedFinds.map((r) => [r.key, r])).values()];
  await import("./workingSet.js").then((W) => W.exitRejectedFinds(userId, uniq, realPruneDeps)).catch((err: any) => console.error("picker: exiting rejected finds failed (non-fatal):", err?.message ?? err));
  // The finds the pick chose together, by the key each is queued under: the set line rides only with a bundle of exactly these.
  const setKeys = () => plan.queue.map((x) => offerTargetKeyOf({ match: x.match, reminder: x.reminder, again: x.again }));
  const { offerTargetKey: offerTargetKeyOf } = await import("./eventSurfacingSweep.js");
  for (const q of plan.queue) {
    // The pick's view of the set rides with each find it chose today, only when it chose more than one (Phase C3).
    const ok = await queuePickedOffer(userId, { askId: q.askId, askText: q.askText, fromProfile: q.fromProfile, match: q.match, reminder: q.reminder, again: q.again, why: q.why, lastDay: q.lastDay ?? null, pick: { whyMember: q.whyMember, whyNow: q.whyNow, set: plan.queue.length > 1 && set ? memberSafeWhy(set) : null, ...(plan.queue.length > 1 && set ? { setKeys: setKeys() } : {}) } }).catch((err: any) => {
      const msg = String(err?.message ?? err).slice(0, 200);
      console.error("picker: queueing a pick failed:", msg);
      // One pick erroring fails the day too: its retry queues what's missing, and what did queue merges into its own row.
      report.error ??= `queueing ${String(q.match?.name ?? "")} failed: ${msg}`;
      return `error: ${msg}`;
    });
    // Why a chosen pick didn't queue, on the record: already decided, past, already exists, or the error.
    if (ok === "queued") report.queued.push(String(q.match?.name ?? ""));
    else report.notQueued.push({ name: String(q.match?.name ?? ""), why: ok });
  }
  // A chosen pick with no backlog copy to queue: one already waiting in the queue is queued; anything else is said, never silent.
  const planned = new Set(plan.queue.map((x) => shadowKey(String(x.match?.name ?? ""), dateOf(x.match))));
  for (const j of judgments.filter((x) => x.verdict === "send" && !planned.has(x.key))) {
    if (waiting.some((w) => w.key === j.key)) report.queued.push(j.name);
    else report.notQueued.push({ name: j.name, why: "error: not in the backlog or the queue" });
  }
  return plan;
}

// They just said what kind of room they want: the picker re-ranks today, not tomorrow at 10 (Royce, 2026-10-09). Same gates as the
// daily run (reviewEnabled, the members it serves, and applyPicks only for picker members); the once-a-day guard lets it through
// because the taste is newer. noteRoomTaste's own limit (capabilities.ts, 3 a day) bounds how often.
export async function rerunPickerForUrgentFind(userId: string): Promise<void> {
  if (!reviewEnabled() || !(await shadowUserIds()).includes(userId)) return;
  await runSweepShadow(userId, new Date(), { trigger: "urgent_find" }).catch((err: any) => console.error(`picker run for an urgent find failed for ${userId} (non-fatal):`, err?.message ?? err));
}

// A kind they ruled out, applied to what's already waiting (services/workingSet.ts exitAvoidedFinds, Phase A2).
export const realAvoidDeps = {
  judge: async (items: { name: string; details: string }[], avoid: string[]) => (await (await import("./memberLimits.js")).judgeAvoided(items, avoid)).kinds,
  pending: async (userId: string) =>
    (await pool.query(`SELECT id, payload FROM proactive_candidates WHERE user_id = $1 AND status = 'pending' AND type = 'event_offer'`, [userId])).rows.map((r: any) => ({ id: String(r.id), match: r.payload?.match ?? {}, askText: r.payload?.askText ?? null })),
  skipPending: async (id: string, reason: string) => {
    await pool.query(`UPDATE proactive_candidates SET status = 'skipped', skip_reason = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [id, reason]);
  },
};

// The backlog, read and written where it lives (event_backlogs), for the working-set exits.
// Changes merge into the row as it is now, under a row lock, so a find a sweep saves meanwhile is never lost (review of #133).
export const realPruneDeps = {
  backlogs: async (userId: string) => (await pool.query(`SELECT ask_id, items FROM event_backlogs WHERE user_id = $1`, [userId])).rows,
  merge: async (userId: string, askId: string, change: import("./workingSet.js").BacklogChange) => {
    const W = await import("./workingSet.js");
    const F = await import("./findForm.js");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT items FROM event_backlogs WHERE user_id = $1 AND ask_id = $2 FOR UPDATE`, [userId, askId]);
      if (rows[0]) await client.query(`UPDATE event_backlogs SET items = $3, updated_at = NOW() WHERE user_id = $1 AND ask_id = $2`, [userId, askId, JSON.stringify(W.applyChange(rows[0].items, change, F.exitKey))]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
  classify: async (match: any, today: string) => (await import("./findForm.js")).classifyFind(match, today),
  zone: (userId: string) => memberZone(userId),
  key: (match: any) => exitKeyOf(match),
  exited: async (userId: string, keys: string[]) => (await import("./workingSet.js")).exitedFindKeys(userId, keys),
  setAsides: async (userId: string, itemKey: string) => (await import("./workingSet.js")).setAsideCount(userId, itemKey),
  writeFact: async (e: any) => (await import("./workingSet.js")).realExitDeps.writeFact(e),
};
// One key everywhere a find exits or is checked for having exited (services/findForm.ts exitKey).
const exitKeyOf = (match: any): string => exitKey(match);

export async function rerunPickerForTaste(userId: string): Promise<void> {
  // Only for members the daily picker serves (review of #132: anyone saving a taste got a paid picker run).
  if (!reviewEnabled() || !(await shadowUserIds()).includes(userId)) return;
  await runSweepShadow(userId).catch((err: any) => console.error(`picker rerun after taste failed for ${userId} (non-fatal):`, err?.message ?? err));
}

// The picker for one member, after one of their sweeps finishes (the 9am floor, the hourly ask sweep, the goal sweep), so a find from
// noon never waits until tomorrow. Everyone, the 10am review account too (Royce, 2026-10-13: "I want the sweeps to run for everyone");
// that account's 10am run stays on top. A failure is logged as that member's picker error; their next sweep runs it again.
export async function runPickerAfterSweep(userId: string, after: "daily" | "hourly" | "goal" | "call" | "new_ask"): Promise<void> {
  if (!pickerLive()) return;
  await runSweepShadow(userId, new Date(), { trigger: "after_sweep" }).then((r) => {
    // Counted for the daily rollup (how often the picker runs after sweeps, to set a cap from).
    if (r && !r.skipped) void recordDecision({ layer: 5, decision: "sweep.picker_after", userId, outcome: r.error ? "skip" : "act", action: r.error ? "error" : "ran", proposal: { after, day: r.day } });
  }).catch(async (err: any) => {
    console.error(`picker after the ${after} sweep failed for ${userId} (non-fatal, runs again after their next sweep):`, err?.message ?? err);
    await recordDecision({ layer: 5, decision: "sweep.select.shadow", userId, outcome: "skip", action: "error", reason: `the picker after the ${after} sweep failed: ${String(err?.message ?? err).slice(0, 200)}`, proposal: { after } });
  });
}

export async function runSweepShadowAll(now = new Date(), trigger?: "retry"): Promise<void> {
  if (!reviewEnabled()) return;
  for (const id of await shadowUserIds()) {
    await runSweepShadow(id, now, trigger ? { trigger } : {}).catch((err: any) => console.error(`sweep shadow failed for ${id} (non-fatal):`, err?.message ?? err));
  }
}

// For the internal report: a day's shadow run beside what the old rules
// queued (sweep.surface) and actually texted that day.
export type ShadowSection = {
  name: string;
  day: string;
  skipped: string | null;
  oldQueued: string[];
  oldTexted: string[];
  judgments: Judgment[];
  pool: { id: string; name: string; date: string | null }[];
};

export async function shadowSections(day: string, userIds?: string[]): Promise<ShadowSection[]> {
  const out: ShadowSection[] = [];
  for (const userId of userIds ?? (await shadowUserIds())) {
    const [run] = (await pool.query(`SELECT outcome, action, reason, proposal FROM harness_decisions WHERE decision = 'sweep.select.shadow' AND user_id = $1 AND proposal->>'day' = $2 ORDER BY created_at DESC LIMIT 1`, [userId, day])).rows;
    const [u] = (await pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId])).rows;
    const start = DateTime.fromISO(day, { zone: "America/Los_Angeles" }).startOf("day").toJSDate();
    const end = DateTime.fromISO(day, { zone: "America/Los_Angeles" }).endOf("day").toJSDate();
    const queued = (await pool.query(`SELECT DISTINCT proposal->'queued'->>'name' AS name FROM harness_decisions WHERE decision = 'sweep.surface' AND user_id = $1 AND created_at BETWEEN $2 AND $3 AND proposal->'queued' IS NOT NULL`, [userId, start, end])).rows.map((r: any) => String(r.name));
    const texted = (await pool.query(`SELECT type, message FROM proactive_sends WHERE user_id = $1 AND sent_at BETWEEN $2 AND $3 AND type IN ('event_offer', 'network_tease') ORDER BY sent_at`, [userId, start, end])).rows.map((r: any) => String(r.message ?? r.type).replace(/\s+/g, " ").slice(0, 160));
    out.push({
      name: u?.first_name ?? "Member",
      day,
      skipped: !run ? "didn't run" : run.outcome === "skip" ? (run.action === "unchanged" ? "nothing changed since the last run" : run.action === "error" ? `the selection failed: ${String(run.reason ?? "unknown").slice(0, 160)}` : "nothing in the pool") : null,
      oldQueued: queued,
      oldTexted: texted,
      judgments: run?.outcome === "act" ? (run.proposal?.judgments ?? []) : [],
      pool: run?.outcome === "act" ? (run.proposal?.pool ?? []) : [],
    });
  }
  return out;
}

// Pure: the report text for some days.
export function renderShadowReport(sections: ShadowSection[]): string {
  const lines: string[] = [];
  for (const s of sections) {
    lines.push(`\n=== ${s.day} (${s.name}) ===`);
    lines.push(`Old rules queued: ${s.oldQueued.length ? s.oldQueued.join("; ") : "nothing"}`);
    lines.push(`Old rules texted: ${s.oldTexted.length ? s.oldTexted.map((t) => `"${t}"`).join(" | ") : "nothing"}`);
    if (s.skipped) {
      lines.push(`Co: skipped (${s.skipped})`);
      continue;
    }
    const by = (v: string) => s.judgments.filter((j) => j.verdict === v);
    const date = (key: string) => s.pool.find((p) => p.id === key)?.date;
    lines.push(`Co would send (${by("send").length}):`);
    for (const j of by("send")) lines.push(`  + ${j.name}${date(j.id) ? ` (${date(j.id)})` : ""}\n      why them: ${j.why}${j.cites?.length ? ` [${j.cites.join(", ")}]` : ""}\n      why now: ${j.whyNow ?? ""}`);
    lines.push(`Co would hold (${by("hold").length}):`);
    for (const j of by("hold")) lines.push(`  ~ ${j.name}${j.until ? ` until ${j.until}` : ""}: ${j.why}${j.guard ? ` (${j.guard})` : ""}`);
    lines.push(`Co would reject (${by("reject").length}):`);
    for (const j of by("reject")) lines.push(`  - ${j.name} [${j.reason}]: ${j.guard ? `guard: ${j.guard}` : j.why}`);
    const none = by("no_verdict");
    if (none.length) lines.push(`No verdict (${none.length}): ${none.map((j) => j.name).join("; ")}`);
  }
  return lines.join("\n");
}
