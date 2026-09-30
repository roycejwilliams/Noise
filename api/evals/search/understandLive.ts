// Live, dry: Royce's real search thread from 2026-09-29/30 (the one that came
// back "nothing fit" 8 times in 10, and that Instinct answered with a ranked
// list), replayed turn by turn with the brief carried between texts. Checks
// what Co understood (kind, carried details, short queries), then runs the web
// search on the steps that should return places or people and counts results
// that hold up on their own page and fit the brief. Writes nothing, texts
// nobody. About $1.40.
//
//   railway run npx tsx evals/search/understandLive.ts
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const S = await import("../../src/services/searchIntent.js");
type Brief = Awaited<ReturnType<typeof S.understandAsk>>;
const U = "00000000-0000-0000-0000-000000000000";
const MAP = "[sent a photo showing: a map of San Francisco with a red pin near Divisadero St and Oak St, between the Western Addition and NoPa, north of the Lower Haight]";

type Step = { say: string; expect: (b: NonNullable<Brief>) => string | null; web?: boolean };
const threads: { name: string; steps: Step[] }[] = [
  {
    name: "Anti-Networking space (Royce's thread)",
    steps: [
      { say: "Can you find me some people, preferably founders that would be open to letting us use their space for Oct 10th?", expect: (b) => (["person", "venue"].includes(b.kind) ? null : `kind ${b.kind}`) },
      { say: "For SF tech week", expect: (b) => (/san francisco|sf/i.test(b.city ?? "") && /oct/i.test(b.when ?? "") ? null : `city ${b.city} when ${b.when}`) },
      { say: "It's called “Anti-Networking” the whole idea to test our product but it would be a dj set. Donated space or spaces below $1000", expect: (b) => (b.budget === 1000 ? null : `budget ${b.budget}`), web: true },
      { say: "120 people", expect: (b) => (b.headcount === 120 && b.budget === 1000 ? null : `headcount ${b.headcount} budget ${b.budget}`) },
      { say: "Look for spaces are bookable from like peer space or something", expect: (b) => (b.kind === "venue" && b.sites.some((s) => s.includes("peerspace")) && b.headcount === 120 ? null : `kind ${b.kind} sites ${b.sites} headcount ${b.headcount}`), web: true },
      { say: `${MAP} In this area`, expect: (b) => (/nopa|western addition|haight|divisadero|alamo/i.test(b.area ?? "") && b.headcount === 120 ? null : `area ${b.area} headcount ${b.headcount}`), web: true },
    ],
  },
  { name: "DJ", steps: [{ say: "Can you find me a DJ for a party on Oct 10 in SF? Around $500", expect: (b) => (b.kind === "vendor" && b.budget === 500 ? null : `kind ${b.kind} budget ${b.budget}`), web: true }] },
  {
    name: "events, then generalize",
    steps: [
      { say: "Any AI founder events this weekend in SF?", expect: (b) => (b.kind === "event" ? null : `kind ${b.kind}`) },
      { say: "generalize it", expect: (b) => (b.kind === "event" && !/generalize/i.test(b.summary) ? null : `kind ${b.kind} summary ${b.summary}`) },
    ],
  },
  { name: "program", steps: [{ say: "Any accelerators taking applications right now for pre-seed consumer AI?", expect: (b) => (b.kind === "program" ? null : `kind ${b.kind}`), web: true }] },
];

const { generateText } = await import("ai");
const { anthropic } = await import("@ai-sdk/anthropic");
const { MODELS } = await import("../../src/models.js");
async function fitsBrief(brief: NonNullable<Brief>, name: string, facts: string): Promise<boolean> {
  const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 20, prompt: `Someone asked for: ${S.describeBrief(brief)} (${brief.summary}).\nA result: ${name}. ${facts}\nIs this the kind of thing they asked for (right type, right city)? Answer only yes or no.` });
  return /^\s*yes/i.test(text);
}

let understood = 0, steps = 0, longest = 0, webSteps = 0, webWithFit = 0, results = 0, fitting = 0;
// ONLY_WEB=5 runs the web search only on that step of the first thread (0-based).
const onlyWeb = process.env.ONLY_WEB ? Number(process.env.ONLY_WEB) : null;
for (const t of threads.filter((t) => !process.env.SKIP || !process.env.SKIP.split(",").includes(t.name.split(" ")[0]))) {
  console.log(`\n##### ${t.name}`);
  let brief: Brief = null;
  let recent = "";
  for (const step of t.steps) {
    steps++;
    const t0 = Date.now();
    const b = await S.understandAsk(U, step.say, "San Francisco", { recent, known: "Co-founder of a startup in SF; hosting events for SF Tech Week", brief });
    const ms = Date.now() - t0;
    recent += `\nMember: ${step.say}`;
    if (!b) {
      console.log(`  "${step.say.slice(0, 60)}" -> NO BRIEF`);
      continue;
    }
    brief = b;
    const miss = step.expect(b);
    if (!miss) understood++;
    longest = Math.max(longest, ...b.queries.map((q) => q.length));
    console.log(`  "${step.say.slice(0, 60)}" (${ms}ms) ${miss ? `MISS: ${miss}` : "ok"}\n    ${b.kind} → ${S.routeFor(b.kind)} | ${S.describeBrief(b)}${b.nearby?.length ? `\n    nearby: ${b.nearby.join(", ")}` : ""}\n    queries: ${b.queries.map((q) => `"${q}"`).join(", ")}${b.ask ? `\n    would ask: ${b.ask}` : ""}`);
    if (step.web && S.routeFor(b.kind) === "web" && (onlyWeb === null || (t === threads[0] && t.steps.indexOf(step) === onlyWeb))) {
      webSteps++;
      const w0 = Date.now();
      const r = await S.webFind(U, b, { zone: "America/Los_Angeles", skipBudget: true, log: false });
      let any = false;
      console.log(`    web (${Math.round((Date.now() - w0) / 1000)}s, tried ${r.tried.length}): ${r.matches.length} kept, ${r.dropped.length} dropped`);
      for (const m of r.matches) {
        results++;
        const ok = await fitsBrief(b, m.name, m.reason);
        if (ok) { fitting++; any = true; }
        console.log(`      ${ok ? "FITS" : "off "} ${m.name}  ${m.url}\n           ${m.reason.slice(0, 200)}`);
      }
      for (const d of r.dropped.slice(0, 6)) console.log(`      dropped: ${d.slice(0, 140)}`);
      const checked = r.factChecks.length;
      if (checked) console.log(`      second reader: ${checked} facts, ${r.factChecks.filter((c) => c.verdict === "no").length} dropped, ${r.factChecks.filter((c) => c.verdict === "unclear").length} unclear`);
      if (any) webWithFit++;
      recent += `\nCo: (sent ${r.matches.map((m) => m.name).join(", ") || "nothing"})`;
    }
  }
}
console.log(`\nunderstood ${understood}/${steps} steps; longest query ${longest} chars; web steps with ≥1 fitting verified result ${webWithFit}/${webSteps}; ${fitting}/${results} results fit the brief`);
