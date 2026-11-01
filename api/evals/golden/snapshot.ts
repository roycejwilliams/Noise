// The member's snapshot for a golden reply turn (snapshot rollout step 3), built by the real builder (services/memberSnapshot.ts
// buildSnapshot, no database) for a member with nothing on file but their name and city: what Cue can do in section 6, their city in
// section 1. The reply reads it the way production does: the whole text as its cached prefix, its entries as the fact check's facts.
import type { ReplySnapshot } from "../../src/services/memberSnapshot.js";

export async function goldenSnapshot(o: { userId: string; firstName: string; city: string; zone: string }): Promise<ReplySnapshot> {
  const S = await import("../../src/services/memberSnapshot.js");
  const { capabilitySheet } = await import("../../src/services/capabilities.js");
  const knowledge: any = { userId: o.userId, asOf: "", identity: { firstName: o.firstName, city: o.city, zone: o.zone }, goals: [], asks: [], delivered: [], carrying: [], lessons: [], corrections: [], preferences: [], claims: [], restraint: null, exchanges: [], person: null, limits: null };
  const built = S.buildSnapshot(
    { userId: o.userId, zone: o.zone, team: false, profile: { firstName: o.firstName, city: o.city, lifeChapters: [], direction: null, activities: [], blockers: [], availability: null, style: [], updatedAt: null }, knowledge, threads: [], coGoals: [], emotions: [], scheduled: [], ledger: [], forgotten: [], names: [], capabilities: capabilitySheet({}) },
    { version: 1 },
  );
  return { prefix: built.body, since: [], entries: S.parseEntries(built.body), version: 1, pinnedVersion: 1, repinned: "none" };
}
