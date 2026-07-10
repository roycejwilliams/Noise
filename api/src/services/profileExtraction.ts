import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import crypto from "crypto";
import pool from "../db/db.js";
import { generateEmbedding, generateGoalEmbedding } from "./embeddings.js";

// Shared by the Hume call webhook (co.ts /webhook), the typed-intake fallback
// (co.ts /typed-intake/:user_id), and co-test's browser-EVI intake — all three
// feed a raw transcript through the same psychographic extraction + co_profiles
// upsert so the fields Co reports and the fields matching actually scores
// against never drift apart between entry points.

const ALLOWED_LIFE_CHAPTERS = ["new_to_city", "building_solo", "career_pivot", "starting_over"];
const ALLOWED_CONNECTION_STYLES = ["small_group", "medium_group", "large_social"];

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
  text: string;
  type: "seeking" | "offering";
  status: "active";
  embedding: number[] | null;
  created_at: string;
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

// Step 2 — sanitizes against co_profiles' CHECK constraints and upserts.
// hume_chat_group_id is intentionally not handled here — it's a call-resume
// concern specific to the Twilio/Hume webhook path, not part of extraction.
export async function storeProfile(
  user_id: string,
  extracted: ExtractedProfile,
  opts: { emotions?: { name: string; score: number }[] | null } = {},
): Promise<{ safeChapters: string[]; safeStyle: string }> {
  const safeChapters = (extracted.life_chapters ?? []).filter((c: string) =>
    ALLOWED_LIFE_CHAPTERS.includes(c),
  );
  const safeStyle = ALLOWED_CONNECTION_STYLES.includes(extracted.connection_style as string)
    ? (extracted.connection_style as string)
    : "small_group";

  let goalEmbedding: number[] | null = null;
  if (extracted.goals && extracted.goals.length > 0) {
    goalEmbedding = await generateGoalEmbedding(extracted.goals);
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
      extracted.social_energy ?? 50,
      safeStyle,
      extracted.activity_preferences ?? [],
      extracted.emotional_state ?? opts.emotions?.[0]?.name ?? null,
      extracted.goals ?? [],
      extracted.blockers ?? [],
      extracted.availability_pattern ?? null,
      extracted.city ?? null,
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

// The seeking/offering Haiku pass — ambient intent capture. Returns the
// extracted intent (or null) so callers that want it synchronously (co-test's
// post-call view) can display it; the production call sites (co.ts) still
// call this fire-and-forget and ignore the resolved value, unchanged.
export async function captureIntent(
  user_id: string,
  transcript: string,
): Promise<ExtractedIntent | null> {
  try {
    const { text: rawIntent } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `Does this person mention something specific they are actively seeking or could offer to others — a connection, an introduction, a resource, expertise? If yes, extract it as a single clear sentence and classify as 'seeking' or 'offering'. If no specific ask is present, return null.

Return ONLY valid JSON or the word null:
{"text": "Looking for climate tech founders at $1M+ ARR", "type": "seeking"}

Transcript:
"${transcript}"`,
    });

    const clean = rawIntent.replace(/```json|```/g, "").trim();
    if (!clean || clean === "null") return null;

    let intentData: { text: string; type: "seeking" | "offering" } | null = null;
    try {
      intentData = JSON.parse(clean);
    } catch {
      return null;
    }
    if (!intentData?.text || !intentData?.type) return null;

    const intentId = crypto.randomUUID();
    const embedding = await generateEmbedding(intentData.text).catch(() => null);

    const newIntent: ExtractedIntent = {
      id: intentId,
      text: intentData.text,
      type: intentData.type,
      status: "active",
      embedding,
      created_at: new Date().toISOString(),
    };

    await pool.query(
      `UPDATE co_profiles
       SET intent = COALESCE(intent, '[]'::jsonb) || $1::jsonb
       WHERE user_id = $2`,
      [JSON.stringify([newIntent]), user_id],
    );

    const memContent = `Co captured intent: ${intentData.text}`;
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
