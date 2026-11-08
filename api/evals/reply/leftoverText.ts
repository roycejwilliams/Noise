// The run's closing plain text after a reply went (2026-11-08, golden feedback-cue-mistake: "Got it, that's on me to flag, just passed it
// to the team so they can fix it." went with sendReply, then "If you want, I can look into their booking page or find the class another
// way." was written as plain text and dropped). Layer 1, no model calls: the turn's sends are a fake that records what went.
//   TZ=UTC node evals/runLayer1.mjs evals/reply/leftoverText.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "node:fs";
const T = await import("../../src/agent/conversationTools.js");
const R = await import("../../src/agent/conversationReply.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

// The turn's sends: a fake sendReply that records what went (as the real one marks state), under the one-reply hold.
function turn() {
  const state = { leftoverOnce: false, sent: false, replyCount: 0, sendStopped: false, sentMessages: [] as string[], partialUnsent: null as string | null, laneNotes: [] as string[], workSinceSend: false, sendsInFlight: 0, extraSendsRefused: 0 };
  const went: string[] = [];
  const tools: Record<string, any> = { sendReply: { execute: async ({ message }: { message: string }) => { went.push(message); state.sentMessages.push(message); state.sent = true; state.replyCount += 1; return { ok: true }; } } };
  T.wrapSendsForOneReply(tools, state, () => false, true);
  return { state, went, tools };
}
const FIRST = "Got it, that's on me to flag, just passed it to the team so they can fix it.";
const OFFER = "I don't have another working link for the studio right now, so I won't send you a dead end twice. If you want, I can look into their booking page or find the class another way.";

{
  const t = turn();
  await t.tools.sendReply.execute({ message: FIRST });
  const sent = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u-marisol", text: OFFER, dryRun: true });
  check("case 63's shape: sendReply, then an offer in plain text: both go, in order", sent && JSON.stringify(t.went) === JSON.stringify([FIRST, OFFER]), t.went);
  check("...past the one-reply hold only for that text (the hold is back on after)", !t.state.leftoverOnce && t.state.extraSendsRefused === 0);
  const again = await t.tools.sendReply.execute({ message: "One more thing about the class." });
  check("...and a further send with nothing new is still held, as before", t.went.length === 2 && again.note === T.ONE_REPLY_NOTE);
}
{
  const t = turn();
  await t.tools.sendReply.execute({ message: FIRST });
  const sent = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: "Got it, that's on me to flag. Passed it to the team so they can fix it.", dryRun: true });
  const sent2 = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: "Passed it to the team, they'll fix the link.", dryRun: true });
  check("plain text that repeats what went is not sent (reworded, or most of its words already said)", !sent && !sent2 && t.went.length === 1, t.went);
}
{
  const t = turn();
  const sent = await R.sendLeftover({ tools: t.tools, state: t.state, isVoice: false, userId: "u", text: OFFER, dryRun: true });
  check("nothing sent yet: this path does nothing (the plain-text reply path handles it, as today)", !sent && t.went.length === 0 && R.leftoverAfterReply({ isVoice: false, sent: false, replies: 0, sendStopped: false, text: OFFER, sentMessages: [] }) === null);
}
check("never on a voice turn, when sends are stopped, or for a few words", R.leftoverAfterReply({ isVoice: true, sent: true, replies: 1, sendStopped: false, text: OFFER, sentMessages: [FIRST] }) === null && R.leftoverAfterReply({ isVoice: false, sent: true, replies: 1, sendStopped: true, text: OFFER, sentMessages: [FIRST] }) === null && R.leftoverAfterReply({ isVoice: false, sent: true, replies: 1, sendStopped: false, text: "Got it.", sentMessages: [FIRST] }) === null);
check("the turn calls it after the run, before the nothing-went paths", (() => { const s = readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8"); const i = s.indexOf("await sendLeftover({ tools, state,"); return i > 0 && i < s.indexOf("const plain = (agentRun?.text ?? \"\").trim();"); })());

console.log(`leftover text: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
