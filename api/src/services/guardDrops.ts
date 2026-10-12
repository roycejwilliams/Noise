// One decision row per guard drop (2026-10-12 audit: the identity guard, date guard, Jev fact check and overpromise drops left no
// record, so how often each fires, and where, couldn't be measured). Type, where and why only: never the message text, so a row
// can be read without carrying what a member said or what Co drafted.

export type GuardKind = "identity" | "date" | "fact_check" | "overpromise";
export type GuardDrop = { guard: GuardKind; where: string; reason: string; userId?: string | null; count?: number };

// Pure: the row.
export function guardDropRow(d: GuardDrop) {
  return {
    layer: 3 as const,
    decision: "guard.drop",
    userId: d.userId ?? null,
    outcome: "skip" as const,
    action: d.guard,
    reason: d.reason.slice(0, 200),
    proposal: { where: d.where, count: d.count ?? 1 },
  };
}

export function recordGuardDrop(d: GuardDrop): void {
  import("../harness/core.js")
    .then(({ recordDecision }) => recordDecision(guardDropRow(d)))
    .catch(() => {});
}

// A date drop recorded, returning its skip reason unchanged (harness/proactiveRegistry.ts).
export function dateDropped(userId: string | null, where: string, why: string): string {
  recordGuardDrop({ guard: "date", where, userId, reason: why });
  return why;
}

// An identity drop: the guard (identityGuard.ts) changed the text.
export function identityDropped(before: string, after: string | null, where: string, userId?: string | null): void {
  if ((after ?? "").trim() !== (before ?? "").trim()) recordGuardDrop({ guard: "identity", where, userId, reason: after?.trim() ? "a sentence said who they are beyond what they told Co" : "the whole text said who they are beyond what they told Co" });
}
