// A registration's outcome, fed to what already follows events (Royce, 2026-11-09): no new briefing system.
//   - The member picture's events section (services/knowledge/events.ts, pictureEntries.ts), through the plan record it already reads
//     (planned_event_mentions): registered, pending approval or waitlisted, the event and its date, and the reason they approved for THAT
//     event, marked as their words or as Cue's draft they approved. Texts and calls read the same picture. It is a plan, never
//     attendance: only a door scan, an arrival or their own word after it started ever says they went.
//   - The existing debrief (harness/proactiveRegistry.ts draftDebrief): a confirmed registration is recorded as "acted" on the find Cue
//     sent (services/outcomes.ts), which the debrief reads as intent, so after the event it asks a neutral "did you make it?", never
//     "how was it". Pending and waitlisted aren't recorded as acted: they may never get in.
// Nothing here is shared with other members: the plan row has no embedding, so the cross-member overlap match (eventMatching.ts) never
// reads it, and the reason is never promoted to a goal or reused for another event.
import { DateTime } from "luxon";
import pool from "../../db/db.js";
import type { RegistrationRecord } from "./registration.js";
import type { Q } from "./registrationStore.js";

// Pure: whether a plan row is one they're confirmed for. A registration pending the host's approval or on a waitlist is never
// "going" (Royce, 2026-11-09): every reader of planned_event_mentions that says "they said they're going" asks this first.
export const notConfirmedPlan = (registrationStatus: unknown): "pending_approval" | "waitlisted" | null =>
  registrationStatus === "pending_approval" || registrationStatus === "waitlisted" ? registrationStatus : null;
// What a reader says about such a plan instead (model-facing facts, never sent as is).
export const notConfirmedWords = (s: "pending_approval" | "waitlisted") =>
  s === "pending_approval" ? "they asked to go and the host hasn't approved them yet: not confirmed, never say they're going" : "they're on the waitlist: not confirmed, never say they're going";

export type PlanRow = { name: string; date: string | null; status: "registered" | "pending_approval" | "waitlisted"; reason: string | null; reasonSource: "their_words" | "approved_draft" | null };

// Pure: the plan a registration's outcome makes, or null for anything that isn't on (or waiting for) the guest list.
export function planRowFor(rec: Pick<RegistrationRecord, "status" | "eventName" | "form" | "answers">): PlanRow | null {
  const status = rec.status === "already_registered" ? "registered" : rec.status;
  if (status !== "registered" && status !== "pending_approval" && status !== "waitlisted") return null;
  const name = (rec.form?.eventName ?? rec.eventName ?? "").trim();
  if (!name) return null;
  const start = rec.form?.startAt ? DateTime.fromISO(rec.form.startAt, { zone: rec.form.zone ?? "UTC" }) : null;
  // Their reason: the answer to the form's open question, for this event only.
  const open = rec.form?.fields.find((f) => f.kind === "open_question" && rec.answers[f.id]?.value?.trim());
  const a = open ? rec.answers[open.id] : null;
  return {
    name,
    date: start?.isValid ? start.toISODate() : null,
    status,
    reason: a ? a.value.trim().slice(0, 600) : null,
    reasonSource: a ? (a.source === "draft_approved" ? "approved_draft" : "their_words") : null,
  };
}

// The plan row for this registration, made once and updated as its status moves (pending → registered). Stated: their own yes.
export async function recordRegistrationPlan(userId: string, rec: RegistrationRecord, q?: Q): Promise<boolean> {
  const row = planRowFor(rec);
  if (!row) return false;
  const db = q ?? (pool as unknown as Q);
  await db.query(
    `INSERT INTO planned_event_mentions (user_id, event_name_raw, event_date, provenance, quote, registration_id, registration_status, reason, reason_source)
     VALUES ($1, $2, $3::date, 'stated', NULL, $4, $5, $6, $7)
     ON CONFLICT (registration_id) WHERE registration_id IS NOT NULL
     DO UPDATE SET registration_status = EXCLUDED.registration_status, event_date = EXCLUDED.event_date, reason = EXCLUDED.reason, reason_source = EXCLUDED.reason_source`,
    [userId, row.name, row.date, rec.id, row.status, row.reason, row.reasonSource],
  );
  if (row.status === "registered" && rec.itemKey) {
    const { recordSuggestionOutcome } = await import("../outcomes.js");
    await recordSuggestionOutcome(userId, "event", rec.itemKey, row.name, "acted", "registered through Cue", { provenance: "stated", quote: null });
  }
  return true;
}
