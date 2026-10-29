// Whether a turn has really answered them yet (reviews of #301). A turn that answered someone and then died on the database (logging
// the reply, say) is never replayed: replaying it would answer them twice. This is the turn's own flag, not a count per number: a
// proactive text to the same number isn't this turn's answer, and neither is a line that answers nothing (a "looking" line, the
// late line, a failure note), which the turn's isReply leaves out. A send made inside asHoldSend (Cue's own "looking" line, in
// agent/loopTools.ts) never counts. The turn opens its scope with trackTurnReplies (routes/sendblue.ts runTurn); every send that
// reaches Sendblue reports through noteSent (services/sendblue.ts). Its own small module so the agent code can mark a hold send
// without loading the Sendblue client.
import { AsyncLocalStorage } from "async_hooks";

// phone: the turn's own member. Only what reaches them counts: a direct ask to another member inside the turn is not this turn's
// answer (last review of #301).
export type TurnReplies = { replied: boolean; phone: string; isReply: (content: string) => boolean };
const phoneKey = (n: unknown) => String(n ?? "").replace(/\D/g, "").slice(-10);
const turnReplies = new AsyncLocalStorage<TurnReplies>();
const holdSend = new AsyncLocalStorage<true>();

// From here on, in this async flow (the rest of the turn and what it starts), sends are this turn's.
export function trackTurnReplies(state: TurnReplies): void {
  turnReplies.enterWith(state);
}
// A send that's a hold line, whatever its words.
export function asHoldSend<T>(fn: () => Promise<T>): Promise<T> {
  return holdSend.run(true, fn);
}
// Something reached Sendblue for `to`. If it's inside a turn, went to that turn's member and answers something, the turn has
// replied. Answers: words that aren't a hold line (isReply), any media (a voice note's reply has no words), and a tapback the turn
// chose instead of replying (services/sendblue.ts sendReaction answerFor). Never a send inside asHoldSend.
export function noteSent(o: { to: unknown; content?: string; media?: boolean; reaction?: boolean }): void {
  const t = turnReplies.getStore();
  if (!t || holdSend.getStore()) return;
  const k = phoneKey(o.to);
  if (!k || k !== phoneKey(t.phone)) return;
  if (o.media || o.reaction || t.isReply(o.content ?? "")) t.replied = true;
}
