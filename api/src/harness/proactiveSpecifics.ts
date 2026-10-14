// No invented specifics in a message Co sends unprompted (Royce, 2026-10-06).
//
// What happened: a post-call text said a member's "scarcity angle and advisor structure would come through Friday", at "the
// pitch you've been prepping the investor ask for". They had said nothing of the kind on the call. "Friday" was a week-old
// relative date ("I am pitching investors Friday", said on 9/29, for a Friday that had already passed) that two recaps had
// carried forward as "preparing to pitch Friday". It sat in the draft's background facts, and the model projected it onto the
// call it had just heard. A check that only asked "is it in the facts?" would have passed it.
//
// So specifics have to be BACKED, and only some facts can back them:
//   - A date, day, time or "tomorrow/tonight/this weekend" is backed only by (a) a structured field that carries it (an
//     event's start, a due date they gave), or (b) words they said in a source marked fresh (the call that just ended), never
//     by background (recaps, summaries) and never by older things they said, whose "Friday" has long since gone by.
//   - An event, deadline or commitment (a pitch, an investor ask, a meeting, a launch) is backed only by something they actually
//     said or a structured field, never by background alone.
//   - The generic windows (today, this week, this weekend, next week) are allowed only inside a QUESTION: asking "anything
//     coming up this week?" invents nothing; stating "good luck Friday" does.
// A message with an unbacked specific is redrafted once with the problem named (cut it, or ask instead); if it still has one, it
// is not sent. This lives in the one place every proactive draft goes through (harness/proactive.ts draftProactive), so no
// caller can opt out and an invented date cannot reach a member, whatever the prompt says.
import { DateTime } from "luxon";

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// A day, a date, a time, or a relative moment: each one is a claim about when.
const TEMPORAL: { re: RegExp; kind: "day" | "date" | "time" | "relative" }[] = [
  { re: new RegExp(`\\b${WEEKDAY}\\b`, "gi"), kind: "day" },
  { re: new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"), kind: "date" },
  { re: /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, kind: "date" },
  { re: /\b\d{4}-\d{2}-\d{2}\b/g, kind: "date" },
  { re: /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi, kind: "time" },
  { re: /\b(?:noon|midnight)\b/gi, kind: "time" },
  { re: /\b(?:tomorrow|tonight|this (?:morning|afternoon|evening|weekend|week|month)|next (?:week|month|weekend|year)|later today|end of (?:the )?(?:day|week|month)|in (?:a|an|\d+|a few|two|three|four|five) (?:days?|weeks?|hours?|months?))\b/gi, kind: "relative" },
];

// Windows that are fine to ASK about: a question about them invents nothing.
const GENERIC_WINDOW = /^(?:today|tonight|this week|this month|this weekend|next week|this (?:morning|afternoon|evening)|later today)$/i;

// An event, a deadline or a commitment: a thing that is happening or due.
const EVENT_NOUN = /\b(?:pitch(?:es|ing|ed)?|investors?|fundrais\w*|raising|series [a-c]|seed round|deck|meetings?|interviews?|launch(?:es|ing)?|demo(?:s|ing)?|presentations?|deadlines?|due date|wedding|flights?|surgery|appointments?|exams?|offsite|signing|closing date)\b/gi;

// Keys that are orientation only: a recap or a summary of older conversations. They can tell Co what someone is about; they can
// never back a date, an event or a commitment.
const BACKGROUND_KEY = /background|recap|context_summary|earlier_summary|history|what_you_know/i;
// Keys that hold what someone SAID. Their wording backs an event (they did mention a pitch) but a day word in it is only as fresh
// as when it was said, so it backs a date only if the source is marked fresh.
const SPOKEN_KEY = /own_words|recent_texts|quote|transcript|their_words|said|told|gist|the_thing|thing_they|what_they|something_they|about_them/i;

export type FactsLike = Record<string, string | number | boolean | string[] | null | undefined>;

const flat = (v: unknown): string => (Array.isArray(v) ? v.join("; ") : v === null || v === undefined ? "" : String(v));

// What the member said in a transcript, not what Co said (Co's lines can repeat a stale fact it was given).
export function theirLinesOnly(text: string): string {
  if (!/^\s*(?:user|assistant)\s*:/im.test(text)) return text;
  return text
    .split("\n")
    .filter((l) => /^\s*user\s*:/i.test(l))
    .join("\n");
}

export type Evidence = { structured: string; spoken: string; fresh: string; background: string };

export function evidenceOf(facts: FactsLike, freshKeys: string[] = []): Evidence {
  const e: Evidence = { structured: "", spoken: "", fresh: "", background: "" };
  for (const [k, v] of Object.entries(facts)) {
    const text = flat(v);
    if (!text) continue;
    if (BACKGROUND_KEY.test(k)) e.background += `\n${text}`;
    else if (freshKeys.includes(k)) e.fresh += `\n${theirLinesOnly(text)}`;
    else if (SPOKEN_KEY.test(k)) e.spoken += `\n${text}`;
    else e.structured += `\n${text}`;
  }
  return e;
}

// One canonical spelling per claim, so "7:00 PM" backs "7pm" and "Oct 9th" backs "October 9".
export function canon(token: string): string {
  const t = token.toLowerCase().replace(/\s+/g, " ").trim();
  const time = t.match(/^(\d{1,2})(?::(\d{2}))?\s?(am|pm)$/);
  if (time) return `${Number(time[1])}${time[2] && time[2] !== "00" ? `:${time[2]}` : ""}${time[3]}`;
  const md = t.match(new RegExp(`^(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?$`));
  if (md) return `${MONTHS.find((m) => m.startsWith(md[1].slice(0, 3)))} ${Number(md[2])}`;
  return t.replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s$/, "$1");
}

type Hit = { text: string; kind: "day" | "date" | "time" | "relative"; sentence: string };
function temporalHits(text: string): Hit[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: Hit[] = [];
  for (const s of sentences) for (const { re, kind } of TEMPORAL) for (const m of s.matchAll(new RegExp(re.source, re.flags))) out.push({ text: m[0], kind, sentence: s });
  return out;
}
const tokensIn = (text: string): Set<string> => new Set(temporalHits(text).map((h) => canon(h.text)));

// What a future date in a structured field backs: its weekday, its month and day, today/tomorrow. A past date backs nothing.
export function datesBacked(structured: string, now: Date, zone = "America/Los_Angeles"): Set<string> {
  const out = new Set<string>();
  const today = DateTime.fromJSDate(now).setZone(zone).startOf("day");
  for (const m of structured.matchAll(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?/g)) {
    const d = DateTime.fromISO(m[0], { zone }).startOf("day");
    if (!d.isValid || d < today) continue;
    out.add(WEEKDAYS[d.weekday % 7]);
    out.add(`${MONTHS[d.month - 1]} ${d.day}`);
    if (+d === +today) { out.add("today"); out.add("tonight"); out.add("later today"); out.add("this evening"); out.add("this afternoon"); out.add("this morning"); }
    if (+d === +today.plus({ days: 1 })) out.add("tomorrow");
  }
  return out;
}

export type Unbacked = { text: string; why: string };

// "You told me...", "you've been prepping...", "you're weighing...": stating something back AS THEIRS. That is only honest when what
// follows is in something they said (or a structured field). If Co only inferred it, the message has to ask, not assert.
const ATTRIBUTION = [
  /\byou(?:'ve| have)?\s+(?:told|said|mentioned|shared|been telling)\b([^.?!]*)/gi,
  /\byou(?:'re| are| were|'ve been| have been)\s+(?:prepping|preparing|weighing|considering|worried|worrying|planning|pitching|raising|working on|thinking about|dealing with|stressed|nervous|exploring|trying|deciding|building toward|gearing up)\b([^.?!]*)/gi,
];
const FILLER = new Set(["that", "this", "with", "from", "about", "your", "have", "been", "they", "what", "when", "then", "there", "their", "them", "more", "just", "some", "still", "also", "into", "over", "very", "much", "only", "even", "ever", "back", "last", "week", "today", "really", "feel", "feels", "like", "kind", "sort"]);
function attributions(text: string, facts: FactsLike, freshKeys: string[]): Unbacked[] {
  const ev = evidenceOf(facts, freshKeys);
  const theirs = `${ev.structured}\n${ev.spoken}\n${ev.fresh}`.toLowerCase();
  const out: Unbacked[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (/\?\s*$/.test(sentence.trim())) continue; // asking is how it is meant to be done
    for (const re of ATTRIBUTION) {
      for (const m of sentence.matchAll(new RegExp(re.source, re.flags))) {
        // What is being attributed: the clause after the verb (up to a comma or "so/but/because"), and, when nothing follows it
        // ("the investor pitch you've been prepping."), the few words before it.
        const after = m[1].split(/[,;]|\b(?:so|but|because)\b/i)[0];
        const before = sentence.slice(0, m.index ?? 0).trim().split(/\s+/).slice(-5).join(" ");
        const object = /[a-z]{4}/i.test(after) ? after : before;
        const words = (object.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !FILLER.has(w) && !/^(?:you|let|that|here|there|what|it)'(?:re|ve|s|ll|d)$/.test(w));
        if (!words.length) continue;
        const backed = words.filter((w) => theirs.includes(w.replace(/(?:ing|ed|es|s)$/, "").slice(0, 5)));
        if (backed.length / words.length < 0.5) out.push({ text: m[0].trim().slice(0, 60), why: "something only Cue inferred (or read in the background), stated back as theirs" });
      }
    }
  }
  return out;
}

// For a REPLY (not an unprompted message): "you've been prepping X", "you told me X" stated back as theirs, where X is in nothing
// they said recently and nothing on file. The words to check against are the member's own (this message and the recent thread, their
// lines only) plus the facts the reply was given; Co's own earlier texts never back it (2026-10-06: asked "What's Friday?", Co defended
// its own earlier text instead of owning that it had no source).
export function attributedWithoutSource(text: string, facts: FactsLike): Unbacked[] {
  return attributions(text, facts, []);
}

// Every specific in an outgoing message that nothing real backs.
export function unbackedSpecifics(text: string, facts: FactsLike, o: { freshKeys?: string[]; now?: Date; zone?: string } = {}): Unbacked[] {
  const ev = evidenceOf(facts, o.freshKeys);
  const now = o.now ?? new Date();
  // When a day or time was said (in a source marked fresh) or sits in a structured field, it is backed; past-dated ISO values don't count.
  const timeBacked = new Set<string>([...tokensIn(ev.structured.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")), ...tokensIn(ev.fresh), ...datesBacked(ev.structured, now, o.zone)]);
  const eventBacked = `${ev.structured}\n${ev.spoken}\n${ev.fresh}`.toLowerCase();
  const out: Unbacked[] = [];
  const seen = new Set<string>();
  for (const h of temporalHits(text)) {
    const c = canon(h.text);
    if (seen.has(c) || timeBacked.has(c)) continue;
    // Asking about a generic window states nothing: "anything coming up this week?"
    if (GENERIC_WINDOW.test(c) && /\?\s*$/.test(h.sentence.trim())) continue;
    seen.add(c);
    out.push({ text: h.text, why: h.kind === "day" || h.kind === "date" ? "a day or date nothing they said just now, and no date on file, backs" : "a time nothing real backs" });
  }
  out.push(...attributions(text, facts, o.freshKeys ?? []));
  for (const m of text.matchAll(new RegExp(EVENT_NOUN.source, EVENT_NOUN.flags))) {
    const stem = m[0].toLowerCase().replace(/(?:es|ing|ed|s)$/, "").slice(0, 5);
    if (seen.has(stem) || eventBacked.includes(stem)) continue;
    seen.add(stem);
    out.push({ text: m[0], why: "an event or commitment they didn't tell you about (it is only in older background)" });
  }
  return out;
}

// The words handed back to the model when a draft has an unbacked specific.
export function feedbackFor(bad: Unbacked[]): string {
  return `it states ${bad.map((b) => `"${b.text}"`).join(", ")}: ${bad[0].why}. Cut it, or ask instead of stating (a question about a generic window, like what is coming up this week, is fine). Never take a day, an event or a commitment from the background, and never say "you told me" or "you've been prepping/weighing/worried" about anything they did not say themselves.`;
}
