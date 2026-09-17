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

// ---------------------------------------------------------------------------
// Profile alignment (Royce, 2026-09-16: "we align users with the intent we
// gather. We actually give them things that match their profile").
// Two different people send the same message and must get different events,
// each better suited to them; and the ask still wins over the profile.
const FOUNDER = "Works on: technical co-founder of a Series A AI infrastructure company, team of 8\nWants right now: meet AI engineers and investors; find a designer for branding\nCares about in people and plans: builders who ship, calm and direct";
const ARTIST = "Works on: painter and ceramics artist, part-time barista\nWants right now: an art community to belong to; creative workshops; low-key social things on weekends\nCares about in people and plans: warmth, making things by hand, nothing corporate";

type Align = EvalCase & { kind: "pair" | "askWins" | "tier3"; message: string; profiles: string[] };
const aligns: Align[] = [
  { id: "p01_same_ask_different_people", kind: "pair", message: "Anything happening in SF next week?", profiles: [FOUNDER, ARTIST] },
  { id: "p02_ask_beats_profile", kind: "askWins", message: "Any pottery or ceramics classes in SF next week?", profiles: [FOUNDER] },
  { id: "p03_tier3_query_follows_profile", kind: "tier3", message: "Any accelerators or programs I should look at?", profiles: [FOUNDER, ARTIST] },
];

async function judge(prompt: string): Promise<string> {
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { generateText } = await import("ai");
  const { text } = await generateText({ model: anthropic(MODELS.sonnet), prompt });
  return text.trim();
}

await runEval<Align, any>({
  name: "profile alignment (live feed)",
  dir: here,
  cases: aligns,
  concurrency: 1,
  run: async (a) => {
    const results = [];
    for (const profile of a.profiles) {
      const found = await getTieredRecommendation({ text: a.message }, "San Francisco", { rawMessage: a.message, timezone: "America/Los_Angeles", checkRepeat: false, profile });
      const scope = takeLastSearchScope();
      results.push({ offered: found.filter((m) => m.tier !== 3).map((m) => m.name), tier3: found.filter((m) => m.tier === 3).map((m) => m.name), scope });
    }
    if (a.kind === "pair") {
      const [f, r] = results.map((x) => x.offered[0] ?? null);
      const verdicts = [];
      for (const [pick, owner] of [[f, "A"], [r, "B"]] as [string | null, string][]) {
        if (!pick) { verdicts.push({ pick, owner, answer: "none" }); continue; }
        const answer = await judge(`Person A: ${FOUNDER}\n\nPerson B: ${ARTIST}\n\nEvent: "${pick}"\n\nWhich person is this event better suited to? Answer only A or B.`);
        verdicts.push({ pick, owner, answer: answer.slice(0, 1).toUpperCase() });
      }
      return { results, verdicts };
    }
    if (a.kind === "askWins") {
      const picks = results[0].offered;
      const checks = [];
      for (const pick of picks) checks.push({ pick, answer: (await judge(`Someone asked for pottery or ceramics classes. Is the event "${pick}" a pottery, ceramics, or hands-on art-making class or workshop? Answer only yes or no.`)).toLowerCase().startsWith("yes") });
      return { results, checks };
    }
    return { results };
  },
  score: (a, r) => {
    const hard: string[] = [];
    const soft: { name: string; ok: boolean }[] = [];
    if (a.kind === "pair") {
      const [f, b] = r.verdicts;
      console.log(`  [${a.id}] founder got ${JSON.stringify(f.pick)} (judged ${f.answer}); artist got ${JSON.stringify(b.pick)} (judged ${b.answer})`);
      if (f.pick && b.pick && f.pick === b.pick) hard.push(`both people got the same event: "${f.pick}"`);
      for (const v of r.verdicts) if (v.pick && v.answer !== v.owner) hard.push(`"${v.pick}" went to person ${v.owner} but suits person ${v.answer} better`);
      soft.push({ name: "both got something", ok: !!f.pick && !!b.pick });
    }
    if (a.kind === "askWins") {
      console.log(`  [${a.id}] founder asking for pottery got ${JSON.stringify(r.checks)}`);
      for (const c of r.checks) if (!c.answer) hard.push(`asked for pottery, got "${c.pick}" (the profile overrode the ask)`);
      soft.push({ name: "found a pottery class", ok: r.checks.some((c: any) => c.answer) });
    }
    if (a.kind === "tier3") {
      const queries = r.results.map((x: any) => x.scope?.xQuery ?? null);
      console.log(`  [${a.id}] X queries: founder ${JSON.stringify(queries[0])}, artist ${JSON.stringify(queries[1])} | picks ${JSON.stringify(r.results.map((x: any) => x.tier3))}`);
      soft.push({ name: "X query differs by profile", ok: !!queries[0] && !!queries[1] && queries[0] !== queries[1] });
    }
    return { hard, soft };
  },
});
