// Probes for the standard exchanges' code checks (evals/golden/standardMatchers.ts): each matcher catches the failure its case was
// written against and lets the honest version of the reply through (review of #454: honest limits were being failed). Layer 1, no model.
import { ASSUMES_WENT, EVENT_UNCONFIRMED, TIPS_LATER, inventedClaim } from "./standardMatchers.js";

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

console.log(`standard exchange matchers: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
