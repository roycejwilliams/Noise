// Follow-ups handed to Co (Royce, 2026-09-30: "Ok apply what needs to be handed
// over to Co"). Advice follow-ups, time-frame follow-ups, ask check-ins and
// debriefs used to go out on fixed timers. Now, when one of them would be
// queued, a follow-up task holds it instead, and at its first wake Co reads the
// thread and decides: check in now, later (it picks when), or not at all.
// "Now" queues it exactly as before (harness/proactive.ts enqueueCandidate), so
// every limit still applies at send: their hours, daily and weekly caps,
// companion first, the pause after unanswered texts, and the draft's own checks.
// Operations (call reminders, event changes, membership notices) and the
// morning report stay on their schedules; so do check-ins and story texts, for now.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { CO_VOICE } from "./coVoice.js";
import { notToTeammate, withoutTeammateLines } from "./teamLines.js";
import type { EnqueueInput } from "../harness/proactive.js";
import type { CoTask } from "./coTasks.js";
import { sealedTelemetry } from "./privateTurn.js";

export const FOLLOWUP_LIMITS = { minHours: 2, maxHours: 7 * 24, maxWakes: 5, maxDays: 14, quietAfterClosedDays: 14 };

export function followUpsByCo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FOLLOWUPS_BY_CO !== "off";
}

// The four handed over. Advice follow-ups are "companion" candidates with an
// advice target; other companion check-ins stay on their schedule.
export function handedToCo(input: Pick<EnqueueInput, "type" | "targetKey">): boolean {
  if (input.type === "window_followup" || input.type === "ask_checkin" || input.type === "debrief" || input.type === "pre_arrival") return true;
  return input.type === "companion" && input.targetKey.startsWith("companion:advice:");
}

// What to do with a new (or repeated) request for the same follow-up.
export function followUpAction(existing: { status: string; closedAt: Date | null } | null, now: Date): "create" | "update" | "ignore" {
  if (!existing) return "create";
  if (existing.status === "open") return "update";
  // Co already decided this one (sent it or let it go): the producers' timers don't reopen it.
  if (existing.closedAt && now.getTime() - existing.closedAt.getTime() < FOLLOWUP_LIMITS.quietAfterClosedDays * 86_400_000) return "ignore";
  return "create";
}

type Stored = { type: string; targetKey: string; topicKey?: string; summary: string; payload: any; expiresAt?: string | null; priority?: number };

// Called by enqueueCandidate for the four handed-over types.
export async function startFollowUp(input: EnqueueInput): Promise<{ queued: boolean }> {
  const { rows } = await pool.query(`SELECT id, status, closed_at, followup FROM co_tasks WHERE user_id = $1 AND kind = 'followup' AND target_key = $2 ORDER BY created_at DESC LIMIT 1`, [input.userId, input.targetKey]);
  const ex = rows[0] ?? null;
  const action = followUpAction(ex ? { status: ex.status, closedAt: ex.closed_at ? new Date(ex.closed_at) : null } : null, new Date());
  if (action === "ignore") return { queued: false };
  const stored: Stored = {
    type: input.type,
    targetKey: input.targetKey,
    topicKey: input.topicKey,
    summary: input.summary,
    // A debrief collects both the outcome follow-up and the event check-in.
    payload: action === "update" && input.merge ? input.merge(ex.followup?.payload, input.payload) : input.payload,
    expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
    priority: input.priority,
  };
  if (action === "update") {
    await pool.query(`UPDATE co_tasks SET followup = $2::jsonb, goal = $3, updated_at = NOW() WHERE id = $1`, [ex.id, JSON.stringify(stored), input.summary.slice(0, 200)]);
    return { queued: true };
  }
  const firstLook = input.dueAt && input.dueAt.getTime() > Date.now() ? input.dueAt : new Date();
  await pool.query(
    `INSERT INTO co_tasks (user_id, kind, goal, their_words, steps, plan_next, next_check_at, notes, followup, target_key)
     VALUES ($1, 'followup', $2, '', '[]'::jsonb, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [input.userId, input.summary.slice(0, 200), "Decide whether and when to check in", firstLook, JSON.stringify([{ at: new Date().toISOString(), text: `Queued: ${input.type}` }]), JSON.stringify(stored), input.targetKey],
  );
  await recordDecision({ layer: 7, decision: "task.followup", userId: input.userId, outcome: "act", action: "held_for_co", proposal: { type: input.type, targetKey: input.targetKey, firstLook: firstLook.toISOString() } }).catch(() => {});
  return { queued: true };
}

// A follow-up with a hard window (the pre-arrival text: no later than an hour
// before the start): Co picks the moment inside it, and at the end of it, it goes.
export function boundedLater(now: Date, hours: number, until: string | null | undefined): { at: Date; lastCall: boolean } {
  const h = Math.min(FOLLOWUP_LIMITS.maxHours, Math.max(0.25, Number(hours) || 24));
  const want = new Date(now.getTime() + h * 3_600_000);
  if (!until) return { at: want, lastCall: false };
  const u = new Date(until);
  return want.getTime() >= u.getTime() ? { at: u, lastCall: true } : { at: want, lastCall: false };
}
export function atWindowEnd(now: Date, until: string | null | undefined): boolean {
  return !!until && now.getTime() >= new Date(until).getTime() - 10 * 60_000;
}

export type FollowUpDeps = {
  firstName: string;
  recent: string;
  recentSends: string;
  now: () => Date;
  checkInNow: () => Promise<boolean>;
  later: (hours: number, why: string) => Promise<void>;
  skip: (why: string) => Promise<void>;
};

export function followUpPrompt(o: { task: CoTask; firstName: string; recent: string; recentSends: string; now: string }): string {
  const f = o.task.followup ?? {};
  return `${CO_VOICE}

You were going to check in with ${o.firstName}: ${f.summary ?? o.task.goal} (${f.type ?? "follow-up"}). It's your call whether that would mean something now, later, or not at all, the way a friend who knows them would decide. Now: ${o.now}. This is look ${o.task.wakes} of at most ${FOLLOWUP_LIMITS.maxWakes}.

Your recent texts with them (oldest first):
${o.recent || "(none)"}

What you've texted them first lately:
${o.recentSends || "(nothing)"}

${o.task.followup?.payload?.until ? `It has to go out by ${o.task.followup.payload.until} (an hour before the event starts). Pick the best moment before then.\n` : ""}Decide with one tool:
- checkInNow: it would land well now.
- later: the timing is off (you just talked, they're in the middle of something, the date it's about hasn't happened yet, you've texted them first a lot lately). Pick when, in hours (${FOLLOWUP_LIMITS.minHours} to ${FOLLOWUP_LIMITS.maxHours}).
- skip: it no longer makes sense (they already told you how it went, they asked for space, it's gone stale, or it would just be noise).
Say why in one plain line.`;
}

// Co decides; code carries it out. With no decision, it looks again in a day.
export async function runFollowUpTurnWith(task: CoTask, deps: FollowUpDeps): Promise<{ action: "now" | "later" | "skip" | "defaulted"; why: string }> {
  let action: "now" | "later" | "skip" | null = null;
  let why = "";
  const tools = {
    checkInNow: tool({ description: "Check in now.", inputSchema: z.object({ why: z.string() }), execute: async (i) => { action = "now"; why = i.why; return { ok: await deps.checkInNow() }; } }),
    later: tool({ description: "Check in later.", inputSchema: z.object({ inHours: z.number(), why: z.string() }), execute: async (i) => { action = "later"; why = i.why; await deps.later(i.inHours, i.why); return { ok: true }; } }),
    skip: tool({ description: "Don't check in about this.", inputSchema: z.object({ why: z.string() }), execute: async (i) => { action = "skip"; why = i.why; await deps.skip(i.why); return { ok: true }; } }),
  };
  try {
    await generateText({
      model: anthropic(MODELS.sonnet),
      maxOutputTokens: 2000,
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "followUp.decide" },
      tools,
      stopWhen: [stepCountIs(3), () => action !== null],
      prompt: followUpPrompt({ task, firstName: deps.firstName, recent: deps.recent, recentSends: deps.recentSends, now: deps.now().toISOString().slice(0, 16) }),
    });
  } catch (err: any) {
    console.error("followUp decide failed (non-fatal):", err?.message ?? err);
  }
  if (!action) {
    await deps.later(24, "no decision; looking again tomorrow");
    return { action: "defaulted", why: "no decision" };
  }
  return { action, why };
}

export async function runFollowUpTurn(task: CoTask): Promise<void> {
  const userId = task.userId;
  const { closeTask, scheduleTask, noteOnTask } = await import("./coTasks.js");
  const age = Date.now() - new Date(task.createdAt).getTime();
  if (task.wakes > FOLLOWUP_LIMITS.maxWakes || age > FOLLOWUP_LIMITS.maxDays * 86_400_000) {
    await closeTask(userId, task.id, "expired", "Co never found the right moment.");
    await recordDecision({ layer: 7, decision: "task.followup", userId, outcome: "skip", action: "expired", proposal: { taskId: task.id, type: task.followup?.type } }).catch(() => {});
    return;
  }
  const [{ rows: u }, { rows: convo }, { rows: sends }] = await Promise.all([
    pool.query(`SELECT first_name, sms_opted_out, archived_at FROM users WHERE id = $1`, [userId]),
    pool.query(`SELECT content, memory_type FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 14`, [userId]),
    pool.query(`SELECT type, sent_at FROM proactive_sends WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '7 days' ORDER BY sent_at DESC LIMIT 6`, [userId]),
  ]);
  if (!u[0] || u[0].sms_opted_out || u[0].archived_at) {
    await closeTask(userId, task.id, "dropped", "Member opted out or archived.");
    return;
  }
  const f = task.followup as Stored;
  const until: string | null = f?.payload?.until ?? null;
  const checkIn = async () => {
    const { enqueueCandidate } = await import("../harness/proactive.js");
    const expires = f.expiresAt ? new Date(Math.max(new Date(f.expiresAt).getTime(), Date.now() + (until ? 0 : 2 * 86_400_000))) : new Date(Date.now() + 3 * 86_400_000);
    const q = await enqueueCandidate({ userId, type: f.type as any, targetKey: f.targetKey, topicKey: f.topicKey, summary: f.summary, payload: f.payload, priority: f.priority, dueAt: new Date(), expiresAt: expires, fromCo: true });
    await closeTask(userId, task.id, "done", q.queued ? "Checked in (queued through the daily pick)." : "Already sent before.");
    return q.queued;
  };
  // The end of its window: it goes now (it's about something happening today).
  if (atWindowEnd(new Date(), until)) {
    const q = await checkIn();
    await recordDecision({ layer: 7, decision: "task.followup", userId, outcome: "act", action: "now_window_end", reason: "last moment in its window", proposal: { taskId: task.id, type: f?.type, queued: q } }).catch(() => {});
    return;
  }
  const r = await runFollowUpTurnWith(task, {
    firstName: u[0].first_name || "them",
    // Another member's details stripped, as in the reply (memberSafeMemories.ts).
    recent: withoutTeammateLines((await import("./memberSafeMemories.js").then((m) => m.memberSafe(userId, convo))).reverse().join("\n")).slice(-2500),
    recentSends: sends.map((s: any) => `- ${new Date(s.sent_at).toISOString().slice(0, 16)} ${s.type}`).join("\n"),
    now: () => new Date(),
    checkInNow: checkIn,
    later: async (hours, why) => {
      await noteOnTask(userId, task.id, `Later: ${why}`);
      if (until) {
        const b = boundedLater(new Date(), hours, until);
        await pool.query(`UPDATE co_tasks SET next_check_at = $3, plan_next = $4, updated_at = NOW() WHERE user_id = $1 AND id = $2`, [userId, task.id, b.at, why.slice(0, 240)]);
        return;
      }
      const h = Math.min(FOLLOWUP_LIMITS.maxHours, Math.max(FOLLOWUP_LIMITS.minHours, Number(hours) || 24));
      await scheduleTask(userId, task.id, h, why);
    },
    skip: async (why) => {
      await closeTask(userId, task.id, "dropped", why);
    },
  });
  await recordDecision({ layer: 7, decision: "task.followup", userId, outcome: r.action === "now" ? "act" : "skip", action: r.action, reason: r.why.slice(0, 300), proposal: { taskId: task.id, type: f?.type, targetKey: f?.targetKey } }).catch(() => {});
}
