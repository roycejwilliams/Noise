import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { edgeHint, refreshRoom, roomEdges, type Edge } from "./peopleGraph.js";
import pool from "../db/db.js";
import { matchablePhone } from "../utils/phone.js";
import { runEventAskSolicitationAgent } from "../agent/eventAskSolicitation.js";
import { getEventDetails, getEventGuestList, listCalendarEvents, type LumaGuest, type LumaEventDetail } from "./luma.js";
import { getActiveOfferingAsk, getActiveSeekingAsk, roomFrame, scoreAgainstRoomFrame, shareableAsks, type RoomFrame } from "./matching.js";
import { goalTexts } from "./goalJourney.js";
import { detectAndScheduleCheckins } from "./eventCheckinFollowUp.js";
import { scheduleUnmatchedFollowUp } from "./eventUnmatchedFollowUp.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { inRoomSendAllowed, recordInRoomSend, releaseInRoomClaim, enqueueCandidate, type OutputRules } from "../harness/proactive.js";
import { writeMemory } from "./memory.js";
import { mergeWalkinsIntoGuestPool } from "./eventWalkinCheckin.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";
import { checkEventWindow, checkNamesWithheld, checkOneNudgePerEvent, draftWithConsent, eventOptedIn, eventPromptLine, withEnd, type IntroEvent } from "../harness/introConsent.js";
import { gateShareReason } from "../harness/matchGate.js";
import { recordDecision } from "../harness/core.js";
import { arrivalWaitCheck, getPresence } from "./eventPresence.js";
import { MODELS } from "../models.js";
import { isOpenAsk } from "../harness/profileWrite.js";
import { withTraceUser } from "./llmTraceText.js";
import { withMember } from "./llmUsage.js";

// Model policy (Royce, 2026-09-14): a draft that names another person is
// Sonnet 5; the additive offer names no one (checked in code) and stays Haiku.
const NAMING_DRAFT_MODEL = MODELS.sonnet;
const PLAIN_DRAFT_MODEL = MODELS.haiku;

// Event Curation — "Standing profile scored against full Luma guest list."
// Scoped strictly to one event's guest list, not the whole network — a Co
// user with a profile who ISN'T attending this event is already served by
// the separate tiered-recommendation route and the general Stage 3 network
// sweep (relevance.ts); this file has nothing to do with them.

export type ScorableGuest = {
  user_id: string;
  first_name: string;
  phone_number: string;
  email: string;
  city?: string | null;
  goals?: string[];
  blockers?: string[];
  activity_preferences?: string[];
  intent?: unknown;
};

export type RankedCandidate = {
  candidate_id: string;
  score: number;
  reason: string;
  // Only this may be shown to a person; see matching.ts AskScore.shareReason.
  shareReason?: string;
  mutual: boolean;
  method: "ask";
  // The people graph's link, internal only (peopleGraph.ts): why they were
  // likely worth each other, for review and for explaining a ranking.
  graph?: { score: number; want: string | null; offer: string | null; mutual: boolean } | null;
  // A newly qualifying person whose additive heads-up is waiting for their other open question to be answered: the next pass
  // still counts them as new, so the heads-up goes once the slot frees instead of being lost (review of #211).
  additivePending?: boolean;
};

// Luma gives us email/phone/name, never a user_id — this is the only place
// that translates "who's on the guest list" into "which of them are actual
// Co users we have a profile for."
//
// Email added to the match 2026-09-03 (Royce: "find something more
// reliable") after live-testing exposed phone-only matching as close to
// useless in practice: Luma's own Add Guests API doesn't even accept a
// phone number as input (confirmed against its OpenAPI spec — phone is
// only ever collected if the event's own `phone_number_requirement` is set
// to require it at checkout), and a real guest added through it came back
// with `phone_number: null`. Email (`user_email`) is the one field Luma
// reliably has on every guest regardless of event configuration, and
// `users.email` is a required column here — so matching OR's both signals
// instead of relying on phone alone. Case-insensitively, since Gmail-style
// email casing differences would otherwise silently miss a real match (the
// existing exact-string email lookup in routes/luma.ts's
// reachOutToSubscriber doesn't have this problem today only because it's
// matching Luma's own subscriber-webhook email, not comparing two
// independently-typed addresses across systems the way this does).
export async function matchGuestsToUsers(guests: LumaGuest[]): Promise<ScorableGuest[]> {
  // Luma's phone as the guest typed it, put in the stored E.164 form (utils/phone.ts matchablePhone).
  const phones = [...new Set(guests.flatMap((g) => [g.phone, matchablePhone(g.phone)]).filter((p): p is string => Boolean(p)))];
  const emails = guests.map((g) => g.email?.toLowerCase()).filter((e): e is string => Boolean(e));
  if (!phones.length && !emails.length) return [];

  const { rows } = await pool.query(
    `SELECT cp.user_id, u.first_name, u.phone_number, u.email, cp.city, cp.goals, cp.blockers, cp.activity_preferences, cp.intent
     FROM co_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE (u.phone_number = ANY($1::text[]) OR LOWER(u.email) = ANY($2::text[]))
       AND coalesce(u.sms_opted_out, false) = false AND u.archived_at IS NULL`,
    [phones, emails],
  );
  return rows;
}

// THE definition of "in the room" for a Co event (Royce, 2026-10-07: "one function, used everywhere"). Scoring, the
// end-of-night pass and named intros all take their people from here, so nobody outside it is ever matched, named or
// texted about the room. In the room means:
//   - on the Luma list as APPROVED (declined, waitlisted, pending and invited-only are not in the room), or a walk-in
//     whose arrival Co has confirmed (event_presence.arrived_at, from their shared location or Co marking them
//     arrived): texting the QR phrase alone is not enough, it's only a claim;
//   - a current member: not archived, not opted out of texts;
//   - not someone who told Co they can't make it (event_presence.not_going_at);
//   - and not someone sharing their location who hasn't arrived yet (sharing_seen_at without arrived_at, still sharing): held out until they do.
// guests: the event's Luma guest list when the caller already has it.
// This is the roster (who is in the room while it's on). Whether someone is in it RIGHT NOW (the room open, not left, not
// closed for the night) is services/roomMatching.ts inRoomNow, which every live reader uses on top of this.
export async function inRoomPool(eventId: string, guests?: LumaGuest[]): Promise<ScorableGuest[]> {
  const { mergeWalkinsIntoGuestPool } = await import("./eventWalkinCheckin.js");
  const { isTestEvent } = await import("./roomMatching.js");
  const [registered, walkins] = await Promise.all([
    isTestEvent(eventId) && !guests ? testEventGuests(eventId) : (async () => matchGuestsToUsers((guests ?? (await getEventGuestList(eventId))).filter((g) => g.approval_status === "approved")))(),
    mergeWalkinsIntoGuestPool(eventId),
  ]);
  const ids = [...new Set([...registered, ...walkins].map((g) => g.user_id))];
  if (!ids.length) return [];
  const { rows } = await pool.query(`SELECT user_id, arrived_at, not_going_at, sharing_seen_at, location_stopped_at FROM event_presence WHERE event_api_id = $1 AND user_id = ANY($2::uuid[])`, [eventId, ids]);
  const presence = new Map<string, { arrived_at: unknown; not_going_at: unknown; sharing_seen_at: unknown; location_stopped_at: unknown }>(rows.map((r: any) => [String(r.user_id), r]));
  const notGoing = (id: string) => Boolean(presence.get(id)?.not_going_at);
  const arrived = (id: string) => Boolean(presence.get(id)?.arrived_at);
  // Someone sharing their location who hasn't arrived is held out of matching until they do (Royce, 2026-10-14): Cue can see
  // they aren't there yet, so nobody is pointed at them and they aren't matched. A registered guest who doesn't share counts as
  // in the room, as before, and so does one who stopped sharing: Cue can't see where they are any more (review of #215).
  const notHereYet = (id: string) => Boolean(presence.get(id)?.sharing_seen_at) && !presence.get(id)?.location_stopped_at && !arrived(id);
  return dedupeByUserId([...registered.filter((g) => !notGoing(g.user_id) && !notHereYet(g.user_id)), ...walkins.filter((g) => arrived(g.user_id) && !notGoing(g.user_id))]);
}

// A fictional test event's guests (co_test_events, co-test only; services/testNumbers.ts): the same profile rows as a
// Luma guest list gives, never a Luma call.
async function testEventGuests(eventId: string): Promise<ScorableGuest[]> {
  const { testNumbersEnabled } = await import("./testNumbers.js");
  if (!testNumbersEnabled()) return [];
  const { rows } = await pool.query(
    `SELECT cp.user_id, u.first_name, u.phone_number, u.email, cp.city, cp.goals, cp.blockers, cp.activity_preferences, cp.intent
     FROM co_test_events e JOIN users u ON u.id = ANY(e.guest_user_ids) JOIN co_profiles cp ON cp.user_id = u.id
     WHERE e.api_id = $1 AND coalesce(u.sms_opted_out, false) = false AND u.archived_at IS NULL`,
    [eventId],
  );
  return rows;
}

// A person could plausibly show up in both sources in the same pass — a
// Luma-registered guest who also scans the venue QR and checks in. Keep one
// entry per user_id (first one wins; both sources carry the same underlying
// co_profiles row anyway, so there's nothing to merge) rather than scoring
// the same person twice against everyone else in scoreMatchedGroup below.
export function dedupeByUserId(guests: ScorableGuest[]): ScorableGuest[] {
  const seen = new Set<string>();
  const out: ScorableGuest[] = [];
  for (const g of guests) {
    if (seen.has(g.user_id)) continue;
    seen.add(g.user_id);
    out.push(g);
  }
  return out;
}

// Cooldown guard (Royce, 2026-08-30) — without this, guest.registered/
// guest.updated retriggering scoreMatchedGroup would re-solicit the same
// person every time, since "no ask yet" stays true until they actually
// reply. 3 days, same first-guess cadence as the Luma/X surfacing sweep.
const SOLICITATION_COOLDOWN_DAYS = 3;

async function wasRecentlySolicited(eventId: string, personId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM event_ask_solicitations
     WHERE event_id = $1 AND person_id = $2 AND solicited_at > NOW() - ($3 || ' days')::interval`,
    [eventId, personId, SOLICITATION_COOLDOWN_DAYS],
  );
  return rows.length > 0;
}

async function markSolicited(eventId: string, personId: string): Promise<void> {
  await pool.query(
    `INSERT INTO event_ask_solicitations (event_id, person_id, solicited_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (event_id, person_id) DO UPDATE SET solicited_at = NOW()`,
    [eventId, personId],
  );
}

// Debounce guard (Royce, 2026-09-05 — found via real guest-add testing):
// Luma fires guest.registered AND guest.updated as two separate webhooks for
// a single guest-add action (confirmed live, ~3 microseconds apart), and
// routes/luma.ts's runScoringPass had nothing stopping both from
// independently running the full scoring pass — each with its own real,
// billed LLM call per matched guest, for the exact same underlying data.
// Atomic claim-before-act (a plain check-then-write would let two near-
// simultaneous webhooks both read "not scored recently" before either had
// written its claim). Short window — this is only meant to coalesce near-
// duplicate signals for the SAME action, not throttle genuinely distinct
// guest registrations, which are vanishingly unlikely to land within
// seconds of each other in practice; even if they did, nothing is lost,
// just picked up on the next trigger.
export const SCORING_DEBOUNCE_SECONDS = 15;

async function tryClaimScoringDebounce(eventId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO event_scoring_debounce (event_id, last_triggered_at)
     VALUES ($1, NOW())
     ON CONFLICT (event_id) DO UPDATE
       SET last_triggered_at = NOW()
       WHERE event_scoring_debounce.last_triggered_at <= NOW() - ($2 || ' seconds')::interval
     RETURNING event_id`,
    [eventId, SCORING_DEBOUNCE_SECONDS],
  );
  return rows.length > 0;
}

// Read BEFORE storeRanking overwrites the row below — this is the "who did
// this person already know about as of the last scoring pass" snapshot that
// maybeSendAdditiveOffer diffs the new ranking against, to find candidates
// that are genuinely new since last time rather than the whole re-ranked
// list (which includes everyone already considered, not just fresh arrivals).
// The previous pass's ranking: who was in it, less anyone whose additive heads-up is still waiting (additivePending), who stays new.
async function getPreviousRankedCandidateIds(eventId: string, personId: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT ranked_candidates FROM event_guest_rankings WHERE event_id = $1 AND person_id = $2`,
    [eventId, personId],
  );
  const prior = rows[0]?.ranked_candidates as RankedCandidate[] | undefined;
  return new Set((prior ?? []).filter((c) => !c.additivePending).map((c) => c.candidate_id));
}

async function storeRanking(eventId: string, personId: string, ranked: RankedCandidate[], methodSummary: string): Promise<void> {
  await pool.query(
    `INSERT INTO event_guest_rankings (event_id, person_id, ranked_candidates, method_summary)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (event_id, person_id) DO UPDATE SET
       ranked_candidates = EXCLUDED.ranked_candidates,
       method_summary = EXCLUDED.method_summary,
       computed_at = NOW()`,
    [eventId, personId, JSON.stringify(ranked), methodSummary],
  );
}

// Minimal text-based version of the "one-time nudge" (Notion V1 board row
// 9's eventual top-5 ranked card stack / App Clip) — see
// event_guest_match_nudges' migration comment. Only fires on a genuinely
// strong match, not just the best of a weak field (confirmed live,
// 2026-09-07: three real independent users with genuinely unrelated asks
// all correctly scored 0-5 against each other — this threshold is exactly
// what keeps that from becoming a false "you two should meet!" text).
export const MATCH_NUDGE_MIN_SCORE = 60;

// Royce, 2026-09-07: "we want to facilitate the nudge as the event is
// happening" — a match found days before the event started was firing
// immediately, so by the time the person actually arrived the text (if they
// even still remembered it) was already stale. Gated on the event's real
// start_at/end_at (Luma always has these) — the same reliable-timestamp
// pattern already used for the end-of-night check-in, not Luma's check-in
// status, which has no API to ever set it at all.
//
// Known follow-on gap, not built here: a match found before start_at is
// correctly withheld (not marked as nudged, so a later pass can still send
// it), but nothing proactively wakes up right at start_at to retry it for an
// event whose guest-list webhooks have gone quiet by then — it only actually
// re-fires if some other real Luma webhook (a late registration, an update)
// happens to arrive after start_at. Worth a dedicated retry pass if that
// turns out to matter in practice; not added speculatively.
//
// "Diminishing value near the end" (Royce, 2026-09-07) — a match surfaced
// with only a few minutes left in the event isn't actionable. Same
// reasoning eventSurfacingSweep.ts's isShortNotice already uses for teases
// on a same-day event, just the mirror case (too LATE, not too early).

// Debounce for the "additive offer" nudge (Royce, 2026-09-10) — a re-score
// triggered by a fresh walk-in check-in must never silently swap or replace
// someone's existing match; it sends a separate, distinct offer instead. But
// during a busy stretch of check-ins that could mean one text per arrival,
// which is exactly the kind of spam the existing anti-nag patterns in this
// codebase (no-reply-means-no-repeat-nudge, the daily proactive-nudge cap)
// are built to avoid. 20 minutes, not the 15-SECOND scoring debounce above —
// that one only coalesces near-duplicate webhooks for the same action, this
// one paces a real outbound text to a real person.
//
// Known limitation, not closed here (stayed in scope of this file only,
// schema fixed at event_walkin_offer_batches(event_api_id, person_id,
// last_offered_at) — no column tracks exactly which candidate_ids were
// already included in the last SENT offer): the "new since last time" diff
// below compares against the immediately-PRIOR scoring pass's stored
// ranking, not against whatever was known as of the last successfully SENT
// offer. If several scoring passes land inside one 20-minute debounce window
// while the offer keeps getting skipped, only the delta from the pass
// immediately before the send is reflected, not the full cumulative set of
// arrivals across the whole debounced window. Closing that properly needs a
// new column (e.g. last_offered_candidate_ids) — not added here to avoid
// touching migrations.ts while other agents are working in parallel.
const ADDITIVE_OFFER_DEBOUNCE_MINUTES = 20;

async function tryClaimAdditiveOfferDebounce(eventId: string, personId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO event_walkin_offer_batches (event_api_id, person_id, last_offered_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (event_api_id, person_id) DO UPDATE
       SET last_offered_at = NOW()
       WHERE event_walkin_offer_batches.last_offered_at <= NOW() - ($3 || ' minutes')::interval
     RETURNING event_api_id`,
    [eventId, personId, ADDITIVE_OFFER_DEBOUNCE_MINUTES],
  );
  return rows.length > 0;
}


export async function wasAlreadyNudgedForMatch(eventId: string, personId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM event_guest_match_nudges WHERE event_id = $1 AND person_id = $2`,
    [eventId, personId],
  );
  return rows.length > 0;
}

// Exported for the Layer 7 registry's onSent hook (harness/proactiveRegistry.ts,
// event_match_nudge) — the self-report/no-timing path below only marks the
// nudge sent once the harness actually delivers it, not at enqueue time.
export async function markMatchNudgeSent(eventId: string, personId: string, candidateId: string, score: number, anonymous = false): Promise<void> {
  await pool
    .query(
      `INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score, anonymous)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id, person_id) DO NOTHING`,
      [eventId, personId, candidateId, score, anonymous],
    )
    .catch((err: any) => console.error("markMatchNudgeSent: insert failed (non-fatal):", err?.message ?? err));
}

// Atomic claim for the live in-room path (code review, 2026-09-17): the
// same INSERT ON CONFLICT DO NOTHING as markMatchNudgeSent, but run BEFORE
// drafting/sending rather than after, so two overlapping scoring passes for
// the same person can't both pass the "not yet nudged" check and both send.
// Returns whether THIS call won the claim.
async function tryClaimMatchNudge(eventId: string, personId: string, candidateId: string, score: number): Promise<boolean> {
  const { rows } = await pool
    .query(
      `INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score, pending)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (event_id, person_id) DO NOTHING RETURNING event_id`,
      [eventId, personId, candidateId, score],
    )
    .catch((err: any) => {
      console.error("tryClaimMatchNudge: insert failed (non-fatal, treated as not claimed):", err?.message ?? err);
      return { rows: [] };
    });
  return rows.length > 0;
}

// Frees a claim that didn't result in an actual send (draft rejected,
// throttled, or the send itself failed) so a later pass can retry — without
// this, a failed attempt would permanently mark the event as "already
// nudged" with nothing ever delivered.
async function releaseMatchNudgeClaim(eventId: string, personId: string): Promise<void> {
  await pool
    .query(`DELETE FROM event_guest_match_nudges WHERE event_id = $1 AND person_id = $2`, [eventId, personId])
    .catch((err: any) => console.error("releaseMatchNudgeClaim: delete failed (non-fatal):", err?.message ?? err));
}

// Payload for the Layer 7 "event_match_nudge" proactive type (registered in
// harness/proactiveRegistry.ts) — the no-real-timing branch below.
export type EventMatchNudgePayload = {
  eventId: string;
  candidateId: string;
  candidateFirstName: string;
  score: number;
  message: string;
  rules: OutputRules;
  // A heads-up about an event Co doesn't run: says no name until both yes.
  anonymous?: boolean;
};

// One-time, not a cooldown (see the table's migration comment) — checked
// BEFORE the shared proactive-nudge throttle so a person already nudged for
// this event doesn't spend today's one discretionary-text slot on a repeat
// pass finding the same top match again.
async function maybeSendMatchNudge(
  eventId: string,
  eventName: string,
  person: ScorableGuest,
  top: RankedCandidate,
  candidate: ScorableGuest,
  eventTiming: { start_at: string; end_at: string | null } | null,
  opts: { dryRun?: boolean; requireTiming?: boolean },
): Promise<boolean> {
  // Never below the bar (Royce, 2026-10-14: "Sparse rooms: never lower the bar, never force a match. Members get silence"). The
  // end-of-event pass that once bypassed this gate for a "low-key hello" is gone (services/eventUnmatchedFollowUp.ts).
  if (top.score < MATCH_NUDGE_MIN_SCORE) return false;
  // Privacy (2026-09-14): top.reason comes from the candidate's private
  // profile + memories. Without a shareable reason there's nothing we can
  // honestly tell this person, so no nudge.
  if (!top.shareReason) return false;

  const oneNudgeCheck = checkOneNudgePerEvent(await wasAlreadyNudgedForMatch(eventId, person.user_id));
  if (!oneNudgeCheck.pass) return false;
  if (!(await gateShareReason(person.user_id, candidate.user_id, top.shareReason, "eventScoring.matchNudge"))) return false;
  // The pair record (services/roomMatching.ts): never ask the same person twice about the same pair, never a pair either
  // side declined at any event, never a pair already introduced or blocked.
  const RM = await import("./roomMatching.js");
  if (await RM.mayAsk(eventId, person.user_id, candidate.user_id, "eventScoring.matchNudge")) return false;
  // The emergency pause, before anything is judged or claimed.
  if (await RM.matchingPause(eventId)) return false;

  const candidateOptedIn = await eventOptedIn(eventId, candidate.user_id, person.user_id);
  // Only what the candidate marked shareable counts as "what they told Co" for the consent checks (2026-10-12): their
  // private asks are not a group a draft may describe.
  const candidateShared = shareableAsks(candidate.intent).map((a) => String(a.text));
  const draftFacts = {
    otherFirstName: candidate.first_name,
    otherOptedIn: candidateOptedIn,
    recipientOptedIn: false,
    recipientFirstName: person.first_name,
    otherStatedAsks: candidateShared,
    otherPhone: candidate.phone_number,
    otherEmail: candidate.email,
  };
  // What the recipient told Co themselves (their shareable asks and goals): a draft may say it back to them.
  const recipientOwn = [...shareableAsks(person.intent).map((a) => String(a.text)), ...goalTexts(person.intent, person.goals)];
  // The candidate's private words (private asks, profile, notes, owner-only facts) never appear in this text.
  const candidateSide = await RM.gatherValueSide(candidate.user_id);
  // Words any text may carry whoever said them: the event's name, its venue, the two first names.
  const info = await RM.eventTiming(eventId).catch(() => null);
  const venue = info?.venue ?? null;
  // The event as it really is (name, day, time, venue), for the prompt and for the check that nothing else is stated
  // (harness/introConsent.ts checkInventedSpecifics). The live timing wins over a stale read.
  const introEvent = { name: eventName, start_at: eventTiming?.start_at ?? info?.start_at ?? null, end_at: eventTiming?.end_at ?? info?.end_at ?? null, timezone: (eventTiming as any)?.timezone ?? info?.timezone ?? null, venue };
  const allow = [eventName, ...(venue ? [venue] : []), person.first_name, candidate.first_name];
  const noPrivateQuote = (d: string) => [RM.checkNoPrivateQuote(d, candidateSide.privateTexts, candidateSide.shared, "no_private_quote", allow)];
  // Taste first: the one line on why this person gets value from the candidate. Set once the gate passes.
  let valueLine = "";
  const passValueGate = async (): Promise<boolean> => {
    // Not ok: blocked (stored, logged) or a failed read (logged, tried again next pass). Either way the caller's loop moves
    // on to this person's next candidate.
    const v = await RM.valueGate(eventId, eventName, person.user_id, candidate.user_id, "eventScoring.matchNudge", { allow });
    if (!v.ok) return false;
    // This person's own line; empty only when the candidate shared nothing, and then there's no nudge (nothing true to say).
    valueLine = v.lineFor(person.user_id);
    return Boolean(valueLine);
  };
  const draftFn = async (feedback: string | null) => {
    const { text } = await generateText({
      model: anthropic(NAMING_DRAFT_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "eventScoring.matchNudge.draft" },
      prompt: matchNudgePrompt({
        recipientFirstName: person.first_name,
        otherFirstName: candidate.first_name,
        eventName,
        // The value line Co wrote for this person (it rests on the candidate's shareable ask, checked in code).
        shareReason: valueLine || top.shareReason!,
        feedback,
        event: introEvent,
      }),
    });
    return cleanCoMessage(text.trim());
  };

  if (eventTiming) {
    // Live in-room path: only makes sense while the event is actually
    // happening, so it stays outside the Layer 7 daily pick (see that
    // harness's own header comment) and sends immediately.
    // Someone sharing their location hears it when they walk in, not at the
    // start time (services/eventPresence.ts); the presence poll re-scores
    // on arrival, and after an hour sends it regardless.
    const preChecks = [
      oneNudgeCheck,
      checkEventWindow(eventTiming, new Date()),
      arrivalWaitCheck(await getPresence(eventId, person.user_id), eventTiming.start_at, new Date()),
    ];
    if (preChecks.some((c) => !c.pass)) return false;

    if (opts.dryRun) {
      console.log(`[eventScoring dryRun] would nudge ${person.user_id} about ${candidate.user_id} at ${eventId} (score ${top.score})`);
      return false;
    }
    // Both of them in the room right now (services/roomMatching.ts inRoomNow): nobody who left is nudged or pointed to.
    const room = await RM.inRoomNow(eventId, { timing: eventTiming });
    const here = new Set(room.people.map((p) => p.user_id));
    if (!room.open || !here.has(person.user_id) || !here.has(candidate.user_id)) {
      await recordDecision({ layer: 6, decision: "match.room", userId: person.user_id, outcome: "skip", action: "eventScoring.matchNudge", proposal: { eventId, candidateId: candidate.user_id }, checks: [{ name: "both_in_room_now", pass: false, reason: !room.open ? `room is ${room.phase ?? "unknown"}` : !here.has(person.user_id) ? "recipient isn't in the room now" : "candidate isn't in the room now" }] }).catch(() => {});
      return false;
    }
    if (!(await passValueGate())) return false;
    // At most two questions about people open or on their way to them at once (services/inRoomOffers.ts claimOfferSlot, under the
    // same lock as a direct ask): with two, this nudge waits for a later pass. Its place is taken now, before drafting, and freed on
    // every way out below that doesn't send.
    const O = await import("./inRoomOffers.js");
    const slot = await O.claimOfferSlot({ eventId, eventName, personId: person.user_id, kind: "nudge", candidateId: candidate.user_id });
    if (!slot) {
      console.log(`eventScoring: match nudge for ${person.user_id} at ${eventId} waits (${O.MAX_OPEN_QUESTIONS} questions already open or on their way)`);
      return false;
    }
    const freeSlot = () => O.releaseOfferSlot(slot).catch((err: any) => console.error("eventScoring: freeing the nudge's question slot failed (non-fatal):", err?.message ?? err));

    // Claim atomically before drafting (code review, 2026-09-17): the
    // scoring debounce only coalesces webhooks that arrive within its 15s
    // window, not two full scoring passes that each take longer than that
    // to run — two overlapping passes could otherwise both see "not yet
    // nudged" via oneNudgeCheck above and both draft and send. This insert
    // is the same one markMatchNudgeSent used to do only at the very end;
    // doing it first and atomically means only one pass ever wins the row.
    if (!(await tryClaimMatchNudge(eventId, person.user_id, candidate.user_id, top.score))) {
      console.log(`eventScoring: match nudge for ${person.user_id} at ${eventId} already claimed by another pass`);
      await freeSlot();
      return false;
    }

    // A draft that throws frees the place too (O.draftingInSlot), or it would hold their slot until SLOT_CLAIM_MINUTES.
    const message = await O.draftingInSlot(slot, () => draftWithConsent({ decision: "eventScoring.matchNudge", recipientId: person.user_id, preChecks, facts: draftFacts, otherUserIds: [candidate.user_id], extraDraftChecks: noPrivateQuote, event: introEvent, said: [...candidateShared, valueLine || top.shareReason!, ...recipientOwn] }, draftFn)).catch(async (err: any) => {
      // The nudge's own claim goes too, so a later pass can retry (draftingInSlot already freed the place).
      await releaseMatchNudgeClaim(eventId, person.user_id).catch(() => {});
      throw err;
    });
    if (!message) {
      await releaseMatchNudgeClaim(eventId, person.user_id); // free it up so a later pass can retry
      await freeSlot();
      return false;
    }

    // Claimed on the ledger in the same locked check (harness/proactive.ts inRoomSendAllowed); a failed send takes it back.
    if (!(await inRoomSendAllowed(person.user_id, eventId, { claim: { targetKey: `in_room:match:${eventId}`, message } }))) {
      console.log(`eventScoring: match nudge throttled for ${person.user_id} (in-room text limit for this event reached)`);
      await releaseMatchNudgeClaim(eventId, person.user_id);
      await freeSlot();
      return false;
    }

    try {
      await sendblue.messages.send({ number: person.phone_number, content: message, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
    } catch (err: any) {
      console.error(`eventScoring: match nudge send failed for ${person.user_id} (non-fatal):`, err?.message ?? err);
      await releaseInRoomClaim(person.user_id, `in_room:match:${eventId}`);
      await releaseMatchNudgeClaim(eventId, person.user_id); // send failed — free the claim so a later pass can retry
      await freeSlot();
      return false;
    }

    // Sent: the claim is no longer at risk of being stranded (strandedClaims.ts).
    await pool
      .query(`UPDATE event_guest_match_nudges SET pending = false WHERE event_id = $1 AND person_id = $2`, [eventId, person.user_id])
      .catch((err: any) => console.error("eventScoring: clearing pending failed (non-fatal):", err?.message ?? err));
    await recordInRoomSend(person.user_id, `in_room:match:${eventId}`, message);
    // The question they now have open about this one person (services/inRoomOffers.ts): their reply binds to it. It opens in the
    // place claimed above.
    await O.openOffer({ eventId, eventName, personId: person.user_id, kind: "nudge", candidateId: candidate.user_id }).catch((err: any) => console.error("eventScoring: opening the nudge offer failed (non-fatal):", err?.message ?? err));
    await RM.notePairAsked(eventId, person.user_id, candidate.user_id);
    // No markMatchNudgeSent call needed here — the claim above already
    // wrote the row with the final candidate_id/score.
    await writeMemory(
      person.user_id,
      "event_guest_match_nudge",
      `Nudged ${person.first_name} that ${candidate.first_name} is also going to "${eventName}" and worth meeting: ${valueLine || top.shareReason}`,
    );
    // Royce, 2026-09-08 sweep — the descriptive log above is a summary, not
    // the actual text sent, so recentConversation (routes/sendblue.ts, which
    // only reads text_exchange rows) never saw this message either.
    await writeMemory(person.user_id, "text_exchange", `Co replied: ${message}`).catch((err: any) =>
      console.error("eventScoring: match nudge text_exchange log failed (non-fatal):", err?.message ?? err),
    );
    return true;
  }

  // A Co event whose times couldn't be read this pass: wait for the next one (it sends live, in the room).
  if (opts.requireTiming) {
    console.log(`eventScoring: no event timing for ${eventId} this pass; ${person.user_id}'s nudge waits for the next one`);
    return false;
  }

  // No real event timing (code review, 2026-09-17): the self-reported/
  // recommended-event path (eventMatching.ts) has no Luma start_at/end_at
  // to check an "in-room" window against, so checkEventWindow's "not a live
  // event, nothing to check" case used to pass here and this sent
  // immediately via the same raw sendblue in-room path above — days before
  // the event, at any hour, over the daily cap. There's no live event to be
  // "in the room" for, so instead of sending directly this drafts and
  // consent-checks the message now (the consent facts need to be current),
  // then hands it to the Layer 7 daily pick, which enforces local hours,
  // the daily/weekly caps, opt-out, and the unanswered-text pause.
  if (opts.dryRun) {
    console.log(`[eventScoring dryRun] would queue an event_match_nudge for ${person.user_id} about ${candidate.user_id} (${eventId}, score ${top.score})`);
    return false;
  }

  if (!(await passValueGate())) return false;
  // An event Co doesn't run (2026-09-23): unlike a Co event, where every
  // guest knows members are in the room, telling someone "Sam is going"
  // shares Sam's plans without Sam's yes. So this heads-up names no one; the
  // name comes out only once both say yes (eventGuestMatchHandoff.ts).
  const message = await draftWithConsent(
    {
      decision: "eventScoring.matchNudge",
      recipientId: person.user_id,
      preChecks: [oneNudgeCheck],
      facts: draftFacts,
      otherUserIds: [candidate.user_id],
      extraDraftChecks: (d) => [checkNamesWithheld(d, [candidate.first_name])],
      event: introEvent.start_at ? introEvent : { name: eventName },
      said: [...candidateShared, valueLine || top.shareReason!, ...recipientOwn],
    },
    async (feedback) => {
      const { text } = await generateText({
        model: anthropic(NAMING_DRAFT_MODEL),
        experimental_telemetry: { isEnabled: true, functionId: "eventScoring.anonymousHeadsUp.draft" },
        prompt: anonymousHeadsUpPrompt({ recipientFirstName: person.first_name, eventName, shareReason: valueLine || top.shareReason!, feedback, event: introEvent }),
      });
      return cleanCoMessage(text.trim());
    },
  );
  if (!message) return false;
  // The candidate's private words never ride along (checked here too, after the consent loop).
  const priv = noPrivateQuote(message)[0];
  if (!priv.pass) {
    await recordDecision({ layer: 6, decision: "intro.consent", userId: person.user_id, outcome: "skip", action: "eventScoring.anonymousHeadsUp", checks: [priv], reason: priv.reason }).catch(() => {});
    return false;
  }

  const payload: EventMatchNudgePayload = {
    eventId,
    candidateId: candidate.user_id,
    candidateFirstName: candidate.first_name,
    score: top.score,
    message,
    rules: { maxSentences: 2, maxChars: 320 },
    anonymous: true,
  };
  // targetKey is keyed on the real people involved (eventId here is already
  // stable per-pair for the no-Luma-id case — see eventMatching.ts's
  // pickCanonicalEventId), so a re-score before this ever sends just updates
  // the same pending candidate instead of queuing a duplicate, and once
  // sent it can never be queued again for this exact pair.
  const { queued } = await enqueueCandidate({
    userId: person.user_id,
    type: "event_match_nudge",
    targetKey: `event_match_nudge:${eventId}:${candidate.user_id}`,
    topicKey: `event_match_nudge:${eventId}`,
    summary: `Heads-up that another member they'd get along with is also going to "${eventName}", no name until both say yes (score ${top.score})`,
    payload,
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });
  return queued;
}

// The additive-offer path for someone who ALREADY has a match nudge for this
// event (Royce, 2026-09-10: "we should give them the 5 people they should
// meet, but instead of just switching them in and out... add those people
// later"). newCandidates is whatever the caller determined is genuinely new
// since the last scoring pass — never touches or re-sends the original
// nudge/match, purely a "more people showed up" heads-up.
async function maybeSendAdditiveOffer(
  eventId: string,
  eventName: string,
  person: ScorableGuest,
  newCandidates: ScorableGuest[],
  eventTiming: { start_at: string; end_at: string | null } | null,
  opts: { dryRun?: boolean },
): Promise<boolean | "waiting"> {
  if (!newCandidates.length) return false;
  if (eventTiming) {
    const RM = await import("./roomMatching.js");
    const room = await RM.inRoomNow(eventId, { timing: eventTiming });
    const here = new Set(room.people.map((p) => p.user_id));
    if (!here.has(person.user_id)) return false;
    const fresh: ScorableGuest[] = [];
    for (const c of newCandidates) if (here.has(c.user_id) && !(await RM.mayAsk(eventId, person.user_id, c.user_id, "eventScoring.additiveOffer"))) fresh.push(c);
    newCandidates = fresh;
    if (!newCandidates.length) return false;
  }
  // This is strictly the in-room "more people just checked in" follow-up to
  // an already-sent live nudge, so it only makes sense with real event
  // timing to be in-room for. Without it (code review, 2026-09-17: same
  // class of bug as maybeSendMatchNudge's no-timing branch —
  // checkEventWindow(null, ...) passes trivially), skip rather than send
  // immediately outside hours/caps; there's no live-event reason to rush an
  // "even more people" follow-up, so it's fine to just wait for the next
  // scoring pass once this event does have real timing, or drop it.
  if (!eventTiming) return false;
  // Same "don't nudge before the event starts or in its last stretch" gate
  // as the original match nudge — a new arrival scored an hour before start
  // is not something to text about yet.
  const windowCheck = checkEventWindow(eventTiming, new Date());
  if (!windowCheck.pass) return false;

  if (opts.dryRun) {
    console.log(
      `[eventScoring dryRun] would send additive offer to ${person.user_id} at ${eventId} (${newCandidates.length} new candidate(s))`,
    );
    return false;
  }
  // It names no one, so it goes only when no other question about people is open or on its way to them (services/inRoomOffers.ts
  // claimOfferSlot): a bare "yes" then answers it alone. Its place is taken now, before drafting, and freed on every way out below
  // that doesn't send.
  const O = await import("./inRoomOffers.js");
  const slot = await O.claimOfferSlot({ eventId, eventName, personId: person.user_id, kind: "additive", candidateIds: newCandidates.map((c) => c.user_id) });
  if (!slot) return "waiting";
  const freeSlot = () => O.releaseOfferSlot(slot).catch((err: any) => console.error("eventScoring: freeing the additive offer's question slot failed (non-fatal):", err?.message ?? err));
  if (!(await tryClaimAdditiveOfferDebounce(eventId, person.user_id))) {
    console.log(
      `eventScoring: additive offer debounced for ${person.user_id} at ${eventId} (sent one within the last ${ADDITIVE_OFFER_DEBOUNCE_MINUTES}m)`,
    );
    await freeSlot();
    return false;
  }

  // A draft that throws frees the place too (O.draftingInSlot).
  const message = await O.draftingInSlot(slot, () => draftWithConsent(
    {
      decision: "eventScoring.additiveOffer",
      recipientId: person.user_id,
      preChecks: [windowCheck, { name: "additive_debounce", pass: true }],
      facts: { otherFirstName: "", otherOptedIn: false, recipientOptedIn: false, recipientFirstName: person.first_name },
      otherUserIds: newCandidates.map((c) => c.user_id),
      extraDraftChecks: (d) => [checkNamesWithheld(d, newCandidates.map((c) => c.first_name))],
      event: { name: eventName, ...eventTiming },
    },
    async (feedback) => {
      const { text } = await generateText({
        model: anthropic(PLAIN_DRAFT_MODEL),
        experimental_telemetry: { isEnabled: true, functionId: "eventScoring.additiveOffer.draft" },
        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${person.first_name} about "${eventName}," an event they're already going to and already have a match at. ${eventPromptLine({ name: eventName, ...eventTiming }, eventName)} Since then, ${newCandidates.length} more ${newCandidates.length === 1 ? "person has" : "people have"} checked in who could also be worth ${person.first_name} meeting.

Draft a short, warm, low-pressure text (1-2 sentences, no em dashes, normal sentence capitalization) letting them know you found ${newCandidates.length === 1 ? "someone else" : `${newCandidates.length} more people`} who just checked in that could be good for them, and ask if they want to hear who. Do NOT name anyone yet or mention their existing match. Don't say what anyone wants or said. This is just the offer to see more, nothing more. Return ONLY the message text.${feedback ? `\n\n${feedback}` : ""}`,
      });
      return cleanCoMessage(text.trim());
    },
  ));
  if (!message) {
    await freeSlot();
    return false;
  }

  // Proactive-nudge cap still applies — this is still one of today's
  // discretionary outbound texts, same as the original match nudge.
  const additiveKey = `in_room:additive:${eventId}:${Date.now()}`;
  if (!(await inRoomSendAllowed(person.user_id, eventId, { claim: { targetKey: additiveKey, message } }))) {
    console.log(`eventScoring: additive offer throttled for ${person.user_id} (in-room text limit for this event reached)`);
    await freeSlot();
    return false;
  }

  try {
    await sendblue.messages.send({
      number: person.phone_number,
      content: message,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (err: any) {
    console.error(`eventScoring: additive offer send failed for ${person.user_id} (non-fatal):`, err?.message ?? err);
    await releaseInRoomClaim(person.user_id, additiveKey);
    await freeSlot();
    return false;
  }

  await recordInRoomSend(person.user_id, additiveKey, message);
  // Who arrived lives only on the offer (services/inRoomOffers.ts), never in their notes: they haven't been told, and
  // after their yes each person is named only through the share gate (eventGuestMatchHandoff.ts handleAdditiveReply).
  await O.openOffer({ eventId, eventName, personId: person.user_id, kind: "additive", candidateIds: newCandidates.map((c) => c.user_id) }).catch((err: any) => console.error("eventScoring: opening the additive offer failed (non-fatal):", err?.message ?? err));
  await writeMemory(
    person.user_id,
    "event_guest_match_nudge",
    `Additive offer sent to ${person.first_name} at "${eventName}": ${newCandidates.length} more people checked in since their last match. Cue asked if they want to hear who; no one has been named to them.`,
  );
  await writeMemory(person.user_id, "text_exchange", `Co replied: ${message}`).catch((err: any) =>
    console.error("eventScoring: additive offer text_exchange log failed (non-fatal):", err?.message ?? err),
  );
  return true;
}

// Shared core: given a group of already-matched Co users (however that group
// was assembled — a Luma guest list, or a cluster of people who separately
// reported the same non-Co event, see eventMatching.ts), score every person
// against every OTHER person in the SAME group. Ask-based only
// (scoreAgainstStatedAsk, LLM-graded, reused as-is from matching.ts/
// relevance.ts) — no embedding-only fallback. A person with no active stated
// ask does not get ranked this pass; Co asks them for one first
// (runEventAskSolicitationAgent), and they become scoreable once/if that
// lands (their reply flows through the existing captureIntent pipeline, same
// as any other stated ask).
// A fair, fixed tiebreak between two equally strong candidates for this person: never guest-list order (whoever registered
// first won every tie), and the same answer on every pass.
export function pairOrder(personId: string, candidateId: string): number {
  let h = 2166136261;
  for (const ch of `${personId}|${candidateId}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// A room pass is about no single member: it never runs in the scope of whoever triggered it (a texter's arrival, a guest
// update). Each person's part opens its own scope inside (services/llmUsage.ts withMember).
export async function scoreMatchedGroup(...a: Parameters<typeof scoreMatchedGroupInScope>): ReturnType<typeof scoreMatchedGroupInScope> {
  return withMember(null, () => scoreMatchedGroupInScope(...a));
}
async function scoreMatchedGroupInScope(
  eventId: string,
  eventName: string,
  matched: ScorableGuest[],
  eventTiming: { start_at: string; end_at: string | null } | null,
  // requireTiming: a Co (Luma) event always has a start and end. When they couldn't be read (a Luma blip), no nudge goes
  // out this pass and none is queued anonymously in its place: the next pass sends it live.
  opts: { dryRun?: boolean; requireTiming?: boolean } = {},
): Promise<{ scoredCount: number; solicitedCount: number; matchedCount: number }> {
  if (matched.length < 2) {
    console.log(`eventScoring: ${eventId} has ${matched.length} matched Cue user(s) — nothing to rank yet`);
    return { scoredCount: 0, solicitedCount: 0, matchedCount: matched.length };
  }

  // The emergency pause (services/roomMatching.ts): no scoring, no asks, no nudges for this event while it's on.
  if (!opts.dryRun) {
    const paused = await (await import("./roomMatching.js")).matchingPause(eventId);
    if (paused) {
      console.log(`eventScoring: ${eventId} not scored: ${paused}`);
      return { scoredCount: 0, solicitedCount: 0, matchedCount: matched.length };
    }
  }
  let scoredCount = 0;
  let solicitedCount = 0;
  // Everyone's wants and offers current before the room is scored
  // (services/peopleGraph.ts). A dry run reads only what's already there.
  if (!opts.dryRun) await refreshRoom(matched.map((m) => m.user_id)).catch(() => {});
  // A frame is only asks a member marked shareable (Royce, 2026-10-12): a private ask is never anyone's frame and never a
  // reason. Someone with no shareable ask has no frame (a goal isn't one): they're asked. (Since 2026-10-18 the scorer sees a
  // candidate's private asks as a hidden signal, below.)
  const { matchableIntent } = await import("./roomMatching.js");
  // For the team (2026-10-12 audit: a room of text-only members produced zero nudges with no warning): how many guests
  // have nothing shareable, so nobody can be pointed to them. Logged on every pass; never told to a member, no email.
  const unshared = matched.filter((g) => !shareableAsks(g.intent).length);
  console.log(`eventScoring: ${eventId} has ${unshared.length} of ${matched.length} guests with no shareable ask`);
  await recordDecision({ layer: 6, decision: "match.room.unshared", userId: null, outcome: unshared.length ? "skip" : "act", action: "count", proposal: { eventId, guests: matched.length, noShareableAsk: unshared.length, ids: unshared.map((g) => g.user_id) }, reason: unshared.length ? `${unshared.length} of ${matched.length} guests have no shareable ask: nobody can be pointed to them` : null }).catch(() => {});
  // Their private asks come back to the scorer only as each candidate's hidden part (Royce, 2026-10-18: a hidden signal on
  // every matching path, rooms included; never mentioned, never cited, never a match's only basis, services/matching.ts).
  // Kept apart from the guests themselves, so nothing after scoring ever reads them.
  const { privateAskTexts } = await import("./matching.js");
  const hiddenAsks = new Map(matched.map((g) => [g.user_id, privateAskTexts(g.intent)] as const));
  const room = matched.map((g) => ({ ...g, intent: matchableIntent(g.intent) }));
  matched = room;
  // Co's read of which asks are about people (services/peopleAsks.ts), for the whole room in one call; each person's frame
  // below reads it from the cache. It holds every guest's asks, so it runs under nobody's trace-text mark, never the mark of
  // whoever's turn started the pass (a mention in their message, profileExtraction -> eventMatching).
  {
    const { readPeopleAsks, askLine } = await import("./peopleAsks.js");
    const texts = [...new Set(matched.flatMap((g) => (Array.isArray(g.intent) ? (g.intent as any[]) : []).filter((e) => isOpenAsk(e)).map(askLine)))];
    if (texts.length) await withTraceUser(null, () => readPeopleAsks(texts)).catch(() => []);
  }
  // Each person's pass is theirs in llm_usage (their frame, solicitation, nudges); the room-level work around it belongs to no one.
  for (const person of matched) await withMember(person.user_id, async () => {
    const others = matched.filter((m) => m.user_id !== person.user_id);
    // What they said they're looking for or can offer decides who they're scored against; asks write the specific reason (a
    // candidate's own ask is the share reason). Someone with only an OFFERING ("climate hardware founders to back at seed") is
    // scored against it too (2026-10-07): it names who they're there for. A goal never picks who they're scored against on its own
    // (Royce, 2026-10-18: "What we know about a member shapes how, never which helper"): someone with only goals is asked what
    // they'd like from the room, like anyone with no ask.
    const ask = getActiveSeekingAsk(person.intent) ?? getActiveOfferingAsk(person.intent);
    // What they're scored on (services/matching.ts roomFrame, 2026-10-12 audit): every open people-shaped ask, both
    // directions, de-duplicated, errands left out, their goal riding along as where they're headed. No ask about people (only
    // errands, or nothing): nothing to judge a room by, so they're asked what they'd like from it, like someone with no ask.
    // Under this person's mark: on a cache miss it reads their own asks again.
    const frame: RoomFrame | null = ask?.text ? await withTraceUser(person.user_id, () => roomFrame(person.intent)) : null;

    if (!frame) {
      if (await wasRecentlySolicited(eventId, person.user_id)) {
        return; // already asked within the cooldown window — wait for a reply or the next window
      }
      const { sent: solicitationSent } = await withTraceUser(person.user_id, () =>
        runEventAskSolicitationAgent(
          { userId: person.user_id, firstName: person.first_name, phoneNumber: person.phone_number },
          eventName,
          opts,
          eventTiming?.end_at ?? null,
        ),
      ).catch((err: any) => {
        console.error(`eventScoring: ask solicitation failed for ${person.user_id} (non-fatal):`, err?.message ?? err);
        return { sent: false };
      });
      // Only starts the 3-day cooldown on an actual send — a throttled
      // attempt (see the Layer 7 send caps) isn't a
      // real ask, and shouldn't cost this person 3 days of silence for it.
      // The next scoring pass (e.g. the next guest.updated) retries normally.
      if (solicitationSent) {
        await markSolicited(eventId, person.user_id);
        solicitedCount++;
      }
      return;
    }

    const askerContextParts = [
      goalTexts(person.intent, person.goals).length ? `goals: ${goalTexts(person.intent, person.goals).join(", ")}` : null,
      person.blockers?.length ? `blockers: ${person.blockers.join(", ")}` : null,
    ].filter((p): p is string => Boolean(p));
    const edges = await roomEdges(person.user_id, others.map((o) => o.user_id)).catch(() => new Map<string, Edge>());
    const hints = new Map<string, string>();
    for (const [id, e] of edges) {
      const h = edgeHint(e);
      if (h) hints.set(id, h);
    }
    // This person's scoring and drafts under their own trace-text mark (services/llmTraceText.ts).
    // A scorer failure is not "nobody fits" (lifted from #216's review): their last ranking stays as it was (it is the basis for the
    // additive offer, so an empty one stored here made everyone look newly arrived next pass), nothing is decided or sent for them
    // this pass, and the next room pass (an arrival, a Luma update, the start-time retry) scores them again.
    const scored = await withTraceUser(person.user_id, () =>
      scoreAgainstRoomFrame(
        frame,
        others,
        askerContextParts.length ? askerContextParts.join("; ") : undefined,
        hints,
        hiddenAsks,
        { askerFirstName: person.first_name, failLoudly: true },
      ),
    ).catch((err: any) => {
      if (err?.name !== "ScoringFailed") throw err;
      recordDecision({ layer: 6, decision: "match.score", userId: person.user_id, outcome: "skip", action: "eventScoring.score", proposal: { eventId }, checks: [{ name: "scorer_answered", pass: false, reason: "the scorer failed; ranking kept, scored again next pass" }] }).catch(() => {});
      return null;
    });
    if (!scored) return;
    const ranked: RankedCandidate[] = scored
      .map((s) => {
        const e = edges.get(s.candidate.user_id);
        return {
          candidate_id: s.candidate.user_id,
          score: s.score,
          reason: s.reason,
          shareReason: s.shareReason,
          mutual: s.mutual,
          method: "ask" as const,
          graph: e ? { score: e.score, want: e.want, offer: e.offer, mutual: e.mutual } : null,
        };
      })
      .sort((a, b) => b.score - a.score || Number(b.mutual) - Number(a.mutual) || pairOrder(person.user_id, a.candidate_id) - pairOrder(person.user_id, b.candidate_id));

    // Read BEFORE storeRanking overwrites the row — this is the diff basis
    // for the additive-offer path below.
    const previouslyRankedIds = await getPreviousRankedCandidateIds(eventId, person.user_id);
    await storeRanking(eventId, person.user_id, ranked, `asks: ${frame.asks.map((a) => `"${a.text}"`).join(" / ") || "(none about people)"}${frame.goal ? `; goal: "${frame.goal.text}"` : ""}`);
    scoredCount++;

    const alreadyNudged = await wasAlreadyNudgedForMatch(eventId, person.user_id);
    const top = ranked[0];
    const topCandidate = top ? others.find((o) => o.user_id === top.candidate_id) : undefined;
    if (top && topCandidate && !alreadyNudged) {
      // Down the ranking (2026-10-07): when the strongest match can't be described (no shareable ask, or the share gate
      // says no), the next strong one is tried, up to five. Only while a live send is actually possible right now; otherwise
      // the top one alone goes through the usual path (and its window/queue rules).
      const live = !!eventTiming && checkEventWindow(eventTiming, new Date()).pass && (await inRoomSendAllowed(person.user_id, eventId));
      const tries = live ? ranked.filter((r) => r.score >= MATCH_NUDGE_MIN_SCORE).slice(0, 5) : [top];
      for (const r of tries) {
        const cand = others.find((o) => o.user_id === r.candidate_id);
        if (!cand || (live && !r.shareReason)) continue;
            const sent = await withTraceUser(person.user_id, () => maybeSendMatchNudge(eventId, eventName, person, r, cand, eventTiming, opts)).catch((err: any) => {
          console.error(`eventScoring: maybeSendMatchNudge failed for ${person.user_id} (non-fatal):`, err?.message ?? err);
          return false;
        });
        if (sent || (await wasAlreadyNudgedForMatch(eventId, person.user_id))) break;
      }
    } else if (alreadyNudged) {
      // Never silently swap or replace an existing match (Royce, 2026-09-10)
      // — anyone newly qualifying who wasn't in the previous pass's ranking
      // gets offered as a separate, additive heads-up instead.
      const newCandidates = ranked
        // Only someone Cue could name if they say yes: an offer whose reveal has no share reason is never made (review of #245).
        .filter((r) => r.score >= MATCH_NUDGE_MIN_SCORE && !!r.shareReason && !previouslyRankedIds.has(r.candidate_id))
        .map((r) => others.find((o) => o.user_id === r.candidate_id))
        .filter((c): c is ScorableGuest => Boolean(c));
      if (newCandidates.length) {
        const r = await withTraceUser(person.user_id, () => maybeSendAdditiveOffer(eventId, eventName, person, newCandidates, eventTiming, opts)).catch((err: any) => {
          console.error(`eventScoring: maybeSendAdditiveOffer failed for ${person.user_id} (non-fatal):`, err?.message ?? err);
          return false;
        });
        // Waiting on their other open question: they stay new for the next pass, so the heads-up isn't lost.
        if (r === "waiting") {
          const waiting = new Set(newCandidates.map((c) => c.user_id));
          await storeRanking(eventId, person.user_id, ranked.map((x) => (waiting.has(x.candidate_id) ? { ...x, additivePending: true } : x)), `asks: ${frame.asks.map((a) => `"${a.text}"`).join(" / ") || "(none about people)"}${frame.goal ? `; goal: "${frame.goal.text}"` : ""}`);
        }
      }
    }
  });

  return { scoredCount, solicitedCount, matchedCount: matched.length };
}

// eventName isn't always available to the caller (guest.registered/
// guest.updated webhook payloads carry guest data, not necessarily the
// event's own name) — fall back to looking it up rather than fail.
//
// Real gap found live, 2026-09-07: a brand-new event's first
// guest.registered webhook can fire before Luma's own list endpoint
// (/v1/calendars/events/list, what listCalendarEvents scans) has caught up
// to include it yet, silently falling all the way through to the generic
// "the event" and shipping a real nudge text that named the wrong thing.
// getEventDetails hits Luma's single-event GET (/v1/event/get) directly by
// id instead of scanning a list for it — same endpoint already preferred
// elsewhere in this file for exactly this reliability reason (see its own
// comment in services/luma.ts) — so try that first and only fall back to
// the list scan if it comes back empty.
async function resolveEventName(
  eventId: string,
  providedName?: string,
  prefetchedDetails?: LumaEventDetail | null,
): Promise<string> {
  if (providedName) return providedName;
  const details = prefetchedDetails !== undefined ? prefetchedDetails : await getEventDetails(eventId).catch(() => null);
  if (details?.name) return details.name;
  const events = await listCalendarEvents().catch(() => []);
  return events.find((e) => e.api_id === eventId)?.name ?? "the event";
}

// Entry point for the Luma-guest-list-driven path — pulls the live guest
// list, matches it to Co users, hands off to the shared scoring core.
//
// Known gap, now closed: this used to only re-run on the event.created
// webhook. It's now also called from guest.registered/guest.updated (see
// routes/luma.ts) so someone solicited for an ask actually gets picked back
// up once they reply, instead of being solicited once and never re-scored.
// A room pass is about no single member: it never runs in the scope of whoever triggered it (a texter's arrival, a guest
// update). Each person's part opens its own scope inside (services/llmUsage.ts withMember).
export async function scoreGuestListForEvent(...a: Parameters<typeof scoreGuestListForEventInScope>): ReturnType<typeof scoreGuestListForEventInScope> {
  return withMember(null, () => scoreGuestListForEventInScope(...a));
}
async function scoreGuestListForEventInScope(
  eventId: string,
  eventName?: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ scoredCount: number; solicitedCount: number; matchedCount: number; debounced?: true }> {
  if (!(await tryClaimScoringDebounce(eventId))) {
    console.log(`eventScoring: ${eventId} scored within the last ${SCORING_DEBOUNCE_SECONDS}s — skipping duplicate pass`);
    return { scoredCount: 0, solicitedCount: 0, matchedCount: 0, debounced: true };
  }

  // One reader of an event's timing (services/roomMatching.ts eventTiming), test events included; Luma's guest list for Co's
  // own events, the test roster for a fictional one.
  const RM = await import("./roomMatching.js");
  const test = RM.isTestEvent(eventId);
  const [guests, details] = await Promise.all([
    test ? Promise.resolve(undefined) : getEventGuestList(eventId),
    test ? RM.eventTiming(eventId).then((t) => (t ? ({ ...t, location: null, url: null } as LumaEventDetail) : null)) : getEventDetails(eventId).catch(() => null),
  ]);
  const resolvedName = await resolveEventName(eventId, eventName, details);
  // Two sources feed the same guest pool now: Luma's real guest list, and
  // anyone who checked in via the day-of QR flow without ever RSVPing on
  // Luma (services/eventWalkinCheckin.ts). Deduped by user_id — a
  // Luma-registered guest who also scans the QR should still only be scored
  // once per pass.
  // One pool (inRoomPool, above): approved Luma guests plus walk-ins Co has seen arrive, never archived, opted-out
  // or not-going members. A walk-in failure leaves the Luma guests.
  const matched = await inRoomPool(eventId, guests).catch(async (err: any) => {
    console.error(`eventScoring: inRoomPool failed for ${eventId} (non-fatal):`, err?.message ?? err);
    return [] as ScorableGuest[];
  });
  // A missing end_at gets the end of that evening (introConsent.ts effectiveEnd), so the window and wrap-up still close.
  const eventTiming = details ? withEnd({ start_at: details.start_at, end_at: details.end_at, timezone: details.timezone ?? null }) : null;
  // The durable end-of-night job for this room (services/roomMatching.ts runRoomCloses).
  if (!opts.dryRun) await RM.scheduleRoomClose(eventId, resolvedName, eventTiming).catch(() => {});

  // End-of-night check-in (Notion V1 board row 8) — gated on registration
  // (matched, above) + the event's real end_at, not a Luma check-in signal
  // (Royce, 2026-09-07: Luma's API has no way to ever set check-in status,
  // making that gate both untestable and unreliable for anyone who
  // genuinely attended but didn't check in on Luma itself). Every
  // registered/updated pass is a fine moment to (re-)schedule this — the
  // underlying INSERT is idempotent (ON CONFLICT DO NOTHING). Fire-and-
  // forget: a failure here shouldn't block the scoring pass itself, same
  // reasoning as every other non-fatal side effect in this webhook path.
  detectAndScheduleCheckins(eventId, resolvedName, matched, opts).catch((err: any) =>
    console.error(`eventScoring: detectAndScheduleCheckins failed for ${eventId} (non-fatal):`, err?.message ?? err),
  );
  // "No one should feel left out" (Royce, 2026-09-22) — same idempotent,
  // fire-and-forget reasoning as detectAndScheduleCheckins above.
  scheduleUnmatchedFollowUp(eventId, resolvedName, matched, eventTiming, opts).catch((err: any) =>
    console.error(`eventScoring: scheduleUnmatchedFollowUp failed for ${eventId} (non-fatal):`, err?.message ?? err),
  );

  return scoreMatchedGroup(eventId, resolvedName, matched, eventTiming, { ...opts, requireTiming: true });
}

// Exported so evals/intro can run the exact production prompt.
export function matchNudgePrompt(p: { recipientFirstName: string; otherFirstName: string; eventName: string; shareReason: string; feedback: string | null; event?: IntroEvent | null }): string {
  return `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${p.recipientFirstName} about "${p.eventName}," an event they're going to. ${eventPromptLine(p.event, p.eventName)} You found someone else going who's genuinely worth them meeting: ${p.otherFirstName}. Why they're worth meeting: ${p.shareReason}

Draft a short, warm, low-pressure text (1-2 sentences, no em dashes, normal sentence capitalization) letting ${p.recipientFirstName} know about ${p.otherFirstName} and naming the real reason above in your own words. Use only that reason. Never say ${p.otherFirstName} wants to meet them, mentioned them, or said anything about them. Not a hard sell, just a genuine heads-up, like a friend connecting two people who'd get along. Return ONLY the message text.${p.feedback ? `\n\n${p.feedback}` : ""}`;
}

// A heads-up about an event Co doesn't run (2026-09-23): no name, only why
// they'd get along, and a question. Exported for evals/intro.
export function anonymousHeadsUpPrompt(p: { recipientFirstName: string; eventName: string; shareReason: string; feedback: string | null; event?: IntroEvent | null }): string {
  return `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${p.recipientFirstName} about "${p.eventName}," an event they told you they're going to. ${eventPromptLine(p.event, p.eventName)} Another member of the club is going too and seems worth meeting. Why: ${p.shareReason}

Draft a short, warm text (1-2 sentences, no em dashes, normal sentence capitalization) that says another member is also going, gives that reason in your own words without anything that would identify who it is (no name, company, or title), and asks if they'd like an intro. Say you'll share who it is once you've checked with them too. Never say the other person wants to meet them or said anything about them. Return ONLY the message text.${p.feedback ? `\n\n${p.feedback}` : ""}`;
}
