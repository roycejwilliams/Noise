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
const O = await import("../../src/services/documentOffer.js");
const D = await import("../../src/services/receiptDrift.js");
const TC = await import("../../src/services/turnContext.js");
const CR = await import("../../src/agent/conversationReply.js");
const DS = await import("../../src/services/documentSheet.js");
const PC = await import("../../src/jobs/postCallFollowUp.js");

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
  check("B1: work first, then sendReply from its result", /startTask, researchBrief, writeDocument, followUp, moveLane\), call that tool first/.test(rules) && /sendReply says what happened, from its result/.test(rules));
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

// ---------------------------------------------------------------- B3
{
  const a = O.documentAskIn;
  check("B3: asked again, the same version (asksToResend)", a("can you send it again? I can't find it", true).resend && !a("can you send it again? I can't find it", true).change);
  check("B3: asked again WITH a change is a change, not a resend", a("send it again but add the dinner", true).change && !a("send it again but add the dinner", true).resend && a("send it again but add the dinner", true).ask);
  check("B3: 'update the plan with 14 people' is a change", a("can you update the plan with 14 people", true).change && !a("can you update the plan with 14 people", true).resend);
  check("B3: never a document ask on an ordinary message, even right after one", !a("thanks, looks great", true).ask && !a("what time is dinner?", true).ask);
  const resend = O.docOfferLines({ due: null, pending: null, lastDocument: { topic: "Plan" } }, "can you send it again? I can't find it");
  check("B3: a resend is the same version (readDocument, sent unchanged)", /same version/.test(resend.ask ?? "") && /readDocument/.test(resend.ask ?? ""), resend.ask);
  const change = O.docOfferLines({ due: null, pending: null, lastDocument: { topic: "Plan" } }, "can you update the plan with 14 people");
  check("B3: a change reads it first, then the next version", /readDocument first, then writeDocument with revises and changed/.test(change.ask ?? ""), change.ask);
  const os = src("services/documentOffer.ts");
  check("B3: documentOffer imports asksToResend from documentDelivery, and no RESEND copy of its own", /import \{ asksToResend \} from "\.\/documentDelivery\.js"/.test(os) && !/export const RESEND/.test(os));
}

// ---------------------------------------------------------------- B6
{
  const task = (o: any) => ({ id: 1, userId: "u", goal: "find a rooftop for Friday", theirWords: "rooftop", steps: [], planNext: null, nextCheckAt: new Date(NOW.getTime() + 6 * 3_600_000).toISOString(), status: "open", wakes: 0, notes: [], textsSent: 0, lastTextedAt: null, createdAt: daysAgo(1).toISOString(), deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "work", source: "ask", window: null, ...o });
  const doc = DS.resolveDocument({ title: "Friday Dinner Plan", sections: [{ heading: "Budget", bullets: ["Dinner for 12 at Rich Table, about $1,400 before tip"] }, { heading: "Timeline", bullets: ["7pm drinks", "8pm dinner"] }] });
  const receipt = (o: any) => ({ id: 12, userId: "u", docKey: "friday-dinner-plan", version: 1, title: "Friday Dinner Plan", kind: "plan", doc, contentHash: "h", channel: "pdf_text", status: "delivered", line: null, link: null, taskId: null, source: "reply", changeNote: null, error: null, attempts: 0, nextRetryAt: null, deliveredAt: hoursAgo(5), ...o });
  // The text reply's items come from the one carrying builder (services/memberKnowledge.ts carryingOf), as one-line labels.
  const MK = await import("../../src/services/memberKnowledge.js");
  const loop = (o: any) => ({ id: 1, changedAt: hoursAgo(3), lastConfirmedAt: null, ...o });
  const items = TC.carryFromKnowledge(
    MK.carryingOf({
      tasks: [task({ id: 3, goal: "find a caterer" }), task({ id: 4, goal: 'Keep your promise: "I\'ll text you the guest list tonight."', source: "promise", window: { words: "tonight", deadline: new Date(NOW.getTime() + 8 * 3_600_000).toISOString(), warnBy: NOW.toISOString(), zone: "America/Los_Angeles", stated: true } })] as any,
      briefs: [{ id: 7, goal: "venue brief", theirWords: "rooftop", status: "open", createdAt: hoursAgo(2).toISOString(), closedAt: null, outcome: null, held: { text: "Three rooms", at: "" } }] as any,
      receipts: [receipt({}), receipt({ id: 9, version: 0, deliveredAt: daysAgo(2) })] as any,
      ledger: [],
      loops: [loop({ id: 5, title: "Pick a date with Sam", status: "decision_needed", dueDate: null, source: "notes", detail: null }), loop({ id: 6, title: "find a caterer", status: "open", dueDate: null, source: "task", detail: null })],
      promises: [],
      now: NOW,
      zone: "America/Los_Angeles",
    }),
    "America/Los_Angeles",
  );
  const order = items.map((i) => `${i.state}:${i.kind}`);
  check("B6: due first (the held brief, the promise due tonight), then outstanding, then done", order.indexOf("due:brief") >= 0 && order.indexOf("due:promise") >= 0 && Math.max(order.indexOf("due:brief"), order.indexOf("due:promise")) < order.indexOf("outstanding:task") && order.indexOf("outstanding:task") < order.indexOf("done:document"), order);
  check("B6: each artifact once (newest version), task loops not doubled", items.filter((i) => i.kind === "document").length === 1 && items.filter((i) => /find a caterer/.test(i.label)).length === 1, items);
  const block = TC.carryingBlock(items) ?? "";
  check("B6: marked 'already told them' where known (the promise, the delivered doc), not where not (the held brief)", /your promise, task #4[^;]*\[already told them\]/.test(block) && /doc #12[^;]*\[already told them\]/.test(block) && !/research brief #7[^;]*\[already told them\]/.test(block), block);
  check("B6: nothing carried, no block", TC.carryingBlock([]) === null);
  const docs = [{ id: 12, title: "Friday Dinner Plan", doc }];
  check("B6 hint: a message about the budget points at doc #12's Budget section", RG.docQuestionHint("wait what was the budget for dinner again?", docs) === "This may be about doc #12 (Budget section): readDocument before answering.", RG.docQuestionHint("wait what was the budget for dinner again?", docs));
  check("B6 hint: an unrelated message gets none", RG.docQuestionHint("how are you doing today?", docs) === null && RG.docQuestionHint("thanks!", docs) === null);
  check("B6 hint: only the last three documents are read", RG.docQuestionHint("what was the budget?", [{ id: 1, title: "a", doc: DS.resolveDocument({ title: "A", sections: [{ heading: "Notes", bullets: ["nothing here at all"] }] }) }, { id: 2, title: "b", doc: DS.resolveDocument({ title: "B", sections: [{ heading: "Notes", bullets: ["nothing here at all"] }] }) }, { id: 3, title: "c", doc: DS.resolveDocument({ title: "C", sections: [{ heading: "Notes", bullets: ["nothing here at all"] }] }) }, ...docs]) === null);
  const g = src("harness/replyGrounding.ts");
  check("B6: the block is an instruction and the doc pointer a hint (never a fact, never a gate)", /addInstruction\(rf, carrying\)/.test(g) && /addHint\(rf, docHint\)/.test(g));
}

// ---------------------------------------------------------------- A1
{
  const plan = DS.resolveDocument({ title: "Friday Dinner Plan", sections: [{ heading: "The night", bullets: ["Dinner for 12 at Rich Table on Oct 17", "Drinks first at Spruce"] }] });
  const delivered = { id: 12, version: 1, title: "Friday Dinner Plan", doc: plan, deliveredAt: daysAgo(2) };
  const hc = D.receiptDrift(delivered, { notes: { headcount: 16, when: "Oct 17", updatedAt: daysAgo(1) } }, NOW);
  check("A1: the headcount changed after delivery", !!hc && /it says 12 people, and it's 16 now/.test(hc.reasons.join()), hc);
  const date = D.receiptDrift(delivered, { notes: { headcount: 12, when: "Oct 24", updatedAt: daysAgo(1) } }, NOW);
  check("A1: the date changed after delivery", !!date && /it says oct 17, and the date is now Oct 24/.test(date.reasons.join()), date);
  const before = D.receiptDrift(delivered, { notes: { headcount: 16, when: "Oct 24", updatedAt: daysAgo(3) } }, NOW);
  check("A1: notes that changed BEFORE it went are not drift", before === null);
  const passed = D.receiptDrift(delivered, { rejected: [{ name: "Spruce", at: daysAgo(1) }] }, NOW);
  check("A1: an option it lists that they passed on after it went", !!passed && /it lists Spruce/.test(passed.reasons.join()));
  check("A1: a pass from before it went is not", D.receiptDrift(delivered, { rejected: [{ name: "Spruce", at: daysAgo(3) }] }, NOW) === null);
  const urgent = D.receiptDrift(delivered, { notes: { headcount: 12, when: "Oct 17", updatedAt: daysAgo(1) }, eventStartsAt: new Date(NOW.getTime() + 20 * 3_600_000) }, NOW);
  check("A1: within 48 hours with changed notes, it's raised and marked urgent", !!urgent && urgent.urgent && /48 hours/.test(D.driftLine(urgent)));
  check("A1: nothing changed, nothing raised", D.receiptDrift(delivered, { notes: { headcount: 12, when: "Oct 17", updatedAt: daysAgo(1) } }, NOW) === null);

  const base = { now: NOW, helpAsks: [], threads: [], recurring: [], needsCare: false, history: [] as any[], notes: null, emailPlanAt: null, delivered: [], openWork: [], drift: [hc!], message: "sounds good", coLines: [] as string[] };
  const due = O.artifactOfferDue("drift", base);
  check("A1: the drift offer is due, with a readDocument then writeDocument(revises, changed) path", due.due && /readDocument 12/.test((due as any).line) && /revises 12/.test((due as any).line), due);
  check("A1: once per version", !O.artifactOfferDue("drift", { ...base, history: [{ topic: "[drift] doc #12 v1", source: "offered", status: "offered", at: daysAgo(3) }] }).due);
  check("A1: the next version may be offered again", O.artifactOfferDue("drift", { ...base, drift: [{ ...hc!, version: 2, key: D.driftKey(12, 2) }], history: [{ topic: "[drift] doc #12 v1", source: "offered", status: "offered", at: daysAgo(3) }] }).due);
  check("A1: never in a heavy moment", !O.artifactOfferDue("drift", { ...base, heavyNow: true }).due && !O.artifactOfferDue("drift", { ...base, needsCare: true }).due);
  check("A1: not held by the fortnight cooldown (it's about what they already have)", O.artifactOfferDue("drift", { ...base, history: [{ topic: "[plan] dinner", source: "offered", status: "offered", at: daysAgo(4) }] }).due);
  check("A1: the turn computes drift from receipts, notes and passes", /receiptDrift\(d, \{ notes, rejected, eventStartsAt/.test(src("services/turnContext.ts")) && /for \(const d of opts\.turn\?\.drift \?\? \[\]\) addFact\(rf, "known", driftLine\(d\)\)/.test(src("harness/replyGrounding.ts")));
}

// ---------------------------------------------------------------- A2, A3: plan sheet and venue brief
{
  const base = { now: NOW, helpAsks: [], threads: [], recurring: [], needsCare: false, history: [] as any[], notes: null as any, emailPlanAt: null as Date | null, delivered: [] as any[], openWork: [] as string[], drift: [], message: "", coLines: [] as string[] };
  const settled = { ...base, notes: { kind: "venue", what: "dinner", picked: "Rich Table", when: "Friday", headcount: 12, city: "San Francisco", area: null, updatedAt: hoursAgo(1) }, coLines: ["Drinks at Spruce at 7pm, then Rich Table at 8:15pm."] };
  const plan = O.artifactOfferDue("plan", settled);
  check("A2: a settled plan (a pick, a date, 2+ times) may be offered as a one-page sheet", plan.due && /one-page sheet with the times/.test((plan as any).line), plan);
  const walk = O.artifactOfferDue("plan", { ...base, coLines: ["6pm: get there early.\n6:30pm: greet the first guests.\n7pm: toast.\n7:30pm: seat everyone."] });
  check("A2: a 4+ timed-step walkthrough Cue just gave may be offered too", walk.due);
  check("A2: three timed steps aren't enough", !O.artifactOfferDue("plan", { ...base, coLines: ["6pm: arrive.\n7pm: toast.\n8pm: dinner."] }).due);
  check("A2: not when emailPlan ran in the last 24h", !O.artifactOfferDue("plan", { ...settled, emailPlanAt: hoursAgo(3) }).due);
  check("A2: not when they already have a sheet for it", !O.artifactOfferDue("plan", { ...settled, delivered: [{ title: "Rich Table, Friday", kind: "plan", at: hoursAgo(2) }] }).due);
  check("A2: shares the fortnight cooldown with every other offer", !O.artifactOfferDue("plan", { ...settled, history: [{ topic: "how to split cofounder roles", source: "offered", status: "offered", at: daysAgo(5) }] }).due);
  check("A2: never the same plan twice", !O.artifactOfferDue("plan", { ...settled, history: [{ topic: "[plan] Rich Table, Friday", source: "offered", status: "offered", at: daysAgo(30) }] }).due);

  const host = { ...base, message: "I'm hosting a dinner for 14 founders on Oct 18 in Hayes Valley" };
  const brief = O.artifactOfferDue("brief", host);
  check("A3: hosting with a size and date, nothing covering it: offer a venue brief naming rates, minimums, capacity", brief.due && /rates, minimums and capacity/.test((brief as any).line) && /researchBrief/.test((brief as any).line), brief);
  const noDate = O.artifactOfferDue("brief", { ...base, message: "I'm hosting a dinner for 14 founders" });
  check("A3: a load-bearing fact missing: ask that one question instead", noDate.due && /ask that one question/.test((noDate as any).line) && !/rates, minimums/.test((noDate as any).line), noDate);
  check("A3: no size and no date: nothing", !O.artifactOfferDue("brief", { ...base, message: "I'm hosting a dinner sometime" }).due);
  check("A3: a brief or task already covering it: nothing", !O.artifactOfferDue("brief", { ...host, openWork: ["venue brief for the founders dinner"] }).due);
  check("A3: they already have a venue brief: nothing", !O.artifactOfferDue("brief", { ...host, delivered: [{ title: "Venue options", kind: "venue_brief", at: daysAgo(2) }] }).due);
  check("A3: no hosting signal (a dinner that happened): nothing", !O.artifactOfferDue("brief", { ...base, message: "had a great dinner for 14 last night" }).due);

  // docOfferLines: at most one offer, drift > plan > brief > document; none on top of an ask or a waiting offer or in a heavy moment.
  const ctx = { due: { topic: "splitting cofounder roles", why: "x" }, pending: null, history: [], needsCare: false, signals: { notes: settled.notes, emailPlanAt: null, delivered: [], openWork: [], drift: [] } };
  const one = O.docOfferLines(ctx, "I'm hosting a dinner for 14 founders on Oct 18", { now: NOW, coLines: settled.coLines });
  check("one offer a reply: the plan sheet wins over the brief and the document notice", one.offer?.kind === "plan" && /one-page sheet/.test(one.hint ?? "") && !/offerDocument/.test(one.hint ?? ""), one);
  const heavy = O.docOfferLines(ctx, "I'm hosting a dinner for 14 founders on Oct 18", { now: NOW, coLines: settled.coLines, heavyNow: true });
  check("a heavy moment: no offer at all", heavy.hint === null && !heavy.offer, heavy);
  const ask = O.docOfferLines(ctx, "can you make me a pdf of this?", { now: NOW, coLines: settled.coLines });
  check("never an offer on top of their own ask", !ask.offer && !!ask.ask);
  const waiting = O.docOfferLines({ ...ctx, pending: { topic: "[plan] Rich Table, Friday" } }, "yes please", { now: NOW, coLines: settled.coLines });
  check("a waiting plan offer: a yes means the one-page sheet; no new offer", /one-page sheet/.test(waiting.pending ?? "") && /never offer it again/.test(waiting.pending ?? "") && !waiting.offer);
  check("a waiting brief offer: a yes means researchBrief", /researchBrief/.test(O.pendingLine("[brief] founders dinner")));
  check("a waiting drift offer: a yes means readDocument then writeDocument", /readDocument, then send the corrected version with writeDocument/.test(O.pendingLine("[drift] doc #12 v1")));
  check("an old row with no prefix is a document offer", O.parseTopic("splitting cofounder roles").kind === "document" && /write it with writeDocument/.test(O.pendingLine("splitting cofounder roles")));
  check("the record: Cue's text made the offer (bookkeeping only)", O.madeArtifactOffer("Want me to put the night on a one-page sheet with the times?", "plan") && !O.madeArtifactOffer("See you Friday.", "plan") && O.madeArtifactOffer("I can pull a venue brief with rates and minimums for a few rooms.", "brief"));
  const cr = src("agent/conversationReply.ts");
  check("the reply records the offer only when a sent text made it, never in a dry run", /if \(artifact && state\.sent && !opts\.dryRun && opts\.record !== false\)/.test(cr) && /O\.madeArtifactOffer\(state\.sentMessages\.join/.test(cr));
}

// ---------------------------------------------------------------- A5: the post-call recap
{
  const gate = { now: NOW, needsCare: false, heavyNow: false, history: [] as any[] };
  const ok = { gate, localHour: 14, confirmationSent: false, coCommitted: false, deliveredSinceCall: false, callKey: PC.recapKey("abc") };
  check("A5: allowed when the facts check out", O.postCallRecapAllowed(ok).ok);
  check("A5: never at night", !O.postCallRecapAllowed({ ...ok, localHour: 22 }).ok && !O.postCallRecapAllowed({ ...ok, localHour: 6 }).ok);
  check("A5: the gate itself says not now for a heavy call or a hard time (recapOfferFor makes that a capped wait: evals/calls/recapMoodHold.ts)", !O.postCallRecapAllowed({ ...ok, gate: { ...gate, heavyNow: true } }).ok && !O.postCallRecapAllowed({ ...ok, gate: { ...gate, needsCare: true } }).ok);
  check("A5: never with the confirmation text, or when Cue committed to something on the call", !O.postCallRecapAllowed({ ...ok, confirmationSent: true }).ok && !O.postCallRecapAllowed({ ...ok, coCommitted: true }).ok);
  check("A5: never when a document already went since the call", !O.postCallRecapAllowed({ ...ok, deliveredSinceCall: true }).ok);
  check("A5: shares the fortnight cooldown", !O.postCallRecapAllowed({ ...ok, gate: { ...gate, history: [{ topic: "[brief] dinner", source: "offered", status: "offered", at: daysAgo(4) }] } }).ok);
  check("A5: once per call", !O.postCallRecapAllowed({ ...ok, gate: { ...gate, history: [{ topic: "[recap] call abc", source: "offered", status: "offered", at: daysAgo(20) }] } }).ok);
  check("A5: the rule Cue reads leaves the decision read to Cue, one line at most", /Only if they settled a decision or a plan in their own words/.test(O.RECAP_OFFER_RULE) && /one short line/.test(O.RECAP_OFFER_RULE));
  check("A5: the record notices a recap offer in the sent text", O.madeArtifactOffer("Want me to put what you decided on a one-page recap?", "recap") && !O.madeArtifactOffer("Good luck with Sam on Friday.", "recap"));
  const pc = src("jobs/postCallFollowUp.ts");
  check("A5: the post-call draft gets the permission only when code allows it, and never beside the confirmation", /may_offer_a_one_page_recap: recapOffer && !confirmationSent \? RECAP_OFFER_RULE : null/.test(pc) && /recapOfferFor\(userId, followUpId, \{ callAt, confirmed: !!confirmed, coCommitted: promised\.length > 0 \}(?:, k)?\)/.test(pc));
  check("A5: the post-call onSent records the offer", /recordRecapOffer\(c\.userId, c\.payload\.followUpId, messages \?\? \[\]\)/.test(src("harness/proactiveRegistry.ts")));
}

console.log(`${total - failed}/${total} passed`);
if (failed) process.exit(1);
