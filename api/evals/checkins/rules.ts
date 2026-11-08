// Check-ins and casual openers (Royce, 2026-10-14): a check-in gets presence plus one line of the member's actual world, read before
// the reply; the reply check never cuts a backed world line as machinery, and never leaves dead air when their world has a true line;
// rhythm is measured, never used for timing yet. Layer 1: zero tokens, no database. The model is scripted per request (by what each
// prompt asks), the way evals/tasks/awayReplay.ts scripts it.
//   npx tsx evals/checkins/rules.ts
// Invented members only.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import path from "node:path";

// The model, scripted by what each prompt is for. Counted, so a check can say which reads ran.
const calls: string[] = [];
// Which reads started, in order, and reads the test holds open until it releases them: the ordering check uses no clock.
const starts: string[] = [];
const holds: Record<string, Promise<void>> = {};
const settled: Record<string, boolean> = {};
let redraftText: string | null = null;
const THROWS = "__redraft_throws__";
// The scripted read's idea of a status report: news, a reply, nothing back, still waiting, confirmed.
const STATUS_WORDS = /\b(no (real )?(word|news|reply)|nothing (back|yet)|heard back|still waiting|confirmed|replied|booked)\b/i;
// The last redraft prompt, for the thread-redraft checks.
let lastRedraft = "";
// The thread-repair answer (a reply after a thread report was cut, with enough left).
let repairText: string | null = null;
// The scripted read's idea of "the member told Co": their own texts in the prompt carry the news.
const THEIR_NEWS = /\b(said yes|confirmed|booked|heard back|got back to me)\b/i;
const backedByThem = (prompt: string) => {
  const p = prompt.replace(/\\"/g, '"');
  const theirs = (p.replace(/\\n/g, "\n").match(/What they texted Cue before that[^\n]*\n((?:- "[^\n]*"\n)+)/)?.[1] ?? "") + (p.match(/What they just told Cue: "([^"]*)"/)?.[1] ?? "");
  return THEIR_NEWS.test(theirs);
};
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const body = String(init?.body ?? "");
  const kind = /Only the member knows where it stands/.test(body) ? "thread_read" : /You check a text message Cue is about to send/.test(body) ? "claims" : /Does this line assert anything that happened/.test(body) ? "admission" : "other";
  starts.push(kind);
  if (holds[kind]) {
    settled[kind] = false;
    await holds[kind];
    settled[kind] = true;
  }
  let text = "no";
  if (/Does this line assert anything that happened/.test(body)) {
    calls.push("admission");
    text = JSON.stringify({ onlyAdmission: false });
  } else if (/You check a text message Cue is about to send/.test(body)) {
    calls.push("claims");
    const about = body.split("Message Cue is about to send:").pop() ?? "";
    text = JSON.stringify({ claims: /Nothing new on my end/.test(about) ? [{ text: "Nothing new on my end since this morning.", type: "work_status", supported: false, factId: null, quote: null }] : /booked Nopa/.test(about) ? [{ text: "Yes, I booked Nopa for you.", type: "past_action", supported: false, factId: null, quote: null }] : /Hayes Valley myself/.test(about) ? [{ text: "Still waiting to hear from Hayes Valley myself.", type: "work_status", supported: false, factId: null, quote: null }] : /searching for jazz bars/.test(about) ? [{ text: "Still searching for jazz bars for you.", type: "work_status", supported: false, factId: null, quote: null }] : /Nothing yet on the venue/.test(about) ? [{ text: "Nothing yet on the venue", type: "work_status", supported: false, factId: null, quote: null }] : /Still waiting to hear back from the Hayes Valley place/.test(about) ? [{ text: "Still waiting to hear back from the Hayes Valley place on the 14th.", type: "detail", supported: false, factId: null, quote: null }] : [] });
  } else if (/Only the member knows where it stands/.test(body)) {
    calls.push("thread_read");
    const listed = [...body.replace(/\\"/g, '"').matchAll(/(\d+)\. "([^"]+)"/g)];
    text = JSON.stringify({ reports: backedByThem(body) ? [] : listed.filter((m) => STATUS_WORDS.test(m[2])).map((m) => Number(m[1])) });
  } else if (/Your reply, after a line was cut:/.test(body)) {
    calls.push("repair");
    lastRedraft = body;
    text = repairText ?? "";
  } else if (/Your draft reply:/.test(body)) {
    calls.push("redraft");
    lastRedraft = body;
    // A redraft call that fails outright (a 400 isn't retried): the model threw.
    if (redraftText === THROWS) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "scripted failure" } }), { status: 400, headers: { "content-type": "application/json" } });
    text = redraftText ?? "";
  } else calls.push("other");
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "scripted", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const M = await import("../../src/services/memberWorld.js");
const G = await import("../../src/harness/replyGrounding.js");
const SF = await import("../../src/services/sourceFence.js");
const SP = await import("../../src/services/speakable.js");
const R = await import("../../src/services/engagementRhythm.js");
const TL = await import("../../src/services/timeline.js");
const { DAILY_SWEEP_HOUR } = await import("../../src/services/dailySweep.js");
const { DateTime } = await import("luxon");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};
const ZONE = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);
const same = (s: string) => s;

// The real failure's shape (10-13/14, an invented member): an afternoon thread, Co's 5:30pm fellowship send ending on a question, then
// nothing until "Hey co" and "Just checking in" past midnight.
const NOW = at("2026-10-14T07:04:48Z"); // 12:04am Wednesday, Pacific
const EXCHANGE = [
  { at: at("2026-10-13T23:04:00Z"), from: "member" as const, text: "Which one do you think is best for me?" },
  { at: at("2026-10-13T23:04:38Z"), from: "co" as const, text: "Founder Feast is the better fit of the two." },
  { at: at("2026-10-13T23:12:09Z"), from: "member" as const, text: "That's not an event search" },
  { at: at("2026-10-13T23:12:19Z"), from: "co" as const, text: "You're right, my mistake. What are you actually asking about then?" },
  { at: at("2026-10-14T00:30:37Z"), from: "co" as const, text: "https://harborlight.example/fellowship" },
  { at: at("2026-10-14T00:30:37Z"), from: "co" as const, text: "Harbor Light Fellowship just opened applications for its second cohort." },
  { at: at("2026-10-14T00:30:37Z"), from: "co" as const, text: "Worth a look before you decide on funding timing?" },
  { at: at("2026-10-14T07:04:20Z"), from: "member" as const, text: "Hey co" },
  { at: at("2026-10-14T07:04:32Z"), from: "co" as const, text: "Hey Jordan. What's up?" },
];
const FELLOWSHIP = { name: "Harbor Light Fellowship", sentAt: at("2026-10-14T00:30:40Z"), endsOn: "2026-12-15", reaction: null };
const SENT = [{ name: "Founder Feast", sentAt: at("2026-10-13T18:15:26Z"), endsOn: null, reaction: null }, FELLOWSHIP];
// When they were active on any channel: their texts in this exchange (the activity read sees every channel).
const ACTIVE = EXCHANGE.filter((l) => l.from === "member").map((l) => l.at);
const COVERAGE = { asks: [] as string[], goals: ["a rooftop for the Sequin AI launch party"], held: [] as string[] };
const NOTHING = { asks: [] as string[], goals: [] as string[], held: [] as string[] };
const THREAD = { text: "Waiting to hear back from the Hayes Valley venue about the Nov 14 dinner", line: "Waiting to hear back from the Hayes Valley venue about the Nov 14 dinner (said Mon Oct 12)" };
const base = (o: Partial<Parameters<typeof M.buildMemberWorld>[0]> = {}) =>
  M.buildMemberWorld({ now: NOW, zone: ZONE, keep: same, tasks: [], briefs: [], searching: COVERAGE, ahead: null, offeredGoals: [], docOffer: null, threads: [], exchange: EXCHANGE, sent: SENT, activity: ACTIVE, safetyHold: false, letPass: [], ...o });
const QUIET = EXCHANGE.slice(0, 3); // ends on their text: nothing of Co's waits

// ------------------------------------------------------------------ 1. what waits on them: only what Co raised (review item 4)
{
  const q = M.unansweredQuestion(EXCHANGE, NOW, SENT);
  check("the question Cue sent with its find, before this conversation, is waiting on them", q?.question === "Worth a look before you decide on funding timing?" && q?.name === "Harbor Light Fellowship" && !q.raisedAgain, q);
  check("a Cue line inside this conversation is never 'before it'", q?.at === "2026-10-14T00:30:37.000Z" && q?.sessionStart === "2026-10-14T07:04:20.000Z", q);
  const answered = [...EXCHANGE.slice(0, 7), { at: at("2026-10-14T01:00:00Z"), from: "member" as const, text: "maybe later" }, ...EXCHANGE.slice(7)];
  check("a text from them between the question and this conversation: not waiting", M.unansweredQuestion(answered, NOW, SENT) === null);
  check("Cue's last line before the conversation isn't a question: nothing waits", M.unansweredQuestion(EXCHANGE.map((l, i) => (i === 6 ? { ...l, text: "No deadline pressure on this one." } : l)), NOW, SENT) === null);
  check("a question older than the waiting window is history", M.unansweredQuestion(EXCHANGE, at("2026-10-17T08:00:00Z"), SENT) === null);
  check("a question with no find of Cue's sent beside it never waits (a rhetorical closer)", M.unansweredQuestion(EXCHANGE, NOW, [SENT[0]]) === null);
  const closer = [...QUIET, { at: at("2026-10-14T00:30:37Z"), from: "co" as const, text: "Big day tomorrow?" }];
  check("\"Big day tomorrow?\" on its own is never waiting", M.unansweredQuestion(closer, NOW, [SENT[0]]) === null && base({ exchange: closer, sent: [SENT[0]] }).waiting.length === 0);
  check("a send beside an earlier reply in the same block isn't what the question is about", M.unansweredQuestion(EXCHANGE, NOW, [{ name: "Founder Feast", sentAt: at("2026-10-13T23:12:30Z") }]) === null);
  check("this message counts even before its line is logged", M.unansweredQuestion(EXCHANGE.slice(0, 7), NOW, SENT)?.name === "Harbor Light Fellowship");
  check("waiting: the real 12:04am state", base().waiting[0]?.kind === "question" && base().waiting[0]?.name === "Harbor Light Fellowship");
  const reWaiting = (o: Partial<Parameters<typeof M.buildMemberWorld>[0]>) => base(o).waiting.filter((x) => x.kind === "question").length;
  check("a find whose date or deadline has passed doesn't wait", reWaiting({ sent: [{ ...FELLOWSHIP, endsOn: "2026-10-10" }] }) === 0 && reWaiting({ sent: [{ ...FELLOWSHIP, endsOn: "2026-10-13T18:00:00Z" }] }) === 0);
  check("a find they reacted to doesn't wait", reWaiting({ sent: [{ ...FELLOWSHIP, reaction: "Liked" }] }) === 0 && reWaiting({ sent: [{ ...FELLOWSHIP, reaction: "Disliked" }] }) === 0);
  check("while finds are let pass (kind restraint), a sent find never waits", reWaiting({ letPass: ["find"] }) === 0 && reWaiting({ letPass: ["goal_nudge"] }) === 1);
  const hold = base({ safetyHold: true, offeredGoals: [{ title: "Raise a pre-seed round", offeredAt: null }], docOffer: { topic: "the venue shortlist" } });
  check("during a safety hold nothing waits on them", hold.waiting.length === 0);
  const unknownHold = base({ safetyHold: null });
  check("a safety hold that can't be read: nothing waits, and it's counted as withheld", unknownHold.waiting.length === 0 && unknownHold.withheld >= 1);
  const raised = [...EXCHANGE, { at: at("2026-10-14T07:04:50Z"), from: "co" as const, text: "Good to hear from you. Harbor Light Fellowship is there whenever you want it." }];
  check("once Cue raised it again (its own later text names it), it doesn't wait again: no repeat asks", M.unansweredQuestion(raised, at("2026-10-14T07:06:00Z"), SENT)?.raisedAgain === true && base({ exchange: raised, now: at("2026-10-14T07:06:00Z") }).waiting.length === 0);
  check("a call between the question and this conversation means it isn't waiting", reWaiting({ activity: [...ACTIVE, at("2026-10-14T03:15:00Z")] }) === 0);
  check("a voice memo or a text to a teammate in between counts too (any channel, timestamps only)", reWaiting({ activity: [at("2026-10-14T05:40:00Z"), ...ACTIVE] }) === 0);
  check("activity inside this conversation doesn't count against it", reWaiting({ activity: [...ACTIVE, at("2026-10-14T07:04:40Z")] }) === 1);
  const noActivity = base({ activity: null });
  check("activity that can't be read is withheld, never read as waiting", noActivity.waiting.length === 0 && noActivity.withheld >= 1);
  check("a goal split whose moment has passed doesn't wait", base({ exchange: QUIET, offeredGoals: [{ title: "Raise a pre-seed round", offeredAt: "2026-10-12T20:00:00Z", momentOn: "2026-10-13" }] }).waiting.length === 0);
  check("a goal split Cue already raised again doesn't wait", base({ exchange: [...QUIET, { at: at("2026-10-13T23:30:00Z"), from: "co" as const, text: "No rush on the pre-seed round split." }], offeredGoals: [{ title: "Raise a pre-seed round", offeredAt: "2026-10-12T20:00:00Z" }] }).waiting.length === 0);
  check("a doc offer Cue already raised again doesn't wait", base({ exchange: [...QUIET, { at: at("2026-10-13T23:30:00Z"), from: "co" as const, text: "The venue shortlist write-up offer stands." }], docOffer: { topic: "the venue shortlist", at: "2026-10-12T20:00:00Z" } }).waiting.length === 0);
  // Only what Co raised (Royce: "Co shouldn't nag about a draft it never actually raised").
  const draftTold = [...QUIET, { at: at("2026-10-14T00:30:37Z"), from: "co" as const, text: "Here's the email to the Hayes Valley venue, ready for you to send: mailto:events@hayes.example" }];
  check("a draft Cue sent without asking anything isn't waiting on them", base({ exchange: draftTold, searching: NOTHING, sent: [{ name: "Email to the Hayes Valley venue", sentAt: at("2026-10-14T00:30:40Z") }] }).waiting.length === 0);
  check("the world has no other door into waiting", Object.keys(base()).sort().join(",") === "clock,lead,next,running,theirWords,thread,waiting,withheld" && [...M.WAITS].sort().join(",") === "doc_offer,goal_split,question");
  const tcSrc = fs.readFileSync(new URL("../../src/services/turnContext.ts", import.meta.url), "utf8");
  const call = tcSrc.slice(tcSrc.indexOf("M.buildMemberWorld({"), tcSrc.indexOf("unreadable: !safe"));
  check("the turn hands the world no loop status, working note, carrying item or draft", !!call && !/carrying|decision|loop|draft|ledger/i.test(call) && /status === "offered"/.test(call) && /safetyHold: knowledge\?\.restraint \? knowledge\.restraint\.safetyHold : null/.test(call) && /letPass: knowledge\?\.restraint\?\.suppressedKinds/.test(call) && /\bactivity,/.test(call), call);
}

// ------------------------------------------------------------------ 2. priorities and the fact
{
  const w = base();
  check("waiting on them leads, ahead of work that's running", w.lead?.kind === "question" && w.running.length === 1 && w.running[0].kind === "search_goal", w.lead);
  const fact = M.memberWorldFact(w);
  check("the fact names the find and its question once, marked as the check-in's one item", /Waiting on them \(a check-in's one item\): "Harbor Light Fellowship", which Cue sent Tue Oct 13, 5:30pm PDT asking "Worth a look before you decide on funding timing\?"; nothing from them on any channel since\./.test(fact) && fact.split("Harbor Light Fellowship").length === 2, fact);
  check("running work is background while something waits (late at night, the plain label)", /Running \(background while something waits\): Cue's daily search for their goal: "a rooftop for the Sequin AI launch party"/.test(fact), fact);
  const dayFact = M.memberWorldFact({ ...w, clock: { ...w.clock, hour: 14, part: "afternoon", local: "2:00 PM on Tuesday, October 13" } });
  check("by day, with something waiting, the running part says a check-in leaves it out and names only what waits (golden 27: Cue named the search too)", /Running \(background while something waits; a check-in leaves it out and names only what waits\): Cue's daily search/.test(dayFact) && /Waiting on them \(a check-in's one item\)/.test(dayFact), dayFact);
  check("the fact is the one the reply check knows", M.WORLD_FACT.test(fact));
  const running = M.memberWorldFact(base({ exchange: QUIET }));
  check("with nothing waiting, running work is the check-in's one item", /Nothing waits on them \(not a thing to say\)\. Running \(a check-in's one item\): Cue's daily search/.test(running), running);
  check("a goal split Cue offered waits on their pick, ahead of running work", base({ exchange: QUIET, offeredGoals: [{ title: "Raise a pre-seed round", offeredAt: "2026-10-13T20:00:00Z" }] }).lead?.kind === "goal_split");
  const nothing = base({ exchange: QUIET, searching: NOTHING });
  const nf = M.memberWorldFact(nothing);
  check("genuinely nothing (all read): no lead, and the fact says so", nothing.lead === null && nothing.withheld === 0 && /Nothing waits on them \(not a thing to say\)\. Nothing is running \(not a thing to say\)\./.test(nf), nf);
  const thread = base({ exchange: QUIET, searching: NOTHING, threads: [THREAD] });
  check("a live thread shows, marked theirs to tell, and is never the lead", thread.thread?.kind === "thread" && thread.lead === null && /Their thread \(theirs to tell: ask, never report; ask them about it as a question, and never say where it stands, not even that nothing has come yet\): Waiting to hear back from the Hayes Valley venue/.test(M.memberWorldFact(thread)));
  const next = base({ exchange: QUIET, searching: NOTHING, ahead: { tasks: [{ id: 41, goal: "Weekly branding check-in", kind: "followup", nextCheckAt: "2026-10-16T16:00:00Z", deadline: null }], queuedFinds: 0 } });
  check("the soonest scheduled check-in is what's next", next.next?.kind === "scheduled" && /a check-in with them, "Weekly branding check-in", Fri Oct 16, 9am PDT/.test(next.next.fact), next.next);
  check("running work is listed by the same items the running-work line uses", G.runningWorkLine([], [], COVERAGE).includes(`Cue's daily search for their goal: "a rooftop for the Sequin AI launch party"`) && M.runningItems([], [], COVERAGE)[0].label === `Cue's daily search for their goal: "a rooftop for the Sequin AI launch party"`);
  const task = 'Cue is working on task #52 for them: "Draft the Sequin AI planning docs" (their words: "draft docs").';
  check("an open task runs, said by its goal", M.runningItems([task], [], NOTHING)[0]?.name === "Draft the Sequin AI planning docs" && G.runningWorkLine([task], [], NOTHING).includes('task #52: "Draft the Sequin AI planning docs"'));
}

// ------------------------------------------------------------------ 3. fenced, and never "nothing" while anything is withheld (item 5)
{
  const strip = (s: string) => (/Ellis/.test(s) ? null : s);
  const withOther = base({ keep: strip, exchange: EXCHANGE.map((l, i) => (i === 6 ? { ...l, text: "Ellis is going too, worth a look?" } : l)) });
  check("a waiting line naming another member is withheld and counted, never shown", withOther.waiting.length === 0 && withOther.withheld === 1 && !/Ellis/.test(M.memberWorldFact(withOther)) && /1 more not shown here, so never say there's nothing/.test(M.memberWorldFact(withOther)), M.memberWorldFact(withOther));
  const empties = [base({ keep: () => null, unreadable: true, searching: NOTHING }), base({ exchange: null, searching: NOTHING }), base({ activity: null, searching: NOTHING }), base({ safetyHold: null, searching: NOTHING })];
  for (const e of empties) {
    const f = M.memberWorldFact(e);
    check("with anything withheld, the fact never says nothing waits or nothing runs", e.withheld >= 1 && !/\bNothing (waits|is running)\b/i.test(f) && /never say there's nothing/.test(f), f);
  }
  const hidden = base({ exchange: QUIET, searching: { asks: [], goals: [], held: [], hidden: 2 } });
  check("searches the strip hid still run: a check-in never hears nothing's on", hidden.running[0]?.kind === "searching" && /Cue's daily search for 2 things they want \(details not shown here\)/.test(M.memberWorldFact(hidden)));
  const rows = [
    { at: at("2026-10-13T23:00:00Z"), content: "User said: what about Ellis's party?" },
    { at: at("2026-10-13T23:01:00Z"), content: "User said: tell Jordan the plan [to Mo]" },
    { at: at("2026-10-13T23:01:30Z"), content: "Mo replied: on it" },
    { at: at("2026-10-13T23:02:00Z"), content: "Co replied: Worth a look?" },
    { at: at("2026-10-13T23:03:00Z"), content: "Co is looking: one sec" },
    { at: at("2026-10-13T23:04:00Z"), content: "system: something internal" },
  ];
  const fenced = SF.fenceExchange({ strip }, rows);
  check("the exchange read drops talk with a teammate, strips other members, keeps both sides", fenced.map((l) => `${l.from}:${l.text}`).join("|") === "co:Worth a look?|co:one sec", fenced);
  const src = fs.readFileSync(new URL("../../src/services/sourceFence.ts", import.meta.url), "utf8");
  check("the exchange and activity are declared sources of the fence", /exchange: "a: their recent texts with Cue/.test(src) && /activity: "a: when they were last active on any channel/.test(src) && /export async function readExchange\(f: Fence/.test(src));
  const act = src.slice(src.indexOf("export async function readActivityTimes"), src.indexOf("export async function readLessonOriginals"));
  check("the activity read returns timestamps only, scoped to the member, every channel", /SELECT created_at FROM co_memories WHERE user_id = \$1/.test(act) && /call_transcript/.test(act) && /voice memo/.test(act) && /rows\.map\(\(r: any\) => new Date\(r\.created_at\)\)/.test(act) && !/content AS|SELECT[^`]*content,/.test(act));
  const mw = fs.readFileSync(new URL("../../src/services/memberWorld.ts", import.meta.url), "utf8");
  check("the member-world read touches member data only through the fence", !/db\/db|\bpool\b|\.query\(/.test(mw) && /F\.readExchange\(fence/.test(mw) && /F\.readActivityTimes\(fence/.test(mw));
  const tc = fs.readFileSync(new URL("../../src/services/turnContext.ts", import.meta.url), "utf8");
  check("the turn builds the world from the fenced reads, with keep, and a failed fence counted", /M\.readRecentExchange\(fence\)/.test(tc) && /M\.readRecentActivity\(fence\)/.test(tc) && /keep: \(x\) => keep\(x\)/.test(tc) && /unreadable: !safe/.test(tc));
  check("the stand-in for discoveryStatus says so", /THIS IS THE STAND-IN for the planned discovery status contract \(discoveryStatus\)/.test(mw));
}

// ------------------------------------------------------------------ 4. late-night timing facts
{
  const night = M.worldClock(NOW, ZONE);
  check("12:04am Pacific reads as their 12:04 AM, late at night", night.local === "12:04 AM on Wednesday, October 14" && night.hour === 0 && night.part === "late at night" && night.today === "2026-10-14", night);
  check("the world fact carries their clock", /Their time: 12:04 AM on Wednesday, October 14 \(late at night\)\./.test(M.memberWorldFact(base())));
  const ny = M.worldClock(NOW, "America/New_York");
  check("their own zone, not the server's or the club's: 3:04 AM in New York", ny.local.startsWith("3:04 AM") && ny.part === "late at night");
  check("an unknown zone is read in Pacific and said as such", !M.worldClock(NOW, null).zoneKnown && /read in America\/Los_Angeles: their zone isn't known/.test(M.memberWorldFact(base({ zone: null }))));
  check("11:30pm is night, 9am is morning, 2pm afternoon", M.worldClock(at("2026-10-14T06:30:00Z"), ZONE).part === "night" && M.worldClock(at("2026-10-14T16:00:00Z"), ZONE).part === "morning" && M.worldClock(at("2026-10-14T21:00:00Z"), ZONE).part === "afternoon");
  const parts = Array.from({ length: 24 }, (_, h) => TL.renderTimeline(DateTime.fromObject({ year: 2026, month: 10, day: 14, hour: h }, { zone: ZONE }), []).includes(`(${M.partOfDay(h)})`));
  check("the part of day matches the turn's timeline for every hour", parts.every(Boolean));
  const dst = M.worldClock(at("2026-11-02T08:04:00Z"), ZONE);
  check("after DST ends the clock follows the zone (12:04 AM PST)", dst.local.startsWith("12:04 AM") && dst.hour === 0, dst);
  check("before 9 their time the next search is this morning; after, tomorrow", M.worldClock(NOW, ZONE).sweepToday && !M.worldClock(at("2026-10-14T17:00:00Z"), ZONE).sweepToday && DAILY_SWEEP_HOUR === 9);
  check("the next look is said from the sweep hour", /Next from Cue: the daily search, this morning from 9\./.test(M.memberWorldFact(base())));
  check("the check-in rule reads their local time for the soft late-night register", /Late at night their time \(about 11pm to 5am\) open soft/.test(M.CHECKIN_RULE));
  check("dates are read in their zone: an ISO instant is their day, a bare date is that day, junk is no date", M.dayOf("2026-10-14T06:00:00Z", ZONE) === "2026-10-13" && M.dayOf("2026-12-15", ZONE) === "2026-12-15" && M.dayOf("Dec 15, 2026", ZONE) === "2026-12-15" && M.dayOf("soon", ZONE) === null);
  // Never the process's zone (PR #201: CI runs in UTC and read "Dec 15, 2026" as Dec 14 for a Pacific member). This file runs under
  // TZ=UTC, America/Los_Angeles and Asia/Tokyo with the same answers.
  // A named US zone converts from that zone; a time range keeps its start (review of PR #201): the same under every server zone.
  const TOKYO = "Asia/Tokyo";
  check("\"Dec 15, 2026 11:30 PM PST\" is Dec 15 for a Pacific member and Dec 16 for a Tokyo one", M.dayOf("Dec 15, 2026 11:30 PM PST", ZONE) === "2026-12-15" && M.dayOf("Dec 15, 2026 11:30 PM PST", TOKYO) === "2026-12-16", [M.dayOf("Dec 15, 2026 11:30 PM PST", ZONE), M.dayOf("Dec 15, 2026 11:30 PM PST", TOKYO)]);
  check("\"Jul 4, 2026 9:00 PM EDT\" converts from Eastern: Jul 4 in Pacific, Jul 5 in Tokyo", M.dayOf("Jul 4, 2026 9:00 PM EDT", ZONE) === "2026-07-04" && M.dayOf("Jul 4, 2026 9:00 PM EDT", TOKYO) === "2026-07-05");
  check("\"Dec 15, 2026 19:00-21:00\" is a range, not an offset: Dec 15 for Pacific and Tokyo members", M.dayOf("Dec 15, 2026 19:00-21:00", ZONE) === "2026-12-15" && M.dayOf("Dec 15, 2026 19:00-21:00", TOKYO) === "2026-12-15" && M.dayOf("Dec 15, 2026 7pm-9pm", ZONE) === "2026-12-15", [M.dayOf("Dec 15, 2026 19:00-21:00", ZONE), M.dayOf("Dec 15, 2026 19:00-21:00", TOKYO), M.dayOf("Dec 15, 2026 7pm-9pm", ZONE)]);
  check("an ISO offset sitting on the time still converts: 2026-12-15T19:00-08:00 is Dec 15 in Pacific, Dec 16 in Tokyo", M.dayOf("2026-12-15T19:00-08:00", ZONE) === "2026-12-15" && M.dayOf("2026-12-15T19:00-08:00", TOKYO) === "2026-12-16");
  check("dates never depend on the server's zone: wall time stays its day, only an explicit offset converts", M.dayOf("2026-12-15T23:30", ZONE) === "2026-12-15" && M.dayOf("Dec 15, 2026 23:00", ZONE) === "2026-12-15" && M.dayOf("Tue, 15 Dec 2026 03:00:00 GMT", ZONE) === "2026-12-14" && M.dayOf("2026-12-15T03:00:00+00:00", ZONE) === "2026-12-14", [M.dayOf("2026-12-15T23:30", ZONE), M.dayOf("Dec 15, 2026 23:00", ZONE), M.dayOf("Tue, 15 Dec 2026 03:00:00 GMT", ZONE), M.dayOf("2026-12-15T03:00:00+00:00", ZONE)]);
}

// ------------------------------------------------------------------ 5. the rule, on the reply's facts (item 7: tokens)
{
  const rf = G.createReplyFacts();
  G.addMemberWorld(rf, base());
  check("the world goes on the reply's facts as a known fact, with the check-in rule and the world for the check", rf.facts.some((f) => f.kind === "known" && M.WORLD_FACT.test(f.text)) && rf.instructions.includes(M.CHECKIN_RULE_AT_NIGHT) /* base() is 12:04am */ && rf.world?.lead?.kind === "question");
  const rgSrc = fs.readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
  check("every text turn with a world gets it (gatherReplyFacts)", /if \(opts\.turn\?\.world\) addMemberWorld\(rf, opts\.turn\.world\);/.test(rgSrc));
  // Review of #310: at 12:04am a check-in got the rule's examples stitched together, a fellowship nudge on late-night care. Late at night
  // their time the reply is told it's care only; no daytime reply reads that.
  const late = G.createReplyFacts();
  G.addMemberWorld(late, base({ now: new Date("2026-10-14T07:04:00Z") }));
  const day = G.createReplyFacts();
  G.addMemberWorld(day, base({ now: new Date("2026-10-14T21:00:00Z") }));
  check("late at night their time, the reply is told it's care only", late.instructions.includes(M.LATE_NIGHT_CARE) && !day.instructions.includes(M.LATE_NIGHT_CARE), { late: late.world?.clock, day: day.world?.clock });
  check("…care only: nothing from their world, no nudge, no 'good to hear from you' opener, no guessed feeling", /this reply is care only/.test(M.LATE_NIGHT_CARE) && /leave out everything from their world unless they raised it themselves, any opportunity, nudge or thing to act on/.test(M.LATE_NIGHT_CARE) && /Don't open by saying it's good to hear from them, and don't guess what's on their mind/.test(M.LATE_NIGHT_CARE));
  check("…described, never quoted (Cue copies quoted lines)", !/["“”]/.test(M.LATE_NIGHT_CARE));
  const k = (hour: number, zoneKnown = true) => M.lateNight({ hour, zoneKnown });
  check("the late window is 11pm to 5am their time", k(23) && k(0) && k(4) && !k(5) && !k(22));
  check("…only with their zone known (it's said to them as a fact)", !k(0, false) && !k(23, false));
  const unknownZone = G.createReplyFacts();
  G.addMemberWorld(unknownZone, base({ zone: null }));
  check("…so a reply with no zone on file never gets the late-night line", !unknownZone.instructions.includes(M.LATE_NIGHT_CARE));
  // The night rule: the daytime rule without the parts that contradict care only; the daytime rule itself is unchanged.
  check("at night the check-in rule drops its quoted presence and fellowship lines and 'the world line is optional'", M.CHECKIN_NIGHT_CUTS.every(([from]) => M.CHECKIN_RULE.includes(from) && !M.CHECKIN_RULE_AT_NIGHT.includes(from)) && /the late-night line governs, care only/.test(M.CHECKIN_RULE_AT_NIGHT) && !/good to hear from you|Harbor Light|world line is optional/.test(M.CHECKIN_RULE_AT_NIGHT));
  check("…and the daytime rule keeps them (the sweep's)", /good to hear from you, what's on your mind\?/.test(M.CHECKIN_RULE) && /the world line is optional then/.test(M.CHECKIN_RULE));
  check("…a daytime reply gets the daytime rule, a late one the night rule", day.instructions.includes(M.CHECKIN_RULE) && !day.instructions.includes(M.CHECKIN_RULE_AT_NIGHT) && late.instructions.includes(M.CHECKIN_RULE_AT_NIGHT) && !late.instructions.includes(M.CHECKIN_RULE));
  const caseSrc = fs.readFileSync(new URL("../golden/cases/checkins.ts", import.meta.url), "utf8");
  check("the late-night golden case fails a business nudge or the old opener in code, and its judge asks for care only", /a business nudge on a late-night check-in/.test(caseSrc) && /opens on the line the case was written against/.test(caseSrc) && /Answer no if any business or nudge follows the care/.test(caseSrc));
  const r = M.CHECKIN_RULE;
  check("the rule: Cue judges whether it's a check-in; presence plus at most one item", /you judge that from the thread/.test(r) && /presence plus at most one item from "Their world right now"/.test(r));
  check("the rule: waiting first, else running; a warm thread asked about, never reported; presence and an open question when nothing", /what waits on them first, else what's running/.test(r) && /a warm thread is asked about \("any word from that venue\?"\), never reported/.test(r) && /with nothing running or waiting, presence and an open question/.test(r));
  check("the rule: with nothing, presence and an open question only, never a line saying nothing is waiting or running", /presence and an open question only \("good to hear from you, what's on your mind\?"\), never a line saying nothing is waiting or running/.test(r));
  check("the rule: the one item as something there for them, never an answer they owe; one breath, no list, no machinery", /That one item only, as something there for them \("the Harbor Light fellowship is there if funding's on your mind"\), never as an answer they owe/.test(r) && /One breath: no list, no status report, never your own machinery/.test(r));
  check("the rule: feelings shape the tone, never whether they hear their world", /Recent feelings shape the tone, never whether they hear their world/.test(r));
  check("the rule: tell me more expands the same item without a greeting", /"Tell me more" expands that same item, with no new greeting/.test(r));
  check("the rule and the fact are in Cue's voice: no em dash, no exclamation, no role noun, never the old brand", [r, M.memberWorldFact(base()), G.WORLD_REDRAFT_NOTE].every((t) => !/[—–]/.test(t) && !/!/.test(t) && !/\b(assistant|concierge)\b/i.test(t) && !/copatible/i.test(t)));
  // Size, by characters (no tokenizer offline; about 4 characters a token for English prose): the rule plus the fact, on the rich and
  // the empty state.
  const rich = r.length + M.memberWorldFact(base({ threads: [THREAD], ahead: { tasks: [{ id: 41, goal: "Weekly branding check-in", kind: "followup", nextCheckAt: "2026-10-16T16:00:00Z", deadline: null }], queuedFinds: 0 } })).length;
  const empty = r.length + M.memberWorldFact(base({ exchange: QUIET, searching: NOTHING })).length;
  console.log(`size: rule ${r.length} chars; rule + fact ${empty} (empty world) to ${rich} (waiting, running, next and thread) chars`);
  check("the rule plus a full world stays under 2,000 characters (about 500 tokens)", rich < 2000, rich);
}

// ------------------------------------------------------------------ 6. the guard: running work passes, machinery and thread reports are cut (item 3)
{
  const w = base({ threads: [THREAD] });
  const rf = G.createReplyFacts();
  G.addFact(rf, "known", G.runningWorkLine([], [], COVERAGE));
  G.addMemberWorld(rf, w);
  const src = { message: "Just checking in", recentConversation: "" };
  const checks = (draft: string, f = rf, s = src) => G.codeChecks(draft, f, s);
  const narr = (draft: string, f = rf) => checks(draft, f).find((c) => c.name === "no_internal_narration");
  // The thread read, scripted the way the real one answers (only a sentence that states where it stands is a yes); one judge call
  // per reply, counted.
  let reads = 0;
  const judge = async (prompt: string) => { reads++; return JSON.stringify({ reports: backedByThem(prompt) ? [] : [...prompt.matchAll(/(\d+)\. "([^"]+)"/g)].filter((m) => STATUS_WORDS.test(m[2])).map((m) => Number(m[1])) }); };
  const reportRun = async (draft: string, s = src, j: (prompt: string) => Promise<string> = judge, world = w) => {
    const f = G.createReplyFacts();
    G.addMemberWorld(f, world);
    await G.judgeThreadReports(draft, f, s, j);
    return { check: checks(draft, f, s).find((c) => c.name === "no_thread_report"), f };
  };
  const report = async (draft: string, s = src) => (await reportRun(draft, s)).check;
  const backed = "Good to hear from you. Still looking for a rooftop for the Sequin launch.";
  check("a line naming a running search, saying only that it's still looked for, passes the narration rule", !narr(backed), narr(backed));
  const noWorld = G.createReplyFacts();
  G.addFact(noWorld, "known", G.runningWorkLine([], [], COVERAGE));
  check("the same line without their world is still cut (the world is what backs it)", !!narr(backed, noWorld));
  check("a search said with progress or results gets no pass", !!narr("Still looking, and I found two promising rooftops for the Sequin launch."));
  const withTask = G.createReplyFacts();
  G.addMemberWorld(withTask, base({ exchange: QUIET, searching: NOTHING, tasks: ['Cue is working on task #52 for them: "Draft the Sequin AI planning docs" (their words: "x").'] }));
  check("a task line naming the task passes", !narr("I'm still working on the Sequin AI planning docs.", withTask));
  check("a bare \"my end\" is machinery: \"No news my end.\"", !!narr("No news my end."));
  check("\"my side\" is machinery: \"Nothing new from my side.\"", !!narr("Nothing new from my side."));
  for (const m of ["Good to hear from you. Nothing new on my end since this morning.", "All quiet in my systems tonight.", "The Sequin rooftop search hit a limit on my end.", "The Sequin rooftop search is in my queue."]) check(`machinery stays cut, whatever it names: "${m}"`, !!narr(m), m);
  check("holding their thing behind Cue's judgment stays cut even when it names it", !!narr("I'll send the Sequin rooftop options once they're worth sending."));
  check("a sentence naming nothing of theirs gets no pass", !!narr("Still looking into a few things."));
  const oneWord = G.createReplyFacts();
  G.addMemberWorld(oneWord, base({ exchange: QUIET, searching: { asks: [], goals: ["fundraising"], held: [] } }));
  check("one shared word isn't a match: \"I'm working on fundraising now.\" with a one-word goal is cut", !!narr("I'm working on fundraising now.", oneWord) && M.namesRunningItem(oneWord.world, "I'm working on fundraising now.") === null);
  check("the exemption never covers their thread: \"Working on the Hayes Valley venue dinner now.\" is cut", !!narr("Working on the Hayes Valley venue dinner now."));
  // A status report is cut on the read's yes (Royce: the thread is asked about, never reported).
  for (const t of ["No word yet from the Hayes Valley venue.", "Still nothing back from Hayes Valley.", "Good to hear from you. No real news yet from the Hayes Valley venue."]) check(`a status report on their thread is cut: "${t}"`, !!(await report(t)));
  // Advice, a plan, or what they told Co is kept (the reviewer's three), and a question never reaches the read.
  for (const t of ["For the Hayes Valley dinner on the 14th, smart casual is right.", "Since you're hosting at the Hayes Valley venue, ask them about the corkage fee.", "You emailed the Hayes Valley place on Monday, so follow up with them on the menu."]) check(`advice or recall about their thread is kept: "${t}"`, !(await report(t)));
  reads = 0;
  check("\"Which venue for the dinner?\" is a question: kept, and never read", !(await report("Which venue for the dinner?")) && reads === 0);
  check("common nouns alone don't name their thread: no read for \"Hope the venue works out for the dinner.\"", M.threadCandidates(w, "Hope the venue works out for the dinner.").length === 0 && !(await report("Hope the venue works out for the dinner.")) && reads === 0);
  check("asking about their thread is right", !(await report("Any word back from the Hayes Valley venue?")));
  check("an everyday greeting never names their thread (\"Good to hear from you.\")", !(await report("Good to hear from you.")) && M.namesWorldItem(w, "Good to hear from you.") === null);
  reads = 0;
  const two = await reportRun("No word yet from the Hayes Valley venue. For the Hayes Valley dinner, smart casual is right.");
  check("one read per reply for all its candidates, and only the report is cut", reads === 1 && !!two.check && /No word yet/.test(two.check.reason ?? "") && two.f.thread?.reads.length === 1 && two.f.thread.reads[0].sentences.length === 2, two.f.thread);
  await G.judgeThreadReports("No word yet from the Hayes Valley venue.", two.f, src, judge);
  check("a sentence already read this turn isn't read again", reads === 1);
  const failed = await reportRun("No word yet from the Hayes Valley venue.", src, async () => { throw new Error("timeout"); });
  const junk = await reportRun("No word yet from the Hayes Valley venue.", src, async () => "sure");
  check("a read that fails or doesn't parse keeps the sentence, and is logged as unread", !failed.check && !junk.check && failed.f.thread?.reads[0].reports === null && junk.f.thread?.reads[0].reports === null);
  const cutRun = await reportRun("Good to hear from you. No real news yet from the Hayes Valley venue.");
  const cut = G.stripUnsupported("Good to hear from you. No real news yet from the Hayes Valley venue.", G.codeChecks("Good to hear from you. No real news yet from the Hayes Valley venue.", cutRun.f, src).filter((c) => !c.pass));
  check("the thread report is cut sentence for sentence", cut === "Good to hear from you.", cut);
  const prompt = M.threadReadPrompt(THREAD.text, "Just checking in", ["No word yet from the Hayes Valley venue."]);
  check("the read asks where the thread stands, against advice, a plan, a question or their own words", /does it state where that thread stands, as a fact \(news, a reply, still waiting, nothing back, confirmed, booked, cancelled\), rather than advice, a plan, a question, or saying back what the member themselves told Cue\?/.test(prompt) && /\{"reports":/.test(prompt));
  check("their message this turn comes first, labelled, and an echo of their news is named as not a report, with one example each way", prompt.indexOf('What they just told Cue: "Just checking in"') < prompt.indexOf("Sentences:") && /A sentence that repeats, reacts to or builds on news the member gave \(just now or before\) is NOT a status report/.test(prompt) && /"Great that the venue said yes" is not a report; with no news from them, "No word yet from the venue" is a report/.test(prompt));
  check("a thread-report cut is Cue's own wording: the fence keeps the draft readable for lessons", SF.redactCuts("x", [{ name: "no_thread_report", reason: 'thread_report: "x"' }]) === "x");
  // Their news from an earlier turn may be said back; a status they never gave is still cut (review, 2026-10-14).
  const told = [...QUIET, { at: at("2026-10-14T05:00:00Z"), from: "member" as const, text: "Hayes Valley said yes for the 14th" }, { at: at("2026-10-14T05:00:20Z"), from: "co" as const, text: "That's a relief." }, { at: at("2026-10-14T05:02:00Z"), from: "member" as const, text: "ok what next" }];
  const echoWorld = base({ threads: [THREAD], exchange: told });
  check("their recent texts reach the read (fenced, theirs only)", echoWorld.theirWords.includes("Hayes Valley said yes for the 14th") && !echoWorld.theirWords.includes("That's a relief.") && /What they texted Cue before that, oldest first \(their own words\):\n(?:.*\n)*- "Hayes Valley said yes for the 14th"/.test(M.threadReadPrompt(THREAD.text, "ok what next", ["x"], echoWorld.theirWords)));
  check("an echo of their news from two turns ago is kept: \"Since Hayes Valley confirmed, let's plan the menu.\"", !(await reportRun("Since Hayes Valley confirmed, let's plan the menu.", { message: "ok what next", recentConversation: "" }, judge, echoWorld)).check);
  check("the same line with no news from them is still cut", !!(await reportRun("Since Hayes Valley confirmed, let's plan the menu.", { message: "ok what next", recentConversation: "" }, judge, base({ threads: [THREAD], exchange: QUIET }))).check);
  check("an unbacked status line is still cut even when they talked about the venue", !!(await reportRun("Still nothing back from Hayes Valley.", { message: "ok what next", recentConversation: "" }, judge, base({ threads: [THREAD], exchange: [...QUIET, { at: at("2026-10-14T05:00:00Z"), from: "member" as const, text: "I emailed Hayes Valley about the 14th" }] }))).check);
  // The thread read never holds the claim read back: they start together (review, 2026-10-14).
  {
    const tf = G.createReplyFacts();
    G.addMemberWorld(tf, w);
    starts.length = 0;
    // The thread read never answers until released. If the claim read waited on it, it could never start: the turn is given a fixed
    // number of event-loop turns (no clock) to start it, then the thread read is released either way, so a regression fails, never hangs.
    let release!: () => void;
    holds.thread_read = new Promise<void>((r) => (release = r));
    const turn = G.groundReply("Good to hear from you. Still nothing back from Hayes Valley, and the dinner is Nov 14.", tf, { message: "Just checking in", recentConversation: "" }, { userId: null, record: false });
    for (let i = 0; i < 2000 && !starts.includes("claims"); i++) await new Promise((r) => setImmediate(r));
    const claimStarted = starts.includes("claims");
    const threadPending = starts.includes("thread_read") && settled.thread_read === false;
    release();
    delete holds.thread_read;
    await turn;
    check("the claim read starts while the thread read is still pending (they run together)", claimStarted && threadPending && settled.thread_read === true, { starts, threadPending });
  }
  // A work claim citing their world must name a running item.
  const worldId = rf.facts.find((f) => M.WORLD_FACT.test(f.text))!.id;
  const claim = (text: string, f = rf, factId = worldId) => G.claimChecks([{ text, type: "work_status", supported: true, factId, quote: null }], f, src)[0];
  check("a work claim citing their world passes when it names the running search", claim("Still looking for a rooftop for the Sequin launch").pass, claim("Still looking for a rooftop for the Sequin launch"));
  check("a work claim citing their world that names no running item fails, even while something runs", !claim("Still working on your venue for the dinner").pass && !claim("I'm on it").pass);
  const none = G.createReplyFacts();
  G.addFact(none, "known", G.runningWorkLine([], [], NOTHING));
  G.addMemberWorld(none, base({ searching: NOTHING, exchange: QUIET }));
  const noneId = none.facts.find((f) => M.WORLD_FACT.test(f.text))!.id;
  check("no line may claim work their world doesn't list", !claim("Still looking for a rooftop", none, noneId).pass);
  check("with nothing running, 'nothing is running' citing their world passes", claim("Nothing's running for you right now", none, noneId).pass);
  const allowed = [...SP.NARRATION_RULES.map((x) => x.why)];
  check("every narration rule the world line may pass still exists by name", [...M.WORLD_STATUS_WHYS].every((why) => allowed.includes(why)));
}

// ------------------------------------------------------------------ 7. dead air only with evidence; honest paths win (item 1); true lines only (item 2)
{
  const draft = "Good to hear from you. Nothing new on my end since this morning.";
  const cut = "Good to hear from you.";
  // The world line after dead air is a daytime behavior (re-review of #310): late at night it's care only (section 7b below).
  // The same world with only its hour moved out of the late window, so nothing else about it changes.
  const daytime = (x: ReturnType<typeof base>): ReturnType<typeof base> => ({ ...x, clock: { ...x.clock, hour: 14, part: "afternoon" } });
  const w = daytime(base());
  const status = [{ name: "no_internal_narration", pass: false }, { name: "claim_work_status", pass: false }];
  check("dead air: a status sentence was cut, a few words of presence are left, and their world has a true line", M.deadAir({ draft, cut, world: w, failed: status }));
  check("not dead air without evidence: only a time claim was cut (\"ok thanks, night\")", !M.deadAir({ draft: "Night Jordan, sleep well. Talk at 9am.", cut: "Night Jordan, sleep well.", world: w, failed: [{ name: "time_on_file", pass: false }] }));
  check("an empty cut is never dead air (the honest no-answer's)", !M.deadAir({ draft: "Yes, I booked Nopa for you.", cut: "", world: w, failed: status }));
  check("under three words is never dead air (the honest no-answer's)", !M.deadAir({ draft: "Hey. Nothing new on my end.", cut: "Hey.", world: w, failed: status }));
  check("not dead air when something already went out this turn", !M.deadAir({ draft, cut, world: w, failed: status, sentThisTurn: ["https://x.example"] }));
  check("not dead air when nothing waits and nothing runs (presence is right)", !M.deadAir({ draft, cut, world: base({ searching: NOTHING, exchange: QUIET }), failed: status }));
  check("not dead air when what's left asks them something", !M.deadAir({ draft, cut: "Good to hear from you. What's on your mind?", world: w, failed: status }));
  check("not dead air when what's left already names their world", !M.deadAir({ draft: `${cut} Nothing new on my end.`, cut: "Harbor Light Fellowship is still open.", world: w, failed: status }));
  check("not dead air when nothing was cut", !M.deadAir({ draft: cut, cut, world: w, failed: status }));
  // Which paths win (harness/replyGrounding.ts deadAirAt).
  const rfOf = (world: ReturnType<typeof base>, line = G.runningWorkLine([], [], COVERAGE), instr: string[] = []) => {
    const rf = G.createReplyFacts();
    G.addFact(rf, "known", line);
    G.addMemberWorld(rf, world);
    for (const i of instr) G.addInstruction(rf, i);
    return rf;
  };
  const srcOf = { message: "Just checking in", recentConversation: "" };
  check("deadAirAt: the 12:04am case is dead air", G.deadAirAt({ draft, cut, failed: status as any, rf: rfOf(w), src: srcOf }));
  check("the nothing-running line wins when a work claim was cut and nothing runs", !G.deadAirAt({ draft, cut, failed: status as any, rf: rfOf(base({ searching: NOTHING }), G.runningWorkLine([], [], NOTHING)), src: srcOf }));
  check("a false \"I don't have that\" goes to its own redraft, never dead air", !G.deadAirAt({ draft, cut, failed: [...status, { name: "claim_detail", pass: false, reason: 'detail: "I don\'t have that on file"' }] as any, rf: rfOf(w), src: { ...srcOf, recentMemories: "User said: my mentor is Lena" } }));
  const { SAFETY_INSTRUCTION } = await import("../../src/services/safetyText.js");
  check("never on a safety turn", !G.deadAirAt({ draft, cut, failed: status as any, rf: rfOf(w, undefined, [SAFETY_INSTRUCTION]), src: srcOf }));
  const D = await import("../../src/harness/discretion.js");
  check("never on a discreet turn", D.isDiscreetTurn([`${D.DISCRETION_MARK} keep it private`]) && !G.deadAirAt({ draft, cut, failed: status as any, rf: rfOf(w, undefined, [`${D.DISCRETION_MARK} keep it private`]), src: srcOf }));
  check("never on an invite cut", !G.deadAirAt({ draft, cut, failed: [...status, { name: "no_invite_sent_claim", pass: false }] as any, rf: rfOf(w), src: srcOf }));

  // The template: only items whose truth code can check at send time, always a statement (Royce: never a question or an ask).
  const clock = M.worldClock(NOW, ZONE);
  const lines: [string, ReturnType<typeof base>][] = [
    ["question", w],
    ["goal_split", base({ exchange: QUIET, offeredGoals: [{ title: "Raise a pre-seed round", offeredAt: null }] })],
    ["doc_offer", base({ exchange: QUIET, docOffer: { topic: "the launch venue shortlist" } })],
    ["search_goal", base({ exchange: QUIET })],
    ["task", base({ exchange: QUIET, searching: NOTHING, tasks: ['Cue is working on task #52 for them: "Draft the Sequin AI planning docs" (their words: "x").'] })],
  ];
  const ASKS = /\?|^\s*(?:say|tell|let me know|pick|choose|decide|reply|text|send|check|look|take a look|read|open|click|tap|confirm|grab|apply|go|think)\b|\b(?:let me know|say the word|your call|when you decide|whenever you(?:'re| are) ready|want me to|would you|could you|can you|do you|are you|should you|you should|you need to|make sure|don't forget|remember to|get back to me)\b/i;
  const every: [string, string | null][] = [
    ...lines.map(([k, w2]) => [k, M.worldLine(w2)] as [string, string | null]),
    ["brief", M.worldStatement({ kind: "brief", name: "Venue options for the Nov 14 dinner", fact: "" }, clock)],
    ["scheduled", M.worldStatement({ kind: "scheduled", name: "Weekly branding check-in", at: "2026-10-16T16:00:00Z", fact: "" }, clock)],
  ];
  for (const [kind, line] of every) {
    check(`the fallback line for ${kind} is a statement naming only what's on file: no question, no ask, no machinery, Cue's voice`, !!line && !line.split(/(?<=[.])\s+/).some((x) => ASKS.test(x)) && !/[—–!]/.test(line) && !/\b(assistant|concierge)\b|copatible/i.test(line) && /[.]$/.test(line) && !SP.NARRATION_RULES.some((r) => (r.why === "narrates Cue's own machinery" || r.why === "task-tracker words") && r.pattern.test(line)), { kind, line });
  }
  for (const [kind, world] of lines) {
    const line = M.worldLine(world)!;
    check(`the fallback line for ${kind} passes the narration rule and names its item`, !!world.lead?.name && line.toLowerCase().includes(world.lead.name.toLowerCase()) && !SP.narratesInternalState(line, { allow: (s) => M.worldLineAllowed(world, s) }), { kind, line });
  }
  check("no template for a find whose date has passed", M.worldStatement({ kind: "question", name: "Harbor Light Fellowship", endsOn: "2026-10-10", fact: "" }, clock) === null);
  check("no template for a find whose date can't be read", M.worldStatement({ kind: "question", name: "Harbor Light Fellowship", endsOn: "soon-ish", fact: "" }, clock) === null);
  check("a find still ahead gets its line; with no date on file, none (Mahjong invite, no date)", !!M.worldStatement({ kind: "question", name: "Harbor Light Fellowship", endsOn: "2026-12-15", fact: "" }, clock) && M.worldStatement({ kind: "question", name: "Mahjong After Dark", fact: "" }, clock) === null && M.worldLine(base({ sent: [{ name: "Mahjong After Dark", sentAt: FELLOWSHIP.sentAt }] })) === null);
  const T = await import("../../src/services/turnContext.js");
  const revealed = T.mergeSent([{ item_key: "name:harbor light fellowship", item_name: "Harbor Light Fellowship", kind: "opportunity", url: null, sent_at: FELLOWSHIP.sentAt, reaction: null }], [], [], [{ name: "Harbor Light Fellowship", when: "2026-11-30", when_end: "2026-12-15" }]);
  check("a find shown in a reply carries its date from Cue's sent record, and gets the line", revealed[0]?.endsOn === "2026-12-15" && !!M.worldStatement({ kind: "question", name: revealed[0].name, endsOn: revealed[0].endsOn, fact: "" }, clock), revealed);
  check("a find's date is read the way findForm reads it (statedDates included)", T.endsOnOf({ statedDates: { start: "2026-11-02" } }) === "2026-11-02" && T.endsOnOf({ deadline: "2026-12-15", event_date: "2026-11-01" }) === "2026-12-15" && T.endsOnOf({}) === null);
  check("no template from the hidden or unreadable search state", M.worldLine(base({ exchange: QUIET, searching: { asks: [], goals: [], held: [], hidden: 2 } })) === null && M.worldStatement({ kind: "searching", name: null, fact: "" }, clock) === null);
  check("no template from an ask in their own words (no label on file)", M.worldStatement({ kind: "search_ask", name: "I'm looking for a jazz bar with a good piano in the Mission", fact: "" }, clock) === null && M.worldStatement({ kind: "search_ask", name: "live jazz nights", fact: "" }, clock) === null);
  check("no template from a goal written as a sentence", M.worldStatement({ kind: "search_goal", name: "Find me a rooftop for my launch party.", fact: "" }, clock) === null);
  check("no template for a question with nothing named", M.worldStatement({ kind: "question", name: null, fact: "" }, clock) === null);
  check("a thread gets no line, and is never the lead", M.worldStatement({ kind: "thread", name: "Waiting to hear back from the venue", fact: "" }, clock) === null && base({ exchange: QUIET, searching: NOTHING, threads: [THREAD] }).lead === null);
  check("this morning's search before 9, tomorrow's after", /on this morning's search/.test(M.worldLine(base({ exchange: QUIET }))!) && /on tomorrow morning's search/.test(M.worldLine(base({ exchange: QUIET, now: at("2026-10-14T21:00:00Z") }))!));

  // The turn itself, through groundReply with the model scripted.
  const turn = async (world: ReturnType<typeof base> | null, rewrite: string | null, d = draft, message = "Just checking in", moment: string | null = null) => {
    const rf = G.createReplyFacts();
    rf.moment = moment;
    G.addFact(rf, "known", G.runningWorkLine([], [], COVERAGE));
    if (world) G.addMemberWorld(rf, world);
    redraftText = rewrite;
    calls.length = 0;
    const r = await G.groundReply(d, rf, { message, recentConversation: "User said: Hey co\nCo replied: Hey Jordan. What's up?" }, { userId: null, record: false });
    return { r, calls: [...calls] };
  };
  const before = await turn(null, null);
  check("before: without their world the cut leaves dead air (the 10-14 reply, 'Good to hear from you.')", before.r.final === cut && before.r.outcome === "cut", before.r);
  const retried = "Good to hear from you. Harbor Light Fellowship is there whenever you want it.";
  const asJson = (checkin: boolean, reply: string) => JSON.stringify({ checkin, reply });
  const after = await turn(w, asJson(true, retried));
  check("after: the draft is retried with their world and the true line goes out", after.r.outcome === "redrafted" && after.r.final === retried && after.calls.includes("redraft"), after);
  check("after: the machinery line is still gone", !/on my end/.test(after.r.final));
  const fallback = await turn(w, asJson(true, "Good to hear from you. Your Zephyr Capital meeting is set for Friday."));
  check("00:04 \"Just checking in\": Cue said check-in, its reply failed the checks, so the lead's true line is said from their world", fallback.r.outcome === "stripped" && fallback.r.final === `${cut} Harbor Light Fellowship is there whenever you want it.` && fallback.r.checks.some((c) => c.name === "world_line"), fallback.r);
  // Daytime (late at night a failed redraft gets the care line instead, section 7b).
  const noTemplate = await turn(daytime(base({ sent: [{ ...FELLOWSHIP }], searching: { asks: ["I'm looking for a jazz bar with a good piano"], goals: [], held: [] }, exchange: QUIET })), asJson(true, "Good to hear from you. Your Zephyr Capital meeting is set for Friday."));
  check("with no line code can prove, the cut goes out alone", noTemplate.r.final === cut && !noTemplate.r.checks.some((c) => c.name === "world_line"), noTemplate.r);
  const appended = fallback.r.final;
  check("the reply with the statement isn't dead air (no re-trigger)", !M.deadAir({ draft, cut: appended, world: w, failed: status }) && !M.deadAir({ draft: appended, cut: appended, world: w, failed: status }));
  check("a later message this turn, after the appended reply went, is never dead air (no double append)", !M.deadAir({ draft, cut, world: w, failed: status, sentThisTurn: [appended] }));
  const rf2 = G.createReplyFacts();
  G.addFact(rf2, "known", G.runningWorkLine([], [], COVERAGE));
  G.addMemberWorld(rf2, w);
  calls.length = 0;
  const again = await G.groundReply(appended, rf2, { message: "Just checking in", recentConversation: "" }, { userId: null, record: false });
  check("checked again, the appended reply goes as it is, the line once", again.outcome === "as_drafted" && again.final === appended && appended.split("whenever you want it").length === 2 && !calls.includes("redraft"), again);
  // Case 30 (2026-10-14): a cut work claim about THEIR thread never gets the #190 "want me to start on it?" line; the turn goes on to
  // dead air, where a check-in redraft may ask about it. #190 is unchanged for Co's own work.
  {
    // Daytime (late at night a failed redraft gets the care line instead, section 7b).
    const threadOnly = daytime(base({ exchange: QUIET, searching: NOTHING, threads: [THREAD] }));
    const ownDraft = "All good here. Still waiting to hear from Hayes Valley myself.";
    const ask = "All good here. Any word back from the Hayes Valley venue?";
    const tf = G.createReplyFacts();
    G.addFact(tf, "known", G.runningWorkLine([], [], NOTHING));
    G.addMemberWorld(tf, threadOnly);
    redraftText = asJson(true, ask);
    calls.length = 0;
    const r = await G.groundReply(ownDraft, tf, { message: "Just checking in", recentConversation: "" }, { userId: null, record: false });
    check("a cut claim about their own thread, nothing running: no nothing-running line, and the check-in redraft asking about it goes out", !/Nothing's running on that|start on it/i.test(r.final) && r.final === ask && r.outcome === "redrafted" && calls.includes("redraft"), r);
    check("the nothing-running line doesn't apply to their thread", !G.nothingRunningLineApplies({ draft: ownDraft, cut: "All good here.", failed: [{ name: "claim_work_status", pass: false, reason: 'work_status: "Still waiting to hear from Hayes Valley myself." (x)' }] as any, rf: tf }) && M.workClaimsNameThread(threadOnly, ["Still waiting to hear from Hayes Valley myself."]));
    redraftText = "";
    const alone = await G.groundReply(ownDraft, tf, { message: "Just checking in", recentConversation: "" }, { userId: null, record: false });
    check("with no usable redraft, the cut goes out alone (no thread line from code, no offer)", alone.final === "All good here." && !alone.checks.some((c) => c.name === "world_line"), alone);
    const of = G.createReplyFacts();
    G.addFact(of, "known", G.runningWorkLine([], [], NOTHING));
    G.addMemberWorld(of, threadOnly);
    redraftText = null;
    const own = await G.groundReply("Hey Jordan, good to hear from you. Still searching for jazz bars for you.", of, { message: "hey", recentConversation: "" }, { userId: null, record: false });
    check("a cut work claim about Cue's own search, nothing running: the nothing-running line fires as before", /Nothing's running on that right now/.test(own.final) && G.nothingRunningLineApplies({ draft: "Hey Jordan, good to hear from you. Still searching for jazz bars for you.", cut: "Hey Jordan, good to hear from you.", failed: [{ name: "claim_work_status", pass: false }] as any, rf: of }), own);
  }
  // A cut thread report always gets one try (case 30's exact draft, 2026-10-14). With enough left it only repairs: every remaining
  // sentence stays, and only the words that pointed back at the cut one change (keepsEverySentence); anything else, the cut goes out.
  // Rechecked like any rewrite; never a second try.
  {
    const threadOnly = base({ exchange: QUIET, searching: NOTHING, threads: [THREAD] });
    const run = async (d: string, repair: string | null, instr: string[] = []) => {
      const f = G.createReplyFacts();
      G.addFact(f, "known", G.runningWorkLine([], [], NOTHING));
      G.addMemberWorld(f, threadOnly);
      for (const i of instr) G.addInstruction(f, i);
      repairText = repair;
      redraftText = null;
      calls.length = 0;
      lastRedraft = "";
      const r = await G.groundReply(d, f, { message: "Just checking in", recentConversation: "" }, { userId: null, record: false });
      return { r, tries: calls.filter((c) => c === "repair" || c === "redraft").length, repairs: calls.filter((c) => c === "repair").length, prompt: lastRedraft };
    };
    const draft30 = "Nothing yet from the Hayes Valley place. I'll be glad to hear it the second you do.";
    const fixed = await run(draft30, "I'll be glad to hear about Hayes Valley the second you do.");
    check("case 30's draft: the thread report is cut and the one repair fixes the dangling \"it\"", fixed.r.outcome === "redrafted" && fixed.r.final === "I'll be glad to hear about Hayes Valley the second you do." && fixed.repairs === 1 && fixed.tries === 1 && fixed.r.checks.some((c) => c.name === "no_thread_report" && !c.pass), fixed.r);
    check("the dangling \"it\" never goes out when the repair is kept", !/hear it the second/.test(fixed.r.final));
    check("the repair is told to keep every sentence and change only what points back", fixed.prompt.includes(JSON.stringify(G.THREAD_REPAIR_NOTE).slice(1, -1)) && /Return ONLY the message/.test(fixed.prompt) && !fixed.prompt.includes(JSON.stringify(G.THREAD_REDRAFT_NOTE).slice(1, -1)));
    const again = await run(draft30, "I'll be glad to hear Hayes Valley confirmed the second you do.");
    check("a repair that's cut again: the cut goes out, with no second try", again.tries === 1 && again.r.final === "I'll be glad to hear it the second you do.", again.r);
    const empty = await run(draft30, "");
    check("a repair that fails: the cut goes out, with no second try", empty.tries === 1 && empty.r.final === "I'll be glad to hear it the second you do.", empty.r);
    // The reviewer's probe: a good reply with a cut thread sentence keeps all three of its sentences.
    const probe = "No word yet from Hayes Valley. Smart casual is right for the dinner. Bring a light jacket, it gets cold. Want me to pull wine pairings?";
    const three = "Smart casual is right for the dinner. Bring a light jacket, it gets cold. Want me to pull wine pairings?";
    const shrunk = await run(probe, "Smart casual is right for the dinner.");
    check("a repair that shrinks a good reply is refused: all three sentences go out", shrunk.repairs === 1 && shrunk.r.final === three, shrunk.r);
    const same = await run(probe, three);
    check("a repair that keeps all three goes out as is", same.r.final === three, same.r);
    const away = "Nothing yet from the Hayes Valley place.";
    check("keepsEverySentence: a dropped, merged or rewritten sentence fails; a dangling \"it\" replaced from the cut sentence passes", !M.keepsEverySentence(three, "Smart casual is right for the dinner.", away) && !M.keepsEverySentence(three, "Smart casual and a jacket. Want wine pairings?", away) && M.keepsEverySentence("I'll be glad to hear it the second you do.", "I'll be glad to hear about Hayes Valley the second you do.", away));
    check("keepsEverySentence: flipped advice is not a repair", !M.keepsEverySentence("Smart casual works for the dinner.", "Smart casual doesn't work for the dinner.", away));
    check("keepsEverySentence: a new name in place of \"it\" is not a repair", !M.keepsEverySentence("Bring a light jacket, it gets cold.", "Bring a light jacket, Nopa gets cold.", away) && M.keepsEverySentence("Bring a light jacket, it gets cold.", "Bring a light jacket, Hayes Valley gets cold.", away));
    const short = G.createReplyFacts();
    G.addFact(short, "known", G.runningWorkLine([], [], NOTHING));
    G.addMemberWorld(short, threadOnly);
    redraftText = "Any word yet from the Hayes Valley place?";
    repairText = null;
    calls.length = 0;
    lastRedraft = "";
    const tiny = await G.groundReply("Hey. No word yet from Hayes Valley.", short, { message: "Just checking in", recentConversation: "" }, { userId: null, record: false });
    check("too little left after the cut: the smallest-true-reply redraft (with the thread note) runs, not the repair", calls.includes("redraft") && !calls.includes("repair") && lastRedraft.includes(JSON.stringify(G.THREAD_REDRAFT_NOTE).slice(1, -1)) && tiny.final === "Any word yet from the Hayes Valley place?", tiny);
    const { SAFETY_INSTRUCTION } = await import("../../src/services/safetyText.js");
    const safe = await run(draft30, "I'll be glad to hear about Hayes Valley the second you do.", [SAFETY_INSTRUCTION]);
    check("never on a safety turn: no try from this path, the cut goes out", safe.tries === 0 && safe.r.final === "I'll be glad to hear it the second you do.", safe.r);
    const D = await import("../../src/harness/discretion.js");
    check("never on a discreet turn or an invite cut", !G.threadRedraftAt({ failed: [{ name: "no_thread_report", pass: false }] as any, rf: (() => { const f = G.createReplyFacts(); G.addInstruction(f, `${D.DISCRETION_MARK} keep it`); return f; })() }) && !G.threadRedraftAt({ failed: [{ name: "no_thread_report", pass: false }, { name: "no_invite_sent_claim", pass: false }] as any, rf: G.createReplyFacts() }));
    const f = G.createReplyFacts();
    G.addFact(f, "known", G.runningWorkLine([], [], NOTHING));
    G.addMemberWorld(f, threadOnly);
    redraftText = "Night Jordan.";
    calls.length = 0;
    const other = await G.groundReply("Night Jordan, sleep well. Talk at 9am about the Nov 14 plan.", f, { message: "ok thanks, night", recentConversation: "" }, { userId: null, record: false });
    check("a cut that isn't a thread report gets no try from this path", !calls.includes("redraft") && !calls.includes("repair") && other.final === "Night Jordan, sleep well." && !G.threadRedraftAt({ failed: [{ name: "time_on_file", pass: false }] as any, rf: f }), other);
    // #190 skips only when the cut WORK CLAIM itself names their thread.
    const mixed = await run("No word yet from Hayes Valley. Still searching for jazz bars for you.", null);
    check("a cut thread sentence beside a cut work claim about Cue's own search: the nothing-running line still fires", /Nothing's running on that right now/.test(mixed.r.final), mixed.r);
    check("workClaimsNameThread: only when every cut work claim names the thread", M.workClaimsNameThread(threadOnly, ["Still waiting to hear from Hayes Valley myself."]) && !M.workClaimsNameThread(threadOnly, ["Still searching for jazz bars for you."]) && !M.workClaimsNameThread(threadOnly, ["Still waiting to hear from Hayes Valley myself.", "Still searching for jazz bars for you."]) && !M.workClaimsNameThread(threadOnly, []));
  }
  // The reviewer's probes: not check-ins, no status cut.
  const nopa = await turn(w, "", "Yes, I booked Nopa for you.", "Did you book Nopa?");
  check("\"Did you book Nopa?\": a fully cut draft gets the honest no-answer path, never their world", !/Harbor Light|whenever you want it/.test(nopa.r.final) && !nopa.r.checks.some((c) => c.name === "world_line") && nopa.r.outcome === "stripped", nopa.r);
  const night = await turn(w, "", "Night Jordan, sleep well. Talk at 9am.", "ok thanks, night");
  check("\"ok thanks, night\": a cut time claim leaves the goodnight alone, nothing appended", night.r.final === "Night Jordan, sleep well." && !night.r.checks.some((c) => c.name === "world_line"), night.r);
  // Co decides whether it was a check-in; code acts only on that (review, 2026-10-14).
  const nightStatus = "Night Jordan, sleep well. Nothing new on my end since this morning.";
  for (const [label, rewrite] of [["Cue says not a check-in, and its reply fails", asJson(false, "Night Jordan, sleep well. Your Zephyr Capital meeting is set for Friday.")], ["the redraft comes back empty", ""], ["the redraft isn't JSON", "Night Jordan, sleep well."]] as const) {
    const r = await turn(w, rewrite, nightStatus, "ok thanks, night");
    check(`"ok thanks, night" with a work-status line cut never gets the lead line (${label})`, r.r.final === "Night Jordan, sleep well." && !/Harbor Light|whenever you want it/.test(r.r.final), r.r);
  }
  const dadDraft = "I'm so sorry about your dad. Nothing new on my end since this morning.";
  for (const [label, rewrite] of [["Cue says not a check-in", asJson(false, "I'm so sorry about your dad. Your Zephyr Capital meeting is set for Friday.")], ["the redraft comes back empty", ""]] as const) {
    const r = await turn(w, rewrite, dadDraft, "my dad's in the hospital");
    check(`"my dad's in the hospital" never gets the lead line (${label})`, r.r.final === "I'm so sorry about your dad." && !/Harbor Light|whenever you want it/.test(r.r.final), r.r);
  }
  const notCheckinKept = await turn(w, asJson(false, "Night Jordan, sleep well."), nightStatus, "ok thanks, night");
  check("when Cue says it isn't a check-in and its reply is true, that reply goes out, with nothing from their world", notCheckinKept.r.outcome === "redrafted" && notCheckinKept.r.final === "Night Jordan, sleep well.", notCheckinKept.r);
  // Not a check-in, or unread: at most a statement about the running item the cut sentence itself named.
  const withTask = daytime(base({ exchange: QUIET, searching: NOTHING, tasks: ['Cue is working on task #52 for them: "Draft the Sequin AI planning docs" (their words: "x").'] }));
  const named = M.deadAirLine({ checkin: false, world: withTask, draft: "Night Jordan. Nothing new on the Sequin AI planning docs on my end.", cut: "Night Jordan." });
  check("not a check-in: only the running item the cut sentence named, said as a statement", named === `I'm still on "Draft the Sequin AI planning docs".`, named);
  check("unread: never the lead, at most the named item", M.deadAirLine({ checkin: null, world: w, draft, cut }) === null && M.deadAirLine({ checkin: true, world: w, draft, cut }) === "Harbor Light Fellowship is there whenever you want it.");
  // 7b. Late at night their time (re-review of #310): dead air still goes to the redraft (presence alone never goes out), the redraft is
  // told care only, and code never adds a line from their world after it.
  const nightW = base();
  check("night: presence alone after a cut status line is still dead air (the 12:04am incident)", M.deadAir({ draft, cut, world: nightW, failed: status }));
  check("night: code adds nothing from their world after dead air", M.deadAirLine({ checkin: true, world: nightW, draft, cut }) === null);
  const nightNudge = await turn(nightW, asJson(true, "Good to hear from you. Your Zephyr Capital meeting is set for Friday."));
  check("night: the redraft is told care only, never the daytime world note", !!lastRedraft && lastRedraft.includes("it's late at night for them") && lastRedraft.includes("bring in nothing from their world") && !lastRedraft.includes("the smallest true reply is that presence plus the one item their world leads with"), lastRedraft.slice(-700));
  // Third review of #310: when the care redraft isn't kept, the fixed care line goes, never "Good to hear from you." alone (the 2026-10-14
  // incident line) and never the fellowship.
  // "Just checking in" at 00:04 (the turn's moment read says small talk): the care redraft said check-in and failed its checks, or its
  // read never came back (threw, out of shape): the care line.
  for (const [label, rewrite] of [["fails its checks", asJson(true, "Good to hear from you. Your Zephyr Capital meeting is set for Friday.")], ["throws", THROWS], ["comes back out of shape", "Good to hear from you."]] as const) {
    const r = await turn(nightW, rewrite, draft, "Just checking in", "small_talk");
    check(`night: the care redraft ${label}, so the fixed care line goes, never the presence-only cut or their world`, r.r.final === G.NIGHT_CARE_LINE && r.r.final !== cut && !/Harbor Light|whenever you want it/.test(r.r.final) && r.r.checks.some((c) => c.name === "night_care") && !r.r.notSure, r.r);
  }
  // Focused review of #310: only a check-in or casual opener gets it. "my dad's in the hospital" and "ok thanks, night" at night keep their
  // cut, as they do by day.
  const nightDad = "I'm so sorry about your dad. Nothing new on my end since this morning.";
  for (const [label, rewrite] of [["says not a check-in, its reply fails", asJson(false, "I'm so sorry about your dad. Your Zephyr Capital meeting is set for Friday.")], ["comes back empty", ""], ["throws", THROWS]] as const) {
    const r = await turn(nightW, rewrite, nightDad, "my dad's in the hospital", "sharing");
    check(`night: "my dad's in the hospital" keeps its cut when the redraft ${label} (never the care line)`, r.r.final === "I'm so sorry about your dad." && !r.r.checks.some((c) => c.name === "night_care"), r.r);
  }
  const nightBye = "Night Jordan, sleep well. Nothing new on my end since this morning.";
  for (const [label, rewrite, moment] of [["says not a check-in, its reply fails", asJson(false, "Night Jordan, sleep well. Your Zephyr Capital meeting is set for Friday."), "small_talk"], ["says not a check-in", asJson(false, "Night Jordan, sleep well. Your Zephyr Capital meeting is set for Friday."), null], ["comes back empty, no moment read", "", null], ["throws, no moment read", THROWS, null]] as const) {
    const r = await turn(nightW, rewrite, nightBye, "ok thanks, night", moment);
    check(`night: "ok thanks, night" keeps its cut when the redraft ${label} (never the care line)`, r.r.final === "Night Jordan, sleep well." && !r.r.checks.some((c) => c.name === "night_care"), r.r);
  }
  const nightShare = await turn(nightW, THROWS, draft, "Just checking in", "sharing");
  check("night: a failed read on a sharing moment never gets the care line", nightShare.r.final !== G.NIGHT_CARE_LINE, nightShare.r);
  const dayFail = await turn(w, asJson(true, "Good to hear from you. Your Zephyr Capital meeting is set for Friday."));
  check("daytime unchanged: a failed redraft still gets the world line, never the night care line", dayFail.r.final === `${cut} Harbor Light Fellowship is there whenever you want it.` && dayFail.r.final !== G.NIGHT_CARE_LINE, dayFail.r);
  check("the care line is the approved copy", G.NIGHT_CARE_LINE === "You're up late. Everything ok?");
  const nightCare = await turn(nightW, asJson(true, "You're up late. Everything ok?"));
  check("night: a care-only redraft goes out", nightCare.r.outcome === "redrafted" && nightCare.r.final === "You're up late. Everything ok?", nightCare.r);
  check("the night note is its own constant; the daytime note is unchanged", /it's late at night for them/.test(G.WORLD_REDRAFT_NOTE_AT_NIGHT) && /late at night, soft and open first/.test(G.WORLD_REDRAFT_NOTE));
  check("the redraft's answer is read strictly", M.parseWorldRedraft('{"checkin": true, "reply": "Hi."}')?.checkin === true && M.parseWorldRedraft("Hi.") === null && M.parseWorldRedraft('{"checkin": "yes", "reply": "Hi."}') === null);
  check("the dead-air redraft is asked to say whether it was a check-in, and to bring nothing in when it wasn't", /First decide whether their message was a check-in or a casual opener with no ask/.test(G.WORLD_REDRAFT_NOTE) && /bring in nothing from their world/.test(G.WORLD_REDRAFT_NOTE) && /\{\\?"checkin\\?": true or false/.test(G.WORLD_REDRAFT_NOTE.replace(/\\/g, "")));
  // Live re-record of #310, checkin-live-thread (daytime, "hey", a thread-only world): the draft reported their thread ("Nothing yet on
  // the venue"), the check-in redraft reported it again, and "Good to hear from you." went out alone by day. Now the world fact and the
  // redraft say to ask; when the redraft can't be kept and their thread is all their world has, code adds THREAD_LINE, a statement that
  // names nothing and asks nothing (Royce's 2026-10-14 ruling: a line that only fires after two failures never asks the member anything).
  {
    const liveW = daytime(base({ exchange: QUIET, searching: NOTHING, threads: [THREAD] }));
    const DRAFT_LT = "Good to hear from you. Nothing yet on the venue, I'll be curious the second they write back.";
    const r = await turn(liveW, asJson(true, "Good to hear from you. Still waiting to hear back from the Hayes Valley place on the 14th."), DRAFT_LT, "hey");
    check("recorded checkin-live-thread: both drafts report the thread, so the cut ends on the thread statement, never presence alone and no question from code", r.r.final === `${cut} ${M.THREAD_LINE}` && !r.r.final.includes("?") && r.r.final !== cut && !/Nothing yet|Still waiting/i.test(r.r.final) && r.r.checks.some((c) => c.name === "world_line"), r.r);
    check("…the redraft is told a thread-only world means a question asking about it, never where it stands", lastRedraft.includes("when their world has only their thread, that item is a question asking them about it, never where it stands"));
    check("…and the world fact itself says to ask, never to say where it stands, not even that nothing has come", lastRedraft.includes("ask them about it as a question, and never say where it stands, not even that nothing has come yet"));
    const asked = await turn(liveW, asJson(true, "Good to hear from you. Any word yet from the Hayes Valley venue?"), DRAFT_LT, "hey");
    check("…a redraft that asks goes out as written", asked.r.outcome === "redrafted" && asked.r.final === "Good to hear from you. Any word yet from the Hayes Valley venue?", asked.r);
    check("the thread line is the approved statement: names nothing, asks nothing", M.THREAD_LINE === "I'm around if there's news on your end." && !M.THREAD_LINE.includes("?") && !/[A-Z][a-z]+ [A-Z]|\d/.test(M.THREAD_LINE.slice(1)) && M.deadAirLine({ checkin: true, world: liveW, draft: DRAFT_LT, cut }) === M.THREAD_LINE && M.deadAirLine({ checkin: false, world: liveW, draft: DRAFT_LT, cut }) === null && M.deadAirLine({ checkin: null, world: liveW, draft: DRAFT_LT, cut }) === null);
  }
  {
    // Only when their thread is all their world has (re-review of #310): with something waiting, the lead's own line; with something
    // scheduled and no line code can prove, nothing from code.
    const withWaiting = daytime(base({ threads: [THREAD] }));
    check("thread line only when their thread is all their world has: with something waiting, the lead's line instead", M.deadAirLine({ checkin: true, world: withWaiting, draft, cut }) === M.worldLine(withWaiting) && M.worldLine(withWaiting) !== M.THREAD_LINE && !M.onlyTheirThread(withWaiting));
    const threadOnly2 = daytime(base({ exchange: QUIET, searching: NOTHING, threads: [THREAD] }));
    const withNext = { ...threadOnly2, next: { kind: "scheduled", name: "Weekly branding check-in", at: "2026-10-16T16:00:00Z", fact: "" } } as any;
    check("…and with something scheduled (no provable line), nothing from code", M.onlyTheirThread(threadOnly2) && !M.onlyTheirThread(withNext) && M.deadAirLine({ checkin: true, world: withNext, draft, cut }) === null);
  }
  // Live re-record of #310, checkin-nothing ("hey", nothing waiting or running): the reply opened with what was or wasn't waiting and
  // running. Royce 2026-10-29: #310's rewrite of the rules every text gets was the cause, so the text rhythm is co-test's again and
  // the new rules ride only on share and feedback turns. A check-in reads none of them.
  {
    const R2 = (await import("../../src/services/textRhythm.js")).MESSAGE_RHYTHM;
    const D2 = await import("../../src/services/connectDots.js");
    const CR = await import("../../src/agent/conversationReply.js");
    check("recorded checkin-nothing: the rhythm every text reads is co-test's (one beat a message, one question per reply), none of the share rules", /One paragraph is one beat/.test(R2) && /One question per reply/.test(R2) && !/Depth follows what they asked|Questions are how you understand them|Don't settle into one shape|A greeting or a check-in gets presence/.test(R2));
    const checkinNote = D2.momentInstruction({ mode: "small_talk", topic: "casual check-in", pushback: null, lesson: null, dots: [] } as any) ?? "";
    check("…a check-in's moment carries neither the sharing nor the feedback guide, and its reply keeps the length line", !checkinNote.includes(D2.SHARING_GUIDE) && !checkinNote.includes(D2.FEEDBACK_GUIDE) && !/overrides the general length/.test(checkinNote) && CR.lengthLineFor("Hey cue, just checking in", "small_talk", false) === "Their message was 5 words and doesn't ask for detail. Reply in one or two sentences.");
    check("…consistent with the check-in rule (presence plus at most one item from their world)", /presence plus at most one item from "Their world right now"/.test(M.CHECKIN_RULE));
    const nothingW = daytime(base({ searching: NOTHING, exchange: QUIET }));
    const recorded = "Hey. Nothing waiting on you, nothing running right now. What's on your mind?";
    const r = await turn(nothingW, null, recorded, "hey");
    // Scope, said plainly: the reply check lets this draft through as drafted (it states no false claim and trips no narration rule),
    // so the guard here is the instructions (the check-in rule's quoted lines, the global rhythm), not code.
    check("…scope: the reply check alone passes the recorded draft as drafted; the guard is the instruction, not code", r.r.outcome === "as_drafted" && r.r.final === recorded, r.r);
  }
  const nothingWorld = await turn(base({ searching: NOTHING, exchange: QUIET }), null);
  check("with genuinely nothing in their world, presence alone stands (no retry, no line added)", nothingWorld.r.final === cut && !nothingWorld.calls.includes("redraft"), nothingWorld);
}

// ------------------------------------------------------------------ 8. rhythm: measured, never used for timing
{
  const L = (iso: string, theirs: boolean) => ({ at: at(iso), theirs });
  const lines = [
    L("2026-10-05T04:10:00Z", true), // Sun Oct 4, 9:10pm PT: opens
    L("2026-10-05T04:11:00Z", false),
    L("2026-10-05T04:30:00Z", true), // same conversation
    L("2026-10-06T16:00:00Z", false), // Co texts first, Tue 9am
    L("2026-10-06T16:45:00Z", true), // their reply after 45 min: an answer, not a conversation they opened
    L("2026-10-07T04:05:00Z", true), // Tue Oct 6, 9:05pm: opens
    L("2026-10-08T04:20:00Z", true), // Wed Oct 7, 9:20pm: opens
  ];
  const r = R.rhythmOf(lines, [at("2026-10-06T16:00:00Z"), at("2026-10-09T16:00:00Z")], ZONE);
  check("a conversation they opened is counted once, by their local hour and weekday", r.started === 3 && r.byHour[21] === 3 && r.byWeekday[6] === 1 && r.byWeekday[1] === 1 && r.byWeekday[2] === 1, r);
  check("their reply to a text Cue sent first counts its wait; a text never answered in the window doesn't", r.proactive === 2 && r.replied === 1 && r.medianReplyMin === 45, r);
  check("busiest hours are said only with enough to say", r.peakHours === "9pm" && R.rhythmOf(lines.slice(0, 3), [], ZONE).peakHours === null);
  // The pin: nothing that times a send reads it yet (Royce: "Measure first ... before changing any send timing").
  const root = new URL("../../src/", import.meta.url).pathname;
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  })(root);
  const readers = files.filter((f) => !f.endsWith("services/engagementRhythm.ts") && /engagementRhythm/.test(fs.readFileSync(f, "utf8")));
  check("no api code reads the rhythm data (no send timing uses it yet)", readers.length === 0, readers.map((f) => path.relative(root, f)));
  const coTest = new URL("../../../co-test/src/", import.meta.url).pathname;
  const coFiles: string[] = [];
  (function walk(d: string) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== "_archive") walk(p);
      else if (p.endsWith(".ts")) coFiles.push(p);
    }
  })(coTest);
  const coReaders = coFiles.filter((f) => /engagementRhythm/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(coTest, f));
  check("on co-test only the team's read-only view reads it", coReaders.join(",") === "routes/sweeps.ts", coReaders);
  const rsrc = fs.readFileSync(path.join(root, "services/engagementRhythm.ts"), "utf8");
  check("the rhythm read writes nothing and logs no decision", !/\b(INSERT|UPDATE|DELETE)\b/.test(rsrc) && !/recordDecision/.test(rsrc));
  check("the rhythm read selects timestamps and who sent each line, never what was said", !/SELECT[^`]*\bcontent\s*(,|FROM)/.test(rsrc));
}

// ---------------------------------------------------------------- 2026-10-17: two holes the live model found (golden 28 and 30)
{
  // 28: "Nothing on my end right now, how's the week treating you?" passed as a question; its statement is still said.
  check("a statement joined to a question by a comma is still checked for machinery", !!SP.narratesInternalState("Hey, good to hear from you. Nothing on my end right now, how's the week treating you?") && SP.statementBeforeQuestion("Nothing on my end right now, how's the week treating you?") === "Nothing on my end right now");
  check("... while a real question still passes, and so does a warm statement before one", SP.narratesInternalState("Hey, good to hear from you. Anything on your mind, or just saying hi?") === null && SP.narratesInternalState("Good to hear from you, how's the week going?") === null && SP.narratesInternalState("Is anything stuck on my end?") === null);
  // 30: "Nothing yet from the venue." named the thread only by a common noun, so the thread read never saw it.
  const world: any = { thread: { kind: "thread", name: "Waiting to hear back from the Hayes Valley venue about the Nov 14 dinner", fact: "x" } };
  check("a report of their thread in common words ('Nothing yet from the venue.') goes to the thread read", M.threadCandidates(world, "Good to hear from you. Nothing yet from the venue.").length === 1 && M.threadCandidates(world, "Still waiting on the dinner place, I'd guess.").length === 1);
  check("... a common word without where-it-stands words doesn't (advice costs no read), and a question never does", M.threadCandidates(world, "For the dinner, smart casual is right.").length === 0 && M.threadCandidates(world, "Any word from the venue yet?").length === 0 && M.threadCandidates(world, "Good to hear from you.").length === 0);
  check("... and a distinctive name still goes to the read, as before", M.threadCandidates(world, "Still nothing back from the Hayes Valley place.").length === 1);
  // Review of the fix: real questions are never split, an admitted sentence stays admitted, and waiting words name no thread.
  check("an either-or or inverted question is one question, never flagged", ["Working on anything fun, or just resting?", "Are you still looking, or did you find one?", "Is that still in progress, or did it wrap?", "Did you hit a snag, or is it moving?", "Totally fair, want me to look?", "Good call, how did it go?", "Did Maya, the designer, reply?"].every((q) => SP.narratesInternalState(q) === null), ["Working on anything fun, or just resting?", "Are you still looking, or did you find one?", "Is that still in progress, or did it wrap?", "Did you hit a snag, or is it moving?"].map((q) => [q, SP.narratesInternalState(q)]));
  check("a statement that only sounds casual is still checked ('Still digging on my end, any thoughts?')", !!SP.narratesInternalState("Still digging on my end, any thoughts?") && !!SP.narratesInternalState("Hey, nothing on my end right now, how's the week treating you?"));
  check("an admitted sentence is admitted whole, comma-joined question included", SP.narratesInternalState("I couldn't confirm the time on my end, want me to call them?", { allow: (x) => x === "I couldn't confirm the time on my end, want me to call them?" }) === null);
  check("waiting words alone name no thread ('Still waiting on the gallery to confirm.')", M.threadCandidates(world, "Still waiting on the gallery to confirm.").length === 0 && M.threadCandidates(world, "Still waiting to hear on the Sequin deck, I'll send it tonight.").length === 0);
  check("more ways a thread is reported in common words go to the read", ["Nothing from the venue yet.", "No update from the venue.", "Not yet on the dinner, they said Friday."].every((x) => M.threadCandidates(world, x).length === 1), ["Nothing from the venue yet.", "No update from the venue.", "Not yet on the dinner, they said Friday."].map((x) => [x, M.threadCandidates(world, x).length]));
}

console.log(`checkin rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
