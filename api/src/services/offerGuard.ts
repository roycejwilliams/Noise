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
import { isAlsoAName, isCommonWord } from "./commonWords.js";
const EVENT_WORDS = /\b(events?|workshops?|fairs?|pop-?ups?|concerts?|panels?|meet-?ups?|mixers?|dinners?|parties|party|classes|class|festivals?|launch(?:es)?|demo days?|hackathons?|retreats?|happening|going on|gatherings?|sessions?|tournaments?|markets?|screenings?|exhibits?|reception)\b/i;
const TIME = /\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b/gi;
const MONTHS_DAYS = new Set("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(" "));
// Capitalized words that are not names of anything.
const NOT_NAMES = new Set(["i", "i'm", "i'll", "i've", "i'd", "co", "cue", "ok", "okay", "yes", "no", "sure", "so", "and", "but", "or", "that", "this", "it", "it's", "that's", "there", "there's", "here", "if", "when", "what", "who", "where", "why", "how", "want", "would", "could", "should", "do", "does", "did", "are", "is", "was", "can", "will", "you", "you're", "your", "we", "they", "he", "she", "the", "a", "an", "both", "either", "maybe", "right", "good", "great", "got", "just", "now", "then", "also", "one", "two", "three", "some", "any", "all", "not", "nothing", "something", "everything", "anything", "talk", "text", "let", "let's", "talking", "thanks", "thank", "hey", "hi", "hello"]);

const norm = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export type Mention = { text: string; kind: "name" | "time" };

// The sentence's first word is a name it puts forward (review of #418: "Maya would be great for you to meet." passed on calls with no
// backing, while "You should meet Maya." was held). A capital there is the sentence's own, so the word counts as a name only when it isn't
// an ordinary English word (services/commonWords.ts, the en_US Hunspell dictionary): "Maya", "Priya", "Stripe's" go on to be checked like
// any other name; "Honestly", "Today", "Coffee", "Pitching" don't. A word the dictionary also has as a name ("Grace", "Will", "Mark")
// leans to a name when a verb a name takes follows it ("Will is coming", never "Will you be there?"). Contractions, sentence openers
// (STARTERS, NOT_NAMES, days and months) and interjections are never names. Without the word table, no first word is (as before).
const STARTERS = new Set("he she they we you it its this that these those there here everyone everybody everything someone somebody something anyone anybody anything nobody nothing none each every either neither both all most many much more some few several one another other others such which what who whom whose whoever whatever whichever where when why how today tonight tomorrow yesterday now then later soon often sometimes usually always never once mine yours ours theirs his hers my our their me us them myself yourself ourselves themselves himself herself itself lol haha ha hah ooh aw aww yay whoa mhm mm hmm um uh".split(" "));
// Short month and day names ("Oct 16 is 3 days out", "Thu works").
const DATE_SHORT = new Set("jan feb mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun summer winter spring fall autumn".split(" "));
// A weekday's short form is the weekday, wherever it sits, like the full name (2026-11-11, golden std-thin-page: "Wed Oct 21" was held
// as an unbacked name when the page said "Wednesday Oct 21"). Months stay checked: "Jan" and "Mar" are names as often as months.
const WEEKDAY_SHORT = new Set("mon tue tues wed thu thur thurs fri sat sun".split(" "));
const NAME_VERBS = new Set("is was has had would will can could should might may must does did knows knew said says thinks thought wants wanted loves loved likes liked runs ran works worked lives lived told tells asked asks went goes got gets came comes made started starts".split(" "));
export function firstWordName(words: string[]): string | null {
  const w = (words[0] ?? "").replace(/[’]/g, "'");
  const bare = w.replace(/^[("'“]+|[)"'”.,!?;:]+$/g, "");
  // One capital, then lowercase ("Maya", "Stripe's"): an all-caps word ("APIs", "YC") is an acronym, read by its own rule.
  if (!/^[A-Z][a-z'-]*[a-z]$/.test(bare)) return null;
  // A contraction ("Don't", "Let's", "That's", "I'm") is the word before it; only a possessive or "is" ('s) carries a name.
  if (/'(?!s$)/.test(bare)) return null;
  const name = bare.replace(/'s$/, "");
  const lower = name.toLowerCase();
  if (STARTERS.has(lower) || NOT_NAMES.has(lower) || MONTHS_DAYS.has(lower) || DATE_SHORT.has(lower)) return null;
  const common = isCommonWord(name);
  if (common === null) return null;
  if (!common) return name;
  const next = (words[1] ?? "").toLowerCase().replace(/[’]/g, "'").replace(/[^a-z']/g, "");
  return !/[.,!?;:]$/.test(w) && isAlsoAName(name) && (NAME_VERBS.has(next) || /'s$/.test(bare)) ? name : null;
}

// The names (capitalized runs, the first word only when it reads as a name: firstWordName) and clock times a sentence puts forward.
export function mentionsIn(sentence: string): Mention[] {
  const clean = sentence.replace(/\[[a-z][a-z ]*\]\s*/gi, "");
  const out: Mention[] = [];
  for (const m of clean.match(TIME) ?? []) out.push({ text: m, kind: "time" });
  const words = clean.split(/\s+/).filter(Boolean);
  let run: string[] = [];
  const flush = () => { if (run.length) out.push({ text: run.join(" "), kind: "name" }); run = []; };
  const lead = firstWordName(words);
  words.forEach((w, i) => {
    const bare = w.replace(/^[("'“]+|[)"'”.,!?;:]+$/g, "");
    const lower = bare.toLowerCase();
    // A capital at the start of a sentence says nothing, unless the word reads as a name there (firstWordName, #419) or is all caps:
    // "AJ would be great to meet", "IBM has a program" put a name forward like any other (review of #418).
    if (i === 0) {
      if (lead) { run.push(lead); if (/[.,!?;:]$/.test(w)) flush(); return; }
      if (!(/^[A-Z]{2,5}s?$/.test(bare) && !NOT_NAMES.has(lower))) return;
    }
    if (/^[A-Z]/.test(bare) && !NOT_NAMES.has(lower) && !MONTHS_DAYS.has(lower) && !WEEKDAY_SHORT.has(lower)) {
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
export type Source = { raw: string; hay: string; flat: string; nums: Set<string>; times?: Set<string> };
// Clock times as minutes of the day, every reading of each: "9:45" is 9:45 or 21:45, "19:45" only 19:45, "7pm" 19:00. A time said is
// backed when one of its readings is one of the source's (review of 8471cdb0: by substring, "9:45" passed against "19:45").
const CLOCK = /(?<![\d:])(\d{1,2})(?::([0-5]\d))?\s?(a\.?m\.?|p\.?m\.?)?(?![\d:])/gi;
export function clockReadings(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(CLOCK)) {
    const h = Number(m[1]);
    const min = m[2] ?? "00";
    const ap = (m[3] ?? "").replace(/\./g, "").toLowerCase();
    if (!m[2] && !ap) continue;
    if (h > 23 || (ap && (h < 1 || h > 12))) continue;
    if (ap) out.add(`${(h % 12) + (ap === "pm" ? 12 : 0)}:${min}`);
    else if (h >= 13 || h === 0) out.add(`${h}:${min}`);
    else out.add(`${h}:${min}`).add(`${h + 12}:${min}`);
  }
  return out;
}
// A contraction's tail is not part of the word they said: "RSVP'd" backs "RSVP" (2026-10-12, a document was refused for it).
export const prepareSource = (source: string): Source => ({ raw: source, hay: norm(`${source}\n${source.replace(/(\w)['’](?:d|ll|re|ve)\b/gi, "$1")}`), flat: squash(source), nums: numbersOf(source, true), times: clockReadings(source) });

// The numbers in a text, as whole numbers ("$3,000" is 3000, "20th" is 20, never the "20" inside "2026"). The extraction is
// taskWeb numbersBacked's; its substring match is too loose for a whole call's prompt, so a number here has to be a whole one.
// A source's written-out numbers count too ("about sixty people" backs "60").
const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100" };
export function numbersOf(text: string, withWords = false): Set<string> {
  const out = new Set(numbersBacked(text, "").missing.map((n) => n.replace(/\.0+$/, "")));
  if (withWords) for (const w of text.toLowerCase().match(/\b[a-z]+\b/g) ?? []) if (NUMBER_WORDS[w]) out.add(NUMBER_WORDS[w]);
  return out;
}

const NAME_JOINERS = new Set(["the", "and", "for", "of", "at", "de", "la"]);
function unbackedMentions(mentions: Mention[], src: Source): Mention[] {
  return mentions.filter((m) => {
    if (m.kind === "time") {
      const said = [...clockReadings(m.text)];
      const known = src.times ?? clockReadings(src.raw);
      return !(said.length && said.some((t) => known.has(t)));
    }
    const n = norm(m.text.replace(/['’]s$/i, ""));
    if (src.hay.includes(n)) return false;
    // A plural of a backed word is backed ("PDFs" for "PDF", 2026-10-08 live call: "Should I keep sending PDFs?" was replaced).
    const singular = (w: string) => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
    if (src.hay.includes(n.replace(/\S+/g, singular))) return false;
    // A name the sentence only shortens or re-cases ("Sequent" for "Sequent AI") still has a source. Each part is read without its
    // possessive and the joiners need no source: Cue saying back "Stripe's CEO and Ramp" when they said "the Stripe CEO and Ramp
    // connected" is their words (2026-11-07 live call: it was held as "names what nothing backs", and the turn came out broken).
    const parts = n.trim().split(" ").map((p) => p.replace(/'s?$/, "")).filter((p) => p.length > 2 && !NAME_JOINERS.has(p));
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
// Said instead when the held line was an offer that needs a way to carry it out (offerNeedingPath) and the retry was held too: after
// "can you book it?", "Got it." sounds like a yes (review of #418). Never a promise, never agreement.
// TODO(Royce): exact wording pending Royce's yes. Options proposed on PR #418: "That's not something I can do from here." (wired, the
// safest), "I can't do that one from here.", "That one's not something I can take care of on a call."
export const HELD_OFFER_LINE = "That's not something I can do from here.";

// Capitalized words that are formats, everyday apps and titles, not a claim about anyone or anywhere ("I'll send the PDF",
// "a Google Doc"). They back a spoken name like any source line (callLlmProxy.ts callSources); a promise's subject never.
export const SPOKEN_COMMON = "PDF Google Doc Docs Sheets Slides Drive Gmail Calendar LinkedIn Instagram iMessage Messages FaceTime Zoom Slack Notion Luma Calendly Venmo Uber Lyft Airbnb Eventbrite AI CEO CTO COO CFO VC VCs FAQ RSVP ASAP ETA TBD ID URL AV Mr Mrs Ms Dr Q1 Q2 Q3 Q4";

// The call prompt's sections that carry what Co knows about them (services/elevenLabsCalls.ts CALL_CONTEXT_BLOCK, CALL_NOW).
const KNOWN_SECTION = /^# (?:What you know about|Right now|What (?:Co|Cue) has found for them)\b/;
export function knownSections(system: string): string {
  const out: string[] = [];
  let on = false;
  for (const line of system.split("\n")) {
    if (/^# /.test(line)) on = KNOWN_SECTION.test(line);
    // The context block's own closing line; the guides after it (variety, coaching, brand) have no heading of their own. (Its wording
    // since 2026-11-02, when a first call became a real flag, and before.)
    if (/^If that's empty, (?:you have nothing from before|this is your first real conversation)/.test(line)) on = false;
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
const PROMISE_PLAIN = new Set(`i'll will going gonna i'm text send look into find what that this those these them they then there their with your yours from about after before call hang once when soon right away later tonight tomorrow today week weekend morning evening afternoon over just also more some anything something everything things thing stuff details detail options option ideas idea links link info information notes note update updates know posted touch back follow circle report check come flag ping research search hunt down scout track reach have make sure pull together write draft share drop shoot forward around through keep moving mind found turn turns comes what's whatever which while here where whatever let it's quick quickly first next couple few best good great real really pass along along been get got give can could would should myself yourself side end both each other others way ways shortly little bit you're done ready within hour hours minute minutes days night ones started starting already still same`.split(/\s+/));

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
// An all-caps term used as a kind of thing ("TTS systems", "API calls", "LLMs") in a sentence that offers nothing is vocabulary, the way
// SPOKEN_COMMON's formats and titles are: "A lot of TTS systems sound fine in isolation..." was held back on Royce's dev calls
// (2026-10-31 to 11-04) as an unbacked name. Narrowed in review of #418: exempt only when it's plural ("LLMs") or a common noun follows
// it ("TTS systems"); never when it's the sentence's singular subject ("YC is a good fit", "IBM has a program"), after a person cue
// ("meet AJ", "someone at", "talk to"), after at/from/with/in ("someone at IBM", "the scene in SF"), or in any sentence that offers to do,
// find, send or set up something or promises a result (offersToAct). A singular one followed by a function word or a verb ("AJ would",
// "IBM has") is a name and stays checked.
const ACRONYM = /^[A-Z]{2,5}s?$/;
const ORG_OR_PLACE_BEFORE = /\b(?:at|from|with|in|near|around|inside|joined|joining|by|to|for|of the|via)\s+$/i;
const PERSON_CUE_BEFORE = /\b(?:meet|meeting|met|talk(?:ing)? to|speak(?:ing)? (?:to|with)|know|knows|someone|somebody|person|people|introduce|introducing|intro|ask|call|text|email|reach out to|ping)\s+(?:\w+\s+)?$/i;
// What can follow a singular name but never makes it a kind of thing: verbs and function words ("AJ would", "IBM has", "YC is").
const NOT_A_NOUN_AFTER = new Set("is are was were be been being has have had would will can could should may might must does do did says said thinks knows wants runs and or but nor so yet a an the to of for in on at with by from that this it its who which whose whom if as than then just really also too".split(" "));
// Cue proposing to act for them, or promising a result: a promise of later work (promisesLaterWork), an event placed, or a first-person
// offer to intro, connect, send, book, reserve, set up, find or get them something ("I can intro you to...", "want me to book it?",
// "let me set that up", "you'll have three intros by Friday"). Questions count: "Want me to...?" is an offer.
const OFFER_TO_ACT = /\b(?:i'?ll|i will|i can|i could|let me|i'?m going to|i'?m gonna|want me to|should i|i'?d be happy to|happy to)\s+(?:\w+\s+){0,2}?(?:intro(?:duce)?|connect|put you in touch|send|text|email|book|reserve|set (?:it |that |this |you |something )?up|find|get you|line up|hook you up|schedule|make (?:an |the )?intro)\b|\byou'?ll (?:have|get|hear from|be (?:on|in))\b/i;
export function offersToAct(sentence: string): boolean {
  const s = sentence.replace(/[’‘]/g, "'");
  return OFFER_TO_ACT.test(s) || promisesLaterWork(s) || placesAnEvent(s);
}
// Pure: the mention is an all-caps term used as vocabulary in this sentence (never in an offer, never after an org or place word).
export function vocabularyTerm(m: Mention, sentence: string): boolean {
  if (m.kind !== "name" || !ACRONYM.test(m.text) || offersToAct(sentence)) return false;
  const plural = /[A-Z]s$/.test(m.text);
  const at = [...sentence.matchAll(new RegExp(String.raw`(?<![A-Za-z])${m.text}(?![A-Za-z])`, "g"))].map((x) => x.index ?? 0);
  return at.length > 0 && at.every((i) => {
    const before = sentence.slice(Math.max(0, i - 32), i);
    if (ORG_OR_PLACE_BEFORE.test(before) || PERSON_CUE_BEFORE.test(before)) return false;
    if (plural) return true;
    // Singular: only as a kind of thing, with a common noun right after it ("TTS systems"), never as the subject at the start.
    if (!/[A-Za-z]/.test(sentence.slice(0, i).replace(/\[[a-z ]+\]/gi, ""))) return false;
    const next = sentence.slice(i + m.text.length).match(/^\s+([a-z][a-z'-]*)/)?.[1];
    return !!next && !NOT_A_NOUN_AFTER.has(next);
  });
}
export function spokenProblem(sentence: string, src: SpokenSources): SpokenProblem | null {
  const s = sentence.replace(/\[[a-z][a-z ]*\]\s*/gi, "").trim();
  if (!s) return null;
  const crisis = CRISIS_RESOURCE_LINE.test(s);
  const mentions = mentionsIn(s);
  const bad = unbackedMentions(mentions, src.all).filter((m) => !(crisis && CRISIS_WORDS.test(m.text.trim())) && !vocabularyTerm(m, s));
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

// ---------- Offers that need a way to carry them out (Royce, 2026-11-07): a booking, reservation, purchase or sign-up Cue says it will
// make ("I'll book that", "I'll reserve a table for you"), or introductions promised as a result ("You'll have three intros by next
// week"). Neither has a source a name check could find: what backs one is a way to do it. So it is its own check, read in
// callLlmProxy.ts say(): the line is said only when a tool on this call that carries that kind out (CallToolset.carries) came back
// done this turn, which is where the capability, the member's yes (the tool's own guard) and the execution path all are. Nothing on a
// call books or introduces today, so these are held; the turn is answered again without them, never with another promise.
// Pure, statements only: a question ("want me to book it?") asks, it doesn't promise.
export type OfferKind = "book" | "intro";
const BOOKING_PROMISE = /\b(?:i'?ll|i will|i'?m going to|i'?m gonna|let me|i can|i could)\s+(?:\w+\s+){0,2}?(?:book|reserve|buy|purchase|pay for|rsvp|sign you up|register you|grab you (?:a |the )?(?:table|ticket|tickets|spot|seat)|get you (?:a |the )?(?:table|reservation|ticket|tickets|spot|seat))\b/i;
const INTRO_RESULT = /\byou'?ll (?:have|get|receive|be getting)\s+(?:\w+\s+){0,2}?(?:intros?|introductions?|matches)\b|\b(?:i'?ll|i will|i'?m going to|i'?m gonna|i can)\s+(?:get|find|line up|set up)\s+(?:you\s+)?(?:\w+\s+){0,2}?(?:intros|introductions|matches)\b/i;
export function offerNeedingPath(sentence: string): OfferKind | null {
  const s = sentence.replace(/[’‘]/g, "'").replace(/\[[a-z][a-z ]*\]\s*/gi, "").trim();
  if (!s || /\?["')\]]*\s*$/.test(s)) return null;
  if (BOOKING_PROMISE.test(s)) return "book";
  if (INTRO_RESULT.test(s)) return "intro";
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
