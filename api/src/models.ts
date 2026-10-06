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

// Layer 2 evals (api/evals/README.md): every model call is run on Haiku to keep the spend small, except the final
// grading of an output, which is Sonnet. A grader marks its call with GRADER_HEADERS; the meter
// (evals/lib/meter.mjs) lets only those through as Sonnet and rewrites everything else to Haiku. In production this
// has no effect: the header is ignored by the API.
export const GRADER_MODEL = MODELS.sonnet;
export const GRADER_HEADERS = { "x-eval-role": "grader" } as const;
