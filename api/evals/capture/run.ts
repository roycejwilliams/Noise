// Ask capture eval (profileExtraction.captureIntentPrompt), live: what
// counts as an ask. 2026-09-15: nearly every message in Royce's thread
// opened or rewrote an ask, including "your messaging seems smoother" and
// "how can your model improve", and those fed the sweep and matching.
//
// 2026-09-20: the same prompt now runs for both channels, with `scope`
// saying how much of the transcript is new (see IntentScope). Cases carry
// the scope they're run under — the "last_user_message" ones pin the text
// turn's unchanged behaviour, the "whole_transcript" ones pin that a call
// keeps an ask stated in its first 30 seconds even when it ends on
// logistics (the 2026-09-19 call, where the whole call captured nothing).
//
//   npx tsx evals/capture/run.ts
//
// Hard: an ask captured from something that isn't one, a real ask missed,
// a text turn yielding more than one ask, or an ask attributed to Co.
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { loadCases, runEval, type EvalCase } from "../lib.js";
import {
  captureIntentPrompt,
  normalizeCapturedAsks,
  type CapturedAsk,
  type IntentScope,
} from "../../src/services/profileExtraction.js";
import { parseModelJson } from "../../src/services/modelJson.js";
import { MODELS } from "../../src/models.js";

type Case = EvalCase & {
  transcript: string;
  // How many asks this transcript should yield. `expectAsk` is the older
  // boolean form, still read from cases.local.json / cases.synthetic.json.
  expectAsk?: boolean;
  expectAsks?: number;
  scope?: IntentScope;
  // Substrings that must appear across the captured asks (case-insensitive).
  mustMention?: string[];
  // Substrings that must NOT appear — mostly things only Co said.
  mustNotMention?: string[];
};
const here = dirname(fileURLToPath(import.meta.url));

const T = (...lines: string[]) => lines.join("\n");
const thread = T(
  "user: Been looking at joining an accelerator. Maybe pre-seed accelerator.",
  "assistant: I don't have enough on where you're at to size that up.",
  "user: We are a series A company, building AI infrastructure for B2B companies. We recently landed a 35 million dollar deal on a team of 8",
  "assistant: What you're more likely to need now is Series A rooms, investors, and operators. Worth me thinking in that direction?",
);

// A call shaped like the real 2026-09-19 one: the ask lands in the first
// exchange, the member drifts through other subjects, and the last thing
// they say is pure logistics.
const callAskEarlyLogisticsLast = T(
  "assistant: Hey Royce — glad we're finally talking. What's actually going on in your life right now?",
  "user: Hey yeah i'm a founder ah i'm just looking for other people to kinda build with ah just moved from texas um preferably i'm looking for. Who are in x google xstripe or xmeta and yeah.",
  "assistant: So you're a founder who's just moved from Texas and is looking for collaborators — people who've come out of places like Google, Stripe, or Meta. What are you working on?",
  "user: So i'm actually building you ah i've been building it for around five months now ah i've been leading the development at this point.",
  "assistant: Five months in — where are you at with that? What does traction look like right now?",
  "user: Ah, currently we are wanting to host the event october tenth to actually put it in front of users.",
  "assistant: What can you offer someone like that in return? Like when they show up, what do they get from knowing you?",
  "user: Hey, i'm actually just going to text you to rest. We can just pick up from there.",
  "assistant: Okay, Royce. Text me when you're ready to pick this back up.",
);

const synthetic: Case[] = [
  // --- text turn: only the last user message is new (unchanged behaviour)
  { id: "c01_smoother", transcript: T(thread, "user: Your messaging seems a lot smoother"), expectAsks: 0 },
  { id: "c02_model_improve", transcript: T(thread, "user: How else do you think your model can be improved?"), expectAsks: 0 },
  { id: "c03_anything_to_ask", transcript: T(thread, "user: Anything you need to ask me?"), expectAsks: 0 },
  { id: "c04_new_number", transcript: T(thread, "user: I got a new number"), expectAsks: 0 },
  { id: "c05_answer_about_self", transcript: T(thread, "assistant: When you picture someone worth building with, what are they like?", "user: Cool, calm, collected. Urgency is important. Also someone who can see a life beyond just the computer"), expectAsks: 0 },
  { id: "c06_point_me", transcript: T(thread, "user: Yeah definitely, point me in the right direction"), expectAsks: 1 },
  { id: "c07_friends", transcript: T(thread, "user: In the mean time, I want to look for some friends"), expectAsks: 1 },
  { id: "c08_thanks", transcript: T(thread, "user: Cool."), expectAsks: 0 },
  // A text turn only ever opens one ask, even when the history is full of
  // older ones — that's what keeps captureIntentForTurn's reply honest.
  {
    id: "c09_text_turn_history_not_reharvested",
    transcript: T(thread, "user: In the mean time, I want to look for some friends"),
    expectAsks: 1,
    mustNotMention: ["accelerator"],
  },
  // Logistics is still logistics on the text side.
  { id: "c10_text_logistics", transcript: T(thread, "user: Cool, I'll text you the rest later. Thanks!"), expectAsks: 0 },

  // --- call: the whole transcript is new
  {
    id: "v01_call_ask_early_logistics_last",
    transcript: callAskEarlyLogisticsLast,
    scope: "whole_transcript",
    expectAsks: 1,
    mustMention: ["build"],
  },
  {
    id: "v02_call_keeps_the_named_companies",
    transcript: callAskEarlyLogisticsLast,
    scope: "whole_transcript",
    expectAsks: 1,
    // "ex-Google / Stripe / Meta" is the whole point of the ask — an ask
    // that drops it isn't the ask they made.
    mustMention: ["google", "stripe", "meta"],
  },
  {
    id: "v03_call_does_not_invent_cos_offer_question",
    transcript: callAskEarlyLogisticsLast,
    scope: "whole_transcript",
    expectAsks: 1,
    // Co asked "what can you offer them in return?" and the member never
    // answered — that must not become an "offering" ask.
    mustNotMention: ["in return"],
  },
  {
    id: "v04_call_two_distinct_asks",
    transcript: T(
      "assistant: What's going on with you right now?",
      "user: I'm looking for a running group — I used to run with one in Austin and I miss it.",
      "assistant: Got it. Anything else on your mind?",
      "user: Also I can help other founders with fundraising, I've raised twice. Happy to offer that.",
      "assistant: Noted. Anything else?",
      "user: That's it, I'll text you later. Thanks.",
    ),
    scope: "whole_transcript",
    expectAsks: 2,
    mustMention: ["running", "fundrais"],
  },
  {
    id: "v05_call_all_smalltalk_yields_nothing",
    transcript: T(
      "assistant: Hey, how's it going?",
      "user: Good, good. Just got back from the gym.",
      "assistant: Nice. Anything you want me working on?",
      "user: Not really. Honestly this is pretty cool, your voice sounds good.",
      "assistant: Appreciated.",
      "user: Cool, I'll text you later.",
    ),
    scope: "whole_transcript",
    expectAsks: 0,
  },
];

const expectedCount = (c: Case): number => c.expectAsks ?? (c.expectAsk ? 1 : 0);

await runEval<Case, { asks: CapturedAsk[] }>({
  name: "ask capture (live)",
  dir: here,
  cases: [...loadCases<Case>(here), ...synthetic],
  concurrency: 4,
  run: async (c) => {
    const scope = c.scope ?? "last_user_message";
    const { text } = await generateText({ model: anthropic(MODELS.haiku), prompt: captureIntentPrompt(c.transcript, scope) });
    return { asks: normalizeCapturedAsks(parseModelJson(text), scope) };
  },
  score: (c, r) => {
    const want = expectedCount(c);
    const hard: string[] = [];
    const joined = r.asks.map((a) => a.text).join(" | ").toLowerCase();
    if (want === 0 && r.asks.length) hard.push(`captured an ask from a non-ask: ${JSON.stringify(r.asks)}`);
    if (want > 0 && !r.asks.length) hard.push("missed a real ask");
    if ((c.scope ?? "last_user_message") === "last_user_message" && r.asks.length > 1) {
      hard.push(`a text turn yielded ${r.asks.length} asks: ${JSON.stringify(r.asks)}`);
    }
    for (const m of c.mustNotMention ?? []) {
      if (joined.includes(m.toLowerCase())) hard.push(`ask contains something the member never asked for: "${m}" in ${JSON.stringify(r.asks)}`);
    }
    const soft = [
      ...(want > 0 ? [{ name: "right number of asks", ok: r.asks.length === want }] : []),
      ...(c.mustMention ?? []).map((m) => ({ name: `mentions "${m}"`, ok: joined.includes(m.toLowerCase()) })),
    ];
    return { hard, soft };
  },
});
