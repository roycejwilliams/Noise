// On the way to a Co event (Royce, 2026-09-30). One text before a member's Co
// event, replacing the old day-of arrival ask so it stays one text per event:
// what they need to get there (from the event's own Luma fields only), how many
// people coming fit what they're after (a count, never who, and only when two or
// more fit, so no one can be picked out before the room), one opener tied to
// their ask (or, when Co doesn't know what they want from it, that question),
// and an offer to share their location while they head over.
//
// Timing is Co's (services/followUps.ts): queued 3 hours before the start, sent
// when Co judges best and no later than 1 hour before, through the daily pick
// (their hours, the caps). Once per event.
//
// Location is opt-in, per event, in code:
//   - read only after a yes quoted from their own message (shareLocationYes)
//   - only during that event's watch window (eventPresence.isWatchWindow)
//   - the yes never carries over to another event
//   - "stop sharing" ends it at once; a bare STOP opts out of everything
//   - used only to know they've arrived (to time the first nudge) and for at
//     most one no-pressure note if they're clearly still far away at the start
//   - never stored (only times are), never used for offers, never told to anyone
import { isOpenAsk } from "../harness/profileWrite.js";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { briefPairBlocks, namedYes, pickNamed, rankingFor } from "./eventBrief.js";
import type { RankedCandidate } from "./eventScoring.js";

export const PRE_ARRIVAL = { fromBeforeStartMs: 3 * 3_600_000, untilBeforeStartMs: 60 * 60_000, strongScore: 60, minCrowd: 2, farMeters: 3000, farNoteFromMs: 10 * 60_000, farNoteUntilMs: 30 * 60_000 };

// ---------------------------------------------------------------- rules (pure)

export function preArrivalWindow(startAt: string): { from: Date; until: Date } {
  const s = new Date(startAt).getTime();
  return { from: new Date(s - PRE_ARRIVAL.fromBeforeStartMs), until: new Date(s - PRE_ARRIVAL.untilBeforeStartMs) };
}

// Who gets it: registered, hasn't said they can't make it, not sent already,
// and the event is still on (a canceled one is gone from the calendar).
export function preArrivalEligible(p: { registered: boolean; notGoing: boolean; alreadySent: boolean; eventListed: boolean }): { ok: boolean; why: string | null } {
  if (!p.eventListed) return { ok: false, why: "the event is no longer on the calendar" };
  if (!p.registered) return { ok: false, why: "not registered" };
  if (p.notGoing) return { ok: false, why: "said they can't make it" };
  if (p.alreadySent) return { ok: false, why: "already sent for this event" };
  return { ok: true, why: null };
}

// No other guest is ever named in it.
export function namesAnyone(text: string, names: string[]): string | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z' ]+/g, " ")} `;
  // Every name, however short ("Jo", "Al"), as a whole word: when in doubt, it names someone.
  return names.find((n) => n && n.trim().length >= 1 && t.includes(` ${n.trim().toLowerCase()} `)) ?? null;
}

export type Consent = { event_api_id: string; location_yes_at: Date | null; location_stopped_at: Date | null };

// May Co use their location for this event, now?
export function mayReadLocation(c: Consent | null, eventId: string, inWatchWindow: boolean): boolean {
  return !!c && c.event_api_id === eventId && !!c.location_yes_at && !c.location_stopped_at && inWatchWindow;
}

export function isStopSharing(text: string): boolean {
  return /\b(stop (sharing|tracking|watching|following)( my location| me)?|don'?t (track|watch|follow) me|turn(ing)? (location|sharing|it) off|stop using my location|no more location)\b/i.test(text);
}

// "Yes" to sharing, in their own words.
export function yesToSharing(quote: unknown, message: string): boolean {
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(quote);
  return q.length >= 2 && norm(message).includes(q) && !/\b(no|nah|don'?t|not|stop)\b/.test(q);
}

export function farNoteDue(p: { startAt: string; now: Date; arrived: boolean; noteSent: boolean; distanceM: number | null }): boolean {
  const since = p.now.getTime() - new Date(p.startAt).getTime();
  return !p.arrived && !p.noteSent && p.distanceM !== null && p.distanceM > PRE_ARRIVAL.farMeters && since >= PRE_ARRIVAL.farNoteFromMs && since <= PRE_ARRIVAL.farNoteUntilMs;
}

export const LOCATION_OFFER = "If you want, share your location with me in Messages while you head over (until the end of the day works). I'll know when you've arrived and can point you to the right people then.";

export function localDate(startAt: string, zone: string | null): string {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  return DateTime.fromISO(startAt, { zone: z }).toISODate() ?? "";
}

export function localStart(startAt: string, zone: string | null): string {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  return DateTime.fromISO(startAt, { zone: z }).toFormat("h:mm a");
}

// ---------------------------------------------------------------- data

// Their stated ask, if any (the newest open "seeking" ask).
export async function statedAsk(userId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const intent = Array.isArray(rows[0]?.intent) ? rows[0].intent : [];
  const open = intent.filter((i: any) => isOpenAsk(i) && i?.type === "seeking"); // an ask, never a goal (harness/profileWrite.ts)
  return open.length ? String(open[open.length - 1].text) : null;
}

// How many people coming fit their ask strongly (a count only). The same guests the member brief may count, by its own rules
// (services/eventBrief.ts pickNamed with nobody named): still registered, haven't said they can't make it, at the strong bar, with a
// reason that is one of their asks shareable right now, and no pair record against it (declined, introduced, blocked: briefPairBlocks).
// It counted every stored ranking before (2026-11-03): a guest who cancelled, or one whose pair was declined, made "a few people coming
// fit what you're after" when fewer did. A read that fails counts nobody (the text then says nothing about who fits), never a guess.
export async function strongFits(eventId: string, userId: string, members: { user_id: string; first_name: string }[]): Promise<number> {
  try {
    const others = members.filter((m) => m.user_id !== userId);
    const rankedAll = await rankingFor(eventId, userId);
    if (!rankedAll.length || !others.length) return 0;
    const blocks = await briefPairBlocks(eventId, userId, rankedAll.map((r) => r.candidate_id));
    if (!blocks) return 0;
    const { notGoing } = await namedYes(eventId, others.map((m) => m.user_id));
    const { shareableAsks } = await import("./matching.js");
    const { rows } = await pool.query(`SELECT user_id, intent FROM co_profiles WHERE user_id = ANY($1::uuid[])`, [others.map((m) => m.user_id)]);
    const stillShareable = new Map<string, string[]>(rows.map((r: any) => [String(r.user_id), shareableAsks(r.intent).map((a: any) => String(a.text))]));
    return countStrongFits({ ranked: rankedAll.filter((r) => !blocks.has(r.candidate_id)), recipientId: userId, members: others, notGoing, stillShareable });
  } catch {
    return 0;
  }
}

// Pure: the count, through the brief's own picker with nobody allowed a name (so every fit is a count).
export function countStrongFits(p: { ranked: RankedCandidate[]; recipientId: string; members: { user_id: string; first_name: string }[]; notGoing: Set<string>; stillShareable: Map<string, string[]> }): number {
  return pickNamed({ ranked: p.ranked, recipientId: p.recipientId, members: p.members, nameOk: new Set(), notGoing: p.notGoing, stillShareable: p.stillShareable }).unnamedFits;
}

export async function presenceRow(eventId: string, userId: string): Promise<any | null> {
  const { rows } = await pool.query(`SELECT * FROM event_presence WHERE event_api_id = $1 AND user_id = $2`, [eventId, userId]).catch(() => ({ rows: [] as any[] }));
  return rows[0] ?? null;
}

export async function recordLocationYes(eventId: string, userId: string, quote: string): Promise<void> {
  await pool.query(
    `INSERT INTO event_presence (event_api_id, user_id, location_yes_at, location_yes_quote) VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (event_api_id, user_id) DO UPDATE SET location_yes_at = NOW(), location_yes_quote = $3, location_stopped_at = NULL`,
    [eventId, userId, quote.slice(0, 200)],
  );
  await recordDecision({ layer: 6, decision: "event.location_yes", userId, outcome: "act", action: "consented", proposal: { eventId } }).catch(() => {});
}

// Ends it for every event of theirs today.
export async function stopSharing(userId: string): Promise<number> {
  const { rowCount } = await pool.query(`UPDATE event_presence SET location_stopped_at = NOW() WHERE user_id = $1 AND location_yes_at IS NOT NULL AND location_stopped_at IS NULL`, [userId]);
  if (rowCount) await recordDecision({ layer: 6, decision: "event.location_stop", userId, outcome: "act", action: "stopped", proposal: { events: rowCount } }).catch(() => {});
  return rowCount ?? 0;
}

export async function setGoing(eventId: string, userId: string, going: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO event_presence (event_api_id, user_id, not_going_at) VALUES ($1, $2, ${going ? "NULL" : "NOW()"})
     ON CONFLICT (event_api_id, user_id) DO UPDATE SET not_going_at = ${going ? "NULL" : "NOW()"}`,
    [eventId, userId],
  );
}
