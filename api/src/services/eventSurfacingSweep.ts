import pool from "../db/db.js";
import { getPersonSnapshot, profileForSearch } from "../harness/personSnapshot.js";
import { getTimezoneForCity } from "./geocoding.js";
import { getTieredRecommendation, type TierMatch } from "./tieredRecommendation.js";
import { enqueueCandidate } from "../harness/proactive.js";
import { generateEmbedding } from "./embeddings.js";
import { scheduleOutcomeFollowUp, getTierBias } from "./recommendationOutcome.js";
import { enrichMatch } from "./eventDetails.js";
import { getEmotionalContext, renderEmotionalContext, roomPreferenceFromFeelings } from "../harness/emotion.js";
import { buildSearchBrief } from "./searchBrief.js";
import { recordDecision } from "../harness/core.js";
import { recordRevealedOffers } from "./offerReactions.js";
import { offerHistory, repeatInput, repeatRule, type RepeatAction } from "../harness/matchGate.js";

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
  // true when there's no stated ask and askText was built from what's on
  // their profile (goals, interests, wants), so drafts don't claim they
  // "told you" it.
  fromProfile?: boolean;
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
// When an opening with a similar name was offered (the dates feed the
// repeat rule in harness/matchGate.ts, not a yes/no).
async function tier3ShownAt(userId: string, name: string): Promise<Date[]> {
  const newEmbedding = await generateEmbedding(name).catch((err: any) => {
    console.error("tier3ShownAt: generateEmbedding failed (non-fatal, treating as not shown):", err?.message ?? err);
    return null;
  });
  if (!newEmbedding) return [];
  const { rows } = await pool.query(
    `SELECT created_at FROM tier3_offered_opportunities
     WHERE user_id = $1
       AND 1 - (embedding <=> $2::vector) >= $3`,
    [userId, `[${newEmbedding.join(",")}]`, OPPORTUNITY_IDENTITY_THRESHOLD],
  );
  return rows.map((r: { created_at: Date }) => new Date(r.created_at));
}

// What happens to something already shown: new, a reminder, back once after
// a month unanswered, or never (harness/matchGate.ts repeatRule).
async function repeatFor(userId: string, match: TierMatch): Promise<{ action: RepeatAction; reason: string }> {
  const extra = "event_api_id" in match ? [] : await tier3ShownAt(userId, match.name);
  const history = await offerHistory(userId, match, extra);
  return repeatRule(history, repeatInput(match, isShortNotice(match)), new Date().toISOString().slice(0, 10), new Date());
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
// 3-day ask cadence and the Layer 7 send caps (src/harness/proactive.ts)
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
// reminder: they were already shown this one (in a texted search or an
// earlier offer) and it's now within a day, or an opening they were
// interested in is near its deadline: a one-time heads-up, not a new pitch.
// again: shown over a month ago, never answered, still open: it comes back
// once, under its own key so the first send's key doesn't block it.
type BacklogItem = { askText: string; match: TierMatch; source: "full" | "urgent"; reminder?: boolean; again?: boolean };

function offerTargetKey(item: Pick<BacklogItem, "match" | "reminder" | "again">): string {
  return `event_offer:${item.reminder ? "reminder:" : item.again ? "again:" : ""}${matchKey(item.match)}`;
}

// Stored in a dedicated table, not co_memories (Royce, 2026-08-30 code
// review fix) — see event_backlogs in migrations.ts for why: co_memories is
// an append-only log, a poor fit for mutable per-ask queue state, and a
// shared per-user key let one ask's backlog get consumed by another ask's
// turn. Scoped by (userId, askId) with a real upsert.
async function getBacklog(userId: string, askId: string): Promise<BacklogItem[]> {
  const { rows } = await pool.query(`SELECT items FROM event_backlogs WHERE user_id = $1 AND ask_id = $2`, [userId, askId]);
  // Tier 1 items queued before the 2026-09-09 listCalendarEvents field fix
  // have no event_api_id, so dedup and match recording can't key off them.
  // Drop them; the next full cycle re-finds the event with a real id.
  return ((rows[0]?.items as BacklogItem[]) ?? []).filter((i) => i.match.tier === 3 || Boolean((i.match as any).event_api_id));
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
// (the Layer 7 send caps) — jobs/index.ts uses this to decide whether to
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
// Daily full search across all three tiers (Royce, 2026-09-14: "it should
// be actively searching for all 3 tiers"). Searching and sending are paced
// separately: anything happening within URGENT_WINDOW_DAYS is "urgent" and
// may go out before the 3-day cadence clears; everything else waits for it.
const URGENT_WINDOW_DAYS = 3;

// Rotates which tier goes next so every tier gets its turn (2026-09-21): the
// search returns Tier 1, then 2, then 3, and with one queued offer per run
// Tier 2 kept filling the slot. Order within a tier is unchanged. Starts with
// the tier after the one Co offered last (in the order the tiers appeared,
// which already carries the outcome bias), then takes one from each in turn.
export function interleaveByTier<T extends { match: { tier: number } }>(items: T[], lastTier: number | null): T[] {
  const groups = new Map<number, T[]>();
  for (const it of items) {
    const g = groups.get(it.match.tier) ?? [];
    g.push(it);
    groups.set(it.match.tier, g);
  }
  let order = [...groups.keys()];
  const at = lastTier === null ? -1 : order.indexOf(lastTier);
  if (at >= 0) order = [...order.slice(at + 1), ...order.slice(0, at + 1)];
  const out: T[] = [];
  while (out.length < items.length) {
    for (const tier of order) {
      const next = groups.get(tier)!.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

// The tier of the last event offer that actually went out to this person.
async function lastOfferedTier(userId: string): Promise<number | null> {
  const { rows } = await pool
    .query(
      `SELECT payload->'match'->>'tier' AS tier FROM proactive_candidates
       WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' AND payload->'match'->>'tier' IS NOT NULL
       ORDER BY COALESCE(decided_at, updated_at) DESC LIMIT 1`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  const t = Number(rows[0]?.tier);
  return Number.isFinite(t) ? t : null;
}

type SweepSearchTrace = {
  searchText: string;
  // Frustrated with what Co has found: searched wider and sends sooner.
  widened: boolean;
  roomPreference: string | null;
  found: { name: string; tier: number; date: string | null }[];
  staleOrRepeat: string[];
  // Shown over a month ago with no reply, and coming back once.
  resurfaced: string[];
  scope: Record<string, unknown> | null;
};

async function findFreshPending(candidate: SurfacingCandidate): Promise<{ items: BacklogItem[]; trace: SweepSearchTrace }> {
  // What to search for comes from the whole person (ask, goals, recent
  // texts, feelings), not the ask's words alone (services/searchBrief.ts).
  const brief = await buildSearchBrief({
    userId: candidate.userId,
    askText: candidate.askText,
    fromProfile: candidate.fromProfile ?? false,
    goals: candidate.goals,
    activityPreferences: candidate.activityPreferences,
  });
  // Their time zone, so event dates are their local calendar dates.
  const timezone = candidate.city ? await getTimezoneForCity(candidate.city).catch(() => null) : null;
  // Feelings steer the search, never stop it (2026-09-18): frustration with
  // what Co has found widens it; how their life has been shapes which rooms
  // rank first.
  const feelings = await getEmotionalContext(candidate.userId).catch(() => null);
  const widen = !!feelings?.withCo.frustrated;
  const roomPreference = feelings ? roomPreferenceFromFeelings(feelings) : null;
  const focus = profileForSearch(await getPersonSnapshot(candidate.userId).catch(() => null)) || null;
  const profile = [focus, roomPreference].filter(Boolean).join("\n") || null;
  // No zone for their city: the engine uses Co's home zone and says so.
  const result = await getTieredRecommendation({ text: brief.searchText }, candidate.city, { userId: candidate.userId, source: "sweep", timezone, profile, widen, checkRepeat: false, coreAsk: candidate.askText })
    .catch((err: any) => {
      console.error("attemptEventSurfacing: getTieredRecommendation failed (non-fatal):", err?.message ?? err);
      return null;
    });
  const matches: TierMatch[] = result?.matches ?? [];
  // Tier order as the mention priority (Tier 1 first by default) — same
  // "route people into Co's own events first" reasoning the old
  // decideBestMatch had, just spread across separate texts over time
  // instead of one ranked pick. Bias-adjusted (Royce, 2026-09-02, "wire
  // signal weighting into the standing profile") by getTierBias — a tier
  // that's landed well for this person before sorts earlier; a user with no
  // outcome history yet gets all-zero bias, which is exactly the same
  // tier-number order as before this existed.
  // Anything they've already been shown (texted search or earlier offer)
  // follows the repeat rule (harness/matchGate.ts): never after a no, a
  // reminder when it's close, back once after a month unanswered. The gate
  // used to drop those forever inside the search (2026-09-18: twelve SF
  // events shown in texted searches were excluded from every later sweep).
  const repeats = await Promise.all(matches.map((m) => repeatFor(candidate.userId, m)));
  const fresh = matches.filter((_, i) => repeats[i].action === "new" || repeats[i].action === "resurface");
  const again = new Set(matches.filter((_, i) => repeats[i].action === "resurface"));
  const reminders = matches.filter((_, i) => repeats[i].action === "remind");
  const bias = await getTierBias(candidate.userId);
  const items = fresh
    .sort((a, b) => bias[b.tier] - bias[a.tier] || a.tier - b.tier)
    .map((match) => {
      const date = relevantDate(match);
      const source: "full" | "urgent" = date !== null && daysUntilDate(date) <= URGENT_WINDOW_DAYS ? "urgent" : "full";
      return { askText: candidate.askText, match, source, ...(again.has(match) ? { again: true } : {}) };
    })
    .concat(reminders.map((match) => ({ askText: candidate.askText, match, source: "urgent" as const, reminder: true })));
  const sc = result?.scope;
  return {
    items,
    trace: {
      searchText: brief.searchText,
      widened: widen,
      roomPreference,
      found: matches.map((m) => ({ name: m.name, tier: m.tier, date: relevantDate(m) })),
      staleOrRepeat: matches.flatMap((m, i) => (repeats[i].action === "blocked" ? [`${m.name}: ${repeats[i].reason}`] : [])),
      resurfaced: [...again].map((m) => m.name),
      scope: sc
        ? {
            city: sc.city,
            tiers: sc.tiers,
            tier2Nearby: sc.tier2Nearby,
            relevanceRejected: sc.relevanceRejected,
            gatedOut: sc.gatedOut,
            xQuery: sc.xQuery,
            xBlocked: sc.xBlocked,
            webBlocked: sc.webBlocked,
            fetchedThrough: sc.fetchedThrough,
            cached: sc.cached,
          }
        : null,
    },
  };
}

function sameMatch(a: TierMatch, b: TierMatch): boolean {
  if ("event_api_id" in a && "event_api_id" in b) return a.event_api_id === b.event_api_id;
  return a.name.toLowerCase() === b.name.toLowerCase();
}

// Openings the sweep already found for them and hasn't sent yet: waiting in a
// backlog or queued as an offer. Live replies answer from these instead of
// searching the web themselves (2026-09-18).
export async function alreadyFoundOpenings(userId: string): Promise<TierMatch[]> {
  const [backlogs, queued] = await Promise.all([
    pool.query(`SELECT items FROM event_backlogs WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] })),
    pool
      .query(`SELECT payload->'match' AS match FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'pending'`, [userId])
      .catch(() => ({ rows: [] as any[] })),
  ]);
  const matches: TierMatch[] = [
    ...backlogs.rows.flatMap((r: any) => ((r.items as BacklogItem[]) ?? []).map((i) => i.match)),
    ...queued.rows.map((r: any) => r.match as TierMatch),
  ].filter((m): m is TierMatch => !!m && m.tier === 3 && !isPastEvent(m));
  const seen = new Set<string>();
  return matches.filter((m) => {
    const key = m.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Stable identity for one event/opportunity, shared by the backlog and the
// proactive harness's idempotency key.
export function matchKey(match: TierMatch): string {
  return "event_api_id" in match ? `event:${match.event_api_id}` : `opportunity:${match.name.toLowerCase().trim()}`;
}

// The harness already sent, skipped, or expired this one for this person.
async function alreadyDecided(userId: string, item: Pick<BacklogItem, "match" | "reminder" | "again">): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM proactive_candidates WHERE user_id = $1 AND target_key = $2 AND status <> 'pending'`,
    [userId, offerTargetKey(item)],
  );
  return rows.length > 0;
}

// Shown to them since it was queued (in a texted search or an earlier offer):
// a new pitch is stale, a reminder isn't.
async function shownSinceQueued(userId: string, item: BacklogItem): Promise<boolean> {
  if (item.reminder) return false;
  return (await repeatFor(userId, item.match)).action !== (item.again ? "resurface" : "new");
}

// Drops anything at the front that's gone stale — already offered through
// some other path, already decided by the harness, or a real event/deadline
// that's fully passed while it sat waiting its turn — without losing what's
// behind it.
async function dropStaleFront(userId: string, items: BacklogItem[]): Promise<BacklogItem[]> {
  let rest = items;
  while (
    rest.length &&
    ((await shownSinceQueued(userId, rest[0])) || isPastEvent(rest[0].match) || (await alreadyDecided(userId, rest[0])))
  ) {
    rest = rest.slice(1);
  }
  return rest;
}

export type EventOfferPayload = {
  askId: string;
  askText: string;
  fromProfile: boolean;
  match: TierMatch;
  // Send the details directly instead of a tease (short notice, or they're
  // frustrated with what Co has found).
  revealNow?: boolean;
  // They've already been shown this one; it's a heads-up that it's coming up.
  reminder?: boolean;
  // Shown over a month ago with no reply, and still open: brought up once more.
  again?: boolean;
};

// ask_id used for the backlog of people with no open stated ask, whose
// search text comes from their profile (jobs/index.ts).
export const PROFILE_ASK_ID = "profile";

// Layer 7 (2026-09-14): searches every day and QUEUES the front item as an
// "event_offer" candidate; src/harness/proactive.ts decides whether it goes
// out and drafts it (a tease, or a direct reveal if it's short notice by
// then). queued: true when the front item is waiting in the harness.
export async function attemptEventSurfacing(candidate: SurfacingCandidate): Promise<{ queued: boolean }> {
  // Search every day, not only when the backlog is empty, and merge
  // anything new behind what's already queued. Urgent items (happening
  // soon) move to the front so they aren't stuck behind a later event.
  const queued = await dropStaleFront(candidate.userId, await getBacklog(candidate.userId, candidate.askId));
  const { items: found, trace } = await findFreshPending(candidate);
  // A reminder replaces an older queued pitch for the same event.
  const merged = [
    ...queued.filter((q) => !found.some((f) => f.reminder && sameMatch(f.match, q.match))),
    ...found.filter((f) => f.reminder || !queued.some((q) => sameMatch(q.match, f.match))),
  ];
  const pending = await dropStaleFront(candidate.userId, [
    ...merged.filter((i) => i.source === "urgent" || isShortNotice(i.match)),
    ...interleaveByTier(
      merged.filter((i) => !(i.source === "urgent" || isShortNotice(i.match))),
      await lastOfferedTier(candidate.userId),
    ),
  ]);
  await saveBacklog(candidate.userId, candidate.askId, pending);

  // Every run is recorded, so a quiet week can be traced to where things
  // were dropped instead of guessed at (2026-09-18).
  const log = (outcome: "act" | "skip", action: string, extra: Record<string, unknown> = {}) =>
    recordDecision({
      layer: 5,
      decision: "sweep.surface",
      userId: candidate.userId,
      outcome,
      action,
      proposal: {
        askId: candidate.askId,
        askText: candidate.askText.slice(0, 200),
        fromProfile: candidate.fromProfile ?? false,
        cooldownCleared: candidate.cooldownCleared,
        ...trace,
        backlog: pending.map((i) => ({ name: i.match.name, tier: i.match.tier, date: relevantDate(i.match), source: i.source })),
        ...extra,
      },
    });

  if (!pending.length) {
    await log("skip", trace.found.length ? "nothing_fresh" : "nothing_found");
    return { queued: false };
  }

  // One queued offer per event: an event already waiting to go out (often
  // queued by another of their asks) is skipped so this ask queues its next
  // distinct one, instead of every ask re-touching the same candidate.
  const { rows: waiting } = await pool.query(
    `SELECT target_key FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'pending'`,
    [candidate.userId],
  );
  const alreadyWaiting = new Set(waiting.map((r: any) => r.target_key as string));
  const skipped: { name: string; why: string }[] = [];
  let tried = 0;

  for (const item of pending) {
    const targetKey = offerTargetKey(item);
    if (alreadyWaiting.has(targetKey)) {
      skipped.push({ name: item.match.name, why: "already queued" });
      continue;
    }
    // No per-ask send hold here (2026-09-21, Royce: "the sweep should allow all
    // the tiers to be surfaced"). The old 3-day cadence parked Tier 3 finds for
    // days behind a Tier 2 send; pacing is the Layer 7 caps' job now (one room
    // text a day, four a week, the unanswered pause). Queueing is not sending.
    // Each try costs a fit read; three is plenty for one ask in one run.
    if (tried >= 3) break;
    tried++;

    const date = relevantDate(item.match);
    // Real details plus a personal reason, computed once when it's queued, so
    // the tease, the reveal, and any "tell me more" all work from the same
    // record (services/eventDetails.ts).
    const match = await enrichMatch(item.match, {
      userId: candidate.userId,
      firstName: candidate.firstName,
      askText: candidate.fromProfile ? null : item.askText,
      goals: candidate.goals,
      city: candidate.city,
      feeling: renderEmotionalContext(await getEmotionalContext(candidate.userId)),
    });
    // The personal read says it doesn't fit what they asked: drop it and try
    // the next one.
    if (match.fits === false) {
      await removeFromBacklog(candidate.userId, candidate.askId, item.match);
      skipped.push({ name: item.match.name, why: `doesn't fit: ${match.whyItFits ?? "no reason given"}`.slice(0, 200) });
      continue;
    }
    const payload: EventOfferPayload = {
      askId: candidate.askId,
      askText: item.askText,
      fromProfile: candidate.fromProfile ?? false,
      match,
      // Frustrated with what Co has found: send the real thing, not a tease
      // they have to answer before seeing it.
      ...(trace.widened ? { revealNow: true } : {}),
      ...(item.reminder ? { reminder: true } : {}),
      ...(item.again ? { again: true } : {}),
    };
    const { queued: ok } = await enqueueCandidate({
      userId: candidate.userId,
      type: "event_offer",
      targetKey,
      summary: `${item.reminder ? "Reminder, already shown to them: " : ""}${item.match.kind === "opportunity" ? "An opportunity" : "An event"} that fits ${candidate.fromProfile ? "what they've shared" : `their ask "${item.askText.slice(0, 120)}"`}: "${item.match.name}"${date ? ` (${date})` : ""}${isShortNotice(item.match) ? ", short notice" : ""}`,
      payload,
      // Expires at the end of the event's (or deadline's) day; an undated
      // opportunity gets two weeks.
      expiresAt: date ? new Date(`${date}T23:59:00Z`) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      // Short notice is the most time-bound thing Co can send.
      priority: isShortNotice(item.match) ? 95 : trace.widened ? 85 : undefined,
    });
    if (ok) {
      await log("act", "queued", { queued: { name: item.match.name, tier: item.match.tier, date }, skipped });
      return { queued: true };
    }
    skipped.push({ name: item.match.name, why: "already sent or decided" });
  }

  await log("skip", "nothing_queued", { skipped });
  return { queued: false };
}

export { isShortNotice };

async function removeFromBacklog(userId: string, askId: string, match: TierMatch): Promise<void> {
  const items = await getBacklog(userId, askId);
  await saveBacklog(userId, askId, items.filter((i) => !sameMatch(i.match, match)));
}

// Harness hook after the text actually went out.
export async function onEventOfferSent(userId: string, payload: EventOfferPayload, revealed: boolean): Promise<void> {
  const { match, askText, askId } = payload;
  await removeFromBacklog(userId, askId, match);

  if (askId === PROFILE_ASK_ID) {
    await pool.query(
      `INSERT INTO profile_surfacing_state (user_id, last_surfaced_at) VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_surfaced_at = NOW()`,
      [userId],
    );
  } else {
    await pool.query(`UPDATE ask_checkins SET last_surfaced_at = NOW() WHERE id = $1`, [askId]);
  }

  // event_offer_pending is both the permanent dedup record (alreadyOffered)
  // and what routes/sendblue.ts reads to answer "yes, tell me more". Stored
  // as JSON but embedded from plain language so later semantic search can
  // find what Co actually surfaced.
  const pendingContent = JSON.stringify({ askText, match });
  const embeddingSource = `${match.name}: ${match.reason} (asked about: ${askText})`;
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'event_offer_pending', $2) RETURNING id`, [
      userId,
      pendingContent,
    ])
    .then((mem) =>
      generateEmbedding(embeddingSource)
        .then((emb) =>
          pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [`[${emb.join(",")}]`, mem.rows[0].id]),
        )
        .catch((err: any) => console.error("event_offer_pending embedding failed (non-fatal):", err?.message ?? err)),
    )
    .catch((err: any) => console.error("onEventOfferSent: event_offer_pending write failed (non-fatal):", err?.message ?? err));

  if (revealed) {
    // A direct reveal skipped the yes/no step; their reaction to it is
    // waited on instead (services/offerReactions.ts). The real details went
    // out, so the debrief gets scheduled.
    await recordRevealedOffers(userId, [match]);
    await pool
      .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'event_offer_resolved', 'revealed_directly')`, [userId])
      .catch((err: any) => console.error("onEventOfferSent: event_offer_resolved write failed (non-fatal):", err?.message ?? err));
    await scheduleOutcomeFollowUp(userId, askText, match).catch((err: any) =>
      console.error("onEventOfferSent: scheduleOutcomeFollowUp failed (non-fatal):", err?.message ?? err),
    );
  }

  if ("event_api_id" in match) {
    const { recordSurfacedEventAndMatch } = await import("./eventMatching.js");
    await recordSurfacedEventAndMatch(userId, match.event_api_id, match.name, match.event_date, match.details?.startAt ?? null, match.details?.endAt ?? null).catch((err: any) =>
      console.error("onEventOfferSent: recordSurfacedEventAndMatch failed (non-fatal):", err?.message ?? err),
    );
  } else {
    await generateEmbedding(match.name)
      .then((embedding) =>
        pool.query(`INSERT INTO tier3_offered_opportunities (user_id, name, embedding) VALUES ($1, $2, $3::vector)`, [
          userId,
          match.name,
          `[${embedding.join(",")}]`,
        ]),
      )
      .catch((err: any) => console.error("onEventOfferSent: tier3_offered_opportunities write failed (non-fatal):", err?.message ?? err));
  }
}

// Harness hook when the candidate is skipped or expires: take it out of the
// backlog so the next match can be queued.
export async function onEventOfferDropped(userId: string, payload: EventOfferPayload): Promise<void> {
  await removeFromBacklog(userId, payload.askId, payload.match);
}

// A real ask captured on a call gets searched right away instead of waiting
// for the next sweep tick (2026-09-15: a designer ask from a call sat with
// nothing looking for it). Anything found goes through the same queue and
// daily pick as the sweep, so it's still paced.
export async function surfaceNewAsksNow(userId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT ac.id, ac.ask_id, ac.ask_text, u.first_name, u.phone_number, cp.city, cp.goals, cp.activity_preferences
     FROM ask_checkins ac
     JOIN users u ON u.id = ac.user_id
     LEFT JOIN co_profiles cp ON cp.user_id = ac.user_id
     WHERE ac.user_id = $1 AND ac.resolved_at IS NULL AND ac.last_attempted_at IS NULL
       AND ac.created_at > NOW() - INTERVAL '30 minutes'`,
    [userId],
  );
  for (const row of rows) {
    await pool.query(`UPDATE ask_checkins SET last_attempted_at = NOW() WHERE id = $1`, [row.id]);
    try {
      await attemptEventSurfacing({
        askId: row.id,
        userId,
        firstName: row.first_name,
        phoneNumber: row.phone_number,
        askText: row.ask_text,
        city: row.city ?? null,
        goals: row.goals ?? null,
        activityPreferences: row.activity_preferences ?? null,
        cooldownCleared: true,
      });
      const { attemptNetworkSurfacing } = await import("./networkIntroNudge.js");
      await attemptNetworkSurfacing(userId, row.first_name, row.phone_number, row.ask_id);
    } catch (err: any) {
      console.error(`surfaceNewAsksNow failed for ${userId} (non-fatal):`, err?.message ?? err);
    }
  }
}

