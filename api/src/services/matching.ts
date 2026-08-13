import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";

const MATCH_RADIUS_MILES = parseFloat(process.env.MATCH_RADIUS_MILES ?? "25");
const METERS_PER_MILE = 1609.344;

//never fewer than 4 people
const min_size = 4;
///never more than 8 people
const max_size = 8;
//ideal target size
const target_size = 6;
// Single confidence line: a group scoring at or above this places
// autonomously (Co decided on its own); below it, the group still gets
// formed and returned (never silently dropped) but goes to the Moderator
// for review — see circleApproval.ts.
const min_group_score = 0.55;
//trust score - separates high trusted users
const trust_floor = 0.4;
const trust_ceiling = 0.8;

// PostgreSQL returns vector columns as strings — parse them back to number arrays
// Returns [] for null/undefined — callers treat empty vector as zero-score (no goals)
function parseEmbedding(embedding: string | number[] | null | undefined): number[] {
  if (!embedding) return [];
  if (typeof embedding === "string") {
    // pgvector returns format: [0.1,0.2,...] — valid JSON array
    // but sometimes returns without brackets
    const cleaned = embedding.startsWith("[") ? embedding : `[${embedding}]`;
    return JSON.parse(cleaned);
  }
  return embedding;
}

function hasSharedChapters(groupChapters: string[][]): boolean {
  const baseline = groupChapters[0];

  const filter = baseline.filter((chapter) => {
    return groupChapters
      .slice(1)
      .every((userChapter) => userChapter.includes(chapter));
  });

  return filter.length >= 1;
}

//Filter 2: Must be in the same city
function inSameCity(cityA: string, cityB: string): boolean {
  return cityA.toLowerCase().trim() === cityB.toLowerCase().trim();
}

// Chapter depth scoring — Jaccard similarity across the whole group
// Measures HOW STRONG the chapter alignment is (not just if it exists)
// The hard filter already confirmed at least 1 shared chapter exists
// This scores the quality of that overlap — more shared chapters = higher score
// Weight: 0.30 (heaviest dimension in the overall compatibility score)
function chapterDepthScore(groupChapters: string[][]): number {
  // Flatten all chapters and get every unique chapter across the group
  const union = [...new Set(groupChapters.flat())];

  // Find chapters that appear in EVERY member's array
  const shared = union.filter((chapter) =>
    groupChapters.every((userChapters) => userChapters.includes(chapter)),
  );

  if (union.length === 0) return 0;

  // Jaccard = shared / union
  const score = shared.length / union.length;

  // Bonus multiplier if 2+ chapters are shared across the whole group
  // Signals deep alignment — not just surface level overlap
  return shared.length >= 2 ? Math.min(score * 1.2, 1) : score;
}

function socialEnergyScore(energyLevels: number[]): number {
  // Calculate the average energy of the group
  const avg = energyLevels.reduce((sum, e) => sum + e, 0) / energyLevels.length;

  // Calculate how far each member is from the group average
  const deviations = energyLevels.map((e) => Math.abs(e - avg));

  // Average deviation across the group
  const avgDeviation =
    deviations.reduce((sum, d) => sum + d, 0) / deviations.length;

  // Score: 1 - (avgDeviation / 100)
  // ±20 deviation = 0.80 score (natural)
  // ±40 deviation = 0.60 score (starts dropping)
  // ±60 deviation = 0.40 score (bad fit)
  const score = 1 - avgDeviation / 100;

  return Math.max(0, score);
}

// Activity overlap scoring — Jaccard similarity on activity_preferences[]
// At least 1 shared activity required — gives the group something to DO together
// Weight: 0.20 in the overall compatibility score
function activityOverlapScore(groupActivities: string[][]): number {
  // All unique activities across the group
  const union = [...new Set(groupActivities.flat())];

  // Activities that appear in every member's array
  const shared = union.filter((activity) =>
    groupActivities.every((userActivities) =>
      userActivities.includes(activity),
    ),
  );

  if (union.length === 0) return 0;

  return shared.length / union.length;
}

// Goal alignment scoring — cosine similarity on goal embeddings
// Similar enough to relate, different enough to not compete
// Weight: 0.15 in the overall compatibility score
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  // Dot product of the two vectors
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);

  // Magnitude of each vector
  const magA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

  if (magA === 0 || magB === 0) return 0;

  return dot / (magA * magB);
}

function goalAlignmentScore(groupEmbeddings: number[][]): number {
  if (groupEmbeddings.length < 2) return 0;

  let totalScore = 0;
  let pairCount = 0;

  // Compare every pair of embeddings in the group
  for (let i = 0; i < groupEmbeddings.length; i++) {
    for (let j = i + 1; j < groupEmbeddings.length; j++) {
      totalScore += cosineSimilarity(groupEmbeddings[i], groupEmbeddings[j]);
      pairCount++;
    }
  }

  // Average pairwise cosine similarity across the group
  return totalScore / pairCount;
}

// Emotional state scoring — avoid extremes together
// Bucket users into 3 zones: struggling / steady / thriving
// Same or adjacent zones = 1, two zones apart = 0.3
// Weight: 0.10 in the overall compatibility score
type EmotionalZone = "struggling" | "steady" | "thriving";

function getEmotionalZone(state: string): EmotionalZone {
  const struggling = ["anxious", "isolated", "overwhelmed", "lost", "burnout"];
  const thriving = [
    "energized",
    "confident",
    "motivated",
    "excited",
    "focused",
  ];

  if (struggling.some((s) => state.toLowerCase().includes(s)))
    return "struggling";
  if (thriving.some((t) => state.toLowerCase().includes(t))) return "thriving";
  return "steady";
}

function emotionalStateScore(emotionalStates: string[]): number {
  const zones = emotionalStates.map(getEmotionalZone);

  let totalScore = 0;
  let pairCount = 0;

  const zoneValues: Record<EmotionalZone, number> = {
    struggling: 0,
    steady: 1,
    thriving: 2,
  };

  // Compare every pair
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const diff = Math.abs(zoneValues[zones[i]] - zoneValues[zones[j]]);
      // Same zone = 1.0, adjacent = 0.65, two apart = 0.3
      totalScore += diff === 0 ? 1 : diff === 1 ? 0.65 : 0.3;
      pairCount++;
    }
  }

  return totalScore / pairCount;
}

// Proximity score — linear decay from 1.0 (same location) to 0.0 (at/beyond radius)
// Returns null when either user has no GPS coordinates (score excluded from weights)
function proximityScore(distanceMeters: number | null): number | null {
  if (distanceMeters === null) return null;
  const radiusMeters = MATCH_RADIUS_MILES * METERS_PER_MILE;
  return Math.max(0, 1 - distanceMeters / radiusMeters);
}

// Overall compatibility score — weighted sum of 5 core dimensions,
// with a 6th proximity dimension added when GPS data is available for both users.
// When proximity is available the weights shift slightly to accommodate it while
// keeping the total at 1.0.
function groupCompatibilityScore(group: {
  life_chapters: string[][];
  social_energy: number[];
  activity_preferences: string[][];
  goal_embeddings: (string | number[] | null | undefined)[];
  emotional_states: string[];
  distances_meters?: (number | null)[];
}): number {
  const size = group.life_chapters.length;
  if (size < 2) return 0;

  let totalScore = 0;
  let pairCount = 0;

  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      const distMeters =
        group.distances_meters
          ? (group.distances_meters[i] !== null && group.distances_meters[j] !== null
              ? Math.max(group.distances_meters[i]!, group.distances_meters[j]!)
              : null)
          : null;

      const prox = proximityScore(distMeters);
      const hasProx = prox !== null;

      // Weights with proximity (sum = 1.0)
      const w = hasProx
        ? { chapter: 0.27, social: 0.23, activity: 0.18, goal: 0.14, emotional: 0.09, proximity: 0.09 }
        : { chapter: 0.30, social: 0.25, activity: 0.20, goal: 0.15, emotional: 0.10, proximity: 0 };

      const pairScore =
        chapterDepthScore([group.life_chapters[i], group.life_chapters[j]]) * w.chapter +
        socialEnergyScore([group.social_energy[i], group.social_energy[j]]) * w.social +
        activityOverlapScore([group.activity_preferences[i], group.activity_preferences[j]]) * w.activity +
        goalAlignmentScore([
          parseEmbedding(group.goal_embeddings[i]),
          parseEmbedding(group.goal_embeddings[j]),
        ]) * w.goal +
        emotionalStateScore([group.emotional_states[i], group.emotional_states[j]]) * w.emotional +
        (hasProx ? prox! * w.proximity : 0);

      totalScore += pairScore;
      pairCount++;
    }
  }

  return totalScore / pairCount;
}

// One entry from co_profiles.intent, as written by captureIntent
// (profileExtraction.ts) — embedding is whatever was computed from the ask
// text at capture time, reused here rather than re-embedding.
type StatedIntent = {
  text?: string;
  type?: "seeking" | "offering";
  status?: string;
  embedding?: number[] | null;
};

// captureIntent appends asks over time as calls happen — take the most
// recent active "seeking" one as the operative filter for this placement.
// "offering" asks describe what the person can give others, not who they
// want to be grouped with, so those are left alone.
function getActiveSeekingAsk(intent: unknown): StatedIntent | null {
  if (!Array.isArray(intent)) return null;
  const seeking = (intent as StatedIntent[]).filter(
    (i) => i?.status === "active" && i?.type === "seeking" && i?.text,
  );
  return seeking.length ? seeking[seeking.length - 1] : null;
}

// Pulls each candidate's single most semantically relevant stored memory
// (call transcripts, text exchanges, etc.) against the ask's embedding — this
// is what lets a fact like "worked at Google" surface even though nothing in
// the structured profile schema tags job history; it's just whatever the
// person actually said, found generically rather than via a fixed taxonomy.
async function fetchTopMemoryPerCandidate(
  candidateIds: string[],
  askEmbedding: number[],
): Promise<Map<string, string>> {
  if (!candidateIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (user_id) user_id, content
     FROM co_memories
     WHERE user_id = ANY($1::uuid[]) AND content_embedding IS NOT NULL
     ORDER BY user_id, content_embedding <=> $2::vector`,
    [candidateIds, `[${askEmbedding.join(",")}]`],
  );
  return new Map(rows.map((r: any) => [r.user_id as string, r.content as string]));
}

// A stated ask ("find founders with experience at Google") is the strongest,
// most explicit signal a user can give about who belongs in their circle —
// applied here as a hard filter alongside city/life-chapter, not folded into
// the scored dimensions below. Deliberately generic: it judges whatever's
// actually on file (existing profile fields plus each candidate's own
// top-matching stored memory) rather than any fixed set of attributes, so it
// works the same whether the ask is about a career background, a hobby, or a
// life circumstance.
async function filterByStatedAsk<
  T extends {
    user_id: string;
    goals?: string[];
    blockers?: string[];
    activity_preferences?: string[];
  },
>(ask: StatedIntent, candidates: T[]): Promise<T[]> {
  if (!candidates.length || !ask.text) return candidates;

  const memoryByUser =
    ask.embedding && ask.embedding.length
      ? await fetchTopMemoryPerCandidate(candidates.map((c) => c.user_id), ask.embedding)
      : new Map<string, string>();

  const digest = candidates
    .map((c, i) => {
      const facts = [...(c.goals ?? []), ...(c.blockers ?? []), ...(c.activity_preferences ?? [])];
      const memory = memoryByUser.get(c.user_id);
      const parts = [
        facts.length ? facts.join("; ") : null,
        memory ? `mentioned: "${memory}"` : null,
      ].filter(Boolean);
      return `${i}. ${parts.length ? parts.join(" | ") : "(nothing on file)"}`;
    })
    .join("\n");

  try {
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "matching.filterByStatedAsk" },
      prompt: `Someone wants to be grouped with people who match this: "${ask.text}"

Here is what's known about each candidate, one per line:
${digest}

Which candidate numbers actually satisfy that criteria, based only on what's listed? Do not assume or infer facts that aren't present — if nothing on file supports it, that candidate does not satisfy it.

Return ONLY valid JSON, no preamble: {"matching_indices": [0, 2]}`,
    });

    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const indices: number[] = Array.isArray(parsed.matching_indices) ? parsed.matching_indices : [];
    return indices
      .filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length)
      .map((i) => candidates[i]);
  } catch (err) {
    // Fail closed — an explicit stated requirement that we can't verify is
    // treated as unmet, same as any other hard filter falling short, rather
    // than silently ignoring what the person asked for.
    console.error("filterByStatedAsk failed, treating as no matches (non-fatal):", err);
    return [];
  }
}

// Trust score check — don't mix chronic ghosts with high-trust users
// New users start at 0.5 (neutral)
function passesTrustCheck(trustScores: number[]): boolean {
  const hasHighTrust = trustScores.some((t) => t >= trust_ceiling);
  const hasLowTrust = trustScores.some((t) => t < trust_floor);

  // If the group has both high-trust and low-trust users — reject
  return !(hasHighTrust && hasLowTrust);
}

// Main matching function — assembles the best circle for a given user
// Called by POST /co/place. Returns both the user IDs and the final group
// score — callers that create a pending_approval circle need the score to
// flag low-confidence placements (see circleApproval.ts); findBestCircle
// below is a thin wrapper for callers that only need the IDs.
async function findBestCircleWithScore(
  userId: string,
  excludeUserIds: string[] = [],
): Promise<{ userIds: string[]; finalScore: number } | null> {
  // Step 1 — Fetch the user being placed (lat/lng extracted for PostGIS queries)
  const userResult = await pool.query(
    `SELECT *,
            ST_Y(coordinates) AS lat,
            ST_X(coordinates) AS lng
     FROM co_profiles WHERE user_id = $1`,
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return null;


  // Step 2 — Fetch candidates in the same city. City is the sole geographic
  // authority for matching — GPS coordinates are not used to expand or
  // redirect this beyond what the user's stated city says (a bad/stale
  // coordinate value must never silently pull in candidates, or bias a
  // venue search, toward the wrong city — confirmed: this happened for
  // real with a leftover test coordinate pointing at NYC for an SF user).
  const candidatesResult = await pool.query(
    `SELECT cp.*, u.id as user_id
     FROM co_profiles cp
     JOIN users u ON cp.user_id = u.id
     WHERE cp.user_id != $2
     AND cp.user_id != ALL($3::uuid[])
     AND cp.life_chapters != '{}'
     AND cp.goal_embeddings IS NOT NULL
     AND cp.city = $1`,
    [user.city, userId, excludeUserIds],
  );

  const candidates = candidatesResult.rows;

  // Need at least MIN_CIRCLE_SIZE - 1 candidates to even attempt a group
  if (candidates.length < min_size - 1) return null;

  // Step 3 — Apply hard filters
  // Remove candidates who don't share at least 1 life chapter with the user
  let filtered = candidates.filter((candidate) =>
    hasSharedChapters([user.life_chapters, candidate.life_chapters]),
  );

  // Not enough candidates after filtering
  if (filtered.length < min_size - 1) return null;

  // Step 3.5 — If the user has an active stated ask (e.g. "find founders
  // with experience at Google"), narrow the pool to candidates who actually
  // satisfy it before scoring — see filterByStatedAsk.
  const activeAsk = getActiveSeekingAsk(user.intent);
  if (activeAsk) {
    filtered = await filterByStatedAsk(activeAsk, filtered);
    if (filtered.length < min_size - 1) return null;
  }


  // Step 4 — Score all candidates against the user
  // Pairwise scoring — how well does each candidate match the user
  const scored = filtered.map((candidate) => {
    const score = groupCompatibilityScore({
      life_chapters: [user.life_chapters, candidate.life_chapters],
      social_energy: [user.social_energy, candidate.social_energy],
      activity_preferences: [
        user.activity_preferences,
        candidate.activity_preferences,
      ],
      goal_embeddings: [
        parseEmbedding(user.goal_embeddings),
        parseEmbedding(candidate.goal_embeddings),
      ],
      emotional_states: [user.emotional_state, candidate.emotional_state],
      distances_meters: [null, candidate.distance_meters ?? null],
    });
    return { ...candidate, score };
  });


  // Sort by score descending — best matches first
  scored.sort((a, b) => b.score - a.score);


  // Step 5 — Assemble the group
  // Target size first — try to fill to target_size
  // If not enough, fall back to min_size
  // Never exceed max_size
  let group = scored.slice(0, Math.min(target_size - 1, max_size - 1));

  // If we fell short of target, try pulling more candidates
  if (group.length < target_size - 1 && scored.length >= min_size - 1) {
    group = scored.slice(0, Math.min(scored.length, max_size - 1));
  }

  // Still below minimum — no valid circle, flag for manual placement
  if (group.length < min_size - 1) return null;

  // Step 6 — Trust check
  // Don't mix chronic ghosts (low trust) with high-trust users
  const trustScores = [user.trust_score, ...group.map((m) => m.trust_score)];
  if (!passesTrustCheck(trustScores)) {
    // Remove low-trust members and try again with remaining candidates
    const cleanGroup = group.filter((m) => m.trust_score >= trust_floor);

    // After removing low-trust members, try to backfill from remaining scored candidates
    if (cleanGroup.length < min_size - 1) {
      const remaining = scored.filter(
        (c) =>
          !cleanGroup.find((g) => g.user_id === c.user_id) &&
          c.trust_score >= trust_floor,
      );
      const backfilled = [
        ...cleanGroup,
        ...remaining.slice(0, max_size - 1 - cleanGroup.length),
      ];

      if (backfilled.length < min_size - 1) return null;
      group = backfilled;
    } else {
      group = cleanGroup;
    }
  }

  // Step 7 — Score the final group as a whole. No score-based rejection
  // here — a group that passed the hard filters (shared chapter, trust,
  // minimum size) above is always returned with its score; the caller
  // decides whether it clears min_group_score for autonomous placement or
  // needs Moderator review (see circleApproval.ts). Nothing gets silently
  // dropped for scoring low — only for not having enough qualifying
  // candidates at all (the min_size checks above).
  const finalGroup = [user, ...group];
  const finalScore = groupCompatibilityScore({
    life_chapters: finalGroup.map((m) => m.life_chapters),
    social_energy: finalGroup.map((m) => m.social_energy),
    activity_preferences: finalGroup.map((m) => m.activity_preferences),
    goal_embeddings: finalGroup.map((m) => parseEmbedding(m.goal_embeddings)),
    emotional_states: finalGroup.map((m) => m.emotional_state),
    distances_meters: finalGroup.map((m) => m.distance_meters ?? null),
  });

  // Step 8 — Enforce max size and return user IDs
  const finalUserIds = [userId, ...group.map((m) => m.user_id as string)];
  return { userIds: finalUserIds.slice(0, max_size), finalScore };
}

// Thin wrapper for callers that only need the group's user IDs (e.g. the
// declined-member replacement flow, which never creates a new
// pending_approval circle and so has no use for the confidence score).
async function findBestCircle(userId: string, excludeUserIds: string[] = []): Promise<string[] | null> {
  const result = await findBestCircleWithScore(userId, excludeUserIds);
  return result?.userIds ?? null;
}

export {
  activityOverlapScore,
  chapterDepthScore,
  emotionalStateScore,
  filterByStatedAsk,
  findBestCircle,
  findBestCircleWithScore,
  getActiveSeekingAsk,
  goalAlignmentScore,
  groupCompatibilityScore,
  hasSharedChapters,
  inSameCity,
  min_group_score,
  passesTrustCheck,
  socialEnergyScore,
};
