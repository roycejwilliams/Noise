// Queued work meets the purpose boundary (Royce, 2026-11-04). The check (harness/scope.ts) runs again when a task wakes, because a
// task opened before the boundary, or one that drifted, may be outside it now. Out-of-scope work is never silently dropped and never
// claimed done:
//   - a member asked for it (or was promised it): one natural line goes through the door, in words the model writes fresh each time
//     (guidance for tone, never a stock line, no forced intro), then the task closes as dropped. If no line can be written or sent,
//     it closes anyway, quietly, and nothing says it was done.
//   - Cue's own look-out, a goal check-in or reminder, a follow-up check-in: it closes quietly at its natural end. Nothing is texted
//     about work the member never asked for.
// This is the existing wake with a different job: no new scheduled run, and at most the one draft a wake could already have made.
import { judgeScope, OUT_OF_SCOPE_GUIDANCE, parseVerdict, workText, type Scope } from "../harness/scope.js";
import type { CoTask } from "./coTasks.js";

// What a task is, for the check: the model's verdict stored on it when it started (followup.scope), else its goal, steps and next plan
// read by the narrow backstop; a follow-up's summary; a goal check-in or reminder's own goal line. A task with a stored "in" is in whatever
// its words say (Cue's own deliveries carry one), and a stored "mixed" never reaches here (it is refused at the start).
export function scopeOfTask(t: Pick<CoTask, "goal" | "steps" | "planNext" | "kind" | "followup">): Scope {
  const v = parseVerdict(t.followup?.scope);
  const text = t.kind === "followup" ? `${t.goal}\n${t.followup?.summary ?? ""}` : workText({ goal: t.goal, steps: t.steps, planNext: t.planNext });
  return judgeScope(text, v && v.scope !== "mixed" ? v : null);
}

// Pure: whether the member asked for this (or was promised it), so they're owed one line instead of a quiet close.
export function memberWaitsOn(t: Pick<CoTask, "kind" | "source" | "lookoutOrigin" | "followup">): boolean {
  if (t.kind !== "work" || t.followup?.checkin) return false;
  return t.source === "ask" || t.source === "promise" || (t.source === "lookout" && t.lookoutOrigin === "member");
}

export type HandBackDeps = {
  firstName: string;
  // One draft in fresh words, or null (the model chose to skip, or the draft broke a rule).
  draft: (facts: Record<string, string>, task: string) => Promise<string | null>;
  // Sends through the door; reports whether it went or was queued.
  send: (text: string) => Promise<{ sent: boolean; queued: boolean; reason?: string }>;
  close: (outcome: string) => Promise<void>;
};

export const OUTCOME_QUIET = "Not something Cue does (outside connections), so it was closed without being done. Nothing was sent about it.";
export const OUTCOME_TOLD = "Not something Cue does (outside connections), so it was closed without being done. They were told so in one line.";

export async function closeOutOfScope(t: CoTask, sc: Scope, deps: HandBackDeps): Promise<{ told: boolean; queued: boolean; outcome: string }> {
  if (!memberWaitsOn(t)) {
    await deps.close(OUTCOME_QUIET);
    return { told: false, queued: false, outcome: OUTCOME_QUIET };
  }
  const text = await deps
    .draft(
      { what_they_asked_for: t.goal.slice(0, 160), their_words: t.theirWords.slice(0, 200), why_not: sc.why },
      `${OUT_OF_SCOPE_GUIDANCE} You had taken this on earlier and haven't done it; tell them plainly you won't be doing it, in one or two short sentences, with no apology spiral and no offer to do something else instead.`,
    )
    .catch(() => null);
  const r = text ? await deps.send(text).catch(() => ({ sent: false, queued: false, reason: "send failed" })) : null;
  const went = !!r && (r.sent || r.queued);
  const outcome = went ? OUTCOME_TOLD : OUTCOME_QUIET;
  await deps.close(outcome);
  return { told: went, queued: !!r?.queued && !r.sent, outcome };
}

// The real deps for one task: the same draft and send paths a task text uses (harness/proactive.ts), and the same close.
export async function handBackDepsFor(t: CoTask): Promise<HandBackDeps | null> {
  const [{ default: pool }, P, D, T, M] = await Promise.all([import("../db/db.js"), import("../harness/proactive.js"), import("../harness/door.js"), import("./coTasks.js"), import("./memberTime.js")]);
  const { rows } = await pool.query(`SELECT first_name, phone_number, sms_opted_out, archived_at FROM users WHERE id = $1`, [t.userId]);
  const u = rows[0];
  const zone = await M.memberZone(t.userId).catch(() => null);
  const firstName = u?.first_name || "them";
  const canText = !!u && !u.sms_opted_out && !u.archived_at && !!u.phone_number;
  return {
    firstName,
    draft: async (facts, task) => (canText ? P.draftProactive({ functionId: "scope.handBack", firstName, facts, task, maxSentences: 2 }) : null),
    send: async (text) => {
      const now = new Date();
      const r = await P.sendExempt({
        userId: t.userId,
        phoneNumber: u.phone_number,
        type: "task_update",
        targetKey: `scope:${t.id}`,
        messages: [text],
        timezone: zone,
        respectHours: true,
        now,
        answers: { askedAt: t.createdAt ? new Date(t.createdAt) : null },
        door: { summary: `A line about work Cue won't take on: ${t.goal.slice(0, 100)}`, validUntil: D.doorValidUntil("requested", now, zone, null), taskId: t.id, awaitingReply: false },
      });
      return { sent: r.sent, queued: !!(r.door && r.queued), reason: r.reason };
    },
    close: async (outcome) => {
      await T.closeTask(t.userId, t.id, "dropped", outcome);
    },
  };
}
