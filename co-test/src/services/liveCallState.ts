import { randomBytes, timingSafeEqual } from "crypto";
import type { Server } from "socket.io";

// Live-push layer for a real Twilio-bridged call — a convenience relay of
// events already being persisted elsewhere (co_memories via the existing
// chat_ended extraction pipeline), never the only place data lives. See
// webhooks.ts for where these get pushed from, and phone.ts's
// /:user_id/live-state for how a (re)connecting browser catches up.
//
// Keyed by user_id (not chat_id) since that's what the browser knows and
// what the socket room is joined by. One entry per in-progress call; deleted
// once chat_ended's extraction has run, at which point the static
// /api/session/:id/results endpoint (unchanged) is the source of truth.

export type TranscriptEvent = {
  seq: number;
  type: "transcript";
  message: { role: "user" | "assistant"; content: string; timestamp: string };
};

export type CoverageEvent = {
  seq: number;
  type: "coverage";
  check: {
    call_number: number;
    timestamp: string;
    missing_topics: string[];
    covered_topics: string[];
    ready_to_summarize: boolean;
    latency_ms: number;
  };
};

export type CallEndedEvent = { seq: number; type: "call_ended" };

export type LiveEvent = TranscriptEvent | CoverageEvent | CallEndedEvent;

// Same three shapes minus `seq` (assigned by pushLiveEvent) — defined
// explicitly rather than as Omit<LiveEvent, "seq">, since Omit computes
// keyof over the whole union and collapses the per-branch discriminant,
// losing the type narrowing callers rely on.
export type LiveEventInput =
  | { type: "transcript"; message: TranscriptEvent["message"] }
  | { type: "coverage"; check: CoverageEvent["check"] }
  | { type: "call_ended" };

type LiveState = {
  events: LiveEvent[];
  nextSeq: number;
  transcriptLinesSeen: number; // dedup guard for the polling loop vs. tool_call fetches
  startedAt: number; // Date.now() at chat_started — see getElapsedMinutes
};

const liveStates = new Map<string, LiveState>();
const pollingIntervals = new Map<string, ReturnType<typeof setInterval>>();

function getOrInit(userId: string): LiveState {
  let state = liveStates.get(userId);
  if (!state) {
    state = { events: [], nextSeq: 1, transcriptLinesSeen: 0, startedAt: Date.now() };
    liveStates.set(userId, state);
  }
  return state;
}

export function startLiveCall(userId: string): void {
  getOrInit(userId);
}

// Elapsed time since chat_started — surfaced to Co via the
// assess_conversation_coverage tool result (see handleToolCall in
// webhooks.ts) so she has a real signal to start wrapping up around the
// 15-minute mark, instead of only ever finding out a call ran long when
// Hume's own max_duration timeout silently cuts her off mid-sentence.
// Returns null if no live call is tracked for this user (e.g. a stale
// tool_call after chat_ended already ran endLiveCall).
export function getElapsedMinutes(userId: string): number | null {
  const state = liveStates.get(userId);
  if (!state) return null;
  return (Date.now() - state.startedAt) / 60000;
}

export function pushLiveEvent(io: Server, userId: string, event: LiveEventInput): void {
  const state = getOrInit(userId);
  const withSeq = { ...event, seq: state.nextSeq++ } as LiveEvent;
  state.events.push(withSeq);
  io.to(`user:${userId}`).emit("co:live_event", withSeq);
}

export function getTranscriptLinesSeen(userId: string): number {
  return getOrInit(userId).transcriptLinesSeen;
}

export function setTranscriptLinesSeen(userId: string, count: number): void {
  getOrInit(userId).transcriptLinesSeen = count;
}

// Snapshot for a (re)connecting browser — see phone.ts's live-state route.
// Returns events unconditionally (empty array if no call is active); the
// client treats "active" as whether it got anything non-empty, or just
// keeps polling call_status the same way it already does.
export function getLiveSnapshot(userId: string): { active: boolean; events: LiveEvent[] } {
  const state = liveStates.get(userId);
  return { active: !!state, events: state?.events ?? [] };
}

export function startPolling(userId: string, fn: () => void, intervalMs = 3000): void {
  stopPolling(userId);
  pollingIntervals.set(userId, setInterval(fn, intervalMs));
}

export function stopPolling(userId: string): void {
  const existing = pollingIntervals.get(userId);
  if (existing) {
    clearInterval(existing);
    pollingIntervals.delete(userId);
  }
}

// Called once chat_ended's own extraction/recap has been persisted — the
// live layer's job is done, the static results view (backed by the DB) is
// now authoritative going forward.
export function endLiveCall(userId: string): void {
  stopPolling(userId);
  liveStates.delete(userId);
}

// Per-session socket-room credential. user_id alone isn't a secret — it's a
// visible route param (/call/:sessionId/results) and is returned unauthed by
// the internal dashboard's own /api/dynamic-test/real-user — so joining a
// live-call room on a bare client-supplied user_id let anyone who obtained
// that id (leak, screenshot, shared link, guess) listen to a real tester's
// live call transcript in real time. Issued once, when /api/phone/session
// creates the row, and known only to that session's own browser.
const socketTokens = new Map<string, string>();

export function issueSocketToken(userId: string): string {
  const token = randomBytes(24).toString("hex");
  socketTokens.set(userId, token);
  return token;
}

export function verifySocketToken(userId: string, token: unknown): boolean {
  if (typeof token !== "string" || !token) return false;
  const expected = socketTokens.get(userId);
  if (!expected || token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}
