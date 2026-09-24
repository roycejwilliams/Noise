// What's already known about a call in progress, shared by the audio bridge
// (mediaStreamBridge.ts, which sees every line as it's said) and the tool
// webhook (routes/co.ts). Before 2026-09-23 the coverage check re-downloaded
// the whole call from Hume and rebuilt the member summary on every tool
// call, which took 9s and 19s on a real call while Claude itself took ~1s;
// Co goes quiet while it waits. In memory only, per process: when it's
// missing (another instance, a restart) the webhook falls back to Hume.
export type LiveCall = { chatId: string | null; lines: string[]; contextSummary: string | null; updatedAt: number };

const calls = new Map<string, LiveCall>();
const STALE_MS = 2 * 3_600_000;

export function startLiveCall(userId: string, contextSummary: string | null): void {
  calls.set(userId, { chatId: null, lines: [], contextSummary, updatedAt: Date.now() });
}

export function noteChatId(userId: string, chatId: string): void {
  const c = calls.get(userId);
  if (c) c.chatId = chatId;
}

// Same line format as the transcript built from Hume's chat events.
export function addLine(userId: string, role: "user" | "assistant", text: string): void {
  const c = calls.get(userId);
  if (!c || !text.trim()) return;
  c.lines.push(`${role}: ${text}`);
  c.updatedAt = Date.now();
}

// Null unless this user's live state is fresh and, when both sides know the
// chat id, it's the same chat.
export function getLiveCall(userId: string, chatId?: string): LiveCall | null {
  const c = calls.get(userId);
  if (!c || Date.now() - c.updatedAt > STALE_MS) return null;
  if (chatId && c.chatId && c.chatId !== chatId) return null;
  return c;
}

// Kept a few minutes after hang-up for a tool call that lands late.
export function endLiveCall(userId: string): void {
  const c = calls.get(userId);
  if (!c) return;
  setTimeout(() => {
    if (calls.get(userId) === c) calls.delete(userId);
  }, 5 * 60_000).unref?.();
}
