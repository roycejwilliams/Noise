// Live search eval against the real Luma feed (services/tieredRecommendation.ts).
//
//   npx tsx evals/search/run.ts
//
// Royce, 2026-09-16: "Find a founder or builder meetup this weekend" against
// the real San Francisco feed must either offer a real event, or name the
// closest miss with a real reason. Never an invented suggestion.
//
// Hard: nothing offered and no closest miss named; a closest miss with only a
// generic reason; a named event that isn't in the real feed; a rewrite-free
// search that still lost its time frame.
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { getTieredRecommendation, takeLastSearchScope } from "../../src/services/tieredRecommendation.js";
import { fetchPublicEvents } from "../../src/services/lumaDiscovery.js";
import { runEval, type CaseScore, type EvalCase } from "../lib.js";

type Case = EvalCase & { message: string; city: string; expectWindow: RegExp };

const here = dirname(fileURLToPath(import.meta.url));
const GENERIC = /came closest|not close enough|isn't quite what they asked for$|doesn't match what they asked$/i;

const cases: Case[] = [
  { id: "q01_founder_builder_weekend", message: "Find a founder or builder meetup this weekend", city: "San Francisco", expectWindow: /this weekend/ },
  { id: "q02_ai_thursday", message: "Any AI meetups in SF on Thursday?", city: "San Francisco", expectWindow: /thursday/ },
];

async function run(c: Case) {
  const found = await getTieredRecommendation({ text: c.message }, c.city, { rawMessage: c.message, timezone: "America/Los_Angeles", checkRepeat: false });
  const scope = takeLastSearchScope();
  const feed = await fetchPublicEvents(50, c.city, scope?.windowEnd ? new Date(scope.windowEnd) : null).catch(() => []);
  return { found: found.map((m) => ({ tier: m.tier, name: m.name })), scope, feedNames: new Set(feed.map((e) => e.name)) };
}

function score(c: Case, r: Awaited<ReturnType<typeof run>>): CaseScore {
  const hard: string[] = [];
  const soft: { name: string; ok: boolean }[] = [];
  if (!c.expectWindow.test(r.scope?.window?.toLowerCase() ?? "")) hard.push(`time frame was ${r.scope?.window ?? "none"}, expected ${c.expectWindow}`);
  // An event inside their time frame is never turned away as outside it.
  for (const g of r.scope?.gatedOut ?? []) {
    if (g.reasons.some((x) => /after the time frame/.test(x)) && g.date && r.scope?.windowEnd && g.date <= r.scope.windowEnd.slice(0, 10)) {
      hard.push(`"${g.name}" on ${g.date} is inside the time frame but was turned away as after it`);
    }
  }
  const offered = r.found.length > 0;
  const closest = r.scope?.closest ?? null;
  if (!offered && !closest && (r.scope?.tier2Nearby ?? 0) > 0) hard.push("nothing offered and no closest miss named, though there were nearby events");
  if (!offered && closest) {
    if (GENERIC.test(closest.why)) hard.push(`closest miss has only a generic reason: "${closest.why}"`);
    if (!r.feedNames.has(closest.name)) hard.push(`closest miss "${closest.name}" isn't in the real feed`);
  }
  for (const m of r.found.filter((m) => m.tier === 2)) if (!r.feedNames.has(m.name)) hard.push(`offered "${m.name}", which isn't in the real feed`);
  soft.push({ name: "offered a real event", ok: offered });
  console.log(`  [${c.id}] nearby ${r.scope?.tier2Nearby ?? "?"} | offered ${JSON.stringify(r.found)} | closest ${closest ? `${closest.name} (${closest.why})` : "none"} | rejected ${JSON.stringify(r.scope?.relevanceRejected ?? [])} | gatedOut ${JSON.stringify((r.scope?.gatedOut ?? []).map((g) => `${g.name}: ${g.reasons.join(", ")}`))}`);
  return { hard, soft };
}

await runEval<Case, any>({ name: "search (live feed)", dir: here, cases, concurrency: 1, run, score });
