// Model-free checks for ask capture (services/profileExtraction.ts's
// captureIntentPrompt + normalizeCapturedAsks, 2026-09-20). No API calls,
// no database:
//   npx tsx evals/capture/rules.ts
//
// What these pin, and why:
//
// A call on 2026-09-19 opened with "i'm a founder... looking for other
// people to kinda build with... preferably people who are ex-Google,
// ex-Stripe or ex-Meta" and ended on "i'm actually just going to text you
// the rest" (logistics). captureIntent ran the LAST-user-message rule over
// the whole call transcript, so it captured nothing at all and the member's
// real ask was silently lost. The fix is one shared mechanism with a scope
// that says how much of the transcript is new — these checks make sure that
// scope keeps meaning what it means, on both sides:
//
//   whole_transcript   must tell the model to take asks from anywhere and
//                      must NOT carry the last-message rule
//   last_user_message  must keep the last-message rule, and the parser must
//                      hard-cap a text turn at one ask no matter what the
//                      model returns
//
// evals/capture/run.ts is the live half (does the model actually do it);
// this half is the part that can't cost anything or flake.
import { captureIntentPrompt, normalizeCapturedAsks } from "../../src/services/profileExtraction.js";
import { getOpenAsksOfType } from "../../src/services/matching.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const transcript = "assistant: what's going on?\nuser: looking for ex-Stripe engineers to build with\nuser: anyway I'll text you the rest";
const turnPrompt = captureIntentPrompt(transcript);
const callPrompt = captureIntentPrompt(transcript, "whole_transcript");

// --- one mechanism, not two prompts
check("both scopes come from the same prompt builder", turnPrompt.includes("extract four things") && callPrompt.includes("extract four things"));
for (const [name, p] of [["turn", turnPrompt], ["call", callPrompt]] as const) {
  check(`${name}: the transcript is actually in the prompt`, p.includes(transcript));
  check(`${name}: asks come back as a list`, /"asks"\s*:\s*\[/.test(p));
  check(`${name}: says to use [] when there's no ask`, /\[\]/.test(p));
  // Guardrails that predate the scope split and must survive it.
  check(`${name}: only what the user actually said`, /"user:" lines/.test(p) && /never guess or infer/.test(p));
  check(`${name}: never attribute Cue's words to the member`, /"assistant:" lines/.test(p));
  check(`${name}: a question Cue asked is not an ask`, /never answered is not an ask/.test(p));
  check(`${name}: small talk / thanks / logistics are not asks`, /small talk/.test(p) && /thanks/.test(p) && /logistics/.test(p));
  check(`${name}: feedback about Cue is not an ask`, /feedback about Cue/.test(p));
  check(`${name}: answering Cue's questions is not an ask`, /answers to Cue's questions/.test(p));
  check(`${name}: still asks for concrete_preferences, wants and availability`, p.includes("concrete_preferences") && p.includes("wants") && p.includes("availability"));
  check(`${name}: a one-off meeting time is not an availability pattern`, /NOT a recurring availability pattern/.test(p));
}

// --- the scopes differ, and differ in the right direction
check("text turn keeps the LAST-user-message rule", /LAST user message/.test(turnPrompt));
check("text turn asks for at most one ask", /at most one ask/.test(turnPrompt));
check("a call does NOT carry the last-message rule", !/LAST user message/.test(callPrompt));
check("a call asks for every distinct ask", /EVERY distinct ask/.test(callPrompt));
check("a call takes asks stated early too", /moved on from/.test(callPrompt));
// This sentence is the actual 2026-09-19 regression, written down.
check("a call says the last thing said never cancels an earlier ask", /never cancels an ask they stated earlier/.test(callPrompt));
check("a call names ending-on-logistics as the case that still carries asks", /text you the rest/.test(callPrompt));
check("a call folds restatements into one ask", /same request are one ask/.test(callPrompt));
check("the two scopes really do produce different prompts", turnPrompt !== callPrompt);

// --- normalizeCapturedAsks: what actually gets written
const two = { asks: [{ text: "Looking for ex-Stripe engineers", type: "seeking" as const }, { text: "Can help founders fundraise", type: "offering" as const }], concrete_preferences: [], wants: [], availability: null };

check("a call can write more than one ask", normalizeCapturedAsks(two, "whole_transcript").length === 2);
check("a text turn is hard-capped at one ask", normalizeCapturedAsks(two, "last_user_message").length === 1);
check("the text turn keeps the FIRST ask returned", normalizeCapturedAsks(two, "last_user_message")[0].text === "Looking for ex-Stripe engineers");
check("last_user_message is the default scope", normalizeCapturedAsks(two).length === 1);
check("types survive normalization", normalizeCapturedAsks(two, "whole_transcript").map((a) => a.type).join(",") === "seeking,offering");

check("no asks means no records", normalizeCapturedAsks({ asks: [], concrete_preferences: [], wants: [], availability: null }, "whole_transcript").length === 0);
check("null parse means no records", normalizeCapturedAsks(null, "whole_transcript").length === 0);
check("a null asks field means no records", normalizeCapturedAsks({ asks: null, concrete_preferences: [], wants: [], availability: null }, "whole_transcript").length === 0);

// Junk from the model never becomes an ask row.
const junk = { asks: [{ text: "", type: "seeking" as const }, { text: "   ", type: "seeking" as const }, { text: "real one", type: "sideways" as any }, { text: "no type" } as any, { type: "seeking" as const } as any], concrete_preferences: [], wants: [], availability: null };
check("blank / untyped / wrongly-typed asks are dropped", normalizeCapturedAsks(junk, "whole_transcript").length === 0);
check("ask text is trimmed", normalizeCapturedAsks({ asks: [{ text: "  spaced out  ", type: "seeking" }], concrete_preferences: [], wants: [], availability: null }, "whole_transcript")[0].text === "spaced out");

// One conversation that says the same thing twice is one ask row, not two —
// the DB-level dedupe (decideAskWrite) is the backstop, not the first line.
const dupes = { asks: [{ text: "Looking for ex-Stripe engineers", type: "seeking" as const }, { text: "looking for EX-STRIPE engineers", type: "seeking" as const }], concrete_preferences: [], wants: [], availability: null };
check("the same ask twice in one pass is one ask", normalizeCapturedAsks(dupes, "whole_transcript").length === 1);

// A runaway pass (every answer read as a request) gets capped, not written.
const many = { asks: Array.from({ length: 12 }, (_, i) => ({ text: `ask number ${i}`, type: "seeking" as const })), concrete_preferences: [], wants: [], availability: null };
check("a runaway call capture is capped (8: a discovery call can carry goals and asks)", normalizeCapturedAsks(many, "whole_transcript").length === 8);

// The pre-2026-09-20 single-ask JSON shape still parses, so a model reply
// that falls back to the old key isn't silently dropped.
const legacy = { ask: { text: "Looking for a running group", type: "seeking" as const }, concrete_preferences: [], wants: [], availability: null };
check("legacy single-ask JSON still yields its ask", normalizeCapturedAsks(legacy, "whole_transcript")[0]?.text === "Looking for a running group");
check("legacy null ask yields nothing", normalizeCapturedAsks({ ask: null, concrete_preferences: [], wants: [], availability: null }, "whole_transcript").length === 0);
// A reply carrying both keys is the new shape's reply — asks wins.
check("asks wins over a stale ask key", normalizeCapturedAsks({ ...legacy, asks: [{ text: "Looking for ex-Stripe engineers", type: "seeking" }] }, "whole_transcript")[0].text === "Looking for ex-Stripe engineers");

// The daily network sweep covers every open ask of a type, oldest first, and
// skips closed and text-less entries (2026-09-21: it used to read only the newest).
const intent = [
  { id: "a1", text: "Looking for ex-Stripe engineers", type: "seeking", status: "active" },
  { id: "a2", text: "Want a climbing partner", type: "seeking", status: "active" },
  { id: "a3", text: "Can intro founders to designers", type: "offering", status: "active" },
  { id: "a4", text: "Looking for a cofounder", type: "seeking", status: "closed" },
  { id: "a5", text: "", type: "seeking", status: "active" },
  { id: "a6", type: "seeking", status: "preferences_only" },
];
check("open seeking asks: all active ones, oldest first", getOpenAsksOfType(intent, "seeking").map((a) => a.id).join(",") === "a1,a2");
check("open offering asks: only the offering", getOpenAsksOfType(intent, "offering").map((a) => a.id).join(",") === "a3");
check("closed, text-less and preference-only entries never count", !getOpenAsksOfType(intent, "seeking").some((a) => ["a4", "a5", "a6"].includes(a.id!)));
check("a non-array intent is no asks", getOpenAsksOfType(null, "seeking").length === 0 && getOpenAsksOfType({}, "offering").length === 0);

console.log(`capture rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
