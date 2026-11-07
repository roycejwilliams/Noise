// Model-free checks for matching on the guarded member picture (Cue Memory Spec step 11, part 1, 2026-11-06): services/matchPicture.ts,
// read by harness/matchGate.ts (gatherNetworkFacts) and services/roomMatching.ts (gatherValueSide). No database, no model.
//   npx tsx evals/member/matchPicture.ts
import { readFileSync } from "fs";
import { join } from "path";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const MP = await import("../../src/services/matchPicture.js");
const RM = await import("../../src/services/roomMatching.js");
const MG = await import("../../src/harness/matchGate.js");
type Deps = import("../../src/services/memberKnowledge.js").KnowledgeDeps;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const root = new URL("../../src/", import.meta.url).pathname;
const src = (p: string) => readFileSync(join(root, p), "utf8");
const code = (p: string) => src(p).replace(/^\s*\/\/.*$/gm, "");
const at = new Date("2026-11-01T12:00:00Z");

type World = { goals?: string[]; asks?: string[]; exchanges?: string[]; removed?: string[]; prefs?: string[]; transitions?: string[]; goalStates?: { goal: string; state: string }[] };
const deps = (w: World, seen: string[] = []): Partial<Deps> =>
  ({
    profile: async (u: string) => (seen.push(u), { firstName: "Jordan", city: null, goals: w.goals ?? [], intent: null, updatedAt: null }),
    zone: async () => null,
    linkedNames: async () => [],
    goalStates: async (u: string) => (seen.push(u), []),
    asks: async (u: string) => (seen.push(u), (w.asks ?? []).map((t, i) => ({ id: `a${i}`, text: t, kind: "find", createdAt: at, lastMentionedAt: null }))),
    taste: async () => null,
    roomTaste: async () => (w.prefs ?? []).map((text) => ({ text, at })),
    limits: async () => ({ avoid: [], availability: null, at: null }),
    exchanges: async (u: string) => (seen.push(u), (w.exchanges ?? []).map((c) => ({ content: `User said: ${c}`, at }))),
    transitions: async () => (w.transitions ?? []).map((t, i) => ({ id: String(i), text: t, quote: "", openedAt: at, closedAt: null, closedQuote: null, lastTouchedAt: at, status: "open", source: "said", channel: "text", corrections: [] })) as any,
    picture: async () => ({ lessons: [], lessonsTotal: 0, corrections: [], correctionsTotal: 0 }) as any,
    people: async () => [],
    forgotten: async () => (w.removed ?? []).map((old, i) => ({ field: "x", old, now: null, ref: `m:${i}`, removed: true })),
  }) as unknown as Partial<Deps>;

// ---------------------------------------------------------------- a forgotten fact no longer reaches a match
const SECRET = "my visa is about to expire and I might have to leave the country";
const live = await MP.matchPicture("a", deps({ exchanges: [SECRET, "I want to find a climate hardware cofounder"] }));
check("without a removal their own words are in the denylist", live.privateTexts.some((t) => t.includes("visa is about to expire")));
const gone = await MP.matchPicture("a", deps({ exchanges: [SECRET, "I want to find a climate hardware cofounder"], removed: ["my visa is about to expire and I might have to leave the country"] }));
check("a fact they had Cue forget is out of the denylist and out of every field", !JSON.stringify(gone).includes("visa") && gone.privateTexts.some((t) => t.includes("climate hardware cofounder")));
check("a read with unread guards says so", MP.matchPictureOf({ ...(await (await import("../../src/services/memberKnowledge.js")).memberKnowledge("a", { include: MP.MATCH_SECTIONS }, deps({}))), guardsUnread: true }).unread === true);

// ---------------------------------------------------------------- only the sections matching needs
check("matching loads goals, asks, preferences, limits, learned, transitions, people, exchanges and nothing else", [...MP.MATCH_SECTIONS].sort().join() === "asks,exchanges,goals,learned,limits,people,preferences,transitions");
check("it never loads delivered, carrying, claims, restraint or events", !["delivered", "carrying", "claims", "restraint", "events"].some((s) => (MP.MATCH_SECTIONS as readonly string[]).includes(s)));

// ---------------------------------------------------------------- a private fact can shape fit but never appears in intro text
const world: World = { goals: ["find a climate hardware cofounder"], asks: ["a cofounder who knows climate hardware"], transitions: ["I am scared about the layoffs at my company"], prefs: ["I only go to small dinners"], exchanges: ["the layoffs at my company have me scared"] };
const pa = await MP.matchPicture("a", deps(world));
check("the goal is the reader's own fit context", pa.goals.includes("find a climate hardware cofounder"));
check("the private transition and preference are in the denylist, not in the goals", pa.privateTexts.some((t) => /layoffs/.test(t)) && pa.privateTexts.some((t) => /small dinners/.test(t)) && !pa.goals.some((g) => /layoffs|small dinners/.test(g)));
const sideA: import("../../src/services/roomMatching.js").ValueSide = { userId: "a", firstName: "Jordan", ownAsks: [{ text: "a cofounder who knows climate hardware", type: "seeking", shareable: true }], goals: pa.goals, pastOutcomes: [], shared: ["a cofounder who knows climate hardware"], privateAsks: [], privateTexts: pa.privateTexts };
const sideB: import("../../src/services/roomMatching.js").ValueSide = { userId: "b", firstName: "Priya", ownAsks: [{ text: "can offer introductions to climate hardware founders", type: "offering", shareable: true }], goals: [], pastOutcomes: [], shared: ["can offer introductions to climate hardware founders"], privateAsks: [], privateTexts: [] };
const prompt = RM.sideLinePrompt("Founders Supper", sideB, { firstName: "Jordan", shared: sideA.shared });
check("the other member's prompt holds only what Jordan shared: no goal, transition or preference of Jordan's", !/layoffs|small dinners|find a climate hardware cofounder/.test(prompt) && /a cofounder who knows climate hardware/.test(prompt));
const promptOwn = RM.sideLinePrompt("Founders Supper", sideA, { firstName: "Priya", shared: sideB.shared });
check("Jordan's own prompt carries his goal (fit) and still not the private transition or preference", /goal: "find a climate hardware cofounder"/.test(promptOwn) && !/layoffs|small dinners/.test(promptOwn));
const clean = "Priya can introduce you to climate hardware founders, which is the cofounder search you are on.";
// the line Jordan would be told about Priya is written for Jordan; the denylist of the OTHER side (Priya's) guards Jordan's line, and
// Jordan's guards the line Priya reads (second).
const cleanSecond = "Jordan is looking for a cofounder who knows climate hardware, which is what you offer.";
const dirtySecond = "Jordan is looking for a cofounder who knows climate hardware, and he is scared about the layoffs at his company.";
const okClean = RM.checkValueLines({ forFirst: clean, forSecond: cleanSecond, verdict: "strong", why: "ok", judged: { first: true, second: true } }, sideA, sideB);
const okDirty = RM.checkValueLines({ forFirst: clean, forSecond: dirtySecond, verdict: "strong", why: "ok", judged: { first: true, second: true } }, sideA, sideB);
check("a clean line passes every check", okClean.ok);
check("a line carrying Jordan's private transition (from the picture) is refused", !okDirty.ok && okDirty.checks.some((c) => !c.pass && /private|hidden|sensitive/.test(c.name)));

// ---------------------------------------------------------------- cross-member isolation
const seen: string[] = [];
await MP.matchPicture("a", deps({ exchanges: ["a's own words"] }, seen));
check("every picture read is bound to the one member asked about", seen.length > 0 && seen.every((u) => u === "a"));
const pb = await MP.matchPicture("b", deps({ exchanges: ["b's own words"] }));
check("one member's picture holds none of the other's words", !JSON.stringify(pb).includes("a's own words") && !JSON.stringify(pa).includes("b's own words"));

// ---------------------------------------------------------------- quiet members rank lower, never out
const f = (o: Partial<import("../../src/harness/matchGate.js").NetworkFacts>) => ({ shareReason: '"a cofounder who knows climate hardware"', candidateStatedAsks: ["a cofounder who knows climate hardware"], candidatePrivateTexts: pa.privateTexts, alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true, ...o });
const quiet = MG.evaluateNetworkCandidate(f({ candidateQuiet: true, askerQuiet: true }));
check("a quiet candidate still passes the gate (less contact, never ejection)", quiet.ok);
check("quiet members sort after active ones, order kept", MG.activeFirst(["q1", "a1", "q2", "a2"], (x) => x.startsWith("q")).join() === "a1,a2,q1,q2");
check("the picture-fed denylist still refuses a reason quoting private text", !MG.evaluateNetworkCandidate(f({ shareReason: '"the layoffs at my company have me scared"', candidateStatedAsks: ["a cofounder who knows climate hardware"] })).ok);

// ---------------------------------------------------------------- no raw co_memories content read remains in the matching paths
const paths = ["harness/matchGate.ts", "services/roomMatching.ts", "services/networkIntroNudge.ts", "services/eventScoring.ts", "services/eventMatching.ts", "services/relevance.ts", "services/peopleGraph.ts", "services/matchPicture.ts"];
const reads = paths.flatMap((p) => (code(p).match(/FROM co_memories[^`]*/g) ?? []).map((r) => ({ p, r })));
check("no matching path reads co_memories by 'everything but intent' (memory_type <>)", reads.every((x) => !/memory_type\s*<>/.test(x.r)));
check("every remaining co_memories read in the matching paths names the Co-bookkeeping or activity type it reads", reads.every((x) => /memory_type\s*(=|IN)/.test(x.r)));
check("the two member-knowledge reads (gatherNetworkFacts, gatherValueSide) are gone", !/memory_type <> 'intent'/.test(code("harness/matchGate.ts") + code("services/roomMatching.ts")) && !/CO_WRITTEN_MEMORY_TYPES/.test(code("services/roomMatching.ts")));
check("both go through matchPicture", /matchPicture\(candidateId\)/.test(code("harness/matchGate.ts")) && /matchPicture\(userId\)/.test(code("services/roomMatching.ts")));
check("no model call in matchPicture", !/generateText|anthropic|openai/i.test(code("services/matchPicture.ts")));

console.log(`member matchPicture: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
