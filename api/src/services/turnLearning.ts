// Learning from a text turn in one read (Royce, 2026-09-28: "fewer layers,
// one shared picture of the moment"; phase 4 of the reply-path restructure).
// After each text, seven background model calls used to re-read the same
// turn: profile extraction, resolved goals/asks, corrections, call cadence,
// ask capture, planned events, and texting style. This is one call returning
// all of it, and every result still goes through the same gates and writes
// as before (storeProfile's city guard, sanitizing, merge caps and
// correction history; quoted resolutions and corrections; the ask dedupe
// and same-ask judgment; the planned-event embedding and match; the style
// notes merge). The call path (routes/co.ts) keeps its own pipeline.
import { withoutTeammateLines } from "./teamLines.js";
import { recordAdvice } from "./advice.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { LIFE_CHAPTERS_RULE, mightBeCorrection, PROFILE_JUDGMENT_MODEL } from "../harness/profileWrite.js";
import { parseModelJson } from "./modelJson.js";
import {
  ANSWERED_INTEREST_RULE,
  openItemsBlock,
  persistIntentFrom,
  RELATED_DROP_JSON,
  RELATED_DROP_RULE,
  storePlannedEventMention,
  storeProfile,
  type CapturedEventMentionData,
  type CapturedIntentData,
  type OpenItem,
} from "./profileExtraction.js";
import { applyStyleUpdate, MAX_NOTES } from "./textingStyle.js";

export type TurnLearningInput = {
  userId: string;
  // "User said: / Co replied:" lines before this turn, as the reply saw them.
  recentConversation: string;
  message: string; // what they just said
  coReply: string; // what Co replied
  coSaidBefore: string | null; // Co's line right before their message, for style
};

type OnFileProfile = {
  city: string | null;
  life_chapters: string[];
  goals: string[];
  blockers: string[];
  activity_preferences: string[];
  long_term_direction: string | null;
  availability_pattern: string | null;
};

export function turnLearningPrompt(o: {
  transcript: string;
  message: string;
  today: string;
  onFile: OnFileProfile | null;
  openAsks: OpenItem[];
  styleNotes: string[];
  coSaidBefore: string | null;
}): string {
  const fileLines = o.onFile
    ? Object.entries(o.onFile)
        .filter(([, v]) => (Array.isArray(v) ? v.length : v))
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n")
    : "";
  return `Read one text exchange between Cue (an assistant, "assistant" lines) and a person ("user" lines), and extract everything below in one pass. Only what the PERSON said (the "user" lines) can fill anything. Something Cue suggested, asked about, or offered is never the person's own goal, blocker, preference, ask, plan or activity unless the person's own reply actually confirms it. Never guess or infer beyond what's said.

Transcript (oldest first; the last "user" line is what they just said):
"${o.transcript}"

What they just said: "${o.message}"
Today's date: ${o.today}

What Cue already has on file about them:
${fileLines || "(nothing yet)"}
${openItemsBlock(o.openAsks)}
1. profile: psychographic fields from the whole transcript.
  - ${LIFE_CHAPTERS_RULE}
  - social_energy: a number 0-100 (0 = very introverted, 100 = very extroverted), or null if their own words gave no real signal; never guess a number.
  - connection_style: one of small_group, medium_group, large_social.
  - activity_preferences: activities they mentioned or implied enjoying.
  - goals: things they are working toward.
  - goals and activity_preferences come only from what they say about themselves or want for themselves, never from the subject of a one-off request (research, a document, advice, a single search): "find me venues for my launch party" alone is not a goal or an interest; "I'm launching in November, find me venues" gives the goal "launch in November".
  - blockers: challenges or struggles in their life they mentioned (never frustrations with Cue itself).
  - availability_pattern: how often and when they want to connect (e.g. "weekday evenings").
  - city: ONLY where they live now or are actually moving to ("I'm in Oakland", "moving to Austin next month"). Never a city that only comes up as a preference or target ("roles in NYC", "investors in NYC", "events in Miami"). Empty string if they didn't say.
  - emotional_state: one word for their current emotional state (e.g. anxious, energized, overwhelmed, motivated, isolated, confident, focused, excited, lost, burnout).
  - long_term_direction: a sentence capturing their longer-term personal and career direction, distinct from immediate goals. Empty string if not discussed.

2. resolved: which of the EXACT on-file goals or blockers has the person said is now achieved, resolved, or no longer relevant, and which numbered items they said are now resolved, no longer needed, or no longer true. Only when the person clearly says so; restating it, still wanting it, or Cue mentioning it does not count. ${RELATED_DROP_RULE} For each, copy the person's exact words that show it, verbatim from the transcript (at least a few words, from their line, not Cue's). Reuse the exact on-file text for goals and blockers and the number for numbered items.

3. corrections: in what they just said, do they correct or contradict something on file? Only a real correction: they say an item is wrong, no longer true, or has changed ("I'm not a founder", "I moved to Oakland", "I don't run anymore"). A new detail that doesn't contradict anything isn't a correction; a goal they achieved isn't a correction either. Don't guess from tone. For each: the field, the EXACT on-file text it replaces (for a list, the one item), what's true now if they said it (otherwise null), and their exact words from what they just said (at least a few words).

4. cadence: did they state how often Cue should proactively call them? "weekly" (roughly every week), "biweekly" (every two weeks or looser but still wanting calls), "none" (don't call proactively), or "unstated" (never came up or no clear answer).

5. intent, taken from what they just said, using the earlier conversation only to understand it (anything they asked for before is context they already said, not a new ask):
  - asks: at most one specific thing they're actively seeking or could offer others (a connection, an introduction, a resource, expertise, a kind of event or community), as one clear sentence, typed "seeking" or "offering"; none at all when what they just said isn't asking for or offering something. Never an ask: small talk, thanks, feedback about Cue, questions about Cue itself, logistics, or answers to Cue's questions about them. ${ANSWERED_INTEREST_RULE}
  - concrete_preferences: named, specific things they mentioned liking or wanting, not vague vibes ("SoulCycle", "oat milk lattes", "speakeasy-style bars", not "fitness" or "good coffee").
  - wants: things they said they miss or want to find.
  - availability: their stated GENERAL, RECURRING availability in their own words; null for a one-off request for a specific call or meeting time.

6. planned_event: did the user mention a specific real-world event they're planning to attend (a conference, meetup, party, gathering, not a vague "I should get out more")? event_name in their own words; event_date resolved to YYYY-MM-DD from today's date only when you can resolve it confidently (a specific day or an unambiguous "this Thursday"), else null, never a guess; event_location as city or venue if mentioned, else null. Only when they say outright that they are going (an RSVP, "I'm going", "signed up", "got tickets", "see you there"); a question about an event (what to bring, where it is), something Cue offered, or an event you would have to infer is none. quote: their exact words that say they are going, copied from their line. All null if none.

7. style: Cue keeps a short list of how this person likes Cue to text them.
Current notes:
${o.styleNotes.length ? o.styleNotes.map((n) => `- ${n}`).join("\n") : "(none)"}
Cue's message right before theirs: "${(o.coSaidBefore ?? "").slice(0, 600)}"
Only change the notes if what they just said makes clear how they want Cue to text them: length, directness, detail, questions, tone, emoji, timing, what to lead with ("just tell me", "shorter please", "stop asking so many questions", "more detail", "that's not what I need, focus on X"). A normal reply is not a preference. Never note anything about their life or plans here, only how Cue should text them. If something changes, return the full updated list (at most ${MAX_NOTES}, each a short instruction to Cue, newest last; drop any older note the new one contradicts).

8. advice: this one is about Cue's own LAST line (the final "assistant" line), not the person's words and not earlier lines. Does that last line tell the person what to do about something specific in their life: how to handle a decision, a pitch, a hard conversation, or steps for a plan? Advice is any suggestion of an approach or a set of steps ("start by...", "I'd...", "bring a number", "say it early"), even when it ends with a question. It is not advice when the line only gives facts or event details, names events, answers a yes/no fact question, makes small talk, or only asks a question. If it is advice: {"topic": "a few words", "gist": "what Cue advised, in one sentence"}. Otherwise null.

9. met_someone: did the person say, in their own words in their LAST message, that they met someone at an event (a person they talked to, got a contact from, hit it off with)? If yes, a short quote of exactly their words saying it. Otherwise null. Not for people they already knew, and not for plans to meet someone.

Return ONLY valid JSON, no preamble:
{"profile": {"life_chapters": [], "social_energy": null, "connection_style": "", "activity_preferences": [], "goals": [], "blockers": [], "availability_pattern": "", "city": "", "emotional_state": "", "long_term_direction": ""},
 "resolved": {"resolved_goals": [{"item": "...", "quote": "..."}], "resolved_blockers": [{"item": "...", "quote": "..."}], "resolved_asks": [{"index": 0, "quote": "..."}], ${RELATED_DROP_JSON}},
 "corrections": [{"field": "...", "old": "...", "new": "..." or null, "quote": "..."}],
 "cadence": "weekly" | "biweekly" | "none" | "unstated",
 "intent": {"asks": [{"text": "...", "type": "seeking"}], "concrete_preferences": [], "wants": [], "availability": null},
 "planned_event": {"event_name": null, "event_date": null, "event_location": null, "quote": null},
 "style": {"changed": false} or {"changed": true, "notes": ["..."]},
 "advice": null or {"topic": "...", "gist": "..."},
 "met_someone": null or "their exact words"}`;
}

export type TurnLearning = {
  profile: Record<string, unknown>;
  resolved: unknown;
  corrections: unknown[];
  cadence: unknown;
  intent: CapturedIntentData | null;
  planned_event: CapturedEventMentionData | null;
  style: { changed?: boolean; notes?: unknown } | null;
  // What Co advised in this reply, when it did (services/advice.ts).
  advice: { topic: string; gist: string } | null;
  // Their words saying they met someone at an event (the morning report counts it).
  metSomeone: string | null;
};

export function parseTurnLearning(text: string): TurnLearning | null {
  try {
    const p = parseModelJson<any>(text);
    if (!p || typeof p !== "object") return null;
    return {
      profile: p.profile && typeof p.profile === "object" ? p.profile : {},
      resolved: p.resolved ?? {},
      corrections: Array.isArray(p.corrections) ? p.corrections : [],
      cadence: p.cadence ?? "unstated",
      intent: p.intent && typeof p.intent === "object" ? p.intent : null,
      planned_event: p.planned_event && typeof p.planned_event === "object" ? p.planned_event : null,
      style: p.style && typeof p.style === "object" ? p.style : null,
      advice: p.advice && typeof p.advice.topic === "string" && typeof p.advice.gist === "string" ? { topic: p.advice.topic, gist: p.advice.gist } : null,
      metSomeone: typeof p.met_someone === "string" && p.met_someone.trim() ? p.met_someone.trim().slice(0, 200) : null,
    };
  } catch {
    return null;
  }
}

// Pure: the turn's transcript, as every learning read sees it: the thread's log ("User said:" / "Co replied:" lines; the caller leaves
// out teammate lines), then their message and Co's reply (services/askSplit.ts exchangeFromTranscript reads both forms).
export function turnTranscript(thread: string, message: string, coReply: string): string {
  return `${thread}\nuser: ${message}\nassistant: ${coReply}`.trim();
}

// Background, after the reply. Non-fatal throughout.
export async function learnFromTextTurn(input: TurnLearningInput): Promise<TurnLearning | null> {
  const started = Date.now();
  // The same transcript the separate calls read before.
  const transcript = turnTranscript(withoutTeammateLines(input.recentConversation), input.message, input.coReply);
  try {
    const [{ rows: profileRows }, { rows: askRows }] = await Promise.all([
      pool.query(
        `SELECT city, life_chapters, goals, blockers, activity_preferences, long_term_direction, availability_pattern, texting_style
         FROM co_profiles WHERE user_id = $1`,
        [input.userId],
      ),
      import("./goalJourney.js").then((m) => m.openErrandsAndGoals(input.userId)).then((rows) => ({ rows })),
    ]);
    const row = profileRows[0] ?? null;
    const onFile: OnFileProfile | null = row
      ? {
          city: row.city ?? null,
          life_chapters: row.life_chapters ?? [],
          goals: row.goals ?? [],
          blockers: row.blockers ?? [],
          activity_preferences: row.activity_preferences ?? [],
          long_term_direction: row.long_term_direction ?? null,
          availability_pattern: row.availability_pattern ?? null,
        }
      : null;
    const openAsks: OpenItem[] = askRows.map((r: any) => ({ id: String(r.ask_id), text: String(r.ask_text), kind: r.kind }));
    const styleNotes: string[] = Array.isArray(row?.texting_style) ? row.texting_style : [];

    const { text } = await generateText({
      model: anthropic(PROFILE_JUDGMENT_MODEL),
      // 2026-09-29: at the default effort the model spent up to 2500 tokens
      // reasoning before writing, and about half of the reads on a real profile
      // were cut off (finish=length) and dropped, taking 17 to 36 seconds.
      // Medium finishes in about 9s and still finds the advice Co gave; low was
      // fast but missed two of three.
      maxOutputTokens: 5000,
      providerOptions: { anthropic: { effort: "medium" } },
      experimental_telemetry: { isEnabled: true, functionId: "turnLearning.learn" },
      prompt: turnLearningPrompt({
        transcript,
        message: input.message,
        today: new Date().toISOString().slice(0, 10),
        onFile,
        openAsks,
        styleNotes,
        coSaidBefore: input.coSaidBefore,
      }),
    });
    const learned = parseTurnLearning(text);
    if (!learned) {
      console.error("turnLearning: couldn't read the model's output (non-fatal)");
      return null;
    }

    // Same gates and writes as the separate calls. Corrections still only
    // count when what they just said can be a correction (mightBeCorrection).
    const correctionsRaw = JSON.stringify({ corrections: mightBeCorrection(input.message) ? learned.corrections : [] });
    // The ask first, so the profile write knows what kind of ask this turn carried (lane moves, Royce 2026-10-13): a one-off ask
    // (research, a document, advice, a single search) never becomes a goal or an interest: the extraction's rule (profile, goals) and,
    // for its exact restatement, code (laneMoves.ts turnAskLane, profileExtraction.ts heldAsOneOff).
    const written = await persistIntentFrom(input.userId, learned.intent, transcript, "last_user_message", input.message).catch((err: any) => {
      console.error("turnLearning: intent write failed (non-fatal):", err?.message ?? err);
      return null;
    });
    // Couldn't read it: the extraction's own rule stands, nothing is held in code (review, 2026-10-13: fail open, never into holding).
    const turnAsk = await import("./laneMoves.js").then((L) => L.turnAskLane(input.userId, written)).catch((err: any) => {
      console.error("turnLearning: reading the turn's ask failed (non-fatal):", err?.message ?? err);
      return null;
    });
    await Promise.all([
      storeProfile(input.userId, learned.profile as any, transcript, {
        newWords: input.message,
        turnAsk,
        // Nothing on file to retire: the old check didn't run at all then.
        precomputed: {
          resolutionRaw: onFile?.goals.length || onFile?.blockers.length || openAsks.length ? JSON.stringify(learned.resolved ?? {}) : "{}",
          openAsks,
          correctionsRaw,
          cadence: learned.cadence,
        },
      }).catch((err: any) => console.error("turnLearning: profile write failed (non-fatal):", err?.message ?? err)),
      storePlannedEventMention(input.userId, learned.planned_event, input.message).catch((err: any) =>
        console.error("turnLearning: planned event write failed (non-fatal):", err?.message ?? err),
      ),
      input.coSaidBefore?.trim() && row
        ? applyStyleUpdate(input.userId, styleNotes, learned.style, input.message).catch(() => null)
        : Promise.resolve(null),
      // The advice Co gave in this reply, so it can ask how it went later.
      // The only place advice is recorded (the noteAdvice tool fired 1 time in 8 and was removed, 2026-09-30); a repeat topic is skipped.
      learned.advice ? recordAdvice(input.userId, learned.advice.topic, learned.advice.gist).catch(() => false) : Promise.resolve(false),
      // They said they met someone: on their most recent Co event, only if the quote is theirs.
      learned.metSomeone && metQuoteIsTheirs(learned.metSomeone, input.message) ? recordMetSomeone(input.userId, learned.metSomeone).catch(() => null) : Promise.resolve(null),
    ]);
    await recordDecision({
      layer: 4,
      decision: "profile.turnLearning",
      userId: input.userId,
      outcome: "act",
      action: "learned",
      proposal: { ms: Date.now() - started, asks: learned.intent?.asks ?? [], plannedEvent: learned.planned_event?.event_name ?? null, styleChanged: !!learned.style?.changed },
    }).catch(() => {});
    return learned;
  } catch (err: any) {
    console.error("turnLearning failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

export function metQuoteIsTheirs(quote: string, message: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(quote);
  return q.length >= 4 && norm(message).includes(q);
}

// The Co event they were at in the last two days (asked about, texted before, or arrived).
export async function recordMetSomeone(userId: string, quote: string): Promise<string | null> {
  const { rows } = await pool.query(
    `UPDATE event_presence SET met_someone_at = NOW(), met_quote = $2
     WHERE (event_api_id, user_id) = (
       SELECT event_api_id, user_id FROM event_presence
       WHERE user_id = $1 AND met_someone_at IS NULL
         AND GREATEST(COALESCE(arrived_at, 'epoch'), COALESCE(pre_arrival_sent_at, 'epoch'), COALESCE(asked_at, 'epoch')) > NOW() - INTERVAL '48 hours'
       ORDER BY GREATEST(COALESCE(arrived_at, 'epoch'), COALESCE(pre_arrival_sent_at, 'epoch'), COALESCE(asked_at, 'epoch')) DESC LIMIT 1)
     RETURNING event_api_id`,
    [userId, quote.slice(0, 200)],
  );
  const eventId = rows[0]?.event_api_id ?? null;
  await recordDecision({ layer: 6, decision: "event.met_someone", userId, outcome: eventId ? "act" : "skip", action: eventId ? "recorded" : "no_recent_event", proposal: { eventId } }).catch(() => {});
  return eventId;
}
