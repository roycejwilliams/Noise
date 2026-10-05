// Live check of payload first's read (harness/payloadFirst.ts): real proactive
// drafts, each with whether Co should do the work instead of asking. Uses the
// Anthropic key (about $0.05 a run); no database, nothing sent.
//   npx tsx evals/payloadFirst/run.ts
import "dotenv/config";
import { decidePayloadFirst, readOffer, theirText } from "../../src/harness/payloadFirst.js";

type Case = { name: string; draft: string; recent: string[]; ask?: string; doIt: boolean };
const U = (s: string) => `User said: ${s}`;
const C = (s: string) => `Co replied: ${s}`;

const cases: Case[] = [
  // Co could do it: deliver, don't ask.
  { name: "caterer options", draft: "Hey Jordan! Still want those caterer options for Friday?", recent: [U("I need a caterer for 60 people by Friday, something casual"), C("On it. Any budget?"), U("under 40 a head")], doIt: true },
  { name: "dig into a fit", draft: "Want me to dig into whether Pitch Protocol would fit as an accelerator or VC lead instead?", recent: [U("can you look into Pitch Protocol for me, we're raising a pre-seed"), C("Pitch Protocol runs demo nights for early founders.")], doIt: true },
  { name: "pull venues", draft: "Should I pull a few venues in SoMa that hold 60 for the launch?", recent: [U("we're doing a launch party in SoMa, about 60 people, late October")], doIt: true },
  { name: "older ask, check-in", draft: "Still looking for a photographer for the launch, or did you find one?", recent: [U("can you find me a photographer for the launch party"), C("On it."), C("Good luck with the board meeting today!")], ask: "a photographer for the launch party", doIt: true },
  // Drafting and shortlisting stay questions until a task is shown to deliver them.
  { name: "draft the outreach (stays a question for now)", draft: "Want me to put together a draft of the note to the venue so you can look it over?", recent: [U("I need to reach out to the Midway about hosting our event but I hate writing these")], doIt: false },
  { name: "shortlist (stays a question for now)", draft: "Want me to narrow those five coworking spots down to the two that fit best?", recent: [U("here are the coworking spaces I'm looking at: Canopy, WeWork Mission, Covo, Shack15, The Laundry"), U("I want somewhere quiet near BART")], doIt: false },
  // Questions that stay questions.
  { name: "pitch practice (theirs)", draft: "Did you get a chance to run through your pitch out loud yet?", recent: [U("I should practice my pitch before Thursday")], doIt: false },
  { name: "intro (visible)", draft: "Want me to introduce you to Maya? She's raising too.", recent: [U("I want to meet other founders raising right now")], doIt: false },
  { name: "booking (irreversible)", draft: "Want me to book the table at Nopa for Saturday at 7?", recent: [U("Nopa Saturday looks perfect for the team dinner")], doIt: false },
  { name: "email in their name (visible)", draft: "Should I send the note to the venue now?", recent: [U("the draft looks good"), C("Here's the note to the Midway: ...")], doIt: false },
  { name: "how did it go (only they know)", draft: "How was the founder dinner last night? Meet anyone good?", recent: [U("heading to the founder dinner tonight")], doIt: false },
  { name: "companion check-in", draft: "How's the move settling in? Still living out of boxes?", recent: [U("just moved into the new place, total chaos")], doIt: false },
  { name: "no question", draft: "Three caterers that fit 60 by Friday: Señor Sisig, Tacolicious and Mixt.", recent: [U("I need a caterer for 60 people by Friday")], doIt: false },
  { name: "what do you want (only they know)", draft: "What would make the launch feel like a win for you?", recent: [U("launch is in two weeks")], doIt: false },
];

let right = 0;
const wrong: string[] = [];
for (const c of cases) {
  const recent = c.recent.join("\n");
  const read = await readOffer(c.draft, recent, [], c.ask ?? null);
  const d = decidePayloadFirst(read, c.draft, theirText(recent), []);
  const ok = d.handOff === c.doIt;
  if (ok) right++;
  else wrong.push(`${c.name}: wanted ${c.doIt ? "do it" : "ask"}, got ${d.handOff ? "do it" : "ask"} (${d.why}; read ${read?.kind}, words "${read?.theirWords ?? ""}")`);
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}: ${d.handOff ? `do it: ${d.work}` : `ask (${d.why})`}`);
}
console.log(`\npayload first live: ${right}/${cases.length}`);
wrong.forEach((w) => console.log("  " + w));
if (right < cases.length) process.exitCode = 1;
