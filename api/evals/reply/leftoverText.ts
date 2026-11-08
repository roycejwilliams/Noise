// The run's closing plain text after a reply went (2026-11-08, golden feedback-cue-mistake: "Got it, that's on me to flag, just passed it
// to the team so they can fix it." went with sendReply, then "If you want, I can look into their booking page or find the class another
// way." was written as plain text and dropped). Layer 1, no model calls: the turn's sends are a fake that records what went.
//   TZ=UTC node evals/runLayer1.mjs evals/reply/leftoverText.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
const T = await import("../../src/agent/conversationTools.js");
const R = await import("../../src/agent/conversationReply.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

// The turn's sends: a fake sendReply that records what went (as the real one marks state), under the one-reply hold.
function turn(o: { reword?: (m: string) => string } = {}) {
  const state = { leftoverOnce: false, draftsGiven: [] as string[], sent: false, replyCount: 0, sendStopped: false, linkDelivered: false, reacted: false, sentMessages: [] as string[], partialUnsent: null as string | null, laneNotes: [] as string[], workSinceSend: false, sendsInFlight: 0, extraSendsRefused: 0 };
  const went: string[] = [];
  const callIds: string[] = [];
  // What went is what the fact check leaves (reword stands in for it).
  const tools: Record<string, any> = { sendReply: { execute: async ({ message }: { message: string }, call?: { toolCallId?: string }) => { const m = o.reword ? o.reword(message) : message; callIds.push(String(call?.toolCallId ?? "")); went.push(m); state.sentMessages.push(m); state.sent = true; state.replyCount += 1; return { ok: true }; } } };
  T.wrapSendsForOneReply(tools, state, () => false, true);
  return { state, went, tools, callIds };
}
const FIRST = "Got it, that's on me to flag, just passed it to the team so they can fix it.";
// The read, stubbed: what it was asked, and its answer for each leftover.
const asked: string[] = [];
let answer: (prompt: string) => Promise<string> = async () => '{"send": true, "why": "offers to find the right page"}';
R.setLeftoverModelForTests(async (p) => { asked.push(p); return answer(p); });
const THEIRS = "that link you sent is dead, it goes to a 404";
const OFFER = "I don't have another working link for the studio right now, so I won't send you a dead end twice. If you want, I can look into their booking page or find the class another way.";

{
  const t = turn();
  await t.tools.sendReply.execute({ message: FIRST });
  const sent = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u-marisol", text: OFFER, theirMessage: THEIRS, dryRun: true });
  check("case 63's shape: sendReply, then an offer in plain text: both go, in order", sent && JSON.stringify(t.went) === JSON.stringify([FIRST, OFFER]), t.went);
  check("...past the one-reply hold only for that text (the hold is back on after)", !t.state.leftoverOnce && t.state.extraSendsRefused === 0);
  const again = await t.tools.sendReply.execute({ message: "One more thing about the class." });
  check("...and a further send with nothing new is still held, as before", t.went.length === 2 && again.note === T.ONE_REPLY_NOTE);
}
{
  const t = turn();
  await t.tools.sendReply.execute({ message: FIRST });
  const sent = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: "Got it, that's on me to flag. Passed it to the team so they can fix it.", theirMessage: THEIRS, dryRun: true });
  const sent2 = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: "Passed it to the team, they'll fix the link.", theirMessage: THEIRS, dryRun: true });
  check("plain text that repeats what went is not sent (reworded, or most of its words already said)", !sent && !sent2 && t.went.length === 1, t.went);
}
{
  const t = turn();
  const sent = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: OFFER, theirMessage: THEIRS, dryRun: true });
  check("nothing sent yet: this path does nothing (the plain-text reply path handles it, as today)", !sent && t.went.length === 0 && R.leftoverAfterReply({ isVoice: false, sent: false, replies: 0, sendStopped: false, text: OFFER, sentMessages: [] }) === null);
}
// The read decides (Royce, option 2). Stubbed as a reader would answer: filler, repeats, Cue on its own replies and sign-offs get false.
{
  check("case 63: the read saw what went, their message and the leftover", asked.length >= 1 && asked[0].includes(FIRST) && asked[0].includes(THEIRS) && asked[0].includes(OFFER));
  const held: [string, string, string][] = [
    ["Hayes Valley just confirmed! What should I sort out next for the 14th?", "That's great, congrats on locking it in. Next, nail down the headcount, since that drives everything else.", "Sounds like a solid plan to build from."],
    ["Anything you have for me in SF?", "https://example.test/one", "A few different directions there, mostly Saturday. Let me know if any catch your eye or if you're after something more specific."],
    ["My dad was admitted to the hospital last night. They think it's his heart.", "That kind of waiting is its own special hell, not knowing anything yet.", "I'm here while you wait, and I hope you hear something soon."],
    ["why are your responses so dry?", "Fair. Two weeks with no agenda after that stretch is exactly right, and I hope those two weeks actually let you exhale.", "I rewrote that one properly instead of brushing past it."],
    ["Got the offer from the design studio today, first one in years I actually wanted", "That's huge, Priya. Congratulations.", "Congratulations. That it's the first one in years you actually wanted makes it mean more."],
  ];
  for (const [theirs, first, left] of held) {
    const t = turn();
    await t.tools.sendReply.execute({ message: first });
    answer = async () => '{"send": false, "why": "adds nothing they need now"}';
    const sent = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: left, theirMessage: theirs, dryRun: true });
    check(`held when the read says no: "${left.slice(0, 50)}"`, !sent && t.went.length === 1, t.went);
  }
  const t = turn();
  await t.tools.sendReply.execute({ message: FIRST });
  answer = async () => { throw new Error("overloaded"); };
  const failedRead = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: OFFER, theirMessage: THEIRS, dryRun: true });
  answer = async () => "sure, send it";
  const badAnswer = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: OFFER, theirMessage: THEIRS, dryRun: true });
  check("a failed read, or one that doesn't answer, sends nothing", !failedRead && !badAnswer && t.went.length === 1);
  check("the verdict is parsed only from its JSON shape", R.parseLeftoverVerdict('{"send": true, "why": "an offer"}')?.send === true && R.parseLeftoverVerdict('{"send": "yes"}') === null && R.parseLeftoverVerdict("no") === null);
  R.setLeftoverModelForTests(null);
}
check("never on a voice turn, when sends are stopped, or for a few words", R.leftoverAfterReply({ isVoice: true, sent: true, replies: 1, sendStopped: false, text: OFFER, sentMessages: [FIRST] }) === null && R.leftoverAfterReply({ isVoice: false, sent: true, replies: 1, sendStopped: true, text: OFFER, sentMessages: [FIRST] }) === null && R.leftoverAfterReply({ isVoice: false, sent: true, replies: 1, sendStopped: false, text: "Got it.", sentMessages: [FIRST] }) === null);
// The review of #421: the set-aside and the leftover are never both sent; a reworded draft still counts as said; no redraft dead end; 3s read.
{
  R.setLeftoverModelForTests(async () => '{"send": true, "why": "x"}');
  // The reviewer's dentist / founder-dinner turn: the finds went (the turn is sent, no reply yet), the set-aside is the run's plain text.
  const SET_ASIDE = "The dentist's not something I handle, but the founder dinners above are this week.";
  const t = turn();
  t.state.sent = true;
  t.state.workSinceSend = true; // the finds that went (shareFinds is new for them)
  const which = await R.sendPlainAfterRun({ tools: t.tools, state: t.state, isVoice: false, userId: "u", scope: { scope: "mixed" }, text: SET_ASIDE, theirMessage: "a dentist near the mission, and any founder dinners this week?", dryRun: true });
  const again = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: SET_ASIDE, theirMessage: "x", dryRun: true });
  check("set-aside, then the same text as the leftover: the set-aside goes once, nothing more", which === "set_aside" && JSON.stringify(t.went) === JSON.stringify([SET_ASIDE]) && !again, t.went);
  // A draft the fact check reworded: the leftover saying the draft again is still a repeat.
  const r = turn({ reword: (m) => (m.startsWith("I passed") ? "Passed along to the team." : m) });
  await r.tools.sendReply.execute({ message: "I passed your note about the broken studio link to the team so they can fix the page." });
  const rep = await R.sendLeftover({ tools: r.tools, state: r.state, isVoice: false, userId: "u", text: "I passed your note about the broken studio link to the team so they can fix the page.", theirMessage: "x", dryRun: true });
  check("a leftover repeating a draft the fact check reworded is still a repeat (nothing sent)", !rep && r.went.length === 1, r.went);
  // The leftover goes as the other after-run text: no redraft can be asked of it.
  const c = turn();
  await c.tools.sendReply.execute({ message: FIRST }, { toolCallId: "call-1" });
  await R.sendLeftover({ tools: c.tools, state: c.state, isVoice: false, userId: "u", text: OFFER, theirMessage: THEIRS, dryRun: true });
  check("the leftover is sent as plain-text-reply (canRedraft false: no finds or move redraft dead end)", c.callIds[1] === "plain-text-reply", c.callIds);
  // Nothing went yet: the after-run step sends nothing; the nothing-went path is left as it was.
  const n = turn();
  check("nothing sent yet: the after-run step sends nothing (the existing plain-text path handles it)", (await R.sendPlainAfterRun({ tools: n.tools, state: n.state, isVoice: false, userId: "u", scope: { scope: "in" }, text: OFFER, theirMessage: THEIRS, dryRun: true })) === null && n.went.length === 0);
  // A read that hangs: a failed read at LEFTOVER_READ_MS, nothing sent.
  R.setLeftoverModelForTests(() => new Promise(() => {}));
  const h = turn();
  await h.tools.sendReply.execute({ message: FIRST });
  const t0 = Date.now();
  const hung = await R.sendLeftover({ tools: h.tools, state: h.state, isVoice: false, userId: "u", text: OFFER, theirMessage: THEIRS, dryRun: true });
  const ms = Date.now() - t0;
  check("the read is capped at 3s: a timeout sends nothing", R.LEFTOVER_READ_MS === 3000 && !hung && h.went.length === 1 && ms < 3600, ms);
  R.setLeftoverModelForTests(null);
}

console.log(`leftover text: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
