// When someone may be in danger (Royce, 2026-09-28: "fix the weaker points
// then handle the rest"; there was no crisis handling anywhere, texts or
// calls). A companion people confide in will hear this eventually.
//
// Co decides, code guards: Co reads every message and flags a safety concern
// with its flagSafetyConcern tool when it hears one, however it's worded. A
// short list of unmistakable phrases only ADDS: it makes sure Co has the
// guidance in front of it and the team hears about it even if Co missed it.
// It never overrides what Co understood.
//
// What follows a flag: Co stays with them, asks plainly whether they're safe,
// and gives 988 (and 911 for immediate danger); no tapback instead of a
// reply; no offers for three days; a gentle check-in the next day; and the
// team is emailed, without the message itself.
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";

export { CRISIS_RESOURCES, SAFETY_INSTRUCTION, soundsLikeCrisis } from "./safetyText.js";

// A flag Co raised (or the phrase list caught). Holds offers, queues a
// check-in for tomorrow, and tells the team once per member per day.
export async function recordSafetyConcern(userId: string, firstName: string | null, source: "co" | "phrase", note: string): Promise<void> {
  await pool.query(`UPDATE co_profiles SET safety_hold_until = NOW() + INTERVAL '3 days' WHERE user_id = $1`, [userId]).catch(() => {});
  await recordDecision({ layer: 3, decision: "safety.concern", userId, outcome: "act", action: source, reason: note.slice(0, 200) }).catch(() => {});
  const { enqueueCandidate } = await import("../harness/proactive.js");
  await enqueueCandidate({
    userId,
    type: "companion",
    targetKey: `companion:safety:${new Date().toISOString().slice(0, 10)}`,
    topicKey: "companion",
    summary: "Check in gently on how they're doing after what they shared yesterday",
    payload: {
      recap: "",
      threadId: null,
      thread: { text: "how they're doing today, after what they shared with Cue yesterday, which was really heavy", quote: "", dueDate: null, feeling: "in real pain" },
      item: null,
      safetyFollowUp: true,
    },
    dueAt: new Date(Date.now() + 18 * 3_600_000),
    expiresAt: new Date(Date.now() + 3 * 24 * 3_600_000),
  }).catch((err: any) => console.error("safety: follow-up enqueue failed (non-fatal):", err?.message ?? err));
  const { alertTeamNow } = await import("../harness/monitor.js");
  await alertTeamNow(
    `safety:${userId}:${new Date().toISOString().slice(0, 10)}`,
    `Cue alert: ${firstName ?? "a member"} may not be safe`,
    `Something ${firstName ?? "a member"} said to Cue today may mean they're thinking about hurting themselves (${source === "co" ? "Cue flagged it" : "matched a crisis phrase"}). Cue asked if they're safe and gave them 988. Their message isn't included here.</p>` +
      `<p><b>What to do now:</b></p><ol>` +
      `<li>Whoever reads this first: reply-all "I've got it" so no one else doubles up.</li>` +
      `<li>Read the conversation on the dashboard within the hour.</li>` +
      `<li>If they may be in immediate danger (a plan, a time, the means), call 911 for their location. Don't wait on Cue.</li>` +
      `<li>Otherwise, a real person from the team texts or calls them today, briefly and warmly, as themselves, not as Cue. Point to 988 again.</li>` +
      `<li>Note what you did in the dashboard. Cue has already paused offers for 3 days and will check in tomorrow.</li></ol><p>`,
  ).catch(() => {});
}

export async function safetyHoldActive(userId: string): Promise<boolean> {
  return pool
    .query(`SELECT 1 FROM co_profiles WHERE user_id = $1 AND safety_hold_until > NOW()`, [userId])
    .then((r) => r.rows.length > 0)
    .catch(() => false);
}
