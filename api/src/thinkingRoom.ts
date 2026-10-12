// Haiku 5.x thinks adaptively, and its thinking counts against max_tokens (2026-10-12: the link reader's 800-token
// page reads spent ~770 tokens thinking and came back cut off, so ordinary pages read as "couldn't read the page" every
// day since the 10-07 move to Haiku 5.5; judges capped at 120-200 tokens failed the same way). Passing
// thinking: { type: "disabled" } is ignored by the model, and effort "low" still thinks. So every Messages request to a
// Haiku 5.x model gets THINKING_ROOM more max_tokens, and callers keep sizing max_tokens for the answer alone. A short
// yes/no read doesn't think at all, so it costs nothing there. On calls, if CALL_LLM_MODEL is ever set to
// Haiku 5.x, its 800-token cap no longer bounds thinking before Co speaks: measure latency first.
export const THINKING_ROOM = 2048;

// Pure: the request body with room added, or unchanged when it isn't a Haiku 5.x Messages request.
export function withThinkingRoom(body: string): string {
  try {
    const b = JSON.parse(body);
    if (typeof b?.model !== "string" || !/^claude-haiku-5/.test(b.model) || typeof b.max_tokens !== "number") return body;
    return JSON.stringify({ ...b, max_tokens: b.max_tokens + THINKING_ROOM });
  } catch {
    return body;
  }
}

// On globalThis, so a second copy of this module can't wrap fetch twice.
const INSTALLED = Symbol.for("co.thinkingRoom.installed");
// Wraps fetch once for Anthropic Messages calls (the AI SDK provider and the Anthropic SDK both go through it).
export function installThinkingRoom(): void {
  const g = globalThis as any;
  if (g[INSTALLED] || typeof globalThis.fetch !== "function") return;
  g[INSTALLED] = true;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    if (url && /api\.anthropic\.com\/v1\/messages(\?|$)/.test(url) && typeof init?.body === "string") {
      return inner(input, { ...init, body: withThinkingRoom(init.body) });
    }
    return inner(input, init);
  }) as typeof fetch;
}
