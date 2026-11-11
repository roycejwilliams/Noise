// Probes for the standard exchanges' code checks (evals/golden/standardMatchers.ts): each matcher catches the failure its case was
// written against and lets the honest version of the reply through (review of #454: honest limits were being failed). Layer 1, no model.
import { ASSUMES_WENT, EVENT_UNCONFIRMED, TIPS_LATER, inventedClaim } from "./standardMatchers.js";
import { hardRuleMisses, hypotheticalNames, inventedFacts, repliesPerTurn } from "../lib/hardRules.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const hits = (re: RegExp, s: string) => re.test(s);

// Case 74: the event called unconfirmed is a miss; a missing piece named as missing is a limit.
for (const s of ["It's not confirmed, but it's tonight at 6:30 in the Mission.", "The meetup isn't confirmed yet. Three talks, then networking.", "I can't confirm the event, but here's what's listed.", "This is unconfirmed: 6:30pm at a brewery hall."]) check(`74 catches: ${s}`, hits(EVENT_UNCONFIRMED, s));
for (const s of ["Speakers are not confirmed on the page.", "Who else attends isn't on the page.", "The speaker list hasn't been confirmed, so you can't plan around a name.", "Tonight at 6:30, three talks on serving models."]) check(`74 lets through: ${s}`, !hits(EVENT_UNCONFIRMED, s));

// Case 76: an invented benefit is a miss; saying the page is silent on it is the narrowed claim the case wants.
for (const s of ["Engineers will be there, so it's a good place to meet a hire.", "It's an intimate dinner, worth it.", "A curated room of founders.", "You'll hear who's hiring."]) check(`76 catches: ${s}`, inventedClaim(s) !== null);
for (const s of ["The page doesn't say whether engineers will be there.", "There's nothing about who's hiring.", "It doesn't say if it's structured or just dinner.", "15-20 founders is all it says; no word on whether technical folks attend."]) check(`76 lets through: ${s}`, inventedClaim(s) === null);

// Case 81: assuming they went is a miss; their own Monday, or a neutral "did you end up going", is not.
for (const s of ["How was Makers Night?", "How did the event go?", "Did you enjoy Makers Night?", "Glad you went."]) check(`81 catches: ${s}`, hits(ASSUMES_WENT, s));
for (const s of ["How did you get through it?", "Did you end up going to Makers Night?", "Glad you made it through Monday.", "How was the rest of it?"]) check(`81 lets through: ${s}`, !hits(ASSUMES_WENT, s));

// Case 82: tips promised for later is a miss; tips given now, whatever the framing, are not.
for (const s of ["I'll send you some tips tonight.", "Rest up, I'll put together a few pointers.", "Happy to share tips tomorrow."]) check(`82 catches: ${s}`, hits(TIPS_LATER, s));
for (const s of ["Before Thursday, a few tips: ask what they'd build first.", "Tips for Thursday: show them the hardest bug you've hit.", "Later in the coffee, ask what they'd want to own."]) check(`82 lets through: ${s}`, !hits(TIPS_LATER, s));

// Case 77: names Cue introduces as made up in a labeled hypothetical are given (Royce, 2026-11-11); a name with no label is still checked.
const SCENE = "Say it's a Noise dinner next month. Two guests, call them Dana and Priya, both RSVP yes. Dana says yes to both, Priya says yes to the ask but no to her name.\nThe morning of, Dana texts me and Priya shares her location for the event. Say I tell Dana that Priya's working on something close.";
const noted = (text: string, facts = "Works on the Noise team (partnerships).") => inventedFacts({ text, kind: "reply", facts, theirLines: [], coLines: [] });
check("77 lets through: the recorded scenario (call them Dana and Priya)", noted(SCENE).length === 0);
for (const s of ["Let's say Ana and Bo meet at a dinner. Ana asks for an intro to Bo.", "Imagine Theo RSVPs. Theo tells me he's here.", "A founder named Ines asks for an intro, and Ines says yes.", "Say Mara and Jun both want to meet. Mara texts first."]) check(`77 lets through: ${s}`, noted(s).length === 0);
for (const s of ["Dana from the dinner said she'd love to meet you.", "Priya will be at the mixer tonight at 7pm.", "Say I tell Marcus about it, he'll come to the dinner."]) check(`77 still catches: ${s}`, noted(s).length > 0);
check("77: 'Say I tell Marcus' introduces nobody", hypotheticalNames("Say I tell Marcus about it.").length === 0);
// Case 76: a weekday's short form is the weekday (services/offerGuard.ts), so "Wed Oct 21" stands on "Wednesday Oct 21".
const SUPPER = "Founders Supper https://example.test/founders-supper Wednesday Oct 21, 7pm, SoMa. Today is Tuesday, October 13, 2026.";
for (const s of ["There's a Founders Supper on Wed Oct 21, 7pm in SoMa.", "There's a Founders Supper on Wed, Oct 21 at 7pm.", "Founders Supper, Wednesday Oct 21 at 7pm."]) check(`76 lets through: ${s}`, noted(s, SUPPER).length === 0);
for (const s of ["There's a Founders Supper on Wed Oct 21 at Zeitgeist.", "There's a Founders Supper on Wed Oct 21, 9pm in SoMa."]) check(`76 still catches: ${s}`, noted(s, SUPPER).length > 0);
// The second reply (#444): when they asked, a second text with new content goes; a repeat or a second offer is a miss; a share stays one.
const R = (...t: string[]) => t.map((text) => ({ kind: "reply" as const, text }));
check("73/74: a continuing second text after an ask passes", repliesPerTurn(R("Tonight at 6:30, a brewery hall in the Mission. Three 15-minute talks.", "It's built more for learning than pitching, talks first."), [], "What's the details and why it fits?").length === 0);
check("83: a second offer after an offer is a miss", repliesPerTurn(R("Nothing's running on that right now. Want me to start on it?", "If you want, I can start looking, whether that's events or something toward the founding engineer search."), [], "Anything new worth my time this week?").length === 1);
check("a second text that repeats the first is a miss", repliesPerTurn(R("Gradient Reading Club, Thursday 7pm in SoMa.", "Gradient Reading Club, Thursday 7pm in SoMa."), [], "Which one should I go to?").length === 1);
check("a share (no ask) still gets one reply", repliesPerTurn(R("Full budget. That's a real win, Julian.", "Go sleep it off. You earned it."), [], "We got the full budget approved").length === 1);
check("no message given: the old one-reply rule", repliesPerTurn(R("One.", "Two more things here."), []).length === 1);

// Case 82 (audit): an offer to check in after the coffees isn't tips promised for later.
for (const s of ["I'll check in after Thursday to hear how it went.", "I'll follow up after your coffees.", "Good luck Thursday, I'll be around if you want to debrief."]) check(`82 lets through: ${s}`, !hits(TIPS_LATER, s));
check("82 still catches: I'll follow up with a few questions to ask them", hits(TIPS_LATER, "I'll follow up with a few questions to ask them."));
// Times (audit, case 86): a read's 24-hour time backs the same time said the usual way; a different time is still flagged.
const READ = "SGLang x NVIDIA Meetup: when: starts 2026-10-13T17:30, ends 2026-10-13T20:30.";
check("86 lets through: tonight 5:30 to 8:30", noted("SGLang x NVIDIA Meetup, tonight 5:30 to 8:30.", READ).length === 0 && noted("SGLang x NVIDIA Meetup starts at 5:30pm.", READ).length === 0);
check("86 still catches: a time the read doesn't have", noted("SGLang x NVIDIA Meetup, tonight 6:30 to 8:30.", READ).length > 0);
// Link then caption and #444 (audit): the shapes the standard set wants pass every hard rule.
const H = (sends: { kind: "reply" | "find" | "link"; text: string }[], message: string, findUrls: string[] = [], facts = "") => hardRuleMisses({ text: sends.map((x) => x.text).join("\n"), sends, tools: [], kind: "reply", facts, theirLines: [message], coLines: [], findUrls, message });
const VEL = "https://example.test/vellum-wine-room";
check("79: link, caption, 'Enjoy tonight.'", H([{ kind: "find", text: VEL }, { kind: "find", text: "Vellum Wine Room on Hayes Street, natural wine, walk-ins only." }, { kind: "reply", text: "Enjoy tonight." }], "know a low key wine spot near Hayes Valley for tonight?", [VEL], "Vellum Wine Room Hayes Street Hayes Valley natural wine walk-ins").length === 0);
check("73: the pick's link alone, then the reply", H([{ kind: "link", text: "https://example.test/gradient-reading-club" }, { kind: "reply", text: "Gradient Reading Club, Thursday 7pm. It beats the other two for you." }], "What's the best option for me this week?", [], "Gradient Reading Club Thursday 7pm https://example.test/gradient-reading-club").length === 0);
check("74: a continuing second text after their question", H([{ kind: "reply", text: "Tonight at 6:30, a brewery hall in the Mission." }, { kind: "reply", text: "It's built more for learning than pitching." }], "What's the details and why it fits?", [], "Tonight 6:30 brewery hall Mission").length === 0);
check("a link sent twice in a row is still a miss", H([{ kind: "link", text: VEL }, { kind: "find", text: VEL }, { kind: "find", text: "Vellum Wine Room." }], "send it again?", [VEL], "Vellum Wine Room").length > 0);

console.log(`standard exchange matchers: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
