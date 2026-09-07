import pool from "../db/db.js";
import { getTieredRecommendation, checkForUrgentMatch, type TierMatch } from "./tieredRecommendation.js";
import { runEventDiscoverySurfacingAgent } from "../agent/eventDiscoverySurfacing.js";
import { generateEmbedding } from "./embeddings.js";
import { scheduleOutcomeFollowUp, getTierBias } from "./recommendationOutcome.js";

export type SurfacingCandidate = {
  // ask_checkins.id — NOT the same as userId. A user can have more than one
  // open ask at once (ask_checkins is UNIQUE(user_id, ask_id), not
  // per-user), so the event backlog is scoped by this, not just userId —
  // see the note on event_backlogs in migrations.ts (2026-08-30 code
  // review fix: a shared per-user backlog let one ask's queued matches get
  // silently consumed by a completely different ask's turn in the same
  // cron cycle).
  askId: string;
  userId: string;
  firstName: string;
  phoneNumber: string;
  askText: string;
  city: string | null;
  goals: string[] | null;
  activityPreferences: string[] | null;
  // Whether the normal 3-day cadence has cleared for this ask (see
  // jobs/index.ts). false means only the cheap urgent pre-check below runs —
  // the full tiered engine (and its Tier 3 cost) waits for the real cycle.
  cooldownCleared: boolean;
};

// How long an unanswered tease stays "open" before Co treats it as
// abandoned. Referenced by sendblue.ts's pending-offer lookup too — a reply
// classifier shouldn't be trying to resolve a tease from three weeks ago
// either. Gap closed 2026-08-30 (Royce): previously there was no expiry at
// all, so an ignored tease sat open forever.
export const EVENT_OFFER_EXPIRY_DAYS = 7;

// "People don't want to get notified about an event every day" (Royce,
// 2026-08-30) — the 3-day cadence in jobs/index.ts already stops Co pinging
// too OFTEN, but did nothing to stop it re-surfacing the SAME event/
// opportunity every cycle just because it's still the best tiered match
// (e.g. a Co event three weeks out stays the top hit for weeks straight).
// This checks whether this exact match was already offered before, keyed by
// event_api_id for Tier 1/2 (a real event) or by name for Tier 3 (no stable
// id). Permanent, not a cooldown window — once told about a specific thing,
// re-telling them in 3/6/9 days adds nothing; the tiered engine re-running
// every cycle is what surfaces something genuinely NEW instead.
//
// Tier 3 dedup is fuzzy, not exact (Royce, 2026-08-30) — the same real
// accelerator/fellowship can get phrased differently across two separate X
// posts in two different sweep cycles ("YC W27" vs. "Y Combinator's Winter
// 2027 batch"), and an exact string match on `name` would miss that,
// letting the same underlying opportunity slip past dedup under a different
// name. Tier 1/2 don't have this problem — they key off a stable
// event_api_id — so only Tier 3 pays the embedding-comparison cost.
const OPPORTUNITY_IDENTITY_THRESHOLD = 0.88;

// Stored embeddings, not recomputed every check (Royce, 2026-08-30 code
// review fix) — this used to regenerate an embedding for every past Tier 3
// opportunity name on every single dedup check, every day the sweep ran,
// for every user with any Tier 3 history: pure recomputation of values that
// never change. tier3_offered_opportunities (migrations.ts) stores each
// offered opportunity's embedding once, at offer time (see the INSERT in
// attemptEventSurfacing below), so this now computes exactly ONE fresh
// embedding — the new candidate's — and lets pgvector's <=> compare it
// against everything past in a single query, the same pattern
// eventMatching.ts already uses for real events instead of JS-side cosine
// comparison.
async function alreadyOfferedTier3(userId: string, name: string): Promise<boolean> {
  const newEmbedding = await generateEmbedding(name).catch((err: any) => {
    console.error("alreadyOfferedTier3: generateEmbedding failed (non-fatal, treating as not-a-repeat):", err?.message ?? err);
    return null;
  });
  if (!newEmbedding) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM tier3_offered_opportunities
     WHERE user_id = $1
       AND 1 - (embedding <=> $2::vector) >= $3
     LIMIT 1`,
    [userId, `[${newEmbedding.join(",")}]`, OPPORTUNITY_IDENTITY_THRESHOLD],
  );
  return rows.length > 0;
}

async function alreadyOffered(userId: string, match: TierMatch): Promise<boolean> {
  if (!("event_api_id" in match)) return alreadyOfferedTier3(userId, match.name);
  const { rows } = await pool.query(
    `SELECT 1 FROM co_memories
     WHERE user_id = $1
       AND memory_type = 'event_offer_pending'
       AND (content::jsonb -> 'match' ->> 'event_api_id') = $2
     LIMIT 1`,
    [userId, match.event_api_id],
  );
  return rows.length > 0;
}

// Filters a set of candidate matches down to only the ones not already
// offered before — per-match, not all-or-nothing, so a repeat-offered Tier 1
// event doesn't take a fresh Tier 2/3 one down with it (see the note on
// getTieredRecommendation in tieredRecommendation.ts).
async function filterFreshMatches(userId: string, matches: TierMatch[]): Promise<TierMatch[]> {
  const flags = await Promise.all(matches.map((m) => alreadyOffered(userId, m)));
  return matches.filter((_, i) => !flags[i]);
}

// One thing at a time, paced by a backlog (Royce, 2026-08-30) — "I don't
// think there should be a 'winner'... all 3 tiers should be surfaced" led to
// briefly bundling every real match into one tease, but that broke Co's own
// voice: "Oh I was thinking about you... here's..." is a friend mentioning
// ONE thing, not a matching engine handing over a list. Nothing found is
// dropped (same goal as before) — it's just paced one text at a time instead
// of dumped at once. When a cycle finds more real matches than it sends, the
// leftovers are stashed here (per user, tier-ordered) and checked FIRST on
// the next attempt, before the tiered engine runs again.
//
// Explicitly NOT gated on a reply (Royce, 2026-08-30): "I don't want it to
// be [that] a user has to text back first in order to get the backlog
// queue." Progression through the backlog is purely time-based — the same
// 3-day ask cadence and 24h cross-mechanism nudge cap (proactiveThrottle.ts)
// that already govern every other proactive text. sendblue.ts's reply
// resolution already always targets the MOST RECENTLY sent, still-unresolved
// tease (ORDER BY created_at DESC), so an ignored earlier tease is simply
// superseded, not a blocker — there is no separate "wait for an answer"
// gate here anymore (the old hasOpenTease check is gone).
// source (Royce, 2026-08-30 code review fix): tags whether an item came
// from the full engine (a normal-cadence cycle) or the urgent pre-check (a
// cadence-hasn't-cleared cycle). Needed because attemptEventSurfacing must
// NOT drain a "full" item early just because the backlog has something
// queued — that would bypass the 3-day cadence entirely once the daily
// nudge cap clears (see the cadence gate below). An "urgent" item is exempt
// from that gate by design — it's already near-term by construction
// (checkForUrgentMatch only ever returns something within
// URGENT_WINDOW_DAYS), so it's meant to reach the person regardless of
// where the normal cadence clock stands.
type BacklogItem = { askText: string; match: TierMatch; source: "full" | "urgent" };

// Stored in a dedicated table, not co_memories (Royce, 2026-08-30 code
// review fix) — see event_backlogs in migrations.ts for why: co_memories is
// an append-only log, a poor fit for mutable per-ask queue state, and a
// shared per-user key let one ask's backlog get consumed by another ask's
// turn. Scoped by (userId, askId) with a real upsert.
async function getBacklog(userId: string, askId: string): Promise<BacklogItem[]> {
  const { rows } = await pool.query(`SELECT items FROM event_backlogs WHERE user_id = $1 AND ask_id = $2`, [userId, askId]);
  return (rows[0]?.items as BacklogItem[]) ?? [];
}

async function saveBacklog(userId: string, askId: string, items: BacklogItem[]): Promise<void> {
  await pool
    .query(
      `INSERT INTO event_backlogs (user_id, ask_id, items, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, ask_id) DO UPDATE SET items = $3, updated_at = NOW()`,
      [userId, askId, JSON.stringify(items)],
    )
    .catch((err: any) => console.error("saveBacklog: write failed (non-fatal):", err?.message ?? err));
}

// Lead-time handling (Royce, 2026-08-30) — "are you giving enough time for
// the search to be handled?" Nothing previously stopped a real event from
// sitting in the backlog, or the tease itself, until it was effectively
// unreachable: the tease-then-wait-for-a-reply round trip eats real hours or
// days before the person ever sees the actual date/link.
//
// Deliberately NOT a "don't even consider it" floor at match time — a flat
// cutoff would silently exclude a genuinely good same-day event that a
// fast-replying person could still make, which is exactly the "don't
// exclude the user from an opportunity" problem this whole feature exists
// to avoid. Instead, lead time changes HOW something is delivered, not
// WHETHER it's offered at all:
//   - past entirely (event_date, or a Tier 3 deadline, before today) → drop
//     it, nothing to act on
//   - short notice (today or tomorrow) → skip the tease-and-wait; reveal
//     directly in one message so no hours are lost to a "want to hear
//     more?" round trip on something time-sensitive
//   - normal lead time → the usual tease-first flow
// Applies to Tier 3 too, when the source post stated an explicit deadline
// (see tieredRecommendation.ts's TierMatch.deadline) — "close that gap"
// (Royce, 2026-08-30): a queued opportunity's deadline can pass while it
// sits in the backlog waiting its turn, same as a Tier 1/2 event, and a
// deadline tomorrow has exactly the same tease-eats-the-runway problem. A
// Tier 3 match with no stated deadline (rolling admissions, or the post
// just didn't say) has nothing to check here, same as before.
const SHORT_NOTICE_DAYS = 1;

function relevantDate(match: TierMatch): string | null {
  if ("event_date" in match) return match.event_date;
  if ("deadline" in match && match.deadline) return match.deadline;
  return null;
}

function daysUntilDate(dateStr: string): number {
  const todayStr = new Date().toISOString().slice(0, 10);
  const msPerDay = 1000 * 60 * 60 * 24;
  return (new Date(`${dateStr}T00:00:00Z`).getTime() - new Date(`${todayStr}T00:00:00Z`).getTime()) / msPerDay;
}

function isPastEvent(match: TierMatch): boolean {
  const date = relevantDate(match);
  return date !== null && daysUntilDate(date) < 0;
}

function isShortNotice(match: TierMatch): boolean {
  const date = relevantDate(match);
  return date !== null && daysUntilDate(date) >= 0 && daysUntilDate(date) <= SHORT_NOTICE_DAYS;
}

// The real, periodic "Luma & X asks surface periodically" mechanism (Royce,
// 2026-08-30) — replaces the old instant-fire-on-every-captured-ask
// behavior, which had no cooldown and could text someone multiple times a
// day. Now driven by jobs/index.ts's cadence cron, same shape as
// ask_checkins' existing check-in cadence. Runs the FULL tiered engine
// (Tier 1 Co event → Tier 2 public Luma event → Tier 3 X opportunity) —
// covers both Luma and X, not just Luma's Tier 2 discovery feed the old
// version was limited to.
//
// Ask-first (Royce, 2026-08-30) — Co no longer dumps the event name/link
// straight into this unprompted text; runEventDiscoverySurfacingAgent now
// drafts a tease asking if they'd like to hear more, and the real details
// only go out once they say yes (see sendblue.ts's eventOfferContext, which
// detects that reply and folds the actual details into Co's next message).
// The match is stashed here as event_offer_pending so that follow-up reply
// has something to draw from without re-running the tiered engine (which
// could return something different by then).
// throttled: true means this attempt never actually went out, purely
// because of the unrelated cross-mechanism daily nudge cap
// (proactiveThrottle.ts) — jobs/index.ts uses this to decide whether to
// spend this ask's 3-day cadence window or retry tomorrow. Nothing found is
// lost either way: it's still sitting in the backlog for next time.
//
// Urgency pre-check (Royce, 2026-08-30) — "something cheap that scans for
// something relevant to that person's wants/ask/intent matching their co
// profile" for someone whose normal cadence hasn't cleared yet. When
// !cooldownCleared, only checkForUrgentMatch runs (Tier 1/2 only, no LLM
// generation, no paid Tier 3 search — see tieredRecommendation.ts), using
// the ask enriched with profile goals/activity_preferences rather than the
// bare ask text alone, since "relevant to their wants" is broader than the
// literal sentence they stated. jobs/index.ts only resets the 3-day clock
// when this path actually sends — a quiet day here doesn't touch it, so the
// normal cadence keeps counting down underneath untouched. Leftovers from
// EITHER path get queued into the backlog, not just the full engine's —
// discarding a second real match the urgent check happened to find would be
// exactly the "exclude the user from an opportunity" problem this feature
// exists to avoid, urgent path or not.
// Runs the tiered engine (or the urgent pre-check) fresh and returns
// whatever's real, tier-ordered — factored out so attemptEventSurfacing can
// retry it in the same cycle if the backlog turns out fully stale, instead
// of just giving up until the next cadence window.
async function findFreshPending(candidate: SurfacingCandidate): Promise<BacklogItem[]> {
  const source: "full" | "urgent" = candidate.cooldownCleared ? "full" : "urgent";
  let matches: TierMatch[];
  if (candidate.cooldownCleared) {
    matches = await getTieredRecommendation({ text: candidate.askText }, candidate.city).catch((err: any) => {
      console.error("attemptEventSurfacing: getTieredRecommendation failed (non-fatal):", err?.message ?? err);
      return [];
    });
  } else {
    const profileContext = [candidate.askText, ...(candidate.goals ?? []), ...(candidate.activityPreferences ?? [])]
      .filter(Boolean)
      .join(". ");
    matches = await checkForUrgentMatch({ text: profileContext }, candidate.city).catch((err: any) => {
      console.error("attemptEventSurfacing: checkForUrgentMatch failed (non-fatal):", err?.message ?? err);
      return [];
    });
  }
  // Tier order as the mention priority (Tier 1 first by default) — same
  // "route people into Co's own events first" reasoning the old
  // decideBestMatch had, just spread across separate texts over time
  // instead of one ranked pick. Bias-adjusted (Royce, 2026-09-02, "wire
  // signal weighting into the standing profile") by getTierBias — a tier
  // that's landed well for this person before sorts earlier; a user with no
  // outcome history yet gets all-zero bias, which is exactly the same
  // tier-number order as before this existed.
  const fresh = await filterFreshMatches(candidate.userId, matches);
  const bias = await getTierBias(candidate.userId);
  return fresh
    .sort((a, b) => bias[b.tier] - bias[a.tier] || a.tier - b.tier)
    .map((match) => ({ askText: candidate.askText, match, source }));
}

// Drops anything at the front that's gone stale — either already offered
// through some other path, or a real event/deadline that's fully passed
// while it sat waiting its turn — without losing what's behind it.
async function dropStaleFront(userId: string, items: BacklogItem[]): Promise<BacklogItem[]> {
  let rest = items;
  while (rest.length && ((await alreadyOffered(userId, rest[0].match)) || isPastEvent(rest[0].match))) {
    rest = rest.slice(1);
  }
  return rest;
}

export async function attemptEventSurfacing(candidate: SurfacingCandidate): Promise<{ sent: boolean; throttled: boolean }> {
  let pending = await dropStaleFront(candidate.userId, await getBacklog(candidate.userId, candidate.askId));

  // Falls through to a fresh search in the SAME cycle whenever there's
  // nothing usable queued — whether the backlog was empty to begin with, or
  // turned out to be entirely stale once checked. Without this, a backlog
  // that goes fully stale would silently wait out the rest of the normal
  // cadence with nothing sent, even on a cycle that was otherwise free to
  // look for something new right now.
  if (!pending.length) {
    pending = await dropStaleFront(candidate.userId, await findFreshPending(candidate));
  }

  if (!pending.length) {
    await saveBacklog(candidate.userId, candidate.askId, []);
    return { sent: false, throttled: false };
  }

  const [item, ...rest] = pending;
  const shortNotice = isShortNotice(item.match);

  // Cadence gate (Royce, 2026-08-30 code review fix): a "full"-sourced item
  // sitting in the backlog must still wait for the normal 3-day cadence to
  // clear, same as it would have if it were being found fresh right now —
  // otherwise, once the unrelated 24h nudge cap clears, the backlog would
  // drain a real match every day instead of every 3 days, directly
  // contradicting "people don't want to get notified about an event every
  // day." An "urgent"-sourced item is exempt (it's near-term by
  // construction) and anything that's become short-notice while queued is
  // exempt too, for the same reason short-notice reveals skip the tease
  // step in the first place — waiting three more days isn't an option for
  // something happening tomorrow.
  if (item.source === "full" && !candidate.cooldownCleared && !shortNotice) {
    await saveBacklog(candidate.userId, candidate.askId, pending);
    return { sent: false, throttled: false };
  }

  const { sent, throttled } = await runEventDiscoverySurfacingAgent(
    { userId: candidate.userId, firstName: candidate.firstName, phoneNumber: candidate.phoneNumber },
    item.askText,
    item.match,
    { revealNow: shortNotice },
  );

  // Only consume the item once it actually goes out — a throttled attempt,
  // or one the model itself decided not to send, leaves it at the front of
  // the backlog for next time instead of silently dropping it.
  await saveBacklog(candidate.userId, candidate.askId, sent ? rest : pending);

  if (sent) {
    // Short-notice reveals still need a permanent-dedup record — alreadyOffered
    // only scans 'event_offer_pending' rows, and skipping this write entirely
    // would mean a directly-revealed event could get offered again later.
    // Immediately followed by 'event_offer_resolved' (not a real reply, just
    // "already handled") so sendblue.ts's pending-offer lookup doesn't
    // mistake the person's next message for an answer to a tease that was
    // never actually asked — revealNow skipped the yes/no step entirely.
    {
      // Stored as JSON (parsed elsewhere by sendblue.ts's pending-offer
      // lookup) but embedded from a plain-language rendering — otherwise
      // this real name/reason (Co's own record of what it actually
      // surfaced) is never reachable by recentMemories' semantic search on
      // a later turn, the same gap that let a real recommendation link go
      // unexplained when asked "what is this?" later.
      const pendingContent = JSON.stringify({ askText: item.askText, match: item.match });
      const embeddingSource = `${item.match.name} — ${item.match.reason} (asked about: ${item.askText})`;
      await pool
        .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'event_offer_pending', $2) RETURNING id`, [
          candidate.userId,
          pendingContent,
        ])
        .then((mem) =>
          generateEmbedding(embeddingSource)
            .then((emb) =>
              pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
                `[${emb.join(",")}]`,
                mem.rows[0].id,
              ]),
            )
            .catch((err: any) => console.error("event_offer_pending embedding failed (non-fatal):", err?.message ?? err)),
        )
        .catch((err: any) => console.error("attemptEventSurfacing: event_offer_pending write failed (non-fatal):", err?.message ?? err));
    }

    if (shortNotice) {
      await pool
        .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'event_offer_resolved', $2)`, [
          candidate.userId,
          "revealed_directly",
        ])
        .catch((err: any) => console.error("attemptEventSurfacing: event_offer_resolved write failed (non-fatal):", err?.message ?? err));

      // Outcome-learning loop (Royce, 2026-09-02) — the ask-first path
      // schedules this in sendblue.ts's "interested" branch; this is the
      // OTHER real-details-revealed moment (revealNow skips the tease
      // entirely), so it needs the same trigger here. No-op for Tier 3.
      scheduleOutcomeFollowUp(candidate.userId, item.askText, item.match).catch((err: any) =>
        console.error("attemptEventSurfacing: scheduleOutcomeFollowUp failed (non-fatal):", err?.message ?? err),
      );
    }

    // Only Tier 1/2 are real shared events worth cross-matching another
    // person against (see eventMatching.ts) — Tier 3 opportunities aren't
    // something two people both "attend." This fires regardless of whether
    // the recipient ends up saying they're interested — Co already surfaced
    // the same real event to two different people either way.
    if ("event_api_id" in item.match) {
      const { recordSurfacedEventAndMatch } = await import("./eventMatching.js");
      recordSurfacedEventAndMatch(candidate.userId, item.match.event_api_id, item.match.name, item.match.event_date).catch(
        (err: any) => console.error("attemptEventSurfacing: recordSurfacedEventAndMatch failed (non-fatal):", err?.message ?? err),
      );
    } else {
      // Stores the embedding once, at offer time, so alreadyOfferedTier3
      // never has to recompute it on a future dedup check (see that
      // function's note above).
      generateEmbedding(item.match.name)
        .then((embedding) =>
          pool.query(`INSERT INTO tier3_offered_opportunities (user_id, name, embedding) VALUES ($1, $2, $3::vector)`, [
            candidate.userId,
            item.match.name,
            `[${embedding.join(",")}]`,
          ]),
        )
        .catch((err: any) => console.error("attemptEventSurfacing: tier3_offered_opportunities write failed (non-fatal):", err?.message ?? err));
    }
  }

  return { sent, throttled };
}
