import { generateText } from "ai";
import { DateTime } from "luxon";
import { isBrowseAsk, parseAskWindow } from "./askWindow.js";
import { getTimezoneForCity } from "./geocoding.js";
import { anthropic } from "@ai-sdk/anthropic";
import { propagateAttributes } from "@langfuse/tracing";
import pool from "../db/db.js";
import { getTieredRecommendation, takeLastSearchScope, type SearchScope, type TierMatch } from "./tieredRecommendation.js";
import { generateEmbedding } from "./embeddings.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { getEmotionalContext, renderEmotionalContext } from "../harness/emotion.js";

// Model policy (Royce, 2026-09-14): Haiku for the narrow message-to-search
// rewrite; Sonnet 5 for the fallback suggestion, which nothing re-checks.
const REWRITE_MODEL = MODELS.haiku;
const SUGGEST_MODEL = MODELS.sonnet;

// Intent-Layer-only real action: Co can actually invoke this (voice via
// Hume's tool_call plane, iMessage via a direct call from the ongoing-chat
// handler) and get back something concrete, grounded in what's actually
// stored for that specific person — not a hypothetical description. No
// venue/moment/circle logic here by design; "match" names a type of
// activity/community/next-step, never a real business or place, since we
// have no real venue data to ground that (venue lookup was removed
// 2026-09-16 — tiers 1-3 are the whole search).
// matches is only present when this came from the tiered engine (real
// events/opportunities, each with its own url) — the generic LLM-guessed
// fallback below has no matches array since it never has a real link.
// Royce, 2026-09-02: "the format should just be the link when it just
// shows the preview then a description... we should be able to identify
// which tier is what" — the old flattened match/reason strings gave
// sendblue.ts nothing to format with; the caller needs the real structure
// to present each one as its own distinct, link-previewable block instead
// of one clumped paragraph.
export type RecommendationResult =
  | { available: true; match: string; reason: string; matches?: TierMatch[]; scope?: SearchScope | null }
  | { available: false; reason: string; scope?: SearchScope | null };

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
const RECOMMENDATION_REPEAT_DAYS = 30;

// Same event or opportunity recommended in conversation within the last
// RECOMMENDATION_REPEAT_DAYS isn't offered again as if it were new.
async function dropAlreadyRecommended(userId: string, matches: TierMatch[]): Promise<TierMatch[]> {
  if (!matches.length) return matches;
  const { rows } = await pool
    .query(
      `SELECT content FROM co_memories
       WHERE user_id = $1 AND memory_type = 'recommendation_offered'
         AND created_at > NOW() - ($2 || ' days')::interval`,
      [userId, RECOMMENDATION_REPEAT_DAYS],
    )
    .catch(() => ({ rows: [] as { content: string }[] }));
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const r of rows) {
    try {
      const c = JSON.parse(r.content);
      if (c.event_api_id) seenIds.add(c.event_api_id);
      if (c.name) seenNames.add(String(c.name).toLowerCase());
    } catch {}
  }
  return matches.filter(
    (m) => !("event_api_id" in m && seenIds.has(m.event_api_id)) && !seenNames.has(m.name.toLowerCase()),
  );
}

// Returns a standalone description of what to look for, or null when the
// message isn't asking for a new thing (a follow-up question, scheduling,
// thanks). Fails open to the raw message so an outage doesn't block recs.
async function toSearchRequest(userId: string, message: string, statedAsk: string | null): Promise<string | null> {
  try {
    const feeling = renderEmotionalContext(await getEmotionalContext(userId));
    const { text: raw } = await generateText({
      model: anthropic(REWRITE_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "co.recommendation.toSearchRequest", metadata: { userId } },
      prompt: `Someone texted: "${message}"${statedAsk ? `\nWhat they've told Co they're looking for overall: "${statedAsk}"` : ""}

Is this message asking Co to find or suggest something new for them (an event, a group, a program, something to do)? Saying they want to find something counts ("I'd love to find a pickup basketball group"). These are NOT: follow-up questions about something already mentioned ("any details?", "where's the link?", "what time?"), asking for help planning or organizing something ("can you help me plan?"), scheduling, and thanks. If it's unclear, treat it as a request.

If yes, rewrite it as one standalone sentence describing what to look for, keeping the place, timing, and topic they gave.${feeling ? ` How they've been feeling, which can shape the format or size (smaller and lower-key when they're drained, community over networking when they're isolated) but never the topic they asked for:\n${feeling}\n` : ""} If they named a topic, use only their words for it and add nothing from their overall goal ("founder meetups" stays "founder meetups"). Only borrow the topic from what they're looking for overall when the message gives none (like "what's going on this weekend"). Return ONLY valid JSON: {"request": "..."} or {"request": null}.`,
    });
    const parsed = parseModelJson(raw);
    if (parsed && "request" in parsed) return typeof parsed.request === "string" && parsed.request.trim() ? parsed.request.trim() : null;
    return message;
  } catch (err: any) {
    console.error("generateRecommendation: toSearchRequest failed (non-fatal, using raw message):", err?.message ?? err);
    return message;
  }
}

export async function generateRecommendation(userId: string, currentMessage?: string): Promise<RecommendationResult> {
  // What the tiered search actually covered this turn, attached to whatever
  // this returns so the decision record shows it even when the answer is a
  // generic idea rather than a real match (2026-09-16).
  let scopeForTurn: SearchScope | null = null;
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
    // The raw text message is not a search request ("Any details?" and
    // "where's the link?" were being searched as-is). Turn it into one, or
    // stop if it isn't asking for something new.
    let askText = latestIntent?.text || profile.goals?.[0];
    if (currentMessage) {
      const request = await toSearchRequest(userId, currentMessage, latestIntent?.text ?? null);
      if (request === null) return { available: false, reason: "their message isn't asking for something new to try" };
      askText = request;
    }
    if (askText) {
      const found: TierMatch[] = await getTieredRecommendation(
        { text: askText, embedding: askText === latestIntent?.text ? latestIntent?.embedding : null },
        profile.city ?? null,
        // Repeats are handled below so the reply can say it was already shared.
        { userId, checkRepeat: false, rawMessage: currentMessage, timezone: profile.city ? await getTimezoneForCity(profile.city).catch(() => null) : null },
      ).catch((err: any) => {
        console.error("generateRecommendation: getTieredRecommendation failed (non-fatal):", err?.message ?? err);
        return [];
      });
      const tierMatches = await dropAlreadyRecommended(userId, found);
      scopeForTurn = takeLastSearchScope();
      const scope = scopeForTurn;
      // "What's on this weekend?" is a question about the calendar. If
      // nothing's on it in that window, the honest answer is nothing, not a
      // generic "look for startup meetups" suggestion (2026-09-16).
      // Real events were found and the gate turned every one away (sold out,
      // already sent, too far): that's the answer, not a generic idea.
      if (!tierMatches.length && scope?.gatedOut?.length) {
        const why = scope.gatedOut.map((g) => `"${g.name}" (${g.reasons.join(", ")})`).join("; ");
        return { available: false, reason: `found real ones but couldn't offer them: ${why}`, scope };
      }
      if (!tierMatches.length && currentMessage && isBrowseAsk(currentMessage)) {
        const window = parseAskWindow(currentMessage, DateTime.now());
        return { available: false, reason: `nothing real on the calendar${window ? ` for ${window.label}` : ""}`, scope };
      }
      if (found.length && !tierMatches.length) {
        return { available: false, reason: `already recommended ${found.map((m) => m.name).join(", ")} recently` };
      }
      if (tierMatches.length) {
        await pool
          .query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             SELECT $1, 'recommendation_offered', x FROM UNNEST($2::text[]) AS x`,
            [userId, tierMatches.map((m) => JSON.stringify({ name: m.name, event_api_id: "event_api_id" in m ? m.event_api_id : null }))],
          )
          .catch((err: any) => console.error("generateRecommendation: recommendation_offered write failed (non-fatal):", err?.message ?? err));
        // No winner here either (Royce, 2026-08-30 — see tieredRecommendation.ts)
        // — this is a live, in-conversation reply, not an unprompted text, so
        // bundling every real match into one description carries none of the
        // proactive-nudge spam risk the tease/reveal flow has to guard against.
        const result: RecommendationResult = {
          available: true,
          match: tierMatches.map((m) => `${m.name} (${m.url ?? "Co's own calendar"})`).join("; "),
          reason: tierMatches.map((m) => m.reason).join(" "),
          matches: tierMatches,
          scope,
        };
        {
          const tieredContent = `Co surfaced ${tierMatches.length} tiered recommendation(s) — ${tierMatches.map((m) => `[Tier ${m.kind}] ${m.name}: ${m.reason}`).join(" | ")}`;
          await pool
            .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation', $2) RETURNING id`, [
              userId,
              tieredContent,
            ])
            .then((mem) =>
              generateEmbedding(tieredContent)
                .then((emb) =>
                  pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
                    `[${emb.join(",")}]`,
                    mem.rows[0].id,
                  ]),
                )
                .catch((err) => console.error("Recommendation memory embedding failed (non-fatal):", err)),
            )
            .catch((err) => console.error("Recommendation memory write failed (non-fatal):", err));
        }

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
          model: anthropic(SUGGEST_MODEL),
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

    const clean = raw.trim();
    let parsed: RecommendationResult | null = null;
    try {
      parsed = parseModelJson(clean);
    } catch {
      return NOT_ENOUGH_DATA;
    }
    if (!parsed || typeof parsed.available !== "boolean") return NOT_ENOUGH_DATA;
    if (!parsed.available) return { available: false, reason: parsed.reason || NOT_ENOUGH_DATA.reason };
    if (!("match" in parsed) || !parsed.match) return NOT_ENOUGH_DATA;

    const result: RecommendationResult = { available: true, match: parsed.match, reason: parsed.reason ?? "", scope: scopeForTurn };

    {
      const fallbackContent = `Co surfaced a recommendation — ${result.match}: ${result.reason}`;
      await pool
        .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation', $2) RETURNING id`, [
          userId,
          fallbackContent,
        ])
        .then((mem) =>
          generateEmbedding(fallbackContent)
            .then((emb) =>
              pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
                `[${emb.join(",")}]`,
                mem.rows[0].id,
              ]),
            )
            .catch((err) => console.error("Recommendation memory embedding failed (non-fatal):", err)),
        )
        .catch((err) => console.error("Recommendation memory write failed (non-fatal):", err));
    }

    return result;
  } catch (err: any) {
    console.error("generateRecommendation failed (non-fatal):", err?.message ?? err);
    return { available: false, reason: "lookup failed" };
  }
}
