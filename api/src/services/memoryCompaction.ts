import pool from "../db/db.js";
import { writeMemory } from "./memory.js";


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
  const lastRecapResult = await pool.query(`SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'recap' ORDER BY created_at DESC LIMIT 1`, [userId]);
  const lastRecap = lastRecapResult.rows[0] ?? null;
  try {
    // The recap is a rendering of the member's LIVE claims (services/claims.ts), not a model's revision of its own last recap:
    // each claim says whether they said it or Co inferred it, and an ephemeral one (a plan, a deadline, a mood, a worry)
    // expires on its own unless they say it again. A claim that has gone is simply not in the next recap.
    const { refreshClaims, renderRecap } = await import("./claims.js");
    const live = await refreshClaims(userId);
    const recap = renderRecap(live, new Date());
    if (recap && recap !== lastRecap?.content) await writeMemory(userId, "recap", recap);
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

// Daily, with no model call: a claim that has reached the end of its lifetime leaves the recap even when the member has said
// nothing new. (The old recap only changed when there was new talk, so a stale plan stayed in it for as long as they were quiet.)
export async function expireRecaps(now = new Date()): Promise<number> {
  const { heldClaims, renderRecap } = await import("./claims.js");
  const { rows } = await pool.query(`SELECT DISTINCT user_id FROM co_memories WHERE memory_type = 'recap' AND created_at > NOW() - INTERVAL '30 days'`);
  let changed = 0;
  for (const r of rows) {
    const claims = await heldClaims(r.user_id);
    if (!claims.length) continue;
    const recap = renderRecap(claims, now);
    const { rows: last } = await pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'recap' ORDER BY created_at DESC LIMIT 1`, [r.user_id]);
    if (recap && recap !== last[0]?.content) { await writeMemory(r.user_id, "recap", recap); changed++; }
  }
  return changed;
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
