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
//
// 2. Emergency pause (kill switch, not a toggle).
//    Was: PROACTIVE_PAUSED, an env var: global only, needs a redeploy to flip, and it never covered the intro email
//    (sendIntroEmail sent with both yeses whatever the pause said) or the additive reveal inside a reply.
//    Now: a matching_pauses row, read fresh on every check (no cache), scope 'all' or one event's id. It stops scoring,
//    nudges, additive offers and reveals, direct asks (also ones held overnight in deferred_sends, which wait), the intro
//    email, and the outside-event heads-up in the daily pick (deferred). Nothing is dropped: a held intro email is sent by
//    retryHeldIntros once the pause lifts. PROACTIVE_PAUSED still stops everything too. A failed read counts as paused.
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
//   both_yes    both said yes; the intro email goes now, or when the pause lifts (retryHeldIntros)
//   intro_sent  the one email went to both
//   met         one side told Co they met (noteRoomMeeting); a_outcome / b_outcome hold each side's own words, never shown
//               to the other side
//   expired     the room closed with the pair still suggested or asked (terminal for this event)
//
// ============================================================ THE VALUE-LINE GATE
//
// Before any Co-initiated intro ask (the in-room nudge, the additive reveal, the end-of-night pairing, the outside-event
// heads-up), Co (the model) writes one line per side: why THIS person gets value from the other, and judges whether a
// friend who knows both would make the intro ("strong" or "weak"). Code guards the facts, not the taste:
//   - each line rests on what the OTHER member marked shareable (at least two of its words), so the reason is real;
//   - neither line carries the other member's private asks, profile, notes or owner-only facts (shingles and
//     coFacts.privateFactLeak), and no sensitive topic that is only the other member's;
//   - a weak verdict, a missing line, or a failed read is no intro. Every outcome is logged (match.valueLines) and stored
//     on the pair (value_line_a/b, value_verdict, blocked_reason). Judged once per pair per event.
// Line for A is shown only to A (their nudge); line for B only to B (their direct ask). Each line may use its reader's
// own private context (it's theirs) and only the other's shareable asks. An intro a member asked for by name
// (requestEventIntro) is theirs, not Co's suggestion: it's logged as member-requested and not blocked on taste.
//
// ============================================================ CROSS-MEMBER LEAKS (audited paths)
//   - The pause, the room's state, a pair's state, a decline, a block and its reason are never told to any member.
//     A member-requested intro to someone who declined gets the same neutral answer as any other (conversationTools).
//   - noteRoomMeeting finds only people Co told THIS member about (asked_<side>_at set) and returns nothing about the
//     other side's answer or outcome.
//   - Value lines: the line for one side is stored under that side and drafted only into that side's text.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { recordDecision, type GateCheck } from "../harness/core.js";
import { effectiveEnd, roomPhase, type RoomPhase } from "../harness/introConsent.js";
import { isOpenAsk } from "../harness/profileWrite.js";
import { proactivePaused } from "./proactivePause.js";
import type { ScorableGuest } from "./eventScoring.js";

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
export type EventInfo = RoomTiming & { api_id: string; name: string };

// Minutes after an event's end that the end-of-night job closes its room.
export const ROOM_CLOSE_BUFFER_MINUTES = 15;

export const isTestEvent = (eventId: string) => eventId.startsWith("test-");

// THE place an event's timing is read: Luma for Co's events, co_test_events for fictional test events (co-test only).
export async function eventTiming(eventId: string): Promise<EventInfo | null> {
  if (isTestEvent(eventId)) {
    const { testNumbersEnabled } = await import("./testNumbers.js");
    if (!testNumbersEnabled()) return null;
    const { rows } = await pool.query(`SELECT api_id, name, start_at, end_at, timezone FROM co_test_events WHERE api_id = $1`, [eventId]).catch(() => ({ rows: [] as any[] }));
    const r = rows[0];
    return r ? { api_id: r.api_id, name: r.name, start_at: new Date(r.start_at).toISOString(), end_at: r.end_at ? new Date(r.end_at).toISOString() : null, timezone: r.timezone ?? null } : null;
  }
  const { getEventDetails } = await import("./luma.js");
  const d = await getEventDetails(eventId).catch(() => null);
  return d?.start_at ? { api_id: eventId, name: d.name, start_at: d.start_at, end_at: d.end_at ?? null, timezone: d.timezone ?? null } : null;
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
  if (here.origin !== "member" && here.state === "blocked") return `value lines blocked${here.blocked_reason ? `: ${here.blocked_reason}` : ""}`;
  if (here.origin !== "member" && here.state === "expired") return "asks expired when the room closed";
  if (xIsA ? here.asked_a_at : here.asked_b_at) return "already asked";
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
  const why = pairBlockReason(await pairRows(x, y), eventId, x, y);
  if (why) {
    await recordDecision({ layer: 6, decision: "match.pair", userId: x, outcome: "skip", action, proposal: { eventId, other: y }, checks: [{ name: "pair_may_ask", pass: false, reason: why }] }).catch(() => {});
  }
  return why;
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
      `UPDATE co_pairs SET ${col} = COALESCE(${col}, NOW()), state = CASE WHEN state = 'suggested' THEN 'asked' ELSE state END, updated_at = NOW()
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

export async function notePairIntroSent(eventId: string, x: string, y: string): Promise<void> {
  const { a, b } = orderPair(x, y);
  await pool
    .query(`UPDATE co_pairs SET intro_sent_at = COALESCE(intro_sent_at, NOW()), state = CASE WHEN state = 'met' THEN state ELSE 'intro_sent' END, updated_at = NOW() WHERE event_id = $1 AND a_id = $2 AND b_id = $3`, [eventId, a, b])
    .catch((err: any) => console.error("co_pairs: intro sent failed (non-fatal):", err?.message ?? err));
}

export type MeetingOutcome = "met_good" | "met_fine" | "met_not_a_fit" | "did_not_meet";

// x's side of how meeting y went, on their most recent pair at a Co event Co told x about. Never shown to y.
export async function notePairMet(x: string, pairId: number, outcome: MeetingOutcome, note: string | null): Promise<boolean> {
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
  return true;
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
  // Their own open asks, each marked shareable or not. Only they read the line written for them.
  ownAsks: { text: string; type: string; shareable: boolean }[];
  goals: string[];
  // How earlier in-room intros Co made for them went, their side only, names removed.
  pastOutcomes: string[];
  // What another member may be told: their shareable asks.
  shared: string[];
  // Their open asks they did NOT mark shareable: in no line at all, theirs or the other's.
  privateAsks: string[];
  // Everything else about them, never to appear in the other side's line.
  privateTexts: string[];
};

export function valueLinePrompt(eventName: string, x: ValueSide, y: ValueSide): string {
  const side = (s: ValueSide) =>
    [
      `What ${s.firstName} has told Co (only ${s.firstName} reads the line written for ${s.firstName}):`,
      ...s.ownAsks.map((a) => `- ${a.type === "offering" ? "can offer" : "looking for"}: "${a.text}" ${a.shareable ? "[ok to share]" : "[private]"}`),
      ...s.goals.map((g) => `- goal: "${g}"`),
      ...s.pastOutcomes.map((o) => `- an earlier intro Co made for them: ${o}`),
      s.ownAsks.length || s.goals.length ? null : "- (nothing on file)",
      `What ${s.firstName} said Co may tell people they meet: ${s.shared.length ? s.shared.map((t) => `"${t}"`).join("; ") : "(nothing)"}`,
    ]
      .filter(Boolean)
      .join("\n");
  return `Co is a friend to every member of a private club, and only introduces two people when a friend who knows both of them would make the introduction. At "${eventName}", Co is considering introducing ${x.firstName} and ${y.firstName}.

${side(x)}

${side(y)}

Write two lines, one sentence each, as Co speaking straight to that person ("you", and "I" for Co, never "Co thinks"): plain, warm, composed, the way a friend who knows both would put it. No em dashes, no exclamation points, no titles or labels for anyone.
- for_first: to ${x.firstName}, the concrete reason meeting ${y.firstName} is worth it for ${x.firstName}. It may use anything ${x.firstName} told Co. About ${y.firstName} it may use ONLY what ${y.firstName} said Co may tell people, in close to their own words (if that's nothing, say only what ${x.firstName} is after and nothing about ${y.firstName}). Nothing else about ${y.firstName}.
- for_second: to ${y.firstName}, the same the other way round. About ${x.firstName}, ONLY what ${x.firstName} said Co may tell people.
Then judge it honestly: would a friend who knows both of them make this introduction? "strong" only when each line names a specific reason that person gets value from the other. "weak" when either reason is generic (similar interests, both in tech, good to know, would get along), a stretch, one-sided, or only works by leaning on something either of them keeps private.
Return ONLY JSON: {"for_first": "...", "for_second": "...", "verdict": "strong" or "weak", "why": "a few words"}`;
}

export type ValueJudgment = { forFirst: string; forSecond: string; verdict: "strong" | "weak"; why: string };

export function parseValueJudgment(raw: string): ValueJudgment | null {
  try {
    const j = parseModelJson<any>(raw);
    const verdict = j?.verdict === "strong" ? "strong" : j?.verdict === "weak" ? "weak" : null;
    if (!verdict) return null;
    return { forFirst: String(j.for_first ?? "").trim(), forSecond: String(j.for_second ?? "").trim(), verdict, why: String(j.why ?? "").trim() };
  } catch {
    return null;
  }
}

const STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "who", "that", "is", "are", "their", "they", "them", "at", "as", "by", "be", "it", "this", "you", "your", "someone", "people", "looking", "want", "wants", "can", "offer", "find", "meet", "more", "some", "who's", "what"]);
const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const contentWords = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
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
export function checkNoPrivateQuote(text: string, privateTexts: string[], shared: string[], name = "no_private_quote"): GateCheck {
  const allowed = shingles(contentWords(shared.join(" . ")), 3);
  const mine = shingles(contentWords(text), 3);
  for (const p of privateTexts) {
    for (const s of shingles(contentWords(p), 3)) {
      if (mine.has(s) && !allowed.has(s)) return { name, pass: false, reason: `carries the other member's private words ("${s}")` };
    }
  }
  return { name, pass: true };
}

// Pure: the facts the lines must hold to. The verdict is Co's; these are code's.
export function checkValueLines(j: ValueJudgment | null, x: ValueSide, y: ValueSide, sensitive: RegExp[] = []): { ok: boolean; checks: GateCheck[] } {
  if (!j) return { ok: false, checks: [{ name: "value_judgment", pass: false, reason: "no judgment (the read failed or came back unreadable)" }] };
  const checks: GateCheck[] = [];
  checks.push(j.verdict === "strong" ? { name: "friend_would_intro", pass: true } : { name: "friend_would_intro", pass: false, reason: `weak: ${j.why || "no reason given"}` });
  for (const [line, reader, other, label] of [
    [j.forFirst, x, y, "first"],
    [j.forSecond, y, x, "second"],
  ] as const) {
    if (!line || line.length < 20) {
      checks.push({ name: `line_${label}`, pass: false, reason: `no real line for ${reader.firstName}` });
      continue;
    }
    if (line.length > 300) checks.push({ name: `line_${label}`, pass: false, reason: `line for ${reader.firstName} is too long` });
    // The reason rests on what the other member shared. When they shared nothing, the line may rest only on the reader's
    // own asks and goals, and it is withheld from the reader (lineFor gives ""): Co then says nothing about why, exactly
    // as before, and the reader hears about the other only once the other has said yes.
    if (other.shared.length) {
      checks.push(groundedIn(line, other.shared) ? { name: `grounded_${label}`, pass: true } : { name: `grounded_${label}`, pass: false, reason: `line for ${reader.firstName} doesn't rest on what ${other.firstName} shared` });
    } else {
      const own = [...reader.ownAsks.map((a) => a.text), ...reader.goals];
      checks.push(groundedIn(line, own) ? { name: `grounded_${label}`, pass: true, reason: `${other.firstName} shared nothing: rests on ${reader.firstName}'s own asks, withheld from the text` } : { name: `grounded_${label}`, pass: false, reason: `${other.firstName} shared nothing, and the line for ${reader.firstName} doesn't rest on their own asks either` });
    }
    checks.push(checkNoPrivateQuote(line, other.privateTexts, other.shared, `private_${label}`));
    checks.push(checkNoPrivateQuote(line, reader.privateAsks, reader.shared, `own_private_ask_${label}`));
    // A sensitive topic that only the other member raised (theirs, not the reader's own) leans on something private.
    const n = ` ${norm(line)} `;
    const hit = sensitive.map((re) => n.match(re)?.[0]).find(Boolean);
    if (hit) {
      const theirs = other.privateTexts.some((t) => norm(t).includes(hit));
      const own = [...reader.ownAsks.map((a) => a.text), ...reader.goals].some((t) => norm(t).includes(hit));
      checks.push(theirs && !own ? { name: `sensitive_${label}`, pass: false, reason: `leans on "${hit}", which is ${other.firstName}'s private matter` } : { name: `sensitive_${label}`, pass: true });
    }
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
    privateTexts: [
      ...privateAsks,
      ...(prof.goals ?? []),
      ...(prof.blockers ?? []),
      ...(prof.activity_preferences ?? []),
      ...(prof.long_term_direction ? [prof.long_term_direction] : []),
      ...allGoals,
      ...m.rows.map((r: any) => String(r.content)),
      ...facts,
    ].map(String),
  };
}

export type ValueGateResult = { ok: true; lineFor: (userId: string) => string; cached: boolean } | { ok: false; reason: string };

// A line resting only on its reader's own asks (the other member shared nothing) is stored marked, never shown.
export const WITHHELD = "[withheld] ";
export const usableLine = (l: string | null | undefined) => (l && !l.startsWith(WITHHELD) ? l : "");

// Before a Co-initiated intro ask between x and y at this event: Co writes a line per side and judges it; code checks
// the facts. Stores the result on the pair (once per pair per event) and logs it. A blocked pair is never asked.
export async function valueGate(eventId: string, eventName: string, x: string, y: string, action: string): Promise<ValueGateResult> {
  const { a, b } = orderPair(x, y);
  await notePairSuggested(eventId, x, y, "co");
  const existing = await pairRow(eventId, x, y);
  const lineOf = (row: { value_line_a: string | null; value_line_b: string | null }) => (id: string) => usableLine(id === a ? row.value_line_a : row.value_line_b);
  if (existing?.value_verdict === "strong" && existing.state !== "blocked") return { ok: true, lineFor: lineOf(existing), cached: true };
  if (existing?.state === "blocked") return { ok: false, reason: existing.blocked_reason ?? "blocked" };

  const [sa, sb] = await Promise.all([gatherValueSide(a), gatherValueSide(b)]);
  let judgment: ValueJudgment | null = null;
  let raw = "";
  try {
    const r = await generateText({
      model: anthropic(VALUE_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "roomMatching.valueLines" },
      prompt: valueLinePrompt(eventName, sa, sb),
    });
    raw = r.text;
    judgment = parseValueJudgment(raw);
  } catch (err: any) {
    raw = `error: ${err?.message ?? err}`;
  }
  // The lines are reasons a draft is built from (the sent text is cleaned there); only Co's punctuation rules apply here.
  const tidy = (l: string) => l.replace(/\s*[\u2014\u2013]\s*/g, ", ").replace(/!/g, ".").trim();
  if (judgment) judgment = { ...judgment, forFirst: tidy(judgment.forFirst), forSecond: tidy(judgment.forSecond) };
  const { SENSITIVE } = await import("../harness/matchGate.js");
  const result = checkValueLines(judgment, sa, sb, SENSITIVE);
  // The stored facts' own check (coFacts.privateFactLeak), on top: each line against the other member.
  if (result.ok && judgment) {
    const { privateFactLeak } = await import("./coFacts.js");
    const [la, lb] = await Promise.all([privateFactLeak(judgment.forFirst, b).catch(() => null), privateFactLeak(judgment.forSecond, a).catch(() => null)]);
    for (const [hit, label] of [
      [la, "first"],
      [lb, "second"],
    ] as const) {
      result.checks.push(hit ? { name: `fact_leak_${label}`, pass: false, reason: `carries a private fact ("${hit.slice(0, 60)}")` } : { name: `fact_leak_${label}`, pass: true });
    }
    result.ok = result.checks.every((c) => c.pass);
  }
  const failed = result.checks.filter((c) => !c.pass).map((c) => c.reason).join("; ");
  if (judgment) judgment = { ...judgment, forFirst: sb.shared.length ? judgment.forFirst : WITHHELD + judgment.forFirst, forSecond: sa.shared.length ? judgment.forSecond : WITHHELD + judgment.forSecond };
  await pool
    .query(
      `UPDATE co_pairs SET value_line_a = $4, value_line_b = $5, value_verdict = $6, value_why = $7, value_judged_at = NOW(),
         state = CASE WHEN $8 THEN state ELSE 'blocked' END, blocked_reason = CASE WHEN $8 THEN NULL ELSE $9 END, updated_at = NOW()
       WHERE event_id = $1 AND a_id = $2 AND b_id = $3`,
      [eventId, a, b, judgment?.forFirst ?? null, judgment?.forSecond ?? null, judgment?.verdict ?? null, judgment?.why ?? null, result.ok, failed || null],
    )
    .catch((err: any) => console.error("co_pairs: storing value lines failed (non-fatal):", err?.message ?? err));
  await recordDecision({
    layer: 6,
    decision: "match.valueLines",
    userId: x,
    outcome: result.ok ? "act" : "skip",
    action,
    proposal: { eventId, a, b, lineForA: judgment?.forFirst ?? null, lineForB: judgment?.forSecond ?? null, verdict: judgment?.verdict ?? null, why: judgment?.why ?? null, raw: judgment ? undefined : raw.slice(0, 300) },
    checks: result.checks,
    reason: result.ok ? null : `no intro: ${failed}`,
  }).catch(() => {});
  if (!result.ok || !judgment) return { ok: false, reason: failed || "no judgment" };
  // Neither line usable means there's nothing true Co can say to either of them: no intro.
  if (!usableLine(judgment.forFirst) && !usableLine(judgment.forSecond)) return { ok: false, reason: "neither member shared anything" };
  return { ok: true, lineFor: lineOf({ value_line_a: judgment.forFirst, value_line_b: judgment.forSecond }), cached: false };
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
    const offers = await pool.query(`UPDATE event_match_offers SET status = 'expired', answered_at = NULL WHERE event_id = $1 AND status IN ('open', 'queued') RETURNING person_id`, [eventId]);
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

// Both said yes but the email waited (the pause): sent once matching isn't paused for that event.
export async function retryHeldIntros(): Promise<number> {
  const { rows } = await pool.query(`SELECT event_id, a_id, b_id FROM co_pairs WHERE state = 'both_yes' AND intro_sent_at IS NULL AND both_yes_at > NOW() - INTERVAL '14 days' LIMIT 20`).catch(() => ({ rows: [] as any[] }));
  let sent = 0;
  for (const r of rows) {
    if (await matchingPause(r.event_id)) continue;
    const H = await import("./eventGuestMatchHandoff.js");
    if (await H.sendHeldIntro(r.event_id, r.a_id, r.b_id).catch(() => false)) sent++;
  }
  return sent;
}
