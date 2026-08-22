import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import crypto from "crypto";
import pool from "../db/db.js";
import { generateEmbedding, generateGoalEmbedding } from "./embeddings.js";
import { sweepAskAgainstNetwork, sweepOfferingAgainstNetwork } from "./relevance.js";

// Shared by the Hume call webhook (co.ts /webhook), the typed-intake fallback
// (co.ts /typed-intake/:user_id), and co-test's browser-EVI intake — all three
// feed a raw transcript through the same psychographic extraction + co_profiles
// upsert so the fields Co reports and the fields matching actually scores
// against never drift apart between entry points.

export const ALLOWED_LIFE_CHAPTERS = ["new_to_city", "building_solo", "career_pivot", "starting_over"];
export const ALLOWED_CONNECTION_STYLES = ["small_group", "medium_group", "large_social"];

export type ExtractedProfile = {
  life_chapters?: string[];
  social_energy?: number;
  connection_style?: string;
  activity_preferences?: string[];
  goals?: string[];
  blockers?: string[];
  availability_pattern?: string;
  city?: string;
  emotional_state?: string;
  // Co Loop Stage 1 addition — longer-horizon personal + career direction,
  // deliberately separate from goals_challenges (immediate/current). See
  // RAPPORT_TOPICS' long_term_direction description for why this split
  // exists.
  long_term_direction?: string;
  [key: string]: unknown;
};

export type ExtractedIntent = {
  id: string;
  // The original seeking/offering ask — both optional now, since a
  // transcript can carry real concrete_preferences/wants/availability
  // signal without ever stating one clear ask (previously this whole
  // record simply didn't exist in that case).
  text?: string;
  type?: "seeking" | "offering";
  // Named, concrete things mentioned — a specific gym, a coffee style, a
  // venue type — not a vague vibe. Recommendation/Event both need this
  // level of specificity to produce anything worth sending.
  concrete_preferences: string[];
  // Things they said they miss or want to find (a running group, a book
  // club, a version of a place from a previous city).
  wants: string[];
  // General availability pattern, in their own words — not parsed into a
  // schedule, just captured as stated ("weekday evenings", "flexible except Sundays").
  availability: string | null;
  status: "active";
  embedding: number[] | null;
  created_at: string;
};

// Keys must match the tool schema description registered on the Hume config
// and the Rapport-phase topics in Jacqueline's spec.
//
// long_term_direction (added for Co Loop Stage 1) is NOT yet confirmed
// registered on Hume's own tool schema for assess_conversation_coverage —
// that config lives on Hume's dashboard, outside this repo, and per the
// comment above this array must independently list any topic key for it to
// reliably show up in missing_topics on a live voice call. The text channel
// (assessConversationCoverage's own prompt, built from RAPPORT_TOPICS
// directly) picks this up correctly regardless. Confirm/update the Hume-side
// schema before relying on this topic surfacing on calls.
export const RAPPORT_TOPICS = [
  "current_situation",
  "major_transition",
  "goals_challenges",
  "looking_for",
  "people_to_meet",
  "ways_to_help",
  "personality",
  "location_availability",
  "boundaries_preferences",
  "long_term_direction",
] as const;

export type RapportTopic = (typeof RAPPORT_TOPICS)[number];

// Single source of truth for what each topic actually means — used both to
// build assessConversationCoverage's prompt below and, for the text channel
// (webhooks.ts), to tell the reply-generation model in plain language what a
// missing_topics key is actually asking about.
export const RAPPORT_TOPIC_DESCRIPTIONS: Record<RapportTopic, string> = {
  current_situation: "what's going on in their life right now",
  major_transition: "the bigger context or change they're in the middle of",
  goals_challenges: "what they're working toward or struggling with",
  looking_for: "what kind of connection or outcome they want from this",
  people_to_meet: "the kind of people they'd want to be introduced to",
  ways_to_help: "what they could offer or help others with",
  personality: "some sense of their personality or how they come across",
  location_availability: "where they are and when they're free",
  boundaries_preferences: "any stated boundaries or preferences",
  long_term_direction:
    "their longer-horizon personal and career direction — where they want to be in a few years, distinct from what's urgent right now",
};

export type CoverageAssessment = {
  missing_topics: RapportTopic[];
  ready_to_summarize: boolean;
};

const COVERAGE_FALLBACK: CoverageAssessment = {
  missing_topics: [...RAPPORT_TOPICS],
  ready_to_summarize: false,
};

// Step 1 of the pipeline — turns a transcript into raw psychographic JSON via
// Claude. Returns both the raw model output and the parsed/attempted-parse
// result so callers that need to show "exactly what the pipeline produced"
// (co-test's raw-output panel) don't have to re-derive it.
export async function extractPsychographicProfile(
  transcript: string,
  emotionalHighlights?: string,
): Promise<{ raw: string; extracted: ExtractedProfile }> {
  // Voice calls only — Hume's own prosody analysis on the user's real audio
  // (not available for text). Without this, "blockers"/emotional_state are
  // inferred from wording alone, so a topic mentioned calmly and one that
  // actually made someone anxious read identically to the model. This
  // grounds the extraction in what Hume's voice analysis flagged as the
  // most emotionally loaded moments, so those get weighted appropriately
  // rather than just whatever was mentioned most.
  const emotionalContext = emotionalHighlights
    ? `\n\nHume's own voice-emotion analysis flagged these as the most emotionally loaded moments in the call (use this to weight blockers/emotional_state toward what actually carried real feeling, not just what was mentioned most often):\n${emotionalHighlights}`
    : "";

  const { text: rawExtraction } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    prompt: `You are extracting psychographic profile data from a conversation transcript.

        Based on this transcript, extract the following fields and return ONLY valid JSON with no preamble or markdown:

        {
          "life_chapters": [], // array of applicable values from: new_to_city, building_solo, career_pivot, starting_over
          "social_energy": 0, // number 0-100 (0 = very introverted/quiet preference, 100 = very extroverted/high energy)
          "connection_style": "", // one of: small_group, medium_group, large_social
          "activity_preferences": [], // array of activities they mentioned or implied enjoying
          "goals": [], // array of things they are working toward
          "blockers": [], // array of challenges or struggles they mentioned
          "availability_pattern": "", // how often and when they want to connect (e.g. "weekday evenings", "weekends")
          "city": "", // city they are in or moving to
          "emotional_state": "", // one word describing their current emotional state (e.g. anxious, energized, overwhelmed, motivated, isolated, confident, focused, excited, lost, burnout)
          "long_term_direction": "" // a sentence capturing their longer-term personal + career direction/trajectory — where they're headed, distinct from immediate goals/blockers. Empty string if not discussed.
        }

        Transcript:
        "${transcript}"${emotionalContext}`,
    experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.extractPsychographicProfile" },
  });

  let extracted: ExtractedProfile = {};
  try {
    const clean = rawExtraction.replace(/```json|```/g, "").trim();
    extracted = JSON.parse(clean);
  } catch {
    console.error("Failed to parse psychographic extraction:", rawExtraction);
  }

  return { raw: rawExtraction, extracted };
}

// Coverage check — originally mid-call only (invoked from the Hume
// tool_call webhook while a call is live), now also reused by the text
// channel — co-test/src/routes/webhooks.ts had this pattern already proven,
// and prod's routes/sendblue.ts now ports the same approach into its own
// reply-generation prompt (Co Loop Stage 1) — so a text-only relationship
// works toward the same set of topics a call does instead of just reactively
// answering whatever comes up. Deliberately separate from
// extractPsychographicProfile: Haiku (not Sonnet), no DB writes, no
// embeddings, terse output-only prompt — on a live call every millisecond
// here is dead air, since EVI blocks the conversation on a pending tool
// response; on text there's no such constraint but the same cheap/fast
// shape is still the right call. On a live call, does NOT decide what Co
// says next — EVI's own model phrases the next question from
// missing_topics, this only reports coverage; the text channel instead
// feeds missing_topics into its own reply-generation prompt directly.
// priorContext (optional) — a compact summary of what's already known about
// this person from BEFORE this conversation (prior calls/texts, e.g.
// callContext.ts's buildContextSummary or sendblue.ts's own profile
// summary). Without this, coverage was judged purely off the live
// transcript, so a topic already answered by text last week still came back
// "missing"
// on a call today and Co would re-ask something it already knew — this lets
// already-known, concrete facts count as covered without requiring the
// person to repeat themselves.
export async function assessConversationCoverage(
  transcriptSoFar: string,
  priorContext?: string,
): Promise<CoverageAssessment> {
  if (!transcriptSoFar.trim() && !priorContext?.trim()) return COVERAGE_FALLBACK;

  const topicList = RAPPORT_TOPICS.map((t) => `- ${t}: ${RAPPORT_TOPIC_DESCRIPTIONS[t]}`).join("\n");
  const priorContextBlock = priorContext?.trim()
    ? `What's already known about this person from before this conversation (prior calls/texts):\n"${priorContext.trim()}"\n\n`
    : "";

  try {
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `${priorContextBlock}Transcript of an in-progress conversation so far between Co (an assistant) and a person, by phone or text:
"${transcriptSoFar.trim() || "(nothing said yet in this conversation)"}"

Which of these topics has the person substantively addressed — either in what's already known from before, or in this conversation so far? Judge by real, concrete information. A topic only counts as covered by prior context if it states something specific and substantive, not a vague hint.
${topicList}

Return ONLY valid JSON, no preamble or markdown:
{"missing_topics": [...topic keys not yet covered...], "ready_to_summarize": true|false}

ready_to_summarize is true only if at most one or two minor topics remain missing, AND this conversation itself (not just prior context) has substantively happened — never mark it true based on prior context alone with nothing yet said in this conversation.`,
      experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.assessConversationCoverage" },
    });

    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const missing = Array.isArray(parsed.missing_topics)
      ? parsed.missing_topics.filter((t: unknown): t is RapportTopic =>
          RAPPORT_TOPICS.includes(t as RapportTopic),
        )
      : [...RAPPORT_TOPICS];

    return { missing_topics: missing, ready_to_summarize: Boolean(parsed.ready_to_summarize) };
  } catch (err) {
    console.error("assessConversationCoverage failed, falling back to nothing-covered:", err);
    return COVERAGE_FALLBACK;
  }
}

// Priority order for WHICH missing topic to actually ask about — deliberately
// not RAPPORT_TOPICS' own declaration order. A gap in goals_challenges or
// long_term_direction feeds Stage 3's matching directly (goal_embeddings /
// trajectory_embedding); a gap in personality or boundaries_preferences is
// lower-value rapport color. Only ever consulted when picking ONE topic for
// a single-question nudge (text replies, check-ins) — the live call's own
// tool response still returns the full missing_topics list, since EVI (not
// this file) decides what to ask next during a live conversation.
const RAPPORT_TOPIC_PRIORITY: RapportTopic[] = [
  "goals_challenges",
  "long_term_direction",
  "looking_for",
  "people_to_meet",
  "ways_to_help",
  "current_situation",
  "major_transition",
  "location_availability",
  "personality",
  "boundaries_preferences",
];

// Merges newly-confirmed topics into co_profiles.topics_covered — called
// both by getCoverageNudge below (text/check-in) and directly by the Hume
// tool_call handler (co.ts) after a live call's own coverage check, so a
// topic confirmed on a call is remembered for text too, not just the other
// way around. jsonb `||` merge (not a full read-modify-write) so concurrent
// callers can't clobber each other. Fire-and-forget/non-fatal, same as every
// other best-effort profile write in this file.
export function persistCoveredTopics(userId: string, coverage: CoverageAssessment): void {
  const missing = new Set(coverage.missing_topics);
  const covered = RAPPORT_TOPICS.filter((t) => !missing.has(t));
  if (!covered.length) return;
  const patch: Partial<Record<RapportTopic, string>> = {};
  const now = new Date().toISOString();
  for (const t of covered) patch[t] = now;
  pool
    .query(
      `UPDATE co_profiles SET topics_covered = COALESCE(topics_covered, '{}'::jsonb) || $2::jsonb WHERE user_id = $1`,
      [userId, JSON.stringify(patch)],
    )
    .catch((err) => console.error("topics_covered update failed (non-fatal):", err));
}

// Records that Co actually asked about a topic (regardless of whether it
// gets answered) — callers invoke this only when a nudge is actually used in
// an outbound message, not just considered. Read by getCoverageNudge's
// anti-nag filter below.
export function markTopicAsked(userId: string, topic: RapportTopic): void {
  pool
    .query(
      `UPDATE co_profiles SET topics_asked = COALESCE(topics_asked, '{}'::jsonb) || jsonb_build_object($2::text, $3::text) WHERE user_id = $1`,
      [userId, topic, new Date().toISOString()],
    )
    .catch((err) => console.error("topics_asked update failed (non-fatal):", err));
}

// Simple 0-100 read of how much of RAPPORT_TOPICS is on file for someone —
// not stored anywhere itself (topics_covered is the source of truth; this is
// just a derived read of it), useful for a future network-wide density
// report (Stage 2) without needing a separate synced column that could go
// stale.
export function getProfileCompletenessPercent(topicsCovered: Record<string, string> | null | undefined): number {
  if (!topicsCovered) return 0;
  const covered = RAPPORT_TOPICS.filter((t) => topicsCovered[t]).length;
  return Math.round((covered / RAPPORT_TOPICS.length) * 100);
}

export type CoverageNudgeProfile = {
  life_chapters?: string[] | null;
  goals?: string[] | null;
  blockers?: string[] | null;
  long_term_direction?: string | null;
  city?: string | null;
  topics_covered?: Record<string, string> | null;
  topics_asked?: Record<string, string> | null;
};

// Shared by sendblue.ts's reply-generation prompt and the Stage 5 check-in
// cron (jobs/index.ts) — one place owning "which single topic, if any,
// should Co work toward asking about right now." Skips the LLM call
// entirely once every RAPPORT_TOPICS entry is already persisted as covered
// (cheap, and keeps a complete profile from re-triggering this check
// forever). Otherwise runs assessConversationCoverage, persists whatever it
// newly confirms, filters out anything asked-but-dodged in the last
// ANTI_NAG_DAYS, and returns the single highest-priority topic left, if any.
// transcriptSoFar is "" for a check-in (no live transcript, judged purely
// off priorContext) and the recent conversation thread for a text reply.
const ANTI_NAG_DAYS = 14;
export async function getCoverageNudge(
  userId: string,
  transcriptSoFar: string,
  profile: CoverageNudgeProfile | null,
): Promise<{ missingTopic: RapportTopic | null }> {
  const topicsCovered = profile?.topics_covered ?? {};
  const topicsAsked = profile?.topics_asked ?? {};

  if (RAPPORT_TOPICS.every((t) => topicsCovered[t])) return { missingTopic: null };

  const priorContextParts = [
    profile?.life_chapters?.length ? `life chapter: ${profile.life_chapters.join(", ")}` : null,
    profile?.goals?.length ? `goals: ${profile.goals.join(", ")}` : null,
    profile?.blockers?.length ? `blockers: ${profile.blockers.join(", ")}` : null,
    profile?.long_term_direction ? `long-term direction: ${profile.long_term_direction}` : null,
    profile?.city ? `city: ${profile.city}` : null,
  ].filter((p): p is string => Boolean(p));

  const coverage = await assessConversationCoverage(
    transcriptSoFar,
    priorContextParts.length ? priorContextParts.join("; ") : undefined,
  ).catch(() => null);
  if (!coverage) return { missingTopic: null };

  persistCoveredTopics(userId, coverage);

  const cutoff = Date.now() - ANTI_NAG_DAYS * 24 * 60 * 60 * 1000;
  const candidates = coverage.missing_topics.filter((t) => {
    const askedAt = topicsAsked[t];
    return !askedAt || new Date(askedAt).getTime() < cutoff;
  });

  const missingTopic = RAPPORT_TOPIC_PRIORITY.find((t) => candidates.includes(t)) ?? null;
  return { missingTopic };
}

// Cheap Haiku pass (same shape as assessConversationCoverage) that checks
// whether this call's transcript signals that an already-on-file goal or
// blocker is done/resolved/no longer relevant — otherwise the union in
// storeProfile only ever grows and stale items pile up forever. Only fires
// when there's something on file to check against. Matches are filtered back
// against the original arrays so a hallucinated or reworded item can't
// accidentally drop something real — worst case a resolved item just lingers
// until the next call catches it.
// openAsks (added for Co Loop Stage 6) — the person's currently-open
// ask_checkins rows, {id, text}. Folded into this same Haiku pass rather than
// a separate call: the judgment ("has the transcript signaled this is done")
// is identical in kind to resolving a goal/blocker, so one call handles all
// three. A resolved ask closes the loop back to Stage 3 — storeProfile
// retires the matching relevance_edges rows and stops further Stage 5
// check-ins for it.
async function assessResolvedItems(
  transcript: string,
  existingGoals: string[],
  existingBlockers: string[],
  openAsks: { id: string; text: string }[] = [],
): Promise<{ resolvedGoals: string[]; resolvedBlockers: string[]; resolvedAskIds: string[] }> {
  if (existingGoals.length === 0 && existingBlockers.length === 0 && openAsks.length === 0) {
    return { resolvedGoals: [], resolvedBlockers: [], resolvedAskIds: [] };
  }

  try {
    const askListBlock = openAsks.length
      ? `\nOpen asks (numbered):\n${openAsks.map((a, i) => `${i}. ${a.text}`).join("\n")}\n`
      : "";

    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `Here is what we already have on file for this person:
Goals: ${JSON.stringify(existingGoals)}
Blockers: ${JSON.stringify(existingBlockers)}
${askListBlock}
Based on this new call transcript, which of the EXACT goals/blockers above (if any) has the caller indicated is now achieved, resolved, or no longer relevant? Separately, which numbered open asks (if any) has the transcript signaled are now resolved, no longer needed, or no longer true? Only include something if the transcript gives a clear signal — do not guess, and leave it out if unclear.

Transcript:
"${transcript}"

Return ONLY valid JSON, reusing the exact original text for goals/blockers and the number for asks:
{"resolved_goals": [], "resolved_blockers": [], "resolved_ask_indices": []}`,
      experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.assessResolvedItems" },
    });

    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const resolvedGoals = Array.isArray(parsed.resolved_goals)
      ? parsed.resolved_goals.filter((g: unknown) => existingGoals.includes(g as string))
      : [];
    const resolvedBlockers = Array.isArray(parsed.resolved_blockers)
      ? parsed.resolved_blockers.filter((b: unknown) => existingBlockers.includes(b as string))
      : [];
    const resolvedAskIds = Array.isArray(parsed.resolved_ask_indices)
      ? parsed.resolved_ask_indices
          .filter((i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < openAsks.length)
          .map((i: number) => openAsks[i].id)
      : [];

    return { resolvedGoals, resolvedBlockers, resolvedAskIds };
  } catch (err) {
    console.error("assessResolvedItems failed (non-fatal):", err);
    return { resolvedGoals: [], resolvedBlockers: [], resolvedAskIds: [] };
  }
}

// Step 2 — sanitizes against co_profiles' CHECK constraints and upserts.
// Each call's transcript only covers what that call happened to touch on, so
// list fields (life_chapters, activity_preferences, goals, blockers) are
// unioned with what's already on file rather than replaced — otherwise a
// goal mentioned on call 1 but not call 2 would silently vanish. Goals and
// blockers are then trimmed by assessResolvedItems so items the caller has
// since resolved don't accumulate forever. Scalar fields (social_energy,
// connection_style, availability_pattern, city) are the model's holistic
// read of the latest call and take precedence, but fall back to the existing
// value when this call's extraction came back empty. emotional_state is
// deliberately NOT carried forward — it describes the caller's state as of
// *this* call, so a call with no signal just clears it.
// hume_chat_group_id is intentionally not handled here — it's a call-resume
// concern specific to the Twilio/Hume webhook path, not part of extraction.
export async function storeProfile(
  user_id: string,
  extracted: ExtractedProfile,
  transcript: string,
  opts: { emotions?: { name: string; score: number }[] | null } = {},
): Promise<{ safeChapters: string[]; safeStyle: string }> {
  const { rows: existingRows } = await pool.query(
    `SELECT life_chapters, social_energy, connection_style, activity_preferences,
            goals, blockers, availability_pattern, city, long_term_direction
     FROM co_profiles WHERE user_id = $1`,
    [user_id],
  );
  const existing = existingRows[0] ?? null;

  const union = (oldArr: string[] | null | undefined, newArr: string[] | null | undefined) => [
    ...new Set([...(oldArr ?? []), ...(newArr ?? [])]),
  ];

  // Co Loop Stage 6 — fold in whatever open asks (Stage 5) this person has,
  // so the same resolution pass that clears a stale goal/blocker can also
  // retire a relevance_edges row and stop further check-ins on an ask that's
  // already resolved.
  const { rows: openAskRows } = await pool.query(
    `SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL`,
    [user_id],
  );
  const openAsks = openAskRows.map((r: any) => ({ id: r.ask_id as string, text: r.ask_text as string }));

  const { resolvedGoals, resolvedBlockers, resolvedAskIds } = await assessResolvedItems(
    transcript,
    existing?.goals ?? [],
    existing?.blockers ?? [],
    openAsks,
  );

  const safeChapters = union(
    existing?.life_chapters,
    (extracted.life_chapters ?? []).filter((c: string) => ALLOWED_LIFE_CHAPTERS.includes(c)),
  );
  const safeStyle = ALLOWED_CONNECTION_STYLES.includes(extracted.connection_style as string)
    ? (extracted.connection_style as string)
    : (existing?.connection_style ?? "small_group");
  const activityPreferences = union(existing?.activity_preferences, extracted.activity_preferences);
  const goals = union(existing?.goals, extracted.goals).filter((g) => !resolvedGoals.includes(g));
  const blockers = union(existing?.blockers, extracted.blockers).filter(
    (b) => !resolvedBlockers.includes(b),
  );
  const socialEnergy = extracted.social_energy ?? existing?.social_energy ?? 50;
  const availabilityPattern = extracted.availability_pattern || existing?.availability_pattern || null;
  const city = extracted.city || existing?.city || null;
  const longTermDirection = extracted.long_term_direction || existing?.long_term_direction || null;

  // Non-fatal like every other embedding call in this file (storeTranscriptMemory,
  // captureIntent) — an embedding-provider hiccup (rate limit, quota, network)
  // must never block the profile write itself, which is what the caller
  // actually needs. A null embedding here just means this profile doesn't
  // participate in goal-similarity matching until the next successful call.
  // Recomputed from the merged goal list so it stays in sync with `goals`.
  let goalEmbedding: number[] | null = null;
  if (goals.length > 0) {
    try {
      goalEmbedding = await generateGoalEmbedding(goals);
    } catch (err) {
      console.error("Goal embedding failed (non-fatal):", err);
    }
  }

  // Same non-fatal reasoning as goalEmbedding above, recomputed from
  // longTermDirection so it stays in sync — see Co Loop Stage 1.
  let trajectoryEmbedding: number[] | null = null;
  if (longTermDirection) {
    try {
      trajectoryEmbedding = await generateEmbedding(longTermDirection);
    } catch (err) {
      console.error("Trajectory embedding failed (non-fatal):", err);
    }
  }

  await pool.query(
    `INSERT INTO co_profiles (
      user_id, life_chapters, social_energy, connection_style,
      activity_preferences, emotional_state, goals, blockers,
      availability_pattern, city, goal_embeddings, long_term_direction,
      trajectory_embedding, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      life_chapters = EXCLUDED.life_chapters,
      social_energy = EXCLUDED.social_energy,
      connection_style = EXCLUDED.connection_style,
      activity_preferences = EXCLUDED.activity_preferences,
      emotional_state = EXCLUDED.emotional_state,
      goals = EXCLUDED.goals,
      blockers = EXCLUDED.blockers,
      availability_pattern = EXCLUDED.availability_pattern,
      city = EXCLUDED.city,
      goal_embeddings = EXCLUDED.goal_embeddings,
      long_term_direction = EXCLUDED.long_term_direction,
      trajectory_embedding = EXCLUDED.trajectory_embedding,
      updated_at = NOW()`,
    [
      user_id,
      safeChapters,
      socialEnergy,
      safeStyle,
      activityPreferences,
      extracted.emotional_state ?? opts.emotions?.[0]?.name ?? null,
      goals,
      blockers,
      availabilityPattern,
      city,
      goalEmbedding ? `[${goalEmbedding.join(",")}]` : null,
      longTermDirection,
      trajectoryEmbedding ? `[${trajectoryEmbedding.join(",")}]` : null,
    ],
  );

  // Co Loop Stage 6 — close the loop back to Stages 3 and 5. A resolved ask
  // retires its relevance_edges rows (proof that Stage 3's call didn't need
  // to be acted on to be right) and stops further Stage 5 check-ins on it.
  if (resolvedAskIds.length) {
    await pool.query(
      `UPDATE ask_checkins SET resolved_at = NOW() WHERE user_id = $1 AND ask_id = ANY($2::text[])`,
      [user_id, resolvedAskIds],
    );
    await pool.query(
      `UPDATE relevance_edges SET status = 'retired', retired_at = NOW(),
        retired_reason = 'ask resolved independently, no intro made'
       WHERE person_id = $1 AND ask_id = ANY($2::text[]) AND status = 'open'`,
      [user_id, resolvedAskIds],
    );
  }

  return { safeChapters, safeStyle };
}

// Stores the raw transcript as a co_memories row, same shape used by both the
// Hume webhook (which has emotions/audio_url) and typed-intake (which has
// neither — they just default to NULL, identical to omitting the columns).
export async function storeTranscriptMemory(
  user_id: string,
  transcript: string,
  opts: { emotionalContext?: unknown; audioUrl?: string | null } = {},
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO co_memories (user_id, memory_type, content, emotional_context, audio_url)
     VALUES ($1, 'call_transcript', $2, $3, $4) RETURNING id`,
    [
      user_id,
      transcript,
      opts.emotionalContext !== undefined ? JSON.stringify(opts.emotionalContext) : null,
      opts.audioUrl ?? null,
    ],
  );
  const memoryId = rows[0].id;

  generateEmbedding(transcript)
    .then((emb) =>
      pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
        `[${emb.join(",")}]`,
        memoryId,
      ]),
    )
    .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

  return memoryId;
}

type CapturedIntentData = {
  ask: { text: string; type: "seeking" | "offering" } | null;
  concrete_preferences: string[];
  wants: string[];
  availability: string | null;
};

// Ambient intent capture — one Haiku pass, extended (not duplicated) to
// also pull named concrete preferences, things mentioned as missed/wanted,
// and stated availability, alongside the original seeking/offering ask.
// Recommendation and Event both depend on this data existing with real
// specificity — a vague vibe isn't enough to act on. Returns the extracted
// record (or null if literally nothing was found) so callers that want it
// synchronously (co-test's post-call view) can display it; the production
// call sites (co.ts) still call this fire-and-forget and ignore the
// resolved value, unchanged.
export async function captureIntent(
  user_id: string,
  transcript: string,
): Promise<ExtractedIntent | null> {
  try {
    const { text: rawIntent } = await propagateAttributes(
      { userId: user_id, traceName: "profileExtraction.captureIntent" },
      () =>
        generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.captureIntent" },
          prompt: `Read this transcript and extract four things. Only include what's actually stated by the user (the "user:" lines) — never guess or infer beyond what's said, and never treat something Co (the "assistant:" lines) said as if the user said it.

1. ask — something specific they are actively seeking or could offer to others (a connection, an introduction, a resource, expertise). One clear sentence, classified as 'seeking' or 'offering'. null if no specific ask is present.
2. concrete_preferences — named, specific things they mentioned liking or wanting, not vague vibes. A specific gym or workout style, a coffee/drink preference, a type of venue or neighborhood, a specific activity. "SoulCycle", "oat milk lattes", "speakeasy-style bars" — not "fitness" or "good coffee".
3. wants — things they said they miss or want to find (a running group, a book club, a version of something from a previous city).
4. availability — their stated GENERAL, RECURRING availability pattern, in their own words (e.g. "weekday evenings", "usually free on weekends"). A one-off request for a specific call or meeting at a specific time ("call me at 2pm today", "can we talk Thursday morning") is NOT a recurring availability pattern — leave this null for those, even if a specific time or day appears in the transcript. Only fill this in when they're describing when they're generally free, not when they want THIS ONE call to happen.

Return ONLY valid JSON, no preamble:
{"ask": {"text": "Looking for climate tech founders at $1M+ ARR", "type": "seeking"} or null, "concrete_preferences": ["..."], "wants": ["..."], "availability": "..." or null}

Transcript:
"${transcript}"`,
        }),
    );

    const clean = rawIntent.replace(/```json|```/g, "").trim();
    if (!clean) return null;

    let parsed: CapturedIntentData | null = null;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return null;
    }

    const ask = parsed?.ask?.text && parsed?.ask?.type ? parsed.ask : null;
    const concrete_preferences = Array.isArray(parsed?.concrete_preferences) ? parsed!.concrete_preferences : [];
    const wants = Array.isArray(parsed?.wants) ? parsed!.wants : [];
    const availability = typeof parsed?.availability === "string" ? parsed!.availability : null;

    // Nothing real came out of this pass at all — don't write an empty
    // record just to have one.
    if (!ask && !concrete_preferences.length && !wants.length && !availability) return null;

    const intentId = crypto.randomUUID();
    // Embedding covers the ask sentence when present (what goal-similarity
    // matching would compare against); falls back to the richest available
    // text so a record with no ask still gets a usable embedding.
    const embeddingSource = ask?.text || [...concrete_preferences, ...wants].join("; ") || availability || "";
    const embedding = embeddingSource ? await generateEmbedding(embeddingSource).catch(() => null) : null;

    const newIntent: ExtractedIntent = {
      id: intentId,
      ...(ask ? { text: ask.text, type: ask.type } : {}),
      concrete_preferences,
      wants,
      availability,
      status: "active",
      embedding,
      created_at: new Date().toISOString(),
    };

    // Upsert, not a plain UPDATE — the call/typed-intake path is the only
    // other place a co_profiles row gets created (storeProfile), so a
    // text-only user who has never called would otherwise have no row for
    // this to update against and the ask would silently vanish.
    await pool.query(
      `INSERT INTO co_profiles (user_id, intent, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         intent = COALESCE(co_profiles.intent, '[]'::jsonb) || EXCLUDED.intent,
         updated_at = NOW()`,
      [user_id, JSON.stringify([newIntent])],
    );

    const memParts = [
      ask ? `${ask.type}: ${ask.text}` : null,
      concrete_preferences.length ? `preferences: ${concrete_preferences.join(", ")}` : null,
      wants.length ? `wants: ${wants.join(", ")}` : null,
      availability ? `availability: ${availability}` : null,
    ].filter(Boolean);
    const memContent = `Co captured intent — ${memParts.join(" | ")}`;
    const mem = await pool.query(
      `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'intent', $2) RETURNING id`,
      [user_id, memContent],
    );
    generateEmbedding(memContent)
      .then((emb) =>
        pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
          `[${emb.join(",")}]`,
          mem.rows[0].id,
        ]),
      )
      .catch((err) => console.error("Intent memory embedding failed:", err));

    // Co Loop Stage 5 — start the check-in cadence for this ask so it never
    // just goes stale after being captured once (see ask_checkins in
    // migrations.ts and the check-in cron in jobs/index.ts).
    if (ask) {
      pool
        .query(
          `INSERT INTO ask_checkins (user_id, ask_id, ask_text)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, ask_id) DO NOTHING`,
          [user_id, intentId, ask.text],
        )
        .catch((err) => console.error("ask_checkins insert failed (non-fatal):", err));
    }

    // Co Loop Stage 3 — a fresh "seeking" ask is exactly what filterByStatedAsk
    // reasons over, so sweep it against the whole network immediately rather
    // than waiting for the next daily sweepAllOpenAsks run. Fire-and-forget,
    // same as this function's own call sites treat captureIntent itself. A
    // fresh "offering" gets the mirrored reverse sweep — otherwise it would
    // only ever surface as a side-effect of someone else's seeking sweep.
    if (ask?.type === "seeking") {
      sweepAskAgainstNetwork(user_id).catch((err) =>
        console.error("sweepAskAgainstNetwork failed (non-fatal):", err),
      );
    } else if (ask?.type === "offering") {
      sweepOfferingAgainstNetwork(user_id).catch((err) =>
        console.error("sweepOfferingAgainstNetwork failed (non-fatal):", err),
      );
    }

    return newIntent;
  } catch (err: any) {
    console.error("captureIntent failed (non-fatal):", err?.message ?? err);
    return null;
  }
}
