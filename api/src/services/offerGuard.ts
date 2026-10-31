// Real finds only (Royce, 2026-10-06): Co names an event, a place or a time only when a source row backs it. A call's brain can
// compose a plausible event from nothing; on a call nobody can check the text first. So every sentence Co is about to say that
// offers or places an event is checked against what the call was GIVEN (its context, the finds list, the clock) and what the
// member has said. A name or a time with no source in those is not said.
//
// Pure. The source corpus never includes Co's own earlier lines (a made-up name, once said, must not source itself).
// (The imports are for their pure matchers only: the task texts' number check and the promise patterns.)
import { numbersBacked } from "./taskWeb.js";
import { PROMISE_RE } from "./promises.js";
import { COMMIT_RE } from "./callCommitments.js";
const EVENT_WORDS = /\b(events?|workshops?|fairs?|pop-?ups?|concerts?|panels?|meet-?ups?|mixers?|dinners?|parties|party|classes|class|festivals?|launch(?:es)?|demo days?|hackathons?|retreats?|happening|going on|gatherings?|sessions?|tournaments?|markets?|screenings?|exhibits?|reception)\b/i;
const TIME = /\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b/gi;
const MONTHS_DAYS = new Set("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(" "));
// Capitalized words that are not names of anything.
const NOT_NAMES = new Set(["i", "i'm", "i'll", "i've", "i'd", "co", "cue", "ok", "okay", "yes", "no", "sure", "so", "and", "but", "or", "that", "this", "it", "it's", "that's", "there", "there's", "here", "if", "when", "what", "who", "where", "why", "how", "want", "would", "could", "should", "do", "does", "did", "are", "is", "was", "can", "will", "you", "you're", "your", "we", "they", "he", "she", "the", "a", "an", "both", "either", "maybe", "right", "good", "great", "got", "just", "now", "then", "also", "one", "two", "three", "some", "any", "all", "not", "nothing", "something", "everything", "anything", "talk", "text", "let", "let's", "talking", "thanks", "thank", "hey", "hi", "hello"]);

const norm = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export type Mention = { text: string; kind: "name" | "time" };

// The names (capitalized runs after the sentence's first word) and clock times a sentence puts forward.
export function mentionsIn(sentence: string): Mention[] {
  const clean = sentence.replace(/\[[a-z][a-z ]*\]\s*/gi, "");
  const out: Mention[] = [];
  for (const m of clean.match(TIME) ?? []) out.push({ text: m, kind: "time" });
  const words = clean.split(/\s+/).filter(Boolean);
  let run: string[] = [];
  const flush = () => { if (run.length) out.push({ text: run.join(" "), kind: "name" }); run = []; };
  words.forEach((w, i) => {
    const bare = w.replace(/^[("'“]+|[)"'”.,!?;:]+$/g, "");
    const lower = bare.toLowerCase();
    if (i === 0) return; // a capital at the start of a sentence says nothing
    if (/^[A-Z]/.test(bare) && !NOT_NAMES.has(lower) && !MONTHS_DAYS.has(lower)) {
      run.push(bare);
      if (/[.,!?;:]$/.test(w)) flush();
      return;
    }
    if (run.length && /^(of|the|at|for|and|&|de|la)$/i.test(bare)) { run.push(bare); return; }
    flush();
  });
  flush();
  // A run that ended on a joiner ("... of") is just the name before it.
  return out.map((m) => (m.kind === "name" ? { ...m, text: m.text.replace(/(?:\s+(?:of|the|at|for|and|&|de|la))+$/i, "") } : m)).filter((m) => m.text.length > 1);
}

// The sentence offers or places an event (the only sentences this checks: "Jacqueline's leading that one" is not one).
export const placesAnEvent = (sentence: string) => EVENT_WORDS.test(sentence) || new RegExp(TIME.source, "i").test(sentence);

// Whether every name and time in an event sentence is backed by the source text. Returns what was not.
export function unsourced(sentence: string, source: string | Source): Mention[] {
  if (!placesAnEvent(sentence)) return [];
  return unbackedMentions(mentionsIn(sentence), typeof source === "string" ? prepareSource(source) : source);
}

// A source text, normalized once: the spoken checks run per sentence on the voice's hot path, against the whole call.
export type Source = { raw: string; hay: string; flat: string; nums: Set<string> };
// A contraction's tail is not part of the word they said: "RSVP'd" backs "RSVP" (2026-10-12, a document was refused for it).
export const prepareSource = (source: string): Source => ({ raw: source, hay: norm(`${source}\n${source.replace(/(\w)['’](?:d|ll|re|ve)\b/gi, "$1")}`), flat: squash(source), nums: numbersOf(source, true) });

// The numbers in a text, as whole numbers ("$3,000" is 3000, "20th" is 20, never the "20" inside "2026"). The extraction is
// taskWeb numbersBacked's; its substring match is too loose for a whole call's prompt, so a number here has to be a whole one.
// A source's written-out numbers count too ("about sixty people" backs "60").
const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100" };
export function numbersOf(text: string, withWords = false): Set<string> {
  const out = new Set(numbersBacked(text, "").missing.map((n) => n.replace(/\.0+$/, "")));
  if (withWords) for (const w of text.toLowerCase().match(/\b[a-z]+\b/g) ?? []) if (NUMBER_WORDS[w]) out.add(NUMBER_WORDS[w]);
  return out;
}

function unbackedMentions(mentions: Mention[], src: Source): Mention[] {
  return mentions.filter((m) => {
    if (m.kind === "time") return !src.flat.includes(squash(m.text).replace(/m$/, "m"));
    const n = norm(m.text.replace(/['’]s$/i, ""));
    if (src.hay.includes(n)) return false;
    // A plural of a backed word is backed ("PDFs" for "PDF", 2026-10-08 live call: "Should I keep sending PDFs?" was replaced).
    const singular = (w: string) => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
    if (src.hay.includes(n.replace(/\S+/g, singular))) return false;
    // A name the sentence only shortens or re-cases ("Sequent" for "Sequent AI") still has a source.
    const parts = n.trim().split(" ").filter((p) => p.length > 2);
    const has = (p: string) => src.hay.includes(` ${p} `) || src.hay.includes(` ${p}'s `) || src.hay.includes(` ${p}s `);
    return !(parts.length && parts.every((p) => has(p) || has(singular(p))));
  });
}

// What the call was given and what the member said: system text, the member's own lines, tool results. Never Co's lines.
export function sourceCorpus(parts: { system?: string; theirLines?: string[]; toolResults?: string[] }): string {
  return [parts.system ?? "", ...(parts.theirLines ?? []), ...(parts.toolResults ?? [])].join("\n");
}

// ---------- Everything said aloud (Royce, 2026-10-08: "Anything Co says aloud on a call (names, places, numbers) passes the same
// real-finds-only check as text. Unknown stays unknown, said as 'I'm not sure.'")
// The event check above covers only sentences that offer or place an event. This covers every spoken sentence, with the same
// matching: each name, place and clock time (mentionsIn) and each number (taskWeb numbersBacked, the task texts' check) has to be in
// what the call stands on: its context and prompt, the member's own words on this call, what Co's tools returned this turn, and
// Co's records (its open tasks, what it did earlier on the call). And a promise of later work (callCommitments COMMIT_RE,
// promises PROMISE_RE, or "I'll look into / find / research") has to be about something they asked for on this call, something a
// tool did this turn, or Co's own open work: "I'll text you what I find on venues" when nobody mentioned venues is not said
// (2026-10-08 live call: it was, and a spoken promise becomes a task).
// Pure and per sentence: a few string scans against sources normalized once per turn. No model on the voice's path.

export type SpokenSources = {
  // Everything a name or number may stand on.
  all: Source;
  // What a promise may stand on: never the prompt's own instructions and examples (they mention venues, caterers, sponsors...).
  asked: Source;
};
export type SpokenProblem = { kind: "event" | "name" | "number" | "promise"; missing: string[] };

// Said in place of a sentence whose name or number nothing backs: unknown stays unknown, once per turn.
export const UNSURE_NAME = "I'm not sure of the name.";
export const UNSURE_NUMBER = "I'm not sure of the exact number.";
// Said when everything else this turn was held back and none of it was an event offer (whose fallback is SAFE_LINE).
export const HELD_LINE = "Got it.";

// Capitalized words that are formats, everyday apps and titles, not a claim about anyone or anywhere ("I'll send the PDF",
// "a Google Doc"). They back a spoken name like any source line (callLlmProxy.ts callSources); a promise's subject never.
export const SPOKEN_COMMON = "PDF Google Doc Docs Sheets Slides Drive Gmail Calendar LinkedIn Instagram iMessage Messages FaceTime Zoom Slack Notion Luma Calendly Venmo Uber Lyft Airbnb Eventbrite AI CEO CTO COO CFO VC VCs FAQ RSVP ASAP ETA TBD ID URL Mr Mrs Ms Dr Q1 Q2 Q3 Q4";

// The call prompt's sections that carry what Co knows about them (services/elevenLabsCalls.ts CALL_CONTEXT_BLOCK, CALL_NOW).
const KNOWN_SECTION = /^# (?:What you know about|Right now|What (?:Co|Cue) has found for them)\b/;
export function knownSections(system: string): string {
  const out: string[] = [];
  let on = false;
  for (const line of system.split("\n")) {
    if (/^# /.test(line)) on = KNOWN_SECTION.test(line);
    // The context block's own closing line; the guides after it (variety, coaching, brand) have no heading of their own.
    if (/^If that's empty, this is your first real conversation/.test(line)) on = false;
    if (on) out.push(line);
  }
  return out.join("\n");
}

const LATER_WORK = /\b(?:i'?ll|i will|i'?m going to|i'?m gonna)\s+(?:\w+\s+){0,2}?(?:look (?:into|for|at|through|around)|research|find|search|hunt (?:down|for)|scout|dig|track down|reach out)\b/i;
// A first-person promise of later work. Questions and offers ("want me to...?") are not promises.
export function promisesLaterWork(sentence: string): boolean {
  const s = sentence.replace(/[’‘]/g, "'").trim();
  if (/\?\s*$/.test(s) || /^\s*(?:want me to|should i|would you like me to|do you want me to|if you want|if you'd like)\b/i.test(s)) return false;
  return COMMIT_RE.test(s) || PROMISE_RE.test(s) || LATER_WORK.test(s);
}

// Words in a promise that say nothing about its subject (the promise's own verbs, time words, generic nouns).
const PROMISE_PLAIN = new Set(`i'll will going gonna i'm text send look into find what that this those these them they then there their with your yours from about after before call hang once when soon right away later tonight tomorrow today week weekend morning evening afternoon over just also more some anything something everything things thing stuff details detail options option ideas idea links link info information notes note update updates know posted touch back follow circle report check come flag ping research search hunt down scout track reach have make sure pull together write draft share drop shoot forward around through keep moving mind found turn turns comes what's whatever which while here where whatever let it's quick quickly first next couple few best good great real really pass along along been get got give can could would should myself yourself side end both each other others way ways shortly little bit you're done ready within hour hours minute minutes days night ones`.split(/\s+/));

// The subject words of a promise ("venues" in "I'll text you what I find on venues").
export function promiseTopic(sentence: string): string[] {
  return [...new Set(sentence.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z' ]+/g, " ").split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "")))].filter((w) => w.length >= 4 && !PROMISE_PLAIN.has(w));
}

const stems = (w: string) => [w, w.replace(/'s$/, ""), w.replace(/ies$/, "y"), w.replace(/es$/, ""), w.replace(/s$/, ""), w.replace(/ing$/, ""), w.replace(/ed$/, "")].filter((x) => x.length >= 3);
const wordBacked = (w: string, src: Source) => stems(w).some((x) => src.hay.includes(` ${x}`));

// Pure: what in one spoken sentence nothing backs, or null.
// The crisis numbers the safety rules tell Cue to give (services/coCore.ts safety: 988, and 911 for immediate danger; 741741 is the
// crisis text line). Always backed: found 2026-10-31, the number check below dropped "you can call or text 988 right now" from a
// crisis turn, because 988 lives in the prompt's guardrails, not in what Cue knows about them.
export const CRISIS_NUMBERS: ReadonlySet<string> = new Set(["988", "911", "741741"]);
// Pure: the sentence gives a crisis resource (review of #330: "$988 a month", "room 911" or "about 741741 people" are just numbers and
// stay checked). Call, text or dial one of the crisis numbers (spelled 9-8-8 or "nine eight eight" too), or the line named.
export const CRISIS_RESOURCE_LINE = /\b(?:call|text|dial|reach|contact)\b[^.!?]{0,40}?(?:\b988\b|\b911\b|\b741741\b|\b9-8-8\b|\bnine[- ]eight[- ]eight\b)|\b988\s+(?:suicide|lifeline|crisis)\b|\bcrisis (?:text )?line\b/i;
// The crisis text line's keyword ("text HOME to 741741") and the lifeline's own name, on such a line only.
const CRISIS_WORDS = /^(?:home|988|911|741741|lifeline|crisis|suicide|(?:the )?988 suicide (?:&|and) crisis lifeline|crisis text line)$/i;
export function spokenProblem(sentence: string, src: SpokenSources): SpokenProblem | null {
  const s = sentence.replace(/\[[a-z][a-z ]*\]\s*/gi, "").trim();
  if (!s) return null;
  const crisis = CRISIS_RESOURCE_LINE.test(s);
  const mentions = mentionsIn(s);
  const bad = unbackedMentions(mentions, src.all).filter((m) => !(crisis && CRISIS_WORDS.test(m.text.trim())));
  // A clock time makes it an event placement (placesAnEvent), held as before; a name elsewhere is said as not known.
  if (bad.length) return { kind: placesAnEvent(s) ? "event" : "name", missing: bad.map((m) => m.text) };
  // Clock times were checked as mentions; the rest of the digits as numbers.
  // A number has to come from what Co knows about them, what they said, a tool or Co's records: never the prompt's own examples.
  const digits = (crisis ? s.replace(/\b9-8-8\b/g, "988") : s).replace(new RegExp(TIME.source, "gi"), " ");
  const nums = [...numbersOf(digits)].filter((n) => !src.asked.nums.has(n) && !(crisis && CRISIS_NUMBERS.has(n)));
  if (nums.length) return { kind: "number", missing: nums };
  if (promisesLaterWork(s)) {
    const missing = promiseTopic(s).filter((w) => !wordBacked(w, src.asked));
    if (missing.length) return { kind: "promise", missing };
  }
  return null;
}

export const SAFE_LINE = "I'll look into that after the call and text it over.";

// Pure: the sentences of a finished call that name something nothing backs. The call's own dynamic variables (context, finds, clock)
// and the member's lines are the source; Co's lines never are. ElevenLabs' own grader can't see the finds list, so this is the grade.
// foundOnCall: what Cue's searches found DURING the call (services/callLedger.ts foundLines: name, link, when and where); without it a
// find's day, time or venue said in Cue's own words reads as made up (review of #319).
export function unsourcedInCall(turns: { role?: string; message?: string | null }[], given: { firstName?: string; contextSummary?: string; findsNow?: string; rightNow?: string; foundOnCall?: string }): { sentence: string; names: string[] }[] {
  const theirs = turns.filter((t) => t.role === "user" && t.message).map((t) => String(t.message));
  const source = sourceCorpus({ system: [given.firstName, given.contextSummary, given.findsNow, given.rightNow, given.foundOnCall].filter(Boolean).join("\n"), theirLines: theirs });
  const out: { sentence: string; names: string[] }[] = [];
  for (const t of turns.filter((x) => x.role === "agent" && x.message)) {
    for (const s of String(t.message).replace(/\[[a-z][a-z ]*\]\s*/gi, "").split(/(?<=[.!?])\s+/)) {
      const bad = unsourced(s, source);
      if (bad.length) out.push({ sentence: s.slice(0, 240), names: bad.map((m) => m.text) });
    }
  }
  return out;
}

export async function recordOfferSourceCheck(userId: string, conversationId: string, turns: { role?: string; message?: string | null }[], given: Parameters<typeof unsourcedInCall>[1]): Promise<number> {
  try {
    const flagged = unsourcedInCall(turns, given);
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({
      layer: 8,
      decision: "call.offer_source",
      userId,
      outcome: flagged.length ? "skip" : "act",
      action: flagged.length ? "unsourced_named" : "all_sourced",
      proposal: { conversationId, flagged: flagged.slice(0, 8) },
      reason: flagged.length ? `${flagged.length} sentence(s) named an event, place or time nothing backed` : null,
    });
    return flagged.length;
  } catch (err: any) {
    console.error("offerGuard: recording the source check failed (non-fatal):", err?.message ?? err);
    return 0;
  }
}
