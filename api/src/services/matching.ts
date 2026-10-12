import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { goalEntries, isOpenAsk } from "../harness/profileWrite.js";
import { parseModelJson } from "./modelJson.js";

// Model policy (Royce, 2026-09-14): scoring decides who gets introduced to
// whom, so it runs on Sonnet 5.
const SCORING_MODEL = MODELS.sonnet;

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
  // The member said Co may mention this ask when introducing them. Default (missing) is private.
  shareable?: boolean | null;
};

// captureIntent appends asks over time as calls happen — take the most
// recent active "seeking" one as the operative filter. "offering" asks
// describe what the person can give others, not who they want to be matched
// with, so those are left alone.
function getActiveSeekingAsk(intent: unknown): StatedIntent | null {
  if (!Array.isArray(intent)) return null;
  const seeking = (intent as StatedIntent[]).filter((i) => isOpenAsk(i) && i?.type === "seeking");
  return seeking.length ? seeking[seeking.length - 1] : null;
}

// Same as getActiveSeekingAsk but any type (seeking OR offering) — used to
// read a CANDIDATE's own most recent ask for the two-way/mutual check in
// scoreAgainstStatedAsk below. A candidate's "offering" is exactly the kind
// of thing that could plausibly satisfy someone else's ask, so unlike
// getActiveSeekingAsk this deliberately doesn't filter type out.
function getActiveAsk(intent: unknown): StatedIntent | null {
  if (!Array.isArray(intent)) return null;
  const active = (intent as StatedIntent[]).filter(isOpenAsk);
  return active.length ? active[active.length - 1] : null;
}

// Mirror of getActiveSeekingAsk for the reverse direction — "I have
// something to offer, who in the network wants it?" (relevance.ts's
// sweepOfferingAgainstNetwork). Without this, an "offering" ask only ever
// gets surfaced as a side-effect of someone ELSE's seeking sweep finding the
// offerer as a candidate — it never proactively searches for the people who
// might actually want it.
function getActiveOfferingAsk(intent: unknown): StatedIntent | null {
  if (!Array.isArray(intent)) return null;
  const offering = (intent as StatedIntent[]).filter((i) => isOpenAsk(i) && i?.type === "offering");
  return offering.length ? offering[offering.length - 1] : null;
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
  // The only reason that may ever be shown to a person (the asker, the
  // candidate, an intro email). `reason` is built from the candidate's
  // private profile and memories and stays internal. Empty = nothing
  // shareable, so the match must not be surfaced to anyone.
  shareReason: string;
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
async function buildCandidateDigest<T extends ScorableCandidate>(
  candidates: T[],
  askEmbedding?: number[] | null,
  hints?: Map<string, string>,
): Promise<string> {
  const memoryByUser =
    askEmbedding && askEmbedding.length
      ? await fetchTopMemoryPerCandidate(candidates.map((c) => c.user_id), askEmbedding)
      : new Map<string, string[]>();
  return formatCandidateDigest(candidates, memoryByUser, hints);
}

// Pure half of buildCandidateDigest, exported for evals/matching.
// hints: the people graph's internal read of an overlap (peopleGraph.ts
// edgeHint), for the scorer only.
export function formatCandidateDigest<T extends ScorableCandidate>(candidates: T[], memoryByUser: Map<string, string[]>, hints?: Map<string, string>): string {
  return candidates
    .map((c, i) => {
      const facts = [...(c.goals ?? []), ...(c.blockers ?? []), ...(c.activity_preferences ?? [])];
      const memories = memoryByUser.get(c.user_id) ?? [];
      const shared = shareableAsks(c.intent);
      const privateAsks = (Array.isArray(c.intent) ? (c.intent as StatedIntent[]) : []).filter((i) => isOpenAsk(i) && i.shareable !== true);
      const parts = [
        facts.length ? facts.join("; ") : null,
        memories.length ? `mentioned: ${memories.map((m) => `"${m}"`).join(" / ")}` : null,
        privateAsks.length ? `private asks (never shareable): ${privateAsks.map((a) => `"${a.text}"`).join(" / ")}` : null,
        shared.length ? `asks they agreed to share: ${shared.map((a, k) => `[S${k + 1}] ${a.type ?? "seeking"} "${a.text}"`).join(" / ")}` : null,
        hints?.get(c.user_id) ?? null,
      ].filter(Boolean);
      return `${i}. ${parts.length ? parts.join(" | ") : "(nothing on file)"}`;
    })
    .join("\n");
}

// Shared prompt-call/parse logic for both scoring directions below — only
// the prompt text itself actually differs between "who satisfies my ask"
// and "who wants my offering".
// The open asks a member said Co may mention when introducing them, in intent order. An ask is private unless marked.
export function shareableAsks(intent: unknown): StatedIntent[] {
  if (!Array.isArray(intent)) return [];
  return (intent as StatedIntent[]).filter((i) => isOpenAsk(i) && i.shareable === true);
}

// The words another person may see: the ONE shareable ask the scorer said the match rests on ("S1", "S2"...), in the
// member's own words. No label, an unknown label, a private or closed ask: nothing. Never their newest ask by default.
export function shareReasonFromOwnAsk(intent: unknown, label?: unknown): string {
  const n = typeof label === "string" ? Number(label.trim().replace(/^\[?S/i, "").replace(/\]$/, "")) : NaN;
  if (!Number.isInteger(n) || n < 1) return "";
  const ask = shareableAsks(intent)[n - 1];
  if (!ask?.text) return "";
  return ask.type === "offering" ? `what they've said they can offer: "${ask.text}"` : `what they've said they're looking for: "${ask.text}"`;
}

async function runAskScoring<T extends ScorableCandidate>(
  functionId: string,
  prompt: string,
  candidates: T[],
): Promise<AskScore<T>[]> {
  try {
    const { text: raw } = await generateText({
      model: anthropic(SCORING_MODEL),
      experimental_telemetry: { isEnabled: true, functionId },
      prompt,
    });

    const parsed = parseModelJson(raw);
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    return results
      .filter((r: any) => Number.isInteger(r.index) && r.index >= 0 && r.index < candidates.length)
      .map((r: any) => ({
        candidate: candidates[r.index],
        score: typeof r.score === "number" ? Math.max(0, Math.min(100, Math.round(r.score))) : 0,
        reason: typeof r.reason === "string" ? r.reason : "",
        // The model only names WHICH shared ask the match rests on; the words shown to people are that ask, in their own
        // words, and only if they marked it shareable. Nothing private or inferred (e.g. "actively fundraising") can leak.
        shareReason: shareReasonFromOwnAsk(candidates[r.index].intent, r.share_ask),
        mutual: Boolean(r.mutual),
      }));
  } catch (err) {
    // Fail closed — an explicit stated requirement that we can't verify is
    // treated as unmet, same as any other hard filter falling short, rather
    // than silently ignoring what the person asked for.
    console.error(`${functionId} failed, treating as no matches (non-fatal):`, err);
    return [];
  }
}

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
  hints?: Map<string, string>,
): Promise<AskScore<T>[]> {
  if (!candidates.length || !ask.text) return [];

  // A big room: Jev rules out the clear no's first and Claude scores who is
  // left (services/jevMatching.ts). Dropped candidates score 0, as Claude
  // gives "nothing on file supports it". Any Jev problem keeps everyone.
  let toScore = candidates;
  let dropped: T[] = [];
  const { PRUNE_MIN_CANDIDATES, pruneEnabled } = await import("./jevMatching.js");
  if (candidates.length >= PRUNE_MIN_CANDIDATES && pruneEnabled()) {
    try {
      const started = Date.now();
      const { jevMatchScores, keepAfterPrune } = await import("./jevMatching.js");
      const ps = await jevMatchScores(ask.text, candidates);
      const keep = new Set(keepAfterPrune(ps));
      toScore = candidates.filter((_, i) => keep.has(i));
      dropped = candidates.filter((_, i) => !keep.has(i));
      const { recordDecision } = await import("../harness/core.js");
      void recordDecision({
        layer: 5,
        decision: "jev.prune.matching",
        userId: null,
        outcome: "act",
        action: `kept ${toScore.length} of ${candidates.length}`,
        proposal: { candidates: candidates.length, keptForClaude: toScore.length, unread: ps.filter((p) => p === null).length, ms: Date.now() - started },
      }).catch(() => {});
    } catch (err: any) {
      console.error("matching: Jev prune failed, scoring everyone (non-fatal):", err?.message ?? err);
      toScore = candidates;
      dropped = [];
    }
  }
  if (!toScore.length) return dropped.map((c) => ({ candidate: c, score: 0, reason: "", shareReason: "", mutual: false }) as AskScore<T>);
  const digest = await buildCandidateDigest(toScore, ask.embedding, hints);
  const scored = await runAskScoring("matching.scoreAgainstStatedAsk", buildStatedAskPrompt(ask.text, digest, askerContext), toScore);
  return [...scored, ...dropped.map((c) => ({ candidate: c, score: 0, reason: "", shareReason: "", mutual: false }) as AskScore<T>)];
}

export function buildStatedAskPrompt(askText: string, digest: string, askerContext?: string): string {
  return `Someone wants to be connected with people who match this: "${askText}"
${askerContext ? `\nWhat's known about the person asking (use ONLY to judge "mutual" below, never to inflate the score itself): ${askerContext}\n` : ""}
Here is what's known about each candidate, one per line:
${digest}

For each candidate, judge how well they satisfy the ask, based only on what's listed — never assume or infer facts that aren't present.

Return ONLY valid JSON, no preamble:
{"results": [{"index": 0, "score": 0, "reason": "one short grounded sentence", "share_ask": "", "mutual": false}, ...]}

score: 0-100. 0 means nothing on file supports it, 100 means they clearly satisfy it. Score every candidate, even a 0.
reason: one short sentence explaining the score, referencing only what's actually listed for that candidate. Internal only, never shown to anyone.
share_ask: the label (like "S1") of the ONE ask listed under "asks they agreed to share" that is the reason this candidate fits. Only that ask can ever be said to other people. Empty string if none of their shared asks supports the match, even when something else on file does. Never pick a shared ask that is unrelated to the match.
mutual: true only if one of the candidate's own asks (shared or private, if listed) also plausibly points back at what's known about the asker above. false if the candidate has no ask listed, or it doesn't plausibly connect.`;
}

// Reverse direction of scoreAgainstStatedAsk — "I have something to offer,
// who in the network would actually want it?" Without this, an "offering"
// ask never gets proactively matched to anyone; it only ever surfaces as a
// side-effect of someone ELSE's seeking ask happening to find the offerer as
// a candidate. mutual here means the reverse of scoreAgainstStatedAsk's:
// true only when the candidate's own stated ask is a "seeking" that
// plausibly wants this specific offering.
export async function scoreOfferingAgainstCandidates<T extends ScorableCandidate>(
  offering: StatedIntent,
  candidates: T[],
): Promise<AskScore<T>[]> {
  if (!candidates.length || !offering.text) return [];

  const digest = await buildCandidateDigest(candidates, offering.embedding);

  const prompt = `Someone has this to offer others: "${offering.text}"

Here is what's known about each candidate, one per line:
${digest}

For each candidate, judge how much they would likely want or benefit from this offering, based only on what's listed — never assume or infer facts that aren't present.

Return ONLY valid JSON, no preamble:
{"results": [{"index": 0, "score": 0, "reason": "one short grounded sentence", "share_ask": "", "mutual": false}, ...]}

score: 0-100. 0 means nothing on file suggests they'd want this, 100 means it clearly matches something they're after. Score every candidate, even a 0.
reason: one short sentence explaining the score, referencing only what's actually listed for that candidate. Internal only, never shown to anyone.
share_ask: the label (like "S1") of the ONE ask listed under "asks they agreed to share" that is the reason this candidate fits. Only that ask can ever be said to other people. Empty string if none of their shared asks supports the match, even when something else on file does. Never pick a shared ask that is unrelated to the match.
mutual: true only if one of the candidate's own asks (if listed) is a "seeking" ask that plausibly wants this specific offering. false if the candidate has no stated ask listed, or it doesn't plausibly connect.`;

  return runAskScoring("matching.scoreOfferingAgainstCandidates", prompt, candidates);
}

// ---------------------------------------------------------------- the room frame (2026-10-12 intelligence audit)
//
// A room is scored against everything a person is open to, not their newest ask: every open, people-shaped ask in both
// directions (what they need, and what they offer), de-duplicated, errands left out (services/peopleAsks.ts), with their
// newest goal as the frame when no ask is about people. The caller passes only what matching may read (roomMatching.ts
// matchableIntent: shareable asks only), so this changes nothing about what is private.
export type RoomFrame = { asks: StatedIntent[]; goal: StatedIntent | null };

export async function roomFrame(intent: unknown): Promise<RoomFrame | null> {
  const open = Array.isArray(intent) ? (intent as StatedIntent[]).filter(isOpenAsk) : [];
  const { peopleAsksOf } = await import("./peopleAsks.js");
  const asks = await peopleAsksOf(open);
  const goal = getGoalFrame(intent);
  return asks.length || goal?.text ? { asks, goal: goal?.text ? goal : null } : null;
}

// Pure: the one line the frame is quoted as (also what the stub scorer and the Jev prune read).
export function frameLine(f: RoomFrame): string {
  const parts = f.asks.map((a) => `${a.type === "offering" ? "can offer" : "looking for"}: ${a.text}`);
  if (f.goal?.text) parts.push(`headed toward: ${f.goal.text}`);
  return parts.join(" | ");
}

export function buildRoomFramePrompt(f: RoomFrame, digest: string, askerContext?: string): string {
  const lines = [
    ...f.asks.map((a) => `- ${a.type === "offering" ? "can offer" : "looking for"}: "${a.text}"`),
    ...(f.goal?.text ? [`- where they're headed: "${f.goal.text}"${f.asks.length ? " (the frame when none of the lines above is about people)" : ""}`] : []),
  ];
  return `Someone wants to be connected with people who match this: "${frameLine(f)}"

Everything they're open to, in their words (a candidate needs to fit only one line):
${lines.join("\n")}
Only lines about people count: someone to meet, hire, work with, learn from, back or be backed by, or something they can give a person. An errand (a place, a product, a booking, a plan, a recommendation) says nothing about who to meet: leave it out of the judgment.
${askerContext ? `\nWhat's known about the person asking (use it to judge what they can offer someone, and "mutual" below): ${askerContext}\n` : ""}
Here is what's known about each candidate, one per line:
${digest}

For each candidate, judge how well they fit, based only on what's listed — never assume or infer facts that aren't present. A fit runs either way: the candidate can meet one of the person's needs, or the candidate needs what the person offers or does (a founder who needs a product designer fits a product designer weighing freelance work). Judge by who the candidate is and what they do, not only by whether the candidate's own ask repeats the person's words.

Return ONLY valid JSON, no preamble:
{"results": [{"index": 0, "score": 0, "reason": "one short grounded sentence", "share_ask": "", "mutual": false}, ...]}

score: 0-100. 0 means nothing on file supports a fit, 100 means a clear fit for one of their lines. Score every candidate, even a 0.
reason: one short sentence explaining the score, referencing only what's actually listed for that candidate. Internal only, never shown to anyone.
share_ask: the label (like "S1") of the ONE ask listed under "asks they agreed to share" that is the reason this candidate fits. Only that ask can ever be said to other people. Empty string if none of their shared asks supports the match, even when something else on file does. Never pick a shared ask that is unrelated to the match.
mutual: true only if one of the candidate's own asks also plausibly points back at the person (what they need, offer or do). false if the candidate has no ask listed, or it doesn't plausibly connect.`;
}

export async function scoreAgainstRoomFrame<T extends ScorableCandidate>(
  f: RoomFrame,
  candidates: T[],
  askerContext?: string,
  hints?: Map<string, string>,
): Promise<AskScore<T>[]> {
  if (!candidates.length || (!f.asks.length && !f.goal?.text)) return [];
  const line = frameLine(f);
  let toScore = candidates;
  let dropped: T[] = [];
  const { PRUNE_MIN_CANDIDATES, pruneEnabled } = await import("./jevMatching.js");
  if (candidates.length >= PRUNE_MIN_CANDIDATES && pruneEnabled()) {
    try {
      const { jevMatchScores, keepAfterPrune } = await import("./jevMatching.js");
      const keep = new Set(keepAfterPrune(await jevMatchScores(line, candidates)));
      toScore = candidates.filter((_, i) => keep.has(i));
      dropped = candidates.filter((_, i) => !keep.has(i));
    } catch (err: any) {
      console.error("matching: Jev prune failed, scoring everyone (non-fatal):", err?.message ?? err);
      toScore = candidates;
      dropped = [];
    }
  }
  const zero = dropped.map((c) => ({ candidate: c, score: 0, reason: "", shareReason: "", mutual: false }) as AskScore<T>);
  if (!toScore.length) return zero;
  // What each candidate said that bears on any of the lines (top memories per ask embedding, merged).
  const embeddings = [...f.asks, ...(f.goal ? [f.goal] : [])].map((a) => a.embedding).filter((e): e is number[] => Array.isArray(e) && e.length > 0).slice(-3);
  const memoryByUser = new Map<string, string[]>();
  for (const e of embeddings) {
    const m = await fetchTopMemoryPerCandidate(toScore.map((c) => c.user_id), e).catch(() => new Map<string, string[]>());
    for (const [id, list] of m) memoryByUser.set(id, [...new Set([...(memoryByUser.get(id) ?? []), ...list])].slice(0, 4));
  }
  const digest = formatCandidateDigest(toScore, memoryByUser, hints);
  const scored = await runAskScoring("matching.scoreAgainstRoomFrame", buildRoomFramePrompt(f, digest, askerContext), toScore);
  return [...scored, ...zero];
}

// Every active stated ask/offering text (the only profile text a person
// gave in order to be matched; see harness/matchGate.ts and introConsent.ts).
function getActiveAsks(intent: unknown): string[] {
  if (!Array.isArray(intent)) return [];
  return (intent as StatedIntent[]).filter(isOpenAsk).map((i) => String(i.text));
}

// Every open ask of one type, oldest first. The immediate sweep after a capture
// only needs the newest (getActiveSeekingAsk); the daily sweep covers them all.
function getOpenAsksOfType(intent: unknown, type: "seeking" | "offering"): StatedIntent[] {
  if (!Array.isArray(intent)) return [];
  return (intent as StatedIntent[]).filter((i) => isOpenAsk(i) && i?.type === type);
}

// When someone has no open ask, who is worth meeting is judged against where they are headed instead: the newest active goal is the frame
// (services/goalJourney.ts). A goal is only ever judged against here, never searched: it is never written to an ask list.
function getGoalFrame(intent: unknown): StatedIntent | null {
  const g = goalEntries(intent);
  return g.length ? ({ ...g[g.length - 1], type: "seeking" } as StatedIntent) : null;
}

export { getActiveAsk, getActiveAsks, getActiveSeekingAsk, getActiveOfferingAsk, getOpenAsksOfType, getGoalFrame };
