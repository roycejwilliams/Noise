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
  event_followthrough: "companion",
  loop_check: "companion",
  goal_checkin: "companion",
  goal_closed: "companion",
  co_event: "offer",
  direct_ask: "offer",
  search_result: "offer",
  // Work they asked Co to do for them (services/coTasks.ts).
  task_update: "companion",
  in_room: "offer",
  product_update: "ops",
  membership_lapse: "ops",
  event_change: "ops",
  call_reminder: "ops",
  missed_call: "ops",
};

export function typesWithPurpose(purpose: ProactivePurpose): string[] {
  return Object.entries(PROACTIVE_PURPOSE)
    .filter(([, p]) => p === purpose)
    .map(([t]) => t);
}
