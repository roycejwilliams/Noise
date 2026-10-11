// As of when (Phase B, B3, Royce 2026-10-10): "Replies never state stored spots/times/prices as current. Re-verify live or label
// as-of." The audit found a reply answering "still spots? what time?" from details captured 3 to 14 days earlier, said as today's,
// and the reply's own fact check passing it, because the stale stored fact was the thing it checked against (circular).
//
// Three parts, all pure but the live read (which takes its fetch as a dep):
//   - renderDetailsAsOf: a stored record's volatile lines (start time, price, spots, sold out, headcount) carry when they were
//     read, and once that's past VOLATILE_MS they say "not checked since". A fresh read carries no mark.
//   - liveDetailFacts: when they ask a live question ("still spots?", "what time?", "how much?"), the Luma pages of what Co sent
//     them are read again now, and what comes back is a fact with no mark (live beats stored).
//   - staleCurrentClaims / citesStaleAsCurrent: a reply that states a volatile detail backed ONLY by marked (stale) facts, without
//     saying "as of", fails, in code (codeChecks) and in the claim read's citation check (claimChecks). A live fact backs it.
import { DateTime } from "luxon";
import { renderEventDetails, type EventDetails } from "./eventDetails.js";

// The same window linkReader.ts uses for its volatile fields (VOLATILE_AFTER_MS): sold out, spots, a moved time.
export const VOLATILE_MS = 4 * 60 * 60 * 1000;
// The mark a stale volatile fact carries. linkReader.ts describeRead's own "(as of …, may have changed)" counts as the same mark.
export const STALE_MARK = "not checked since";
const STALE_RE = /\bnot checked since\b|\bmay have changed\b/i;
export function isStaleFact(text: string): boolean {
  return STALE_RE.test(text);
}

// Pure: is a read from checkedAt still current at now? No time at all is never current.
export function isStale(checkedAt: string | Date | null | undefined, now = new Date()): boolean {
  if (!checkedAt) return true;
  const t = new Date(checkedAt).getTime();
  return Number.isNaN(t) || now.getTime() - t > VOLATILE_MS;
}

// Pure: "Oct 6" (in their zone), or "an earlier day" when the record never said.
export function asOfWords(checkedAt: string | Date | null | undefined, zone: string | null = null): string {
  if (!checkedAt) return "an earlier day";
  const d = DateTime.fromJSDate(new Date(checkedAt));
  if (!d.isValid) return "an earlier day";
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  return d.setZone(z).toFormat("LLL d, h:mm a");
}

// The lines renderEventDetails writes that can change after a read: the start (and end), the price, sold out, spots, headcount.
const VOLATILE_LINE = /\bstarts\b|\bspots left\b|\bsold out\b|\bregistered so far\b|\bTickets are\b|\bIt's free\b/;

// Pure: a stored event record as facts, each volatile line marked when it's stale. Fresh: exactly renderEventDetails.
export function renderDetailsAsOf(name: string, d: EventDetails, checkedAt: string | Date | null | undefined, now = new Date(), zone: string | null = null): string[] {
  const lines = renderEventDetails(name, d);
  if (!isStale(checkedAt, now)) return lines;
  const when = asOfWords(checkedAt, zone);
  return lines.map((l) => (VOLATILE_LINE.test(l) ? `${l.replace(/\.\s*$/, "")} (as of ${when}, ${STALE_MARK}; say it as of then, or check it again).` : l));
}

// Pure: their message is an explicit live-detail question: spots or tickets left, sold out, still on, what time it starts, the price.
// Narrow on purpose (review of #138: "I'm still on the fence", "any chance you're around Sunday" and "I want to start running again"
// each set off a read they waited on). Royce has an open question on keeping the live read at all; it stays narrow and bounded.
export function asksLiveDetail(message: string): boolean {
  const m = message.toLowerCase().replace(/[’‘]/g, "'");
  return (
    /\b(?:any|still|are there|is there)\s+(?:\w+\s+)?(?:spots?|seats?|tickets?|room|space)\b/.test(m) ||
    /\b(?:spots?|seats?|tickets?)\s+(?:left|available|remaining)\b/.test(m) ||
    /\b(?:sold out|full)\s*\?|\bis it (?:sold out|full)\b|\bdid it sell out\b/.test(m) ||
    /\b(?:is|it's) (?:it |that |this |the \w+ )?still (?:on|happening|going ahead)\b|\bstill (?:on|happening) for\b|\b(?:was|is) it (?:cancel+ed|postponed)\b/.test(m) ||
    /\bwhat time (?:does|is|do)\b|\bwhen does (?:it|that|this|the \w+) (?:start|begin|kick off)\b/.test(m) ||
    /\bhow much (?:is|are|does|do)\b|\bwhat(?:'s| is| are) the (?:price|cost)\b|\bticket price\b|\bis it free\b/.test(m)
  );
}

// ---------------------------------------------------------------- the claim check

// A label that makes a stored detail honest: "as of Oct 6", "last I checked", "when I looked on Monday".
export const AS_OF_LABEL = /\bas of\b|\blast (?:i|we) (?:checked|looked)\b|\bwhen i (?:checked|looked)\b|\b(?:checked|looked) (?:it )?(?:on|at|last)\b|\bon file\b|\bat the time\b/i;

const num = (s: string) => s.replace(/,/g, "").replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
function clocks(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])/gi)) {
    let h = Number(m[1]) % 12;
    if (/^p/i.test(m[3])) h += 12;
    out.push(`time:${String(h).padStart(2, "0")}:${m[2] ?? "00"}`);
  }
  return out;
}
// Pure: the volatile things a piece of text states, as comparable tokens (a draft's sentence or a fact line, read the same way):
// spots:12, reg:40, price:25, price:free, soldout, avail. Clock times only with o.times (review of #138: "It starts at 7pm Saturday"
// in a plain "ok I'm in" reply and "want me to remind you at 6:30pm?" were cut): the cut covers availability, price and counts only;
// a stale time is marked in its fact, never cut from a reply.
export function volatileTokens(text: string, o: { times?: boolean } = {}): string[] {
  const t = text.replace(/[’‘]/g, "'");
  const out = new Set<string>(o.times ? clocks(t) : []);
  for (const m of t.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) out.add(`price:${num(m[1])}`);
  for (const m of t.matchAll(/\b(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars|bucks)\b/gi)) out.add(`price:${num(m[1])}`);
  if (/\b(?:it'?s|is|are|totally|completely)\s+free\b|\bfree (?:to (?:attend|join|go)|entry|admission|tickets?)\b|\bno (?:cover|cost|charge)\b/i.test(t)) out.add("price:free");
  for (const m of t.matchAll(/\b(\d[\d,]*)\s+(?:\w+\s+)?(?:spots?|seats?|tickets?|places?)\b/gi)) out.add(`spots:${num(m[1])}`);
  for (const m of t.matchAll(/\b(\d[\d,]*)\s+(?:people|guests?|attendees|folks)\b[^.?!]{0,30}\b(?:registered|going|signed up|rsvp'?d|attending)\b|\b(\d[\d,]*)\s+(?:registered|rsvps?|signups?)\b/gi)) out.add(`reg:${num(m[1] ?? m[2])}`);
  if (/\bsold out\b|\bno (?:spots?|seats?|tickets?) left\b|\bat capacity\b/i.test(t)) out.add("soldout");
  if (/\b(?:still|plenty of|a few|some|only)\s+(?:\d+\s+)?(?:spots?|seats?|tickets?|room|space|places?)\b|\bspots? (?:left|open|remaining|available)\b|\bnot sold out\b|\bstill (?:open|available|has room)\b/i.test(t)) out.add("avail");
  return [...out];
}
// A fact speaks to availability (backs or contradicts "still spots") when it states spots, sold out or a headcount.
function factTokens(text: string): string[] {
  const own = volatileTokens(text);
  return own.some((x) => x.startsWith("spots:") || x === "soldout" || x.startsWith("reg:")) ? [...own, "avail"] : own;
}

// Pure: the sentences of a draft that state a volatile detail as current when every fact backing it is stale (marked), and the
// sentence itself says nothing about when. A detail no fact states at all is left to the other checks.
export function staleCurrentClaims(draft: string, facts: string[]): { sentence: string; token: string }[] {
  const read = facts.map((f) => ({ stale: isStaleFact(f), tokens: new Set(factTokens(f)) }));
  const out: { sentence: string; token: string }[] = [];
  for (const sentence of draft.match(/[^.!?\n]+[.!?]*/g) ?? []) {
    if (AS_OF_LABEL.test(sentence)) continue;
    for (const token of volatileTokens(sentence)) {
      const backing = read.filter((r) => r.tokens.has(token));
      if (backing.length && backing.every((r) => r.stale)) {
        out.push({ sentence: sentence.trim(), token });
        break;
      }
    }
  }
  return out;
}

// Pure: the model's claim read cited this fact for this claim. A stale fact never backs a claim that states its volatile detail as
// current: the citation is circular (the stored detail checked against itself).
export function citesStaleAsCurrent(claim: string, citedFact: string | null | undefined): boolean {
  if (!citedFact || !isStaleFact(citedFact) || AS_OF_LABEL.test(claim)) return false;
  const cited = new Set(factTokens(citedFact));
  return volatileTokens(claim).some((t) => cited.has(t));
}

// ---------------------------------------------------------------- the live read

export type LiveItem = { name: string; url: string | null };
export type LiveDeps = { luma: (url: string) => Promise<EventDetails | null>; isLuma: (url: string) => boolean };
export const LIVE_READS_MAX = 2;
// They asked a live question: the Luma pages of the few things Co sent them most recently are read now (a short cache: a read within
// the last few minutes counts as now), and what comes back is a fact with no mark. Other pages stay as-of: reading them needs a model
// and the reply never waits on that. Only this member's own sends are passed in (no other member's links ever reach here).
export async function liveDetailFacts(message: string, items: LiveItem[], deps: LiveDeps, now = new Date()): Promise<string[]> {
  if (!asksLiveDetail(message)) return [];
  const seen = new Set<string>();
  const picks = items.filter((i) => i.url && deps.isLuma(i.url) && !seen.has(i.url) && seen.add(i.url)).slice(0, LIVE_READS_MAX);
  const lines: string[] = [];
  await Promise.all(
    picks.map(async (i) => {
      const d = await deps.luma(i.url!).catch(() => null);
      if (!d) {
        lines.push(`Co tried to check "${i.name}" live just now and couldn't read its page: anything on file about its spots, time or price is as of when it was found, never current.`);
        return;
      }
      lines.push(`Checked live just now (${now.toISOString().slice(0, 16).replace("T", " ")} UTC), "${i.name}": ${renderEventDetails(i.name, d).filter((l) => !/^What the event page says/.test(l)).join(" ")}`);
    }),
  );
  return lines;
}
