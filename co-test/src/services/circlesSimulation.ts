import pool from "../../../api/src/db/db.js";
import { generateGoalEmbedding } from "../../../api/src/services/embeddings.js";
import { findBestCircle } from "./matching.js";
import { createMomentForCircle } from "./venues.js";
import { acceptCircleMembership, declineCircleMembership, approveVenue, rejectVenue } from "./moderatorActions.js";
import type { CandidateWindow } from "../../../api/src/services/scheduling.js";

// Circles pipeline test — proves matching/Moderator-approval/venue-
// selection/availability-poll logic runs correctly end to end, without
// tying up the shared production Sendblue webhook for the multi-day real
// window CIRCLES_SCOPING.md flags. Every function here calls into the same
// logic (matching.ts, moderatorActions.ts, venues.ts) a real reply-driven
// run would use — only the trigger is internal instead of a parsed inbound
// text. This validates PIPELINE LOGIC, not the real texting experience —
// keep that distinction visible everywhere this data surfaces (see
// circlesTest.ts's API responses and the checklist page panel).
//
// SIM_CITY is fixed rather than configurable — matching.ts's Step 2 filters
// candidates by exact city string equality, so every seeded profile must
// share one literal value for findBestCircle to ever group them.
const SIM_CITY = "San Francisco";
const SIM_NAME_PREFIX = "SimTest";
const SIM_VENUE_PREFIX = "SimVenue";

type SeededProfile = {
  first_name: string;
  life_chapters: string[];
  social_energy: number;
  connection_style: string;
  activity_preferences: string[];
  emotional_state: string;
  goals: string[];
  availability_pattern: string;
};

// Deliberately varied-but-compatible, not identical — all share the
// new_to_city chapter (matching.ts's hard filter requires >=1 shared
// chapter) and overlapping goal language (so real embeddings actually
// cluster), but differ enough in energy/activities/secondary chapters that
// clearing the 0.55 group-score floor means something, not a trivial
// coin-flip against near-duplicate rows.
const PROFILE_TEMPLATES: SeededProfile[] = [
  {
    first_name: `${SIM_NAME_PREFIX}-1`,
    life_chapters: ["new_to_city"],
    social_energy: 55,
    connection_style: "small_group",
    activity_preferences: ["hiking", "coffee", "board games"],
    emotional_state: "hopeful",
    goals: ["meet new people in the city", "build a small circle of real friends"],
    availability_pattern: "weekday evenings",
  },
  {
    first_name: `${SIM_NAME_PREFIX}-2`,
    life_chapters: ["new_to_city", "career_pivot"],
    social_energy: 60,
    connection_style: "small_group",
    activity_preferences: ["hiking", "dinner", "live music"],
    emotional_state: "motivated",
    goals: ["find a real community after moving", "make friends who feel like home"],
    availability_pattern: "weekend afternoons",
  },
  {
    first_name: `${SIM_NAME_PREFIX}-3`,
    life_chapters: ["new_to_city"],
    social_energy: 45,
    connection_style: "small_group",
    activity_preferences: ["coffee", "board games", "bookstores"],
    emotional_state: "curious",
    goals: ["build a small circle of real friends", "find people to grab coffee with regularly"],
    availability_pattern: "weekday evenings",
  },
  {
    first_name: `${SIM_NAME_PREFIX}-4`,
    life_chapters: ["new_to_city", "starting_over"],
    social_energy: 50,
    connection_style: "small_group",
    activity_preferences: ["dinner", "hiking", "coffee"],
    emotional_state: "hopeful",
    goals: ["meet new people in the city", "find people to grab coffee with regularly"],
    availability_pattern: "weekend afternoons",
  },
  {
    first_name: `${SIM_NAME_PREFIX}-5`,
    life_chapters: ["new_to_city"],
    social_energy: 65,
    connection_style: "small_group",
    activity_preferences: ["live music", "dinner", "board games"],
    emotional_state: "motivated",
    goals: ["find a real community after moving", "build a small circle of real friends"],
    availability_pattern: "weekday evenings",
  },
  {
    first_name: `${SIM_NAME_PREFIX}-6`,
    life_chapters: ["new_to_city", "career_pivot"],
    social_energy: 50,
    connection_style: "small_group",
    activity_preferences: ["hiking", "bookstores", "coffee"],
    emotional_state: "curious",
    goals: ["make friends who feel like home", "meet new people in the city"],
    availability_pattern: "weekend afternoons",
  },
];

export async function seedSimulatedMembers(count = 6): Promise<{ userIds: string[] }> {
  const templates = PROFILE_TEMPLATES.slice(0, Math.min(count, PROFILE_TEMPLATES.length));
  const userIds: string[] = [];

  for (const profile of templates) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const userResult = await pool.query(
      `INSERT INTO users (first_name, last_name, email, phone_number, username, test_channel, is_simulated, contact_verified)
       VALUES ($1, 'Simulated', $2, $3, $4, 'circles_sim', true, true) RETURNING id`,
      [
        profile.first_name,
        `${profile.first_name.toLowerCase()}-${suffix}@copatible.test`,
        `+15550101${String(userIds.length).padStart(2, "0")}${suffix.slice(0, 2)}`,
        `co_test_sim_${suffix}`,
      ],
    );
    const userId = userResult.rows[0].id;
    userIds.push(userId);

    const goalEmbedding = await generateGoalEmbedding(profile.goals);

    await pool.query(
      `INSERT INTO co_profiles (user_id, life_chapters, social_energy, connection_style, activity_preferences, emotional_state, goals, availability_pattern, city, goal_embeddings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        profile.life_chapters,
        profile.social_energy,
        profile.connection_style,
        profile.activity_preferences,
        profile.emotional_state,
        profile.goals,
        profile.availability_pattern,
        SIM_CITY,
        `[${goalEmbedding.join(",")}]`,
      ],
    );
  }

  return { userIds };
}

export async function seedFakeVenues(): Promise<void> {
  const venues: { name: string; type: string; neighborhood: string }[] = [
    { name: `${SIM_VENUE_PREFIX} Dinner House`, type: "dinner", neighborhood: "Mission" },
    { name: `${SIM_VENUE_PREFIX} Trailhead Cafe`, type: "outdoor", neighborhood: "Presidio" },
    { name: `${SIM_VENUE_PREFIX} Game Night Bar`, type: "social", neighborhood: "Hayes Valley" },
    { name: `${SIM_VENUE_PREFIX} Coworking Loft`, type: "coworking", neighborhood: "SOMA" },
  ];
  for (const v of venues) {
    await pool.query(
      `INSERT INTO co_venues (name, type, neighborhood, city, capacity_min, capacity_max, payment_tier, booking_method, active)
       VALUES ($1, $2, $3, $4, 2, 10, 'free', 'none', true)
       ON CONFLICT DO NOTHING`,
      [v.name, v.type, v.neighborhood, SIM_CITY],
    );
  }
}

export async function resetSimulatedData(): Promise<void> {
  // Order matters: moments.creator_id and circles.owner_id both reference
  // users with no ON DELETE rule (confirmed against co-test's schema) —
  // deleting users first would fail with a FK violation. Moments before
  // circles for the same reason (moments.circle_id is ON DELETE SET NULL,
  // circles has no cascade from moments, so order between those two doesn't
  // itself matter, but doing moments first keeps moment_attendees/
  // moment_responses cleanup — both CASCADE from moments — tidy in one step).
  await pool.query(`DELETE FROM moments WHERE is_simulated = true`);
  await pool.query(`DELETE FROM circles WHERE is_simulated = true`);
  await pool.query(`DELETE FROM users WHERE is_simulated = true`); // cascades co_profiles/co_memories/circle_members/moment_responses
  await pool.query(`DELETE FROM co_venues WHERE name LIKE $1`, [`${SIM_VENUE_PREFIX}%`]);
}

// Runs findBestCircle on the first seeded member and, if a qualifying group
// comes back, creates the circle/circle_members rows the same shape
// api/src/routes/co.ts's POST /place does — is_simulated propagated onto
// the circle explicitly (nothing infers it).
export async function runMatchingForSimulatedGroup(): Promise<
  { success: true; circleId: string; memberIds: string[] } | { success: false; error: string }
> {
  const seeded = await pool.query(
    `SELECT user_id FROM co_profiles WHERE user_id IN (SELECT id FROM users WHERE is_simulated = true) ORDER BY user_id LIMIT 1`,
  );
  const requester = seeded.rows[0]?.user_id;
  if (!requester) return { success: false, error: "No simulated members seeded yet." };

  const alreadyInCircle = await pool.query(`SELECT 1 FROM circle_members WHERE member_id = $1`, [requester]);
  if (alreadyInCircle.rows[0]) return { success: false, error: "Simulated requester is already in a circle — reset first." };

  const groupUserIds = await findBestCircle(requester);
  if (!groupUserIds || groupUserIds.length < 4) {
    return { success: false, error: "findBestCircle returned no qualifying group (below 0.55 floor or too few candidates)." };
  }

  const profileResult = await pool.query(`SELECT life_chapters FROM co_profiles WHERE user_id = $1`, [requester]);
  const primaryChapter = profileResult.rows[0]?.life_chapters?.[0] ?? "new_to_city";
  const circleName = `Sim Circle — ${primaryChapter.replace(/_/g, " ")}`;

  const circleResult = await pool.query(
    `INSERT INTO circles (owner_id, circle_name, status, is_simulated) VALUES ($1, $2, 'pending_approval', true) RETURNING id`,
    [requester, circleName],
  );
  const circleId = circleResult.rows[0].id;

  for (const memberId of groupUserIds) {
    await pool.query(`INSERT INTO circle_members (circle_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      circleId,
      memberId,
    ]);
  }

  return { success: true, circleId, memberIds: groupUserIds };
}

export async function simulateCircleResponse(
  circleId: string,
  memberId: string,
  action: "accept" | "decline",
): Promise<{ success: boolean; momentId?: string; error?: string }> {
  if (action === "accept") return acceptCircleMembership(circleId, memberId);
  const result = await declineCircleMembership(circleId, memberId);
  return { success: result.success };
}

export async function simulateAvailabilityResponse(
  momentId: string,
  memberId: string,
  selectedWindowIndices: number[],
): Promise<{ success: boolean }> {
  await pool.query(
    `UPDATE moment_responses SET response = 'windows', selected_windows = $1, responded_at = NOW()
     WHERE moment_id = $2 AND user_id = $3`,
    [selectedWindowIndices, momentId, memberId],
  );
  return { success: true };
}

export async function simulateModeratorApproval(
  target: { type: "circle"; circleId: string } | { type: "venue"; momentId: string },
  action: "approve" | "reject",
): Promise<{ success: boolean; error?: string }> {
  if (target.type === "circle") {
    if (action === "approve") {
      const r = await pool.query(`UPDATE circles SET status = 'active' WHERE id = $1 RETURNING id`, [target.circleId]);
      return { success: !!r.rows[0], error: r.rows[0] ? undefined : "Circle not found." };
    }
    await pool.query(`UPDATE circles SET status = 'rejected' WHERE id = $1`, [target.circleId]);
    return { success: true };
  }
  return action === "approve" ? approveVenue(target.momentId) : rejectVenue(target.momentId);
}

// Manual stand-in for the */15 * * * * consensus-cutoff cron (not deployed
// in co-test — that's separate scope) — same tally logic, run on demand so
// this pipeline test doesn't have to wait on a real cron tick. Locks in the
// plurality window regardless of whether the 2x-majority threshold or the
// 48hr cutoff would normally gate it — this is a testing shortcut, not a
// faithful re-implementation of the cutoff timing itself.
export async function resolveConsensusNow(momentId: string): Promise<{ success: boolean; error?: string }> {
  const momentResult = await pool.query(`SELECT id, candidate_windows FROM moments WHERE id = $1`, [momentId]);
  const moment = momentResult.rows[0];
  if (!moment) return { success: false, error: "Moment not found." };

  const responsesResult = await pool.query(
    `SELECT selected_windows FROM moment_responses WHERE moment_id = $1`,
    [momentId],
  );
  const candidateWindows: CandidateWindow[] = moment.candidate_windows ?? [];
  if (!candidateWindows.length) {
    await pool.query(`UPDATE moments SET status = 'pending_venue_approval', keana_venue_notified_at = NOW() WHERE id = $1`, [momentId]);
    return { success: true };
  }

  const counts = new Array(candidateWindows.length).fill(0);
  for (const row of responsesResult.rows) {
    for (const idx of row.selected_windows ?? []) {
      if (idx >= 1 && idx <= counts.length) counts[idx - 1]++;
    }
  }
  let winningIndex = 0;
  counts.forEach((c, i) => {
    if (c > counts[winningIndex]) winningIndex = i;
  });
  const winner = candidateWindows[winningIndex];

  await pool.query(
    `UPDATE moments SET moment_start = $1, suggested_time = $2, status = 'pending_venue_approval', keana_venue_notified_at = NOW() WHERE id = $3`,
    [winner.start, winner.label, momentId],
  );
  return { success: true };
}
