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

export async function findDots(input: DotsInput, timeoutMs = 6000): Promise<Dot[]> {
  if (!input.now.trim() || (!input.asks.length && !input.threads.length)) return [];
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      maxOutputTokens: 400,
      abortSignal: AbortSignal.timeout(timeoutMs),
      experimental_telemetry: { isEnabled: true, functionId: "connectDots" },
      prompt: `You help Co, a companion who texts with one member, notice how things connect in their life, the way a friend who's been paying attention would.

What's happening now:
${input.now.slice(0, 800)}

What they've asked Co for (their words):
${input.asks.map((a) => `- ${a}`).join("\n") || "- (nothing open)"}

What they're in the middle of:
${input.threads.map((t) => `- ${t.text}${t.feeling ? ` (feeling: ${t.feeling})` : ""}`).join("\n") || "- (nothing open)"}
${input.feeling ? `\nHow they've been lately: ${input.feeling}\n` : ""}
Event offers Co has texted them in the last 7 days: ${input.offersThisWeek}

Find at most two connections that what's happening now actually leads to, the way a friend who's been paying attention would:
- "mention": something worth pointing out, like one thing serving two of their goals, or something now that bears on a decision they're stuck on.
- "shape": how they're doing that should change how Co responds right now, not something to say (for example: burned out and asking for more events, so offer fewer, lower-pressure ones, or check in on them first).
Only links what's happening now leads to. A thanks, an ok, a sign-off or pure logistics leads nowhere: return none. Only real, specific links from what's written above; never invent facts about an event, a person, or them.

First decide whether what's happening now leads anywhere at all. Then return ONLY JSON: {"leads_somewhere": true | false, "dots": [{"kind": "mention" | "shape", "link": "the connection in one short plain sentence", "why": "which of their asks or threads it ties to"}]}`,
    });
    const parsed = parseModelJson(text);
    const dots = parsed?.leads_somewhere !== false && Array.isArray(parsed?.dots) ? parsed.dots : [];
    return dots
      .filter((d: any) => typeof d?.link === "string" && d.link.trim())
      .slice(0, 2)
      .map((d: any) => ({ link: String(d.link).trim().slice(0, 240), why: String(d.why ?? "").trim().slice(0, 160), kind: d.kind === "shape" ? ("shape" as const) : ("mention" as const) }));
  } catch (err: any) {
    console.error("connectDots: failed (non-fatal):", err?.message ?? err);
    return [];
  }
}

// What they want and what's going on, for tying something Co sent back to
// their why (services/coVoice.ts CO_WHY).
export function whyContext(known: Pick<DotsInput, "asks" | "threads">): string {
  const asks = known.asks.slice(0, 5).map((a) => `"${a}"`).join("; ");
  const threads = known.threads.slice(0, 4).map((t) => t.text).join("; ");
  return [asks ? `What they've asked Co for: ${asks}.` : "", threads ? `What they're in the middle of: ${threads}.` : ""].filter(Boolean).join(" ");
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
