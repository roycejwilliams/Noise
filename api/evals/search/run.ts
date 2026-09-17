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
import { getTieredRecommendation, relevancePrompt, takeLastSearchScope } from "../../src/services/tieredRecommendation.js";
import { fetchLumaEventDetails } from "../../src/services/eventDetails.js";
import { parseModelJson } from "../../src/services/modelJson.js";
import { MODELS } from "../../src/models.js";
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
  // With nothing offered, a near miss is named only when the check judged one
  // related; if every rejection was unrelated, saying nothing is right.
  const anyRelated = (r.scope?.relevanceRejected ?? []).some((x) => x.related) || (r.scope?.gatedOut ?? []).length > 0;
  if (!offered && !closest && anyRelated && !(r.scope?.gatedOut ?? []).length) hard.push("a related near miss existed but none was named");
  if (closest && (r.scope?.relevanceRejected ?? []).some((x) => x.name === closest.name && x.related === false)) hard.push(`named "${closest.name}" as the closest miss though it was judged unrelated`);
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

// The relevance check gives the same answer each time on the events that
// flipped between runs on 2026-09-16, and the right one. Three reads each.
type Kind = EvalCase & { ask: string; event: RegExp; expectFit: boolean; expectRelated?: boolean };
const kinds: Kind[] = [
  { id: "k01_chess_not_ai", ask: "Any AI meetups in SF on Thursday?", event: /Best Move Club/, expectFit: false },
  { id: "k02_ai_talk_is_ai", ask: "Any AI meetups in SF on Thursday?", event: /multi-model architecture/, expectFit: true },
  { id: "k03_build_day_for_builders", ask: "Find a founder or builder meetup this weekend", event: /Build Day/, expectFit: true },
  { id: "k04_build_day_not_founder_meetup", ask: "Find a founder meetup this weekend", event: /Build Day/, expectFit: false, expectRelated: true },
  { id: "k05_market_not_founders", ask: "Find a founder or builder meetup this weekend", event: /Maum Market/, expectFit: false, expectRelated: false },
  { id: "k06_market_not_a_near_miss", ask: "Is there a founder meetup this weekend?", event: /Maum Market/, expectFit: false, expectRelated: false },
  { id: "k07_run_not_a_near_miss", ask: "Is there a founder meetup this weekend?", event: /Bakery Run/, expectFit: false, expectRelated: false },
];
const feed = await fetchPublicEvents(50, "San Francisco", new Date(Date.now() + 10 * 86400000)).catch(() => []);
await runEval<Kind, any>({
  name: "relevance check (live, consistency)",
  dir: here,
  cases: kinds,
  concurrency: 2,
  run: async (k) => {
    const e = feed.find((x) => k.event.test(x.name));
    if (!e) return { missing: true };
    const d = await fetchLumaEventDetails(e.url);
    const { anthropic } = await import("@ai-sdk/anthropic");
    const { generateText } = await import("ai");
    const reads = await Promise.all([0, 1, 2].map(async () => {
      const { text } = await generateText({ model: anthropic(MODELS.sonnet), prompt: relevancePrompt(k.ask, e.name, e.city ?? null, d?.description ?? "") });
      const p = parseModelJson<{ fit?: boolean; related?: boolean }>(text);
      return { fit: p.fit === true, related: p.fit === true || p.related === true };
    }));
    return { reads };
  },
  score: (k, r) => {
    // The feed changes day to day; an event that's gone isn't a failure.
    if (r.missing) return { hard: [], soft: [{ name: "event still in feed", ok: false }] };
    const hard: string[] = [];
    const fits = r.reads.map((x: { fit: boolean }) => x.fit);
    if (new Set(fits).size > 1) hard.push(`inconsistent fit across reads: ${fits.join(", ")}`);
    if (fits.some((x: boolean) => x !== k.expectFit)) hard.push(`expected fit=${k.expectFit}, got ${fits.join(", ")}`);
    if (k.expectRelated !== undefined) {
      const related = r.reads.map((x: { related: boolean }) => x.related);
      if (related.some((x: boolean) => x !== k.expectRelated)) hard.push(`expected related=${k.expectRelated}, got ${related.join(", ")}`);
    }
    return { hard, soft: [] };
  },
});
