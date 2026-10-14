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
import { recordDecision } from "../harness/core.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
// Everything it reads goes through the one source fence (services/sourceFence.ts): their own texts to Co and Co's own replies to
// them, never their talk with anyone else and never another member's details (Royce, 2026-10-13).
import { fenceReplyLog, fenceTheirTexts, memberFence, readLessonOriginals, readReplyLog, readTheirTexts, type Fence, type ReplyLog, type TheirText } from "./sourceFence.js";

export type { ReplyLog, TheirText };
export type LessonCause = "check" | "co" | "unknown";
// evidence: the log it was read from, kept with its check (lesson.check) so the lesson can be checked again when the same failure shows up.
export type CheckedLesson = { text: string; cause: LessonCause; causeLine: string | null; original: string; evidence?: { replies: ReplyLog[]; theirs: TheirText[] } };

// How far back a reply still explains this pushback, and how many of them.
const LOG_WINDOW_MIN = 30;
const LOG_REPLIES = 3;
export const HYPOTHESIS_MARK = "Hypothesis (cause not confirmed in the logs):";

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

// Lines handed in (o.logs, o.theirs) go through the same fence as lines read here. What the model writes back is fenced too: a lesson
// or cause that names someone else is never kept as confirmed. Evidence only the fence removed can't confirm anything.
export async function checkLesson(userId: string, i: { message: string; pushback: string | null; lesson: string }, o: { logs?: ReplyLog[]; theirs?: TheirText[]; read?: LessonReader; fence?: Pick<Fence, "strip"> } = {}): Promise<CheckedLesson> {
  const fence = o.fence ? { userId, ...o.fence } : await memberFence(userId);
  const logs = o.logs ? fenceReplyLog(fence, o.logs) : await readReplyLog(fence, LOG_WINDOW_MIN, LOG_REPLIES).catch(() => [] as ReplyLog[]);
  if (!logs.length) return noLogVerdict(i.lesson);
  const theirs = o.theirs ? fenceTheirTexts(fence, o.theirs) : o.logs ? [] : await readTheirTexts(fence, LOG_WINDOW_MIN, LOG_REPLIES + 2).catch(() => [] as TheirText[]);
  try {
    const p = parseModelJson(await (o.read ?? haikuRead)(lessonPrompt({ message: i.message, pushback: (i.pushback ? fence.strip(i.pushback) : null) ?? "", lesson: i.lesson, logs, theirs }))) ?? {};
    // Code guards the fact the model names: "check" only when the log shows the check changed a reply, "co" only when one went out
    // as drafted. Otherwise it is a hypothesis (review of the 10-13 fixes).
    const checkChanged = logs.some((l) => l.outcome !== "as_drafted" && l.draft.trim() !== l.sent.trim());
    const sentAsDrafted = logs.some((l) => l.outcome === "as_drafted");
    const named: LessonCause = p.cause === "check" || p.cause === "co" ? p.cause : "unknown";
    const cause: LessonCause = (named === "check" && checkChanged) || (named === "co" && sentAsDrafted) ? named : "unknown";
    const rawLesson = typeof p.lesson === "string" && p.lesson.trim() ? p.lesson.trim().slice(0, 240) : null;
    const rawCause = typeof p.causeLine === "string" && p.causeLine.trim() && p.causeLine.trim().toLowerCase() !== "null" ? p.causeLine.trim().slice(0, 240) : null;
    // Fenced on the way out: anything the strip changes or blanks is dropped (the guess stands, as a hypothesis).
    const outOk = (t: string | null) => (t !== null && fence.strip(t)?.trim() === t.trim() ? t : null);
    const lesson = outOk(rawLesson) ?? i.lesson;
    const causeLine = outOk(rawCause);
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
  const fence = await memberFence(userId);
  // A guess that itself carries another member's details is never kept, not even as a hypothesis.
  if (fence.strip(i.lesson)?.trim() !== i.lesson.trim()) {
    await recordDecision({ layer: 3, decision: "lesson.check", userId, outcome: "skip", action: "withheld", reason: fence.failed ? "member names couldn't be read, so the lesson wasn't checked or kept" : "the guessed lesson carried details from outside their own conversation", proposal: { pushback: null } }).catch(() => {});
    return;
  }
  const seen = await readLessonOriginals(fence, 7).then((xs) => xs.some((x) => norm(x) === norm(i.lesson))).catch(() => false);
  if (seen) return;
  const r = await checkLesson(userId, i, { fence });
  await recordDecision({ layer: 3, decision: "lesson.check", userId, outcome: "act", action: r.cause, reason: r.causeLine, proposal: { original: r.original, stored: r.text, pushback: i.pushback, message: i.message, evidence: r.evidence ?? null } }).catch(() => {});
  const { saveLesson } = await import("./connectDots.js");
  await saveLesson(userId, r.text);
}
