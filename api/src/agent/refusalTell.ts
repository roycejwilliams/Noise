// The one text a refused file ends in, when nothing that passes can go (services/refusalOutcome.ts: case 1, the one question, or case
// 3, the check couldn't run). Sent by code, as the turn's whole delivery about the file (rule 2: one text), so the reply after it can't
// talk about the file and the fallback line never follows it (agent/loopTools.ts onLinkDelivered). The file is held for their answer or
// their yes (services/pendingFiles.ts). Never on a call: a call's refusals go back to the voice agent as before, which says them aloud.
// Once a turn: a second refused file in the same turn sends nothing more.
import type { ConversationToolContext } from "./conversationTools.js";
import type { FlowEnd } from "../services/refusalOutcome.js";
import type { PendingType } from "../services/pendingFiles.js";

// Finishing a held file in the background (services/pendingFiles.ts runHeld): no second question; no second "try again?".
export type Finishing = { mode: "answer" | "retry"; taskId: number };
export const finishingOf = (ctx: ConversationToolContext): Finishing | null => ((ctx as any).finishing as Finishing | undefined) ?? null;

// Pure: whether code settles this refusal itself (the three lines), or hands it back to the agent as before: on a call (spoken), in a
// test run (golden cases stay as recorded), or on a turn where they may not be safe (the reply answers them, never a file line).
export function settlesHere(ctx: Pick<ConversationToolContext, "onCall" | "dryRun" | "safetyConcern">): boolean {
  return !ctx.onCall && !ctx.dryRun && !ctx.safetyConcern;
}
// A refusal line already went this turn.
export const toldThisTurn = (ctx: ConversationToolContext): boolean => !!(ctx as any).refusalTold;
export const ALREADY_TOLD: { ok: false; told: true; error: string } = { ok: false, told: true, error: "They were already sent the one line about a file this turn. Nothing more about it goes out: don't call this again or sendReply about it; end the turn." };

export async function tellRefusal(
  ctx: ConversationToolContext,
  o: { say: (text: string, record: string) => Promise<boolean> },
  end: Extract<FlowEnd<unknown, unknown>, { case: "ask" | "down" }>,
  held: { type: PendingType; word: import("../services/refusalOutcome.js").FileWord; input: unknown; place: string },
): Promise<{ ok: false; told?: true; error: string }> {
  const R = await import("../services/refusalOutcome.js");
  const fin = finishingOf(ctx);
  // A held file whose check is still down on their yes: nothing more is asked (never "try again?" twice). Logged, never sent.
  if (fin?.mode === "retry" && end.case === "down") {
    await R.logOutcome({ place: held.place, userId: ctx.userId, end, sent: false, extra: { finishing: true } });
    return { ok: false, error: "The check still couldn't run, so nothing was sent." };
  }
  if (toldThisTurn(ctx)) return ALREADY_TOLD;
  const word = held.word;
  const sent = await o.say(end.line, `Co replied: ${end.line}`);
  await R.logOutcome({ place: held.place, userId: ctx.userId, end, sent, ...(fin ? { extra: { finishing: true } } : {}) });
  if (!sent) {
    ctx.facts?.add("not_done", `No ${word} was made or sent, and the line telling them so didn't send either.`);
    return { ok: false, error: `No ${word} was made, and the text telling them so didn't send. Tell them plainly in your reply that the ${word} isn't made yet; never describe it as made.` };
  }
  (ctx as any).refusalTold = true;
  // The line is the turn's whole delivery about the file: no leftover text and no fallback line after it.
  ctx.onLinkDelivered?.();
  const { rememberPending } = await import("../services/pendingFiles.js");
  // Asked: the file as written waits for their answer. Down: the file as it was given waits for their yes.
  // Kept without what's already been said and saved: their taste (never recorded twice), a read's confirm, an answer riding along.
  const kept = (x: unknown) => {
    const { taste: _t, readConfirmed: _r, alsoAnswer: _a, ...rest } = (x ?? {}) as Record<string, unknown>;
    return rest;
  };
  await rememberPending({ userId: ctx.userId, type: held.type, word, mode: end.case === "ask" ? "answer" : "retry", input: kept(end.case === "ask" ? end.file : held.input), theirWords: ctx.resolvedContent ?? "" });
  ctx.facts?.add(
    "did_this_turn",
    end.case === "ask"
      ? `No ${word} was sent yet. Cue texted them one question it needs answered first ("${end.line}"); their answer finishes the ${word} and it goes then, as its own text.`
      : `No ${word} was made: the check couldn't run just now. Cue texted them "${end.line}"; their yes tries it again.`,
  );
  return { ok: false, told: true, error: `Not sent yet, and they've been told in one text (${end.case === "ask" ? "the one question it needs" : "it didn't go through and you'll try again on their yes"}). That text is the whole reply about the ${word}: don't call this again or sendReply about it. End the turn unless their message asked something else.` };
}

// A file went out (as normal, or without the lines it couldn't confirm): how its refusal ended is logged, and when Cue's last text
// was the line holding a file of this kind back, that held file is settled, so the background finish never sends it a second time.
export async function afterFileSent(ctx: ConversationToolContext, o: { types: PendingType[]; end: FlowEnd<unknown, unknown> | null; place: string }): Promise<void> {
  if (ctx.dryRun) return;
  const R = await import("../services/refusalOutcome.js");
  if (o.end) await R.logOutcome({ place: o.place, userId: ctx.userId, end: o.end, sent: true, ...(finishingOf(ctx) ? { extra: { finishing: true } } : {}) });
  if (!finishingOf(ctx) && ctx.lastCoMessage && R.isRefusalLine(ctx.lastCoMessage)) await (await import("../services/pendingFiles.js")).settlePending(ctx.userId, o.types, "made in the reply to their answer");
}
