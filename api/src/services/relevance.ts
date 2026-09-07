import pool from "../db/db.js";
import { getActiveOfferingAsk, getActiveSeekingAsk, scoreAgainstStatedAsk, scoreOfferingAgainstCandidates } from "./matching.js";
import { maybeSendNetworkIntroNudges } from "./networkIntroNudge.js";

// Co Loop Stage 3 — "identify relevance." Runs scoreAgainstStatedAsk
// standalone against the whole network — no eligibility gating of any kind,
// a relevance signal between two people doesn't require anything else to be
// true first. Every candidate scored above LOG_SCORE_FLOOR is logged to
// relevance_edges, even a near-miss, not just a full match. Surfacing a real
// shortlist (1-5 people) from this data to the person themselves is
// networkIntroNudge.ts's job, called at the end of sweepAllOpenAsks below —
// this file's job stays just computing and logging the graph.

const PREFILTER_LIMIT = 40;

// Below this, a candidate isn't worth storing even as a near-miss — cuts
// down on relevance_edges noise from genuinely irrelevant candidates that
// only entered the pool via the embedding pre-filter.
const LOG_SCORE_FLOOR = 20;

type RelevanceCandidate = {
  user_id: string;
  goals?: string[];
  blockers?: string[];
  activity_preferences?: string[];
  intent?: unknown;
};

// Cheap embedding-similarity pass before the expensive per-candidate LLM
// check in scoreAgainstStatedAsk. Without this, sweeping "the whole network"
// would mean reasoning over every profile on every sweep — this narrows to
// the most plausible candidates first, ordered by cosine distance between
// the ask's own embedding and each candidate's goal_embeddings (same
// cross-embedding comparison fetchTopMemoryPerCandidate already does in
// matching.ts, just against goal_embeddings instead of memory embeddings).
// Also pulls each candidate's own intent[] — used by scoreAgainstStatedAsk's
// mutual/two-way check, not by this prefilter itself.
async function prefilterCandidates(personId: string, askEmbedding: number[]): Promise<RelevanceCandidate[]> {
  const { rows } = await pool.query(
    `SELECT cp.user_id, cp.goals, cp.blockers, cp.activity_preferences, cp.intent
     FROM co_profiles cp
     WHERE cp.user_id != $1 AND cp.goal_embeddings IS NOT NULL
     ORDER BY cp.goal_embeddings <=> $2::vector
     LIMIT $3`,
    [personId, `[${askEmbedding.join(",")}]`, PREFILTER_LIMIT],
  );
  return rows.map((r: any) => ({
    user_id: r.user_id,
    goals: r.goals ?? undefined,
    blockers: r.blockers ?? undefined,
    activity_preferences: r.activity_preferences ?? undefined,
    intent: r.intent ?? undefined,
  }));
}

// ON CONFLICT ... DO UPDATE (not DO NOTHING) so a re-sweep refreshes the
// score/reason/mutual as the network's context changes — but only while the
// edge is still 'open'; a retired or acted_on row keeps whatever it looked
// like at the point Stage 6 closed it out, rather than being silently
// rewritten by a later sweep. This is still what makes sweepAllOpenAsks safe
// to re-run daily: no duplicate rows, just refreshed data on open ones.
async function logRelevanceEdges(
  personId: string,
  askId: string,
  askText: string,
  scored: { user_id: string; score: number; reason: string; mutual: boolean }[],
): Promise<void> {
  const loggable = scored.filter((s) => s.score >= LOG_SCORE_FLOOR);
  if (!loggable.length) return;
  await pool.query(
    `INSERT INTO relevance_edges (person_id, candidate_id, ask_id, ask_text, match_score, match_reason, mutual)
     SELECT $1, x.candidate_id, $2, $3, x.score, x.reason, x.mutual
     FROM UNNEST($4::uuid[], $5::int[], $6::text[], $7::boolean[]) AS x(candidate_id, score, reason, mutual)
     ON CONFLICT (person_id, candidate_id, ask_id) DO UPDATE SET
       match_score = EXCLUDED.match_score,
       match_reason = EXCLUDED.match_reason,
       mutual = EXCLUDED.mutual
     WHERE relevance_edges.status = 'open'`,
    [
      personId,
      askId,
      askText,
      loggable.map((s) => s.user_id),
      loggable.map((s) => s.score),
      loggable.map((s) => s.reason),
      loggable.map((s) => s.mutual),
    ],
  );
}

// Direction: "I have a stated ask — who in the whole network satisfies it?"
// Fails silent, not closed — this is a background sweep, not a user-facing
// gate, so an error here just means this sweep found nothing this time, not
// that anyone was blocked from anything.
export async function sweepAskAgainstNetwork(userId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT intent, goals, blockers, long_term_direction FROM co_profiles WHERE user_id = $1`,
    [userId],
  );
  const profile = rows[0];
  const ask = getActiveSeekingAsk(profile?.intent);
  if (!ask?.id || !ask.text || !ask.embedding?.length) return;

  try {
    const candidates = await prefilterCandidates(userId, ask.embedding);
    if (!candidates.length) return;

    // Short summary of the asker's own profile, given to scoreAgainstStatedAsk
    // only to judge the mutual/two-way flag — never to inflate the
    // one-directional score itself.
    const askerContextParts = [
      profile?.goals?.length ? `goals: ${profile.goals.join(", ")}` : null,
      profile?.blockers?.length ? `blockers: ${profile.blockers.join(", ")}` : null,
      profile?.long_term_direction ? `long-term direction: ${profile.long_term_direction}` : null,
    ].filter((p): p is string => Boolean(p));
    const askerContext = askerContextParts.length ? askerContextParts.join("; ") : undefined;

    const scored = await scoreAgainstStatedAsk(ask, candidates, askerContext);
    await logRelevanceEdges(
      userId,
      ask.id,
      ask.text,
      scored.map((s) => ({ user_id: s.candidate.user_id, score: s.score, reason: s.reason, mutual: s.mutual })),
    );
  } catch (err) {
    console.error(`sweepAskAgainstNetwork failed for user ${userId} (non-fatal):`, err);
  }
}

// Reverse direction of sweepAskAgainstNetwork: "I have something to offer —
// who in the network would actually want it?" Without this, an "offering"
// ask never gets proactively matched to anyone; it only ever shows up as a
// side-effect of someone ELSE's seeking sweep finding the offerer as a
// candidate. Structurally a mirror of sweepAskAgainstNetwork: same prefilter,
// same relevance_edges log, just person_id/candidate_id reversed — the edge
// is logged from the OFFERER's side (person_id = offerer, candidate_id =
// the person who'd likely want it), same as every other relevance_edges row
// is logged from the ask-holder's side.
export async function sweepOfferingAgainstNetwork(userId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT intent, goals, blockers, long_term_direction FROM co_profiles WHERE user_id = $1`,
    [userId],
  );
  const profile = rows[0];
  const offering = getActiveOfferingAsk(profile?.intent);
  if (!offering?.id || !offering.text || !offering.embedding?.length) return;

  try {
    const candidates = await prefilterCandidates(userId, offering.embedding);
    if (!candidates.length) return;

    const scored = await scoreOfferingAgainstCandidates(offering, candidates);
    await logRelevanceEdges(
      userId,
      offering.id,
      offering.text,
      scored.map((s) => ({ user_id: s.candidate.user_id, score: s.score, reason: s.reason, mutual: s.mutual })),
    );
  } catch (err) {
    console.error(`sweepOfferingAgainstNetwork failed for user ${userId} (non-fatal):`, err);
  }
}

// Direction: "the network just changed — re-check every open ask against
// it." Re-running an existing ask is cheap and safe (logRelevanceEdges
// de-dupes/refreshes open rows), so this is what actually surfaces a new
// joiner to everyone who already has a standing ask, without needing a
// separate reverse-search path keyed off the joiner instead of the asker.
// Covers both directions — a standing "seeking" ask re-checked against new
// candidates, and a standing "offering" re-checked for new people who might
// want it. Run daily, not per-event — see jobs/index.ts — since looping
// every open ask through an LLM call on every single profile update would
// scale badly.
export async function sweepAllOpenAsks(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT DISTINCT user_id FROM co_profiles WHERE intent IS NOT NULL AND jsonb_array_length(intent) > 0`,
  );
  for (const row of rows) {
    await sweepAskAgainstNetwork(row.user_id);
    await sweepOfferingAgainstNetwork(row.user_id);
    await maybeSendNetworkIntroNudges(row.user_id).catch((err: any) =>
      console.error(`sweepAllOpenAsks: network intro nudge failed for ${row.user_id} (non-fatal):`, err?.message ?? err),
    );
  }
}
