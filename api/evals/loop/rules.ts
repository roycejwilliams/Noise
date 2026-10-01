// Co's own loop (agent/loop.ts, agent/loopTools.ts): the tools Co
// gets, and the fact guards. Model-free.
//   npx tsx evals/loop/rules.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const L = await import("../../src/agent/loop.js");
const LT = await import("../../src/agent/loopTools.js");
const C = await import("../../src/services/capabilities.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};
const src = (f: string) => fs.readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

// Replies find things only through the loop (2026-10-01: the old path is gone).
const ct = src("agent/conversationTools.ts");
check("the loop's tools are always there, and searchNow is gone", /Object\.assign\(tools, loopTools\(ctx, state, newLoopState\(\), notDone\)\);/.test(ct) && !/searchNow: tool\(/.test(ct));
check("no switch left behind", !/CO_LOOP|loopOn|loopMode/.test(src("agent/loop.ts") + src("routes/sendblue.ts") + ct));
check("the capability sheet describes the loop's tools", C.capabilitySheet().some((l) => /look up events itself/.test(l)) && !C.capabilitySheet().some((l) => /search right now for events/.test(l)));

// Lab guidance in the tool descriptions: the why, no over-broad triggers.
for (const t of ["searchEvents", "webSearch", "searchPosts", "readPage", "shareFinds", "draftEmail", "updateNotes", "updateLoop"]) {
  const use = C.toolUse(t);
  check(`${t}: says why, no "whenever/however/if in doubt/MUST"`, /\b(because|so (they|the|you|what)|so that)\b/i.test(use) && !/\bwhenever\b|however it'?s worded|if in doubt|\bMUST\b|\bCRITICAL\b/.test(use), use.slice(0, 160));
}

// Fact guards.
check("a caption can't carry a number its facts don't have", LT.captionProblems("Holds 200 and costs $500.", "capacity: 120 standing; price: $180/hr", "").length === 2);
check("a caption from its facts passes", LT.captionProblems("Holds 120 standing, $180/hr, Lower Haight.", "Wave. capacity: 120 standing; price: $180/hr; neighborhood: Lower Haight", "").length === 0);
check("a caption can't claim availability its page doesn't state", LT.captionProblems("It's available on Oct 10.", "capacity: 120", "Oct 10").some((p) => /isn't something its page says/.test(p)));
check("the email is a tap-to-send link, nothing sent", LT.mailtoLink("events@wave.sf", "Oct 10?", "Hi, is Oct 10 open?") === "mailto:events@wave.sf?subject=Oct%2010%3F&body=Hi%2C%20is%20Oct%2010%20open%3F");
const lt = src("agent/loopTools.ts");
check("a marketplace listing gets a draft without an address, to paste into its contact form", /if \(!to\?\.trim\(\)\) \{/.test(lt) && /the listing's contact form/.test(lt));
check("the draft goes out as its own text (and the tap-to-send link), so they can always copy it", /const draftText = /.test(lt) && /await say\(draftText, /.test(lt) && /await say\(link, /.test(lt));
check("an email address must have been seen (page, their texts, notes)", /that address wasn't on a page read this turn, in their texts, or in the notes/.test(lt));
check("shareFinds only sends links the loop found or the notes hold", /not something you found this turn or have in your notes/.test(lt));
check("sold out, over or already sent can't be shared (the gate's own reasons)", /if \(f\.blocked\)/.test(lt) && /gateMatches\(raw, \{ userId: opts\.userId \?\? null, searchCity: city, checkRepeat: true/.test(src("services/tieredRecommendation.ts")));
check("event search covers Co's events, the public feed, and openings the daily search already found", /alreadyFoundOpenings\(ctx\.userId\)/.test(lt) && /openingsFoundEarlier: openings/.test(lt) && /cachedCalendarEvents\(\)/.test(src("services/tieredRecommendation.ts").split("for Co's own loop")[1] ?? ""));
check("Tier 3 in the loop: X posts through the shared daily X budget, plus the web", /reserveXSearch\(ctx\.userId, "request", q\)/.test(lt) && /searchRecentPosts\(q, 10\)/.test(lt) && C.toolUse("searchPosts").includes("shared daily budget"));
check("a sold-out event can't be shared (its own page says so)", /details\?\.soldOut === true \? "sold out" : null/.test(lt));
check("a spent web search budget is said plainly, never as 'nothing found'", /Web search is used up for today\. Tell them plainly/.test(lt));
check("no model gate between the feed and Co", !/isGenuinelyRelevant|explainFit|relevanceGate/.test(src("services/tieredRecommendation.ts").split("for Co's own loop")[1] ?? "x"));
check("every search leaves a receipt, empty or not, so 'nothing turned up' is backed", (lt.match(/receipt\(`/g) ?? []).length >= 4);
check("code saves the basics on every search (Co forgetting the notes)", (lt.match(/await remember\(\{/g) ?? []).length >= 3);
check("web queries run in parallel and the budget counts queries, not calls", /queries: z\.array\(z\.string\(\)\)\.min\(1\)\.max\(3\)/.test(lt) && /Promise\.all\(run\.map\(\(q\) => taskWebSearch/.test(lt) && /loop\.webQueries \+= run\.length/.test(lt));
check("each search checks its results' pages at the same time", /const pages = await Promise\.all\(raws\.map\(\(raw\) => pickPage/.test(src("services/taskWeb.ts")));
check("tools stop at the time budget and say to answer with what's there", /Out of time for this turn: share what you have and answer them/.test(lt) && L.LOOP_BUDGET.seconds === 75);
check("the reply's step limit is the loop's budget", /stepCountIs\(LOOP_BUDGET\.steps\)/.test(src("agent/conversationReply.ts")));
check("the first search can send a short 'on it' text, once", /if \(!line\?\.trim\(\) \|\| loop\.holdSent \|\| state\.sent\) return;/.test(lt));
const sb = src("routes/sendblue.ts");
check("the reply gets the guide when they want something found, and the working notes", /if \(decision\.wantsRecommendation && hasText\) addInstruction\(replyFacts, LOOP_GUIDE\);/.test(sb) && /loadBrief\(user\.id\)\.then\(describeNotes\)/.test(sb) && /if \(timeline\) addFact\(replyFacts, "known", timeline\.fact\)/.test(sb) && /if \(notes\) addFact\(replyFacts, "ongoing", notes\)/.test(sb));

// Tasks, voice and the sweep find things with the same tools (2026-10-01).
{
  const tt = src("services/taskTurn.ts");
  check("Co's tasks search with the loop's event candidates and the sweep's openings, not the old pipeline", /eventCandidates\(what, person\.city/.test(tt) && /alreadyFoundOpenings\(userId\)/.test(tt) && !/searchWithTimeCap|generateRecommendation/.test(tt));
  const co = src("routes/co.ts");
  check("a call's lookup uses no model: raw candidates and Co's notes", /await voiceFinds\(userId\)/.test(co) && !/generateRecommendation/.test(co) && !/generateText/.test(src("services/voiceFinds.ts")));
  const V = await import("../../src/services/voiceFinds.js");
  check("on a call, Co mentions only what fits and offers to text the link", /mention only the one or two that genuinely fit/.test(V.VOICE_NOTE) && /offer to text them the link/.test(V.VOICE_NOTE));
  const sw = src("services/eventSurfacingSweep.ts");
  const sf = src("services/sweepFind.ts");
  check("the sweep finds with Co's own loop, not the old search brief and tiers", /await sweepFind\(/.test(sw) && !/getTieredRecommendation|buildSearchBrief/.test(sw));
  check("the sweep queues Co's own judgment, with no second fit read", /if \(!item\.match\.whyItFits\) \{/.test(sw) && /const match = await enrichMatch\(item\.match\);/.test(sw));
  check("the sweep's tools: events, web (checked by the second reader), X posts, pages, keep", ["searchEvents: tool(", "webSearch: tool(", "searchPosts: tool(", "readPage: tool(", "keep: tool("].every((t) => sf.includes(t)) && /checkVerified\(/.test(sf));
  check("the sweep uses the sweep's share of the web and X budgets", /source: "sweep"/.test(sf) && /reserveXSearch\(c\.userId, "sweep", query\)/.test(sf));
  check("what the sweep keeps still goes through the fact gate", /gateMatches\(kept, \{ userId: c\.userId/.test(sf));
  const SF = await import("../../src/services/sweepFind.js");
  const p = SF.sweepPrompt({ userId: "u", firstName: "Jordan", askText: "AI founder dinners", city: "San Francisco" }, { today: "2026-10-01", picture: "", feeling: "stressed", shown: ["Rooftop evening"] });
  check("the sweep's brief: their ask, what was already sent, feelings never decide", p.includes("AI founder dinners") && p.includes("Rooftop evening") && p.includes("never whether they hear about something") && p.includes("Search only for this one ask"));
  check("the old pipeline's entry points are gone", !/export async function (generateRecommendation|getTieredRecommendation)/.test(src("services/recommendation.ts") + src("services/tieredRecommendation.ts")) && !/searchWithTimeCap/.test(src("agent/conversationTools.ts")));
}

// Beats, bursts and the timeline (2026-10-01).
{
  const B = await import("../../src/services/beats.js");
  check("each paragraph is its own text, at most three", JSON.stringify(B.toBeats("Got it.\n\nThe loft holds 60.\n\nWant me to ask about price?")) === JSON.stringify(["Got it.", "The loft holds 60.", "Want me to ask about price?"]) && B.toBeats("a\n\nb\n\nc\n\nd").length === 3 && B.toBeats("one line").length === 1);
  check("a text that looks unfinished waits longer for the rest of the burst", B.burstWaitMs("so") === B.BURST_WAIT_UNFINISHED_MS && B.burstWaitMs("I was thinking...") === B.BURST_WAIT_UNFINISHED_MS && B.burstWaitMs("also,") === B.BURST_WAIT_UNFINISHED_MS && B.burstWaitMs("Can you find me a venue for Oct 10?") === B.BURST_WAIT_MS);
  const ct = src("agent/conversationTools.ts");
  check("sendReply sends each beat after the fact check, paced, and logs each", /const beats = ctx\.isVoice \? \[message\] : toBeats\(message\)/.test(ct) && /BEAT_GAP_MS/.test(ct) && /writeMemory\(ctx\.userId, "text_exchange", `Co replied: \$\{cleanCoMessage\(beat\)\}`\)/.test(ct));
  check("the burst window comes from their text", /burstWaitMs\(resolvedContent \?\? ""\)/.test(src("routes/sendblue.ts")));
  const T = await import("../../src/services/timeline.js");
  const { DateTime } = await import("luxon");
  const now = DateTime.fromISO("2026-10-01T01:40:00", { zone: "America/Los_Angeles" });
  const line = T.renderTimeline(now, [
    { at: "2026-10-01T08:00:00-07:00", allDay: false, what: "busy on their calendar" },
    { at: "2026-10-02", allDay: true, what: "the deadline they gave for venue options" },
    { at: "2026-09-29", allDay: true, what: "something already past" },
  ]);
  check("the timeline gives their local time, part of day, and what's ahead in order", line.startsWith("Right now it's 1:40 AM on Thursday, October 1 where they are (late at night).") && /in 6h \(Thu 8:00 AM\): busy on their calendar; tomorrow: the deadline they gave/.test(line) && !/already past/.test(line), line);
  const items = [{ at: "2026-10-01T08:00:00-07:00", allDay: false, what: "busy on their calendar" }];
  check("late at night with something early ahead, Co gets a note; not at noon, not when nothing's soon", /they have something at 8:00 AM \(in 6h: busy on their calendar\)/.test(T.lateNightNote(now, items) ?? "") && T.lateNightNote(now.set({ hour: 12 }), items) === null && T.lateNightNote(now, []) === null);
  check("every text turn gets the timeline", /timelineFor\(user\.id, profile\?\.city \?\? null\)/.test(src("routes/sendblue.ts")));
  check("Co is told to weave it in, never recite it", /Never recite their schedule back as a list/.test(src("services/coVoice.ts")) && /say it once, warmly, and let it go/.test(src("services/coVoice.ts")));
  check("a reaction that says it all can end the turn, only after one went out", /if \(!ctx\.ackSent\) delete \(tools as Record<string, unknown>\)\.leaveItAtReaction/.test(ct));
  check("photos: format from their bytes, HEIC converted, a failed photo retries without it", /readableImage\(Buffer\.from\(await imageRes\.arrayBuffer\(\)\)\)/.test(src("routes/sendblue.ts")) && /heic-convert/.test(src("services/imageRead.ts")) && /agentRun = await runAgent\(false\)/.test(src("agent/conversationReply.ts")));
}

// The three principles (Royce, 2026-10-01): one person model, open loops as
// first-class state, one move per turn.
{
  const O = await import("../../src/services/openLoops.js");
  const P = await import("../../src/services/personModel.js");
  const M = await import("../../src/services/moves.js");
  const loops = O.deriveLoops({
    tasks: [
      { id: 7, goal: "Find a venue for Oct 10", deadline: "2026-10-10", awaitingReply: true, latest: "Asked whether they want Wave or SOMA Loft." },
      { id: 8, goal: "Find a DJ", deadline: null, awaitingReply: false, latest: "Wave's price is unconfirmed." },
    ],
    notes: { what: "bookable space", when: "Oct 10", shortlist: [{ name: "Wave", note: "price unconfirmed" }, { name: "SOMA Loft" }], picked: null, next: "they pick one" },
    asks: [{ askId: "a1", text: "a run club" }],
    offers: [{ key: "event:1", name: "Founders Dinner" }],
  });
  check("a task waiting on them is waiting_on_reply, an unconfirmed price is unconfirmed", loops[0].status === "waiting_on_reply" && loops[0].taskId === 7 && loops[0].dueDate === "2026-10-10" && loops[1].status === "unconfirmed", JSON.stringify(loops.slice(0, 2)));
  check("notes with a choice left to them are decision_needed; asks are open; a sent offer waits on how it landed", loops[2].source === "notes" && loops[2].status === "decision_needed" && /shortlist: Wave, SOMA Loft/.test(loops[2].detail ?? "") && loops[3].status === "open" && loops[4].status === "waiting_on_reply", JSON.stringify(loops.slice(2)));
  check("notes with a pick whose price isn't confirmed are unconfirmed", O.deriveLoops({ tasks: [], notes: { what: "space", when: null, shortlist: [{ name: "Wave", note: "price unconfirmed" }], picked: "Wave", next: null }, asks: [], offers: [] })[0].status === "unconfirmed");
  const said = O.describeLoops(loops.map((l) => ({ ...l })));
  check("the loops read as where each stands, closed ones left out", !!said && /Find a venue for Oct 10: waiting on a reply/.test(said) && /a decision that's theirs/.test(said) && O.describeLoops([{ title: "x", status: "done", detail: null, dueDate: null, source: "task" }]) === null, said ?? "");
  const t0 = new Date("2026-10-01T12:00:00Z");
  const base = { taskId: 7, status: "unconfirmed" as const, changedAt: new Date(t0.getTime() - 60_000) };
  check("a changed loop wakes its task once, at most every 6 hours, and only task-backed open loops", O.shouldWake({ ...base, wokeAt: null }, t0) && !O.shouldWake({ ...base, wokeAt: new Date(t0.getTime() - 30_000) }, t0) && !O.shouldWake({ ...base, wokeAt: new Date(t0.getTime() - 3_600_000) }, t0) && !O.shouldWake({ ...base, taskId: null, wokeAt: null }, t0) && !O.shouldWake({ ...base, status: "done" as any, wokeAt: null }, t0));
  check("every text turn syncs the loops and reads them as ongoing", /o\.describeLoops\(\(await o\.syncOpenLoops\(user\.id\)\)\.rows\)/.test(src("routes/sendblue.ts")) && /if \(loops\) addFact\(replyFacts, "ongoing", loops\)/.test(src("routes/sendblue.ts")));
  check("the 15-minute pass syncs loops before waking tasks", /runLoopSync\(\)[\s\S]{0,200}runDueTasks\(\)/.test(src("jobs/index.ts")));
  check("the open_loops table exists, one row per source", /CREATE TABLE IF NOT EXISTS open_loops[\s\S]*UNIQUE \(user_id, source, source_ref\)/.test(src("db/migrations.ts")));
  check("Co can set a loop's status, and its word wins until the source closes", /updateLoop: tool\(/.test(lt) && /status_by === "co" \? ex\.status : d\.status/.test(src("services/openLoops.ts")));
  const model = P.renderPersonModel({ who: "Work: founder", threads: "- venue hunt (open)", did: ["Sent them Wave"], loops: said });
  check("one person model: who, threads, what Co did, what it carries, in order", /^Who they are:\nWork: founder\n\nWhat's going on in their life[\s\S]*What you've done for them lately:\n- Sent them Wave\n\nWhat you're carrying/.test(model) && P.renderPersonModel({ who: "", threads: "", did: [], loops: null }) === "", model);
  check("the task, the sweep and the call all read the person model", /personModel\(userId/.test(src("services/taskTurn.ts")) && /personModel\(c\.userId/.test(src("services/sweepFind.ts")) && /personModelParts\(userId\)/.test(src("services/callContext.ts")));
  check("moves: a reaction alone is quiet, a search is act, a task is watch, words are reply", M.moveOf({ toolsCalled: ["leaveItAtReaction"], sent: false }) === "quiet" && M.moveOf({ toolsCalled: ["webSearch", "sendReply"], sent: true }) === "act" && M.moveOf({ toolsCalled: ["startTask", "sendReply"], sent: true }) === "watch" && M.moveOf({ toolsCalled: ["sendReply"], sent: true }) === "reply");
  check("Co is told each turn is one move and quiet is a real answer, and every turn logs it", /Quiet is a real answer/.test(M.MOVES_GUIDE) && /\$\{MOVES_GUIDE\}/.test(src("agent/conversationReply.ts")) && /decision: "turn\.move"/.test(src("agent/conversationReply.ts")));
}

// Notes.
check("notes read back as one line", LT.describeNotes({ kind: "venue", what: "bookable space", city: "San Francisco", area: "NoPa", when: "Oct 10", budget: 1000, headcount: 120, vibe: null, summary: "", queries: [], sites: [], ask: null, picked: "Wave" } as any) === "Your working notes for what you're finding for them (from earlier texts): looking for: bookable space. where: NoPa, San Francisco. when: Oct 10. headcount: 120. budget: under $1000. they picked: Wave.");

console.log(`\nloop rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
