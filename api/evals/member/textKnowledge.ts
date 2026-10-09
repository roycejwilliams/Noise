// Model-free checks for the text reply on the member-knowledge layer (PR 3, 2026-10-09): the reply's context reads member
// knowledge once (services/turnContext.ts assembleContext), its goal lens is goals WITH their state, claims and carrying come from
// the layer, and the member-level rules (memberRules) ride along. No database, no model.
//   npx tsx evals/member/textKnowledge.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const MK = await import("../../src/services/memberKnowledge.js");
const TC = await import("../../src/services/turnContext.js");
const RG = await import("../../src/harness/replyGrounding.js");
type MemberKnowledge = import("../../src/services/memberKnowledge.js").MemberKnowledge;
type Restraint = import("../../src/services/memberKnowledge.js").Restraint;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const NOW = new Date("2026-10-09T18:00:00Z"); // 11am in San Francisco
const H = 3_600_000;
const iso = (h: number) => new Date(NOW.getTime() - h * H).toISOString();
const ZONE = "America/Los_Angeles";
const calm: Restraint = { holdUntil: null, spaceUntil: null, safetyHold: false, needsCare: false, frustratedWithCo: false, feeling: null, suppressedKinds: [], trialKinds: [], unanswered: { count: 0, lastInboundAt: iso(0), lastSentAt: null, pausedUntil: null }, verifiedAt: NOW.toISOString() };
const knowledge = (o: Partial<MemberKnowledge> = {}): MemberKnowledge => ({
  userId: "u",
  asOf: NOW.toISOString(),
  identity: { firstName: "Jordan", city: "San Francisco", zone: ZONE, timeZone: ZONE, verifiedAt: iso(48) },
  goals: [],
  asks: [],
  delivered: [],
  carrying: [],
  lessons: [],
  corrections: [],
  preferences: [],
  claims: [],
  restraint: calm,
  exchanges: [],
  person: null,
  ...o,
});

// ---------------------------------------------------------------- the goal lens reads goal state (the known gap)
{
  const k = knowledge({
    goals: [
      { text: "raise a seed round", state: "active", reason: null, told: true, verifiedAt: iso(24) },
      { text: "hire a designer", state: "done", reason: "they closed it", told: true, verifiedAt: iso(72) },
      { text: "find a venue for the Oct 3 launch", state: "stale", reason: "its date passed", told: false, verifiedAt: iso(200) },
    ],
  });
  const lens = RG.goalLens(k, null);
  check("lens: only active goals are where they're headed (done and stale are history)", JSON.stringify(lens?.texts) === JSON.stringify(["raise a seed round"]), lens);
  check("lens: the rule rides with it", /LENS, not the conversation/.test(lens?.rule ?? ""));
  check("lens: no knowledge, no lens (fails closed)", RG.goalLens(null, null) === null);
}

// ---------------------------------------------------------------- claims from the layer, rendered the way a reply reads them
{
  const k = knowledge({
    claims: [
      { text: "They are building a climate startup.", provenance: "user_said", kind: "building", quote: "building a climate startup", expiresOn: null, verifiedAt: "2026-10-03T00:00:00.000Z" },
      { text: "They have a pitch on Friday.", provenance: "user_said", kind: "plan", quote: "pitch on friday", expiresOn: "2026-10-11", verifiedAt: "2026-10-07T00:00:00.000Z" },
      { text: "They seem tired of events.", provenance: "co_inferred", kind: "mood", quote: null, expiresOn: "2026-10-12", verifiedAt: "2026-10-08T00:00:00.000Z" },
      { text: "A plan that ended.", provenance: "user_said", kind: "plan", quote: "a plan that ended", expiresOn: "2026-10-05", verifiedAt: "2026-10-01T00:00:00.000Z" },
    ],
  });
  const said = RG.heldClaimsFrom(k, NOW)!;
  check("claims: enduring things they said, dated the day they said it (never a day off in their zone)", said.enduring.length === 1 && /climate startup\. \(they said, Oct 3\)/.test(said.enduring[0]), said);
  check("claims: a plan they said, with until", said.theySaid.length === 1 && /pitch on Friday\. \(they said, Oct 7, until Oct 10\)/.test(said.theySaid[0]), said);
  check("claims: Co's own read is never 'they said'", said.coInferred.length === 1 && ![...said.enduring, ...said.theySaid].some((l) => /tired of events/.test(l)));
  check("claims: an expired claim is gone", ![...said.enduring, ...said.theySaid, ...said.coInferred].some((l) => /ended/.test(l)));
  check("claims: no knowledge, nothing to answer from (fails closed)", RG.heldClaimsFrom(null) === null);
}

// ---------------------------------------------------------------- carrying: the one builder, labelled for a text
{
  const items = MK.carryingOf({
    tasks: [],
    briefs: [],
    receipts: [],
    // A document only Co's own record has (co_facts 'sent'), and a promise from a call that went: both new to the text path.
    ledger: [{ label: "a document (PDF): Friday Dinner Plan", url: null, kind: "document", at: new Date(NOW.getTime() - 20 * H) }],
    loops: [{ id: 31, title: "Pick a date with Sam", status: "waiting_on_them", dueDate: "2026-10-10", source: "notes", detail: null, changedAt: new Date(NOW.getTime() - 5 * H), lastConfirmedAt: null }],
    promises: [{ at: new Date(NOW.getTime() - 26 * H), content: 'Looked into "three rooftop bars for Friday" after the call; nothing sent yet.' }],
    now: NOW,
    zone: ZONE,
  });
  const lines = TC.carryFromKnowledge(items, ZONE);
  const block = TC.carryingBlock(lines) ?? "";
  check("carrying: a document only co_facts records shows as delivered", /"Friday Dinner Plan": delivered/.test(block) && lines.some((l) => l.kind === "document" && l.state === "done"), block);
  check("carrying: a promise from a call that hasn't gone is outstanding and told (they heard it)", /your promise on a call: three rooftop bars for Friday \[already told them\]/.test(block), block);
  check("carrying: a loop keeps its id for updateLoop, its status and due day", /\[loop 31\] Pick a date with Sam: waiting on them, due 2026-10-10/.test(block), block);
  check("carrying: a loop due tomorrow is due now", lines.find((l) => l.kind === "loop")?.state === "due");
  check("carrying: never more than 14 lines", TC.carryFromKnowledge(Array.from({ length: 30 }, (_, i) => ({ what: `t${i}`, kind: "task" as const, state: "outstanding" as const, told: false, theyHaveIt: false, dueAt: null, ref: `task #${i}`, status: null, detail: null, verifiedAt: NOW.toISOString() })), ZONE).length === 14);
  const deadline = TC.carryFromKnowledge([{ what: "find a caterer", kind: "task", state: "outstanding", told: false, theyHaveIt: false, dueAt: "2026-10-12T23:59:00.000Z", ref: "task #3", status: null, detail: null, verifiedAt: NOW.toISOString() }], ZONE)[0];
  check("carrying: a deadline day is said as a day, not a clock time", deadline.label === 'task #3: "find a caterer" (their deadline 2026-10-12)', deadline.label);
}

// ---------------------------------------------------------------- member rules and knowledge as reply facts
{
  const k = knowledge({ corrections: [{ field: "city", was: "Oakland", now: "San Francisco", verifiedAt: iso(30) }], preferences: [{ text: "Rooftop dinners landed; big mixers didn't.", source: "taste", verifiedAt: iso(30) }] });
  const rules = MK.memberRules(k);
  const rf = RG.baseReplyFacts();
  const before = rf.instructions.length;
  RG.addMemberKnowledge(rf, k, rules);
  check("rules: discretion is the shared constant, said once (deduped against the base facts)", rf.instructions.filter((i) => i === rules.discretion).length === 1);
  check("rules: delivery shape and quiet hours in their zone are attached", rf.instructions.includes(rules.deliveryShape) && rf.instructions.some((i) => i.startsWith(rules.quietHours) && /America\/Los_Angeles/.test(i)));
  check("rules: no restraint line when nothing is on", !rf.instructions.some((i) => /^Restraint:/.test(i)) && rf.instructions.length === before + 2);
  check("knowledge: taste and corrections as facts", rf.facts.some((f) => f.text === "Rooftop dinners landed; big mixers didn't.") && rf.facts.some((f) => /city was "Oakland", now "San Francisco"/.test(f.text) && /only the new version is true/.test(f.text)));
  const muted = knowledge({ restraint: { ...calm, suppressedKinds: ["event_offer"] } });
  const rf2 = RG.createReplyFacts();
  RG.addMemberKnowledge(rf2, muted, MK.memberRules(muted));
  check("rules: a muted kind brings its restraint line (kind restraint awareness)", rf2.instructions.some((i) => /^Restraint:/.test(i) && /event_offer/.test(i)), rf2.instructions);
  const rf3 = RG.createReplyFacts();
  RG.addMemberKnowledge(rf3, null, null);
  check("no knowledge (names unreadable): nothing added", rf3.facts.length === 0 && rf3.instructions.length === 0);
}

// ---------------------------------------------------------------- the path reads the layer, once, and its duplicate loaders are gone
{
  const tc = src("services/turnContext.ts");
  const sb = src("routes/sendblue.ts");
  const rg = src("harness/replyGrounding.ts");
  check("assembleContext: one memberKnowledge read, sections limited to what a text reply reads", (tc.match(/memberKnowledge\(userId/g) ?? []).length === 1 && /include: TEXT_KNOWLEDGE/.test(tc));
  check("assembleContext: tasks, briefs and receipts read once, shared with the layer", /tasks: \(\) => tasksOnce\(\), briefs: \(\) => briefsOnce\(\), receipts: \(\) => receiptsOnce\(\)/.test(tc));
  check("assembleContext: no loaders of its own for asks, lessons or loops", !/FROM ask_checkins/.test(tc) && !/memory_type = 'co_lesson'/.test(tc) && !/FROM open_loops/.test(tc));
  check("text route: claims and the goal lens from member knowledge, not their own reads", /heldClaimsFrom\(turn\?\.knowledge\)/.test(sb) && /goalLens\(turn\?\.knowledge, turn\?\.profile\?\.intent\)/.test(sb) && !/liveClaimsRendered/.test(sb) && !/goalTexts\(/.test(sb));
  check("reply facts: taste from the layer when the turn has it", /addMemberKnowledge\(rf, t\?\.knowledge, t\?\.rules\)/.test(rg));
  check("the text-channel rules stay in the reply prompt", /Reply in one or two sentences/.test(src("agent/conversationReply.ts")));
}

console.log(`text reply on member knowledge: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
