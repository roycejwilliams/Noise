// A last-line breaker on how many texts Co will send one number (2026-09-21).
// On 09-20 two automated senders answered each other: 32 texts to a stranger's
// number in 3 minutes. The gate now has its own guard (gateGuard.ts), but any
// loop, from any flow, ends here: more than SEND_LIMIT.max texts to one number
// in SEND_LIMIT.windowMs trips the breaker, and that number gets nothing for
// SEND_LIMIT.cooldownMs. Set far above anything a real conversation does (a
// search reply with results is about 6 texts), so it only fires on a runaway.
//
// In memory on purpose: a loop is fast, and a restart clearing it is fine.
// Pure apart from the clock, so tests can drive it.
export const SEND_LIMIT = {
  max: Number(process.env.SEND_LIMIT_MAX) > 0 ? Number(process.env.SEND_LIMIT_MAX) : 15,
  windowMs: 10 * 60 * 1000,
  cooldownMs: 30 * 60 * 1000,
};

export type LimitResult = { ok: true } | { ok: false; count: number; tripped: boolean; resumesAt: number };

export function createSendLimiter(cfg = SEND_LIMIT) {
  const hits = new Map<string, number[]>();
  const blockedUntil = new Map<string, number>();
  // Formats differ across callers (+1..., 415..., (415) ...): same number, same key.
  const keyOf = (n: string) => String(n).replace(/\D/g, "").slice(-10);

  return {
    // Records the send when allowed. `tripped` is true only on the send that
    // trips the breaker, so the caller can alert once, not per blocked text.
    check(number: string | null | undefined, now = Date.now()): LimitResult {
      const key = number ? keyOf(number) : "";
      if (!key) return { ok: true };
      const until = blockedUntil.get(key);
      if (until !== undefined) {
        if (now < until) return { ok: false, count: cfg.max, tripped: false, resumesAt: until };
        blockedUntil.delete(key);
        hits.delete(key);
      }
      const recent = (hits.get(key) ?? []).filter((t) => now - t < cfg.windowMs);
      if (recent.length >= cfg.max) {
        blockedUntil.set(key, now + cfg.cooldownMs);
        hits.set(key, recent);
        return { ok: false, count: recent.length, tripped: true, resumesAt: now + cfg.cooldownMs };
      }
      recent.push(now);
      hits.set(key, recent);
      return { ok: true };
    },
  };
}

export const sendLimiter = createSendLimiter();
