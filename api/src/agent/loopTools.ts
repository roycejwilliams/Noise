import { parseVerdict, workVerdict } from "../harness/scope.js";
// The tools of Co's own loop (agent/loop.ts). Co chooses and chains them; code
// guards only facts: a link was really found, a fact is on its page, an email
// address was really seen, the turn's budget, and nothing is sent to anyone
// but the member.
import { z } from "zod";
import { asHoldSend } from "../services/turnReplies.js";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import { writeMemory } from "../services/memory.js";
import { meaningWords } from "../services/profileExtraction.js";
import { recordDecision } from "../harness/core.js";
import { withRecordAs } from "./toolGuard.js";
import { recordRecommendationsSent } from "../services/recommendation.js";
import { eventCandidates, type TierMatch } from "../services/tieredRecommendation.js";
import { loadBrief, saveBrief, type SearchIntent } from "../services/searchIntent.js";
import { numbersBacked, placesBacked, unbackedClaims } from "../services/taskWeb.js";
import { captionNumbersBacked } from "../services/sendCheck.js";
import { LOOP_BUDGET } from "./loop.js";
import { START_LEAD_MINUTES, matchStartProblem } from "../harness/matchGate.js";
import { replySearchPlace, webSearchCity } from "../services/askPlace.js";
import { identityDropped } from "../services/guardDrops.js";
import { stripUngroundedIdentity } from "../services/identityGuard.js";
import type { ConversationToolContext } from "./conversationTools.js";
import pool from "../db/db.js";

// What the loop has seen this turn: every link a tool returned, with the facts
// that came with it, and every page it read.
// stored: carried in from an earlier turn (seedFound), checked at checkedAt and good until freshUntil; past that its facts back
// nothing until its page is read again.
// viaPost: a link an X post pointed to (checked for a private event page again before it's shared, batched review of #299).
export type Found = { name: string; url: string; facts: string; match: TierMatch | null; blocked: string | null; stored?: boolean; checkedAt?: string | null; freshUntil?: number | null; viaPost?: boolean };
// The line they get while a search runs (Royce, 2026-10-17: "Let me look" is bland). It's Cue's own words, saying what it's looking for
// in their terms, never a status message. Never praise or a recap either (2026-11-06 live test: "founder dinners before an investor
// meeting, good instinct").
export const WHILE_LOOKING = "Only on your first search, if it'll take a moment: a few plain words naming the thing itself, in the terms of what they asked (\"founder dinners in SF this week\"), with no verb or status phrasing in front (no \"looking at\", \"searching for\"). Only that: no compliment or praise of the ask, no recap of what they told you, no word about tools, searches or how it works. Never a generic status line (\"let me look\", \"checking\", \"one sec\", \"on it\"), and never one you've sent them before.";
// Tests only (golden cases): a fixed set of real events a stubbed search returns, the way a live one would.
export type StubEvent = { name: string; url: string; tier?: 1 | 2; lines: string[] };
export type LoopState = { started: number; found: Map<string, Found>; pages: Map<string, string>; holdSent: boolean; shared: string[]; webQueries: number; eventSearches?: number; holdAsked?: boolean };
// A stock holding line (Royce, 2026-10-17: "Let me look" is bland; golden 55 still said "Let me see what's good this week").
// Openers only, after an optional "ok,", "sure,", "got it,"; Royce 2026-10-17 asked for the wider list, and what it doesn't cover is in
// evals/reply/usesItsFinds.ts.
// A stock opener that names something of theirs ("Looking at founder dinners in SF for Saturday") reacts to what they asked: only one
// that names nothing from their words is stock (review of the finds batch, 2026-10-17: the wider list caught lines like that).
const STOCK_WORDS = ["let", "lemme", "look", "looking", "see", "check", "checking", "dig", "digging", "find", "pull", "pulling", "search", "searching", "hunt", "hunting", "scout", "poke", "around", "take", "have", "into", "sec", "second", "moment", "minute", "min", "hang", "hold", "tight", "bear", "back", "right", "sure", "okay", "ok", "got", "alright", "yes", "yep", "working", "gonna", "just", "give", "gimme", "now", "one", "good", "what", "for", "you", "your", "something", "some", "anything", "thing", "things", "options", "go", "going", "out", "there", "happen", "happening", "on"];
export function stockLine(line: string, theirWords: string): boolean {
  if (!STOCK_HOLD.test(line)) return false;
  const said = meaningWords(theirWords, STOCK_WORDS);
  return ![...meaningWords(line, STOCK_WORDS)].some((w) => said.has(w));
}
export const STOCK_HOLD = /^\s*(?:(?:ok|okay|sure|got it|alright|all right|yep|yes|right)[\s,.!:-]+)?(?:(?:let me|lemme|i'?ll|gonna) (?:look|see|check|dig|find|pull|search|hunt|scout|poke around|have a look|take a look|look around|look into|check around)|let'?s see|let'?s (?:look|check|find out)|looking(?! forward)|checking|searching|digging|hunting|on it|working on it|one (?:sec|second|moment|min|minute)|(?:give|gimme) (?:me )?a (?:sec|second|minute|moment|min)|hang (?:on|tight)|hold on|bear with me|just a (?:sec|second|moment|minute|min)|be right back|brb|back in a (?:sec|second|moment|minute|bit))\b/i;

// ---------- yesterday's finds, carried into today's turn (B5, 2026-10-08)
// What Co found for them on earlier turns (web results kept at research time, a brief's options, events it sent, its shortlist),
// each with when it was checked. A plan, a document or a caption may cite one only while it's fresh; past its window it's re-read
// first (readPage). Every read is this member's own (user_id), never anyone else's.
export type StoredFind = { name: string; url: string; facts: string; checkedAt: string | null; freshUntil: number | null };
export const WEB_FIND_FRESH_HOURS = 24;
export const SENT_EVENT_DAYS = 3;

// Pure: a carried-in find past its window (or never dated): its facts back nothing until it's read again.
export function staleFind(f: Found, now = Date.now()): boolean {
  return !!f.stored && (f.freshUntil === null || f.freshUntil === undefined || now > f.freshUntil);
}
// Pure: the facts a find may back something with right now.
export const usableFacts = (f: Found, now = Date.now()): string => (staleFind(f, now) ? "" : f.facts);
// Pure: seed the turn with what's on file; anything this turn already found wins.
export function seedFound(loop: LoopState, rows: StoredFind[]): number {
  let n = 0;
  for (const r of rows) {
    if (!r.url || loop.found.has(r.url)) continue;
    loop.found.set(r.url, { name: r.name, url: r.url, facts: r.facts, match: null, blocked: null, stored: true, checkedAt: r.checkedAt, freshUntil: r.freshUntil });
    n++;
  }
  return n;
}
// Pure: a carried-in find, read again just now (its page or its event record): fresh from now.
export function refreshFound(f: Found, facts: string, now = Date.now(), freshHours = WEB_FIND_FRESH_HOURS): void {
  f.facts = facts;
  f.checkedAt = new Date(now).toISOString();
  f.freshUntil = now + freshHours * 3_600_000;
}
// What's on file for this member, as carried-in finds. Every query is scoped to their user_id.
export async function storedFinds(userId: string, now = Date.now()): Promise<StoredFind[]> {
  const out: StoredFind[] = [];
  const hours = (h: number) => h * 3_600_000;
  const { recentResearchFinds } = await import("../services/researchFinds.js");
  for (const f of await recentResearchFinds(userId).catch(() => [])) {
    const t = new Date(f.at).getTime();
    out.push({ name: f.name, url: f.url, facts: f.facts, checkedAt: f.at || null, freshUntil: Number.isNaN(t) ? null : t + hours(WEB_FIND_FRESH_HOURS) });
  }
  // A brief's options: each field good for its own window (availability a day, prices two weeks).
  const Q = await import("../services/researchQuality.js");
  const keyHours = new Map<string, number>(Q.FIND_SCHEMAS.venue.map((s) => [s.key, Q.FRESHNESS_HOURS[s.freshKey]]));
  for (const f of await Q.recentShownFinds(userId).catch(() => [])) {
    const ends = f.fields.map((x) => new Date(x.checkedAt).getTime() + hours(keyHours.get(x.key) ?? WEB_FIND_FRESH_HOURS)).filter((x) => !Number.isNaN(x));
    const checked = f.fields.map((x) => x.checkedAt).filter(Boolean).sort()[0] ?? null;
    out.push({ name: f.name, url: f.url, facts: f.fields.filter((x) => x.value).map((x) => `${x.label}: ${x.value}`).join("; "), checkedAt: checked, freshUntil: ends.length ? Math.min(...ends) : null });
  }
  // Events Co sent them in the last few days (its own record of sends, services/coFacts.ts).
  const { rows } = await pool
    .query(`SELECT object_label, url, happened_at, meta->>'when' AS "when" FROM co_facts WHERE owner_user_id = $1 AND subject = 'co' AND relation = 'sent' AND url IS NOT NULL AND NOT (meta ? 'ledger') AND happened_at > NOW() - make_interval(days => $2) ORDER BY happened_at DESC LIMIT 20`, [userId, SENT_EVENT_DAYS])
    .catch(() => ({ rows: [] as any[] }));
  for (const r of rows) {
    const t = new Date(r.happened_at).getTime();
    out.push({ name: String(r.object_label), url: String(r.url), facts: [String(r.object_label), r.when ? `on ${r.when}` : ""].filter(Boolean).join(" "), checkedAt: Number.isNaN(t) ? null : new Date(t).toISOString(), freshUntil: Number.isNaN(t) ? null : t + hours(WEB_FIND_FRESH_HOURS) });
  }
  // The shortlist in their notes: never dated, so it's re-read before anything cites it.
  const notes = await loadBrief(userId).catch(() => null);
  for (const s of notes?.shortlist ?? []) if (s.url) out.push({ name: s.name, url: s.url, facts: s.note ?? "", checkedAt: null, freshUntil: null });
  void now;
  return out;
}

// started: when their text arrived, so the time budget counts the turn's prep
// too (2026-10-01 code review); now when not known.
export function newLoopState(started = Date.now()): LoopState {
  return { started, found: new Map(), pages: new Map(), holdSent: false, shared: [], webQueries: 0, eventSearches: 0, holdAsked: false };
}

// What a document tool tells Co once its attachment went with its one line (Royce, 2026-10-08: no second bubble repeating it).
export const DELIVERED_NOTE = "Delivered with its line; send nothing more about it unless you have a question for them.";
const HOLD_PREFIX = "Co is looking:"; // the same record line routes/sendblue.ts writes for a hold text
const emailsIn = (text: string) => [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))];

// A caption may only carry numbers, places and claims its own facts back.
// What the member did ("you already looked at their residency") comes from
// their own words, never from Co having sent it (2026-10-01: Co sent it, asked
// if they'd looked, and later told them they had).
const THEY_DID = /\byou(?:'ve| have)?\s+(?:already\s+)?(looked (?:at|into)|checked (?:out|it)|applied|signed up|registered|went|been to|visited|seen|read)\b/i;
export function theyDidUnbacked(caption: string, theirs: string): string | null {
  const m = caption.match(THEY_DID);
  if (!m) return null;
  const root = m[1].split(" ")[0].replace(/ed$|en$/, "").replace(/^went$/, "go");
  return new RegExp(`\\bI(?:'ve| have)?\\s+(?:already\\s+)?\\w*\\s*${root}`, "i").test(theirs) ? null : m[0];
}
export function captionProblems(caption: string, facts: string, theirs: string): string[] {
  const did = theyDidUnbacked(caption, theirs);
  return [
    ...numbersBacked(caption, `${facts} ${theirs}`).missing.map((n) => `"${n}" isn't in its facts`),
    ...placesBacked(caption, `${facts} ${theirs}`).missing.map((p) => `"${p}" isn't in its facts`),
    ...unbackedClaims(caption, facts).map((c) => `"${c}" isn't something its page says`),
    // "Only a few spots left", "free", "sold out" with no number to check (Phase B, B4): on its page, or not said.
    ...captionNumbersBacked(caption, `${facts} ${theirs}`).problems.filter((p) => !/^(?:price|count) /.test(p)),
    ...(did ? [`"${did}" isn't something they told you they did`] : []),
  ];
}


// A search-area read that failed (searchHome): the search doesn't run.
const AREA_UNREAD = Symbol("area unread");

export function loopTools(
  ctx: ConversationToolContext,
  state: { sent: boolean; sentMessages: string[]; linkDelivered?: boolean; holdLines?: string[] },
  loop: LoopState,
  notDone: (what: string) => void,
) {
  const outOfTime = () => (Date.now() - loop.started) / 1000 > LOOP_BUDGET.seconds;
  const OUT_OF_TIME = { ok: false, error: "Out of time for this turn: share what you have and answer them; say what you'd check next." };
  const say = async (text: string, record: string) => {
    if (ctx.dryRun) {
      console.log(`[conversationReply dryRun] would send to ${ctx.userId}: ${text.slice(0, 160)}`);
      state.sentMessages.push(text);
      return true;
    }
    const ok = await ctx.sendCoReply({ phone: ctx.phoneNumber, message: text, asVoice: false });
    if (ok === false) return false;
    // Delivered is delivered: the log write failing doesn't unsend it (2026-10-01 code review).
    state.sentMessages.push(text);
    await writeMemory(ctx.userId, "text_exchange", record).catch((err: any) => console.error("loopTools: logging a sent text failed (it did send):", err?.message ?? err));
    return true;
  };
  // A stock opener is asked for once more (stockHold below); one that's still stock is never sent: the search goes on without it.
  const stockHold = (line?: string) => {
    // On a call the line is never sent (services/callTools.ts), so asking again only spends one of the call's few rounds.
    if (ctx.onCall || !line?.trim() || loop.holdSent || state.sent || !stockLine(line, theirWords()) || loop.holdAsked) return null;
    loop.holdAsked = true;
    return { ok: false, error: `Not searched yet: "${line.trim().slice(0, 80)}" is a stock line. Call this again with a whileLooking that names the thing itself in the terms of what they asked (\"founder dinners in SF this week\"), with no verb in front, or leave whileLooking out.` };
  };
  const hold = async (line?: string) => {
    if (!line?.trim() || loop.holdSent || state.sent || stockLine(line, theirWords())) return;
    loop.holdSent = true;
    // Sent as a hold, so a turn that dies after it is still owed an answer (services/turnReplies.ts asHoldSend, review of #301).
    if (await asHoldSend(() => say(line.trim(), `${HOLD_PREFIX} ${line.trim()}`))) {
      ctx.facts?.add("did_this_turn", `Told them "${line.trim()}" while looking.`);
      // A holding line answers nothing (agent/conversationTools.ts sendReply never counts it as the reply).
      state.holdLines?.push(line.trim());
    }
  };
  // Code saves the basics whenever a search runs, so the next text picks up
  // even if Co never updates its notes (Royce, 2026-10-01).
  const remember = async (patch: Partial<SearchIntent>) => {
    if (ctx.dryRun) return;
    const prev = (await loadBrief(ctx.userId).catch(() => null)) ?? ({ kind: "event", what: "", city: null, area: null, when: null, budget: null, headcount: null, vibe: null, summary: "", queries: [], sites: [], ask: null } as SearchIntent);
    const tried = [...new Set([...(prev.tried ?? []), ...(patch.tried ?? [])])].slice(-12);
    await saveBrief(ctx.userId, { ...prev, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null && v !== "")), tried } as SearchIntent);
  };
  // The log of a text that already went out; its failure never makes a delivered text look unsent.
  const logDeliveredPlan = (content: string) => writeMemory(ctx.userId, "text_exchange", content).catch((err: any) => console.error("loopTools: logging a sent plan failed (it did send):", err?.message ?? err));
  const theirWords = () => `${ctx.resolvedContent} ${ctx.turn?.message ?? ""}`;
  // Probes and dry runs never spend on searches (ctx.stubSearch).
  const STUB = { ok: true, note: "Test run: nothing was searched. Say you looked and nothing solid came up yet." };
  // What they ruled out and when they're free, from the record's one reader (services/memberKnowledge.ts limits), read once a turn
  // (Phase A2: "I'll stop suggesting it in every search and sweep" held for no live search). A kind they name in this text is theirs
  // again for this turn. A dry run reads nothing.
  let limitsRead: Promise<import("../services/memberLimits.js").Limits | null> | null = null;
  const limits = () => (limitsRead ??= ctx.dryRun ? Promise.resolve(null) : import("../services/memberKnowledge.js").then((M) => M.realKnowledgeDeps.limits(ctx.userId)).catch(() => null));
  // The words an ask is judged on: a text's message (with the text it replies to), or on a call their last three lines (an ask is often
  // built over a few turns: "I'd love a hackathon again", "which weekend?", "the 20th"), never the whole call (review of #139).
  const askWords = () => (ctx.isVoice ? String(ctx.turn?.message ?? "").split("\n").filter((l) => l.trim()).slice(-3).join("\n") || ctx.resolvedContent : theirWords());
  // What stands in for "their home" in a search with no place of its own (services/askPlace.ts): where they asked Cue to search from
  // now on (services/searchArea.ts, its resolved place), else their home city. Read once a turn; a dry run reads nothing. A read that
  // fails is never quietly their home city (review of #336): the search doesn't run, it's logged, and Cue says so (areaUnread).
  let areaRead: Promise<{ ok: true; area: string | null } | { ok: false }> | null = null;
  const searchHome = async (): Promise<string | null | typeof AREA_UNREAD> => {
    const r = await (areaRead ??= ctx.dryRun
      ? Promise.resolve({ ok: true as const, area: null })
      : import("../services/searchArea.js")
          .then((A) => A.searchAreaOf(ctx.userId))
          .then((a) => ({ ok: true as const, area: a ? (a.label ?? a.place) : null }))
          .catch((err: any) => {
            console.error("loopTools: reading their search area failed (that search doesn't run):", err?.message ?? err);
            void recordDecision({ layer: 3, decision: "search.area_unread", userId: ctx.userId, outcome: "skip", action: "not_searched", reason: String(err?.message ?? err).slice(0, 200) }).catch(() => {});
            return { ok: false as const };
          }));
    return r.ok ? (r.area ?? ctx.turn?.profile?.city ?? null) : AREA_UNREAD;
  };
  const areaUnread = () => {
    notDone("Nothing was searched: where they asked Cue to search couldn't be read just now.");
    return { ok: false, error: "Nothing was searched: where they asked you to search couldn't be read just now. Say plainly the search didn't run and offer to try again in a moment." };
  };
  const ruledOut = async (query: string): Promise<string | null> => {
    const l = await limits();
    if (!l?.avoid.length) return null;
    const { avoidFor, avoidHits } = await import("../services/memberLimits.js");
    const hit = avoidHits(query, avoidFor(l.avoid, askWords()))[0];
    return hit ? `Not searched: they told Cue to stop suggesting ${hit}. Look for something else they want. If they're asking for it now, it lifts for this once when their own words ask for it; only use steerAwayFrom with undo if they say they're open to it again in general.` : null;
  };
  // A receipt for every search, empty or not, so "I looked and nothing turned
  // up" is backed (2026-10-01: with no record, the fact check cut it).
  const receipt = (what: string) => ctx.facts?.add("did_this_turn", what);
  // Yesterday's finds, carried into this turn (storedFinds): read once, the first time a tool that cites a find runs (a turn that
  // never needs them never reads them). Never in tests.
  let seeding: Promise<unknown> | null = null;
  const seeded = (): Promise<unknown> => (seeding ??= ctx.dryRun || ctx.stubSearch ? Promise.resolve() : storedFinds(ctx.userId).then((rows) => seedFound(loop, rows)).catch(() => 0));
  // What anythingForMe sent is the turn's whole answer: no leftover text or fallback line after it (conversationTools.ts sendReply).
  ctx.onLinkDelivered = () => {
    if (ctx.dryRun) return;
    state.sent = true;
    state.linkDelivered = true;
  };

  return {
    searchEvents: tool({
      description: toolUse("searchEvents"),
      inputSchema: z.object({
        what: z.string().describe("What kind of event, in a few words."),
        when: z.string().optional().describe("The time in their own words: \"this weekend\", \"Friday night\", \"Oct 10\"."),
        city: z.string().optional().describe("The city, when they named one; their own city otherwise."),
        whileLooking: z.string().optional().describe(WHILE_LOOKING),
      }),
      execute: async ({ what, when, city, whileLooking }) => {
        const stock = stockHold(whileLooking);
        if (stock) return stock;
        const avoided = await ruledOut(what);
        if (avoided) return { ok: false, error: avoided };
        if (ctx.stubSearch && ctx.stubEvents?.length) {
          await hold(whileLooking);
          const events = ctx.stubEvents.map((e) => {
            const match = { tier: e.tier ?? 2, kind: e.tier === 1 ? "co_event" : "public_event", name: e.name, url: e.url, reason: "" } as unknown as TierMatch;
            loop.found.set(e.url, { name: e.name, url: e.url, facts: e.lines.join(" "), match, blocked: null });
            ctx.facts?.add("known", `Found just now: "${e.name}", link ${e.url}. ${e.lines.join(" ")}`);
            return { name: e.name, link: e.url, ownEvent: e.tier === 1, details: e.lines };
          });
          receipt(`Looked up events for "${what}"${when ? `, ${when}` : ""} just now: ${events.length} came back.`);
          return { ok: true, events, turnedAway: [], openingsFoundEarlier: [], note: `${events.length} events in the feed nearby; the closest to what you asked are above.` };
        }
        if (ctx.stubSearch) {
          receipt(`Looked up events for "${what}"${when ? `, ${when}` : ""} just now: nothing came back.`);
          return { ...STUB, events: [] };
        }
        if (outOfTime()) return OUT_OF_TIME;
        // LOOP_BUDGET.eventSearches a turn, like webSearches: each one can be an Exa search now (services/lumaViaExa.ts).
        const eventsHome = await searchHome();
        if (eventsHome === AREA_UNREAD) return areaUnread();
        if ((loop.eventSearches ?? 0) >= LOOP_BUDGET.eventSearches) return { ok: false, error: `No event searches left this turn (${LOOP_BUDGET.eventSearches} used): work with the events you already have, or try webSearch.` };
        loop.eventSearches = (loop.eventSearches ?? 0) + 1;
        await hold(whileLooking);
        // Where it looks (services/askPlace.ts): the city passed, unless it's just their home city and "what" names another place
        // ("in/near/around X", or SF/NYC-style short names; "visiting Lisbon" or lowercase isn't seen); else that named place; else their
        // home city.
        const where = replySearchPlace({ kind: "events", words: what, toolCity: city, message: askWords(), home: eventsHome });
        const [r, earlier] = await Promise.all([
          // No Exa search on a call (ctx.isVoice: services/callTools.ts): a voice turn can't wait up to 10s for Exa plus the page reads.
          eventCandidates(what, where.place, { when: when ?? null, userId: ctx.userId, limit: 8, viaExa: !ctx.isVoice, source: "request" }),
          // Openings Co's daily search already found and checked for them (the
          // old reply search offered these too): programs, grants, open calls.
          import("../services/eventSurfacingSweep.js").then((m) => m.alreadyFoundOpenings(ctx.userId)).catch(() => [] as TierMatch[]),
        ]);
        await remember({ what, when: when ?? undefined, city: city ?? undefined, tried: [`events: ${what}${when ? `, ${when}` : ""}`] });
        if (r.outOfRange) return { ok: true, events: [], note: `Nothing searched: ${r.outOfRange}. Say so.` };
        const events = r.candidates.map(({ match, lines }) => {
          const url = "url" in match ? (match.url ?? "") : "";
          // Sold out on its own page: a fact, so it can't be shared (it's still listed for Co to mention).
          const soldOut = (match as any).details?.soldOut === true ? "sold out" : null;
          if (url) loop.found.set(url, { name: match.name, url, facts: lines.join(" "), match, blocked: soldOut });
          return { name: match.name, link: url || null, ownEvent: match.tier === 1, details: lines };
        });
        for (const g of r.turnedAway) if (g.url) loop.found.set(g.url, { name: g.name, url: g.url, facts: "", match: null, blocked: g.reasons.join(", ") });
        for (const e of events) ctx.facts?.add("known", `Found just now: "${e.name}"${e.link ? `, link ${e.link}` : ""}. ${e.details.join(" ")}`);
        receipt(`Looked up events for "${what}"${when ? `, ${when}` : ""} just now: ${events.length} came back${r.turnedAway.length ? `, ${r.turnedAway.length} turned away (${r.turnedAway.map((g) => `${g.name}: ${g.reasons.join(", ")}`).join("; ").slice(0, 200)})` : ""}.`);
        const openings = earlier.filter((m) => "url" in m && m.url).slice(0, 4).map((m) => {
          const facts = `${m.reason} ${(m as any).evidence ?? ""}`.trim().slice(0, 600);
          loop.found.set((m as any).url, { name: m.name, url: (m as any).url, facts, match: m, blocked: null });
          ctx.facts?.add("known", `Found earlier by Cue's daily search: "${m.name}", link ${(m as any).url}. ${facts}`);
          return { name: m.name, link: (m as any).url, details: facts };
        });
        return {
          ok: true,
          window: r.window,
          events,
          turnedAway: r.turnedAway.map((g) => `${g.name}: ${g.reasons.join(", ")}`),
          openingsFoundEarlier: openings,
          // "On Luma" once a search of Luma's pages added any (services/lumaViaExa.ts): the count is no longer the feed's alone.
          note: `${r.inWindow} events ${r.viaExa?.nearby ? "on Luma" : "in the feed"} for ${r.window ?? "the next two weeks"} nearby; the ${events.length} closest to what you asked are above.${r.inWindow < 4 ? ` ${r.viaExa?.nearby ? "Luma" : "The feed"} is thin here: try webSearch for the same thing.` : ""}`,
        };
      },
    }),

    webSearch: tool({
      description: toolUse("webSearch"),
      inputSchema: z.object({
        queries: z.array(z.string()).min(1).max(3).describe("1 to 3 short searches, 3 to 7 words each, each a different angle; they run at the same time."),
        sites: z.array(z.string()).optional().describe("Sites where this kind of thing is listed, e.g. peerspace.com, thebash.com, lu.ma."),
        whileLooking: z.string().optional().describe(WHILE_LOOKING),
        theirs: z
          .object({ what: z.string().optional(), city: z.string().optional(), area: z.string().optional(), when: z.string().optional(), headcount: z.number().optional(), budget: z.number().optional(), hours: z.number().optional() })
          .optional()
          .describe("What they've asked for so far (what, place, date, headcount, budget in dollars, hours): saved to your working notes, so the next text picks up from here."),
      }),
      execute: async ({ queries, sites, whileLooking, theirs }) => {
        const stock = stockHold(whileLooking);
        if (stock) return stock;
        // Their constraints go into the notes with the search (2026-10-01 next-live run:
        // turn one's 120 people, $3k and 4 hours were lost in 2 of 4 runs when no updateNotes followed).
        for (const q of queries) {
          const avoided = await ruledOut(q);
          if (avoided) return { ok: false, error: `"${q}": ${avoided}` };
        }
        const saved = Object.fromEntries(Object.entries(theirs ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));
        if (Object.keys(saved).length && !ctx.stubSearch) await remember(saved as Partial<SearchIntent>);
        if (ctx.stubSearch) {
          receipt(`Searched the web just now (${queries.map((q) => `"${q}"`).join(", ")}): nothing held up on its own page.`);
          return { ...STUB, results: [] };
        }
        if (outOfTime()) return OUT_OF_TIME;
        const home = await searchHome();
        if (home === AREA_UNREAD) return areaUnread();
        const left = LOOP_BUDGET.webSearches - loop.webQueries;
        if (left <= 0) return { ok: false, error: "No web searches left this turn: work with what you have, or read a page you already found." };
        const run = [...new Set(queries.map((q) => q.trim().slice(0, 90)).filter(Boolean))].slice(0, left);
        loop.webQueries += run.length;
        await hold(whileLooking);
        const { taskWebSearch } = await import("../services/taskWeb.js");
        // Where each search looks (services/askPlace.ts): a query that names a place ("in/near/around X", or SF/NYC-style short names;
        // "visiting Lisbon" or lowercase isn't seen) gets nothing added on top; else theirs.city; else their home city, unless the query
        // says it's for no place (online, remote).
        const cityFor = (q: string) => webSearchCity(replySearchPlace({ kind: "web", words: q, toolCity: theirs?.city ?? null, message: askWords(), home }));
        const siteList = (sites ?? []).filter((s) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)).slice(0, 4);
        const all = await Promise.all(run.map((q) => taskWebSearch(ctx.userId, q, { city: cityFor(q), sites: siteList, source: "request", log: !ctx.dryRun }).catch(() => ({ kept: [], dropped: [], droppedDetails: [], note: "Web search failed: error." }))));
        // The shared daily web search budget is spent: say so plainly rather than
        // "nothing yet" (2026-10-01: a day of testing used all 60, and Co gave up vaguely).
        if (all.every((x) => /^No web search right now/.test(x.note))) {
          notDone("Web search wasn't available: today's shared web search budget is used up.");
          return { ok: false, error: "No more web searches today. Lead with what you already found or searchEvents; if they still need more, save it (saveAsk) and say when they'll hear back, without naming a limit." };
        }
        // A search that failed (Exa down or timed out, the picker threw) or that the budget blocked never ran, so it says nothing about
        // what's out there: never in the "nothing held up" receipt, which backs "I looked and nothing turned up" (review of #225).
        const failedNote = (n: string) => /^Web search failed/.test(n);
        const notRun = (n: string) => failedNote(n) || /^No web search right now/.test(n);
        const failed = all.filter((x) => notRun(x.note));
        if (failed.length === all.length) {
          notDone(`The web search didn't run just now (${run.map((q) => `"${q}"`).join(", ")}): nothing was searched, so nothing is known about what's out there.`);
          return { ok: false, error: "The web search failed just now: it never ran, so it says nothing about what exists. Try it once more, or tell them you couldn't search right now and offer to look again. Never say nothing turned up." };
        }
        await remember({ tried: run.filter((_, i) => !notRun(all[i].note)).map((q) => `web: ${q}`) });
        const seenUrls = new Set<string>();
        // Jev reads each fact against its passage (services/factCheck.ts); a "no" is dropped.
        const { checkVerified } = await import("../services/factCheck.js");
        const read = await checkVerified(all.flatMap((x) => x.kept).filter((k) => !seenUrls.has(k.url) && seenUrls.add(k.url)), { where: "reply.web_search", userId: ctx.dryRun ? null : ctx.userId }).catch(() => ({ kept: all.flatMap((x) => x.kept), droppedFacts: [] as string[] }));
        // Budget and headcount from the notes, and the total for their night, worked out in code.
        const notes = await loadBrief(ctx.userId).catch(() => null);
        const { fitsConstraints, priceEstimate } = await import("../services/searchIntent.js");
        // A name alone isn't something to send (2026-09-30: "DJ Busy B" with nothing about it).
        const empty = read.kept.filter((k) => !k.facts.length);
        // Listings on sites that block reading can't be checked, so they never come back as finds.
        const { cantCheck } = await import("../services/taskWeb.js");
        const blocked = siteList.filter(cantCheck);
        const withNotes = read.kept.filter((k) => k.facts.length).map((k) => {
          const fit = notes ? fitsConstraints(k.facts, { budget: notes.budget ?? null, headcount: notes.headcount ?? null, hours: notes.hours ?? null }) : { ok: true, why: null };
          const estimate = priceEstimate(k.facts, notes?.hours ?? null);
          return { ...k, facts: [...k.facts, ...(estimate ? [estimate] : []), ...(fit.tight ? [fit.tight] : []), ...(!fit.ok && fit.why ? [`note: ${fit.why}`] : [])] };
        });
        const r = {
          kept: withNotes,
          dropped: [
            ...all.flatMap((x) => x.dropped),
            ...read.droppedFacts.map((d) => ({ name: d, url: "", why: "the second reader said its page doesn't say that" })),
            ...empty.map((k) => ({ name: k.name, url: k.url, why: "nothing about it on its page" })),
            ...(blocked.length ? [{ name: `${blocked.join(", ")} listings`, url: "", why: "those sites block reading, so their listings can't be checked; look for places' own pages" }] : []),
          ],
          note: `${all.map((x) => x.note).find((n) => /checked/.test(n)) ?? all.find((x) => !notRun(x.note))?.note ?? ""}${failed.length ? ` ${failed.length} of ${all.length} searches didn't run (failed, or no web search was available): that's not the same as nothing there.` : ""}`.trim() };
        // A search that didn't run among ones that did is named as not run, never counted in what came up empty.
        const ranOk = run.filter((_, i) => !notRun(all[i].note));
        const ranFailed = run.filter((_, i) => failedNote(all[i].note));
        const ranBlocked = run.filter((_, i) => !failedNote(all[i].note) && notRun(all[i].note));
        receipt(`Searched the web just now (${ranOk.map((q) => `"${q}"`).join(", ")}): ${r.kept.length} held up on their own pages${r.dropped.length ? `, ${r.dropped.length} didn't` : ""}.${ranFailed.length ? ` The search for ${ranFailed.map((q) => `"${q}"`).join(", ")} failed and never ran.` : ""}${ranBlocked.length ? ` The search for ${ranBlocked.map((q) => `"${q}"`).join(", ")} never ran: no web search was available.` : ""}`);
        for (const k of r.kept) {
          const facts = [...k.facts, ...(k.date ? [`date: ${k.date}`] : [])].join("; ");
          const match = { tier: 3, kind: "opportunity", source: "web", name: k.name, url: k.url, reason: facts || k.name, evidence: `${k.name}. ${facts}`, ...(k.date ? { statedDates: { start: k.date } } : {}) } as unknown as TierMatch;
          loop.found.set(k.url, { name: k.name, url: k.url, facts, match, blocked: null });
          ctx.facts?.add("known", `Found just now on the web: "${k.name}", link ${k.url}. ${facts}`);
        }
        // On file at research time, not only for this turn: the next turn's "send
        // it" needs the link (services/researchFinds.ts; 2026-10-03, Pitch Protocol).
        if (!ctx.dryRun && r.kept.length) {
          const { recordResearchFinds } = await import("../services/researchFinds.js");
          await recordResearchFinds(ctx.userId, r.kept.map((k) => ({ name: k.name, url: k.url, facts: k.facts.slice(0, 4).join("; ") }))).catch(() => 0);
        }
        return {
          ok: true,
          results: r.kept.map((k) => ({ name: k.name, link: k.url, facts: k.facts, date: k.date, ownSite: k.official })),
          dropped: r.dropped.map((d) => `${d.name}: ${d.why}`),
          note: r.note,
        };
      },
    }),

    searchPosts: tool({
      description: toolUse("searchPosts"),
      inputSchema: z.object({
        query: z.string().describe("2 to 4 distinctive keywords, OR for real synonyms; no city, no year they didn't say."),
        whileLooking: z.string().optional().describe(WHILE_LOOKING),
      }),
      execute: async ({ query, whileLooking }) => {
        const stock = stockHold(whileLooking);
        if (stock) return stock;
        const avoided = await ruledOut(query);
        if (avoided) return { ok: false, error: avoided };
        if (ctx.stubSearch) return { ...STUB, posts: [] };
        if (outOfTime()) return OUT_OF_TIME;
        const q = query.trim().slice(0, 200);
        // The same daily X budget as the sweep, from the share kept for live asks.
        const { reserveXSearch } = await import("../services/tieredRecommendation.js");
        const budget = await reserveXSearch(ctx.userId, "request", q);
        if (!budget.ok) return { ok: false, error: `X search isn't available right now (${budget.reason ?? "daily budget"}); use webSearch instead.` };
        await hold(whileLooking);
        const { searchRecentPosts, X_SEARCH_RESULTS } = await import("../services/xSearch.js");
        const posts = await searchRecentPosts(q, X_SEARCH_RESULTS).catch(() => null);
        await remember({ tried: [`x: ${q}`] });
        if (!posts) return { ok: false, error: "X search failed this time; use webSearch instead." };
        // A post's link to a private event page (a Partiful invite, a private Luma event, by its own record) is never a find, never shown
        // to the model as one (batched review of #299; the sweep drops it the same way, sweepFind.ts promoteEventPages).
        // Fail closed (final review of #299): a Luma or Partiful link not confirmed public, or not read in time, is dropped too.
        const { unshareableEventLinks, mayBePrivateEvent } = await import("../services/eventPage.js");
        const allLinks = posts.flatMap((p) => p.links);
        const privateLinks = await unshareableEventLinks(allLinks).catch(() => new Set(allLinks.filter(mayBePrivateEvent)));
        for (const p of posts) p.links = p.links.filter((l) => !privateLinks.has(l));
        for (const p of posts) {
          const match = { tier: 3, kind: "opportunity", source: "x", name: p.text.slice(0, 80), url: p.url, reason: p.text, evidence: p.text } as unknown as TierMatch;
          loop.found.set(p.url, { name: p.text.slice(0, 80), url: p.url, facts: p.text, match, blocked: null });
          // What the post links to (expanded from t.co), with the post as what's known about it, as readPage does for a page.
          for (const l of p.links) if (!loop.found.has(l)) loop.found.set(l, { name: p.text.slice(0, 80), url: l, facts: p.text, match: null, blocked: null, viaPost: true });
        }
        return { ok: true, posts: posts.map((p) => ({ link: p.url, by: p.author ? `@${p.author}` : undefined, text: p.text.slice(0, 600), links: p.links.length ? p.links : undefined })), note: posts.length ? "Posts from the last week, as written. Judge them yourself; share only one whose own text backs what you'd say." : "No recent posts for that. Try other keywords or webSearch." };
      },
    }),

    readPage: tool({
      description: toolUse("readPage"),
      inputSchema: z.object({ url: z.string().describe("The page to read.") }),
      execute: async ({ url }) => {
        if (ctx.stubSearch) return { ok: false, error: "Test run: pages aren't read. Don't describe it." };
        if (outOfTime()) return OUT_OF_TIME;
        const { readPageText } = await import("../services/webOpportunitySearch.js");
        const text = await readPageText(url).catch(() => null);
        if (!text) {
          notDone(`Couldn't read ${url}.`);
          return { ok: false, error: "That page couldn't be read. Don't describe it from memory; try another page or say you couldn't check it." };
        }
        loop.pages.set(url, text);
        await seeded();
        const known = loop.found.get(url);
        // A find carried in from an earlier turn is read again: what its page says now replaces what it said then.
        if (known?.stored) refreshFound(known, text.slice(0, 4000));
        else if (known) known.facts = `${known.facts} ${text.slice(0, 4000)}`;
        else loop.found.set(url, { name: url, url, facts: text.slice(0, 4000), match: null, blocked: null });
        ctx.facts?.add("known", `From the page ${url}: ${text.replace(/\s+/g, " ").slice(0, 1500)}`);
        return { ok: true, text: text.replace(/[ \t]+/g, " ").slice(0, 6000), emails: emailsIn(text).slice(0, 5) };
      },
    }),

    shareFinds: tool({
      description: toolUse("shareFinds"),
      inputSchema: z.object({
        items: z
          .array(z.object({ link: z.string(), caption: z.string().describe("One or two short sentences: what it is and why it fits them, from its facts; say what's unconfirmed.") }))
          .min(1)
          .max(3),
      }),
      execute: async ({ items }) => {
        await seeded();
        const notes = await loadBrief(ctx.userId).catch(() => null);
        const sent: string[] = [];
        // The finds that went (their link did), for the record only: a refused or skipped one is never recorded as sent.
        const went: { link: string; caption: string }[] = [];
        const refused: string[] = [];
        const uncaptioned: string[] = [];
        // Their limits at keep (Phase A2), all items in one read: a kind they ruled out (judged by its main activity), an event outside
        // when they're free. A kind they name in this text is theirs again.
        const foundFor = (link: string) => loop.found.get(link) ?? (notes?.shortlist ?? []).map((s) => ({ name: s.name, url: s.url, facts: s.note ?? "", match: null, blocked: null }) as Found).find((s) => s.url === link);
        const lim = await limits();
        const outByLink = new Map<string, string>();
        if (lim && (lim.avoid.length || lim.availability || lim.rules?.some((r) => r.area === "avoid_topic"))) {
          const { limitsGate } = await import("../services/memberLimits.js");
          const known = items.map((it) => ({ link: it.link, f: foundFor(it.link) })).filter((x) => x.f);
          // A reply's search is theirs: a subject read that fails keeps its finds (onTopicReadFail "keep").
          const g = await limitsGate(known.map((x) => ({ ...(x.f!.match ?? {}), name: x.f!.name, reason: x.f!.facts, link: x.link })), lim, { askText: askWords(), onTopicReadFail: "keep" }).catch(() => null);
          for (const o of g?.out ?? []) outByLink.set(String((o.match as any).link), o.why);
        }
        const postLinks = items.map((it) => it.link).filter((l) => foundFor(l)?.viaPost);
        const { unshareableEventLinks, mayBePrivateEvent } = await import("../services/eventPage.js");
        const unshareable = postLinks.length ? await unshareableEventLinks(postLinks).catch(() => new Set(postLinks.filter(mayBePrivateEvent))) : new Set<string>();
        for (const it of items) {
          if (outByLink.has(it.link)) {
            refused.push(`${foundFor(it.link)?.name ?? it.link}: ${outByLink.get(it.link)}`);
            continue;
          }
          const f = foundFor(it.link);
          if (!f) {
            refused.push(`${it.link}: not something you found this turn or have in your notes`);
            continue;
          }
          if (f.blocked) {
            refused.push(`${f.name}: ${f.blocked}`);
            continue;
          }
          // A post's link to a Luma or Partiful page not confirmed public never goes (fail closed): checked again here, all of them at once
          // before this loop (unshareable). A web find was already checked by the web search (taskWeb.ts).
          if (unshareable.has(it.link)) {
            refused.push(`${f.name}: its page doesn't confirm it's a public event; never share it`);
            continue;
          }
          // Its start, read again as it goes: an event found earlier that has started, or starts too soon to get to, never goes
          // (harness/matchGate.ts startProblem; Royce, 2026-10-17, the Angel Island run).
          const late = matchStartProblem(f.match, new Date(), START_LEAD_MINUTES);
          if (late) {
            refused.push(`${f.name}: ${late}`);
            continue;
          }
          if (loop.shared.includes(it.link)) continue;
          // A find from an earlier turn past its window backs nothing in a caption until its page is read again.
          const problems = captionProblems(it.caption, `${f.name} ${usableFacts(f)}`, `${theirWords()} ${notes ? JSON.stringify({ city: notes.city, when: notes.when, headcount: notes.headcount, budget: notes.budget }) : ""}`);
          if (problems.length) {
            refused.push(`${f.name}: caption says more than its facts (${problems.join("; ")}); rewrite it from its facts`);
            continue;
          }
          // Says who they are only from what they've told Co (services/identityGuard.ts).
          const known = `${theirWords()} ${JSON.stringify({ goals: ctx.turn?.profile?.goals ?? null, city: ctx.turn?.profile?.city ?? null })} ${f.name} ${usableFacts(f)}`;
          if ((stripUngroundedIdentity(it.caption, known) ?? "").trim() !== it.caption.trim()) {
            identityDropped(it.caption, null, "reply.find_caption", ctx.userId);
            refused.push(`${f.name}: the caption says who they are beyond what they've told you; rewrite it without that`);
            continue;
          }
          // The first find after a "looking" line threads under their text, as results always have.
          if (!sent.length && loop.holdSent) ctx.threadNext?.();
          if (!(await say(it.link, `Co replied: ${it.link}`))) {
            notDone(`The link ${it.link} didn't send.`);
            continue;
          }
          // The link went out, so it's shared whatever happens to its caption.
          loop.shared.push(it.link);
          sent.push(f.name);
          went.push({ link: it.link, caption: it.caption });
          state.sent = true;
          await new Promise((r) => setTimeout(r, ctx.dryRun ? 0 : 1500));
          // The caption is its own receipt (2026-10-01 code review: a failed
          // caption was recorded as sent). One retry of just the caption; if it
          // still fails, the fact says the link went alone, so Co's reply can
          // carry what the caption would have.
          const caption = it.caption.trim();
          const captioned = (await say(caption, `Co replied: ${caption}`)) || (await say(caption, `Co replied: ${caption}`));
          if (captioned) {
            ctx.facts?.add("did_this_turn", `Sent "${f.name}" (${it.link}) with the caption: "${caption}"`);
          } else {
            uncaptioned.push(f.name);
            ctx.facts?.add("did_this_turn", `Sent the link for "${f.name}" (${it.link}), but its caption didn't send`);
            notDone(`The caption for ${f.name} didn't send; only its link went.`);
          }
          if (f.match && !ctx.dryRun) await recordRecommendationsSent(ctx.userId, [f.match], [it.link]).catch(() => {});
        }
        if (sent.length) await remember({ shortlist: [...(notes?.shortlist ?? []), ...items.filter((i) => loop.shared.includes(i.link)).map((i) => ({ name: loop.found.get(i.link)?.name ?? i.link, url: i.link, note: i.caption.slice(0, 200) }))].slice(-8) });
        if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "loop.shareFinds", userId: ctx.userId, outcome: sent.length ? "act" : "skip", action: `sent ${sent.length}`, proposal: { sent, refused, seconds: Math.round((Date.now() - loop.started) / 1000) } }).catch(() => {});
        if (refused.length) notDone(`Not sent: ${refused.join(" | ")}`);
        // What the model reads is unchanged: every refused find and why. The record (agent/toolGuard.ts) reads only what went.
        return withRecordAs({
          ok: sent.length > 0,
          sent,
          refused,
          ...(uncaptioned.length ? { uncaptioned } : {}),
          note: !sent.length
            ? "Nothing sent."
            : uncaptioned.length
              ? `Sent. The caption didn't go out for ${uncaptioned.join(", ")}: only the link did, so say what it is in your reply. The rest went with their captions; don't repeat those.`
              : "Sent, each link then its caption. Don't repeat them in your reply; add only what's left to say.",
        }, { items: went });
      },
    }),

    // A file they sent (services/memberFiles.ts), read only for what serves connections (services/documentRead.ts): event details from
    // a flyer or agenda, who they are and what they're looking for. Read in its own call, so the file never enters this conversation.
    readDocument: tool({
      description: toolUse("readDocument"),
      inputSchema: z.object({ file: z.number().int().optional().describe("The file's number, when they name one; leave it out for their newest.") }),
      execute: async ({ file }) => {
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was read." };
        const R = await import("../services/documentRead.js");
        const r = await R.readMemberFile(ctx.userId, file ?? null, ctx.resolvedContent);
        if (!r) return { ok: false, error: "There's no readable file of theirs on file. Ask them to send it again, or to tell you the details." };
        ctx.facts?.add("did_this_turn", r.kind === "unrelated" ? "Read the file they sent: it isn't about an event, a person or what they're looking for." : `Read the file they sent for ${r.kind === "event" ? "event details" : "who they are and what they're looking for"}.`);
        return R.toolResult(r);
      },
    }),
    // Research on rooms, events and communities they'd attend, in the background (services/researchBrief.ts): this only starts it, on their ask or yes (the
    // guard's their_yes). The task finds, checks every line's source and texts the finds, each its link then one line (never a document).
    researchBrief: tool({
      description: toolUse("researchBrief"),
      inputSchema: z.object({
        what: z.string().describe("What they're looking for, in their words: the kind of event and space, how many people."),
        date: z.string().optional().describe("The event date they gave, YYYY-MM-DD. Leave it out if they didn't give one."),
        start: z.string().optional().describe("The start time they gave, like 6:00 pm. Leave it out if they did not give one."),
        memberContext: z.array(z.string()).max(6).optional().describe("Up to six short lines of what they told you that matters (budget, size, neighborhood), in their words."),
        headcount: z.number().int().positive().max(5000).optional().describe("How many people, if they said. Never guess it."),
        budget: z.string().optional().describe("Their budget in their words (like \"$5k\" or \"under $200 an hour\"), if they gave one."),
        neighborhood: z.string().optional().describe("The neighborhood or area they named, if any."),
        city: z.string().optional().describe("The city, only if it's not the one they live in."),
        scope: z.enum(["in", "out", "mixed"]).optional().describe("Your own judgment: \"in\" when this is research on rooms, events or communities they would attend. On a message that mixed that with something else, call this for the connection part alone with scope \"in\"."),
        again: z.boolean().optional().describe("True when they want the same brief again or updated; the options are re-checked before it goes."),
      }),
      execute: async (input) => {
        // Search quality (services/researchQuality.ts): the search is built from what's known about them; a load-bearing fact
        // that isn't known is asked, never guessed. "Again" re-sends the last brief's options, re-checked.
        // The purpose boundary (harness/scope.ts): venue and vendor research for their OWN event is out for now. Only research on rooms,
        // events and communities they would attend goes ahead. The same check runs again in startResearchBrief and when a brief wakes.
        const { scopeRefusal } = await import("../services/coTasks.js");
        const briefVerdict = input.scope ? parseVerdict({ scope: input.scope }) : workVerdict(ctx.turnScope);
        const outside = scopeRefusal({ goal: input.what, scope: briefVerdict });
        if (outside) {
          notDone("The research wasn't started: that isn't something Cue does.");
          return { ok: false, error: outside.why };
        }
        if (!input.again) {
          const Q = await import("../services/researchQuality.js");
          const known = { city: input.city?.trim() || (ctx.turn?.profile?.city ?? null), neighborhood: null, budget: null, date: null, start: null, headcount: input.headcount ?? null, likes: [], passes: [] };
          const q = Q.assembleQuery("event", input.what, known);
          if (!q.ok) return { ok: false, askThem: q.question, note: "Nothing was started. Ask them this in your own words, in one line, then start it once they answer." };
        }
        const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : null;
        const start = input.start && /^\d{1,2}:\d{2}\s*[ap]m$/i.test(input.start.trim()) ? input.start.trim().toLowerCase() : null;
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was started." };
        const { startResearchBrief } = await import("../services/coTasks.js");
        const r = await startResearchBrief({
          userId: ctx.userId,
          theirWords: theirWords(),
          goal: `Research: ${input.what}`.slice(0, 200),
          scope: briefVerdict,
          params: { what: input.what.slice(0, 200), date, start: date ? start : null, memberContext: (input.memberContext ?? []).map((x) => x.slice(0, 200)), city: input.city?.trim() || (ctx.turn?.profile?.city ?? null), headcount: input.headcount ?? null, budget: input.budget?.slice(0, 80) ?? null, neighborhood: input.neighborhood?.slice(0, 80) ?? null, again: !!input.again },
        });
        if (!r.ok) {
          notDone(`The research wasn't started: ${r.why}.`);
          return { ok: false, error: r.why };
        }
        // "Started task #N:" is the shape a promise is backed by (harness/replyGrounding.ts unbackedFollowup), so "I'll text you the brief
        // once it's ready" stands on this.
        ctx.facts?.add("did_this_turn", `Started task #${r.task.id}: researching rooms, events and communities for them in the background ("${input.what.slice(0, 80)}"${date ? `, ${date}${start ? ` from ${start}` : ""}` : ""}). They come as finds by text when it's ready; nothing about options, prices or availability is known yet.`);
        return { ok: true, note: "Tell them in one line you're on it and what it verifies will come as texts. Don't name any option, price or availability now." };
      },
    }),
    // What they made of an option Co showed them in a brief (services/researchQuality.ts): the ranking signal for their next finds.
    findReaction: tool({
      description: toolUse("findReaction"),
      inputSchema: z.object({
        option: z.string().describe("The option as they referred to it: its number in the brief (\"2\") or its name."),
        reaction: z.enum(["yes", "no", "not_like_that"]).describe("yes: they want it or like it; no: not this one; not_like_that: not this kind of thing at all."),
        why: z.string().optional().describe("What they said about it, in their words, if anything."),
      }),
      execute: async (input) => {
        const Q = await import("../services/researchQuality.js");
        const shown = await Q.recentShownFinds(ctx.userId);
        const lastTask = shown.length ? shown[0].shownAt.getTime() : 0;
        const latest = shown.filter((f) => Math.abs(f.shownAt.getTime() - lastTask) < 60_000);
        const n = Number(input.option.trim().replace(/^#|\.$/g, ""));
        const byNum = Number.isInteger(n) && n >= 1 && n <= latest.length ? latest[n - 1] : null;
        const want = input.option.trim().toLowerCase();
        const byName = shown.find((f) => want.length >= 3 && (f.name.toLowerCase().includes(want) || want.includes(f.name.toLowerCase())));
        const hit = byNum ?? byName ?? null;
        if (!hit) return { ok: false, error: "That doesn't match an option you showed them in the last two weeks." };
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was recorded." };
        const ok = await Q.recordFindOutcome(ctx.userId, hit.id, input.reaction, input.why ?? null);
        if (!ok) return { ok: false, error: "Already recorded." };
        return { ok: true, option: { name: hit.name, link: hit.url, fields: hit.fields.map((f) => ({ [f.label]: f.value ?? "unknown", checked: f.checkedAt })) }, next: Q.nextStepAfterReaction(input.reaction, hit), note: "Don't mention noting it." };
      },
    }),
    // A goal's state (services/goalEdges.ts, Royce 2026-10-08): done or set aside when they say so or it's plainly over, active again
    // when they still want it. Only a goal on file; stale and done goals stay on file as history and stop generating searches.
    markGoal: tool({
      description: toolUse("markGoal"),
      inputSchema: z.object({
        goal: z.string().describe("The goal, as it reads in what you know about them."),
        state: z.enum(["done", "stale", "active"]).describe("done: they reached it or closed it; stale: it no longer applies (its date passed, plans changed); active: they still want it."),
        why: z.string().describe("A few words: what they said or what changed."),
      }),
      execute: async ({ goal, state, why }) => {
        const G = await import("../services/goalEdges.js");
        const { goalTexts } = await import("../services/goalJourney.js");
        const { rows } = await pool.query(`SELECT goals, intent, long_term_direction FROM co_profiles WHERE user_id = $1`, [ctx.userId]).catch(() => ({ rows: [] as any[] }));
        // Their direction is read as a goal by the sweep, so it can be marked too (review of #107).
        const onFile = [...goalTexts(rows[0]?.intent, rows[0]?.goals), ...(rows[0]?.long_term_direction ? [String(rows[0].long_term_direction)] : [])];
        const exact = onFile.find((g) => g.trim().toLowerCase() === goal.trim().toLowerCase());
        const close = exact ? [exact] : onFile.filter((g) => G.restates(goal, g) || G.restates(g, goal));
        if (!close.length) return { ok: false, error: "That isn't one of their goals on file. Only mark a goal they have." };
        if (close.length > 1) return { ok: false, error: `That could be more than one of their goals (${close.map((g) => `"${g.slice(0, 60)}"`).join(", ")}). Call again with the goal exactly as it reads.` };
        const match = close[0];
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was changed." };
        const changed = await G.setGoalState(ctx.userId, match, state, why, state === "active" ? "member" : "co").catch(() => false);
        if (!changed) return { ok: false, error: "The goal couldn't be marked just now; nothing changed. Don't tell them it was." };
        // A goal action is a signal: its recheck clock moves, and a recheck it answers is cleared (services/goalRecheck.ts).
        await import("../services/goalRecheck.js").then((R) => R.noteGoalAction(ctx.userId, [match])).catch(() => {});
        // Back to active: the find asks that idled with it come back too (services/askRetire.ts).
        if (state === "active") await import("../services/askRetire.js").then((A) => A.reviveAsksWithGoal(ctx.userId, G.goalHash(match))).catch(() => 0);
        ctx.facts?.add("did_this_turn", `Marked their goal "${match.slice(0, 100)}" ${state}${why ? ` (${why.slice(0, 80)})` : ""}.`);
        return { ok: true, note: state === "active" ? "It's active again: the daily search uses it." : "It stays on file and stops generating searches. Don't announce the bookkeeping; just answer them." };
      },
    }),

    updateNotes: tool({
      description: toolUse("updateNotes"),
      inputSchema: z.object({
        what: z.string().optional(),
        city: z.string().optional(),
        area: z.string().optional(),
        when: z.string().optional(),
        headcount: z.number().optional(),
        budget: z.number().optional(),
        hours: z.number().optional(),
        picked: z.string().optional().describe("What they chose, by name."),
        next: z.string().optional().describe("What's next, in a few words."),
      }),
      execute: async (patch) => {
        await remember(patch as Partial<SearchIntent>);
        return { ok: true };
      },
    }),

    // Where one of their open loops stands (services/openLoops.ts): Co's word
    // wins over what code derives, and a loop Co closes stays closed. Named by
    // its id; a title only lands when exactly one loop fits it.
    updateLoop: tool({
      description: toolUse("updateLoop"),
      inputSchema: z.object({
        loopId: z.number().int().optional().describe("The loop's id, the N in [loop N] in what you're carrying for them. Leave it out only for a new loop."),
        loop: z.string().describe("The loop's name as you're carrying it, or a new one in a few words."),
        status: z.enum(["open", "waiting_on_reply", "unconfirmed", "decision_needed", "done", "dropped"]),
        detail: z.string().optional().describe("What it's waiting on or what's unconfirmed, in a few words."),
      }),
      execute: async ({ loopId, loop, status, detail }) => {
        if (ctx.dryRun) return { ok: true, note: "Recorded (test run)." };
        const { setLoopStatus } = await import("../services/openLoops.js");
        const r = await setLoopStatus(ctx.userId, { id: loopId ?? null, title: loop }, status, detail?.trim().slice(0, 240) ?? null).catch(() => ({ ok: false as const, error: "Couldn't record that. Don't say you did." }));
        return r.ok ? { ok: true, note: `"${r.title}" is now ${status.replace(/_/g, " ")}.` } : { ok: false, error: r.error };
      },
    }),
  };
}

// The notes, as Co reads them at the start of a turn.
export function describeNotes(b: SearchIntent | null): string | null {
  if (!b) return null;
  const parts = [
    b.what && `looking for: ${b.what}`,
    (b.area || b.city) && `where: ${[b.area, b.city].filter(Boolean).join(", ")}`,
    b.when && `when: ${b.when}`,
    b.headcount && `headcount: ${b.headcount}`,
    b.budget && `budget: under $${b.budget}`,
    b.hours && `hours: ${b.hours}`,
    b.shortlist?.length && `shortlist: ${b.shortlist.map((s) => `${s.name} (${s.url})`).join("; ")}`,
    b.picked && `they picked: ${b.picked}`,
    b.contacts?.length && `contacts: ${b.contacts.map((c) => c.email).join(", ")}`,
    b.tried?.length && `already tried: ${b.tried.slice(-6).join("; ")}`,
    b.next && `next: ${b.next}`,
  ].filter(Boolean);
  return parts.length ? `Your working notes for what you're finding for them (from earlier texts): ${parts.join(". ")}.` : null;
}
