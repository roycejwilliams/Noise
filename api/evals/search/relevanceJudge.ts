// Live eval for the Tier 2 relevance judge's audience-vs-activity boundary
// (services/tieredRecommendation.ts's isGenuinelyRelevant).
//
//   npx tsx evals/search/relevanceJudge.ts
//
// Royce, 2026-09-17: "even for Luma there's events I see all the time for
// builder and founders on the app. Why aren't we reaching that with our
// users stated ask" — the judge was rejecting real founder/builder events
// on event FORMAT alone (a pitch night, a demo night, a work session all
// came back "not a meetup"). Fixed by splitting the fit test: an ACTIVITY
// ask (chess, pottery) still needs the event's own activity to match; a
// PEOPLE/AUDIENCE ask (founders, builders) now asks whether that audience
// is the point of the event, not whether it's literally labeled "meetup."
//
// Unlike evals/search/run.ts, these descriptions are hand-written, not
// pulled from today's live Luma feed — the guardrail this protects
// (audience-loosening must not leak into unrelated activity asks) needs to
// be tested the same way every day, and a real founder-heavy event isn't
// guaranteed to exist in the feed on any given day to test against.
import "dotenv/config";
import { isGenuinelyRelevant } from "../../src/services/tieredRecommendation.js";
import { runEval, type CaseScore, type EvalCase } from "../lib.js";

type Case = EvalCase & { ask: string; name: string; description: string; expectFit: boolean };

// Both "should reject" cases are deliberately written to be as tempting as
// possible — packed with the audience the ask names — specifically to
// stress whether audience-loosening leaks into an unrelated activity ask.
const cases: Case[] = [
  {
    id: "r01_chess_ask_rejects_founder_pitch_night",
    ask: "chess night",
    name: "Founders & Builders Pitch Night",
    description: "Join fellow founders and builders for an evening of 2-minute pitches, feedback, and networking over drinks. Bring your deck or just come to watch and meet other people building things.",
    expectFit: false,
  },
  {
    id: "r02_pottery_ask_rejects_founder_mixer",
    ask: "pottery class",
    name: "Builder Community Mixer",
    description: "A casual mixer for founders, engineers, and builders in SF to meet each other, swap notes on what they're working on, and make new connections in the startup scene.",
    expectFit: false,
  },
  {
    id: "r03_chess_ask_accepts_real_chess_night",
    ask: "chess night",
    name: "SF Chess Social",
    description: "Casual chess night open to all levels. Bring a board or use ours. Beer and snacks provided. No tournament, just chess and conversation.",
    expectFit: true,
  },
  {
    id: "r04_founder_ask_accepts_demo_night",
    ask: "founder meetup",
    name: "Side-Project Demo Night",
    description: "Founders and builders show off what they've been working on this month. Short demos, no slides required, just show your screen and talk about what you built.",
    expectFit: true,
  },
  {
    id: "r05_founder_ask_accepts_pitch_night",
    ask: "founder meetup",
    name: "Hardware Pitch Night",
    description: "Hardware founders pitch their startups to a room of other builders and a few investors. Q&A after each pitch, drinks and mingling to follow.",
    expectFit: true,
  },
];

async function run(c: Case) {
  return isGenuinelyRelevant(c.ask, c.name, "San Francisco", c.description);
}

function score(c: Case, verdict: Awaited<ReturnType<typeof run>>): CaseScore {
  const hard: string[] = [];
  if (verdict.fit !== c.expectFit) {
    hard.push(`ask="${c.ask}" event="${c.name}" -> fit=${verdict.fit} (expected ${c.expectFit}); why="${verdict.why}"`);
  }
  return { hard, soft: [{ name: "fit matched expectation", ok: verdict.fit === c.expectFit }] };
}

runEval({ name: "search/relevanceJudge", dir: "evals/search", cases, run, score }).then(({ hard }) => {
  if (hard > 0) process.exitCode = 1;
});
