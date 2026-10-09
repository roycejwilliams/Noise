// What kind of room a member has told Co they want, or don't (Royce, 2026-10-09: "everything is performative, I'm looking to be in
// a room where I can drop my guard" sat in a feedback log for the team; it's the highest-quality signal the picker gets, so it
// shapes what's picked). Their words, recorded when they say it (agent/conversationTools.ts noteRoomTaste), read through the shared
// member layer (services/memberKnowledge.ts preferences, source "stated") into the daily pick and the sweep picker.
import pool from "../db/db.js";

export type RoomTaste = { wants: string | null; avoids: string | null; quote: string };
export const ROOM_TASTE_MEMORY = "room_taste";
export const ROOM_TASTE_LIMITS = { keep: 5, days: 180, chars: 200 } as const;

// Pure: the line a reader sees, their quote kept.
export function roomTasteLine(t: RoomTaste): string {
  const parts = [t.wants ? `wants ${t.wants}` : null, t.avoids ? `not ${t.avoids}` : null].filter(Boolean);
  return `The kind of room they want: ${parts.join("; ")} (their words: "${t.quote}")`;
}

// Pure: a stored row back to a taste, or null when it isn't one.
export function parseRoomTaste(content: string): RoomTaste | null {
  try {
    const j = JSON.parse(content);
    const clean = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, ROOM_TASTE_LIMITS.chars) : null);
    const t = { wants: clean(j?.wants), avoids: clean(j?.avoids), quote: clean(j?.quote) ?? "" };
    return (t.wants || t.avoids) && t.quote ? t : null;
  } catch {
    return null;
  }
}

export async function recordRoomTaste(userId: string, t: RoomTaste): Promise<void> {
  const { writeMemory } = await import("./memory.js");
  await writeMemory(userId, ROOM_TASTE_MEMORY, JSON.stringify(t));
}

// Newest first: what they said most recently leads.
export async function loadRoomTaste(userId: string): Promise<{ taste: RoomTaste; at: Date }[]> {
  const { rows } = await pool.query(
    `SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = $2 AND created_at > NOW() - ($3 || ' days')::interval ORDER BY created_at DESC LIMIT $4`,
    [userId, ROOM_TASTE_MEMORY, ROOM_TASTE_LIMITS.days, ROOM_TASTE_LIMITS.keep],
  );
  return rows.flatMap((r: any) => {
    const taste = parseRoomTaste(String(r.content ?? ""));
    return taste ? [{ taste, at: new Date(r.created_at) }] : [];
  });
}
