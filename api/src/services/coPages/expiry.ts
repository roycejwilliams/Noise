// Before a page or deck a member has been using expires, Co tells them, and one word keeps it (Royce, 2026-10-11): "renew" for 90
// more days, "keep" for good (agent/artifactTools.ts keepArtifact). In use = their link opened, or changed, in the last 30 days
// (store.ts expiringInUse). Kept ones never expire and are never warned about. One notice per lifetime; a renewal resets it.
// The text goes out through the proactive harness (hours, caps and quiet times apply), in fixed wording, since it names a date.
import { DateTime } from "luxon";
import { enqueueCandidate } from "../../harness/proactive.js";
import { expiringInUse } from "./store.js";

// Pure: the notice. Plain, one text, the one word they can send.
export function expiryText(title: string, kind: "page" | "deck", dateLabel: string): string {
  return `Your ${kind} "${title}" expires ${dateLabel}. Reply renew for 90 more days, or keep to keep it for good.`;
}
export function expiryDateLabel(at: Date, zone: string | null): string {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  return DateTime.fromJSDate(at).setZone(z).toFormat("ccc, LLL d");
}

// Daily: queue a notice for each artifact about to expire that they've been using.
export async function enqueueExpiryWarnings(now = new Date()): Promise<number> {
  let n = 0;
  for (const a of await expiringInUse()) {
    const r = await enqueueCandidate({
      userId: a.ownerUserId,
      type: "artifact_expiry",
      targetKey: `artifact_expiry:${a.id}:${a.expiresAt.toISOString().slice(0, 10)}`,
      topicKey: `artifact_expiry:${a.id}`,
      summary: `Their ${a.kind} "${a.title}" expires soon; one word keeps it`,
      payload: { pageId: a.id },
      expiresAt: new Date(Math.min(a.expiresAt.getTime(), now.getTime() + 6 * 86400_000)),
    }).catch(() => ({ queued: false }));
    if (r.queued) n++;
  }
  return n;
}
