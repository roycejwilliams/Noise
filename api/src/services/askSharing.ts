// Which of a member's asks Co may say out loud when it introduces them (Royce, 2026-10-07: "an ask is only shareable
// if the member marked it shareable. Default is private."). The in-room nudge, the brief and network intros quote only
// an ask marked here (services/matching.ts shareableAsks; harness/matchGate.ts checkShareReason). Nothing else marks it.
import pool from "../db/db.js";
import { isOpenAsk } from "../harness/profileWrite.js";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Pure: the one open ask their words point at. Exact text first, then the only ask that contains (or is contained in)
// what was named. More than one fit, or none, is no ask: Co asks which.
export function pickAsk(intent: unknown, named: string): { id: string; text: string } | { none: true } | { ambiguous: string[] } {
  const open = (Array.isArray(intent) ? intent : []).filter((e: any) => isOpenAsk(e) && e.id) as { id: string; text: string }[];
  const n = norm(named);
  if (!n) return { none: true };
  const exact = open.filter((a) => norm(a.text) === n);
  if (exact.length === 1) return exact[0];
  const near = open.filter((a) => norm(a.text).includes(n) || n.includes(norm(a.text)));
  if (near.length === 1) return near[0];
  return near.length > 1 ? { ambiguous: near.map((a) => a.text) } : { none: true };
}

// Marks one ask shareable (their yes) or private again (their no). Returns the ask's text, or why not.
export async function setAskShareable(userId: string, named: string, shareable: boolean): Promise<{ ok: true; text: string } | { ok: false; why: string; options?: string[] }> {
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const intent = Array.isArray(rows[0]?.intent) ? rows[0].intent : [];
  const hit = pickAsk(intent, named);
  if ("none" in hit) return { ok: false, why: "no open ask of theirs matches that" };
  if ("ambiguous" in hit) return { ok: false, why: "more than one of their asks matches that", options: hit.ambiguous };
  const next = intent.map((e: any) => (e?.id === hit.id ? { ...e, shareable, shareable_at: new Date().toISOString() } : e));
  await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(next)]);
  return { ok: true, text: hit.text };
}

// ---------------------------------------------------------------- at RSVP (beside "can I name you in the brief?")

export const RSVP_SHARE_MAX = 3;

// The asks the question offers: open, not yet decided either way (a member who already said yes or no about an ask
// isn't asked again), newest first, at most three.
export function undecidedAsks(intent: unknown): { id: string; text: string }[] {
  const open = (Array.isArray(intent) ? intent : []).filter((e: any) => isOpenAsk(e) && e.id && (e.shareable === undefined || e.shareable === null)) as { id: string; text: string }[];
  return open.slice(-RSVP_SHARE_MAX).reverse();
}

// In Co's voice: one question, per ask, private unless picked.
export function shareAskMessage(asks: { text: string }[]): string | null {
  if (!asks.length) return null;
  if (asks.length === 1) return `And if someone in the room is a good match, can I tell them you're looking for ${asks[0].text}? Yes or no. If you don't say, I keep it to myself.`;
  return `And if someone in the room is a good match, can I tell them what you're looking for? Reply with the numbers you're happy to share, all, or none: ${asks.map((a, i) => `${i + 1}. ${a.text}`).join("  ")}. Anything you don't pick stays between us.`;
}

// Pure: their picks (1-based) over the asks offered, applied to the intent. Picked asks become shareable; the others they
// were shown become explicitly private. Asks not offered are untouched.
export function applyAskPicks<T extends { id?: string }>(intent: T[], offeredIds: string[], picks: number[]): T[] {
  const yes = new Set(picks.map((n) => offeredIds[n - 1]).filter(Boolean));
  const at = new Date().toISOString();
  return intent.map((e: any) => (e?.id && offeredIds.includes(e.id) ? { ...e, shareable: yes.has(e.id), shareable_at: at } : e));
}

// Their answer to the RSVP question, read from their whole message (mo/memberRules.ts readPicks, strict: anything
// unclear is no answer, and Co asks which numbers). A single offered ask takes a plain yes or no.
export async function recordRsvpShareAnswer(userId: string, message: string): Promise<{ ok: true; shared: string[] } | { ok: false; why: string }> {
  const { rows } = await pool.query(
    `SELECT event_api_id, share_ask_ids FROM event_presence WHERE user_id = $1 AND share_asked_at > NOW() - INTERVAL '14 days' AND share_answered_at IS NULL ORDER BY share_asked_at DESC LIMIT 1`,
    [userId],
  );
  const open = rows[0];
  const ids: string[] = Array.isArray(open?.share_ask_ids) ? open.share_ask_ids : [];
  if (!open || !ids.length) return { ok: false, why: "there's no open question about sharing their asks" };
  let picks: number[] | null;
  if (ids.length === 1) {
    const { readNameAnswer } = await import("./eventBrief.js");
    const a = readNameAnswer(message, message);
    picks = a === "yes" ? [1] : a === "no" ? [] : null;
  } else {
    const { readPicks } = await import("../mo/memberRules.js");
    picks = readPicks(message, ids.length);
  }
  if (!picks) return { ok: false, why: "their answer isn't a clear choice" };
  const { rows: p } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const intent = Array.isArray(p[0]?.intent) ? p[0].intent : [];
  const next = applyAskPicks(intent, ids, picks);
  await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(next)]);
  await pool.query(`UPDATE event_presence SET share_answered_at = NOW() WHERE event_api_id = $1 AND user_id = $2`, [open.event_api_id, userId]);
  return { ok: true, shared: next.filter((e: any) => e?.id && ids.includes(e.id) && e.shareable === true).map((e: any) => String(e.text)) };
}
