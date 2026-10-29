// One reply per turn unless something new came in (2026-10-28 before/after run). Layer 1, no model calls.
//   TZ=UTC node evals/runLayer1.mjs evals/reply/oneReply.ts
// The incident: "Got the offer from the design studio today..." got "That's huge, Priya. Congratulations." and then a second text,
// "Congratulations. That it's the first one in years you actually wanted makes it mean more." Golden nothing-at-all records the same
// shape: a sendReply, its ok, another step, a second text. Nothing new had come in between the two.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const T = await import("../../src/agent/conversationTools.js");
const G = await import("../../src/agent/toolGuard.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const quiet = console.log;

// A tool set with a fake send that records what went out, the way the real sendReply marks a send (state.sent, sentMessages).
function harness(o: { answerOwed?: boolean } = {}) {
  const state = { sent: false, sentMessages: [] as string[], partialUnsent: null as string | null, laneNotes: [] as string[], workSinceSend: false, sendsInFlight: 0, extraSendsRefused: 0 };
  const went: string[] = [];
  const tools: Record<string, any> = {
    sendReply: { execute: async ({ message }: { message: string }) => { await new Promise((r) => setTimeout(r, 5)); went.push(message); state.sentMessages.push(message); state.sent = true; return { ok: true }; } },
    startTask: { execute: async () => ({ ok: true }) },
    // A tool the guard refused (switched off, a limit, no yes yet): it did nothing.
    refusedTool: { execute: async () => G.markGuardRefusal({ ok: false, error: "This is switched off right now." }) },
    // A tool's own failure is still a result to say.
    failedTool: { execute: async () => ({ ok: false, error: "Couldn't reach the venue's page." }) },
    markTopicAsked: { execute: async () => ({ ok: true }) },
  };
  T.wrapSendsForOneReply(tools, state, () => !!o.answerOwed, false);
  return { state, went, tools };
}
const PRIYA_1 = "That's huge, Priya. Congratulations.";
const PRIYA_2 = "Congratulations. That it's the first one in years you actually wanted makes it mean more.";

{
  const h = harness();
  await h.tools.sendReply.execute({ message: PRIYA_1 });
  const r = await h.tools.sendReply.execute({ message: PRIYA_2 });
  check("replay of the job-offer turn: the second text with nothing new since the reply doesn't go", h.went.length === 1 && h.went[0] === PRIYA_1, h.went);
  check("  the model is told the reply stands and to stop (ok, so it doesn't retry)", r.ok === true && r.note === T.ONE_REPLY_NOTE && h.state.extraSendsRefused === 1);
}
{
  const h = harness();
  await Promise.all([h.tools.sendReply.execute({ message: PRIYA_1 }), h.tools.sendReply.execute({ message: PRIYA_2 })]);
  check("two sendReply calls in the same step: only the first goes", h.went.length === 1 && h.went[0] === PRIYA_1, h.went);
}
{
  const h = harness();
  await h.tools.sendReply.execute({ message: "Started on it." });
  await h.tools.startTask.execute({});
  await h.tools.sendReply.execute({ message: "The first draft will be with you tomorrow morning." });
  check("another tool ran after the reply: its result may go as its own text", h.went.length === 2);
  await h.tools.sendReply.execute({ message: "Anything else?" });
  check("…and only once: a third text after it, with nothing new again, doesn't go", h.went.length === 2);
}
{
  const h = harness();
  await h.tools.sendReply.execute({ message: PRIYA_1 });
  await h.tools.refusedTool.execute({});
  await h.tools.sendReply.execute({ message: PRIYA_2 });
  check("a tool the guard refused is nothing new: no second text after it", h.went.length === 1, h.went);
  await h.tools.failedTool.execute({});
  await h.tools.sendReply.execute({ message: "That page wouldn't load, so I couldn't check the time." });
  check("…a tool's own failure is a result: the text about it goes", h.went.length === 2, h.went);
}
{
  check("isGuardRefusal reads only the guard's mark: a plain ok:false isn't one, and what the model reads is unchanged", !G.isGuardRefusal({ ok: false }) && G.isGuardRefusal(G.markGuardRefusal({ ok: false, error: "x" })) && JSON.stringify(G.markGuardRefusal({ ok: false, error: "x" })) === '{"ok":false,"error":"x"}');
}
{
  const h = harness();
  await h.tools.sendReply.execute({ message: "Glad it went well." });
  await h.tools.markTopicAsked.execute({});
  await h.tools.sendReply.execute({ message: "What's next for the two of you?" });
  check("bookkeeping (markTopicAsked) is nothing new to say: no second text after it", h.went.length === 1);
}
{
  const h = harness();
  await h.tools.sendReply.execute({ message: "First part." });
  h.state.partialUnsent = "The rest of it.";
  await h.tools.sendReply.execute({ message: "The rest of it." });
  check("the rest of a partly sent reply still goes", h.went.length === 2);
}
{
  const h = harness();
  await h.tools.sendReply.execute({ message: "Moved it to next week." });
  h.state.laneNotes = ["Your Thursday check-in is now next Tuesday."];
  await h.tools.sendReply.execute({ message: "One more thing." });
  check("a lane move's line still owed: the reply that carries it goes", h.went.length === 2);
}
{
  const h = harness({ answerOwed: true });
  await h.tools.sendReply.execute({ message: "https://lu.ma/x" });
  await h.tools.sendReply.execute({ message: "And yes, it's free." });
  check("an answer owed after a link still goes", h.went.length === 2);
}
{
  const h = harness();
  const failing: Record<string, any> = { sendReply: { execute: async () => ({ ok: false, error: "Nothing was left to send after the fact check." }) } };
  const st = { ...h.state };
  T.wrapSendsForOneReply(failing, st, () => false, false);
  await failing.sendReply.execute({ message: "x" });
  check("a send that didn't go (emptied by the check) leaves the reply open: the retry is allowed", T.anotherSendAllowed(st, false) && st.sendsInFlight === 0);
}
check("pure: nothing sent yet, a send is always allowed", T.anotherSendAllowed({ sent: false, sentMessages: [], partialUnsent: null, laneNotes: [], workSinceSend: false, sendsInFlight: 0, extraSendsRefused: 0 }, false));

{
  // Through the real tool set, dry run (nothing is sent): the same two calls.
  const lines: string[] = [];
  console.log = (...a: any[]) => { lines.push(a.join(" ")); };
  const t = T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "Got the offer from the design studio today. First job in like four years I actually wanted", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any);
  const a = await (t.tools as any).sendReply.execute({ message: PRIYA_1 }, { toolCallId: "1", messages: [] });
  const b = await (t.tools as any).sendReply.execute({ message: PRIYA_2 }, { toolCallId: "2", messages: [] });
  console.log = quiet;
  const would = lines.filter((l) => /would reply to/.test(l));
  check("real tools: the first goes, the second is held as nothing new", a.ok === true && b.note === T.ONE_REPLY_NOTE && would.length === 1 && t.state.sentMessages.length === 1, { would, b });
}

// Wiring: the real tool set is wrapped before the guard, and the turn rule says the same thing.
const ct = fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
check("the real tool set is wrapped for one reply, outermost (after the tool guard)", /guardTools\(tools, \{[^\n]*\}\);\n(?:\s*\/\/[^\n]*\n)+\s*wrapSendsForOneReply\(tools as Record<string, any>, state, \(\) => !!ctx\.answerOwed, ctx\.dryRun\);\n\s*return \{ tools: orderForCache\(tools\)/.test(ct));
check("the guard marks every refusal it returns", /return markGuardRefusal\(\{ ok: false, error: tell \}\);/.test(fs.readFileSync(new URL("../../src/agent/toolGuard.ts", import.meta.url), "utf8")));
check("the send wrap skips a guard refusal when counting new work", /if \(!isGuardRefusal\(out\)\) state\.workSinceSend = true;/.test(ct));
const cr = fs.readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
check("the turn rule: the exception is another tool's result, never its own sent reply", /something new from another tool's result after your reply went out, as its own text; your own sent reply isn't one/.test(cr));

console.log = quiet;
console.log(`reply one reply: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
