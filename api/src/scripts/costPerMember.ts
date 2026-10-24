import "dotenv/config";
import { isTestNumber } from "../services/testNumbers.js";

// Cost per member per active day, split real / test / team (cost-complexity plan, Phase A, 2026-10-23). Read only: one READ ONLY
// transaction, no writes, no model or vendor calls. Prints ids nowhere and names and message text never (it never selects them).
//
//   npx tsx src/scripts/costPerMember.ts              the last 14 days
//   npx tsx src/scripts/costPerMember.ts --days 7
//
// Classes (the token-use report's, 2026-10-18): team = the founders' accounts (users.mo_approver); test = a 555-01xx number (now
// or before archiving) or an archived account; real = an invite-verified member who is neither; gate = an unverified number that
// only reached the door (no cost is put on it, its rows are counted under gate). An active day is a day with a text exchange or a
// call transcript. Model cost is llm_usage (rows with no user_id are "unattributed": calls marked as about no single member, and
// any call site nobody marked yet, listed by function so the gap stays visible). Non-model counts: Exa searches and their
// reported cost (harness_decisions "exa.search"), X searches (x_search_log) and the web search budget log (web_search_log).

export type MemberClass = "real" | "test" | "team" | "gate";
export type UserRow = { id: string; phone_number: string | null; archived_phone: string | null; archived_at: Date | string | null; invite_verified: boolean | null; mo_approver: boolean | null };
export type UsageAgg = { user_id: string | null; function_id: string; calls: number; cost: number; web_searches: number };
export type CountAgg = { user_id: string | null; n: number; cost?: number };

export function classOf(u: UserRow): MemberClass {
  if (u.mo_approver) return "team";
  if (isTestNumber(u.phone_number, {}) || isTestNumber(u.archived_phone, {}) || u.archived_at) return "test";
  return u.invite_verified ? "real" : "gate";
}

type ClassLine = { members: number; activeMembers: number; activeDays: number; cost: number; perActiveDay: number | null; webSearches: number; exa: number; exaCost: number; x: number; webLog: number; top: { fn: string; cost: number; calls: number }[] };
export type CostReport = { days: number; classes: Record<MemberClass, ClassLine>; unattributed: { cost: number; top: { fn: string; cost: number; calls: number }[] }; total: number };

const CLASSES: MemberClass[] = ["real", "test", "team", "gate"];

export function summarize(i: { days: number; users: UserRow[]; usage: UsageAgg[]; activeDays: { user_id: string; days: number }[]; exa: CountAgg[]; x: CountAgg[]; webLog: CountAgg[] }, topN = 5): CostReport {
  const cls = new Map(i.users.map((u) => [u.id, classOf(u)]));
  const blank = (): ClassLine => ({ members: 0, activeMembers: 0, activeDays: 0, cost: 0, perActiveDay: null, webSearches: 0, exa: 0, exaCost: 0, x: 0, webLog: 0, top: [] });
  const classes = Object.fromEntries(CLASSES.map((c) => [c, blank()])) as Record<MemberClass, ClassLine>;
  for (const c of cls.values()) classes[c].members++;
  for (const a of i.activeDays) {
    const c = cls.get(a.user_id);
    if (!c) continue;
    classes[c].activeMembers++;
    classes[c].activeDays += a.days;
  }
  const byFn: Record<MemberClass | "none", Map<string, { cost: number; calls: number }>> = { real: new Map(), test: new Map(), team: new Map(), gate: new Map(), none: new Map() };
  let unattributed = 0;
  let total = 0;
  for (const r of i.usage) {
    const c = r.user_id ? cls.get(r.user_id) ?? null : null;
    total += r.cost;
    const key = c ?? "none";
    if (c) {
      classes[c].cost += r.cost;
      classes[c].webSearches += r.web_searches;
    } else unattributed += r.cost;
    const f = byFn[key].get(r.function_id) ?? { cost: 0, calls: 0 };
    f.cost += r.cost;
    f.calls += r.calls;
    byFn[key].set(r.function_id, f);
  }
  const add = (rows: CountAgg[], field: "exa" | "x" | "webLog") => {
    for (const r of rows) {
      const c = r.user_id ? cls.get(r.user_id) : undefined;
      if (!c) continue;
      classes[c][field] += r.n;
      if (field === "exa") classes[c].exaCost += r.cost ?? 0;
    }
  };
  add(i.exa, "exa");
  add(i.x, "x");
  add(i.webLog, "webLog");
  const top = (m: Map<string, { cost: number; calls: number }>) => [...m].map(([fn, v]) => ({ fn, ...v })).sort((a, b) => b.cost - a.cost).slice(0, topN);
  for (const c of CLASSES) {
    classes[c].top = top(byFn[c]);
    classes[c].perActiveDay = classes[c].activeDays ? classes[c].cost / classes[c].activeDays : null;
  }
  return { days: i.days, classes, unattributed: { cost: unattributed, top: top(byFn.none) }, total };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
export function renderReport(r: CostReport): string {
  const out: string[] = [`Cost per member, last ${r.days} days (model spend ${usd(r.total)}; unattributed ${usd(r.unattributed.cost)})`, ""];
  out.push("class | members (active) | active days | model $ | $/active day | llm web searches | exa (cost) | x | web log");
  for (const c of CLASSES) {
    const l = r.classes[c];
    out.push(`${c} | ${l.members} (${l.activeMembers}) | ${l.activeDays} | ${usd(l.cost)} | ${l.perActiveDay === null ? "-" : usd(l.perActiveDay)} | ${l.webSearches} | ${l.exa} (${usd(l.exaCost)}) | ${l.x} | ${l.webLog}`);
  }
  for (const c of CLASSES) {
    if (!r.classes[c].top.length) continue;
    out.push("", `Top functions, ${c}:`);
    for (const f of r.classes[c].top) out.push(`  ${f.fn}: ${usd(f.cost)} (${f.calls} calls)`);
  }
  if (r.unattributed.top.length) {
    out.push("", "Top functions with no member (marked not about one member, or not yet marked):");
    for (const f of r.unattributed.top) out.push(`  ${f.fn}: ${usd(f.cost)} (${f.calls} calls)`);
  }
  return out.join("\n");
}

async function main() {
  const at = process.argv.indexOf("--days");
  const days = at > 0 ? Math.max(1, Math.min(90, Number(process.argv[at + 1]) || 14)) : 14;
  const { default: pool } = await import("../db/db.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const since = `NOW() - make_interval(days => $1::int)`;
    const q = async <T>(sql: string): Promise<T[]> => (await client.query(sql, [days])).rows as T[];
    const users = await client.query(`SELECT id, phone_number, archived_phone, archived_at, invite_verified, mo_approver FROM users`).then((x) => x.rows as UserRow[]);
    const usage = await q<UsageAgg>(`SELECT user_id, function_id, COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0)::float AS cost, COALESCE(SUM(web_searches), 0)::int AS web_searches FROM llm_usage WHERE created_at > ${since} GROUP BY 1, 2`);
    const activeDays = await q<{ user_id: string; days: number }>(`SELECT user_id, COUNT(DISTINCT created_at::date)::int AS days FROM co_memories WHERE memory_type IN ('text_exchange', 'call_transcript') AND created_at > ${since} GROUP BY 1`);
    const exa = await q<CountAgg>(`SELECT user_id, COUNT(*)::int AS n, COALESCE(SUM(CASE WHEN jsonb_typeof(proposal->'cost') = 'number' THEN (proposal->>'cost')::float ELSE 0 END), 0)::float AS cost FROM harness_decisions WHERE decision = 'exa.search' AND outcome = 'act' AND created_at > ${since} GROUP BY 1`);
    const x = await q<CountAgg>(`SELECT user_id, COUNT(*)::int AS n FROM x_search_log WHERE created_at > ${since} GROUP BY 1`);
    const webLog = await q<CountAgg>(`SELECT user_id, COUNT(*)::int AS n FROM web_search_log WHERE created_at > ${since} GROUP BY 1`);
    await client.query("ROLLBACK");
    console.log(renderReport(summarize({ days, users, usage, activeDays, exa, x, webLog })));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && /costPerMember\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
