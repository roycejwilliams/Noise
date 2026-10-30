// ElevenLabs' per-turn timing for a call, read from the post-call webhook's transcript (routes/co.ts call.el_turn_metrics): each
// of Cue's turns carries conversation_turn_metrics.metrics, a set of named timings ({ elapsed_time } in seconds), e.g. its LLM's
// time to first token and to first sentence and its voice's time to first audio. Every call has them, whichever brain answered, so
// they're the like-for-like baseline: the direct path (ElevenLabs' own LLM) against the call brain endpoint (routes/callLlm.ts,
// which also logs its own call.turn_latency). Read generically by name, so a metric ElevenLabs adds or renames is still kept.
// Numbers only: never a word of the call.

export type MetricSummary = { n: number; medianMs: number; p90Ms: number; maxMs: number };
export type ElTurnMetrics = { turns: number; keys: string[]; byKey: Record<string, MetricSummary>; perTurn: Record<string, number>[] };

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

// Pure: the timings of Cue's turns, by metric name, in ms.
export function elTurnMetrics(turns: unknown[]): ElTurnMetrics {
  const perTurn: Record<string, number>[] = [];
  let agentTurns = 0;
  for (const t of Array.isArray(turns) ? turns : []) {
    const turn = t as { role?: unknown; conversation_turn_metrics?: { metrics?: Record<string, unknown> } | null };
    if (turn?.role === "user") continue;
    agentTurns++;
    const metrics = turn?.conversation_turn_metrics?.metrics;
    if (!metrics || typeof metrics !== "object") continue;
    const row: Record<string, number> = {};
    for (const [k, v] of Object.entries(metrics)) {
      const secs = typeof v === "number" ? v : (v as { elapsed_time?: unknown } | null)?.elapsed_time;
      if (typeof secs === "number" && Number.isFinite(secs) && secs >= 0 && secs < 600) row[k.slice(0, 60)] = Math.round(secs * 1000);
    }
    if (Object.keys(row).length) perTurn.push(row);
  }
  const keys = [...new Set(perTurn.flatMap((r) => Object.keys(r)))].sort().slice(0, 12);
  const byKey: Record<string, MetricSummary> = {};
  for (const k of keys) {
    const xs = perTurn.map((r) => r[k]).filter((x): x is number => typeof x === "number");
    if (xs.length) byKey[k] = { n: xs.length, medianMs: quantile(xs, 0.5), p90Ms: quantile(xs, 0.9), maxMs: Math.max(...xs) };
  }
  return { turns: agentTurns, keys, byKey, perTurn: perTurn.slice(0, 80).map((r) => Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]]))) };
}
