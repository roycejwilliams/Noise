// The send-time read on real model calls (Royce, 2026-11-09): does harness/momentFit.ts judge a hard day the way the ruling means it?
// "A hard-day read is a reason to be more thoughtful, not a blanket reason to go silent." The same queued offer (a relevant event three
// days out) meets a calm deliberation, real distress, grief, a find they asked for, a stale event and an ordinary good day; each
// verdict is checked against the range it should fall in. Invented names only.
//
//   npm run evals:momentfit:quality -- --estimate     what a run would cost, no call (free)
//   npm run evals:momentfit:quality                   the real run, metered and capped (evals/lib/meter.mjs), run by Royce
//
// One Haiku call per scenario that reaches the read (6), the prompt exactly as the dispatch builds it (momentPrompt via momentFit).
import "../lib/requireMeter.js";
import { HARD_DAY_LINE, momentFit, momentFitApplies, momentPrompt, type MomentVerdict } from "../../src/harness/momentFit.js";

type Verdict = MomentVerdict["verdict"];
type Scenario = { id: string; what: string; recent: string; message: string; hardDay: boolean; cls: "unsolicited" | "requested"; accept: Verdict[]; never?: Verdict[] };

const NOW = new Date("2026-11-09T22:00:00Z"); // Monday 2pm in LA
const QUEUED = new Date("2026-11-09T16:00:00Z");
// The queued offer: a relevant event three days out (Thursday 11-12).
const OFFER = "https://lu.ma/builders-supper\nA builders' supper this Thursday (Nov 12), twelve founders around one table, for the cofounder search you mentioned.";
// The stale one: the same kind of find, for an event that was last Saturday.
const STALE = "https://lu.ma/founder-brunch\nA founder brunch on Saturday (Nov 7), small and mostly technical people, for the cofounder search you mentioned.";

export const SCENARIOS: Scenario[] = [
  {
    id: "calm_deliberation",
    what: "calm deliberation about a business decision (a hard-day read that was really someone thinking it through)",
    recent: "[Mon 9:10am] User said: Weighing whether to bring on a technical cofounder or keep going solo for now. Not urgent, just thinking it through.\n[Mon 9:12am] Cue said: Both are real options. What would a cofounder take off your plate?\n[Mon 9:40am] User said: The backend mostly. I'd like to meet a couple of people before I decide anything.",
    message: OFFER,
    hardDay: true,
    cls: "unsolicited",
    accept: ["send"],
  },
  {
    id: "genuine_distress",
    what: "genuine distress (overwhelmed, can't sleep)",
    recent: "[Mon 2:05am] User said: I can't sleep. Everything is piling up at once and I feel like I'm drowning.\n[Mon 2:07am] Cue said: That's a lot to carry at 2am. I'm here.\n[Mon 2:15am] User said: I just need it all to stop for a bit. I haven't slept properly in days.",
    message: OFFER,
    hardDay: true,
    cls: "unsolicited",
    accept: ["wait", "drop"],
    never: ["send"],
  },
  {
    id: "grief",
    what: "grief (a parent died last week)",
    recent: "[Tue 8:30pm] User said: My dad passed away on Thursday. The funeral was Saturday.\n[Tue 8:32pm] Cue said: I'm so sorry, Ellis. That's a huge loss.\n[Sun 10:00am] User said: Still pretty numb. Taking it a day at a time.",
    message: OFFER,
    hardDay: true,
    cls: "unsolicited",
    accept: ["wait", "drop"],
    never: ["send"],
  },
  {
    id: "requested_during_distress",
    what: "a find they asked for, during distress: never read, it goes as asked (code path, no model call)",
    recent: "[Sun 9:00pm] User said: Can you find me a builders' dinner this week? I need to get out of my own head.\n[Mon 2:05am] User said: Rough night. Can't sleep.",
    message: OFFER,
    hardDay: true,
    cls: "requested",
    accept: ["send"],
  },
  {
    id: "stale_event",
    what: "a stale event (already past)",
    recent: "[Mon 9:10am] User said: Still looking for a technical cofounder, open to meeting people this month.",
    message: STALE,
    hardDay: true,
    cls: "unsolicited",
    accept: ["drop"],
    never: ["send"],
  },
  {
    id: "good_day",
    what: "an ordinary good day (no hard-day read: shown for the read's baseline)",
    recent: "[Mon 11:00am] User said: Good week so far, shipped the new onboarding. Still keen to meet a technical cofounder.\n[Mon 11:02am] Cue said: Congrats on shipping it.",
    message: OFFER,
    hardDay: false,
    cls: "unsolicited",
    accept: ["send"],
  },
  {
    id: "frustrated_not_distressed",
    what: "venting about a frustrating day, then asking about people to meet",
    recent: "[Mon 1:00pm] User said: Ugh, investor call went badly, they didn't get it at all.\n[Mon 1:01pm] Cue said: That's frustrating after the prep you put in.\n[Mon 1:20pm] User said: Whatever, their loss. Honestly I just want to find a cofounder who gets it.",
    message: OFFER,
    hardDay: true,
    cls: "unsolicited",
    accept: ["send", "wait"],
    never: ["drop"],
  },
];

// Haiku 5.5 list prices, USD per million tokens (evals/lib/meter.mjs PRICE.haiku).
const PRICE = { input: 0.1, output: 0.5 };
const MAX_OUT = 150; // momentFit's maxOutputTokens
const reads = SCENARIOS.filter((s) => s.cls !== "requested");
const promptOf = (s: Scenario) => momentPrompt({ firstName: "Ellis", message: s.message, recent: s.recent, call: null, queuedAt: QUEUED, now: NOW, hardDay: s.hardDay, queued: [] });

if (process.argv.includes("--estimate")) {
  let usd = 0;
  let tokens = 0;
  for (const s of reads) {
    // The meter reserves (whole request JSON / 3.5) in and max_tokens out per call: this is that worst case.
    const inTok = Math.ceil((promptOf(s).length + 400) / 3.5);
    const cost = (inTok * PRICE.input + MAX_OUT * PRICE.output) / 1e6;
    usd += cost;
    tokens += inTok + MAX_OUT;
    console.log(`  ${s.id.padEnd(28)} ~${inTok} in + ${MAX_OUT} out (worst case) = $${cost.toFixed(5)}`);
  }
  console.log(`momentFit quality estimate: ${reads.length} model reads (${SCENARIOS.length - reads.length} code-only), ~${tokens.toLocaleString()} tokens worst case, $${usd.toFixed(4)}. Suggested caps (10x): EVAL_TOKEN_CAP=${Math.ceil((tokens * 10) / 1000) * 1000} EVAL_COST_CAP_USD=${Math.max(0.01, Math.ceil(usd * 10 * 100) / 100).toFixed(2)}`);
  process.exit(0);
}

let bad = 0;
for (const s of SCENARIOS) {
  // A find they asked for is never read: the dispatch sends it as asked (momentFitApplies is false for "requested").
  if (s.cls === "requested") {
    const read = momentFitApplies(s.cls, { askId: "a1" }, { type: "event_offer", hardDay: s.hardDay });
    const ok = !read;
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} ${s.id}: ${read ? "would be read (wrong)" : "not read: goes as asked"}`);
    continue;
  }
  if (s.hardDay && !promptOf(s).includes(HARD_DAY_LINE)) {
    bad++;
    console.log(`FAIL ${s.id}: the hard-day line is missing from the prompt`);
    continue;
  }
  const v = await momentFit({ userId: "eval-moment-quality", firstName: "Ellis", message: s.message, recent: s.recent, call: { ready: true, line: null }, queuedAt: QUEUED, now: NOW, kind: "event_offer", hardDay: s.hardDay, queued: [] });
  const ok = v.read === "model" && s.accept.includes(v.verdict) && !(s.never ?? []).includes(v.verdict);
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${s.id}: ${v.verdict} (${v.read}) "${v.why}" [accepts ${s.accept.join("/")}]`);
}
const spend = (globalThis as any).__EVAL_METER_SPEND__?.();
console.log(`momentFit quality: ${SCENARIOS.length - bad}/${SCENARIOS.length} in range${spend ? ` | spent $${Number(spend.cost ?? 0).toFixed(4)} of $${Number(spend.capUsd).toFixed(2)}` : ""}`);
if (bad) process.exitCode = 1;
