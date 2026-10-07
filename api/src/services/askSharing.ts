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
