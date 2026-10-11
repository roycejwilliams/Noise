// A member's visual taste (Royce, 2026-10-11: a deck's design "comes from the MEMBER's taste, not a fixed Co theme"): the vibe, the
// colors and the inspiration they named (Pinterest boards, sites, brands), or that they don't care. Kept as member knowledge, like
// room taste (services/roomTaste.ts): co_memories, read through the shared member layer (services/memberKnowledge.ts preferences,
// "stated"), so the next deck, page or doc doesn't ask again. Their words are kept with it.
//
// Co asks at most once (one question covering taste and what the deck should say). That ask is recorded too, so if they answer
// without a word on taste, the deck is built clean and minimal instead of asking again.
import pool from "../db/db.js";
import { DECK_MOODS, type DeckMood } from "./coPages/deck.js";

export const DESIGN_TASTE_MEMORY = "design_taste";
export const DESIGN_TASTE_ASKED = "design_taste_asked";
export const DESIGN_TASTE_LIMITS = { chars: 200, askedDays: 7 } as const;

export type DesignTaste = {
  // "minimal" when they don't care.
  mood: DeckMood;
  colors: { background: string | null; text: string | null; accent: string | null };
  type: "serif" | "sans" | null;
  // What they pointed to, as they said it: "my Pinterest board", "Aesop, Kinfolk".
  inspo: string | null;
  dontCare: boolean;
  // Their own words saying it.
  quote: string;
};

const HEX = /^#[0-9a-f]{6}$/i;
const clean = (x: unknown, n: number = DESIGN_TASTE_LIMITS.chars) => (typeof x === "string" && x.trim() ? x.trim().replace(/\s+/g, " ").slice(0, n) : null);

// Pure: a stored row back to a taste, or null when it isn't one.
export function parseDesignTaste(content: string): DesignTaste | null {
  try {
    const j = JSON.parse(content);
    const hex = (v: unknown) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim().toUpperCase() : null);
    const quote = clean(j?.quote) ?? "";
    if (!quote) return null;
    return {
      mood: DECK_MOODS.includes(j?.mood) ? j.mood : "minimal",
      colors: { background: hex(j?.colors?.background), text: hex(j?.colors?.text), accent: hex(j?.colors?.accent) },
      type: j?.type === "serif" || j?.type === "sans" ? j.type : null,
      inspo: clean(j?.inspo),
      dontCare: j?.dontCare === true,
      quote,
    };
  } catch {
    return null;
  }
}

// Pure: the line every reader sees, their words kept.
export function designTasteLine(t: DesignTaste): string {
  if (t.dontCare) return `Their design taste (for decks, pages, docs): no preference, so clean and minimal (their words: "${t.quote}")`;
  const colors = [t.colors.background && `background ${t.colors.background}`, t.colors.text && `text ${t.colors.text}`, t.colors.accent && `accent ${t.colors.accent}`].filter(Boolean).join(", ");
  const parts = [`${t.mood} feel`, colors || null, t.type ? `${t.type} type` : null, t.inspo ? `inspired by ${t.inspo}` : null].filter(Boolean);
  return `Their design taste (for decks, pages, docs): ${parts.join("; ")} (their words: "${t.quote}")`;
}

export async function recordDesignTaste(userId: string, t: DesignTaste): Promise<void> {
  const { writeMemory } = await import("./memory.js");
  await writeMemory(userId, DESIGN_TASTE_MEMORY, JSON.stringify(t));
}

// Their latest taste, or null.
export async function loadDesignTaste(userId: string): Promise<{ taste: DesignTaste; at: Date } | null> {
  const { rows } = await pool.query(`SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = $2 ORDER BY created_at DESC LIMIT 1`, [userId, DESIGN_TASTE_MEMORY]);
  const taste = rows[0] ? parseDesignTaste(String(rows[0].content ?? "")) : null;
  return taste ? { taste, at: new Date(rows[0].created_at) } : null;
}

// The one ask: recorded when Co asks, read so it never asks twice.
export async function recordTasteAsked(userId: string): Promise<void> {
  await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, $2, $3)`, [userId, DESIGN_TASTE_ASKED, "Co asked about their design taste"]);
}
export async function tasteAskedRecently(userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = $2 AND created_at > NOW() - make_interval(days => $3) LIMIT 1`,
    [userId, DESIGN_TASTE_ASKED, DESIGN_TASTE_LIMITS.askedDays],
  );
  return rows.length > 0;
}
