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
    // A declared tool the guard refused with a limit: it did nothing, and there's nothing to tell them.
    sendInvite: { execute: async () => G.markGuardRefusal({ ok: false, error: "Already done this turn. Don't repeat it." }) },
    // A refusal whose words tell Cue to tell them (switched off): owed, even arriving after the reply.
    makeDeck: { execute: async (o?: { slow?: boolean }) => { if (o?.slow) await new Promise((r) => setTimeout(r, 1)); return G.markGuardRefusal({ ok: false, error: "This is switched off right now. Tell them plainly it isn't available at the moment." }); } },
    // A declared tool's own failure is still a result to say.
    searchEvents: { execute: async () => ({ ok: false, error: "Couldn't reach the venue's page." }) },
    // Silent bookkeeping (review of #310: these reopened a second text).
    markTopicAsked: { execute: async () => ({ ok: true }) },
    noteReaction: { execute: async () => ({ ok: true }) },
    noteFreeTime: { execute: async () => ({ ok: true, note: "Saved: free Thursday evenings." }) },
    keepArtifact: { execute: async () => ({ ok: true, link: "https://example.com/d/v/moved" }) },
    findReaction: { execute: async () => ({ ok: true, next: "They said yes: offer the intro." }) },
    // Made, but its text didn't send: the guard's refusal says to give it in the reply.
    makePage: { execute: async () => G.markGuardRefusal({ ok: false, error: "Already done this turn: the page exists, but the text with it didn't send. Don't make it again; give it in your reply." }) },
    saveKitFact: { execute: async () => ({ ok: true }) },
    saveAsk: { execute: async () => ({ ok: true }) },
    // A tool nobody declared: default no.
    someNewTool: { execute: async () => ({ ok: true, result: "anything" }) },
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
  await h.tools.sendInvite.execute({});
  await h.tools.sendReply.execute({ message: PRIYA_2 });
  check("a tool the guard refused with a limit is nothing new: no second text after it", h.went.length === 1, h.went);
  await h.tools.searchEvents.execute({});
  await h.tools.sendReply.execute({ message: "That page wouldn't load, so I couldn't check the time." });
  check("…a tool's own failure is a result: the text about it goes", h.went.length === 2, h.went);
}
{
  // Review of #310: silent bookkeeping, and any tool nobody declared, never reopen a second text.
  for (const name of ["noteReaction", "saveKitFact", "saveAsk", "someNewTool"]) {
    const h = harness();
    await h.tools.sendReply.execute({ message: PRIYA_1 });
    await h.tools[name].execute({});
    await h.tools.sendReply.execute({ message: PRIYA_2 });
    check(`silent ${name}: no second text after it`, h.went.length === 1, h.went);
  }
}
{
  // Re-review of #310: a moved link, the next step on a yes, a playback of their time each carry something to say.
  for (const name of ["keepArtifact", "findReaction", "noteFreeTime"]) {
    const h = harness();
    await h.tools.sendReply.execute({ message: PRIYA_1 });
    await h.tools[name].execute({});
    await h.tools.sendReply.execute({ message: "One more thing from that." });
    check(`${name} carries something to say: its text goes`, h.went.length === 2 && T.NEW_FOR_THEM.has(name) && !T.SILENT_TOOLS.has(name), h.went);
  }
  const h = harness();
  await h.tools.sendReply.execute({ message: "Making the page now." });
  await h.tools.makePage.execute({});
  await h.tools.sendReply.execute({ message: "Here's the page: https://example.com/d/v/x" });
  check("a 'made but unsent, give it in your reply' refusal is owed: its text goes", h.went.length === 2, h.went);
}
{
  // Review of #310: a refusal that tells Cue to tell them, landing while the reply goes out, is owed after it.
  const h = harness();
  const [, refused] = await Promise.all([h.tools.sendReply.execute({ message: "On it, making the deck now." }), h.tools.makeDeck.execute({ slow: true })]);
  await h.tools.sendReply.execute({ message: "The deck builder is switched off right now, so that one isn't made." });
  check("a guard refusal that tells Cue to tell them, arriving during the reply, still gets its text", h.went.length === 2 && G.guardRefusalTellsThem(refused), h.went);
  const h2 = harness();
  await h2.tools.sendReply.execute({ message: PRIYA_1 });
  await h2.tools.makeDeck.execute({});
  await h2.tools.sendReply.execute({ message: "That one's switched off right now." });
  check("…and after the reply", h2.went.length === 2);
  check("only the guard's own instruction to tell them counts ('say so if it comes up' doesn't)", !G.guardRefusalTellsThem(G.markGuardRefusal({ ok: false, error: "Already done for them today. Don't do it again; say so if it comes up." })) && G.guardRefusalTellsThem(G.markGuardRefusal({ ok: false, error: "Not done: their yes couldn't be checked just now. Say plainly it didn't go through yet." })));
}
{
  // Every tool in the real set is a conscious choice: new for them or silent, never both.
  console.log = () => {};
  const t = T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "hi", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, isTeam: true, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any);
  console.log = quiet;
  const names = Object.keys(t.tools);
  const unclassified = names.filter((n) => !T.NEW_FOR_THEM.has(n) && !T.SILENT_TOOLS.has(n));
  const both = names.filter((n) => T.NEW_FOR_THEM.has(n) && T.SILENT_TOOLS.has(n));
  check("every real tool is declared new-for-them or silent (default no for anything new)", unclassified.length === 0 && both.length === 0, { unclassified, both });
  // voiceRead (#304) is only in the set where the read can run; it's declared all the same.
  check("…voiceRead too, though the test set leaves it out", T.NEW_FOR_THEM.has("voiceRead") && !T.SILENT_TOOLS.has("voiceRead"));
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
check("the send wrap counts only a declared tool's result, or a refusal that tells them", /if \(resultIsNewForThem\(name, out\)\) news\(\);/.test(ct) && /if \(isGuardRefusal\(out\)\) return guardRefusalTellsThem\(out\);\s+return NEW_FOR_THEM\.has\(name\);/.test(ct));
const cr = fs.readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
check("the turn rule: the exception is another tool's result, never its own sent reply", /something new from another tool's result after your reply went out, as its own text; your own sent reply isn't one/.test(cr));

console.log = quiet;
console.log(`reply one reply: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
