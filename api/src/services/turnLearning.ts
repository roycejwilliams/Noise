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
import { recordAdvice } from "./advice.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { mightBeCorrection, PROFILE_JUDGMENT_MODEL } from "../harness/profileWrite.js";
import { parseModelJson } from "./modelJson.js";
import {
  persistIntentFrom,
  storePlannedEventMention,
  storeProfile,
  type CapturedEventMentionData,
  type CapturedIntentData,
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
  openAsks: { id: string; text: string }[];
  styleNotes: string[];
  coSaidBefore: string | null;
}): string {
  const fileLines = o.onFile
    ? Object.entries(o.onFile)
        .filter(([, v]) => (Array.isArray(v) ? v.length : v))
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n")
    : "";
  return `Read one text exchange between Co (an assistant, "assistant" lines) and a person ("user" lines), and extract everything below in one pass. Only what the PERSON said (the "user" lines) can fill anything. Something Co suggested, asked about, or offered is never the person's own goal, blocker, preference, ask, plan or activity unless the person's own reply actually confirms it. Never guess or infer beyond what's said.

Transcript (oldest first; the last "user" line is what they just said):
"${o.transcript}"

What they just said: "${o.message}"
Today's date: ${o.today}

What Co already has on file about them:
${fileLines || "(nothing yet)"}
${o.openAsks.length ? `\nOpen asks (numbered):\n${o.openAsks.map((a, i) => `${i}. ${a.text}`).join("\n")}\n` : ""}
1. profile: psychographic fields from the whole transcript.
  - life_chapters: applicable values from new_to_city, building_solo, career_pivot, starting_over.
  - social_energy: a number 0-100 (0 = very introverted, 100 = very extroverted), or null if their own words gave no real signal; never guess a number.
  - connection_style: one of small_group, medium_group, large_social.
  - activity_preferences: activities they mentioned or implied enjoying.
  - goals: things they are working toward.
  - blockers: challenges or struggles in their life they mentioned (never frustrations with Co itself).
  - availability_pattern: how often and when they want to connect (e.g. "weekday evenings").
  - city: ONLY where they live now or are actually moving to ("I'm in Oakland", "moving to Austin next month"). Never a city that only comes up as a preference or target ("roles in NYC", "investors in NYC", "events in Miami"). Empty string if they didn't say.
  - emotional_state: one word for their current emotional state (e.g. anxious, energized, overwhelmed, motivated, isolated, confident, focused, excited, lost, burnout).
  - long_term_direction: a sentence capturing their longer-term personal and career direction, distinct from immediate goals. Empty string if not discussed.

2. resolved: which of the EXACT on-file goals or blockers has the person said is now achieved, resolved, or no longer relevant, and which numbered open asks they said are now resolved, no longer needed, or no longer true. Only when the person clearly says so; restating it, still wanting it, or Co mentioning it does not count. For each, copy the person's exact words that show it, verbatim from the transcript (at least a few words, from their line, not Co's). Reuse the exact on-file text for goals and blockers and the number for asks.

3. corrections: in what they just said, do they correct or contradict something on file? Only a real correction: they say an item is wrong, no longer true, or has changed ("I'm not a founder", "I moved to Oakland", "I don't run anymore"). A new detail that doesn't contradict anything isn't a correction; a goal they achieved isn't a correction either. Don't guess from tone. For each: the field, the EXACT on-file text it replaces (for a list, the one item), what's true now if they said it (otherwise null), and their exact words from what they just said (at least a few words).

4. cadence: did they state how often Co should proactively call them? "weekly" (roughly every week), "biweekly" (every two weeks or looser but still wanting calls), "none" (don't call proactively), or "unstated" (never came up or no clear answer).

5. intent, taken from what they just said, using the earlier conversation only to understand it (anything they asked for before is context they already said, not a new ask):
  - asks: at most one specific thing they're actively seeking or could offer others (a connection, an introduction, a resource, expertise, a kind of event or community), as one clear sentence, typed "seeking" or "offering"; none at all when what they just said isn't asking for or offering something. Never an ask: small talk, thanks, feedback about Co, questions about Co itself, logistics, or answers to Co's questions about them.
  - concrete_preferences: named, specific things they mentioned liking or wanting, not vague vibes ("SoulCycle", "oat milk lattes", "speakeasy-style bars", not "fitness" or "good coffee").
  - wants: things they said they miss or want to find.
  - availability: their stated GENERAL, RECURRING availability in their own words; null for a one-off request for a specific call or meeting time.

6. planned_event: did the user mention a specific real-world event they're planning to attend (a conference, meetup, party, gathering, not a vague "I should get out more")? event_name in their own words; event_date resolved to YYYY-MM-DD from today's date only when you can resolve it confidently (a specific day or an unambiguous "this Thursday"), else null, never a guess; event_location as city or venue if mentioned, else null. All null if none.

7. style: Co keeps a short list of how this person likes Co to text them.
Current notes:
${o.styleNotes.length ? o.styleNotes.map((n) => `- ${n}`).join("\n") : "(none)"}
Co's message right before theirs: "${(o.coSaidBefore ?? "").slice(0, 600)}"
Only change the notes if what they just said makes clear how they want Co to text them: length, directness, detail, questions, tone, emoji, timing, what to lead with ("just tell me", "shorter please", "stop asking so many questions", "more detail", "that's not what I need, focus on X"). A normal reply is not a preference. Never note anything about their life or plans here, only how Co should text them. If something changes, return the full updated list (at most ${MAX_NOTES}, each a short instruction to Co, newest last; drop any older note the new one contradicts).

8. advice: this one is about Co's own last message (the assistant line), not the person's. Did it give real advice or a plan on something specific in the person's life: a decision, a pitch, a hard conversation, a set of steps? Not for event picks, facts, small talk, a plain question, or a feeling met without advice. If yes: {"topic": "a few words", "gist": "what Co advised, in one sentence"}. Otherwise null.

Return ONLY valid JSON, no preamble:
{"profile": {"life_chapters": [], "social_energy": null, "connection_style": "", "activity_preferences": [], "goals": [], "blockers": [], "availability_pattern": "", "city": "", "emotional_state": "", "long_term_direction": ""},
 "resolved": {"resolved_goals": [{"item": "...", "quote": "..."}], "resolved_blockers": [{"item": "...", "quote": "..."}], "resolved_asks": [{"index": 0, "quote": "..."}]},
 "corrections": [{"field": "...", "old": "...", "new": "..." or null, "quote": "..."}],
 "cadence": "weekly" | "biweekly" | "none" | "unstated",
 "intent": {"asks": [{"text": "...", "type": "seeking"}], "concrete_preferences": [], "wants": [], "availability": null},
 "planned_event": {"event_name": null, "event_date": null, "event_location": null},
 "style": {"changed": false} or {"changed": true, "notes": ["..."]},
 "advice": null or {"topic": "...", "gist": "..."}}`;
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
    };
  } catch {
    return null;
  }
}

// Background, after the reply. Non-fatal throughout.
export async function learnFromTextTurn(input: TurnLearningInput): Promise<TurnLearning | null> {
  const started = Date.now();
  // The same transcript the separate calls read before.
  const transcript = `${input.recentConversation}\nuser: ${input.message}\nassistant: ${input.coReply}`.trim();
  try {
    const [{ rows: profileRows }, { rows: askRows }] = await Promise.all([
      pool.query(
        `SELECT city, life_chapters, goals, blockers, activity_preferences, long_term_direction, availability_pattern, texting_style
         FROM co_profiles WHERE user_id = $1`,
        [input.userId],
      ),
      pool.query(`SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL`, [input.userId]),
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
    const openAsks = askRows.map((r: any) => ({ id: String(r.ask_id), text: String(r.ask_text) }));
    const styleNotes: string[] = Array.isArray(row?.texting_style) ? row.texting_style : [];

    const { text } = await generateText({
      model: anthropic(PROFILE_JUDGMENT_MODEL),
      maxOutputTokens: 2500,
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
    await Promise.all([
      storeProfile(input.userId, learned.profile as any, transcript, {
        newWords: input.message,
        // Nothing on file to retire: the old check didn't run at all then.
        precomputed: {
          resolutionRaw: onFile?.goals.length || onFile?.blockers.length || openAsks.length ? JSON.stringify(learned.resolved ?? {}) : "{}",
          openAsks,
          correctionsRaw,
          cadence: learned.cadence,
        },
      }).catch((err: any) => console.error("turnLearning: profile write failed (non-fatal):", err?.message ?? err)),
      persistIntentFrom(input.userId, learned.intent, transcript, "last_user_message").catch((err: any) =>
        console.error("turnLearning: intent write failed (non-fatal):", err?.message ?? err),
      ),
      storePlannedEventMention(input.userId, learned.planned_event).catch((err: any) =>
        console.error("turnLearning: planned event write failed (non-fatal):", err?.message ?? err),
      ),
      input.coSaidBefore?.trim() && row
        ? applyStyleUpdate(input.userId, styleNotes, learned.style, input.message).catch(() => null)
        : Promise.resolve(null),
      // The advice Co gave in this reply, so it can ask how it went later.
      // Same note the noteAdvice tool writes; a repeat topic is skipped.
      learned.advice ? recordAdvice(input.userId, learned.advice.topic, learned.advice.gist).catch(() => false) : Promise.resolve(false),
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
