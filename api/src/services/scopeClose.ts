// Queued work meets the purpose boundary (Royce, 2026-11-04). The check (harness/scope.ts) runs again when a task wakes, because a
// task opened before the boundary, or one that drifted, may be outside it now. Out-of-scope work is never silently dropped and never
// claimed done:
//   - a member asked for it (or was promised it): one natural line goes through the door, in words the model writes fresh each time
//     (guidance for tone, never a stock line, no forced intro), then the task closes as dropped. If no line can be written or sent,
//     the task stays open and tries again at its next wake (a few times); only after that is it closed, with the record saying they
//     were never told. Nothing ever says it was done.
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
  // Wakes again tomorrow (the line could not be written or sent); the task stays open meanwhile.
  later?: () => Promise<void>;
  // Whether the line already went (the ledger key scope:<id> exists), asked after a draft or a send that threw: a line that went is never "never told".
  wasTold?: () => Promise<boolean>;
};
// How many wakes a line to a member who asked for the work is tried before the task closes without it (the record says so).
export const TELL_ATTEMPTS = 4;

export const OUTCOME_UNTOLD = "Not something Cue does (outside connections), so it was closed without being done. The line telling them so could not be sent after several tries.";
export const OUTCOME_QUIET = "Not something Cue does (outside connections), so it was closed without being done. Nothing was sent about it.";
export const OUTCOME_TOLD = "Not something Cue does (outside connections), so it was closed without being done. They were told so in one line.";

export async function closeOutOfScope(t: CoTask, sc: Scope, deps: HandBackDeps): Promise<{ told: boolean; queued: boolean; outcome: string; closed: boolean }> {
  if (!memberWaitsOn(t)) {
    await deps.close(OUTCOME_QUIET);
    return { told: false, queued: false, outcome: OUTCOME_QUIET, closed: true };
  }
  const text = await deps
    .draft(
      { what_they_asked_for: t.goal.slice(0, 160), their_words: t.theirWords.slice(0, 200), why_not: sc.why },
      `${OUT_OF_SCOPE_GUIDANCE} You had taken this on earlier and haven't done it; tell them plainly you won't be doing it, in one or two short sentences, with no apology spiral and no offer to do something else instead.`,
    )
    .catch(() => null);
  const r = text ? await deps.send(text).catch(() => ({ sent: false, queued: false, reason: "send failed" })) : null;
  const went = (!!r && (r.sent || r.queued)) || (await deps.wasTold?.().catch(() => false)) === true;
  // They asked for it: never a silent close. No line went, so it stays open and the next wake tries again; after TELL_ATTEMPTS wakes it
  // closes with the record saying they were never told (and it is never called done).
  if (!went && deps.later && (t.wakes ?? 0) < TELL_ATTEMPTS) {
    await deps.later();
    return { told: false, queued: false, outcome: "retry", closed: false };
  }
  const outcome = went ? OUTCOME_TOLD : OUTCOME_UNTOLD;
  await deps.close(outcome);
  return { told: went, queued: !!r?.queued && !r.sent, outcome, closed: true };
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
    wasTold: async () => (await pool.query(`SELECT 1 FROM proactive_sends WHERE user_id = $1 AND target_key = $2`, [t.userId, `scope:${t.id}`])).rows.length > 0,
    later: async () => {
      await T.scheduleTask(t.userId, t.id, 24, "Tell them plainly that this isn't something Cue does, then close it.");
    },
  };
}
