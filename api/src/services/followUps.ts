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
import { localStamp, memberZone } from "./memberTime.js";

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
  zone?: string | null; // their zone (services/memberTime.ts): "Now:" is shown in it, named
  checkInNow: () => Promise<boolean>;
  later: (hours: number, why: string) => Promise<void>;
  skip: (why: string) => Promise<void>;
  // How long it has been due, in words ("3h ago"), so the decider knows it's due.
  dueSince?: string | null;
};

// Pure: how long ago, in words that need no time zone ("40 min ago", "5h ago", "3d ago").
export function ago(at: Date | string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 60_000));
  if (m < 2) return "just now";
  if (m < 90) return `${m} min ago`;
  if (m < 36 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// Pure: what the follow-up is about, from its payload (the summary alone often dropped the ask or the event's date).
export function aboutLines(payload: any): string[] {
  const p = payload ?? {};
  const s = (x: unknown, n = 200) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const out: string[] = [];
  if (p.askText) out.push(`What they asked for: "${s(p.askText)}"`);
  if (p.eventName) out.push(`The event: ${s(p.eventName, 120)}${p.eventDate ? ` (${s(p.eventDate, 40)})` : ""}`);
  if (p.advice) out.push(`What you told them: "${s(p.advice)}"`);
  if (p.item && typeof p.item === "string") out.push(`About: ${s(p.item)}`);
  if (p.label) out.push(`About: ${s(p.label)}${Array.isArray(p.dates) && p.dates.length ? ` (${p.dates.slice(0, 3).map((d: unknown) => s(d, 30)).join(", ")})` : ""}`);
  if (p.name && p.startAt) out.push(`The event: ${s(p.name, 120)}, starting ${s(p.startAt, 40)}`);
  return out;
}

// Why so few went out (2026-10-07, dev, 14 days: 90 held, 65 "later", 10 skip, 4 "now"): the decider saw its texts with no
// times, so any last exchange read as "you just talked"; it saw a UTC clock and put things off as "too late at night" at
// midday their time; it held off for "you've texted them a lot" and for the hour, both of which the send path already enforces;
// and nothing said it was due. Now the thread carries how long ago each line was, the limits are named as code's job, the
// payload says what it's about, and the last look is a real choice (now or skip), not another "later".
export function followUpPrompt(o: { task: CoTask; firstName: string; recent: string; recentSends: string; now: string; dueSince?: string | null; zone?: string | null }): string {
  const f = o.task.followup ?? {};
  const lastLook = o.task.wakes >= FOLLOWUP_LIMITS.maxWakes;
  const about = aboutLines(f.payload);
  return `${CO_VOICE}

You were going to check in with ${o.firstName}: ${f.summary ?? o.task.goal} (${f.type ?? "follow-up"}).${about.length ? `\n${about.join("\n")}` : ""}
It came due ${o.dueSince ?? "now"}: it was set for this point because whatever it's about has had time to happen. It's your call whether it would mean something now, later, or not at all, the way a friend who knows them would decide. Now: ${o.now}. This is look ${o.task.wakes} of at most ${FOLLOWUP_LIMITS.maxWakes}.

Your recent texts with them (oldest first, each with how long ago):
${o.recent || "(none)"}

What you've texted them first lately:
${o.recentSends || "(nothing)"}

What isn't yours to weigh: their hours, how many texts they've had, and the pause after texts they haven't answered are all enforced when it sends. "Now" goes out at the next good moment inside their hours with every limit applied, never at night, so don't put it off for the time of day or because you've texted them before.

${o.task.followup?.payload?.until ? `It has to go out by ${localStamp(o.task.followup.payload.until, o.zone ?? null)} (an hour before the event starts). Pick the best moment before then.\n` : ""}Decide with one tool:
- checkInNow: the thread doesn't already answer it and it still matters to them. For a follow-up that's due, that's usually the case.
${lastLook ? "" : `- later: only for a reason you can point to in the thread: you're mid-conversation with them right now (their last text is minutes old), or the date it's about is still ahead. Pick when, in hours (${FOLLOWUP_LIMITS.minHours} to ${FOLLOWUP_LIMITS.maxHours}).\n`}- skip: the thread already answers it or it no longer makes sense: they already told you how it went (even if there is more you could ask, this follow-up is answered), they sorted it themselves, they asked for space, or it was cancelled or is long past mattering.
${lastLook ? "This is the last look: check in now or skip.\n" : ""}Say why in one plain line.`;
}

// Co decides; code carries it out. With no decision, it looks again in a day.
export async function runFollowUpTurnWith(task: CoTask, deps: FollowUpDeps): Promise<{ action: "now" | "later" | "skip" | "defaulted"; why: string }> {
  let action: "now" | "later" | "skip" | null = null;
  let why = "";
  const checkInNow = tool({ description: "Check in now.", inputSchema: z.object({ why: z.string() }), execute: async (i) => { action = "now"; why = i.why; return { ok: await deps.checkInNow() }; } });
  const later = tool({ description: "Check in later.", inputSchema: z.object({ inHours: z.number(), why: z.string() }), execute: async (i) => { action = "later"; why = i.why; await deps.later(i.inHours, i.why); return { ok: true }; } });
  const skip = tool({ description: "Don't check in about this.", inputSchema: z.object({ why: z.string() }), execute: async (i) => { action = "skip"; why = i.why; await deps.skip(i.why); return { ok: true }; } });
  // The last look decides: there's no "later" to put it off past the end (it used to expire as "never found the right moment").
  const tools: Record<string, typeof checkInNow | typeof later> = task.wakes >= FOLLOWUP_LIMITS.maxWakes ? { checkInNow, skip } : { checkInNow, later, skip };
  try {
    await generateText({
      model: anthropic(MODELS.sonnet),
      maxOutputTokens: 2000,
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "followUp.decide" },
      tools,
      stopWhen: [stepCountIs(3), () => action !== null],
      prompt: followUpPrompt({ task, firstName: deps.firstName, recent: deps.recent, recentSends: deps.recentSends, now: localStamp(deps.now(), deps.zone ?? null), dueSince: deps.dueSince ?? null, zone: deps.zone ?? null }),
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

// What the decider reads, as of a moment (now, or a past one for a replay): the thread with how long ago each line was, Co's
// first texts lately the same way, and how long the follow-up has been due. Another member's details are stripped, as in the
// reply (memberSafeMemories.ts).
export async function loadFollowUpContext(userId: string, task: Pick<CoTask, "createdAt" | "nextCheckAt">, asOf: Date = new Date()): Promise<{ user: { first_name: string | null; sms_opted_out: boolean; archived_at: Date | null } | null; recent: string; recentSends: string; dueSince: string }> {
  const [{ rows: u }, { rows: convo }, { rows: sends }] = await Promise.all([
    pool.query(`SELECT first_name, sms_opted_out, archived_at FROM users WHERE id = $1`, [userId]),
    pool.query(`SELECT content, memory_type, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} AND created_at <= $2 ORDER BY created_at DESC LIMIT 14`, [userId, asOf]),
    pool.query(`SELECT type, sent_at FROM proactive_sends WHERE user_id = $1 AND sent_at <= $2 AND sent_at > $2::timestamptz - INTERVAL '7 days' ORDER BY sent_at DESC LIMIT 6`, [userId, asOf]),
  ]);
  const M = await import("./memberSafeMemories.js");
  const names = [...new Set([...(await M.linkedMemberNames(userId).catch(() => [] as string[])), ...M.namesInRecords(convo)])];
  const lines: string[] = [];
  for (const row of [...convo].reverse()) {
    const safe = withoutTeammateLines((await M.memberSafe(userId, [row], names)).join("\n")).trim();
    if (safe) lines.push(safe.split("\n").map((l) => `[${ago(row.created_at, asOf)}] ${l}`).join("\n"));
  }
  return {
    user: u[0] ?? null,
    recent: lines.join("\n").slice(-3000),
    recentSends: sends.map((s: any) => `- ${ago(s.sent_at, asOf)}: ${s.type}`).join("\n"),
    dueSince: ago(task.createdAt, asOf),
  };
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
  const ctx = await loadFollowUpContext(userId, task);
  const u = ctx.user ? [ctx.user] : [];
  if (!u[0] || u[0].sms_opted_out || u[0].archived_at) {
    await closeTask(userId, task.id, "dropped", "Member opted out or archived.");
    return;
  }
  const f = task.followup as Stored;
  const zone = await memberZone(userId);
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
    recent: ctx.recent,
    recentSends: ctx.recentSends,
    dueSince: ctx.dueSince,
    zone,
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
