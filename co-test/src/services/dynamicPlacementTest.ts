import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../../../api/src/db/db.js";
import { generateEmbedding } from "../../../api/src/services/embeddings.js";
import { ALLOWED_CONNECTION_STYLES, ALLOWED_LIFE_CHAPTERS } from "../../../api/src/services/profileExtraction.js";
import sendblue from "../../../api/src/services/sendblue.js";
import { findBestCircleDiagnostic } from "./matching.js";
import { insertSimulatedProfile, SIM_CITY, type SeededProfile } from "./circlesSimulation.js";
import { generateCircleTitle, generateWarmCircleInviteMessage } from "../../../api/src/services/circleInvite.js";

// Real-test-user-vs-filler-pool feature — a real test user goes through
// actual onboarding (real call/text, real captureIntent), and gets matched
// with the REAL findBestCircle/filterByStatedAsk/scoring against a filler
// pool generated FROM their own real captured context, not a scripted
// scenario. Three variants (A/B/C) mirror Scenario A/B/C's shape (clear
// match / clear non-match / borderline) but the filler content is generated
// fresh each run by an LLM reading the real profile, so this validates the
// real algorithm against real, unscripted input — confirmed design.
export type DynamicVariant = "A" | "B" | "C";

const VARIANT_LABEL: Record<DynamicVariant, string> = {
  A: "Clear match (generated to overlap)",
  B: "Clear non-match (generated with no overlap)",
  C: "Borderline (generated ~half overlap)",
};

const VARIANT_INSTRUCTIONS: Record<DynamicVariant, string> = {
  A: `Each profile should genuinely, substantively overlap with this real person's stated ask (if given) and/or their goals, activities, or life chapter — a person reading both side by side would agree they belong in the same circle. Vary secondary details (energy, specific wording) so profiles aren't identical, but the core thematic overlap must be real and clear.`,
  B: `Each profile should have NO real thematic overlap with this person's ask, goals, or activities — different pursuits, different life focus entirely. Deliberately spread/mismatch social_energy and emotional_state from theirs too, so it doesn't accidentally score high on those dimensions either.`,
  C: `Roughly half the profiles should genuinely overlap with this person's context, half should not — deliberately ambiguous, not a clean match or a clean miss.`,
};

type RealContext = {
  userId: string;
  first_name: string;
  city: string | null;
  life_chapters: string[];
  social_energy: number | null;
  connection_style: string | null;
  activity_preferences: string[];
  emotional_state: string | null;
  goals: string[];
  availability_pattern: string | null;
  activeAskText: string | null;
};

async function loadRealContext(realUserId: string): Promise<RealContext> {
  const { rows } = await pool.query(
    `SELECT u.id, u.first_name, cp.city, cp.life_chapters, cp.social_energy, cp.connection_style,
            cp.activity_preferences, cp.emotional_state, cp.goals, cp.availability_pattern, cp.intent
     FROM users u JOIN co_profiles cp ON cp.user_id = u.id
     WHERE u.id = $1`,
    [realUserId],
  );
  const row = rows[0];
  if (!row) throw new Error("Real test user has no profile yet — they need to complete onboarding first.");
  const intent = Array.isArray(row.intent) ? row.intent : [];
  const activeAsk = intent
    .filter((i: any) => i?.status === "active" && i?.type === "seeking" && i?.text)
    .slice(-1)[0];
  return {
    userId: row.id,
    first_name: row.first_name,
    city: row.city,
    life_chapters: row.life_chapters ?? [],
    social_energy: row.social_energy,
    connection_style: row.connection_style,
    activity_preferences: row.activity_preferences ?? [],
    emotional_state: row.emotional_state,
    goals: row.goals ?? [],
    availability_pattern: row.availability_pattern,
    activeAskText: activeAsk?.text ?? null,
  };
}

// The one active real test session — same "one tester at a time" convention
// already used throughout co-test (phone_pending, checklist sample-size
// parity, etc).
export async function getActiveRealTestUser(): Promise<(RealContext & { hasSignal: boolean }) | null> {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE test_channel = 'phone' AND otp_verified = true AND is_simulated = false
     ORDER BY created_at DESC LIMIT 1`,
  );
  const userId = rows[0]?.id;
  if (!userId) return null;
  const ctx = await loadRealContext(userId).catch(() => null);
  if (!ctx) return null;
  const hasSignal = ctx.life_chapters.length > 0 || ctx.goals.length > 0 || ctx.activity_preferences.length > 0;
  return { ...ctx, hasSignal };
}

type RawGeneratedProfile = {
  first_name?: string;
  life_chapters?: string[];
  social_energy?: number;
  connection_style?: string;
  activity_preferences?: string[];
  emotional_state?: string;
  goals?: string[];
  availability_pattern?: string;
  seedMemory?: string;
};

// Validates/clamps LLM output against the exact same DB constraints
// insertSimulatedProfile's INSERTs are subject to (life_chapters CHECK,
// connection_style CHECK) — confirmed the hard way building Scenarios A/B/C,
// where an unvalidated hand-picked value violated co_profiles_life_chapters_check.
// Returns null (skip, don't seed) rather than guessing when a profile is too
// thin to be meaningful (no goals/activities/chapters at all).
// Coerces a field that should be a string[] but may come back as a single
// string (confirmed: Haiku sometimes collapses "1-2 sentences" into one
// string instead of an array despite the prompt asking for an array) —
// forgiving of the shape slip since it doesn't indicate low-quality
// content, just wrong JSON structure.
function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.trim());
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function validateGeneratedProfile(raw: RawGeneratedProfile, variant: DynamicVariant, index: number): SeededProfile | null {
  const life_chapters = coerceStringArray(raw.life_chapters).filter((c) => ALLOWED_LIFE_CHAPTERS.includes(c));
  const activity_preferences = coerceStringArray(raw.activity_preferences);
  const goals = coerceStringArray(raw.goals);
  if (!life_chapters.length || !activity_preferences.length || !goals.length) return null;

  const connection_style = ALLOWED_CONNECTION_STYLES.includes(raw.connection_style as string)
    ? (raw.connection_style as string)
    : "small_group";
  const social_energy = Number.isFinite(raw.social_energy)
    ? Math.max(0, Math.min(100, Math.round(raw.social_energy as number)))
    : 50;
  const emotional_state =
    typeof raw.emotional_state === "string" && raw.emotional_state.trim() ? raw.emotional_state.trim() : "curious";
  const availability_pattern =
    typeof raw.availability_pattern === "string" && raw.availability_pattern.trim()
      ? raw.availability_pattern.trim()
      : "flexible";
  const seedMemory = typeof raw.seedMemory === "string" && raw.seedMemory.trim() ? raw.seedMemory.trim() : undefined;

  return {
    first_name: `Dyn${variant}-${index + 1}`,
    life_chapters,
    social_energy,
    connection_style,
    activity_preferences,
    emotional_state,
    goals,
    availability_pattern,
    seedMemory,
  };
}

async function generateFillerProfiles(ctx: RealContext, variant: DynamicVariant, count = 6): Promise<SeededProfile[]> {
  const contextBlock = [
    `Life chapters: ${ctx.life_chapters.join(", ") || "none stated"}`,
    `Social energy (0-100): ${ctx.social_energy ?? "unknown"}`,
    `Connection style: ${ctx.connection_style ?? "unknown"}`,
    `Activity preferences: ${ctx.activity_preferences.join(", ") || "none stated"}`,
    `Emotional state: ${ctx.emotional_state ?? "unknown"}`,
    `Goals: ${ctx.goals.join("; ") || "none stated"}`,
    `Active stated ask: ${ctx.activeAskText ?? "none"}`,
  ].join("\n");

  const memoryInstruction =
    variant === "A" && (ctx.activeAskText || ctx.goals.length)
      ? `\nExactly ONE profile should include a "seedMemory" field — a specific first-person sentence they might have said in conversation that reveals the same interest as this real person's ask/goals only indirectly, NOT restated in that profile's own structured goals/activity_preferences. This tests whether matching can find the overlap from conversation content alone, not just structured fields.`
      : "";

  const prompt = `You are generating fake filler test profiles for CoPatible's internal Circles-matching test harness. A real test user has this actual, unscripted captured profile:

${contextBlock}

Generate exactly ${count} realistic filler profiles for test variant "${variant}" (${VARIANT_LABEL[variant]}):
${VARIANT_INSTRUCTIONS[variant]}${memoryInstruction}

Each profile must have (life_chapters, activity_preferences, and goals are ALL JSON arrays of strings — never a single string):
- life_chapters: JSON array using ONLY these exact values: ${ALLOWED_LIFE_CHAPTERS.join(", ")} (1-2 per profile)
- connection_style: one of ${ALLOWED_CONNECTION_STYLES.join(", ")}
- social_energy: integer 0-100
- emotional_state: one word (e.g. anxious, isolated, overwhelmed, motivated, energized, curious, hopeful, burnout)
- activity_preferences: JSON array of 2-4 short specific activities, each its own array element, e.g. ["coffee", "hiking"]
- goals: JSON array of 1-2 short, separate, concrete sentences, each its own array element, e.g. ["Find a job in tech.", "Build a support network."] — NOT one combined string
- availability_pattern: short phrase

Return ONLY valid JSON, no preamble: {"profiles": [{"life_chapters": ["new_to_city"], "social_energy": 55, "connection_style": "small_group", "activity_preferences": ["coffee", "hiking"], "emotional_state": "curious", "goals": ["Find a job in tech.", "Build a support network."], "availability_pattern": "weekday evenings"}]}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text: raw } = await generateText({ model: anthropic("claude-haiku-4-5-20251001"), prompt });
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      const rawProfiles: RawGeneratedProfile[] = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
      const validated = rawProfiles
        .map((p, i) => validateGeneratedProfile(p, variant, i))
        .filter((p): p is SeededProfile => p !== null);
      if (validated.length >= 3) return validated.slice(0, count);
      console.error(`Dynamic filler generation attempt ${attempt + 1} for variant ${variant} produced only ${validated.length} usable profiles.`);
    } catch (err) {
      console.error(`Dynamic filler generation attempt ${attempt + 1} for variant ${variant} failed:`, err);
    }
  }
  throw new Error(`Failed to generate a usable filler pool for variant ${variant} after 2 attempts.`);
}

export type DynamicSeedResult = { variant: DynamicVariant; userIds: string[] };

export async function seedDynamicPools(realUserId: string): Promise<Record<DynamicVariant, DynamicSeedResult>> {
  const ctx = await loadRealContext(realUserId);
  const city = ctx.city?.trim() || SIM_CITY;

  const results = {} as Record<DynamicVariant, DynamicSeedResult>;
  for (const variant of ["A", "B", "C"] as DynamicVariant[]) {
    const profiles = await generateFillerProfiles(ctx, variant);
    const userIds: string[] = [];
    for (const profile of profiles) {
      userIds.push(await insertSimulatedProfile(profile, `DYNAMIC_${variant}`, city));
    }
    results[variant] = { variant, userIds };
  }
  return results;
}

export type DynamicRunResult = {
  variant: DynamicVariant;
  variantLabel: string;
  finalScore: number | null;
  consideredCandidates: number;
  memberNames: string[];
  excludedNames: string[];
  rejectionReason: string | null;
  passed: boolean | null;
  generatedProfiles: { first_name: string; goals: string[]; activity_preferences: string[]; life_chapters: string[] }[];
  ranAt: string;
};

// Every real-vs-dynamic-pool call must exclude every OTHER simulated pool
// (other variants, stray Scenario A/B/C/random data) and every other real
// user — same contamination fix built for Scenario A/B/C, applied per
// variant tag here instead of a single fixed tag.
async function excludeIdsForVariant(realUserId: string, variant: DynamicVariant): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE id != $1 AND (is_simulated = false OR simulation_scenario IS DISTINCT FROM $2)`,
    [realUserId, `DYNAMIC_${variant}`],
  );
  return rows.map((r: any) => r.id as string);
}

// Read-only — computes score/members/excluded for one variant and persists
// it for dashboard readback. Never creates a circle or sends anything; see
// attemptRealPlacement for the one action that can.
export async function runDynamicDiagnostic(realUserId: string, variant: DynamicVariant): Promise<DynamicRunResult> {
  const tag = `DYNAMIC_${variant}`;
  const poolUsers = await pool.query(
    `SELECT u.id, u.first_name, cp.goals, cp.activity_preferences, cp.life_chapters
     FROM users u JOIN co_profiles cp ON cp.user_id = u.id
     WHERE u.simulation_scenario = $1`,
    [tag],
  );
  if (!poolUsers.rows.length) throw new Error(`No seeded filler pool found for variant ${variant} — seed first.`);

  const excludeUserIds = await excludeIdsForVariant(realUserId, variant);
  const diagnostics = await findBestCircleDiagnostic(realUserId, excludeUserIds);

  const nameById = new Map(poolUsers.rows.map((r: any) => [r.id as string, r.first_name as string]));
  const memberNames = (diagnostics.result ?? []).filter((id) => nameById.has(id)).map((id) => nameById.get(id)!);
  const excludedNames = poolUsers.rows.map((r: any) => r.first_name as string).filter((n) => !memberNames.includes(n));

  // A/B have a designed answer (mirrors Scenario A/B's rule exactly); C is
  // exploratory, same as Scenario C.
  let passed: boolean | null = null;
  if (variant === "A") passed = diagnostics.result !== null;
  else if (variant === "B") passed = diagnostics.result === null;

  const generatedProfiles = poolUsers.rows.map((r: any) => ({
    first_name: r.first_name as string,
    goals: (r.goals ?? []) as string[],
    activity_preferences: (r.activity_preferences ?? []) as string[],
    life_chapters: (r.life_chapters ?? []) as string[],
  }));

  await pool.query(
    `INSERT INTO co_test_dynamic_runs (real_user_id, variant, final_score, considered_candidates, member_names, excluded_names, rejection_reason, passed, generated_profiles)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      realUserId,
      variant,
      diagnostics.finalScore,
      diagnostics.consideredCandidates,
      memberNames,
      excludedNames,
      diagnostics.rejectionReason,
      passed,
      JSON.stringify(generatedProfiles),
    ],
  );

  return {
    variant,
    variantLabel: VARIANT_LABEL[variant],
    finalScore: diagnostics.finalScore,
    consideredCandidates: diagnostics.consideredCandidates,
    memberNames,
    excludedNames,
    rejectionReason: diagnostics.rejectionReason,
    passed,
    generatedProfiles,
    ranAt: new Date().toISOString(),
  };
}

export async function runAllDynamicVariants(realUserId: string): Promise<DynamicRunResult[]> {
  const results: DynamicRunResult[] = [];
  for (const variant of ["A", "B", "C"] as DynamicVariant[]) {
    results.push(await runDynamicDiagnostic(realUserId, variant));
  }
  return results;
}

export async function getLatestDynamicRuns(realUserId: string): Promise<DynamicRunResult[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (variant) variant, final_score, considered_candidates, member_names, excluded_names, rejection_reason, passed, generated_profiles, ran_at
     FROM co_test_dynamic_runs WHERE real_user_id = $1 ORDER BY variant, ran_at DESC`,
    [realUserId],
  );
  return rows.map((r: any) => ({
    variant: r.variant,
    variantLabel: VARIANT_LABEL[r.variant as DynamicVariant],
    finalScore: r.final_score,
    consideredCandidates: r.considered_candidates,
    memberNames: r.member_names ?? [],
    excludedNames: r.excluded_names ?? [],
    rejectionReason: r.rejection_reason,
    passed: r.passed,
    generatedProfiles: r.generated_profiles ?? [],
    ranAt: r.ran_at,
  }));
}

export type RealPlacementResult =
  | { success: true; circleId: string; memberNames: string[]; finalScore: number }
  | { success: false; error: string; finalScore: number | null; rejectionReason: string | null };

// Re-runs the diagnostic fresh (not the cached run — profile data may have
// changed) and, if a group forms, creates the real circle/circle_members
// rows the same shape production's POST /place does — is_simulated FALSE
// (this is a real circle, it can trigger a real send) and
// real_test_placement TRUE (so it's findable/cleanable as this feature's
// own data). Does not notify anyone yet — see approveRealPlacementAndNotify.
export async function attemptRealPlacement(realUserId: string, variant: DynamicVariant): Promise<RealPlacementResult> {
  const alreadyInCircle = await pool.query(`SELECT 1 FROM circle_members WHERE member_id = $1`, [realUserId]);
  if (alreadyInCircle.rows[0]) {
    return {
      success: false,
      error: "This real test user is already in a circle — reset or resolve it first.",
      finalScore: null,
      rejectionReason: null,
    };
  }

  const tag = `DYNAMIC_${variant}`;
  const poolUsers = await pool.query(`SELECT id, first_name FROM users WHERE simulation_scenario = $1`, [tag]);
  if (!poolUsers.rows.length) {
    return {
      success: false,
      error: `No seeded filler pool for variant ${variant} — seed first.`,
      finalScore: null,
      rejectionReason: null,
    };
  }

  const excludeUserIds = await excludeIdsForVariant(realUserId, variant);
  const diagnostics = await findBestCircleDiagnostic(realUserId, excludeUserIds);

  if (!diagnostics.result || diagnostics.result.length < 4) {
    return {
      success: false,
      error: `No qualifying circle formed (${diagnostics.rejectionReason ?? "unknown reason"}).`,
      finalScore: diagnostics.finalScore,
      rejectionReason: diagnostics.rejectionReason,
    };
  }

  const profileResult = await pool.query(`SELECT life_chapters FROM co_profiles WHERE user_id = $1`, [realUserId]);
  const primaryChapter = profileResult.rows[0]?.life_chapters?.[0] ?? "new_to_city";
  const circleName = `Co Circle — ${primaryChapter.replace(/_/g, " ")}`;

  const circleResult = await pool.query(
    `INSERT INTO circles (owner_id, circle_name, status, is_simulated, real_test_placement) VALUES ($1, $2, 'pending_approval', false, true) RETURNING id`,
    [realUserId, circleName],
  );
  const circleId = circleResult.rows[0].id;

  for (const memberId of diagnostics.result) {
    await pool.query(`INSERT INTO circle_members (circle_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      circleId,
      memberId,
    ]);
  }

  const nameById = new Map(poolUsers.rows.map((r: any) => [r.id as string, r.first_name as string]));
  const memberNames = diagnostics.result.map((id) => (id === realUserId ? "(you)" : nameById.get(id) ?? id));

  return { success: true, circleId, memberNames, finalScore: diagnostics.finalScore! };
}

export async function getRealPlacementCircleState(realUserId: string) {
  const circle = await pool.query(
    `SELECT id, circle_name, status FROM circles WHERE owner_id = $1 AND real_test_placement = true ORDER BY created_at DESC LIMIT 1`,
    [realUserId],
  );
  return circle.rows[0] ?? null;
}

// Approves the circle and sends the ONE real member the exact production
// message shape (api/src/routes/sendblue.ts's Keana-approval invite path):
// a generated circle title + "moment curated, reply YES/NO" — deliberately
// never mentions headcount or other members' names/identities, matching
// production's real consent design. Filler (simulated) members never get a
// send — they have no real phone number.
export async function approveRealPlacementAndNotify(
  circleId: string,
): Promise<{ success: boolean; error?: string; notified?: boolean }> {
  const circleResult = await pool.query(`SELECT id, real_test_placement FROM circles WHERE id = $1`, [circleId]);
  if (!circleResult.rows[0]) return { success: false, error: "Circle not found." };
  if (!circleResult.rows[0].real_test_placement) return { success: false, error: "Not a real-test-placement circle." };

  await pool.query(`UPDATE circles SET status = 'active' WHERE id = $1`, [circleId]);

  const memberResult = await pool.query(
    `SELECT u.id, u.first_name, u.phone_number, u.is_simulated, cp.city, cp.life_chapters, cp.goals
     FROM circle_members cm JOIN users u ON u.id = cm.member_id LEFT JOIN co_profiles cp ON cp.user_id = u.id
     WHERE cm.circle_id = $1`,
    [circleId],
  );
  const realMember = memberResult.rows.find((m: any) => !m.is_simulated);
  if (!realMember) return { success: true, notified: false };

  const city = realMember.city ?? "your city";
  const chapter = (realMember.life_chapters?.[0] ?? "").replace(/_/g, " ");

  const circleTitle = await generateCircleTitle(city, chapter, realMember.goals ?? []);
  const inviteMsg = await generateWarmCircleInviteMessage({
    firstName: realMember.first_name,
    circleTitle,
    chapter,
    city,
    goals: realMember.goals ?? [],
  });

  // This feature only ever notifies one real member per circle (the rest
  // are simulated filler), so persisting their personalized title here is
  // safe — unlike production's multi-member circles, there's no other real
  // recipient whose own title this would overwrite. Without this, the
  // accept/decline ack in webhooks.ts (which reads circles.circle_name)
  // would show the generic placeholder name instead of the actual
  // personalized title just sent — confirmed for real: the invite said
  // "The Bay Bridge Newcomers" and the ack said "Co Circle — new to city."
  await pool.query(`UPDATE circles SET circle_name = $1 WHERE id = $2`, [circleTitle, circleId]);

  try {
    await sendblue.messages.send({
      number: realMember.phone_number,
      content: inviteMsg,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (err: any) {
    console.error("Dynamic real-placement invite send failed:", err?.message ?? err);
    return { success: false, error: "Circle approved but the real notification failed to send — check logs." };
  }

  const placementContent = `Co invited user to circle ${circleId} ("${circleTitle}") — awaiting accept/decline (real test placement)`;
  const placementMem = await pool.query(
    `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'placement', $2) RETURNING id`,
    [realMember.id, placementContent],
  );
  generateEmbedding(placementContent)
    .then((emb) =>
      pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
        `[${emb.join(",")}]`,
        placementMem.rows[0].id,
      ]),
    )
    .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

  return { success: true, notified: true };
}

export async function rejectRealPlacement(circleId: string): Promise<{ success: boolean }> {
  await pool.query(`UPDATE circles SET status = 'rejected' WHERE id = $1`, [circleId]);
  return { success: true };
}

// Whether filler pools currently exist — used only to gate the checklist
// UI's "run diagnostics" / "attempt real placement" steps until step 1
// (generate filler pools) has actually happened, instead of letting them be
// clicked out of order with no real feedback about why nothing useful comes
// back.
export async function getDynamicPoolsSeeded(): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM users WHERE is_simulated = true AND simulation_scenario IN ('DYNAMIC_A', 'DYNAMIC_B', 'DYNAMIC_C') LIMIT 1`,
  );
  return !!result.rows[0];
}

// Clears only this feature's own data — the filler pools it generated and
// the real circle(s) it created. Never touches the real test user's own
// account, profile, memories, or captured intent.
export async function resetDynamicPools(): Promise<void> {
  await pool.query(`DELETE FROM moments WHERE circle_id IN (SELECT id FROM circles WHERE real_test_placement = true)`);
  await pool.query(`DELETE FROM circles WHERE real_test_placement = true`);
  await pool.query(
    `DELETE FROM users WHERE is_simulated = true AND simulation_scenario IN ('DYNAMIC_A', 'DYNAMIC_B', 'DYNAMIC_C')`,
  );
  await pool.query(`DELETE FROM co_test_dynamic_runs`);
}
