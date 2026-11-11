// Verify at send (Phase B, Royce 2026-10-10). The audit: nothing re-read a find between when it was captured and when it went out,
// so "12 spots left" went out days later as current. Co checked live sources only when it FOUND something (pages fetched, words
// checked, a Jev fact check, Luma details at most an hour old); at send time it checked only its own records (opted out, ask still
// open, the date against today, already sent). The reply loop already had the right pattern (agent/loopTools.ts storedFinds /
// seedFound / usableFacts: a stored find expires and is read again before anything cites it); this is that pattern on the send path.
//
//   B1 recheckFind: one find's own page read again right before it sends. What comes back replaces the stored record, stamped
//      checkedAt. Only a CERTAIN signal exits (review of #138): its date on record passed; Luma's own flags (sold out, no spots, ended);
//      a dead link (404/410). Words on a web page ("cancelled", "sold out", "closed") are never certain (a refund policy, another
//      session, last year's cohort, an FAQ), so they hold the send and it's read again: a defer, never an exit.
//   checkBeforeSend: the send path's hook (harness/proactiveRegistry.ts event_offer draft, and stillRelevant for B6). A certain exit goes
//      through the working set (services/workingSet.ts writeExitFact: the fact first, scoped, never silently dropped). Anything
//      uncertain (unreadable now, a closing word, a date the page doesn't show) defers and is read again; the queue's own window bounds
//      how long. Nothing writes in a dispatch dry run (sendCheckDryRun).
//   B2 queue windows: an undated find waits UNDATED_QUEUE_DAYS, not 14 blind. When its window ends unsent that is not an exit and not a
//      decision (review of #138: "not picked in 3 days" or a paused dispatch said nothing about the find): it goes back to the backlog
//      and may be queued again, and it's re-read before any send.
//   B4 captionNumbersBacked: a caption's prices and counts must be on the record it was drafted from.
//   B5 recheckOnFile: a task's "on file" find is read again (or left out) before a task sends it.
//   B6 sourceLine: what its page says now, for stillRelevant to read instead of the conversation alone.
//
// Phase C moves the event_offer bundle into one composer (harness/bundleComposer.ts prepareOffer): checkBeforeSend is the one call
// it needs, so the hooks here stay one or two lines.
import { AsyncLocalStorage } from "node:async_hooks";
import { DateTime } from "luxon";
import type { TierMatch } from "./tieredRecommendation.js";
import { WAITLIST_SHORT, type EventDetails } from "./eventDetails.js";
import { datesOnPage, dayIn, eventDateOf, exitKey, formOf, lifeEndOf } from "./findForm.js";
import { writeExitFact, type ExitDeps, type ExitState } from "./workingSet.js";
import { START_LEAD_MINUTES, eventStartProblem, matchStartProblem } from "./eventStart.js";
import { hostOf, hostTerms, namesThing } from "./knowledge/sent.js";

// A read this recent counts as now: the old plan tool's window for a Luma page.
export const RECHECK_FRESH_MS = 30 * 60 * 1000;
// Anything uncertain is read again after this long (and never later than the row's own expiry, harness/proactive.ts).
export const RECHECK_RETRY_HOURS = 3;
// Bounds (re-review of #138: an unreadable or "closed" page deferred every ~3h forever, a pick's model read and a page read each
// time; a rolling opening cycled expire, reopen, requeue forever). After this many defers, or this many queue windows ended unsent,
// the find is held in its backlog as stalled (workingSet.ts Unread): out of the dispatch pool, out of the working set after its days.
export const RECHECK_MAX_DEFERS = 3;
export const WINDOW_CYCLES_MAX = 3;
// In a skip reason: the backlog holds the find instead of dropping it (eventSurfacingSweep.ts onEventOfferDropped). Its "send failed"
// prefix makes the row a failed attempt, never a decision.
export const HELD_MARK = "held for daily re-reads";
// Pure: after `ended` queue windows ended unsent for one thing, it goes back to the backlog, or is held.
export function windowCycleAction(ended: number): "return" | "hold" {
  return ended >= WINDOW_CYCLES_MAX ? "hold" : "return";
}
// How long an undated find may wait in the queue (B2): it used to be 14 days, never read again. Its window ending returns it to
// the backlog (eventSurfacingSweep.ts onEventOfferDropped), never an exit.
export const UNDATED_QUEUE_DAYS = 3;
// A dispatch dry run (harness/proactive.ts dispatchForUser) runs the drafts: inside it, the check reads but never writes.
export const sendCheckDryRun = new AsyncLocalStorage<boolean>();

export type PageRead = { text: string | null; gone: boolean };
export type RecheckDeps = {
  // A Luma event's details, read fresh (a cached read younger than RECHECK_FRESH_MS counts). Takes a full link or a Luma slug.
  luma: (url: string) => Promise<EventDetails | null>;
  // Any other page: its text, and whether it's gone (404/410).
  page: (url: string) => Promise<PageRead>;
  // A dated find's page, read now for whether it is still open (Royce, 2026-10-13: "Finds with a deadline, application window or
  // event date get their page re-verified at send time"). The word list (closedOnPage) missed "Applications for Batch 4 are closed"
  // because the name wasn't in that sentence, and "applications open now" went out. Optional: without it only the word list runs.
  openRead?: (i: { name: string; page: string; today: string; onFile: string | null; isOpening: boolean }) => Promise<OpenRead | null>;
  // The names of everything already sent to this member (knowledge/sent.ts sentByReferent), for a roundup shared as a roundup: it must
  // add something beyond what they already have. null: unreadable (the roundup is held). Absent: the roundup is held.
  sentNames?: () => Promise<string[] | null>;
  // Which of these places were talked about in their conversation, ever (services/conversationRecall.ts talkedAboutAmong: one owner-bound
  // query per roundup). null: unreadable (the roundup is held). Absent: the roundup is held.
  discussedAmong?: (names: string[]) => Promise<Set<string> | null>;
};
// open: the page shows it still taking applications or still ahead; closed: the page says it is closed, over, full or past (quote is
// the page's own words); unclear: the page doesn't say either way.
export type OpenRead = { state: "open" | "closed" | "unclear"; quote: string | null };
export type Recheck =
  | { ok: true; match: TierMatch; checkedAt: string; changed: string[]; verified: boolean }
  | { ok: false; why: string; exit: boolean; state?: ExitState };

const isLuma = (url: string | null | undefined) => !!url && /^https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\//i.test(url);
const isX = (url: string | null | undefined) => !!url && /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(url);
const zoneOr = (zone: string | null | undefined) => (zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles");
const localDay = (now: Date, zone: string | null) => DateTime.fromJSDate(now).setZone(zoneOr(zone)).toISODate()!;

// Closing words on a page (review of #138: "cancelled" with no "is/was/has been" in front read a refund policy as a cancellation).
const CLOSED = /\b(sold out|(?:has been|was|is|been) (?:cancel+ed|postponed)|(?:registration|applications?|rsvps?)(?: for [^.!?]{1,80}?)? (?:are |is |has |have )?(?:now )?closed|no longer accepting (?:applications|registrations|rsvps)|fully booked|at capacity)\b/i;
// Conditional and policy wording around a closing word: never a statement that it happened.
const CONDITIONAL = /\b(?:if|unless|in case|should|whether|what if|what happens|refunds?|refundable|policy|policies|faq|terms|in the event)\b/i;
// A tier or level of the thing ("VIP tier: waitlist") isn't the thing.
const TIER_WORDS = /\b(?:vip|tier|level|add-?on|upgrade|early bird|premium)\b/i;
// Pure: a closing word that is genuinely about this find. The sentence (or the heading line right above it) must carry a word of its
// name; the sentence must not be conditional or policy; a sentence naming another date (a past cohort's year, another session) is
// about that date, not this find; and a tier of it isn't it. Null when there's nothing it could be sure of.
// More of the name has to be there than one shared word (re-review of #138: "Past: Founders Breakfast NYC, sold out" held "Founders
// Dinner SF" on "founders" alone): all of its distinctive words when it has one or two, else all but one.
const NAME_STOP = new Set(["with", "from", "your", "this", "that", "event", "night", "the", "and", "for", "2025", "2026", "2027"]);
export function nameWordsIn(text: string, name: string): boolean {
  const words = [...new Set(name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !NAME_STOP.has(w)))];
  if (!words.length) return false;
  const lower = text.toLowerCase();
  const have = words.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)).length;
  return have >= (words.length <= 2 ? words.length : words.length - 1);
}
// A sentence or heading about something else: past events, another listing.
const OTHER_EVENT = /^\s*(?:past|previous|earlier|archived?|recent)\b|\bpast events?\b|\bprevious (?:events?|sessions?|editions?)\b/i;
export function closedOnPage(page: string, name: string, onFile: string | null = null): string | null {
  if (!name.trim()) return null;
  const lines = page.split(/\n+/);
  for (let li = 0; li < lines.length; li++) {
    // A heading: the line above, when it's short and isn't itself a sentence.
    const above = li > 0 ? lines[li - 1].trim() : "";
    const heading = above && above.length < 80 && !/[.!?]$/.test(above) ? above : "";
    if (OTHER_EVENT.test(lines[li])) continue;
    for (const sentence of lines[li].split(/(?<=[.!?])\s+/)) {
      const m = sentence.match(CLOSED);
      if (!m) continue;
      if (CONDITIONAL.test(sentence) || /\?/.test(sentence) || TIER_WORDS.test(sentence)) continue;
      if (OTHER_EVENT.test(sentence) || OTHER_EVENT.test(heading)) continue;
      if (!nameWordsIn(sentence, name) && !(nameWordsIn(heading, name) && !/[A-Z][a-z]+ [A-Z][a-z]+/.test(sentence.replace(/^\W+/, "").slice(1)))) continue;
      if (otherDate(sentence, onFile, name)) continue;
      return m[0];
    }
  }
  return null;
}
// Pure: does a sentence name a date (or a year) other than the one on file? With no date on file, a full date is about something more
// specific than the find, but the current and next year, and any year in the find's own name, are the find's own (re-review of
// #138: "Applications for the Climate Fellowship 2026 are now closed" read as another year and went out as live).
function otherDate(sentence: string, onFile: string | null, name = "", now = new Date()): boolean {
  const year = onFile ? Number(onFile.slice(0, 4)) : now.getFullYear();
  const own = new Set([...name.matchAll(/\b(20\d{2})\b/g)].map((y) => y[1]));
  const dates = datesOnPage(sentence.replace(/\b20\d{2}\b/g, (y) => (own.has(y) ? "" : y)), year);
  const years = [...sentence.matchAll(/\b(20\d{2})\b/g)].map((y) => y[1]).filter((y) => !own.has(y));
  if (!onFile) return dates.size > 0 || years.some((y) => Number(y) !== year && Number(y) !== year + 1);
  return [...dates].some((d) => d !== onFile.slice(0, 10)) || years.some((y) => y !== onFile.slice(0, 4));
}

// Pure: is a quote really on the page (spacing and case aside)? A closed read stands only on the page's own words.
export function onPage(page: string, quote: string): boolean {
  const n = (t: string) => t.toLowerCase().replace(/&[a-z]+;/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const q = n(quote);
  // Two words count when one of them says closed ("Applications closed"); otherwise three, so a lone word never holds a find.
  const words = q.split(" ").length;
  return (words >= 3 || (words === 2 && /\b(?:closed|over|ended|full|sold)\b/.test(q))) && n(page).includes(q);
}

// The send-time read of a dated find's page: still open, closed, or unclear. One short model read; null when it can't be made.
export async function readOpenNow(i: { name: string; page: string; today: string; onFile: string | null; isOpening: boolean }): Promise<OpenRead | null> {
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { generateText } = await import("ai");
  const { MODELS } = await import("../models.js");
  const { parseModelJson } = await import("./modelJson.js");
  const { text } = await generateText({
    model: anthropic(MODELS.haiku),
    maxOutputTokens: 200,
    abortSignal: AbortSignal.timeout(8000),
    experimental_telemetry: { isEnabled: true, functionId: "readOpenNow" },
    prompt: `Today is ${i.today}. A companion is about to text a member about "${i.name}"${i.isOpening ? ", an opening (an application, program or grant)" : ""}${i.onFile ? `, on file for ${i.onFile}` : ""}. Its own page, read just now:
"""${i.page.slice(0, 12000)}"""

Is "${i.name}" itself still open as of today: still taking applications or sign-ups, or still ahead? Answer "closed" only if the page says this one is closed, over, full, sold out or past (applications closed, batch closed, registration ended), and quote that whole sentence exactly as the page has it. Answer "open" if the page shows it still open or ahead. Answer "unclear" if the page doesn't say, or the closed words are about something else (another event, another year, a past batch when a new one is open).

Return ONLY JSON: {"state": "open" | "closed" | "unclear", "quote": "the page's exact words" or null}`,
  });
  const p = parseModelJson(text) ?? {};
  const state = p.state === "open" || p.state === "closed" ? p.state : "unclear";
  return { state, quote: typeof p.quote === "string" && p.quote.trim() ? p.quote.trim() : null };
}

// ---------------------------------------------------------------- a roundup is not the thing (Royce, 2026-11-10)

// A list line: a bullet, a number, an arrow or an emoji at its start.
const LIST_LINE = /^\s*(?:[-*•▪◦→>]|\d{1,2}[.)]|\p{Extended_Pictographic})\s*\S/u;
// A headline that counts things ("Five places to look for founder support", "10 fellowships open now").
const COUNT_HEADLINE = /\b(?:\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|top \d{1,2})\s+(?:[\w'-]+\s+){0,3}?(?:places|programs|programmes|ways|resources|things|options|opportunities|accelerators|fellowships|residencies|communities|grants|picks|orgs|organizations|funds|incubators)\b/i;
// A page that counts the gatherings it covers ("lists three founder events", "5 dinners worth your evening"), read near its top; and how
// much of a flat page is its title zone.
const PAGE_COUNT = /\b(?:\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[\w'-]+\s+){0,2}?(?:events|dinners|meetups|gatherings|mixers|salons|nights)\b/i;
const PAGE_COUNT_CHARS = 1500;
const PAGE_TITLE_CHARS = 160;
const URLS = /https?:\/\/[^\s)"'<>\]]+/gi;
// links: every candidate, those whose host carries its name or acronym first (named); the rest are only pages about it.
export type Roundup = { items: number; line: string | null; links: string[]; named?: string[] };
// Pure: is this text a roundup that lists several things, this one among them? A post: three or more list lines with this one in some
// but not all of them, or a counting headline whose opening line isn't about this thing. A page: only the counting headline (its own
// page lists its benefits in bullets; that's not a roundup). links: candidates for its own page, the ones on the line that names it
// first, then any whose address carries its name or acronym; never another X or Twitter post.
export function roundupOf(text: string, name: string, o: { page?: boolean } = {}): Roundup | null {
  const t = String(text ?? "");
  if (!t.trim() || !name.trim() || !namesThing(t, name)) return null;
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  // Its first line names it: the post or page is about this thing, whatever else it lists (review of #441). A page read flat (the reader
  // returns most web pages as one run of text) has no first line, so its opening is its title zone, never the whole page (2026-11-11: a
  // blog post listing three founder events went out as one of them, because the flat page "named it in its first line").
  const opening = o.page && lines.length <= 2 ? t.slice(0, PAGE_TITLE_CHARS) : (lines[0] ?? "");
  if (namesThing(opening, name)) return null;
  const items = lines.filter((l) => LIST_LINE.test(l));
  const named = items.filter((l) => namesThing(l, name));
  // A page that counts the events it covers near its top ("the calendar lists three founder events this week") is a roundup too.
  const headline = COUNT_HEADLINE.test(t.slice(0, 300)) || (!!o.page && PAGE_COUNT.test(t.slice(0, PAGE_COUNT_CHARS)));
  const isRoundup = o.page ? headline : (items.length >= 3 && named.length >= 1 && named.length < items.length) || headline;
  if (!isRoundup) return null;
  const line = named[0] ?? lines.find((l) => namesThing(l, name)) ?? null;
  const clean = (u: string) => u.replace(/[.,;!?]+$/, "");
  // Elsewhere in the text, a candidate for its own page carries a whole word of its name (five letters or more) or its organization's
  // acronym in its address (knowledge/sent.ts hostTerms). Never a shortened link, another post, or a write-up on a publishing or news
  // site (review of #441: pcmag.com and mrbeast.com matched two-letter pieces).
  const terms = hostTerms(name).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w.length >= 3);
  const bare = (u: string) => (hostOf(u) ?? "").replace(/[^a-z0-9.]/g, "");
  const ownPage = (u: string) => {
    const h = bare(u);
    if (!h || isX(u) || SHORTENER.test(h) || WRITE_UP.test(h)) return false;
    const label = h.split(".").slice(0, -1).join("");
    return terms.some((w) => label.includes(w));
  };
  // On the line that names it, any link that isn't a post, a shortener or a write-up is a candidate (re-review of #441: beondeck.com,
  // joinef.com, neo.com, hf0.com, aigrant.org and mercatus.org were refused for not carrying a five-letter name word). The page read
  // still requires its name near the top. Elsewhere in the text, the address must carry its name or acronym.
  const allowed = (u: string) => { const h = bare(u); return !!h && !isX(u) && !SHORTENER.test(h) && !WRITE_UP.test(h); };
  const all = (t.match(URLS) ?? []).map(clean);
  const onLine = (line?.match(URLS) ?? []).map(clean).filter(allowed);
  const byName = [...new Set(all.filter(ownPage))];
  const links = [...new Set([...byName, ...onLine])];
  return { items: items.length, line: line ? line.slice(0, 200) : null, links, named: byName };
}
// Hosts that shorten links, and hosts where a third party writes about things: never a thing's own page.
const SHORTENER = /^(?:t\.co|bit\.ly|tinyurl\.com|buff\.ly|ow\.ly|lnkd\.in|rebrand\.ly|is\.gd|cutt\.ly|shorturl\.at)$/;
// Event platforms too, for this resolution only (round-3 review of #441): a Luma, Eventbrite, Partiful or Meetup page about a program is
// never the program's own page. Event finds never pass through here (roundupOf runs only for openings).
const WRITE_UP = /(?:^|\.)(?:lu\.ma|luma\.com|eventbrite(?:\.[a-z]{2,3}){1,2}|partiful\.com|meetup\.com|medium\.com|substack\.com|linkedin\.com|youtube\.com|youtu\.be|reddit\.com|facebook\.com|instagram\.com|threads\.net|tiktok\.com|news\.ycombinator\.com|techcrunch\.com|forbes\.com|businessinsider\.com|venturebeat\.com|wired\.com|theverge\.com|pcmag\.com|crunchbase\.com|wikipedia\.org|github\.com|notion\.site|beehiiv\.com|ghost\.io)$/;

// Its own page, from the roundup's links: the first that reads, names it near its top, and isn't itself a roundup. Then the usual
// send-time read runs on that page (dates, closing words), with the roundup kept as where it was found. None: held and read again (the
// defers bound it), never sent as the post and never described from the post as if it were its page.
// A roundup shared as a roundup (Royce, 2026-11-10): when no page of its own reads, the post itself may go, as what it is, only when it
// is readable, adds something beyond what they already have, and its value doesn't rest on details nobody checked. Whether the list as a
// whole helps their goal is the composer's call, at the same bar as any find (it skips what doesn't fit). Pure.
// A post whose value is a deadline, a closing date or a spots count: those can't be checked here, so it stays held.
// Round-5 review: "apps close Friday", "open until Dec 1", "closing soon", "only 10 seats", "due 12/1", "first come first served" too.
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\w*";
const UNCHECKED_VALUE = new RegExp(`\\b(?:deadlines?|due (?:by|on)|apply by|(?:applications?|apps?) (?:close|closes|closing|due|end)|clos(?:e|es|ing) (?:on|in|this|next|soon|today|tomorrow)|closing|last (?:chance|call|day)|ends? (?:on|this|next|soon)|until (?:${MONTH}|\\d{1,2}(?:st|nd|rd|th)?\\b|(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|the \\d)|spots? (?:left|remaining)|limited (?:spots|seats)|seats?|first come|(?:before|by) ${MONTH})\\b|\\b\\d{1,2}\\/\\d{1,2}\\b`, "i");
export const ROUNDUP_MIN_POST_CHARS = 40;
// discussed: the listed places talked about in their conversation (sent OR talked about is not new: Royce's ruling). null: unreadable.
export function roundupShare(post: string, sentNames: readonly string[] | null, discussed: ReadonlySet<string> | null = new Set()): { ok: true; items: number; fresh: number } | { ok: false; why: string } {
  const t = String(post ?? "").trim();
  if (t.length < ROUNDUP_MIN_POST_CHARS) return { ok: false, why: "the post itself couldn't be read" };
  if (UNCHECKED_VALUE.test(t)) return { ok: false, why: "its value rests on deadlines or spots nobody checked" };
  if (!sentNames || !discussed) return { ok: false, why: "what they already have or talked about couldn't be read" };
  const items = t.split(/\n+/).map((l) => l.trim()).filter((l) => LIST_LINE.test(l));
  if (items.length < 2) return { ok: false, why: "the post doesn't list its places" };
  const known = (line: string) => discussed.has(roundupPlace(line)) || sentNames.some((n) => namesThing(line, n) || namesThing(n, roundupPlace(line)));
  const fresh = items.filter((l) => !known(l)).length;
  if (fresh < 2 || fresh * 2 <= items.length) return { ok: false, why: `mostly what they already have (${items.length - fresh} of ${items.length} already sent or talked about)` };
  return { ok: true, items: items.length, fresh };
}
const LIST_MARK = /^\s*(?:[-*\u2022\u25aa\u25e6\u2192>]|\d{1,2}[.)]|\p{Extended_Pictographic})\s*/u;
// Pure: a list line's place, without its marker or links (what the talked-about read is asked about).
// The name only: cut at the first ", ", ": ", " - ", " \u2013 ", " \u2014 " or "(" (final review of #441: "- Thiel Fellowship, $100k for young
// founders" was searched for whole, so the talked-about read missed almost every real roundup).
export function roundupPlace(line: string): string {
  const bare = line.replace(LIST_MARK, "").replace(/https?:\/\/\S+/g, "").trim();
  return bare.split(/,\s|:\s|\s[-\u2013\u2014]\s|\(/)[0].replace(/[:,\-\u2013\u2014]\s*$/, "").trim();
}
// Pure: a roundup post's places (its list lines), for the talked-about read.
export function roundupPlaces(post: string): string[] {
  return String(post ?? "").split(/\n+/).map((l) => l.trim()).filter((l) => LIST_LINE.test(l)).map(roundupPlace).filter(Boolean);
}

async function resolveFromRoundup(match: TierMatch, url: string, r: Roundup, o: { now: Date; zone: string | null; deps: RecheckDeps }, post = ""): Promise<Recheck> {
  const label = r.line ? `listed as: ${r.line}` : "listed among several things";
  // A link whose host carries its name or acronym first (its own page); only when none of those reads, the line's other links, and then
  // the page is "a page about it", never its own or official page (round-3 review of #441).
  const named = new Set(r.named ?? []);
  const ordered = [...r.links.filter((l) => named.has(l)), ...r.links.filter((l) => !named.has(l))].slice(0, 3);
  for (const link of ordered) {
    const page = await o.deps.page(link).catch((): PageRead => ({ text: null, gone: false }));
    if (!page.text || page.gone || !namesThing(page.text.slice(0, 6000), match.name) || roundupOf(page.text, match.name, { page: true })) continue;
    const about = !named.has(link);
    const own = { ...match, url: link, roundupUrl: url, foundInRoundup: label, ...(about ? { pageIsAbout: true } : {}) } as TierMatch;
    const next = await recheckFind(own, o);
    return next.ok ? { ...next, changed: [...next.changed, about ? "a page about it instead of the post that listed it" : "its own page instead of the post that listed it"] } : next;
  }
  // No page of its own: the post itself, as a roundup, when it qualifies (roundupShare); otherwise held, as before.
  const sent = o.deps.sentNames ? await o.deps.sentNames().catch(() => null) : null;
  const discussed = o.deps.discussedAmong ? await o.deps.discussedAmong(roundupPlaces(post)).catch(() => null) : null;
  const share = roundupShare(post, sent, discussed);
  if (share.ok) {
    const asList = { ...match, url, roundupUrl: url, foundInRoundup: label, sendAsRoundup: true, opportunity: { ...(match.opportunity ?? {}), postText: post.slice(0, 3000) } } as TierMatch;
    return { ok: true, match: asList, checkedAt: o.now.toISOString(), changed: [`shared as a roundup (${share.fresh} of ${share.items} not sent before): no page of its own could be read`], verified: false };
  }
  return { ok: false, exit: false, why: `its link is a post listing several things (${label.slice(0, 100)}), not its own page, and no page of its own could be read; not shared as a roundup: ${share.why}` };
}

// Pure-with-deps: one find's own page, read again now. Never throws.
export async function recheckFind(match: TierMatch, o: { now: Date; zone: string | null; deps: RecheckDeps }): Promise<Recheck> {
  const { now, zone, deps } = o;
  const today = localDay(now, zone);
  const isOpening = formOf(match as any) === "opening";
  const pastBy = (m: TierMatch): Recheck | null => {
    const end = lifeEndOf(m, zone);
    return end && end < today ? { ok: false, exit: true, state: "expired", why: `${isOpening ? "its deadline" : "its date"} (${end}) passed` } : null;
  };
  const before = pastBy(match);
  if (before) return before;
  const url = "url" in match ? (match.url ?? null) : null;
  const checkedAt = now.toISOString();
  // The Luma page that is its record: a Co or public event's own link (a full link or a slug: both come from Luma's own API,
  // services/tieredRecommendation.ts), a Luma link, else a Luma link in the post it came from.
  const postText = String(match.opportunity?.postText ?? ("evidence" in match ? match.evidence ?? "" : ""));
  // A roundup's own Luma links are other things (or a page about this one), never its record (round-3 review of #441).
  const lumaUrl = match.kind !== "opportunity" && url ? url : isLuma(url) ? url : match.foundInRoundup || (isX(url) && roundupOf(postText, match.name)) ? null : (postText.match(/https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/[^\s)"'<>]+/i)?.[0] ?? null);
  if (lumaUrl) {
    const d = await deps.luma(lumaUrl).catch(() => null);
    if (!d) return { ok: false, exit: false, why: "its event page couldn't be read just now" };
    // Luma's own flags are certain.
    if (d.cancelled === true) return { ok: false, exit: true, state: "cancelled", why: `its page said it was cancelled when Cue read it on ${today}` };
    // Not listed for the public any more (its host made it private, or it never was): never sent to a member it wasn't shared with
    // (2026-11-10: a find queued 11-09 had gone "private" by 11-10). Noise's own events (tier 1) are ours to share, whatever their listing.
    if (match.tier !== 1 && typeof d.visibility === "string" && d.visibility !== "public")
      return { ok: false, exit: true, state: "expired", why: `its page says it's ${d.visibility}, not public, when Cue read it on ${today}` };
    if (d.soldOut === true) return { ok: false, exit: true, state: "expired", why: `sold out when Cue read its page on ${today}` };
    // No spots and no waitlist: gone. A waitlist (full, with one to join) stays, said as waitlist only (Royce, 2026-11-10).
    if (d.spotsRemaining === 0 && !d.waitlist) return { ok: false, exit: true, state: "expired", why: `no spots left when Cue read its page on ${today}` };
    // Over: past its end when it has one (a festival that started yesterday still runs), else past its start.
    const over = d.endAt ? d.endAt : d.startAt;
    if (over && new Date(over).getTime() <= now.getTime()) return { ok: false, exit: true, state: "expired", why: `it was already ${d.endAt ? "over" : "under way"} (${over}) when Cue read its page` };
    // Its start as the page has it now: started, or too soon to get there (START_LEAD_MINUTES; Royce, 2026-10-17, the Angel Island run).
    // Certain, so an exit. An event that runs a day or more is judged by its end above (services/eventStart.ts).
    // From the page itself, whatever tier found it: a web or X find whose page is a Luma event has a real start too (review of #229).
    const late = eventStartProblem({ startAt: d.startAt, endAt: d.endAt, online: d.online }, now, START_LEAD_MINUTES, d.timezone ?? zone);
    if (late) return { ok: false, exit: true, state: "expired", why: `${late}, when Cue read its page` };
    const old = match.details ?? null;
    const changed: string[] = [];
    if (old?.startAt && d.startAt && old.startAt !== d.startAt) changed.push(`start moved from ${old.startAt} to ${d.startAt}`);
    if (d.waitlist && !old?.waitlist) changed.push(`now ${WAITLIST_SHORT}`);
    else if (old && old.spotsRemaining !== d.spotsRemaining && d.spotsRemaining !== null && !d.waitlist) changed.push(`spots ${old.spotsRemaining ?? "unknown"} -> ${d.spotsRemaining}`);
    if (old?.price && d.price && old.price !== d.price) changed.push(`price ${old.price} -> ${d.price}`);
    const next: any = { ...match, details: d, checkedAt };
    const newDay = d.startAt ? dayIn(d.startAt, d.timezone ?? zone) : null;
    if (newDay && "event_date" in next && next.event_date && String(next.event_date).slice(0, 10) !== newDay) next.event_date = newDay;
    const after = pastBy(next);
    if (after) return after;
    return { ok: true, match: next, checkedAt, changed, verified: true };
  }
  // A post that lists several things (a roundup: "five places to look for founder support"), this among them, is not this thing's page
  // (Royce, 2026-11-10: an X roundup went out as the residency itself). Its own page is found among the post's links and read now: that
  // link goes, described from that page. None that can be read: held and read again, never sent as the post.
  if (match.kind === "opportunity" && url && !match.foundInRoundup) {
    const listed = isX(url) ? postText : "";
    const r = listed ? roundupOf(listed, match.name) : null;
    if (r) return resolveFromRoundup(match, url, r, o, listed);
  }
  // No page to read again: a Co event with no link, or an X post with no event page behind it (the post can't be read again without
  // the X API). It goes as it was found, marked unverified; its caption may not claim spots or a price its record doesn't state.
  if (!url || isX(url) || match.kind !== "opportunity") {
    // Nothing to read again, so its start on record decides (a Noise event with no link).
    const late = matchStartProblem(match, now, START_LEAD_MINUTES, zone);
    if (late) return { ok: false, exit: true, state: "expired", why: late };
    return { ok: true, match, checkedAt: match.checkedAt ?? "", changed: [], verified: false };
  }
  const r = await deps.page(url).catch((): PageRead => ({ text: null, gone: false }));
  // A dead link is certain.
  if (r.gone) return { ok: false, exit: true, state: "cancelled", why: `its page is gone (a dead link when Cue checked on ${today})` };
  if (!r.text) return { ok: false, exit: false, why: "its page couldn't be read just now" };
  // A web page that is itself a roundup of several things, this among them (an article, a list): the same rule as a post.
  if (!match.foundInRoundup) {
    const listed = roundupOf(r.text, match.name, { page: true });
    if (listed) return resolveFromRoundup(match, url, listed, o, r.text);
  }
  // Words are never certain: held and read again.
  const onFile = eventDateOf(match, zone) ?? (isOpening && "deadline" in match ? match.deadline ?? null : null);
  const closed = closedOnPage(r.text, match.name, onFile);
  if (closed) return { ok: false, exit: false, why: `its page says "${closed}" next to its name (checked ${today}); held and read again, not sent` };
  // A dated find (an opening, or anything with a date or deadline on file): read for whether it is still open, whatever the wording.
  // Closed counts only with the page's own words, found on the page; held and read again like the word list, never an exit.
  const dated = isOpening || !!onFile || ("deadline" in match && !!match.deadline);
  if (dated && deps.openRead) {
    const o = await deps.openRead({ name: String(match.name ?? ""), page: r.text, today, onFile, isOpening }).catch(() => null);
    if (o?.state === "closed" && o.quote && onPage(r.text, o.quote)) return { ok: false, exit: false, why: `its page says "${o.quote.slice(0, 120)}" (read for whether it's still open, ${today}); held and read again, not sent` };
  }
  // A date on file the page doesn't show (it moved, or the page writes it in a form the date reader misses): held, never an exit.
  if (onFile) {
    const stated = datesOnPage(r.text, Number(onFile.slice(0, 4)));
    if (stated.size && !stated.has(onFile.slice(0, 10))) return { ok: false, exit: false, why: `the date on file (${onFile.slice(0, 10)}) isn't shown on its page now` };
  }
  // The page now, in its own field: the post or evidence it was found from stays as it was (review of #138).
  const next: any = { ...match, pageNow: r.text.slice(0, 3000), checkedAt };
  return { ok: true, match: next, checkedAt, changed: [], verified: true };
}

// ---------------------------------------------------------------- the send path's hook

export type SendCheckDeps = RecheckDeps &
  ExitDeps & {
    now: () => Date;
    // The refreshed record onto the waiting row, so every later read (the reply's details, the send record) has it.
    saveMatch: (candidateId: string, match: TierMatch) => Promise<void>;
    // How many times the re-read held this waiting text back (RECHECK_MAX_DEFERS).
    saveDefers: (candidateId: string, defers: number) => Promise<void>;
  };
export const realSendCheckDeps: SendCheckDeps = {
  // An event's own page record now: Luma's, or (Royce, 2026-10-28: tiers by kind of page) any event page it was filed from (eventPage.ts).
  luma: async (url) => (await import("./eventPage.js")).eventPageDetails(url, RECHECK_FRESH_MS),
  page: async (url) => (await import("./webOpportunitySearch.js")).readPageChecked(url),
  openRead: (i) => readOpenNow(i),
  // Bound to the member per send (checkBeforeSend).
  sentNames: undefined,
  now: () => new Date(),
  writeFact: async (e) => (await import("./workingSet.js")).realExitDeps.writeFact(e),
  saveMatch: async (id, match) => {
    const pool = (await import("../db/db.js")).default;
    await pool.query(`UPDATE proactive_candidates SET payload = jsonb_set(payload, '{match}', $2::jsonb), updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [id, JSON.stringify(match)]);
  },
  saveDefers: async (id, defers) => {
    const pool = (await import("../db/db.js")).default;
    await pool.query(`UPDATE proactive_candidates SET payload = payload || jsonb_build_object('recheckDefers', $2::int), updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [id, defers]);
  },
};

export type SendCandidate = { id: string; userId: string; payload: any };
// held: skipped after RECHECK_MAX_DEFERS defers; the caller archives the row and the backlog holds the find (HELD_MARK in the reason).
export type SendCheck = { ok: true; match: TierMatch } | { skip: string; exited: boolean; held?: boolean } | { defer: Date; reason: string };

// Pure: the fact an exit writes, scoped to this find (and the ask it was for), never wider.
export function findExit(userId: string, match: TierMatch, askText: string | null | undefined, state: ExitState, reason: string) {
  return { userId, kind: "find" as const, itemKey: exitKey(match), label: String(match.name ?? ""), state, reason, scope: `this ${formOf(match as any) ?? "find"}${askText ? `, found for: ${String(askText).slice(0, 100)}` : ""}; nothing about what they like` };
}

// The hook. ok: c.payload.match is now the refreshed record (draft from it). skip with exited: a certain exit, its fact written (the
// caller archives the row: dispatch's dropCandidate). defer: anything uncertain, read again later. A fact that can't be written keeps
// the find live (workingSet.ts: the fact first), so that's a defer too. In a dry run nothing is written (o.dryRun, or sendCheckDryRun).
export async function checkBeforeSend(c: SendCandidate, zone: string | null, deps: SendCheckDeps = realSendCheckDeps, o: { dryRun?: boolean } = {}): Promise<SendCheck> {
  const dry = o.dryRun ?? sendCheckDryRun.getStore() === true;
  const p = c.payload ?? {};
  const match: TierMatch | undefined = p.match;
  if (!match) return { skip: "no find on the waiting text", exited: false };
  const now = deps.now();
  const later = new Date(now.getTime() + RECHECK_RETRY_HOURS * 3_600_000);
  // What they already have, for a roundup shared as a roundup: read once, only if it's needed (knowledge/sent.ts).
  if (!deps.sentNames) {
    deps = { ...deps, sentNames: async () => {
      const [{ default: pool }, S] = await Promise.all([import("../db/db.js"), import("./knowledge/sent.js")]);
      return (await S.sentByReferent((sql, args) => pool.query(sql, args as any[]).then((r) => r.rows), c.userId)).map((x) => x.name);
    } };
  }
  if (!deps.discussedAmong) {
    deps = { ...deps, discussedAmong: async (names) => {
      const [{ default: pool }, R] = await Promise.all([import("../db/db.js"), import("./conversationRecall.js")]);
      return R.talkedAboutAmong({ query: (sql, args) => pool.query(sql, args as any[]) as any }, c.userId, names);
    } };
  }
  // Read moments ago (stillRelevant ran first this tick): no second read.
  const at = match.checkedAt ? Date.parse(match.checkedAt) : NaN;
  // Its start still decides: read 20 minutes ago, it may have started since (or come inside the hour).
  const fresh = !Number.isNaN(at) && now.getTime() - at < RECHECK_FRESH_MS;
  const late = fresh ? matchStartProblem(match, now, START_LEAD_MINUTES, zone) : null;
  if (fresh && !late) return { ok: true, match };
  const r: Recheck = late ? { ok: false, exit: true, state: "expired", why: late } : await recheckFind(match, { now, zone, deps });
  if (r.ok) {
    p.match = r.match;
    if (r.verified && !dry) await deps.saveMatch(c.id, r.match).catch((err: any) => console.error("sendCheck: refreshed record not saved (non-fatal):", err?.message ?? err));
    return { ok: true, match: r.match };
  }
  if (!r.exit) {
    const defers = Number(p.recheckDefers ?? 0) + 1;
    if (defers >= RECHECK_MAX_DEFERS) return { skip: `send failed: ${HELD_MARK}: ${r.why}, on ${defers} tries`, exited: false, held: true };
    p.recheckDefers = defers;
    if (!dry) await deps.saveDefers(c.id, defers).catch(() => {});
    return { defer: later, reason: `not sent unchecked: ${r.why} (try ${defers} of ${RECHECK_MAX_DEFERS})` };
  }
  if (dry) return { skip: `re-read at send: ${r.why} (dry run: nothing written)`, exited: true };
  const ok = await writeExitFact(findExit(c.userId, match, p.askText, r.state ?? "expired", r.why), deps);
  return ok ? { skip: `re-read at send: ${r.why}`, exited: true } : { defer: later, reason: `re-read at send: ${r.why}; its exit fact couldn't be written, so it waits` };
}

// ---------------------------------------------------------------- B2: a queue window that ran out

// The skip reason an undated find's row gets when its window ends unsent: a failed attempt (workingSet.ts isFailedAttempt), never a
// decision, so it goes back to the backlog and may be queued again.
export const WINDOW_ENDED = "window ended unsent";
// Pure: does a waiting find go back to the backlog when its window ends? An undated one does (nothing about it ended); one whose date
// or last useful day ended doesn't (the backlog's own prune exits a past date on its fact).
export function returnsOnExpiry(p: { match: TierMatch; lastDay?: string | null }, zone: string | null): boolean {
  return !p.lastDay && !lifeEndOf(p.match, zone);
}

// ---------------------------------------------------------------- B4: a caption's prices and counts

const n = (s: string) => s.replace(/,/g, "").replace(/\.0+$/, "");
// A number with its scale word, as one value (2026-10-13: "$75K+" in a caption was read as "$75" and refused against a page saying
// "$75,000+", so the find never went out). k/K/thousand, m/M/million, b/bn/billion.
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const scaled = (num: string, unit: string | undefined): string => {
  const mult = unit ? SCALE[unit.toLowerCase()] : undefined;
  if (!mult) return n(num);
  return String(Math.round(Number(num.replace(/,/g, "")) * mult));
};
const NUM_WITH_SCALE = /(\d[\d,]*(?:\.\d+)?)(?:\s?(k|thousand|mm|m|million|bn|b|billion)\b)?/gi;
const SCARCITY = /\b(?:only a few|a few|limited|last few|handful of|few)\s+(?:spots?|seats?|tickets?|places?|slots)\b|\b(?:selling|filling)\s+(?:out|up|fast)\b|\balmost (?:full|sold out|gone)\b|\bspots? (?:are )?(?:going|limited)\b|\bbefore it sells out\b/i;
const SPOTS_ON_RECORD = /\bspots? (?:left|remaining)\b|\bsold out\b|\bcapacity\b|\bwait ?list\b|\blimited (?:spots?|seats?|capacity|space)\b|\bspots? (?:are )?limited\b/i;
// Pure (B4): every price and count a caption states is on the record it was drafted from (the page's details, the source post, their
// own ask), the way a task's texts already are (services/taskWeb.ts numbersBacked). Dates and clock times are left to the date checks.
export function captionNumbersBacked(caption: string, facts: string): { ok: boolean; problems: string[] } {
  // Every number on the record at its full value ("$250K" is on file as 250000 only, so a caption's "$250" isn't backed by it).
  const have = new Set<string>();
  for (const m of facts.matchAll(NUM_WITH_SCALE)) have.add(scaled(m[1], m[2]));
  const problems: string[] = [];
  const t = caption.replace(/[’‘]/g, "'");
  for (const m of t.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k|thousand|mm|m|million|bn|b|billion)\b)?|\b(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars|bucks)\b/gi)) {
    // "$75K" is 75000: backed by "$75,000" or "$75K" on the record. A bare "$75" still needs 75.
    const v = m[1] !== undefined ? scaled(m[1], m[2]) : n(m[3]);
    if (!have.has(v)) problems.push(`price "${m[0].trim()}" isn't on its page`);
  }
  if (/\b(?:it'?s|is|are|totally|completely)\s+free\b|\bfree (?:to (?:attend|join|go)|entry|admission|tickets?)\b|\bno (?:cover|cost|charge)\b/i.test(t) && !/\bfree\b|\bno (?:cost|charge|cover)\b|\$0\b/i.test(facts)) problems.push(`says it's free, and its page doesn't`);
  for (const m of t.matchAll(/\b(\d[\d,]*)\s+(?:\w+\s+){0,2}?(?:spots?|seats?|tickets?|places?|slots|people|guests?|attendees|rsvps?|registered|signups?|founders|members|builders|openings)\b|\b(?:only|just)\s+(\d[\d,]*)\s+(?:left|remaining)\b/gi)) {
    const v = n(m[1] ?? m[2]);
    if (!have.has(v)) problems.push(`count "${m[0].trim()}" isn't on its page`);
  }
  const scarce = t.match(SCARCITY);
  if (scarce && !SPOTS_ON_RECORD.test(facts)) problems.push(`"${scarce[0]}" with no spots count on its page`);
  if (/\bsold out\b/i.test(t) && !/\bsold out\b/i.test(facts)) problems.push(`says "sold out", and its page doesn't`);
  // A waitlist-only event (eventDetails.ts WAITLIST_FACT): no caption says or hints there are spots, or that Cue gets them off it.
  if (WAITLIST_ON_RECORD.test(facts)) {
    // Joining the waitlist itself ("you can sign up for the waitlist", "registration is open for the waitlist") is the honest offer.
    const spotsTalk = t.replace(WAITLIST_JOIN, " ");
    const open = spotsTalk.match(OPEN_SPOTS) ?? spotsTalk.match(SCARCITY) ?? spotsTalk.match(CAPACITY_LEFT);
    if (open) problems.push(`says "${open[0]}", and its page says waitlist only (no open spots)`);
    const off = t.match(OFF_THE_WAITLIST);
    if (off) problems.push(`says "${off[0]}", and Cue can only add them to the waitlist`);
  }
  return { ok: problems.length === 0, problems };
}
const WAITLIST_ON_RECORD = /\bwait ?list only\b/i;
// Spot words only: "room" and "space" alone are the venue ("great space for demos", "plenty of room to breathe"), never availability.
const OPEN_SPOTS = /\b(?:spots?|seats?|tickets?|places?)\s+(?:are\s+|is\s+)?(?:still\s+)?(?:open|left|available|remaining)\b|\b(?:still|plenty of|some)\s+(?:spots?|seats?|tickets?)\b|\bopen\s+(?:spots?|seats?)\b|\b(?:registration|rsvps?|signups?)\s+(?:is\s+|are\s+|'s\s+)?(?:still\s+)?open\b|\bopen for (?:registration|signups?|rsvps?)\b|\byou can (?:still )?(?:register|get in|grab a (?:spot|seat|ticket)|rsvp|sign up)\b|\b(?:not|isn't|is not) (?:full|sold out)\b/i;
// The gap never spans a spot word ("register now, spots are open for the waitlist" keeps its spots claim), and "open" only in the
// exact phrase "open for the waitlist", never after a spot word ("spots are open for the waitlist crowd"; review of #452).
// Room left as a number ("room for 20 more", "20 more", "20 spots"; final review of #452). "a 20-minute walk" isn't one.
const CAPACITY_LEFT = /\broom for\s+\d[\d,]*\b|\b\d[\d,]*\s+more\b|\b\d[\d,]*\s+(?:open\s+)?(?:spots?|seats?|tickets?|places?)\b/i;
const WAITLIST_JOIN = /\b(?:register|sign(?:\s|-)?up|join|rsvp|get on)\b(?:(?!\b(?:spots?|seats?|tickets?|places?)\b)[^.!?\n]){0,30}?\b(?:for|on|to)\s+(?:the\s+)?wait ?list\b|(?<!\b(?:spots?|seats?|tickets?|places?)\s+(?:are\s+|is\s+)?(?:still\s+)?)\bopen for the wait ?list\b/gi;
const OFF_THE_WAITLIST = /\b(?:get|move|bump|pull)\s+(?:you|them)\s+off\s+(?:the\s+)?wait ?list\b|\b(?:get|guarantee)\s+(?:you|them)\s+(?:a\s+)?(?:spot|seat|in)\b/i;

// ---------------------------------------------------------------- B5: a task's on-file find

export type OnFileLike = { name: string; url: string; tier: number; facts: string[]; checkedAt?: string | null };
// Pure: the find a task has on file, as a match recheckFind can read (its date from its own "date: " fact).
export function onFileMatch(f: OnFileLike): TierMatch {
  const date = f.facts.map((x) => x.match(/^date: (\d{4}-\d{2}-\d{2})/)?.[1]).find(Boolean) ?? null;
  if (isLuma(f.url) && date) return { tier: 2, kind: "public_event", event_api_id: f.url, event_date: date, name: f.name, url: f.url, reason: f.name, checkedAt: f.checkedAt ?? undefined } as TierMatch;
  return { tier: 3, kind: "opportunity", name: f.name, url: f.url, reason: f.name, ...(date ? { statedDates: { start: date } } : {}), checkedAt: f.checkedAt ?? undefined } as TierMatch;
}
// Pure: the facts a task may send for a re-read find (the record as it is now, stamped).
export function onFileFacts(m: TierMatch, checkedAt: string): string[] {
  const d = m.details;
  const date = eventDateOf(m);
  return [
    date ? `date: ${date}` : null,
    d?.startAt ? `starts ${String(d.startAt).replace("T", " ").slice(0, 16)}` : null,
    d?.venue ?? null,
    d?.price ? (d.price === "free" ? "free" : `price ${d.price}`) : null,
    d?.soldOut ? "sold out" : d?.waitlist ? WAITLIST_SHORT : typeof d?.spotsRemaining === "number" ? `${d.spotsRemaining} spots left` : null,
    `checked ${checkedAt.slice(0, 16).replace("T", " ")} UTC`,
  ].filter((x): x is string => !!x);
}
export type OnFileCheck = { ok: true; facts: string[]; checkedAt: string } | { ok: false; why: string; exited: boolean };
// A task's on-file find, read again before the task sends it unless it was read within RECHECK_FRESH_MS. Sold out, gone or past:
// left out, and it exits the working set on that fact (the backlog prune then takes it out, workingSet.ts pruneBacklogs). Unreadable
// right now: left out of this send. A source that can't be read again at all: sent with its age on it, never as current.
export async function recheckOnFile(userId: string, f: OnFileLike, zone: string | null, deps: RecheckDeps & ExitDeps & { now: () => Date }): Promise<OnFileCheck> {
  const now = deps.now();
  const at = f.checkedAt ? Date.parse(f.checkedAt) : NaN;
  if (!Number.isNaN(at) && now.getTime() - at < RECHECK_FRESH_MS) return { ok: true, facts: f.facts, checkedAt: f.checkedAt! };
  const m = onFileMatch(f);
  const r = await recheckFind(m, { now, zone, deps });
  // A source that can't be read again (an X post with no event page): it goes with its age on it, never as current.
  if (r.ok) return r.verified ? { ok: true, facts: onFileFacts(r.match, r.checkedAt), checkedAt: r.checkedAt } : { ok: true, facts: [...f.facts.filter((x) => !/not checked since/.test(x)), `on file from ${f.checkedAt ? f.checkedAt.slice(0, 10) : "an earlier day"}, not checked since`], checkedAt: f.checkedAt ?? "" };
  if (!r.exit) return { ok: false, why: r.why, exited: false };
  const exited = await writeExitFact(findExit(userId, m, null, r.state ?? "expired", r.why), deps);
  return { ok: false, why: r.why, exited };
}

// ---------------------------------------------------------------- B6: the source, for stillRelevant

// Pure: what its own page says now, in one line, for a model to read alongside the conversation. null when it wasn't read.
export function sourceLine(match: TierMatch | null | undefined, now = new Date()): string | null {
  if (!match?.checkedAt) return null;
  const age = now.getTime() - Date.parse(match.checkedAt);
  if (Number.isNaN(age) || age > RECHECK_FRESH_MS) return null;
  const d = match.details;
  if (d) {
    const bits = [d.startAt ? `starts ${d.startAt}` : null, d.soldOut ? "sold out" : d.waitlist ? WAITLIST_SHORT : typeof d.spotsRemaining === "number" ? `${d.spotsRemaining} spots left` : null, d.price ? `price ${d.price}` : null].filter(Boolean);
    return `Its event page, read just now: ${bits.join(", ") || "still listed"}.`;
  }
  const page = String(match.pageNow ?? match.opportunity?.postText ?? ("evidence" in match ? match.evidence ?? "" : "")).replace(/\s+/g, " ").slice(0, 600);
  return page ? `Its page, read just now, opens: ${page}` : null;
}
