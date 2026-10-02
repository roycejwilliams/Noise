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
import { selectForMember, selectSignature, SELECT_MODEL, type Judgment, type PoolItem, type SelectContext } from "./sweepSelect.js";
import { dayOf, loadAsks, loadMemberContext, type Q } from "./sweepSelectContext.js";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const shadowKey = (name: string, date: string | null) => `${norm(name)}|${date ?? ""}`;

export async function shadowUserIds(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const ids = (env.SWEEP_SHADOW_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) return ids;
  const me = await digestRecipient(env);
  return me ? [me] : [];
}

type RawCandidate = { name: string; date: string | null; tier: number; askId: string | null; fromProfile: boolean; reminder: boolean; details: string | null };

// Pure: the pool from what's waiting (the event backlogs and the queued
// offers): deduped by name + date, past ones and things already sent dropped
// (a reminder about a sent thing stays), each tagged with the asks it serves.
export function buildShadowPool(raw: RawCandidate[], today: string, askNumber: Map<string, string>, sentNames: Set<string>): PoolItem[] {
  const items = new Map<string, PoolItem>();
  for (const r of raw) {
    if (!r.name || (r.date && r.date < today)) continue;
    if (sentNames.has(norm(r.name)) && !r.reminder) continue;
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

const detailsOf = (m: any): string | null => {
  const parts = [m?.details, m?.evidence, m?.category, m?.city, m?.url ? `(${String(m.url).replace(/^https?:\/\//, "").split("/")[0]})` : null].filter((x) => typeof x === "string" && x.trim());
  return parts.length ? parts.join("; ").replace(/\s+/g, " ").slice(0, 300) : null;
};

export type ShadowRun = { day: string; signature: string; skipped: boolean; judgments: Judgment[]; pool: PoolItem[] };

// dryRun: decide and return, but write nothing (a local check).
export async function runSweepShadow(userId: string, now = new Date(), opts: { dryRun?: boolean } = {}): Promise<ShadowRun | null> {
  const q: Q = async (sql, args = []) => (await pool.query(sql, args as any[])).rows;
  const { today, weekday } = dayOf(now);
  // Once a day.
  const done = await q(`SELECT 1 FROM harness_decisions WHERE decision = 'sweep.select.shadow' AND user_id = $1 AND proposal->>'day' = $2 LIMIT 1`, [userId, today]);
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
        details: detailsOf(it?.match),
      })),
    ),
    ...queued.map((c: any) => {
      const p = c.payload ?? {};
      const m = p.match ?? {};
      return { name: String(m.name ?? ""), date: dateOf(m), tier: Number(m.tier ?? 0), askId: p.askId && p.askId !== "profile" ? String(p.askId) : null, fromProfile: p.fromProfile === true, reminder: !!p.reminder, details: detailsOf(m) };
    }),
  ];
  const askIds = [...new Set(raw.map((r) => r.askId).filter((x): x is string => !!x))];
  const { asks, idFor } = await loadAsks(q, userId, now, askIds);
  const sentNames = new Set(
    (await q(`SELECT payload->'match'->>'name' AS name FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent'`, [userId])).map((r: any) => norm(String(r.name ?? ""))).filter(Boolean),
  );
  const ctx: SelectContext = { ...(await loadMemberContext(q, userId, now)), today, weekday, asks, pool: buildShadowPool(raw, today, idFor, sentNames) };

  // Skip unchanged days: same signature as the last run (holds that came due count as a change).
  const [last] = await q(`SELECT proposal FROM harness_decisions WHERE decision = 'sweep.select.shadow' AND user_id = $1 AND outcome = 'act' ORDER BY created_at DESC LIMIT 1`, [userId]);
  const holds = ((last?.proposal?.judgments ?? []) as Judgment[]).filter((j) => j.verdict === "hold").map((j) => j.until ?? null);
  const signature = selectSignature(ctx, holds);
  if (!ctx.pool.length || (last?.proposal?.signature === signature && !opts.dryRun)) {
    if (!opts.dryRun) await recordDecision({ layer: 5, decision: "sweep.select.shadow", userId, outcome: "skip", action: ctx.pool.length ? "unchanged" : "empty_pool", proposal: { day: today, signature, poolSize: ctx.pool.length } });
    return { day: today, signature, skipped: true, judgments: [], pool: ctx.pool };
  }

  const r = await selectForMember(ctx, { model: process.env.SWEEP_SELECT_MODEL || SELECT_MODEL, userId });
  const count = (v: string) => r.judgments.filter((j) => j.verdict === v).length;
  if (!opts.dryRun) await recordDecision({
    layer: 5,
    decision: "sweep.select.shadow",
    userId,
    outcome: "act",
    action: `${count("send")} send, ${count("hold")} hold, ${count("reject")} reject`,
    reason: r.error ?? undefined,
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
    const [run] = (await pool.query(`SELECT outcome, action, proposal FROM harness_decisions WHERE decision = 'sweep.select.shadow' AND user_id = $1 AND proposal->>'day' = $2 ORDER BY created_at DESC LIMIT 1`, [userId, day])).rows;
    const [u] = (await pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId])).rows;
    const start = DateTime.fromISO(day, { zone: "America/Los_Angeles" }).startOf("day").toJSDate();
    const end = DateTime.fromISO(day, { zone: "America/Los_Angeles" }).endOf("day").toJSDate();
    const queued = (await pool.query(`SELECT DISTINCT proposal->'queued'->>'name' AS name FROM harness_decisions WHERE decision = 'sweep.surface' AND user_id = $1 AND created_at BETWEEN $2 AND $3 AND proposal->'queued' IS NOT NULL`, [userId, start, end])).rows.map((r: any) => String(r.name));
    const texted = (await pool.query(`SELECT type, message FROM proactive_sends WHERE user_id = $1 AND sent_at BETWEEN $2 AND $3 AND type IN ('event_offer', 'network_tease') ORDER BY sent_at`, [userId, start, end])).rows.map((r: any) => String(r.message ?? r.type).replace(/\s+/g, " ").slice(0, 160));
    out.push({
      name: u?.first_name ?? "Member",
      day,
      skipped: !run ? "didn't run" : run.outcome === "skip" ? (run.action === "unchanged" ? "nothing changed since the last run" : "nothing in the pool") : null,
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
