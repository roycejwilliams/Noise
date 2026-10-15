import type { ExemptType, ProactiveType } from "./proactive.js";

// What each proactive message is FOR (2026-09-22, audit against Co's core
// goal: a genuine, ongoing life companion; events are the near-term wedge,
// not the product). "companion" is about the person and their life,
// "offer" is something to go to or someone to meet, "ops" is logistics.
// Every type must be listed: evals/vision/rules.ts fails on a new type that
// isn't, and harness/metrics.ts reads it to compare replies to companion
// messages against replies to offers.
export type ProactivePurpose = "companion" | "offer" | "ops";
// in_room: live nudges sent at an event (recordInRoomSend), logged as their own type.
export const PROACTIVE_PURPOSE: Record<ProactiveType | ExemptType | "in_room", ProactivePurpose> = {
  companion: "companion",
  post_call: "companion",
  window_followup: "companion",
  ask_checkin: "companion",
  debrief: "companion",
  event_offer: "offer",
  network_tease: "offer",
  event_match_nudge: "offer",
  calendar_follow: "offer",
  ask_solicitation: "offer",
  pre_arrival: "offer",
  event_brief: "offer",
  brief_name_ask: "offer",
  room_share_ask: "offer",
  event_followthrough: "companion",
  mo_member_offer: "offer",
  mo_member_voice: "offer",
  mo_member_batch: "offer",
  mo_member_update: "offer",
  loop_check: "companion",
  goal_checkin: "companion",
  goal_closed: "companion",
  // The goal recheck (services/goalRecheck.ts): whether a goal is still theirs to look for.
  goal_recheck: "companion",
  // Member-state nudges (services/memberStateNudges.ts): about their own life and what they said, except a deadline on a find.
  intro_nudge: "companion",
  goal_nudge: "companion",
  commitment_nudge: "companion",
  deadline_nudge: "offer",
  co_event: "offer",
  direct_ask: "offer",
  search_result: "offer",
  // Work they asked Co to do for them (services/coTasks.ts).
  task_update: "companion",
  // What Co said on a call it would send, confirmed the moment they hang up (services/callFollowThrough.ts).
  call_confirm: "companion",
  // A commitment that will miss its window, said before it passes, with the new time (services/taskTurn.ts).
  task_window: "companion",
  in_room: "offer",
  product_update: "ops",
  artifact_expiry: "ops",
  event_change: "ops",
  call_reminder: "ops",
  missed_call: "ops",
};

export function typesWithPurpose(purpose: ProactivePurpose): string[] {
  return Object.entries(PROACTIVE_PURPOSE)
    .filter(([, p]) => p === purpose)
    .map(([t]) => t);
}
