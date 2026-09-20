// Model-free checks for profile list hygiene and emotion rendering
// (2026-09-15 call review: 126 goals, complaints about Co stored as
// blockers, "low clarifying" shown in the call prompt).
//   npx tsx evals/profile/lists.ts
import { cityChangeAllowed } from "../../src/services/profileExtraction.js";
import "dotenv/config";
import { isAboutCo, mergeProfileList, nearDuplicate, specificity } from "../../src/services/profileExtraction.js";
import { renderEmotionalContext, summarizeSignals } from "../../src/harness/emotion.js";
import { hasAskText, isOpenAsk, latestAskEntry, stripTextlessIntent } from "../../src/harness/profileWrite.js";
import { getActiveSeekingAsk } from "../../src/services/matching.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label} ${detail}`);
  }
};

const WORDS = ["hiking", "pottery", "chess", "surfing", "investors", "design", "hiring", "fundraising", "climbing", "cooking", "music", "writing", "running", "reading", "travel", "sales", "marketing", "legal", "tennis", "yoga"];
const many = WORDS.map((w, i) => `${w} ${WORDS[(i + 7) % WORDS.length]}`);
check("cap", mergeProfileList(many, [], 12).length === 12);
const merged = mergeProfileList(["meet other cleantech founders", "grow cleantech startup"], ["meet Series A investors and operators", "scale the team past 8"], 12);
check("newest first", merged[0] === "meet Series A investors and operators", JSON.stringify(merged));
check("rewording collapsed", mergeProfileList(["meet other founders in SF"], ["meet other founders"], 12).length === 1);
check("distinct kept", mergeProfileList(["find a designer"], ["meet Series A investors"], 12).length === 2);
// Restatements collapse and the specific wording survives (2026-09-20). The
// real profile below is verbatim what one member's co_profiles.goals held at
// the 12 cap: nine of the twelve reword two things, and "find collaborators
// from Google, Stripe, or Meta" — genuinely extracted from a call — was
// pushed off the end by the crowding.
const REAL_GOALS = [
  "find and attend relevant tech week events",
  "connect with founders, investors, and builders",
  "lock in permits and timing for the Oct 10th street block event",
  "meet VC and founder connections before Oct 10",
  "plan and execute the October 10th event",
  "find VC and founder connections",
  "coordinate logistics with cofounder",
  "planning the October 10th event with cofounder",
  "finding VC and founder connections",
  "locking in permits and venue for the street block event",
  "host a founder event on October 10th",
  "connect with VCs and investors",
];
const FROM_THE_CALL = "find collaborators from Google, Stripe, or Meta";
const realMerge = mergeProfileList(REAL_GOALS, [FROM_THE_CALL], 12);
check("the call's specific goal survives the merge", realMerge.includes(FROM_THE_CALL), JSON.stringify(realMerge));
check("restatements collapse below the cap", realMerge.length < 12, `${realMerge.length} kept`);
check(
  "only one 'VC and founder connections' left",
  realMerge.filter((g) => /vc and founder connections/i.test(g)).length === 1,
  JSON.stringify(realMerge),
);
check("the October 10th event is one goal", realMerge.filter((g) => /october 10th/i.test(g)).length <= 2, JSON.stringify(realMerge));
check("the permits goal isn't stored twice", realMerge.filter((g) => /permits/i.test(g)).length === 1, JSON.stringify(realMerge));
check("nothing distinct was lost", realMerge.some((g) => /coordinate logistics/i.test(g)), JSON.stringify(realMerge));

// The near-duplicate test reads stems, so a reworded goal isn't a new goal.
check("find/finding", nearDuplicate("find VC and founder connections", "finding VC and founder connections"));
check("lock/locking", nearDuplicate("lock in permits and timing for the Oct 10th street block event", "locking in permits and venue for the street block event"));
check("plan/planning", nearDuplicate("plan and execute the October 10th event", "planning the October 10th event with cofounder"));
check("different goals stay different", !nearDuplicate("find a designer", "meet Series A investors"));
check("logistics isn't a VC ask", !nearDuplicate("coordinate logistics with cofounder", "find VC and founder connections"));

// Named things and dates are what make a goal actionable.
check("named companies beat a generic ask", specificity(FROM_THE_CALL) > specificity("find VC and founder connections"));
check("a date beats no date", specificity("host a founder event on October 10th") > specificity("host a founder event"));
check(
  "the sharper wording wins when two mean the same",
  mergeProfileList(["meet other founders in SF"], ["meet other founders"], 12)[0] === "meet other founders in SF",
);

// At the cap, a vague item can't evict a specific one.
const vague = WORDS.slice(0, 12).map((w, i) => `${w} ${WORDS[(i + 3) % WORDS.length]}`);
const capped = mergeProfileList(["ship the Series B deck for Sequoia by March 3"], vague, 12);
check("cap holds", capped.length === 12, `${capped.length}`);
check("a specific goal still gets in at the cap", capped.includes("ship the Series B deck for Sequoia by March 3"), JSON.stringify(capped));

check("Co complaint", isAboutCo("lack of information from Co"));
check("Co's", isAboutCo("Co's links were broken"));
check("co-founder isn't Co", !isAboutCo("finding a technical co-founder"));
check("unrelated", !isAboutCo("raising a Series A"));

// An intent entry with no text is never an open ask (2026-09-20 — one real
// profile carried three of them, written by captureIntent when a call
// produced preferences but no ask, and they were counted as open asks
// everywhere downstream). This is the exact shape found on file: id, wants,
// status, embedding, created_at, availability, concrete_preferences, and no
// text or type at all.
const TEXTLESS = {
  id: "a1",
  wants: ["VC and founder connections"],
  status: "active",
  embedding: null,
  created_at: "2026-09-19T00:00:00.000Z",
  availability: "Weekdays after 3pm, weekends free",
  concrete_preferences: ["small curated crowd", "rooftop mixer"],
};
const REAL_ASK = { id: "a2", text: "Looking for event recommendations during tech week", type: "seeking", status: "active", created_at: "2026-09-19T01:00:00.000Z" };
const OLDER_ASK = { id: "a0", text: "Finding a venue for an October 10th event", type: "seeking", status: "active", created_at: "2026-09-18T00:00:00.000Z" };

check("no text is not an ask", !hasAskText(TEXTLESS));
check("whitespace is not text", !hasAskText({ text: "   ", status: "active" }));
check("a real ask has text", hasAskText(REAL_ASK));
check("a text-less entry is never open", !isOpenAsk(TEXTLESS));
check("an active ask is open", isOpenAsk(REAL_ASK));
check("a resolved ask is not open", !isOpenAsk({ ...REAL_ASK, status: "resolved" }));
check("junk shapes don't crash", !isOpenAsk(null) && !isOpenAsk(undefined) && !isOpenAsk("nope"));

// A text-less entry written after the real ask used to shadow it, because
// every read took the last element of the array.
const POLLUTED = [OLDER_ASK, TEXTLESS, REAL_ASK, { ...TEXTLESS, id: "a3" }];
check("the newest real ask still wins", latestAskEntry(POLLUTED)?.id === "a2", JSON.stringify(latestAskEntry(POLLUTED)?.id));
check("no asks at all reads as none", latestAskEntry([TEXTLESS]) === null);
check("a non-array reads as none", latestAskEntry(null) === null);
check("scoring skips the text-less entries", getActiveSeekingAsk(POLLUTED)?.id === "a2");
check("scoring finds nothing in text-less entries alone", getActiveSeekingAsk([TEXTLESS]) === null);

const cleaned = stripTextlessIntent(POLLUTED);
check("cleanup keeps every real ask", cleaned.length === 2 && cleaned.every((e) => hasAskText(e)), JSON.stringify(cleaned.map((e) => e.id)));
check("cleanup keeps their order", cleaned[0]?.id === "a0" && cleaned[1]?.id === "a2");
check("cleanup is idempotent", JSON.stringify(stripTextlessIntent(cleaned)) === JSON.stringify(cleaned));
check("cleanup leaves a clean profile alone", JSON.stringify(stripTextlessIntent([REAL_ASK])) === JSON.stringify([REAL_ASK]));

const now = new Date("2026-09-15T20:00:00Z");
const low = summarizeSignals([{ source: "text", emotion: "clarifying", intensity: "low", valence: "mixed", about: null, quote: null, at: new Date(now.getTime() - 3600_000) }], now);
check("low read hidden", renderEmotionalContext(low, now) === "", renderEmotionalContext(low, now));
const med = summarizeSignals([{ source: "text", emotion: "frustrated", intensity: "medium", valence: "negative", about: "investor passes", quote: null, at: new Date(now.getTime() - 3600_000) }], now);
check("medium read shown", renderEmotionalContext(med, now).includes("frustrated"));
const lowCall = summarizeSignals([{ source: "call", emotion: "awkwardness", intensity: "low", valence: "negative", about: null, quote: "not really", at: new Date(now.getTime() - 7200_000) }], now);
check("low call moment hidden", !renderEmotionalContext(lowCall, now).includes("awkwardness"));


// Where someone lives only changes when they say so (Royce, 2026-09-16:
// "founding engineer roles in NYC" moved his city off San Francisco).
// cityChangeAllowed reads real Hume-transcript shape ("user: ..." /
// "assistant: ..." lines) now that it only trusts the person's own words —
// see profileExtraction.ts, fixed 2026-09-17.
const cityCases: [boolean, string][] = [
  [!cityChangeAllowed("San Francisco", "NYC", "user: Cool, I'm also looking for founding engineer roles too in the mean time"), "a role preference doesn't move them"],
  [!cityChangeAllowed("San Francisco", "NYC", "user: any accelerators in NYC worth applying to?"), "an accelerator preference doesn't move them"],
  [!cityChangeAllowed("San Francisco", "Miami", "user: are there good events in Miami this weekend?"), "an events question doesn't move them"],
  [cityChangeAllowed("San Francisco", "NYC", "user: I'm in NYC now, moved last week"), "saying they're there moves them"],
  [cityChangeAllowed("San Francisco", "Austin", "user: we're moving to Austin next month"), "moving moves them"],
  [cityChangeAllowed("San Francisco", "Oakland", "user: based in Oakland these days"), "based in moves them"],
  [cityChangeAllowed(null, "San Francisco", "user: any events this weekend?"), "first city on file is kept"],
  [cityChangeAllowed("San Francisco", "san francisco", "user: whatever"), "same city is fine"],
  [!cityChangeAllowed("San Francisco", null, "user: I'm in NYC"), "no new city means no change"],
  // 2026-09-17 fixes below.
  [!cityChangeAllowed("San Francisco", "Austin", "user: I'm in the middle of raising\nassistant: how's that going?"), "'in the middle of' isn't a place"],
  [!cityChangeAllowed("San Francisco", "NYC", "assistant: I'm in your corner, we'll figure it out\nuser: thanks"), "only Co's own line said it, not the person's"],
  [!cityChangeAllowed("San Francisco", "Austin", "user: we moved fast on the offer"), "'moved fast' isn't a move"],
  [!cityChangeAllowed("San Francisco", "Austin", "user: I am heading to a meeting, can we talk later"), "'heading to a meeting' isn't a place"],
  [cityChangeAllowed("San Francisco", "NYC", "user: im in nyc now"), "missing apostrophe still counts"],
  [cityChangeAllowed("San Francisco", "SF", "user: im in sf"), "a lowercase abbreviation still counts"],
  [cityChangeAllowed("San Francisco", "NYC", "user: I’m in NYC these days"), "a curly apostrophe still counts"],
];
for (const [ok, label] of cityCases) {
  check(`city: ${label}`, ok);
}

console.log(`profile lists, intent entries, emotion render, city changes: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
