import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { writeMemory } from "./memory.js";
import { MODELS } from "../models.js";
import { sealedTelemetry } from "./privateTurn.js";

// The recap decides what's stale and what to drop from Co's running picture
// of someone, so it's a judgment call: Sonnet 5 (Royce's model policy).
const RECAP_MODEL = MODELS.sonnet;

// Memory compaction (Royce, 2026-09-01: "go ahead and have that built") —
// Co's own suggestion, made live while diagnosing a real memory-continuity
// gap with Royce: "Build a compaction layer that periodically distills and
// corrects the profile, weighted toward recent signal." Separate from (and
// complementary to) the callContext.ts fix earlier the same day — that fix
// stopped a stale truncation limit from discarding recent raw history;
// this is the actual "distill and correct" half Co asked for, so the
// picture stays coherent even once raw history grows past what any
// reasonable context window should carry in full every time.
//
// 'recap' has been a defined co_memories memory_type since early in this
// project (see migrations.ts's CHECK constraint and types/index.d.ts) but
// was never actually written anywhere — this is what finally uses it.
//
// REVISES the previous recap rather than re-summarizing from scratch each
// time (the actual "corrects," not just "distills," part of the ask) — the
// model is handed its own last recap plus what's happened since, and told
// to drop or correct anything now stale rather than let the summary only
// ever grow. Grounded strictly in what was actually said, same "never
// invent" discipline as every other synthesis step in this codebase.
export async function buildRecap(userId: string): Promise<void> {
  const [profileResult, lastRecapResult] = await Promise.all([
    pool.query(
      `SELECT life_chapters, goals, blockers, long_term_direction, city, emotional_state
       FROM co_profiles WHERE user_id = $1`,
      [userId],
    ),
    pool.query(
      `SELECT content, created_at FROM co_memories
       WHERE user_id = $1 AND memory_type = 'recap'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
  ]);
  const profile = profileResult.rows[0] ?? null;
  const lastRecap = lastRecapResult.rows[0] ?? null;

  const { rows: newExchanges } = await pool.query(
    `SELECT content FROM co_memories
     WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript')
       AND content NOT LIKE 'Co initiated call%'
       AND created_at > $2
     ORDER BY created_at ASC`,
    [userId, lastRecap?.created_at ?? new Date(0)],
  );
  // Nothing genuinely new since the last recap — re-running would just
  // reproduce the same summary at real LLM cost for no benefit.
  if (!newExchanges.length) return;

  const profileLines = [
    profile?.life_chapters?.length ? `Life chapter: ${profile.life_chapters.join(", ")}` : null,
    profile?.city ? `City: ${profile.city}` : null,
    profile?.goals?.length ? `Current goals: ${profile.goals.join("; ")}` : null,
    profile?.blockers?.length ? `Current blockers: ${profile.blockers.join("; ")}` : null,
    profile?.long_term_direction ? `Long-term direction: ${profile.long_term_direction}` : null,
    profile?.emotional_state ? `Last known emotional state: ${profile.emotional_state}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { text: raw } = await generateText({
      model: anthropic(RECAP_MODEL),
      experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "memoryCompaction.buildRecap" },
      prompt: `You maintain Co's running understanding of one specific person, across many conversations over time.

${lastRecap ? `Your previous recap of them:\n${lastRecap.content}` : "You have no previous recap of them yet — this is the first one."}

Their current structured profile fields (separately maintained, always up to date):
${profileLines || "(nothing on file yet)"}

New raw exchanges since your last recap, in order:
${newExchanges.map((e: any) => e.content).join("\n")}

Write an UPDATED recap: a compact, accurate running narrative of who this person is and what's actually going on with them, weighted toward what's recent. If something from your previous recap is now stale, resolved, or contradicted by what's happened since, drop or correct it — don't just append to a list that only ever grows. Ground every claim strictly in what's actually in the profile fields or was actually said in the exchanges above; never invent or assume a detail that isn't there. When something newer contradicts something older (their company stage, city, team, what they're looking for), the newer one wins and the older one goes. This is only about them: never record how Co performed, Co's mistakes, trust in Co, or complaints about Co. Write it as prose, not a bulleted list. 4-8 sentences.

Return ONLY the recap text, nothing else — no preamble, no labels.`,
    });
    const recap = raw.trim();
    if (!recap) return;

    await writeMemory(userId, "recap", recap);
    // Upsert, not update: a member with no profile row yet still gets their
    // recap recorded (storeProfile and captureIntent both upsert this row too).
    await pool.query(
      `INSERT INTO co_profiles (user_id, last_recap_at, updated_at) VALUES ($1, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_recap_at = NOW()`,
      [userId],
    );
    // Open threads they've gone quiet on become "waiting" here; only their
    // own words ever close one (harness/memberThreads.ts).
    const { markQuietThreadsWaiting } = await import("../harness/memberThreads.js");
    await markQuietThreadsWaiting(userId);
  } catch (err: any) {
    console.error(`memoryCompaction: buildRecap failed for ${userId} (non-fatal):`, err?.message ?? err);
  }
}

// Cadence gate for the cron (jobs/index.ts) — 3 days, same cadence pattern
// used elsewhere in this codebase for periodic-but-not-urgent per-user
// work (event surfacing, ask check-ins). Only users with genuine new
// activity since their last recap are eligible, so an inactive user's
// cadence timer effectively never fires — no point re-summarizing someone
// who hasn't said anything new.
// Every member who has talked to Co, not only those with a profile row
// (2026-09-22): the row is only created once a call is extracted or an ask
// is captured, so a member who stopped after giving their name and email
// had none, never got a recap, and so never got a companion check-in either.
export async function findUsersDueForRecap(): Promise<string[]> {
  const { rows } = await pool.query(`
    SELECT u.id AS user_id
    FROM users u
    LEFT JOIN co_profiles cp ON cp.user_id = u.id
    WHERE u.identity_captured = true
      AND u.archived_at IS NULL
      AND (cp.last_recap_at IS NULL OR cp.last_recap_at <= NOW() - INTERVAL '3 days')
      AND EXISTS (
        SELECT 1 FROM co_memories m
        WHERE m.user_id = u.id
          AND m.memory_type IN ('text_exchange', 'call_transcript')
          AND m.content NOT LIKE 'Co initiated call%'
          AND m.created_at > COALESCE(cp.last_recap_at, '-infinity'::timestamptz)
      )
  `);
  return rows.map((r: any) => r.user_id);
}
