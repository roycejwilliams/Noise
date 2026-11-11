// Issues test users tell Co about (Royce, 2026-09-16: "for test only. If we
// have any issues we decide to tell Co about then it needs to be stored so
// that way when I log on I can ask you if any issues from the test users have
// been reported").
//
// The turn's one read flags feedback (services/readTurn.ts) and Co saves it
// with its tool (agent/conversationTools.ts saveFeedbackForTeam → saveFeedback
// below): user_reported_issues, with the conversation around it, and
// feedback.issueReport in the decision log.
//
// DEV ONLY (Royce, 2026-09-16: "Never commit this to prod this is a dev thing
// only"). It runs only on the co-test service in Railway's dev environment,
// with CAPTURE_USER_ISSUES=true set there. Anywhere else it does nothing,
// even with the flag set, so a merge to main can never turn it on in
// production. Read reports back with `npm run issues`.
import pool from "../db/db.js";
import { isDevService } from "../devService.js";
import { recordDecision } from "../harness/core.js";

export function captureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RAILWAY_ENVIRONMENT_NAME !== "dev" || !isDevService(env.RAILWAY_SERVICE_NAME)) return false;
  return env.CAPTURE_USER_ISSUES === "true";
}

// Co saving feedback itself (conversationTools.ts saveFeedbackForTeam,
// 2026-09-28): "We should find time and date for any event we surface" never
// reached the old word-filter classifier, and Co had to admit it hadn't
// passed it on. Same table, same switch.
export async function saveFeedback(userId: string, message: string, summary: string, recentConversation: string): Promise<boolean> {
  if (!captureEnabled()) return false;
  await pool.query(
    `INSERT INTO user_reported_issues (user_id, message, summary, category, severity, conversation) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, message.slice(0, 2000), summary.slice(0, 500), "feedback", "medium", recentConversation.slice(-3000)],
  );
  await recordDecision({ layer: 2, decision: "feedback.issueReport", userId, outcome: "act", action: "saved_by_co", proposal: { message: message.slice(0, 500), summary } }).catch(() => {});
  return true;
}
