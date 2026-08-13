import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import crypto from "crypto";
import pool from "../db/db.js";
import { generateEmbedding, generateGoalEmbedding } from "./embeddings.js";

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
// and the nine Rapport-phase topics in Jacqueline's spec.
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
): Promise<{ raw: string; extracted: ExtractedProfile }> {
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
          "emotional_state": "" // one word describing their current emotional state (e.g. anxious, energized, overwhelmed, motivated, isolated, confident, focused, excited, lost, burnout)
        }

        Transcript:
        "${transcript}"`,
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
// channel (webhooks.ts's ongoing-conversation reply) so a text-only
// relationship works toward the same set of topics a call does instead of
// just reactively answering whatever comes up. Deliberately separate from
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
// callContext.ts's buildContextSummary or webhooks.ts's own profileContext
// string). Without this, coverage was judged purely off the live transcript,
// so a topic already answered by text last week still came back "missing"
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

// Cheap Haiku pass (same shape as assessConversationCoverage) that checks
// whether this call's transcript signals that an already-on-file goal or
// blocker is done/resolved/no longer relevant — otherwise the union in
// storeProfile only ever grows and stale items pile up forever. Only fires
// when there's something on file to check against. Matches are filtered back
// against the original arrays so a hallucinated or reworded item can't
// accidentally drop something real — worst case a resolved item just lingers
// until the next call catches it.
async function assessResolvedItems(
  transcript: string,
  existingGoals: string[],
  existingBlockers: string[],
): Promise<{ resolvedGoals: string[]; resolvedBlockers: string[] }> {
  if (existingGoals.length === 0 && existingBlockers.length === 0) {
    return { resolvedGoals: [], resolvedBlockers: [] };
  }

  try {
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `Here is what we already have on file for this person:
Goals: ${JSON.stringify(existingGoals)}
Blockers: ${JSON.stringify(existingBlockers)}

Based on this new call transcript, which of the EXACT items above (if any) has the caller indicated is now achieved, resolved, or no longer relevant? Only include an item if the transcript gives a clear signal — do not guess, and leave it out if unclear.

Transcript:
"${transcript}"

Return ONLY valid JSON, reusing the exact original text for each item:
{"resolved_goals": [], "resolved_blockers": []}`,
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

    return { resolvedGoals, resolvedBlockers };
  } catch (err) {
    console.error("assessResolvedItems failed (non-fatal):", err);
    return { resolvedGoals: [], resolvedBlockers: [] };
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
            goals, blockers, availability_pattern, city
     FROM co_profiles WHERE user_id = $1`,
    [user_id],
  );
  const existing = existingRows[0] ?? null;

  const union = (oldArr: string[] | null | undefined, newArr: string[] | null | undefined) => [
    ...new Set([...(oldArr ?? []), ...(newArr ?? [])]),
  ];

  const { resolvedGoals, resolvedBlockers } = await assessResolvedItems(
    transcript,
    existing?.goals ?? [],
    existing?.blockers ?? [],
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

  await pool.query(
    `INSERT INTO co_profiles (
      user_id, life_chapters, social_energy, connection_style,
      activity_preferences, emotional_state, goals, blockers,
      availability_pattern, city, goal_embeddings, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
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
    ],
  );

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
          prompt: `Read this transcript and extract four things. Only include what's actually stated — never guess or infer beyond what's said.

1. ask — something specific they are actively seeking or could offer to others (a connection, an introduction, a resource, expertise). One clear sentence, classified as 'seeking' or 'offering'. null if no specific ask is present.
2. concrete_preferences — named, specific things they mentioned liking or wanting, not vague vibes. A specific gym or workout style, a coffee/drink preference, a type of venue or neighborhood, a specific activity. "SoulCycle", "oat milk lattes", "speakeasy-style bars" — not "fitness" or "good coffee".
3. wants — things they said they miss or want to find (a running group, a book club, a version of something from a previous city).
4. availability — their stated general availability pattern, in their own words. null if not mentioned. Do not infer a schedule from anything other than what they directly said.

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

    return newIntent;
  } catch (err: any) {
    console.error("captureIntent failed (non-fatal):", err?.message ?? err);
    return null;
  }
}
