// Hard rules for a reply, checked by code (Royce, 2026-10-29: "Let code check the hard rules: no invented facts, no status lines, no
// stock phrases, no machinery talk. Free, deterministic, not tied to exact wording"). Every golden reply (evals/golden/replies.ts) and
// every texting-eval reply (evals/texting/grade.ts, pairwise.ts) runs through these, in replay and live alike. Pure: no model, no I/O.
//
// Each rule is a line Cue never crosses, written tight so a miss is a real one; tone and depth are the model judge's (evals/lib/
// replyRubric.ts), in the scheduled quality run. The matchers are the product's own where one exists:
//   invented:   services/offerGuard.ts spokenProblem (every name, place, clock time and number has to be in what the turn stood on)
//   stock:      harness/stockLines.ts stockLine and textStockSentence
//   voice:      services/coVoice.ts VOICE_PUNCTUATION (no exclamation points, no em dashes)
import { prepareSource, spokenProblem, SPOKEN_COMMON } from "../../src/services/offerGuard.js";
import { stockLine, textStockSentence } from "../../src/harness/stockLines.js";
import { askedForSomething, reOffers, repeatsSent } from "../../src/agent/secondSend.js";

export type TurnKind = "checkin" | "share" | "feedback" | "find" | "reply";
// One text that went out this turn: Cue's reply (sendReply), a find or link line (shareFinds, shareLink), or the fallback.
export type Send = { kind: "reply" | "find" | "link" | "fallback"; text: string };

export type HardRuleInput = {
  // Everything Cue sent this turn, joined (the reply as the member reads it).
  text: string;
  // Each text that went out, in order. Without it, the text counts as one reply.
  sends?: Send[];
  tools?: string[];
  kind: TurnKind;
  // What the turn stood on: the rendered facts, what Cue knows about them, their world. A name or number from here is not invented.
  facts: string;
  // The member's own words: this message and their earlier lines.
  theirLines: string[];
  // Cue's earlier lines in the thread (a quote of one back is a miss; they also back a name: they are the case's given history).
  coLines: string[];
  firstName?: string;
  // The finds this turn carried (their links), for link-then-caption.
  findUrls?: string[];
  // Their message this turn: whether it asks for something decides if a second reply may go (#444).
  message?: string;
};

const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const words = (s: string) => norm(s).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
export const sentencesOf = (text: string) => norm(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
const bareUrl = (s: string) => /^\s*https?:\/\/\S+\s*$/.test(s);
const trimUrl = (u: string) => u.replace(/[.,!?;:]+$/, "");

// ---- 1. No invented facts: every name, place, clock time, number and link is in the facts, the thread or their words.
// Words that are Cue's own world or everyday trade words, not a claim about theirs.
const OWN = "Cue Noise iMessage DJ DJs MC PR HR";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/gi;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY = 86_400_000;
// Advice units: a range followed by one of these is how-to ("20-30 min", "3-4 pairs", "4-6 people per table"), not a claim. Any other
// range is a number like any other ("seats 40-60 people", "3000 to 3500 a month"): it has to be in what the turn stood on.
const ADVICE_UNIT = /^(?:\s+[a-z]+)?\s*(?:min|mins|minutes?|hours?|hrs?|seconds?|secs?|pairs?|intros?|introductions?|people (?:per|a|at each|to a) table|(?:per|a) table|tables?|spots?|options?|names?|ideas?|lines?|sentences?|messages?|texts?|questions?|bullets?|points?|slides?|words?|drinks?|conversations?|rounds?|beats?|follow-?ups?|times?)\b/i;
// The dates the turn stood on, as day numbers (UTC midnight): ISO dates, and month-day dates with the year given or the context's year.
function datesIn(text: string, year: number | null): number[] {
  const out = [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].map((m) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  for (const m of text.matchAll(MONTH_DAY)) {
    const y = m[3] ? Number(m[3]) : year;
    const mo = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3));
    if (y) out.push(Date.UTC(y, mo, Number(m[2])));
    // No year anywhere: the same month-day in the two years around it (a gap is the same unless it crosses a year end).
    else out.push(Date.UTC(2026, mo, Number(m[2])), Date.UTC(2027, mo, Number(m[2])), Date.UTC(2025, mo, Number(m[2])));
  }
  return out;
}
// Text that carries no fact of its own, cleared before the check (review of #318: 12 of 40 real replies were flagged for these):
//   a numbered-list marker at a line's start ("3. The proof point"); an advice range ("20-30 min", "3-4 pairs"; review round 2: only
//   with an advice unit after it); and date arithmetic that can be worked out from a date the turn stood on (review round 2: "Today is"
//   alone covers no arbitrary ordinal): a month and day within a month of a given date ("Oct 16" when today is Oct 13), "the 15th" when
//   a given date is the 15th or the weekday before it names a day within a month of one ("Thursday the 15th"), and "N days" (or weeks)
//   when two dates it stood on or named are N days apart (a day either way, for the member's own time zone). Anything else is checked.
export function withoutNonFacts(text: string, given: string): string {
  let t = text.replace(/^\s*\d{1,2}[.)]\s+/gm, "").replace(/\b\d+(?:\.\d+)?\s*(?:-|–|to)\s*\d+(?:\.\d+)?\b/g, (all, at: number, whole: string) => (ADVICE_UNIT.test(whole.slice(at + all.length)) ? " a range " : all));
  const year = Number((given.match(/\b(20\d{2})\b/) ?? [])[1]) || null;
  const known = datesIn(given, year);
  if (!known.length) return t;
  const near = (d: number) => known.some((k) => Math.abs(k - d) <= 31 * DAY);
  // Month-day dates in the reply: within a month of a given date, the day number is cleared (the month stays, a name like any other: the
  // word as written, "October" not "Oct", or the name check reads a cut word as a new name).
  const named: number[] = [];
  t = t.replace(MONTH_DAY, (all, m: string, d: string, y?: string) => {
    const days = datesIn(all, y ? Number(y) : year);
    if (!days.some(near)) return all;
    named.push(...days);
    return all.match(/^[a-z]+/i)?.[0] ?? m;
  });
  // "the 15th": a given date's own day, or a weekday-and-ordinal that falls within a month of a given date.
  const knownDays = new Set(known.map((k) => new Date(k).getUTCDate()));
  // Never a month's own ordinal ("March 10th" far from any date stays checked).
  t = t.replace(/(?<!\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)\b(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/gi, (all, wd: string | undefined, n: string) => {
    const day = Number(n);
    if (!wd) return knownDays.has(day) ? " " : all;
    const want = WEEKDAYS.indexOf(wd.toLowerCase().slice(0, 3));
    const hits = known.flatMap((k) => Array.from({ length: 63 }, (_, i) => k + (i - 31) * DAY)).filter((d) => new Date(d).getUTCDate() === day && new Date(d).getUTCDay() === want);
    if (!hits.length) return all;
    named.push(...hits);
    // The weekday as written ("Thursday", not the "Thu" the pattern captured).
    return ` ${all.match(/^[a-z]+/i)?.[0] ?? wd} `;
  });
  // "18 days out": two dates it stood on or named, that many days apart.
  const all = [...known, ...named];
  const gaps = all.flatMap((a, i) => all.slice(i + 1).map((b) => Math.round(Math.abs(a - b) / DAY)));
  return t.replace(/\b(\d{1,3})(\s*|-)(days?|weeks?)\b/gi, (whole, n: string, sep: string, unit: string) => {
    const days = Number(n) * (/^w/i.test(unit) ? 7 : 1);
    const slack = /^w/i.test(unit) ? 3 : 1;
    return gaps.some((g) => Math.abs(g - days) <= slack) ? ` ${unit}` : whole;
  });
}
// A one-word capitalized name opening a quote (Say "Marcus sent me"): the quote's first word is a sentence start to the name check, so a
// name there is checked on its own (review round 2 of #318). Common openers of a quoted line are not names.
const QUOTE_OPENERS = new Set(`i i'm i'll i've i'd you you're you'll you've we we're we'll they they're he she it it's its my your our their me us the a an this that these those some any all each every no not nothing something anything everything everyone someone anyone nobody both either neither one another other most many few much more less is are was were am be been do does did don't doesn't didn't can can't could would should will won't shall may might must have has had let let's what what's who where when why how which and but or so if because since as at in on for with without from to of by about after before until while though although just also still even only then now here there there's here's that's today tonight tomorrow yesterday maybe perhaps honestly really actually quick hey hi hello yes yeah yep nope ok okay sure thanks thank sorry congrats congratulations wow oh ah well please cheers welcome great good nice glad happy love loved excited looking totally absolutely definitely fair agreed right exactly give tell say ask send take make keep try come go get got bring call text meet join grab check look think know want need hope feel see remember mind count put stop start wait book pick thought long big first last next real`.split(/\s+/));
function quoteOpenerNames(sentence: string, src: { all: ReturnType<typeof prepareSource> }): string[] {
  const out: string[] = [];
  for (const m of sentence.matchAll(/(?:^|[\s(:])"([A-Z][a-z'’]+)(?=[\s,.!?;:"]|$)(?!\s+[A-Z])/g)) {
    const w = m[1];
    if (QUOTE_OPENERS.has(w.toLowerCase().replace(/’/g, "'"))) continue;
    // The product's own backing (plurals, a name it only shortens), with the word placed mid-sentence.
    const p = spokenProblem(`so ${w}`, { all: src.all, asked: src.all });
    if (p && p.kind !== "promise") out.push(w);
  }
  return out;
}
// Names Cue clearly introduces as made up, in a hypothetical it labels as one (Royce, 2026-11-11: "call them Dana and Priya" in a
// walkthrough is fine): "call them X and Y", "say X and Y", "let's say X", "imagine X", "a guest named X". They count as given for the
// whole turn; a name with no such label is still checked ("Dana from the dinner said she'd love to meet you").
const NAME = "[A-Z][a-z]+";
const NAME_LIST = `${NAME}(?:(?:,\\s*|,?\\s+and\\s+|\\s+or\\s+)${NAME})*`;
const INTRODUCES = new RegExp(`\\b(?:[Cc]all(?:ing)? (?:them|him|her|the [a-z]+(?: [a-z]+)?)|(?:[Ss]omeone|[Aa] [a-z]+|[Tt]wo [a-z]+|[Oo]ne [a-z]+) (?:named|called)|(?:[Ll]et'?s say|[Jj]ust say|[Ss]ay)|[Ii]magine|[Ss]uppose|[Pp]icture)\\s+(${NAME_LIST})\\b`, "g");
const LABELED = /\b(?:say|imagine|suppose|picture|hypothetical|for example|let'?s say|call (?:them|him|her)|named|called)\b/i;
export function hypotheticalNames(text: string): string[] {
  if (!LABELED.test(text)) return [];
  return [...norm(text).matchAll(INTRODUCES)].flatMap((m) => m[1].split(/,\s*|,?\s+and\s+|\s+or\s+/)).filter((w) => !NOT_INTRODUCED.has(w));
}
// Capitalized words after "say" that open a clause, not a name ("Say I tell Dana", "say It's").
const NOT_INTRODUCED = new Set(["I", "It", "Its", "That", "This", "The", "We", "You", "They", "He", "She", "There", "What", "When", "If", "Yes", "No"]);
export function inventedFacts(i: HardRuleInput): string[] {
  const given = [i.facts, ...i.theirLines, ...i.coLines, i.firstName ?? "", ...hypotheticalNames(i.text)].join("\n");
  const src = { all: prepareSource(`${given}\n${SPOKEN_COMMON} ${OWN}`), asked: prepareSource(given) };
  const out: string[] = [];
  // A quote mark opens its own sentence: the capital after it ("Give", "Thanks") is a first word, not a name.
  const sentences = sentencesOf(withoutNonFacts(i.text.replace(URL_RE, " "), given));
  for (const s of sentences) for (const w of quoteOpenerNames(s, src)) out.push(`a name nothing gave it (${w}): "${s.slice(0, 120)}"`);
  const pieces = sentences.flatMap((s) => s.split(/["“”]/).map((x) => x.trim()).filter(Boolean));
  for (const s of pieces) {
    const p = spokenProblem(s, src);
    // A promise of later work is the product's own fact check's call (it reads the task list); here only names, times and numbers.
    if (p && p.kind !== "promise") out.push(`${p.kind === "number" ? "a number" : p.kind === "event" ? "an event detail" : "a name"} nothing gave it (${p.missing.join(", ")}): "${s.slice(0, 120)}"`);
  }
  const known = new Set((given.match(URL_RE) ?? []).map(trimUrl));
  for (const u of (i.text.match(URL_RE) ?? []).map(trimUrl)) if (!known.has(u) && !(i.findUrls ?? []).includes(u)) out.push(`a link nothing gave it: ${u}`);
  return out;
}

// ---- 2. No system-status talk on a check-in: presence and one item of their world, never a report on Cue's own state.
export const STATUS_TALK = [
  /\bnothing (?:is |'s )?(?:running|waiting|pending|queued|new|scheduled|in progress|on (?:my|your) (?:end|plate|radar|list))\b/i,
  /\bnothing (?:to report|from me|on my end|on my side)\b/i,
  /\bno (?:updates?|news) (?:from|on) (?:me|my end|my side)\b/i,
  /\bon your radar\b/i,
  /\ball (?:quiet|clear) (?:on|from|here)\b/i,
  /\b(?:status|quick) (?:update|report|check)\b/i,
  /\b(?:here'?s|quick) (?:where things stand|what'?s (?:going on|happening) (?:on my end|with me))\b/i,
];
export function statusTalk(text: string): string[] {
  return STATUS_TALK.flatMap((re) => { const m = norm(text).match(re); return m ? [`a status line on a check-in: "${m[0]}"`] : []; });
}

// ---- 3. No stock empathy: a phrase that fits any answer (harness/stockLines.ts), never a sentence that is only "Makes sense."
export function stockEmpathy(text: string): string[] {
  return sentencesOf(text).flatMap((s) => {
    const phrase = stockLine(s);
    if (phrase) return [`a stock phrase: "${phrase}"`];
    return textStockSentence(s) ? [`a stock sentence: "${s.slice(0, 60)}"`] : [];
  });
}

// ---- 4. No machinery narration: Cue never talks about its systems, tools, prompts, errors or retries (TOOL_FAILURE_RULE).
export const MACHINERY = [
  /\bon my (?:end|side)\b/i,
  /\bmy (?:systems?|pipeline|backend|queue|database|tools?|tooling|instructions|prompt|programming|training|context window|logs?)\b/i,
  /\b(?:the|a) (?:fact[- ]check|tool call|system prompt|language model)\b/i,
  /\bas an ai\b|\bi'?m (?:just )?an ai\b/i,
  /\b(?:the|my) (?:search|searches|lookup|tool) (?:returned|failed|errored|timed out|came back (?:empty|with nothing))\b/i,
  /\b(?:hit|got|ran into|threw) (?:an? )?(?:error|glitch|bug|timeout|rate limit)\b/i,
  /\b(?:retry|retrying|retried|try again later)\b/i,
];
export function machinery(text: string): string[] {
  return MACHINERY.flatMap((re) => { const m = norm(text).match(re); return m ? [`talks about its own machinery: "${m[0]}"`] : []; });
}

// ---- 5. No quoting its own earlier line back ("That deserved more than 'nice evening'"): a quoted span of 2+ words from what Cue sent.
// A span the member said first is theirs, even when Cue's earlier line quoted it too (review of #318: their founding-story line).
export function quotesOwnLine(text: string, coLines: string[], theirLines: string[] = []): string[] {
  const t = norm(text);
  const spans = [...t.matchAll(/"([^"\n]{3,160})"/g), ...t.matchAll(/(?:^|[\s(])'([^'\n]{3,160})'(?=[\s.,!?;:)]|$)/g)].map((m) => m[1]);
  const has = (lines: string[], q: string) => lines.map(words).some((l) => ` ${l} `.includes(` ${words(q)} `));
  return spans.filter((q) => words(q).split(" ").length >= 2 && has(coLines, q) && !has(theirLines, q)).map((q) => `quotes its own earlier line back: "${q}"`);
}

// ---- 6. Link then caption: a find goes out as its link alone, then a caption that isn't a link; never inside prose.
export function linkThenCaption(sends: Send[], findUrls: string[]): string[] {
  const finds = new Set(findUrls.map(trimUrl));
  const isFind = (s: string) => bareUrl(s) && finds.has(trimUrl(s.trim()));
  const out: string[] = [];
  sends.forEach((s, i) => {
    if (isFind(s.text)) {
      const next = sends[i + 1]?.text ?? "";
      if (!next.trim() || bareUrl(next)) out.push(`a find's link with no caption after it: ${s.text.trim()}`);
    } else if ((s.text.match(URL_RE) ?? []).some((u) => finds.has(trimUrl(u)))) out.push(`a find's link inside prose (a find is its link, then a caption): "${s.text.slice(0, 120)}"`);
  });
  return out;
}

// ---- 7. One reply a turn: one sendReply text, unless a tool brought something new after it went out (TOOL_TURN_RULES), or they asked
// for something and the next text carries what's new (#444, agent/conversationTools.ts wrapSendsForOneReply: the send path lets it go,
// and to them it reads like the reply's next paragraph). Then only what the send path would hold is a miss: a text that repeats what
// went (repeatsSent), a second offer (reOffers), or more continuing texts than it allows (MAX_CONTINUING_SENDS, 2).
const WORK_TOOLS = new Set(["searchEvents", "webSearch", "searchPosts", "readPage", "shareFinds", "researchBrief", "startTask", "writeDocument", "makePage", "makeDeck", "followUp", "moveLane", "readDocument"]);
export function repliesPerTurn(sends: Send[], tools: string[], message?: string): string[] {
  const replies = sends.filter((s) => s.kind === "reply" && s.text.trim());
  if (replies.length <= 1 || tools.some((t) => WORK_TOOLS.has(t))) return [];
  if (message === undefined || !askedForSomething(message)) return [`${replies.length} replies in one turn: ${replies.map((r) => `"${r.text.slice(0, 50)}"`).join(" / ")}`];
  const out: string[] = [];
  replies.forEach((r, i) => {
    if (!i) return;
    const said = replies.slice(0, i).map((x) => x.text);
    if (repeatsSent(r.text, said)) out.push(`a second reply that repeats what went: "${r.text.slice(0, 80)}"`);
    else if (reOffers(r.text, said)) out.push(`a second offer in one turn: "${r.text.slice(0, 80)}"`);
  });
  if (replies.length > 3) out.push(`${replies.length} replies in one turn: more continuing texts than the send path allows`);
  return out;
}

// ---- 8. Voice style: no exclamation points, no em dashes (coVoice.ts VOICE_PUNCTUATION; review round 2 of #318).
export function voiceStyle(text: string): string[] {
  const t = norm(text).replace(URL_RE, " ");
  return [...(/!/.test(t) ? [`an exclamation point: "${(t.match(/[^.!?\n]*!/) ?? [""])[0].trim().slice(-80)}"`] : []), ...(/—/.test(t) ? [`an em dash: "${(t.match(/.{0,40}—.{0,40}/) ?? [""])[0].trim()}"`] : [])];
}

// Every hard rule that applies to this turn. An empty reply (a tapback alone) has nothing to check.
export function hardRuleMisses(i: HardRuleInput): string[] {
  const sends = i.sends ?? (i.text.trim() ? [{ kind: "reply" as const, text: i.text }] : []);
  const prose = sends.filter((s) => !bareUrl(s.text)).map((s) => s.text).join("\n") || (sends.length ? "" : i.text);
  if (!prose.trim() && !sends.length) return [];
  return [
    ...inventedFacts({ ...i, text: sends.map((s) => s.text).join("\n") || i.text }),
    ...(i.kind === "checkin" ? statusTalk(prose) : []),
    ...stockEmpathy(prose),
    ...machinery(prose),
    ...quotesOwnLine(prose, i.coLines, i.theirLines),
    ...linkThenCaption(sends, i.findUrls ?? []),
    ...repliesPerTurn(sends, i.tools ?? [], i.message),
    ...voiceStyle(prose),
  ];
}

// What kind of turn a message opens, when the case doesn't say: a check-in ("just checking in", a bare greeting), or the moment read.
const BARE_GREETING = /^\s*(?:hey|hi|hello|yo|morning|evening|good (?:morning|afternoon|evening))\b[\s,!.]*(?:(?:there|cue|co|you)\b[\s,!.]*)?$/i;
export function turnKind(message: string, moment?: string | null): TurnKind {
  if (/\bchecking in\b|\bcheck(?:ing)? in on you\b/i.test(message) || BARE_GREETING.test(message)) return "checkin";
  if (moment === "sharing") return "share";
  if (moment === "feedback") return "feedback";
  return "reply";
}
