// Never assume a member went to an event (Royce, permanent rule, 2026-11-04). A follow-up about a find says what the record supports:
//   attended: a Luma door scan at one of Noise's own events, an arrival Cue saw (their location or "I'm here"), a walk-in check-in,
//             or their own stated word that they went (services/provenance.ts). "How was it / who did you meet" is allowed.
//   intent:   they said they're going, or registered. Only a neutral "did you end up going?", never "how was it".
//   none:     Cue sent it and nothing more (no reply, a yes to hearing more, a no). No follow-up at all.
// A "no" (declined, not interested) drops the follow-up whatever else is there, unless the door says they came.
import { isStated } from "./provenance.js";

export type EvidenceLevel = "attended" | "intent" | "none";
export type Evidence = { level: EvidenceLevel; declined: boolean; why: string };
export type OutcomeRow = { result: string; provenance?: string | null };

export function followUpEvidence(i: {
  rows: OutcomeRow[]; // suggestion_outcomes for this find's keys
  reactions?: (string | null)[]; // revealed_offers.reaction for this find
  came?: boolean; // door scan, an arrival Cue saw, or a walk-in
  walkin?: boolean;
  registered?: boolean; // on the guest list of a Noise event
}): Evidence {
  const rows = i.rows ?? [];
  if (i.came || i.walkin) return { level: "attended", declined: false, why: i.walkin ? "checked in as a walk-in" : "arrived or was scanned at the door" };
  if (rows.some((r) => (r.result === "helped" || r.result === "didnt_help") && isStated(r.provenance))) return { level: "attended", declined: false, why: "said they went" };
  const declined = rows.some((r) => r.result === "declined") || (i.reactions ?? []).some((r) => r === "not_interested");
  if (declined) return { level: "none", declined: true, why: "they said it isn't for them" };
  if (rows.some((r) => r.result === "acted") || i.registered) return { level: "intent", declined: false, why: i.registered && !rows.some((r) => r.result === "acted") ? "registered" : "said they're going" };
  return { level: "none", declined: false, why: "no sign they meant to go" };
}

// A line that takes for granted they went ("How was…", "anyone stood out", "who did you meet").
export const PRESUMES_THEY_WENT = /\bhow (?:was|did|'d|’d)\b|\bhow['’]d\b|\b(?:anyone|anything|who) stood out\b|\bwho did you (?:meet|talk|end up)\b|\bdid you (?:meet|enjoy|have fun)\b|\bmeet anyone\b|\bwhat did you think of\b/i;
