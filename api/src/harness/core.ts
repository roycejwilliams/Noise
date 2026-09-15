// Shared harness for every AI decision point (Royce, 2026-09-14: "all 8
// layers need a harness"). Same shape in every layer:
//
//   gather  — code collects the facts the decision needs, as structured data
//   propose — the model returns structured output, never a side effect
//   gate    — code checks hard rules, then acts, asks, or skips
//   record  — recordDecision writes what was decided and why
//   eval    — evals/<layer>/ cases; a change ships only with zero hard failures
//
// The model is allowed to be wrong. The gate is what keeps a wrong proposal
// from turning into a call, a text, an intro, or a false claim.
import pool from "../db/db.js";

export type Layer = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type Confidence = "high" | "medium" | "low";

// One hard rule. `pass: false` blocks the action; `reason` says why in
// plain words so the decision log is readable without the code open.
export type GateCheck = { name: string; pass: boolean; reason?: string };

export type Outcome = "act" | "ask" | "skip";

export type HarnessDecision = {
  layer: Layer;
  // Stable name for the decision point, e.g. "router.decideActions",
  // "proactive.dailyPick", "reply.grounding".
  decision: string;
  userId: string | null;
  outcome: Outcome;
  // What was done (or would have been), e.g. "place_call", "send:event_tease".
  action?: string | null;
  proposal?: unknown;
  checks?: GateCheck[];
  confidence?: Confidence | null;
  reason?: string | null;
};

export function gate(checks: GateCheck[]): { ok: boolean; failed: GateCheck[] } {
  const failed = checks.filter((c) => !c.pass);
  return { ok: failed.length === 0, failed };
}

// Plain-words summary of failed checks, for logs and reply context.
export function describeFailed(failed: GateCheck[]): string {
  return failed.map((c) => (c.reason ? `${c.name}: ${c.reason}` : c.name)).join("; ");
}

// Non-fatal: a logging failure never changes what happens to the person.
export async function recordDecision(d: HarnessDecision): Promise<void> {
  await pool
    .query(
      `INSERT INTO harness_decisions (layer, decision, user_id, outcome, action, proposal, checks, confidence, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        d.layer,
        d.decision,
        d.userId,
        d.outcome,
        d.action ?? null,
        d.proposal === undefined ? null : JSON.stringify(d.proposal),
        JSON.stringify(d.checks ?? []),
        d.confidence ?? null,
        d.reason ?? null,
      ],
    )
    .catch((err: any) => console.error(`recordDecision(${d.decision}) failed (non-fatal):`, err?.message ?? err));
}
