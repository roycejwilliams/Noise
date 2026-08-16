import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";

// Co Loop Stage 3 — "identify relevance." Judges whether a candidate
// satisfies someone's stated ask. Used standalone by relevance.ts's network
// sweep — the only active caller right now, per the current build priority
// (Stages 1/2/3/5/6).

// One entry from co_profiles.intent, as written by captureIntent
// (profileExtraction.ts) — embedding is whatever was computed from the ask
// text at capture time, reused here rather than re-embedding.
export type StatedIntent = {
  id?: string;
  text?: string;
  type?: "seeking" | "offering";
  status?: string;
  embedding?: number[] | null;
};

// captureIntent appends asks over time as calls happen — take the most
// recent active "seeking" one as the operative filter. "offering" asks
// describe what the person can give others, not who they want to be matched
// with, so those are left alone.
function getActiveSeekingAsk(intent: unknown): StatedIntent | null {
  if (!Array.isArray(intent)) return null;
  const seeking = (intent as StatedIntent[]).filter(
    (i) => i?.status === "active" && i?.type === "seeking" && i?.text,
  );
  return seeking.length ? seeking[seeking.length - 1] : null;
}

// Same as getActiveSeekingAsk but any type (seeking OR offering) — used to
// read a CANDIDATE's own most recent ask for the two-way/mutual check in
// scoreAgainstStatedAsk below. A candidate's "offering" is exactly the kind
// of thing that could plausibly satisfy someone else's ask, so unlike
// getActiveSeekingAsk this deliberately doesn't filter type out.
function getActiveAsk(intent: unknown): StatedIntent | null {
  if (!Array.isArray(intent)) return null;
  const active = (intent as StatedIntent[]).filter((i) => i?.status === "active" && i?.text);
  return active.length ? active[active.length - 1] : null;
}

// Pulls each candidate's top 3 semantically relevant stored memories (call
// transcripts, text exchanges, etc.) against the ask's embedding — this is
// what lets a fact like "worked at Google" surface even though nothing in
// the structured profile schema tags job history; it's just whatever the
// person actually said, found generically rather than via a fixed taxonomy.
// Top 3 (not top 1) gives the judgment call more to work with before it says
// no — a single closest memory can miss context a second or third would add.
async function fetchTopMemoryPerCandidate(
  candidateIds: string[],
  askEmbedding: number[],
): Promise<Map<string, string[]>> {
  if (!candidateIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT user_id, content FROM (
       SELECT user_id, content,
              ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY content_embedding <=> $2::vector) AS rn
       FROM co_memories
       WHERE user_id = ANY($1::uuid[]) AND content_embedding IS NOT NULL
     ) ranked
     WHERE rn <= 3
     ORDER BY user_id, rn`,
    [candidateIds, `[${askEmbedding.join(",")}]`],
  );
  const byUser = new Map<string, string[]>();
  for (const r of rows as any[]) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(r.content);
    byUser.set(r.user_id, list);
  }
  return byUser;
}

export type AskScore<T> = {
  candidate: T;
  score: number;
  reason: string;
  mutual: boolean;
};

type ScorableCandidate = {
  user_id: string;
  goals?: string[];
  blockers?: string[];
  activity_preferences?: string[];
  intent?: unknown;
};

// A stated ask ("find founders with experience at Google") is the strongest,
// most explicit signal a user can give about who's relevant to them. This
// grades every candidate 0-100 instead of a hard yes/no, and returns a
// one-line grounded reason plus a mutual flag (does the candidate's OWN
// stated ask/offering also plausibly point back at the asker) — so a "no
// strong match" result is distinguishable from "three people were close",
// and relevance_edges ends up with something a human can actually read
// instead of a bare count. askerContext (optional) is a short summary of the
// asker's own goals/blockers/long-term direction, given only so the model
// can judge mutuality — it does not affect the one-directional score.
// Deliberately generic: judges whatever's actually on file rather than any
// fixed set of attributes, so it works the same whether the ask is about a
// career background, a hobby, or a life circumstance.
export async function scoreAgainstStatedAsk<T extends ScorableCandidate>(
  ask: StatedIntent,
  candidates: T[],
  askerContext?: string,
): Promise<AskScore<T>[]> {
  if (!candidates.length || !ask.text) return [];

  const memoryByUser =
    ask.embedding && ask.embedding.length
      ? await fetchTopMemoryPerCandidate(candidates.map((c) => c.user_id), ask.embedding)
      : new Map<string, string[]>();

  const digest = candidates
    .map((c, i) => {
      const facts = [...(c.goals ?? []), ...(c.blockers ?? []), ...(c.activity_preferences ?? [])];
      const memories = memoryByUser.get(c.user_id) ?? [];
      const ownAsk = getActiveAsk(c.intent);
      const parts = [
        facts.length ? facts.join("; ") : null,
        memories.length ? `mentioned: ${memories.map((m) => `"${m}"`).join(" / ")}` : null,
        ownAsk?.text ? `their own stated ${ownAsk.type ?? "ask"}: "${ownAsk.text}"` : null,
      ].filter(Boolean);
      return `${i}. ${parts.length ? parts.join(" | ") : "(nothing on file)"}`;
    })
    .join("\n");

  try {
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "matching.scoreAgainstStatedAsk" },
      prompt: `Someone wants to be connected with people who match this: "${ask.text}"
${askerContext ? `\nWhat's known about the person asking (use ONLY to judge "mutual" below, never to inflate the score itself): ${askerContext}\n` : ""}
Here is what's known about each candidate, one per line:
${digest}

For each candidate, judge how well they satisfy the ask, based only on what's listed — never assume or infer facts that aren't present.

Return ONLY valid JSON, no preamble:
{"results": [{"index": 0, "score": 0, "reason": "one short grounded sentence", "mutual": false}, ...]}

score: 0-100. 0 means nothing on file supports it, 100 means they clearly satisfy it. Score every candidate, even a 0.
reason: one short sentence explaining the score, referencing only what's actually listed for that candidate.
mutual: true only if the candidate's own stated ask/offering (if listed) also plausibly points back at what's known about the asker above. false if the candidate has no stated ask/offering listed, or it doesn't plausibly connect.`,
    });

    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    return results
      .filter((r: any) => Number.isInteger(r.index) && r.index >= 0 && r.index < candidates.length)
      .map((r: any) => ({
        candidate: candidates[r.index],
        score: typeof r.score === "number" ? Math.max(0, Math.min(100, Math.round(r.score))) : 0,
        reason: typeof r.reason === "string" ? r.reason : "",
        mutual: Boolean(r.mutual),
      }));
  } catch (err) {
    // Fail closed — an explicit stated requirement that we can't verify is
    // treated as unmet, same as any other hard filter falling short, rather
    // than silently ignoring what the person asked for.
    console.error("scoreAgainstStatedAsk failed, treating as no matches (non-fatal):", err);
    return [];
  }
}

export { getActiveAsk, getActiveSeekingAsk };
