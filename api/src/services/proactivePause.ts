// The pause on unprompted outreach (Royce, 2026-10-06). PROACTIVE_PAUSED=true stops every send Co starts on its own: the proactive
// dispatcher and its exempt door (harness/proactive.ts), automatic calls (services/callTrigger.ts: auto intake and the check-in
// cadence) and Mo's outreach (mo/outreach.ts). Replies to someone who texts, calls or DMs Co, and anything a member asked for, are
// never paused. Pending messages wait; nothing is dropped.
export function proactivePaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROACTIVE_PAUSED === "true";
}
