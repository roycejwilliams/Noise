// What a member wants, in their own words, and the conditions they put on it (Royce's spec, 2026-11-02: "Preserve what the member
// actually wants ... Match against meaning and evidence, not just labels").
//
// Not a new store and not a taxonomy: these are fields on the intent entry captureIntent already writes (co_profiles.intent), read by
// the matching paths that already read that entry (services/matching.ts) and shown by what-Cue-knows (services/whatCoKnows.ts).
//   quote       their words for the want, copied from one of their own lines (checked here); none found = the want's text is Cue's
//               read of what they said ("inferred"), never shown as their words
//   provenance  "stated" with a checked quote, "inferred" without (services/provenance.ts)
//   via         where they said it: a text or a call
//   criteria    conditions they put on that want, said outright, each with their checked words:
//                 must      a requirement ("who's built consumer before")
//                 must_not  an exclusion ("not investors right now")
//                 prefer    weighs the order, never rules anyone in or out ("taste matters more than seniority")
//               A condition belongs to one want: it never filters another want of theirs.
//
// Matching applies them in code from the scorer's per-candidate read of each condition (yes / no / unknown), so a condition is never
// silently relaxed and nothing is invented when the line is silent:
//   must_not yes                 -> that want is out for this candidate
//   must no                      -> that want is out for this candidate
//   must unknown                 -> uncertain: never a match on that want (held below the bar), never assumed either way
//   must_not unknown             -> passes: an exclusion is applied only when confirmed (Royce, 2026-11-03, option A)
//   prefer yes / no              -> up or down a little, never across the bar either way (a preference is not a filter)
// Pure, apart from nothing: every function here is a pure step the capture and matching paths call.
import { quoteIsTheirs } from "./provenance.js";

export type Strength = "must" | "must_not" | "prefer";
// timed: their words limit it in time, read when it was grounded from the quote or the sentence of theirs it came from (absent on
// conditions saved before 2026-11-04: the quote alone is read).
export type Criterion = { text: string; strength: Strength; quote: string; at: string; timed?: boolean };
export type Holds = "yes" | "no" | "unknown";

// The bar both nudge paths use for a match (eventScoring.ts MATCH_NUDGE_MIN_SCORE, networkIntroNudge.ts NETWORK_NUDGE_MIN_SCORE).
export const CONDITION_BAR = 60;
export const PREFER_STEP = 10;
export const MAX_CRITERIA = 6;
const MAX_TEXT = 140;

const STRENGTHS: readonly string[] = ["must", "must_not", "prefer"];
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Pure: only their side of a transcript (text history "User said:", a turn's "user:", a call's "user:"), joined.
export function theirWordsIn(transcript: string): string {
  return String(transcript ?? "")
    .split("\n")
    .filter((l) => /^\s*(user said:|user:|user sent a voice memo:)/i.test(l))
    .map((l) => l.replace(/^\s*(user said:|user:|user sent a voice memo:)\s*/i, ""))
    .join("\n");
}

// Pure: the want's own words and how sure Cue is that they're theirs. A quote that isn't in their lines is dropped, never kept.
export function groundWant(quote: unknown, ownWords: string): { quote: string | null; provenance: "stated" | "inferred" } {
  const q = typeof quote === "string" ? quote.trim().slice(0, 300) : "";
  return q && norm(q).split(" ").length >= 2 && quoteIsTheirs(q, ownWords) ? { quote: q, provenance: "stated" } : { quote: null, provenance: "inferred" };
}

// Words that make a statement a preference, never a requirement ("I'd rather", "taste matters more than seniority").
const PREFER_WORDS = /\b(rather|prefer|preferably|ideally|bonus|nice to have|if possible|matters? more|matters? less|more important than|less important than)\b/i;
// Words that make it an exclusion ("not investors right now", "no founders", "I don't want").
const NEGATION = /\b(not|no|never|without|except|avoid|none|nobody|skip)\b|n't\b/i;
// Words that carry no meaning of their own in a reading ("in SF", "not VCs", "no one from big tech"), or too little to tie a reading to a
// quote ("good energy" is not "good engineer"): never counted.
const FUNCTION = new Set(["a", "an", "the", "in", "on", "at", "of", "to", "for", "and", "or", "no", "not", "one", "from", "with", "by", "is", "are", "be", "was", "who", "whos", "that", "this", "it", "its", "someone", "somebody", "people", "person", "folks", "anyone", "they", "them", "their", "have", "has", "had", "been", "into", "right", "really", "just", "want", "wants", "looking", "would", "should", "could", "about", "some", "more", "less", "than", "over", "dont", "don't", "all", "any", "only", "good", "great", "nice", "kind", "type", "sort", "like", "very", "well", "much", "lot", "also", "maybe", "thing", "things", "stuff", "time", "now", "new", "get", "got", "can", "will", "me", "my", "i", "i'm", "im", "you", "we", "our", "so", "but", "if", "as", "rather", "prefer", "need", "needs", "must", "something", "anything", "anyone", "who's", "who", "being", "doing"]);
// A few words people use for the same thing, read as one ("has to be a woman founder" is "female founder"; "job hunting" is "job
// seekers"). Kept small on purpose: anything else said differently is off their words.
const SAME_AS: Record<string, string> = { female: "woman", women: "woman", woman: "woman", seekers: "seek", seeker: "seek", seeking: "seek", hunting: "seek" };
const tokens = (t: string) => norm(t).split(" ").filter(Boolean);
const bare = (x: string) => x.replace(/'s$|s$/, "");
// Pure: one word of a reading against the quote's words: the same word (a plural "s" aside), or for words of six letters or more the
// same first six letters ("engineer"/"engineering"). A short word must be the same word: "found" is never "founder".
const sameWord = (x: string, q: string) => bare(x) === bare(q) || (!!SAME_AS[x] && SAME_AS[x] === SAME_AS[q]) || (x.length >= 6 && q.length >= 6 && x.slice(0, 6) === q.slice(0, 6));
// Pure: does Cue's reading of a condition stay on their words (review of #378, rounds 2 and 3)? Every meaningful word of the reading
// counts at any length, and at least two of them must be in the quote (all of them when the reading has fewer than two), unless a
// name, place or acronym of the reading (SF, VCs, NYC, LA, B2B, Austin) is the same word in the quote. "no one in finance" from "not investors", "good engineer" from "good energy" and "no FAANG" from "big tech" are
// all off their words: dropped.
export function readingOnTheirWords(text: string, quote: string): boolean {
  const q = tokens(quote);
  const meaningful = [...new Set(tokens(text).filter((x) => !FUNCTION.has(x)))];
  if (!meaningful.length) return false;
  // A name, place or acronym in the reading (a capital in it: SF, VCs, LA, Austin, B2B) that is the same word in their quote is enough
  // on its own: "based in Austin" from "has to be in Austin".
  const named = String(text ?? "").split(/[^A-Za-z0-9'’]+/).filter((x) => /[A-Z]/.test(x) && !FUNCTION.has(norm(x)));
  if (named.some((x) => q.some((y) => bare(norm(x)) === bare(y)))) return true;
  // Two words in common, or as many as the shorter side has: "has to be a designer" has one meaningful word, so "a product
  // designer" needs only that one (review of bb6c5372).
  const qMeaningful = [...new Set(q.filter((x) => !FUNCTION.has(x)))];
  const hits = meaningful.filter((x) => q.some((y) => sameWord(x, y))).length;
  return hits >= Math.min(2, meaningful.length, Math.max(1, qMeaningful.length));
}

// Words in their own quote that put a time limit on the condition: it expires CONDITION_TTL_DAYS after it was last said.
export const TIME_WORDS = /\b(right now|for now|at the moment|this month|this year|currently|these days)\b/i;
export const CONDITION_TTL_DAYS = 60;
// Pure: does a time word limit the condition itself (review of bb6c5372)? Only where it bounds what they said: at the start of the
// clause ("for now no investors"), right after the negation or the want/need ("not currently looking", "don't need right now"), or at
// the clause's end ("not investors right now", "no VCs at the moment"). Never inside a clause about the other person ("someone
// currently building in AI", "nobody who's fundraising these days"): that describes them, not how long the condition lasts.
export function timeBound(quote: string): boolean {
  const clauses = String(quote ?? "").toLowerCase().replace(/[’‘]/g, "'").split(/[.;!?,]|\s(?:but|and|though)\s/);
  const re = new RegExp(TIME_WORDS.source, "gi");
  for (const raw of clauses) {
    const c = raw.trim();
    for (const m of c.matchAll(re)) {
      const before = c.slice(0, m.index).trim();
      const after = c.slice((m.index ?? 0) + m[0].length).trim();
      if (/\b(who|who's|whos|who is|who are|who're|that is|that's|that are|which)\b/.test(before)) continue;
      if (!before || !after) return true;
      if (/\b(not|no|never|n't|don't|dont|want|wants|need|needs|looking)$/.test(before)) return true;
    }
  }
  return false;
}

// Pure: a condition said with a time limit, last said more than 60 days ago. A condition with no time words lasts as long as the want;
// one with no readable time it was said has no basis to expire.
export function conditionExpired(c: { quote?: unknown; at?: unknown; timed?: unknown }, now: Date = new Date()): boolean {
  if (!(typeof c.timed === "boolean" ? c.timed : timeBound(String(c.quote ?? "")))) return false;
  const at = Date.parse(String(c.at ?? ""));
  return Number.isFinite(at) && now.getTime() - at > CONDITION_TTL_DAYS * 86_400_000;
}
// Pure: the intent list with expired conditions taken off, and which wants lost how many (ids and counts only).
export function pruneExpiredCriteria(intent: unknown, now: Date = new Date()): { intent: unknown[]; expired: { id: string; n: number }[] } {
  const entries = Array.isArray(intent) ? (intent as any[]) : [];
  const expired: { id: string; n: number }[] = [];
  const out = entries.map((e) => {
    const all = Array.isArray(e?.criteria) ? e.criteria : [];
    const keep = all.filter((c: any) => !conditionExpired(c, now));
    if (keep.length === all.length) return e;
    expired.push({ id: String(e?.id ?? ""), n: all.length - keep.length });
    return { ...e, criteria: keep };
  });
  return { intent: out, expired };
}

// Pure: the sentence of theirs a quote was taken from (their words split at . ! ? and line breaks), the latest one when they said it
// more than once (the newest wording is what holds), or null when it isn't found.
export function sentenceOf(quote: string, ownWords: string): string | null {
  const q = norm(quote);
  if (!q) return null;
  const sentences = String(ownWords ?? "").split(/(?<=[.!?])\s+|\n+/);
  for (let i = sentences.length - 1; i >= 0; i--) if (` ${norm(sentences[i])} `.includes(` ${q} `)) return sentences[i];
  return null;
}

// A clause that is only a time phrase ("For now, ..."): it limits the clause right after it.
const TIME_ONLY = /^(right now|for now|at the moment|this month|this year|currently|these days)$/i;

// Pure: is a condition limited in time (review of #382)? Its quote, or the clause of theirs holding it (the latest sentence it came
// from, split at commas, semicolons, "and" and "but"), or a time clause standing alone right before that clause ("For now, I don't
// want to meet any recruiters"). Each by the same position rules (timeBound): a time word in another clause of the sentence, or one
// about the other person, never counts.
export function conditionTimed(quote: string, ownWords: string): boolean {
  if (timeBound(quote)) return true;
  const sentence = sentenceOf(quote, ownWords);
  if (!sentence) return false;
  const clauses = sentence.split(/[,;]|\s+(?:and|but)\s+/i).map((x) => x.trim()).filter((x) => norm(x));
  const q = norm(quote);
  let at = -1;
  for (let i = clauses.length - 1; i >= 0; i--) if (` ${norm(clauses[i])} `.includes(` ${q} `)) { at = i; break; }
  if (at < 0) return false;
  return timeBound(clauses[at]) || (at > 0 && TIME_ONLY.test(norm(clauses[at - 1])));
}

export type CriterionReject = "no_quote_of_theirs" | "quote_too_short" | "reading_off_their_words" | "exclusion_without_negation" | "malformed" | "duplicate";

// Pure: the conditions the read found, kept only when said outright in their own words (review of #378):
//   - a quote of theirs of two words or more ("investors" alone, lifted from "I'm meeting investors Thursday", is not a condition)
//   - Cue's reading stays on those words (readingOnTheirWords)
//   - an exclusion needs words that exclude (a negation); without one it is dropped, never stored as must_not
//   - words of preference ("I'd rather", "matters more than") are always a preference, never a must or must_not
// No quote, no condition: a date, budget, urgency or requirement they didn't say is never added.
// onReject: why each one was left out (a reason only, never their words), so a rejection is logged, never silent.
export function groundCriteria(raw: unknown, ownWords: string, now: string = new Date().toISOString(), onReject?: (why: CriterionReject) => void): Criterion[] {
  const out: Criterion[] = [];
  const no = (why: CriterionReject) => onReject?.(why);
  for (const c of Array.isArray(raw) ? raw : []) {
    const text = typeof c?.text === "string" ? c.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";
    let strength = typeof c?.strength === "string" && STRENGTHS.includes(c.strength) ? (c.strength as Strength) : null;
    const quote = typeof c?.quote === "string" ? c.quote.trim().slice(0, 200) : "";
    if (!text || !strength) { no("malformed"); continue; }
    if (!quote || !quoteIsTheirs(quote, ownWords)) { no("no_quote_of_theirs"); continue; }
    if (tokens(quote).length < 2) { no("quote_too_short"); continue; }
    if (!readingOnTheirWords(text, quote)) { no("reading_off_their_words"); continue; }
    if (PREFER_WORDS.test(quote)) strength = "prefer";
    else if (strength === "must_not" && !NEGATION.test(quote)) { no("exclusion_without_negation"); continue; }
    if (out.some((o) => norm(o.text) === norm(text))) { no("duplicate"); continue; }
    out.push({ text, strength, quote, at: now, timed: conditionTimed(quote, ownWords) });
  }
  return out.slice(0, MAX_CRITERIA);
}

// Pure: a want's conditions after a newer statement. The newer one replaces the same condition (same words); a lifted one goes; the
// rest stay. Never touches another want.
export function mergeCriteria(onFile: unknown, added: Criterion[], lifted: string[] = []): Criterion[] {
  const gone = new Set(lifted.map(norm));
  // Said again (the same reading or the same words of theirs): the newer one replaces it, so a time-worded one's clock starts over.
  const kept = criteriaOf({ criteria: onFile }).filter((c) => !gone.has(norm(c.text)) && !added.some((a) => norm(a.text) === norm(c.text) || norm(a.quote) === norm(c.quote)));
  return [...kept, ...added].slice(-MAX_CRITERIA);
}

// Pure: a want entry's conditions in force (anything malformed is left out, and so is a time-worded one past its 60 days: it stops
// applying and stops showing the moment it expires, before the daily prune takes it off the record and logs it).
export function criteriaOf(entry: unknown, now: Date = new Date()): Criterion[] {
  const raw = (entry as { criteria?: unknown } | null)?.criteria;
  return (Array.isArray(raw) ? raw : []).filter(
    (c: any): c is Criterion => typeof c?.text === "string" && c.text.trim() !== "" && STRENGTHS.includes(c?.strength) && !conditionExpired(c, now),
  );
}

// ---------------------------------------------------------------- capture: what the reads are told

// The want's own words and conditions, for both reads (the call's captureIntentPrompt and the text turn's turnLearningPrompt).
export const WANT_WORDS_RULE = `For each ask also give "quote": their own words for it, copied exactly from one of their lines (a few words to a sentence), and "criteria": conditions they put on that ask, only when said outright, each with their exact words as "quote". strength "must" is a requirement ("who's built consumer before"), "must_not" rules a kind of person or thing out ("not investors right now"), "prefer" weighs without ruling anyone out ("taste matters more than seniority"). Never add a condition they didn't say: no dates, budgets, urgency, seniority or requirements of your own; a feeling or a vague wish is not a condition, and most asks have none ([]). Different wants stay different asks in their own words: "a technical cofounder who's built consumer before", "people outside tech" and "a room where I can drop my guard" are three asks, never one "networking" ask.`;

export const CRITERIA_FOR_RULE = `criteria_for: a condition they put, in what they just said, on one of the numbered items above that is an ask or a goal (not Cue's task), when it isn't a new ask itself ("for the cofounder search, not investors right now"). index is the item's number; strength as above; "lifted" with the exact on-file condition text when they take one back ("investors are fine now"). Their exact words as quote. Only for the item it was said about; [] when none.`;

export const CRITERIA_FOR_JSON = `"criteria_for": [{"index": 0, "text": "...", "strength": "must" | "must_not" | "prefer" | "lifted", "quote": "..."}]`;
export const ASK_JSON = `{"text": "...", "type": "seeking", "quote": "their exact words", "criteria": [{"text": "...", "strength": "must" | "must_not" | "prefer", "quote": "..."}]}`;

// Pure: the conditions already on file for the numbered items, so a read can lift one by its exact text.
export function conditionsOnFileBlock(items: { id: string }[], intent: unknown): string {
  const entries = Array.isArray(intent) ? (intent as any[]) : [];
  const lines: string[] = [];
  items.forEach((it, i) => {
    const e = entries.find((x) => x?.id === it.id);
    for (const c of criteriaOf(e)) lines.push(`${i}. ${strengthWords(c.strength)}: "${c.text}"`);
  });
  return lines.length ? `\nConditions already on file for those numbered items:\n${lines.join("\n")}\n` : "";
}

export const strengthWords = (s: Strength) => (s === "must" ? "must" : s === "must_not" ? "must not" : "would rather");

export type CriteriaFor = { id: string; added: Criterion[]; lifted: string[] };

// Pure: criteria_for answers turned into per-item changes. Only an ask or goal item (by its index in what the read was shown), only
// conditions in their own words; a lift only of a condition actually on file.
export function groundCriteriaFor(raw: unknown, items: { id: string; kind?: string | null }[], intent: unknown, ownWords: string, now: string = new Date().toISOString(), onReject?: (why: CriterionReject) => void): CriteriaFor[] {
  const entries = Array.isArray(intent) ? (intent as any[]) : [];
  const out = new Map<string, CriteriaFor>();
  for (const c of Array.isArray(raw) ? raw : []) {
    const item = Number.isInteger(c?.index) ? items[c.index] : undefined;
    if (!item || (item.kind && item.kind !== "ask" && item.kind !== "goal" && item.kind !== "lookout")) continue;
    const entry = entries.find((e) => e?.id === item.id);
    if (!entry || entry.status !== "active") continue;
    const slot = out.get(item.id) ?? { id: item.id, added: [], lifted: [] };
    if (c?.strength === "lifted") {
      const q = typeof c?.quote === "string" ? c.quote : "";
      const hit = criteriaOf(entry).find((x) => norm(x.text) === norm(c?.text));
      if (hit && q && quoteIsTheirs(q, ownWords)) slot.lifted.push(hit.text);
    } else slot.added.push(...groundCriteria([c], ownWords, now, onReject));
    if (slot.added.length || slot.lifted.length) out.set(item.id, slot);
  }
  return [...out.values()];
}

// Pure: the intent list with those changes applied, each to its own entry only.
export function applyCriteriaFor(intent: unknown, changes: CriteriaFor[]): unknown[] {
  const entries = Array.isArray(intent) ? (intent as any[]) : [];
  return entries.map((e) => {
    const ch = changes.find((c) => c.id === e?.id);
    return ch ? { ...e, criteria: mergeCriteria(e.criteria, ch.added, ch.lifted) } : e;
  });
}

// ---------------------------------------------------------------- matching: what the scorer is told, and what code does with it

export type WantLine = { label: string; text: string; criteria: Criterion[] };
export type Labelled = { label: string; want: string; c: Criterion };

// Pure: each want's conditions labelled C1, C2... in the order the wants are listed.
export function labelConditions(wants: WantLine[]): Labelled[] {
  const out: Labelled[] = [];
  for (const w of wants) for (const c of w.criteria) out.push({ label: `C${out.length + 1}`, want: w.label, c });
  return out;
}

// Pure: the prompt part that lists a want's conditions (nothing when there are none).
export function conditionsPromptBlock(wants: WantLine[]): string {
  const ls = labelConditions(wants);
  if (!ls.length) return "";
  const multi = wants.length > 1;
  return `\nConditions they put on ${multi ? "these wants (each belongs to its own want only)" : "this"}, in their own words (Cue's short reading after each is context only; judge their words):\n${ls.map((l) => `${l.label}${multi ? ` (for ${l.want})` : ""}, ${strengthWords(l.c.strength)}: "${l.c.quote}" (reading: ${l.c.text})`).join("\n")}\nFor every candidate, say for each condition whether what they said holds for that candidate on what's listed: "yes", "no", or "unknown" when nothing listed says either way. For a "must not", "yes" means the candidate is what they ruled out. Never guess: "unknown" is the honest answer when the line is silent. Judge the score on the want itself; the conditions are applied separately.\n`;
}

export const CONDITIONS_FIELDS = `conditions: one entry per listed condition, {"label": "C1", "holds": "yes" | "no" | "unknown"}; [] when no conditions are listed.`;

export type Judged = { conditions?: unknown; fits?: unknown };
// held: the want that would carry the match is kept from it by a condition (its exclusion holds, its requirement failed, or nobody can
// confirm it). Only when the candidate fits on the want itself (the scorer's score at the bar): a candidate who fits none of the wants
// isn't a match on conditions, and a condition on a want they don't fit never marks them (review of #378, round 2). perWant: each
// want's own result, never pooled across wants.
export type WantResult = { label: string; excluded: boolean; unverified: boolean };
export type ConditionOutcome = { score: number; excluded: string[]; unverified: string[]; preferred: string[]; held: boolean; perWant: WantResult[] };

// Pure: a candidate's score after the conditions. fits: the want labels the scorer said the candidate fits (rooms); none named means
// every want could be the fit. A want with a broken requirement or exclusion is out for this candidate; the candidate stays only
// through a want that isn't. A requirement nobody can confirm keeps that want below the bar.
export function applyConditions(score: number, judged: Judged, wants: WantLine[], bar: number = CONDITION_BAR): ConditionOutcome {
  const ls = labelConditions(wants);
  if (!ls.length) return { score, excluded: [], unverified: [], preferred: [], held: false, perWant: [] };
  const holds = new Map<string, Holds>();
  for (const j of Array.isArray(judged.conditions) ? judged.conditions : []) {
    const h = (j as any)?.holds;
    if (typeof (j as any)?.label === "string" && (h === "yes" || h === "no" || h === "unknown")) holds.set((j as any).label.trim().toUpperCase(), h);
  }
  const named = new Set((Array.isArray(judged.fits) ? judged.fits : []).map((f) => String(f).trim().toUpperCase()));
  const candidates = wants.filter((w) => !named.size || named.has(w.label.toUpperCase()));
  const pool = candidates.length ? candidates : wants;
  const excluded: string[] = [];
  const unverified: string[] = [];
  const preferred: string[] = [];
  const open: { w: WantLine; certain: boolean; step: number }[] = [];
  const perWant: WantResult[] = [];
  for (const w of pool) {
    const mine = ls.filter((l) => l.want === w.label);
    const h = (l: Labelled) => holds.get(l.label) ?? "unknown";
    const broken = mine.filter((l) => (l.c.strength === "must_not" && h(l) === "yes") || (l.c.strength === "must" && h(l) === "no"));
    if (broken.length) {
      excluded.push(...broken.map((l) => l.c.text));
      perWant.push({ label: w.label, excluded: true, unverified: false });
      continue;
    }
    // A requirement nobody can confirm holds the want under the bar. An exclusion nobody can confirm does not (Royce, 2026-11-03,
    // option A): only a confirmed exclusion holds or excludes; the double opt-in protects the member, who can decline the ask.
    const unsure = mine.filter((l) => l.c.strength === "must" && h(l) === "unknown");
    perWant.push({ label: w.label, excluded: false, unverified: unsure.length > 0 });
    unverified.push(...unsure.map((l) => l.c.text));
    const step = mine.filter((l) => l.c.strength === "prefer").reduce((s, l) => s + (h(l) === "yes" ? PREFER_STEP : h(l) === "no" ? -PREFER_STEP : 0), 0);
    for (const l of mine.filter((x) => x.c.strength === "prefer" && h(x) === "yes")) preferred.push(l.c.text);
    open.push({ w, certain: !unsure.length, step });
  }
  const fitsAtAll = score >= bar;
  if (!open.length) return { score: 0, excluded, unverified, preferred, held: fitsAtAll, perWant };
  const best = open.find((o) => o.certain) ?? open[0];
  let s = score;
  // A preference moves the order, never across the bar either way.
  if (best.step) s = score >= bar ? Math.max(bar, Math.min(100, score + best.step)) : Math.min(bar - 1, Math.max(0, score + best.step));
  // Only wants with a requirement nobody can confirm: uncertain, never a match.
  if (!best.certain) s = Math.min(s, bar - 1);
  // Held only through the want that would carry it: every candidate want ruled out (above), or the best open one unconfirmed.
  return { score: s, excluded, unverified, preferred, held: fitsAtAll && !best.certain, perWant };
}
