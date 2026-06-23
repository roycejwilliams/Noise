import pool from "../db/db.js";

//never fewer than 4 people
const min_size = 4;
///never more than 8 people
const max_size = 8;
//ideal target size
const target_size = 6;
//minimum score to qualify
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

// Overall compatibility score — weighted sum of all 5 dimensions
// Returns a score between 0 and 1
function groupCompatibilityScore(group: {
  life_chapters: string[][];
  social_energy: number[];
  activity_preferences: string[][];
  goal_embeddings: (string | number[] | null | undefined)[];
  emotional_states: string[];
}): number {
  const size = group.life_chapters.length;
  if (size < 2) return 0;

  let totalScore = 0;
  let pairCount = 0;

  // Compare every pair in the group
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      const pairScore =
        chapterDepthScore([group.life_chapters[i], group.life_chapters[j]]) *
          0.3 +
        socialEnergyScore([group.social_energy[i], group.social_energy[j]]) *
          0.25 +
        activityOverlapScore([
          group.activity_preferences[i],
          group.activity_preferences[j],
        ]) *
          0.2 +
        goalAlignmentScore([
          parseEmbedding(group.goal_embeddings[i]),
          parseEmbedding(group.goal_embeddings[j]),
        ]) *
          0.15 +
        emotionalStateScore([
          group.emotional_states[i],
          group.emotional_states[j],
        ]) *
          0.1;

      totalScore += pairScore;
      pairCount++;
    }
  }

  // Average pairwise score across all pairs in the group
  return totalScore / pairCount;
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
// Called by POST /co/place
// Returns an array of user IDs that form the best group, or null if no match found
async function findBestCircle(userId: string, excludeUserIds: string[] = []): Promise<string[] | null> {
  // Step 1 — Fetch the user being placed
  const userResult = await pool.query(
    `SELECT * FROM co_profiles WHERE user_id = $1`,
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return null;

  console.log("User goal_embeddings type:", typeof user.goal_embeddings);
  console.log("User goal_embeddings value:", user.goal_embeddings);

  // Step 2 — Fetch all other users in the same city with complete profiles
  // Exclude the user themselves, anyone already in an active circle,
  // and any explicitly excluded user IDs (e.g. members of a rejected circle)
  const candidatesResult = await pool.query(
    `SELECT cp.*, u.id as user_id
     FROM co_profiles cp
     JOIN users u ON cp.user_id = u.id
     WHERE cp.city = $1
     AND cp.user_id != $2
     AND cp.user_id != ALL($3::uuid[])
     AND cp.life_chapters != '{}'
     AND cp.goal_embeddings IS NOT NULL`,
    [user.city, userId, excludeUserIds],
  );

  const candidates = candidatesResult.rows;

  // Need at least MIN_CIRCLE_SIZE - 1 candidates to even attempt a group
  if (candidates.length < min_size - 1) return null;

  // Step 3 — Apply hard filters
  // Remove candidates who don't share at least 1 life chapter with the user
  // and aren't in the same city
  const filtered = candidates.filter((candidate) => {
    return (
      hasSharedChapters([user.life_chapters, candidate.life_chapters]) &&
      inSameCity(user.city, candidate.city)
    );
  });

  // Not enough candidates after filtering
  if (filtered.length < min_size - 1) return null;

  console.log("Filtered candidates count:", filtered.length);

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
    });
    return { ...candidate, score };
  });

  console.log("Scored candidates count:", scored.length);

  // Sort by score descending — best matches first
  scored.sort((a, b) => b.score - a.score);

  console.log(
    "Top 3 scores:",
    scored.slice(0, 3).map((s) => ({ user_id: s.user_id, score: s.score })),
  );

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

  // Step 7 — Validate final group score as a whole
  const finalGroup = [user, ...group];
  const finalScore = groupCompatibilityScore({
    life_chapters: finalGroup.map((m) => m.life_chapters),
    social_energy: finalGroup.map((m) => m.social_energy),
    activity_preferences: finalGroup.map((m) => m.activity_preferences),
    goal_embeddings: finalGroup.map((m) => parseEmbedding(m.goal_embeddings)),
    emotional_states: finalGroup.map((m) => m.emotional_state),
  });

  console.log("Final group score:", finalScore);
  console.log("Min required:", min_group_score);

  // If group doesn't meet minimum score — flag for manual placement
  if (finalScore < min_group_score) return null;

  // Step 8 — Enforce max size and return user IDs
  const finalUserIds = [userId, ...group.map((m) => m.user_id as string)];
  return finalUserIds.slice(0, max_size);
}

export {
  activityOverlapScore,
  chapterDepthScore,
  emotionalStateScore,
  findBestCircle,
  goalAlignmentScore,
  groupCompatibilityScore,
  hasSharedChapters,
  inSameCity,
  passesTrustCheck,
  socialEnergyScore,
};
