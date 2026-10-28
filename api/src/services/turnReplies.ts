// Whether a turn has really answered them yet (reviews of #301). A turn that answered someone and then died on the database (logging
// the reply, say) is never replayed: replaying it would answer them twice. This is the turn's own flag, not a count per number: a
// proactive text to the same number isn't this turn's answer, and neither is a line that answers nothing (a "looking" line, the
// late line, a failure note), which the turn's isReply leaves out. A send made inside asHoldSend (Cue's own "looking" line, in
// agent/loopTools.ts) never counts. The turn opens its scope with trackTurnReplies (routes/sendblue.ts runTurn); every send that
// reaches Sendblue reports through noteSent (services/sendblue.ts). Its own small module so the agent code can mark a hold send
// without loading the Sendblue client.
import { AsyncLocalStorage } from "async_hooks";

export type TurnReplies = { replied: boolean; isReply: (content: string) => boolean };
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
// A text reached Sendblue: if it's inside a turn and answers something, that turn has replied.
export function noteSent(content: string | undefined): void {
  const t = turnReplies.getStore();
  if (t && !holdSend.getStore() && t.isReply(content ?? "")) t.replied = true;
}
