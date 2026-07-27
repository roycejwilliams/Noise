import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../../../api/src/db/db.js";

// Intent-Layer-only real action: Co can actually invoke this (voice via
// Hume's tool_call plane, iMessage via a direct call from the ongoing-chat
// handler) and get back something concrete, grounded in what's actually
// stored for that specific person — not a hypothetical description. No
// venue/moment/circle logic here by design; "match" names a type of
// activity/community/next-step, never a real business or place, since we
// have no real venue data to ground that (that's Circles/venue-selection
// territory, deliberately not touched).
export type RecommendationResult =
  | { available: true; match: string; reason: string }
  | { available: false; reason: string };

const NOT_ENOUGH_DATA: RecommendationResult = {
  available: false,
  reason: "not enough concrete preference data on file yet",
};

export async function generateRecommendation(userId: string): Promise<RecommendationResult> {
  try {
    const { rows } = await pool.query(
      `SELECT life_chapters, goals, blockers, activity_preferences, availability_pattern, city, emotional_state, intent
       FROM co_profiles WHERE user_id = $1`,
      [userId],
    );
    const profile = rows[0];
    if (!profile) return NOT_ENOUGH_DATA;

    const latestIntent = Array.isArray(profile.intent) && profile.intent.length
      ? profile.intent[profile.intent.length - 1]
      : null;

    const hasSignal =
      (profile.goals?.length ?? 0) > 0 ||
      (profile.activity_preferences?.length ?? 0) > 0 ||
      (latestIntent?.concrete_preferences?.length ?? 0) > 0 ||
      (latestIntent?.wants?.length ?? 0) > 0 ||
      Boolean(latestIntent?.text);
    if (!hasSignal) return NOT_ENOUGH_DATA;

    const knownData = [
      profile.life_chapters?.length ? `Life chapter: ${profile.life_chapters.join(", ")}` : null,
      profile.city ? `City: ${profile.city}` : null,
      profile.goals?.length ? `Goals: ${profile.goals.join("; ")}` : null,
      profile.blockers?.length ? `Blockers: ${profile.blockers.join("; ")}` : null,
      profile.activity_preferences?.length
        ? `Activity preferences: ${profile.activity_preferences.join(", ")}`
        : null,
      profile.availability_pattern ? `Availability: ${profile.availability_pattern}` : null,
      profile.emotional_state ? `Emotional state as of the last call: ${profile.emotional_state}` : null,
      latestIntent?.text ? `Stated ask (${latestIntent.type}): ${latestIntent.text}` : null,
      latestIntent?.concrete_preferences?.length
        ? `Concrete preferences: ${latestIntent.concrete_preferences.join(", ")}`
        : null,
      latestIntent?.wants?.length ? `Things they want or miss: ${latestIntent.wants.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `Here is everything actually known about this person, captured from real conversations:
${knownData}

Based ONLY on this, name ONE concrete recommendation — a type of activity, group, or community, not a specific real business or venue (we have no real venue data, never invent one). Ground it in something they actually said. If nothing here is specific enough to recommend anything real, say so.

Return ONLY valid JSON, no preamble or markdown:
{"available": true, "match": "a consistent hiking or running group", "reason": "one sentence, grounded only in the data above"}
or
{"available": false, "reason": "why there isn't enough to go on"}`,
    });

    const clean = raw.replace(/```json|```/g, "").trim();
    let parsed: RecommendationResult | null = null;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return NOT_ENOUGH_DATA;
    }
    if (!parsed || typeof parsed.available !== "boolean") return NOT_ENOUGH_DATA;
    if (!parsed.available) return { available: false, reason: parsed.reason || NOT_ENOUGH_DATA.reason };
    if (!("match" in parsed) || !parsed.match) return NOT_ENOUGH_DATA;

    const result: RecommendationResult = { available: true, match: parsed.match, reason: parsed.reason ?? "" };

    await pool
      .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation', $2)`, [
        userId,
        `Co surfaced a recommendation — ${result.match}: ${result.reason}`,
      ])
      .catch((err) => console.error("Recommendation memory write failed (non-fatal):", err));

    return result;
  } catch (err: any) {
    console.error("generateRecommendation failed (non-fatal):", err?.message ?? err);
    return { available: false, reason: "lookup failed" };
  }
}
