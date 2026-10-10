// Proactive dispatch and nudge/reflection drafts on the member-knowledge layer (services/memberKnowledge.ts, PR 8, 2026-10-09):
// one memberKnowledge read per dispatch, the timestamped transcript for the model reads and the stored form for the code that parses
// it, the member facts and member-level rules (memberRules) handed to every draft inside the dispatch and nothing outside it, and the
// gates reading what they always read. Layer 1: fake model, fake store, zero tokens.   npx tsx evals/proactive/knowledge.ts
import fs from "node:fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const P = await import("../../src/harness/proactive.js");
const MK = await import("../../src/services/memberKnowledge.js");
const MR = await import("../../src/harness/memberReflection.js");
const J = await import("../../src/services/goalJourney.js");
const { turnsFromConversation } = await import("../../src/harness/repeatAsk.js");
const { theirText } = await import("../../src/harness/payloadFirst.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const { DISCRETION_GUIDE } = await import("../../src/harness/discretion.js");
const { CO_GROUNDING, CO_MEMBER_SAFETY } = await import("../../src/services/coCore.js");
const { DELIVERY_SHAPE_RULE } = await import("../../src/services/speakable.js");
const { default: pool } = await import("../../src/db/db.js");
type MemberKnowledge = import("../../src/services/memberKnowledge.js").MemberKnowledge;

let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const NOW = new Date("2026-10-09T18:00:00Z"); // 2pm in New York
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const v = (o: any) => ({ ...o, verifiedAt: o.verifiedAt ?? at(1) });
const k: MemberKnowledge = {
  userId: "u1",
  asOf: NOW.toISOString(),
  identity: v({ firstName: "Jordan", city: "New York", zone: "America/New_York", timeZone: "America/New_York" }),
  goals: [v({ text: "Raise a pre-seed round", state: "active", reason: null, told: true }), v({ text: "Ship the first version", state: "done", reason: "they closed it", told: true })],
  asks: [v({ id: "a1", text: "a design partner in fintech", kind: "find" })],
  delivered: [v({ what: "Founders Breakfast", kind: "event", at: at(30), via: ["offer"], url: "https://lu.ma/fb", reaction: "loved" })],
  carrying: [
    v({ what: "find two angel investors", kind: "task", state: "outstanding", told: true, theyHaveIt: false, dueAt: null, ref: "task #3", status: null, detail: null }),
    v({ what: "The pitch outline", kind: "document", state: "done", told: true, theyHaveIt: true, dueAt: null, ref: "doc #1", status: null, detail: null }),
  ],
  lessons: [v({ text: "Keep texts to one line in the morning" })],
  corrections: [v({ field: "city", was: "Boston", now: "New York" })],
  preferences: [v({ text: "Small founder dinners land; big mixers don't", source: "taste" })],
  claims: [],
  restraint: v({ holdUntil: null, spaceUntil: null, safetyHold: false, needsCare: true, frustratedWithCo: false, feeling: null, suppressedKinds: [], trialKinds: [], unanswered: { count: 0, lastInboundAt: null, lastSentAt: null } }),
  exchanges: [
    v({ from: "co", text: "Want me to look for angels who back fintech?", call: false, verifiedAt: at(26) }),
    v({ from: "member", text: "yes please", call: false, verifiedAt: at(25) }),
    v({ from: "co", text: "We talked through the raise.", call: true, verifiedAt: at(5) }),
  ],
  person: v({ text: "Who they are:\nA founder in New York." }),
};
const rules = MK.memberRules(k);

// ---- the transcript: stored form for the parsers, stamped for the model reads
{
  const plain = P.exchangeTranscript(k);
  const turns = turnsFromConversation(plain);
  check("transcript: the stored form parses as Co's question then their yes (repeat-question check)", turns.length >= 2 && turns[0].from === "co" && /angels/.test(turns[0].text) && turns[1].from === "them" && turns[1].text.startsWith("yes please"));
  check("transcript: payload first reads only their own lines from it", theirText(plain) === "yes please");
  check("transcript: a call line keeps its [Call] mark", /^\[Call\] We talked through the raise\.$/m.test(plain));
  const stamped = P.exchangeTranscript(k, { stamped: true });
  check("transcript: stamped lines open with when it was said, in their zone", /^\[Thu Oct 8, 12pm EDT\] Co replied: Want me/m.test(stamped) && /^\[Thu Oct 8, 1pm EDT\] User said: yes please$/m.test(stamped));
  check("transcript: dispatch reads the same 12-exchange window it always did", P.DISPATCH_EXCHANGES.exchanges === 12 && !P.DISPATCH_KNOWLEDGE.includes("claims"));
}

// ---- the draft block: member facts and the member-level rules, word for word
const block = P.memberDraftBlock(k, rules);
check("block: the member-level rules are the shared constants themselves", [DISCRETION_GUIDE, CO_MEMBER_SAFETY, CO_GROUNDING, DELIVERY_SHAPE_RULE].every((r) => block.includes(r)));
check("block: restraint and quiet hours come from their state", block.includes(rules.restraint) && block.includes(rules.quietHours) && /hard time/.test(block));
check("block: only an active goal is where they're headed; a done goal is history", /headed \(the lens: never recite it\): Raise a pre-seed round$/m.test(block) && /history, never current direction\): Ship the first version \(done\)/.test(block));
check("block: what they already have is named: never re-pitched as new, but reminders and follow-ups are fine", /Already sent them \(don't re-pitch any as new; a reminder, follow-up or update about one is fine\): Founders Breakfast \(event, Thu Oct 8, they reacted: loved\)/.test(block));
check("block: carrying shows what's open, not what's done", /find two angel investors \(task, outstanding, they know\)/.test(block) && !/The pitch outline/.test(block));
check("block: corrections, taste, lessons and open asks are in it", /city: New York, not Boston/.test(block) && /Small founder dinners/.test(block) && /one line in the morning/.test(block) && /design partner in fintech/.test(block));
check("block: background only, never a source to state, never a reason to SKIP", /never a source for a date, an event or a commitment/.test(block) && /none of them is a reason to SKIP/.test(block));
check("block: nothing on file still renders", /nothing more on file/.test(P.memberDraftBlock({ ...k, goals: [], asks: [], delivered: [], carrying: [], lessons: [], corrections: [], preferences: [] }, rules)));

// ---- draftProactive: the block inside a dispatch, nothing outside it
{
  const prompts: string[] = [];
  P.setProactiveModelForTests(async (p) => { prompts.push(p); return "Still on for the angels search?"; });
  await P.draftProactive({ functionId: "t", firstName: "Jordan", facts: { the_thing: "angels" }, task: "Ask." });
  await P.draftWithKnowledge(k, rules, () => P.draftProactive({ functionId: "t", firstName: "Jordan", facts: { the_thing: "angels" }, task: "Ask." }));
  const inside = await P.draftWithKnowledge(k, rules, async () => P.draftKnowledge());
  const outside = P.draftKnowledge();
  P.setProactiveModelForTests(null);
  check("draft: outside a dispatch the prompt has no member block (other paths unchanged)", !prompts[0].includes("WHAT YOU KNOW ABOUT THEM") && !prompts[0].includes("MEMBER RULES"));
  check("draft: inside a dispatch the prompt carries the block once, after CONFIRMED_FACTS", prompts[1].split("WHAT YOU KNOW ABOUT THEM").length === 2 && prompts[1].indexOf("CONFIRMED_FACTS") < prompts[1].indexOf("WHAT YOU KNOW ABOUT THEM") && prompts[1].includes(DISCRETION_GUIDE));
  check("draft: a type can read the dispatch's knowledge, and none outside it", inside === k && outside === null);
  const none = await P.draftWithKnowledge(null, null, async () => P.draftKnowledge());
  check("draft: a failed knowledge read drafts without it", none === null);
}

// ---- dispatch: one read, the gates unchanged
{
  const s = src("harness/proactive.ts");
  const body = s.slice(s.indexOf("export async function dispatchForUser"), s.indexOf("export { proactivePaused }"));
  check("dispatch: memberKnowledge is read once per dispatch", (body.match(/memberKnowledge\(/g) ?? []).length === 1);
  check("dispatch: the untimestamped 12-row transcript query is gone", !/memory_type = 'text_exchange' ORDER BY created_at DESC LIMIT 12/.test(body));
  // Phase A6 (2026-10-10): the gates and the drafts read restraint once, through the record's loader (memberSendState), and the record
  // is handed that same read rather than reading it again.
  const ps = src("harness/proactive.ts");
  check("dispatch: the gates and the record share one restraint read (needsCare, safety hold, kind restraint, hold/space)", /const member = await memberSendState\(userId, person, now\);/.test(body) && /MK\.realKnowledgeDeps\.restraint\(userId, now\)/.test(ps) && /needsCare: !!raw\.emotional\?\.needsCare,/.test(ps) && /safetyHold: raw\.safetyHold,/.test(ps) && /suppressedKinds: raw\.suppressed,/.test(ps) && /\{ restraint: async \(\) => member\.raw \}/.test(body) && !/getEmotionalContext\(userId\)|safetyHoldActive\(userId\)|hold_until, space_until FROM proactive_user_state/.test(body));
  check("dispatch: the knowledge read comes after the gates, never before them", body.indexOf("memberKnowledge(") > body.indexOf("evaluateCandidates(state, opts)"));
  check("dispatch: the model reads get the stamped transcript, the parsers the stored one", /choosePick\(ev\.eligible, \{ recentConversation: recentStamped/.test(body) && (body.match(/stillRelevant\([^)]*recentConversation: recentStamped/g) ?? []).length === 2 && /repeatQuestionCheck\(text, recent\)/.test(body) && /payloadFirst\(\{[^}]*recent,/.test(body));
  check("dispatch: every draft (first, redraft, batched offers) runs through drafting, by its type", /drafting\(c\.type, \(\) => registry\[c\.type\]\.draft/.test(body) && /drafting\(c\.type, \(\) => draftAgain/.test(body) && /drafting\(sib\.type, \(\) => registry\.event_offer\.draft/.test(body) && !/feelingForDraft\.run\(renderEmotionalContext\(emotional\), \(\) => registry/.test(body));
  // post_call builds its own member section (PR #121): no dispatch block for it, so nothing is in its prompt twice.
  check("dispatch: post_call drafts get no member block; every other type does", P.OWN_MEMBER_CONTEXT.has("post_call") && P.OWN_MEMBER_CONTEXT.size === 1 && /OWN_MEMBER_CONTEXT\.has\(type\) \? draftWithKnowledge\(null, null,/.test(body));
  const prompts: string[] = [];
  P.setProactiveModelForTests(async (p) => { prompts.push(p); return "How did the call land?"; });
  await P.draftWithKnowledge(null, null, () => P.draftProactive({ functionId: "t", firstName: "Jordan", facts: { x: "y" }, task: "Ask." }));
  P.setProactiveModelForTests(null);
  check("dispatch: a draft run without knowledge (post_call) carries no member block or rules", !prompts[0].includes("WHAT YOU KNOW ABOUT THEM") && !prompts[0].includes("MEMBER RULES") && !prompts[0].includes(DISCRETION_GUIDE));
}

// ---- goal check-in: a goal done in the knowledge is never asked about
{
  check("goal state: read by its text", J.goalCheckinState(k.goals, " raise a PRE-SEED round ") === "active" && J.goalCheckinState(k.goals, "Ship the first version") === "done" && J.goalCheckinState(k.goals, "Hire a CTO") === null);
  const intent = [{ id: "g1", kind: "goal", text: "Ship the first version", status: "active" }];
  const orig = (pool as any).query;
  (pool as any).query = async () => ({ rows: [{ intent }] });
  P.setProactiveModelForTests(async () => "Still shipping the first version, or has that shifted?");
  const cand = { id: "c", userId: "u1", type: "goal_checkin", payload: { goalId: "g1", text: "Ship the first version" } } as any;
  const inDispatch: any = await P.draftWithKnowledge(k, rules, () => proactiveRegistry.goal_checkin.draft(cand, { firstName: "Jordan", userId: "u1" } as any));
  const alone: any = await proactiveRegistry.goal_checkin.draft(cand, { firstName: "Jordan", userId: "u1" } as any);
  P.setProactiveModelForTests(null);
  (pool as any).query = orig;
  check("goal check-in: done in the knowledge, skipped even while the profile entry still reads active", !!inDispatch.skip);
  check("goal check-in: without knowledge, the profile entry decides as before", !alone.skip && /first version/.test(alone.text));
  check("goal check-in: the done skip has its own reason", inDispatch.skip === J.GOAL_DONE_SKIP);

  // Dropped as done: the entry is marked, so the monthly cron stops re-queuing it (and only a fresh confirmation re-arms it).
  const writes: any[] = [];
  (pool as any).query = async (sql: string, args: any[]) => { if (/UPDATE co_profiles/.test(sql)) writes.push(JSON.parse(args[1])); return { rows: [{ intent }] }; };
  await proactiveRegistry.goal_checkin.onDropped!(cand, "skipped", J.GOAL_DONE_SKIP);
  await proactiveRegistry.goal_checkin.onDropped!(cand, "skipped", "model chose SKIP");
  (pool as any).query = orig;
  check("goal check-in: a done drop marks the entry; any other drop doesn't", writes.length === 1 && !!writes[0][0].checkin_done_at);
  const old = "2026-06-01T00:00:00Z";
  const due = (e: any) => J.dueGoalCheckin([{ id: "g1", kind: "goal", text: "Ship the first version", status: "active", created_at: old, confirmed_at: old, ...e }], null, NOW);
  check("goal check-in: the cron re-queues an old goal, but not one marked done", !!due({}) && due({ checkin_done_at: "2026-09-01T00:00:00Z" }) === null);
  check("goal check-in: confirmed again after the mark, it's due again in its season", !!J.dueGoalCheckin([{ id: "g1", kind: "goal", text: "x", status: "active", created_at: old, confirmed_at: "2026-07-01T00:00:00Z", checkin_done_at: "2026-06-15T00:00:00Z" }], null, NOW));
}

// ---- weekly reflection: what Co knows, and the restraint, in the prompt
{
  const base = { sends: [], replies: 0, lastReplyAt: null, offerShare: null, threads: [], zone: "America/New_York" };
  const known = MR.reflectionKnown(k)!;
  const withK = MR.reflectionPrompt("Jordan", { ...base, known, restraint: rules.restraint });
  check("reflection: goals with state, carrying, corrections and lessons", /headed: Raise a pre-seed round/.test(known) && /Ship the first version \(done\)/.test(known) && /find two angel investors \(task, outstanding\)/.test(known) && !/pitch outline/.test(known) && /city: New York/.test(known));
  check("reflection: the prompt carries them and the restraint rule", withK.includes(known) && withK.includes(rules.restraint));
  check("reflection: without knowledge the prompt is as before", !/What else you know/.test(MR.reflectionPrompt("Jordan", base)) && MR.reflectionKnown({ goals: [], carrying: [], corrections: [], lessons: [] }) === null);
  check("reflection: the gate is unchanged (a thread of theirs, never piling on)", MR.gateReflection({ move: "check_in", threadId: "x", reasoning: "r" }, { ...base, known, restraint: rules.restraint } as any).move.move === "hold");
}

console.log(`proactive knowledge: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
