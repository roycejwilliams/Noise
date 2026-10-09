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
import { digestRecipient, reviewEnabled } from "../harness/devReview.js";
import { holdDueDates, selectForMember, selectSignature, SELECT_MODEL, type Judgment, type PoolItem, type SelectContext } from "./sweepSelect.js";
import { dayOf, loadAsks, loadKnowledge, loadMemberContext, type Q } from "./sweepSelectContext.js";
import { memberZone } from "./memberTime.js";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const shadowKey = (name: string, date: string | null) => `${norm(name)}|${date ?? ""}`;

// Live since 2026-10-09 (Royce, 2026-10-08: "switch the shadow picker to live for my account"): for these accounts the picker
// decides WHAT is sent and the queue decides HOW. The per-ask sweep only feeds the backlog (eventSurfacingSweep.ts
// pickerDecides); each "send" verdict is queued through the same send step as every find (queuePickedOffer). co-test only.
export const pickerLive = () => reviewEnabled();
export const pickerUserIds = (env: NodeJS.ProcessEnv = process.env) => shadowUserIds(env);

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
// live sweep), each tagged with the asks it serves.
export function buildShadowPool(raw: RawCandidate[], today: string, askNumber: Map<string, string>, sentNames: Set<string>): PoolItem[] {
  const items = new Map<string, PoolItem>();
  for (const r of raw) {
    if (!r.name || (r.date && r.date < today)) continue;
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
export async function runSweepShadow(userId: string, now = new Date(), opts: { dryRun?: boolean } = {}): Promise<ShadowRun | null> {
  const q: Q = async (sql, args = []) => (await pool.query(sql, args as any[])).rows;
  // Their day, in their zone (memberTime.ts, the one source; Pacific only when none is known).
  const zone = await memberZone(userId);
  const { today, weekday } = dayOf(now, zone);
  // Once a day.
  const done = await q(`SELECT 1 FROM harness_decisions WHERE decision = 'sweep.select.shadow' AND user_id = $1 AND proposal->>'day' = $2 AND action IS DISTINCT FROM 'error' LIMIT 1`, [userId, today]);
  if (done.length && !opts.dryRun) return null;

  const backlogs = await q(`SELECT ask_id, items FROM event_backlogs WHERE user_id = $1`, [userId]);
  const queued = await q(`SELECT payload FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'pending'`, [userId]);
  const raw: RawCandidate[] = [
    ...backlogs.flatMap((b: any) =>
      (Array.isArray(b.items) ? b.items : []).map((it: any) => ({
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
  const ctx: SelectContext = { ...(await loadMemberContext(q, userId, now, { knowledge })), today, weekday, asks, pool: buildShadowPool(raw, today, idFor, sentNames) };

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
  // The picks go in before the run is recorded: the record is what marks today done (review of #116).
  if (!opts.dryRun) await applyPicks(userId, r.judgments, backlogs, today).catch((err: any) => console.error("picker: applying the picks failed (non-fatal):", err?.message ?? err));
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
export function planPicks(judgments: Pick<Judgment, "key" | "verdict" | "why" | "whyNow" | "name">[], backlog: Waiting[], waitingKeys: { id: string; key: string }[]): { queue: (Waiting & { why: string })[]; reject: { id: string; why: string }[]; unqueue: { id: string; why: string }[] } {
  const verdictOf = new Map(judgments.map((j) => [j.key, j]));
  const queue: (Waiting & { why: string })[] = [];
  const rank = (b: Waiting) => (b.reminder || b.again ? 0 : 1) * 2 + Number(b.fromProfile);
  for (const j of judgments.filter((x) => x.verdict === "send")) {
    const from = backlog.filter((b) => shadowKey(String(b.match?.name ?? ""), dateOf(b.match)) === j.key).sort((a, b) => rank(a) - rank(b))[0];
    if (from) queue.push({ ...from, why: memberSafeWhy([j.why, j.whyNow].filter(Boolean).join(" ")) });
  }
  const why = (j: { verdict: string; why?: string } | undefined) => `Co's daily pick: ${j?.verdict}${j?.why ? `, ${String(j.why).slice(0, 160)}` : ""}`;
  const reject = waitingKeys.filter((w) => verdictOf.get(w.key)?.verdict === "reject").map((w) => ({ id: w.id, why: why(verdictOf.get(w.key)) }));
  const unqueue = waitingKeys.filter((w) => verdictOf.get(w.key)?.verdict === "hold").map((w) => ({ id: w.id, why: why(verdictOf.get(w.key)) }));
  return { queue, reject, unqueue };
}

async function applyPicks(userId: string, judgments: Judgment[], backlogs: any[], today: string): Promise<void> {
  if (!pickerLive() || !(await pickerUserIds()).includes(userId)) return;
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
  const queuedNames: string[] = [];
  for (const q of plan.queue) {
    const ok = await queuePickedOffer(userId, { askId: q.askId, askText: q.askText, fromProfile: q.fromProfile, match: q.match, reminder: q.reminder, again: q.again, why: q.why }).catch((err: any) => {
      console.error("picker: queueing a pick failed (non-fatal):", err?.message ?? err);
      return false;
    });
    if (ok) queuedNames.push(String(q.match?.name ?? ""));
  }
  await recordDecision({ layer: 5, decision: "sweep.select.queue", userId, outcome: queuedNames.length ? "act" : "skip", action: `queued ${queuedNames.length}, rejected ${plan.reject.length}, held back ${plan.unqueue.length}`, proposal: { day: today, queued: queuedNames, chosen: judgments.filter((j) => j.verdict === "send").map((j) => j.name), rejected: plan.reject, heldBack: plan.unqueue } });
}

export async function runSweepShadowAll(now = new Date()): Promise<void> {
  if (!reviewEnabled()) return;
  for (const id of await shadowUserIds()) {
    await runSweepShadow(id, now).catch((err: any) => console.error(`sweep shadow failed for ${id} (non-fatal):`, err?.message ?? err));
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
