// A lesson from their pushback is checked against what really caused it before it is kept (Royce, 2026-10-13: "Saved lessons get
// verified against the actual cause before they're stored. ... A lesson that misdiagnoses the failure compounds quietly. When a
// failure's cause is known in code or logs, the lesson must reference it; when it isn't, the lesson saves as a hypothesis, marked as
// one"). That day Co kept "describe it in his terms instead of relabeling it as an event search" when the real failure was the reply
// check's false "Nothing's running on that right now" line.
//
// The log it reads: the reply check's record of Co's last few replies (harness_decisions reply.grounding), what Co drafted next to what
// went out and why anything changed. One short model read decides which it was:
//   - check: what they pushed back on was written or caused by the reply check, not Co's draft. Kept naming that cause.
//   - co: Co's own draft said it, and it went out as drafted. Kept naming that cause.
//   - unknown: the log doesn't show it (nothing logged, or it doesn't cover what they pushed back on). Kept as a hypothesis.
// Every check is logged (lesson.check), so the team sees the cause next to the lesson. Never a text or an email.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { notToTeammate } from "./teamLines.js";

export type ReplyLog = { at: Date; outcome: string; draft: string; sent: string; why: string | null };
export type LessonCause = "check" | "co" | "unknown";
// evidence: the log it was read from, kept with its check (lesson.check) so the lesson can be checked again when the same failure shows up.
export type CheckedLesson = { text: string; cause: LessonCause; causeLine: string | null; original: string; evidence?: { replies: ReplyLog[]; theirs: TheirText[] } };

// How far back a reply still explains this pushback, and how many of them.
const LOG_WINDOW_MIN = 30;
const LOG_REPLIES = 3;
export const HYPOTHESIS_MARK = "Hypothesis (cause not confirmed in the logs):";

// Their own messages in the same window, so the read sees what each reply answered.
export type TheirText = { at: Date; text: string };
export async function recentTheirTexts(userId: string): Promise<TheirText[]> {
  const { rows } = await pool.query(
    `SELECT created_at, content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > NOW() - ($2 || ' minutes')::interval ORDER BY created_at DESC LIMIT ${LOG_REPLIES + 2}`,
    [userId, String(LOG_WINDOW_MIN)],
  );
  return rows.reverse().map((r: any) => ({ at: new Date(r.created_at), text: String(r.content).replace(/^User said:\s*/, "") }));
}

export async function recentReplyLogs(userId: string): Promise<ReplyLog[]> {
  const { rows } = await pool.query(
    `SELECT created_at, action, proposal, reason FROM harness_decisions WHERE user_id = $1 AND decision = 'reply.grounding' AND created_at > NOW() - ($2 || ' minutes')::interval ORDER BY created_at DESC LIMIT ${LOG_REPLIES}`,
    [userId, String(LOG_WINDOW_MIN)],
  );
  return rows.reverse().map((r: any) => ({ at: new Date(r.created_at), outcome: String(r.action ?? ""), draft: String(r.proposal?.draft ?? ""), sent: String(r.proposal?.final ?? ""), why: r.reason ? String(r.reason) : null }));
}

// Pure: the stored text for a verdict. A known cause is named in the lesson; an unknown one is marked a hypothesis.
export function lessonText(lesson: string, cause: LessonCause, causeLine: string | null): string {
  const l = lesson.trim();
  if (cause === "unknown" || !causeLine?.trim()) return `${HYPOTHESIS_MARK} ${l}`;
  return `${l} [cause, from the logs: ${causeLine.trim().replace(/[.\s]+$/, "")}]`;
}

// Pure: with nothing logged there is nothing to read, and the lesson is a hypothesis without a model read.
export function noLogVerdict(lesson: string): CheckedLesson {
  return { text: lessonText(lesson, "unknown", null), cause: "unknown", causeLine: null, original: lesson };
}

export type LessonReader = (prompt: string) => Promise<string>;
const haikuRead: LessonReader = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 400, abortSignal: AbortSignal.timeout(8000), experimental_telemetry: { isEnabled: true, functionId: "lessonCheck" }, prompt })).text;

export function lessonPrompt(i: { message: string; pushback: string; lesson: string; logs: ReplyLog[]; theirs?: TheirText[] }): string {
  const entries = [
    ...i.logs.map((l) => ({ at: l.at.getTime(), text: `Co's reply (${l.outcome}):\nCo drafted: "${l.draft.slice(0, 600)}"\nWhat went out: "${l.sent.slice(0, 600)}"${l.why ? `\nWhy the check changed it: ${l.why.slice(0, 400)}` : ""}` })),
    ...(i.theirs ?? []).map((t) => ({ at: t.at.getTime(), text: `They texted: "${t.text.slice(0, 300)}"` })),
  ].sort((a, b) => a.at - b.at);
  const logs = entries.map((e) => e.text).join("\n\n");
  return `A member pushed back on a companion's texts, and a lesson was guessed from it. Check the guess against the log of the companion's last replies: what the companion drafted, what a reply check let go out instead, and why.

Their message: "${i.message.slice(0, 400)}"
What they pushed back on: ${i.pushback.slice(0, 200)}
The guessed lesson: ${i.lesson.slice(0, 240)}

The log (oldest first):
${logs}

Decide what caused the thing they pushed back on. Follow the chain, not just the last reply: if the reply check cut or replaced a true answer earlier in this log, and the replies after it went off course from there (the companion answering the replaced line, narrowing or reframing to make sense of it), the cause is the check.
- "check": it is in what went out but not in what the companion drafted (the reply check cut, replaced or added it), or it follows from an earlier reply the check changed. The companion's own behavior didn't start it.
- "co": the companion drafted it, and it went out as drafted.
- "unknown": the log doesn't show the thing they pushed back on.
Then write the lesson that fits the real cause, in one short sentence: for "check", say which line came from the reply check and what was true instead, if the log shows it; for "co", keep or correct the guess so it addresses what the draft actually did; for "unknown", keep the guess. causeLine: one short plain line naming the cause from the log (for example "the reply check replaced Co's answer with 'Nothing's running on that right now' (claim_work_status)"), or null for unknown.

Return ONLY JSON: {"cause": "check" | "co" | "unknown", "lesson": "...", "causeLine": "..." or null}`;
}

export async function checkLesson(userId: string, i: { message: string; pushback: string | null; lesson: string }, o: { logs?: ReplyLog[]; theirs?: TheirText[]; read?: LessonReader } = {}): Promise<CheckedLesson> {
  const logs = o.logs ?? (await recentReplyLogs(userId).catch(() => [] as ReplyLog[]));
  if (!logs.length) return noLogVerdict(i.lesson);
  const theirs = o.theirs ?? (o.logs ? [] : await recentTheirTexts(userId).catch(() => [] as TheirText[]));
  try {
    const p = parseModelJson(await (o.read ?? haikuRead)(lessonPrompt({ message: i.message, pushback: i.pushback ?? "", lesson: i.lesson, logs, theirs }))) ?? {};
    // Code guards the fact the model names: "check" only when the log shows the check changed a reply, "co" only when one went out
    // as drafted. Otherwise it is a hypothesis (review of the 10-13 fixes).
    const checkChanged = logs.some((l) => l.outcome !== "as_drafted" && l.draft.trim() !== l.sent.trim());
    const sentAsDrafted = logs.some((l) => l.outcome === "as_drafted");
    const named: LessonCause = p.cause === "check" || p.cause === "co" ? p.cause : "unknown";
    const cause: LessonCause = (named === "check" && checkChanged) || (named === "co" && sentAsDrafted) ? named : "unknown";
    const lesson = typeof p.lesson === "string" && p.lesson.trim() ? p.lesson.trim().slice(0, 240) : i.lesson;
    const causeLine = typeof p.causeLine === "string" && p.causeLine.trim() && p.causeLine.trim().toLowerCase() !== "null" ? p.causeLine.trim().slice(0, 240) : null;
    const known = cause !== "unknown" && !!causeLine;
    return { text: lessonText(known ? lesson : i.lesson, known ? cause : "unknown", known ? causeLine : null), cause: known ? cause : "unknown", causeLine: known ? causeLine : null, original: i.lesson, evidence: { replies: logs, theirs } };
  } catch {
    return noLogVerdict(i.lesson);
  }
}

// The text route's one call: check, log, then keep it (services/connectDots.ts saveLesson). In the background, never slows a reply.
export async function checkAndSaveLesson(userId: string, i: { message: string; pushback: string | null; lesson: string }): Promise<void> {
  // The stored words vary with each read, so a repeat is caught on the guessed lesson it came from (the last 7 days of checks: an
// older one may have left the newest lessons Co reads, and comes back).
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();
  const seen = await pool
    .query(`SELECT proposal->>'original' AS original FROM harness_decisions WHERE user_id = $1 AND decision = 'lesson.check' AND created_at > NOW() - INTERVAL '7 days'`, [userId])
    .then((r) => r.rows.some((x: any) => norm(String(x.original ?? "")) === norm(i.lesson)))
    .catch(() => false);
  if (seen) return;
  const r = await checkLesson(userId, i);
  await recordDecision({ layer: 3, decision: "lesson.check", userId, outcome: "act", action: r.cause, reason: r.causeLine, proposal: { original: r.original, stored: r.text, pushback: i.pushback, message: i.message, evidence: r.evidence ?? null } }).catch(() => {});
  const { saveLesson } = await import("./connectDots.js");
  await saveLesson(userId, r.text);
}
