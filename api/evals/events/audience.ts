// Model-free checks for event audience (services/eventAudience.ts and its use in
// the sweep and the event offer): an event Co judged aimed at a group says so,
// nothing is held back for anyone, and Co never guesses or implies who a member
// is. No API calls, no database:
//   npx tsx evals/events/audience.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const A = await import("../../src/services/eventAudience.js");
const D = await import("../../src/agent/eventDiscoverySurfacing.js");
const { checkDraft } = await import("../../src/harness/proactive.js");
const { renderEventDetails } = await import("../../src/services/eventDetails.js");
const { addEventFacts, baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
import { readFileSync } from "fs";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

const HIKE = "HOT GIRL HIKE CLUB: SESSION 6. Our next Hot Girl Hike is here! Fair warning, girls, this one is going to make us WORK. See you on the trail, girls!";
const details = (description: string) => ({ startAt: "2026-10-11T23:15:00.000Z", endAt: null, timezone: "America/Los_Angeles", hosts: ["925 Wellness Club"], price: "free", venue: "Round Valley", address: null, city: "Brentwood", online: false, soldOut: false, spotsRemaining: null, requiresApproval: false, guestCount: 61, description }) as any;
const lineFor = (name: string, description: string) => renderEventDetails(name, details(description)).find((l) => /^Who it's for/.test(l)) ?? null;

// ---- the fact Co reads: the page's text only, a fact to judge, never a verdict or a requirement
check("the real Hot Girl Hike page shows the line", /Who it's for: the page's text uses the word "girls"/.test(lineFor("HOT GIRL HIKE", HIKE) ?? ""));
check("the line tells Cue to judge it and that it may be nothing", /Read it yourself/.test(lineFor("x", HIKE) ?? "") && /or it may be nothing/.test(lineFor("x", HIKE) ?? ""));
check("and that Cue doesn't know who the member is", /does not know whether this member is in any group unless they have said so in their own words/.test(lineFor("x", HIKE) ?? "") && /never guesses from a name, a voice/.test(lineFor("x", HIKE) ?? ""));
check("a title alone never shows it: Men in Black screening", lineFor("Men in Black screening", "Outdoor movie night.") === null);
check("a title alone never shows it: Gone Girl book club", lineFor("Gone Girl book club", "We discuss the novel over wine.") === null);
check("an open event shows nothing", lineFor("Founders Hike", "A walk with founders. All welcome. Bring water.") === null);
check("words the description uses are found, once each, in order", A.addressedAs("x", "girls, girls and ladies; women's night").join() === "girls,ladies,women");
check("singular titles in a description are not addresses", A.addressedAs("", "We screen Gone Girl and Men in Black.").join() === "men");

// ---- nothing forces a note from page words alone (the false positives the review found)
const hikeNoJudgment: any = { tier: 2, kind: "public_event", event_api_id: "e", event_date: "2026-10-11", name: "HOT GIRL HIKE CLUB: SESSION 6", url: "https://lu.ma/x", reason: "A public event.", details: details(HIKE) };
check("with no judgment from Cue, nothing is required", Object.keys(D.whoItIsFor(hikeNoJudgment)).length === 0);
for (const [label, desc] of [["Hey guys! Trivia is back", "Hey guys! Trivia is back at the pub."], ["Mad Men trivia", "Join us for Mad Men trivia."], ["Spice Girls tribute", "Spice Girls and Backstreet Boys tribute night."], ["women founders panel", "Panels by women founders."], ["gala", "Ladies and gentlemen, welcome to the gala."], ["co-ed", "Men and women welcome, co-ed."]] as const) {
  check(`never forced from the page's words: ${label}`, Object.keys(D.whoItIsFor({ ...hikeNoJudgment, name: label, details: details(desc) })).length === 0);
}

// ---- Co's own judgment is what requires the note, and a member's words never switch it off
const judged: any = { ...hikeNoJudgment, audience: "women" };
const req = D.whoItIsFor(judged);
check("Cue's judgment of a group requires the note", !!req.mustAlsoIncludeAny && req.mustAlsoIncludeAny.words.includes("women") && req.mustAlsoIncludeAny.words.includes("women's"));
check("the requirement takes only the match: nothing the member said can turn it off", D.whoItIsFor.length === 1);
check("Cue's judgment of 'open' is not a group", A.isGroupAimed("open to everyone") === false && A.isGroupAimed("women") === true && A.isGroupAimed(undefined) === false && Object.keys(D.whoItIsFor({ ...judged, audience: "open" })).length === 0);

const rules = (extra: any) => ({ maxSentences: 2, maxChars: 300, mustIncludeAny: ["hike"], ...extra });
const verdict = (text: string, r: any = req) => checkDraft(text, rules(r)).filter((c: any) => !c.pass).map((c: any) => c.name);
check("a text that says who it's for passes", !verdict("HOT GIRL HIKE is Sunday at Round Valley, a women's hike club, easy to join on your own.").includes("draft_says_who_it_is_for"));
check("a text that doesn't is sent back", verdict("HOT GIRL HIKE is Sunday at Round Valley, a sunset hike to clear your head.").includes("draft_says_who_it_is_for"));
// The review's probes
const girlsReq = D.whoItIsFor({ ...judged, audience: "girls" });
check("the full page title with its colon and number does not count as saying it", verdict("HOT GIRL HIKE CLUB: SESSION 6 is Sunday at Round Valley.", girlsReq).includes("draft_says_who_it_is_for"));
check("nor the short name, however the draft punctuates it", verdict("Hot Girl Hike Club, session 6, is Sunday at Round Valley.", girlsReq).includes("draft_says_who_it_is_for") && verdict("HOT GIRL HIKE is Sunday at Round Valley.", girlsReq).includes("draft_says_who_it_is_for"));
check("but saying it beside the name does", !verdict("HOT GIRL HIKE CLUB: SESSION 6 is Sunday, a hike club for girls.", girlsReq).includes("draft_says_who_it_is_for"));
check("the title with an emoji and no colon doesn't either", verdict("HOT GIRL HIKE is Sunday at Round Valley.", D.whoItIsFor({ ...judged, audience: "girls", name: "HOT GIRL HIKE 🩵🥾" })).includes("draft_says_who_it_is_for"));
check("a word inside another word does not count: moment, mentor, female", (() => {
  const men = D.whoItIsFor({ ...judged, audience: "men" });
  return verdict("Trivia Night is Thursday at the pub, a good moment to unwind with a mentor.", men).includes("draft_says_who_it_is_for") && verdict("It's a female friendly night, many people, humans welcome.", men).includes("draft_says_who_it_is_for");
})());
check("the women's note is not satisfied by 'men' inside 'women'", (() => {
  const men = D.whoItIsFor({ ...judged, audience: "men" });
  return verdict("It's a women's hike club.", men).includes("draft_says_who_it_is_for");
})());
check("curly apostrophes count: women’s hike club", !verdict("HOT GIRL HIKE is Sunday, a women’s hike club.").includes("draft_says_who_it_is_for"));

// ---- never imply who they are
const implies = (t: string) => verdict(t, { forbidden: [D.OFFER_FORBIDDEN, D.IMPLIES_IDENTITY] }).some((n: string) => /^draft_forbidden|forbidden/.test(n) || n.startsWith("draft_"));
const forbidden = (t: string) => checkDraft(t, rules({ forbidden: [D.OFFER_FORBIDDEN, D.IMPLIES_IDENTITY] })).some((c: any) => !c.pass && !["draft_says_who_it_is_for"].includes(c.name));
check("'perfect for you' next to who it's for is refused", forbidden("It's a women's hike club, perfect for you. HOT GIRL HIKE is Sunday."));
check("'which you are' and 'as a woman' are refused", forbidden("It's for women, which you are. HOT GIRL HIKE is Sunday.") && forbidden("As a woman you'd love this hike."));
check("saying who it's for plainly is fine", !forbidden("HOT GIRL HIKE is Sunday at Round Valley. It's a women's hike club, in case it's for you."));
check("'thinking about you' is refused", forbidden("Been thinking about you. HOT GIRL HIKE is Sunday at Round Valley."));
check("the member's own 'thinking about getting outside' is allowed", !forbidden("If you've been thinking about getting outside, HOT GIRL HIKE is Sunday at Round Valley."));
check("the member's 'thinking about a move' is allowed", !forbidden("You mentioned thinking about a move, and this hike is Sunday at Round Valley."));
void implies;

// ---- nothing is held back, and the other offer paths hear it too
check("the shared event facts carry Cue's audience judgment", (() => {
  const rf = baseReplyFacts();
  addEventFacts(rf, { name: "HOT GIRL HIKE", url: "https://lu.ma/x", kind: "public_event", audience: "women" } as any);
  return rf.facts.some((f: any) => /Who "HOT GIRL HIKE" is for, as Cue judged it when it found it: women/.test(f.text) && /never say or imply what they are/.test(f.text));
})());
check("an event with no judgment adds no such fact", (() => {
  const rf = baseReplyFacts();
  addEventFacts(rf, { name: "Founders Hike", url: "https://lu.ma/y", kind: "public_event" } as any);
  return !rf.facts.some((f: any) => /is for, as Cue judged/.test(f.text));
})());
check("the audience never reaches the match gate (nothing is held back)", !/audience/.test(read("src/harness/matchGate.ts")));
check("a woman's offer is the same text, so nothing differs by who the member is", D.AUDIENCE_RULE.includes("Every time, even if their ask uses that group's words"));

// ---- the sweep: judged by Co, the audience travels with the match
const sweep = read("src/services/sweepFind.ts");
check("the keep tool takes the audience and stores it on the match", /audience: z\.string\(\)\.optional\(\)/.test(sweep) && /audience: audience\.trim\(\)\.slice\(0, 60\)/.test(sweep));
check("Cue is told never to hold something back for who it assumes they are", /Never hold something back for who you assume they are/.test(sweep) && /never from a name or a voice/.test(sweep));
check("Cue is told to prefer an open event when two fit about equally", /Prefer an open event when two fit about equally/.test(sweep));
check("the reveal's task carries all three rules", /\$\{IDENTITY_RULE\} \$\{AUDIENCE_RULE\} \$\{OFFER_HONESTY\}/.test(read("src/agent/eventDiscoverySurfacing.ts")) && /forbidden: \[OFFER_FORBIDDEN, IMPLIES_IDENTITY[\],]/.test(read("src/agent/eventDiscoverySurfacing.ts")) && /\.\.\.whoItIsFor\(match\),/.test(read("src/agent/eventDiscoverySurfacing.ts")));

console.log(`event audience rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
