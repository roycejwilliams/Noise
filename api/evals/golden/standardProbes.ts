// Probes for the standard exchanges' code checks (evals/golden/standardMatchers.ts): each matcher catches the failure its case was
// written against and lets the honest version of the reply through (review of #454: honest limits were being failed). Layer 1, no model.
import { ASSUMES_WENT, EVENT_UNCONFIRMED, TIPS_LATER, inventedClaim } from "./standardMatchers.js";
import { hypotheticalNames, inventedFacts, repliesPerTurn } from "../lib/hardRules.js";

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

console.log(`standard exchange matchers: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
