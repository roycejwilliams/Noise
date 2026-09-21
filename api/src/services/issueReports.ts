// Issues test users tell Co about (Royce, 2026-09-16: "for test only. If we
// have any issues we decide to tell Co about then it needs to be stored so
// that way when I log on I can ask you if any issues from the test users have
// been reported").
//
//   gate     plain rule: the message is about Co and sounds like a problem or
//            feedback (cheap, runs on every text)
//   confirm  Haiku reads the message in context and says whether it's really
//            a report about Co, not about their own life, with a one-line
//            summary and a category
//   store    user_reported_issues, with the conversation around it
//   record   feedback.issueReport in the decision log
//
// DEV ONLY (Royce, 2026-09-16: "Never commit this to prod this is a dev thing
// only"). It runs only on the co-test service in Railway's dev environment,
// with CAPTURE_USER_ISSUES=true set there. Anywhere else it does nothing,
// even with the flag set, so a merge to main can never turn it on in
// production. Read reports back with `npm run issues`.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { recordDecision } from "../harness/core.js";
import { jevIssue, shadow } from "./jevClassifiers.js";

export const ISSUE_CATEGORIES = ["bug", "wrong_info", "behavior", "speed", "feature_request", "other"] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];
export type IssueReport = { summary: string; category: IssueCategory; severity: "low" | "medium" | "high" };

export function captureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RAILWAY_ENVIRONMENT_NAME !== "dev" || env.RAILWAY_SERVICE_NAME !== "co-test") return false;
  return env.CAPTURE_USER_ISSUES === "true";
}

const ABOUT_CO = /\b(you|your|you're|youre|co|co's|this app|the app|the bot|texts?|messages?|link|links|search|call)\b/i;
const PROBLEM = /\b(bug|broken|glitch|error|issue|problem|wrong|incorrect|not working|doesn'?t work|didn'?t work|isn'?t working|won'?t|can'?t|couldn'?t|failed|fail|crash|twice|again and again|repeat(ed|ing)?|same (thing|message|event)|spam|slow|took (so )?long|forever|confus|weird|off|annoying|frustrat|should(n'?t)?|stop (doing|sending)|never (sent|came|got)|didn'?t (get|send|come)|missing|feedback|fix|so long|too long|takes? (you )?(so |too )?long|taking (so |too )?long|ignor\w*|didn'?t (answer|respond|reply|listen|read|hear)|not what i (asked|said|meant)|made (it|that|this) up|doesn'?t exist|not real|fake|invent\w*|hallucinat\w*|lying|lied)\b/i;
const EXPLICIT = /\b(bug|feedback|report (a|an|this) (bug|issue|problem)|glitch)\b/i;

// Feedback phrased as a suggestion rather than a complaint (2026-09-18: "if
// you don't have an understanding of the context... ask clarifying questions
// ... rather than just ... sending them anything" had no problem word, was
// never saved, and Co said it went "straight to the team").
const SUGGESTION = /\b(something to (think about|consider)|(you|co) (should|shouldn'?t|need to|needs to|have to|has to|must|ought to)|we (should|must|need to|have to)|(ask|asking) (clarifying|me|first|before)|clarifying questions?|rather than|instead of|would be (nice|better|great)|it'?d be (nice|better|great)|make sure (you|to|co)|be (more )?(diligent|careful)|next time)\b/i;

// Plain-rule gate. Wide on purpose: the model confirms.
export function mayBeIssueReport(text: string): boolean {
  const t = text.trim();
  if (t.length < 6) return false;
  return EXPLICIT.test(t) || (ABOUT_CO.test(t) && (PROBLEM.test(t) || SUGGESTION.test(t)));
}

export function issuePrompt(message: string, recentConversation: string): string {
  return `Someone is testing an AI texting companion called Co. Decide whether their latest message reports a problem with Co itself, or gives feedback on how Co works.

Recent conversation (oldest first):
${recentConversation.slice(-2500)}

Their latest message: "${message}"

It IS a report when they point out something Co did wrong or badly (sent the same thing twice, wrong or made-up info, a broken or missing link, ignored what they said, too slow, confusing), or say how Co should work differently.
It is NOT a report when the problem is in their own life (a bad day, a hard week, a work issue), when they're just asking Co for something, or when they're pushing back on a normal answer without saying Co got something wrong.

Return ONLY JSON:
{"isIssue": true or false, "summary": "one plain sentence a developer can act on, or null", "category": ${ISSUE_CATEGORIES.map((c) => `"${c}"`).join(" | ")}, "severity": "low" | "medium" | "high"}`;
}

export async function classifyIssue(message: string, recentConversation: string): Promise<IssueReport | null> {
  const { text } = await generateText({
    model: anthropic(MODELS.haiku),
    experimental_telemetry: { isEnabled: true, functionId: "issueReports.classify" },
    prompt: issuePrompt(message, recentConversation),
  });
  const p = parseModelJson<{ isIssue?: boolean; summary?: string | null; category?: string; severity?: string }>(text);
  if (!p.isIssue || typeof p.summary !== "string" || !p.summary.trim()) return null;
  const category = (ISSUE_CATEGORIES as readonly string[]).includes(p.category ?? "") ? (p.category as IssueCategory) : "other";
  const severity = p.severity === "high" || p.severity === "medium" ? p.severity : "low";
  return { summary: p.summary.trim().slice(0, 300), category, severity };
}

// Returns the stored report, or null when this message isn't one (or capture
// is off). Never throws: a failure here must not block the reply.
export async function captureIssueReport(userId: string, message: string, recentConversation: string): Promise<IssueReport | null> {
  if (!captureEnabled() || !mayBeIssueReport(message)) return null;
  try {
    const report = await classifyIssue(message, recentConversation);
    void shadow("issue", userId, report ? { isIssue: true, category: report.category, severity: report.severity } : { isIssue: false }, () => jevIssue(message, recentConversation, ISSUE_CATEGORIES), (j) => j.isIssue === !!report, (j) => ({ isIssue: j.isIssue, category: j.category, severity: j.severity, p: j.pIssue }), { message: message.slice(0, 200) });
    await recordDecision({
      layer: 2,
      decision: "feedback.issueReport",
      userId,
      outcome: report ? "act" : "skip",
      action: report ? "saved" : "not_an_issue",
      proposal: { message: message.slice(0, 500), report },
    });
    if (!report) return null;
    await pool.query(
      `INSERT INTO user_reported_issues (user_id, message, summary, category, severity, conversation) VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, message.slice(0, 2000), report.summary, report.category, report.severity, recentConversation.slice(-3000)],
    );
    return report;
  } catch (err: any) {
    console.error("captureIssueReport failed (non-fatal):", err?.message ?? err);
    return null;
  }
}
