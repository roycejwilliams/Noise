import { getTieredRecommendation } from "./tieredRecommendation.js";
import { runEventDiscoverySurfacingAgent } from "../agent/eventDiscoverySurfacing.js";

export type SurfacingCandidate = {
  userId: string;
  firstName: string;
  phoneNumber: string;
  askText: string;
  city: string | null;
};

// The real, periodic "Luma & X asks surface periodically" mechanism (Royce,
// 2026-08-30) — replaces the old instant-fire-on-every-captured-ask
// behavior, which had no cooldown and could text someone multiple times a
// day. Now driven by jobs/index.ts's cadence cron, same shape as
// ask_checkins' existing check-in cadence. Runs the FULL tiered engine
// (Tier 1 Co event → Tier 2 public Luma event → Tier 3 X opportunity) —
// covers both Luma and X, not just Luma's Tier 2 discovery feed the old
// version was limited to.
export async function attemptEventSurfacing(candidate: SurfacingCandidate): Promise<{ sent: boolean }> {
  const match = await getTieredRecommendation({ text: candidate.askText }, candidate.city).catch((err: any) => {
    console.error("attemptEventSurfacing: getTieredRecommendation failed (non-fatal):", err?.message ?? err);
    return null;
  });
  if (!match) return { sent: false };

  const { sent } = await runEventDiscoverySurfacingAgent(
    { userId: candidate.userId, firstName: candidate.firstName, phoneNumber: candidate.phoneNumber },
    candidate.askText,
    match,
  );

  // Only Tier 1/2 are real shared events worth cross-matching another
  // person against (see eventMatching.ts) — Tier 3 opportunities aren't
  // something two people both "attend."
  if (sent && "event_api_id" in match) {
    const { recordSurfacedEventAndMatch } = await import("./eventMatching.js");
    recordSurfacedEventAndMatch(candidate.userId, match.event_api_id, match.name, match.event_date).catch(
      (err: any) => console.error("attemptEventSurfacing: recordSurfacedEventAndMatch failed (non-fatal):", err?.message ?? err),
    );
  }

  return { sent };
}
