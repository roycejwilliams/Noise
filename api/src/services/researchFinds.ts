// What Co found while researching, kept with its link (Royce, 2026-10-03): "if
// research surfaced a name, the link goes on file at research time." Pitch
// Protocol was researched and described in a text, the page address lived only
// inside that one turn, and the next turns said "I don't actually have a link
// for them on file" to "send it" twice. Now every result a web search keeps is
// stored as a research_find, and every later reply sees them as facts it can
// hand over (a link in a draft is only allowed when it's on file).
import pool from "../db/db.js";
import { asOfWords, isStale, STALE_MARK } from "./asOf.js";

export type ResearchFind = { name: string; url: string; facts: string; at: string };

export const RESEARCH_FIND_DAYS = 14;
// Stored and fetched: plenty, so one big search can't push out the one they're asking about.
export const RESEARCH_FIND_MAX = 20;
// Shown to a reply: only the ones that matter to this message.
export const RESEARCH_FIND_SHOWN = 3;

// Pure: the finds as fact lines for a reply. A find is kept up to RESEARCH_FIND_DAYS; past a few hours what its page said is marked
// as of then (Phase B, B3, 2026-10-10: a 9-day-old "12 spots" read as today's, and the reply's fact check passed it against itself).
export function findLines(finds: ResearchFind[], now = new Date()): string[] {
  return finds.map((f) => {
    const said = !f.facts ? "" : isStale(f.at || null, now) ? `. What its page said when you found it (as of ${asOfWords(f.at || null)}, ${STALE_MARK}): ${f.facts}` : `. What its page says: ${f.facts}`;
    return `You researched "${f.name}" and have its link: ${f.url}${said}. If they ask for it, send this link.`;
  });
}

// Pure: whether a message is asking for a link or site. A link word they use
// as a noun ("the link", "their website"), or a bare imperative to send it
// ("send it", "nah just send it"). Not "I'll send it to my boss" or "on site".
export function asksForLink(message: string): boolean {
  const m = message.trim();
  if (/\b(?:the|that|their|its|a|your|this|his|her)\s+(?:link|url|website|web ?site|site)\b/i.test(m) || /\b(?:link|url)\b/i.test(m) && !/\bon[- ]?site\b/i.test(m)) return true;
  return /^(?:(?:ok(?:ay)?|nah|no|yeah|yes|well|so|just|pls|please|can you|could you)[,.!]?\s+)*(?:send|share|text|drop)\s+(?:it|that|them|this)\b/i.test(m);
}

const NAME_STOP = new Set(["the", "and", "for", "with", "inc", "llc", "com", "www"]);
const nameWords = (name: string): string[] => name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !NAME_STOP.has(w));

// Pure: the finds worth showing a reply: any whose name they (or the last lines)
// mention, then, if they're asking for a link, the newest. Newest first, at most
// RESEARCH_FIND_SHOWN. With neither, nothing: finds don't ride along every reply.
export function relevantFinds(finds: ResearchFind[], message: string, recent: string, linkAsk: boolean): ResearchFind[] {
  const said = `${message}\n${recent}`.toLowerCase();
  const named = finds.filter((f) => nameWords(f.name).some((w) => said.includes(w)));
  const picks = [...named, ...(linkAsk ? finds : [])];
  const seen = new Set<string>();
  return picks.filter((f) => !seen.has(f.url) && seen.add(f.url)).slice(0, RESEARCH_FIND_SHOWN);
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
