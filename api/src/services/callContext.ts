import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import { writeMemory } from "./memory.js";
import { MODELS } from "../models.js";
import { getEmotionalContext, renderEmotionalContext } from "../harness/emotion.js";
import { getPersonSnapshot, renderSnapshot } from "../harness/personSnapshot.js";

// A 1-2 sentence call summary: narrow work, Haiku.
const SUMMARY_MODEL = MODELS.haiku;

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
    const [profileResult, recentTextResult, recapResult, recentRecommendationResult, emotional, ownWordsResult, openAsksResult, snapshot] = await Promise.all([
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
      // Real gap found 2026-09-07: Co asked "what did you find me?" on a
      // fresh call had no way to answer — this summary read profile/text/
      // recap only, never what Co itself actually surfaced. One bounded,
      // recency-limited line (not the full pending/resolved offer machinery
      // sendblue.ts owns for text) covers the common "did I miss what you
      // found me" case without growing every call's opening context.
      pool.query(
        `SELECT content FROM co_memories
         WHERE user_id = $1 AND memory_type = 'recommendation' AND created_at > NOW() - INTERVAL '3 days'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      ),
      // Emotion loop: the same read of how they've been feeling that texts
      // use, so a call opens knowing what the texts showed and vice versa.
      getEmotionalContext(userId),
      // What they've told Co themselves in the last 48 hours, first: newer
      // facts beat an older recap or profile (2026-09-15 call opened as if he
      // were still pre-seed, after he'd texted he's Series A with a $35M deal).
      pool.query(
        `SELECT content FROM co_memories
         WHERE user_id = $1 AND memory_type = 'text_exchange' AND (content LIKE 'User said:%' OR content LIKE '[Call]%')
           AND created_at > NOW() - INTERVAL '48 hours'
         ORDER BY created_at DESC LIMIT 25`,
        [userId],
      ),
      pool.query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 4`, [userId]),
      getPersonSnapshot(userId),
    ]);
    const emotionalLine = renderEmotionalContext(emotional);

    const profile = profileResult.rows[0] ?? null;
    const latestIntent = Array.isArray(profile?.intent) && profile.intent.length
      ? profile.intent[profile.intent.length - 1]
      : null;

    const ownWords = ownWordsResult.rows.map((r: any) => String(r.content).replace(/^User said: /, "- ")).reverse();
    const openAsks = openAsksResult.rows.map((r: any) => `- ${r.ask_text}`);
    const picture = renderSnapshot(snapshot);
    const lines = [
      picture ? `Who they are right now:\n${picture}` : null,
      ownWords.length ? `What they've told you in the last two days (newest facts win over anything below):\n${ownWords.join("\n")}` : null,
      openAsks.length ? `What they're looking for right now:\n${openAsks.join("\n")}` : null,
      recapResult.rows[0]?.content ? `Ongoing summary: ${recapResult.rows[0].content}` : null,
      profile?.life_chapters?.length ? `Life chapter: ${profile.life_chapters.join(", ")}` : null,
      profile?.city ? `City: ${profile.city}` : null,
      emotionalLine ? `How they've been feeling:\n${emotionalLine}` : null,
      profile?.goals?.length ? `Goals: ${profile.goals.slice(0, 3).join("; ")}` : null,
      profile?.blockers?.length ? `Blockers: ${profile.blockers.slice(0, 2).join("; ")}` : null,
      !openAsks.length && latestIntent?.text ? `Stated ask: ${latestIntent.text}` : null,
      latestIntent?.wants?.length ? `Wants: ${latestIntent.wants.slice(0, 2).join(", ")}` : null,
      recentRecommendationResult.rows[0]?.content ? `Most recent thing Co suggested: ${recentRecommendationResult.rows[0].content}` : null,
    ].filter(Boolean);

    const recentTextLine = recentTextResult.rows.length
      ? `Recent texts: ${recentTextResult.rows.map((r: any) => r.content).reverse().join(" / ")}`
      : null;
    if (recentTextLine) lines.push(recentTextLine);

    // Newest and most important sections come first, so the bound drops the
    // oldest, least important lines whole instead of cutting mid-sentence.
    const MAX = 4500;
    let summary = "";
    for (const line of lines as string[]) {
      const next = summary ? `${summary}\n\n${line}` : line;
      if (next.length > MAX) break;
      summary = next;
    }
    return summary;
  } catch (err: any) {
    console.error("callContext: buildContextSummary failed (non-fatal, calling with no prior context):", err?.message ?? err);
    return "";
  }
}

// The other direction of the same bridge — closes a real gap (Royce,
// 2026-09-07: "anything overlapping that may cause confusion... between
// voice and text?"): routes/sendblue.ts's recentConversation, read by every
// text-reply classifier, only ever queries co_memories.text_exchange rows,
// never call_transcript — and the only other channel-bridging mechanism is
// memoryCompaction.ts's recap, which runs once a day at 4am. Without this, a
// text reply arriving the SAME DAY as a call had zero visibility into what
// was just discussed until the next day's recap. Written as its own
// text_exchange row (not call_transcript) specifically so it's picked up by
// that same existing query with no changes needed there. Best-effort,
// call-ending pipeline continues regardless — matches storeProfile's own
// non-blocking Step 7 siblings (captureIntent, extractPlannedEventMention).
export async function summarizeCallForTextContext(userId: string, transcript: string, emotionalHighlights?: string): Promise<void> {
  try {
    const { text: raw } = await generateText({
      model: anthropic(SUMMARY_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "callContext.summarizeCallForText" },
      prompt: `Summarize what was actually discussed in this phone call transcript, in 1-2 plain sentences, third person, as if briefing someone on what just happened. Ground it only in what's actually in the transcript — no invented detail, no therapy-speak.

Transcript:
"${transcript}"
${emotionalHighlights ? `\nHume's voice analysis of how they sounded (measured, not guessed):\n${emotionalHighlights}\n\nAdd one short sentence on how they came across and about what, using only those moments. Describe it plainly ("sounded anxious talking about the raise"), not clinically.\n` : ""}
Return ONLY the summary, no preamble.`,
    });
    const summary = raw.trim();
    if (!summary) return;
    await writeMemory(userId, "text_exchange", `[Call] ${summary}`);
  } catch (err: any) {
    console.error("summarizeCallForTextContext: failed (non-fatal):", err?.message ?? err);
  }
}
