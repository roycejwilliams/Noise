// A reply's second text with the substance goes; actual duplicates never do (2026-11-10, needQuality run on #443). Layer 1, no model
// calls: the model's two-call outputs are replayed from the saved run logs and recordings into the real sendReply / one-reply guard.
//   TZ=UTC node evals/runLayer1.mjs evals/reply/secondSend.ts
// The bug: "Tell me more about your matching system" and "What should I do differently in first meetings?" each went out as a first
// line ("There's no algorithm spitting out percentages...", "Engineer searches drain everyone...") and the second sendReply, carrying
// the actual answer, was held as "nothing new since the reply" (conversationTools.ts wrapSendsForOneReply).
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const T = await import("../../src/agent/conversationTools.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const quiet = console.log;

// Saved outputs (need443.txt, 2026-11-10; the held texts are as the log printed them).
const MATCHING = {
  message: "Tell me more about your matching system",
  first: "There's no algorithm spitting out percentages, if that's what you mean. I actually get to know you first, what you're working on, who you're trying to meet, what stage you're in, and I hold onto that.",
  second: "Then when it's useful, at a Noise event or just in conversation, I act on it. Point you to someone worth meeting and say why, send you something that actually f",
};
const VENT_ASK = {
  message: "I'm so drained from this engineer search. What should I do differently in first meetings?",
  first: "Engineer searches drain everyone, there's no way around that part.",
  second: "A few things that actually change how first meetings go.\n\n1. Open with their work, not your pitch. Ask them to walk you through something they built that they'r",
};
// complete-moment's recording on test (984b4001bc65b416.json, f53c56566c41ea22.json): a share, so one text (#310).
const COMPLETE = {
  message: "It went really well. They approved the full budget. I'm going to sleep for twelve hours.",
  first: "Full budget approved, that's the best outcome you could've walked out with.",
  second: "Go get your twelve hours. You earned it.",
};
const PRIYA = { message: "Got the offer from the design studio today. First job in like four years I actually wanted", first: "That's huge, Priya. Congratulations.", second: "Congratulations. That it's the first one in years you actually wanted makes it mean more." };

// The real tool set, dry run: what "would reply" is what would go to them.
function real(message: string, sendCoReply: (p: any) => Promise<boolean> = async () => true) {
  const lines: string[] = [];
  console.log = (...a: any[]) => { lines.push(a.join(" ")); };
  const t = T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: message, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply, facts: { add: () => {}, text: () => "" } } as any);
  console.log = quiet;
  const send = async (m: string, id = "x") => {
    console.log = (...a: any[]) => { lines.push(a.join(" ")); };
    const r = await (t.tools as any).sendReply.execute({ message: m }, { toolCallId: id, messages: [] });
    console.log = quiet;
    return r;
  };
  return { t, lines, send, would: () => lines.filter((l) => /would reply to/.test(l)) };
}

for (const [name, c] of [["matching walkthrough", MATCHING], ["vent + ask", VENT_ASK]] as const) {
  const r = real(c.message);
  await r.send(c.first, "1");
  const b = await r.send(c.second, "2");
  check(`${name}: they asked, so the second text with the substance goes too (the full answer arrives)`, r.would().length === 2 && r.t.state.sentMessages.length === 2 && b.note !== T.ONE_REPLY_NOTE, r.would());
}
{
  const r = real(COMPLETE.message);
  await r.send(COMPLETE.first, "1");
  const b = await r.send(COMPLETE.second, "2");
  check("complete-moment (a share): still one text, the second held (#310)", r.would().length === 1 && b.note === T.ONE_REPLY_NOTE, r.would());
}
{
  const r = real(PRIYA.message);
  await r.send(PRIYA.first, "1");
  await r.send(PRIYA.second, "2");
  check("the 10-28 job-offer turn (a share): still one text", r.would().length === 1, r.would());
}
{
  const r = real(VENT_ASK.message);
  await r.send(VENT_ASK.first, "1");
  await r.send(VENT_ASK.second, "2");
  const third = await r.send(VENT_ASK.second, "3");
  check("a genuine duplicate second call (the same text again) is held", r.would().length === 2 && third.note === T.ONE_REPLY_NOTE);
  const restated = await r.send("A few things that change how first meetings go. Open with their work, not your pitch.", "4");
  check("…and the same content reworded is held too", restated.note === T.ONE_REPLY_NOTE && r.would().length === 2);
  await r.send("One more: end by asking what would make them say yes.", "5");
  await r.send("And bring a real problem you're stuck on, not a hypothetical.", "6");
  check("continuing texts are capped: the reply and at most two more", r.would().length === 3 && r.t.state.sentMessages.length === 3, r.would());
}
{
  // A failed first send, then the retry: one text, not two.
  let calls = 0;
  const r = real(MATCHING.message, async () => { calls++; return calls > 1; });
  const t = T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: MATCHING.message, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, sendCoReply: async () => { calls++; return calls > 1; }, facts: { add: () => {}, text: () => "" } } as any);
  void r;
  calls = 0;
  const first = await (t.tools as any).sendReply.execute({ message: MATCHING.first }, { toolCallId: "1", messages: [] }).catch(() => ({ ok: false }));
  const retry = await (t.tools as any).sendReply.execute({ message: MATCHING.first }, { toolCallId: "2", messages: [] }).catch(() => ({ ok: false }));
  const again = await (t.tools as any).sendReply.execute({ message: MATCHING.first }, { toolCallId: "3", messages: [] }).catch(() => ({ ok: false }));
  check("a failed first send then the retry: it goes once, and the same text after that is held", first.ok === false && retry.ok === true && again.note === T.ONE_REPLY_NOTE && t.state.sentMessages.length === 1, { first, retry, again, sent: t.state.sentMessages });
}
{
  // A send that timed out but went (#442: sendCoReply reads Sendblue's record and returns true): the model's retry of it is a duplicate.
  const t = T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: MATCHING.message, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any);
  await (t.tools as any).sendReply.execute({ message: MATCHING.first }, { toolCallId: "1", messages: [] }).catch(() => null);
  const retry = await (t.tools as any).sendReply.execute({ message: MATCHING.first }, { toolCallId: "2", messages: [] }).catch(() => null);
  check("a timeout the record check counted as sent: the model's retry of it never doubles", retry?.note === T.ONE_REPLY_NOTE && t.state.sentMessages.length === 1, t.state.sentMessages);
}
{
  // The plain-text fallback after a sent reply (the same words as plain text): held as a duplicate.
  const r = real(MATCHING.message);
  await r.send(MATCHING.first, "1");
  const plain = await r.send(MATCHING.first, "plain-text-reply");
  check("the plain-text fallback after a sent reply doesn't double", plain.note === T.ONE_REPLY_NOTE && r.would().length === 1);
}
{
  // Two identical calls in one step: only one goes, even with the first still in flight.
  const r = real(MATCHING.message);
  const both = await Promise.all([(r.t.tools as any).sendReply.execute({ message: MATCHING.first }, { toolCallId: "1", messages: [] }), (r.t.tools as any).sendReply.execute({ message: MATCHING.first }, { toolCallId: "2", messages: [] })]);
  check("two identical calls in one step: one text", r.t.state.sentMessages.length === 1 && both.filter((x: any) => x.note === T.ONE_REPLY_NOTE).length === 1, r.t.state.sentMessages);
}
// Review of #444.
{
  // A correction that changes only a number goes (numbers kept whatever their length).
  const r = real("what time does it start?");
  await r.send("It starts at 7:30 at the pier.", "1");
  const fix = await r.send("Sorry, it starts at 8:30 at the pier.", "2");
  check("a number-only correction (7:30 -> 8:30) goes out", fix.note !== T.ONE_REPLY_NOTE && r.t.state.sentMessages.length === 2, r.t.state.sentMessages);
  check("whole words: 'Yes.' isn't contained in 'yesterday', 'ok' isn't in 'booking'", !T.repeatsSent("Yes.", ["I booked it yesterday."]) && !T.repeatsSent("ok", ["Your booking is set."]));
  check("…while the same words again still are", T.repeatsSent("It starts at 7:30 at the pier.", ["It starts at 7:30 at the pier."]));
}
{
  const share = real("guess what? I got the job!");
  await share.send("That's huge. Congratulations.", "1");
  await share.send("You've wanted this one for a long time.", "2");
  check("a share with a rhetorical 'guess what?' stays one text", share.t.state.sentMessages.length === 1, share.t.state.sentMessages);
  const rec = real("recommend a good book on hiring");
  await rec.send("One I'd start with: Who by Geoff Smart.", "1");
  await rec.send("It's built around scorecards, which fits how you're hiring for the backend role.", "2");
  check("'recommend a good book on hiring': the second text goes", rec.t.state.sentMessages.length === 2, rec.t.state.sentMessages);
  const nah = real('nah [Replying to Cue\'s text: "Want me to keep looking for engineers this week?"]');
  await nah.send("Got it, I'll leave it.", "1");
  await nah.send("Say the word if that changes.", "2");
  check("'nah' replying to a Cue question (its quoted text set aside) stays one text", nah.t.state.sentMessages.length === 1, nah.t.state.sentMessages);
  check("asked: find me, recommend, suggest, send me, I need help/someone, any thoughts, ideas", ["find me a quiet bar", "recommend a book", "suggest somewhere", "send me the link", "I need someone to build the backend", "I need a recommendation", "any thoughts", "ideas for saturday"].every((m) => T.askedForSomething(m)));
  check("not asked: guess what / you know what shares, quoted lines", !T.askedForSomething("guess what? I got the job!") && !T.askedForSomething("you know what? we did it") && !T.askedForSomething("> Want me to look?\nnah"));
}
// Re-review of #444.
{
  const plan = "The plan is dinner at Nopa Tuesday with Maya.";
  const r = real("what's the plan again?");
  await r.send(plan, "1");
  const ex = await r.send(`${plan} Exactly.`, "2");
  check("repeat + 'Exactly.' → held (only the repeat and a trivial word)", ex.note === T.ONE_REPLY_NOTE && r.t.state.sentMessages.length === 1, r.t.state.sentMessages);
  const r2 = real("what's the plan again?");
  await r2.send(plan, "1");
  await r2.send(`${plan} Book the back room for four.`, "2");
  check("repeat + 'Book the back room for four.' → sends only the new sentence", r2.t.state.sentMessages.length === 2 && r2.t.state.sentMessages[1] === "Book the back room for four.", r2.t.state.sentMessages);
  check("'7:30pm' and '7:30 pm' read the same", T.repeatsSent("It starts at 7:30pm.", ["It starts at 7:30 pm."]));
  for (const m of ["Finally shipped it. I need a nap.", "so many thoughts", "I find a lot of these boring", "whichever works"]) check(`not an ask, one text: "${m}"`, !T.askedForSomething(m));
  check("'recommend a good book on hiring' still asks", T.askedForSomething("recommend a good book on hiring") && T.askedForSomething("I need help finding a venue") && T.askedForSomething("any thoughts on this?") && T.askedForSomething("can you find a quiet bar"));
}
// Pure.
check("asked: a question or a request", T.askedForSomething(VENT_ASK.message) && T.askedForSomething(MATCHING.message) && !T.askedForSomething(COMPLETE.message) && !T.askedForSomething(PRIYA.message));
check("repeatsSent: same, contained, or nearly all the same words", T.repeatsSent("Hi there.", ["Hi there. How are you?"]) && !T.repeatsSent(MATCHING.second, [MATCHING.first]));

console.log = quiet;
console.log(`reply second send: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
