// Connecting the dots (Royce, 2026-09-28: "I need Co to start connecting the
// dots"). Co held every piece and used each alone: "I'm in" under the Grok Bot
// product builders night got "which one?", when that night is the 0-to-1
// builder crowd he'd asked for, a place to meet the dependable builder friend
// he described, and a room for sponsor leads for his event on the 10th. And
// while he was burned out and weighing a break, Co sent seven event offers in
// a week without noticing.
//
// One cheap read per turn, alongside the router: what they just said (and the
// text they replied to) against their own open asks, what they're in the
// middle of, how they've been feeling, and how much Co has been pitching. At
// most two real connections, handed to Co to use only if they fit. Their own
// information only, never another member's.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";

// mention: worth pointing out. shape: changes how Co shows up (pacing, tone,
// what it offers), not something to say.
export type Dot = { link: string; why: string; kind: "mention" | "shape" };

export type DotsInput = {
  now: string; // what's happening now: their message, or the thing Co is about to offer
  recent?: string; // the last few lines of the conversation, for a reply
  asks: string[];
  threads: { text: string; feeling: string | null }[];
  offersThisWeek: number;
  feeling?: string | null;
};

export async function gatherDots(userId: string): Promise<Omit<DotsInput, "now">> {
  const [asks, threads, offers] = await Promise.all([
    pool
      .query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 10`, [userId])
      .then((r) => r.rows.map((x: any) => String(x.ask_text)))
      .catch(() => [] as string[]),
    pool
      .query(`SELECT text, feeling FROM member_threads WHERE user_id = $1 AND status IN ('open', 'waiting') ORDER BY last_touched_at DESC NULLS LAST LIMIT 8`, [userId])
      .then((r) => r.rows.map((x: any) => ({ text: String(x.text), feeling: x.feeling ?? null })))
      .catch(() => [] as { text: string; feeling: string | null }[]),
    pool
      .query(`SELECT count(*)::int AS n FROM proactive_sends WHERE user_id = $1 AND type = 'event_offer' AND NOT exempt AND sent_at > NOW() - INTERVAL '7 days'`, [userId])
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => 0),
  ]);
  return { asks, threads, offersThisWeek: offers };
}

// The moment, read once per reply (Royce, 2026-09-28: "how can we make Co
// aware?"): what the conversation is about and what they're doing in it, so
// Co stays on it (a question about Tuesday's timing got tied to his Oct 10
// sponsors, and he said "This has nothing to do with Oct 10th"); whether
// they're pushing back on what Co just said; and a lesson worth keeping when
// they are. Connections are only kept when they're sharing something or
// reacting to something Co sent (Royce: "only if the conversation leads them
// there"); code holds that line on the model's own read of the moment.
export type Mode = "sharing" | "reacting" | "asking" | "logistics" | "feedback" | "planning" | "small_talk";
export type Moment = { mode: Mode; topic: string; pushback: string | null; lesson: string | null; dots: Dot[] };
const MODES: Mode[] = ["sharing", "reacting", "asking", "logistics", "feedback", "planning", "small_talk"];
export const DOTS_MODES: Mode[] = ["sharing", "reacting"];

export async function readMoment(input: DotsInput, opts: { forReply?: boolean; timeoutMs?: number } = {}): Promise<Moment | null> {
  if (!input.now.trim()) return null;
  const forReply = opts.forReply ?? true;
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      maxOutputTokens: 600,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
      experimental_telemetry: { isEnabled: true, functionId: "connectDots" },
      prompt: `You help Cue, a companion who texts with one member, stay aware of the moment, the way a friend who's been paying attention would.
${input.recent ? `\nThe last few texts (oldest first):\n${input.recent.slice(-1500)}\n` : ""}
What's happening now:
${input.now.slice(0, 800)}

What they've asked Cue for (their words):
${input.asks.map((a) => `- ${a}`).join("\n") || "- (nothing open)"}

What they're in the middle of:
${input.threads.map((t) => `- ${t.text}${t.feeling ? ` (feeling: ${t.feeling})` : ""}`).join("\n") || "- (nothing open)"}
${input.feeling ? `\nHow they've been lately: ${input.feeling}\n` : ""}
Event offers Cue has texted them in the last 7 days: ${input.offersThisWeek}

1. mode: what they're doing right now: "sharing" (telling Cue about their life or feelings), "reacting" (responding to something Cue sent), "asking" (a question), "logistics" (times, places, details), "feedback" (about how Cue works), "planning", or "small_talk" (thanks, ok, a sign-off).
2. topic: what this part of the conversation is about, in a few words.
3. pushback: if their message corrects or pushes back on something Cue just said, what (in a few words); otherwise null.
4. lesson: only when there's pushback, one short standing note about how Cue should be with them from now on, general enough to apply next time ("when he asks about logistics, answer the logistics; don't tie it to his own event"); otherwise null.
5. dots: at most two connections what's happening now actually leads to: "mention" (one thing serving two of their goals, or bearing on a decision they're stuck on) or "shape" (how they're doing should change how Cue responds right now, not something to say). Only real, specific links from what's written above; never invent facts. Leave empty unless what's happening now clearly leads there.

Return ONLY JSON: {"mode": "...", "topic": "...", "pushback": "..." or null, "lesson": "..." or null, "dots": [{"kind": "mention" | "shape", "link": "one short plain sentence", "why": "which of their asks or threads it ties to"}]}`,
    });
    const p = parseModelJson(text) ?? {};
    const mode: Mode = MODES.includes(p.mode) ? p.mode : "asking";
    const rawDots = Array.isArray(p.dots) ? p.dots : [];
    const dots: Dot[] = rawDots
      .filter((d: any) => typeof d?.link === "string" && d.link.trim())
      .slice(0, 2)
      .map((d: any) => ({ link: String(d.link).trim().slice(0, 240), why: String(d.why ?? "").trim().slice(0, 160), kind: d.kind === "shape" ? ("shape" as const) : ("mention" as const) }));
    const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim().slice(0, n) : null);
    return {
      mode,
      topic: str(p.topic, 120) ?? "",
      pushback: str(p.pushback, 200),
      lesson: str(p.pushback, 200) ? str(p.lesson, 240) : null,
      // A reply only connects the dots when they're sharing or reacting to something Co sent.
      dots: forReply && !DOTS_MODES.includes(mode) ? [] : dots,
    };
  } catch (err: any) {
    console.error("connectDots: moment read failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// For event offers (no reply, no mode gate).
export async function findDots(input: DotsInput, timeoutMs = 6000): Promise<Dot[]> {
  if (!input.asks.length && !input.threads.length) return [];
  return (await readMoment(input, { forReply: false, timeoutMs }))?.dots ?? [];
}

// How the moment reads to Co in a reply.
export function momentInstruction(m: Moment | null): string | null {
  if (!m) return null;
  const parts: string[] = [];
  if (m.topic) parts.push(`Right now the conversation is about: ${m.topic} (they're ${m.mode === "small_talk" ? "just closing out" : m.mode}). Stay on that; don't bring in their other plans or asks unless they do.`);
  if (m.pushback) parts.push(`They're pushing back on what you said: ${m.pushback}. Own it plainly in a few words, fix it, and don't repeat it or defend it.`);
  if (m.mode === "sharing") parts.push(SHARING_GUIDE);
  if (m.mode === "feedback") parts.push(FEEDBACK_GUIDE);
  return parts.length ? parts.join(" ") : null;
}

// How Cue answers something they shared (Royce, 2026-10-28, after "Why are your responses so dry?": "someone who paid attention, not a
// system following an empathy template"). Principles, never sample lines: Cue copies the wording of its instructions (evals/texting).
// Only on a sharing turn, so it never reaches a question, logistics or a sign-off. Scoped here, not in the rules every text gets (Royce
// 2026-10-29): rewriting the global rhythm regressed live check-ins, so a share or feedback turn overrides the general length and
// question rules on its own, and the per-message length line is left off these turns (agent/conversationReply.ts UNCAPPED_MOMENTS).
export const SHARING_GUIDE = `They're telling you something about their life. On this turn this overrides the general length and question rules: match the depth to what they shared, with no length cap. Respond to what they said and what it means to them, the way someone who was paying attention would. There's no formula: a specific reaction, an observation, a small opinion of your own, light humor when it fits them and the moment, or questions when there's something you genuinely want to understand. Several questions are fine when they are one continuous thought, each building on the last, and a reaction with the thought or question that grows from it stays one message; never a questionnaire, never re-asking what they already answered, never a question forced onto a moment that's complete. When the moment is complete, a short warm line is the whole reply; don't pull another answer out of them. Add something of your own instead of restating what they told you or simply agreeing, and don't fall into mirroring them and then asking something; they know what they said. Use what they've already told you, in this thread or before, rather than asking again, and bring an earlier thread back only when it's relevant, never as a scheduled check-in on how they feel. What you know about them shapes your tone, never your facts: don't fill in what they did, where they went, or why they feel the way they do; be curious instead. Get the timing right: something already behind them is said as past. When it's a feeling, meet it first. If they want help, find out what would help or walk them through the way forward, shaped around what they're feeling. If they're telling you how things are or were rather than asking for help, a real response is enough: don't turn it into a question about what would help, a therapy question, or a plan.`;

// "You're dry" and other feedback on how Cue comes across: show it, don't explain it (Royce, 2026-10-28).
export const FEEDBACK_GUIDE = `They're telling you how you're coming across. On this turn this overrides the general length and question rules: give it the depth it needs, with no length cap. Own it in a few words at most, then show it: give the reply their earlier message deserved, picking up what they actually shared, with something of your own in it rather than their words handed back, and using what they already told you rather than asking again. Don't explain your tone or how you work, don't say you're listening, don't apologize at length, and don't ask them to say it again. If they ask what went wrong, say honestly what happened, from what you actually sent.`;

// Lessons from their pushback, kept for next time (co_lesson memories).
export async function saveLesson(userId: string, lesson: string): Promise<void> {
  const { rows } = await pool
    .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'co_lesson' ORDER BY created_at DESC LIMIT 20`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();
  if (rows.some((r: any) => norm(String(r.content)) === norm(lesson))) return;
  await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'co_lesson', $2)`, [userId, lesson]).catch(() => {});
}

export async function lessonsFor(userId: string): Promise<string[]> {
  return pool
    .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'co_lesson' ORDER BY created_at DESC LIMIT 6`, [userId])
    .then((r) => r.rows.map((x: any) => String(x.content)))
    .catch(() => [] as string[]);
}

// What they want and what's going on, for tying something Co sent back to
// their why (services/coVoice.ts CO_WHY).
export function whyContext(known: Pick<DotsInput, "asks" | "threads">): string {
  const asks = known.asks.slice(0, 5).map((a) => `"${a}"`).join("; ");
  const threads = known.threads.slice(0, 4).map((t) => t.text).join("; ");
  return [asks ? `What they've asked Cue for: ${asks}.` : "", threads ? `What they're in the middle of: ${threads}.` : ""].filter(Boolean).join(" ");
}

// How Co reads them in a reply or a draft.
export function dotsInstruction(dots: Dot[]): string | null {
  const shape = dots.filter((d) => d.kind === "shape");
  const mention = dots.filter((d) => d.kind === "mention");
  const parts: string[] = [];
  if (mention.length) parts.push(`A connection worth making, in your own words, if it fits naturally: ${mention.map((d) => `${d.link} (ties to: ${d.why})`).join(" / ")}`);
  if (shape.length) parts.push(`Let this shape the pace and pressure of your reply (it doesn't mean saying less or skipping the connection above; don't lecture them or name it back to them): ${shape.map((d) => d.link).join(" / ")}`);
  return parts.length ? parts.join(" ") : null;
}
