// A last-line breaker on how many texts Co will send one number (2026-09-21).
// On 09-20 two automated senders answered each other: 32 texts to a stranger's
// number in 3 minutes. The gate now has its own guard (gateGuard.ts), but any
// loop, from any flow, ends here, and that number gets nothing for
// SEND_LIMIT.cooldownMs.
//
// Two limits (2026-09-24). The single 15-in-10-minutes cap tripped on Royce
// in a normal back-and-forth (a quick chat plus one event search is 15
// texts), and he got 32 minutes of silence. Now:
//   - unprompted: more than SEND_LIMIT.unprompted texts with no text from
//     them in between. A real conversation resets this every time they
//     reply; a loop on Co's side never does.
//   - total: more than SEND_LIMIT.max texts in SEND_LIMIT.windowMs, whatever
//     the replies. Catches two bots answering each other, which a reply
//     from them would otherwise keep resetting. Twice the busiest real
//     conversation seen (16).
//
// In memory on purpose: a loop is fast, and a restart clearing it is fine.
// Pure apart from the clock, so tests can drive it.
export const SEND_LIMIT = {
  max: Number(process.env.SEND_LIMIT_MAX) > 0 ? Number(process.env.SEND_LIMIT_MAX) : 40,
  // 18, not 12 (2026-10-05): a reply is now up to five messages, so one normal search turn (a "looking" line,
  // three links, a reply and a second reply) can reach fourteen.
  unprompted: 18,
  windowMs: 10 * 60 * 1000,
  cooldownMs: 30 * 60 * 1000,
};

export type LimitReason = "unprompted" | "total";
export type LimitResult = { ok: true } | { ok: false; count: number; tripped: boolean; resumesAt: number; reason: LimitReason };

export function createSendLimiter(cfg = SEND_LIMIT) {
  const hits = new Map<string, number[]>();
  const blockedUntil = new Map<string, { until: number; reason: LimitReason; count: number }>();
  const sinceInbound = new Map<string, number>();
  // Formats differ across callers (+1..., 415..., (415) ...): same number, same key.
  const keyOf = (n: string) => String(n).replace(/\D/g, "").slice(-10);

  return {
    // Records the send when allowed. `tripped` is true only on the send that
    // trips the breaker, so the caller can alert once, not per blocked text.
    check(number: string | null | undefined, now = Date.now()): LimitResult {
      const key = number ? keyOf(number) : "";
      if (!key) return { ok: true };
      const block = blockedUntil.get(key);
      if (block !== undefined) {
        if (now < block.until) return { ok: false, count: block.count, tripped: false, resumesAt: block.until, reason: block.reason };
        blockedUntil.delete(key);
        hits.delete(key);
        sinceInbound.delete(key);
      }
      const recent = (hits.get(key) ?? []).filter((t) => now - t < cfg.windowMs);
      const unprompted = sinceInbound.get(key) ?? 0;
      const reason: LimitReason | null = recent.length >= cfg.max ? "total" : unprompted >= cfg.unprompted ? "unprompted" : null;
      if (reason) {
        const count = reason === "total" ? recent.length : unprompted;
        blockedUntil.set(key, { until: now + cfg.cooldownMs, reason, count });
        hits.set(key, recent);
        return { ok: false, count, tripped: true, resumesAt: now + cfg.cooldownMs, reason };
      }
      recent.push(now);
      hits.set(key, recent);
      sinceInbound.set(key, unprompted + 1);
      return { ok: true };
    },
    // A send Sendblue rejected never reached them, so it doesn't count
    // (2026-09-28: a refused inline reply and its plain resend counted twice).
    release(number: string | null | undefined): void {
      const key = number ? keyOf(number) : "";
      if (!key) return;
      const recent = hits.get(key);
      if (recent?.length) recent.pop();
      const n = sinceInbound.get(key) ?? 0;
      if (n > 0) sinceInbound.set(key, n - 1);
    },
    // A real text from them: the unprompted count starts over. Never lifts
    // a breaker that already tripped.
    noteInbound(number: string | null | undefined): void {
      const key = number ? keyOf(number) : "";
      if (key) sinceInbound.delete(key);
    },
    // Read-only: whether sends to this number are held right now.
    blocked(number: string | null | undefined, now = Date.now()): { until: number; reason: LimitReason } | null {
      const key = number ? keyOf(number) : "";
      const block = key ? blockedUntil.get(key) : undefined;
      return block && now < block.until ? { until: block.until, reason: block.reason } : null;
    },
  };
}

export const sendLimiter = createSendLimiter();
