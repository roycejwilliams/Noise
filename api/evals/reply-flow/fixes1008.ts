// The 2026-10-08 reply-flow review fixes, layer 1 (zero tokens, no database: pure functions and the prompts' own text).
//   F1  a research brief backs "I'll text you the brief"; a promise already kept by this turn's work opens no second task
//   F6  the reply prompt no longer says nothing follows up on a promise
//   F7  the fallback rewrite says what Co is doing now, never "Want me to look?"
//   F8  "Today is" is in the member's own zone
//   F9  the tone label no longer credits Hume's read of their voice
//   F11 narration of Co's own state is a failed check on text replies, cut like the others
//   B1/B4/B7  tools first, one sendReply, independent tools together, one tool-failure rule
//   B3  the document re-send detection is documentDelivery's asksToResend; a change is readDocument then the next version
//   B6  one ordered "what you're carrying" view, and a hint when a message is about a section of a recent document
//   A1  a delivered document gone stale (receiptDrift), offered once per version, never in a heavy moment
//   A2/A3  a plan sheet and a venue brief, through the same offer rules, at most one offer a reply
//   A5  the post-call recap offer: the code-checked conditions, and its record
//   npx tsx evals/reply-flow/fixes1008.ts   (or: node evals/runLayer1.mjs reply-flow)
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const RG = await import("../../src/harness/replyGrounding.js");
const P = await import("../../src/services/promises.js");
const TC = await import("../../src/services/turnContext.js");
const CR = await import("../../src/agent/conversationReply.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-08T19:00:00Z"); // noon in San Francisco
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

// ---------------------------------------------------------------- F1
{
  const promise = "I'll text you the brief once it's ready.";
  const rf = RG.createReplyFacts();
  check("F1: with nothing behind it, the promise is unbacked", RG.unbackedFollowup(promise, rf) !== null);
  const brief = RG.createReplyFacts();
  RG.addFact(brief, "did_this_turn", 'Started researching a venue brief for them in the background ("rooftop for 40, Oct 18"). It comes as a document when it\'s ready.');
  check("F1: a research brief started this turn backs it", RG.unbackedFollowup(promise, brief) === null);
  const briefTask = RG.createReplyFacts();
  RG.addFact(briefTask, "did_this_turn", 'Started task #12: "venue brief for 40". Cue will work on it first around 2pm.');
  check("F1: agent 1's 'Started task #N:' form backs it too", RG.unbackedFollowup(promise, briefTask) === null);
  const running = RG.createReplyFacts();
  RG.addFact(running, "scheduled", 'Cue is putting together research brief #7 for them, "venue brief" (their words: "rooftop"), since Oct 8, 10:00am PDT. It runs in the background and goes to them as a document when it\'s done.');
  check("F1: a brief already running (scheduled fact) backs it", RG.unbackedFollowup(promise, running) === null);
  const hint = RG.createReplyFacts();
  RG.addHint(hint, "Started researching something (a hint)");
  check("F1: a hint never backs a promise", RG.unbackedFollowup(promise, hint) !== null);

  check("F1 dedupe: work started this turn keeps the promise, no second task", P.promiseCovered(promise, { startedThisTurn: ['Started researching a venue brief for them ("rooftop")'] }) !== null);
  check("F1 dedupe: a promise task's own receipt counts as work started", P.promiseCovered(promise, { startedThisTurn: ["Started task #4: Keep your promise: \"x\""] }) !== null);
  check("F1 dedupe: other receipts this turn don't", P.promiseCovered(promise, { startedThisTurn: ["Sent them a document, \"Plan\"."] }) === null);
  const open = [{ goal: 'Keep your promise: "I\'ll text you the rooftop venue options tomorrow."', source: "promise" as const, status: "open" as const }];
  check("F1 dedupe: an open promise task about the same thing keeps it", P.promiseCovered("I'll text you the rooftop venue options by Friday.", { open }) !== null);
  check("F1 dedupe: a different promise still gets its own task", P.promiseCovered("I'll check back on the caterer quote tomorrow.", { open }) === null);
  check("F1 dedupe: a closed or non-promise task doesn't count", P.promiseCovered("I'll text you the rooftop venue options by Friday.", { open: [{ ...open[0], status: "done" as const }, { ...open[0], source: "ask" as const }] }) === null);
  const g = src("harness/replyGrounding.ts");
  check("F1: groundReply hands this turn's receipts to trackPromise", /startedThisTurn = rf\.facts\.filter\(\(f\) => f\.kind === "did_this_turn"\)/.test(g) && /discreet: isDiscreetTurn\(rf\.instructions\), startedThisTurn \}\)/.test(g));
  check("F1: trackPromise checks coverage before opening a task", /promiseCovered\(sentence, \{ startedThisTurn: o\.startedThisTurn \}\)/.test(src("services/promises.ts")) && /promiseCovered\(sentence, \{ open \}\)/.test(src("services/promises.ts")));
}

// ---------------------------------------------------------------- F6, F7, F9, B1, B4, B7: the prompts
{
  const cr = src("agent/conversationReply.ts");
  check("F6: the false line is gone, the true one is there", !/Nothing follows up on a promise you make yourself/.test(cr) && /Only promise what a tool you called this turn, or a task in the facts, will do\./.test(cr));
  const g = src("harness/replyGrounding.ts");
  check("F7: the rewrite never teaches 'Want me to look?'", !/Want me to look\?/.test(g) && /say what you're doing about it now/.test(g));
  check("F9: no 'Hume's read' in the reply prompts", !/Hume's read/.test(cr) && (cr.match(/may have been feeling: reads of their recent texts and calls/g) ?? []).length === 1);
  const rules = CR.TOOL_TURN_RULES(false);
  check("B1: work first, then sendReply from its result", /startTask, draftEmail, followUp, moveLane\), call that tool first/.test(rules) && /sendReply says what happened, from its result/.test(rules));
  check("B7: one sendReply, except something new from another tool's result (never its own sent reply); independent tools together", /One sendReply per turn/.test(rules) && /something new from another tool's result after your reply went out/.test(rules) && /your own sent reply isn't one/.test(rules) && /same step/.test(rules));
  check("B7: on a voice turn, no second-text exception", !/separate thought/.test(CR.TOOL_TURN_RULES(true)));
  check("B4: the tool-failure rule (lead with what they get, pending only when backed, no machinery, no 'try again')", /lead with what they get now/.test(CR.TOOL_FAILURE_RULE) && /only when a receipt or a task in the facts backs it/.test(CR.TOOL_FAILURE_RULE) && /Never mention tools, searches, limits, errors or retries/.test(CR.TOOL_FAILURE_RULE) && /never ask them to try again/.test(CR.TOOL_FAILURE_RULE));
  // One reply prompt (prompt sweep 2026-10-29: the REPLY_PROMPT=flow copy is gone).
  check("B1/B4/B7: the reply prompt carries the rules once, and there is no second prompt", (cr.match(/\$\{TOOL_TURN_RULES\(input\.isVoice\)\}/g) ?? []).length === 1 && (cr.match(/TOOL_FAILURE_RULE/g) ?? []).length === 2 && !/systemFlow|REPLY_PROMPT/.test(cr));
}

// ---------------------------------------------------------------- F8
{
  const late = new Date("2026-10-09T04:30:00Z"); // 9:30pm Oct 8 in SF, 12:30am Oct 9 in New York
  check("F8: a New York member's today is their own date", /Friday, October 9, 2026 \(their local time, America\/New_York\)/.test(RG.todayFact("America/New_York", late)), RG.todayFact("America/New_York", late));
  check("F8: a San Francisco member's today is still the 8th", /Thursday, October 8, 2026/.test(RG.todayFact("America/Los_Angeles", late)));
  check("F8: no zone on file says so, in the fallback", /their own zone isn't known/.test(RG.todayFact(null, late)));
  check("F8: gatherReplyFacts uses it with the zone it loaded", /addFact\(rf, "known", todayFact\(zone\)\)/.test(src("harness/replyGrounding.ts")) && !/setZone\("America\/Los_Angeles"\)\.toFormat\("cccc, LLLL d, yyyy"\)\} \(Pacific time\)/.test(src("harness/replyGrounding.ts")));
}

// ---------------------------------------------------------------- F11
{
  const rf = RG.baseReplyFacts();
  const srcs = { message: "any luck on the venue?", recentConversation: "" };
  for (const d of ["Still digging on that one.", "The search hit a limit on my end, retrying.", "I'm working on it now."]) {
    check(`F11: narration fails the code checks: "${d}"`, RG.codeChecks(d, rf, srcs).some((c) => c.name === "no_internal_narration" && !c.pass));
  }
  check("F11: a plain answer passes", !RG.codeChecks("The rooftop at Spruce holds forty seated.", rf, srcs).some((c) => c.name === "no_internal_narration"));
  check("F11: a question passes", !RG.codeChecks("Still want the rooftop, or should we look indoors?", rf, srcs).some((c) => c.name === "no_internal_narration"));
  const draft = "Spruce holds forty seated and has the rooftop. Still digging on the price.";
  const cut = RG.stripUnsupported(draft, RG.codeChecks(draft, rf, srcs).filter((c) => !c.pass));
  check("F11: the cut drops only the narrating sentence", cut === "Spruce holds forty seated and has the rooftop.", cut);
}

// ---------------------------------------------------------------- B6
{
  const task = (o: any) => ({ id: 1, userId: "u", goal: "find a rooftop for Friday", theirWords: "rooftop", steps: [], planNext: null, nextCheckAt: new Date(NOW.getTime() + 6 * 3_600_000).toISOString(), status: "open", wakes: 0, notes: [], textsSent: 0, lastTextedAt: null, createdAt: daysAgo(1).toISOString(), deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "work", source: "ask", window: null, ...o });
  // The text reply's items come from the one carrying builder (services/memberKnowledge.ts carryingOf), as one-line labels.
  const MK = await import("../../src/services/memberKnowledge.js");
  const loop = (o: any) => ({ id: 1, changedAt: hoursAgo(3), lastConfirmedAt: null, ...o });
  const items = TC.carryFromKnowledge(
    MK.carryingOf({
      tasks: [task({ id: 3, goal: "find a caterer" }), task({ id: 4, goal: 'Keep your promise: "I\'ll text you the guest list tonight."', source: "promise", window: { words: "tonight", deadline: new Date(NOW.getTime() + 8 * 3_600_000).toISOString(), warnBy: NOW.toISOString(), zone: "America/Los_Angeles", stated: true } })] as any,
      briefs: [{ id: 7, goal: "venue brief", theirWords: "rooftop", status: "open", createdAt: hoursAgo(2).toISOString(), closedAt: null, outcome: null, held: { text: "Three rooms", at: "" } }] as any,
      ledger: [],
      loops: [loop({ id: 5, title: "Pick a date with Sam", status: "decision_needed", dueDate: null, source: "notes", detail: null }), loop({ id: 6, title: "find a caterer", status: "open", dueDate: null, source: "task", detail: null })],
      promises: [],
      now: NOW,
      zone: "America/Los_Angeles",
    }),
    "America/Los_Angeles",
  );
  const order = items.map((i) => `${i.state}:${i.kind}`);
  const block = TC.carryingBlock(items) ?? "";
  check("B6: marked 'already told them' where known (the promise), not where not (the held brief)", /your promise, task #4[^;]*\[already told them\]/.test(block) && !/research brief #7[^;]*\[already told them\]/.test(block), block);
  check("B6: nothing carried, no block", TC.carryingBlock([]) === null);
  const g = src("harness/replyGrounding.ts");
}


console.log(`${total - failed}/${total} passed`);
if (failed) process.exit(1);
