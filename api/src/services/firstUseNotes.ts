// First-use notes (2026-11-08): when a member asks for something that changed, Cue says so once, plainly, the first time it matters,
// then offers what it does now. Never again after that, and never to a member who joined after the change (they only knew the new way).
//
// The one note today: the makers (pages, decks, documents, email drafts) were removed (#386-#388, 2026-11-04). The reply path already
// tells Cue it doesn't make those (services/coVoice.ts MAKER_DECLINE_RULE, harness/replyGrounding.ts MAKER_ASK). This adds, once per
// member, the neutral facts that it changed and what Cue does instead; Cue phrases it in its own words (small system lines give Cue
// facts, never a fixed line). It is noted pending while the reply is written and recorded only once a reply carrying it actually went
// (confirmMakerFirstUse, from the reply's send in routes/sendblue.ts), so a reply that never went says it next time.
//
// The record: one co_facts row per member (subject 'co', source FIRST_USE_SOURCE, object_key MAKER_FIRST_USE_KEY, visibility 'team':
// internal, never shown to a member as something Cue knows about them). The one-change announcement's makers line counts as told too
// (its ledger row on ONE_CHANGE_KEY with that line), so the two never both say it.
//
// Text replies only, for now: the call prompts carry the decline rule as fixed text (services/callTools.ts, services/gptLive.ts), and a
// per-member line there needs its own after-call record (see the PR).
import pool from "../db/db.js";
import { HELPERS_REMOVED_AT, ONE_CHANGE_HELPERS, ONE_CHANGE_KEY } from "./announcements.js";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

export const FIRST_USE_SOURCE = "first_use_note";
export const MAKER_FIRST_USE_KEY = "first_use:makers";

// An email draft ask (the makers' MAKER_ASK covers decks, docs, pages and PDFs, not email): only for the first-use note.
export const EMAIL_DRAFT_ASK = /\b(write|draft|compose|put together|help me (write|with)|can you (write|draft)|could you (write|draft))\b[^.?!\n]{0,40}\b(e-?mails?)\b/i;

// The tools that made what was removed, as Cue's action record holds them (co_facts source tool.<name>, written by
// services/coFacts.ts recordToolAction and the ledger's tool rows, services/ledger.ts toolOutcomeRow).
export const REMOVED_MAKER_TOOLS = ["makePage", "updatePage", "makeDeck", "updateDeck", "writeDocument", "emailPlan", "draftEmail"] as const;

// Whether Cue made a page, deck, document or email draft for them before the makers were removed: a tool that did it (not a refused
// call) in Cue's action record, a delivered document, a page or deck row, or an artifact's design log. Every source that honestly
// remains; the page and design tables may since have been emptied (scripts/cleanupRemovedHelpers.ts), so they are only extra evidence.
// Throws when it can't be read.
export async function usedRemovedMaker(userId: string, db: Db = pool): Promise<boolean> {
  const sources = REMOVED_MAKER_TOOLS.flatMap((t) => [`tool.${t}`, `tool.${t}.background`]);
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM co_facts WHERE owner_user_id = $1 AND subject = 'co' AND source = ANY($2::text[]) AND relation <> 'not_done' AND happened_at < $3)
         OR EXISTS (SELECT 1 FROM document_deliveries WHERE user_id = $1 AND delivered_at < $3)
         OR EXISTS (SELECT 1 FROM co_pages WHERE owner_user_id = $1 AND created_at < $3)
         OR EXISTS (SELECT 1 FROM artifact_design_log WHERE owner_user_id = $1 AND event = 'made' AND created_at < $3) AS used`,
    [userId, sources, HELPERS_REMOVED_AT],
  );
  if (typeof rows[0]?.used !== "boolean") throw new Error("no answer");
  return rows[0].used;
}

// Whether they've been told the makers changed: the first-use note went in a reply, or the one-change announcement's makers line went.
// Throws when it can't be read.
export async function makerChangeTold(userId: string, db: Db = pool): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM co_facts WHERE owner_user_id = $1 AND source = $2 AND object_key = $3)
         OR EXISTS (SELECT 1 FROM proactive_sends WHERE user_id = $1 AND target_key = $4 AND message = $5) AS told`,
    [userId, FIRST_USE_SOURCE, MAKER_FIRST_USE_KEY, ONE_CHANGE_KEY, ONE_CHANGE_HELPERS],
  );
  if (typeof rows[0]?.told !== "boolean") throw new Error("no answer");
  return rows[0].told;
}

// Model-facing facts for the one reply that says it (never a line handed to the member). Cue phrases it.
export const MAKER_FIRST_USE_FACTS =
  "A change to say once, the first time it matters, which is now: until early November Cue made decks, pages, documents and email drafts for members, and this member was around then. Cue stopped making them so it can put that time into who they should meet. Say plainly, in your own words and in one or two short sentences, that this changed. Then offer what Cue does now: if they still need one made, Cue can look for someone they could meet who does that. Nothing is promised beyond the look. This is the only time: don't bring the change up again in later replies.";

// Pure: whether this message is one the note is for.
export function asksForRemovedMaker(message: string, makerAsk: RegExp): boolean {
  return makerAsk.test(message) || EMAIL_DRAFT_ASK.test(message);
}

// Pure: whether the note goes in this reply. Joined before the change, and not told yet. Unread (null) is no note: the reply still
// declines as before, and the note waits for a read that works.
export function makerNoteDue(o: { joinedAt: Date | null; told: boolean | null }): boolean {
  return !!o.joinedAt && o.joinedAt.getTime() < HELPERS_REMOVED_AT.getTime() && o.told === false;
}

export type NoteDeps = { joinedAt: (userId: string) => Promise<Date | null>; told: (userId: string) => Promise<boolean> };
const realNoteDeps: NoteDeps = {
  joinedAt: async (userId) => {
    const { rows } = await pool.query(`SELECT created_at FROM users WHERE id = $1`, [userId]);
    return rows[0]?.created_at ? new Date(rows[0].created_at) : null;
  },
  told: (userId) => makerChangeTold(userId),
};

// The note's facts for this reply, or null. Any read that fails is null (no note this time).
export async function makerFirstUseNote(userId: string, deps: Partial<NoteDeps> = {}): Promise<string | null> {
  const d = { ...realNoteDeps, ...deps };
  const joinedAt = await d.joinedAt(userId).catch(() => null);
  if (!joinedAt || joinedAt.getTime() >= HELPERS_REMOVED_AT.getTime()) return null;
  const told = await d.told(userId).catch(() => null);
  return makerNoteDue({ joinedAt, told }) ? MAKER_FIRST_USE_FACTS : null;
}

// Set every reply turn (harness/replyGrounding.ts): given or not in THIS reply, so a note from a reply that never went is never
// recorded by a later reply that didn't carry it. Recorded once a reply carrying it went (confirmMakerFirstUse).
const pending = new Set<string>();
export function noteMakerFirstUse(userId: string, given: boolean): void {
  if (given) pending.add(userId);
  else pending.delete(userId);
}
export function makerFirstUsePending(userId: string): boolean {
  return pending.has(userId);
}
export async function confirmMakerFirstUse(userId: string, db: Db = pool, now: Date = new Date()): Promise<boolean> {
  if (!pending.has(userId)) return false;
  pending.delete(userId);
  await db.query(
    `INSERT INTO co_facts (owner_user_id, subject, relation, object_label, object_key, url, visibility, source, happened_at, meta)
     SELECT $1, 'co', 'did', 'told them, once, that Cue stopped making decks, pages, documents and email drafts', $3, NULL, 'team', $2, $4, '{}'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM co_facts WHERE owner_user_id = $1 AND source = $2 AND object_key = $3)`,
    [userId, FIRST_USE_SOURCE, MAKER_FIRST_USE_KEY, now],
  );
  return true;
}
// Tests only.
export function resetFirstUseNotes(): void {
  pending.clear();
}
