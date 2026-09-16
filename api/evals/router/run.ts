// Layer 2 router eval. Every change to the router prompt, model, or gates in
// src/services/messageRouter.ts must pass this before it ships: zero hard
// failures, soft accuracy no worse than the last run.
//
//   npx tsx evals/router/run.ts --mode baseline
//   npx tsx evals/router/run.ts --mode router [--model claude-sonnet-5] [--effort low|none] [--only c150,s06]
//
// cases.local.json holds real user messages and is gitignored — never commit
// it. cases.synthetic.json is committed and covers flows real traffic hasn't
// hit yet. Baseline mode scores the `current` outputs the old independent
// classifiers actually produced, mapped the way routes/sendblue.ts acted on
// them; synthetic cases have no baseline and are skipped there.
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  NO_ROUTE,
  ROUTER_MODEL,
  decideActions,
  describeOpenItem,
  routeMessage,
  type Decision,
  type OpenItemKind,
  type RouterOutput,
} from "../../src/services/messageRouter.js";

type Case = {
  id: string;
  source: "real" | "synthetic";
  message: string;
  recentConversation: string;
  openItems: { kind: OpenItemKind; detail: string | null }[];
  current: Record<string, string | undefined> | null;
  label: { ans: string[]; call: string[]; rec: boolean | null; upd: boolean | null; nope: string[] };
  repeats?: number;
};

type Acted = {
  resolved: string[];
  clarified: boolean;
  clarifiedCall?: boolean;
  call: "place_call" | "schedule" | "cancel" | "answer_calling_question" | "nothing";
  rec: boolean;
  upd: boolean;
};

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const mode = arg("mode") ?? "router";
const model = arg("model") ?? ROUTER_MODEL;
const effortArg = arg("effort") ?? "low";
const effort = effortArg === "none" ? null : (effortArg as "low" | "medium" | "high");
const only = arg("only")?.split(",");
const concurrency = Number(arg("concurrency") ?? 6);

// $ per million tokens, input / output.
const PRICING: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-haiku-4-5-20251001": [1, 5],
  "claude-sonnet-5": [2, 10],
  "claude-opus-5": [5, 25],
};

function loadCases(): Case[] {
  const files = ["cases.local.json", "cases.synthetic.json"].map((f) => join(here, f)).filter(existsSync);
  const all = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as Case[]);
  return only ? all.filter((c) => only.includes(c.id)) : all;
}

// Old pipeline: every classifier acted on its own, so several can fire.
function baselineActions(c: Case): Acted {
  const cur = c.current ?? {};
  const resolved: string[] = [];
  let call: Acted["call"] = "nothing";
  switch (cur.callOffer) {
    case "accepts_offer":
      resolved.push("call_offer:accept");
      call = "place_call";
      break;
    case "declines_offer":
      resolved.push("call_offer:decline");
      break;
    case "explicit_request":
      call = "place_call";
      break;
    case "schedule_request":
      call = "schedule";
      break;
    case "cancel_scheduled_call":
      call = "cancel";
      break;
    case "asks_about_calling":
      call = "answer_calling_question";
      break;
  }
  if (cur.eventOffer === "interested") resolved.push("event_tease:yes");
  if (cur.eventOffer === "not_interested") resolved.push("event_tease:no");
  if (cur.outcome && cur.outcome !== "unrelated") resolved.push(`outcome_followup:${cur.outcome}`);
  if (cur.matchNudge === "interested") resolved.push("match_nudge:yes");
  if (cur.matchNudge === "not_interested") resolved.push("match_nudge:no");
  if (cur.methodChoice === "phone") resolved.push("method_choice:text");
  if (cur.methodChoice === "email") resolved.push("method_choice:email");
  return {
    resolved,
    clarified: false,
    call,
    rec: (cur.wantsRecommendation ?? "").trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "") === "wants_something_concrete",
    upd: (cur.asksForUpdates ?? "").trim().toLowerCase().startsWith("yes"),
  };
}

function routerActions(d: Decision): Acted {
  return {
    resolved: d.resolve ? [`${d.resolve.item.kind}:${d.resolve.value}`] : [],
    clarified: d.clarifyAbout === "items",
    clarifiedCall: d.clarifyAbout === "call",
    call: d.placeCall ? "place_call" : d.scheduleCall ? "schedule" : d.cancelCall ? "cancel" : d.answerCallingQuestion ? "answer_calling_question" : "nothing",
    rec: d.wantsRecommendation,
    upd: d.asksForUpdates,
  };
}

const inAns = (r: string, ans: string[]) => ans.includes(r) || ans.includes(r.split(":")[0]);

function score(c: Case, a: Acted) {
  const hard: string[] = [];
  const done = [...a.resolved, ...(a.call === "place_call" ? ["place_call"] : [])];
  for (const n of c.label.nope) if (done.includes(n)) hard.push(`did nope action ${n}`);
  if (a.call === "place_call" && !c.label.call.includes("place_call") && !c.label.nope.includes("place_call")) hard.push("placed a call not in label");
  // Resolving an item the label doesn't allow is hard. Resolving the right
  // item with the wrong value is soft (scored under ans) unless that value is
  // an irreversible one (accepting a call, opting into an intro, a method).
  const irreversible = (r: string) => ["call_offer:accept", "match_nudge:yes", "network_intro:yes"].includes(r) || r.startsWith("method_choice:");
  for (const r of a.resolved) {
    if (inAns(r, c.label.ans) || c.label.nope.includes(r)) continue;
    const itemAllowed = c.label.ans.some((x) => x.split(":")[0] === r.split(":")[0]);
    if (!itemAllowed || irreversible(r)) hard.push(`resolved ${r} (label ans: ${c.label.ans.join("|")})`);
  }

  const soft: Record<string, boolean | null> = {};
  soft.ans = a.resolved.length
    ? a.resolved.every((r) => inAns(r, c.label.ans))
    : a.clarified
      ? c.label.ans.includes("ambiguous")
      : c.label.ans.includes("none");
  soft.call = c.label.call.includes(a.call);
  soft.rec = c.label.rec === null ? null : a.rec === c.label.rec;
  soft.upd = c.label.upd === null ? null : a.upd === c.label.upd;
  return { hard, soft };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function main() {
  let cases = loadCases();
  if (mode === "baseline") cases = cases.filter((c) => c.current);

  const results = await pool(cases, mode === "baseline" ? cases.length : concurrency, async (c) => {
    if (mode === "baseline") {
      const acted = baselineActions(c);
      return { c, acted, ...score(c, acted), latencyMs: 0, inTok: 0, outTok: 0, output: null as RouterOutput | null, error: null as string | null };
    }
    const openItems = c.openItems.map((it, i) => ({ id: `${it.kind}:${i + 1}`, kind: it.kind, description: describeOpenItem(it.kind, it.detail), detail: it.detail, askedAt: null }));
    let output: RouterOutput = NO_ROUTE;
    let latencyMs = 0;
    let inTok = 0;
    let outTok = 0;
    let error: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await routeMessage({ message: c.message, recentConversation: c.recentConversation, openItems }, { model, effort });
        ({ output, latencyMs } = r);
        inTok = r.inputTokens;
        outTok = r.outputTokens;
        error = null;
        break;
      } catch (err: any) {
        error = String(err?.message ?? err).slice(0, 200);
      }
    }
    const acted = routerActions(decideActions(output, openItems, { message: c.message, recentConversation: c.recentConversation }));
    return { c, acted, ...score(c, acted), latencyMs, inTok, outTok, output, error };
  });

  const label = mode === "baseline" ? "baseline (current classifiers)" : `router ${model} effort=${effort ?? "none"}`;
  console.log(`\n=== ${label} — ${results.length} cases ===\n`);

  const hardCases = results.filter((r) => r.hard.length);
  const fields = ["ans", "call", "rec", "upd"] as const;
  const acc: Record<string, string> = {};
  let softRight = 0;
  let softTotal = 0;
  for (const f of fields) {
    const scored = results.filter((r) => r.soft[f] !== null);
    const right = scored.filter((r) => r.soft[f]).length;
    softRight += right;
    softTotal += scored.length;
    acc[f] = `${right}/${scored.length} (${((100 * right) / Math.max(1, scored.length)).toFixed(1)}%)`;
  }

  for (const r of results) {
    const wrong = fields.filter((f) => r.soft[f] === false);
    if (!r.hard.length && !wrong.length && !r.error) continue;
    const tag = r.hard.length ? "HARD" : "soft";
    console.log(`[${tag}] ${r.c.id} ${JSON.stringify(r.c.message.slice(0, 90))}`);
    if (r.error) console.log(`   error: ${r.error}`);
    for (const h of r.hard) console.log(`   hard: ${h}`);
    for (const f of wrong) {
      const got = f === "ans" ? (r.acted.resolved.join(",") || (r.acted.clarified ? "clarify" : "none")) : String(r.acted[f]);
      const want = f === "ans" ? r.c.label.ans.join("|") : f === "call" ? r.c.label.call.join("|") : String(r.c.label[f]);
      console.log(`   ${f}: got ${got}, want ${want}`);
    }
    if (r.output?.reason) console.log(`   router: ${r.output.confidence} — ${r.output.reason}`);
  }

  const lat = results.map((r) => r.latencyMs).filter((x) => x > 0);
  const inTok = results.reduce((s, r) => s + r.inTok, 0);
  const outTok = results.reduce((s, r) => s + r.outTok, 0);
  const price = PRICING[model];
  const n = Math.max(1, results.filter((r) => r.inTok).length);
  const costPer1k = price ? ((inTok / n) * price[0] + (outTok / n) * price[1]) / 1000 : null;

  const summary = {
    label,
    cases: results.length,
    hardFailures: hardCases.length,
    hardCaseIds: hardCases.map((r) => r.c.id),
    errors: results.filter((r) => r.error).length,
    clarifiedItems: results.filter((r) => r.acted.clarified).length,
    clarifiedCall: results.filter((r) => r.acted.clarifiedCall).length,
    softAccuracy: acc,
    softOverall: `${softRight}/${softTotal} (${((100 * softRight) / Math.max(1, softTotal)).toFixed(1)}%)`,
    softOverallRealOnly: (() => {
      const real = results.filter((r) => r.c.source === "real");
      const scored = real.flatMap((r) => fields.map((f) => r.soft[f]).filter((v) => v !== null));
      const right = scored.filter(Boolean).length;
      return `${right}/${scored.length} (${((100 * right) / Math.max(1, scored.length)).toFixed(1)}%)`;
    })(),
    hardFailuresRealOnly: hardCases.filter((r) => r.c.source === "real").length,
    p50ms: pct(lat, 50),
    p95ms: pct(lat, 95),
    avgInTok: Math.round(inTok / n),
    avgOutTok: Math.round(outTok / n),
    costPer1kUsd: costPer1k === null ? null : Number(costPer1k.toFixed(3)),
  };
  console.log("\n", JSON.stringify(summary, null, 2));

  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${mode === "baseline" ? "baseline" : `${model}-${effort ?? "none"}`}.local.json`);
  writeFileSync(outFile, JSON.stringify({ summary, results: results.map(({ c, ...r }) => ({ id: c.id, ...r })) }, null, 2));
  console.log(`\nwrote ${outFile}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
