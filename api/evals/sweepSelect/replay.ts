// Replay Co's sweep selection (services/sweepSelect.ts) on a member's past
// sweeps, for blind grading against what the old rules queued (Royce,
// 2026-10-02). Read-only against the Railway DEV database; nothing is sent
// and the live sweep is untouched.
//
//   MEMBER=9728 [FROM=2026-09-19] [TO=2026-10-02] [SELECT_MODEL=claude-opus-5-5] \
//     npx tsx --env-file=.env evals/sweepSelect/replay.ts
//
// For each day with sweep runs:
//   - the pool: every candidate those runs found or had queued (sweep.surface
//     logs), deduped by name + date, tagged with the asks it serves; past ones dropped
//   - the old pick: what the old surface step queued that day
//   - the context as of that day's first run, from records created before it
//     only (no peeking at the future): open asks, last 14 days of texts, what
//     Co sent in the 30 days before and whether they replied, how they reacted
//     to suggestions, feelings in the 3 days before
// Writes results.json, grading.html (A/B blind, shuffled) and key.json to
// ~/copatible-live-logs/sweep-replay/<run>/. Score with evals/sweepSelect/score.ts.
import "../lib/requireMeter.js";
import pool from "../../src/db/db.js";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { DateTime } from "luxon";
import { selectForMember, selectSignature, SELECT_MODEL, type PoolItem, type SelectContext, type Judgment } from "../../src/services/sweepSelect.js";
import { loadAsks, loadMemberContext } from "../../src/services/sweepSelectContext.js";
import { renderGrading } from "./grading.js";

const ZONE = "America/Los_Angeles";
const member = process.env.MEMBER ?? "9728";
const model = process.env.SELECT_MODEL ?? SELECT_MODEL;
const from = process.env.FROM ?? "0000-00-00";
const to = process.env.TO ?? "9999-99-99";

export type ReplayDay = {
  day: string;
  now: string;
  pool: PoolItem[];
  oldPick: string[]; // keys
  judgments: Judgment[];
  signature: string;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  raw: string; // Co's whole answer, for the audit trail
  error?: string;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const itemKey = (name: string, date: string | null) => `${norm(name)}|${date ?? ""}`;

async function main() {
  const u = new URL(process.env.DATABASE_URL!);
  console.log(`db: ${u.hostname}:${u.port}/${u.pathname.slice(1)}`);
  if (u.hostname !== "localhost" || u.port !== "55432") throw new Error("not the dev tunnel (localhost:55432); stopping");
  const client = await pool.connect();
  await client.query("BEGIN READ ONLY");
  const q = async (sql: string, args: unknown[] = []) => (await client.query(sql, args)).rows;
  try {
    const [me] = await q(`SELECT u.id, u.first_name, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE right(regexp_replace(u.phone_number, '\\D', '', 'g'), 4) = $1`, [member]);
    if (!me) throw new Error(`no member ending ${member}`);
    const runs = await q(`SELECT created_at, action, proposal FROM harness_decisions WHERE decision = 'sweep.surface' AND user_id = $1 ORDER BY created_at`, [me.id]);
    const byDay = new Map<string, any[]>();
    for (const r of runs) {
      const d = DateTime.fromJSDate(r.created_at).setZone(ZONE).toISODate()!;
      if (d < from || d > to) continue;
      byDay.set(d, [...(byDay.get(d) ?? []), r]);
    }
    const days: ReplayDay[] = [];
    let cost = 0;
    for (const [day, dayRuns] of byDay) {
      const now = dayRuns[0].created_at as Date;
      const today = day;
      // Asks open then, numbered in order; any ask a candidate serves is listed even if closed since.
      const servedIds = [...new Set(dayRuns.map((r: any) => String(r.proposal?.askId ?? "")).filter(Boolean))];
      const { asks, idFor: askId } = await loadAsks(q, me.id, now, servedIds);
      // The pool.
      const items = new Map<string, PoolItem>();
      const oldPick = new Set<string>();
      for (const r of dayRuns) {
        const p = r.proposal ?? {};
        const served = p.fromProfile ? null : askId.get(String(p.askId ?? ""));
        for (const f of [...(p.found ?? []), ...(p.backlog ?? [])]) {
          if (!f?.name) continue;
          const date = f.date ? String(f.date).slice(0, 10) : null;
          if (date && date < today) continue;
          const key = itemKey(f.name, date);
          const it = items.get(key) ?? { id: "", key, name: String(f.name), date, tier: Number(f.tier ?? 0), kind: "discovery" as const, asks: [], shortNotice: !!date && DateTime.fromISO(date).diff(DateTime.fromISO(today), "days").days <= 2 };
          if (served && !it.asks.includes(served)) it.asks.push(served);
          if (served) it.kind = "answer";
          items.set(key, it);
        }
        if (p.queued?.name) oldPick.add(itemKey(p.queued.name, p.queued.date ? String(p.queued.date).slice(0, 10) : null));
      }
      const poolItems = [...items.values()].map((it, i) => ({ ...it, id: `C${i + 1}` }));
      // Context as of `now`: only records created before it.
      const ctx: SelectContext = { ...(await loadMemberContext(q, me.id, now)), today, weekday: DateTime.fromISO(today).toFormat("cccc"), asks, pool: poolItems };
      const r = await selectForMember(ctx, { model, userId: me.id, effort: (["low", "medium", "high"] as const).find((e) => e === process.env.SELECT_EFFORT) });
      const sends = r.judgments.filter((j) => j.verdict === "send");
      // Sonnet-class prices, assumed ($3 in, $3.75 cache write, $0.30 cache read, $15 out per M); Opus ~2.5x.
      const mult = /opus/.test(model) ? 2.5 : 1;
      cost += mult * (r.usage.input * 3 + r.usage.cacheWrite * 3.75 + r.usage.cacheRead * 0.3 + r.usage.output * 15) / 1e6;
      console.log(`${day}: pool ${poolItems.length}, old queued ${oldPick.size}, new sends ${sends.length}, holds ${r.judgments.filter((j) => j.verdict === "hold").length}${r.error ? `, ERROR ${r.error}` : ""} (in ${r.usage.input}+${r.usage.cacheRead}cached, out ${r.usage.output})`);
      days.push({ day, now: now.toISOString(), pool: poolItems, oldPick: [...oldPick], judgments: r.judgments, signature: selectSignature(ctx), usage: r.usage, raw: r.raw, ...(r.error ? { error: r.error } : {}) });
    }
    // Things they reacted to, and whether each pick reached them.
    const reacted = (await q(`SELECT DISTINCT ON (item_name) item_name, result, created_at FROM suggestion_outcomes WHERE user_id = $1 ORDER BY item_name, created_at`, [me.id])).map((o: any) => ({ name: String(o.item_name), result: String(o.result), at: new Date(o.created_at).toISOString() }));
    const unchanged = days.filter((d, i) => i > 0 && d.signature === days[i - 1].signature).length;
    const stamp = DateTime.now().setZone(ZONE).toFormat("yyyy-LL-dd'T'HHmm");
    const dir = join(homedir(), "copatible-live-logs", "sweep-replay", `${stamp}-${model.replace(/[^a-z0-9.-]/gi, "")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), JSON.stringify({ member: me.first_name, model, from, to, days, reacted, unchanged, cost }, null, 1));
    const { html, key } = renderGrading(days, me.first_name ?? "you");
    writeFileSync(join(dir, "grading.html"), html);
    writeFileSync(join(dir, "key.json"), JSON.stringify(key, null, 1));
    console.log(`\n${days.length} days, ~$${cost.toFixed(2)} (${model}); ${unchanged} day(s) unchanged from the day before (would be skipped)\n${dir}`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error("ERR", e?.message ?? e);
  process.exit(1);
});
