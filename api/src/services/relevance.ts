import pool from "../db/db.js";
import { isOpenAsk } from "../harness/profileWrite.js";
import { getActiveOfferingAsk, getActiveSeekingAsk, getOpenAsksOfType, scoreAgainstStatedAsk, scoreOfferingAgainstCandidates, type StatedIntent } from "./matching.js";
import { withTraceUser } from "./llmTraceText.js";
import { withMember } from "./llmUsage.js";

// Co Loop Stage 3 — "identify relevance." Runs scoreAgainstStatedAsk
// standalone against the whole network — no eligibility gating of any kind,
// a relevance signal between two people doesn't require anything else to be
// true first. Every candidate scored above LOG_SCORE_FLOOR is logged to
// relevance_edges, even a near-miss, not just a full match. Surfacing one
// real candidate at a time from this data (tease → reveal → double opt-in)
// is networkIntroNudge.ts's job, triggered per-ask from jobs/index.ts's
// event-surfacing cron (same ask_checkins rotation, right alongside the
// Tier 1/2/3 event/opportunity surfacing) — this file's job stays just
// computing and logging the graph.

const PREFILTER_LIMIT = 40;

// Below this, a candidate isn't worth storing even as a near-miss — cuts
// down on relevance_edges noise from genuinely irrelevant candidates that
// only entered the pool via the embedding pre-filter.
const LOG_SCORE_FLOOR = 20;

type RelevanceCandidate = {
  user_id: string;
  // Never shown to the scorer: it lets matching.ts leave out any item that names another candidate in the same prompt.
  first_name?: string;
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
//
// A candidate qualifies with goal_embeddings (written from a call transcript)
// OR an open ask that carries its own embedding (written on every capture,
// text included). Requiring goal_embeddings alone meant a member who had only
// texted could never be matched (2026-09-21). Distance is the closer of the
// two.
const OPEN_ASK_EMBEDDINGS = `
  SELECT (e->'embedding')::text::vector AS emb
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cp.intent) = 'array' THEN cp.intent ELSE '[]'::jsonb END) AS e
  WHERE e->>'status' = 'active' AND COALESCE(e->>'kind', 'ask') = 'ask' AND COALESCE(btrim(e->>'text'), '') <> '' AND jsonb_typeof(e->'embedding') = 'array'`;

async function prefilterCandidates(personId: string, askEmbedding: number[]): Promise<RelevanceCandidate[]> {
  const { rows } = await pool.query(
    `SELECT user_id, first_name, goals, blockers, activity_preferences, intent FROM (
       SELECT cp.user_id, u.first_name, cp.goals, cp.blockers, cp.activity_preferences, cp.intent,
              LEAST(
                COALESCE(cp.goal_embeddings <=> $2::vector, 2),
                COALESCE((SELECT MIN(x.emb <=> $2::vector) FROM (${OPEN_ASK_EMBEDDINGS}) x), 2)
              ) AS dist
       FROM co_profiles cp
       -- Only members still in the club and still texting: an archived or opted-out member is never scored (2026-10-12 audit:
       -- the first pass scored archived members, and only a later step dropped them).
       JOIN users u ON u.id = cp.user_id AND u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false
       WHERE cp.user_id != $1
         AND (cp.goal_embeddings IS NOT NULL OR EXISTS (${OPEN_ASK_EMBEDDINGS}))
     ) c
     ORDER BY dist
     LIMIT $3`,
    [personId, `[${askEmbedding.join(",")}]`, PREFILTER_LIMIT],
  );
  return rows.map((r: any) => ({
    user_id: r.user_id,
    first_name: r.first_name ?? undefined,
    goals: r.goals ?? undefined,
    blockers: r.blockers ?? undefined,
    activity_preferences: r.activity_preferences ?? undefined,
    intent: r.intent ?? undefined,
  }));
}

// The asker's first name, so no candidate's items carrying it reach the asker's prompt (matching.ts candidateLines). A failed
// read throws: the sweep for this ask skips (it runs again tomorrow) rather than scoring without the strip.
async function firstNameOf(userId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId]);
  return String(rows[0]?.first_name ?? "");
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
  scored: { user_id: string; score: number; reason: string; shareReason: string; mutual: boolean }[],
): Promise<void> {
  const loggable = scored.filter((s) => s.score >= LOG_SCORE_FLOOR);
  if (!loggable.length) return;
  await pool.query(
    `INSERT INTO relevance_edges (person_id, candidate_id, ask_id, ask_text, match_score, match_reason, share_reason, mutual)
     SELECT $1, x.candidate_id, $2, $3, x.score, x.reason, NULLIF(x.share_reason, ''), x.mutual
     FROM UNNEST($4::uuid[], $5::int[], $6::text[], $7::boolean[], $8::text[]) AS x(candidate_id, score, reason, mutual, share_reason)
     ON CONFLICT (person_id, candidate_id, ask_id) DO UPDATE SET
       match_score = EXCLUDED.match_score,
       match_reason = EXCLUDED.match_reason,
       share_reason = EXCLUDED.share_reason,
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
      loggable.map((s) => s.shareReason),
    ],
  );
}

// Direction: "I have a stated ask — who in the whole network satisfies it?"
// Fails silent, not closed — this is a background sweep, not a user-facing
// gate, so an error here just means this sweep found nothing this time, not
// that anyone was blocked from anything.
// The daily sweep covers a member's open asks, not just the newest one.
const MAX_ASKS_PER_SWEEP = 5;

// Every model call inside is this member's in llm_usage (services/llmUsage.ts withMember, cost per member 2026-10-23).
export async function sweepAskAgainstNetwork(...a: Parameters<typeof sweepAskAgainstNetworkInScope>): ReturnType<typeof sweepAskAgainstNetworkInScope> {
  return withMember(a[0], () => sweepAskAgainstNetworkInScope(...a));
}
async function sweepAskAgainstNetworkInScope(userId: string, opts: { all?: boolean } = {}): Promise<void> {
  const { rows } = await pool.query(
    `SELECT intent, goals, blockers, long_term_direction FROM co_profiles WHERE user_id = $1`,
    [userId],
  );
  const profile = rows[0];
  const newest = getActiveSeekingAsk(profile?.intent);
  const asks = opts.all ? getOpenAsksOfType(profile?.intent, "seeking").slice(-MAX_ASKS_PER_SWEEP) : newest ? [newest] : [];
  for (const ask of asks) await sweepOneSeekingAsk(userId, ask, profile);
}

async function sweepOneSeekingAsk(userId: string, ask: StatedIntent, profile: any): Promise<void> {
  if (!ask?.id || !ask.text || !ask.embedding?.length) return;

  try {
    const candidates = await prefilterCandidates(userId, ask.embedding);
    if (!candidates.length) return;

    // Short summary of the asker's own profile, given to scoreAgainstStatedAsk
    // only to judge the mutual/two-way flag — never to inflate the
    // one-directional score itself.
    const askerContext = askerContextOf(profile);

    const scored = await scoreAgainstStatedAsk(ask, candidates, askerContext, undefined, { askerFirstName: await firstNameOf(userId) });
    await logRelevanceEdges(
      userId,
      ask.id,
      ask.text,
      scored.map((s) => ({ user_id: s.candidate.user_id, score: s.score, reason: s.reason, shareReason: s.shareReason, mutual: s.mutual })),
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
// Every model call inside is this member's in llm_usage (services/llmUsage.ts withMember, cost per member 2026-10-23).
export async function sweepOfferingAgainstNetwork(...a: Parameters<typeof sweepOfferingAgainstNetworkInScope>): ReturnType<typeof sweepOfferingAgainstNetworkInScope> {
  return withMember(a[0], () => sweepOfferingAgainstNetworkInScope(...a));
}
async function sweepOfferingAgainstNetworkInScope(userId: string, opts: { all?: boolean } = {}): Promise<void> {
  const { rows } = await pool.query(
    `SELECT intent, goals, blockers, long_term_direction FROM co_profiles WHERE user_id = $1`,
    [userId],
  );
  const profile = rows[0];
  const newest = getActiveOfferingAsk(profile?.intent);
  const offerings = opts.all ? getOpenAsksOfType(profile?.intent, "offering").slice(-MAX_ASKS_PER_SWEEP) : newest ? [newest] : [];
  for (const offering of offerings) await sweepOneOffering(userId, offering);
}

async function sweepOneOffering(userId: string, offering: StatedIntent): Promise<void> {
  if (!offering?.id || !offering.text || !offering.embedding?.length) return;

  try {
    const candidates = await prefilterCandidates(userId, offering.embedding);
    if (!candidates.length) return;

    const scored = await scoreOfferingAgainstCandidates(offering, candidates, { askerFirstName: await firstNameOf(userId) });
    await logRelevanceEdges(
      userId,
      offering.id,
      offering.text,
      scored.map((s) => ({ user_id: s.candidate.user_id, score: s.score, reason: s.reason, shareReason: s.shareReason, mutual: s.mutual })),
    );
  } catch (err) {
    console.error(`sweepOfferingAgainstNetwork failed for user ${userId} (non-fatal):`, err);
  }
}

// The late-joiner gap (Royce, 2026-10-17: "fix ... the late-joiner matching
// gap"). A fresh ask is also the moment its member becomes someone other
// members' standing asks can find: the prefilter above qualifies a candidate
// by their open ask embeddings. The capture-time sweeps only look outward from
// the new ask, so the asks already on file met this member only at the next
// 3am pass, up to a day later. On dev every edge from a standing ask to
// someone who joined after it was written by the 3am pass, none at capture
// (91 of 91, 2026-10-17). So right after a fresh ask, the standing asks
// nearest to this member are checked against them alone: the same scorers and
// the same edge log as the 3am pass, one model call per ask, capped.
const STANDING_ASKS_PER_NEWCOMER = 5;

// askerFirstName: the standing asker, left out of the newcomer's items as the 3am pass does (matching.ts candidateLines).
export type StandingAsk = { personId: string; ask: StatedIntent; askerContext?: string; askerFirstName?: string };
type EdgeScore = { user_id: string; score: number; reason: string; shareReason: string; mutual: boolean };

export type NewcomerSweepDeps = {
  newcomer: (userId: string) => Promise<RelevanceCandidate | null>;
  standingAsksNear: (userId: string, limit: number) => Promise<StandingAsk[]>;
  scoreSeeking: (ask: StatedIntent, candidates: RelevanceCandidate[], askerContext?: string, askerFirstName?: string) => Promise<EdgeScore[]>;
  scoreOffering: (offering: StatedIntent, candidates: RelevanceCandidate[], askerFirstName?: string) => Promise<EdgeScore[]>;
  logEdges: (personId: string, askId: string, askText: string, scored: EdgeScore[]) => Promise<void>;
};

function askerContextOf(profile: any): string | undefined {
  const parts = [
    profile?.goals?.length ? `goals: ${profile.goals.join(", ")}` : null,
    profile?.blockers?.length ? `blockers: ${profile.blockers.join(", ")}` : null,
    profile?.long_term_direction ? `long-term direction: ${profile.long_term_direction}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join("; ") : undefined;
}

const toEdgeScores = (scored: { candidate: { user_id: string }; score: number; reason: string; shareReason: string; mutual: boolean }[]): EdgeScore[] =>
  scored.map((s) => ({ user_id: s.candidate.user_id, score: s.score, reason: s.reason, shareReason: s.shareReason, mutual: s.mutual }));

const realNewcomerDeps: NewcomerSweepDeps = {
  newcomer: async (userId) => {
    const { rows } = await pool.query(
      `SELECT cp.user_id, cp.goals, cp.blockers, cp.activity_preferences, cp.intent
       FROM co_profiles cp
       JOIN users u ON u.id = cp.user_id AND u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false
       WHERE cp.user_id = $1`,
      [userId],
    );
    const r = rows[0];
    return r ? { user_id: r.user_id, goals: r.goals ?? undefined, blockers: r.blockers ?? undefined, activity_preferences: r.activity_preferences ?? undefined, intent: r.intent ?? undefined } : null;
  },
  // Other members' open asks, nearest first by the same distance the
  // prefilter uses (the closer of this member's goal_embeddings and their
  // open ask embeddings), with the same live-member filter as the 3am pass.
  standingAsksNear: async (userId, limit) => {
    const { rows } = await pool.query(
      `WITH me AS (SELECT cp.goal_embeddings, cp.intent FROM co_profiles cp WHERE cp.user_id = $1),
            mine AS (
              SELECT (e->'embedding')::text::vector AS emb
              FROM me, jsonb_array_elements(CASE WHEN jsonb_typeof(me.intent) = 'array' THEN me.intent ELSE '[]'::jsonb END) AS e
              WHERE e->>'status' = 'active' AND COALESCE(e->>'kind', 'ask') = 'ask' AND COALESCE(btrim(e->>'text'), '') <> '' AND jsonb_typeof(e->'embedding') = 'array'
            )
       SELECT person_id, first_name, goals, blockers, long_term_direction, entry FROM (
         SELECT cp.user_id AS person_id, u.first_name, cp.goals, cp.blockers, cp.long_term_direction, a.entry,
                LEAST(
                  COALESCE((SELECT me.goal_embeddings FROM me) <=> (a.entry->'embedding')::text::vector, 2),
                  COALESCE((SELECT MIN(mine.emb <=> (a.entry->'embedding')::text::vector) FROM mine), 2)
                ) AS dist
         FROM co_profiles cp
         JOIN users u ON u.id = cp.user_id AND u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(cp.intent) = 'array' THEN cp.intent ELSE '[]'::jsonb END) AS a(entry)
         WHERE cp.user_id != $1
           AND a.entry->>'status' = 'active' AND COALESCE(a.entry->>'kind', 'ask') = 'ask'
           AND COALESCE(btrim(a.entry->>'text'), '') <> '' AND jsonb_typeof(a.entry->'embedding') = 'array'
       ) s
       ORDER BY dist
       LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r: any) => ({ personId: r.person_id, ask: r.entry as StatedIntent, askerContext: askerContextOf(r), askerFirstName: r.first_name ?? undefined }));
  },
  scoreSeeking: async (ask, candidates, askerContext, askerFirstName) => toEdgeScores(await scoreAgainstStatedAsk(ask, candidates, askerContext, undefined, { askerFirstName })),
  scoreOffering: async (offering, candidates, askerFirstName) => toEdgeScores(await scoreOfferingAgainstCandidates(offering, candidates, { askerFirstName })),
  logEdges: (personId, askId, askText, scored) => logRelevanceEdges(personId, askId, askText, scored),
};

export async function sweepStandingAsksForNewcomer(userId: string, deps: NewcomerSweepDeps = realNewcomerDeps): Promise<void> {
  try {
    const newcomer = await deps.newcomer(userId);
    if (!newcomer) return;
    const standing = await deps.standingAsksNear(userId, STANDING_ASKS_PER_NEWCOMER);
    for (const { personId, ask, askerContext, askerFirstName } of standing) {
      if (personId === userId || !isOpenAsk(ask) || !ask.id || !ask.text || !ask.embedding?.length) continue;
      try {
        // The prompt holds the standing asker's ask and context: it is theirs (trace text and cost under their id, so a removal of
        // theirs reaches it), never the newcomer's whose turn started this (review of #274, 2026-10-27).
        const scored = await withTraceUser(personId, () =>
          withMember(personId, () =>
            ask.type === "offering"
              ? deps.scoreOffering(ask, [newcomer], askerFirstName)
              : ask.type === "seeking"
                ? deps.scoreSeeking(ask, [newcomer], askerContext, askerFirstName)
                : Promise.resolve([] as EdgeScore[]),
          ),
        );
        if (scored.length) await deps.logEdges(personId, ask.id, ask.text, scored);
      } catch (err) {
        console.error(`sweepStandingAsksForNewcomer: ask ${ask.id} failed (non-fatal):`, err);
      }
    }
  } catch (err) {
    console.error(`sweepStandingAsksForNewcomer failed for user ${userId} (non-fatal):`, err);
  }
}

// Direction: "the network just changed — re-check every open ask against
// it." Re-running an existing ask is cheap and safe (logRelevanceEdges
// de-dupes/refreshes open rows). sweepStandingAsksForNewcomer above reaches a
// new joiner the moment their ask lands; this daily pass is the backstop for
// anyone that missed, and it refreshes every open edge as people change.
// Covers both directions — a standing "seeking" ask re-checked against new
// candidates, and a standing "offering" re-checked for new people who might
// want it. Run daily, not per-event — see jobs/index.ts — since looping
// every open ask through an LLM call on every single profile update would
// scale badly.
export async function sweepAllOpenAsks(): Promise<void> {
  // "Has a standing ask" means an intent entry that actually carries ask
  // text and is still active — the same thing getActiveSeekingAsk means.
  // jsonb_array_length alone also swept people whose only entries were the
  // text-less preference records captureIntent writes when a conversation
  // produced no ask (2026-09-20).
  const { rows } = await pool.query(
    `SELECT DISTINCT cp.user_id FROM co_profiles cp
     JOIN users u ON u.id = cp.user_id AND u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(cp.intent, '[]'::jsonb)) AS e
       WHERE e->>'status' = 'active' AND COALESCE(btrim(e->>'text'), '') <> ''
     )`,
  );
  // Each member's sweep (and the matching prompts it makes) under their own trace-text mark (services/llmTraceText.ts).
  for (const row of rows)
    await withTraceUser(row.user_id, async () => {
      await sweepAskAgainstNetwork(row.user_id, { all: true });
      await sweepOfferingAgainstNetwork(row.user_id, { all: true });
    });
}
