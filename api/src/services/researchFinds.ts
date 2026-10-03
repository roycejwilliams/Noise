// What Co found while researching, kept with its link (Royce, 2026-10-03): "if
// research surfaced a name, the link goes on file at research time." Pitch
// Protocol was researched and described in a text, the page address lived only
// inside that one turn, and the next turns said "I don't actually have a link
// for them on file" to "send it" twice. Now every result a web search keeps is
// stored as a research_find, and every later reply sees them as facts it can
// hand over (a link in a draft is only allowed when it's on file).
import pool from "../db/db.js";

export type ResearchFind = { name: string; url: string; facts: string; at: string };

export const RESEARCH_FIND_DAYS = 14;
export const RESEARCH_FIND_MAX = 8;

// Pure: the finds as fact lines for a reply.
export function findLines(finds: ResearchFind[]): string[] {
  return finds.map((f) => `You researched "${f.name}" and have its link: ${f.url}${f.facts ? `. What its page says: ${f.facts}` : ""}. If they ask for it, send this link.`);
}

// Pure: whether a message is asking for a link or site.
export function asksForLink(message: string): boolean {
  return /\b(link|url|website|web ?site|site)\b/i.test(message) || /\b(send|share|text|drop)\s+(it|that|them|this)\b/i.test(message);
}

// Pure: what to tell Co when they ask for a link. With one on file, send it;
// with none, look it up now, never "can't send what I don't have".
export function linkRequestInstruction(message: string, haveLink: boolean): string | null {
  if (!asksForLink(message)) return null;
  return haveLink
    ? "They're asking for a link: send the one you have on file for what they mean, as a plain link."
    : "They're asking for a link you don't have on file. Don't ask permission and don't say you can't: look it up now (webSearch, or readPage), then send what you find. Only if the search turns up nothing, say so plainly.";
}

const key = (url: string) => JSON.stringify(url.trim());

// Stores what a search kept. One row per link per fortnight. Never throws.
export async function recordResearchFinds(userId: string, finds: { name: string; url: string; facts?: string }[]): Promise<number> {
  let stored = 0;
  for (const f of finds) {
    if (!f.name || !/^https?:\/\//i.test(f.url)) continue;
    try {
      const seen = await pool.query(
        `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'research_find' AND created_at > NOW() - ($3 || ' days')::interval AND position($2 in content) > 0 LIMIT 1`,
        [userId, `"url":${key(f.url)}`, RESEARCH_FIND_DAYS],
      );
      if (seen.rows[0]) continue;
      await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'research_find', $2)`, [
        userId,
        JSON.stringify({ name: f.name.slice(0, 120), url: f.url.trim(), facts: (f.facts ?? "").slice(0, 400) }),
      ]);
      stored++;
    } catch (err: any) {
      console.error("recordResearchFinds failed (non-fatal):", err?.message ?? err);
    }
  }
  return stored;
}

// The newest finds, newest first.
export async function recentResearchFinds(userId: string): Promise<ResearchFind[]> {
  const { rows } = await pool
    .query(
      `SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'research_find' AND created_at > NOW() - ($2 || ' days')::interval ORDER BY created_at DESC LIMIT $3`,
      [userId, RESEARCH_FIND_DAYS, RESEARCH_FIND_MAX],
    )
    .catch(() => ({ rows: [] as any[] }));
  const out: ResearchFind[] = [];
  for (const r of rows) {
    try {
      const j = JSON.parse(r.content);
      if (j?.name && j?.url) out.push({ name: String(j.name), url: String(j.url), facts: String(j.facts ?? ""), at: new Date(r.created_at).toISOString() });
    } catch {}
  }
  return out;
}
