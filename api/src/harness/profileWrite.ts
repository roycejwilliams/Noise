// Layer 4 harness: writes to co_profiles, co_profiles.intent, ask_checkins.
//
// gather   open asks (text + embedding) and what's on file
// propose  captureIntent / assessResolvedItems / extractPsychographicProfile
// gate     decideAskWrite (dedup restated asks), gateResolutions (a retired
//          item needs a quoted line that really appears in the conversation),
//          sanitizeExtractedProfile (enums and ranges)
// record   recordDecision(layer 4, "profile.write")
//
// The pure functions here are what evals/profile runs without a DB or model.
//
// HOOK FOR THE REPLY SECTION (routes/sendblue.ts, owned by the Layer 3 agent):
// the ask written this turn used to be invisible to anything reading
// co_profiles in the same turn, because captureIntent ran fire-and-forget
// after the reply. Call
//
//   const turnAsk = await captureIntentForTurn(user.id, textTranscript, { timeoutMs: 2500 });
//
// before building the reply facts. It returns { ask, askId, deduped } from
// the synchronous capture (or null on timeout / nothing captured) and the
// capture keeps running to completion in the background either way, so
// nothing is lost. Prefer turnAsk.ask over getActiveSeekingAsk(profile.intent)
// for this turn. Don't also call captureIntent separately for the same text.
import type { GateCheck } from "./core.js";
import { MODELS } from "../models.js";
import { coAskedQuestion } from "../services/conversationClose.js";

// Local copy so this file (and its eval) doesn't pull in a DB-backed module.
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Judgment calls with side effects (retiring items, deciding borderline
// "same ask") use Sonnet 5 per Royce's model policy.
export const PROFILE_JUDGMENT_MODEL = MODELS.sonnet;

// Embedding similarity at or above this is the same ask restated; between
// the two thresholds the model decides; below LOW it's a new ask. Measured
// with text-embedding-3-small on evals/profile: real paraphrases scored as
// low as 0.72 while different asks reached 0.78, so the model owns the
// whole 0.65-0.90 band (run evals/profile/sims.ts to re-check).
export const SAME_ASK_HIGH = 0.9;
export const SAME_ASK_LOW = 0.65;

export type OpenAsk = { askId: string; text: string; embedding: number[] | null };

// ---- intent entries ----------------------------------------------------------
//
// One entry in co_profiles.intent. captureIntent writes an entry whenever a
// conversation produced anything at all, which includes the case where it
// found preferences/wants/availability but NO ask — that entry has no text
// and no type, only `status: "active"`. Those are legitimate preference
// records, but they are not asks, and 2026-09-20 one real profile carried
// three of them being counted as open asks downstream. Everything that reads
// co_profiles.intent for asks goes through these predicates so "is this an
// ask" means one thing everywhere.

// The hard type of every entry (Royce, 2026-10-06: "Split goals and asks - right now they're combined and it's causing the bugs").
//   ask   an errand: something to find, answer or do. It feeds search, offers and check-ins, and lives under the ask lifecycle
//         (services/askLifecycle.ts: states, expiry, evidence closes). It has an ask_checkins row.
//   goal  direction: where they are headed. It feeds orientation and judgment only; it has NO ask_checkins row, so nothing that searches
//         or checks in can reach it; it never expires and only changes when they change it.
// An entry written before the split has no kind and reads as an ask (what it always was) until the reclassify pass types it.
export type EntryKind = "ask" | "goal";

export type IntentEntry = {
  id?: string;
  kind?: EntryKind | null;
  text?: string | null;
  type?: string | null;
  status?: string | null;
  wants?: string[] | null;
  concrete_preferences?: string[] | null;
  availability?: string | null;
  embedding?: number[] | null;
  created_at?: string | null;
  // The member said Co may mention this ask when introducing them (services/matching.ts shareableAsks). Missing = private.
  shareable?: boolean | null;
};

// An entry is an ask only when it actually carries ask text. Whitespace is
// not text.
export function hasAskText(entry: unknown): boolean {
  const text = (entry as IntentEntry | null)?.text;
  return typeof text === "string" && text.trim().length > 0;
}

export function entryKind(entry: unknown): EntryKind {
  return (entry as IntentEntry | null)?.kind === "goal" ? "goal" : "ask";
}

// An open ASK: the one predicate every search, offer, match and check-in reads. A goal is never one.
export function isOpenAsk(entry: unknown): boolean {
  return hasAskText(entry) && (entry as IntentEntry).status === "active" && entryKind(entry) === "ask";
}

// An active GOAL: what orients and judges, read only by things that orient (never by anything that searches or checks in).
export function isActiveGoal(entry: unknown): boolean {
  return hasAskText(entry) && (entry as IntentEntry).status === "active" && entryKind(entry) === "goal";
}
export function goalEntries(intent: unknown): IntentEntry[] {
  return Array.isArray(intent) ? (intent as IntentEntry[]).filter(isActiveGoal) : [];
}

export function askEntries(intent: unknown): IntentEntry[] {
  return Array.isArray(intent) ? (intent as IntentEntry[]).filter(isOpenAsk) : [];
}

// The operative ask, newest last — captureIntent appends, so the last open
// ask entry wins. A text-less entry written after it no longer hides it.
export function latestAskEntry(intent: unknown): IntentEntry | null {
  const asks = askEntries(intent);
  return asks.length ? asks[asks.length - 1] : null;
}

// Whether an entry with no ask text still carries something the member said:
// wants, concrete preferences, or availability.
export function hasIntentPayload(entry: unknown): boolean {
  const e = entry as IntentEntry | null;
  if (!e || typeof e !== "object") return false;
  const list = (v: unknown) => Array.isArray(v) && v.some((x) => typeof x === "string" && x.trim().length > 0);
  return list(e.wants) || list(e.concrete_preferences) || (typeof e.availability === "string" && e.availability.trim().length > 0);
}

// What the cleanup script (src/scripts/settleTextlessIntent.ts) writes back,
// and the guard any writer can run before storing an intent array.
//   - an entry with ask text is left exactly as it is
//   - an entry with no ask text but real preferences is KEPT, marked
//     "preferences_only" so nothing reads it as an open ask
//   - an entry with no ask text and nothing else is dropped
// The first version of this deleted the second kind too (2026-09-20), which
// removed wants, availability and preferences a member had given Co. It was
// restored from a backup; keeping the payload is the whole point of the
// "preferences_only" status. Idempotent: a settled array comes back the same.
export function settleTextlessIntent(intent: unknown): IntentEntry[] {
  if (!Array.isArray(intent)) return [];
  const out: IntentEntry[] = [];
  for (const e of intent as IntentEntry[]) {
    if (hasAskText(e)) out.push(e);
    else if (hasIntentPayload(e)) out.push(e.status === "preferences_only" ? e : { ...e, status: "preferences_only" });
  }
  return out;
}

export function normalizeAskText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(a|an|the|some|any|to|for|i'?m|im|looking|find|me|my|please|really|just)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type AskWriteDecision =
  | { action: "update_existing"; askId: string; similarity: number; checks: GateCheck[]; reason: string }
  | { action: "needs_judgment"; askId: string; similarity: number; checks: GateCheck[]; reason: string }
  | { action: "open_new"; checks: GateCheck[]; reason: string };

export function decideAskWrite(newAsk: { text: string; embedding: number[] | null }, openAsks: OpenAsk[]): AskWriteDecision {
  const norm = normalizeAskText(newAsk.text);
  const exact = openAsks.find((a) => normalizeAskText(a.text) === norm);
  if (exact) {
    return {
      action: "update_existing",
      askId: exact.askId,
      similarity: 1,
      checks: [{ name: "no_duplicate_ask", pass: true, reason: "same text as an open ask" }],
      reason: `restates open ask "${exact.text}"`,
    };
  }

  let best: { ask: OpenAsk; sim: number } | null = null;
  if (newAsk.embedding?.length) {
    for (const a of openAsks) {
      if (!a.embedding?.length) continue;
      const sim = cosineSimilarity(newAsk.embedding, a.embedding);
      if (!best || sim > best.sim) best = { ask: a, sim };
    }
  }

  if (best && best.sim >= SAME_ASK_HIGH) {
    return {
      action: "update_existing",
      askId: best.ask.askId,
      similarity: best.sim,
      checks: [{ name: "no_duplicate_ask", pass: true, reason: `similarity ${best.sim.toFixed(3)}` }],
      reason: `near-duplicate of "${best.ask.text}"`,
    };
  }
  if (best && best.sim >= SAME_ASK_LOW) {
    return {
      action: "needs_judgment",
      askId: best.ask.askId,
      similarity: best.sim,
      checks: [{ name: "borderline_similarity", pass: true, reason: `similarity ${best.sim.toFixed(3)}` }],
      reason: `may restate "${best.ask.text}"`,
    };
  }
  return {
    action: "open_new",
    checks: [{ name: "no_duplicate_ask", pass: true, reason: best ? `closest ${best.sim.toFixed(3)}` : "no open asks to compare" }],
    reason: "different from every open ask",
  };
}

// ---- resolutions -------------------------------------------------------------

export type ProposedResolution = { kind: "goal" | "blocker" | "ask"; item: string; quote: string };

function squash(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

// A resolution only goes through when the item is really on file and the
// supporting quote is (a) at least a few words, (b) actually present in the
// transcript, and (c) said by the person, not by Co.
export function gateResolutions(
  proposals: ProposedResolution[],
  onFile: { goals: string[]; blockers: string[]; asks: { id: string; text: string }[] },
  transcript: string,
): { accepted: ProposedResolution[]; rejected: { proposal: ProposedResolution; reason: string }[]; checks: GateCheck[] } {
  const accepted: ProposedResolution[] = [];
  const rejected: { proposal: ProposedResolution; reason: string }[] = [];
  // Only the person's own lines can support retiring something; Co's lines
  // ("Co replied:", "assistant:") are excluded.
  const isCoLine = (l: string) => /^\s*(co replied:|assistant:|co:)/i.test(l);
  const lines = transcript.split("\n");
  const hay = squash(lines.join(" "));
  const theirs = squash(lines.filter((l) => !isCoLine(l)).join(" "));

  for (const p of proposals) {
    const exists =
      p.kind === "goal"
        ? onFile.goals.includes(p.item)
        : p.kind === "blocker"
          ? onFile.blockers.includes(p.item)
          : onFile.asks.some((a) => a.id === p.item);
    const q = squash(p.quote ?? "");
    let reason: string | null = null;
    if (!exists) reason = "item isn't on file";
    else if (q.split(" ").filter(Boolean).length < 3) reason = "no real supporting quote";
    else if (!hay.includes(q)) reason = "quote isn't in the conversation";
    else if (!theirs.includes(q)) reason = "quote is something Co said, not them";
    if (reason) rejected.push({ proposal: p, reason });
    else accepted.push(p);
  }
  const checks: GateCheck[] = rejected.map((r) => ({
    name: "resolution_supported",
    pass: false,
    reason: `${r.proposal.kind} "${r.proposal.item}": ${r.reason}`,
  }));
  if (accepted.length) checks.push({ name: "resolution_supported", pass: true, reason: `${accepted.length} accepted` });
  return { accepted, rejected, checks };
}

// ---- extracted profile values ------------------------------------------------

export const ALLOWED_LIFE_CHAPTERS = ["new_to_city", "building_solo", "career_pivot", "starting_over"];
// What each chapter means, and that their own stated facts always win over an inference (2026-10-12 intelligence audit: a founder
// who named his cofounder was marked building_solo, and a photographer who moved here 5 years ago was marked new_to_city). One rule
// for every reader that proposes chapters (services/profileExtraction.ts, turnLearning.ts, callLearning.ts).
export const LIFE_CHAPTERS_RULE = `life_chapters, only when their own words support it: new_to_city = they moved to where they live within about the last year (someone who moved years ago is not new); building_solo = building something of their own WITHOUT a cofounder or business partner (anyone who named a cofounder or partner in it is not solo); career_pivot = changing careers or fields now; starting_over = rebuilding after a major ending. A chapter must never contradict a fact they stated (a cofounder they named, how long they've lived somewhere): their stated facts win over any inference. When unsure, leave it out.`;
export const ALLOWED_CONNECTION_STYLES = ["small_group", "medium_group", "large_social"];
const MAX_LIST_ITEMS = 25;
const MAX_ITEM_CHARS = 200;

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter((x) => x.length > 0 && x.length <= MAX_ITEM_CHARS),
    ),
  ].slice(0, MAX_LIST_ITEMS);
}

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t && t.length <= max ? t : undefined;
}

export type SanitizedProfile = {
  life_chapters: string[];
  social_energy?: number;
  connection_style?: string;
  activity_preferences: string[];
  goals: string[];
  blockers: string[];
  availability_pattern?: string;
  city?: string;
  emotional_state?: string;
  long_term_direction?: string;
};

export function sanitizeExtractedProfile(raw: Record<string, unknown> | null | undefined): { profile: SanitizedProfile; checks: GateCheck[] } {
  const r = raw ?? {};
  const checks: GateCheck[] = [];
  const chaptersIn = Array.isArray(r.life_chapters) ? (r.life_chapters as unknown[]) : [];
  const life_chapters = chaptersIn.filter((c): c is string => typeof c === "string" && ALLOWED_LIFE_CHAPTERS.includes(c));
  if (life_chapters.length !== chaptersIn.length) checks.push({ name: "life_chapters_enum", pass: false, reason: "dropped values outside the allowed list" });

  let social_energy: number | undefined;
  if (r.social_energy !== undefined && r.social_energy !== null && r.social_energy !== "") {
    const n = Number(r.social_energy);
    if (Number.isFinite(n) && n >= 0 && n <= 100) social_energy = Math.round(n);
    else checks.push({ name: "social_energy_range", pass: false, reason: `"${String(r.social_energy)}" is outside 0-100` });
  }

  let connection_style: string | undefined;
  if (typeof r.connection_style === "string" && r.connection_style) {
    if (ALLOWED_CONNECTION_STYLES.includes(r.connection_style)) connection_style = r.connection_style;
    else checks.push({ name: "connection_style_enum", pass: false, reason: `"${r.connection_style}" isn't allowed` });
  }

  const emotional = cleanText(r.emotional_state, 40);
  const emotional_state = emotional && /^[a-z-]+$/i.test(emotional) ? emotional.toLowerCase() : undefined;
  if (emotional && !emotional_state) checks.push({ name: "emotional_state_one_word", pass: false, reason: "not a single word" });

  return {
    profile: {
      life_chapters,
      social_energy,
      connection_style,
      activity_preferences: cleanList(r.activity_preferences),
      goals: cleanList(r.goals),
      blockers: cleanList(r.blockers),
      availability_pattern: cleanText(r.availability_pattern, 200),
      city: cleanText(r.city, 100),
      emotional_state,
      long_term_direction: cleanText(r.long_term_direction, 600),
    },
    checks,
  };
}

// ---- corrections ---------------------------------------------------------------
//
// When someone corrects something Co has on file ("I'm not a founder, I'm a
// designer", "I moved to Oakland"), the old item comes off the profile and a
// dated record of the change is kept (Royce, 2026-09-23, from Instinct's
// "dated corrections"). Co can then say honestly what it had and when it
// changed, instead of silently holding a wrong fact or silently dropping it.

export const CORRECTABLE_FIELDS = [
  "city",
  "life_chapters",
  "goals",
  "blockers",
  "activity_preferences",
  "long_term_direction",
  "availability_pattern",
] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];
export const LIST_FIELDS: CorrectableField[] = ["life_chapters", "goals", "blockers", "activity_preferences"];

export type OnFile = Partial<Record<CorrectableField, string | string[] | null>>;
export type ProposedCorrection = { field: string; old: string; new: string | null; quote: string };
export type Correction = { field: CorrectableField; old: string; new: string | null; quote: string };

// Cheap first pass on what they just said, so the model check only runs when
// a correction is plausible. Deliberately broad: a miss here means a wrong
// fact stays on file, a false hit only costs one small model call.
export function mightBeCorrection(message: string): boolean {
  return /\b(actually|not|no longer|anymore|wrong|correct|incorrect|moved|changed|instead|never|isn'?t|wasn'?t|aren'?t|don'?t|doesn'?t|didn'?t|haven'?t|quit|left|stopped|no|now|these days|used to|prefer|rather|better)\b/i.test(message);
}

function onFileItems(onFile: OnFile, field: CorrectableField): string[] {
  const v = onFile[field];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" && v.trim() ? [v] : [];
}

// A correction is accepted only when the old value is really on file and
// their own words in the new message say so. Co's lines never count.
export function gateCorrections(
  proposals: ProposedCorrection[],
  onFile: OnFile,
  newWords: string,
): { accepted: Correction[]; rejected: { proposal: ProposedCorrection; reason: string }[]; checks: GateCheck[] } {
  const accepted: Correction[] = [];
  const rejected: { proposal: ProposedCorrection; reason: string }[] = [];
  const isCoLine = (l: string) => /^\s*(co replied:|assistant:|co:)/i.test(l);
  const theirs = squash(newWords.split("\n").filter((l) => !isCoLine(l)).join(" "));
  for (const p of proposals) {
    const field = CORRECTABLE_FIELDS.find((f) => f === p.field);
    const q = squash(p.quote ?? "");
    let reason: string | null = null;
    if (!field) reason = "not a field that can be corrected";
    else if (!onFileItems(onFile, field).includes(p.old)) reason = "old value isn't on file";
    else if (q.split(" ").filter(Boolean).length < 3) reason = "no real supporting quote";
    else if (!theirs.includes(q)) reason = "quote isn't in what they just said";
    else if (p.new != null && squash(p.new) === squash(p.old)) reason = "nothing changed";
    if (reason || !field) rejected.push({ proposal: p, reason: reason ?? "invalid" });
    else accepted.push({ field, old: p.old, new: p.new?.trim() ? p.new.trim() : null, quote: p.quote });
  }
  const checks: GateCheck[] = rejected.map((r) => ({ name: "correction_supported", pass: false, reason: `${r.proposal.field}: ${r.reason}` }));
  return { accepted, rejected, checks };
}

// The profile after corrections: old items out, new ones in (lists put the
// new item first, as the newest).
export function applyCorrections<T extends OnFile>(profile: T, corrections: Correction[]): T {
  const out: any = { ...profile };
  for (const c of corrections) {
    if (LIST_FIELDS.includes(c.field)) {
      const list = (Array.isArray(out[c.field]) ? out[c.field] : []).filter((x: string) => x !== c.old);
      out[c.field] = c.new && !list.includes(c.new) ? [c.new, ...list] : list;
    } else if (out[c.field] === c.old) {
      out[c.field] = c.new;
    }
  }
  return out;
}

// For Co's context: what changed and when, newest first.
const FIELD_LABELS: Record<CorrectableField, string> = {
  city: "where they live",
  life_chapters: "life chapter",
  goals: "goal",
  blockers: "what's in their way",
  activity_preferences: "what they like doing",
  long_term_direction: "long-term direction",
  availability_pattern: "when they're free",
};
export function renderCorrections(rows: { field: string; old_value: string; new_value: string | null; corrected_at: Date | string }[], timezone = "America/Los_Angeles"): string {
  return rows
    .map((r) => {
      const label = FIELD_LABELS[r.field as CorrectableField] ?? r.field;
      const day = new Date(r.corrected_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timezone });
      return r.new_value
        ? `- ${label}: you had "${r.old_value}"; they corrected it to "${r.new_value}" on ${day}`
        : `- ${label}: you had "${r.old_value}"; they said that's wrong on ${day}`;
    })
    .join("\n");
}

// ---- Co's words aren't their wants ---------------------------------------------
//
// 2026-09-23: after a call where Co said "I'll dig into those founder, tech,
// design, and product communities in SF", the member's profile gained
// "wants: founder, tech, design, and product communities in SF". Their own
// asks were about down-to-earth, dependable people. A captured item is Co's
// echo when nearly all its words are in Co's lines and most aren't in theirs.
const ECHO_STOPWORDS = new Set(["with", "that", "this", "what", "your", "have", "just", "like", "would", "want", "wants", "into", "some", "more", "they", "them", "their", "from", "about", "also", "really", "things", "people"]);
function itemWords(s: string): string[] {
  return [...new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !ECHO_STOPWORDS.has(w)))];
}
// A plain yes to what Co just asked or offered. Code review, 2026-09-24: "Want
// me to look for founder communities in SF?" / "Yes please" was dropped as
// Co's echo, so an ask they agreed to was never saved or searched.
const AGREES = /^\s*(user said:|user:|user sent a voice memo:)\s*(yes|yeah|yep|yup|sure|please|definitely|absolutely|for sure|of course|that would be|that'?d be|sounds (good|great)|i'?d (like|love) that|let'?s do (it|that))\b/i;
// A yes that's taken back isn't one (second review, 2026-09-24): "of course
// not", "yes, I mean no, forget that". "No worries" / "no problem" are
// still agreement.
// Only an explicit taking-back: "sure, why not" and "I don't mind" are still yes; "of course not", "yes, I mean no" aren't.
const TAKES_IT_BACK = /\b(of course not|absolutely not|definitely not|certainly not|not really|not right now|not this|not now|but not|nah|nope|never mind|nevermind|no wait|wait,? no|no thanks|no thank you)\b|\bno(?!\s+(worries|problem|rush|pressure|need))\b(?!\s*(,|\.|!)?\s*(i mean|just kidding))|forget (it|that)|changed my mind|i mean no/i;
export function agreesWith(line: string): boolean {
  return AGREES.test(line) && !TAKES_IT_BACK.test(line.replace(/^\s*(user said:|user:|user sent a voice memo:)/i, ""));
}
// The one thing a yes answers: Co's last question or offer, not the whole
// message (second review, 2026-09-24: a yes to "How was your weekend?"
// claimed the plan Co had stated two lines earlier).
export function lastAskedSentence(coMessage: string): string | null {
  const body = coMessage.replace(/^\s*(co replied:|assistant:|co:)\s*/i, "");
  const sentences = body.match(/[^.!?\n]+[.!?]*/g) ?? [];
  // Only an offer or an ask of theirs, not a check-in question ("did it go well?"): a yes to that is not a want.
  for (let i = sentences.length - 1; i >= 0; i--) if (coAskedQuestion(sentences[i]) && OFFER.test(sentences[i])) return sentences[i].trim();
  return null;
}
const OFFER = /\b(want me to|should i|shall i|would you like|do you want|can i|could i|if you want|let me|i can|i could|i'?ll|how about|interested in|keen to)\b/i;
export function splitSpeakers(transcript: string): { theirs: string; cos: string } {
  const theirs: string[] = [];
  const cos: string[] = [];
  let lastCo: string | null = null;
  for (const line of transcript.split("\n")) {
    if (/^\s*(co replied:|assistant:|co:)/i.test(line)) {
      cos.push(line);
      // Co's reply is several texts, one 'Co replied:' line each (a link last, often): with no member line
      // between them they are one message, and the offer it ends on is what a yes answers.
      lastCo = lastCo ? `${lastCo} ${line.replace(/^\s*(co replied:|assistant:|co:)\s*/i, "")}` : line;
    } else if (/^\s*(user said:|user:|user sent a voice memo:)/i.test(line)) {
      theirs.push(line);
      // The question or offer they said yes to is theirs too; only that one.
      const asked = lastCo ? lastAskedSentence(lastCo) : null;
      if (asked && agreesWith(line)) theirs.push(asked);
      lastCo = null;
    } else if (/^\s*(user (said|sent)\b|co (replied|called)\b|\[)/i.test(line)) {
      // Any other labeled line ("User sent a photo...", "Co called...",
      // "[Call] ...", a gap marker) ends Co's message.
      lastCo = null;
    } else if (lastCo && line.trim()) {
      // A text's later paragraphs are part of the same Co message.
      cos.push(line);
      lastCo += ` ${line}`;
    }
  }
  return { theirs: theirs.join(" ").toLowerCase(), cos: cos.join(" ").toLowerCase() };
}
export function echoesCoNotMember(item: string, transcript: string): boolean {
  const words = itemWords(item);
  if (words.length < 2) return false;
  const { theirs, cos } = splitSpeakers(transcript);
  if (!cos) return false;
  const inCo = words.filter((w) => cos.includes(w)).length / words.length;
  const inTheirs = words.filter((w) => theirs.includes(w)).length / words.length;
  return inCo >= 0.8 && inTheirs < 0.5;
}
