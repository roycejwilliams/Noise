import pool from "../db/db.js";
import { generateEmbedding } from "./embeddings.js";
import { scoreMatchedGroup, type ScorableGuest } from "./eventScoring.js";
import { recordDecision } from "../harness/core.js";

// "Nudge Co users at events Co doesn't own" — the non-Luma counterpart to
// eventScoring.ts. Two sources feed the same matching logic:
// - planned_event_mentions: fuzzy self-reports ("I'm going to X"), matched
//   by embedding similarity since there's no canonical event id.
// - surfaced_events: exact — Co itself recommended this real event
//   (event_api_id) to someone via the tiered recommendation engine.
// Unified 2026-08-30 (Royce) so a self-report and a surfaced-event
// recommendation for the SAME real event actually cross-match each other,
// not just within their own table.

// First-guess defaults, same spirit as the Luma pagination-limit default we
// left unset earlier — not backed by real tuning data yet.
const DATE_WINDOW_DAYS = 2;
const SIMILARITY_THRESHOLD = 0.85;

export type CrossMatch = { user_id: string; event_api_id: string | null; source?: "mention" | "surfaced" };

async function fetchScorableGuests(userIds: string[]): Promise<ScorableGuest[]> {
  if (!userIds.length) return [];
  const { rows } = await pool.query(
    `SELECT cp.user_id, u.first_name, u.phone_number, u.email, cp.city, cp.goals, cp.blockers, cp.activity_preferences, cp.intent
     FROM co_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE cp.user_id = ANY($1::uuid[]) AND coalesce(u.sms_opted_out, false) = false`,
    [userIds],
  );
  return rows;
}

// Checks BOTH tables for anyone else (excluding excludeUserId/excludeMentionId)
// whose embedding clears the bar within the date window — this is the piece
// that unifies the two sources. Prefers surfaced_events' real event_api_id
// as the canonical id when both tables produce matches.
async function findCrossMatches(
  excludeUserId: string,
  excludeMentionId: string | null,
  embedding: number[] | string,
  eventDate: string,
): Promise<CrossMatch[]> {
  // embedding arrives as a real number[] from a fresh generateEmbedding() call
  // (recordSurfacedEventAndMatch below), but as pgvector's own text format
  // ("[0.1,0.2,...]") when read back from a `vector` column via a plain
  // SELECT (matchAndScoreEventMention above) — pg has no type parser
  // registered for `vector`, so that column always comes back as a string,
  // not an array. Real gap found live, 2026-09-10: calling .join(",") on
  // that string crashed every mention-match attempt. It's already in the
  // exact literal form the query needs, so pass it through as-is.
  const embeddingLiteral = Array.isArray(embedding) ? `[${embedding.join(",")}]` : embedding;
  const [mentionRows, surfacedRows] = await Promise.all([
    pool.query(
      `SELECT user_id, NULL::text AS event_api_id, 'mention' AS source
       FROM planned_event_mentions
       -- Only their stated going counts (services/provenance.ts, 2026-10-12): a row from before provenance is never someone "going".
       WHERE provenance = 'stated' AND ($1::uuid IS NULL OR id != $1::uuid)
         AND user_id != $2
         AND event_date IS NOT NULL
         AND event_date BETWEEN $3::date - $4::int AND $3::date + $4::int
         AND 1 - (embedding <=> $5::vector) >= $6`,
      [excludeMentionId, excludeUserId, eventDate, DATE_WINDOW_DAYS, embeddingLiteral, SIMILARITY_THRESHOLD],
    ),
    pool.query(
      `SELECT user_id, event_api_id, 'surfaced' AS source
       FROM surfaced_events
       WHERE user_id != $1
         AND event_date IS NOT NULL
         AND embedding IS NOT NULL
         AND event_date BETWEEN $2::date - $3::int AND $2::date + $3::int
         AND 1 - (embedding <=> $4::vector) >= $5`,
      [excludeUserId, eventDate, DATE_WINDOW_DAYS, embeddingLiteral, SIMILARITY_THRESHOLD],
    ),
  ]);
  return [...mentionRows.rows, ...surfacedRows.rows];
}

// Stable per-pair id when neither side has a real Luma event (code review,
// 2026-09-17): this used to fall back to `self:${mentionId}`, a fresh id
// every time either side re-mentioned the same plans, which reset the
// one-nudge-per-event dedup (event_guest_match_nudges is keyed on event_id)
// and let the exact same pair get nudged about each other again and again.
// Deriving it from the sorted set of matched user_ids instead keeps it
// identical across repeated mentions of the same real people, and only
// changes when the actual group of matched people changes.
// Exported so evals/proactive/rules.ts can test the dedupe key directly.
export function pickCanonicalEventId(matches: CrossMatch[], matchedUserIds: string[]): string {
  const real = matches.find((m) => m.event_api_id)?.event_api_id;
  return real ?? `self:${[...matchedUserIds].sort().join(",")}`;
}

// Called right after a new planned_event_mentions row is inserted
// (profileExtraction.ts's extractPlannedEventMention).
export async function matchAndScoreEventMention(mentionId: string): Promise<void> {
  const { rows: mentionRows } = await pool.query(
    `SELECT id, user_id, event_name_raw, event_date, embedding
     FROM planned_event_mentions WHERE id = $1 AND provenance = 'stated'`,
    [mentionId],
  );
  const mention = mentionRows[0];
  if (!mention || !mention.embedding) return;

  if (!mention.event_date) {
    console.log(`eventMatching: mention ${mentionId} has no resolved date — skipping match (no reliable window)`);
    return;
  }

  const found = await findCrossMatches(mention.user_id, mentionId, mention.embedding, mention.event_date);
  // Only people who said they're going count (2026-09-23). A surfaced_events
  // row means Co recommended the event, not that they're going, so it can
  // give the event its real id but never adds a person to the group.
  const matches = attendeesOnly(found);
  if (!matches.length) return; // no one else said they're going to the same event yet

  const matchedUserIds = [...new Set([mention.user_id, ...matches.map((m) => m.user_id)])];
  const matched = await fetchScorableGuests(matchedUserIds);
  // Real Luma id if any matched record has one (a surfaced_events match),
  // otherwise a synthetic id stable across repeated mentions of the same
  // people — there's no canonical event record when it's purely two
  // self-reports matching each other.
  const eventId = pickCanonicalEventId(found, matchedUserIds);
  await recordDecision({
    layer: 6,
    decision: "event.overlap",
    userId: mention.user_id,
    outcome: "act",
    action: "outside_event",
    proposal: { eventId, members: matchedUserIds.length },
  }).catch(() => {});

  console.log(
    `eventMatching: mention ${mentionId} ("${mention.event_name_raw}") matched ${matches.length} other Co user(s) (event id: ${eventId}), scoring group`,
  );
  await scoreMatchedGroup(eventId, mention.event_name_raw, matched, null);
}

// Called right after a real event gets surfaced/recommended to someone
// (recommendation.ts's reactive path, eventSurfacingSweep.ts's periodic
// cadence sweep).
// eventDate is the EVENT's own date (ISO, YYYY-MM-DD) — required now, not
// optional, since matching against planned_event_mentions needs a real date
// window; a surfacing with no confident date isn't recorded.
//
// startAt/endAt (2026-09-17): a real Tier 1/2 event has real timing
// available (the same fields scoreGuestListForEvent's live path already
// uses), but this was always passed to scoreMatchedGroup as null anyway —
// not unsafe (still routed through the Layer 7 ledger either way), just a
// missed chance at checkEventWindow's tighter timing read. Optional and
// nullable so a caller with no details fetched yet degrades to the same
// behavior as before.
export async function recordSurfacedEventAndMatch(
  userId: string,
  eventApiId: string,
  eventName: string,
  eventDate: string,
  startAt?: string | null,
  endAt?: string | null,
): Promise<void> {
  // Recorded only (2026-09-23). Co recommending an event isn't the member
  // going, so this no longer matches anyone; the recorded row still lends a
  // real event id to people who later say they're going.
  const embedding = await generateEmbedding(eventName).catch((err: any) => {
    console.error("recordSurfacedEventAndMatch: generateEmbedding failed (non-fatal):", err?.message ?? err);
    return null;
  });

  await pool.query(
    `INSERT INTO surfaced_events (user_id, event_api_id, event_name, event_date, embedding)
     VALUES ($1, $2, $3, $4, $5::vector)`,
    [userId, eventApiId, eventName, eventDate, embedding ? `[${embedding.join(",")}]` : null],
  );

  void startAt;
  void endAt;
}

// People from planned_event_mentions (they said they're going), never from
// surfaced_events (Co only recommended it). Exported for evals.
export function attendeesOnly(found: CrossMatch[]): CrossMatch[] {
  return found.filter((m) => m.source === "mention");
}

// Is matching at events Co doesn't run worth it? (Royce, 2026-09-23: "if
// overlap stays rare, that's a sign to put the effort into Co's own events".)
// Over the last `days`: how many outside events had 2+ members going, how
// many anonymous heads-ups went out, and how many pairs both said yes (the
// intro email goes out on that second yes).
export async function outsideEventOverlapStats(days = 30): Promise<{ eventsWithOverlap: number; headsUps: number; bothSaidYes: number }> {
  const [overlap, headsUps, both] = await Promise.all([
    pool.query(
      `SELECT COUNT(DISTINCT proposal->>'eventId')::int AS n FROM harness_decisions
       WHERE decision = 'event.overlap' AND created_at > NOW() - ($1 || ' days')::interval`,
      [days],
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM event_guest_match_nudges WHERE anonymous AND sent_at > NOW() - ($1 || ' days')::interval`, [days]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM event_guest_match_opt_ins a
       JOIN event_guest_match_opt_ins b ON b.event_id = a.event_id AND b.person_id = a.candidate_id AND b.candidate_id = a.person_id
       WHERE a.status = 'interested' AND b.status = 'interested' AND a.person_id < a.candidate_id
         AND EXISTS (SELECT 1 FROM event_guest_match_nudges n WHERE n.event_id = a.event_id AND n.anonymous)
         AND GREATEST(a.decided_at, b.decided_at) > NOW() - ($1 || ' days')::interval`,
      [days],
    ),
  ]);
  return { eventsWithOverlap: overlap.rows[0].n, headsUps: headsUps.rows[0].n, bothSaidYes: both.rows[0].n };
}
