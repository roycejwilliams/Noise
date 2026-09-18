import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import crypto from "crypto";
import pool from "../db/db.js";
import { generateEmbedding, generateGoalEmbedding } from "./embeddings.js";
import { sweepAskAgainstNetwork, sweepOfferingAgainstNetwork } from "./relevance.js";
import { recordDecision } from "../harness/core.js";
import { askExpiresAtForUser } from "./askExpiry.js";
import {
  PROFILE_JUDGMENT_MODEL,
  decideAskWrite,
  gateResolutions,
  sanitizeExtractedProfile,
  type OpenAsk,
  type ProposedResolution,
} from "../harness/profileWrite.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";

// Model per job (Royce's policy): Sonnet 5 for judgment that changes the
// profile (psychographic extraction, retiring items, same-ask calls);
// Haiku 4.5 for narrow extraction that code checks afterward.
const PROFILE_EXTRACT_MODEL = PROFILE_JUDGMENT_MODEL;
const NARROW_MODEL = MODELS.haiku;

// Shared by the Hume call webhook (co.ts /webhook), the typed-intake fallback
// (co.ts /typed-intake/:user_id), and co-test's browser-EVI intake — all three
// feed a raw transcript through the same psychographic extraction + co_profiles
// upsert so the fields Co reports and the fields matching actually scores
// against never drift apart between entry points.

export const ALLOWED_LIFE_CHAPTERS = ["new_to_city", "building_solo", "career_pivot", "starting_over"];
export const ALLOWED_CONNECTION_STYLES = ["small_group", "medium_group", "large_social"];

export type ExtractedProfile = {
  life_chapters?: string[];
  social_energy?: number;
  connection_style?: string;
  activity_preferences?: string[];
  goals?: string[];
  blockers?: string[];
  availability_pattern?: string;
  city?: string;
  emotional_state?: string;
  // Co Loop Stage 1 addition — longer-horizon personal + career direction,
  // deliberately separate from goals_challenges (immediate/current). See
  // RAPPORT_TOPICS' long_term_direction description for why this split
  // exists.
  long_term_direction?: string;
  [key: string]: unknown;
};

export type ExtractedIntent = {
  id: string;
  // The original seeking/offering ask — both optional now, since a
  // transcript can carry real concrete_preferences/wants/availability
  // signal without ever stating one clear ask (previously this whole
  // record simply didn't exist in that case).
  text?: string;
  type?: "seeking" | "offering";
  // Named, concrete things mentioned — a specific gym, a coffee style, a
  // venue type — not a vague vibe. Recommendation/Event both need this
  // level of specificity to produce anything worth sending.
  concrete_preferences: string[];
  // Things they said they miss or want to find (a running group, a book
  // club, a version of a place from a previous city).
  wants: string[];
  // General availability pattern, in their own words — not parsed into a
  // schedule, just captured as stated ("weekday evenings", "flexible except Sundays").
  availability: string | null;
  status: "active";
  embedding: number[] | null;
  created_at: string;
};

// Keys must match the tool schema description registered on the Hume config
// and the Rapport-phase topics in Jacqueline's spec.
//
// long_term_direction (added for Co Loop Stage 1) is NOT yet confirmed
// registered on Hume's own tool schema for assess_conversation_coverage —
// that config lives on Hume's dashboard, outside this repo, and per the
// comment above this array must independently list any topic key for it to
// reliably show up in missing_topics on a live voice call. The text channel
// (assessConversationCoverage's own prompt, built from RAPPORT_TOPICS
// directly) picks this up correctly regardless. Confirm/update the Hume-side
// schema before relying on this topic surfacing on calls.
export const RAPPORT_TOPICS = [
  "current_situation",
  "major_transition",
  "goals_challenges",
  "looking_for",
  "people_to_meet",
  "ways_to_help",
  "personality",
  "location_availability",
  "boundaries_preferences",
  "long_term_direction",
] as const;

export type RapportTopic = (typeof RAPPORT_TOPICS)[number];

// Single source of truth for what each topic actually means — used both to
// build assessConversationCoverage's prompt below and, for the text channel
// (webhooks.ts), to tell the reply-generation model in plain language what a
// missing_topics key is actually asking about.
export const RAPPORT_TOPIC_DESCRIPTIONS: Record<RapportTopic, string> = {
  current_situation: "what's going on in their life right now",
  major_transition: "the bigger context or change they're in the middle of",
  goals_challenges: "what they're working toward or struggling with",
  looking_for: "what kind of connection or outcome they want from this",
  people_to_meet: "the kind of people they'd want to be introduced to",
  ways_to_help: "what they could offer or help others with",
  personality: "some sense of their personality or how they come across",
  location_availability: "where they are and when they're free",
  boundaries_preferences: "any stated boundaries or preferences",
  long_term_direction:
    "their longer-horizon personal and career direction — where they want to be in a few years, distinct from what's urgent right now",
};

export type CoverageAssessment = {
  missing_topics: RapportTopic[];
  ready_to_summarize: boolean;
};

const COVERAGE_FALLBACK: CoverageAssessment = {
  missing_topics: [...RAPPORT_TOPICS],
  ready_to_summarize: false,
};

// Step 1 of the pipeline — turns a transcript into raw psychographic JSON via
// Claude. Returns both the raw model output and the parsed/attempted-parse
// result so callers that need to show "exactly what the pipeline produced"
// (co-test's raw-output panel) don't have to re-derive it.
export async function extractPsychographicProfile(
  transcript: string,
  emotionalHighlights?: string,
): Promise<{ raw: string; extracted: ExtractedProfile }> {
  // Voice calls only — Hume's own prosody analysis on the user's real audio
  // (not available for text). Without this, "blockers"/emotional_state are
  // inferred from wording alone, so a topic mentioned calmly and one that
  // actually made someone anxious read identically to the model. This
  // grounds the extraction in what Hume's voice analysis flagged as the
  // most emotionally loaded moments, so those get weighted appropriately
  // rather than just whatever was mentioned most.
  const emotionalContext = emotionalHighlights
    ? `\n\nHume's own voice-emotion analysis flagged these as the most emotionally loaded moments in the call (use this to weight blockers/emotional_state toward what actually carried real feeling, not just what was mentioned most often):\n${emotionalHighlights}`
    : "";

  const { text: rawExtraction } = await generateText({
    model: anthropic(PROFILE_EXTRACT_MODEL),
    prompt: `You are extracting psychographic profile data from a conversation transcript between Co (an assistant, "assistant" lines) and a person ("user" lines).

        Only what the PERSON said (the "user" lines) can fill any field below. Something Co suggested, asked about, or offered ("assistant" lines) is never the person's own goal, blocker, preference, or activity unless the person's own reply actually confirms it.

        Based on this transcript, extract the following fields and return ONLY valid JSON with no preamble or markdown:

        {
          "life_chapters": [], // array of applicable values from: new_to_city, building_solo, career_pivot, starting_over
          "social_energy": null, // number 0-100 (0 = very introverted/quiet preference, 100 = very extroverted/high energy), or null if the person's own words didn't give a real signal this call — never guess a number
          "connection_style": "", // one of: small_group, medium_group, large_social
          "activity_preferences": [], // array of activities they mentioned or implied enjoying
          "goals": [], // array of things they are working toward
          "blockers": [], // array of challenges or struggles in their life they mentioned (never frustrations with Co itself)
          "availability_pattern": "", // how often and when they want to connect (e.g. "weekday evenings", "weekends")
          "city": "", // ONLY where they live now or are actually moving to ("I'm in Oakland", "moving to Austin next month"). Never a city that only comes up as a preference or target — "roles in NYC", "investors in NYC", "events in Miami" say nothing about where they are. Empty string if they didn't say.
          "emotional_state": "", // one word describing their current emotional state (e.g. anxious, energized, overwhelmed, motivated, isolated, confident, focused, excited, lost, burnout)
          "long_term_direction": "" // a sentence capturing their longer-term personal + career direction/trajectory — where they're headed, distinct from immediate goals/blockers. Empty string if not discussed.
        }

        Transcript:
        "${transcript}"${emotionalContext}`,
    experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.extractPsychographicProfile" },
  });

  let extracted: ExtractedProfile = {};
  try {
    const clean = rawExtraction.trim();
    extracted = parseModelJson(clean);
  } catch {
    console.error("Failed to parse psychographic extraction:", rawExtraction);
  }

  return { raw: rawExtraction, extracted };
}

// Coverage check — originally mid-call only (invoked from the Hume
// tool_call webhook while a call is live), now also reused by the text
// channel — co-test/src/routes/webhooks.ts had this pattern already proven,
// and prod's routes/sendblue.ts now ports the same approach into its own
// reply-generation prompt (Co Loop Stage 1) — so a text-only relationship
// works toward the same set of topics a call does instead of just reactively
// answering whatever comes up. Deliberately separate from
// extractPsychographicProfile: Haiku (not Sonnet), no DB writes, no
// embeddings, terse output-only prompt — on a live call every millisecond
// here is dead air, since EVI blocks the conversation on a pending tool
// response; on text there's no such constraint but the same cheap/fast
// shape is still the right call. On a live call, does NOT decide what Co
// says next — EVI's own model phrases the next question from
// missing_topics, this only reports coverage; the text channel instead
// feeds missing_topics into its own reply-generation prompt directly.
// priorContext (optional) — a compact summary of what's already known about
// this person from BEFORE this conversation (prior calls/texts, e.g.
// callContext.ts's buildContextSummary or sendblue.ts's own profile
// summary). Without this, coverage was judged purely off the live
// transcript, so a topic already answered by text last week still came back
// "missing"
// on a call today and Co would re-ask something it already knew — this lets
// already-known, concrete facts count as covered without requiring the
// person to repeat themselves.
export async function assessConversationCoverage(
  transcriptSoFar: string,
  priorContext?: string,
): Promise<CoverageAssessment> {
  if (!transcriptSoFar.trim() && !priorContext?.trim()) return COVERAGE_FALLBACK;

  const topicList = RAPPORT_TOPICS.map((t) => `- ${t}: ${RAPPORT_TOPIC_DESCRIPTIONS[t]}`).join("\n");
  const priorContextBlock = priorContext?.trim()
    ? `What's already known about this person from before this conversation (prior calls/texts):\n"${priorContext.trim()}"\n\n`
    : "";

  try {
    const { text: raw } = await generateText({
      model: anthropic(NARROW_MODEL),
      prompt: `${priorContextBlock}Transcript of an in-progress conversation so far between Co (an assistant) and a person, by phone or text:
"${transcriptSoFar.trim() || "(nothing said yet in this conversation)"}"

Which of these topics has the person substantively addressed — either in what's already known from before, or in this conversation so far? Judge by real, concrete information. A topic only counts as covered by prior context if it states something specific and substantive, not a vague hint.
${topicList}

Return ONLY valid JSON, no preamble or markdown:
{"missing_topics": [...topic keys not yet covered...], "ready_to_summarize": true|false}

ready_to_summarize is true only if at most one or two minor topics remain missing, AND this conversation itself (not just prior context) has substantively happened — never mark it true based on prior context alone with nothing yet said in this conversation.`,
      experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.assessConversationCoverage" },
    });

    const clean = raw.trim();
    const parsed = parseModelJson(clean);
    const missing = Array.isArray(parsed.missing_topics)
      ? parsed.missing_topics.filter((t: unknown): t is RapportTopic =>
          RAPPORT_TOPICS.includes(t as RapportTopic),
        )
      : [...RAPPORT_TOPICS];

    return { missing_topics: missing, ready_to_summarize: Boolean(parsed.ready_to_summarize) };
  } catch (err) {
    console.error("assessConversationCoverage failed, falling back to nothing-covered:", err);
    return COVERAGE_FALLBACK;
  }
}

// Priority order for WHICH missing topic to actually ask about — deliberately
// not RAPPORT_TOPICS' own declaration order. A gap in goals_challenges or
// long_term_direction feeds Stage 3's matching directly (goal_embeddings /
// trajectory_embedding); a gap in personality or boundaries_preferences is
// lower-value rapport color. Only ever consulted when picking ONE topic for
// a single-question nudge (text replies, check-ins) — the live call's own
// tool response still returns the full missing_topics list, since EVI (not
// this file) decides what to ask next during a live conversation.
const RAPPORT_TOPIC_PRIORITY: RapportTopic[] = [
  "goals_challenges",
  "long_term_direction",
  "looking_for",
  "people_to_meet",
  "ways_to_help",
  "current_situation",
  "major_transition",
  "location_availability",
  "personality",
  "boundaries_preferences",
];

// Merges newly-confirmed topics into co_profiles.topics_covered — called
// both by getCoverageNudge below (text/check-in) and directly by the Hume
// tool_call handler (co.ts) after a live call's own coverage check, so a
// topic confirmed on a call is remembered for text too, not just the other
// way around. jsonb `||` merge (not a full read-modify-write) so concurrent
// callers can't clobber each other. Fire-and-forget/non-fatal, same as every
// other best-effort profile write in this file.
export function persistCoveredTopics(userId: string, coverage: CoverageAssessment): void {
  const missing = new Set(coverage.missing_topics);
  const covered = RAPPORT_TOPICS.filter((t) => !missing.has(t));
  if (!covered.length) return;
  const patch: Partial<Record<RapportTopic, string>> = {};
  const now = new Date().toISOString();
  for (const t of covered) patch[t] = now;
  pool
    .query(
      `UPDATE co_profiles SET topics_covered = COALESCE(topics_covered, '{}'::jsonb) || $2::jsonb WHERE user_id = $1`,
      [userId, JSON.stringify(patch)],
    )
    .catch((err) => console.error("topics_covered update failed (non-fatal):", err));
}

// Records that Co actually asked about a topic (regardless of whether it
// gets answered) — callers invoke this only when a nudge is actually used in
// an outbound message, not just considered. Read by getCoverageNudge's
// anti-nag filter below.
export function markTopicAsked(userId: string, topic: RapportTopic): void {
  pool
    .query(
      `UPDATE co_profiles SET topics_asked = COALESCE(topics_asked, '{}'::jsonb) || jsonb_build_object($2::text, $3::text) WHERE user_id = $1`,
      [userId, topic, new Date().toISOString()],
    )
    .catch((err) => console.error("topics_asked update failed (non-fatal):", err));
}

export type CoverageNudgeProfile = {
  life_chapters?: string[] | null;
  goals?: string[] | null;
  blockers?: string[] | null;
  long_term_direction?: string | null;
  city?: string | null;
  topics_covered?: Record<string, string> | null;
  topics_asked?: Record<string, string> | null;
};

// Shared by sendblue.ts's reply-generation prompt and the Stage 5 check-in
// cron (jobs/index.ts) — one place owning "which single topic, if any,
// should Co work toward asking about right now." Skips the LLM call
// entirely once every RAPPORT_TOPICS entry is already persisted as covered
// (cheap, and keeps a complete profile from re-triggering this check
// forever). Otherwise runs assessConversationCoverage, persists whatever it
// newly confirms, filters out anything asked-but-dodged in the last
// ANTI_NAG_DAYS, and returns the single highest-priority topic left, if any.
// transcriptSoFar is "" for a check-in (no live transcript, judged purely
// off priorContext) and the recent conversation thread for a text reply.
const ANTI_NAG_DAYS = 14;
export async function getCoverageNudge(
  userId: string,
  transcriptSoFar: string,
  profile: CoverageNudgeProfile | null,
): Promise<{ missingTopic: RapportTopic | null }> {
  const topicsCovered = profile?.topics_covered ?? {};
  const topicsAsked = profile?.topics_asked ?? {};

  if (RAPPORT_TOPICS.every((t) => topicsCovered[t])) return { missingTopic: null };

  const priorContextParts = [
    profile?.life_chapters?.length ? `life chapter: ${profile.life_chapters.join(", ")}` : null,
    profile?.goals?.length ? `goals: ${profile.goals.join(", ")}` : null,
    profile?.blockers?.length ? `blockers: ${profile.blockers.join(", ")}` : null,
    profile?.long_term_direction ? `long-term direction: ${profile.long_term_direction}` : null,
    profile?.city ? `city: ${profile.city}` : null,
  ].filter((p): p is string => Boolean(p));

  const coverage = await assessConversationCoverage(
    transcriptSoFar,
    priorContextParts.length ? priorContextParts.join("; ") : undefined,
  ).catch(() => null);
  if (!coverage) return { missingTopic: null };

  persistCoveredTopics(userId, coverage);

  const cutoff = Date.now() - ANTI_NAG_DAYS * 24 * 60 * 60 * 1000;
  const candidates = coverage.missing_topics.filter((t) => {
    const askedAt = topicsAsked[t];
    return !askedAt || new Date(askedAt).getTime() < cutoff;
  });

  const missingTopic = RAPPORT_TOPIC_PRIORITY.find((t) => candidates.includes(t)) ?? null;
  return { missingTopic };
}


async function assessResolvedItems(
  transcript: string,
  existingGoals: string[],
  existingBlockers: string[],
  openAsks: { id: string; text: string }[] = [],
  userId: string | null = null,
): Promise<{ resolvedGoals: string[]; resolvedBlockers: string[]; resolvedAskIds: string[] }> {
  if (existingGoals.length === 0 && existingBlockers.length === 0 && openAsks.length === 0) {
    return { resolvedGoals: [], resolvedBlockers: [], resolvedAskIds: [] };
  }

  try {
    const askListBlock = openAsks.length
      ? `\nOpen asks (numbered):\n${openAsks.map((a, i) => `${i}. ${a.text}`).join("\n")}\n`
      : "";

    // Retiring something is a judgment with a side effect (it stops check-ins
    // and retires matches), so Sonnet 5, and every retirement must quote the
    // person's own words. gateResolutions (src/harness/profileWrite.ts)
    // rejects anything whose quote isn't really in the transcript or was
    // said by Co.
    const { text: raw } = await generateText({
      model: anthropic(PROFILE_JUDGMENT_MODEL),
      prompt: buildResolutionPrompt(transcript, existingGoals, existingBlockers, askListBlock),
      experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.assessResolvedItems" },
    });

    const gated = gateResolutionOutput(raw, transcript, existingGoals, existingBlockers, openAsks);
    if (gated.proposals.length) {
      await recordDecision({
        layer: 4,
        decision: "profile.write",
        userId,
        outcome: gated.accepted.length ? "act" : "skip",
        action: "retire_items",
        proposal: gated.proposals,
        checks: gated.checks,
        reason: `${gated.accepted.length} of ${gated.proposals.length} retirements supported by a quote`,
      });
    }

    return {
      resolvedGoals: gated.accepted.filter((p) => p.kind === "goal").map((p) => p.item),
      resolvedBlockers: gated.accepted.filter((p) => p.kind === "blocker").map((p) => p.item),
      resolvedAskIds: gated.accepted.filter((p) => p.kind === "ask").map((p) => p.item),
    };
  } catch (err) {
    console.error("assessResolvedItems failed (non-fatal):", err);
    return { resolvedGoals: [], resolvedBlockers: [], resolvedAskIds: [] };
  }
}

// Exported for evals/profile, which runs the real prompt and gate.
export function buildResolutionPrompt(
  transcript: string,
  existingGoals: string[],
  existingBlockers: string[],
  askListBlock: string,
): string {
  return `Here is what we already have on file for this person:
Goals: ${JSON.stringify(existingGoals)}
Blockers: ${JSON.stringify(existingBlockers)}
${askListBlock}
Based on this new transcript, which of the EXACT goals/blockers above (if any) has the person said is now achieved, resolved, or no longer relevant? Separately, which numbered open asks (if any) has the person said are now resolved, no longer needed, or no longer true? Only include something when the person clearly says so. Restating it, still wanting it, or Co mentioning it does not count. Leave it out if unclear.

For every item you include, copy the person's exact words that show it, verbatim from the transcript (at least a few words, from their line, not Co's).

Transcript:
"${transcript}"

Return ONLY valid JSON, reusing the exact original text for goals/blockers and the number for asks:
{"resolved_goals": [{"item": "...", "quote": "..."}], "resolved_blockers": [{"item": "...", "quote": "..."}], "resolved_asks": [{"index": 0, "quote": "..."}]}`;
}

export function gateResolutionOutput(
  raw: string,
  transcript: string,
  existingGoals: string[],
  existingBlockers: string[],
  openAsks: { id: string; text: string }[],
) {
  // Real gap found live, 2026-09-10: despite "Return ONLY valid JSON", the
  // model sometimes appends a "**Reasoning:**" section after the fenced
  // block. Extract the balanced {...} object instead of trusting fences.
  const clean = raw.trim();
  const parsed = parseModelJson(clean);
  const proposals: ProposedResolution[] = [
    ...(Array.isArray(parsed.resolved_goals) ? parsed.resolved_goals : []).map((g: any) => ({
      kind: "goal" as const,
      item: String(g?.item ?? ""),
      quote: String(g?.quote ?? ""),
    })),
    ...(Array.isArray(parsed.resolved_blockers) ? parsed.resolved_blockers : []).map((b: any) => ({
      kind: "blocker" as const,
      item: String(b?.item ?? ""),
      quote: String(b?.quote ?? ""),
    })),
    ...(Array.isArray(parsed.resolved_asks) ? parsed.resolved_asks : [])
      .filter((a: any) => Number.isInteger(a?.index) && a.index >= 0 && a.index < openAsks.length)
      .map((a: any) => ({ kind: "ask" as const, item: openAsks[a.index].id, quote: String(a?.quote ?? "") })),
  ];
  return { proposals, ...gateResolutions(proposals, { goals: existingGoals, blockers: existingBlockers, asks: openAsks }, transcript) };
}

// Proactive check-in call cadence — Hume's own voice prompt (Phase 4, Next
// Steps) asks how often they'd like Co to call back on its own; this reads
// the transcript afterward for a stated answer, the same narrow-classifier
// shape as assessResolvedItems above. Only ever returns a value when they
// actually said one — storeProfile below only writes it when non-null, so a
// call that never touches the subject doesn't silently reset an existing
// preference back to "unset."
async function extractCheckinCadencePreference(transcript: string): Promise<number | null> {
  try {
    const { text: raw } = await generateText({
      model: anthropic(NARROW_MODEL),
      prompt: `Here is a call transcript between Co and a caller. Near the end of the call, Co may have asked how often the caller would like Co to proactively call them to check in.

Transcript:
"${transcript}"

Did the caller state a preference for how often Co should proactively call them? If so, classify it as the closest of:
- "weekly" — roughly every week
- "biweekly" — roughly every two weeks, or anything looser but still wanting proactive calls (e.g. "every so often", "once in a while")
- "none" — they said not to call proactively, or said they'd rather just reach out themselves
- "unstated" — the topic never came up, or they didn't give a clear answer

Return ONLY valid JSON, no preamble: {"preference": "weekly" | "biweekly" | "none" | "unstated"}`,
      experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.extractCheckinCadencePreference" },
    });

    const clean = raw.trim();
    const parsed = parseModelJson(clean);
    switch (parsed.preference) {
      case "weekly":
        return 7;
      case "biweekly":
        return 14;
      case "none":
        return 0;
      default:
        return null;
    }
  } catch (err) {
    console.error("extractCheckinCadencePreference failed (non-fatal):", err);
    return null;
  }
}

// Step 2 — sanitizes against co_profiles' CHECK constraints and upserts.
// Each call's transcript only covers what that call happened to touch on, so
// list fields (life_chapters, activity_preferences, goals, blockers) are
// unioned with what's already on file rather than replaced — otherwise a
// goal mentioned on call 1 but not call 2 would silently vanish. Goals and
// blockers are then trimmed by assessResolvedItems so items the caller has
// since resolved don't accumulate forever. Scalar fields (social_energy,
// A city only replaces the one on file when their own words place them
// there. A city named as a target ("roles in NYC", "investors in NYC") is a
// preference, not a move.
const LIVES_THERE = [
  /\b(i(?:'m| am)?|we(?:'re| are)?)\s+(?:currently\s+)?(?:in|based in|living in|out here in|over in)\b/i,
  /\b(i|we)\s+(?:live|moved|relocated)\b/i,
  /\b(moving|relocating|heading|headed)\s+(?:to|out to|back to)\b/i,
  /\bbased (?:in|out of)\b/i,
  /\bmy (?:place|apartment|home|office) (?:is )?in\b/i,
  /\b(?:i(?:'m| am)?)\s+(?:from|back in)\b/i,
];

// Fixed 2026-09-17: this used to test the WHOLE transcript, Co's lines
// included — "assistant: I'm in your corner" or "we moved fast" (talking
// about the search, not a move) tripped LIVES_THERE just as easily as an
// actual move did, and a curly apostrophe ("I’m in NYC") or a dropped one
// ("im in sf") didn't match the straight-apostrophe-only pattern at all.
// Now: only the person's own lines count, curly/missing apostrophes are
// normalized first, and the phrase has to actually be followed by
// something place-like — not "the middle of raising" or "a meeting" — a
// short lowercase token (an abbreviation like "sf"/"nyc"), a capitalized
// word (a proper noun), or the stated new city itself.
function normalizeApostrophes(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/\bim\b/gi, "i'm");
}

// Words that can follow "I'm in"/"we moved"/etc. without naming a place —
// these keep a real move sentence ("I'm in NYC") distinguishable from one
// that only happens to use the same words ("I'm in the middle of raising").
const NON_PLACE_FOLLOWERS = new Set([
  "the", "a", "an", "my", "your", "his", "her", "our", "their", "this", "that",
  "some", "any", "not", "just", "still", "here", "there", "home", "back", "process",
]);

function placeLikeWordFollows(afterText: string, newCity: string): boolean {
  const m = afterText.trimStart().match(/^[A-Za-z0-9']+/);
  if (!m) return false;
  const firstRaw = m[0];
  const first = firstRaw.toLowerCase();
  // Check against the stated new city BEFORE the stopword list — a real
  // place can start with one ("The Bronx", "The Woodlands"); only fall back
  // to excluding stopwords once there's no direct name match to trust.
  const cityFirst = (newCity.trim().match(/^[A-Za-z0-9']+/)?.[0] ?? "").toLowerCase();
  if (cityFirst && first === cityFirst) return true; // names the stated city
  if (NON_PLACE_FOLLOWERS.has(first)) return false;
  if (/^[A-Z]/.test(firstRaw)) return true; // reads as a proper noun
  return firstRaw.length <= 3; // a short lowercase token reads as an abbreviation (sf, nyc, la)
}

function personsOwnLines(transcript: string): string {
  return transcript
    .split("\n")
    .filter((line) => /^user:/i.test(line.trim()))
    .map((line) => normalizeApostrophes(line.replace(/^user:\s*/i, "")))
    .join(" ");
}

export function cityChangeAllowed(existingCity: string | null, newCity: string | null, transcript: string): boolean {
  if (!newCity) return false;
  if (!existingCity) return true; // nothing to protect yet
  if (newCity.trim().toLowerCase() === existingCity.trim().toLowerCase()) return true;

  const ownWords = personsOwnLines(transcript);
  for (const re of LIVES_THERE) {
    const m = re.exec(ownWords);
    if (!m) continue;
    const after = ownWords.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (placeLikeWordFollows(after, newCity)) return true;
  }
  return false;
}

// connection_style, availability_pattern, city) are the model's holistic
// read of the latest call and take precedence, but fall back to the existing
// value when this call's extraction came back empty. emotional_state is
// deliberately NOT carried forward — it describes the caller's state as of
// *this* call, so a call with no signal just clears it.
// hume_chat_group_id is intentionally not handled here — it's a call-resume
// concern specific to the Twilio/Hume webhook path, not part of extraction.
const PROFILE_STOPWORDS = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "for", "with", "on", "at", "their", "his", "her", "my", "more", "other"]);
function listWords(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !PROFILE_STOPWORDS.has(w)));
}
function nearDuplicate(a: string, b: string): boolean {
  const wa = listWords(a);
  const wb = listWords(b);
  if (!wa.size || !wb.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.min(wa.size, wb.size) >= 0.75;
}

// Newest items win, near-duplicates of an item already kept are dropped,
// and the list is capped. Exported for evals.
export function mergeProfileList(existing: string[] | null | undefined, fresh: string[] | null | undefined, cap: number): string[] {
  const out: string[] = [];
  for (const item of [...(fresh ?? []), ...(existing ?? [])]) {
    const t = item?.trim();
    if (!t || out.some((kept) => nearDuplicate(kept, t))) continue;
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

// Complaints about Co ("lack of information from Co") aren't the person's
// blockers. "co-founder" is not Co.
export function isAboutCo(item: string): boolean {
  return /\bco(?!-)\b|\bco's\b|\bcopatible\b/i.test(item);
}

export async function storeProfile(
  user_id: string,
  extracted: ExtractedProfile,
  transcript: string,
  opts: { emotions?: { name: string; score: number }[] | null } = {},
): Promise<{ safeChapters: string[]; safeStyle: string }> {
  const { rows: existingRows } = await pool.query(
    `SELECT life_chapters, social_energy, connection_style, activity_preferences,
            goals, blockers, availability_pattern, city, long_term_direction
     FROM co_profiles WHERE user_id = $1`,
    [user_id],
  );
  const existing = existingRows[0] ?? null;

  const union = (oldArr: string[] | null | undefined, newArr: string[] | null | undefined) => [
    ...new Set([...(oldArr ?? []), ...(newArr ?? [])]),
  ];

  // Co Loop Stage 6 — fold in whatever open asks (Stage 5) this person has,
  // so the same resolution pass that clears a stale goal/blocker can also
  // retire a relevance_edges row and stop further check-ins on an ask that's
  // already resolved.
  const { rows: openAskRows } = await pool.query(
    `SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL`,
    [user_id],
  );
  const openAsks = openAskRows.map((r: any) => ({ id: r.ask_id as string, text: r.ask_text as string }));

  const { resolvedGoals, resolvedBlockers, resolvedAskIds } = await assessResolvedItems(
    transcript,
    existing?.goals ?? [],
    existing?.blockers ?? [],
    openAsks,
    user_id,
  );

  // Layer 4 gate: every model value is checked against allowed enums and
  // ranges before it can reach the upsert.
  const { profile: clean, checks: sanitizeChecks } = sanitizeExtractedProfile(extracted);
  if (sanitizeChecks.length) {
    await recordDecision({
      layer: 4,
      decision: "profile.write",
      userId: user_id,
      outcome: "act",
      action: "sanitize_extraction",
      proposal: extracted,
      checks: sanitizeChecks,
      reason: "dropped invalid extracted values",
    });
  }

  const safeChapters = union(existing?.life_chapters, clean.life_chapters);
  const safeStyle = clean.connection_style ?? existing?.connection_style ?? "small_group";
  // Newest first, near-duplicates collapsed, capped: these lists used to only
  // grow (one tester reached 126 goals and 115 blockers, most rewordings).
  const activityPreferences = mergeProfileList(existing?.activity_preferences, clean.activity_preferences, 15);
  const goals = mergeProfileList(existing?.goals, clean.goals, 12).filter((g) => !resolvedGoals.includes(g));
  const blockers = mergeProfileList(existing?.blockers, (clean.blockers ?? []).filter((b) => !isAboutCo(b)), 10).filter(
    (b) => !resolvedBlockers.includes(b) && !isAboutCo(b),
  );
  const socialEnergy = clean.social_energy ?? existing?.social_energy ?? 50;
  const availabilityPattern = clean.availability_pattern || existing?.availability_pattern || null;
  // Where they live only changes when they actually said so (Royce,
  // 2026-09-16: "founding engineer roles in NYC" moved his city from San
  // Francisco to NYC, and every event search went to the wrong coast).
  const cityAllowed = cityChangeAllowed(existing?.city ?? null, clean.city ?? null, transcript);
  const city = cityAllowed ? clean.city || existing?.city || null : (existing?.city ?? null);
  if (clean.city && existing?.city && clean.city !== existing.city) {
    await recordDecision({
      layer: 4,
      decision: "profile.city",
      userId: user_id,
      outcome: cityAllowed ? "act" : "skip",
      action: cityAllowed ? "moved" : "kept_existing",
      proposal: { from: existing.city, to: clean.city },
      checks: [{ name: "they_said_they_live_there", pass: cityAllowed, reason: cityAllowed ? "their own words place them there" : "named as a preference, not a move" }],
    }).catch(() => {});
  }
  const longTermDirection = clean.long_term_direction || existing?.long_term_direction || null;

  // Non-fatal like every other embedding call in this file (storeTranscriptMemory,
  // captureIntent) — an embedding-provider hiccup (rate limit, quota, network)
  // must never block the profile write itself, which is what the caller
  // actually needs. A null embedding here just means this profile doesn't
  // participate in goal-similarity matching until the next successful call.
  // Recomputed from the merged goal list so it stays in sync with `goals`.
  let goalEmbedding: number[] | null = null;
  if (goals.length > 0) {
    try {
      goalEmbedding = await generateGoalEmbedding(goals);
    } catch (err) {
      console.error("Goal embedding failed (non-fatal):", err);
    }
  }

  // Same non-fatal reasoning as goalEmbedding above, recomputed from
  // longTermDirection so it stays in sync — see Co Loop Stage 1.
  let trajectoryEmbedding: number[] | null = null;
  if (longTermDirection) {
    try {
      trajectoryEmbedding = await generateEmbedding(longTermDirection);
    } catch (err) {
      console.error("Trajectory embedding failed (non-fatal):", err);
    }
  }

  await pool.query(
    `INSERT INTO co_profiles (
      user_id, life_chapters, social_energy, connection_style,
      activity_preferences, emotional_state, goals, blockers,
      availability_pattern, city, goal_embeddings, long_term_direction,
      trajectory_embedding, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      life_chapters = EXCLUDED.life_chapters,
      social_energy = EXCLUDED.social_energy,
      connection_style = EXCLUDED.connection_style,
      activity_preferences = EXCLUDED.activity_preferences,
      emotional_state = EXCLUDED.emotional_state,
      goals = EXCLUDED.goals,
      blockers = EXCLUDED.blockers,
      availability_pattern = EXCLUDED.availability_pattern,
      city = EXCLUDED.city,
      goal_embeddings = EXCLUDED.goal_embeddings,
      long_term_direction = EXCLUDED.long_term_direction,
      trajectory_embedding = EXCLUDED.trajectory_embedding,
      updated_at = NOW()`,
    [
      user_id,
      safeChapters,
      socialEnergy,
      safeStyle,
      activityPreferences,
      // Only from what the conversation showed, never one voice moment
      // (a single awkward second set this to "awkward").
      clean.emotional_state ?? null,
      goals,
      blockers,
      availabilityPattern,
      city,
      goalEmbedding ? `[${goalEmbedding.join(",")}]` : null,
      longTermDirection,
      trajectoryEmbedding ? `[${trajectoryEmbedding.join(",")}]` : null,
    ],
  );

  // Co Loop Stage 6 — close the loop back to Stages 3 and 5. A resolved ask
  // retires its relevance_edges rows (proof that Stage 3's call didn't need
  // to be acted on to be right) and stops further Stage 5 check-ins on it.
  if (resolvedAskIds.length) {
    await pool.query(
      `UPDATE ask_checkins SET resolved_at = NOW() WHERE user_id = $1 AND ask_id = ANY($2::text[])`,
      [user_id, resolvedAskIds],
    );
    await pool.query(
      `UPDATE relevance_edges SET status = 'retired', retired_at = NOW(),
        retired_reason = 'ask resolved independently, no intro made'
       WHERE person_id = $1 AND ask_id = ANY($2::text[]) AND status = 'open'`,
      [user_id, resolvedAskIds],
    );
  }

  // Separate conditional write, same reasoning as resolvedAskIds above —
  // most calls never touch this subject, and a null/unstated result here
  // must never silently reset an already-captured preference back to unset.
  // 0 (explicitly declined) is a real, distinct value from null (never
  // asked) — checked with !== null, not a truthy check.
  const cadenceDays = await extractCheckinCadencePreference(transcript);
  if (cadenceDays !== null) {
    await pool.query(`UPDATE co_profiles SET checkin_call_cadence_days = $2 WHERE user_id = $1`, [
      user_id,
      cadenceDays,
    ]);
  }

  return { safeChapters, safeStyle };
}

// Stores the raw transcript as a co_memories row, same shape used by both the
// Hume webhook (which has emotions/audio_url) and typed-intake (which has
// neither — they just default to NULL, identical to omitting the columns).
export async function storeTranscriptMemory(
  user_id: string,
  transcript: string,
  opts: { emotionalContext?: unknown; audioUrl?: string | null } = {},
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO co_memories (user_id, memory_type, content, emotional_context, audio_url)
     VALUES ($1, 'call_transcript', $2, $3, $4) RETURNING id`,
    [
      user_id,
      transcript,
      opts.emotionalContext !== undefined ? JSON.stringify(opts.emotionalContext) : null,
      opts.audioUrl ?? null,
    ],
  );
  const memoryId = rows[0].id;

  generateEmbedding(transcript)
    .then((emb) =>
      pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
        `[${emb.join(",")}]`,
        memoryId,
      ]),
    )
    .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

  return memoryId;
}

type CapturedIntentData = {
  ask: { text: string; type: "seeking" | "offering" } | null;
  concrete_preferences: string[];
  wants: string[];
  availability: string | null;
};

// Ambient intent capture — one Haiku pass, extended (not duplicated) to
// also pull named concrete preferences, things mentioned as missed/wanted,
// and stated availability, alongside the original seeking/offering ask.
// Recommendation and Event both depend on this data existing with real
// specificity — a vague vibe isn't enough to act on. Returns the extracted
// record (or null if literally nothing was found) so callers that want it
// synchronously (co-test's post-call view) can display it; the production
// call sites (co.ts) still call this fire-and-forget and ignore the
// resolved value, unchanged.
// Exported so evals/capture can check what counts as an ask.
export function captureIntentPrompt(transcript: string): string {
  return `Read this transcript and extract four things. Only include what's actually stated by the user (the "user:" lines) — never guess or infer beyond what's said, and never treat something Co (the "assistant:" lines) said as if the user said it.

1. ask — something specific they are actively seeking or could offer to others (a connection, an introduction, a resource, expertise, a kind of event or community). One clear sentence, classified as 'seeking' or 'offering'. Take it from the LAST user message, using the earlier conversation only to understand it. null when the last message isn't asking for or offering something: small talk, thanks, feedback about Co, questions about Co itself ("how can you improve?", "anything you need to ask me?"), logistics, or answers to Co's questions about them.
2. concrete_preferences — named, specific things they mentioned liking or wanting, not vague vibes. A specific gym or workout style, a coffee/drink preference, a type of venue or neighborhood, a specific activity. "SoulCycle", "oat milk lattes", "speakeasy-style bars" — not "fitness" or "good coffee".
3. wants — things they said they miss or want to find (a running group, a book club, a version of something from a previous city).
4. availability — their stated GENERAL, RECURRING availability pattern, in their own words (e.g. "weekday evenings", "usually free on weekends"). A one-off request for a specific call or meeting at a specific time ("call me at 2pm today", "can we talk Thursday morning") is NOT a recurring availability pattern — leave this null for those, even if a specific time or day appears in the transcript. Only fill this in when they're describing when they're generally free, not when they want THIS ONE call to happen.

Return ONLY valid JSON, no preamble:
{"ask": {"text": "Looking for climate tech founders at $1M+ ARR", "type": "seeking"} or null, "concrete_preferences": ["..."], "wants": ["..."], "availability": "..." or null}

Transcript:
"${transcript}"`;
}

export async function captureIntent(
  user_id: string,
  transcript: string,
): Promise<ExtractedIntent | null> {
  try {
    const { text: rawIntent } = await propagateAttributes(
      { userId: user_id, traceName: "profileExtraction.captureIntent" },
      () =>
        generateText({
          model: anthropic(NARROW_MODEL),
          experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.captureIntent" },
          prompt: captureIntentPrompt(transcript),
        }),
    );

    const clean = rawIntent.trim();
    if (!clean) return null;

    let parsed: CapturedIntentData | null = null;
    try {
      parsed = parseModelJson(clean);
    } catch {
      return null;
    }

    const ask = parsed?.ask?.text && parsed?.ask?.type ? parsed.ask : null;
    const concrete_preferences = Array.isArray(parsed?.concrete_preferences) ? parsed!.concrete_preferences : [];
    const wants = Array.isArray(parsed?.wants) ? parsed!.wants : [];
    const availability = typeof parsed?.availability === "string" ? parsed!.availability : null;

    // Nothing real came out of this pass at all — don't write an empty
    // record just to have one.
    if (!ask && !concrete_preferences.length && !wants.length && !availability) return null;

    // Embedding covers the ask sentence when present (what goal-similarity
    // matching would compare against); falls back to the richest available
    // text so a record with no ask still gets a usable embedding.
    const embeddingSource = ask?.text || [...concrete_preferences, ...wants].join("; ") || availability || "";
    const embedding = embeddingSource ? await generateEmbedding(embeddingSource).catch(() => null) : null;

    // Layer 4 gate (src/harness/profileWrite.ts): a restated ask updates the
    // open ask it repeats instead of opening another one. Every capture used
    // to mint a new intent id, so one tester ended up with 90 ask rows.
    let intentId: string = crypto.randomUUID();
    let deduped = false;
    let existingIntent: any[] = [];
    if (ask) {
      const [{ rows: openRows }, { rows: profileRows }] = await Promise.all([
        pool.query(`SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL`, [user_id]),
        pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [user_id]),
      ]);
      existingIntent = Array.isArray(profileRows[0]?.intent) ? profileRows[0].intent : [];
      const openAsks: OpenAsk[] = openRows.map((r: any) => ({
        askId: r.ask_id,
        text: r.ask_text,
        embedding: existingIntent.find((i: any) => i?.id === r.ask_id)?.embedding ?? null,
      }));
      let decision = decideAskWrite({ text: ask.text, embedding }, openAsks);
      let judged: boolean | null = null;
      if (decision.action === "needs_judgment") {
        const match = openAsks.find((a) => a.askId === (decision as { askId: string }).askId)!;
        judged = await judgeSameAsk(user_id, ask.text, match.text);
        decision = judged
          ? { action: "update_existing", askId: match.askId, similarity: decision.similarity, checks: decision.checks, reason: `model: same ask as "${match.text}"` }
          : { action: "open_new", checks: decision.checks, reason: `model: different from "${match.text}"` };
      }
      if (decision.action === "update_existing") {
        intentId = decision.askId;
        deduped = true;
      }
      await recordDecision({
        layer: 4,
        decision: "profile.write",
        userId: user_id,
        outcome: "act",
        action: deduped ? "update_existing_ask" : "open_new_ask",
        proposal: { ask, judged },
        checks: decision.checks,
        reason: decision.reason,
      });
    }

    const newIntent: ExtractedIntent = {
      id: intentId,
      ...(ask ? { text: ask.text, type: ask.type } : {}),
      concrete_preferences,
      wants,
      availability,
      status: "active",
      embedding,
      created_at: new Date().toISOString(),
    };

    if (deduped) {
      // Replace the restated entry in place (latest wording wins, preferences
      // merged) and keep it last so getActiveSeekingAsk still picks it.
      const prior = existingIntent.find((i: any) => i?.id === intentId) ?? {};
      const merged: ExtractedIntent = {
        ...newIntent,
        created_at: prior.created_at ?? newIntent.created_at,
        concrete_preferences: [...new Set([...(prior.concrete_preferences ?? []), ...concrete_preferences])],
        wants: [...new Set([...(prior.wants ?? []), ...wants])],
        availability: availability ?? prior.availability ?? null,
      };
      Object.assign(newIntent, merged);
      const rest = existingIntent.filter((i: any) => i?.id !== intentId);
      await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [
        user_id,
        JSON.stringify([...rest, merged]),
      ]);
      // Restating an ask renews its time limit (services/askExpiry.ts).
      const renewedUntil = await askExpiresAtForUser(user_id, ask!.text).catch(() => null);
      await pool.query(
        `UPDATE ask_checkins SET ask_text = $3, expires_at = COALESCE($4::timestamptz, expires_at) WHERE user_id = $1 AND ask_id = $2`,
        [user_id, intentId, ask!.text, renewedUntil],
      );
    } else {
      // Upsert, not a plain UPDATE — the call/typed-intake path is the only
      // other place a co_profiles row gets created (storeProfile), so a
      // text-only user who has never called would otherwise have no row for
      // this to update against and the ask would silently vanish.
      await pool.query(
        `INSERT INTO co_profiles (user_id, intent, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           intent = COALESCE(co_profiles.intent, '[]'::jsonb) || EXCLUDED.intent,
           updated_at = NOW()`,
        [user_id, JSON.stringify([newIntent])],
      );
    }

    const memParts = [
      ask ? `${ask.type}: ${ask.text}` : null,
      concrete_preferences.length ? `preferences: ${concrete_preferences.join(", ")}` : null,
      wants.length ? `wants: ${wants.join(", ")}` : null,
      availability ? `availability: ${availability}` : null,
    ].filter(Boolean);
    const memContent = `Co captured intent — ${memParts.join(" | ")}`;
    const mem = await pool.query(
      `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'intent', $2) RETURNING id`,
      [user_id, memContent],
    );
    generateEmbedding(memContent)
      .then((emb) =>
        pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
          `[${emb.join(",")}]`,
          mem.rows[0].id,
        ]),
      )
      .catch((err) => console.error("Intent memory embedding failed:", err));

    // Co Loop Stage 5 — start the check-in cadence for a genuinely new ask
    // (see ask_checkins in migrations.ts and the check-in cron in
    // jobs/index.ts). The NOT EXISTS guard stays as a backstop for two
    // captures of the same text racing each other.
    if (ask && !deduped) {
      const expiresAt = await askExpiresAtForUser(user_id, ask.text).catch(() => null);
      await pool
        .query(
          `INSERT INTO ask_checkins (user_id, ask_id, ask_text, expires_at)
           SELECT $1::uuid, $2::text, $3::text, $4::timestamptz
           WHERE NOT EXISTS (
             SELECT 1 FROM ask_checkins
             WHERE user_id = $1 AND resolved_at IS NULL AND lower(trim(ask_text)) = lower(trim($3))
           )
           ON CONFLICT (user_id, ask_id) DO NOTHING`,
          [user_id, intentId, ask.text, expiresAt],
        )
        .catch((err) => console.error("ask_checkins insert failed (non-fatal):", err));
    }

    // Co Loop Stage 3 — a fresh "seeking" ask is exactly what filterByStatedAsk
    // reasons over, so sweep it against the whole network immediately rather
    // than waiting for the next daily sweepAllOpenAsks run. A restated ask
    // waits for the daily sweep. A fresh "offering" gets the mirrored
    // reverse sweep — otherwise it would only ever surface as a side-effect
    // of someone else's seeking sweep.
    if (ask?.type === "seeking" && !deduped) {
      sweepAskAgainstNetwork(user_id).catch((err) =>
        console.error("sweepAskAgainstNetwork failed (non-fatal):", err),
      );
      // Luma/X event surfacing moved off this instant-fire-on-every-ask path
      // (Royce, 2026-08-30 — "needs to surface periodically") onto
      // jobs/index.ts's cadence cron instead — see eventSurfacingSweep.ts.
    } else if (ask?.type === "offering" && !deduped) {
      sweepOfferingAgainstNetwork(user_id).catch((err) =>
        console.error("sweepOfferingAgainstNetwork failed (non-fatal):", err),
      );
    }

    lastCaptureDeduped.set(newIntent.id, deduped);
    return newIntent;
  } catch (err: any) {
    console.error("captureIntent failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

const lastCaptureDeduped = new Map<string, boolean>();

// Borderline similarity only: is the new wording the same request as the
// open ask? A wrong "yes" hides a real new ask, so this is a Sonnet 5 call.
export async function judgeSameAsk(userId: string | null, newText: string, openText: string): Promise<boolean> {
  try {
    const { text } = await generateText({
      model: anthropic(PROFILE_JUDGMENT_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.judgeSameAsk", metadata: { userId: userId ?? "" } },
      prompt: sameAskPrompt(newText, openText),
    });
    return /"same"\s*:\s*true/.test(text);
  } catch (err: any) {
    // Can't tell: opening a separate ask is the safer mistake.
    console.error("judgeSameAsk failed (non-fatal, treating as different):", err?.message ?? err);
    return false;
  }
}

export function sameAskPrompt(newText: string, openText: string): string {
  return `Someone already has this open request with Co: "${openText}"
They just said they're looking for: "${newText}"

Is the new one the same request restated (same kind of thing, same purpose, maybe more detail or different wording)? Or a different request (a different kind of person, thing, or goal)? A narrower or more specific version of the same request counts as the same.

Return ONLY valid JSON: {"same": true} or {"same": false}`;
}

export type TurnAsk = { ask: { text: string; type: "seeking" | "offering" }; askId: string; deduped: boolean };

// Same-turn hook for the reply section (see the header of
// src/harness/profileWrite.ts). Waits up to timeoutMs for the capture; the
// capture itself always runs to completion.
export async function captureIntentForTurn(
  userId: string,
  transcript: string,
  opts: { timeoutMs?: number } = {},
): Promise<TurnAsk | null> {
  const capture = captureIntent(userId, transcript);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? 2500));
  const intent = await Promise.race([capture, timeout]);
  if (!intent?.text || !intent.type) return null;
  return { ask: { text: intent.text, type: intent.type }, askId: intent.id, deduped: lastCaptureDeduped.get(intent.id) ?? false };
}

type CapturedEventMentionData = {
  event_name: string | null;
  event_date: string | null; // resolved ISO date (YYYY-MM-DD), or null
  event_location: string | null;
};

// "Nudge Co users at events Co doesn't own" — same shape as captureIntent
// (one Haiku pass, only what's actually stated, embedding on the richest
// text), extracting a planned event mention instead of an ask. The model
// resolves relative dates ("Thursday", "next week") against today's date
// itself rather than a separate date-parsing step — genuinely ambiguous ones
// come back null rather than a guessed date, since a wrong date would
// silently break the date-window matching in eventMatching.ts.
export async function extractPlannedEventMention(user_id: string, transcript: string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { text: raw } = await propagateAttributes(
      { userId: user_id, traceName: "profileExtraction.extractPlannedEventMention" },
      () =>
        generateText({
          model: anthropic(NARROW_MODEL),
          experimental_telemetry: { isEnabled: true, functionId: "profileExtraction.extractPlannedEventMention" },
          prompt: `Read this transcript. Only include what the user (the "user:" lines) actually stated — never guess or infer, never treat something Co said as if the user said it.

Did the user mention a specific real-world event they're planning to attend (a conference, meetup, party, gathering — not a vague "I should get out more")? If so extract:
1. event_name — however they described it, in their own words.
2. event_date — resolve this to an ISO date (YYYY-MM-DD) using today's date, ${today}, as the reference point. Only fill this in if you can confidently resolve it (a specific day, or an unambiguous relative reference like "this Thursday"). null if too vague ("sometime next month", no date mentioned at all) — do not guess.
3. event_location — city or venue if mentioned, else null.

Return ONLY valid JSON, no preamble:
{"event_name": "..." or null, "event_date": "YYYY-MM-DD" or null, "event_location": "..." or null}

Transcript:
"${transcript}"`,
        }),
    );

    const clean = raw.trim();
    if (!clean) return;

    let parsed: CapturedEventMentionData | null = null;
    try {
      parsed = parseModelJson(clean);
    } catch {
      return;
    }
    if (!parsed?.event_name) return;

    const embeddingSource = [parsed.event_name, parsed.event_location].filter(Boolean).join(", ");
    const embedding = await generateEmbedding(embeddingSource).catch(() => null);
    if (!embedding) return; // matching depends entirely on the embedding — no point storing without one

    const { rows } = await pool.query(
      `INSERT INTO planned_event_mentions (user_id, event_name_raw, event_date, event_location, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       RETURNING id`,
      [user_id, parsed.event_name, parsed.event_date, parsed.event_location, `[${embedding.join(",")}]`],
    );

    // Immediately check for other Co users who mentioned roughly the same
    // event — same "capture, then sweep right away" pattern captureIntent
    // uses for sweepAskAgainstNetwork above, rather than waiting on a batch job.
    const { matchAndScoreEventMention } = await import("./eventMatching.js");
    matchAndScoreEventMention(rows[0].id).catch((err: any) =>
      console.error("matchAndScoreEventMention failed (non-fatal):", err?.message ?? err),
    );
  } catch (err: any) {
    console.error("extractPlannedEventMention failed (non-fatal):", err?.message ?? err);
  }
}

// Luma/X event surfacing used to live here as an instant fire-on-every-ask
// function (surfaceMatchingLumaEvent). Moved 2026-08-30 to
// eventSurfacingSweep.ts's attemptEventSurfacing, driven by a periodic cron
// (jobs/index.ts) instead — see that file for why.
