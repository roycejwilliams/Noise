// A turn that touched one of a member's documents is private (Royce, 2026-10-05: "Nothing from a member's
// documents, contents, facts, existence, may ever shape what Co says to any other member. Enforce this in the
// data model, not by instructing the model to be careful.").
//
// Why it has to be in the data: matching reads other members' stored memories as evidence about them
// (services/matching.ts), recaps and profiles are derived from memories, and Co's own reply about a document
// ("your deck says you're raising two million") is logged as an ordinary memory. So everything written during a
// private turn is stored private: no embedding (nothing semantic can find it), and every reader that serves
// another member, or builds anything shared, skips private rows. The member's own conversation still reads them,
// so the thread holds together for that member.
//
// Per turn, carried by the async context, so every write on the turn is covered without threading a flag through
// each call (the reply path, its tools, the logging of what was sent).
import { AsyncLocalStorage } from "node:async_hooks";

// userId: whose turn this is. A write for any other member in the same turn is never made private by it.
type Store = { private: boolean; userId?: string };
const als = new AsyncLocalStorage<Store>();

// Replies to a burst of messages can be written by a different request than the one that carried the file, so
// a per-request flag is not enough: the member is private for a short window after a document is sent or read.
export const PRIVATE_WINDOW_MS = 10 * 60 * 1000;
const recent = new Map<string, number>();

// At the start of handling one inbound message.
export function beginTurn(): void {
  als.enterWith({ private: false });
}
// A document was sent this turn, or one was read: from here on, what is written for this member is private.
export function markPrivateTurn(userId?: string, now = Date.now()): void {
  const s = als.getStore();
  if (s) {
    s.private = true;
    if (userId) s.userId = userId;
  }
  if (userId) recent.set(userId, now + PRIVATE_WINDOW_MS);
}
export function isPrivateTurn(userId?: string, now = Date.now()): boolean {
  const s = als.getStore();
  if (s?.private === true && (!s.userId || !userId || s.userId === userId)) return true;
  if (!userId) return false;
  const until = recent.get(userId);
  if (until === undefined) return false;
  if (until < now) {
    recent.delete(userId);
    return false;
  }
  return true;
}
// For work that must run apart from the turn (a background job): run it under its own store.
export function runPrivate<T>(fn: () => T, isPrivate: boolean): T {
  return als.run({ private: isPrivate }, fn);
}
