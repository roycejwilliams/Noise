// The only place model IDs are written. Policy (Royce, 2026-09-14):
// - sonnet: anything that acts on people or needs judgment (routing, reply,
//   grounding, proactive drafts, match scoring, consent, profile judgment)
// - haiku: narrow work that code checks afterwards (extraction, query
//   rewrites, short yes/no reads, one-line drafts)
// No Opus: it matched Sonnet 5 on the router eval at ~2.5x the cost.
// Files keep their own named constants (e.g. ROUTER_MODEL) pointing here, so
// a model change is one line in this file plus the eval for that layer.
export const MODELS = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
} as const;
