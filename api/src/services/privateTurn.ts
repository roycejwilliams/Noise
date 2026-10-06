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
export const PRIVATE_WINDOW_MS = 15 * 60 * 1000;
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
// At the start of a member's turn, once we know whose it is: if they are inside the window, this turn is sealed from its
// first step, so everything that asks without a member id (the trace settings) sees it too.
export function joinWindow(userId: string, now = Date.now()): void {
  if (isPrivateTurn(userId, now)) markPrivateTurn(userId, now);
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

// ---------- the member's own live conversation

// A private row seen after the conversation has gone quiet: only that something about a document was said, never what,
// so Co can't restate a document from history. To talk about it again it reads it (readDocument), which seals the turn.
export function renderPrivateRow(content: string): string {
  if (/^\s*co replied:/i.test(content)) return "Co replied: [talked about a document they sent; readDocument reads it again if they bring it up]";
  if (/^\s*user (said|sent)/i.test(content)) return "User said: [about a document they sent]";
  return "[about a document they sent]";
}

// The rows of one member's live conversation, oldest first: private ones in full while the conversation is sealed, else
// as a bare placeholder (and a run of placeholders is one).
export function liveRows<T extends { content: string; private?: boolean }>(rows: T[], sealed: boolean): T[] {
  const out: T[] = [];
  for (const r of rows) {
    if (!r.private || sealed) {
      out.push(r);
      continue;
    }
    const shown = { ...r, content: renderPrivateRow(r.content) };
    if (out.length && out[out.length - 1].content === shown.content) continue;
    out.push(shown);
  }
  return out;
}

// Model calls made during a sealed turn keep their prompts and answers out of the trace store: they carry what a
// document says. Spread into any `experimental_telemetry` setting.
export function sealedTelemetry(): { recordInputs?: false; recordOutputs?: false } {
  return isPrivateTurn() ? { recordInputs: false, recordOutputs: false } : {};
}
