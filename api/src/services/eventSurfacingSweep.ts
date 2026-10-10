import { DateTime } from "luxon";
import pool from "../db/db.js";
import { endOfLocalDay, localDay, memberZone } from "./memberTime.js";
import type { TierMatch } from "./tieredRecommendation.js";
import { enqueueCandidate } from "../harness/proactive.js";
import { generateEmbedding } from "./embeddings.js";
import { scheduleOutcomeFollowUp, getTierBias } from "./recommendationOutcome.js";
import { enrichMatch } from "./eventDetails.js";
import { sweepFind } from "./sweepFind.js";
import { recordDecision } from "../harness/core.js";
import { classifyFind, eventDateOf, exitKey, formOf, lifeEndOf } from "./findForm.js";
import { offerItemKey, recordRevealedOffers } from "./offerReactions.js";
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
async function repeatFor(userId: string, match: TierMatch, zone: string | null = null): Promise<{ action: RepeatAction; reason: string }> {
  const extra = "event_api_id" in match ? [] : await tier3ShownAt(userId, match.name);
  const history = await offerHistory(userId, match, extra);
  return repeatRule(history, repeatInput(match, isShortNotice(match, zone)), localDay(new Date(), zone), new Date());
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
// unread: held because its page didn't say when it is, or couldn't be read (services/workingSet.ts); never offered while held.
type BacklogItem = { askText: string; match: TierMatch; source: "full" | "urgent"; reminder?: boolean; again?: boolean; unread?: { days: string[]; why: "undated" | "unknown" } };

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

// A save merged into the row as it is now, under the row's lock (re-review of #133): `read` is what this caller read before it
// worked, so another writer's removals and read days in between survive (workingSet.ts mergeSweepSave).
async function saveBacklogMerged(userId: string, askId: string, read: BacklogItem[], next: BacklogItem[]): Promise<void> {
  const { mergeSweepSave } = await import("./workingSet.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT items FROM event_backlogs WHERE user_id = $1 AND ask_id = $2 FOR UPDATE`, [userId, askId]);
    const now = ((rows[0]?.items as BacklogItem[]) ?? []).filter((i) => i.match.tier === 3 || Boolean((i.match as any).event_api_id));
    const items = rows[0] ? mergeSweepSave(read, next, now, exitKey) : next;
    await client.query(
      `INSERT INTO event_backlogs (user_id, ask_id, items, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, ask_id) DO UPDATE SET items = $3, updated_at = NOW()`,
      [userId, askId, JSON.stringify(items)],
    );
    await client.query("COMMIT");
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("saveBacklog: write failed (non-fatal):", err?.message ?? err);
  } finally {
    client.release();
  }
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

// The date a find is about: an event's date (wherever the find carries it: event_date, details, or the stated dates a web find
// brings), else an opening's deadline (services/findForm.ts). A web event's statedDates used to be ignored here, so a past one never
// counted as past (2026-10-09: Hardly Strictly from Oct 3 was still judged a week later).
function relevantDate(match: TierMatch, zone: string | null = null): string | null {
  if (formOf(match as any) === "opening") return ("deadline" in match && match.deadline) || null;
  return eventDateOf(match, zone) ?? (("deadline" in match && match.deadline) || null);
}

// Days from their today (in their zone, else Pacific; never the server's UTC day, which turns over at 5pm Pacific) to a date.
function daysUntilDate(dateStr: string, zone: string | null = null, now = new Date()): number {
  const todayStr = localDay(now, zone);
  const msPerDay = 1000 * 60 * 60 * 24;
  return (new Date(`${dateStr.slice(0, 10)}T00:00:00Z`).getTime() - new Date(`${todayStr}T00:00:00Z`).getTime()) / msPerDay;
}

export function isPastEvent(match: TierMatch, zone: string | null = null, now = new Date()): boolean {
  // Past once its useful life is over: an event's last day (a festival runs to its end), an opening's deadline.
  const date = lifeEndOf(match, zone) ?? relevantDate(match, zone);
  return date !== null && daysUntilDate(date, zone, now) < 0;
}

function isShortNotice(match: TierMatch, zone: string | null = null): boolean {
  const date = relevantDate(match, zone);
  return date !== null && daysUntilDate(date, zone) >= 0 && daysUntilDate(date, zone) <= SHORT_NOTICE_DAYS;
}

// Pure: when a queued offer stops being offerable (Royce, 2026-10-07: evening Pacific events were dropped at 5pm Pacific, when the
// old `${date}T23:59:00Z` expiry passed, 2-4 hours before they started). An event with a known start: at its start. An event with
// only a date: the end of that day in the event's own zone (its page's), else theirs, else Pacific. A deadline: the end of that
// day in their zone. Undated: two weeks.
export function offerExpiresAt(match: TierMatch, zone: string | null, now = new Date()): Date {
  const startAt = match.kind !== "opportunity" ? match.details?.startAt : null;
  const start = startAt ? new Date(startAt) : null;
  if (start && !Number.isNaN(start.getTime())) return start;
  const date = relevantDate(match);
  const end = date ? endOfLocalDay(date.slice(0, 10), match.details?.timezone ?? zone) : null;
  if (end && !Number.isNaN(end.getTime())) return end;
  return new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
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
// Pure: what matches the kind of room they've said they want first, then neutral, then the rest, each in its own order (Phase A5: taste
// ranks for every member, not only picker accounts). The sweep's keep sets the taste (services/sweepFind.ts); without one it's neutral.
export function byTaste<T extends { match: unknown }>(items: T[]): T[] {
  const rank = (it: T) => ((it.match as any)?.taste === "matches" ? 0 : (it.match as any)?.taste === "clashes" ? 2 : 1);
  return items.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i).map((x) => x.it);
}

export function interleaveByTier<T extends { match: { tier: number } }>(items: T[], lastTier: number | null, waitingTiers: number[] = []): T[] {
  const groups = new Map<number, T[]>();
  for (const it of items) {
    const g = groups.get(it.match.tier) ?? [];
    g.push(it);
    groups.set(it.match.tier, g);
  }
  let order = [...groups.keys()];
  const at = lastTier === null ? -1 : order.indexOf(lastTier);
  if (at >= 0) order = [...order.slice(at + 1), ...order.slice(0, at + 1)];
  // A tier that already has an offer waiting for this person goes last: the
  // dispatcher sends one per tier together, so the next slot is a new tier's.
  order = [...order.filter((t) => !waitingTiers.includes(t)), ...order.filter((t) => waitingTiers.includes(t))];
  const out: T[] = [];
  while (out.length < items.length) {
    for (const tier of order) {
      const next = groups.get(tier)!.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

// A tier that already has an offer waiting doesn't queue a second one behind it
// (the dispatcher sends one per tier together); urgent, short-notice and
// reminder items are the exception, since they can't wait a day.
export function tierAlreadyCovered(item: { match: { tier: number }; source: string; reminder?: boolean }, coveredTiers: Set<number>, shortNotice: boolean): boolean {
  if (item.source === "urgent" || item.reminder || shortNotice) return false;
  return coveredTiers.has(item.match.tier);
}

// Tiers that already have an offer waiting to go out to this person.
async function waitingOfferTiers(userId: string): Promise<number[]> {
  const { rows } = await pool
    .query(`SELECT DISTINCT payload->'match'->>'tier' AS tier FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'pending'`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => Number(r.tier)).filter((n: number) => Number.isFinite(n));
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
  searched?: boolean;
  // Frustrated with what Co has found (the record's restraint): the sweep is told to look wider, and a find goes out sooner, revealed.
  frustratedWithCo: boolean;
  found: { name: string; tier: number; date: string | null }[];
  staleOrRepeat: string[];
  // Shown over a month ago with no reply, and coming back once.
  resurfaced: string[];
  scope: Record<string, unknown> | null;
  // What Co's sweep loop looked at (services/sweepFind.ts).
  did?: string[];
};

async function findFreshPending(candidate: SurfacingCandidate, timezone: string | null): Promise<{ items: BacklogItem[]; trace: SweepSearchTrace }> {
  // Their time zone (memberTime.ts), so event dates are their local calendar dates.
  // Co finds and judges in its own loop, reading their record (services/sweepFind.ts, Phase A1): what they've said they want and ruled
  // out, how they've been, what was already sent. Feelings shape how Co says it, never whether they hear about something (2026-09-18);
  // frustration with what Co has found sends the real thing instead of a tease (attemptEventSurfacing, revealNow).
  const result = await sweepFind(
    { userId: candidate.userId, firstName: candidate.firstName, askText: candidate.askText, fromProfile: candidate.fromProfile ?? false, city: candidate.city },
    { timezone },
  ).catch((err: any) => {
    console.error("attemptEventSurfacing: sweepFind failed (non-fatal):", err?.message ?? err);
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
  const repeats = await Promise.all(matches.map((m) => repeatFor(candidate.userId, m, timezone)));
  const fresh = matches.filter((_, i) => repeats[i].action === "new" || repeats[i].action === "resurface");
  const again = new Set(matches.filter((_, i) => repeats[i].action === "resurface"));
  const reminders = matches.filter((_, i) => repeats[i].action === "remind");
  const bias = await getTierBias(candidate.userId);
  const items = fresh
    .sort((a, b) => bias[b.tier] - bias[a.tier] || a.tier - b.tier)
    .map((match) => {
      const date = relevantDate(match);
      const source: "full" | "urgent" = date !== null && daysUntilDate(date, timezone) <= URGENT_WINDOW_DAYS ? "urgent" : "full";
      return { askText: candidate.askText, match, source, ...(again.has(match) ? { again: true } : {}) };
    })
    .concat(reminders.map((match) => ({ askText: candidate.askText, match, source: "urgent" as const, reminder: true })));
  return {
    items,
    trace: {
      searchText: candidate.askText,
      frustratedWithCo: result?.frustratedWithCo ?? false,
      found: matches.map((m) => ({ name: m.name, tier: m.tier, date: relevantDate(m) })),
      staleOrRepeat: matches.flatMap((m, i) => (repeats[i].action === "blocked" ? [`${m.name}: ${repeats[i].reason}`] : [])),
      resurfaced: [...again].map((m) => m.name),
      scope: null,
      did: result?.did ?? [],
      // Whether any search came back (sweepFind.ts): a throw or a used-up budget isn't an empty run.
      searched: result?.searched ?? false,
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
// Whether the ask a find belongs to is still open. Finds saved for an ask
// that's since closed (a stale "chess this weekend", a fund that fell
// through) stop coming back (Royce, 2026-09-26: "get my ask back on track so
// I have the right events coming through"). Profile-based finds have no ask.
export const ASK_STILL_OPEN = (col: string) =>
  `(${col} = '${PROFILE_ASK_ID}' OR ${col} IS NULL OR EXISTS (SELECT 1 FROM ask_checkins ac WHERE ac.id::text = ${col} AND ac.resolved_at IS NULL))`;

export async function askStillOpen(askId: string | null | undefined): Promise<boolean> {
  if (!askId || askId === PROFILE_ASK_ID) return true;
  const { rows } = await pool
    .query(`SELECT resolved_at IS NULL AS open FROM ask_checkins WHERE id::text = $1`, [askId])
    .catch(() => ({ rows: [] as any[] }));
  // No row: an ask from a call or an older shape; don't block it.
  return rows.length ? rows[0].open === true : true;
}

export async function alreadyFoundOpenings(userId: string): Promise<TierMatch[]> {
  const [backlogs, queued] = await Promise.all([
    pool.query(`SELECT items FROM event_backlogs b WHERE b.user_id = $1 AND ${ASK_STILL_OPEN("b.ask_id")}`, [userId]).catch(() => ({ rows: [] as any[] })),
    pool
      .query(
        `SELECT payload->'match' AS match FROM proactive_candidates pc WHERE pc.user_id = $1 AND pc.type = 'event_offer' AND pc.status = 'pending' AND ${ASK_STILL_OPEN("pc.payload->>'askId'")}`,
        [userId],
      )
      .catch(() => ({ rows: [] as any[] })),
  ]);
  const matches: TierMatch[] = [
    ...backlogs.rows.flatMap((r: any) => ((r.items as BacklogItem[]) ?? []).filter((i) => !i.unread).map((i) => i.match)),
    ...queued.rows.map((r: any) => r.match as TierMatch),
  ].filter((m): m is TierMatch => !!m && m.tier === 3);
  const zone = await memberZone(userId);
  return dedupeOpenings(matches.filter((m) => !isPastEvent(m, zone)));
}

function dedupeOpenings(matches: TierMatch[]): TierMatch[] {
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

// Clears a failed attempt's row (status skipped with a failed draft or send) so the thing can be queued again.
export async function reopenFailedAttempt(userId: string, targetKey: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT id, skip_reason FROM proactive_candidates WHERE user_id = $1 AND target_key = $2 AND status <> 'pending'`, [userId, targetKey]);
  const { isFailedAttempt } = await import("./workingSet.js");
  const failed = rows.filter((r: any) => isFailedAttempt(r.skip_reason));
  if (!failed.length || failed.length !== rows.length) return false;
  await pool.query(`DELETE FROM proactive_candidates WHERE user_id = $1 AND id = ANY($2::bigint[]) AND status <> 'pending'`, [userId, failed.map((r: any) => r.id)]);
  return true;
}

// The harness already sent, skipped, or expired this one for this person.
// A failed attempt (a draft that failed its checks, a send that failed) is not a decision: only a sent text or a member-visible
// outcome closes a find (Royce, 2026-10-09: a failed Oct 6 draft kept the Extraordinary Founders Dinner out for good). An exited find
// (services/workingSet.ts) is decided whatever its row says: it's inert and never re-queued.
async function alreadyDecided(userId: string, item: Pick<BacklogItem, "match" | "reminder" | "again">): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT skip_reason FROM proactive_candidates WHERE user_id = $1 AND target_key = $2 AND status <> 'pending'`,
    [userId, offerTargetKey(item)],
  );
  const { decidedByRows, exitedFindKeys } = await import("./workingSet.js");
  if (decidedByRows(rows)) return true;
  if ((await exitedFindKeys(userId, [exitKey(item.match)]).catch(() => new Set<string>())).size) return true;
  // A reminder for something Co already gave them a deadline heads-up about (services/memberStateNudges.ts, entry
  // deadline:<item key>, queued or sent) would be the same heads-up twice (review of the branch, 2026-10-08).
  if (item.reminder) {
    // The nudge is keyed by the reaction's item key (event:<id>, or name:<lowercased name> for an opportunity), not the backlog's
    // match key: both are checked (final review of #108: opportunities never matched).
    const keys = [...new Set([`deadline:${matchKey(item.match)}`, `deadline:${offerItemKey(item.match as any)}`])];
    const dn = await pool
      .query(`SELECT 1 FROM member_state_nudges WHERE user_id = $1 AND entry_key = ANY($2::text[]) AND status IN ('queued','sent') LIMIT 1`, [userId, keys])
      .catch(() => ({ rows: [] as any[] }));
    if (dn.rows.length) return true;
  }
  return false;
}

// Shown to them since it was queued (in a texted search or an earlier offer):
// a new pitch is stale, a reminder isn't.
async function shownSinceQueued(userId: string, item: BacklogItem, zone: string | null): Promise<boolean> {
  if (item.reminder) return false;
  return (await repeatFor(userId, item.match, zone)).action !== (item.again ? "resurface" : "new");
}

// Drops anything at the front that's gone stale — already offered through
// some other path, already decided by the harness, or a real event/deadline
// that's fully passed while it sat waiting its turn — without losing what's
// behind it. "Passed" is their day, not the server's.
async function dropStaleFront(userId: string, items: BacklogItem[], zone: string | null): Promise<BacklogItem[]> {
  let rest = items;
  while (
    rest.length &&
    ((await shownSinceQueued(userId, rest[0], zone)) || isPastEvent(rest[0].match, zone) || (await alreadyDecided(userId, rest[0])))
  ) {
    rest = rest.slice(1);
  }
  return rest;
}

export type EventOfferPayload = {
  // Chosen by Co's daily pick (services/sweepShadow.ts): sent together with the other picks waiting.
  picked?: boolean;
  // The last day it's worth sending (the pick's own read): its expiry and its rank among finds.
  lastDay?: string;
  // The pick's own why, kept apart, and its view of the day's set (Phase C3): what the bundle composer writes from.
  pick?: { whyMember: string; whyNow: string; set: string | null };
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
// Backlog key for something Co promised on a call to look into.
export const PROMISE_ASK_PREFIX = "promise:";

// Layer 7 (2026-09-14): searches every day and QUEUES the front item as an
// "event_offer" candidate; src/harness/proactive.ts decides whether it goes
// out and drafts it (a tease, or a direct reveal if it's short notice by
// then). queued: true when the front item is waiting in the harness.
// Pure: does a find's useful life end before the next scheduled pick (services/sweepShadow.ts, 10am in their zone)?
export const PICK_HOUR = 10;
export function endsBeforeNextPick(match: TierMatch, zone: string | null, now = new Date()): boolean {
  const end = lifeEndOf(match, zone);
  if (!end) return false;
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  const local = DateTime.fromJSDate(now).setZone(z);
  const next = (local.hour < PICK_HOUR ? local : local.plus({ days: 1 })).set({ hour: PICK_HOUR, minute: 0, second: 0, millisecond: 0 });
  return DateTime.fromISO(end, { zone: z }).endOf("day") < next;
}

// New finds, settled before they enter the backlog: classified (a dated event or an opening), out when they're past or already
// exited, and held (never offered) when their page doesn't say when or can't be read; the daily pass reads those again and exits one
// only after several separate days (services/workingSet.ts UNREAD_DAYS). At most CLASSIFY_PER_SWEEP reads per sweep.
export const CLASSIFY_PER_SWEEP = 3;
async function settleNewFinds(userId: string, items: BacklogItem[], today: string, askText: string, zone: string | null = null): Promise<BacklogItem[]> {
  const W = await import("./workingSet.js");
  const exited = await W.exitedFindKeys(userId, items.map((i) => exitKey(i.match))).catch(() => new Set<string>());
  const out: BacklogItem[] = [];
  let reads = 0;
  for (const it of items) {
    if (exited.has(exitKey(it.match))) continue;
    const known = !!formOf(it.match as any);
    if (!known && reads >= CLASSIFY_PER_SWEEP) {
      out.push({ ...it, unread: { days: [], why: "unknown" } });
      continue;
    }
    if (!known) reads++;
    const c = known ? { match: it.match, result: "known" as const } : await classifyFind(it.match, today).catch(() => ({ match: it.match, result: "unknown" as const }));
    const match = c.match as TierMatch;
    // Its key once classified can differ from the raw find's (a date found on the page): an exit under either keeps it out (re-review of #133).
    const k = exitKey(match);
    if (k !== exitKey(it.match) && (exited.has(k) || (await W.exitedFindKeys(userId, [k]).catch(() => new Set<string>())).size)) continue;
    const end = lifeEndOf(match, zone);
    if (c.result === "undated" || c.result === "unknown") {
      out.push({ ...it, match, unread: { days: [today], why: c.result } });
      continue;
    }
    if (end && end < today) {
      await W.writeExitFact({ userId, kind: "find", itemKey: exitKey(match), label: match.name, state: "expired", reason: `its date (${end}) had already passed when it was found`, scope: `this find, for: ${askText.slice(0, 100)}` });
      continue;
    }
    out.push({ ...it, match });
  }
  return out;
}

export async function attemptEventSurfacing(candidate: SurfacingCandidate): Promise<{ queued: boolean; fed?: boolean }> {
  // Search every day, not only when the backlog is empty, and merge
  // anything new behind what's already queued. Urgent items (happening
  // soon) move to the front so they aren't stuck behind a later event.
  // Their zone (or Pacific): "today", "past" and "short notice" are their days, never the server's.
  const zone = await memberZone(candidate.userId);
  const readAtStart = await getBacklog(candidate.userId, candidate.askId);
  const queued = await dropStaleFront(candidate.userId, readAtStart, zone);
  const { items: rawFound, trace } = await findFreshPending(candidate, zone);
  // What each new find IS, read at capture (services/findForm.ts): a dated event or an opening. An event whose date its page doesn't
  // state, or one already past, exits with its fact; an exited find found again stays out (services/workingSet.ts).
  const found = await settleNewFinds(candidate.userId, rawFound, localDay(new Date(), zone), candidate.askText, zone);
  // Empty runs in a row (the backoff, services/workingSet.ts askSearchDue): a real ask only.
  // Only a search that really ran counts (review of #133: a throw or a used-up web budget counted as "nothing found").
  if (/^[0-9a-f-]{36}$/i.test(candidate.askId) && trace.searched) {
    await pool.query(`UPDATE ask_checkins SET empty_runs = CASE WHEN $2 THEN 0 ELSE empty_runs + 1 END WHERE id::text = $1`, [candidate.askId, trace.found.length > 0]).catch(() => {});
  }
  // A reminder replaces an older queued pitch for the same event.
  const merged = [
    ...queued.filter((q) => !found.some((f) => f.reminder && sameMatch(f.match, q.match))),
    ...found.filter((f) => f.reminder || !queued.some((q) => sameMatch(q.match, f.match))),
  ];
  const pending = await dropStaleFront(candidate.userId, [
    ...byTaste(merged.filter((i) => i.source === "urgent" || isShortNotice(i.match, zone))),
    ...interleaveByTier(
      byTaste(merged.filter((i) => !(i.source === "urgent" || isShortNotice(i.match, zone)))),
      await lastOfferedTier(candidate.userId),
      await waitingOfferTiers(candidate.userId),
    ),
  ], zone);
  await saveBacklogMerged(candidate.userId, candidate.askId, readAtStart, pending);

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

  // A new member's sweep (their first week) is a cold-start hit or a flagged miss (services/coldStart.ts), never a silent pass.
  // Bookkeeping for the team only: nothing is sent for a miss. Nothing is recorded for an established member.
  await import("./coldStart.js")
    .then((C) => C.noteColdStartSweep({ userId: candidate.userId, sweep: candidate.askId === PROFILE_ASK_ID ? "goal" : "ask", searched: candidate.askText, found: pending.length > 0, why: trace.found.length ? `found ${trace.found.length}, none offerable (already sent, past or set aside)` : "the search found nothing", tried: trace.did ?? [], turnedAway: trace.staleOrRepeat }))
    .catch((err: any) => console.error("attemptEventSurfacing: cold-start note failed (non-fatal):", err?.message ?? err));

  if (!pending.length) {
    await log("skip", trace.found.length ? "nothing_fresh" : "nothing_found");
    return { queued: false };
  }

  // A member whose sends Co's daily picker decides (services/sweepShadow.ts, Royce 2026-10-08): this sweep only feeds the
  // backlog. The picker judges the whole backlog across their asks, goals and texts, and queues its sends below
  // (queuePickedOffer), so nothing reaches them that the picker didn't choose.
  if (await pickerDecides(candidate.userId)) {
    await log("act", "fed_to_picker");
    // A find that ends before the next scheduled pick (10am their time) gets a pick run now, not a day late.
    if (found.some((f) => endsBeforeNextPick(f.match, zone))) {
      await import("./sweepShadow.js").then((m) => m.rerunPickerForUrgentFind(candidate.userId)).catch((err: any) => console.error("picker rerun for an urgent find failed (non-fatal):", err?.message ?? err));
    }
    return { queued: false, fed: true };
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
  // One offer per tier per run (2026-09-21): a missing tier holds nothing back,
  // and a person with a single ask still gets every tier that has something.
  const coveredTiers = new Set<number>(await waitingOfferTiers(candidate.userId));
  let queuedAny = false;

  for (const item of pending) {
    if (item.unread) continue; // held: its date isn't known yet (services/workingSet.ts)
    const targetKey = offerTargetKey(item);
    if (alreadyWaiting.has(targetKey)) {
      skipped.push({ name: item.match.name, why: "already queued" });
      continue;
    }
    if (tierAlreadyCovered(item, coveredTiers, isShortNotice(item.match, zone))) {
      skipped.push({ name: item.match.name, why: `tier ${item.match.tier} already has an offer waiting` });
      continue;
    }
    // No per-ask send hold here (2026-09-21, Royce: "the sweep should allow all
    // the tiers to be surfaced"). The old 3-day cadence parked Tier 3 finds for
    // days behind a Tier 2 send; pacing is the Layer 7 caps' job now (one room
    // text a day, four a week, the unanswered pause). Queueing is not sending.
    // Each try costs a fit read; four covers three tiers and a rejection.
    if (tried >= 4) break;
    tried++;

    const date = relevantDate(item.match);
    // Real details plus a personal reason, computed once when it's queued, so
    // the tease, the reveal, and any "tell me more" all work from the same
    // record (services/eventDetails.ts).
    // Co judged it when it kept it (services/sweepFind.ts): its reason rides
    // along, and only the real details are added here. Something found before
    // the sweep moved into Co's loop has no judgment, so it's dropped and the
    // next sweep looks again (2026-10-01).
    if (!item.match.whyItFits) {
      await removeFromBacklog(candidate.userId, candidate.askId, item.match);
      skipped.push({ name: item.match.name, why: "found before Co judged sweeps; the next sweep looks again" });
      continue;
    }
    const match = await enrichMatch(item.match);
    const payload: EventOfferPayload = {
      askId: candidate.askId,
      askText: item.askText,
      fromProfile: candidate.fromProfile ?? false,
      match,
      // Frustrated with what Co has found: send the real thing, not a tease
      // they have to answer before seeing it.
      ...(trace.frustratedWithCo ? { revealNow: true } : {}),
      ...(item.reminder ? { reminder: true } : {}),
      ...(item.again ? { again: true } : {}),
    };
    const { queued: ok } = await enqueueCandidate({
      userId: candidate.userId,
      type: "event_offer",
      targetKey,
      summary: `${item.reminder ? "Reminder, already shown to them: " : ""}${item.match.kind === "opportunity" ? "An opportunity" : "An event"} that fits ${candidate.fromProfile ? "what they've shared" : `their ask "${item.askText.slice(0, 120)}"`}: "${item.match.name}"${date ? ` (${date})` : ""}${isShortNotice(item.match, zone) ? ", short notice" : ""}`,
      payload,
      // Expires at the event's start (or the end of its day, or the
      // deadline's, in local time); an undated opportunity gets two weeks.
      expiresAt: offerExpiresAt(match, zone),
      // Short notice is the most time-bound thing Co can send.
      priority: isShortNotice(item.match, zone) ? 95 : trace.frustratedWithCo ? 85 : undefined,
    });
    if (ok) {
      await log("act", "queued", { queued: { name: item.match.name, tier: item.match.tier, date }, skipped });
      coveredTiers.add(item.match.tier);
      queuedAny = true;
      continue;
    }
    skipped.push({ name: item.match.name, why: "already sent or decided" });
  }

  if (queuedAny) return { queued: true };
  await log("skip", "nothing_queued", { skipped });
  return { queued: false };
}

// Members whose sends Co's daily picker decides: the picker accounts (sweepShadow.ts pickerUserIds), on co-test only.
export async function pickerDecides(userId: string): Promise<boolean> {
  const S = await import("./sweepShadow.js");
  return S.pickerLive() && (await S.pickerUserIds()).includes(userId);
}

// Queues one thing the picker chose to send, through the same queue and send step as every find (Royce, 2026-10-08): the
// send step bundles it by tier with whatever else is waiting (one per tier), checks it's still fresh, and holds it to the
// lane's one find a day, the pause after an unanswered text, and 8am-9pm. The picker's reason is the reason it fits.
// Returns false when it's already sent or decided (the queue keeps one row per thing).
export async function queuePickedOffer(userId: string, o: { askId: string; askText: string; fromProfile: boolean; match: TierMatch; reminder?: boolean; again?: boolean; why: string; lastDay?: string | null; pick?: { whyMember: string; whyNow: string; set: string | null } }): Promise<boolean> {
  const zone = await memberZone(userId);
  const item: BacklogItem = { askText: o.askText, match: o.match, source: "full", ...(o.reminder ? { reminder: true } : {}), ...(o.again ? { again: true } : {}) };
  if (await alreadyDecided(userId, item)) return false;
  if (isPastEvent(o.match, zone)) return false;
  const match = await enrichMatch({ ...o.match, whyItFits: o.why || o.match.whyItFits });
  // picked: the daily pick chose it, so the send step bundles it with the other picks waiting (any tier). lastDay: the last day
  // it's worth sending (Royce, 2026-10-09: "Fleet Week should never lose its slot to something that will still exist next week").
  const payload: EventOfferPayload = { askId: o.askId, askText: o.askText, fromProfile: o.fromProfile, match, picked: true, ...(o.pick ? { pick: o.pick } : {}), ...(o.lastDay ? { lastDay: o.lastDay } : {}), ...(o.reminder ? { reminder: true } : {}), ...(o.again ? { again: true } : {}) };
  const timeBound = pickPriority(o.lastDay ?? null, zone);
  // A failed earlier attempt for the same thing re-enters the working set: its row (the queue keeps one per thing) is cleared so this
  // pick lands in it, instead of the insert quietly doing nothing.
  await reopenFailedAttempt(userId, offerTargetKey(item));
  const { queued } = await enqueueCandidate({
    userId,
    type: "event_offer",
    targetKey: offerTargetKey(item),
    summary: `${o.reminder ? "Reminder, already shown to them: " : ""}${o.match.kind === "opportunity" ? "An opportunity" : "An event"} Co's daily pick chose for them: ${o.match.name}`,
    payload,
    // Whichever comes first: an event still expires at its start (the 2026-10-07 rule), a pick at the end of its last day.
    expiresAt: o.lastDay ? new Date(Math.min(endOfLocalDay(o.lastDay, zone).getTime(), offerExpiresAt(match, zone).getTime())) : offerExpiresAt(match, zone),
    // The higher of the two: short notice stays 95 even when the pick's last day is a few days out (review of #127).
    priority: Math.max(timeBound ?? 0, isShortNotice(o.match, zone) ? 95 : 0) || undefined,
  });
  return queued;
}

// Pure: a pick's rank from its last useful day, in their zone: today or tomorrow outranks everything (95), within three days 85,
// and anything with no end or further out keeps the default (undefined). Evergreen never takes a time-bound pick's slot.
export function pickPriority(lastDay: string | null, zone: string | null, now = new Date()): number | undefined {
  if (!lastDay) return undefined;
  const z = zone ?? "America/Los_Angeles";
  const days = DateTime.fromISO(lastDay, { zone: z }).startOf("day").diff(DateTime.fromJSDate(now).setZone(z).startOf("day"), "days").days;
  return days <= 1 ? 95 : days <= 3 ? 85 : undefined;
}

export { isShortNotice };

async function removeFromBacklog(userId: string, askId: string, match: TierMatch): Promise<void> {
  const items = await getBacklog(userId, askId);
  await saveBacklogMerged(userId, askId, items, items.filter((i) => !sameMatch(i.match, match)));
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
  } else if (!askId.startsWith(PROMISE_ASK_PREFIX)) {
    // A promise Co made on a call has no ask_checkins row
    // (harness/callGrounding.ts keepCallPromise).
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
     WHERE ac.user_id = $1 AND ac.resolved_at IS NULL AND ac.last_attempted_at IS NULL AND ac.kind = 'find'
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

