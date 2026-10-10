// Verify at send (Phase B, Royce 2026-10-10). The audit: nothing re-read a find between when it was captured and when it went out,
// so "12 spots left" went out days later as current. Co checked live sources only when it FOUND something (pages fetched, words
// checked, a Jev fact check, Luma details at most an hour old); at send time it checked only its own records (opted out, ask still
// open, the date against today, already sent). The reply loop already had the right pattern (agent/loopTools.ts storedFinds /
// seedFound / usableFacts: a stored find expires and is read again before anything cites it); this is that pattern on the send path.
//
//   B1 recheckFind: one find's own page read again right before it sends. Luma: the event's details, fresh (sold out, no spots left,
//      a moved start, already started). A web page: gone (404/410), says it's sold out, cancelled or closed next to its name, or no
//      longer states the date on file. What comes back replaces the stored record, stamped checkedAt.
//   checkBeforeSend: the send path's hook (harness/proactiveRegistry.ts event_offer draft, and stillRelevant for B6). A find that's
//      sold out, cancelled, gone or past EXITS through the working set (services/workingSet.ts writeExitFact: the fact first, with its
//      scoped reason, never silently dropped). One that can't be read right now waits a few hours and is read again; after
//      RECHECK_MAX_MISSES unread tries it exits on that fact.
//   B2 exitOnQueueExpiry: a queued find whose window ran out leaves on a fact too (an undated one now waits UNDATED_QUEUE_DAYS, not 14).
//   B4 captionNumbersBacked: a caption's prices and counts must be on the record it was drafted from.
//   B5 recheckOnFile: a task's "on file" find is read again (or left out) before a task sends it.
//   B6 sourceLine: what its page says now, for stillRelevant to read instead of the conversation alone.
//
// Phase C moves the event_offer bundle into one composer (harness/bundleComposer.ts prepareOffer): checkBeforeSend is the one call
// it needs, so the hooks here stay one or two lines.
import { DateTime } from "luxon";
import type { TierMatch } from "./tieredRecommendation.js";
import type { EventDetails } from "./eventDetails.js";
import { datesOnPage, dayIn, eventDateOf, exitKey, formOf, lifeEndOf } from "./findForm.js";
import { writeExitFact, type ExitDeps, type ExitState } from "./workingSet.js";

// A read this recent counts as now: the plan/email tool's own window for a Luma page (agent/loopTools.ts emailPlan).
export const RECHECK_FRESH_MS = 30 * 60 * 1000;
// A page that can't be read is tried again after this long, and exits after this many unread tries (the backlog's own rule for an
// unreadable page is UNREAD_DAYS separate days; a queued find is about to go, so it gets hours, not days).
export const RECHECK_RETRY_HOURS = 3;
export const RECHECK_MAX_MISSES = 3;
// How long an undated find may wait in the queue (B2): it used to be 14 days, never read again. Every send re-reads it now; past
// this it leaves on that fact, and a new search finds it again only if they ask again.
export const UNDATED_QUEUE_DAYS = 3;

export type PageRead = { text: string | null; gone: boolean };
export type RecheckDeps = {
  // A Luma event's details, read fresh (a cached read younger than RECHECK_FRESH_MS counts).
  luma: (url: string) => Promise<EventDetails | null>;
  // Any other page: its text, and whether it's gone (404/410).
  page: (url: string) => Promise<PageRead>;
};
export type Recheck =
  | { ok: true; match: TierMatch; checkedAt: string; changed: string[]; verified: boolean }
  | { ok: false; why: string; exit: boolean; state?: ExitState };

const isLuma = (url: string | null | undefined) => !!url && /^https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\//i.test(url);
const isX = (url: string | null | undefined) => !!url && /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(url);
const zoneOr = (zone: string | null | undefined) => (zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles");
const localDay = (now: Date, zone: string | null) => DateTime.fromJSDate(now).setZone(zoneOr(zone)).toISODate()!;

// Said on a page next to the thing's name: sold out, cancelled, postponed, full, closed to applications.
const CLOSED = /\b(sold out|(?:has been |was |is )?cancel+ed|(?:has been |was |is )postponed|registration (?:is |has )?closed|applications? (?:are |is |have )?(?:now )?closed|no longer accepting|at capacity|fully booked|wait ?list only|join the wait ?list)\b/i;
// Pure: a closing word on the page, about this thing: next to a word of its name, or on a short page that's only about it.
export function closedOnPage(page: string, name: string): string | null {
  const words = name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4);
  const lower = page.toLowerCase();
  for (const m of lower.matchAll(new RegExp(CLOSED.source, "gi"))) {
    const at = m.index ?? 0;
    const near = lower.slice(Math.max(0, at - 300), at + 300);
    if (page.length < 1500 || !words.length || words.some((w) => near.includes(w))) return m[0];
  }
  return null;
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
  // The Luma page that is its record: its own link, else a Luma link in the post it came from.
  const postText = String(match.opportunity?.postText ?? ("evidence" in match ? match.evidence ?? "" : ""));
  const lumaUrl = isLuma(url) ? url : (postText.match(/https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/[^\s)"'<>]+/i)?.[0] ?? null);
  if (lumaUrl) {
    const d = await deps.luma(lumaUrl).catch(() => null);
    if (!d) return { ok: false, exit: false, why: "its event page couldn't be read just now" };
    if (d.soldOut === true) return { ok: false, exit: true, state: "expired", why: `sold out when Co read its page on ${today}` };
    if (d.spotsRemaining === 0) return { ok: false, exit: true, state: "expired", why: `no spots left when Co read its page on ${today}` };
    if (d.startAt && new Date(d.startAt).getTime() <= now.getTime()) return { ok: false, exit: true, state: "expired", why: `it had already started (${d.startAt}) when Co read its page` };
    const old = match.details ?? null;
    const changed: string[] = [];
    if (old?.startAt && d.startAt && old.startAt !== d.startAt) changed.push(`start moved from ${old.startAt} to ${d.startAt}`);
    if (old && old.spotsRemaining !== d.spotsRemaining && d.spotsRemaining !== null) changed.push(`spots ${old.spotsRemaining ?? "unknown"} -> ${d.spotsRemaining}`);
    if (old?.price && d.price && old.price !== d.price) changed.push(`price ${old.price} -> ${d.price}`);
    const next: any = { ...match, details: d, checkedAt };
    const newDay = d.startAt ? dayIn(d.startAt, d.timezone ?? zone) : null;
    if (newDay && "event_date" in next && next.event_date && String(next.event_date).slice(0, 10) !== newDay) next.event_date = newDay;
    const after = pastBy(next);
    if (after) return after;
    return { ok: true, match: next, checkedAt, changed, verified: true };
  }
  // An X post with no event page behind it: the post is the only record and can't be read again without the X API. It goes as it
  // was found, unverified; its caption may not claim spots or a price the post doesn't state (captionNumbersBacked).
  if (!url || isX(url) || match.kind !== "opportunity") return { ok: true, match, checkedAt: match.checkedAt ?? "", changed: [], verified: false };
  const r = await deps.page(url).catch((): PageRead => ({ text: null, gone: false }));
  if (r.gone) return { ok: false, exit: true, state: "cancelled", why: `its page is gone (a dead link when Co checked on ${today})` };
  if (!r.text) return { ok: false, exit: false, why: "its page couldn't be read just now" };
  const closed = closedOnPage(r.text, match.name);
  if (closed) return { ok: false, exit: true, state: /cancel|postpone/i.test(closed) ? "cancelled" : "expired", why: `its page says "${closed}" (checked ${today})` };
  // A date on file the page no longer states, while it states others: it moved, and Co doesn't know where to. Read again later.
  const onFile = eventDateOf(match, zone) ?? (isOpening && "deadline" in match ? match.deadline ?? null : null);
  if (onFile) {
    const stated = datesOnPage(r.text, Number(onFile.slice(0, 4)));
    if (stated.size && !stated.has(onFile.slice(0, 10))) return { ok: false, exit: false, why: `the date on file (${onFile.slice(0, 10)}) isn't on its page any more` };
  }
  const page = r.text.slice(0, 6000);
  const next: any = { ...match, evidence: page, checkedAt, ...(match.opportunity || match.source === "web" ? { opportunity: { postText: page.slice(0, 2000) } } : {}) };
  return { ok: true, match: next, checkedAt, changed: [], verified: true };
}

// ---------------------------------------------------------------- the send path's hook

export type SendCheckDeps = RecheckDeps &
  ExitDeps & {
    now: () => Date;
    // The refreshed record onto the waiting row, so every later read (the reply's details, the send record) has it.
    saveMatch: (candidateId: string, match: TierMatch) => Promise<void>;
    saveMisses: (candidateId: string, misses: number) => Promise<void>;
  };
export const realSendCheckDeps: SendCheckDeps = {
  luma: async (url) => (await import("./eventDetails.js")).fetchLumaEventDetails(url, { maxAgeMs: RECHECK_FRESH_MS }),
  page: async (url) => (await import("./webOpportunitySearch.js")).readPageChecked(url),
  now: () => new Date(),
  writeFact: async (e) => (await import("./workingSet.js")).realExitDeps.writeFact(e),
  saveMatch: async (id, match) => {
    const pool = (await import("../db/db.js")).default;
    await pool.query(`UPDATE proactive_candidates SET payload = jsonb_set(payload, '{match}', $2::jsonb), updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [id, JSON.stringify(match)]);
  },
  saveMisses: async (id, misses) => {
    const pool = (await import("../db/db.js")).default;
    await pool.query(`UPDATE proactive_candidates SET payload = payload || jsonb_build_object('recheckMisses', $2::int), updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [id, misses]);
  },
};

export type SendCandidate = { id: string; userId: string; payload: any };
export type SendCheck = { ok: true; match: TierMatch } | { skip: string; exited: boolean } | { defer: Date; reason: string };

// Pure: the fact an exit writes, scoped to this find (and the ask it was for), never wider.
export function findExit(userId: string, match: TierMatch, askText: string | null | undefined, state: ExitState, reason: string) {
  return { userId, kind: "find" as const, itemKey: exitKey(match), label: String(match.name ?? ""), state, reason, scope: `this ${formOf(match as any) ?? "find"}${askText ? `, found for: ${String(askText).slice(0, 100)}` : ""}; nothing about what they like` };
}

// The hook. ok: c.payload.match is now the refreshed record (draft from it). skip with exited: it left the working set on its fact
// (the caller archives the row: dispatch's dropCandidate). defer: read again later. A fact that can't be written keeps the find live
// (workingSet.ts: the fact first), so that's a defer too.
export async function checkBeforeSend(c: SendCandidate, zone: string | null, deps: SendCheckDeps = realSendCheckDeps): Promise<SendCheck> {
  const p = c.payload ?? {};
  const match: TierMatch | undefined = p.match;
  if (!match) return { skip: "no find on the waiting text", exited: false };
  const now = deps.now();
  // Read moments ago (stillRelevant ran first this tick): no second read.
  const at = match.checkedAt ? Date.parse(match.checkedAt) : NaN;
  if (!Number.isNaN(at) && now.getTime() - at < RECHECK_FRESH_MS) return { ok: true, match };
  const r = await recheckFind(match, { now, zone, deps });
  if (r.ok) {
    p.match = r.match;
    if (r.verified) await deps.saveMatch(c.id, r.match).catch((err: any) => console.error("sendCheck: refreshed record not saved (non-fatal):", err?.message ?? err));
    return { ok: true, match: r.match };
  }
  const exitWith = async (state: ExitState, why: string): Promise<SendCheck> => {
    const ok = await writeExitFact(findExit(c.userId, match, p.askText, state, why), deps);
    return ok ? { skip: `re-read at send: ${why}`, exited: true } : { defer: new Date(now.getTime() + RECHECK_RETRY_HOURS * 3_600_000), reason: `re-read at send: ${why}; its exit fact couldn't be written, so it waits` };
  };
  if (r.exit) return exitWith(r.state ?? "expired", r.why);
  const misses = Number(p.recheckMisses ?? 0) + 1;
  if (misses >= RECHECK_MAX_MISSES) return exitWith("expired", `${r.why}, on ${misses} tries before it could send, so nothing about it could be checked`);
  p.recheckMisses = misses;
  await deps.saveMisses(c.id, misses).catch(() => {});
  return { defer: new Date(now.getTime() + RECHECK_RETRY_HOURS * 3_600_000), reason: `not sent unchecked: ${r.why} (try ${misses} of ${RECHECK_MAX_MISSES})` };
}

// ---------------------------------------------------------------- B2: a queue window that ran out

// Pure: why a waiting find's window ran out, as the fact's reason.
export function queueExpiryReason(p: { match: TierMatch; lastDay?: string | null }, zone: string | null): string {
  if (p.lastDay) return `its last useful day (${p.lastDay}) passed before it was sent`;
  const end = lifeEndOf(p.match, zone);
  if (end) return `its time (${end}) came before it was sent`;
  return `it has no date, and it wasn't sent within ${UNDATED_QUEUE_DAYS} days of being queued, so it doesn't wait unchecked`;
}
// The queue's own expiry (harness/proactive.ts, status 'expired') used to take a find out of the backlog with no fact. Now it exits.
export async function exitOnQueueExpiry(userId: string, p: { match: TierMatch; askText?: string | null; lastDay?: string | null }, zone: string | null, deps: ExitDeps): Promise<boolean> {
  if (!p?.match?.name) return false;
  return writeExitFact(findExit(userId, p.match, p.askText, "expired", queueExpiryReason(p, zone)), deps);
}

// ---------------------------------------------------------------- B4: a caption's prices and counts

const n = (s: string) => s.replace(/,/g, "").replace(/\.0+$/, "");
const SCARCITY = /\b(?:only a few|a few|limited|last few|handful of|few)\s+(?:spots?|seats?|tickets?|places?|slots)\b|\b(?:selling|filling)\s+(?:out|up|fast)\b|\balmost (?:full|sold out|gone)\b|\bspots? (?:are )?(?:going|limited)\b|\bbefore it sells out\b/i;
const SPOTS_ON_RECORD = /\bspots? (?:left|remaining)\b|\bsold out\b|\bcapacity\b|\bwait ?list\b|\blimited (?:spots?|seats?|capacity|space)\b|\bspots? (?:are )?limited\b/i;
// Pure (B4): every price and count a caption states is on the record it was drafted from (the page's details, the source post, their
// own ask), the way a task's texts already are (services/taskWeb.ts numbersBacked). Dates and clock times are left to the date checks.
export function captionNumbersBacked(caption: string, facts: string): { ok: boolean; problems: string[] } {
  const have = new Set((facts.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(n));
  const problems: string[] = [];
  const t = caption.replace(/[’‘]/g, "'");
  for (const m of t.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)|\b(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars|bucks)\b/gi)) {
    const v = n(m[1] ?? m[2]);
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
  return { ok: problems.length === 0, problems };
}

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
    d?.soldOut ? "sold out" : typeof d?.spotsRemaining === "number" ? `${d.spotsRemaining} spots left` : null,
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
    const bits = [d.startAt ? `starts ${d.startAt}` : null, d.soldOut ? "sold out" : typeof d.spotsRemaining === "number" ? `${d.spotsRemaining} spots left` : null, d.price ? `price ${d.price}` : null].filter(Boolean);
    return `Its event page, read just now: ${bits.join(", ") || "still listed"}.`;
  }
  const page = String(match.opportunity?.postText ?? ("evidence" in match ? match.evidence ?? "" : "")).replace(/\s+/g, " ").slice(0, 600);
  return page ? `Its page, read just now, opens: ${page}` : null;
}
