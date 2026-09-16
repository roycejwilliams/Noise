// Model-free checks for the Layer 3 gate's deterministic rules. Runs in a
// second, no API calls: npx tsx evals/reply/codeChecks.ts
import { nearestPlace, parseDiscoverPlaces } from "../../src/services/lumaDiscovery.js";
import { DateTime } from "luxon";
import { isBrowseAsk, parseAskWindow, withinWindow } from "../../src/services/askWindow.js";
import { asksForContactCard } from "../../src/services/conversationClose.js";
import { renderMatchLead } from "../../src/services/messageFormat.js";
import { closingReaction } from "../../src/services/conversationClose.js";
import "dotenv/config";
import { addFact, baseReplyFacts, codeChecks } from "../../src/harness/replyGrounding.js";

const rf = baseReplyFacts();
addFact(rf, "scheduled", "A call is scheduled for Tuesday, September 8 at 2:00 PM (America/Los_Angeles).");
addFact(rf, "known", 'Link for "Mixer": https://lu.ma/abc123');
const src = { message: "hey", recentConversation: "Co replied: https://lu.ma/abc123" };

const cases: [string, string | null, string][] = [
  // [draft, expected failing check or null, label]
  ["I'll call you Tuesday at 2pm.", null, "scheduled time matches"],
  ["I'll call you Tuesday at 3pm.", "time_on_file", "wrong time"],
  ["Here's the link again: https://lu.ma/abc123", null, "link on file"],
  ["Here you go: https://lu.ma/zzz999", "link_on_file", "invented link"],
  ["Reach me at (650) 667-0798.", "phone_on_file", "invented phone"],
  ["Calling you now.", "no_call_placed_claim", "calling now"],
  ["I'm still ringing you now too.", "no_call_placed_claim", "ringing"],
  ["Want me to call you right now?", null, "offering a call is fine"],
  ["This is text, I can't actually call.", "no_capability_denial", "capability denial"],
  ["I'll make sure we don't call you before 5.", null, "not a denial"],
  ["I'll let you know as soon as I hear back.", "no_followup_promise", "follow-up promise"],
  ["Waiting to hear back, will let you know.", "no_followup_promise", "follow-up promise without I"],
  ["I can keep an eye out for one.", "no_followup_promise", "keep an eye out"],
  ["Let me know if anything changes.", null, "their follow-up, not Co's"],
  ["Will do.", null, "bare will do"],
  ["If a good one turns up in Oakland I'll send it your way.", "no_followup_promise", "send it your way"],
  ["I'll pass it along if I hear anything.", "no_followup_promise", "pass it along"],
  ["Send it my way whenever.", null, "their send, not Co's"],
  ["Will do. If a good Oakland running group turns up, I'll text you.", "no_followup_promise", "conditional promise first"],
  ["When you get there, I'll text you the address?", "no_followup_promise", "when-clause promise"],
  ["If you want, I can look now.", null, "offer to act now, not later"],
  // From Royce's 2026-09-15 thread: no open search behind these.
  ["I'll keep watching for one that fits a Series A team and text you the second something real shows up.", "no_followup_promise", "keep watching, no open ask"],
  ["Got it. I'll keep my eyes open for people worth putting you in front of.", "no_followup_promise", "keep my eyes open, no open ask"],
  ["No pressure if the timing doesn't work, want me to keep an eye out for the next one?", null, "offer (saveAsk makes a yes real)"],
  ["On it, I'll ask Devon and let you know what he says.", "no_followup_promise", "promise after another verb"],
  ["I'll dig into it and get back to you.", "no_followup_promise", "dig in and get back"],
];

// With an open ask the daily search really runs: keeping looking is true,
// a timing commitment still isn't.
const rfOngoing = baseReplyFacts();
addFact(rfOngoing, "ongoing", 'Co\'s daily search is looking for: "friends to hang out with in SF". If something real fits, Co may text them about it (at most one text a day).');
const ongoingCases: [string, string | null, string][] = [
  ["Nothing real yet, but I'll keep looking and text you if something fits.", null, "keep looking with open ask"],
  ["I'll keep an eye out for people worth meeting.", null, "keep an eye out with open ask"],
  ["I'll keep looking and text you the second something shows up.", "no_followup_promise", "timing commitment even with open ask"],
  ["I'll keep looking and get back to you tomorrow.", "no_followup_promise", "tomorrow commitment"],
];

// When a thread is over: react instead of replying (services/conversationClose.ts).
const closingCases: [string, string | null][] = [
  ["Cool", "like"],
  ["cool thanks!", "like"],
  ["Nice thanks \u{1F64F}\u{1F3FE}", "like"],
  ["\u{1F44D}", "like"],
  ["ok cool thanks so much", "like"],
  ["got it", "like"],
  ["sounds good", "like"],
  ["perfect", "love"],
  ["lol", "laugh"],
  ["haha amazing", null],
  ["Cool, can you send it again?", null],
  ["thanks, what time does it start", null],
  ["Which one?", null],
  ["cool i'll check it out and let you know what i think", null],
  ["Yeah", null],
  ["ok call me now", null],
  ["Tell me more", null],
  ["no", null],
];

// How several real things arrive (services/messageFormat.ts): a one-line
// heads-up, then each item followed by its own link.
const formatCases: [boolean, string][] = [
  [renderMatchLead(2) === "Two that fit, sending both now.", "two reads naturally"],
  [renderMatchLead(3) === "Three that fit, sending them now.", "three reads naturally"],
  [!renderMatchLead(2).includes("http"), "the lead-in never carries a link"],
  [!renderMatchLead(2).includes("\u2022"), "the lead-in is not a bulleted list"],
];

// Time frames someone names in an ask (services/askWindow.ts). Reference
// "now" is Tue 2026-09-15 18:00 local.
const now = DateTime.fromISO("2026-09-15T18:00:00", { zone: "America/Los_Angeles" });
const w = (text: string) => parseAskWindow(text, now);
const windowCases: [boolean, string][] = [
  [w("anything this weekend?")?.label === "this weekend", "this weekend"],
  [w("what's on this weekend")?.start.toISODate() === "2026-09-19", "weekend starts Saturday"],
  [w("what's on this weekend")?.end.toISODate() === "2026-09-20", "weekend ends Sunday"],
  [w("anything tonight")?.label === "tonight", "tonight"],
  [w("what about tomorrow")?.end.toISODate() === "2026-09-16", "tomorrow"],
  [w("free next tuesday?")?.start.toISODate() === "2026-09-22", "next tuesday"],
  [w("anything next week")?.label === "next week", "next week"],
  [w("anything in the next 10 days")?.end.toISODate() === "2026-09-25", "next 10 days"],
  [w("anything tech happening Thursday?")?.start.toISODate() === "2026-09-17", "a bare weekday is the coming one"],
  [w("anything thursday night")?.end.toISODate() === "2026-09-17", "thursday night stays on thursday"],
  [w("anything happening tuesday")?.start.toISODate() === "2026-09-15", "a bare weekday that is today means today"],
  [w("anything next thursday")?.start.toISODate() === "2026-09-17", "next thursday is the coming one, same as before"],
  [w("find me climate founders") === null, "no time frame means no window"],
  [withinWindow("2026-09-19T19:00:00-07:00", w("this weekend")!), "saturday evening is in the weekend window"],
  [!withinWindow("2026-09-23T19:00:00-07:00", w("this weekend")!), "next wednesday is not"],
  [isBrowseAsk("What's been surfacing on Luma this weekend?"), "luma browse ask"],
  [isBrowseAsk("anything coming up this week?"), "generic browse ask"],
  [!isBrowseAsk("any climate events this weekend?"), "a subject means a normal search"],
  [!isBrowseAsk("find me a designer"), "not a browse ask"],
  [isBrowseAsk("what's happening thursday night?"), "a weekday alone is still a browse ask"],
  [!isBrowseAsk("anything tech happening thursday?"), "tech is a subject"],
  [asksForContactCard("can you send your contact card"), "asks for the card"],
  [asksForContactCard("what's your number?"), "asks for the number"],
  [!asksForContactCard("You send it over"), "sending a link is not a card request"],
  [!asksForContactCard("send me both accelerator links again"), "links are not a card request"],
];

// Mapping wherever someone says they are to Luma's own city list
// (services/lumaDiscovery.ts), so no city list lives in our code.
const catalog = [
  { apiId: "discplace-sf", name: "San Francisco", slug: "sf", lat: 37.7749, lng: -122.4194 },
  { apiId: "discplace-nyc", name: "New York", slug: "nyc", lat: 40.7128, lng: -74.006 },
  { apiId: "discplace-la", name: "Los Angeles", slug: "la", lat: 34.0522, lng: -118.2437 },
];
const placeCases: [boolean, string][] = [
  [nearestPlace(catalog, "San Francisco", null)?.apiId === "discplace-sf", "exact name needs no coordinates"],
  [nearestPlace(catalog, "sf", null)?.apiId === "discplace-sf", "slug matches"],
  [nearestPlace(catalog, "Oakland", { lat: 37.8044, lng: -122.2712 })?.apiId === "discplace-sf", "Oakland maps to San Francisco"],
  [nearestPlace(catalog, "Brooklyn", { lat: 40.6782, lng: -73.9442 })?.apiId === "discplace-nyc", "Brooklyn maps to New York"],
  [nearestPlace(catalog, "Boise", { lat: 43.615, lng: -116.2023 }) === null, "a city with nothing within 75 miles maps to nothing"],
  [nearestPlace(catalog, "Nowhere", null) === null, "no coordinates and no name match means nothing"],
  [nearestPlace([], "San Francisco", { lat: 37.7749, lng: -122.4194 }) === null, "an empty catalog maps to nothing"],
  [parseDiscoverPlaces("<html>no next data</html>").length === 0, "a page without data parses to nothing"],
];

let failed = 0;
for (const [ok, label] of placeCases) {
  if (!ok) {
    failed++;
    console.log(`FAIL place: ${label}`);
  }
}

for (const [ok, label] of windowCases) {
  if (!ok) {
    failed++;
    console.log(`FAIL window: ${label}`);
  }
}

for (const [ok, label] of formatCases) {
  if (!ok) {
    failed++;
    console.log(`FAIL format: ${label}`);
  }
}

for (const [message, expected] of closingCases) {
  const got = closingReaction(message);
  if (got !== expected) {
    failed++;
    console.log(`FAIL closing "${message}" -> ${got ?? "(reply)"} , expected ${expected ?? "(reply)"}`);
  }
}

for (const [draft, expected, label] of cases) {
  const failing = codeChecks(draft, rf, src).filter((c) => !c.pass).map((c) => c.name);
  const ok = expected ? failing.includes(expected) : failing.length === 0;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}: "${draft}" -> ${failing.join(", ") || "(none)"}`);
  }
}
for (const [draft, expected, label] of ongoingCases) {
  const failing = codeChecks(draft, rfOngoing, src).filter((c) => !c.pass).map((c) => c.name);
  const ok = expected ? failing.includes(expected) : failing.length === 0;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}: "${draft}" -> ${failing.join(", ") || "(none)"}`);
  }
}
const total = cases.length + ongoingCases.length + closingCases.length + formatCases.length + windowCases.length + placeCases.length;
console.log(`codeChecks: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
