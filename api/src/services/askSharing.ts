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

// Which numbered items they chose, read STRICTLY: only a clean choice counts, anything else is null and Co asks again. A
// wrong yes here shares an ask the member meant to keep private, so the grammar is small on purpose:
//   "1 and 3" / "1, 3" / "just 2" / "the first and the third"      -> those numbers
//   "all" / "everyone" / "all of them" / "all three"                -> every item
//   "all but 2" / "everyone except 1"                               -> everyone else
//   "none" / "nobody" / "no one"                                    -> no one
// Any other word, any negation ("not", "don't", "no" with a number), a question mark, or a number beyond the list is null.
const FILLER = new Set(["yes", "ok", "okay", "sure", "please", "just", "only", "and", "the", "reach", "out", "to", "go", "ahead", "with", "for", "on", "them", "those", "these", "people", "person", "of", "me", "number", "numbers"]);
const ORDINAL: Record<string, number> = { first: 1, second: 2, third: 3, "1st": 1, "2nd": 2, "3rd": 3 };
export function readPicks(message: string, count: number): number[] | null {
  if (/\?/.test(message)) return null;
  const m = message.toLowerCase().replace(/[’‘]/g, "'");
  if (/n't|\bnot\b|\bnever\b|\bwithout\b|\bskip\b|\bdrop\b|\bexclude\b|\bminus\b/.test(m)) return null;
  const tokens = m.replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const all = Array.from({ length: count }, (_, i) => i + 1);
  const joined = ` ${tokens.join(" ")} `;
  if (/^ (?:(?:yes|ok|okay|sure|please|just) )*(?:none|nobody|no one|none of them|nothing) (?:(?:for|now|thanks|thank|you) )*$/.test(joined)) return [];
  // all but N
  const butM = joined.match(/^ (?:(?:yes|ok|okay|sure|please) )*(?:all|everyone|all of them) (?:but|except) (?:number |numbers )?((?:\d+|first|second|third)(?: (?:and )?(?:\d+|first|second|third))*) $/);
  if (butM) {
    const out = new Set(butM[1].split(/ (?:and )?/).map((t) => (/^\d+$/.test(t) ? Number(t) : ORDINAL[t])));
    if ([...out].some((n) => !n || n < 1 || n > count)) return null;
    return all.filter((n) => !out.has(n));
  }
  if (tokens.includes("but") || tokens.includes("except")) return null;
  const hasAll = tokens.some((t) => ["all", "everyone"].includes(t));
  const nums: number[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) nums.push(Number(t));
    else if (ORDINAL[t]) nums.push(ORDINAL[t]);
    else if (t === "all" || t === "everyone" || t === "three" || t === "all") continue;
    else if (!FILLER.has(t)) return null;
  }
  if (hasAll) {
    // "all", "all of them", "all three": nothing else but fillers (so no numbers beside it)
    if (nums.length) return null;
    if (tokens.includes("three") && count !== 3) return null;
    return all;
  }
  if (tokens.includes("three")) return null;
  if (!nums.length) return null;
  if (nums.some((n) => n < 1 || n > count)) return null;
  return [...new Set(nums)].sort((a, b) => a - b);
}

// Their answer to the RSVP question, read from their whole message (readPicks above, strict: anything
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

// ---------------------------------------------------------------- before the event, once (2026-10-12 intelligence audit)
//
// A member who only ever texted Co has every ask private, so nobody in the room could be pointed to them, and the room
// produced no nudges at all. The RSVP question above reaches only asks that existed when they were asked about the brief.
// So before each Co event, a guest with no shareable ask and at least one undecided ask about people (services/peopleAsks.ts:
// errands and anything personal are never offered) is asked once, in their thread, through the daily pick (their hours, the
// room lane's caps and spacing). Never more than once per event (event_presence.share_asked_at), and never while the RSVP
// question, which carries the same line, is still to go. Their answer goes through the same tool and the same record
// (recordRsvpShareAnswer): a yes marks that ask shareable; no answer leaves it private.

// Pure: whether the question is due for this guest at this event.
export function shareQuestionDue(p: {
  notGoing: boolean;
  // The RSVP question (which carries the sharing line) is still to go for this event.
  nameAskPending: boolean;
  // Already asked about sharing for this event (by either question).
  shareAsked: boolean;
  hasShareableAsk: boolean;
  offerable: number;
  startAt: string;
  now: Date;
}): { due: boolean; why: string } {
  if (p.notGoing) return { due: false, why: "said they can't make it" };
  if (new Date(p.startAt).getTime() <= p.now.getTime()) return { due: false, why: "the event has started" };
  if (p.shareAsked) return { due: false, why: "already asked for this event" };
  if (p.nameAskPending) return { due: false, why: "the RSVP question carries it" };
  if (p.hasShareableAsk) return { due: false, why: "already has a shareable ask" };
  if (!p.offerable) return { due: false, why: "no undecided ask about people" };
  return { due: true, why: "" };
}

// In Co's voice, fixed in code: one light question.
export function roomShareAskMessage(eventName: string, asks: { text: string }[]): string | null {
  const line = shareAskMessage(asks);
  if (!line) return null;
  return `One question before ${eventName}. ${line.replace(/^And if/, "If")}`;
}

// The asks the question may offer now: undecided, about people, not personal (Co's read; unknown offers nothing).
export async function offerableShareAsks(intent: unknown): Promise<{ id: string; text: string }[]> {
  const { shareableCandidates } = await import("./peopleAsks.js");
  const undecided = (Array.isArray(intent) ? intent : []).filter((e: any) => isOpenAsk(e) && e.id && (e.shareable === undefined || e.shareable === null)) as { id: string; text: string; type?: string }[];
  const ok = await shareableCandidates(undecided);
  return ok.slice(-RSVP_SHARE_MAX).reverse().map((a) => ({ id: a.id, text: a.text }));
}
