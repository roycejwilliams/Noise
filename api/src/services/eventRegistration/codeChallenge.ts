// A Luma code a member texts back, caught before the ordinary reply (Royce, 2026-11-09): only while that member has an active code
// challenge (a registration of theirs waiting on a code, with its browser session still held), and only when the text is a code.
//
// Caught means it never lands anywhere: the inbound text is rewritten to a placeholder BEFORE the route saves or reads it, so the
// stored delivery (inbound_webhook_handles.payload), the hold used when the database is down, the thread record (co_memories), the
// debounce, the reply prompt, its traces (Langfuse) and anything derived from the thread (embeddings, summaries, the member picture)
// only ever see the placeholder. The code itself is handed to the held session once, in memory, and dropped. Nothing calls a model.
// Not caught (it flows as an ordinary text): any message when no challenge is active, and any message that isn't just a code ("meet at
// 7", "$20", "my zip is 94110", "call me at 415-555-0101", "the 1234 Main St one").
// What it can't keep out: Sendblue, which carries the text to us, holds its own copy of the message (a third party, as with any text).
import pool from "../../db/db.js";

export const CODE_PLACEHOLDER = "[a sign-in code for an event signup, used once and not kept]";

// Pure: the code when the whole text is just a code, maybe with a word or two around it ("482913", "it's 482 913", "code: 482913
// thanks"). Anything else is null: a time, money, an address, a phone number, a sentence with a number in it.
const LEAD = /^(?:(?:here(?:'s| is| you go)|it'?s|that'?s|the code(?: is)?|code(?: is)?|my code(?: is)?|ok(?:ay)?|sure|yes|yep|got it)[\s,:.-]*)*/i;
const TAIL = /(?:[\s,.!]*(?:thanks|thank you|ty|thx))?[\s.!]*$/i;
export function codeOnlyMessage(text: string): string | null {
  const t = String(text ?? "").replace(/[’]/g, "'").trim();
  if (!t || t.length > 60 || /[$€£@#%/]|\b(?:am|pm|st|ave|rd|blvd|apt|room|zip|phone|call|text me|meet|at)\b/i.test(t)) return null;
  const core = t.replace(LEAD, "").replace(TAIL, "").trim();
  const m = core.match(/^(\d(?:[ -]?\d){5})$/);
  if (!m) return null;
  const code = m[1].replace(/[ -]/g, "");
  return code.length === 6 ? code : null;
}

export type ChallengeDeps = {
  heldAny: () => boolean;
  isHeld: (registrationId: string) => boolean;
  query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }>;
};

// The member's active code challenge (their registration waiting on a code, its session still held), or null. Free when nothing is held
// anywhere: no database read at all on an ordinary text.
export async function activeChallenge(phone: string, deps: ChallengeDeps): Promise<{ userId: string; registrationId: string } | null> {
  if (!deps.heldAny()) return null;
  const { rows } = await deps
    .query(
      `SELECT r.id, r.user_id FROM event_registrations r JOIN users u ON u.id = r.user_id
       WHERE u.phone_number = $1 AND u.archived_at IS NULL AND r.status = 'needs_member_code' AND r.updated_at > NOW() - INTERVAL '10 minutes'
       ORDER BY r.updated_at DESC LIMIT 3`,
      [phone],
    )
    .catch(() => ({ rows: [] as any[] }));
  const live = rows.find((r: any) => deps.isHeld(String(r.id)));
  return live ? { userId: String(live.user_id), registrationId: String(live.id) } : null;
}

// The route's check, before anything is saved: the code to use and the text to keep in its place, or null (the text flows as it came).
export async function catchCode(phone: string, text: unknown, deps?: ChallengeDeps): Promise<{ code: string; userId: string; registrationId: string; placeholder: string } | null> {
  if (typeof text !== "string") return null;
  const code = codeOnlyMessage(text);
  if (!code) return null;
  const d = deps ?? (await realChallengeDeps());
  const ch = await activeChallenge(phone, d);
  return ch ? { code, ...ch, placeholder: CODE_PLACEHOLDER } : null;
}

async function realChallengeDeps(): Promise<ChallengeDeps> {
  const L = await import("./lumaDriver.js");
  return { heldAny: () => L.heldCount() > 0, isHeld: (id) => L.isHeld(id), query: (sql, args) => pool.query(sql, args as any[]) };
}
