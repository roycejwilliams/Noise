// Model-free checks for the Layer 3 gate's deterministic rules. Runs in a
// second, no API calls: npx tsx evals/reply/codeChecks.ts
import { rewriteKeepsAsk, shouldCacheSearch, xPostFitsWindow } from "../../src/services/searchRules.js";
import { localDate, orderForOffering } from "../../src/services/eventOrder.js";
import { capitalizeSentences, looksLikeMetaReply } from "../../src/services/textStyle.js";
import { nearestPlace, parseDiscoverPlaces } from "../../src/services/lumaDiscovery.js";
import { DateTime } from "luxon";
import { isBrowseAsk, parseAskWindow, withinWindow } from "../../src/services/askWindow.js";
import { asksForContactCard } from "../../src/services/conversationClose.js";
import { renderMatchLead } from "../../src/services/messageFormat.js";
import { closingReaction } from "../../src/services/conversationClose.js";
import "dotenv/config";
import { addFact, baseReplyFacts, codeChecks, predictionMatch } from "../../src/harness/replyGrounding.js";

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
  [w("anything Oct 5 - Oct 14th?")?.start.toISODate() === "2026-10-05", "explicit range start"],
  [w("anything Oct 5 - Oct 14th?")?.end.toISODate() === "2026-10-14", "explicit range end"],
  [w("events october 5 to 14")?.end.toISODate() === "2026-10-14", "second month can be left off"],
  [w("anything between Oct 5 and Oct 14")?.start.toISODate() === "2026-10-05", "between x and y"],
  [w("what's on Oct 9")?.end.toISODate() === "2026-10-09", "a single date"],
  [w("anything sept 3")?.start === undefined, "a date already past this year means next year, which is past the 90-day limit"],
  [w("anything dec 10 - jan 2")?.end.toISODate() === "2026-12-14", "a range across new year is cut at the limit"],
  [!withinWindow("2026-09-16T18:00:00-07:00", w("anything thursday")!), "a wednesday evening event is not in a thursday window"],
  [isBrowseAsk("what's on Oct 5 - Oct 14th?"), "dates alone are still a browse ask"],
  [w("anything march 1 - march 5") === null, "a range entirely past the 90-day limit is no window"],
  [w("anything oct 5 - dec 30")?.end.toISODate() === "2026-12-14", "a range reaching past the limit is cut at 90 days"],
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

// Onboarding lines go out in sentence case (otpActions.ts varied): these two
// went out lowercase on 2026-09-16.
const onboardingCaseCases: [boolean, string][] = [
  [capitalizeSentences("hey, good to have you here.") === "Hey, good to have you here.", "welcome line"],
  [capitalizeSentences("what's your full name and email? want to get you set up.") === "What's your full name and email? Want to get you set up.", "intake ask"],
];

// cleanCoMessage (services/sendblue.ts) runs this on every send; tested
// directly because importing the Sendblue client needs API keys.
onboardingCaseCases.push(
  [capitalizeSentences("got it, keeping it to text. i'll be in touch") === "Got it, keeping it to text. I'll be in touch", "every sentence capitalized"],
  [capitalizeSentences("https://lu.ma/4nkiwp04") === "https://lu.ma/4nkiwp04", "a bare link is left alone"],
  [capitalizeSentences("hey, did you end up meeting anyone? curious what stood out") === "Hey, did you end up meeting anyone? Curious what stood out", "after a question mark"],
);

// A drafted line that answers its instruction instead of the person never
// goes out (2026-09-16 onboarding: "I'm ready to be Co. Send me what you'd
// like me to say, and I'll write a single message.").
onboardingCaseCases.push(
  [looksLikeMetaReply("I'm ready to be Co. Send me what you'd like me to say, and I'll write a single message."), "the onboarding leak is caught"],
  [looksLikeMetaReply("Send me what you'd like me to say."), "asking for what to say is caught"],
  [!looksLikeMetaReply("Save my contact so we can keep talking."), "the real line passes"],
  [!looksLikeMetaReply("Would you like me to look for more founder events this week?"), "a normal offer passes"],
  [!looksLikeMetaReply("You and your co-founder should both come."), "co-founder is not being Co"],
  [!looksLikeMetaReply("I'll text you if something real turns up."), "a normal promise passes"],
  [capitalizeSentences("what's your full name and email so i can get started?") === "What's your full name and email so I can get started?", "a lone i is capitalized"],
  [capitalizeSentences("i'm in. i'll text you") === "I'm in. I'll text you", "i'm and i'll are capitalized"],
  [capitalizeSentences("hit the wifi") === "Hit the wifi", "words containing i are left alone"],
);

// Open events are offered before sold-out ones, then by score
// (services/eventOrder.ts, 2026-09-16: 14 of 40 SF events were sold out).
{
  const ev = (name: string, similarity: number, soldOut: boolean | null) => ({ name, similarity, details: soldOut === null ? undefined : ({ soldOut } as any) });
  const order = orderForOffering([ev("sold out best", 0.5, true), ev("open second", 0.4, false), ev("no details", 0.45, null), ev("open low", 0.31, false)]).map((e) => e.name);
  onboardingCaseCases.push(
    [order[0] === "no details" && order[1] === "open second" && order[2] === "open low" && order[3] === "sold out best", `open before sold out, then score (got ${order.join(", ")})`],
  );
}

// Search rules (services/searchRules.ts), 2026-09-16.
{
  const now916 = DateTime.fromISO("2026-09-16T18:00:00", { zone: "America/Los_Angeles" });
  const keeps = (o: string, r: string) => rewriteKeepsAsk(o, r, now916).ok;
  const weekend = { start: "2026-09-19T00:00:00-07:00", end: "2026-09-20T23:59:59-07:00" };
  onboardingCaseCases.push(
    [!shouldCacheSearch([]), "an empty search result is not cached"],
    [shouldCacheSearch([{ name: "x" }]), "a search with a result is cached"],
    [keeps("Can you help me find a founder or builder meetup this weekend?", "Find a founder or builder meetup this weekend"), "rewrite that only drops filler is kept"],
    [!keeps("That sounds interesting maybe you can help me find that founder/builder meetup this weekend", "a weekend founder/builder meetup at a casual cafe setting"), "rewrite that adds Co's invented words is refused"],
    [!keeps("Any AI meetups in SF on Thursday?", "AI meetups on Thursday"), "rewrite that drops the place is refused"],
    [!keeps("Any AI meetups in SF on Thursday?", "AI meetups in SF this weekend"), "rewrite that changes the time frame is refused"],
    [!keeps("looking for climate tech founders near Oakland", "climate tech founders"), "rewrite that drops a named city is refused"],
    [keeps("Any founder events Oct 5 - Oct 14th?", "founder events from Oct 5 to Oct 14"), "rewrite that keeps explicit dates is kept"],
    [keeps("What's going on this weekend?", "founder and investor events this weekend"), "no topic of their own: borrowing one is allowed"],
    [keeps("I'd love to find a pickup basketball group", "pickup basketball group"), "their own topic survives"],
    [xPostFitsWindow({ start: "2026-09-19" }, weekend).ok, "an X post dated inside the window passes"],
    [xPostFitsWindow({ start: "2026-09-15", end: "2026-09-21" }, weekend).ok, "an X post whose range overlaps the window passes"],
    [!xPostFitsWindow({ start: "2026-10-05", end: "2026-10-11" }, weekend).ok, "an X post dated outside the window is kept out"],
    [!xPostFitsWindow(null, weekend).ok, "an X post with no date is kept out of a time-frame ask"],
    [xPostFitsWindow(null, null).ok, "without a time frame, a dateless X post is fine"],
    [localDate("2026-09-18T02:00:00.000Z", "America/Los_Angeles") === "2026-09-17", "a 7pm Thursday SF event is Thursday, not Friday"],
    [localDate("2026-09-18T02:00:00.000Z", null) === "2026-09-18", "without a zone, the UTC date is kept"],
  );
}

// Predictions Co can't back (harness/replyGrounding.ts predictionMatch).
onboardingCaseCases.push(
  [!!predictionMatch("Honest read: I don't think a separate one is going to materialize by Saturday."), "the Saturday forecast is caught"],
  [!!predictionMatch("It'll probably sell out, honestly."), "a sell-out forecast is caught"],
  [!!predictionMatch("Nothing else is going to come up this week."), "a nothing-else-coming forecast is caught"],
  [!!predictionMatch("That one isn't going to happen before Friday."), "a won't-happen forecast is caught"],
  [!predictionMatch("I'll keep looking and text you if something real turns up."), "keeping an eye out is not a forecast"],
  [!predictionMatch("I don't think I have the link for that one."), "not having something is not a forecast"],
  [!predictionMatch("Only 9 spots left, so worth registering soon."), "stating spots left is not a forecast"],
  [!predictionMatch("Are you going to Corgi on Saturday?"), "asking about their plans is not a forecast"],
);

let failed = 0;
for (const [ok, label] of onboardingCaseCases) {
  if (!ok) {
    failed++;
    console.log(`FAIL onboarding capitalization: ${label}`);
  }
}
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
const total = cases.length + ongoingCases.length + closingCases.length + formatCases.length + windowCases.length + placeCases.length + onboardingCaseCases.length;
console.log(`codeChecks: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
