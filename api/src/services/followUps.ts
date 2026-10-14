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
import { memberKnowledge, memberRules, type Exchange, type Fact, type KnowledgeDeps, type MemberKnowledge } from "./memberKnowledge.js";

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
  // One follow-up per target (concurrency audit, 2026-10-12): two enqueues at once (two snapshot rebuilds, a call and a text) both
  // read "none yet" and both inserted. The read and the write now run under a lock on this member and target.
  const client = await pool.connect();
  let created = false;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`followup:${input.userId}:${input.targetKey}`]);
    const { rows } = await client.query(`SELECT id, status, closed_at, followup FROM co_tasks WHERE user_id = $1 AND kind = 'followup' AND target_key = $2 ORDER BY created_at DESC LIMIT 1`, [input.userId, input.targetKey]);
    const ex = rows[0] ?? null;
    const action = followUpAction(ex ? { status: ex.status, closedAt: ex.closed_at ? new Date(ex.closed_at) : null } : null, new Date());
    if (action === "ignore") {
      await client.query("ROLLBACK");
      return { queued: false };
    }
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
      await client.query(`UPDATE co_tasks SET followup = $2::jsonb, goal = $3, updated_at = NOW() WHERE id = $1`, [ex.id, JSON.stringify(stored), input.summary.slice(0, 200)]);
    } else {
      const firstLook = input.dueAt && input.dueAt.getTime() > Date.now() ? input.dueAt : new Date();
      await client.query(
        `INSERT INTO co_tasks (user_id, kind, goal, their_words, steps, plan_next, next_check_at, notes, followup, target_key)
         VALUES ($1, 'followup', $2, '', '[]'::jsonb, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [input.userId, input.summary.slice(0, 200), "Decide whether and when to check in", firstLook, JSON.stringify([{ at: new Date().toISOString(), text: `Queued: ${input.type}` }]), JSON.stringify(stored), input.targetKey],
      );
      created = true;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (created) {
    const firstLook = input.dueAt && input.dueAt.getTime() > Date.now() ? input.dueAt : new Date();
    await recordDecision({ layer: 7, decision: "task.followup", userId: input.userId, outcome: "act", action: "held_for_co", proposal: { type: input.type, targetKey: input.targetKey, firstLook: firstLook.toISOString() } }).catch(() => {});
  }
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
  // What Co knows about them that bears on the decision (services/memberKnowledge.ts, followUpKnowledge) and the member-level
  // rules it reads with (memberRules: grounding, other members).
  knowledge?: string;
  rules?: string;
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
export function followUpPrompt(o: { task: CoTask; firstName: string; recent: string; recentSends: string; now: string; dueSince?: string | null; zone?: string | null; knowledge?: string; rules?: string }): string {
  const f = o.task.followup ?? {};
  const lastLook = o.task.wakes >= FOLLOWUP_LIMITS.maxWakes;
  const about = aboutLines(f.payload);
  return `${CO_VOICE}

You were going to check in with ${o.firstName}: ${f.summary ?? o.task.goal} (${f.type ?? "follow-up"}).${about.length ? `\n${about.join("\n")}` : ""}
It came due ${o.dueSince ?? "now"}: it was set for this point because whatever it's about has had time to happen. It's your call whether it would mean something now, later, or not at all, the way a friend who knows them would decide. Now: ${o.now}. This is look ${o.task.wakes} of at most ${FOLLOWUP_LIMITS.maxWakes}.
${o.knowledge ? `\n${o.knowledge}\n` : ""}${o.rules ? `\n${o.rules}\n` : ""}
Your recent texts with them (oldest first, each with how long ago):
${o.recent || "(none)"}

What you've texted them first lately:
${o.recentSends || "(nothing)"}

What isn't yours to weigh: their hours, how many texts they've had, and the pause after texts they haven't answered are all enforced when it sends. "Now" goes out at the next good moment inside their hours with every limit applied, never at night, so don't put it off for the time of day or because you've texted them before.

${o.task.followup?.payload?.until ? `It has to go out by ${localStamp(o.task.followup.payload.until, o.zone ?? null)} (an hour before the event starts). Pick the best moment before then.\n` : ""}Decide with one tool:
- checkInNow: the thread doesn't already answer it and it still matters to them. For a follow-up that's due, that's usually the case.
${lastLook ? "" : `- later: only for a reason you can point to in the thread: you're mid-conversation with them right now (their last text is minutes old), or the date it's about is still ahead. Pick when, in hours (${FOLLOWUP_LIMITS.minHours} to ${FOLLOWUP_LIMITS.maxHours}). Never "later" because they asked for space: that is skip.\n`}- If they asked for space, a break, a pause, or to hear less from you ("give me some space", "I need a break", "not right now", "too many texts"), that is skip, never later: respecting it means not coming back to this one.
- skip: the thread already answers it or it no longer makes sense: they already told you how it went (even if there is more you could ask, this follow-up is answered), they sorted it themselves, they asked for space, or it was cancelled or is long past mattering.
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
      prompt: followUpPrompt({ task, firstName: deps.firstName, recent: deps.recent, recentSends: deps.recentSends, now: localStamp(deps.now(), deps.zone ?? null), dueSince: deps.dueSince ?? null, zone: deps.zone ?? null, knowledge: deps.knowledge, rules: deps.rules }),
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

// Pure: the thread as one block, oldest first, every line stamped (stamp: "3h ago" here, their local time in a task turn).
// Lines are written the way they're stored ("User said:", "Co replied:", "[Call]"), so a reader that looks for "User said:"
// still finds it after the stamp. Lines that belong to a talk with a teammate agent are dropped (teamLines.ts).
export function exchangeText(exchanges: Fact<Exchange>[], stamp: (at: string) => string): string {
  const out: string[] = [];
  for (const x of exchanges) {
    const head = x.from === "member" ? "User said: " : x.call ? "[Call] " : "Co replied: ";
    const safe = withoutTeammateLines(`${head}${x.text}`).trim();
    if (safe) out.push(safe.split("\n").map((l) => `[${stamp(x.verifiedAt)}] ${l}`).join("\n"));
  }
  return out.join("\n");
}

// Pure: what a follow-up decider knows besides the thread: how they are right now, what they already have from Co, what they
// corrected, what Co has learned working with them. Each section left out when empty.
export function followUpKnowledge(k: Pick<MemberKnowledge, "restraint" | "delivered" | "corrections" | "lessons">, asOf: Date): string {
  const r = k.restraint;
  const how = [
    r?.safetyHold ? "a safety hold is on (only care, no offers or nudges)" : null,
    r?.needsCare ? "they've been having a hard time lately" : null,
    r?.frustratedWithCo ? "they've been frustrated with Cue lately" : null,
    r?.feeling ? `their latest feeling: ${r.feeling}` : null,
  ].filter(Boolean);
  return [
    how.length ? `How they are right now: ${how.join("; ")}.` : null,
    k.delivered.length ? `What they already have from you (newest first):\n${k.delivered.slice(0, 6).map((d) => `- ${d.what} (${d.kind}, ${ago(d.at, asOf)})`).join("\n")}` : null,
    k.corrections.length ? `What they corrected (only the corrected version exists):\n${k.corrections.slice(0, 4).map((c) => `- ${c.field}: now ${c.now ?? "(removed)"}`).join("\n")}` : null,
    k.lessons.length ? `What you've learned working with them:\n${k.lessons.slice(0, 4).map((l) => `- ${l.text}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// The thread as of a moment (a replay reads the past): the layer's own exchange read, bounded by asOf.
export function exchangesAsOf(asOf: Date): KnowledgeDeps["exchanges"] {
  return async (userId, o) =>
    (
      await pool.query(
        `SELECT content, created_at FROM co_memories
         WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} AND created_at <= $4 AND created_at > $4::timestamptz - make_interval(days => $2)
         ORDER BY created_at DESC LIMIT $3`,
        // Twice the window, like the layer's own read: lines that aren't exchanges are dropped after, and the layer trims to the
        // limit then (memberKnowledge.ts), so they never use up the member's slots.
        [userId, o.days, o.limit * 2, asOf],
      )
    ).rows.map((r: any) => ({ content: String(r.content ?? ""), at: new Date(r.created_at) }));
}

// What the decider reads, as of a moment (now, or a past one for a replay): the thread with how long ago each line was, Co's
// first texts lately the same way, how long the follow-up has been due, and what Co knows about them. Member facts come from the
// one member-knowledge layer (services/memberKnowledge.ts: another member's details stripped inside, fails closed); the account
// row (opted out, archived) and Co's send log stay direct reads.
export async function loadFollowUpContext(userId: string, task: Pick<CoTask, "createdAt" | "nextCheckAt">, asOf: Date = new Date()): Promise<{ user: { first_name: string | null; sms_opted_out: boolean; archived_at: Date | null } | null; recent: string; recentSends: string; dueSince: string; knowledge: string; rules: string; zone: string | null }> {
  const [{ rows: u }, { rows: sends }, k] = await Promise.all([
    pool.query(`SELECT first_name, sms_opted_out, archived_at FROM users WHERE id = $1`, [userId]),
    pool.query(`SELECT type, sent_at FROM proactive_sends WHERE user_id = $1 AND sent_at <= $2 AND sent_at > $2::timestamptz - INTERVAL '7 days' ORDER BY sent_at DESC LIMIT 6`, [userId, asOf]),
    // A rejection (the member-name read failed) means no member context, never an unstripped fallback.
    memberKnowledge(userId, { now: asOf, exchanges: 14, exchangeDays: 30, include: ["exchanges", "restraint", "delivered", "corrections", "lessons"] }, { exchanges: exchangesAsOf(asOf) }).catch((err: any) => {
      console.error("followUp: member knowledge unavailable, going without member context (non-fatal):", err?.message ?? err);
      return null;
    }),
  ]);
  const rules = k ? memberRules(k) : null;
  return {
    user: u[0] ?? null,
    recent: k ? exchangeText(k.exchanges, (at) => ago(at, asOf)).slice(-3000) : "",
    recentSends: sends.map((s: any) => `- ${ago(s.sent_at, asOf)}: ${s.type}`).join("\n"),
    dueSince: ago(task.createdAt, asOf),
    knowledge: k ? followUpKnowledge(k, asOf) : "",
    // Their hours, caps and the unanswered pause stay the send path's to enforce (the prompt says so, so a "later" is never for
    // them): only grounding and other members here.
    rules: rules ? `${rules.grounding}\n${rules.memberSafety}` : "",
    zone: k ? k.identity.zone : await memberZone(userId).catch(() => null),
  };
}

export async function runFollowUpTurn(task: CoTask): Promise<void> {
  const userId = task.userId;
  const { closeTask, scheduleTask, noteOnTask } = await import("./coTasks.js");
  const age = Date.now() - new Date(task.createdAt).getTime();
  if (task.wakes > FOLLOWUP_LIMITS.maxWakes || age > FOLLOWUP_LIMITS.maxDays * 86_400_000) {
    await closeTask(userId, task.id, "expired", "Cue never found the right moment.");
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
  // Their zone from the same layer read (identity: services/memberTime.ts memberZone, the one source).
  const zone = ctx.zone;
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
    knowledge: ctx.knowledge,
    rules: ctx.rules,
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
