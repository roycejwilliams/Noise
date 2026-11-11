// Reply judgment on real model calls (Royce, 2026-11-10): does the reply SATISFY what the moment asked for, not just fit a length? Each
// synthetic case (invented people and places; the reported shapes, never a member's words) is drafted by the real reply agent in a dry
// run (nothing sent or written; searches stubbed), then one grader call reads the reply against that case's own bar.
//
//   npx tsx evals/reply/needQuality.ts --estimate     what a run would cost, from the golden recordings (free, no call)
//   npm run evals:reply:need                          the real run, metered and capped (evals/lib/meter.mjs), run by Royce
//
// One reply draft (Sonnet, the agent's own steps) and one grade (Sonnet) per case.
import { estimateQuality, RUBRIC_CALL_USD } from "../golden/estimate.js";

// seed: the facts the real reply path would give this turn (F5, 2026-11-10: the first run's anything_yet, requested_resurface, quick_wine
// and wrong_link were cut by the fact check for facts the real path has and the fixture didn't): the running-work line and the daily
// search's own fact (replyGrounding.ts runningWorkLine, ongoingFactsFor), and what Cue sent them (turnContext.ts sentFindFacts).
type Seed = { running?: string[]; sent?: { name: string; url: string | null; at: string }[] };
type Case = { id: string; check: string; message: string; recent: string; context?: string; seed?: Seed; isTeam?: boolean; bar: string; never?: string };

const T = (d: string) => `[${d}]`;
export const CASES: Case[] = [
  {
    id: "matching_walkthrough",
    check: "the matching walkthrough request (a teammate asks)",
    isTeam: true,
    message: "Tell me more about your matching system",
    recent: "",
    bar: "Explains how matching works in substance: what Cue learns about each member, how a possible match forms around a room, the private yes or no on each side, and that only a double yes becomes an intro. A concrete example is labelled as one.",
    never: "deflects (\"you built it\", \"you know it better than me\") or gives a one-line headline",
  },
  {
    id: "scenario_first_time",
    check: "a scenario, as if seeing it for the first time",
    message: "Give me a scenario, like I'm seeing it for the first time",
    recent: `${T("Mon 10:01am")} User said: How does Cue decide who I should meet?\n${T("Mon 10:01am")} Cue replied: From what you've told me and who's in the room.`,
    bar: "A labelled hypothetical walked through start to finish: who does what, what the member sees on their phone, and how it ends. Separates how it works today from anything proposed. Doesn't stop after one fragment.",
    never: "invents real people or claims a capability as real that the reply can't know exists",
  },
  {
    id: "repair_shallow",
    check: "correcting a shallow explanation",
    message: "That doesn't explain it. You said the same thing twice.",
    recent: `${T("Mon 10:01am")} User said: Be real descriptive about how intros happen\n${T("Mon 10:01am")} Cue replied: I learn what you're after and who's around, and connect you when it fits.\n${T("Mon 10:03am")} User said: Give me a larger description\n${T("Mon 10:03am")} Cue replied: I get to know you over time and connect you with the right people when it fits.`,
    bar: "Names what the earlier answers missed and answers differently: concrete steps or an example, not the same sentence reworded. Complete in this reply.",
    never: "paraphrases the earlier answer, or promises to explain later",
  },
  {
    id: "quick_wine",
    check: "a quick wine-spot question",
    message: "what was the wine bar you sent?",
    recent: `${T("Sun 6:10pm")} User said: somewhere low key for wine near Hayes?\n${T("Sun 6:11pm")} Cue replied: https://example.test/the-cellar-on-fell\n${T("Sun 6:11pm")} Cue replied: The Cellar on Fell: a small natural-wine bar, quiet on weeknights.`,
    seed: { sent: [{ name: "The Cellar on Fell", url: "https://example.test/the-cellar-on-fell", at: "2026-11-08T02:11:00Z" }] },
    bar: "Names it and gives the link first, with only what's needed to use it. One or two texts.",
    never: "restates the description twice, or adds an unrelated pitch",
  },
  {
    id: "venting",
    check: "venting",
    message: "ugh the demo crashed in front of the investor today. brutal.",
    recent: "",
    bar: "Receives the moment specifically (the demo, the investor), in their register. No plan or event pushed into it.",
    never: "names their feeling for them, pivots to events or offers, or a stock empathy line",
  },
  {
    id: "mixed_vent_ask",
    check: "a mixed emotional and practical ask",
    message: "I'm so drained from this engineer search. What should I do differently in first meetings?",
    recent: "",
    bar: "Both: a real acknowledgment of being drained, then concrete, specific advice for first meetings with engineer candidates.",
    never: "only sympathy, or only advice with the feeling ignored",
  },
  {
    id: "casual",
    check: "casual conversation stays casual",
    message: "haha my cat just knocked my coffee onto my keyboard",
    recent: "",
    bar: "A light, human reply. Short.",
    never: "turns it into advice, a task, or a connection pitch",
  },
  {
    id: "repeat_recommendation",
    check: "a repeated recommendation (the residency already discussed)",
    message: "anything new for the engineer search?",
    recent: `${T("Sep 22")} Cue replied: https://example.test/harbor-point-residency\n${T("Sep 22")} Cue replied: Harbor Point Collective Member Residency: six months for builders.\n${T("Sep 24")} User said: is the HPC residency only for solo founders?\n${T("Sep 24")} Cue replied: It takes teams too.\n${T("Oct 6")} User said: not sure the residency helps me find an engineer though`,
    bar: "Answers honestly about the engineer search. If it mentions the residency at all, it's as already discussed, never as a new find.",
    never: "presents the Harbor Point residency as new, or as a way to find an engineer without a supported reason",
  },
  {
    id: "requested_resurface",
    check: "requested resurfacing",
    message: "what was that residency you sent me back in September? send the link again",
    recent: `${T("Sep 22")} Cue replied: https://example.test/harbor-point-residency\n${T("Sep 22")} Cue replied: Harbor Point Collective Member Residency: six months for builders.`,
    seed: { sent: [{ name: "Harbor Point Collective Member Residency", url: "https://example.test/harbor-point-residency", at: "2026-09-22T17:00:00Z" }] },
    bar: "Names it and sends the link again, plainly.",
    never: "refuses because it was already sent, or says it can't find it",
  },
  {
    id: "anything_yet",
    check: "\"anything yet?\" about a promised search",
    message: "anything yet on the engineer search?",
    recent: `${T("Nov 3")} User said: can you keep an eye out for ways to meet backend engineers in SF?\n${T("Nov 3")} Cue replied: I'll keep looking.`,
    context: "What the daily search has brought back for it so far: founder programs, nothing about meeting backend engineers.",
    seed: { running: ["ways to meet backend engineers in SF"] },
    bar: "Answers the question honestly: where the search stands and what's missing (nothing that fit, and why), and that it keeps going.",
    never: "dodges the question, invents a find, or is a bare \"still looking\" with nothing real",
  },
  {
    id: "wrong_link",
    check: "a member points out a wrong link",
    message: "that link was a roundup post of five programs, not the residency",
    recent: `${T("Nov 10")} Cue replied: https://example.test/x-post-roundup\n${T("Nov 10")} Cue replied: The HPC Member Residency, six months for builders.`,
    seed: { sent: [{ name: "HPC Member Residency", url: "https://example.test/x-post-roundup", at: "2026-11-10T16:00:00Z" }] },
    bar: "Owns the specific mistake in a line, and either gives the residency's own link if it's known or says plainly it doesn't have a verified one.",
    never: "repeats the wrong description as fact, invents a link, or over-apologizes",
  },
  {
    id: "text_call_continuity",
    check: "text/call continuity (a correction made on a call)",
    message: "any wine spot near me this weekend?",
    recent: `${T("Sat 11:00am")} [Call] They corrected where they live: Oakland, not San Francisco.`,
    bar: "Works from Oakland, the place corrected on the call.",
    never: "uses San Francisco as where they are",
  },
  {
    id: "tired_of_looking",
    check: "\"I'm tired of looking\" (not a close)",
    message: "honestly I'm tired of looking for an engineer",
    recent: "",
    bar: "Gentle; meets the tiredness; leaves the search open (paused or lighter), not closed.",
    never: "treats the search as finished or pushes more finds right now",
  },
  {
    id: "new_direction",
    check: "a new direction",
    message: "actually I'm going to focus on fundraising first, hiring can wait",
    recent: "",
    bar: "Takes the new direction at their word and engages with it.",
    never: "asks whether the engineer search is still active",
  },
];

// --only id,id: run (or estimate) just those cases.
const onlyArg = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? (process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null);
const ONLY = onlyArg ? new Set(onlyArg.split(",").map((x) => x.trim()).filter(Boolean)) : null;
if (ONLY) for (const id of ONLY) if (!CASES.some((c) => c.id === id)) throw new Error(`--only: no case "${id}"`);
const RUN = ONLY ? CASES.filter((c) => ONLY.has(c.id)) : CASES;

if (process.argv.includes("--estimate")) {
  // Each case is a new one-turn reply: estimate.ts counts it at the median recorded reply case, plus one grade.
  const e = estimateQuality(RUN.map((c) => ({ id: `need-${c.id}`, awaiting: true, turns: 1 })), 1);
  console.log(`reply need quality estimate: ${RUN.length} cases x 1 run = $${e.total.toFixed(2)} (median recorded reply case each, rubric grade $${RUBRIC_CALL_USD.toFixed(4)} each). Searches are stubbed. Suggested cap: EVAL_COST_CAP_USD=${Math.max(1, Math.ceil(e.total * 2))}`);
  process.exit(0);
}

await import("../lib/requireMeter.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { baseReplyFacts, addFact, runningWorkLine, ongoingFactsFor } = await import("../../src/harness/replyGrounding.js");
const { sentFindFacts } = await import("../../src/services/turnContext.js");
const NOW = new Date("2026-11-10T18:00:00Z");
const { generateText } = await import("ai");
const { anthropic } = await import("@ai-sdk/anthropic");
const { GRADER_MODEL } = await import("../../src/models.js");
const { parseModelJson } = await import("../../src/services/modelJson.js");

// What went to them, in send order (Fix 1, 2026-11-10: a link shared with the share tool never reached replyText, so the grader saw
// "names the residency, no link" when the link had gone first). The dry run logs each send; the grader reads those lines.
const sentLines: string[] = [];
const realLog = console.log;
const captureSends = (on: boolean) => {
  console.log = on
    ? (...a: any[]) => {
        const line = a.map(String).join(" ");
        const link = line.match(/^\[conversationReply dryRun\] would share link (\S+)/);
        const reply = line.match(/^\[conversationReply dryRun\] would reply to [^:]+: "([\s\S]*)"$/);
        if (link) sentLines.push(link[1]);
        else if (reply) sentLines.push(reply[1]);
        realLog(...a);
      }
    : realLog;
};

let bad = 0;
for (const c of RUN) {
  const facts = baseReplyFacts();
  if (c.context) addFact(facts, "known", c.context);
  if (c.seed?.running?.length) {
    addFact(facts, "known", runningWorkLine([], [], { asks: c.seed.running, goals: [], held: [] }));
    for (const f of ongoingFactsFor(c.seed.running.map((text) => ({ text, kind: "find" as const })))) addFact(facts, f.kind, f.text);
  }
  for (const x of c.seed?.sent ?? []) for (const f of sentFindFacts({ name: x.name, url: x.url, sentAt: new Date(x.at), key: `name:${x.name.toLowerCase()}` } as any, NOW)) addFact(facts, "known", f);
  sentLines.length = 0;
  captureSends(true);
  const r = await runConversationReplyAgent(
    { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan", resolvedContent: c.message, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: c.recent, recentMemories: "", contextSummary: "", personaPrompt: null, isTeam: !!c.isTeam, sendCoReply: async () => true } as any,
    // Fix 2: the fixture's running search is what a dry run's listOpenAsks reports open.
    { dryRun: true, record: false, stubSearch: true, stubEvents: [], ...(c.seed?.running?.length ? { dryRunOpenAsks: c.seed.running.map((text) => ({ text, type: "seeking" as const })) } : {}) },
  ).catch((err: any) => ({ replyText: `(failed: ${err?.message ?? err})` }) as any);
  captureSends(false);
  const sent = sentLines.length ? sentLines.join(" || ") : String(r.replyText ?? "");
  // What Cue did and what the fact check changed, so a cut is visible in the log.
  console.log(`    tools: ${(r.toolsCalled ?? []).join(", ") || "none"}`);
  for (const g of (r.grounding ?? []) as any[]) if (g?.outcome && g.outcome !== "as_drafted") console.log(`    fact check ${g.outcome}: ${(g.checks ?? []).filter((k: any) => !k.pass).map((k: any) => `${k.name}${k.reason ? ` (${String(k.reason).slice(0, 140)})` : ""}`).join("; ")}${g.draft ? `\n      draft: ${String(g.draft).replace(/\n/g, " / ").slice(0, 300)}` : ""}\n      final: ${String(g.final ?? "").replace(/\n/g, " / ").slice(0, 300)}`);
  const { text } = await generateText({
    model: anthropic(GRADER_MODEL),
    maxOutputTokens: 250,
    prompt: `A companion texted this reply. Judge whether it SATISFIES what the moment asked for (not its length).\n\nTheir message: "${c.message}"\nEarlier:\n${c.recent || "(nothing)"}\n${c.context ? `Context: ${c.context}\n` : ""}\nThe reply (separate texts in send order, split by ||; a bare link is a shared link):\n${sent}\n\nIt passes only if: ${c.bar}${c.never ? `\nIt fails if it ${c.never}.` : ""}\n\nReturn ONLY JSON: {"pass": true|false, "why": "one line"}`,
  });
  const g = parseModelJson(text) ?? {};
  const ok = g.pass === true;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} (${c.check}): ${String(g.why ?? "no grade")}\n    ${sent.replace(/\n/g, " / ").slice(0, 400)}`);
}
const spend = (globalThis as any).__EVAL_METER_SPEND__?.();
console.log(`reply need quality: ${RUN.length - bad}/${RUN.length} satisfied${spend ? ` | spent $${Number(spend.cost ?? 0).toFixed(4)} of $${Number(spend.capUsd).toFixed(2)}` : ""}`);
if (bad) process.exitCode = 1;
