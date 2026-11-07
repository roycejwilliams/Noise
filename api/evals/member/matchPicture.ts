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
// A stubbed pool: answers by SQL text, records every statement. Rows for the picture's own-lines read and the forget guards come in by argument.
type Stub = { sql: string[]; query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> };
const stub = (o: { own?: { content: string; memory_type: string }[]; corrections?: any[]; profile?: any; failOwn?: boolean } = {}): Stub => {
  const sql: string[] = [];
  return {
    sql,
    query: async (q: string) => {
      sql.push(q);
      if (/FROM profile_corrections pc WHERE pc\.user_id/.test(q)) return { rows: o.corrections ?? [] };
      if (/memory_type IN \('call_transcript'/.test(q)) {
        if (o.failOwn) throw new Error("db down");
        return { rows: o.own ?? [] };
      }
      if (/FROM co_profiles WHERE user_id = \$1/.test(q) && o.profile && /goals, blockers/.test(q)) return { rows: [o.profile] };
      if (/SELECT u\.first_name, cp\.city, cp\.goals/.test(q) && o.profile) return { rows: [{ first_name: "Jordan", city: null, goals: o.profile.goals, intent: o.profile.intent, updated_at: null }] };
      return { rows: [] };
    },
  };
};
const q0 = stub();

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
    transitions: async () => (w.transitions ?? []).map((t, i) => ({ id: String(i), text: t, quote: "", openedAt: at, closedAt: null, closedQuote: null, lastTouchedAt: at, status: "active", source: "said", channel: "text", corrections: [] })) as any,
    picture: async () => ({ lessons: [], lessonsTotal: 0, corrections: [], correctionsTotal: 0 }) as any,
    people: async () => [],
    forgotten: async () => (w.removed ?? []).map((old, i) => ({ field: "x", old, now: null, ref: `m:${i}`, removed: true })),
  }) as unknown as Partial<Deps>;

// ---------------------------------------------------------------- a forgotten fact no longer reaches a match
const SECRET = "my visa is about to expire and I might have to leave the country";
const live = await MP.matchPicture("a", deps({ exchanges: [SECRET, "I want to find a climate hardware cofounder"] }), q0);
check("without a removal their own words are in the denylist", live.privateTexts.some((t) => t.includes("visa is about to expire")));
const gone = await MP.matchPicture("a", deps({ exchanges: [SECRET, "I want to find a climate hardware cofounder"], removed: ["my visa is about to expire and I might have to leave the country"] }), q0);
check("a fact they had Cue forget is out of the denylist and out of every field", !JSON.stringify(gone).includes("visa") && gone.privateTexts.some((t) => t.includes("climate hardware cofounder")));
check("a read with unread guards says so", MP.matchPictureOf({ ...(await (await import("../../src/services/memberKnowledge.js")).memberKnowledge("a", { include: MP.MATCH_SECTIONS }, deps({}))), guardsUnread: true }).unread === true);

// ---------------------------------------------------------------- only the sections matching needs
check("matching loads goals, asks, preferences, learned (the one read of limits), transitions, people, exchanges and nothing else", [...MP.MATCH_SECTIONS].sort().join() === "asks,exchanges,goals,learned,people,preferences,transitions");
check("it never loads delivered, carrying, claims, restraint or events", !["delivered", "carrying", "claims", "restraint", "events"].some((s) => (MP.MATCH_SECTIONS as readonly string[]).includes(s)));

// ---------------------------------------------------------------- a private fact can shape fit but never appears in intro text
const world: World = { goals: ["find a climate hardware cofounder"], asks: ["a cofounder who knows climate hardware"], transitions: ["I am scared about the layoffs at my company"], prefs: ["I only go to small dinners"], exchanges: ["the layoffs at my company have me scared"] };
const pa = await MP.matchPicture("a", deps(world), q0);
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
await MP.matchPicture("a", deps({ exchanges: ["a's own words"] }, seen), q0);
check("every picture read is bound to the one member asked about", seen.length > 0 && seen.every((u) => u === "a"));
const pb = await MP.matchPicture("b", deps({ exchanges: ["b's own words"] }), q0);
check("one member's picture holds none of the other's words", !JSON.stringify(pb).includes("a's own words") && !JSON.stringify(pa).includes("b's own words"));

// ---------------------------------------------------------------- quiet members rank lower, never out
const f = (o: Partial<import("../../src/harness/matchGate.js").NetworkFacts>) => ({ shareReason: '"a cofounder who knows climate hardware"', candidateStatedAsks: ["a cofounder who knows climate hardware"], candidatePrivateTexts: pa.privateTexts, alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true, ...o });
const quiet = MG.evaluateNetworkCandidate(f({ candidateQuiet: true, askerQuiet: true }));
check("a quiet candidate still passes the gate (less contact, never ejection)", quiet.ok);
check("quiet members sort after active ones, order kept", MG.activeFirst(["q1", "a1", "q2", "a2"], (x) => x.startsWith("q")).join() === "a1,a2,q1,q2");
// ---------------------------------------------------------------- call content stays in the denylist (the reviewer's probe)
const REHAB = "I'm fresh out of rehab and nobody at work knows";
const callOnly = stub({ own: [{ content: `[Call] They said ${REHAB}`, memory_type: "text_exchange" }, { content: `user: ${REHAB}, so please keep it quiet\nassistant: Understood.`, memory_type: "call_transcript" }, { content: "assistant: Co's own phrasing that is not theirs", memory_type: "call_transcript" }] });
const pCall = await MP.matchPicture("a", deps({}), callOnly);
check("a member with only call content has it in the denylist ([Call] summary and the transcript's own lines)", pCall.privateTexts.some((t) => t.includes("fresh out of rehab")) && !pCall.privateTexts.some((t) => /Co's own phrasing/.test(t)));
const sideCall = { ...sideA, goals: [], privateTexts: pCall.privateTexts };
const rehabLine = "Jordan is looking for a cofounder who knows climate hardware, and he is fresh out of rehab and nobody at work knows.";
const withDeny = RM.checkValueLines({ forFirst: clean, forSecond: rehabLine, verdict: "strong", why: "ok", judged: { first: true, second: true } }, sideCall, sideB);
const noDeny = RM.checkValueLines({ forFirst: clean, forSecond: rehabLine, verdict: "strong", why: "ok", judged: { first: true, second: true } }, { ...sideCall, privateTexts: [] }, sideB);
check("an intro line quoting call-only content is refused by the denylist (private_second)", !withDeny.ok && withDeny.checks.some((c) => c.name === "private_second" && !c.pass));
check("the same line with an empty denylist passes every other check, so the denylist is what refused it", noDeny.ok);
const forgot = await MP.matchPicture("a", deps({}), stub({ own: [{ content: `[Call] They said ${REHAB}`, memory_type: "text_exchange" }], corrections: [{ field: "x", old_value: REHAB, new_value: null, item_ref: "m:1", removed: true }] }));
check("a call row they had Cue forget is out of the denylist", !JSON.stringify(forgot).includes("rehab"));
const ownSql = callOnly.sql.find((q) => /memory_type IN \('call_transcript'/.test(q)) ?? "";
check("the own-lines read is bound to the member, has no day window and caps its rows", /user_id = \$1/.test(ownSql) && !/NOW\(\)|INTERVAL|created_at >/.test(ownSql) && /LIMIT 1000/.test(ownSql));

// ---------------------------------------------------------------- behaviour of the two gathers, with the pool stubbed
const pool = (await import("../../src/db/db.js")).default as any;
const real = pool.query;
const withPool = async <T,>(s: Stub, fn: () => Promise<T>): Promise<T> => {
  pool.query = (sql: string, args: unknown[]) => s.query(sql, args);
  try {
    return await fn();
  } finally {
    pool.query = real;
  }
};
const memorySql = (s: Stub) => s.sql.filter((q) => /FROM co_memories/.test(q));
const profile = { goals: ["find a climate hardware cofounder"], blockers: ["burnout at work"], activity_preferences: [], long_term_direction: null, intent: [{ kind: "ask", status: "active", type: "seeking", text: "a cofounder who knows climate hardware", shareable: true }, { kind: "ask", status: "active", type: "seeking", text: "a quiet therapist", shareable: false }] };
const vs = stub({ own: [{ content: `[Call] They said ${REHAB}`, memory_type: "text_exchange" }], profile });
const sideReal = await withPool(vs, () => RM.gatherValueSide("a"));
check("gatherValueSide returns the call content in the denylist and the private ask apart from the shared one", sideReal.privateTexts.some((t) => t.includes("fresh out of rehab")) && sideReal.privateAsks.join() === "a quiet therapist" && sideReal.shared.join() === "a cofounder who knows climate hardware");
check("gatherValueSide issues no read of 'everything but intent' and no unbounded co_memories read", memorySql(vs).length > 0 && memorySql(vs).every((q) => !/memory_type\s*<>/.test(q) && /memory_type\s*(=|IN)/.test(q)));
check("every co_memories read gatherValueSide issues is for the one member asked about", vs.sql.length > 0 && memorySql(vs).every((q) => /user_id = \$1/.test(q)));
let threw = false;
try {
  await withPool(stub({ failOwn: true, profile }), () => RM.gatherValueSide("a"));
} catch {
  threw = true;
}
check("gatherValueSide fails (rejects) when the picture cannot be read, never an empty denylist", threw);
const guardsDown = stub({ profile });
const origQ = guardsDown.query;
guardsDown.query = async (q: string, a: unknown[]) => {
  if (/FROM profile_corrections pc WHERE pc\.user_id/.test(q)) throw new Error("db down");
  return origQ(q, a);
};
let threwUnread = false;
try {
  await withPool(guardsDown, () => RM.gatherValueSide("a"));
} catch {
  threwUnread = true;
}
check("a picture read whole except its guards (unread) also fails the side", threwUnread);
const ns = stub({ profile });
const facts = await withPool(ns, () => MG.gatherNetworkFacts("a", "b", '"a cofounder who knows climate hardware"'));
check("gatherNetworkFacts reads no co_memories content and no member picture (only the activity timestamps)", memorySql(ns).length > 0 && memorySql(ns).every((q) => /SELECT DISTINCT m\.user_id AS id/.test(q)) && !ns.sql.some((q) => /profile_corrections|member_threads/.test(q)));
check("gatherNetworkFacts' denylist is the profile's own fields, and its shareable asks are the consented ones", facts.candidatePrivateTexts.includes("find a climate hardware cofounder") && facts.candidatePrivateTexts.includes("burnout at work") && facts.candidateStatedAsks.join() === "a cofounder who knows climate hardware");
check("the network gate stays at the pair rules (PAIR_BLOCKED_SQL) and still passes a quiet candidate", ns.sql.some((q) => /FROM network_introductions/.test(q)) && MG.evaluateNetworkCandidate({ ...facts, alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true, candidateQuiet: true, askerQuiet: true }).ok);
const vg = await withPool(stub({ failOwn: true, profile }), () => RM.valueGate("evt-1", "Founders Supper", "00000000-0000-0000-0000-00000000000a", "00000000-0000-0000-0000-00000000000b", "test"));
check("valueGate fails closed and transient when a side's picture cannot be read (no pair is blocked or judged)", vg.ok === false && (vg as any).transient === true);
check("no model call in matchPicture", !/generateText|anthropic|openai/i.test(code("services/matchPicture.ts")));

console.log(`member matchPicture: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
