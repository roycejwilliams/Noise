// The ask to an event guest with no stated ask (ask_solicitation), after #254 made it reach members who have goals but no ask.
// Decided 2026-10-19 on Royce's delegation (review of #254):
//   1. it follows the rules of any text Cue starts: it waits while they're struggling (HOLD_WHILE_STRUGGLING; with #253 a capped wait),
//      it's paced by engagement, and it isn't "can't wait";
//   2. one ask per member per event: the walk-in check-in's "what are you hoping to find here" and the scoring pass's ask never both go;
//   3. its draft says what Cue knows about where they're headed (their own record), never "nothing yet".
// Zero tokens: the model, the database and Sendblue are stubbed; nothing is sent.
//   npx tsx evals/matching/askSolicitation.ts
import { readFileSync } from "fs";
import { W, reset, addMember, addEvent, goal, check, results } from "../inroom/world.js";

{
  const RealDate = Date;
  const pinned = new RealDate();
  pinned.setUTCHours(18, 0, 0, 0);
  const offset = pinned.getTime() - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...a: any[]) {
      super(...((a.length ? a : [RealDate.now() + offset]) as [any]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  (globalThis as any).Date = PinnedDate;
}

const P = await import("../../src/harness/proactive.js");
const S = await import("../../src/services/eventScoring.js");
const WK = await import("../../src/services/eventWalkinCheckin.js");
const A = await import("../../src/agent/eventAskSolicitation.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ================================================================ 1. the rules of any text Cue starts
{
  const now = new Date("2026-10-19T20:00:00Z");
  const cand = (type: any, payload: any = {}): any => ({ id: "1", userId: "u", type, targetKey: `${type}:x`, topicKey: `${type}:x`, summary: "", priority: 55, dueAt: now, expiresAt: null, payload, attempts: 0, createdAt: now });
  const held = P.candidateChecks(cand("ask_solicitation"), { now, sends: [], lastInboundAt: null, needsCare: true } as any).some((c) => c.name === "emotional_timing" && !c.pass);
  check("1a. it waits while they're struggling, like an ask check-in", held && P.HOLD_WHILE_STRUGGLING.has("ask_solicitation"));
  check("1b. it's paced by engagement (only a safety follow-up isn't)", P.pacedByEngagement(cand("ask_solicitation")) === true && P.pacedByEngagement(cand("companion", { safetyFollowUp: true })) === false);
  check("1c. it isn't 'can't wait'", !/const CANT_WAIT = new Set\([^)]*"ask_solicitation"/.test(src("harness/proactive.ts")));
}

// ================================================================ 2. one ask per member per event
{
  const calls: string[] = [];
  const deps = (o: { hasAsk?: boolean; sent?: boolean } = {}): any => ({
    hasAsk: async () => !!o.hasAsk,
    solicitationSent: async (_p: string, key: string) => (calls.push(`sent? ${key}`), !!o.sent),
    dropPending: async (p: string, key: string) => void calls.push(`drop ${p} ${key}`),
    markAsked: async (e: string, p: string) => void calls.push(`mark ${e} ${p}`),
  });
  check("2a. walk-in: no ask, and the scoring pass's ask for this event hasn't gone: it asks", (await WK.walkinAskDue("Cue Night", "u1", deps())) === true && calls.includes("sent? ask_solicitation:cue night"));
  check("2b. walk-in: the scoring pass's ask for this event already went: it doesn't ask again", (await WK.walkinAskDue("Cue Night", "u1", deps({ sent: true }))) === false);
  check("2c. walk-in: they have an ask: it doesn't ask (as before)", (await WK.walkinAskDue("Cue Night", "u1", deps({ hasAsk: true }))) === false);
  calls.length = 0;
  await WK.noteWalkinAsked("evt-1", "Cue Night", "u1", deps());
  check("2d. when the walk-in asks: a pending ask for this event is dropped and the event is marked asked", calls.includes("drop u1 ask_solicitation:cue night") && calls.includes("mark evt-1 u1"), calls);
  check("2e. the key is the one the scoring pass queues under", A.solicitationKey("Cue Night") === "ask_solicitation:cue night" && /targetKey: solicitationKey\(eventName\),/.test(src("agent/eventAskSolicitation.ts")));
  // Review of #254 (2026-10-19): the ask is noted only after a reply that asks it is delivered, never when it's only planned.
  const sb = src("routes/sendblue.ts");
  check("2f. the reply path asks at walk-in only when walkinAskDue says so", /const due = await walkinAskDue\(walkinCheckinEventName, user\.id\)/.test(sb) && /if \(due\) \{\n\s+walkinAskEvent = \{ id: walkinCheckinEventId, name: walkinCheckinEventName \};\n\s+walkinAskInstruction = /.test(sb));
  const replyAt = sb.indexOf("runConversationReplyAgent({");
  const noteAt = sb.indexOf("await noteWalkinAsked(");
  check("2g. ... and notes it only after the reply, once a delivered text asked it", sb.split("await noteWalkinAsked(").length === 2 && replyAt > 0 && noteAt > replyAt && /if \(walkinAskEvent && walkinAskWentOut\(deliveredThisTurn\)\) \{\n\s+await noteWalkinAsked\(walkinAskEvent\.id, walkinAskEvent\.name, user\.id\)/.test(sb));
  check("2h. delivered means the send went out: only a send that returned true is counted", /if \(ok\) deliveredThisTurn\.push\(p\.message\);\n\s+return ok;/.test(sb) && /sendCoReply: threadedSend,/.test(sb));
  check("2i. a delivered reply that asked counts; nothing delivered, or only an acknowledgment, doesn't", WK.walkinAskWentOut(["Welcome in. What are you hoping to find here tonight?"]) && !WK.walkinAskWentOut([]) && !WK.walkinAskWentOut(["Glad you made it, enjoy the night."]));
  check("2j. the unused hasActiveAsk import is gone from the reply path", !/hasActiveAsk/.test(sb));

  // The scoring pass after a walk-in ask: the event is marked asked, so it doesn't queue a second one.
  reset();
  const noor = addMember({ first_name: "Noor", intent: [goal("invest in early edtech founders")] });
  const ellis = addMember({ first_name: "Ellis", intent: [goal("back pre-seed founders")] });
  addEvent({ api_id: "evt-walk", name: "Cue Night" }, [{ m: noor }, { m: ellis }]);
  await WK.realWalkinAskDeps.markAsked("evt-walk", noor.id);
  W.scoringDebounce.clear();
  await S.scoreGuestListForEvent("evt-walk");
  await new Promise((r) => setTimeout(r, 30));
  check("2g. scoring pass after Noor was asked at walk-in: no second ask for her; Ellis (not asked) is", !W.candidates.some((c) => c.user_id === noor.id) && W.candidates.some((c) => c.user_id === ellis.id && c.type === "ask_solicitation"), W.candidates.map((c) => [c.user_id === noor.id ? "Noor" : "Ellis", c.type]));
}

// ================================================================ 3. the draft says what Cue knows about their goals
{
  const prompts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url instanceof URL ? url.href : typeof url === "string" ? url : url?.url);
    if (/api\.anthropic\.com/.test(u)) {
      prompts.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: "What would make Cue Night worth it for you?" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    await A.draftAskSolicitation("Noor", "Cue Night", ["invest in early edtech founders"]);
    const withGoals = prompts.join("\n");
    check("3a. with goals: the draft is told where they say they're headed, and that what they want from the event is unknown", /where_they_say_they_are_headed[^\n]*invest in early edtech founders/.test(withGoals) && /unknown: that's what you're asking/.test(withGoals) && !/nothing yet/.test(withGoals), withGoals.slice(0, 600));
    prompts.length = 0;
    await A.draftAskSolicitation("Ellis", "Cue Night", null);
    const none = prompts.join("\n");
    check("3b. goals unknown: nothing is said about their goals, and never 'nothing yet'", prompts.length > 0 && !/where_they_say_they_are_headed/.test(none) && !/nothing yet/.test(none));
  } finally {
    globalThis.fetch = realFetch;
  }
  const read = async () => ({ goals: [{ text: "old done goal", state: "done", verifiedAt: "2026-01-01" }, { text: "launch a consumer app", state: "active", verifiedAt: "2026-09-01" }, { text: "raise a pre-seed", state: "active", verifiedAt: "2026-10-01" }, { text: "hire a designer", state: "active", verifiedAt: "2026-08-01" }, { text: "write a book", state: "active", verifiedAt: "2026-07-01" }] });
  check("3c. their goals come from their own record: active only, newest first, at most three", JSON.stringify(await A.solicitationGoals("u1", read)) === JSON.stringify(["raise a pre-seed", "launch a consumer app", "hire a designer"]));
  check("3d. a record that can't be read: null (the draft then says nothing about goals)", (await A.solicitationGoals("u1", async () => { throw new Error("down"); })) === null);
  check("3e. the queued ask's draft reads their goals", /draftAskSolicitation\(person\.firstName, c\.payload\.eventName, await solicitationGoals\(c\.userId\)\)/.test(src("harness/proactiveRegistry.ts")));
}

console.log(`\nask solicitation: ${results.total - results.failed}/${results.total} passed`);
process.exit(results.failed ? 1 : 0);
