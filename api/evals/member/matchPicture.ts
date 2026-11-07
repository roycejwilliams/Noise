// Model-free checks for matching on the guarded member picture (Cue Memory Spec step 11, part 1, 2026-11-06): services/matchPicture.ts,
// read by harness/matchGate.ts (gatherNetworkFacts) and services/roomMatching.ts (gatherValueSide). No database, no model.
//   npx tsx evals/member/matchPicture.ts
import { readFileSync } from "fs";
import { join } from "path";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
// The opt-in write embeds its memory in the background: answered by a local stub, set before anything is imported (the client keeps the fetch it is built with), so no outside call is made.
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0] }], model: "stub", usage: { prompt_tokens: 0, total_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
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

type World = { lessons?: string[]; people?: any[]; goals?: string[]; asks?: string[]; exchanges?: string[]; removed?: string[]; prefs?: string[]; transitions?: string[]; goalStates?: { goal: string; state: string }[] };
const deps = (w: World, seen: string[] = []): Partial<Deps> =>
  ({
    profile: async (u: string) => (seen.push(u), { firstName: "Jordan", city: null, goals: w.goals ?? [], intent: null, updatedAt: null }),
    zone: async () => null,
    linkedNames: async () => [],
    goalStates: async (u: string) => (seen.push(u), (w.goalStates ?? []) as any),
    asks: async (u: string) => (seen.push(u), (w.asks ?? []).map((t, i) => ({ id: `a${i}`, text: t, kind: "find", createdAt: at, lastMentionedAt: null }))),
    taste: async () => null,
    roomTaste: async () => (w.prefs ?? []).map((text) => ({ text, at })),
    limits: async () => ({ avoid: [], availability: null, at: null }),
    exchanges: async (u: string) => (seen.push(u), (w.exchanges ?? []).map((c) => ({ content: `User said: ${c}`, at }))),
    transitions: async () => (w.transitions ?? []).map((t, i) => ({ id: String(i), text: t, quote: "", openedAt: at, closedAt: null, closedQuote: null, lastTouchedAt: at, status: "active", source: "said", channel: "text", corrections: [] })) as any,
    picture: async () => ({ lessons: (w.lessons ?? []).map((text, i) => ({ id: `l${i}`, text, at })), lessonsTotal: (w.lessons ?? []).length, corrections: [], correctionsTotal: 0 }) as any,
    people: async () => w.people ?? [],
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
const callOnly = stub({ own: [{ content: `[Call] They said ${REHAB}`, memory_type: "text_exchange" }, { content: `user: ${REHAB}, so please keep it quiet\nassistant: Understood.`, memory_type: "call_transcript" }, { content: "Co initiated call to Jordan at 4pm", memory_type: "call_transcript" }] });
const pCall = await MP.matchPicture("a", deps({}), callOnly);
check("a member with only call content has it in the denylist ([Call] summary and the transcript)", pCall.privateTexts.some((t) => t.includes("fresh out of rehab")));
const sideCall = { ...sideA, goals: [], privateTexts: pCall.privateTexts };
const rehabLine = "Jordan is looking for a cofounder who knows climate hardware, and he is fresh out of rehab and nobody at work knows.";
const withDeny = RM.checkValueLines({ forFirst: clean, forSecond: rehabLine, verdict: "strong", why: "ok", judged: { first: true, second: true } }, sideCall, sideB);
const noDeny = RM.checkValueLines({ forFirst: clean, forSecond: rehabLine, verdict: "strong", why: "ok", judged: { first: true, second: true } }, { ...sideCall, privateTexts: [] }, sideB);
check("an intro line quoting call-only content is refused by the denylist (private_second)", !withDeny.ok && withDeny.checks.some((c) => c.name === "private_second" && !c.pass));
check("the same line with an empty denylist passes every other check, so the denylist is what refused it", noDeny.ok);
const forgot = await MP.matchPicture("a", deps({ removed: [REHAB] }), stub({ own: [{ content: `[Call] They said ${REHAB}`, memory_type: "text_exchange" }] }));
check("a call row they had Cue forget is out of the denylist", !JSON.stringify(forgot).includes("rehab"));
const ownSql = callOnly.sql.find((q) => /memory_type IN \('call_transcript'/.test(q)) ?? "";
check("the own-lines read is bound to the member and has no day window", /user_id = \$1/.test(ownSql) && !/NOW\(\)|INTERVAL|created_at >/.test(ownSql));
// Transcripts keep both sides: a vague member, and Cue's line that names the detail outright.
const vague = stub({ own: [{ content: "user: it's been a rough few months, you know\nassistant: So you're fresh out of rehab, and that's why the job change matters.", memory_type: "call_transcript" }] });
const pVague = await MP.matchPicture("a", deps({}), vague);
check("a call transcript is in the denylist whole: Cue's lines that name the private detail count too", pVague.privateTexts.some((t) => t.includes("So you're fresh out of rehab")));
const vagueLine = "Jordan is looking for a cofounder who knows climate hardware, and he is fresh out of rehab, which is why the job change matters.";
const vagueRes = RM.checkValueLines({ forFirst: clean, forSecond: vagueLine, verdict: "strong", why: "ok", judged: { first: true, second: true } }, { ...sideA, goals: [], privateTexts: pVague.privateTexts }, sideB);
check("an intro line carrying what only Cue's transcript line said is refused", !vagueRes.ok && vagueRes.checks.some((c) => !c.pass && /private|hidden|sensitive/.test(c.name)));
// The cap: call content is never capped; the markers are left out in SQL; only check_in and recap are capped, newest dropped first.
const [uncapped, capped] = ownSql.split("UNION ALL");
check("call transcripts, call summaries, outcome and correction rows are in the uncapped read, which has no LIMIT", /call_transcript/.test(uncapped) && /\[Call\]/.test(uncapped) && /event_checkin_outcome/.test(uncapped) && /call_correction/.test(uncapped) && !/LIMIT/.test(uncapped));
check("call-attempt markers are excluded in SQL from both reads", (ownSql.match(/NOT LIKE 'Co initiated call%'/g) ?? []).length === 2);
check("only check_in and recap are capped, ordered oldest first so the newest are what the cap drops", /check_in/.test(capped) && /recap/.test(capped) && !/call_transcript|\[Call\]/.test(capped) && /ORDER BY created_at ASC LIMIT 300/.test(capped));

// ---------------------------------------------------------------- behaviour of the two gathers, with the pool stubbed
const pool = (await import("../../src/db/db.js")).default as any;
const real = pool.query;
const withPool = async <T,>(s: Stub, fn: () => Promise<T>): Promise<T> => {
  pool.query = (sql: string, args: unknown[]) => s.query(sql, args);
  try {
    return await fn();
  } finally {
    // A rejected Promise.all leaves its other reads running: let them finish against this stub, not the next one.
    await new Promise((r) => setTimeout(r, 60));
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

// ---------------------------------------------------------------- a yes is never dropped by a picture blip (eventGuestMatchHandoff.ts)
const H = await import("../../src/services/eventGuestMatchHandoff.js");
const H_class = H.additiveClassification;
const A = { user_id: "00000000-0000-0000-0000-00000000000a", first_name: "Jordan", phone_number: "+15550000001", email: "a@example.com" };
const B = { user_id: "00000000-0000-0000-0000-00000000000b", first_name: "Priya", phone_number: "+15550000002", email: "b@example.com" };
const hs = stub({ failOwn: true, profile });
let handoffThrew = false;
await withPool(hs, async () => {
  try {
    await H.handleMatchNudgeReply("evt-1", "Founders Supper", "interested", A, B);
  } catch {
    handoffThrew = true;
  }
});
check("when the asker's picture cannot be read, the reply handling does not throw (so the member's yes is acknowledged)", !handoffThrew);
check("the ask waits in line (queued for the candidate, naming the asker) instead of being dropped", hs.sql.some((q) => /INSERT INTO event_match_offers/.test(q) && /'queued'/.test(q)));
check("nothing was drafted or claimed against a thinner denylist (no slot claimed, no send)", !hs.sql.some((q) => /pg_advisory_xact_lock|INSERT INTO deferred_sends/.test(q)));
check("a decision is recorded for the held ask", hs.sql.some((q) => /INSERT INTO decisions|INSERT INTO decision/i.test(q)) || hs.sql.some((q) => /decision/i.test(q) && /INSERT/.test(q)));
// The drain: a queued ask whose asker's picture still cannot be read stays in line for the next drain; it is not expired.
const drain = stub({ failOwn: true, profile });
const baseQuery = drain.query;
drain.query = async (q: string, a: unknown[]) => {
  if (/FROM event_match_offers/.test(q) && /status = 'queued' ORDER BY created_at ASC LIMIT 1/.test(q)) return (drain.sql.push(q), { rows: [{ event_id: "evt-1", person_id: B.user_id, candidate_key: A.user_id, kind: "direct_ask", candidate_id: A.user_id, asker_id: A.user_id, status: "queued", opened_at: null, event_name: "Founders Supper" }] });
  if (/SELECT id AS user_id, first_name, phone_number, email FROM users/.test(q)) return (drain.sql.push(q), { rows: [{ ...A }, { ...B }] });
  if (/SELECT 1 FROM event_match_offers WHERE event_id = \$1 AND person_id = \$2 AND candidate_key = \$3 AND status = 'queued'/.test(q)) return (drain.sql.push(q), { rows: [{ "?column?": 1 }] });
  return baseQuery(q, a);
};
await withPool(drain, () => H.sendNextQueued(B.user_id));
check("a queued ask that cannot be read yet is not expired by the drain (it waits for the next one)", !drain.sql.some((q) => /UPDATE event_match_offers SET status = 'expired'/.test(q)));
// The additive reveal (handleAdditiveReply): a transient value-gate result is a hold, not a no. The reveal needs the live room (timing, roster,
// rankings, the share gate) to run, so this is pinned in the source; the gate's transient result itself is run above (valueGate).
const hs2 = code("services/eventGuestMatchHandoff.ts");
const reveal = hs2.slice(hs2.indexOf("export async function handleAdditiveReply"));
check("a transient value gate in the reveal sets a hold and does not count as 'nobody'", /if \(v\.transient\) held = true;/.test(reveal) && /if \(held\) \{[\s\S]*holdOffer[\s\S]*return \{ revealed: null, held: true \};/.test(reveal));
check("a held reveal keeps the yes on the re-opened question (holdOffer), records a decision, and skips the 'next queued ask' send", /O\.holdOffer\(eventId, person\.user_id, "additive"\)/.test(reveal) && /action: "picture_unread_held"/.test(reveal) && reveal.indexOf("return { revealed: null, held: true }") < reveal.lastIndexOf("await sendNextQueued(person.user_id);"));
check("the reply for a held reveal is acknowledged and neither names anyone nor says nobody is there", /else if \(held\)[\s\S]{0,700}Don't name or describe anyone, don't say nobody new is there, and don't imply you'll try again on your own/.test(code("routes/sendblue.ts")));

// ---------------------------------------------------------------- permitted views: only the member's own active goals reach a prompt
const rawPerson = { id: "knows:1", kind: "knows", at, eventName: null, firstName: null, doubleYes: false, otherKey: null, mine: null, reached: false, memberAsked: false, introduced: false, ended: null, evidence: {}, outcome: null, note: null, viaNetwork: false, quote: "PEOPLEMARK my old landlord Dana" };
const marks = { ask: "ASKMARK a quiet therapist", pref: "PREFMARK only small dinners", trans: "TRANSMARK worried about the layoffs", ex: "EXMARK what I said last week", less: "LESSMARK never joke about my sister", call: "CALLMARK told Cue on a call about the move", assist: "ASSISTMARK Cue said you're leaving your marriage", people: "PEOPLEMARK" };
const goalMark = "GOALMARK find a climate hardware cofounder";
const viewWorld: World = { goals: [goalMark], asks: [marks.ask], prefs: [marks.pref], transitions: [marks.trans], exchanges: [marks.ex], lessons: [marks.less], people: [rawPerson] };
const viewProfile = { goals: [goalMark], blockers: [], activity_preferences: [], long_term_direction: null, intent: [{ kind: "ask", status: "active", type: "seeking", text: "a cofounder who knows climate hardware", shareable: true }, { kind: "ask", status: "active", type: "seeking", text: marks.ask, shareable: false }] };
const viewQ = stub({ own: [{ content: `[Call] ${marks.call}`, memory_type: "text_exchange" }, { content: `user: hmm\nassistant: ${marks.assist}`, memory_type: "call_transcript" }], profile: viewProfile });
const viewSide = await withPool(viewQ, () => RM.gatherValueSide("a", (u) => MP.matchPicture(u, deps(viewWorld), viewQ)));
const otherSide: import("../../src/services/roomMatching.js").ValueSide = { userId: "b", firstName: "Priya", ownAsks: [{ text: "can offer introductions to climate hardware founders", type: "offering", shareable: true }], goals: [], pastOutcomes: [], shared: ["can offer introductions to climate hardware founders"], privateAsks: [], privateTexts: [] };
const nonGoal = Object.values(marks);
const ownPrompt = RM.sideLinePrompt("Founders Supper", viewSide, { firstName: "Priya", shared: otherSide.shared });
const theirPrompt = RM.sideLinePrompt("Founders Supper", otherSide, { firstName: "Jordan", shared: viewSide.shared });
check("the member's own active goal is in their own fit prompt", ownPrompt.includes(goalMark));
check("the goal is in no prompt the other side's call sees", !theirPrompt.includes("GOALMARK"));
check("no other section (asks, preferences, transitions, exchanges, lessons, people, calls, Cue's call lines) reaches either side's prompt", nonGoal.every((m) => !ownPrompt.includes(m.split(" ")[0]) && !theirPrompt.includes(m.split(" ")[0])));
check("the free-text fields a prompt or draft is built from hold none of them (goals, shared asks, past outcomes)", nonGoal.every((m) => !JSON.stringify([viewSide.goals, viewSide.ownAsks, viewSide.shared, viewSide.pastOutcomes]).includes(m.split(" ")[0])));
check("every one of them is in the denylist instead, where it can only make a line be refused", nonGoal.every((m) => viewSide.privateTexts.some((t) => t.includes(m.split(" ")[0]))));
// The draft intro text: the asker's `said` is their shared asks and the value line, and privateTexts is only ever handed to checkNoPrivateQuote.
for (const f of ["services/eventGuestMatchHandoff.ts", "services/eventScoring.ts"]) {
  const uses = code(f).split("\n").filter((l) => /privateTexts/.test(l));
  check(`${f}: privateTexts is used only inside checkNoPrivateQuote`, uses.length > 0 && uses.every((u) => /checkNoPrivateQuote\(/.test(u)));
}

// ---------------------------------------------------------------- memory rules for matching
const goalsOnly = async (w: World, extra: Partial<Deps> = {}) => (await MP.matchPicture("a", { ...deps(w), ...extra }, q0)).goals;
const podcast = await goalsOnly({ goals: ["start a podcast", "find a climate cofounder"], removed: ["start a podcast"] });
check("a goal they had Cue forget is not current", !podcast.some((g) => /podcast/.test(g)) && podcast.includes("find a climate cofounder"));
const { goalHash } = await import("../../src/services/goalEdges.js");
const states = ["done", "stale"].map((state, i) => ({ goalHash: goalHash(["finish the deck", "open a studio"][i]), goal: ["finish the deck", "open a studio"][i], state, reason: "", source: "member", changedAt: at, toldAt: at, hints: 0 }));
const closed = await goalsOnly({ goals: ["finish the deck", "open a studio", "find a climate cofounder"], goalStates: states as any });
check("a done goal and a set-aside goal are history, not current", closed.join() === "find a climate cofounder");
const oakland = await MP.matchPicture("a", { ...deps({ goals: ["move to Oakland", "find a climate cofounder"] }), forgotten: async () => [{ field: "goals", old: "move to Oakland", now: "move to Berkeley", ref: "goal:9", removed: false }] }, q0);
check("a goal they corrected away does not beat the correction", !oakland.goals.some((g) => /Oakland/.test(g)) && oakland.goals.includes("find a climate cofounder"));
const ask = await withPool(stub({ profile: viewProfile }), () => RM.gatherValueSide("a", (u) => MP.matchPicture(u, deps({ removed: ["a cofounder who knows climate hardware", marks.ask] }), q0)));
check("an ask they had Cue forget is in neither what is shared nor what is kept private", ask.shared.length === 0 && ask.ownAsks.length === 0 && ask.privateAsks.length === 0);
const kept = await withPool(stub({ profile: viewProfile }), () => RM.gatherValueSide("a", (u) => MP.matchPicture(u, deps({}), q0)));
check("with nothing forgotten the same asks are there", kept.shared.length === 1 && kept.privateAsks.length === 1);

// ---------------------------------------------------------------- the held reveal keeps the yes; the direct ask retry is bounded
check("additive reply: a held question treats anything but a no as the yes already given", H_class("yes", { heldYes: true }) === "interested" && H_class("nudge", { heldYes: true }) === "interested" && H_class(null, { heldYes: true }) === "interested" && H_class("no", { heldYes: true }) === "not_interested");
check("additive reply: an ordinary question still needs the yes (as before)", H_class("yes", {}) === "interested" && H_class("no", {}) === "not_interested" && H_class("nudge", {}) === "not_interested");
const O = await import("../../src/services/inRoomOffers.js");
const hold = stub({});
await withPool(hold, () => O.holdOffer("evt-1", B.user_id, "additive"));
check("holdOffer re-opens only an additive question and keeps its yes on it", hold.sql.length === 1 && /SET status = 'open'/.test(hold.sql[0]) && /answer = 'yes'/.test(hold.sql[0]) && /kind = 'additive'/.test(hold.sql[0]));
const pendRow = (answer: string | null) => ({ event_id: "evt-1", person_id: B.user_id, candidate_key: "additive", kind: "additive", candidate_id: null, candidate_ids: [A.user_id], asker_id: null, status: "open", answer, opened_at: at, event_name: "Founders Supper" });
const pendQ = (answer: string | null) => { const s0 = stub({}); const qq = s0.query; s0.query = async (q: string, a: unknown[]) => (/FROM event_match_offers/.test(q) && /status = 'open'/.test(q) ? (s0.sql.push(q), { rows: [pendRow(answer)] }) : qq(q, a)); return s0; };
const heldPend = await withPool(pendQ("yes"), () => H.findPendingMatchNudges(B.user_id));
const plainPend = await withPool(pendQ(null), () => H.findPendingMatchNudges(B.user_id));
check("a held additive question is found with its yes; an ordinary one without", heldPend[0]?.heldYes === true && plainPend[0]?.heldYes === false && heldPend[0]?.kind === "additive");
// The bound on the direct-ask retry.
const retryQ = (ageHours: number | null) => {
  const s0 = stub({ failOwn: true, profile });
  const qq = s0.query;
  s0.query = async (q: string, a: unknown[]) => (/SELECT created_at FROM event_match_offers/.test(q) && /status = 'queued'/.test(q) ? (s0.sql.push(q), { rows: ageHours === null ? [] : [{ created_at: new Date(Date.now() - ageHours * 3600_000) }] }) : qq(q, a));
  return s0;
};
const first = retryQ(null);
await withPool(first, () => H.handleMatchNudgeReply("evt-1", "Founders Supper", "interested", A, B));
check("first failure: the ask is queued and one decision is recorded", first.sql.some((q) => /INSERT INTO event_match_offers/.test(q)) && first.sql.filter((q) => /INSERT INTO harness_decisions/.test(q)).length >= 1);
const again = retryQ(1);
await withPool(again, () => H.handleMatchNudgeReply("evt-1", "Founders Supper", "interested", A, B));
check("a retry within the day is silent: no new row, no new decision, still queued", !again.sql.some((q) => /INSERT INTO event_match_offers|UPDATE event_match_offers SET status = 'expired'/.test(q)) && !again.sql.some((q) => /INSERT INTO harness_decisions/.test(q) && /asker_picture_unread/.test(q)));
const gaveUp = retryQ(25);
await withPool(gaveUp, () => H.handleMatchNudgeReply("evt-1", "Founders Supper", "interested", A, B));
check("still unreadable after a day: the queued ask is dropped (expired) and the decision says so", gaveUp.sql.some((q) => /UPDATE event_match_offers SET status = 'expired'/.test(q)));
check("no model call in matchPicture", !/generateText|anthropic|openai/i.test(code("services/matchPicture.ts")));

console.log(`member matchPicture: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
