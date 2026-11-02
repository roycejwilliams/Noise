// Matching, taste-first (Royce, 2026-10-12: "Fix the five known holes first. Then, before every intro, a one-line reason
// each side gets value; a weak line means no intro. The standard: a friend who knows both people would make this intro.")
//
// This file is the one place the in-room matching rules live: the pause, "in the room right now", the pair record, the
// value-line gate and the end of the night. The sending paths stay where they were (eventScoring.ts nudges,
// eventGuestMatchHandoff.ts asks and the intro email, eventUnmatchedFollowUp.ts) and ask here before they act.
//
// ============================================================ THE FIVE HOLES
//
// 1. Shareable-ask gating (per ask, default private).
//    Was: the RSVP question already asked per ask (askSharing.ts) and the share reason had to be one shareable ask word
//    for word (matchGate.ts checkShareReason). But the nudge's consent facts handed the drafter's checks and the
//    consent-read model ALL of the candidate's open asks as "what they've told Co they're looking for"
//    (eventScoring.ts getActiveAsks), so a draft echoing a private ask passed the interest check and the model read, and
//    no check looked for a private ask's words in the text itself (private asks are not in candidatePrivateTexts).
//    Matching itself also ran on private asks: the asker's frame was their newest seeking ask, shareable or not (a dev
//    run on 2026-10-12 matched a member on "a new role ... without my cofounder knowing"), and the scorer read every
//    candidate's private asks.
//    Now: matching reads only shareable asks (matchableIntent, applied to the whole room before scoring; goals stay the
//    frame for someone with no shareable ask); consent facts carry shareable asks only; every in-room draft also passes
//    checkNoPrivateQuote (below) against the other member's private asks, profile, notes and owner-only facts; and value
//    lines (below) never see a private ask, rest only on the other member's shareable asks, and are checked in code.
//    Since 2026-10-18 (Royce): the scorer also reads a candidate's private asks and blockers as a marked hidden signal
//    (services/matching.ts); still never anyone's frame, never a reason, and no line or draft may echo them
//    (harness/hiddenEcho.ts).
//
// 2. Emergency pause (kill switch, not a toggle).
//    Was: PROACTIVE_PAUSED, an env var: global only, needs a redeploy to flip, and it never covered the intro email
//    (sendIntroEmail sent with both yeses whatever the pause said) or the additive reveal inside a reply.
//    Now: a matching_pauses row, read fresh on every check (no cache), scope 'all' or one event's id. It stops scoring,
//    nudges, additive offers and reveals, direct asks, the intro email, the outside-event heads-up in the daily pick, and
//    (scope 'all') network suggestions, reveals, asks and emails. Nothing a member was promised is dropped: a direct ask
//    whose asker was told "I'll check" waits in deferred_sends (held while paused, re-checked against the pair record when
//    it goes); a held in-room intro email is marked once (intro_held_at) and sent by retryHeldIntros when the pause
//    lifts. PROACTIVE_PAUSED still stops everything too. A failed read counts as paused.
//      On:  npx tsx src/scripts/matchingPause.ts on [eventId|all] "why"
//      Off: npx tsx src/scripts/matchingPause.ts off [eventId|all]
//
// 3. One in-room definition.
//    Was: "the room" was inRoomPool (the roster) in some places and eventMembers (Luma approved only, no walk-ins, no
//    not-going) in others; "is it on" had four ends for an event without one (effectiveEnd's evening, 6h in
//    eventPresence twice, 12h for walk-ins); someone who had left (event_presence.left_at) was still nudged and still
//    named to others; and test events had no roster or timing at all outside eventPresence.
//    Now: roomPhase (harness/introConsent.ts, beside effectiveEnd) is the one phase rule, also used by checkEventWindow;
//    inRoomNow / isInRoomNow (below) is the one "in the room right now": on the roster (inRoomPool), the room open, not
//    left, and the room not closed by the end-of-night job. Nudges (both people), additive offers and reveals and the
//    end-of-night pairing read it; presence and walk-in windows take their end from effectiveEnd. eventTiming (below)
//    is the one place timing is read, test events included.
//
// 4. Per-pair tracking.
//    Was: four partial records (event_guest_match_nudges per person, event_guest_match_opt_ins per direction,
//    event_match_offers per question, network_introductions for the network) and nothing for met or outcome. A declined
//    pair could be suggested again at the next event, and nothing tied a yes, the email and how it went to one pair.
//    Now: co_pairs, one row per (event, pair), a_id < b_id. Lifecycle below. mayAsk refuses a second ask of the same
//    person about the same pair, any pair either side declined at any event, any pair already introduced, a pair the
//    value gate blocked, and a pair whose asks expired.
//
// 5. End-of-night timer.
//    Was: pending in-room asks stayed open for 7 days (inRoomOffers REPLY_EXPIRY_DAYS), so a "yes" the next week bound
//    to an in-room question; the only end-of-night work was the unmatched pass and the check-in, each scheduled only when
//    Luma's details loaded.
//    Now: event_room_closures, one durable row per event, due at effectiveEnd + ROOM_CLOSE_BUFFER_MINUTES, scheduled by
//    every scoring pass and by a sweep of Co's calendar (test events included). The */5 cron (jobs/index.ts) claims due
//    rows and closes the room: in-room matching stops (roomPhase reads closed_at), open and queued offers expire, asks
//    held overnight are brought due so the deferred runner drops them as "event over" (the asker is told it didn't go
//    out, never why), pairs still waiting expire, and the follow-up path starts: every member who was in the room gets
//    their end-of-night check-in row (eventCheckinFollowUp.ts), which asks how it went; noteRoomMeeting records it.
//
// ============================================================ THE PAIR LIFECYCLE (co_pairs.state)
//
//   suggested   Co picked the pair (a nudge or reveal about to go, or a member named someone: origin 'member')
//      |        value gate: strong -> lines stored, goes on; weak or leaky -> blocked (terminal for this event, logged)
//   asked       an ask reached one side (asked_a_at / asked_b_at, each set once: never asked twice)
//      |        each side answers once (a_answer / b_answer). Any no -> declined (terminal, every event, never re-suggested)
//   both_yes    both said yes; the intro email goes now, or when the pause lifts (retryHeldIntros: held by the pause,
//               or failed up to INTRO_MAX_ATTEMPTS times, both members still active, at most 3 days after both yeses)
//   intro_sent  the one email went to both
//   met         one side told Co they met (noteRoomMeeting); a_outcome / b_outcome hold each side's own words, never shown
//               to the other side. What happened after the intro, per side, with its source and whether it was said or
//               inferred: a_evidence / b_evidence (the outcome record, below; 2026-11-02)
//   expired     the room closed with the pair still suggested or asked (terminal for this event)
//
// ============================================================ THE VALUE-LINE GATE
//
// Before any Co-initiated intro ask (the in-room nudge, the additive reveal, the end-of-night pairing, the outside-event
// heads-up), Co (the model) writes one line per side: why THIS person gets value from the other, and judges whether a
// friend who knows them would make the intro for their sake ("strong" or "weak"). One call per side: the reader's own
// context (their shareable asks, goals, how earlier intros went) and, of the other member, ONLY their first name and
// shareable asks. The other member's private data never enters the prompt, so no paraphrase of it can come out
// (2026-10-12 review). A side whose other member shared nothing gets no call and no line (withheld, as before); at least
// one side must be judged, and every judged side must be strong. Code guards the facts, not the taste, as a backstop:
//   - each line rests on what the OTHER member marked shareable (at least two of its words), so the reason is real;
//   - neither line carries a private ask (anyone's), the other member's profile, notes, outcome notes or owner-only facts
//     (shingles, with the event name, venue and first names allowed, and coFacts.privateFactLeak), and no sensitive
//     topic that is only the other member's;
//   - a weak verdict or a missing line is no intro: stored on the pair (value_line_a/b, value_verdict, blocked_reason)
//     and logged (match.valueLines). It turns only a 'suggested' pair into 'blocked'; a pair already moving keeps its
//     state. A failed read is logged and NOT stored, so the next pass tries again, and the nudge loop moves on to the
//     person's next candidate meanwhile.
// Line for A is shown only to A (their nudge); line for B only to B (their direct ask). An intro a member asked for by
// name (requestEventIntro) is theirs, not Co's suggestion: logged as member-requested, not blocked on taste, and not
// swallowed by a Co ask that expired with the room.
//
// ============================================================ CROSS-MEMBER LEAKS (audited paths)
//   - The pause, the room's state, a pair's state, a decline, a block and its reason are never told to any member.
//     A member-requested intro to someone who declined gets the same neutral answer as any other (conversationTools).
//   - noteRoomMeeting finds only people Co told THIS member about (asked_<side>_at set) and returns nothing about the
//     other side's answer or outcome.
//   - Value lines: the line for one side is stored under that side and drafted only into that side's text.
import { anthropic } from "@ai-sdk/anthropic";
import { checkNoHiddenEcho, sensitiveSafeAllow, unconsentedSensitive } from "../harness/hiddenEcho.js";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { recordDecision, type GateCheck } from "../harness/core.js";
import { effectiveEnd, roomPhase, type RoomPhase } from "../harness/introConsent.js";
import { isOpenAsk } from "../harness/profileWrite.js";
import { proactivePaused } from "./proactivePause.js";
import type { ScorableGuest } from "./eventScoring.js";
import { NO_MEMBER } from "./llmUsage.js";

export { roomPhase, type RoomPhase };

// ============================================================ 2. the pause

export const PAUSE_ALL = "all";

// Why matching is paused for this event right now, or null. Read fresh every time (an emergency stop can't wait for a
// cache). A read that fails counts as paused.
export async function matchingPause(eventId?: string | null): Promise<string | null> {
  if (proactivePaused()) return "PROACTIVE_PAUSED";
  const scopes = eventId ? [PAUSE_ALL, eventId] : [PAUSE_ALL];
  try {
    const { rows } = await pool.query(`SELECT scope, COALESCE(reason, '') AS reason FROM matching_pauses WHERE paused AND scope = ANY($1::text[])`, [scopes]);
    const r = rows[0];
    return r ? `matching paused (${r.scope === PAUSE_ALL ? "all events" : "this event"})${r.reason ? `: ${r.reason}` : ""}` : null;
  } catch (err: any) {
    return `pause check failed: ${err?.message ?? err}`;
  }
}

export async function setMatchingPause(scope: string, paused: boolean, reason: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO matching_pauses (scope, paused, reason, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (scope) DO UPDATE SET paused = EXCLUDED.paused, reason = EXCLUDED.reason, updated_at = NOW()`,
    [scope, paused, reason],
  );
}

// ============================================================ 3. the room

export type RoomTiming = { start_at: string; end_at: string | null; timezone?: string | null };
export type EventInfo = RoomTiming & { api_id: string; name: string; venue?: string | null };

// Minutes after an event's end that the end-of-night job closes its room.
export const ROOM_CLOSE_BUFFER_MINUTES = 15;

export const isTestEvent = (eventId: string) => eventId.startsWith("test-");

// THE place an event's timing is read: Luma for Co's events, co_test_events for fictional test events (co-test only).
export async function eventTiming(eventId: string): Promise<EventInfo | null> {
  if (isTestEvent(eventId)) {
    const { testNumbersEnabled } = await import("./testNumbers.js");
    if (!testNumbersEnabled()) return null;
    const { rows } = await pool.query(`SELECT api_id, name, start_at, end_at, timezone, venue FROM co_test_events WHERE api_id = $1`, [eventId]).catch(() => ({ rows: [] as any[] }));
    const r = rows[0];
    return r ? { api_id: r.api_id, name: r.name, start_at: new Date(r.start_at).toISOString(), end_at: r.end_at ? new Date(r.end_at).toISOString() : null, timezone: r.timezone ?? null, venue: r.venue ?? null } : null;
  }
  const { getEventDetails } = await import("./luma.js");
  const d = await getEventDetails(eventId).catch(() => null);
  return d?.start_at ? { api_id: eventId, name: d.name, start_at: d.start_at, end_at: d.end_at ?? null, timezone: d.timezone ?? null, venue: d.location ?? null } : null;
}

export async function roomClosedAt(eventId: string): Promise<Date | null> {
  const { rows } = await pool.query(`SELECT closed_at FROM event_room_closures WHERE event_id = $1 AND closed_at IS NOT NULL`, [eventId]).catch(() => ({ rows: [] as any[] }));
  return rows[0]?.closed_at ? new Date(rows[0].closed_at) : null;
}

// Whether the event is over for every purpose (its end passed, or the room was closed).
export async function eventOver(eventId: string, now = new Date()): Promise<boolean> {
  if (!eventId) return false;
  const [t, closed] = await Promise.all([eventTiming(eventId), roomClosedAt(eventId)]);
  if (closed && closed <= now) return true;
  return t ? new Date(effectiveEnd(t)).getTime() <= now.getTime() : false;
}

// Pure: who of the roster is in the room right now.
export function inRoomNowPure(
  phase: RoomPhase,
  roster: ScorableGuest[],
  leftIds: Set<string>,
): { open: boolean; people: ScorableGuest[] } {
  const live = phase === "open" || phase === "closing";
  return { open: phase === "open", people: live ? roster.filter((g) => !leftIds.has(g.user_id)) : [] };
}

// THE answer to "who is in the room right now" (every live reader): on the roster (eventScoring.ts inRoomPool: approved
// guests and walk-ins Co saw arrive, no one archived, opted out or not going), the room on (roomPhase, with the
// end-of-night closure), and not someone Co saw leave. `open` is false in the last 30 minutes: people are still there,
// but nothing new starts.
export async function inRoomNow(
  eventId: string,
  opts: { timing?: RoomTiming | null; now?: Date; roster?: ScorableGuest[] } = {},
): Promise<{ phase: RoomPhase | null; open: boolean; people: ScorableGuest[] }> {
  const now = opts.now ?? new Date();
  const timing = opts.timing !== undefined ? opts.timing : await eventTiming(eventId);
  if (!timing) return { phase: null, open: false, people: [] };
  const phase = roomPhase(timing, now, await roomClosedAt(eventId));
  if (phase !== "open" && phase !== "closing") return { phase, open: false, people: [] };
  const roster = opts.roster ?? (await (await import("./eventScoring.js")).inRoomPool(eventId).catch(() => [] as ScorableGuest[]));
  const ids = roster.map((g) => g.user_id);
  const { rows } = ids.length
    ? await pool.query(`SELECT user_id, left_at FROM event_presence WHERE event_api_id = $1 AND user_id = ANY($2::uuid[])`, [eventId, ids]).catch(() => ({ rows: [] as any[] }))
    : { rows: [] as any[] };
  const left = new Set(rows.filter((r: any) => r.left_at).map((r: any) => String(r.user_id)));
  return { phase, ...inRoomNowPure(phase, roster, left) };
}

export async function isInRoomNow(eventId: string, userId: string, opts: { timing?: RoomTiming | null; now?: Date; roster?: ScorableGuest[] } = {}): Promise<boolean> {
  return (await inRoomNow(eventId, opts)).people.some((p) => p.user_id === userId);
}

// ============================================================ 1. shareable asks

// Pure: a member's intent as matching may read it. Open asks they didn't mark shareable are left out (private by
// default); goals and everything else stay.
export function matchableIntent(intent: unknown): unknown {
  if (!Array.isArray(intent)) return intent;
  return intent.filter((e: any) => !isOpenAsk(e) || e?.shareable === true);
}

// ============================================================ 4. the pair record

export type PairState = "suggested" | "asked" | "both_yes" | "intro_sent" | "met" | "declined" | "blocked" | "expired";
export type PairRow = {
  id: number;
  event_id: string;
  a_id: string;
  b_id: string;
  state: PairState;
  origin: "co" | "member";
  asked_a_at: Date | null;
  asked_b_at: Date | null;
  a_answer: "yes" | "no" | null;
  b_answer: "yes" | "no" | null;
  intro_sent_at: Date | null;
  declined_at: Date | null;
  met_at: Date | null;
  value_line_a: string | null;
  value_line_b: string | null;
  value_verdict: "strong" | "weak" | null;
  blocked_reason: string | null;
  expired_at: Date | null;
  intro_held_at?: Date | null;
  intro_attempts?: number | null;
  // Each side's own outcome evidence (the outcome record, below). Never read into the other side's anything.
  a_evidence?: SideEvidence | null;
  b_evidence?: SideEvidence | null;
};

export function orderPair(x: string, y: string): { a: string; b: string; xIsA: boolean } {
  return x < y ? { a: x, b: y, xIsA: true } : { a: y, b: x, xIsA: false };
}

// Pure: why Co may NOT ask x about y at this event now, or null. rows: every co_pairs row for this pair (any event).
export function pairBlockReason(rows: PairRow[], eventId: string, x: string, y: string): string | null {
  const { xIsA } = orderPair(x, y);
  if (rows.some((r) => r.declined_at || r.state === "declined")) return "declined before";
  if (rows.some((r) => r.intro_sent_at)) return "already introduced";
  const here = rows.find((r) => r.event_id === eventId);
  if (!here) return null;
  // Co's taste and the room's clock govern Co's own suggestions; a member who asked for this intro by name isn't held to them.
  const member = here.origin === "member";
  if (!member && (here.state === "blocked" || here.value_verdict === "weak" || here.blocked_reason)) return `value lines blocked${here.blocked_reason ? `: ${here.blocked_reason}` : ""}`;
  if (!member && here.state === "expired") return "asks expired when the room closed";
  // x has answered about y here already (or the pair is past asking): asking again would ask someone who already said.
  const answered = xIsA ? here.a_answer : here.b_answer;
  if (answered) return `already answered (${answered})`;
  if (here.state === "both_yes" || here.state === "intro_sent" || here.state === "met") return `pair is ${here.state}`;
  const asked = xIsA ? here.asked_a_at : here.asked_b_at;
  // A Co ask that expired with the room doesn't swallow a later by-name request: an ask from before the expiry is spent.
  const spent = member && here.expired_at && asked && new Date(asked).getTime() <= new Date(here.expired_at).getTime();
  if (asked && !spent) return "already asked";
  return null;
}

export async function pairRows(x: string, y: string): Promise<PairRow[]> {
  const { a, b } = orderPair(x, y);
  const { rows } = await pool.query(`SELECT * FROM co_pairs WHERE a_id = $1 AND b_id = $2 ORDER BY created_at DESC`, [a, b]).catch(() => ({ rows: [] as any[] }));
  return rows as PairRow[];
}

export async function pairRow(eventId: string, x: string, y: string): Promise<PairRow | null> {
  return (await pairRows(x, y)).find((r) => r.event_id === eventId) ?? null;
}

// May Co ask x about y at this event? Logged when not.
export async function mayAsk(eventId: string, x: string, y: string, action: string): Promise<string | null> {
  // Two people who already know each other are never introduced as strangers (services/knownConnections.ts): checked before the
  // tease, the nudge, the additive offer, the direct ask, and again when a deferred ask goes.
  const known = await (await import("./knownConnections.js")).knownReason(x, y, action);
  if (known) return known;
  const why = pairBlockReason(await pairRows(x, y), eventId, x, y);
  if (why) {
    await recordDecision({ layer: 6, decision: "match.pair", userId: x, outcome: "skip", action, proposal: { eventId, other: y }, checks: [{ name: "pair_may_ask", pass: false, reason: why }] }).catch(() => {});
  }
  return why;
}

// Right before a direct ask to x about y goes out: why it shouldn't any more, or null. Read fresh: the pair record (any
// answer of x's, a pair that moved on) and x's own yes in the opt-in table, which is written a moment before the pair's
// answer (eventGuestMatchHandoff.ts recordOptIn). Concurrency audit finding 8: both said yes at once, and the side whose
// turn saw "not both" still asked the other "X is up for an intro, open to it?".
export async function directAskStale(eventId: string, x: string, y: string): Promise<string | null> {
  // Right before the send: a connection added while it was queued (an intro elsewhere, "we already know each other") stops it.
  const known = await (await import("./knownConnections.js")).knownReason(x, y, "roomMatching.directAskStale");
  if (known) return known;
  const why = pairBlockReason(await pairRows(x, y), eventId, x, y);
  if (why) return why;
  const { rows } = await pool
    .query(`SELECT status FROM event_guest_match_opt_ins WHERE event_id = $1 AND person_id = $2 AND candidate_id = $3`, [eventId, x, y])
    .catch(() => ({ rows: [] as any[] }));
  return rows[0] ? `already answered (${rows[0].status})` : null;
}

export async function notePairSuggested(eventId: string, x: string, y: string, origin: "co" | "member"): Promise<void> {
  const { a, b } = orderPair(x, y);
  await pool
    .query(
      `INSERT INTO co_pairs (event_id, a_id, b_id, origin) VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, a_id, b_id) DO NOTHING`,
      [eventId, a, b, origin],
    )
    .catch((err: any) => console.error("co_pairs: suggest failed (non-fatal):", err?.message ?? err));
}

// A member asked for this intro by name (requestEventIntro): the pair becomes theirs. A decline still stands.
export async function notePairMemberRequested(eventId: string, x: string, y: string): Promise<void> {
  const { a, b } = orderPair(x, y);
  await notePairSuggested(eventId, x, y, "member");
  await pool
    .query(
      `UPDATE co_pairs SET origin = 'member', updated_at = NOW(),
         state = CASE WHEN state IN ('expired', 'blocked') THEN (CASE WHEN asked_a_at IS NOT NULL OR asked_b_at IS NOT NULL THEN 'asked' ELSE 'suggested' END) ELSE state END
       WHERE event_id = $1 AND a_id = $2 AND b_id = $3`,
      [eventId, a, b],
    )
    .catch((err: any) => console.error("co_pairs: member request failed (non-fatal):", err?.message ?? err));
}

// x was asked about y (the ask actually reached x). Set once.
export async function notePairAsked(eventId: string, x: string, y: string, origin: "co" | "member" = "co"): Promise<void> {
  const { a, b, xIsA } = orderPair(x, y);
  const col = xIsA ? "asked_a_at" : "asked_b_at";
  await notePairSuggested(eventId, x, y, origin);
  await pool
    .query(
      `UPDATE co_pairs SET ${col} = CASE WHEN ${col} IS NULL OR (expired_at IS NOT NULL AND ${col} <= expired_at) THEN NOW() ELSE ${col} END,
         state = CASE WHEN state = 'suggested' THEN 'asked' ELSE state END, updated_at = NOW()
       WHERE event_id = $1 AND a_id = $2 AND b_id = $3`,
      [eventId, a, b],
    )
    .catch((err: any) => console.error("co_pairs: asked failed (non-fatal):", err?.message ?? err));
}

// Pure: the state after x answers.
export function stateAfterAnswer(row: Pick<PairRow, "state" | "a_answer" | "b_answer">, xIsA: boolean, answer: "yes" | "no"): PairState {
  if (["declined", "intro_sent", "met"].includes(row.state)) return row.state;
  if (answer === "no") return "declined";
  const other = xIsA ? row.b_answer : row.a_answer;
  return other === "yes" ? "both_yes" : row.state === "suggested" ? "asked" : row.state === "expired" ? "expired" : row.state === "blocked" ? "blocked" : "asked";
}

export async function notePairAnswer(eventId: string, x: string, y: string, answer: "yes" | "no", origin: "co" | "member" = "co"): Promise<PairState | null> {
  const { a, b, xIsA } = orderPair(x, y);
  await notePairSuggested(eventId, x, y, origin);
  const row = await pairRow(eventId, x, y);
  if (!row) return null;
  // One answer per side: a second answer never overwrites the first.
  if ((xIsA ? row.a_answer : row.b_answer) !== null && (xIsA ? row.a_answer : row.b_answer) !== undefined) return row.state;
  const next = stateAfterAnswer(row, xIsA, answer);
  const side = xIsA ? "a" : "b";
  await pool
    .query(
      `UPDATE co_pairs SET ${side}_answer = $4, ${side}_answered_at = NOW(), state = $5,
         declined_at = CASE WHEN $5 = 'declined' THEN COALESCE(declined_at, NOW()) ELSE declined_at END,
         both_yes_at = CASE WHEN $5 = 'both_yes' THEN COALESCE(both_yes_at, NOW()) ELSE both_yes_at END, updated_at = NOW()
       WHERE event_id = $1 AND a_id = $2 AND b_id = $3`,
      [eventId, a, b, answer, next],
    )
    .catch((err: any) => console.error("co_pairs: answer failed (non-fatal):", err?.message ?? err));
  return next;
}

// The one send of a pair's intro email: "claimed" (this call sends it), "taken" (another call already has), or "none" (no
// pair row: the caller goes on as before, guarded by its other checks). The claim (intro_claimed_at) is separate from the
// send (intro_sent_at, written only once the email went), so a server that dies between the two leaves an unconfirmed
// claim, which goes stale after INTRO_CLAIM_STALE_MINUTES and is taken again (retryHeldIntros). A second send of the same
// intro is also refused by the email provider itself (the send carries an idempotency key per pair and event).
export const INTRO_CLAIM_STALE_MINUTES = 15;
export async function claimIntroSend(eventId: string, x: string, y: string): Promise<"claimed" | "taken" | "none"> {
  const { a, b } = orderPair(x, y);
  const won = await pool
    .query(
      `UPDATE co_pairs SET intro_claimed_at = NOW(), updated_at = NOW()
       WHERE event_id = $1 AND a_id = $2 AND b_id = $3 AND intro_sent_at IS NULL
         AND (intro_claimed_at IS NULL OR intro_claimed_at < NOW() - INTERVAL '${INTRO_CLAIM_STALE_MINUTES} minutes')
       RETURNING id`,
      [eventId, a, b],
    )
    .catch(() => null);
  if (!won) return "none";
  if (won.rows.length) return "claimed";
  const { rows } = await pool.query(`SELECT 1 FROM co_pairs WHERE event_id = $1 AND a_id = $2 AND b_id = $3`, [eventId, a, b]).catch(() => ({ rows: [] as any[] }));
  return rows.length ? "taken" : "none";
}

// A claimed send that didn't go: the pair is free for a retry (retryHeldIntros reads intro_sent_at IS NULL).
export async function releaseIntroClaim(eventId: string, x: string, y: string): Promise<void> {
  const { a, b } = orderPair(x, y);
  await pool.query(`UPDATE co_pairs SET intro_claimed_at = NULL, updated_at = NOW() WHERE event_id = $1 AND a_id = $2 AND b_id = $3 AND intro_sent_at IS NULL`, [eventId, a, b]).catch(() => {});
}

export async function notePairIntroSent(eventId: string, x: string, y: string): Promise<void> {
  const { a, b } = orderPair(x, y);
  await pool
    .query(`UPDATE co_pairs SET intro_sent_at = COALESCE(intro_sent_at, NOW()), state = CASE WHEN state = 'met' THEN state ELSE 'intro_sent' END, updated_at = NOW() WHERE event_id = $1 AND a_id = $2 AND b_id = $3`, [eventId, a, b])
    .catch((err: any) => console.error("co_pairs: intro sent failed (non-fatal):", err?.message ?? err));
}

export type MeetingOutcome = "met_good" | "met_fine" | "met_not_a_fit" | "did_not_meet";

// ============================================================ the outcome record (Royce, 2026-11-02: "both accepted" isn't enough)
//
// One record per pair: co_pairs. Both accepted is a_answer/b_answer/both_yes_at, as before. What happened after lives per side in
// a_evidence / b_evidence (JSONB), each field with its value, where it came from, when, and whether the member SAID it or Cue
// inferred it:
//   met           yes | no         stated (their words: text, call, the check-in) or inferred (they said they didn't come to the
//                                  event, so they didn't meet anyone there; a check-in read that named this person warmly)
//   useful        yes | somewhat | no   stated only (noteRoomMeeting on a text, the call's read)
//   kept_talking  yes | not_yet | no    stated only (noteMetAgain on a text, the call's read). Cue never sees their messages to each
//                                  other, so silence is never a "no": a field nobody filled stays unknown.
// Rules: one side's evidence is written only from that side's own words and is never read into the other side's prompt, reply,
// nudge or line; the host sees only room-level counts (partnerReadout.ts). An inference never replaces something they said; their
// newer word replaces their older one. Unknown is a missing field, never a default "no".
// The older columns stay in step for their readers: met_at (either side said they met), <side>_outcome / _note (noteRoomMeeting).
export type EvidenceField = "met" | "useful" | "kept_talking";
export type EvidenceSource = "noshow_ask" | "checkin" | "text" | "call";
export type EvidenceEntry = { value: string; source: EvidenceSource; at: string; how: "stated" | "inferred" };
export type SideEvidence = Partial<Record<EvidenceField, EvidenceEntry>>;
export const EVIDENCE_VALUES: Record<EvidenceField, readonly string[]> = { met: ["yes", "no"], useful: ["yes", "somewhat", "no"], kept_talking: ["yes", "not_yet", "no"] };

// Pure: the side's evidence after one more entry, or null when it doesn't change (an inference never replaces what they said; an
// unknown value is refused).
export function mergeEvidence(had: SideEvidence | null | undefined, field: EvidenceField, entry: EvidenceEntry): SideEvidence | null {
  if (!EVIDENCE_VALUES[field].includes(entry.value)) return null;
  if (field !== "met" && entry.how !== "stated") return null;
  const prev = (had ?? {})[field];
  if (prev && prev.how === "stated" && entry.how === "inferred") return null;
  if (prev && prev.value === entry.value && prev.how === entry.how && prev.source === entry.source) return null;
  return { ...(had ?? {}), [field]: entry };
}

// What noteRoomMeeting's four answers mean in the record.
export function evidenceFromMeeting(outcome: MeetingOutcome): { met: "yes" | "no"; useful: "yes" | "somewhat" | "no" | null } {
  if (outcome === "did_not_meet") return { met: "no", useful: null };
  return { met: "yes", useful: outcome === "met_good" ? "yes" : outcome === "met_fine" ? "somewhat" : "no" };
}

// x's side of one pair: one field. Optimistic write (the evidence read must still be there), retried once. Never throws.
export async function notePairEvidence(x: string, pairId: number, field: EvidenceField, value: string, source: EvidenceSource, how: "stated" | "inferred", at = new Date()): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { rows } = await pool.query(`SELECT a_id, b_id, a_evidence, b_evidence FROM co_pairs WHERE id = $1`, [pairId]).catch(() => ({ rows: [] as any[] }));
    const r = rows[0];
    if (!r || (r.a_id !== x && r.b_id !== x)) return false;
    const side = r.a_id === x ? "a" : "b";
    const had: SideEvidence = r[`${side}_evidence`] ?? {};
    const next = mergeEvidence(had, field, { value, source, at: at.toISOString(), how });
    if (!next) return false;
    const met = field === "met" && value === "yes" && how === "stated";
    const done = await pool
      .query(
        `UPDATE co_pairs SET ${side}_evidence = $2::jsonb, met_at = CASE WHEN $4 THEN COALESCE(met_at, NOW()) ELSE met_at END, updated_at = NOW()
         WHERE id = $1 AND ${side}_evidence IS NOT DISTINCT FROM $3::jsonb RETURNING id`,
        [pairId, JSON.stringify(next), JSON.stringify(had), met],
      )
      .catch((err: any) => (console.error("co_pairs: evidence write failed (non-fatal):", err?.message ?? err), null));
    if (done?.rows.length) return true;
    if (!done) return false;
  }
  return false;
}

// x's side of how meeting y went, on their most recent pair at a Co event Co told x about. Never shown to y.
export async function notePairMet(x: string, pairId: number, outcome: MeetingOutcome, note: string | null, source: EvidenceSource = "text"): Promise<boolean> {
  const { rows } = await pool.query(`SELECT a_id, b_id FROM co_pairs WHERE id = $1`, [pairId]);
  const r = rows[0];
  if (!r || (r.a_id !== x && r.b_id !== x)) return false;
  const side = r.a_id === x ? "a" : "b";
  const met = outcome !== "did_not_meet";
  await pool.query(
    `UPDATE co_pairs SET ${side}_outcome = $2, ${side}_outcome_note = $3, outcome_at = NOW(),
       met_at = CASE WHEN $4 THEN COALESCE(met_at, NOW()) ELSE met_at END,
       state = CASE WHEN $4 AND state NOT IN ('declined') THEN 'met' ELSE state END, updated_at = NOW()
     WHERE id = $1`,
    [pairId, outcome, note, met],
  );
  const e = evidenceFromMeeting(outcome);
  await notePairEvidence(x, pairId, "met", e.met, source, "stated");
  if (e.useful) await notePairEvidence(x, pairId, "useful", e.useful, source, "stated");
  return true;
}

// The newest pair whose intro went to both x and y (any event), for "kept talking": that's said about an intro, not a night.
export async function introducedPairId(x: string, y: string): Promise<number | null> {
  const { a, b } = orderPair(x, y);
  const { rows } = await pool
    .query(`SELECT id FROM co_pairs WHERE a_id = $1 AND b_id = $2 AND intro_sent_at IS NOT NULL ORDER BY intro_sent_at DESC LIMIT 1`, [a, b])
    .catch(() => ({ rows: [] as any[] }));
  return rows[0] ? Number(rows[0].id) : null;
}

// They said they didn't make it to the event (the no-show ask, settled "said no"): every pair Co told them about there is "didn't
// meet", inferred, on THEIR side only. No answer, or an unclear one, changes nothing (unknown stays unknown).
export async function notePairsNoShow(eventId: string, x: string): Promise<number> {
  const told = (await pairsToldAbout(x).catch(() => [])).filter((p) => p.eventId === eventId);
  let n = 0;
  for (const p of told) if (await notePairEvidence(x, p.pairId, "met", "no", "noshow_ask", "inferred")) n++;
  return n;
}

// Pure: the people Co told them about who their check-in answer names, by first name, with no "didn't / never / missed" next to
// the name. A first name two of them share is nobody (Cue can't tell which).
export function namedInCheckin(text: string, told: { pairId: number; otherId: string; firstName: string }[]): { pairId: number; firstName: string }[] {
  const out: { pairId: number; firstName: string }[] = [];
  const t = String(text ?? "");
  for (const p of told) {
    const name = p.firstName.trim();
    if (name.length < 2) continue;
    if (new Set(told.filter((q) => q.firstName.trim().toLowerCase() === name.toLowerCase()).map((q) => q.otherId)).size > 1) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const sentence = t.split(/(?<=[.!?\n])\s*/).find((s) => re.test(s));
    if (!sentence) continue;
    if (/\b(?:didn'?t|did not|never|not|couldn'?t|could not|missed|no sign|wasn'?t|was not|haven'?t|have not)\b/i.test(sentence)) continue;
    if (!out.some((o) => o.pairId === p.pairId)) out.push({ pairId: p.pairId, firstName: p.firstName });
  }
  return out;
}

// The night-after check-in, answered (sendblue.ts): the read said they named someone worthwhile, and they named someone Co told
// them about at this event. Met is recorded as inferred (the read and the name, not a sentence that says "we met"); Cue's own
// noteRoomMeeting in the same reply records what they said, which replaces it. Returns who was named, for Cue's instruction.
export async function notePairsFromCheckin(x: string, eventId: string, text: string, positive: boolean): Promise<{ pairId: number; firstName: string }[]> {
  const told = (await pairsToldAbout(x).catch(() => [])).filter((p) => p.eventId === eventId);
  const named = namedInCheckin(text, told);
  if (positive) for (const n of named) await notePairEvidence(x, n.pairId, "met", "yes", "checkin", "inferred");
  return named;
}

// ============================================================ outcomes feed pair selection (their own side only)
//
// What worked for THIS member, by the ask the pairing served, never by who it was (review of #358: matching on any two shared words
// let "founder", "building" or "raising" tie one bad outcome to nearly every candidate). The kind of a pairing is the one of THEIR OWN
// asks (the room frame's asks) its reason rests on: their own value line for a past pair, the scorer's reason and the candidate's share
// reason for a new one, each needing two distinctive words of that ask (generic words never count) and one clear winner, else no kind
// and no move. Inside one kind: "not useful" or "never met" (they said so) moves a new candidate down, "useful" a little up; one signal
// alone counts half, and each fades with age (half-life OUTCOME_ADJUST.halfLifeDays). Never past the bar: a candidate below
// MATCH_NUDGE_MIN_SCORE stays below it, whatever worked before (no forced match, a stated constraint is never relaxed). Their own
// no-show says nothing about a kind of pairing and is left out.
export type OutcomeSignal = { line: string; kind: "useful" | "not_useful" | "not_met"; at?: string | null };
export const OUTCOME_ADJUST = { notUseful: -12, notMet: -5, useful: 6, maxDown: -24, maxUp: 10, single: 0.5, halfLifeDays: 90 };

// Words that say nothing about which ask a pairing served: they'd tie one outcome to most of the room.
const GENERIC = new Set(["founder", "founders", "founding", "building", "build", "builder", "raising", "raise", "startup", "startups", "company", "companies", "business", "work", "working", "people", "person", "help", "helping", "great", "good", "meet", "meeting", "talk", "connect", "connection", "network", "networking", "intro", "introduction", "someone", "anyone", "new", "early", "stage", "space", "industry", "tech", "team", "things", "really", "also", "just", "would", "could", "might", "worth", "value", "useful"]);
// Compared after stemming, so the list is stemmed too ("raising" -> "rais", "companies" -> "compan"; review of #358).
let genericStems: Set<string> | null = null;
const distinct = (s: string) => {
  genericStems ??= new Set([...GENERIC].map(stem));
  return new Set(contentWords(s).map(stem).filter((w) => !genericStems!.has(w) && w.length > 2));
};

// Pure: which of their own asks this text rests on (index), or null when none clearly does: at least two distinctive words of the ask,
// and strictly more than any other ask.
export function themeOf(text: string, asks: string[]): number | null {
  const have = distinct(text);
  let best = -1;
  let bestHits = 0;
  let tie = false;
  asks.forEach((a, i) => {
    const words = [...distinct(a)];
    const hits = words.filter((w) => have.has(w)).length;
    if (hits < Math.min(2, words.length) || hits === 0) return;
    if (hits > bestHits) {
      best = i;
      bestHits = hits;
      tie = false;
    } else if (hits === bestHits) tie = true;
  });
  return best >= 0 && !tie ? best : null;
}

// Pure: one candidate's score after their own outcomes. candidateText: what the new pairing rests on (the scorer's reason and the
// candidate's share reason). asks: their own asks (the frame). bar: the score a match must reach; nothing below it is lifted to it.
export function outcomeAdjustedScore(score: number, candidateText: string, signals: OutcomeSignal[], bar: number, asks: string[] = [], now = new Date()): { score: number; moved: number } {
  if (!candidateText || !signals.length || score <= 0 || !asks.length) return { score, moved: 0 };
  const theme = themeOf(candidateText, asks);
  if (theme == null) return { score, moved: 0 };
  const same = signals.filter((s) => s.line && themeOf(s.line, asks) === theme);
  if (!same.length) return { score, moved: 0 };
  let moved = 0;
  for (const s of same) {
    const base = s.kind === "not_useful" ? OUTCOME_ADJUST.notUseful : s.kind === "not_met" ? OUTCOME_ADJUST.notMet : OUTCOME_ADJUST.useful;
    const ageDays = s.at ? Math.max(0, (now.getTime() - new Date(s.at).getTime()) / 86_400_000) : 0;
    moved += base * Math.pow(0.5, (Number.isFinite(ageDays) ? ageDays : 0) / OUTCOME_ADJUST.halfLifeDays);
  }
  if (same.length === 1) moved *= OUTCOME_ADJUST.single;
  moved = Math.round(Math.max(OUTCOME_ADJUST.maxDown, Math.min(OUTCOME_ADJUST.maxUp, moved)));
  if (moved > 0 && score < bar) moved = 0;
  const next = Math.max(0, Math.min(100, score + moved));
  return { score: next, moved: next - score };
}

// Pure: the signal in one side's evidence, and when it was said. Only stated evidence counts.
export function signalOf(e: SideEvidence | null | undefined): OutcomeSignal["kind"] | null {
  if (!e) return null;
  if (e.useful?.how === "stated") return e.useful.value === "no" ? "not_useful" : e.useful.value === "yes" ? "useful" : null;
  if (e.met?.how === "stated" && e.met.value === "no") return "not_met";
  return null;
}

// Their own outcome signals: their side's evidence and their own value line, newest first. Never the other side's.
export async function ownOutcomeSignals(x: string): Promise<OutcomeSignal[]> {
  const { rows } = await pool
    .query(
      `SELECT CASE WHEN a_id = $1 THEN a_evidence ELSE b_evidence END AS ev, CASE WHEN a_id = $1 THEN value_line_a ELSE value_line_b END AS line
       FROM co_pairs WHERE (a_id = $1 OR b_id = $1) AND intro_sent_at IS NOT NULL ORDER BY updated_at DESC LIMIT 20`,
      [x],
    )
    .catch(() => ({ rows: [] as any[] }));
  const out: OutcomeSignal[] = [];
  for (const r of rows) {
    const kind = signalOf(r.ev);
    const line = usableLine(r.line);
    const at = kind === "not_met" ? r.ev?.met?.at : r.ev?.useful?.at;
    if (kind && line) out.push({ line, kind, at: at ?? null });
  }
  return out;
}

// ============================================================ measurement (pure): one pair, both sides
export type PairOutcome = { met: "yes" | "no" | "unknown"; usefulA: string; usefulB: string; keptTalking: "yes" | "no" | "unknown" };
export function pairOutcome(a: SideEvidence | null | undefined, b: SideEvidence | null | undefined): PairOutcome {
  const sides = [a ?? {}, b ?? {}];
  const met = sides.some((s) => s.met?.value === "yes") ? "yes" : sides.some((s) => s.met?.value === "no") ? "no" : "unknown";
  const kept = sides.some((s) => s.kept_talking?.value === "yes") ? "yes" : sides.some((s) => s.kept_talking && s.kept_talking.value !== "yes") ? "no" : "unknown";
  return { met, usefulA: sides[0].useful?.value ?? "unknown", usefulB: sides[1].useful?.value ?? "unknown", keptTalking: kept };
}

// The people Co told this member about at Co events (their side was asked, or they were introduced), newest first.
export async function pairsToldAbout(x: string): Promise<{ pairId: number; otherId: string; firstName: string; eventId: string }[]> {
  const { rows } = await pool.query(
    `SELECT p.id, p.event_id, CASE WHEN p.a_id = $1 THEN p.b_id ELSE p.a_id END AS other_id, u.first_name
     FROM co_pairs p JOIN users u ON u.id = CASE WHEN p.a_id = $1 THEN p.b_id ELSE p.a_id END
     WHERE (p.a_id = $1 AND (p.asked_a_at IS NOT NULL OR p.intro_sent_at IS NOT NULL))
        OR (p.b_id = $1 AND (p.asked_b_at IS NOT NULL OR p.intro_sent_at IS NOT NULL))
     ORDER BY p.updated_at DESC LIMIT 50`,
    [x],
  );
  return rows.map((r: any) => ({ pairId: Number(r.id), otherId: String(r.other_id), firstName: String(r.first_name ?? ""), eventId: String(r.event_id) }));
}

// ============================================================ the value-line gate

export type ValueSide = {
  userId: string;
  firstName: string;
  // Their own open asks they marked shareable (a private ask is in no prompt and no line). Only they read their line.
  ownAsks: { text: string; type: string; shareable: boolean }[];
  goals: string[];
  // How earlier in-room intros Co made for them went, their side only, names removed. Theirs: never in the other's prompt.
  pastOutcomes: string[];
  // What another member may be told: their shareable asks.
  shared: string[];
  // Their open asks they did NOT mark shareable: in no line at all, theirs or the other's.
  privateAsks: string[];
  // Everything else about them (outcome notes included), never to appear in the other side's line.
  privateTexts: string[];
  // Their hidden part: private asks and blockers (Royce, 2026-10-18). No line the other member reads may echo it, word for word
  // or near it (harness/hiddenEcho.ts). Optional for callers that build a side by hand; read as none.
  hiddenTexts?: string[];
};

// What the reader's call may know about the other member: their first name and what they marked shareable. Nothing else
// of theirs ever enters the reader's prompt (2026-10-12 review: one prompt holding both members' private context let a
// paraphrase of one leak into the other's line, and no word-match check catches a paraphrase).
export type OtherSide = { firstName: string; shared: string[]; kinds?: string[] };

// One call per side: the reader's own context, and only the other's shareable asks.
export function sideLinePrompt(eventName: string, reader: ValueSide, other: OtherSide): string {
  const mine = [
    ...reader.ownAsks.map((a) => `- ${a.type === "offering" ? "can offer" : "looking for"}: "${a.text}"`),
    ...reader.goals.map((g) => `- goal: "${g}"`),
    ...reader.pastOutcomes.map((o) => `- an earlier intro Cue made for them: ${o}`),
  ];
  return `Cue is a friend to every member of a private club, and only introduces two people when a friend who knows both of them would make the introduction. At "${eventName}", Cue is considering pointing ${reader.firstName} toward ${other.firstName}.

What ${reader.firstName} has told Cue (only ${reader.firstName} will read this line):
${mine.length ? mine.join("\n") : "- (nothing on file)"}

All Cue may say about ${other.firstName}, what ${other.firstName} said Cue may tell people they meet: ${other.shared.map((t, i) => `${other.kinds?.[i] === "offering" ? "can offer" : "looking for"} "${t}"`).join("; ")}

Write one sentence to ${reader.firstName}: the concrete reason meeting ${other.firstName} is worth it for ${reader.firstName}, resting on what ${other.firstName} shared, in close to their own words. Say nothing else about ${other.firstName}. Speak as Cue straight to them ("you", and "I" for Cue, never "Cue thinks"): plain, warm, composed, the way a friend who knows both would put it. No em dashes, no exclamation points, no titles or labels for anyone.
Then judge it honestly: would a friend who knows ${reader.firstName} make this introduction for ${reader.firstName}'s sake? A friend makes it when what ${other.firstName} shared plainly meets something ${reader.firstName} needs or offers, even if it doesn't spell out every detail ${reader.firstName} cares about (a style, a place, a timeline, a title): what ${other.firstName} shared is a few words on purpose, and the two of them can sort out the details once they meet. "strong" for a specific reason ${reader.firstName} gets value, a direct need-and-offer fit included. "weak" when the reason is generic (similar interests, both like food, both in tech, good to know, would get along), when nothing ${other.firstName} shared bears on what ${reader.firstName} wants or offers, or when ${other.firstName}'s words openly rule it out. Sharing a general interest (both into food, tech, running, meeting people) is generic, never a need-and-offer fit, unless ${other.firstName} can give ${reader.firstName} something specific. A missing detail is not a mismatch.
Return ONLY JSON: {"line": "...", "verdict": "strong" or "weak", "why": "a few words"}`;
}

export type SideJudgment = { line: string; verdict: "strong" | "weak"; why: string };
export function parseSideJudgment(raw: string): SideJudgment | null {
  try {
    const j = parseModelJson<any>(raw);
    const verdict = j?.verdict === "strong" ? "strong" : j?.verdict === "weak" ? "weak" : null;
    if (!verdict) return null;
    return { line: String(j.line ?? "").trim(), verdict, why: String(j.why ?? "").trim() };
  } catch {
    return null;
  }
}

// Both sides together. A side whose other member shared nothing isn't judged (null): its line is withheld.
export type ValueJudgment = { forFirst: string; forSecond: string; verdict: "strong" | "weak"; why: string; judged: { first: boolean; second: boolean } };

// Pure: the two side reads combined. Every judged side must be strong; at least one side must be judged.
export function combineSides(first: SideJudgment | null, second: SideJudgment | null): ValueJudgment | null {
  if (!first && !second) return null;
  const sides = [first, second].filter(Boolean) as SideJudgment[];
  return {
    forFirst: first?.line ?? "",
    forSecond: second?.line ?? "",
    verdict: sides.every((x) => x.verdict === "strong") ? "strong" : "weak",
    why: sides.map((x) => x.why).filter(Boolean).join("; "),
    judged: { first: !!first, second: !!second },
  };
}

const STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "who", "that", "is", "are", "their", "they", "them", "at", "as", "by", "be", "it", "this", "you", "your", "someone", "people", "looking", "want", "wants", "can", "offer", "find", "meet", "more", "some", "who's", "what"]);
const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const contentWords = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
// A phrase taken out leaves this marker, so words on either side of it never join into one shingle.
const SEP = "zzsep";
const stem = (w: string) => w.replace(/(ies|es|s|ing|ed)$/, "");
function shingles(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

// Pure: does the line rest on what the other member shared (at least two of one shared ask's words, or all of a
// shorter one)?
export function groundedIn(line: string, shared: string[]): boolean {
  const have = new Set(contentWords(line).map(stem));
  return shared.some((s) => {
    const words = [...new Set(contentWords(s).map(stem))];
    const hits = words.filter((w) => have.has(w)).length;
    return words.length > 0 && hits >= Math.min(2, words.length);
  });
}

// Pure: does the text quote something private of the other member (three words in a row from a private text that
// aren't also in what they shared)?
// allow: words any text may carry whoever said them (the event's name, the venue, the two first names): they're taken
// out of both sides before comparing, so a member who once texted "Founders Friday Supper" doesn't silence every nudge
// that names the event (2026-10-12 review).
export function checkNoPrivateQuote(text: string, privateTexts: string[], shared: string[], name = "no_private_quote", allow: string[] = []): GateCheck {
  const phrases = allow.map(norm).filter((a) => a.length > 1).sort((p, q) => q.length - p.length);
  const strip = (t: string) => {
    let n = ` ${norm(t)} `;
    for (const a of phrases) n = n.split(` ${a} `).join(` ${SEP} `);
    return n;
  };
  const allowed = shingles(contentWords(shared.join(" . ")), 3);
  const mine = shingles(contentWords(strip(text)), 3);
  for (const p of privateTexts) {
    for (const s of shingles(contentWords(strip(p)), 3)) {
      if (s.includes(SEP)) continue;
      if (mine.has(s) && !allowed.has(s)) return { name, pass: false, reason: `carries the other member's private words ("${s}")` };
    }
  }
  return { name, pass: true };
}

// Pure: the facts the lines must hold to. The verdict is Co's; these are code's. allow: see checkNoPrivateQuote.
export function checkValueLines(j: ValueJudgment | null, x: ValueSide, y: ValueSide, sensitive: RegExp[] = [], allow: string[] = []): { ok: boolean; checks: GateCheck[] } {
  if (!j) return { ok: false, checks: [{ name: "value_judgment", pass: false, reason: "neither member shared anything Cue may say" }] };
  const checks: GateCheck[] = [];
  checks.push(j.verdict === "strong" ? { name: "friend_would_intro", pass: true } : { name: "friend_would_intro", pass: false, reason: `weak: ${j.why || "no reason given"}` });
  for (const [line, reader, other, label, judged] of [
    [j.forFirst, x, y, "first", j.judged.first],
    [j.forSecond, y, x, "second", j.judged.second],
  ] as const) {
    // The other member shared nothing: no call was made for this side, and its reader is told no reason (as before).
    if (!judged) {
      checks.push({ name: `line_${label}`, pass: true, reason: `${other.firstName} shared nothing: no line for ${reader.firstName}` });
      continue;
    }
    if (!line || line.length < 20) {
      checks.push({ name: `line_${label}`, pass: false, reason: `no real line for ${reader.firstName}` });
      continue;
    }
    if (line.length > 300) checks.push({ name: `line_${label}`, pass: false, reason: `line for ${reader.firstName} is too long` });
    checks.push(groundedIn(line, other.shared) ? { name: `grounded_${label}`, pass: true } : { name: `grounded_${label}`, pass: false, reason: `line for ${reader.firstName} doesn't rest on what ${other.firstName} shared` });
    // Backstops: the other member's data never enters this side's prompt; these catch it anyway if it did.
    checks.push(checkNoPrivateQuote(line, other.privateTexts, other.shared, `private_${label}`, allow));
    // What the other member keeps private or is going through: never echoed, even in other words that share its distinctive ones.
    // A sensitive word gets through only from the other member's own shareable asks, never the reader's words (decided 2026-10-19).
    checks.push(checkNoHiddenEcho(line, other.hiddenTexts ?? [], [...reader.ownAsks.map((a) => a.text), ...reader.goals], allow, `hidden_${label}`, sensitive, other.shared));
    checks.push(checkNoPrivateQuote(line, reader.privateAsks, reader.shared, `own_private_ask_${label}`, allow));
    // A sensitive word the other member's private material carries: only their own shareable ask, quoted word for word, lets it
    // through; the reader's own asks and goals never do (decided 2026-10-19: words in another person's text never whitelist).
    const hit = unconsentedSensitive(line, other.privateTexts, other.shared, sensitive, false, sensitiveSafeAllow(allow, sensitive));
    if (hit) checks.push({ name: `sensitive_${label}`, pass: false, reason: `leans on "${hit}", which is ${other.firstName}'s private matter` });
  }
  return { ok: checks.every((c) => c.pass), checks };
}

const VALUE_MODEL = MODELS.sonnet;

const CO_WRITTEN_MEMORY_TYPES = ["system", "event_guest_match_nudge", "event_guest_match_optin", "event_intro_email_sent", "event_discovery_surfacing", "event_pre_arrival", "event_follow_through", "event_change_notification", "event_brief_ask", "event_brief", "event_ask_solicitation", "promise_result", "mo_member_offer"];

export async function gatherValueSide(userId: string): Promise<ValueSide> {
  const [u, p, m, facts, past] = await Promise.all([
    pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId]),
    pool.query(`SELECT goals, blockers, activity_preferences, long_term_direction, intent FROM co_profiles WHERE user_id = $1`, [userId]),
    // What they told Co. Co's own words (its texts, its event notes) are left out: they aren't the member's private
    // matter, and Co's stock phrasing in them would read as a quote of every later draft.
    pool
      .query(
        `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type <> 'intent' AND memory_type <> ALL($2::text[])
           AND NOT (memory_type = 'text_exchange' AND content LIKE 'Co %')
         ORDER BY created_at DESC LIMIT 300`,
        [userId, CO_WRITTEN_MEMORY_TYPES],
      )
      .catch(() => ({ rows: [] as any[] })),
    import("./coFacts.js").then((c) => c.ownerOnlyFacts(userId)).catch(() => [] as string[]),
    pool
      .query(
        `SELECT CASE WHEN p.a_id = $1 THEN p.a_outcome ELSE p.b_outcome END AS outcome, CASE WHEN p.a_id = $1 THEN p.a_outcome_note ELSE p.b_outcome_note END AS note, u.first_name
         FROM co_pairs p JOIN users u ON u.id = CASE WHEN p.a_id = $1 THEN p.b_id ELSE p.a_id END
         WHERE (p.a_id = $1 AND p.a_outcome IS NOT NULL) OR (p.b_id = $1 AND p.b_outcome IS NOT NULL) ORDER BY p.outcome_at DESC LIMIT 5`,
        [userId],
      )
      .catch(() => ({ rows: [] as any[] })),
  ]);
  const prof = p.rows[0] ?? {};
  const intent = Array.isArray(prof.intent) ? prof.intent : [];
  const open = intent.filter((i: any) => isOpenAsk(i));
  // Only shareable asks go into the prompt, even for the member's own line: intro text uses no private ask (hole 1).
  const privateAsks = open.filter((i: any) => i.shareable !== true).map((i: any) => String(i.text));
  const ownAsks = open.filter((i: any) => i.shareable === true).map((i: any) => ({ text: String(i.text), type: String(i.type ?? "seeking"), shareable: true }));
  const goals = intent.filter((i: any) => i?.kind === "goal" && i?.status === "active" && i?.text).map((i: any) => String(i.text));
  const { goalTexts } = await import("./goalJourney.js");
  const allGoals = [...new Set([...goals, ...goalTexts(intent, prof.goals ?? [])])].slice(0, 6);
  const scrub = (s: string, name: string) => (name ? s.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "them") : s);
  return {
    userId,
    firstName: String(u.rows[0]?.first_name ?? "").trim() || "them",
    ownAsks,
    goals: allGoals,
    pastOutcomes: past.rows.map((r: any) => `${String(r.outcome).replace(/_/g, " ")}${r.note ? `, in their words: "${scrub(String(r.note), String(r.first_name ?? "")).slice(0, 160)}"` : ""}`),
    shared: ownAsks.filter((a: { shareable: boolean }) => a.shareable).map((a: { text: string }) => a.text),
    privateAsks,
    hiddenTexts: [...privateAsks, ...(Array.isArray(prof.blockers) ? prof.blockers.map(String) : [])],
    privateTexts: [
      ...privateAsks,
      ...(prof.goals ?? []),
      ...(prof.blockers ?? []),
      ...(prof.activity_preferences ?? []),
      ...(prof.long_term_direction ? [prof.long_term_direction] : []),
      ...allGoals,
      // Co's own texts to them ("Co replied: ...") are never their private words, whatever the read returned.
      ...m.rows.map((r: any) => String(r.content)).filter((c: string) => !c.startsWith("Co replied:")),
      ...facts,
      // How their earlier intros went, in their words: theirs alone.
      ...past.rows.map((r: any) => String(r.note ?? "")).filter(Boolean),
    ].map(String),
  };
}

export type ValueGateResult = { ok: true; lineFor: (userId: string) => string; cached: boolean } | { ok: false; reason: string; transient?: boolean };

// A line resting only on its reader's own asks (the other member shared nothing) is stored marked, never shown.
export const WITHHELD = "[withheld] ";
export const usableLine = (l: string | null | undefined) => (l && !l.startsWith(WITHHELD) ? l : "");

// Before a Co-initiated intro ask between x and y at this event: Co writes a line per side, each in its own call that
// sees the reader's context and only the other member's shareable asks, and judges it; code checks the facts. A clear
// outcome is stored on the pair (once per pair per event) and logged. A failed read is logged, not stored: the next
// pass tries again. A block never rewrites a pair that's already moving (only 'suggested' becomes 'blocked').
export async function valueGate(eventId: string, eventName: string, x: string, y: string, action: string, opts: { allow?: string[] } = {}): Promise<ValueGateResult> {
  const { a, b } = orderPair(x, y);
  await notePairSuggested(eventId, x, y, "co");
  const existing = await pairRow(eventId, x, y);
  const lineOf = (row: { value_line_a: string | null; value_line_b: string | null }) => (id: string) => usableLine(id === a ? row.value_line_a : row.value_line_b);
  if (existing && (existing.state === "blocked" || existing.value_verdict === "weak" || existing.blocked_reason)) return { ok: false, reason: existing.blocked_reason ?? "blocked" };
  if (existing?.value_verdict === "strong") return { ok: true, lineFor: lineOf(existing), cached: true };

  const [sa, sb] = await Promise.all([gatherValueSide(a), gatherValueSide(b)]);
  const allow = [eventName, sa.firstName, sb.firstName, ...(opts.allow ?? [])];
  const tidy = (l: string) => l.replace(/\s*[\u2014\u2013]\s*|\s+-\s+/g, ", ").replace(/!/g, ".").trim();
  const read = async (reader: ValueSide, other: ValueSide): Promise<SideJudgment | null | "failed"> => {
    if (!other.shared.length) return null;
    try {
      const r = await generateText({
        model: anthropic(VALUE_MODEL),
        // Not about one member: a pair's value line, read from both sides.
        experimental_telemetry: { isEnabled: true, functionId: "roomMatching.valueLine", metadata: NO_MEMBER },
        prompt: sideLinePrompt(eventName, reader, { firstName: other.firstName, shared: other.shared, kinds: other.ownAsks.map((x) => x.type) }),
      });
      const j = parseSideJudgment(r.text);
      return j ? { ...j, line: tidy(j.line) } : "failed";
    } catch {
      return "failed";
    }
  };
  const [ra, rb] = await Promise.all([read(sa, sb), read(sb, sa)]);
  if (ra === "failed" || rb === "failed") {
    await recordDecision({ layer: 6, decision: "match.valueLines", userId: x, outcome: "skip", action, proposal: { eventId, a, b }, reason: "the value read failed; the next pass tries again" }).catch(() => {});
    return { ok: false, reason: "value read failed", transient: true };
  }
  const judgment = combineSides(ra, rb);
  const { SENSITIVE } = await import("../harness/matchGate.js");
  const result = checkValueLines(judgment, sa, sb, SENSITIVE, allow);
  if (result.ok && judgment) {
    const { privateFactLeak } = await import("./coFacts.js");
    const [la, lb] = await Promise.all([judgment.judged.first ? privateFactLeak(judgment.forFirst, b).catch(() => null) : null, judgment.judged.second ? privateFactLeak(judgment.forSecond, a).catch(() => null) : null]);
    for (const [hit, label] of [
      [la, "first"],
      [lb, "second"],
    ] as const) {
      result.checks.push(hit ? { name: `fact_leak_${label}`, pass: false, reason: `carries a private fact ("${hit.slice(0, 60)}")` } : { name: `fact_leak_${label}`, pass: true });
    }
    result.ok = result.checks.every((c) => c.pass);
  }
  const failed = result.checks.filter((c) => !c.pass).map((c) => c.reason).join("; ");
  const lineA = judgment ? (judgment.judged.first ? judgment.forFirst : WITHHELD) : null;
  const lineB = judgment ? (judgment.judged.second ? judgment.forSecond : WITHHELD) : null;
  await pool
    .query(
      `UPDATE co_pairs SET value_line_a = $4, value_line_b = $5, value_verdict = $6, value_why = $7, value_judged_at = NOW(),
         state = CASE WHEN $8 THEN state WHEN state = 'suggested' THEN 'blocked' ELSE state END, blocked_reason = CASE WHEN $8 THEN NULL ELSE $9 END, updated_at = NOW()
       WHERE event_id = $1 AND a_id = $2 AND b_id = $3`,
      [eventId, a, b, lineA, lineB, judgment?.verdict ?? "weak", judgment?.why ?? null, result.ok, failed || null],
    )
    .catch((err: any) => console.error("co_pairs: storing value lines failed (non-fatal):", err?.message ?? err));
  await recordDecision({
    layer: 6,
    decision: "match.valueLines",
    userId: x,
    outcome: result.ok ? "act" : "skip",
    action,
    proposal: { eventId, a, b, lineForA: lineA, lineForB: lineB, verdict: judgment?.verdict ?? null, why: judgment?.why ?? null },
    checks: result.checks,
    reason: result.ok ? null : `no intro: ${failed}`,
  }).catch(() => {});
  if (!result.ok || !judgment) return { ok: false, reason: failed || "no judgment" };
  return { ok: true, lineFor: lineOf({ value_line_a: lineA, value_line_b: lineB }), cached: false };
}

// ============================================================ 5. the end of the night

export async function scheduleRoomClose(eventId: string, eventName: string, timing: RoomTiming | null): Promise<void> {
  if (!timing) return;
  const ends = new Date(effectiveEnd(timing));
  const due = new Date(ends.getTime() + ROOM_CLOSE_BUFFER_MINUTES * 60_000);
  await pool
    .query(
      `INSERT INTO event_room_closures (event_id, event_name, ends_at, due_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO UPDATE SET event_name = EXCLUDED.event_name, ends_at = EXCLUDED.ends_at, due_at = EXCLUDED.due_at
         WHERE event_room_closures.closed_at IS NULL`,
      [eventId, eventName, ends, due],
    )
    .catch((err: any) => console.error("event_room_closures: schedule failed (non-fatal):", err?.message ?? err));
}

// Every Co event (and test event on co-test) that started within the last two days or starts within the next two gets
// its closure row, whether or not a scoring pass ever ran for it.
export async function scheduleRoomCloses(now = new Date()): Promise<number> {
  const { presenceEvents } = await import("./eventPresence.js");
  const events = await presenceEvents().catch(() => []);
  let n = 0;
  for (const e of events) {
    const start = new Date(e.start_at).getTime();
    if (Math.abs(start - now.getTime()) > 2 * 86_400_000) continue;
    await scheduleRoomClose(e.api_id, e.name, { start_at: e.start_at, end_at: e.end_at ?? null, timezone: e.timezone ?? null });
    n++;
  }
  return n;
}

export type CloseResult = { eventId: string; expiredOffers: number; droppedAsks: number; expiredPairs: number; checkins: number };

// The durable end-of-night job: claims each due room once (a claim older than 10 minutes is taken again after a crash).
export async function runRoomCloses(now = new Date()): Promise<CloseResult[]> {
  const out: CloseResult[] = [];
  const { rows } = await pool.query(
    `UPDATE event_room_closures SET claimed_at = $1
     WHERE event_id IN (SELECT event_id FROM event_room_closures WHERE closed_at IS NULL AND due_at <= $1 AND (claimed_at IS NULL OR claimed_at < $1 - INTERVAL '10 minutes') LIMIT 10)
     RETURNING event_id, event_name, ends_at`,
    [now],
  );
  for (const r of rows) {
    const eventId = String(r.event_id);
    // Who was in the room at its end, for the follow-up (read before the room is marked closed).
    const roster = await (await import("./eventScoring.js")).inRoomPool(eventId).catch(() => [] as ScorableGuest[]);
    // An ask that never went out (queued, or stuck mid-send) loses its opened_at as it expires: the member-names read counts an expired
    // ask with an opened_at as one that reached them, so a stuck send must not put the candidate's name on their list (review of #295).
    const offers = await pool.query(`UPDATE event_match_offers SET status = 'expired', answered_at = NULL, opened_at = CASE WHEN status IN ('queued', 'sending') THEN NULL ELSE opened_at END WHERE event_id = $1 AND status IN ('open', 'queued', 'sending') RETURNING person_id`, [eventId]);
    // Asks held for someone's morning: brought due now, so the deferred runner drops them as "event over" and tells the
    // asker only that it didn't go out.
    const held = await pool.query(
      `UPDATE deferred_sends SET due_at = $2 WHERE status = 'queued' AND after_kind = 'event_direct_ask' AND after_payload->>'eventId' = $1 RETURNING id`,
      [eventId, now],
    );
    const pairs = await pool.query(`UPDATE co_pairs SET state = 'expired', expired_at = $2, updated_at = NOW() WHERE event_id = $1 AND state IN ('suggested', 'asked') RETURNING id`, [eventId, now]);
    // The follow-up path: each member who was there gets their "how was tonight" check-in (eventCheckinFollowUp.ts), a few
    // hours after the end. Idempotent: a row the scoring pass already scheduled stays as it was.
    let checkins = 0;
    const sendAt = new Date(new Date(r.ends_at).getTime() + 3 * 3_600_000);
    for (const g of roster) {
      const ins = await pool
        .query(`INSERT INTO event_checkin_followups (user_id, event_api_id, event_name, send_at) VALUES ($1, $2, $3, $4) ON CONFLICT (event_api_id, user_id) DO NOTHING RETURNING id`, [g.user_id, eventId, r.event_name ?? "the event", sendAt])
        .catch(() => ({ rows: [] as any[] }));
      checkins += ins.rows.length;
    }
    await pool.query(`UPDATE event_room_closures SET closed_at = $2, expired_offers = $3, expired_pairs = $4 WHERE event_id = $1`, [eventId, now, offers.rows.length, pairs.rows.length]);
    const res = { eventId, expiredOffers: offers.rows.length, droppedAsks: held.rows.length, expiredPairs: pairs.rows.length, checkins };
    await recordDecision({ layer: 6, decision: "event.roomClosed", userId: null, outcome: "act", action: "close", proposal: res }).catch(() => {});
    out.push(res);
  }
  return out;
}

// The email for a pair whose both yeses are in but the email didn't go: held by the pause (intro_held_at), or failed
// to send (intro_attempts). Pure: whether it's worth trying again now.
export const INTRO_MAX_ATTEMPTS = 3;
export const INTRO_RETRY_MAX_AGE_MS = 3 * 86_400_000;
export function introRetryDue(p: { both_yes_at: Date | null; intro_held_at: Date | null; intro_attempts: number | null; intro_claimed_at?: Date | null }, now: Date): boolean {
  if (!p.both_yes_at || now.getTime() - new Date(p.both_yes_at).getTime() > INTRO_RETRY_MAX_AGE_MS) return false;
  const attempts = p.intro_attempts ?? 0;
  // A claim no send ever confirmed (the server died in between), once it's stale.
  const staleClaim = Boolean(p.intro_claimed_at) && now.getTime() - new Date(p.intro_claimed_at!).getTime() >= INTRO_CLAIM_STALE_MINUTES * 60_000;
  return attempts < INTRO_MAX_ATTEMPTS && (Boolean(p.intro_held_at) || attempts > 0 || staleClaim);
}

// Held by the pause: marked once (and logged once), so the cron doesn't log it every five minutes.
export async function noteIntroHeld(eventId: string, x: string, y: string, why: string): Promise<void> {
  const { a, b } = orderPair(x, y);
  const { rows } = await pool
    .query(`UPDATE co_pairs SET intro_held_at = NOW(), updated_at = NOW() WHERE event_id = $1 AND a_id = $2 AND b_id = $3 AND intro_held_at IS NULL RETURNING id`, [eventId, a, b])
    .catch(() => ({ rows: [] as any[] }));
  if (rows.length) await recordDecision({ layer: 6, decision: "match.pause", userId: a, outcome: "skip", action: "introEmail.held", proposal: { eventId, a, b }, reason: why }).catch(() => {});
}

// A send that failed (Resend, a missing email): counted, so it's tried a few times and then left.
export async function noteIntroFailed(eventId: string, x: string, y: string, why: string, final = false): Promise<void> {
  const { a, b } = orderPair(x, y);
  await pool
    .query(`UPDATE co_pairs SET intro_attempts = CASE WHEN $4 THEN ${INTRO_MAX_ATTEMPTS} ELSE COALESCE(intro_attempts, 0) + 1 END, updated_at = NOW() WHERE event_id = $1 AND a_id = $2 AND b_id = $3`, [eventId, a, b, final])
    .catch(() => {});
  await recordDecision({ layer: 6, decision: "match.introEmail", userId: a, outcome: "skip", action: final ? "failed_final" : "failed_will_retry", proposal: { eventId, a, b }, reason: why }).catch(() => {});
}

// Every limit is in the WHERE clause, oldest first, so rows past their cap or their age can never fill the batch and
// starve a real held email (2026-10-12 re-review). introRetryDue stays as the same rule in code, for the checks.
export const RETRY_HELD_INTROS_SQL = `SELECT p.event_id, p.a_id, p.b_id, p.both_yes_at, p.intro_held_at, p.intro_attempts, p.intro_claimed_at FROM co_pairs p
       JOIN users ua ON ua.id = p.a_id JOIN users ub ON ub.id = p.b_id
       WHERE p.state = 'both_yes' AND p.intro_sent_at IS NULL
         AND (p.intro_held_at IS NOT NULL OR COALESCE(p.intro_attempts, 0) > 0 OR p.intro_claimed_at < NOW() - INTERVAL '${INTRO_CLAIM_STALE_MINUTES} minutes')
         AND COALESCE(p.intro_attempts, 0) < ${INTRO_MAX_ATTEMPTS}
         AND p.both_yes_at > NOW() - INTERVAL '${INTRO_RETRY_MAX_AGE_MS / 86_400_000} days'
         AND ua.archived_at IS NULL AND ub.archived_at IS NULL AND NOT coalesce(ua.sms_opted_out, false) AND NOT coalesce(ub.sms_opted_out, false)
       ORDER BY p.both_yes_at ASC
       LIMIT 20`;

export async function retryHeldIntros(now = new Date()): Promise<number> {
  const { rows } = await pool.query(RETRY_HELD_INTROS_SQL).catch(() => ({ rows: [] as any[] }));
  let sent = 0;
  for (const r of rows) {
    if (!introRetryDue(r, now)) continue;
    if (await matchingPause(r.event_id)) continue;
    const H = await import("./eventGuestMatchHandoff.js");
    if (await H.sendHeldIntro(r.event_id, r.a_id, r.b_id).catch(() => false)) sent++;
  }
  // Network intro emails the pause held (networkIntroNudge.ts), under the same rules.
  sent += await (await import("./networkIntroNudge.js")).retryHeldNetworkIntros(now).catch(() => 0);
  return sent;
}
