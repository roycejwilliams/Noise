// Learning from a call in one read (Royce, 2026-09-28, "On calls: what should
// carry over": the text side's merged learning, and lessons from pushback in
// both directions). After a call, five model calls used to re-read the same
// transcript: profile extraction, resolved goals/asks, corrections, call
// cadence, and planned events. This is one call returning all of it, plus the
// moments they corrected Co itself, saved as standing lessons (co_lesson) that
// texts and the next call both read. Every result goes through the same gates
// and writes as before: storeProfile (city guard, sanitizing, merge caps,
// correction history, quoted resolutions and corrections, cadence),
// storePlannedEventMention.
//
// Kept separate, on purpose:
// - Ask capture (captureIntent, whole-transcript scope): its "capture every
//   distinct ask, even one said early" rule and the filter that drops Co's own
//   words saved as their wants are tuned against evals/capture and
//   evals/calls; folding it in would weaken both.
// - The call summary for texts (summarizeCallForTextContext) and the audit
//   (callGrounding.ts): different jobs with their own evals.
//
// Throws when the read itself fails, so the call's pipeline marks it failed
// and a retry runs, exactly as the old awaited extraction did. An unreadable
// answer falls back to the old separate path rather than losing the call.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { LIFE_CHAPTERS_RULE, mightBeCorrection, PROFILE_JUDGMENT_MODEL } from "../harness/profileWrite.js";
import { parseModelJson } from "./modelJson.js";
import { extractPsychographicProfile, storePlannedEventMention, storeProfile } from "./profileExtraction.js";
import { parseTurnLearning, type TurnLearning } from "./turnLearning.js";

type OnFile = {
  city: string | null;
  life_chapters: string[];
  goals: string[];
  blockers: string[];
  activity_preferences: string[];
  long_term_direction: string | null;
  availability_pattern: string | null;
};

export function callLearningPrompt(o: {
  transcript: string;
  today: string;
  onFile: OnFile | null;
  openAsks: { id: string; text: string }[];
}): string {
  const fileLines = o.onFile
    ? Object.entries(o.onFile)
        .filter(([, v]) => (Array.isArray(v) ? v.length : v))
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n")
    : "";
  return `Read one phone call between Cue (an assistant, "assistant" lines) and a person ("user" lines), and extract everything below in one pass. The whole call is new: every "user" line counts. Only what the PERSON said (the "user" lines) can fill anything. Something Cue suggested, asked about, or offered is never the person's own goal, blocker, preference, plan or activity unless the person's own reply actually confirms it. Never guess or infer beyond what's said.

Transcript (oldest first):
"${o.transcript}"
Today's date: ${o.today}

What Cue already has on file about them:
${fileLines || "(nothing yet)"}
${o.openAsks.length ? `\nOpen asks (numbered):\n${o.openAsks.map((a, i) => `${i}. ${a.text}`).join("\n")}\n` : ""}
1. profile: psychographic fields from the whole call.
  - ${LIFE_CHAPTERS_RULE}
  - social_energy: a number 0-100 (0 = very introverted, 100 = very extroverted), or null if their own words gave no real signal this call; never guess a number.
  - connection_style: one of small_group, medium_group, large_social.
  - activity_preferences: activities they mentioned or implied enjoying.
  - goals: things they are working toward.
  - goals and activity_preferences come only from what they say about themselves or want for themselves, never from the subject of a one-off request (research, a document, advice, a single search): "find me venues for my launch party" alone is not a goal or an interest; "I'm launching in November, find me venues" gives the goal "launch in November".
  - blockers: challenges or struggles in their life they mentioned (never frustrations with Cue itself).
  - availability_pattern: how often and when they want to connect (e.g. "weekday evenings").
  - city: ONLY where they live now or are actually moving to ("I'm in Oakland", "moving to Austin next month"). Never a city that only comes up as a preference or target ("roles in NYC", "investors in NYC", "events in Miami"). Empty string if they didn't say.
  - emotional_state: one word for their current emotional state (e.g. anxious, energized, overwhelmed, motivated, isolated, confident, focused, excited, lost, burnout), from what the conversation showed, never one voice moment.
  - long_term_direction: a sentence capturing their longer-term personal and career direction, distinct from immediate goals. Empty string if not discussed.
  Write about them as "they", never "he" or "she", unless they said their pronouns on the call.

2. resolved: which of the EXACT on-file goals or blockers has the person said is now achieved, resolved, or no longer relevant, and which numbered open asks they said are now resolved, no longer needed, or no longer true. Only when the person clearly says so; restating it, still wanting it, or Cue mentioning it does not count. For each, copy the person's exact words that show it, verbatim from the transcript (at least a few words, from their line, not Cue's). Reuse the exact on-file text for goals and blockers and the number for asks.

3. corrections: anywhere in the call, did they correct or contradict something on file? Only a real correction: they say an item is wrong, no longer true, or has changed ("I'm not a founder", "I moved to Oakland", "I don't run anymore"). A new detail that doesn't contradict anything isn't a correction; a goal they achieved isn't a correction either. Don't guess from tone. For each: the field, the EXACT on-file text it replaces (for a list, the one item), what's true now if they said it (otherwise null), and their exact words (at least a few words, from their line).

4. cadence: near the end of a call Cue may ask how often they'd like Cue to call on its own. Did they state a preference? "weekly" (roughly every week), "biweekly" (roughly every two weeks, or anything looser but still wanting proactive calls, e.g. "every so often"), "none" (they said not to call proactively, or they'd rather reach out themselves), or "unstated" (it never came up, or no clear answer).

5. planned_event: did they mention a specific real-world event they're planning to attend (a conference, meetup, party, gathering, not a vague "I should get out more")? event_name in their own words; event_date resolved to YYYY-MM-DD from today's date only when you can resolve it confidently, else null, never a guess; event_location as city or venue if mentioned, else null. Only when they say outright that they are going (an RSVP, "I'm going", "signed up", "got tickets", "see you there"); a question about an event (what to bring, where it is), something Cue offered, or an event you would have to infer is none. quote: their exact words that say they are going, copied from their line. All null if none.

6. lessons: moments where they corrected or pushed back on Cue itself: something Cue said, assumed, suggested, or how Cue was talking to them ("that's not what I asked", "this has nothing to do with my event", "you already told me that", "slow down"). Not a correction of their own details (that's #3), and not disagreement with a normal answer. For each, one short standing note to Cue about how to be with them from now on, general enough to apply next time ("when he asks about logistics, answer the logistics; don't tie it to his own event"), and their exact words (at least a few words, from their line). None when there were none.

Return ONLY valid JSON, no preamble:
{"profile": {"life_chapters": [], "social_energy": null, "connection_style": "", "activity_preferences": [], "goals": [], "blockers": [], "availability_pattern": "", "city": "", "emotional_state": "", "long_term_direction": ""},
 "resolved": {"resolved_goals": [{"item": "...", "quote": "..."}], "resolved_blockers": [{"item": "...", "quote": "..."}], "resolved_asks": [{"index": 0, "quote": "..."}]},
 "corrections": [{"field": "...", "old": "...", "new": "..." or null, "quote": "..."}],
 "cadence": "weekly" | "biweekly" | "none" | "unstated",
 "planned_event": {"event_name": null, "event_date": null, "event_location": null, "quote": null},
 "lessons": [{"lesson": "...", "quote": "..."}]}`;
}

export type CallLesson = { lesson: string; quote: string };

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Pure: he/she and their forms become they/them/their, keeping a capital at the start of a word.
export function neutralPronouns(text: string): string {
  const swaps: [RegExp, string][] = [
    [/\b(he|she) is\b/gi, "they are"],
    [/\b(he|she) was\b/gi, "they were"],
    [/\b(he|she) has\b/gi, "they have"],
    [/\b(he|she)'s\b/gi, "they're"],
    [/\b(himself|herself)\b/gi, "themself"],
    [/\b(his|hers)\b/gi, "their"],
    [/\bher(?=\s+[a-z])/gi, "their"],
    [/\b(him|her)\b/gi, "them"],
    [/\b(he|she)\b/gi, "they"],
  ];
  let out = text;
  for (const [re, to] of swaps) out = out.replace(re, (m) => (m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
  return out;
}

// "They", never a guessed "he" or "she" (2026-09-22 rule; callContext.ts
// enforces the same on call summaries).
export function neutralLearning<T extends { profile: Record<string, unknown> }>(learned: T): T {
  const p = { ...learned.profile };
  for (const k of ["long_term_direction", "availability_pattern"]) {
    if (typeof p[k] === "string") p[k] = neutralPronouns(p[k] as string);
  }
  for (const k of ["goals", "blockers", "activity_preferences"]) {
    if (Array.isArray(p[k])) p[k] = (p[k] as unknown[]).map((x) => (typeof x === "string" ? neutralPronouns(x) : x));
  }
  return { ...learned, profile: p };
}

// Their own lines, as one string, for checking quotes.
export function theirLines(transcript: string): string {
  return transcript
    .split("\n")
    .filter((l) => /^user:/i.test(l.trim()))
    .map((l) => l.replace(/^user:\s*/i, ""))
    .join("\n");
}

// Pure: only lessons backed by their own words on the call are kept; the
// quote has to really be in a "user" line (code check, not the model's say).
export function callLessonsFrom(raw: unknown, transcript: string): string[] {
  const mine = squash(theirLines(transcript));
  const list = Array.isArray((raw as any)?.lessons) ? (raw as any).lessons : [];
  const out: string[] = [];
  for (const l of list) {
    const lesson = typeof l?.lesson === "string" ? l.lesson.trim().slice(0, 240) : "";
    const quote = typeof l?.quote === "string" ? squash(l.quote) : "";
    if (!lesson || quote.split(" ").length < 3 || !mine.includes(quote)) continue;
    if (!out.some((o) => squash(o) === squash(lesson))) out.push(lesson);
  }
  return out.slice(0, 3);
}

// Same store and dedupe as the text side's lessons (services/connectDots.ts
// saveLesson): one member's co_lesson rows, skipped when already there.
export async function saveCallLessons(userId: string, lessons: string[]): Promise<number> {
  if (!lessons.length) return 0;
  const { rows } = await pool
    .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'co_lesson' ORDER BY created_at DESC LIMIT 20`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  const had = new Set(rows.map((r: any) => squash(String(r.content))));
  let saved = 0;
  for (const lesson of lessons) {
    if (had.has(squash(lesson))) continue;
    await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'co_lesson', $2)`, [userId, lesson]);
    had.add(squash(lesson));
    saved++;
  }
  return saved;
}

export type CallLearning = TurnLearning & { lessons: string[] };

// The call's profile, resolutions, corrections, cadence, planned event and
// lessons from one read. Awaited by the call pipeline before it marks the call
// complete; throws on failure so the call is retried.
export async function learnFromCall(input: {
  userId: string;
  transcript: string; // the cleaned transcript (voicemail lines stripped)
}): Promise<CallLearning | null> {
  const started = Date.now();
  const [{ rows: profileRows }, { rows: askRows }] = await Promise.all([
    pool.query(
      `SELECT city, life_chapters, goals, blockers, activity_preferences, long_term_direction, availability_pattern
       FROM co_profiles WHERE user_id = $1`,
      [input.userId],
    ),
    import("./goalJourney.js").then((m) => m.openErrandsAndGoals(input.userId)).then((rows) => ({ rows })),
  ]);
  const row = profileRows[0] ?? null;
  const onFile: OnFile | null = row
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

  // No catch: a failed read fails the call's processing, which is retried.
  const { text } = await generateText({
    model: anthropic(PROFILE_JUDGMENT_MODEL),
    // Same cap problem as turnLearning (2026-09-29): reasoning at the default
    // effort used the budget before any JSON was written.
    maxOutputTokens: 6000,
    providerOptions: { anthropic: { effort: "medium" } },
    experimental_telemetry: { isEnabled: true, functionId: "callLearning.learn", metadata: { userId: input.userId } },
    prompt: callLearningPrompt({
      transcript: input.transcript,
      today: new Date().toISOString().slice(0, 10),
      onFile,
      openAsks,
    }),
  });
  const parsed = parseTurnLearning(text);
  const learned = parsed ? neutralLearning(parsed) : null;
  if (!learned) {
    // Unreadable: the old separate path, so the call is never lost.
    console.error("callLearning: couldn't read the model's output, using the separate calls (non-fatal)");
    const { extracted } = await extractPsychographicProfile(input.transcript);
    await storeProfile(input.userId, extracted, input.transcript);
    await recordDecision({ layer: 4, decision: "profile.callLearning", userId: input.userId, outcome: "skip", action: "fell_back", proposal: { ms: Date.now() - started } }).catch(() => {});
    return null;
  }
  let raw: unknown = null;
  try {
    raw = parseModelJson(text);
  } catch {}
  const lessons = callLessonsFrom(raw, input.transcript);

  // Same gates and writes as the separate calls. Corrections only count when
  // their words could be one (mightBeCorrection, as assessCorrections checks).
  const correctionsRaw = JSON.stringify({ corrections: mightBeCorrection(theirLines(input.transcript)) ? learned.corrections : [] });
  await storeProfile(input.userId, learned.profile as any, input.transcript, {
    precomputed: {
      // Nothing on file to retire: the old check had nothing to judge then either.
      resolutionRaw: onFile?.goals.length || onFile?.blockers.length || openAsks.length ? JSON.stringify(learned.resolved ?? {}) : "{}",
      openAsks,
      correctionsRaw,
      cadence: learned.cadence,
    },
  });
  // Non-blocking siblings, as before.
  storePlannedEventMention(input.userId, learned.planned_event, theirLines(input.transcript)).catch((err: any) =>
    console.error("callLearning: planned event write failed (non-fatal):", err?.message ?? err),
  );
  saveCallLessons(input.userId, lessons).catch((err: any) => console.error("callLearning: lesson write failed (non-fatal):", err?.message ?? err));
  await recordDecision({
    layer: 4,
    decision: "profile.callLearning",
    userId: input.userId,
    outcome: "act",
    action: "learned",
    proposal: { ms: Date.now() - started, plannedEvent: learned.planned_event?.event_name ?? null, lessons, cadence: learned.cadence },
  }).catch(() => {});
  return { ...learned, lessons };
}
