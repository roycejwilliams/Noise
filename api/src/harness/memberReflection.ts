// Weekly reflection, per member (Royce, 2026-09-22: "a fundamental technique
// called Reflection"). Once a week Co looks back at one member's week: what
// it sent them, whether they replied, how much of it was offers versus about
// them, and what they're in the middle of. The output is at most one next
// companion move, queued through the normal daily pick (caps, hours, and
// companion-first all apply), with its reasoning logged to harness_decisions
// as "proactive.reflection".
//
// It only ever reads one member's own rows, and what it queues goes only to
// that member.
import { dueAdvice, FOLLOW_UP_EXPIRES_DAYS, loadAdvice } from "../services/advice.js";
import { syncMilestones, pickToMark } from "../services/milestones.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { recordDecision, type GateCheck } from "./core.js";
import { enqueueCandidate } from "./proactive.js";
import { PROACTIVE_PURPOSE } from "./proactivePurpose.js";
import { listThreads, renderThreads, type MemberThread } from "./memberThreads.js";
import { localStamp, memberZone } from "../services/memberTime.js";
import type { KnowledgeSection, MemberKnowledge } from "../services/memberKnowledge.js";
import { withTraceUser } from "../services/llmTraceText.js";

export type WeekFacts = {
  sends: { type: string; purpose: string; at: string; message: string }[];
  replies: number;
  lastReplyAt: string | null;
  offerShare: number | null; // offers / all proactive sends this week
  threads: MemberThread[];
  // Their zone (services/memberTime.ts): times are shown in it, with the zone named.
  zone?: string | null;
  // What Co knows about them (services/memberKnowledge.ts, reflectionKnown) and the restraint on them now (memberRules), or null.
  known?: string | null;
  restraint?: string | null;
};

// The sections the weekly reflection reads, in its one memberKnowledge call per member.
export const REFLECTION_KNOWLEDGE: readonly KnowledgeSection[] = ["goals", "carrying", "corrections", "lessons", "restraint"];

// Pure: the part of what Co knows about them that bears on a companion move (goals with state, what Co is carrying, what they have
// corrected, what Co has learned), already stripped of anyone else's details inside memberKnowledge. Background for the choice only.
export function reflectionKnown(k: Pick<MemberKnowledge, "goals" | "carrying" | "corrections" | "lessons">): string | null {
  const active = k.goals.filter((g) => g.state === "active").slice(0, 4);
  const past = k.goals.filter((g) => g.state !== "active").slice(0, 3);
  const carrying = k.carrying.filter((c) => c.state !== "done").slice(0, 6);
  const lines = [
    active.length ? `- Where they say they're headed: ${active.map((g) => g.text).join("; ")}` : null,
    past.length ? `- Goals done or set aside (history, not current): ${past.map((g) => `${g.text} (${g.state})`).join("; ")}` : null,
    carrying.length ? `- What Cue is carrying for them: ${carrying.map((c) => `${c.what.slice(0, 120)} (${c.kind}, ${c.state})`).join("; ")}` : null,
    k.corrections.length ? `- They corrected (only the corrected version exists): ${k.corrections.slice(0, 4).map((c) => `${c.field}: ${c.now ?? "(removed)"}`).join("; ")}` : null,
    k.lessons.length ? `- What Cue has learned about them: ${k.lessons.slice(0, 4).map((l) => l.text.slice(0, 160)).join("; ")}` : null,
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

export type ReflectionMove = { move: "check_in" | "hold"; threadId: string | null; reasoning: string };

// Pure gate: a check-in must name one of their own open threads, and a week
// with no open thread or with a companion text already unanswered holds.
export function gateReflection(proposal: Partial<ReflectionMove>, facts: WeekFacts): { move: ReflectionMove; checks: GateCheck[] } {
  const checks: GateCheck[] = [];
  const reasoning = typeof proposal.reasoning === "string" ? proposal.reasoning.slice(0, 500) : "";
  const hold = (why: string): { move: ReflectionMove; checks: GateCheck[] } => ({ move: { move: "hold", threadId: null, reasoning: reasoning || why }, checks });
  if (proposal.move !== "check_in") return hold("model chose hold");
  const t = facts.threads.find((x) => x.id === proposal.threadId && (x.status === "open" || x.status === "waiting"));
  checks.push({ name: "reflection_thread_theirs", pass: Boolean(t), reason: t ? t.text.slice(0, 80) : `not one of their open threads: ${proposal.threadId}` });
  if (!t) return hold("no valid thread");
  const companionSends = facts.sends.filter((s) => s.purpose === "companion");
  const lastCompanion = companionSends[companionSends.length - 1];
  const unansweredCompanion = Boolean(lastCompanion) && (!facts.lastReplyAt || facts.lastReplyAt < lastCompanion!.at);
  checks.push({ name: "reflection_not_piling_on", pass: !unansweredCompanion, reason: unansweredCompanion ? "a companion text this week got no reply" : "ok" });
  if (unansweredCompanion) return hold("companion text unanswered");
  return { move: { move: "check_in", threadId: t.id, reasoning }, checks };
}

export function reflectionPrompt(firstName: string, f: WeekFacts): string {
  return `Look back at Cue's last week with ${firstName} and decide Cue's one next move as their companion.

What Cue texted them first this week (oldest first):
${f.sends.map((s) => `- [${localStamp(`${s.at}:00Z`, f.zone)}] (${s.purpose}) ${s.message.slice(0, 200)}`).join("\n") || "(nothing)"}

Replies from them this week: ${f.replies}
Share of Cue's texts that were offers (events, people): ${f.offerShare == null ? "n/a" : `${Math.round(f.offerShare * 100)}%`}

What they're in the middle of:
${f.threads.length ? f.threads.map((t) => `[${t.id}] ${renderThreads([t], new Date(), f.zone ?? null).slice(2)}`).join("\n") : "(nothing open)"}
${f.known ? `\nWhat else you know about them (background):\n${f.known}\n` : ""}${f.restraint ? `\n${f.restraint}\n` : ""}
Choose "check_in" on ONE of their threads when it would mean something to them now (it's been a while, a date passed, or Cue has mostly been sending offers), or "hold" when Cue should give them space. Say why in one or two plain sentences.

Return ONLY JSON: {"move": "check_in" | "hold", "threadId": "id or null", "reasoning": "..."}`;
}

async function weekFacts(userId: string, known: MemberKnowledge | null = null, restraint: string | null = null): Promise<WeekFacts> {
  const [sends, replies, threads] = await Promise.all([
    pool.query(
      `SELECT type, sent_at, COALESCE(message, '') AS message FROM proactive_sends WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '7 days' ORDER BY sent_at`,
      [userId],
    ),
    pool.query(
      `SELECT count(*)::int AS n, MAX(created_at) AS last FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND created_at > NOW() - INTERVAL '7 days'`,
      [userId],
    ),
    listThreads(userId),
  ]);
  const rows = sends.rows.map((r: any) => ({
    type: r.type,
    purpose: (PROACTIVE_PURPOSE as Record<string, string>)[r.type] ?? "ops",
    at: new Date(r.sent_at).toISOString().slice(0, 16),
    message: r.message,
  }));
  const counted = rows.filter((r) => r.purpose !== "ops");
  return {
    sends: rows,
    replies: replies.rows[0]?.n ?? 0,
    lastReplyAt: replies.rows[0]?.last ? new Date(replies.rows[0].last).toISOString().slice(0, 16) : null,
    offerShare: counted.length ? counted.filter((r) => r.purpose === "offer").length / counted.length : null,
    threads,
    // Their zone as the member knowledge read it (the same memberZone source), else read here.
    zone: known ? known.identity.zone : await memberZone(userId),
    known: known ? reflectionKnown(known) : null,
    restraint,
  };
}

export async function reflectOnMember(userId: string): Promise<ReflectionMove | null> {
  try {
    // What Co knows about them, one read (services/memberKnowledge.ts). A failed read reflects on the week alone, as before.
    const MK = await import("../services/memberKnowledge.js");
    const known = await MK.memberKnowledge(userId, { include: REFLECTION_KNOWLEDGE }).catch((err: any) => {
      console.error("reflectOnMember: member knowledge read failed (non-fatal, reflecting without it):", err?.message ?? err);
      return null;
    });
    const facts = await weekFacts(userId, known, known ? MK.memberRules(known).restraint || null : null);
    // Nothing to be a companion about yet: the recap path covers them.
    if (!facts.threads.length) {
      await recordDecision({ layer: 7, decision: "proactive.reflection", userId, outcome: "skip", action: "hold", reason: "no open threads", proposal: { facts: { ...facts, threads: [] } } });
      return null;
    }
    const { rows } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId]);
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "proactive.reflection" },
      prompt: reflectionPrompt(rows[0]?.first_name || "them", facts),
    });
    const { move, checks } = gateReflection(parseModelJson<Partial<ReflectionMove>>(text), facts);
    let queued = false;
    if (move.move === "check_in" && move.threadId) {
      const t = facts.threads.find((x) => x.id === move.threadId)!;
      const recap = await pool.query(
        `SELECT id, content FROM co_memories WHERE user_id = $1 AND memory_type = 'recap' ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      const week = new Date().toISOString().slice(0, 10);
      const r = await enqueueCandidate({
        userId,
        type: "companion",
        targetKey: `companion:reflection:${t.id}:${week}`,
        topicKey: "companion",
        summary: `Weekly reflection: check in on "${t.text.slice(0, 80)}"`,
        payload: {
          recap: recap.rows[0]?.content ?? "",
          threadId: t.id,
          thread: { text: t.text, quote: t.openedQuote, dueDate: t.dueDate, feeling: t.feeling },
          item: null,
          reflection: move.reasoning,
        },
        expiresAt: new Date(Date.now() + 4 * 86400_000),
      }).catch(() => ({ queued: false }));
      queued = r.queued;
    }
    await recordDecision({
      layer: 7,
      decision: "proactive.reflection",
      userId,
      outcome: move.move === "check_in" && queued ? "act" : "skip",
      action: move.move === "check_in" ? (queued ? "queued_check_in" : "check_in_not_queued") : "hold",
      proposal: { move, week: { sends: facts.sends.length, replies: facts.replies, offerShare: facts.offerShare, openThreads: facts.threads.length } },
      checks,
      reason: move.reasoning,
    });
    return move;
  } catch (err: any) {
    console.error("reflectOnMember failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// Advice Co gave a few days ago, asked about once (services/advice.ts). One
// companion text per member at a time, so this and a milestone don't stack.
export async function queueAdviceFollowUp(userId: string): Promise<boolean> {
  try {
    const a = dueAdvice(await loadAdvice(userId), new Date());
    if (!a) return false;
    const pending = await pool.query(`SELECT 1 FROM proactive_candidates WHERE user_id = $1 AND type = 'companion' AND status = 'pending' LIMIT 1`, [userId]);
    if (pending.rows[0]) return false;
    const r = await enqueueCandidate({
      userId,
      type: "companion",
      targetKey: `companion:advice:${a.id}`,
      topicKey: "companion",
      summary: `Ask how it went: advice about ${a.topic.slice(0, 80)}`,
      payload: { recap: "", threadId: null, thread: null, item: null, advice: { id: a.id, topic: a.topic, gist: a.gist, daysAgo: Math.round((Date.now() - new Date(a.givenAt).getTime()) / 86_400_000) } },
      expiresAt: new Date(Date.now() + FOLLOW_UP_EXPIRES_DAYS * 86400_000),
    }).catch(() => ({ queued: false }));
    await recordDecision({ layer: 7, decision: "proactive.adviceFollowUp", userId, outcome: r.queued ? "act" : "skip", action: r.queued ? "queued" : "not_queued", proposal: { adviceId: a.id, topic: a.topic } }).catch(() => {});
    return r.queued;
  } catch (err: any) {
    console.error("queueAdviceFollowUp failed (non-fatal):", err?.message ?? err);
    return false;
  }
}

// A moment worth marking comes before a check-in (services/milestones.ts):
// one, at most every 7 days, from the record. Returns true when one is queued.
export async function queueMilestone(userId: string): Promise<boolean> {
  try {
    const all = await syncMilestones(userId);
    const m = pickToMark(all, new Date());
    if (!m) return false;
    const pending = await pool.query(`SELECT 1 FROM proactive_candidates WHERE user_id = $1 AND type = 'companion' AND status = 'pending' LIMIT 1`, [userId]);
    if (pending.rows[0]) return false;
    const r = await enqueueCandidate({
      userId,
      type: "companion",
      targetKey: `companion:milestone:${m.key}`,
      topicKey: "companion",
      summary: `Mark a moment in their story: ${m.text.slice(0, 100)}`,
      payload: { recap: "", threadId: null, thread: null, item: null, story: { key: m.key, text: m.text, then: m.then, now: m.now } },
      expiresAt: new Date(Date.now() + FOLLOW_UP_EXPIRES_DAYS * 86400_000),
    }).catch(() => ({ queued: false }));
    await recordDecision({ layer: 7, decision: "proactive.milestone", userId, outcome: r.queued ? "act" : "skip", action: r.queued ? "queued" : "not_queued", proposal: { key: m.key, kind: m.kind } }).catch(() => {});
    return r.queued;
  } catch (err: any) {
    console.error("queueMilestone failed (non-fatal):", err?.message ?? err);
    return false;
  }
}

// Daily: only members Co advised in the last three weeks and hasn't asked
// about yet, so the follow-up lands a few days after the advice, not a week.
export async function runAdviceFollowUps(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT DISTINCT a.user_id AS id FROM member_advice a
     JOIN users u ON u.id = a.user_id AND u.archived_at IS NULL AND u.sms_opted_out = false
     WHERE a.followed_up_at IS NULL AND a.given_at < NOW() - INTERVAL '3 days' AND a.given_at > NOW() - INTERVAL '21 days'
     LIMIT 200`,
  );
  for (const r of rows) await queueAdviceFollowUp(r.id);
}

// Weekly: members who talked to Co or heard from it in the last two weeks.
export async function runWeeklyReflections(): Promise<void> {
  const active = await pool.query(
    `SELECT u.id FROM users u WHERE u.archived_at IS NULL AND u.sms_opted_out = false AND u.identity_captured = true LIMIT 500`,
  );
  const marked = new Set<string>();
  for (const r of active.rows) if ((await queueAdviceFollowUp(r.id)) || (await queueMilestone(r.id))) marked.add(r.id);
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
     WHERE u.archived_at IS NULL AND u.sms_opted_out = false AND u.identity_captured = true
       AND EXISTS (SELECT 1 FROM member_threads t WHERE t.user_id = u.id AND t.status IN ('open', 'waiting'))
     LIMIT 200`,
  );
  for (const r of rows) if (!marked.has(r.id)) await withTraceUser(r.id, () => reflectOnMember(r.id)); // under their own trace-text mark
}
