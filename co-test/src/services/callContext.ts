import pool from "../../../api/src/db/db.js";

// Builds a compact summary of everything already known about a person —
// from a prior call's extracted profile/intent AND recent text exchanges —
// so a new call's opening can pick up from it instead of a cold generic
// greeting every time, regardless of which channel the prior context came
// from. Kept short (a handful of lines) since this gets passed as a URL
// query param on the Twilio bridge connect URL, the same proven mechanism
// {first_name} already uses — not a documented Hume feature for arbitrary
// variables, but the one actually wired up and working in this system.
export async function buildContextSummary(userId: string): Promise<string> {
  try {
    const [profileResult, recentTextResult] = await Promise.all([
      pool.query(
        `SELECT life_chapters, goals, blockers, availability_pattern, city, emotional_state, intent
         FROM co_profiles WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT content FROM co_memories
         WHERE user_id = $1 AND memory_type = 'text_exchange'
         ORDER BY created_at DESC LIMIT 6`,
        [userId],
      ),
    ]);

    const profile = profileResult.rows[0] ?? null;
    const latestIntent = Array.isArray(profile?.intent) && profile.intent.length
      ? profile.intent[profile.intent.length - 1]
      : null;

    const lines = [
      profile?.life_chapters?.length ? `Life chapter: ${profile.life_chapters.join(", ")}` : null,
      profile?.city ? `City: ${profile.city}` : null,
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
    // Twilio bridge URL is a query string, not a request body — keep this
    // bounded so it can't push the whole URL past a proxy/server length
    // limit regardless of how much is on file.
    return summary.length > 600 ? `${summary.slice(0, 600)}…` : summary;
  } catch (err: any) {
    console.error("callContext: buildContextSummary failed (non-fatal, calling with no prior context):", err?.message ?? err);
    return "";
  }
}
