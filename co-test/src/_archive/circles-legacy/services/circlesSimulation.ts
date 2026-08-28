import crypto from "crypto";
import pool from "../../../api/src/db/db.js";
import { generateEmbedding, generateGoalEmbedding } from "../../../api/src/services/embeddings.js";
import { findBestCircleDiagnostic } from "./matching.js";
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
export const SIM_CITY = "San Francisco";
const SIM_NAME_PREFIX = "SimTest";
const SIM_VENUE_PREFIX = "SimVenue";

export type SeededProfile = {
  first_name: string;
  life_chapters: string[];
  social_energy: number;
  connection_style: string;
  activity_preferences: string[];
  emotional_state: string;
  goals: string[];
  availability_pattern: string;
  // Scenario-only: writes an active co_profiles.intent "seeking" entry with
  // a real embedding, exercising filterByStatedAsk (matching.ts Step 3.5).
  statedAsk?: string;
  // Scenario-only: writes a co_memories row (memory_type: 'text_exchange')
  // with a real content_embedding — exercises the memory-fallback branch of
  // filterByStatedAsk, where a match is only findable via something the
  // person said, not via any structured profile field.
  seedMemory?: string;
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

// --- Fixed, hand-designed scenarios -----------------------------------
// Unlike PROFILE_TEMPLATES above (randomized variation, good for general
// stress-testing over time), each scenario here has a deliberately-designed
// correct outcome to check the pipeline against — a ground truth, not just
// a score that moves around plausibly. Confirmed design, see conversation.
export type ScenarioId = "A" | "B" | "C";

export type ScenarioDefinition = {
  id: ScenarioId;
  label: string;
  description: string;
  requesterName: string;
  profiles: SeededProfile[];
  expected: {
    // true = must form exactly expectedMemberNames; false = must NOT form a
    // circle at all; null = exploratory (Scenario C) — no fixed answer,
    // just observing where the score actually lands.
    shouldForm: boolean | null;
    expectedMemberNames?: string[];
    note: string;
  };
};

const SCENARIO_A_PROFILES: SeededProfile[] = [
  {
    first_name: "SimA-1",
    life_chapters: ["new_to_city", "career_pivot"],
    social_energy: 55,
    connection_style: "small_group",
    activity_preferences: ["coffee", "networking events", "hiking"],
    emotional_state: "motivated",
    goals: ["find a job in tech after moving", "build a support network while job hunting"],
    availability_pattern: "weekday evenings",
    statedAsk: "people who are also job hunting or going through a career pivot right now",
  },
  {
    first_name: "SimA-2",
    life_chapters: ["new_to_city", "career_pivot"],
    social_energy: 60,
    connection_style: "small_group",
    activity_preferences: ["coffee", "networking events", "resume workshops"],
    emotional_state: "hopeful",
    goals: ["actively job hunting after a layoff", "meet people going through the same career transition"],
    availability_pattern: "weekday evenings",
  },
  {
    first_name: "SimA-3",
    life_chapters: ["new_to_city", "career_pivot"],
    social_energy: 50,
    connection_style: "small_group",
    activity_preferences: ["coffee", "hiking", "networking events"],
    emotional_state: "curious",
    goals: ["searching for a new job in a new city", "find community while between jobs"],
    availability_pattern: "weekday evenings",
  },
  {
    // Deliberately generic goals/activities — only matches via the seeded
    // memory below, exercising filterByStatedAsk's memory-fallback branch.
    first_name: "SimA-4",
    life_chapters: ["new_to_city"],
    social_energy: 45,
    connection_style: "small_group",
    activity_preferences: ["coffee", "board games"],
    emotional_state: "curious",
    goals: ["meet new people in the city", "build a small circle of real friends"],
    availability_pattern: "weekday evenings",
    seedMemory:
      "I've been grinding through job applications every day, hoping to land something before my savings run out.",
  },
  {
    first_name: "SimA-5",
    life_chapters: ["new_to_city"],
    social_energy: 70,
    connection_style: "small_group",
    activity_preferences: ["running", "hiking", "trail races"],
    emotional_state: "energized",
    goals: ["train for a half marathon", "find a running group"],
    availability_pattern: "weekend afternoons",
  },
  {
    first_name: "SimA-6",
    life_chapters: ["new_to_city", "starting_over"],
    social_energy: 40,
    connection_style: "small_group",
    activity_preferences: ["coffee", "playdates", "parenting meetups"],
    emotional_state: "overwhelmed",
    goals: ["meet other new parents nearby", "find a mom's group"],
    availability_pattern: "weekend afternoons",
  },
];

const SCENARIO_B_PROFILES: SeededProfile[] = [
  {
    first_name: "SimB-1",
    life_chapters: ["new_to_city"],
    social_energy: 20,
    connection_style: "small_group",
    activity_preferences: ["pottery", "art classes"],
    emotional_state: "anxious",
    goals: ["learn pottery and join a ceramics studio"],
    availability_pattern: "weekday evenings",
  },
  {
    first_name: "SimB-2",
    life_chapters: ["new_to_city", "building_solo"],
    social_energy: 90,
    connection_style: "small_group",
    activity_preferences: ["swimming", "cycling", "running"],
    emotional_state: "energized",
    goals: ["train for an Ironman triathlon"],
    availability_pattern: "weekend afternoons",
  },
  {
    first_name: "SimB-3",
    life_chapters: ["new_to_city"],
    social_energy: 35,
    connection_style: "small_group",
    activity_preferences: ["tabletop games", "video games"],
    emotional_state: "isolated",
    goals: ["find a D&D group to join"],
    availability_pattern: "weekday evenings",
  },
  {
    first_name: "SimB-4",
    life_chapters: ["new_to_city", "career_pivot"],
    social_energy: 75,
    connection_style: "small_group",
    activity_preferences: ["volunteering", "canvassing"],
    emotional_state: "motivated",
    goals: ["get more involved in local political organizing"],
    availability_pattern: "weekend afternoons",
  },
  {
    first_name: "SimB-5",
    life_chapters: ["new_to_city"],
    social_energy: 50,
    connection_style: "small_group",
    activity_preferences: ["wine tasting", "fine dining"],
    emotional_state: "curious",
    goals: ["find a wine tasting / sommelier study group"],
    availability_pattern: "weekend afternoons",
  },
  {
    first_name: "SimB-6",
    life_chapters: ["new_to_city", "starting_over"],
    social_energy: 15,
    connection_style: "small_group",
    activity_preferences: ["painting", "museums"],
    emotional_state: "burnout",
    goals: ["get back into painting and visual art"],
    availability_pattern: "weekday evenings",
  },
];

const SCENARIO_C_PROFILES: SeededProfile[] = [
  {
    first_name: "SimC-1",
    life_chapters: ["new_to_city"],
    social_energy: 60,
    connection_style: "small_group",
    activity_preferences: ["yoga", "running", "gym"],
    emotional_state: "motivated",
    goals: ["build a consistent workout habit"],
    availability_pattern: "weekday evenings",
  },
  {
    first_name: "SimC-2",
    life_chapters: ["new_to_city"],
    social_energy: 55,
    connection_style: "small_group",
    activity_preferences: ["running", "yoga", "coffee"],
    emotional_state: "curious",
    goals: ["find a running buddy"],
    availability_pattern: "weekday evenings",
  },
  {
    // Deliberate bridge between the two loose "camps" — blurs the line
    // rather than a clean split.
    first_name: "SimC-3",
    life_chapters: ["new_to_city"],
    social_energy: 45,
    connection_style: "small_group",
    activity_preferences: ["yoga", "painting", "coffee"],
    emotional_state: "curious",
    goals: ["get back into yoga"],
    availability_pattern: "weekend afternoons",
  },
  {
    first_name: "SimC-4",
    life_chapters: ["new_to_city"],
    social_energy: 40,
    connection_style: "small_group",
    activity_preferences: ["painting", "museums", "coffee"],
    emotional_state: "curious",
    goals: ["get more into painting"],
    availability_pattern: "weekend afternoons",
  },
  {
    first_name: "SimC-5",
    life_chapters: ["new_to_city"],
    social_energy: 35,
    connection_style: "small_group",
    activity_preferences: ["writing", "painting", "coffee"],
    emotional_state: "hopeful",
    goals: ["build a regular writing practice"],
    availability_pattern: "weekend afternoons",
  },
  {
    first_name: "SimC-6",
    life_chapters: ["new_to_city"],
    social_energy: 40,
    connection_style: "small_group",
    activity_preferences: ["pottery", "painting", "art classes"],
    emotional_state: "curious",
    goals: ["join a pottery class"],
    availability_pattern: "weekend afternoons",
  },
];

export const SCENARIOS: Record<ScenarioId, ScenarioDefinition> = {
  A: {
    id: "A",
    label: "Clear shared intent",
    description:
      "4 of 6 seeded users genuinely share a job-hunting/career-pivot ask (one of them only via a stored memory, not structured fields); 2 are unrelated.",
    requesterName: "SimA-1",
    profiles: SCENARIO_A_PROFILES,
    expected: {
      shouldForm: true,
      expectedMemberNames: ["SimA-1", "SimA-2", "SimA-3", "SimA-4"],
      note: "Should group exactly SimA-1..4 (the job-hunting ask); SimA-5 (running) and SimA-6 (new parent) should be excluded.",
    },
  },
  B: {
    id: "B",
    label: "Scattered, no overlap",
    description:
      "6 seeded users sharing only the bare-minimum city/chapter hard filter, otherwise deliberately divergent goals, activities, energy, and emotional state.",
    requesterName: "SimB-1",
    profiles: SCENARIO_B_PROFILES,
    expected: {
      shouldForm: false,
      note:
        "No circle should form (score should land below the 0.55 floor). Note: the pipeline currently has no separate 'low-confidence, route to Moderator' lane (that's a future confidence-gated escalation design) — 'correct' today means no circle at all, not a formed-but-flagged one.",
    },
  },
  C: {
    id: "C",
    label: "Borderline overlap",
    description:
      "Two loose 'camps' (fitness-leaning, creative-leaning) with one deliberate bridge profile — exploratory, to observe where the 0.55 floor actually lands.",
    requesterName: "SimC-1",
    profiles: SCENARIO_C_PROFILES,
    expected: {
      shouldForm: null,
      note: "No fixed right answer — records the actual score and members for observation, not a pass/fail check.",
    },
  },
};

// Shared insert used by the legacy randomized pool, fixed scenarios, and
// (city param) the dynamic real-user-vs-filler-pool feature — writes the
// profile row, then (when present) the stated-ask intent entry and/or seed
// memory. scenarioId is plain TEXT in the DB — any tag string is valid, not
// just "A"/"B"/"C" (dynamicPlacementTest.ts uses "DYNAMIC_A" etc).
export async function insertSimulatedProfile(
  profile: SeededProfile,
  scenarioId: string | null,
  city: string = SIM_CITY,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userResult = await pool.query(
    `INSERT INTO users (first_name, last_name, email, phone_number, username, test_channel, is_simulated, contact_verified, simulation_scenario)
     VALUES ($1, 'Simulated', $2, $3, $4, 'circles_sim', true, true, $5) RETURNING id`,
    [
      profile.first_name,
      `${profile.first_name.toLowerCase()}-${suffix}@copatible.test`,
      `+15550101${suffix}`,
      `co_test_sim_${suffix}`,
      scenarioId,
    ],
  );
  const userId = userResult.rows[0].id;

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
      city,
      `[${goalEmbedding.join(",")}]`,
    ],
  );

  if (profile.statedAsk) {
    const askEmbedding = await generateEmbedding(profile.statedAsk).catch(() => null);
    const intentEntry = {
      id: crypto.randomUUID(),
      text: profile.statedAsk,
      type: "seeking" as const,
      concrete_preferences: [] as string[],
      wants: [] as string[],
      availability: null,
      status: "active" as const,
      embedding: askEmbedding,
      created_at: new Date().toISOString(),
    };
    await pool.query(`UPDATE co_profiles SET intent = COALESCE(intent, '[]'::jsonb) || $1::jsonb WHERE user_id = $2`, [
      JSON.stringify([intentEntry]),
      userId,
    ]);
  }

  if (profile.seedMemory) {
    const memResult = await pool.query(
      `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2) RETURNING id`,
      [userId, profile.seedMemory],
    );
    const memEmbedding = await generateEmbedding(profile.seedMemory).catch(() => null);
    if (memEmbedding) {
      await pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
        `[${memEmbedding.join(",")}]`,
        memResult.rows[0].id,
      ]);
    }
  }

  return userId;
}

export async function seedSimulatedMembers(count = 6): Promise<{ userIds: string[] }> {
  const templates = PROFILE_TEMPLATES.slice(0, Math.min(count, PROFILE_TEMPLATES.length));
  const userIds: string[] = [];
  for (const profile of templates) {
    userIds.push(await insertSimulatedProfile(profile, null));
  }
  return { userIds };
}

export async function seedScenario(scenarioId: ScenarioId): Promise<{ userIds: string[]; requesterId: string }> {
  const scenario = SCENARIOS[scenarioId];
  const userIds: string[] = [];
  let requesterId = "";
  for (const profile of scenario.profiles) {
    const userId = await insertSimulatedProfile(profile, scenarioId);
    userIds.push(userId);
    if (profile.first_name === scenario.requesterName) requesterId = userId;
  }
  return { userIds, requesterId };
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
  await pool.query(`DELETE FROM co_test_scenario_runs`);
}

export type ScenarioRunResult = {
  scenarioId: ScenarioId;
  scenarioLabel: string;
  finalScore: number | null;
  consideredCandidates: number;
  memberNames: string[];
  excludedNames: string[];
  rejectionReason: string | null;
  passed: boolean | null;
  expectedNote: string;
  ranAt: string;
};

export async function getLastScenarioRun(): Promise<ScenarioRunResult | null> {
  const { rows } = await pool.query(
    `SELECT scenario_id, final_score, considered_candidates, member_names, excluded_names, rejection_reason, passed, expected_note, ran_at
     FROM co_test_scenario_runs ORDER BY ran_at DESC LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  const scenarioId = row.scenario_id as ScenarioId;
  return {
    scenarioId,
    scenarioLabel: SCENARIOS[scenarioId]?.label ?? scenarioId,
    finalScore: row.final_score,
    consideredCandidates: row.considered_candidates,
    memberNames: row.member_names ?? [],
    excludedNames: row.excluded_names ?? [],
    rejectionReason: row.rejection_reason,
    passed: row.passed,
    expectedNote: row.expected_note ?? "",
    ranAt: row.ran_at,
  };
}

// Runs findBestCircleDiagnostic on the seeded requester and, if a
// qualifying group comes back, creates the circle/circle_members rows the
// same shape api/src/routes/co.ts's POST /place does — is_simulated
// propagated onto the circle explicitly (nothing infers it). When the
// currently-seeded pool is a fixed scenario (all seeded users share one
// simulation_scenario tag), also evaluates the result against that
// scenario's designed answer and persists the run to
// co_test_scenario_runs for the dashboard to read back.
export async function runMatchingForSimulatedGroup(): Promise<
  | { success: true; circleId: string; memberIds: string[]; scenario: ScenarioRunResult | null }
  | { success: false; error: string; scenario?: ScenarioRunResult | null }
> {
  const seededUsers = await pool.query(
    `SELECT id, first_name, simulation_scenario FROM users WHERE is_simulated = true`,
  );
  if (!seededUsers.rows.length) return { success: false, error: "No simulated members seeded yet." };

  const scenarioTags = new Set(seededUsers.rows.map((r: any) => r.simulation_scenario).filter(Boolean));
  const scenarioId: ScenarioId | null = scenarioTags.size === 1 ? ([...scenarioTags][0] as ScenarioId) : null;
  const scenario = scenarioId ? SCENARIOS[scenarioId] : null;

  const requester = scenario
    ? seededUsers.rows.find((r: any) => r.first_name === scenario.requesterName)?.id
    : [...seededUsers.rows].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)))[0]?.id;
  if (!requester) return { success: false, error: "Could not determine a requester from seeded members." };

  const alreadyInCircle = await pool.query(`SELECT 1 FROM circle_members WHERE member_id = $1`, [requester]);
  if (alreadyInCircle.rows[0]) return { success: false, error: "Simulated requester is already in a circle — reset first." };

  // findBestCircle's candidate query (matching.ts Step 2) filters only by
  // city, with no is_simulated scoping — real profiles from earlier manual
  // phone/text testing that happen to share SIM_CITY would otherwise bleed
  // into the pool and break a scenario's known-answer check (confirmed:
  // leftover "Test"/"Tester" San Francisco profiles were doing exactly
  // this). Excluding every real (non-simulated) user keeps the scenario
  // evaluated against a clean, deterministic pool — reuses findBestCircle's
  // existing excludeUserIds param for exactly what it's for.
  const realUsers = await pool.query(`SELECT id FROM users WHERE is_simulated = false`);
  const excludeUserIds = realUsers.rows.map((r: any) => r.id as string);

  const diagnostics = await findBestCircleDiagnostic(requester, excludeUserIds);

  const nameById = new Map(seededUsers.rows.map((r: any) => [r.id as string, r.first_name as string]));
  const memberNames = (diagnostics.result ?? []).map((id) => nameById.get(id) ?? id);
  const excludedNames = scenario
    ? scenario.profiles.map((p) => p.first_name).filter((n) => !memberNames.includes(n))
    : [];

  let scenarioRunPayload: ScenarioRunResult | null = null;
  if (scenario) {
    let passed: boolean | null = null;
    if (scenario.expected.shouldForm === false) {
      passed = diagnostics.result === null;
    } else if (scenario.expected.shouldForm === true) {
      const expected = new Set(scenario.expected.expectedMemberNames ?? []);
      passed = expected.size === memberNames.length && memberNames.every((n) => expected.has(n));
    }
    // shouldForm === null (Scenario C) leaves passed as null — exploratory, no pass/fail.

    await pool.query(
      `INSERT INTO co_test_scenario_runs (scenario_id, final_score, considered_candidates, member_names, excluded_names, rejection_reason, passed, expected_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        scenario.id,
        diagnostics.finalScore,
        diagnostics.consideredCandidates,
        memberNames,
        excludedNames,
        diagnostics.rejectionReason,
        passed,
        scenario.expected.note,
      ],
    );

    scenarioRunPayload = {
      scenarioId: scenario.id,
      scenarioLabel: scenario.label,
      finalScore: diagnostics.finalScore,
      consideredCandidates: diagnostics.consideredCandidates,
      memberNames,
      excludedNames,
      rejectionReason: diagnostics.rejectionReason,
      passed,
      expectedNote: scenario.expected.note,
      ranAt: new Date().toISOString(),
    };
  }

  if (!diagnostics.result || diagnostics.result.length < 4) {
    return {
      success: false,
      error: `findBestCircle returned no qualifying group (${diagnostics.rejectionReason ?? "unknown reason"}).`,
      scenario: scenarioRunPayload,
    };
  }

  const groupUserIds = diagnostics.result;
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

  return { success: true, circleId, memberIds: groupUserIds, scenario: scenarioRunPayload };
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
