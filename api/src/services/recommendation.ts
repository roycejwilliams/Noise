import { recordRevealedOffers } from "./offerReactions.js";
import { matchKey } from "./eventSurfacingSweep.js";
import pool from "../db/db.js";
import type { TierMatch } from "./tieredRecommendation.js";
import { generateEmbedding } from "./embeddings.js";

// Recording what Co sent (2026-09-17): only the ones actually sent. The search
// that used to live here (generateRecommendation) was removed 2026-10-01; Co
// finds things in its own loop (agent/loop.ts). Call it after the
// send succeeds, with exactly the matches that went out:
//   recommendation_offered  so the same thing isn't offered again for 30 days
//                           (dropAlreadyRecommended) and the gate's repeat check
//   recommendation memory   "Co surfaced ...", which grounding reads as sent
//   surfaced_events         Tier 1/2 only, so another person getting the same
//                           event is caught as a certain match (eventMatching.ts)
export async function recordRecommendationsSent(userId: string, matches: TierMatch[]): Promise<void> {
  if (!matches.length) return;
  // Sent in a reply: the same thing queued as an offer doesn't go out again.
  await pool
    .query(
      `UPDATE proactive_candidates SET status = 'skipped', skip_reason = 'sent in a reply', decided_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND type = 'event_offer' AND status = 'pending' AND target_key = ANY($2::text[])`,
      [userId, matches.flatMap((m) => [`event_offer:${matchKey(m)}`, `event_offer:again:${matchKey(m)}`])],
    )
    .catch((err: any) => console.error("recordRecommendationsSent: queued offer cleanup failed (non-fatal):", err?.message ?? err));
  // Waiting on their reaction for the next two days (services/offerReactions.ts).
  await recordRevealedOffers(userId, matches);
  // Co's record of what it sent (services/coFacts.ts).
  const { recordSentItems } = await import("./coFacts.js");
  const { itemDays } = await import("./dateGuard.js");
  await recordSentItems(
    userId,
    matches.map((m) => {
      const d = itemDays(m);
      return { name: m.name, url: "url" in m ? (m.url ?? null) : null, kind: m.kind ?? null, when: d.start, whenEnd: d.end };
    }),
    "recommendationsSent",
  );
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
