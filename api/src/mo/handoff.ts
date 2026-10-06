// When someone Mo invited joins, Co picks up where Mo left off (Royce,
// 2026-09-26) instead of starting cold: what was public about them, the
// event they were invited ahead of, and what they wrote back to Mo, in their
// own words. Only ever used in their own conversation with Co.
//
// None of it is something they told Co, so it reaches Co as an instruction,
// never a citable fact: Co can ask about it ("you're building in climate,
// right?") but can't state it, which also keeps the no-unasked-identity rule
// (services/identityGuard.ts). Co never says how it knew, and never
// mentions Mo. After 30 days what they've told Co themselves is enough.
import pool from "../db/db.js";

export const HANDOFF_DAYS = 30;

const q = (s: unknown, max: number) => `"${String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max)}"`;

// The one thing Co may say plainly: how they got in. Everything else is the
// instruction below.
export const HANDOFF_FACT = "They came in on one of the club's own invitations, not through a friend's invite.";

export function handoffLine(p: {
  source: string;
  evidence_quote?: string | null;
  bio?: string | null;
  headline?: string | null;
  invited_for?: string | null;
  their_words?: { text?: string }[] | null;
}): string | null {
  const parts: string[] = [];
  if (p.source === "x") {
    if (p.evidence_quote) parts.push(`Before joining, they posted publicly: ${q(p.evidence_quote, 280)}.`);
    if (p.bio?.trim()) parts.push(`Their public bio: ${q(p.bio, 200)}.`);
  } else if (p.headline?.trim()) {
    parts.push(`Their public LinkedIn headline: ${q(p.headline, 200)}.`);
  }
  const words = (Array.isArray(p.their_words) ? p.their_words : []).map((w) => String(w?.text ?? "").trim()).filter(Boolean).slice(-3);
  if (words.length) parts.push(`What they wrote back to their invitation: ${words.map((w) => q(w, 240)).join(" / ")}.`);
  if (!parts.length) return null;
  if (p.invited_for) parts.push(`They were invited ahead of ${p.invited_for}.`);
  return `This member came into Co on an invitation, not through a friend. ${parts.join(" ")} None of this is something they told you, and it may be out of date. Use it to ask good questions early on, as a question ("you're working on X, right?"), never as a fact about them. Never say how you know it, never say who invited them, and never mention anyone called Mo. If they ask how they got here or who invited them, say plainly that they came in on one of the club's own invitations ("you came in on one of our invitations"), not a friend's, and that who picked them stays private. Don't claim you reached out yourself (someone else did the reaching out), and don't talk about Co in the third person; never pretend not to know. Once they've told you themselves, go with what they said.`;
}

export async function moHandoff(userId: string): Promise<{ known: string[]; instruction: string } | null> {
  const { rows } = await pool
    .query(
      `SELECT source, evidence_quote, bio, headline, invited_for, their_words FROM mo_prospects
       WHERE joined_user_id = $1 AND joined_at > NOW() - make_interval(days => $2)
       ORDER BY joined_at DESC LIMIT 1`,
      [userId, HANDOFF_DAYS],
    )
    .catch(() => ({ rows: [] as any[] }));
  const instruction = rows[0] ? handoffLine(rows[0]) : null;
  if (instruction) return { known: [HANDOFF_FACT], instruction };
  // Someone a member asked Mo to find (mo/memberFlow.ts): Co asks about what they do and what they want from the club.
  // It never says a member asked, never names the member, and never says anyone reached out.
  const { rows: m } = await pool
    .query(`SELECT evidence_quote FROM mo_member_candidates WHERE joined_user_id = $1 AND joined_at > NOW() - make_interval(days => $2) ORDER BY joined_at DESC LIMIT 1`, [userId, HANDOFF_DAYS])
    .catch(() => ({ rows: [] as any[] }));
  if (!m[0]) return null;
  return {
    known: [HANDOFF_FACT],
    instruction: `They came in on an invitation from the club's own outreach, because of something they posted publicly: "${String(m[0].evidence_quote).slice(0, 160)}". You may ask about that work and what they hope to get from the club. Never say a member asked for them, never name or hint at any member, never say anyone reached out, and don't offer an introduction: that only happens if both people say yes.`,
  };
}
