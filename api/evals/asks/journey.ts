// Goals and asks through the member journey (services/goalJourney.ts): discovery, daily life, check-ins, the sweep, events, closure.
// Layer 1: fake store, fake model, zero tokens.   npx tsx evals/asks/journey.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import path from "node:path";
const J = await import("../../src/services/goalJourney.js");
const X = await import("../../src/services/profileExtraction.js");
const M = await import("../../src/services/matching.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const P = await import("../../src/harness/proactive.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const { default: pool } = await import("../../src/db/db.js");
const root = new URL("../../src/", import.meta.url).pathname;
const src = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const prompt = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const day = (n: number) => new Date(Date.UTC(2026, 9, 6) - n * 86_400_000).toISOString();
const NOW = new Date("2026-10-06T20:00:00Z");

// ---- DISCOVERY CALL: where goals are born
// The call no longer runs a goals-and-asks interview (2026-10-08: the scripted Hume-era guide is gone; Co decides
// from what it knows, as in texts). Goals and asks still come out of the call afterwards (captureIntent below).
const callPrompt = E.promptForElevenLabs(prompt);
// 2026-10-08: the call prompt is Hume's again (Royce), Rapport and all; what stays out is the repo-only goals-and-asks interview.
check("the call prompt runs no goals-and-asks interview", !/GOALS AND ASKS|what are you moving toward these next few months|here's what I'm carrying for you/.test(callPrompt));
const ex = X.captureIntentPrompt("user: I'm moving toward getting Co in front of users\nassistant: here's what I'm carrying for you...\nuser: no, the first thing is pre-seed", "whole_transcript");
check("the extraction takes direction as entries too, and treats the corrected playback as the final list", /DIRECTION they said they are moving toward over the next few months/.test(ex) && /the CORRECTED version is the final list/.test(ex) && X.normalizeCapturedAsks({ asks: Array.from({ length: 12 }, (_, i) => ({ text: `entry ${i}`, type: "seeking" as const })) } as any, "whole_transcript").length === 8);

// ---- DAILY LIFE: goals stay silent (the lens)
check("the lens rule: judge against goals, almost never say them, never ask about them in passing", /LENS, not the conversation/.test(J.LENS_RULE) && /almost never say it back/.test(J.LENS_RULE) && /never ask about it in passing/.test(J.LENS_RULE));
check("replies get goals as an unspoken hint plus the rule (never as a fact to recite)", /addHint\(replyFacts, `Where they say they are headed:/.test(src("routes/sendblue.ts")) && /addInstruction\(replyFacts, lens\.rule\)/.test(src("routes/sendblue.ts")));
check("the call context carries their closed goals as an arc line, orientation only", /arcLine\(profile\?\.intent\)/.test(src("services/callContext.ts")));
const intent = [
  { id: "g1", kind: "goal", status: "active", text: "Raise a pre-seed round", created_at: day(80), confirmed_at: day(80) },
  { id: "g2", kind: "goal", status: "active", text: "Get Co in front of users", created_at: day(20), confirmed_at: day(20) },
  { id: "a1", kind: "ask", status: "active", text: "Find me weekend events", created_at: day(90) },
  { id: "g3", kind: "goal", status: "resolved", text: "Ship the first version", created_at: day(120), resolved_at: day(60), closed_by: "member", closed_quote: "we shipped it" },
];
check("goal history is the autobiography: closed goals are kept, dated, with their closing words; asks are not in it", J.goalHistory(intent).map((g) => g.text).join("|") === "Ship the first version|Raise a pre-seed round|Get Co in front of users" && J.goalHistory(intent)[0].closedQuote === "we shipped it" && !J.goalHistory(intent).some((g) => g.text.includes("weekend")));
check("the arc line names what they closed, by month, and nothing still open", /Ship the first version/.test(String(J.arcLine(intent))) && !/Raise a pre-seed/.test(String(J.arcLine(intent))));

// ---- CHECK-INS: rare, seasonal, never the 7-day ask clock
check("a goal is asked about only after eight weeks unconfirmed: a 20-day-old goal is not due, an 80-day-old one is", J.dueGoalCheckin([intent[1]], null, NOW) === null && J.dueGoalCheckin([intent[0]], null, NOW)?.id === "g1");
check("seasonal, never a drumbeat: nothing for eight weeks after the last goal check-in, whatever goals are due", J.dueGoalCheckin(intent, new Date(NOW.getTime() - 30 * 86_400_000), NOW) === null && J.dueGoalCheckin(intent, new Date(NOW.getTime() - 60 * 86_400_000), NOW)?.id === "g1");
check("asks, closed goals and the oldest-unconfirmed order: only goals are ever due, oldest first", J.dueGoalCheckin([intent[2]], null, NOW) === null && J.dueGoalCheckin([intent[3]], null, NOW) === null && J.dueGoalCheckin([{ ...intent[1], created_at: day(70), confirmed_at: day(70) }, intent[0]], null, NOW)?.id === "g1");
check("the type's own policy is a season: no more than one in 56 days, held while they struggle, and it is a companion message", /goal_checkin: \{ priority: 9, typeGapDays: 56 \}/.test(src("harness/proactive.ts")) && /"ask_checkin",\s+"goal_checkin",/.test(src("harness/proactive.ts")) && /goal_checkin: "companion"/.test(src("harness/proactivePurpose.ts")));
check("it does not ride the 7-day ask clock: the ask check-in cron reads ask_checkins only and never queues a goal_checkin", !/goal_checkin/.test(src("jobs/index.ts").slice(src("jobs/index.ts").indexOf("Co Loop Stage 5 check-in on an open ask"), src("jobs/index.ts").indexOf("Luma & X asks need to surface"))) && /runGoalCheckins\(\)/.test(src("jobs/index.ts")));
{
  const queued: any[] = [];
  (pool as any).query = async (sql: string) => (/FROM co_profiles cp JOIN users u/.test(sql) ? { rows: [{ user_id: "u1", intent, last_checkin: null }, { user_id: "u2", intent: [intent[2]], last_checkin: null }] } : { rows: [] });
  const PR: any = P;
  // enqueueCandidate is called for real: stub the table it writes to
  (pool as any).connect = async () => ({ query: async (sql: string) => { if (/INSERT INTO proactive_candidates/.test(sql)) queued.push(sql); return { rows: /INSERT INTO proactive_candidates/.test(sql) ? [{ id: "1" }] : [] }; }, release: () => {} });
  const n = await J.runGoalCheckins(NOW);
  check("the cron queues one check-in for the member with an old goal, none for the member with only asks", n === 1 && PR !== null);
}
{
  P.setProactiveModelForTests(async () => "Still chasing the pre-seed, or has that shifted?");
  let reads = 0;
  (pool as any).query = async (sql: string) => { reads++; return { rows: [{ intent }] }; };
  const open: any = await proactiveRegistry.goal_checkin.draft({ id: "c", userId: "u1", type: "goal_checkin", payload: { goalId: "g1", text: "Raise a pre-seed round", since: "July 2026" } } as any, { firstName: "Jordan", userId: "u1" } as any);
  check("the check-in is one light question in their words ('still chasing it, or has that shifted?')", !open.skip && /still chasing the pre-seed/i.test(open.text) && open.rules.maxSentences === 2);
  const gone: any = await proactiveRegistry.goal_checkin.draft({ id: "c", userId: "u1", type: "goal_checkin", payload: { goalId: "g3", text: "Ship the first version" } } as any, { firstName: "Jordan", userId: "u1" } as any);
  check("a goal that has closed in the meantime is not asked about", !!gone.skip);
  P.setProactiveModelForTests(null);
}

// ---- THE SWEEP: goals ambient (own budget), asks active, offers judged against both
check("offers are judged against the ask AND where they are headed: the ask sweep hands the fit judge profile goals plus goal entries", /goals: goalTexts\(row\.intent, row\.goals\)\.length \? goalTexts\(row\.intent, row\.goals\) : null/.test(src("jobs/index.ts")) && /cp\.goals, cp\.intent, cp\.activity_preferences/.test(src("jobs/index.ts")));
check("the daily pick is judged against goals too, as a lens that is never the stated reason", /goals: k\.goals\.filter\(\(g\) => g\.state === "active"\)/.test(src("services/sweepSelectContext.ts")) && /goalTexts\(prof\?\.intent, prof\?\.goals\)/.test(src("services/sweepSelectContext.ts")) && /the LENS: judge every candidate against this as well as the asks; never cite it as the reason/.test(src("services/sweepSelect.ts")));
check("the goal sweep keeps its own budget and the ask sweep still only reads asks", /runGoalSweep\(runWithConcurrency\)/.test(src("jobs/index.ts")) && /WHERE ac\.resolved_at IS NULL AND ac\.kind = 'find'/.test(src("jobs/index.ts")));

// ---- EVENTS: goals frame who is worth meeting, asks write the reason
const onlyGoals = [{ id: "g9", kind: "goal", status: "active", text: "Meet people building consumer social", created_at: day(5) }];
check("someone with only goals is scored against them as the frame (not asked what they want from the room)", M.getGoalFrame(onlyGoals)?.text === "Meet people building consumer social" && M.getActiveSeekingAsk(onlyGoals) === null && /getActiveSeekingAsk\(person\.intent\) \?\? getGoalFrame\(person\.intent\)/.test(src("services/eventScoring.ts")));
check("the reason shown is only ever an ask: a candidate with only a goal has no share reason", M.shareReasonFromOwnAsk(onlyGoals, "S1") === "" && /what they've said they're looking for: "Find me weekend events"/.test(M.shareReasonFromOwnAsk([{ ...intent[2], shareable: true }], "S1")));
check("the brief is goals as frame, asks as bullets: it hands the writer both, and says to frame in one line without reciting, then the people with their reasons", /where_they_say_they_are_headed_the_frame_only/.test(src("harness/proactiveRegistry.ts")) && /what_they_asked_for_now/.test(src("harness/proactiveRegistry.ts")) && /Frame the room in one line against where they are headed/.test(src("harness/proactiveRegistry.ts")));

// ---- CLOSURE: only at the member's word, and a companion moment
{
  let stored: any[] = JSON.parse(JSON.stringify(intent));
  const enq: string[] = [];
  (pool as any).query = async (sql: string, args: any[] = []) => {
    if (/SELECT intent FROM co_profiles/.test(sql)) return { rows: [{ intent: stored }] };
    if (/UPDATE co_profiles SET intent/.test(sql)) { stored = JSON.parse(args[1]); return { rows: [] }; }
    return { rows: [] };
  };
  (pool as any).connect = async () => ({ query: async (sql: string) => { if (/INSERT INTO proactive_candidates/.test(sql)) enq.push(sql); return { rows: /INSERT INTO proactive_candidates/.test(sql) ? [{ id: "9" }] : [] }; }, release: () => {} });
  const ok = await J.closeGoal("u1", "g1", "we closed the round");
  const g1 = stored.find((e) => e.id === "g1");
  check("closing a goal at their word marks it resolved by the member with their words, and keeps it (the autobiography)", ok && g1.status === "resolved" && g1.closed_by === "member" && g1.closed_quote === "we closed the round" && stored.length === intent.length);
  check("and it is a companion moment: a goal_closed message is queued, not just a status flip", enq.length === 1);
  check("an ask can't be closed this way, and a goal already closed can't be closed twice", (await J.closeGoal("u1", "a1", null)) === false && (await J.closeGoal("u1", "g1", null)) === false && enq.length === 1);
}
{
  P.setProactiveModelForTests(async () => "You were chasing this back in July, and you did it.");
  const r: any = await proactiveRegistry.goal_closed.draft({ id: "c", userId: "u1", type: "goal_closed", payload: { goalId: "g1", text: "Raise a pre-seed round", startedIn: "July 2026", closedIn: "October 2026", quote: "we closed the round" } } as any, { firstName: "Jordan", userId: "u1" } as any);
  check("the closing moment acknowledges the arc in a few lines, with no question, offer or next step", !r.skip && /chasing this back in July/.test(r.text) && r.rules.maxSentences === 3 && /No question, no offer, no next step/.test(src("harness/proactiveRegistry.ts")));
  P.setProactiveModelForTests(null);
}
check("nothing closes a goal on its own: the only code that resolves a goal entry is closeGoal, reached only from the member-quoted resolution pass", ["services/askLifecycle.ts", "services/askExpiry.ts", "services/loopLifecycle.ts", "jobs/index.ts", "services/goalSweep.ts"].every((f) => !/closeGoal|kind === "goal"[^\n]*resolved/.test(src(f))) && /closeGoal\(user_id, id, null\)/.test(src("services/profileExtraction.ts")));
check("the resolution pass reads errands AND goals, so a goal can close at their word (three sites share one list)", ["services/profileExtraction.ts", "services/turnLearning.ts", "services/callLearning.ts"].every((f) => /openErrandsAndGoals/.test(src(f))));
check("asks are disposable, goals are not: the lifecycle (expiry, evidence closes, check-ins) only ever reads ask_checkins, which a goal has no row in", !/goalEntries|isActiveGoal|kind === "goal"/.test(src("services/askLifecycle.ts") + src("services/askExpiry.ts")));

console.log(`goals and asks across the journey: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
