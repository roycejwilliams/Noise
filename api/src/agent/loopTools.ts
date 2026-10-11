// The tools of Co's own loop (agent/loop.ts). Co chooses and chains them; code
// guards only facts: a link was really found, a fact is on its page, an email
// address was really seen, the turn's budget, and nothing is sent to anyone
// but the member (an email is a tap-to-send link they send themselves).
import { z } from "zod";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import { writeMemory } from "../services/memory.js";
import { recordDecision } from "../harness/core.js";
import { recordRecommendationsSent } from "../services/recommendation.js";
import { eventCandidates, type TierMatch } from "../services/tieredRecommendation.js";
import { loadBrief, saveBrief, type SearchIntent } from "../services/searchIntent.js";
import { numbersBacked, placesBacked, unbackedClaims } from "../services/taskWeb.js";
import { captionNumbersBacked } from "../services/sendCheck.js";
import { LOOP_BUDGET } from "./loop.js";
import { stripUngroundedIdentity } from "../services/identityGuard.js";
import type { ConversationToolContext } from "./conversationTools.js";
import pool from "../db/db.js";
import { resolvePlan, planProblems, type EventRecord } from "../services/planSheet.js";
import { WRITE_DOCUMENT_INPUT } from "../services/documentSheet.js";
import { GOOGLE_DOC_ASK } from "../services/documentDelivery.js";

// What the loop has seen this turn: every link a tool returned, with the facts
// that came with it, and every page it read.
// stored: carried in from an earlier turn (seedFound), checked at checkedAt and good until freshUntil; past that its facts back
// nothing until its page is read again.
export type Found = { name: string; url: string; facts: string; match: TierMatch | null; blocked: string | null; stored?: boolean; checkedAt?: string | null; freshUntil?: number | null };
export type LoopState = { started: number; found: Map<string, Found>; pages: Map<string, string>; holdSent: boolean; shared: string[]; webQueries: number };

// ---------- yesterday's finds, carried into today's turn (B5, 2026-10-08)
// What Co found for them on earlier turns (web results kept at research time, a brief's options, events it sent, its shortlist),
// each with when it was checked. A plan, a document or a caption may cite one only while it's fresh; past its window it's re-read
// first (readPage, or an event's own page re-read by emailPlan). Every read is this member's own (user_id), never anyone else's.
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
// Pure: what a plan step may take from a find: an event with its own page record, and nothing from one past its window.
export function recordFromFound(f: Found | undefined, now = Date.now()): EventRecord | null {
  if (!f) return null;
  const d = f.match && "details" in f.match ? (f.match as any).details : null;
  if (staleFind(f, now)) {
    const when = f.checkedAt ? new Date(f.checkedAt).toISOString().slice(0, 10) : "an earlier day";
    return { name: f.match?.name ?? f.name, hasRecord: true, blocked: `last checked ${when}; read its page again (readPage) before it goes in a plan` };
  }
  // Only an event with its own page record can fill a step; a web result or a post can't.
  return { name: f.match?.name ?? f.name, hasRecord: !!d, blocked: f.blocked ?? null, startAt: d?.startAt ?? null, endAt: d?.endAt ?? null, timezone: d?.timezone ?? null, venue: d?.venue ?? null, address: d?.address ?? null };
}
// An event carried in from an earlier turn that a plan names: its own page re-read now (Luma), so its time and place are today's.
export async function refreshStoredEvents(loop: LoopState, links: string[], fetchDetails: (url: string) => Promise<any | null>, isEvent: (url: string) => boolean, now = Date.now()): Promise<number> {
  let n = 0;
  for (const link of [...new Set(links)]) {
    const f = loop.found.get(link);
    if (!f?.stored || !isEvent(link)) continue;
    const hasDetails = !!(f.match && "details" in f.match && (f.match as any).details);
    if (hasDetails && !staleFind(f, now)) continue;
    const d = await fetchDetails(link).catch(() => null);
    if (!d) continue;
    f.match = { tier: 2, kind: "event", source: "luma", name: f.name, url: link, reason: f.facts || f.name, details: d } as unknown as TierMatch;
    f.blocked = d.soldOut === true ? "sold out" : null;
    refreshFound(f, [f.facts, d.startAt ? `starts ${d.startAt}` : "", d.venue ?? "", d.address ?? ""].filter(Boolean).join(" "), now);
    n++;
  }
  return n;
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
    .query(`SELECT object_label, url, happened_at, meta->>'when' AS "when" FROM co_facts WHERE owner_user_id = $1 AND subject = 'co' AND relation = 'sent' AND url IS NOT NULL AND happened_at > NOW() - make_interval(days => $2) ORDER BY happened_at DESC LIMIT 20`, [userId, SENT_EVENT_DAYS])
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
  return { started, found: new Map(), pages: new Map(), holdSent: false, shared: [], webQueries: 0 };
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

// They asked for it by email, in their own words: "email it to me", "send it to my email", "put it on my
// calendar", "in my inbox". Not "I'll email the host", "don't email me", "my email changed", or the caption of
// a photo of an email.
const EMAIL_REQUEST = /\be-?mail (?:it|this|that|me|the plan|the pdf|the sheet)\b|\bmail (?:it|this|that|me the|the plan|the pdf) (?:to me|over)?\b|\bsend (?:it|this|that|me the plan|the plan|the pdf)(?: over)? (?:to|by|via|through) (?:my )?(?:e-?mail|inbox|gmail|outlook|icloud)\b|\b(?:to|in|into|on|at) my (?:e-?mail|inbox|gmail|outlook|icloud)\b|\b(?:add|put|drop|send)(?: it| this| the plan| these| them)? (?:to|on|in|into) my calendar\b|\bon my calendar\b|\bcalendar (?:invites?|holds?|events?)\b|\bby e-?mail\b|\bvia e-?mail\b|\be-?mails? please\b/i;
const EMAIL_REFUSAL = /\b(?:don'?t|do not|no need to|never|please don'?t|stop) (?:e-?mail|mail)\b|\bI(?:'ll| will)? e-?mail (?:the|them|him|her|my)\b|\bI(?:'ve)? e-?mailed\b|\bmy e-?mail (?:changed|is|was|address)\b/i;
export function EMAIL_ASK_TEST(text: string): boolean {
  const own = text.replace(/\[[^\]]*\]/g, " ");
  return EMAIL_REQUEST.test(own) && !EMAIL_REFUSAL.test(own);
}
export const EMAIL_ASK = { test: EMAIL_ASK_TEST };

// They asked for a Google Doc (or for it in their Drive), in their own words. Defined with the delivery (a task's document reads it too).
export { GOOGLE_DOC_ASK };

export function mailtoLink(to: string, subject: string, body: string): string {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function loopTools(
  ctx: ConversationToolContext,
  state: { sent: boolean; sentMessages: string[] },
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
  const hold = async (line?: string) => {
    if (!line?.trim() || loop.holdSent || state.sent) return;
    loop.holdSent = true;
    if (await say(line.trim(), `${HOLD_PREFIX} ${line.trim()}`)) ctx.facts?.add("did_this_turn", `Told them "${line.trim()}" while looking.`);
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
  let limitsRead: Promise<{ avoid: string[]; availability: string | null } | null> | null = null;
  const limits = () => (limitsRead ??= ctx.dryRun ? Promise.resolve(null) : import("../services/memberKnowledge.js").then((M) => M.realKnowledgeDeps.limits(ctx.userId)).catch(() => null));
  // The words an ask is judged on: a text's message (with the text it replies to), or on a call their last three lines (an ask is often
  // built over a few turns: "I'd love a hackathon again", "which weekend?", "the 20th"), never the whole call (review of #139).
  const askWords = () => (ctx.isVoice ? String(ctx.turn?.message ?? "").split("\n").filter((l) => l.trim()).slice(-3).join("\n") || ctx.resolvedContent : theirWords());
  const ruledOut = async (query: string): Promise<string | null> => {
    const l = await limits();
    if (!l?.avoid.length) return null;
    const { avoidFor, avoidHits } = await import("../services/memberLimits.js");
    const hit = avoidHits(query, avoidFor(l.avoid, askWords()))[0];
    return hit ? `Not searched: they told Co to stop suggesting ${hit}. Look for something else they want. If they're asking for it now, it lifts for this once when their own words ask for it; only use steerAwayFrom with undo if they say they're open to it again in general.` : null;
  };
  // A receipt for every search, empty or not, so "I looked and nothing turned
  // up" is backed (2026-10-01: with no record, the fact check cut it).
  const receipt = (what: string) => ctx.facts?.add("did_this_turn", what);
  // Yesterday's finds, carried into this turn (storedFinds): read once, the first time a tool that cites a find runs (a turn that
  // never needs them never reads them). Never in tests.
  let seeding: Promise<unknown> | null = null;
  const seeded = (): Promise<unknown> => (seeding ??= ctx.dryRun || ctx.stubSearch ? Promise.resolve() : storedFinds(ctx.userId).then((rows) => seedFound(loop, rows)).catch(() => 0));
  // A short line while a PDF is made (like whileLooking), unless the ✍️ reaction on their text already said "on it".
  const holdWhileWriting = async (line?: string) => {
    if (ctx.ackSent === "✍️") return;
    await hold(line);
  };

  return {
    searchEvents: tool({
      description: toolUse("searchEvents"),
      inputSchema: z.object({
        what: z.string().describe("What kind of event, in a few words."),
        when: z.string().optional().describe("The time in their own words: \"this weekend\", \"Friday night\", \"Oct 10\"."),
        city: z.string().optional().describe("The city, when they named one; their own city otherwise."),
        whileLooking: z.string().optional().describe("Only on your first search, if it'll take a moment: a few words to them, in your own voice."),
      }),
      execute: async ({ what, when, city, whileLooking }) => {
        const avoided = await ruledOut(what);
        if (avoided) return { ok: false, error: avoided };
        if (ctx.stubSearch) {
          receipt(`Looked up events for "${what}"${when ? `, ${when}` : ""} just now: nothing came back.`);
          return { ...STUB, events: [] };
        }
        if (outOfTime()) return OUT_OF_TIME;
        await hold(whileLooking);
        const [r, earlier] = await Promise.all([
          eventCandidates(what, city ?? ctx.turn?.profile?.city ?? null, { when: when ?? null, userId: ctx.userId, limit: 8 }),
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
          ctx.facts?.add("known", `Found earlier by Co's daily search: "${m.name}", link ${(m as any).url}. ${facts}`);
          return { name: m.name, link: (m as any).url, details: facts };
        });
        return {
          ok: true,
          window: r.window,
          events,
          turnedAway: r.turnedAway.map((g) => `${g.name}: ${g.reasons.join(", ")}`),
          openingsFoundEarlier: openings,
          note: `${r.inWindow} events in the feed for ${r.window ?? "the next two weeks"} nearby; the ${events.length} closest to what you asked are above.${r.inWindow < 4 ? " The feed is thin here: try webSearch for the same thing." : ""}`,
        };
      },
    }),

    webSearch: tool({
      description: toolUse("webSearch"),
      inputSchema: z.object({
        queries: z.array(z.string()).min(1).max(3).describe("1 to 3 short searches, 3 to 7 words each, each a different angle; they run at the same time."),
        sites: z.array(z.string()).optional().describe("Sites where this kind of thing is listed, e.g. peerspace.com, thebash.com, lu.ma."),
        whileLooking: z.string().optional().describe("Only on your first search, if it'll take a moment: a few words to them, in your own voice."),
        theirs: z
          .object({ what: z.string().optional(), city: z.string().optional(), area: z.string().optional(), when: z.string().optional(), headcount: z.number().optional(), budget: z.number().optional(), hours: z.number().optional() })
          .optional()
          .describe("What they've asked for so far (what, place, date, headcount, budget in dollars, hours): saved to your working notes, so the next text picks up from here."),
      }),
      execute: async ({ queries, sites, whileLooking, theirs }) => {
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
        const left = LOOP_BUDGET.webSearches - loop.webQueries;
        if (left <= 0) return { ok: false, error: "No web searches left this turn: work with what you have, or read a page you already found." };
        const run = [...new Set(queries.map((q) => q.trim().slice(0, 90)).filter(Boolean))].slice(0, left);
        loop.webQueries += run.length;
        await hold(whileLooking);
        const { taskWebSearch } = await import("../services/taskWeb.js");
        const city = ctx.turn?.profile?.city ?? null;
        const siteList = (sites ?? []).filter((s) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)).slice(0, 4);
        const all = await Promise.all(run.map((q) => taskWebSearch(ctx.userId, q, { city, sites: siteList, source: "request", log: !ctx.dryRun }).catch(() => ({ kept: [], dropped: [], droppedDetails: [], note: "failed" }))));
        // The shared daily web search budget is spent: say so plainly rather than
        // "nothing yet" (2026-10-01: a day of testing used all 60, and Co gave up vaguely).
        if (all.every((x) => /^No web search right now/.test(x.note))) {
          notDone("Web search wasn't available: today's shared web search budget is used up.");
          return { ok: false, error: "No more web searches today. Lead with what you already found or searchEvents; if they still need more, save it (saveAsk) and say when they'll hear back, without naming a limit." };
        }
        await remember({ tried: run.map((q) => `web: ${q}`) });
        const seenUrls = new Set<string>();
        // Jev reads each fact against its passage (services/factCheck.ts); a "no" is dropped.
        const { checkVerified } = await import("../services/factCheck.js");
        const read = await checkVerified(all.flatMap((x) => x.kept).filter((k) => !seenUrls.has(k.url) && seenUrls.add(k.url))).catch(() => ({ kept: all.flatMap((x) => x.kept), droppedFacts: [] as string[] }));
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
          note: all.map((x) => x.note).find((n) => /checked/.test(n)) ?? all[0]?.note ?? "" };
        receipt(`Searched the web just now (${run.map((q) => `"${q}"`).join(", ")}): ${r.kept.length} held up on their own pages${r.dropped.length ? `, ${r.dropped.length} didn't` : ""}.`);
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
        whileLooking: z.string().optional().describe("Only on your first search, if it'll take a moment: a few words to them, in your own voice."),
      }),
      execute: async ({ query, whileLooking }) => {
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
        for (const p of posts) {
          const match = { tier: 3, kind: "opportunity", source: "x", name: p.text.slice(0, 80), url: p.url, reason: p.text, evidence: p.text } as unknown as TierMatch;
          loop.found.set(p.url, { name: p.text.slice(0, 80), url: p.url, facts: p.text, match, blocked: null });
          // What the post links to (expanded from t.co), with the post as what's known about it, as readPage does for a page.
          for (const l of p.links) if (!loop.found.has(l)) loop.found.set(l, { name: p.text.slice(0, 80), url: l, facts: p.text, match: null, blocked: null });
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
        const refused: string[] = [];
        const uncaptioned: string[] = [];
        // Their limits at keep (Phase A2), all items in one read: a kind they ruled out (judged by its main activity), an event outside
        // when they're free. A kind they name in this text is theirs again.
        const foundFor = (link: string) => loop.found.get(link) ?? (notes?.shortlist ?? []).map((s) => ({ name: s.name, url: s.url, facts: s.note ?? "", match: null, blocked: null }) as Found).find((s) => s.url === link);
        const lim = await limits();
        const outByLink = new Map<string, string>();
        if (lim && (lim.avoid.length || lim.availability)) {
          const { limitsGate } = await import("../services/memberLimits.js");
          const known = items.map((it) => ({ link: it.link, f: foundFor(it.link) })).filter((x) => x.f);
          const g = await limitsGate(known.map((x) => ({ ...(x.f!.match ?? {}), name: x.f!.name, reason: x.f!.facts, link: x.link })), lim, { askText: askWords() }).catch(() => null);
          for (const o of g?.out ?? []) outByLink.set(String((o.match as any).link), o.why);
        }
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
          if (f.match && !ctx.dryRun) await recordRecommendationsSent(ctx.userId, [f.match]).catch(() => {});
        }
        if (sent.length) await remember({ shortlist: [...(notes?.shortlist ?? []), ...items.filter((i) => loop.shared.includes(i.link)).map((i) => ({ name: loop.found.get(i.link)?.name ?? i.link, url: i.link, note: i.caption.slice(0, 200) }))].slice(-8) });
        if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "loop.shareFinds", userId: ctx.userId, outcome: sent.length ? "act" : "skip", action: `sent ${sent.length}`, proposal: { sent, refused, seconds: Math.round((Date.now() - loop.started) / 1000) } }).catch(() => {});
        if (refused.length) notDone(`Not sent: ${refused.join(" | ")}`);
        return {
          ok: sent.length > 0,
          sent,
          refused,
          ...(uncaptioned.length ? { uncaptioned } : {}),
          note: !sent.length
            ? "Nothing sent."
            : uncaptioned.length
              ? `Sent. The caption didn't go out for ${uncaptioned.join(", ")}: only the link did, so say what it is in your reply. The rest went with their captions; don't repeat those.`
              : "Sent, each link then its caption. Don't repeat them in your reply; add only what's left to say.",
        };
      },
    }),

    draftEmail: tool({
      description: toolUse("draftEmail"),
      inputSchema: z.object({
        to: z.string().optional().describe("The address, if the place has one you've seen. Leave it out for a marketplace listing that has its own contact form."),
        subject: z.string(),
        body: z.string(),
      }),
      execute: async ({ to, subject, body }) => {
        const notes = await loadBrief(ctx.userId).catch(() => null);
        // A marketplace listing (Tagvenue, Peerspace, The Bash) is reached through
        // its own contact form: the draft is for them to paste there.
        // The draft itself goes out as its own text, so they always have it to
        // copy (2026-10-01: Co said "I wrote the note" and never showed it).
        const draftText = `${subject.trim() ? `Subject: ${subject.trim()}\n\n` : ""}${body.trim()}`;
        if (!to?.trim()) {
          if (!(await say(draftText, `Co replied: ${draftText}`))) return { ok: false, error: "The draft didn't send. Give them the words in your reply instead, plainly, without mentioning what failed." };
          ctx.facts?.add("did_this_turn", `Sent them a draft message to paste into the listing's own contact form: "${draftText.slice(0, 400)}"`);
          await remember({ next: "message drafted for the listing's contact form; waiting for them to send it" });
          return { ok: true, note: "The draft went out as its own text. Say in a line where to paste it (the listing's contact form); don't repeat the draft." };
        }
        const addr = to.trim().toLowerCase();
        const seen = [...loop.pages.values()].some((t) => t.toLowerCase().includes(addr)) || theirWords().toLowerCase().includes(addr) || (notes?.contacts ?? []).some((c) => c.email.toLowerCase() === addr) || (ctx.turn?.ledger ? JSON.stringify(ctx.turn.ledger).toLowerCase().includes(addr) : false);
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(addr) || !seen) {
          notDone(`No email drafted to ${to}: that address wasn't on a page read this turn, in their texts, or in the notes.`);
          return { ok: false, error: "That address isn't one you've seen. Read the place's own page (readPage) for a contact address and try again; if it's a marketplace listing with its own contact form, draft without an address so they can paste it there." };
        }
        const link = mailtoLink(addr, subject.trim(), body.trim());
        if (!(await say(`To: ${addr}\n${draftText}`, `Co replied: To: ${addr}\n${draftText}`))) return { ok: false, error: "The draft didn't send. Give them the words in your reply instead, plainly, without mentioning what failed." };
        await new Promise((r) => setTimeout(r, ctx.dryRun ? 0 : 1200));
        await say(link, `Co replied: ${link}`);
        ctx.facts?.add("did_this_turn", `Sent them a draft email to ${addr} ("${subject.trim()}") and a tap-to-send link that opens it in their own mail app. Nothing was sent to ${addr}.`);
        await remember({ contacts: [...(notes?.contacts ?? []).filter((c) => c.email !== addr), { name: addr.split("@")[1] ?? addr, email: addr }].slice(-6), next: `email drafted to ${addr}; waiting for them to send it` });
        return { ok: true, note: "The draft and its tap-to-send link went out as their own texts. Say in a line that tapping the link opens it in their mail app ready to send; don't repeat the draft." };
      },
    }),

    // A plan, emailed (services/planSheet.ts, planEmail.ts): a one-page sheet and calendar holds, to
    // the member's own email on their account. Co writes the plan; code fills event steps from their own
    // records and holds everything else to what was read this turn or said, and the address is never Co's to choose.
    emailPlan: tool({
      description: toolUse("emailPlan"),
      inputSchema: z.object({
        title: z.string().describe("A short title for the plan, in Co's voice, using only words they said or you read: no place, name or number you didn't read."),
        note: z.string().describe("One or two plain sentences for the top of the sheet and the email, in your voice."),
        steps: z
          .array(
            z.object({
              link: z.string().optional().describe("The link of an event you found this turn; its time, place and address come from its own record."),
              when: z.string().optional().describe("Their local time, 2026-10-11T16:30."),
              until: z.string().optional(),
              what: z.string(),
              where: z.string().optional(),
              address: z.string().optional(),
              detail: z.string().optional(),
            }),
          )
          .min(1)
          .max(8),
        notes: z.array(z.string()).max(4).optional().describe("Things worth knowing, one short line each."),
        sendBy: z.enum(["text", "email", "both"]).optional().describe("Leave this out: the PDF goes in this conversation, by text. Only when they ask for it by email (or both) in their own words do you set email or both; the email also carries a calendar hold for each time."),
        line: z.string().optional().describe("The one sentence that goes with the PDF, in your voice (\"Here's the plan for Saturday.\"). No dashes, no exclamation points. Leave it out and a plain line goes. Nothing else about it is sent, so don't repeat it."),
        whileWriting: z.string().optional().describe("Only if it'll take a moment and you haven't already reacted to their text with ✍️: a few words to them while the sheet is made, in your own voice."),
      }),
      execute: async (input) => {
        await seeded();
        const { rows } = await pool.query(`SELECT email, first_name FROM users WHERE id = $1`, [ctx.userId]).catch(() => ({ rows: [] as any[] }));
        const raw = String(rows[0]?.email ?? "").trim();
        const email = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(raw) ? raw : "";
        // By default the plan is a text: the PDF in this conversation. It goes to their email only when they
        // ask for that in their own words this turn (code checks the words, not Co's say-so); with no email on
        // file, an email request becomes a text and Co says so.
        const askedForEmail = EMAIL_ASK.test(theirWords());
        const asked = (input.sendBy === "email" || input.sendBy === "both") && !askedForEmail ? "text" : (input.sendBy ?? "text");
        const byEmail = (asked === "email" || asked === "both") && !!email;
        const byText = asked === "text" || asked === "both" || (asked === "email" && !email);
        const noEmailFallback = (asked === "email" || asked === "both") && !email;
        const downgraded = (input.sendBy === "email" || input.sendBy === "both") && !askedForEmail;
        const zone = await (await import("../services/memberTime.js")).memberZoneOrFallback(ctx.userId);
        // An event from an earlier turn that a step names: its own page re-read now, so the plan carries today's time and place.
        const E = await import("../services/eventDetails.js");
        await refreshStoredEvents(loop, input.steps.map((x) => x.link ?? "").filter(Boolean), (url) => E.fetchLumaEventDetails(url, { maxAgeMs: 30 * 60_000 }), E.isLumaLink);
        const recordFor = (link: string): EventRecord | null => recordFromFound(loop.found.get(link));
        const brief = await loadBrief(ctx.userId).catch(() => null);
        const facts = [...loop.pages.values(), ...[...loop.found.values()].map((f) => `${f.name} ${usableFacts(f)}`), brief ? JSON.stringify(brief) : ""].join("\n");
        const plan = resolvePlan(input, zone, recordFor);
        const problems = planProblems(input, plan, { facts, theirs: theirWords(), now: new Date(), recordFor });
        if (problems.length) {
          notDone(`No plan emailed: ${problems.slice(0, 3).join("; ")}.`);
          return { ok: false, error: `Not sent: ${problems.slice(0, 5).join(" | ")}. Fix these and try again, or say what you couldn't confirm.` };
        }
        const way = byEmail && byText ? "by email and by text" : byEmail ? "by email" : "by text";
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `Sent them a plan, "${plan.title}", as a one-page sheet ${way}.`);
          return { ok: true, note: "Test run: nothing was sent." };
        }
        const { buildPlanFiles, sendPlanEmail, planAsDoc } = await import("../services/planEmail.js");
        const D = await import("../services/documentDelivery.js");
        const firstName = String(rows[0]?.first_name ?? ctx.firstName ?? "");
        await holdWhileWriting(input.whileWriting);
        // The sheet; null when Chrome can't make it right now (then the text carries the plan and the PDF follows).
        const files = await buildPlanFiles(plan, { firstName, seed: `${ctx.userId.slice(0, 8)}-${Date.now().toString(36)}` });
        if (!files && !byText) {
          notDone("No plan sent: the sheet couldn't be made right now.");
          return { ok: false, error: "The sheet couldn't be made, so the email didn't go. Give them the plan in a text now; mention the email only if they asked for it by email." };
        }
        // Recorded like any document (services/deliveryReceipts.ts): it shows under "Documents you've delivered", readDocument quotes it,
        // the same plan never goes twice unless they ask for it again, and a sheet that won't render goes as text with the PDF to follow.
        const doc = planAsDoc(plan);
        const now = new Date();
        const went: string[] = [];
        let emailed = false;
        if (byEmail && files) {
          const sent = await sendPlanEmail({ to: email, files });
          if (sent.ok) {
            emailed = true;
            went.push("email");
            // Logged like a text, so a replayed turn sees it went out and doesn't send it twice.
            await logDeliveredPlan(`Co replied: [emailed a plan: ${plan.title}]`);
          }
          else notDone(`The plan email didn't go out: ${sent.why}.`);
        }
        let line: string | undefined;
        let pdfPending = false;
        let duplicateWhy: string | null = null;
        if (byText) {
          // The plan's one line, owned by the tool (Royce, 2026-10-08): Co's sentence when it holds to the rules, else "Here's the plan."
          // ("partnership_plan" only names it a plan in that line.)
          const caption = await D.captionFor({ line: input.line, title: plan.title, kind: "partnership_plan", sendAt: now, zone });
          const withEmail = emailed ? `${caption.replace(/[.?]$/, ".")} It's in your email too${files?.calendar ? ", with a calendar hold for each time" : ""}.` : caption;
          const deps = await D.deliverDepsWith({ render: async () => files?.pdf ?? null });
          const rd = await D.deliverAndRecord(doc, { userId: ctx.userId, firstName, phone: ctx.phoneNumber, zone, now, line: withEmail }, { askedForGoogle: false, source: "reply:plan", resend: D.asksToResend(theirWords()) }, { deliver: (d, t, target) => D.deliverDocument(d, t, target, deps) });
          if (rd.duplicate) duplicateWhy = String((rd.results[0] as any).why);
          else if (rd.sentOk.length) {
            went.push("text");
            line = rd.line;
            pdfPending = rd.sentOk.some((r) => r.pdfPending);
            await logDeliveredPlan(`Co replied: [sent a plan: ${plan.title}]`);
            state.sentMessages.push(`[sent a plan: ${plan.title}]`);
            if (line) state.sentMessages.push(line);
          } else notDone("The plan PDF didn't send by text.");
        }
        if (emailed) await D.recordSent(doc, { userId: ctx.userId, channel: "email", line: null, source: "reply:plan", now }).catch((err: any) => console.error("loopTools: the plan email's receipt failed (it did send):", err?.message ?? err));
        if (!went.length && duplicateWhy) {
          notDone("No plan sent: it's already theirs.");
          return { ok: false, error: `${duplicateWhy}. Answer from it instead (readDocument).` };
        }
        if (!went.length) return { ok: false, error: "The plan didn't go out. Give them the plan in a text now." };
        await recordDecision({ layer: 3, decision: "loop.emailPlan", userId: ctx.userId, outcome: "act", action: plan.title, proposal: { steps: plan.steps.length, via: went, calendar: went.includes("email") && !!files?.calendar, pdfPending } }).catch(() => {});
        const gone = went.length === 2 ? "by email and by text" : went[0] === "email" ? "by email" : "by text";
        ctx.facts?.add("did_this_turn", `Sent them a plan, "${plan.title}", as a one-page sheet ${gone}${went.includes("email") && files?.calendar ? ", with a calendar hold for each time in the email" : ""}${line ? `, with the line "${line}"` : ""}.`);
        if (pdfPending) ctx.facts?.add("did_this_turn", `The sheet for "${plan.title}" couldn't be made, so the plan went as text in this conversation, saying the PDF version will follow (it's retried on its own).`);
        await remember({ next: `plan sent: ${plan.title}` });
        const emailOnly = went.length === 1 && went[0] === "email";
        const extras = `${noEmailFallback ? "They have no email on file, so it went by text: say so, in a few words. " : ""}${downgraded ? "They hadn't asked for email, so it went by text; if they want it by email too, they can say so. " : ""}${duplicateWhy && emailed ? "It was already theirs by text, so only the email went. " : ""}${went.length < (byEmail && byText ? 2 : 1) && !duplicateWhy ? "One of the two didn't go out: say which. " : ""}`;
        return {
          ok: true,
          via: went,
          note: `${extras}${emailOnly ? `It's in their email${files?.calendar ? ", with a calendar hold for each time" : ""}: say so in one line, and don't list the steps.` : extras ? "The PDF went with its line: say only the above, in a few words, nothing else about it." : DELIVERED_NOTE}`,
        };
      },
    }),

    // A document (services/documentSheet.ts, documentDelivery.ts): a titled page Co writes from what they said, as a PDF in this
    // conversation. Phase 1; a Google Docs step slots into DELIVERERS later. Needs their own yes (the registry's `confirm`).
    // A venue brief, researched in the background (services/researchBrief.ts): this only starts it, on their ask or yes (the
    // guard's their_yes, the same as writeDocument). The task finds, builds, checks every line's source and sends the document.
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
        again: z.boolean().optional().describe("True when they want the same brief again or updated; the options are re-checked before it goes."),
      }),
      execute: async (input) => {
        // Search quality (services/researchQuality.ts): the search is built from what's known about them; a load-bearing fact
        // that isn't known is asked, never guessed. "Again" re-sends the last brief's options, re-checked.
        if (!input.again) {
          const Q = await import("../services/researchQuality.js");
          const known = { city: input.city?.trim() || (ctx.turn?.profile?.city ?? null), neighborhood: null, budget: null, date: null, start: null, headcount: input.headcount ?? null, likes: [], passes: [] };
          const q = Q.assembleQuery("venue", input.what, known);
          if (!q.ok) return { ok: false, askThem: q.question, note: "Nothing was started. Ask them this in your own words, in one line, then start it once they answer." };
        }
        const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : null;
        const start = input.start && /^\d{1,2}:\d{2}\s*[ap]m$/i.test(input.start.trim()) ? input.start.trim().toLowerCase() : null;
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was started." };
        const { startResearchBrief } = await import("../services/coTasks.js");
        const r = await startResearchBrief({
          userId: ctx.userId,
          theirWords: theirWords(),
          goal: `Venue brief: ${input.what}`.slice(0, 200),
          params: { what: input.what.slice(0, 200), date, start: date ? start : null, memberContext: (input.memberContext ?? []).map((x) => x.slice(0, 200)), wantsGoogle: GOOGLE_DOC_ASK.test(theirWords()), city: input.city?.trim() || (ctx.turn?.profile?.city ?? null), headcount: input.headcount ?? null, budget: input.budget?.slice(0, 80) ?? null, neighborhood: input.neighborhood?.slice(0, 80) ?? null, again: !!input.again },
        });
        if (!r.ok) {
          notDone(`The venue brief wasn't started: ${r.why}.`);
          return { ok: false, error: r.why };
        }
        // "Started task #N:" is the shape a promise is backed by (harness/replyGrounding.ts unbackedFollowup), so "I'll text you the brief
        // once it's ready" stands on this.
        // Their yes to a waiting [brief] offer is this brief: mark it accepted, so it doesn't hold other offers for 48h.
        await import("../services/documentOffer.js").then((m) => m.recordDocumentWritten(ctx.userId, `[brief] ${input.what}`)).catch(() => {});
        ctx.facts?.add("did_this_turn", `Started task #${r.task.id}: researching a venue brief for them in the background ("${input.what.slice(0, 80)}"${date ? `, ${date}${start ? ` from ${start}` : ""}` : ""}). It comes as a document when it's ready; nothing about options, prices or availability is known yet.`);
        return { ok: true, note: "Tell them in one line you're on it and the brief will come as a document. Don't name any option, price or availability now." };
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
    // The input and the delivery loop are shared with a task keeping a promise (services/taskTurn.ts writeDocument).
    writeDocument: tool({
      description: toolUse("writeDocument"),
      inputSchema: WRITE_DOCUMENT_INPUT.extend({
        whileWriting: z.string().optional().describe("Only if it'll take a moment and you haven't already reacted to their text with ✍️: a few words to them while the PDF is made, in your own voice."),
      }),
      execute: async (input) => {
        await seeded();
        const { resolveDocument, documentProblems } = await import("../services/documentSheet.js");
        const { deliverAndRecord, asksToResend, loadTheirWords, captionFor } = await import("../services/documentDelivery.js");
        const { recordDocumentWritten } = await import("../services/documentOffer.js");
        const doc = resolveDocument(input);
        // Their record is their words: two weeks of their texts and calls, and this message. What Co read this turn can back only
        // an event or place in Co's own marked suggestions, never a claim about them.
        const theirs = [await loadTheirWords(ctx.userId).catch(() => ""), theirWords()].join("\n");
        const read = [...loop.pages.values(), ...[...loop.found.values()].map((f) => `${f.name} ${usableFacts(f)}`)].join("\n");
        const source = { theirs, read };
        const problems = documentProblems(doc, source);
        if (problems.length) {
          notDone(`No document sent: ${problems.slice(0, 3).join("; ")}.`);
          return { ok: false, error: `Not sent: ${problems.slice(0, 5).join(" | ")}. Fix these and try again once, or tell them plainly what you couldn't back and give them the points in a text.` };
        }
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `Sent them a document, "${doc.title}", as a PDF in this conversation.`);
          return { ok: true, note: "Test run: nothing was sent." };
        }
        const { rows } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [ctx.userId]).catch(() => ({ rows: [] as any[] }));
        const zone = await (await import("../services/memberTime.js")).memberZone(ctx.userId);
        // The tool owns its one line (Co's, held to the delivery rules, or "Here's the X."): the caption on the attachment, nothing after it.
        const now = new Date();
        const line = await captionFor({ line: input.line, title: doc.title, kind: doc.kind, sendAt: now, zone });
        await holdWhileWriting(input.whileWriting);
        const to = { userId: ctx.userId, firstName: String(rows[0]?.first_name ?? ctx.firstName ?? ""), phone: ctx.phoneNumber, zone, now, line };
        // A Google Doc only when they asked for one in their own words (code checks the words, not Co's say-so), and only for a shared
        // working artifact (venue brief, partnership plan, readout) for a member with Google connected (narrowed by GOOGLE_DOCS_TEST_USERS when set); otherwise the PDF.
        // Not connected (or Docs not allowed): the PDF goes instead, and Co offers to connect Google.
        // Recorded (services/deliveryReceipts.ts): a revision goes as the next version with its change line; the same artifact never twice.
        const rd = await deliverAndRecord(doc, to, { saveTo: input.saveTo, askedForGoogle: GOOGLE_DOC_ASK.test(theirWords()), source: "reply", revises: input.revises ?? null, changed: input.changed ?? null, resend: asksToResend(theirWords()) });
        const { results, sentOk, googleRefused, googleMissing } = rd;
        if (rd.duplicate) {
          notDone(`No document sent: it's already theirs (doc #${rd.duplicate.id}).`);
          return { ok: false, error: `${(results[0] as any).why}. Answer from it instead (readDocument).` };
        }
        if (!sentOk.length) {
          const why = results.map((r) => (r.ok ? "" : r.why)).filter(Boolean).join("; ");
          notDone(`No document sent: ${why}.`);
          return { ok: false, error: `${why}. Give them the points in a text now; mention the document only to say it isn't there yet.` };
        }
        const sent = { ok: true as const, via: sentOk.map((r) => r.via).join("+"), link: sentOk.find((r) => r.link)?.link ?? null };
        const asText = sentOk.some((r) => r.pdfPending);
        if (asText) ctx.facts?.add("did_this_turn", `The PDF of "${doc.title}" failed, so its content went as text in this conversation, saying the PDF version will follow (it's retried on its own).`);
        if (rd.version > 1) ctx.facts?.add("did_this_turn", `This was version ${rd.version} of "${doc.title}", sent with the line "${rd.line}".`);
        await logDeliveredPlan(`Co replied: [sent a document: ${doc.title}]`);
        state.sentMessages.push(`[sent a document: ${doc.title}]`);
        if (rd.line) state.sentMessages.push(rd.line);
        await recordDocumentWritten(ctx.userId, doc.title).catch(() => {});
        await recordDecision({ layer: 3, decision: "loop.writeDocument", userId: ctx.userId, outcome: "act", action: doc.title, proposal: { sections: doc.sections.length, via: sent.via } }).catch(() => {});
        const asPdf = sentOk.some((r) => r.via === "pdf_text");
        const asDoc = sentOk.some((r) => r.via === "google_docs");
        const sharedLink = sentOk.some((r) => r.via === "google_docs" && r.shared);
        // The same Doc, written in place: the text said only what changed; the link they have still opens it (rule 3, 2026-10-11).
        const inPlace = sentOk.some((r) => r.via === "google_docs" && r.updatedInPlace);
        const newDoc = sentOk.find((r) => r.via === "google_docs" && r.newDocBecause)?.newDocBecause;
        ctx.facts?.add("did_this_turn", `Sent them a document, "${doc.title}" (${doc.sections.length} sections)${asDoc ? `, as a Google Doc in their own Drive (${inPlace ? `updated in place, same link: ${sent.link}` : `link texted: ${sent.link}; ${sharedLink ? "anyone with the link can open and edit it" : "only they can open it"}`})` : ""}${asDoc && asPdf ? " and" : ""}${asPdf ? " as a PDF in this conversation" : ""}${rd.line ? `, with the line "${rd.line}"` : ""}.`);
        await remember({ next: `document sent: ${doc.title}` });
        const extras = `${rd.docBecamePdf ? "The earlier version was a Google Doc, but this one couldn't go to Google, so it went as a PDF, and the text said so. " : ""}${googleRefused === "kind" ? "They asked for a Google Doc, but a Google Doc is only for a venue brief, partnership plan or readout, so this went as a PDF: say so in a line. " : googleRefused === "not_yet" ? "They asked for a Google Doc, but Google Docs aren't open to them yet, so it went as a PDF: say so in a line, without promising when. " : ""}${googleMissing ? "Their Google isn't connected with Docs allowed, so it went as a PDF: say so in a line and offer to send the link to connect Google (googleConnection). " : ""}`;
        return {
          ok: true,
          via: sent.via,
          note: `${inPlace ? "The Google Doc they already have was updated in place (same link), and the text said what changed. Add nothing about it. " : asDoc ? `The Google Doc is in their Drive and its link went with its line; ${sharedLink ? "anyone with the link can open and edit it, and the text told them so" : "only they can open it for now, and the text told them so"}. ${newDoc ? `It's a new Doc with a new link, and the text said why ("${newDoc}"). ` : ""}` : ""}${extras}${extras ? "Say only that, in a few words, nothing else about it." : DELIVERED_NOTE}`,
        };
      },
    }),
    // A delivered document's own words (services/deliveryReceipts.ts), for a question or a change request about it: answers come
    // from what was sent, quoted, never a fresh generation.
    readDocument: tool({
      description: toolUse("readDocument"),
      inputSchema: z.object({
        doc: z.number().int().describe("Its doc number from \"Documents you've delivered\"."),
        about: z.string().optional().describe("What they asked about, in their words, to find the section."),
      }),
      execute: async ({ doc: id, about }) => {
        const R = await import("../services/deliveryReceipts.js");
        const rec = await R.pgReceipts.get(ctx.userId, id).catch(() => null);
        if (!rec) return { ok: false, error: `There's no document #${id} on record for them. Say plainly you don't have it.` };
        const section = about ? R.findSection(rec.doc, about) : null;
        return {
          ok: true,
          title: rec.title,
          version: rec.version,
          delivered: rec.deliveredAt.toISOString(),
          section,
          sections: R.sectionsOf(rec.doc),
          note: `Answer from this text only. Quote the words of the section they asked about, in quotation marks, then answer. If it isn't in the document, say so. If they want it changed, write the new version with writeDocument (revises: ${rec.id}, changed: what changed), starting from these words.`,
        };
      },
    }),

    // A document from a PDF they sent (services/memberFiles.ts, board item 4). Drafted in its own call from their file and their words,
    // so the file's contents never enter this conversation: Co doesn't see them, and every record of it here says only "their file #n"
    // (no title, no words of it), so nothing from a file reaches their memory, their profile, or anything another member's matching reads.
    writeFromFile: tool({
      description: toolUse("writeFromFile"),
      inputSchema: z.object({
        file: z.number().int().positive().optional().describe("The file's number (#2 is 2) when they name one; leave it out for their newest."),
        kind: z.enum(["venue_brief", "partnership_plan", "readout", "other"]).optional().describe("What it is for: venue_brief, partnership_plan, readout, or other (anything for themselves)."),
        want: z.string().describe("What they asked for, in a few of their own words."),
        saveTo: z.enum(["pdf", "google_doc", "both"]).optional().describe("Leave this out for a PDF in this conversation. Only when they ask for a Google Doc in their own words: google_doc (or both)."),
      }),
      execute: async (input) => {
        const F = await import("../services/memberFiles.js");
        const { resolveDocument, documentProblems } = await import("../services/documentSheet.js");
        const { docTargets, loadTheirWords } = await import("../services/documentDelivery.js");
        const deliverDocument = F.fileSteps.deliver;
        // Only this member's own file, by their own number.
        const file = await F.fileText(ctx.userId, input.file ?? null);
        if (!file) {
          const have = await F.filesOnFile(ctx.userId).catch(() => []);
          return { ok: false, error: have.length ? `No file #${input.file} on file for them; their files are ${have.map((f) => `#${f.n} (sent ${f.sentOn})`).join(", ")}. Ask which one.` : "They have no file on file with you. Tell them to text you the PDF first." };
        }
        const theirs = [await loadTheirWords(ctx.userId).catch(() => ""), theirWords()].join("\n");
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `Sent them a document made from their file #${file.n}.`);
          return { ok: true, note: "Test run: nothing was drafted or sent." };
        }
        const draft = await F.fileSteps.draft({ fileText: file.text, theirWords: theirs, kind: input.kind ?? "other", want: input.want });
        if (!draft) return { ok: false, error: "The document couldn't be drafted. Give them what you can from their file in a text now, and never ask them to try again." };
        const doc = resolveDocument(draft);
        // Rule 4: the same grounding as writeDocument, with their file as part of their own record. Nothing of either is shown to Co.
        const problems = documentProblems(doc, { theirs: `${theirs}\n${file.text}` });
        if (problems.length) {
          notDone(`No document sent from their file #${file.n}: it didn't hold to their file and words.`);
          return { ok: false, error: "The draft leaned on things that weren't in their file or their words, so it wasn't sent. Say you couldn't make it hold to what they gave you, and ask what they want it to cover." };
        }
        const { rows } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [ctx.userId]).catch(() => ({ rows: [] as any[] }));
        const to = { userId: ctx.userId, firstName: String(rows[0]?.first_name ?? ctx.firstName ?? ""), phone: ctx.phoneNumber, zone: null };
        const { targets, googleRefused } = docTargets({ userId: ctx.userId, kind: doc.kind, saveTo: input.saveTo, askedForGoogle: GOOGLE_DOC_ASK.test(theirWords()) });
        const results: Awaited<ReturnType<typeof deliverDocument>>[] = [];
        for (const target of targets) {
          const r = await deliverDocument(doc, to, target);
          results.push(r);
          if (!r.ok && target === "google_docs" && (r.notConnected || r.notAllowed) && !targets.includes("pdf_text")) results.push(await deliverDocument(doc, to, "pdf_text"));
        }
        const sentOk = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
        if (!sentOk.length) {
          notDone(`No document sent from their file #${file.n}.`);
          return { ok: false, error: "It didn't send. Give them the content in a text now, and never ask them to try again." };
        }
        const via = sentOk.map((r) => r.via).join("+");
        const line = `[sent a document made from their file #${file.n}]`;
        await logDeliveredPlan(`Co replied: ${line}`);
        state.sentMessages.push(line);
        await recordDecision({ layer: 3, decision: "loop.writeFromFile", userId: ctx.userId, outcome: "act", action: `file #${file.n}`, proposal: { via, kind: doc.kind } }).catch(() => {});
        ctx.facts?.add("did_this_turn", `Sent them a document made from their file #${file.n}${sentOk.some((r) => r.via === "google_docs") ? ", as a Google Doc in their own Drive" : ""}${sentOk.some((r) => r.via === "pdf_text") ? ", as a PDF in this conversation" : ""}.`);
        await remember({ next: `document sent from their file #${file.n}` });
        return {
          ok: true,
          via,
          note: `It's sent. ${googleRefused === "kind" ? "A Google Doc is only for a venue brief, partnership plan or readout, so it went as a PDF: say so in a line. " : googleRefused === "not_yet" ? "Google Docs aren't open to them yet, so it went as a PDF: say so in a line. " : ""}Say in one line that it's there and you'll change anything they want. You haven't seen what it says, so don't describe it.`,
        };
      },
    }),

    // Their files, gone on their ask (services/memberFiles.ts): code checks their words asked for it, not Co's say-so.
    deleteMyFiles: tool({
      description: toolUse("deleteMyFiles"),
      inputSchema: z.object({ file: z.number().int().positive().optional().describe("The file's number when they name one; leave it out to delete all of them.") }),
      execute: async (input) => {
        const F = await import("../services/memberFiles.js");
        if (!F.DELETE_ASK.test(theirWords())) return { ok: false, error: "Not done: they haven't asked to delete their files in this message. Only delete when they ask." };
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was deleted." };
        const n = await F.deleteFiles(ctx.userId, input.file ?? null);
        await recordDecision({ layer: 3, decision: "loop.deleteMyFiles", userId: ctx.userId, outcome: "act", action: input.file ? `file #${input.file}` : "all", proposal: { deleted: n } }).catch(() => {});
        ctx.facts?.add("did_this_turn", n ? `Deleted ${n === 1 ? "one of their files" : `${n} of their files`}${input.file ? ` (#${input.file})` : ""}; ${n === 1 ? "it's" : "they're"} gone.` : "Looked for their files to delete and found none.");
        return { ok: true, deleted: n, note: n ? "Say plainly what was deleted and that it's gone." : "There was nothing to delete: say so." };
      },
    }),

    // The offer (services/documentOffer.ts): code re-checks the moment and records that Co offered, so it is never offered twice;
    // Co writes the offer itself, in its own words.
    offerDocument: tool({
      description: toolUse("offerDocument"),
      inputSchema: z.object({}),
      execute: async () => {
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was recorded. Make the offer in your own words." };
        const { loadOfferState, documentOfferDue, recordOffer } = await import("../services/documentOffer.js");
        const due = documentOfferDue(await loadOfferState(ctx.userId));
        if (!due.due) return { ok: false, error: `Don't offer a document now: ${due.why}.` };
        await recordOffer(ctx.userId, due.topic);
        ctx.facts?.add("did_this_turn", `Offered to write up "${due.topic}" as a document; waiting on their answer.`);
        return { ok: true, topic: due.topic, note: "Recorded. Now make the offer in your reply, in your own words, as one light line about this. Don't write the document until they say yes." };
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
