import pool from "../db/db.js";
import { runEventAskSolicitationAgent } from "../agent/eventAskSolicitation.js";
import { getEventGuestList, listCalendarEvents, type LumaGuest } from "./luma.js";
import { getActiveSeekingAsk, scoreAgainstStatedAsk } from "./matching.js";
import { detectAndScheduleCheckins } from "./eventCheckinFollowUp.js";

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
     WHERE u.phone_number = ANY($1::text[]) OR LOWER(u.email) = ANY($2::text[])`,
    [phones, emails],
  );
  return rows;
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
        mutual: s.mutual,
        method: "ask" as const,
      }))
      .sort((a, b) => b.score - a.score);

    await storeRanking(eventId, person.user_id, ranked, `ask: "${ask.text}"`);
    scoredCount++;
  }

  return { scoredCount, solicitedCount, matchedCount: matched.length };
}

// eventName isn't always available to the caller (guest.registered/
// guest.updated webhook payloads carry guest data, not necessarily the
// event's own name) — fall back to looking it up rather than fail. Small
// list (one calendar's worth of events), so a linear find is fine.
async function resolveEventName(eventId: string, providedName?: string): Promise<string> {
  if (providedName) return providedName;
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

  const [guests, resolvedName] = await Promise.all([
    getEventGuestList(eventId),
    resolveEventName(eventId, eventName),
  ]);
  const matched = await matchGuestsToUsers(guests);

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

  return scoreMatchedGroup(eventId, resolvedName, matched, opts);
}
