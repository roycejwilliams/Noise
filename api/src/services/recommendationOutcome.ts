import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import type { TierMatch } from "./tieredRecommendation.js";
import { writeMemory } from "./memory.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";

// Outcome-learning loop (Royce, 2026-09-02: "Co follows up" + the shared
// "named someone?" classifier + wiring signal weighting into future
// matching — Notion V1 board rows 7/12/13, confirmed fully unbuilt before
// this). Tier 1/2 only — a Tier 3 opportunity (accelerator, fellowship) has
// no attendees to "meet," so "who did you meet?" doesn't apply to it.
//
// Same due-timestamp + nullable claim column + partial index convention as
// post_call_follow_ups (jobs/postCallFollowUp.ts) — see migrations.ts's
// recommendation_outcome_followups table. The outcome itself is written as
// a co_memories row ('recommendation_outcome'), not a new table — that's
// exactly what co_memories already exists for (event_offer_pending/
// event_offer_resolved/recap all follow this same shape).
export async function scheduleOutcomeFollowUp(userId: string, askText: string, match: TierMatch): Promise<void> {
  if (!("event_date" in match) || !match.event_date) return; // Tier 3 has no event_date — nothing to schedule

  try {
    await pool.query(
      // One follow-up per recommended event, however many times it got
      // recommended (2026-09-14: the same event produced two follow-ups
      // sent 2 seconds apart).
      `INSERT INTO recommendation_outcome_followups (user_id, ask_text, tier, match_name, match, send_at)
       SELECT $1::uuid, $2::text, $3::int, $4::text, $5::jsonb, ($6::date + INTERVAL '1 day 11 hours')
       WHERE NOT EXISTS (
         SELECT 1 FROM recommendation_outcome_followups
         WHERE user_id = $1 AND (
           (match ->> 'event_api_id') = ($5::jsonb ->> 'event_api_id')
           OR lower(match_name) = lower($4)
         )
       )`,
      [userId, askText, match.tier, match.name, JSON.stringify(match), match.event_date],
    );
  } catch (err: any) {
    console.error("scheduleOutcomeFollowUp: insert failed (non-fatal):", err?.message ?? err);
  }
}

// Same expiry reasoning as sendblue.ts's EVENT_OFFER_EXPIRY_DAYS — a reply
// classifier shouldn't be trying to resolve a "who did you meet?" follow-up
// from weeks ago against unrelated later conversation.
const OUTCOME_FOLLOWUP_EXPIRY_DAYS = 7;

export type PendingOutcomeFollowUp = {
  id: string;
  tier: number;
  match_name: string;
  ask_text: string;
};

// Mirrors sendblue.ts's pendingEventOffer lookup shape exactly (same
// created_at-cutoff + NOT EXISTS resolved-row pattern), scoped to this
// feature's own table instead of co_memories.
export async function findPendingOutcomeFollowUp(userId: string): Promise<PendingOutcomeFollowUp | null> {
  const { rows } = await pool.query(
    `SELECT id, tier, match_name, ask_text FROM recommendation_outcome_followups
     WHERE user_id = $1 AND sent_at IS NOT NULL
       AND sent_at > NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM co_memories r
         WHERE r.user_id = $1 AND r.memory_type = 'recommendation_outcome'
           AND (r.content::jsonb ->> 'followupId') = recommendation_outcome_followups.id::text
       )
     ORDER BY sent_at DESC LIMIT 1`,
    [userId, OUTCOME_FOLLOWUP_EXPIRY_DAYS],
  );
  return rows[0] ?? null;
}

export type NamedOutcome = "named_positive" | "named_critical" | "not_mentioned" | "unrelated";

// One-shot classification, same pattern as sendblue.ts's eventOffer.classify
// (routes/sendblue.ts) — a single classification, not a multi-step decision,
// so this doesn't need the heavier agent/ tool-calling shape.
export async function classifyNamedOutcome(replyText: string, matchName: string, recentConversation?: string): Promise<NamedOutcome> {
  try {
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "recommendationOutcome.classify" },
      prompt: `Co previously texted this person asking how "${matchName}" went — specifically, who they met or talked to there. This does NOT mean every message from them now is answering that — if the recent conversation shows they're actually responding to something else that came up more recently (a different question, a different offer), that's normal conversation, not an answer to this older one.
${recentConversation ? `\nRecent conversation, in order:\n${recentConversation}\n` : ""}
Their reply: "${replyText}"

Classify as ONE of:
- "named_positive" — they name someone or something specific and it reads as a good/worthwhile connection or experience
- "named_critical" — a real negative assessment of the experience itself, whether or not they name a specific person (e.g. "nobody interesting there", "waste of time" both count — the negative signal matters even without a name)
- "not_mentioned" — a neutral or non-committal answer with no real positive or negative signal either way (e.g. "it was fine", "didn't end up going", "no one really")
- "unrelated" — this reply isn't actually answering the question at all — normal unrelated conversation, or clearly answering something else more recent in the thread instead

Return ONLY the classification, nothing else.`,
    });
    const cleaned = raw.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");
    if (cleaned === "named_positive" || cleaned === "named_critical" || cleaned === "not_mentioned" || cleaned === "unrelated") {
      return cleaned;
    }
    return "unrelated";
  } catch (err: any) {
    console.error("classifyNamedOutcome: generateText failed (non-fatal, treating as unrelated):", err?.message ?? err);
    return "unrelated";
  }
}

export async function recordOutcome(userId: string, followupId: string, tier: number, outcome: NamedOutcome): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation_outcome', $2)`, [
      userId,
      JSON.stringify({ followupId, tier, outcome }),
    ])
    .catch((err: any) => console.error("recordOutcome: memory write failed (non-fatal):", err?.message ?? err));
}

// Tier-weighting loop-back (Notion board row 12, "wire signal weighting into
// the standing profile") — TierMatch carries no per-person identity (see
// this session's research), so "reinforce/deprioritize" is scoped to which
// TIER tends to land for this person, matching the diamond's own "not
// mentioned -> adjusts tier weighting" language. Net positive-minus-critical
// per tier; a user with no history gets all zeros, which keeps
// eventSurfacingSweep.ts's sort behaving exactly as it does today (tier-
// number order) until real signal exists.
export async function getTierBias(userId: string): Promise<Record<number, number>> {
  const bias: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  try {
    const { rows } = await pool.query(
      `SELECT content::jsonb ->> 'tier' AS tier, content::jsonb ->> 'outcome' AS outcome
       FROM co_memories WHERE user_id = $1 AND memory_type = 'recommendation_outcome'`,
      [userId],
    );
    for (const row of rows) {
      const tier = Number(row.tier);
      if (!(tier in bias)) continue;
      if (row.outcome === "named_positive") bias[tier] += 1;
      else if (row.outcome === "named_critical") bias[tier] -= 1;
    }
  } catch (err: any) {
    console.error("getTierBias: query failed (non-fatal, no bias applied):", err?.message ?? err);
  }
  return bias;
}

// Cron-callable — mirrors jobs/postCallFollowUp.ts's sendDueFollowUps()
// exactly: poll due rows, claim atomically so overlapping ticks can't
// double-send, generate fresh text at send time. Leaked-meta-commentary
// guard lives in services/sendblue.ts (moved there 2026-09-03) so every
// send gets it, not just this one.
export async function sendDueOutcomeFollowUps(): Promise<void> {
  const due = await pool.query(
    `SELECT rof.id, rof.user_id, rof.ask_text, rof.match_name, u.phone_number, u.first_name
     FROM recommendation_outcome_followups rof
     JOIN users u ON u.id = rof.user_id
     WHERE rof.send_at <= NOW() AND rof.sent_at IS NULL AND u.sms_opted_out = false
     LIMIT 20`,
  );

  for (const row of due.rows) {
    const claim = await pool.query(
      `UPDATE recommendation_outcome_followups SET sent_at = NOW() WHERE id = $1 AND sent_at IS NULL RETURNING id`,
      [row.id],
    );
    if (!claim.rows[0]) continue;

    try {
      const { text: draft } = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        experimental_telemetry: { isEnabled: true, functionId: "recommendationOutcome.followUp" },
        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${row.first_name}. A little while back you told them about "${row.match_name}" (it was for: "${row.ask_text}"). Enough time has passed that it should have happened by now.

Draft a short, warm, genuinely curious message asking how it went — who they met or talked to, or what stood out. 1-2 sentences, no exclamation points, no em dashes, normal sentence capitalization. This is a friend checking in, not a survey.

Return ONLY the message text.`,
      });
      const trimmed = draft.trim();
      const cleaned = cleanCoMessage(trimmed);
      await sendblue.messages.send({
        number: row.phone_number,
        content: cleaned,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
      // Royce, 2026-09-08 sweep — this send had zero logging of any kind,
      // so recentConversation had no record of Co's own question. Matters
      // more here than most: the reply to THIS message is what drives
      // classifyNamedOutcome downstream.
      await writeMemory(row.user_id, "text_exchange", `Co replied: ${cleaned}`).catch((err: any) =>
        console.error(`sendDueOutcomeFollowUps: text_exchange log failed for ${row.id} (non-fatal):`, err?.message ?? err),
      );
    } catch (err: any) {
      console.error(`sendDueOutcomeFollowUps: send failed for ${row.id} (non-fatal, already claimed — will not retry):`, err?.message ?? err);
    }
  }
}
