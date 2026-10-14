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
