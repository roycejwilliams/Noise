import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { propagateAttributes } from "@langfuse/tracing";
import pool from "../db/db.js";
import { getTieredRecommendation, type TierMatch } from "./tieredRecommendation.js";

// Intent-Layer-only real action: Co can actually invoke this (voice via
// Hume's tool_call plane, iMessage via a direct call from the ongoing-chat
// handler) and get back something concrete, grounded in what's actually
// stored for that specific person — not a hypothetical description. No
// venue/moment/circle logic here by design; "match" names a type of
// activity/community/next-step, never a real business or place, since we
// have no real venue data to ground that (that's the separate venue-lookup
// mechanism in venueLookup.ts).
export type RecommendationResult =
  | { available: true; match: string; reason: string }
  | { available: false; reason: string };

const NOT_ENOUGH_DATA: RecommendationResult = {
  available: false,
  reason: "not enough concrete preference data on file yet",
};

// currentMessage is optional so the voice tool_call path (an ambient "check
// if you should recommend something" during a live call, not tied to one
// specific just-said line) is unaffected — it's the text path that needs
// it. Found the hard way: without it, this kept mining whatever preference
// dominated the accumulated intent history (climbing gyms, after many turns
// about them) even when the person had explicitly moved on to a different
// topic (dinner spots) — Co kept redirecting back to the stale topic
// instead of just answering what was actually asked.
export async function generateRecommendation(userId: string, currentMessage?: string): Promise<RecommendationResult> {
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

    // Tiered engine first (Tier 1 Co event → Tier 2 public event → Tier 3
    // real opportunity via X) — real, grounded, never invented. Only falls
    // through to the old generic LLM-category behavior below if all three
    // tiers come back empty, same "something is better than silence" logic
    // this function always had, just no longer the FIRST thing tried.
    const askText = currentMessage || latestIntent?.text || profile.goals?.[0];
    if (askText) {
      const tierMatches: TierMatch[] = await getTieredRecommendation(
        { text: askText, embedding: askText === latestIntent?.text ? latestIntent?.embedding : null },
        profile.city ?? null,
      ).catch((err: any) => {
        console.error("generateRecommendation: getTieredRecommendation failed (non-fatal):", err?.message ?? err);
        return [];
      });
      if (tierMatches.length) {
        // No winner here either (Royce, 2026-08-30 — see tieredRecommendation.ts)
        // — this is a live, in-conversation reply, not an unprompted text, so
        // bundling every real match into one description carries none of the
        // proactive-nudge spam risk the tease/reveal flow has to guard against.
        const result: RecommendationResult = {
          available: true,
          match: tierMatches.map((m) => `${m.name} (${m.url ?? "Co's own calendar"})`).join("; "),
          reason: tierMatches.map((m) => m.reason).join(" "),
        };
        await pool
          .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation', $2)`, [
            userId,
            `Co surfaced ${tierMatches.length} tiered recommendation(s) — ${tierMatches.map((m) => `[Tier ${m.kind}] ${m.name}: ${m.reason}`).join(" | ")}`,
          ])
          .catch((err) => console.error("Recommendation memory write failed (non-fatal):", err));

        // Royce, 2026-08-30: Tier 1/2 matches carry a real event_api_id —
        // record it so another person getting surfaced this exact same
        // event later is caught as a certain match. Tier 3 "opportunities"
        // have no event_api_id (not a shared event), skipped naturally.
        const eventMatches = tierMatches.filter((m): m is Extract<TierMatch, { event_api_id: string }> => "event_api_id" in m);
        if (eventMatches.length) {
          const { recordSurfacedEventAndMatch } = await import("./eventMatching.js");
          await Promise.all(
            eventMatches.map((m) =>
              recordSurfacedEventAndMatch(userId, m.event_api_id, m.name, m.event_date).catch((err: any) =>
                console.error("recordSurfacedEventAndMatch failed (non-fatal):", err?.message ?? err),
              ),
            ),
          );
        }
        return result;
      }
    }

    const { text: raw } = await propagateAttributes(
      { userId, traceName: "co.recommendation.generate" },
      () =>
        generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          experimental_telemetry: { isEnabled: true, functionId: "co.recommendation.generate" },
          prompt: `Here is everything actually known about this person, captured from real conversations:
${knownData}
${currentMessage ? `\nWhat they just said, right now: "${currentMessage}"\n\nOnly recommend something if it's actually relevant to what they JUST said — not just relevant to their history in general. If they've moved on to a different topic than what the data above centers on, say there isn't enough to go on for THIS message rather than redirecting back to an old topic.` : ""}

Based ONLY on this, name ONE concrete recommendation — a type of activity, group, or community, not a specific real business or venue (we have no real venue data, never invent one). Ground it in something they actually said. If nothing here is specific enough to recommend anything real, say so.

Return ONLY valid JSON, no preamble or markdown:
{"available": true, "match": "a consistent hiking or running group", "reason": "one sentence, grounded only in the data above"}
or
{"available": false, "reason": "why there isn't enough to go on"}`,
        }),
    );

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
