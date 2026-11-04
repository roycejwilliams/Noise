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
import { extractPsychographicProfile, openItemsBlock, RELATED_DROP_JSON, RELATED_DROP_RULE, storePlannedEventMention, storeProfile, type OpenItem } from "./profileExtraction.js";
import { parseTurnLearning, type TurnLearning } from "./turnLearning.js";
import { activePreferences, learnPreferences, markCadenceTwin, preferencePromptItem, PREFERENCE_JSON_SHAPE, type Preference } from "./memberPreferences.js";
import { localDay, memberZone } from "./memberTime.js";
import { ALREADY_KNOW_JSON, ALREADY_KNOW_RULE, alreadyKnowFrom, saveAlreadyKnow } from "./knownConnections.js";

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
  openAsks: OpenItem[];
  // Their rules on file and their local date (services/memberPreferences.ts): item 7, the same read as a text turn's item 10.
  preferences?: { onFile: Parameters<typeof preferencePromptItem>[0]["onFile"]; localToday: string };
  // First names of people Cue introduced them to or pointed them to at a Noise event (the outcome record). None: no section 8.
  introduced?: string[];
  // Their Noise event today, or the no-show question still open (services/preArrival.ts goingSubject). None: no going section.
  going?: import("./preArrival.js").GoingSubject | null;
}): string {
  const intros = (o.introduced ?? []).length > 0;
  const goingN = intros ? 9 : 8;
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
${openItemsBlock(o.openAsks)}
1. profile: psychographic fields from the whole call.
  - ${LIFE_CHAPTERS_RULE}
  - social_energy: a number 0-100 (0 = very introverted, 100 = very extroverted), or null if their own words gave no real signal this call; never guess a number.
  - connection_style: one of small_group, medium_group, large_social.
  - activity_preferences: activities they mentioned or implied enjoying.
  - goals: things they are working toward.
  - goals and activity_preferences come only from what they say about themselves or want for themselves, never from the subject of a one-off request (research, a document, advice, a single search): "find me venues for my launch party" alone is not a goal or an interest; "I'm launching in November, find me venues" gives the goal "launch in November".
  - blockers: challenges or struggles in their life they mentioned (never frustrations with Cue itself).
  - availability_pattern: how often and when they want to connect (e.g. "weekday evenings"): when they're free for things, never how often or when Cue may text or call them (that's item 7).
  - city: ONLY where they live now or are actually moving to ("I'm in Oakland", "moving to Austin next month"). Never a city that only comes up as a preference or target ("roles in NYC", "investors in NYC", "events in Miami"). Empty string if they didn't say.
  - emotional_state: one word for their current emotional state (e.g. anxious, energized, overwhelmed, motivated, isolated, confident, focused, excited, lost, burnout), from what the conversation showed, never one voice moment.
  - long_term_direction: a sentence capturing their longer-term personal and career direction, distinct from immediate goals. Empty string if not discussed.
  Write about them as "they", never "he" or "she", unless they said their pronouns on the call.

2. resolved: which of the EXACT on-file goals or blockers has the person said is now achieved, resolved, or no longer relevant, and which numbered items they said are now resolved, no longer needed, or no longer true. Only when the person clearly says so; restating it, still wanting it, or Cue mentioning it does not count. ${RELATED_DROP_RULE} For each, copy the person's exact words that show it, verbatim from the transcript (at least a few words, from their line, not Cue's). Reuse the exact on-file text for goals and blockers and the number for numbered items.

3. corrections: anywhere in the call, did they correct or contradict something on file? Only a real correction: they say an item is wrong, no longer true, or has changed ("I'm not a founder", "I moved to Oakland", "I don't run anymore"). A new detail that doesn't contradict anything isn't a correction; a goal they achieved isn't a correction either. Don't guess from tone. For each: the field, the EXACT on-file text it replaces (for a list, the one item), what's true now if they said it (otherwise null), and their exact words (at least a few words, from their line).

4. cadence: near the end of a call Cue may ask how often they'd like Cue to call on its own. Did they state a preference? "weekly" (roughly every week), "biweekly" (roughly every two weeks, or anything looser but still wanting proactive calls, e.g. "every so often"), "none" (they said not to call proactively, or they'd rather reach out themselves), or "unstated" (it never came up, or no clear answer).

5. planned_event: did they mention a specific real-world event they're planning to attend (a conference, meetup, party, gathering, not a vague "I should get out more")? event_name in their own words; event_date resolved to YYYY-MM-DD from today's date only when you can resolve it confidently, else null, never a guess; event_location as city or venue if mentioned, else null. Only when they say outright that they are going (an RSVP, "I'm going", "signed up", "got tickets", "see you there"); a question about an event (what to bring, where it is), something Cue offered, or an event you would have to infer is none. quote: their exact words that say they are going, copied from their line. All null if none.

6. lessons: moments where they corrected or pushed back on Cue itself: something Cue said, assumed, suggested, or how Cue was talking to them ("that's not what I asked", "this has nothing to do with my event", "you already told me that", "slow down"). Not a correction of their own details (that's #3), and not disagreement with a normal answer. For each, one short standing note to Cue about how to be with them from now on, general enough to apply next time ("when he asks about logistics, answer the logistics; don't tie it to his own event"), and their exact words (at least a few words, from their line). None when there were none.

${preferencePromptItem({ n: 7, via: "call", onFile: o.preferences?.onFile ?? [], localToday: o.preferences?.localToday ?? o.today })}

${introSection(o.introduced ?? [])}${goingSection(goingN, o.going ?? null)}${alreadyKnowSection(goingN + (o.going ? 1 : 0))}Return ONLY valid JSON, no preamble:
{"profile": {"life_chapters": [], "social_energy": null, "connection_style": "", "activity_preferences": [], "goals": [], "blockers": [], "availability_pattern": "", "city": "", "emotional_state": "", "long_term_direction": ""},
 "resolved": {"resolved_goals": [{"item": "...", "quote": "..."}], "resolved_blockers": [{"item": "...", "quote": "..."}], "resolved_asks": [{"index": 0, "quote": "..."}], ${RELATED_DROP_JSON}},
 "corrections": [{"field": "...", "old": "...", "new": "..." or null, "quote": "..."}],
 "cadence": "weekly" | "biweekly" | "none" | "unstated",
 "planned_event": {"event_name": null, "event_date": null, "event_location": null, "quote": null},
 "lessons": [{"lesson": "...", "quote": "..."}],
 ${PREFERENCE_JSON_SHAPE}${(o.introduced ?? []).length ? `,
 "introductions": [{"name": "...", "met": null, "useful": null, "kept_talking": null, "quote": "..."}]` : ""}${o.going ? `,
 "noise_event": {"going": null, "quote": null}` : ""},
 ${ALREADY_KNOW_JSON}}`;
}

// The last item, on every call (services/knownConnections.ts): people they say they already know, so Cue never introduces them as
// strangers. Numbered after the preferences item (7) and the introductions item (8) when there is one.
export const alreadyKnowSection = (n: number) => `${n}. already_know: ${ALREADY_KNOW_RULE}

`;

// Only for someone on the list for a Noise event today, or whose "did you make it?" is still open (Royce, 2026-11-03: "can't make it
// tonight" said on a call is recorded like a text). The prompt is unchanged for everyone else.
export function goingSection(n: number, g: import("./preArrival.js").GoingSubject | null): string {
  if (!g) return "";
  const what = g.kind === "today" ? `Cue's Noise event today${g.name ? `, "${g.name}"` : ""}` : `Cue's Noise event${g.name ? ` "${g.name}"` : ""}, which Cue asked whether they made it to`;
  const yes = g.kind === "today" ? `"yes" only if they themselves said they're going after all. ` : "";
  return `${n}. noise_event: they're on the list for ${what}. going: "no" only when the person says THEY themselves can't make it or didn't. Never for someone else ("my friend can't make it"), never for a condition or maybe ("might not", "if work runs late", "probably not"). ${yes}Otherwise null. quote: their exact words that say it, copied from their line.

`;
}
// Pure: what to record from that section, or why not (review of #380: a false "no" silently takes them out of that night's matching,
// the pre-arrival text and the brief). Only their own words (the quote is in their lines); only "no" for a no-show question; never
// when the sentence that says it hedges (might, maybe, may, if, probably, possibly, not sure, could) or is about someone else (a name,
// he/she/they, "my friend", "my partner" before the verb).
const HEDGE = /\b(?:might|maybe|may|if|probably|possibly|not sure|could(?!n'?t))\b/i;
const GOING_VERB = /\b(?:can'?t|cannot|can not|won'?t|couldn'?t|didn'?t|did not|not going|not gonna|not coming|unable|not make|going|coming|make it|be there)\b/i;
const OTHER_SUBJECT = /\b(?:he|she|they|his|her|their|my\s+\w+|our\s+\w+)\b/i;
// A capitalized word before the verb is a name (someone else), unless it's one of these sentence openers.
const OPENERS = new Set(["ugh", "oh", "hey", "sorry", "actually", "unfortunately", "honestly", "yeah", "yes", "no", "nope", "well", "so", "sadly", "hmm", "ah", "okay", "ok", "good", "bad", "news", "turns", "looks", "just", "man", "shoot", "dang", "tonight", "today", "really", "totally", "afraid"]);
export type CallGoingRead = { going: boolean | null; why: "none" | "not_theirs" | "hedged" | "not_them" | "not_today" | null };
export function readCallGoing(raw: unknown, transcript: string, g: import("./preArrival.js").GoingSubject | null): CallGoingRead {
  if (!g) return { going: null, why: "none" };
  const x = (raw as any)?.noise_event;
  const said = x?.going === "no" ? false : x?.going === "yes" ? true : null;
  if (said === null) return { going: null, why: "none" };
  if (said && g.kind !== "today") return { going: null, why: "not_today" };
  if (typeof x?.quote !== "string") return { going: null, why: "not_theirs" };
  const q = squash(x.quote);
  const lines = theirLines(transcript);
  if (q.split(" ").length < 2 || !squash(lines).includes(q)) return { going: null, why: "not_theirs" };
  // The sentence of theirs that holds the quote (the whole line when the quote runs across sentences).
  const pieces = lines.split("\n").flatMap((l) => [l, ...l.split(/(?<=[.!?])\s+/)]);
  const sentence = pieces.filter((p) => squash(p).includes(q)).sort((a, b) => a.length - b.length)[0] ?? "";
  if (HEDGE.test(sentence)) return { going: null, why: "hedged" };
  // Who it's about: the words before the verb, in the clause that holds it.
  const at = sentence.search(GOING_VERB);
  const before = (at >= 0 ? sentence.slice(0, at) : sentence).split(/[,;:]|\b(?:but|so|and|because)\b/i).pop() ?? "";
  if (OTHER_SUBJECT.test(before) || before.split(/[^A-Za-z']+/).some((w) => /^[A-Z][a-z]+$/.test(w) && !OPENERS.has(w.toLowerCase()))) return { going: null, why: "not_them" };
  return { going: said, why: null };
}
export function callGoingFrom(raw: unknown, transcript: string, g: import("./preArrival.js").GoingSubject | null): boolean | null {
  return readCallGoing(raw, transcript, g).going;
}

// The read's answer, recorded through the text tool's own path (services/preArrival.ts recordGoing). Never throws.
export async function saveCallGoing(userId: string, raw: unknown, transcript: string, g: import("./preArrival.js").GoingSubject | null): Promise<{ going: boolean | null; recorded: import("./preArrival.js").GoingSubject | null }> {
  const read = readCallGoing(raw, transcript, g);
  const going = read.going;
  // Turned down: nothing recorded, and the decision says why in a word, never their words.
  if (going === null) {
    if (g && read.why && read.why !== "none") await recordDecision({ layer: 4, decision: "profile.callGoing", userId, outcome: "skip", action: read.why, proposal: { eventId: g.eventApiId, kind: g.kind } }).catch(() => {});
    return { going, recorded: null };
  }
  const recorded = await import("./preArrival.js").then((P) => P.recordGoing(userId, going, g)).catch((err: any) => (console.error("callLearning: going write failed (non-fatal):", err?.message ?? err), null));
  return { going, recorded };
}

// Section 8, only for someone Cue has introduced (the prompt is unchanged for everyone else).
export function introSection(names: string[]): string {
  if (!names.length) return "";
  return `8. introductions: Cue introduced them to, or pointed them to at a Noise event, these people (first names): ${names.map((n) => `"${n}"`).join(", ")}. For each of them the person talks about on this call, what THE PERSON said: met ("yes" or "no", or null if they didn't say), useful (how meeting them was for the person: "yes", "somewhat" or "no", or null if they didn't say), kept_talking (whether they've seen or talked with them again since: "yes", "not_yet" or "no", or null if they didn't say), and their exact words (at least a few words, from their line). Only what the person said: never guess, and never fill a field from what Cue said or from silence. Leave out anyone they didn't talk about.

`;
}

export type CallIntroOutcome = { name: string; met: "yes" | "no" | null; useful: "yes" | "somewhat" | "no" | null; keptTalking: "yes" | "not_yet" | "no" | null };

// Pure: only answers about someone on the list (one first name, one person), each value from its own set, and only with a quote
// that is really in one of their lines (code check, not the model's say). A field they didn't fill stays null (unknown).
export function callIntroOutcomes(raw: unknown, transcript: string, names: string[]): CallIntroOutcome[] {
  const mine = squash(theirLines(transcript));
  const list = Array.isArray((raw as any)?.introductions) ? (raw as any).introductions : [];
  const known = new Map<string, string>();
  for (const n of names) known.set(n.trim().toLowerCase(), n);
  const pick = <T extends string>(v: unknown, set: readonly T[]): T | null => (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null);
  const out: CallIntroOutcome[] = [];
  for (const x of list) {
    const name = known.get(String(x?.name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "");
    const quote = typeof x?.quote === "string" ? squash(x.quote) : "";
    if (!name || quote.split(" ").length < 3 || !mine.includes(quote)) continue;
    const r: CallIntroOutcome = { name, met: pick(x.met, ["yes", "no"] as const), useful: pick(x.useful, ["yes", "somewhat", "no"] as const), keptTalking: pick(x.kept_talking, ["yes", "not_yet", "no"] as const) };
    if (!r.met && !r.useful && !r.keptTalking) continue;
    if (!out.some((o) => o.name === name)) out.push(r);
  }
  return out;
}

// Who they could be talking about: the people Cue pointed them to at its events and the people Cue introduced them to. A first name
// two of them share is left out (Cue can't tell which one they meant).
export async function introducedNames(userId: string): Promise<{ names: string[]; pairs: { pairId: number; otherId: string; firstName: string }[]; intros: import("./secondContact.js").Introduced[] }> {
  const [pairs, intros] = await Promise.all([
    import("./roomMatching.js").then((m) => m.pairsToldAbout(userId)).catch(() => []),
    import("./secondContact.js").then((m) => m.introducedTo(userId)).catch(() => []),
  ]);
  const byName = new Map<string, Set<string>>();
  const add = (first: string, id: string) => {
    const k = first.trim().toLowerCase();
    if (k) byName.set(k, (byName.get(k) ?? new Set()).add(id));
  };
  for (const p of pairs) add(p.firstName, p.otherId);
  for (const i of intros) add(i.firstName, i.otherId);
  const names: string[] = [];
  for (const p of [...pairs.map((p) => p.firstName), ...intros.map((i) => i.firstName)]) {
    const k = p.trim().toLowerCase();
    if (byName.get(k)?.size === 1 && !names.some((n) => n.toLowerCase() === k)) names.push(p.trim());
  }
  return { names: names.slice(0, 12), pairs, intros };
}

// What they said on the call about people Cue introduced, on their side of the outcome record (source "call", stated).
export async function saveCallIntroOutcomes(userId: string, said: CallIntroOutcome[], known: Awaited<ReturnType<typeof introducedNames>>, quoteOf: (name: string) => string | null = () => null): Promise<number> {
  const RM = await import("./roomMatching.js");
  const SC = await import("./secondContact.js");
  let n = 0;
  for (const s of said) {
    const k = s.name.toLowerCase();
    const pair = known.pairs.find((p) => p.firstName.trim().toLowerCase() === k);
    const intro = known.intros.find((i) => i.firstName.trim().toLowerCase() === k);
    if (pair && (s.met || s.useful)) {
      const outcome = s.met === "no" ? "did_not_meet" : s.useful === "yes" ? "met_good" : s.useful === "somewhat" ? "met_fine" : s.useful === "no" ? "met_not_a_fit" : null;
      if (outcome) await RM.notePairMet(userId, pair.pairId, outcome, quoteOf(s.name), "call");
      else await RM.notePairEvidence(userId, pair.pairId, "met", "yes", "call", "stated");
      n++;
    }
    if (s.keptTalking) {
      const outcome = s.keptTalking === "yes" ? "talked_again" : s.keptTalking === "not_yet" ? "not_yet" : "not_going_to";
      if (intro) await SC.recordSecondContact(userId, intro, outcome, null, new Date(), null, "call");
      else if (pair) await SC.notePairKeptTalking(userId, pair.otherId, outcome, "call");
      n++;
    }
  }
  return n;
}

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
  // The call's own id, the source a preference records.
  callRef?: string | null;
  // The live call's key ("gpt-live:<session>"): rules its mid-call reads already stored are never read again (callPreferences.ts).
  callKey?: string | null;
}): Promise<CallLearning | null> {
  const started = Date.now();
  // Mid-call reads still running finish first, so what they stored is on file for this read; the lines they covered are left out below.
  const unread = await import("./callPreferences.js").then((m) => m.unreadCallerLines(input.callKey, theirLines(input.transcript))).catch(() => null);
  const [{ rows: profileRows }, { rows: askRows }, prefs, zone] = await Promise.all([
    pool.query(
      `SELECT city, life_chapters, goals, blockers, activity_preferences, long_term_direction, availability_pattern
       FROM co_profiles WHERE user_id = $1`,
      [input.userId],
    ),
    import("./goalJourney.js").then((m) => m.openErrandsAndGoals(input.userId)).then((rows) => ({ rows })),
    activePreferences(input.userId).catch(() => [] as Preference[]),
    memberZone(input.userId).catch(() => null),
  ]);
  const introduced = await introducedNames(input.userId).catch(() => ({ names: [] as string[], pairs: [], intros: [] }));
  const goingSubj = await import("./preArrival.js").then((P) => P.goingSubject(input.userId, null)).catch(() => null);
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
  const openAsks: OpenItem[] = askRows.map((r: any) => ({ id: String(r.ask_id), text: String(r.ask_text), kind: r.kind, link: r.link ?? null, owned: !!r.owned }));

  // No catch: a failed read fails the call's processing, which is retried.
  const { text } = await generateText({
    model: anthropic(PROFILE_JUDGMENT_MODEL),
    // Same cap problem as turnLearning (2026-09-29): reasoning at the default
    // effort used the budget before any JSON was written.
    maxOutputTokens: 6000,
    providerOptions: { anthropic: { effort: "medium" } },
    experimental_telemetry: { isEnabled: true, functionId: "callLearning.learn" },
    prompt: callLearningPrompt({
      transcript: input.transcript,
      today: new Date().toISOString().slice(0, 10),
      onFile,
      openAsks,
      preferences: { onFile: prefs, localToday: localDay(new Date(), zone) },
      introduced: introduced.names,
      going: goingSubj,
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
  // Standing instructions said on the call (services/memberPreferences.ts): the same resolve and store as a text turn's, quotes checked
  // against their own lines on the call. The fallback for rules the mid-call reads didn't take (callPreferences.ts): only lines no read
  // covered count, so a rule stored on the call is never stored twice.
  const prefLines = unread ?? theirLines(input.transcript);
  if (learned.preferences.length && prefLines.trim()) {
    const stored = await learnPreferences(input.userId, learned.preferences, { message: prefLines, zone, onFile: prefs, source: { via: "call", ref: input.callRef ?? null } }).catch((err: any) => {
      console.error("callLearning: preference write failed (non-fatal):", err?.message ?? err);
      return null;
    });
    // A call cadence from the same read is the rule's twin: withdrawing the rule clears it too.
    if (stored?.added.length && learned.cadence !== "unstated") await markCadenceTwin(input.userId, stored.added).catch(() => {});
  }
  saveCallLessons(input.userId, lessons).catch((err: any) => console.error("callLearning: lesson write failed (non-fatal):", err?.message ?? err));
  const introOutcomes = callIntroOutcomes(raw, input.transcript, introduced.names);
  const quotes = new Map<string, string>(((raw as any)?.introductions ?? []).filter((x: any) => typeof x?.name === "string" && typeof x?.quote === "string").map((x: any) => [String(x.name).trim().split(/\s+/)[0].toLowerCase(), String(x.quote).slice(0, 160)]));
  await saveCallIntroOutcomes(input.userId, introOutcomes, introduced, (name) => quotes.get(name.toLowerCase()) ?? null).catch((err: any) => console.error("callLearning: intro outcome write failed (non-fatal):", err?.message ?? err));
  // "Can't make it tonight" (or "going after all") said on the call: the same presence record the text tool writes (updateGoing).
  const { going, recorded: goingRecorded } = await saveCallGoing(input.userId, raw, input.transcript, goingSubj);
  // People they said they already know (services/knownConnections.ts): the same record the text tool writes, source "call".
  await saveAlreadyKnow(input.userId, alreadyKnowFrom(raw, theirLines(input.transcript)), "call");
  await recordDecision({
    layer: 4,
    decision: "profile.callLearning",
    userId: input.userId,
    outcome: "act",
    action: "learned",
    proposal: { ms: Date.now() - started, plannedEvent: learned.planned_event?.event_name ?? null, lessons, cadence: learned.cadence, introOutcomes: introOutcomes.length, ...(goingRecorded ? { going, goingEvent: goingRecorded.eventApiId } : {}) },
  }).catch(() => {});
  return { ...learned, lessons };
}
