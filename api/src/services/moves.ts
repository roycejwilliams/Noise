// Every turn Co makes one move (Royce, 2026-10-01: "Every turn the loop picks
// one move: reply, act, watch, or stay quiet. Quiet is a valid output - timing
// is part of the product."). Co chooses through its tools; this names the move
// it made so every turn is logged (turn.move) and the replay harness can hold
// a case to one (evals/replay).
export const MOVES = ["reply", "act", "watch", "quiet"] as const;
export type Move = (typeof MOVES)[number];

// Doing something for them this turn: finding, sharing, drafting.
const ACT_TOOLS = new Set(["searchEvents", "webSearch", "searchPosts", "readPage", "shareFinds", "draftEmail", "emailPlan", "writeDocument", "shareLink", "sendContactCard"]);
// Keeping a loop open to come back to.
const WATCH_TOOLS = new Set(["startTask", "updateTask", "updateNotes", "updateLoop", "saveAsk", "scheduleCall"]);

// A reaction in place of words, either kind.
const REACTION_TOOLS = ["leaveItAtReaction", "reactInsteadOfReplying"];

// From the tools that worked (toolsDone), not just the ones tried: a refused
// search isn't an act (2026-10-01 code review). toolsCalled is the fallback
// for callers that only know what was tried.
export function moveOf(t: { toolsCalled: string[]; toolsDone?: string[]; sent: boolean }): Move {
  const used = new Set(t.toolsDone ?? t.toolsCalled);
  if (!t.sent) return "quiet";
  // Words went out too: it's whatever else the turn did, not quiet.
  if (REACTION_TOOLS.some((x) => used.has(x)) && !used.has("sendReply")) return "quiet";
  if ([...used].some((x) => ACT_TOOLS.has(x))) return "act";
  if ([...used].some((x) => WATCH_TOOLS.has(x))) return "watch";
  return "reply";
}

export const MOVES_GUIDE =
  "Each turn is one move, and you pick it: reply (answer them), act (do something for them now: find, share, draft), watch (a loop stays open and you'll come back to it when it moves: start or update a task, a loop, your notes), or stay quiet (the reaction already said it, so nothing else goes). Quiet is a real answer, and timing is part of what you give them: speak when something changed or they need you, not to fill the space.";
