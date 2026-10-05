// Model-free checks for event audience (services/eventAudience.ts and its use in
// the sweep and the event offer): an event that is aimed at a group says so,
// nothing is held back for anyone, and Co never guesses who a member is. No API
// calls, no database:
//   npx tsx evals/events/audience.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const A = await import("../../src/services/eventAudience.js");
const { whoItIsFor, AUDIENCE_RULE, OFFER_HONESTY } = await import("../../src/agent/eventDiscoverySurfacing.js");
const { checkDraft } = await import("../../src/harness/proactive.js");
const { renderEventDetails } = await import("../../src/services/eventDetails.js");

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

// ---- what the page says
check("the real Hot Girl Hike page is read as speaking to girls", A.addressedAs("HOT GIRL HIKE", HIKE).join() === "girls");
check("an open event names no group", A.addressedAs("Founders Hike", "A walk with founders. All welcome. Bring water.").length === 0);
check("a title is not an address: Gone Girl book club", A.addressedAs("Gone Girl book club", "We discuss the novel over wine.").length === 0);
check("a title is not an address: Men in Black screening", A.addressedAs("Men in Black screening", "Outdoor movie night.").length === 0 || A.audienceTokens(undefined, "Men in Black screening", "Outdoor movie night.").length === 0);
check("a women's event is read as one", A.addressedAs("Women Who Build", "A monthly dinner for women founders.").includes("women"));
check("a men's group, ladies' night, a moms' brunch", A.addressedAs("Men's Group", "").includes("men") && A.addressedAs("Ladies Night", "").includes("ladies") && A.addressedAs("Moms brunch", "For the moms.").includes("moms"));
check("each word once, in order", A.addressedAs("x", "girls, girls, girls and ladies").join() === "girls,ladies");

// ---- Co sees it with the event, as a fact, never as a verdict on the member
const lines = renderEventDetails("HOT GIRL HIKE", details(HIKE));
check("the event text Co reads carries who it's for", lines.some((l) => /Who it's for: the page speaks to its guests as "girls"/.test(l)));
check("and says Co doesn't know whether the member is in it", lines.some((l) => /does not know whether this member is in it unless they have said so/.test(l)) && lines.some((l) => /never guesses from a name, a voice/.test(l)));
check("an open event adds no such line", !renderEventDetails("Founders Hike", details("All welcome.")).some((l) => /Who it's for/.test(l)));

// ---- nothing is held back: the offer is required to SAY it, never blocked
const hike: any = { tier: 2, kind: "public_event", event_api_id: "e", event_date: "2026-10-11", name: "HOT GIRL HIKE", url: "https://lu.ma/x", reason: "A public event.", details: details(HIKE) };
const req = whoItIsFor(hike, "something to do this weekend to clear their mind and mingle");
check("an unknown member's offer must say who it's for", !!req.mustAlsoIncludeAny && req.mustAlsoIncludeAny.words.includes("women") && req.mustAlsoIncludeAny.words.includes("girls"));
const rules = (extra: any) => ({ maxSentences: 2, maxChars: 300, mustIncludeAny: ["hike"], ...extra });
const withNote = "HOT GIRL HIKE is Sunday at Round Valley, a women's hike club, easy to join on your own.";
const withoutNote = "HOT GIRL HIKE is Sunday at Round Valley, a sunset hike to clear your head.";
const verdict = (text: string) => checkDraft(text, rules(req)).filter((c: any) => !c.pass).map((c: any) => c.name);
check("a text that says who it's for passes", !verdict(withNote).includes("draft_says_who_it_is_for"));
check("a text that doesn't is sent back", verdict(withoutNote).includes("draft_says_who_it_is_for"));
const hikeEmoji: any = { ...hike, name: "HOT GIRL HIKE 🩵🥾" };
check("the event name with its emoji still doesn't count as saying who it's for", whoItIsFor(hikeEmoji, "x").mustAlsoIncludeAny?.ignoring === "HOT GIRL HIKE" && checkDraft(withoutNote, rules(whoItIsFor(hikeEmoji, "x"))).some((c: any) => c.name === "draft_says_who_it_is_for" && !c.pass));
check("a woman\'s own words showing she belongs mean no note is required", Object.keys(whoItIsFor(hike, "I'm looking for women's groups in the East Bay")).length === 0);
check("so do girls' words from a member who uses them", Object.keys(whoItIsFor(hike, "love a hot girl summer, want to meet girls who hike")).length === 0);
const open: any = { ...hike, name: "Founders Hike", details: details("A walk with founders. All welcome.") };
check("an open event requires no note", Object.keys(whoItIsFor(open, "something to clear my mind")).length === 0);
const judged: any = { ...open, audience: "women" };
check("Co's own judgment of the audience requires it too", !!whoItIsFor(judged, "something to clear my mind").mustAlsoIncludeAny);
check("Co's judgment of 'open' is not a group", A.isGroupAimed("open to everyone") === false && A.isGroupAimed("women") === true && A.isGroupAimed(undefined) === false);

// ---- the sweep: judged by Co, the audience travels with the match
const sweep = read("src/services/sweepFind.ts");
check("the keep tool takes the audience and stores it on the match", /audience: z\.string\(\)\.optional\(\)/.test(sweep) && /audience: audience\.trim\(\)\.slice\(0, 60\)/.test(sweep));
check("Co is told never to hold something back for who it assumes they are", /Never hold something back for who you assume they are/.test(sweep) && /never from a name or a voice/.test(sweep));
check("Co is told to prefer an open event when two fit about equally", /Prefer an open event when two fit about equally/.test(sweep));
check("nothing in the sweep or the offer drops an event for its audience", !/audience/.test(read("src/harness/matchGate.ts")));

// ---- honesty in the offer
check("the offer is told to say who it's for and never assume", /say plainly in a few words who it's for/.test(AUDIENCE_RULE) && /Never assume or say what they are/.test(AUDIENCE_RULE));
check("and to invent no bridge or 'thinking of you'", /Never say you were thinking about them/.test(OFFER_HONESTY) && /never "a way into" a community unless its page says so/.test(OFFER_HONESTY));
const draftSrc = read("src/agent/eventDiscoverySurfacing.ts");
check("both rules reach the reveal's task", /\$\{IDENTITY_RULE\} \$\{AUDIENCE_RULE\} \$\{OFFER_HONESTY\}/.test(draftSrc));
check("the real Hot Girl Hike text is now refused", checkDraft("Been thinking about you with everything piling up. HOT GIRL HIKE is Sunday, a sunset hike at Round Valley.", rules({ forbidden: [{ pattern: /\b(?:thinking|thought) (?:about|of)\b/i, reason: "x" }] })).some((c: any) => !c.pass && c.name !== "draft_says_who_it_is_for"));
check("the forbidden pattern is in the reveal's rules", /forbidden: \[OFFER_FORBIDDEN\]/.test(draftSrc));

console.log(`event audience rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
