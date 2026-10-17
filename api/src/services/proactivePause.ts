// The pause on unprompted outreach (Royce, 2026-10-06). PROACTIVE_PAUSED=true stops every send Co starts on its own: the proactive
// dispatcher and its exempt door (harness/proactive.ts), automatic calls (services/callTrigger.ts: auto intake and the check-in
// cadence). Replies to someone who texts, calls or DMs Co, and anything a member asked for, are
// never paused. Pending messages wait; nothing is dropped.
export function proactivePaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROACTIVE_PAUSED === "true";
}

// Types held while the rest flows (PROACTIVE_PAUSED_TYPES=ask_checkin,window_followup). Candidates of these types wait.
export function pausedTypes(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PROACTIVE_PAUSED_TYPES ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

// Parked types, in code, never an env switch. goal_nudge (Royce, 2026-10-17: "Park the member-state 'goal gone quiet' nudge and let
// the Nudges helper be the one goal nudge. ... Park, don't delete."): the one goal nudge left is the goal recheck
// (services/goalRecheck.ts: a quiet goal is asked once, an ignored ask lets the goal go idle). Why: goal_nudge never fired since it
// was built (10-08), it asks nearly the recheck's question, and goal_season already holds the goal texts to one slot (sweep review
// 2026-10-17). A parked type is not queued (services/memberStateNudges.ts planNudges) and a row already pending is never loaded by
// the dispatcher, so it is never picked, drafted or sent; it expires on its own date (expires_at) and its onDropped marks it. Its
// code (detector, draft, registry entry, gates) is kept, and the detector still feeds call reasons. To turn it back on, take it out
// of this list.
export const PARKED_TYPES: readonly string[] = ["goal_nudge"];

// Every type the dispatcher leaves where it is: the env pause list plus the parked ones.
export function heldTypes(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...pausedTypes(env), ...PARKED_TYPES])];
}
