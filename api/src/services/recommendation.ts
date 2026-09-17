import { generateText } from "ai";
import { getPersonSnapshot, profileFocusText } from "../harness/personSnapshot.js";
import { rewriteKeepsAsk } from "./searchRules.js";
import { isBrowseAsk } from "./askWindow.js";
import { getTimezoneForCity } from "./geocoding.js";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import { getTieredRecommendation, type SearchScope, type TierMatch } from "./tieredRecommendation.js";
import { generateEmbedding } from "./embeddings.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { getEmotionalContext, renderEmotionalContext } from "../harness/emotion.js";

// Model policy (Royce, 2026-09-14): Haiku for the narrow message-to-search
// rewrite. (The Sonnet generic-suggestion fallback was removed 2026-09-16.)
const REWRITE_MODEL = MODELS.haiku;

// Intent-Layer-only real action: Co can actually invoke this (voice via
// Hume's tool_call plane, iMessage via a direct call from the ongoing-chat
// handler) and get back something concrete, grounded in what's actually
// stored for that specific person — not a hypothetical description. No
// venue/moment/circle logic here by design; "match" names a type of
// activity/community/next-step, never a real business or place, since we
// have no real venue data to ground that (venue lookup was removed
// 2026-09-16 — tiers 1-3 are the whole search).
// A result is available only when the tiered engine found real
// events/opportunities, each with its own url; otherwise it says why not.
// Royce, 2026-09-02: "the format should just be the link when it just
// shows the preview then a description... we should be able to identify
// which tier is what" — the old flattened match/reason strings gave
// sendblue.ts nothing to format with; the caller needs the real structure
// to present each one as its own distinct, link-previewable block instead
// of one clumped paragraph.
export type RecommendationResult =
  | { available: true; match: string; reason: string; matches?: TierMatch[]; scope?: SearchScope | null }
  | { available: false; reason: string; scope?: SearchScope | null; alreadyRecommended?: TierMatch[] };

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

If yes, rewrite it as one standalone sentence describing what to look for. Only drop filler. Keep their topic, place, and time frame in their own words. Never add details they didn't say, including anything Co suggested earlier in the conversation.${feeling ? ` How they've been feeling, which can shape the format or size (smaller and lower-key when they're drained, community over networking when they're isolated) but never the topic they asked for:\n${feeling}\n` : ""} If they named a topic, use only their words for it and add nothing from their overall goal ("founder meetups" stays "founder meetups"). Only borrow the topic from what they're looking for overall when the message gives none (like "what's going on this weekend"). Return ONLY valid JSON: {"request": "..."} or {"request": null}.`,
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
  // this returns so the decision record shows it even when nothing real was
  // found (2026-09-16).
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

    // Tiered engine first (Tier 1 Co event → Tier 2 public event → Tier 3
    // real opportunity via X) — real, grounded, never invented. If all
    // three come back empty, that's the answer: no generic suggestion.
    // The raw text message is not a search request ("Any details?" and
    // "where's the link?" were being searched as-is). Turn it into one, or
    // stop if it isn't asking for something new.
    let askText = latestIntent?.text || profile.goals?.[0];
    let rewrite: { original: string; rewritten: string; used: string; rejectedBecause: string | null } | null = null;
    if (currentMessage) {
      const request = await toSearchRequest(userId, currentMessage, latestIntent?.text ?? null);
      if (request === null) return { available: false, reason: "their message isn't asking for something new to try" };
      // The rewrite may only drop filler. If it changed their topic, place or
      // time frame, or added words, search their own message instead
      // (services/searchRules.ts).
      const check = rewriteKeepsAsk(currentMessage, request);
      askText = check.ok ? request : currentMessage;
      rewrite = { original: currentMessage, rewritten: request, used: askText, rejectedBecause: check.reason };
    }
    if (askText) {
      // The scope comes back with this search's own matches (2026-09-17: it
      // was read from module state after another await, so two people
      // searching at once could get each other's record).
      const tiered = await getTieredRecommendation(
        { text: askText, embedding: askText === latestIntent?.text ? latestIntent?.embedding : null },
        profile.city ?? null,
        // Repeats are handled below so the reply can say it was already shared.
        {
          userId,
          checkRepeat: false,
          rawMessage: currentMessage,
          // No city or zone on file: getTieredRecommendation uses Co's home
          // zone and records that it did (scope.timezoneDefaulted).
          timezone: profile.city ? await getTimezoneForCity(profile.city).catch(() => null) : null,
          // What Co knows they want right now orders what matches the ask.
          profile: profileFocusText(await getPersonSnapshot(userId).catch(() => null)) || null,
        },
      ).catch((err: any) => {
        console.error("generateRecommendation: getTieredRecommendation failed (non-fatal):", err?.message ?? err);
        return null;
      });
      const found: TierMatch[] = tiered?.matches ?? [];
      scopeForTurn = tiered?.scope ?? null;
      if (scopeForTurn && rewrite) scopeForTurn.rewrite = rewrite;
      const scope = scopeForTurn;
      // A time frame past how far Co searches: say that, rather than answering
      // with the default window's events (2026-09-17).
      if (scope?.windowOutOfRange) {
        return { available: false, reason: `they asked about ${scope.windowOutOfRange.reason}; nothing searched`, scope };
      }
      const tierMatches = await dropAlreadyRecommended(userId, found);
      // "What's on this weekend?" is a question about the calendar. If
      // nothing's on it in that window, the honest answer is nothing, not a
      // generic "look for startup meetups" suggestion (2026-09-16).
      // Real events were found and the gate turned every one away (sold out,
      // already sent, too far): that's the answer, not a generic idea.
      if (!tierMatches.length && scope?.gatedOut?.length) {
        const why = scope.gatedOut.map((g) => `"${g.name}"${g.date ? ` on ${g.date}` : ""}${g.url ? `, link ${g.url}` : ""} (${g.reasons.join(", ")})`).join("; ");
        return { available: false, reason: `found real ones but couldn't offer them: ${why}`, scope };
      }
      if (!tierMatches.length && currentMessage && isBrowseAsk(currentMessage)) {
        return { available: false, reason: `nothing real on the calendar${scope?.window ? ` for ${scope.window}` : ""}`, scope };
      }
      if (found.length && !tierMatches.length) {
        // Named, not just noted in a reason string (2026-09-17 code
        // review): the only real match for a specific-date ask was
        // something already sent hours earlier, and the reply just said
        // "nothing found" instead of reminding them what it already told
        // them — the honest, useful answer to "anything worth my time
        // then?" is "yeah, the thing I already mentioned."
        return { available: false, reason: `already recommended ${found.map((m) => m.name).join(", ")} recently`, scope, alreadyRecommended: found };
      }
      if (tierMatches.length) {
        // Nothing is recorded as offered here (2026-09-17): the caller sends
        // only some of these, sometimes none (the search can finish after the
        // reply timed out), and recording all of them hid unsent events for
        // 30 days and let grounding treat them as sent. The caller calls
        // recordRecommendationsSent with what actually went out.
        // No winner here either (Royce, 2026-08-30 — see tieredRecommendation.ts)
        // — this is a live, in-conversation reply, not an unprompted text, so
        // bundling every real match into one description carries none of the
        // proactive-nudge spam risk the tease/reveal flow has to guard against.
        return {
          available: true,
          match: tierMatches.map((m) => `${m.name} (${m.url ?? "Co's own calendar"})`).join("; "),
          reason: tierMatches.map((m) => m.reason).join(" "),
          matches: tierMatches,
          scope,
        };
      }
    }

    // No generic "type of thing" fallback (Royce, 2026-09-16: "drop the
    // fallback"). When the search finds nothing real, the answer is that it
    // found nothing. The old fallback ("a weekend founder/builder meetup at a
    // casual cafe") read like a real find, the person asked Co to find it,
    // and that made-up description then narrowed their next real search.
    // Nothing to offer, but name the nearest real thing when there is one.
    const closest = scopeForTurn?.closest;
    const nearMiss = closest ? `; the closest real one was "${closest.name}"${closest.date ? ` on ${closest.date}` : ""}${closest.url ? `, link ${closest.url}` : ""} (${closest.why})` : "";
    return { available: false, reason: `searched and found nothing real that fits yet${nearMiss}`, scope: scopeForTurn };
  } catch (err: any) {
    console.error("generateRecommendation failed (non-fatal):", err?.message ?? err);
    return { available: false, reason: "lookup failed" };
  }
}

// What generateRecommendation used to write for every match it found, now
// written only for the ones actually sent (2026-09-17). Call it after the
// send succeeds, with exactly the matches that went out:
//   recommendation_offered  so the same thing isn't offered again for 30 days
//                           (dropAlreadyRecommended) and the gate's repeat check
//   recommendation memory   "Co surfaced ...", which grounding reads as sent
//   surfaced_events         Tier 1/2 only, so another person getting the same
//                           event is caught as a certain match (eventMatching.ts)
export async function recordRecommendationsSent(userId: string, matches: TierMatch[]): Promise<void> {
  if (!matches.length) return;
  await pool
    .query(
      `INSERT INTO co_memories (user_id, memory_type, content)
       SELECT $1, 'recommendation_offered', x FROM UNNEST($2::text[]) AS x`,
      [userId, matches.map((m) => JSON.stringify({ name: m.name, event_api_id: "event_api_id" in m ? m.event_api_id : null }))],
    )
    .catch((err: any) => console.error("recordRecommendationsSent: recommendation_offered write failed (non-fatal):", err?.message ?? err));

  const tieredContent = `Co surfaced ${matches.length} tiered recommendation(s) — ${matches.map((m) => `[Tier ${m.kind}] ${m.name}: ${m.reason}`).join(" | ")}`;
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation', $2) RETURNING id`, [userId, tieredContent])
    .then((mem) =>
      generateEmbedding(tieredContent)
        .then((emb) => pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [`[${emb.join(",")}]`, mem.rows[0].id]))
        .catch((err) => console.error("Recommendation memory embedding failed (non-fatal):", err)),
    )
    .catch((err) => console.error("Recommendation memory write failed (non-fatal):", err));

  // Royce, 2026-08-30: Tier 1/2 matches carry a real event_api_id — record it
  // so another person getting surfaced this exact same event later is caught
  // as a certain match. Tier 3 "opportunities" have no event_api_id (not a
  // shared event), skipped naturally.
  const eventMatches = matches.filter((m): m is Extract<TierMatch, { event_api_id: string }> => "event_api_id" in m);
  if (eventMatches.length) {
    const { recordSurfacedEventAndMatch } = await import("./eventMatching.js");
    await Promise.all(
      eventMatches.map((m) =>
        recordSurfacedEventAndMatch(userId, m.event_api_id, m.name, m.event_date, m.details?.startAt ?? null, m.details?.endAt ?? null).catch((err: any) =>
          console.error("recordSurfacedEventAndMatch failed (non-fatal):", err?.message ?? err),
        ),
      ),
    );
  }
}
