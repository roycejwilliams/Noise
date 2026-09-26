// How each member likes to be texted (Royce, 2026-09-26: make Co more
// adaptable). Everyone got the same reply style, and a correction ("that's
// not what we need right now", "just tell me") changed one reply, not the
// next. After each exchange, a quick read of their message against Co's
// last one: only a preference they made clear about how Co texts them
// becomes a note. Up to MAX_NOTES per member, newest kept, and a new note
// replaces an older one it contradicts. Co reads them before every reply
// (harness/replyGrounding.ts gatherReplyFacts).
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { recordDecision } from "../harness/core.js";

export const MAX_NOTES = 6;

export function styleLearningPrompt(current: string[], coSaid: string, theySaid: string): string {
  return `Co is an AI companion that texts members. You keep a short list of how this member likes Co to text them.

Current notes:
${current.length ? current.map((n) => `- ${n}`).join("\n") : "(none)"}

Co's last message: "${coSaid.slice(0, 600)}"
Their reply: "${theySaid.slice(0, 600)}"

Only change the notes if their reply makes clear how they want Co to text them: length, directness, detail, questions, tone, emoji, timing, what to lead with (e.g. "just tell me", "shorter please", "stop asking so many questions", "more detail", "that's not what I need, focus on X"). A normal reply is not a preference. Never note anything about their life or plans here, only how Co should text them.

If something changes, return the full updated list (at most ${MAX_NOTES}, each a short instruction to Co, newest last; drop any older note the new one contradicts). Otherwise return {"changed": false}.

Return ONLY JSON: {"changed": false} or {"changed": true, "notes": ["...", "..."]}`;
}

export function mergeNotes(notes: unknown): string[] {
  if (!Array.isArray(notes)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of notes) {
    // No dashes: Co copies the style of what it reads (2026-09-24 texting eval).
    const t = String(n ?? "").trim().replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").slice(0, 160);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(-MAX_NOTES);
}

export async function learnTextingStyle(userId: string, coSaid: string | null, theySaid: string): Promise<string[] | null> {
  if (!coSaid?.trim() || !theySaid?.trim()) return null;
  const { rows } = await pool.query(`SELECT texting_style FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  if (!rows[0]) return null;
  const current: string[] = Array.isArray(rows[0].texting_style) ? rows[0].texting_style : [];
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      maxOutputTokens: 300,
      experimental_telemetry: { isEnabled: true, functionId: "textingStyle.learn" },
      prompt: styleLearningPrompt(current, coSaid, theySaid),
    });
    const r = parseModelJson<{ changed?: boolean; notes?: unknown }>(text);
    if (!r?.changed) return null;
    const notes = mergeNotes(r.notes);
    await pool.query(`UPDATE co_profiles SET texting_style = $2 WHERE user_id = $1`, [userId, notes]);
    await recordDecision({ layer: 4, decision: "profile.textingStyle", userId, outcome: "act", action: "updated", proposal: { before: current, after: notes, theySaid: theySaid.slice(0, 200) } }).catch(() => {});
    return notes;
  } catch {
    return null;
  }
}

export async function textingStyleFor(userId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT texting_style FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  return Array.isArray(rows[0]?.texting_style) ? rows[0].texting_style : [];
}
