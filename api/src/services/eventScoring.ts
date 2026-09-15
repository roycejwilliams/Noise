import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { runEventAskSolicitationAgent } from "../agent/eventAskSolicitation.js";
import { getEventDetails, getEventGuestList, listCalendarEvents, type LumaGuest, type LumaEventDetail } from "./luma.js";
import { getActiveAsks, getActiveSeekingAsk, scoreAgainstStatedAsk } from "./matching.js";
import { detectAndScheduleCheckins } from "./eventCheckinFollowUp.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { tryClaimProactiveNudge } from "./proactiveThrottle.js";
import { writeMemory } from "./memory.js";
import { mergeWalkinsIntoGuestPool } from "./eventWalkinCheckin.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";
import { checkEventWindow, checkNamesWithheld, checkOneNudgePerEvent, draftWithConsent, eventOptedIn } from "../harness/introConsent.js";
import { gateShareReason } from "../harness/matchGate.js";

// Model policy (Royce, 2026-09-14): a draft that names another person is
// Sonnet 5; the additive offer names no one (checked in code) and stays Haiku.
const NAMING_DRAFT_MODEL = "claude-sonnet-5";
const PLAIN_DRAFT_MODEL = "claude-haiku-4-5-20251001";

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
  const phones = guests.map((g) => g.phone).filter((p): p is string => Boolean(p));
  const emails = guests.map((g) => g.email?.toLowerCase()).filter((e): e is string => Boolean(e));
  if (!phones.length && !emails.length) return [];

  const { rows } = await pool.query(
    `SELECT cp.user_id, u.first_name, u.phone_number, u.email, cp.city, cp.goals, cp.blockers, cp.activity_preferences, cp.intent
     FROM co_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE (u.phone_number = ANY($1::text[]) OR LOWER(u.email) = ANY($2::text[]))
       AND coalesce(u.sms_opted_out, false) = false`,
    [phones, emails],
  );
  return rows;
}

// A person could plausibly show up in both sources in the same pass — a
// Luma-registered guest who also scans the venue QR and checks in. Keep one
// entry per user_id (first one wins; both sources carry the same underlying
// co_profiles row anyway, so there's nothing to merge) rather than scoring
// the same person twice against everyone else in scoreMatchedGroup below.
function dedupeByUserId(guests: ScorableGuest[]): ScorableGuest[] {
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
// Same atomic claim-before-act pattern as proactiveThrottle.ts's
// tryClaimProactiveNudge (a plain check-then-write would let two near-
// simultaneous webhooks both read "not scored recently" before either had
// written its claim). Short window — this is only meant to coalesce near-
// duplicate signals for the SAME action, not throttle genuinely distinct
// guest registrations, which are vanishingly unlikely to land within
// seconds of each other in practice; even if they did, nothing is lost,
// just picked up on the next trigger.
const SCORING_DEBOUNCE_SECONDS = 15;

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
async function getPreviousRankedCandidateIds(eventId: string, personId: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT ranked_candidates FROM event_guest_rankings WHERE event_id = $1 AND person_id = $2`,
    [eventId, personId],
  );
  const prior = rows[0]?.ranked_candidates as RankedCandidate[] | undefined;
  return new Set((prior ?? []).map((c) => c.candidate_id));
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
const MATCH_NUDGE_MIN_SCORE = 60;

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


async function wasAlreadyNudgedForMatch(eventId: string, personId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM event_guest_match_nudges WHERE event_id = $1 AND person_id = $2`,
    [eventId, personId],
  );
  return rows.length > 0;
}

async function markMatchNudgeSent(eventId: string, personId: string, candidateId: string, score: number): Promise<void> {
  await pool
    .query(
      `INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, person_id) DO NOTHING`,
      [eventId, personId, candidateId, score],
    )
    .catch((err: any) => console.error("markMatchNudgeSent: insert failed (non-fatal):", err?.message ?? err));
}

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
  opts: { dryRun?: boolean },
): Promise<boolean> {
  if (top.score < MATCH_NUDGE_MIN_SCORE) return false;
  // Privacy (2026-09-14): top.reason comes from the candidate's private
  // profile + memories. Without a shareable reason there's nothing we can
  // honestly tell this person, so no nudge.
  if (!top.shareReason) return false;

  // Consent harness (harness/introConsent.ts): event window and one nudge
  // per event are hard checks; eventTiming is null only for the non-Luma
  // self-reported path (eventMatching.ts), where there's no live window.
  const preChecks = [
    checkOneNudgePerEvent(await wasAlreadyNudgedForMatch(eventId, person.user_id)),
    checkEventWindow(eventTiming, new Date()),
  ];
  if (preChecks.some((c) => !c.pass)) return false;
  if (!(await gateShareReason(person.user_id, candidate.user_id, top.shareReason, "eventScoring.matchNudge"))) return false;

  if (opts.dryRun) {
    console.log(
      `[eventScoring dryRun] would nudge ${person.user_id} about ${candidate.user_id} at ${eventId} (score ${top.score})`,
    );
    return false;
  }

  const candidateOptedIn = await eventOptedIn(eventId, candidate.user_id, person.user_id);
  const message = await draftWithConsent(
    {
      decision: "eventScoring.matchNudge",
      recipientId: person.user_id,
      preChecks,
      facts: {
        otherFirstName: candidate.first_name,
        otherOptedIn: candidateOptedIn,
        recipientOptedIn: false,
        recipientFirstName: person.first_name,
        otherStatedAsks: getActiveAsks(candidate.intent),
        otherPhone: candidate.phone_number,
        otherEmail: candidate.email,
      },
    },
    async (feedback) => {
      const { text } = await generateText({
        model: anthropic(NAMING_DRAFT_MODEL),
        experimental_telemetry: { isEnabled: true, functionId: "eventScoring.matchNudge.draft" },
        prompt: matchNudgePrompt({ recipientFirstName: person.first_name, otherFirstName: candidate.first_name, eventName, shareReason: top.shareReason!, feedback }),
      });
      return cleanCoMessage(text.trim());
    },
  );
  if (!message) return false;

  if (!(await tryClaimProactiveNudge(person.user_id))) {
    console.log(`eventScoring: match nudge throttled for ${person.user_id} (proactive nudge used elsewhere in last 24h)`);
    return false;
  }

  try {
    await sendblue.messages.send({
      number: person.phone_number,
      content: message,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (err: any) {
    console.error(`eventScoring: match nudge send failed for ${person.user_id} (non-fatal):`, err?.message ?? err);
    return false;
  }

  await markMatchNudgeSent(eventId, person.user_id, candidate.user_id, top.score);
  await writeMemory(
    person.user_id,
    "event_guest_match_nudge",
    `Nudged ${person.first_name} that ${candidate.first_name} is also going to "${eventName}" and worth meeting: ${top.shareReason} (score ${top.score})`,
  );
  // Royce, 2026-09-08 sweep — the descriptive log above is a summary, not
  // the actual text sent, so recentConversation (routes/sendblue.ts, which
  // only reads text_exchange rows) never saw this message either.
  await writeMemory(person.user_id, "text_exchange", `Co replied: ${message}`).catch((err: any) =>
    console.error("eventScoring: match nudge text_exchange log failed (non-fatal):", err?.message ?? err),
  );
  return true;
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
): Promise<boolean> {
  if (!newCandidates.length) return false;
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
  if (!(await tryClaimAdditiveOfferDebounce(eventId, person.user_id))) {
    console.log(
      `eventScoring: additive offer debounced for ${person.user_id} at ${eventId} (sent one within the last ${ADDITIVE_OFFER_DEBOUNCE_MINUTES}m)`,
    );
    return false;
  }

  const message = await draftWithConsent(
    {
      decision: "eventScoring.additiveOffer",
      recipientId: person.user_id,
      preChecks: [windowCheck, { name: "additive_debounce", pass: true }],
      facts: { otherFirstName: "", otherOptedIn: false, recipientOptedIn: false, recipientFirstName: person.first_name },
      extraDraftChecks: (d) => [checkNamesWithheld(d, newCandidates.map((c) => c.first_name))],
    },
    async (feedback) => {
      const { text } = await generateText({
        model: anthropic(PLAIN_DRAFT_MODEL),
        experimental_telemetry: { isEnabled: true, functionId: "eventScoring.additiveOffer.draft" },
        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${person.first_name} about "${eventName}," an event they're already going to and already have a match at. Since then, ${newCandidates.length} more ${newCandidates.length === 1 ? "person has" : "people have"} checked in who could also be worth ${person.first_name} meeting.

Draft a short, warm, low-pressure text (1-2 sentences, no exclamation points, no em dashes, normal sentence capitalization) letting them know you found ${newCandidates.length === 1 ? "someone else" : `${newCandidates.length} more people`} who just checked in that could be good for them, and ask if they want to hear who. Do NOT name anyone yet or mention their existing match. Don't say what anyone wants or said. This is just the offer to see more, nothing more. Return ONLY the message text.${feedback ? `\n\n${feedback}` : ""}`,
      });
      return cleanCoMessage(text.trim());
    },
  );
  if (!message) return false;

  // Proactive-nudge cap still applies — this is still one of today's
  // discretionary outbound texts, same as the original match nudge.
  if (!(await tryClaimProactiveNudge(person.user_id))) {
    console.log(`eventScoring: additive offer throttled for ${person.user_id} (proactive nudge used elsewhere in last 24h)`);
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
    return false;
  }

  await writeMemory(
    person.user_id,
    "event_guest_match_nudge",
    `Additive offer sent to ${person.first_name} at "${eventName}": ${newCandidates.length} new candidate(s) checked in since their last match (${newCandidates.map((c) => c.first_name).join(", ")})`,
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
export async function scoreMatchedGroup(
  eventId: string,
  eventName: string,
  matched: ScorableGuest[],
  eventTiming: { start_at: string; end_at: string | null } | null,
  opts: { dryRun?: boolean } = {},
): Promise<{ scoredCount: number; solicitedCount: number; matchedCount: number }> {
  if (matched.length < 2) {
    console.log(`eventScoring: ${eventId} has ${matched.length} matched Co user(s) — nothing to rank yet`);
    return { scoredCount: 0, solicitedCount: 0, matchedCount: matched.length };
  }

  let scoredCount = 0;
  let solicitedCount = 0;
  for (const person of matched) {
    const others = matched.filter((m) => m.user_id !== person.user_id);
    const ask = getActiveSeekingAsk(person.intent);

    if (!ask?.text) {
      if (await wasRecentlySolicited(eventId, person.user_id)) {
        continue; // already asked within the cooldown window — wait for a reply or the next window
      }
      const { sent: solicitationSent } = await runEventAskSolicitationAgent(
        { userId: person.user_id, firstName: person.first_name, phoneNumber: person.phone_number },
        eventName,
        opts,
      ).catch((err: any) => {
        console.error(`eventScoring: ask solicitation failed for ${person.user_id} (non-fatal):`, err?.message ?? err);
        return { sent: false };
      });
      // Only starts the 3-day cooldown on an actual send — a throttled
      // attempt (see proactiveThrottle.ts's shared daily nudge cap) isn't a
      // real ask, and shouldn't cost this person 3 days of silence for it.
      // The next scoring pass (e.g. the next guest.updated) retries normally.
      if (solicitationSent) {
        await markSolicited(eventId, person.user_id);
        solicitedCount++;
      }
      continue;
    }

    const askerContextParts = [
      person.goals?.length ? `goals: ${person.goals.join(", ")}` : null,
      person.blockers?.length ? `blockers: ${person.blockers.join(", ")}` : null,
    ].filter((p): p is string => Boolean(p));
    const scored = await scoreAgainstStatedAsk(
      ask,
      others,
      askerContextParts.length ? askerContextParts.join("; ") : undefined,
    );
    const ranked: RankedCandidate[] = scored
      .map((s) => ({
        candidate_id: s.candidate.user_id,
        score: s.score,
        reason: s.reason,
        shareReason: s.shareReason,
        mutual: s.mutual,
        method: "ask" as const,
      }))
      .sort((a, b) => b.score - a.score);

    // Read BEFORE storeRanking overwrites the row — this is the diff basis
    // for the additive-offer path below.
    const previouslyRankedIds = await getPreviousRankedCandidateIds(eventId, person.user_id);
    await storeRanking(eventId, person.user_id, ranked, `ask: "${ask.text}"`);
    scoredCount++;

    const alreadyNudged = await wasAlreadyNudgedForMatch(eventId, person.user_id);
    const top = ranked[0];
    const topCandidate = top ? others.find((o) => o.user_id === top.candidate_id) : undefined;
    if (top && topCandidate && !alreadyNudged) {
      await maybeSendMatchNudge(eventId, eventName, person, top, topCandidate, eventTiming, opts).catch((err: any) =>
        console.error(`eventScoring: maybeSendMatchNudge failed for ${person.user_id} (non-fatal):`, err?.message ?? err),
      );
    } else if (alreadyNudged) {
      // Never silently swap or replace an existing match (Royce, 2026-09-10)
      // — anyone newly qualifying who wasn't in the previous pass's ranking
      // gets offered as a separate, additive heads-up instead.
      const newCandidates = ranked
        .filter((r) => r.score >= MATCH_NUDGE_MIN_SCORE && !previouslyRankedIds.has(r.candidate_id))
        .map((r) => others.find((o) => o.user_id === r.candidate_id))
        .filter((c): c is ScorableGuest => Boolean(c));
      if (newCandidates.length) {
        await maybeSendAdditiveOffer(eventId, eventName, person, newCandidates, eventTiming, opts).catch((err: any) =>
          console.error(`eventScoring: maybeSendAdditiveOffer failed for ${person.user_id} (non-fatal):`, err?.message ?? err),
        );
      }
    }
  }

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
export async function scoreGuestListForEvent(
  eventId: string,
  eventName?: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ scoredCount: number; solicitedCount: number; matchedCount: number }> {
  if (!(await tryClaimScoringDebounce(eventId))) {
    console.log(`eventScoring: ${eventId} scored within the last ${SCORING_DEBOUNCE_SECONDS}s — skipping duplicate pass`);
    return { scoredCount: 0, solicitedCount: 0, matchedCount: 0 };
  }

  const [guests, details] = await Promise.all([
    getEventGuestList(eventId),
    getEventDetails(eventId).catch(() => null),
  ]);
  const resolvedName = await resolveEventName(eventId, eventName, details);
  // Two sources feed the same guest pool now: Luma's real guest list, and
  // anyone who checked in via the day-of QR flow without ever RSVPing on
  // Luma (services/eventWalkinCheckin.ts). Deduped by user_id — a
  // Luma-registered guest who also scans the QR should still only be scored
  // once per pass.
  const [lumaMatched, walkinMatched] = await Promise.all([
    matchGuestsToUsers(guests),
    mergeWalkinsIntoGuestPool(eventId).catch((err: any) => {
      console.error(`eventScoring: mergeWalkinsIntoGuestPool failed for ${eventId} (non-fatal):`, err?.message ?? err);
      return [];
    }),
  ]);
  const matched = dedupeByUserId([...lumaMatched, ...walkinMatched]);
  const eventTiming = details ? { start_at: details.start_at, end_at: details.end_at } : null;

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

  return scoreMatchedGroup(eventId, resolvedName, matched, eventTiming, opts);
}

// Exported so evals/intro can run the exact production prompt.
export function matchNudgePrompt(p: { recipientFirstName: string; otherFirstName: string; eventName: string; shareReason: string; feedback: string | null }): string {
  return `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${p.recipientFirstName} about "${p.eventName}," an event they're going to. You found someone else going who's genuinely worth them meeting: ${p.otherFirstName}. Why they're worth meeting: ${p.shareReason}

Draft a short, warm, low-pressure text (1-2 sentences, no exclamation points, no em dashes, normal sentence capitalization) letting ${p.recipientFirstName} know about ${p.otherFirstName} and naming the real reason above in your own words. Use only that reason. Never say ${p.otherFirstName} wants to meet them, mentioned them, or said anything about them. Not a hard sell, just a genuine heads-up, like a friend connecting two people who'd get along. Return ONLY the message text.${p.feedback ? `\n\n${p.feedback}` : ""}`;
}
