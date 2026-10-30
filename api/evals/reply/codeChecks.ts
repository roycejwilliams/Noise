// Model-free checks for the Layer 3 gate's deterministic rules. Runs in a
// second, no API calls: npx tsx evals/reply/codeChecks.ts
import { canSkipReplyAfterResults, isOnlyUpdatesAsk, messageIsOnlyTheAsk, rewriteKeepsAsk, shouldCacheSearch, xPostFitsWindow } from "../../src/services/searchRules.js";
import { localDate, offerScore, orderForOffering } from "../../src/services/eventOrder.js";
import { capitalizeSentences, looksLikeMetaReply, paragraphize } from "../../src/services/textStyle.js";
import { readFileSync } from "fs";
const { isTimeout } = await import("../../src/agent/conversationReply.js");
const { firstSendTimes } = await import("../../src/services/turnLatency.js");
import { nearestPlace, parseDiscoverPlaces } from "../../src/services/lumaDiscovery.js";
import { announcementAudience } from "../../src/services/coEventAnnouncement.js";
import { resolveCoEventCity } from "../../src/services/luma.js";
import { DateTime } from "luxon";
import { isBrowseAsk, parseAskWindow, withinWindow } from "../../src/services/askWindow.js";
import { renderMatchLead } from "../../src/services/messageFormat.js";
import { closingReaction } from "../../src/services/conversationClose.js";
import "dotenv/config";
import { addFact, baseReplyFacts, codeChecks, countOf, onlyCuts, sentencesToRecheck, renderReplyFacts, needsClaimCheck, pairSentLinks, predictionMatch, stripUnsupported } from "../../src/harness/replyGrounding.js";
import { isLeakedMetaCommentary, webhookSecretMatches } from "../../src/services/sendblue.js";
import { coAskedQuestion } from "../../src/services/conversationClose.js";

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
  ["Let me know if anything changes.", null, "their follow-up, not Cue's"],
  ["Will do.", null, "bare will do"],
  // Advice about their own event's invites is not Co claiming a membership invite (2026-09-22).
  ["Have a handful of founders each sending invites to 3 people they actually want there.", null, "event invite advice is not an invite claim"],
  ["Sending your invite now, one sec.", "no_invite_sent_claim", "Cue claiming an invite is still caught"],
  ["I'll send an invite link to your friend.", "no_invite_sent_claim", "Cue promising an invite is still caught"],
  // Co can't start a group text (Sendblue only replies to numbers that texted
  // in), and group chats are out of the product (2026-09-20).
  ["Sure, I'll start a group text with you both.", "no_group_chat_claim", "offers a group text"],
  ["I can set up a group chat so you two can pick a time.", "no_group_chat_claim", "offers a group chat"],
  ["She's in. Starting a group text so you two can pick a time.", "no_group_chat_claim", "the old phone-mockup line"],
  ["I put you two in a group thread.", "no_group_chat_claim", "claims it already happened"],
  ["I can't start a group text, but I can email you both once you've each said yes.", null, "honest denial passes"],
  ["A group chat isn't something I do. I'll introduce you two by email once you both say yes.", null, "honest denial, other wording"],
  ["I'll email you both once you've each said yes.", null, "the email introduction is fine"],
  ["If a good one turns up in Oakland I'll send it your way.", "no_followup_promise", "send it your way"],
  ["I'll pass it along if I hear anything.", "no_followup_promise", "pass it along"],
  ["Send it my way whenever.", null, "their send, not Cue's"],
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
addFact(rfOngoing, "ongoing", 'Cue\'s daily search is looking for: "friends to hang out with in SF". If something real fits, Cue may text them about it (at most one text a day).');
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
  ["Thanks Cue.", "like"],
  ["Cue thank you!", "like"],
  ["love it co", "love"],
  ["co can you look again", null],
];

// A closing acknowledgment that actually answers a question Co just asked is
// not the end of the thread (2026-09-17 code review, live: Co asked "Want me
// to keep an eye out?", they said "sounds good", and got a tapback with
// nothing saved). closingReaction(text, lastCoMessage) must return null
// whenever Co's last message asked or offered something.
const closingWithLastCoMessageCases: [string, string | null, string][] = [
  ["sounds good", "Want me to keep an eye out for one?", null],
  ["for sure", "Should I text you if something opens up?", null],
  ["ok", "Do you want me to save that so I keep looking?", null],
  ["got it", "Here's what's new:\n\nWe added dark mode.", "like"],
  ["perfect", "I found a mixer this Thursday.", "love"],
  ["sounds good", null, "like"],
  ["ok", "I'm here if you ever want to hop on a call and talk it through.", null],
];

// How several real things arrive (services/messageFormat.ts): a one-line
// heads-up, then each item followed by its own link.
const BLOCK = `Okay. Here's the shape I'd commit to. Arrival: one funnel, one bar, no check-in table. People drift toward that one point. Middle: a short round of intros from you as host, then let it release back into mingling. Close: end on something people remember leaving on, not just the bar closing, so the night has a real last beat instead of a slow fade.`;
const PARA = paragraphize(BLOCK);
const replyPrompt = readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
const groundingPrompt = readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
const sendblueRoute = readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
let total2 = 0;
function check2(ok: boolean, label: string) {
  total2++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
}
const formatCases: [boolean, string][] = [
  // Readable paragraphs, walkthroughs, and pressure-tested advice (2026-09-22).
  [PARA.split("\n\n").length === 4 && PARA.split("\n\n")[1].startsWith("Arrival:") && PARA.split("\n\n")[3].startsWith("Close:"), "a long block splits into paragraphs, each labeled part on its own"],
  [paragraphize("Short and sweet. Two lines. Three.") === "Short and sweet. Two lines. Three.", "short texts are left alone"],
  [paragraphize("First para already.\n\nSecond one. " + "x".repeat(400)).startsWith("First para already.\n\nSecond"), "text that already has paragraphs is left alone"],
  [/give the whole walkthrough in this one reply/.test(replyPrompt) && /End with one question that gauges where they are/.test(replyPrompt), "walkthroughs come whole, ending with a gauging question"],
  [/challenge your own answer before you send it/.test(replyPrompt), "advice is pressure-tested against their specifics"],
  [/meet the feeling first, then gauge before you plan/.test(replyPrompt) && /never make them ask twice/.test(replyPrompt), "a feeling is met first, then gauged, then walked through"],
  [/each idea its own short paragraph with a blank line between them/.test(replyPrompt), "reply prompt asks for paragraphs"],
  [/Never claims \(don't list these\)/.test(groundingPrompt) && /Advice and possibilities: general know-how about how things usually go/.test(groundingPrompt), "the fact check doesn't strip ordinary advice as a prediction"],
  // A photo they send is written down once, for the record and the fact check (2026-09-22).
  [/a conclusion reasoned from the sources \("if Oct 10 is under 30 days out/.test(groundingPrompt), "reasoning from what's on file isn't cut as a prediction"],
  // In their own zone since 2026-10-08 (review F8): todayFact(zone), built from the zone gatherReplyFacts loaded.
  [/addFact\(rf, "known", todayFact\(zone\)\)/.test(groundingPrompt) && /Today is \$\{DateTime\.fromJSDate\(now\)\.setZone\(wordsZone\(z\)\)/.test(groundingPrompt), "the reply's facts include today's date"],
  [/photoDescription = await describeImage\(buffer, mediaType\)/.test(sendblueRoute), "an incoming photo is described once"],
  [/\[They also sent a photo\$\{photoDescription \? `\. It shows: \$\{photoDescription\}`/.test(sendblueRoute), "the conversation record keeps the photo, not just their words"],
  [/They sent a photo this turn\. It shows: \$\{photoDescription\}/.test(sendblueRoute), "the fact check sees what the photo shows"],
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
  // Receipts: what didn't happen is marked, and can't be claimed as done.
  [renderReplyFacts((() => { const r = baseReplyFacts(); addFact(r, "not_done", "Cue's contact card was not sent (the send failed)."); return r; })()).includes("NOT DONE: Cue's contact card was not sent"), "a receipt is shown to Cue as NOT DONE"],
  [(() => { const r = baseReplyFacts(); addFact(r, "not_done", "Cue's contact card was not sent (the send failed)."); return codeChecks("Here you go.", r, { message: "v card?", recentConversation: "", sentThisTurn: ["https://lu.ma/abc123"] }).some((c) => c.name === "no_handover_claim" && !c.pass); })(), "a failed card can't be claimed even when a link went out"],
  // "Here you go" with nothing handed over this turn.
  [codeChecks("Here you go, Jacqueline. Save it so I'm easy to find.", rf, { message: "can you send me a v card", recentConversation: "" }).some((c) => c.name === "no_handover_claim" && !c.pass), "\"here you go\" with nothing sent is caught"],
  [!codeChecks("Here you go, save it so I'm easy to find.", rf, { message: "can you send me a v card", recentConversation: "", sentThisTurn: ["[sent Cue's contact card]"] }).some((c) => c.name === "no_handover_claim"), "after a real card, \"here you go\" is fine"],
  [!codeChecks("Here it is.", rf, { message: "link?", recentConversation: "Co replied: https://lu.ma/abc123", sentThisTurn: ["https://lu.ma/abc123"] }).some((c) => c.name === "no_handover_claim"), "after a real link, \"here it is\" is fine"],
  [(() => { const r = baseReplyFacts(); addFact(r, "did_this_turn", "Sent the link https://lu.ma/abc123 for \"Mixer\" as its own message just before this reply."); return !codeChecks("There you go, that's the one.", r, src).some((c) => c.name === "no_handover_claim"); })(), "a link the turn sent first counts as handed over"],
  [!codeChecks("Sounds good, talk soon.", rf, src).some((c) => c.name === "no_handover_claim"), "an ordinary reply isn't a handover claim"],
  // 2026-09-26: pointing back at an earlier send isn't a handover.
  [!codeChecks("Already sent it above, should be there to save.", rf, src).some((c) => c.name === "no_handover_claim"), "\"already sent it above\" isn't a handover claim"],
  [!codeChecks("The Tech Week link I sent you a few minutes ago is the latest.", rf, src).some((c) => c.name === "no_handover_claim"), "a link sent earlier isn't a handover claim"],
  [codeChecks("Just sent it, check your texts.", rf, { message: "card?", recentConversation: "" }).some((c) => c.name === "no_handover_claim" && !c.pass), "\"just sent it\" with nothing sent is still caught"],
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
  [looksLikeMetaReply("I'm ready to be Cue. Send me what you'd like me to say, and I'll write a single message."), "the onboarding leak is caught"],
  [looksLikeMetaReply("Send me what you'd like me to say."), "asking for what to say is caught"],
  [!looksLikeMetaReply("Save my contact so we can keep talking."), "the real line passes"],
  [!looksLikeMetaReply("Would you like me to look for more founder events this week?"), "a normal offer passes"],
  [!looksLikeMetaReply("You and your co-founder should both come."), "co-founder is not being Cue"],
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
    [!keeps("That sounds interesting maybe you can help me find that founder/builder meetup this weekend", "a weekend founder/builder meetup at a casual cafe setting"), "rewrite that adds Cue's invented words is refused"],
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
    [messageIsOnlyTheAsk("Any good tech talks in SF next week?", "Find good tech talks in SF next week"), "a pure ask needs no extra reply"],
    [messageIsOnlyTheAsk("Anything for AI engineers happening Thursday night?", "Find AI engineer events happening Thursday night"), "a pure ask with a time frame needs no extra reply"],
    [!messageIsOnlyTheAsk("Ugh rough week, any chill founder events this weekend?", "Find chill founder events this weekend"), "a feeling in the message still gets a reply"],
    [!messageIsOnlyTheAsk("Any AI meetups Thursday? Also did you hear back from Maya?", "Find AI meetups Thursday"), "a second question still gets a reply"],
    [!messageIsOnlyTheAsk("Wasn't feeling the mixer, any accelerators if I build something else?", "Find accelerators for a new company"), "news in the message still gets a reply"],
    [!messageIsOnlyTheAsk("any founder events this weekend 😭", "Find founder events this weekend"), "a feeling shown only as an emoji still gets a reply"],
    [canSkipReplyAfterResults({ sentResults: 1, original: "Any design events in SF next week?", rewritten: "Find design events in SF next week", ruledOut: 0, firstRealMessage: false }), "a plain ask with a result and nothing ruled out skips the reply"],
    [!canSkipReplyAfterResults({ sentResults: 1, original: "Any AI engineer events Thursday?", rewritten: "Find AI engineer events Thursday", ruledOut: 1, firstRealMessage: false }), "something ruled out keeps the reply, so a wrong earlier pick gets corrected"],
    [!canSkipReplyAfterResults({ sentResults: 1, original: "Any AI events in SF this week?", rewritten: "Find AI events in SF this week", ruledOut: 0, firstRealMessage: true }), "a first real message keeps the reply, so Cue opens the conversation"],
    [!canSkipReplyAfterResults({ sentResults: 0, original: "Any design events in SF next week?", rewritten: "Find design events in SF next week", ruledOut: 0, firstRealMessage: false }), "nothing sent means a reply"],
    [isOnlyUpdatesAsk("Updates?") && isOnlyUpdatesAsk("any updates") && isOnlyUpdatesAsk("What's new?") && isOnlyUpdatesAsk("hey, any new updates on Cue?"), "a bare updates question is only the ask (2026-09-18)"],
    [!isOnlyUpdatesAsk("Updates? also did you find anything for Sunday") && !isOnlyUpdatesAsk("any updates on the grants?"), "updates plus something else still gets a reply"],
    // The router's split of the ask from everything else (2026-09-18).
    [canSkipReplyAfterResults({ sentResults: 1, original: "What does the SF tech week look like? Oct 5th - Oct 11th?", rewritten: "What tech events are happening during SF tech week Oct 5th - Oct 11th", ruledOut: 0, firstRealMessage: false, beyondAsk: null }), "router: a date range is part of the ask, so no restating reply"],
    [canSkipReplyAfterResults({ sentResults: 1, original: "Did you see anything about VC looking to fund?", rewritten: "Look for VC funding opportunities", ruledOut: 0, firstRealMessage: false, beyondAsk: null }), "router: only the ask, even when the words don't line up"],
    [!canSkipReplyAfterResults({ sentResults: 1, original: "Ugh rough week, any chill founder events?", rewritten: "Find chill founder events", ruledOut: 0, firstRealMessage: false, beyondAsk: "rough week" }), "router: a feeling beyond the ask gets a reply"],
    [!canSkipReplyAfterResults({ sentResults: 1, original: "any founder events this weekend 😭", rewritten: "Find founder events this weekend", ruledOut: 0, firstRealMessage: false, beyondAsk: null }), "an emoji still gets a reply even if the router missed it"],
    [!canSkipReplyAfterResults({ sentResults: 1, original: "Any AI events Thursday?", rewritten: "Find AI events Thursday", ruledOut: 1, firstRealMessage: false, beyondAsk: null }), "router or not, something ruled out keeps the reply"],
    [!messageIsOnlyTheAsk("anything this weekend 🙏🏾", "Find events this weekend"), "any emoji counts as more than the ask"],
    [messageIsOnlyTheAsk("Any AI/ML talks in SF next week?", "Find AI/ML talks in SF next week"), "ordinary punctuation like a slash is still just the ask"],
    [offerScore(0.5, null, false) === 0.5, "no profile: order by the ask alone"],
    [resolveCoEventCity("Oakland", "San Francisco", "Austin").city === "Oakland", "a Cue event's own calendar city wins"],
    [resolveCoEventCity(null, "Brooklyn", "Austin").source === "event_page", "no calendar city: the event page's city"],
    [resolveCoEventCity(null, null, "Austin", "San Francisco, CA").source === "event_address", "no city field: the page's venue text"],
    [resolveCoEventCity(null, null, "Austin").city === "Austin", "no city anywhere: Cue's home city"],
    [resolveCoEventCity("", null, undefined).city === "San Francisco", "no home city set: San Francisco"],
    [(() => {
      const people = [
        { id: "near", city: "Oakland", optedOut: false, identityCaptured: true },
        { id: "far", city: "New York", optedOut: false, identityCaptured: true },
        { id: "opted", city: "San Francisco", optedOut: true, identityCaptured: true },
        { id: "mid-onboarding", city: "San Francisco", optedOut: false, identityCaptured: false },
        { id: "no-city", city: null, optedOut: false, identityCaptured: true },
      ];
      const ids = announcementAudience(people, (c) => c !== "New York").map((p) => p.id);
      return ids.length === 1 && ids[0] === "near";
    })(), "a new Cue event goes to everyone nearby, never far away, opted out, mid-onboarding or with no city"],
    [offerScore(0.4, 0.6, false) > offerScore(0.45, 0.2, false), "with a profile, a slightly weaker ask match that suits them better comes first"],
    [offerScore(0.6, 0.1, false) > offerScore(0.35, 0.3, false), "a much stronger ask match still beats a small profile edge"],
    [offerScore(0.1, 0.7, true) === 0.7, "a what's-on ask is ordered by the profile"],
    [(() => { const o = orderForOffering([{ name: "a", similarity: 0.5, offerScore: 0.3 }, { name: "b", similarity: 0.4, offerScore: 0.5 }]); return o[0].name === "b"; })(), "ordering uses the offer score when there is one"],
    [localDate("2026-09-18T02:00:00.000Z", "America/Los_Angeles") === "2026-09-17", "a 7pm Thursday SF event is Thursday, not Friday"],
    [localDate("2026-09-18T02:00:00.000Z", null) === "2026-09-17", "without a zone, the Pacific date (the one fallback), not the UTC one (2026-10-07)"],
  );
}

// Co's own last message asking or offering something (services/
// conversationClose.ts coAskedQuestion) — feeds closingReaction above.
onboardingCaseCases.push(
  [coAskedQuestion("Want me to keep an eye out for one?"), "a question mark is an ask"],
  [coAskedQuestion("If you want, I can look now."), "an offer without a question mark still counts"],
  [coAskedQuestion("I'm here if you'd ever want to hop on a call and talk it through."), "an offer phrased as availability still counts"],
  [!coAskedQuestion("Here's what's new:\n\nWe added dark mode."), "a plain statement is not an ask"],
  [!coAskedQuestion(null), "no last message means no ask"],
  [!coAskedQuestion("Check it out here: https://lu.ma/abc123?ref=co"), "a query string's ? doesn't count as Cue asking something"],
);

// LEAKED_METACOMMENTARY / looksLikeMetaReply (services/sendblue.ts,
// 2026-09-17 code review): the send wrapper must still block a real leak,
// but must not reject an honest "I don't have X" / "I can't do X for you"
// line — the old pattern did, sendCoReply swallowed the rejection, and the
// person got nothing while every caller logged "Co replied."
onboardingCaseCases.push(
  [!isLeakedMetaCommentary("I don't have any information on the start time."), "honest gap about an event detail passes"],
  [!isLeakedMetaCommentary("I can't send the ticket for you, but here's the link."), "honest capability limit passes"],
  [!isLeakedMetaCommentary("I don't have the link for that one yet."), "honest missing link passes"],
  [!isLeakedMetaCommentary("Booking that is outside what I can do, but I can point you to the link."), "an honest scope limit passes"],
  [isLeakedMetaCommentary("I don't have access to the context_summary you gave me."), "a real prompt-plumbing leak is still caught"],
  [isLeakedMetaCommentary("Here's a message: {{first_name}}, want to grab coffee?"), "an unfilled template variable is still caught"],
  [isLeakedMetaCommentary("As an AI I can't form opinions about that."), "a real AI self-reference is still caught"],
  [isLeakedMetaCommentary("I don't have access to our conversation history before this."), "a real memory/context leak is still caught"],
  [isLeakedMetaCommentary("I can't actually send you a text message right now."), "claiming Cue can't text at all is still caught"],
  [isLeakedMetaCommentary("I'm ready to be Cue. Send me what you'd like me to say."), "the looksLikeMetaReply leak is still caught (delegated)"],
);

// Sendblue's webhook secret comparison (services/sendblue.ts
// webhookSecretMatches, 2026-09-17 code review) — the constant-time check
// behind the webhook's auth.
onboardingCaseCases.push(
  [webhookSecretMatches("real-secret-123", "real-secret-123"), "matching secret passes"],
  [!webhookSecretMatches("real-secret-123", "wrong-secret"), "wrong secret fails"],
  [!webhookSecretMatches("real-secret-123", undefined), "missing header fails"],
  [!webhookSecretMatches("real-secret-123", ""), "empty header fails"],
  [!webhookSecretMatches(undefined, "real-secret-123"), "no configured secret fails closed even with a header present"],
  [!webhookSecretMatches("", "real-secret-123"), "empty configured secret fails closed"],
  [!webhookSecretMatches("real-secret-123", 12345 as any), "a non-string header fails"],
);

// stripUnsupported's suffix handling (harness/replyGrounding.ts, 2026-09-17
// code review): claimChecks appends more than just " (cited support not
// found)" — a future_promise failure's real suffix is " (a future action
// needs a real scheduled call or an open search behind it)". The old
// literal-only regex left that suffix in place, so the quoted claim text
// never matched a sentence and an unsupported promise survived stripping.
{
  const draft = "Sounds fun! I'll text you the moment a spot opens up.";
  const failed = [
    {
      name: "claim_future_promise",
      pass: false,
      reason: 'future_promise: "I\'ll text you the moment a spot opens up." (a future action needs a real scheduled call or an open search behind it)',
    },
  ];
  const out = stripUnsupported(draft, failed);
  onboardingCaseCases.push(
    [!out.includes("I'll text you the moment"), `future_promise suffix is stripped along with the claim (got "${out}")`],
    [out.includes("Sounds fun"), "the supported sentence is kept"],
  );
}
{
  // The generic no_followup_promise code check (a different suffix shape,
  // no factId/quote) still strips as before.
  const draft = "I'll keep an eye out for you.";
  const out = stripUnsupported(draft, [{ name: "no_followup_promise", pass: false, reason: 'promises a follow-up nothing will do: "I\'ll keep an eye out for you."' }]);
  onboardingCaseCases.push([out === "" || out.trim() === "", "a whole-message follow-up promise with no other content strips to nothing"]);
}

// Real incident, 2026-09-17: Jacqueline asked for Co's contact card, it
// apparently didn't arrive, and her plain "I dont see it" follow-up wasn't
// itself a fresh ask — but the reply agent claimed "trying again" without
// conversationTools.ts's sendContactCard tool ever running a real resend,
// and that false claim slipped past grounding's claim-shape pre-filter
// entirely (nothing in it matched CLAIM_SHAPED, so the model's claim read
// was skipped, not even attempted).
onboardingCaseCases.push(
  [needsClaimCheck("Trying again, should come through as a separate contact card, not a text bubble."), "a retry/resend claim is now recognized as claim-shaped and gets checked, not skipped"],
  [needsClaimCheck("Yeah, feedback like that goes straight to the team, not just logged and forgotten."), "saying feedback reached the team gets checked (2026-09-18, sent with nothing saved)"],
  [needsClaimCheck("Noted, I passed that along."), "passing something along gets checked"],
  // What Co sent, for the claim check: every link with its caption (2026-09-18).
  [(() => {
    const t = (m: number) => new Date(Date.UTC(2026, 8, 17, 4, m));
    const p = pairSentLinks([
      { at: t(21), text: "https://lu.ma/love-potion" },
      { at: t(21.5), text: "Sunday 3-6pm at The Love Potion Library, this low-key one has coffee, tarot, and massages." },
      { at: t(40), text: "Looking now, give me a minute." },
      { at: t(41), text: "https://lu.ma/other" },
    ]);
    return p.length === 2 && p[0].caption?.includes("Love Potion") === true && p[1].caption === null;
  })(), "each sent link keeps the description sent right after it; a lone link has none"],
  [needsClaimCheck("Cue keeps an eye on that for you."), "a claim about how Cue works gets checked"],
  [needsClaimCheck("Already ran that search, those two were the results."), "a spelled-out count of Cue's own results gets checked (2026-09-25: went out unchecked when there were 4)"],
  [countOf(4, "result") === "4 results" && countOf(1, "thing") === "1 thing", "search notes lead with the count in words"],
  // (2026-10-01) The old reply search (routes/sendblue.ts searchAndSend) is gone: what Co sends, and what it turns away and why, is now its own loop (evals/loop/rules.ts).
  [/A number must match its source exactly/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")), "the claim check compares numbers, not just topics"],
  // 2026-09-26 quality fixes
  [/debounceWaitMs = Math\.max\(0, burstWaitMs\(resolvedContent \?\? ""\) - \(Date\.now\(\) - new Date\(myInboundAt\)\.getTime\(\)\)\)/.test(readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8")), "latency: the debounce runs from when their text arrived, not after the router"],
  [/Promise\.all\(\[recentMemoriesP, coverageP, buildContextSummary\(user\.id\)\]\)/.test(readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8")), "latency: memories, coverage and context summary run together"],
  [/firstSentMs: firsts\.firstSentMs, firstAnswerMs: firsts\.firstAnswerMs/.test(readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8")), "latency: time to Cue's first text and first real answer are recorded, whichever path sent them"],
  [(() => { const t0 = new Date("2026-09-27T00:31:47Z"); const r = firstSendTimes([{ text: "https://lu.ma/full-moon", at: new Date("2026-09-27T00:32:11Z") }, { text: "Let me look, one sec.", at: new Date("2026-09-27T00:31:56Z") }], t0, ["Let me look, one sec."]); return r.firstSentMs === 9000 && r.firstAnswerMs === 24000; })(), "latency: a hold line counts as the first text, not as the answer"],
  [firstSendTimes([], new Date(), []).firstSentMs === null, "latency: nothing sent, nothing recorded"],
  [/\?\? "medium";/.test(readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8")), "latency: replies draft at medium effort (won blind 22-16, faster)"],
  [/Never a heading or a label with a colon/.test(readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8")) && !/labeled part \("Arrival:"\)/.test(readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8")), "voice: walkthroughs read as spoken steps, not labeled sections"],
  [/including a yes or no to whether it did \("Still no", "Yep, I did"\)/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")), "grounding: a yes or no about what Cue did is a claim"],
  [/What they're asking about is in Cue's record as sent: \$\{ledger\.named\.join\(" "\)\} Answer from that record\./.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")), "record: when they ask about something Cue sent, the record answers, over earlier messages"],
  // Remove-only (2026-09-28): the unsupported sentences are cut first; one rewrite only when too little is left, kept only if it adds nothing.
  [/let cut = stripUnsupported\(draft, effectiveFailed1, allowArrival\);/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")) && /const cutStands = enoughLeft\(cut, draft\) && !apologyOnly\(cut\) && !inviteCut && !deniesWhatTheyToldCo\(effectiveFailed1, src\) && !silent && !lostSupported;[\s\S]{0,4000}?const stub = shareCutStub\([\s\S]{0,300}?if \(cutStands && !threadCut && shareTurn && stub\)[\s\S]{0,900}?\} else if \(cutStands && !threadCut\)/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")) && /const guard = cleaned \? rewriteAddsNothing\(draft, cleaned, allowed\)/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")), "grounding: cut first; a rewrite only when too little is left (or a false \"nothing on file\" about their own life, or dead air while their world has a true line, or a cut thread report, evals/checkins/rules.ts, or a sharing turn's cut left a stub, or the narration rule cut a supported answer, evals/reply/shareCut.ts), and only if it adds nothing"],
  [(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8").match(/abortSignal: AbortSignal\.timeout\(GROUNDING_CALL_TIMEOUT_MS\)/g) ?? []).length === 4, "grounding: the check, the rewrite, the share rewrite and the thread repair can't stall a reply"],
  [onlyCuts("Still just Mahjong After Dark from what I sent earlier, nothing new has turned up since.", "Still just Mahjong After Dark from what I sent earlier."), "grounding: a rewrite that only drops a clause skips the second read"],
  [!onlyCuts("I did not send it yet.", "I did send it."), "grounding: dropping a word from the middle of a sentence still gets re-checked"],
  [!onlyCuts("Nothing new on my end.", "Nothing new, but I found a rooftop party Saturday."), "grounding: a rewrite that adds anything still gets re-checked"],
  [!onlyCuts("Hey. What's up?", "Hey. What's up?"), "grounding: an unchanged rewrite isn't treated as a cut"],
  // 2026-09-26, fact check and stalls
  [sentencesToRecheck("Mahjong is Saturday. It's casual.", "Mahjong is Saturday. Want me to look for more?", []).join() === "Want me to look for more?", "grounding: only new sentences are re-read"],
  [sentencesToRecheck("I sent it Tuesday. It's casual.", "I sent it Tuesday. It's casual.", [{ name: "claim_past_action", pass: false, reason: 'past_action: "I sent it Tuesday"' }]).length === 1, "grounding: a kept sentence with a failed claim is re-read"],
  [isTimeout({ name: "TimeoutError" }) && isTimeout({ lastError: { cause: { name: "AbortError" } } }) && !isTimeout(new Error("rate limited")), "stalls: a timeout is recognized however it's wrapped"],
  [/if \(!isTimeout\(err\)\) throw err;/.test(readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8")) && /REPLY_CALL_TIMEOUT_MS = Number\(process\.env\.REPLY_CALL_TIMEOUT_MS \?\? 40_000\)/.test(readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8")), "stalls: each reply model call is capped at 40s and a timeout doesn't fail the turn"],
  [/What Cue did or didn't do \(past_action, including "I never sent that"\) needs a FACT/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")), "grounding: what Cue did needs a fact, not its own earlier words"],
  [/No promises, no "let me look" or "one sec"/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")), "grounding: a rewrite never promises a search it can't run"],
  [needsClaimCheck("That's on my radar now."), "'on my radar' gets checked"],
  [needsClaimCheck("I save everything you tell me."), "a present-tense claim about what Cue does gets checked"],
  [!needsClaimCheck("That sounds hard. What's been the toughest part?"), "a plain conversational reply still skips the check"],
);

// Real incident, 2026-09-17: groundReply used to strip only the redraft
// when it also failed its own check, discarding the original draft's other,
// still-good sentence entirely. A "checked already" past-action claim got
// redrafted into an unsupported "let me check... one sec" future promise
// instead of being fixed — stripping just that one-sentence redraft left
// nothing, so the person got the generic fallback instead of the real,
// grounded detail sitting right there in the original draft. groundReply
// itself needs a live model call to fully exercise, so this locks in the
// piece that made the fix correct: stripping the ORIGINAL draft (with its
// own failure) has to actually survive with real content, so a
// content-length comparison between the two candidates picks it over an
// empty/near-empty redraft strip.
{
  const originalDraft = "Nothing real for Sep 24th, checked already. Only actual thing on the board right now for that window is the SOLO Founder Club on Oct 6.";
  const originalFailed = [{ name: "claim_past_action", pass: false, reason: 'past_action: "Nothing real for Sep 24th, checked already."' }];
  const redraftDraft = "Let me check for Sep 24th specifically, one sec.";
  const redraftFailed = [{ name: "claim_future_promise", pass: false, reason: 'future_promise: "Let me check for Sep 24th specifically, one sec." (a future action needs a real scheduled call or an open search behind it)' }];
  const strippedOriginal = stripUnsupported(originalDraft, originalFailed);
  const strippedRedraft = stripUnsupported(redraftDraft, redraftFailed);
  onboardingCaseCases.push(
    [strippedOriginal.includes("SOLO Founder Club"), `stripping the original keeps its other real, grounded sentence (got "${strippedOriginal}")`],
    [strippedOriginal.split(/\s+/).filter(Boolean).length >= 3, "the original's stripped result clears the minimal-fallback word floor"],
    [strippedRedraft.split(/\s+/).filter(Boolean).length < 3, "the redraft's stripped result is the thin one here, confirming the original is the real candidate to prefer"],
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
for (const [message, lastCoMessage, expected] of closingWithLastCoMessageCases) {
  const got = closingReaction(message, lastCoMessage);
  if (got !== expected) {
    failed++;
    console.log(`FAIL closing (Cue asked "${lastCoMessage}") "${message}" -> ${got ?? "(reply)"} , expected ${expected ?? "(reply)"}`);
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
// Remove-only fact check and hints (2026-09-28).
{
  const G = await import("../../src/harness/replyGrounding.js");
  const facts = 'Details on file for "Grok Bot x Notion for Product Builders night (SF)", which Cue sent them: starts Tuesday, September 29 at 5:00 PM (America/Los_Angeles).';
  const removeOnly: [boolean, string][] = [
    [!G.rewriteAddsNothing("Both on the same night though, so it's one or the other. Since you already called the daytonaio demo night your pick, I'd stick with that.", "Given you're leaning toward taking a break from building, I'd pick this one.", facts).ok, "a rewrite that flips the pick and names his burnout is rejected"],
    [!G.rewriteAddsNothing("Still no, same as I said before.", "Yes, sent it Friday with the Luma link.", facts).ok, "a rewrite can't add a day or name that isn't in the draft or facts"],
    [G.rewriteAddsNothing("Neither gave me a clock time.", "The Grok Bot night starts at 5:00 PM.", facts).ok, "a correction from the facts is kept"],
    [G.rewriteAddsNothing("Agreed, noted that too.", "Honestly, that one didn't get passed to the team.", facts).ok, "saying plainly what's true is kept"],
    [!G.rewriteAddsNothing("Good.", "Good, and honestly that's a lot of events for how stretched you've been this week.", facts).ok, "a rewrite can't add feelings, or run longer than the draft"],
  ];
  for (const [ok, label] of removeOnly) { total2++; if (!ok) { failed++; console.log(`FAIL grounding: ${label}`); } }
  const rf = G.createReplyFacts();
  G.addHint(rf, "Why it fits: this is their people");
  check2(/YOUR READ, NOT A FACT/.test(G.renderReplyFacts(rf)), "grounding: hints are shown to Cue as its read, not as facts");
  const src2 = readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
  check2(/rf\.facts\.filter\(\(f\) => f\.kind !== "hint"\)\.map\(\(f\) => `\[\$\{f\.id\}\] \$\{f\.text\}`\)/.test(src2) && /that came from a model's read, which is a hint, not a source/.test(src2), "grounding: a hint is never listed or accepted as a source");
  check2(/addHint\(rf, `Why "\$\{match\.name\}" may fit them/.test(src2), "grounding: a search's fit reason is a hint, not a fact");
  check2(/const summaries = claimType && WORLD_CLAIMS\.has\(claimType\) \? \[\] :/.test(src2), "grounding: summaries never back a claim about an event, a count, a link or another person");
  check2(G.crowdClaim("go find the llama_index people, that's your crowd") && G.crowdClaim("Room full of your people") && !G.crowdClaim("Could be a solid place to find the dependable builder people you're after") && !G.crowdClaim("demo nights tend to draw builders"), "grounding: 'your crowd' is caught; where it could lead isn't");
  check2(G.clashClaim("Both on the same night though, so it's really one or the other.") && G.clashClaim("You can't do both") && !G.clashClaim("Both are Tuesday, one at 5 and one at 7, so you could make both"), "grounding: a clash is caught; making both isn't");
  check2(/The member is never "another person"/.test(src2) && /Precedence, when a sentence fits both/.test(src2), "grounding: one rule list, with precedence; the member's own words are never another person");
}
const total = total2 + cases.length + ongoingCases.length + closingCases.length + formatCases.length + windowCases.length + placeCases.length + onboardingCaseCases.length;
console.log(`codeChecks: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
