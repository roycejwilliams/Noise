// What the sweep actually searches for (Royce, 2026-09-15: "Emotions and
// whatever context the user gives us should heavily influence what is
// actually being swept").
//
// The sweep used to search on the stated ask's text alone, so someone who'd
// spent the week saying they feel isolated got the same networking mixers
// as someone who's energized and raising. This turns everything Co knows
// into the search: the ask, goals and interests, what they've said lately,
// and how they've been feeling (harness/emotion.ts), so what comes back
// fits the person right now (a small dinner over a 300-person mixer when
// they're drained, founder support when fundraising keeps worrying them).
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { getEmotionalContext, renderEmotionalContext } from "../harness/emotion.js";
import { recordDecision } from "../harness/core.js";

export type SearchBrief = {
  // One sentence used for search and relevance ranking.
  searchText: string;
  // Why the search looks like this, for the decision log.
  reasoning: string;
};

export type BriefInput = {
  userId: string;
  askText: string;
  fromProfile: boolean;
  goals: string[] | null;
  activityPreferences: string[] | null;
};

async function recentUserTexts(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT content FROM co_memories
       WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND created_at > NOW() - INTERVAL '10 days'
       ORDER BY created_at DESC LIMIT 12`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => String(r.content).replace(/^User said: /, "")).reverse();
}

// Falls back to the plain ask text if anything fails, so the sweep never
// stops searching because of this step.
export async function buildSearchBrief(input: BriefInput): Promise<SearchBrief> {
  const fallback = { searchText: input.askText, reasoning: "fallback: ask text only" };
  try {
    const [emotional, texts] = await Promise.all([getEmotionalContext(input.userId), recentUserTexts(input.userId)]);
    const feeling = renderEmotionalContext(emotional);
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "sweep.searchBrief" },
      prompt: `Co is about to search for events, communities, and opportunities for someone. Write what to search for so the results fit who they are and how they're doing right now, not just the words of their ask.

${input.fromProfile ? "They haven't asked for anything specific. From their profile" : "What they asked Co for"}: ${input.askText}
${input.goals?.length ? `Goals: ${input.goals.slice(0, 6).join("; ")}` : ""}
${input.activityPreferences?.length ? `Things they enjoy: ${input.activityPreferences.slice(0, 6).join("; ")}` : ""}

What they've said to Co lately (oldest first):
${texts.length ? texts.map((t) => `- ${t}`).join("\n") : "(nothing recent)"}

How they've been feeling:
${feeling || "(nothing notable)"}

Let their feelings and recent words change the search where they should: drained or overwhelmed points to smaller, lower-key things; isolated or lonely points to recurring community over one-off networking; a worry that keeps coming up (like fundraising) points to things that help with it; excitement points to things that build on it. Keep their actual ask at the center. Don't invent interests they haven't shown.

Return ONLY JSON: {"searchText": "one sentence describing what to look for, including topic, format, and size or energy when it matters", "reasoning": "one short sentence on what shaped it"}`,
    });
    const p = parseModelJson<{ searchText?: string; reasoning?: string }>(text);
    const brief = p.searchText?.trim() ? { searchText: p.searchText.trim().slice(0, 300), reasoning: String(p.reasoning ?? "").slice(0, 300) } : fallback;
    await recordDecision({
      layer: 5,
      decision: "sweep.searchBrief",
      userId: input.userId,
      outcome: "act",
      action: "search",
      proposal: { askText: input.askText, feeling, brief },
      reason: brief.reasoning,
    });
    return brief;
  } catch (err: any) {
    console.error("buildSearchBrief failed (non-fatal, searching on ask text):", err?.message ?? err);
    return fallback;
  }
}
