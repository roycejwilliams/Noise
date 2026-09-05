import pool from "../db/db.js";

// Builds a compact summary of everything already known about a person —
// from a prior call's extracted profile/intent AND recent text exchanges —
// so a new call's opening can pick up from it instead of a cold generic
// greeting every time, regardless of which channel the prior context came
// from.
//
// Bug fix, 2026-09-01 (Royce, diagnosing a real memory-continuity gap live
// with Co: "earlier parts of what you told me didn't come through
// cleanly"): this used to hard-truncate to 600 characters and pull only the
// last 6 raw text_exchange rows (3 conversational turns), justified by a
// comment claiming the result "gets passed as a URL query param on the
// Twilio bridge connect URL." That mechanism doesn't exist anywhere in the
// current code — every actual caller (mediaStreamBridge.ts's Hume
// sessionSettings.variables, postCallFollowUp.ts and sendblue.ts's LLM
// prompt interpolation) treats this as plain in-process text with no URL
// involved. The cap was real, it just wasn't protecting anything anymore —
// it was silently discarding real context on every call and every text
// reply, which is exactly the gap Co and Royce were diagnosing. Raised to a
// generous bound (still a bound, not unlimited — a defensive sanity check
// against a genuinely pathological profile, not a real constraint anyone
// should ever hit) and 20 rows (10 turns) of raw history instead of 3.
// recap (Royce, 2026-09-01: "go ahead and have that built") — the
// distilled, corrected running narrative services/memoryCompaction.ts
// maintains. Led with here since it's the durable, weighted-toward-recent
// picture; the raw recent-text line below still carries this-week's exact
// specifics the recap's own cadence hasn't folded in yet.
export async function buildContextSummary(userId: string): Promise<string> {
  try {
    const [profileResult, recentTextResult, recapResult] = await Promise.all([
      pool.query(
        `SELECT life_chapters, goals, blockers, availability_pattern, city, emotional_state, intent
         FROM co_profiles WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT content FROM co_memories
         WHERE user_id = $1 AND memory_type = 'text_exchange'
         ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT content FROM co_memories
         WHERE user_id = $1 AND memory_type = 'recap'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      ),
    ]);

    const profile = profileResult.rows[0] ?? null;
    const latestIntent = Array.isArray(profile?.intent) && profile.intent.length
      ? profile.intent[profile.intent.length - 1]
      : null;

    const lines = [
      recapResult.rows[0]?.content ? `Ongoing summary: ${recapResult.rows[0].content}` : null,
      profile?.life_chapters?.length ? `Life chapter: ${profile.life_chapters.join(", ")}` : null,
      profile?.city ? `City: ${profile.city}` : null,
      profile?.emotional_state ? `Emotional state as of the last call: ${profile.emotional_state}` : null,
      profile?.goals?.length ? `Goals: ${profile.goals.slice(0, 3).join("; ")}` : null,
      profile?.blockers?.length ? `Blockers: ${profile.blockers.slice(0, 2).join("; ")}` : null,
      latestIntent?.text ? `Stated ask: ${latestIntent.text}` : null,
      latestIntent?.wants?.length ? `Wants: ${latestIntent.wants.slice(0, 2).join(", ")}` : null,
    ].filter(Boolean);

    const recentTextLine = recentTextResult.rows.length
      ? `Recent texts: ${recentTextResult.rows.map((r: any) => r.content).reverse().join(" / ")}`
      : null;
    if (recentTextLine) lines.push(recentTextLine);

    const summary = lines.join(". ");
    // Generous sanity bound, not a real constraint (see the note above) —
    // a few thousand characters costs nothing meaningful in an LLM prompt
    // or a JSON payload; this just guards against a genuinely pathological
    // profile ballooning without limit.
    return summary.length > 4000 ? `${summary.slice(0, 4000)}…` : summary;
  } catch (err: any) {
    console.error("callContext: buildContextSummary failed (non-fatal, calling with no prior context):", err?.message ?? err);
    return "";
  }
}
