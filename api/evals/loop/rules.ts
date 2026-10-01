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
for (const t of ["searchEvents", "webSearch", "searchPosts", "readPage", "shareFinds", "draftEmail", "updateNotes"]) {
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
check("code saves the basics on every search (Co forgetting the notes)", (lt.match(/await remember\(\{/g) ?? []).length >= 3);
check("web queries run in parallel and the budget counts queries, not calls", /queries: z\.array\(z\.string\(\)\)\.min\(1\)\.max\(3\)/.test(lt) && /Promise\.all\(run\.map\(\(q\) => taskWebSearch/.test(lt) && /loop\.webQueries \+= run\.length/.test(lt));
check("each search checks its results' pages at the same time", /const pages = await Promise\.all\(raws\.map\(\(raw\) => pickPage/.test(src("services/taskWeb.ts")));
check("tools stop at the time budget and say to answer with what's there", /Out of time for this turn: share what you have and answer them/.test(lt) && L.LOOP_BUDGET.seconds === 75);
check("the reply's step limit is the loop's budget", /stepCountIs\(LOOP_BUDGET\.steps\)/.test(src("agent/conversationReply.ts")));
check("the first search can send a short 'on it' text, once", /if \(!line\?\.trim\(\) \|\| loop\.holdSent \|\| state\.sent\) return;/.test(lt));
const sb = src("routes/sendblue.ts");
check("the reply gets the guide when they want something found, and the working notes", /if \(decision\.wantsRecommendation && hasText\) addInstruction\(replyFacts, LOOP_GUIDE\);/.test(sb) && /if \(hasText\) \{\s*const notes = describeNotes/.test(sb));

// Notes.
check("notes read back as one line", LT.describeNotes({ kind: "venue", what: "bookable space", city: "San Francisco", area: "NoPa", when: "Oct 10", budget: 1000, headcount: 120, vibe: null, summary: "", queries: [], sites: [], ask: null, picked: "Wave" } as any) === "Your working notes for what you're finding for them (from earlier texts): looking for: bookable space. where: NoPa, San Francisco. when: Oct 10. headcount: 120. budget: under $1000. they picked: Wave.");

console.log(`\nloop rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
