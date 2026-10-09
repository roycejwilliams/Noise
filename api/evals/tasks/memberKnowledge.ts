// Task turns and follow-ups read member facts from the one member-knowledge layer (services/memberKnowledge.ts). Model-free.
//   npx tsx evals/tasks/memberKnowledge.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const F = await import("../../src/services/followUps.js");
const TT = await import("../../src/services/taskTurn.js");
const MK = await import("../../src/services/memberKnowledge.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, info = "") => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${info ? ` :: ${info}` : ""}`); } };

const now = new Date("2026-10-09T20:00:00Z");
const NY = "America/New_York";
const x = (from: "member" | "co", text: string, minAgo: number, call = false) => ({ from, text, call, verifiedAt: new Date(now.getTime() - minAgo * 60_000).toISOString() });
const ex = [x("co", "Found two rooftops.", 300), x("member", "we booked Wave ourselves", 120), x("co", "Said on the call: I'll send the DJ list", 60, true), x("member", "thanks!\nalso need a DJ", 5)];

// The thread: stamped, in stored shape, and still readable by the goal-done check.
const stamped = F.exchangeText(ex as any, (at) => new Date(at).toISOString().slice(11, 16));
check("every line is stamped with its time", stamped.split("\n").every((l) => /^\[\d\d:\d\d\] /.test(l)), stamped);
check("lines keep their stored shape (User said / Co replied / [Call])", /\] User said: we booked Wave/.test(stamped) && /\] Co replied: Found two/.test(stamped) && /\] \[Call\] Said on the call/.test(stamped));
check("a multi-line message is stamped on every line", /User said: thanks!\n\[\d\d:\d\d\] also need a DJ/.test(stamped));
check("the goal-done check still reads their newest lines through the stamps", JSON.stringify(TT.newestMemberLines(stamped)) === JSON.stringify(["we booked Wave ourselves", "thanks!"]), JSON.stringify(TT.newestMemberLines(stamped)));
check("...and unstamped lines as before", JSON.stringify(TT.newestMemberLines("User said: hi\nCo replied: yo")) === JSON.stringify(["hi"]));
check("a teammate's lines never reach the thread", !F.exchangeText([x("member", "draft a tweet [to Mo]", 3)] as any, () => "t").length);
check("follow-ups stamp with how long ago", /^\[2h ago\] User said: we booked/m.test(F.exchangeText(ex as any, (at) => F.ago(at, now))));

// The task's knowledge block.
const k: any = {
  delivered: [{ what: "Wave rooftop", kind: "event", at: "2026-10-08T18:00:00Z", via: ["offer"], url: "https://wave.example/r", reaction: "loved", verifiedAt: "2026-10-08T18:00:00Z" }],
  carrying: [
    { what: "Find a DJ", kind: "task", state: "outstanding", told: true, theyHaveIt: false, dueAt: null, ref: "task #12", status: null, detail: null, verifiedAt: "x" },
    { what: "Venue shortlist", kind: "task", state: "due", told: false, theyHaveIt: false, dueAt: null, ref: "task #7", status: null, detail: null, verifiedAt: "x" },
    { what: "Old brief", kind: "brief", state: "done", told: true, theyHaveIt: true, dueAt: null, ref: "brief #2", status: null, detail: null, verifiedAt: "x" },
  ],
  asks: [{ id: "a1", text: "a DJ for the block party", kind: "find", verifiedAt: "x" }],
  corrections: [{ field: "city", was: "Oakland", now: "Brooklyn", verifiedAt: "x" }],
  lessons: [{ text: "Send fewer, better options", verifiedAt: "x" }],
  preferences: [{ text: "likes small rooms", source: "taste", verifiedAt: "x" }],
  claims: [{ text: "Party is Oct 18", provenance: "user_said", kind: "plan", quote: null, expiresOn: "2026-10-18", verifiedAt: "x" }],
  restraint: { feeling: "stressed about the party (medium, from a text)" },
};
const kt = TT.taskKnowledge(k, { taskId: 12, zone: NY });
check("what they already have is there, with when (their time) and the link", /already have from you[\s\S]*Wave rooftop \(event, Thu Oct 8, 2pm EDT\) https:\/\/wave\.example\/r/.test(kt), kt);
check("this task's own entry is not listed as something else Co carries; another task is", !/Find a DJ/.test(kt) && /Venue shortlist \(task, due\)/.test(kt));
check("done carrying isn't listed as still carried", !/Old brief/.test(kt));
check("asks, corrections (the corrected version), lessons, taste, held claims, and their feeling all reach the turn", /a DJ for the block party/.test(kt) && /city: was "Oakland", now "Brooklyn"/.test(kt) && /Send fewer, better options/.test(kt) && /likes small rooms/.test(kt) && /Party is Oct 18 \(until 2026-10-18\)/.test(kt) && /stressed about the party/.test(kt));
check("an empty knowledge read is no block", TT.taskKnowledge({ delivered: [], carrying: [], asks: [], corrections: [], lessons: [], preferences: [], claims: [], restraint: null }, { taskId: 1, zone: null }) === "");

// The rules: the shared constants themselves, plus restraint and quiet hours from their state.
const empty: any = { userId: "u", asOf: now.toISOString(), identity: { firstName: "Sam", city: null, zone: NY, timeZone: NY, verifiedAt: now.toISOString() }, goals: [], asks: [], delivered: [], carrying: [], lessons: [], corrections: [], preferences: [], claims: [], exchanges: [], person: null, restraint: { holdUntil: null, spaceUntil: null, safetyHold: false, needsCare: false, frustratedWithCo: false, feeling: null, suppressedKinds: ["event_offer"], trialKinds: [], unanswered: { count: 0, lastInboundAt: null, lastSentAt: null }, verifiedAt: now.toISOString() } };
const rules = TT.taskRules(MK.memberRules(empty), empty);
const R = MK.memberRules(empty);
check("the task reads every member-level rule, word for word", [R.grounding, R.memberSafety, R.discretion, R.deliveryShape, R.restraint, R.quietHours].every((r) => r && rules.includes(r)));
// Space after a handoff, the pick's hold and the unanswered count are Co's own lanes, set when work goes TO a task: a task told
// "nothing new until X" would hold the result it owes. What's about them stays.
{
  const later = new Date(now.getTime() + 6 * 3_600_000);
  const held: any = { ...empty, restraint: { ...empty.restraint, holdUntil: later.toISOString(), spaceUntil: later.toISOString(), safetyHold: true, needsCare: true, unanswered: { count: 3, lastInboundAt: null, lastSentAt: null } } };
  const whole = MK.memberRules(held).restraint;
  const forTask = TT.taskRules(MK.memberRules(held), held);
  check("(fixture) the layer's own restraint rule names the space, hold and unanswered count", /giving them space/.test(whole) && /starts nothing on its own until/.test(whole) && /no reply yet/.test(whole), whole);
  check("the task's restraint leaves out space, hold and the unanswered count", !/giving them space/.test(forTask) && !/starts nothing on its own until/.test(forTask) && !/no reply yet/.test(forTask), forTask);
  check("...and keeps safety hold, a hard time and muted kinds", /safety hold is on/.test(forTask) && /hard time lately/.test(forTask) && /event_offer/.test(forTask), forTask);
}
check("open asks are context only, like what Co carries", /still open \(context only: each is its own work, never worked or reported on here\)/.test(kt));
check("the restraint state reaches the turn (a muted kind)", /Restraint:.*event_offer/.test(rules) && /Quiet hours:/.test(rules));
const prompt = TT.taskTurnPrompt({ task: { id: 12, userId: "u", goal: "Find a DJ", theirWords: "need a DJ", steps: [], notes: [], wakes: 1, source: "user", createdAt: now.toISOString() } as any, firstName: "Sam", now: "Thu Oct 9, 4pm EDT", zone: NY, recent: stamped, knowledge: kt, rules });
check("the task prompt carries the knowledge, the rules and the stamped thread", prompt.includes(kt) && prompt.includes(rules) && prompt.includes(stamped) && /each stamped with its time/.test(prompt));
check("without knowledge or rules the prompt is as before (no empty headers)", !/Rules for them:/.test(TT.taskTurnPrompt({ task: { id: 1, goal: "g", theirWords: "w", steps: [], notes: [], wakes: 1, source: "user" } as any, firstName: "S", now: "n", zone: null, recent: "" })));

// The follow-up's knowledge: how they are, what they have, corrections, lessons; and only grounding + other members as rules.
const fk = F.followUpKnowledge({ restraint: { ...empty.restraint, needsCare: true, feeling: "low (high, from a text)" }, delivered: k.delivered, corrections: k.corrections, lessons: k.lessons } as any, now);
check("follow-up knowledge says how they are and what they already have", /hard time lately/.test(fk) && /latest feeling: low/.test(fk) && /Wave rooftop \(event, 26h ago\)/.test(fk) && /city: now Brooklyn/.test(fk) && /Send fewer/.test(fk), fk);
const fp = F.followUpPrompt({ task: { id: 1, goal: "Ask how the party went", wakes: 1, followup: { type: "debrief", summary: "Ask how the party went" } } as any, firstName: "Sam", recent: "", recentSends: "", now: "n", knowledge: fk, rules: `${R.grounding}\n${R.memberSafety}` });
check("the follow-up prompt carries them, and still says hours/caps/pause are enforced at send", fp.includes(fk) && fp.includes(R.grounding) && /enforced when it sends/.test(fp));

// Wiring: one layer read per turn, zone from identity, the delivery guards untouched.
const tt = src("services/taskTurn.ts");
const fu = src("services/followUps.ts");
check("a task turn reads member facts once, from memberKnowledge, zone from identity", (tt.match(/await memberKnowledge\(/g) ?? []).length === 1 && /const zone = k \? k\.identity\.zone : await memberZone\(userId\)/.test(tt) && !/getTimezoneForCity/.test(tt) && !/memory_type = 'text_exchange'/.test(tt));
check("a follow-up reads member facts from memberKnowledge as of its moment, zone from identity", /memberKnowledge\(userId, \{ now: asOf,[^)]*\{ exchanges: exchangesAsOf\(asOf\) \}\)/.test(fu) && /const zone = ctx\.zone;/.test(fu) && !/memberSafe\(/.test(fu));
check("a rejected knowledge read (names unreadable) means no member context, never an unstripped fallback", /\]\s*\}\)\.catch\(\(err: any\) => \{[\s\S]{0,200}return null;/.test(tt) && /recent: k \? exchangeText\(/.test(tt) && /\.catch\(\(err: any\) => \{[\s\S]{0,200}return null;/.test(fu) && /recent: k \? exchangeText\(/.test(fu) && !/memberSafe\(|co_memories/.test(tt) && !/memberSafe\(/.test(fu));
check("the delivery guards are all still in the task turn", ["wholeDelivery(messages)", "inventedFailure(what)", "inventedFailure(text)", "namesRejected(what)", "progressReport(what", "progressReport(text", "const asOfNow = texts.length ? { ...task, lastTextedAt: deps.now().toISOString() } : task;", "mayText(asOfNow, await deps.textsToday()", "const known = (links ?? []).filter(linkOk)", "if (docsSent.length) return { ok: false"].every((s) => tt.includes(s)));
check("task texts still go through sendExempt", /type: "task_update", targetKey: `task:\$\{task\.id\}:\$\{Date\.now\(\)\}`, messages, timezone: zone, respectHours: true/.test(tt));

console.log(`task/follow-up member knowledge: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
