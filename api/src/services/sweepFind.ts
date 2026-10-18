// The daily sweep's finding, in Co's own loop (2026-10-01: "one way of finding
// things"). For one member's open ask, Co uses the same tools as its replies
// (event search with Co's events, the public feed and openings; verified web
// search; recent X posts; page reads) and keeps up to three things worth texting
// them about, each with its reason. No search brief, no relevance gate, no
// separate fit read: Co judges with the whole person in view. Code guards facts
// only, through the same gate as before (sold out, past, too far, the name and
// any date on the thing's own record).
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { gateMatches, START_LEAD_MINUTES, type GatedOut } from "../harness/matchGate.js";
import { localDay } from "./memberTime.js";
import { avoidFor, limitsGate } from "./memberLimits.js";
import type { KnowledgeSection, MemberKnowledge } from "./memberKnowledge.js";
import { eventCandidates, reserveXSearch, type TierMatch } from "./tieredRecommendation.js";
import { memberTerms, QueryLedger, SWEEP_QUERY_RULES } from "./sweepQuery.js";
import { skipsPaidSearch } from "./testMemberSpend.js";
import { withMember } from "./llmUsage.js";

export const SWEEP_BUDGET = { steps: 7, allSourcesSteps: 9, webQueries: 2, xSearches: 1, pageReads: 3, keep: 3 };

// X in the sweep (2026-10-07). After the old Tier 3 pipeline went (6f1530b),
// X was one optional tool and the model wrote literal queries ("Peerspace NoPa
// venue"): 10 of 17 searches came back empty, the rest spam, and nothing from X
// was kept after 2026-09-28. This puts back what the old pipeline's query step
// knew (proposeOpportunityQuery): search X once for the asks X covers, written
// the way such posts are written, with OR for the words people post with. Co
// still decides; this is guidance, not a rule in code.
export const SWEEP_X_GUIDANCE = `X is where programs and gatherings are announced first. When the ask is one X covers (a program, cohort, accelerator, fellowship, residency or grant taking applications; an open call or a speaking or demo slot; founder or builder gatherings; investors or people looking for exactly what they want), search X once in this sweep. Write the query the way those posts are written, not the way they asked: the kind of thing, with OR for the real words people post with, grouped in parentheses, for example (accelerator OR cohort OR fellowship) (applications open OR now accepting OR apply). Keep it broad: two groups, the kind of thing and how it's announced, and a third only for a stage or field posts would carry (pre-seed, AI, fintech); never four. Their niche words make it come back empty; you judge the 20 posts that come back. Leave out their city and any year they didn't say, because posts rarely name either and those words make you miss them. Don't use X for venues, vendors, services or plain things to do; posts don't list those. And don't spend it on something that isn't a thing to find at all (a plan or draft Cue owes them, a status, a deal they're working on): skip X for that sweep.`;

// Every place Co can look, named in the brief (2026-10-08: sweeps ended without
// ever looking at Co's own events for an event-shaped ask). Guidance, not a
// forced call: Co still picks the tools.
export const SWEEP_TIERS = `Where you can look, in order: (1) Noise's own events and (2) the public event feed and openings Cue already found, both through searchEvents; (3) the web (webSearch) and X (searchPosts) for programs, places and people. When the ask is something to go to or join (an event, a dinner, a meetup, a class, a community gathering), look at searchEvents before you finish, even if you expect it thin: Noise's own events come first when they fit.`;

// The 9am daily sweep looks in all three places (Royce, 2026-10-13: "Search all three sources (events, web, X) for every open ask ...
// No per-ask source selectivity"): Co's own events and the public feed (searchEvents), the web (webSearch) and X (searchPosts). Co
// writes each query and decides what to keep; code only makes sure no place is skipped (sweepFind's prepareStep, opts.allSources):
// a place Co hasn't called yet is the next step's one tool, in the tiers' order. A call that's refused or fails still counts as
// looked at and is reported with its reason, never retried in a loop. The hourly sweeps keep Co's own choice of places.
export const SWEEP_SOURCES = [
  { source: "events", tool: "searchEvents" },
  { source: "web", tool: "webSearch" },
  { source: "x", tool: "searchPosts" },
] as const;
export type SweepSource = (typeof SWEEP_SOURCES)[number]["source"];
// Pure: the tool the next step must call, or null when every place has been looked at (or too few steps are left to also keep).
export function nextRequiredSource(called: ReadonlySet<SweepSource>, stepNumber: number, steps: number = SWEEP_BUDGET.allSourcesSteps): (typeof SWEEP_SOURCES)[number]["tool"] | null {
  const missing = SWEEP_SOURCES.filter((s) => !called.has(s.source));
  if (!missing.length || stepNumber >= steps - 2) return null;
  return missing[0].tool;
}
export const SWEEP_ALL_SOURCES = `This is the morning sweep, and it looks in all three places: searchEvents, webSearch and searchPosts, each at least once. When the ask is one X rarely covers, still search X once, broadly, for the kind of thing it is.`;
// The morning sweep looks for what's new (Royce, 2026-10-13: "new stuff posts overnight ... Otherwise it re-finds the same pages every
// morning"): X only returns the last RECENT_HOURS, the web search favors what was posted in them, and Co sees what it already looked
// at for this ask on earlier mornings.
export const RECENT_HOURS = 48;
export const SEEN_BEFORE_CAP = 25;
export const SWEEP_RECENT = `New things post overnight. Write your queries for what was announced, listed or opened in the last day or two (just announced, new dates, applications now open), and favor results that are new.`;
// Pure: the morning sweep's line on what it already looked at for this ask, or "" when nothing was.
export function seenBeforeLine(seen: { name: string; url: string }[]): string {
  if (!seen.length) return "";
  return `Already looked at on earlier mornings for this ask, so find what's new instead (one of these only if something about it changed, like a new date): ${seen.slice(0, SEEN_BEFORE_CAP).map((s) => `${s.name} (${s.url})`).join("; ")}.`;
}
// What earlier morning sweeps looked at for this ask (their sweep.find records, last 14 days): kept and passed over, by link.
export async function seenBefore(userId: string, askText: string, db: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> }): Promise<{ name: string; url: string }[]> {
  const { rows } = await db.query(
    `SELECT proposal->'passedOver' AS passed, proposal->'keptBy' AS kept FROM harness_decisions
      WHERE decision = 'sweep.find' AND user_id = $1 AND proposal->>'ask' = $2 AND (proposal->>'allSources')::boolean IS TRUE
        AND created_at > NOW() - INTERVAL '14 days' ORDER BY created_at DESC LIMIT 14`,
    [userId, askText.slice(0, 200)],
  );
  const out = new Map<string, string>();
  for (const r of rows) for (const x of [...(Array.isArray(r.kept) ? r.kept : []), ...(Array.isArray(r.passed) ? r.passed : [])]) {
    if (typeof x?.url === "string" && x.url && !out.has(x.url)) out.set(x.url, String(x.name ?? "").slice(0, 60));
  }
  return [...out].map(([url, name]) => ({ name, url }));
}

// What Co looked at and passed over, for the log (sweep.find), so "why did
// nothing from X go out" can be answered from the record.
export const SWEEP_PASS_TOOL =
  "Note what you looked at closely and decided against, each with its link and a few words on why (wrong kind, already past, spam or promotion, not for them, too far). Call it once, alongside your keeps, when you're done. Nothing is sent; it's how Cue's choices are reviewed.";
export const PASSED_OVER_CAP = 10;

// query: the search that brought it back (the tuning log: which phrasings produce keeps, 2026-10-08).
export type LookedAt = { source: "x" | "web" | "events"; name: string; url: string; query?: string };
export type PassedOver = LookedAt & { why: string };

// Everything looked at but not kept, X first then web then events, with Co's
// reason when it gave one, else the gate's, else "not kept". Pure.
export function passedOver(lookedAt: LookedAt[], keptUrls: Set<string>, reasons: Map<string, string>, cap = PASSED_OVER_CAP): PassedOver[] {
  const order = { x: 0, web: 1, events: 2 } as const;
  const seen = new Set<string>();
  return lookedAt
    .filter((l) => !keptUrls.has(l.url) && !seen.has(l.url) && seen.add(l.url))
    .sort((a, b) => order[a.source] - order[b.source] || Number(reasons.has(b.url)) - Number(reasons.has(a.url)))
    .slice(0, cap)
    .map((l) => ({ source: l.source, name: l.name.slice(0, 80), url: l.url, why: (reasons.get(l.url) ?? "not kept").slice(0, 120), ...(l.query ? { query: l.query } : {}) }));
}

// An X search that failed, said by kind and status only (never the response
// body or a token), for the log and for Co.
export function xFailure(err: unknown): { kind: "not_configured" | "auth" | "rate_limited" | "server" | "error"; status: number | null } {
  const msg = String((err as any)?.message ?? err ?? "");
  if (/not configured/i.test(msg)) return { kind: "not_configured", status: null };
  const m = msg.match(/\((\d{3})\)/);
  const status = m ? Number(m[1]) : null;
  if (status === 401 || status === 403) return { kind: "auth", status };
  if (status === 429) return { kind: "rate_limited", status };
  if (status !== null && status >= 500) return { kind: "server", status };
  return { kind: "error", status };
}

// What Co is told when X failed: not "no posts", which reads as "nothing out there".
export function xFailedNote(f: ReturnType<typeof xFailure>): string {
  const why = f.kind === "rate_limited" ? "X is rate limiting us right now" : f.kind === "auth" || f.kind === "not_configured" ? "Cue's X access isn't working right now" : "X didn't answer";
  return `The X search failed (${why}), so there are no posts to judge. This says nothing about whether posts exist. Use webSearch for this ask instead.`;
}

export const SWEEP_X_TOOL =
  "Recent X posts (the last 7 days), for what's announced there first: programs and cohorts taking applications, open calls, fellowships, residencies, grants, founder or builder gatherings, investors or people looking for what they want. One search a sweep. Write it the way such posts are written, broad: two or three OR-grouped sets of synonyms in parentheses, e.g. (accelerator OR cohort OR fellowship) (applications open OR now accepting OR apply by). No niche words, no city, no year, no venue or vendor names. Each post comes with its own links expanded; when a post points to the program's own page, keep that link rather than the post.";

// city: where this want is (services/wantPlace.ts), or their home city when it has no place of its own; homeCity: where they live.
export type SweepCandidate = { userId: string; firstName: string; askText: string; fromProfile?: boolean; city: string | null; homeCity?: string | null };

// What the sweep reads about them: the member record (services/memberKnowledge.ts), the same one the picker, dispatch, tasks and
// replies read (Phase A1, 2026-10-10: the sweep ran on a snapshot paragraph, a regex guess at the room they want from their feelings,
// and 15 sent names; it never saw stated taste, the avoid list, availability, corrections, lessons, goal states or claims).
export const SWEEP_KNOWLEDGE: readonly KnowledgeSection[] = ["goals", "asks", "delivered", "lessons", "corrections", "preferences", "claims", "restraint", "person", "limits"];
export const SWEEP_RECORD_LIMITS = { person: 1800, goals: 6, asks: 6, shown: 15, learned: 8, claims: 6 } as const;

export type SweepRecord = {
  person: string;
  goals: string[];
  goalsPast: string[];
  otherAsks: string[];
  statedTaste: string[];
  observedTaste: string | null;
  // The kinds ruled out that apply to this ask (avoidFor), and when they're usually free.
  avoid: string[];
  availability: string | null;
  learned: string[];
  claims: string[];
  feeling: string | null;
  frustratedWithCo: boolean;
  shown: string[];
  // Every goal's words, for keeping names out of queries (memberTerms), done ones too.
  goalWords: string[];
};

// A record with nothing in it (a member Co knows little about yet).
export function emptySweepRecord(): SweepRecord {
  return { person: "", goals: [], goalsPast: [], otherAsks: [], statedTaste: [], observedTaste: null, avoid: [], availability: null, learned: [], claims: [], feeling: null, frustratedWithCo: false, shown: [], goalWords: [] };
}

// Pure: the record, read for one ask's sweep.
export function sweepRecord(k: MemberKnowledge, askText: string): SweepRecord {
  const L = SWEEP_RECORD_LIMITS;
  const same = (a: string) => a.trim().toLowerCase() === askText.trim().toLowerCase();
  return {
    person: (k.person?.text ?? "").slice(0, L.person),
    goals: k.goals.filter((g) => g.state === "active").map((g) => g.text).slice(0, L.goals),
    goalsPast: k.goals.filter((g) => g.state !== "active").map((g) => g.text).slice(0, L.goals),
    otherAsks: k.asks.filter((a) => !same(a.text)).map((a) => a.text).slice(0, L.asks),
    statedTaste: k.preferences.filter((p) => p.source === "stated").map((p) => p.text),
    observedTaste: k.preferences.filter((p) => p.source === "taste").map((p) => p.text).join(" ") || null,
    avoid: avoidFor(k.limits?.avoid ?? [], askText),
    availability: k.limits?.availability ?? null,
    learned: [...k.corrections.map((c) => `Corrected ${c.field}: ${c.now ?? "(removed)"}`), ...k.lessons.map((l) => `Lesson: ${l.text}`)].slice(0, L.learned),
    claims: k.claims.map((c) => `${c.text}${c.expiresOn ? ` (until ${c.expiresOn})` : ""}`).slice(0, L.claims),
    feeling: k.restraint?.feeling ?? null,
    frustratedWithCo: !!k.restraint?.frustratedWithCo, // mood: carries the read (search wider, never less)
    shown: k.delivered.map((d) => d.what).slice(0, L.shown),
    goalWords: k.goals.map((g) => g.text),
  };
}

export function sweepPrompt(c: SweepCandidate, o: { today: string; record: SweepRecord; allSources?: boolean; seen?: { name: string; url: string }[] }): string {
  const r = o.record;
  const section = (title: string, lines: string[]) => (lines.length ? `${title}\n${lines.map((l) => `- ${l}`).join("\n")}\n` : "");
  return `You're Cue, finding things worth texting ${c.firstName} about over the next couple of weeks. Nothing is sent now: what you keep goes into a queue, and Cue texts at most one a day, so keep only what genuinely fits.

${c.fromProfile ? "They haven't asked for something specific; this is what they've shared they want" : "What they asked Cue to keep an eye out for"}: "${c.askText}"
${c.homeCity !== undefined && c.city && c.homeCity && c.city.toLowerCase() !== c.homeCity.toLowerCase() ? `Where this is for: ${c.city} (they live in ${c.homeCity}; for this, look in ${c.city}).` : `Where they are: ${c.city ?? "unknown"}.`} Today: ${o.today}.

What Cue knows about them (their record):
${r.person || "(little known yet)"}
${section("Where they're headed now:", r.goals)}${section("Goals since done or set aside (history, not what to look for):", r.goalsPast)}${section("Their other open asks (each gets its own sweep; context only):", r.otherAsks)}${section("What they've corrected or Cue has learned (only the corrected version exists):", r.learned)}${section("What they've told Cue, still holding:", r.claims)}${r.observedTaste ? `How what Cue sent has landed: ${r.observedTaste}\n` : ""}${r.feeling ? `How they've been: ${r.feeling} (this shapes how Cue says it, never whether they hear about something)\n` : ""}${r.frustratedWithCo ? "They've been frustrated with what Cue has found: look wider and try harder.\n" : ""}
${r.statedTaste.length ? `THE KIND OF ROOM THEY'VE TOLD CO THEY WANT (their own words, newest first; the strongest signal you have about fit):\n${r.statedTaste.map((t) => `- ${t}`).join("\n")}\nJudge every result against it and give each keep a taste: "matches", "neutral" or "clashes". Keep the ones that match first. Something that clashes isn't kept.\n` : ""}${r.avoid.length ? `They told Cue to stop suggesting these kinds of things: ${r.avoid.map((a) => `"${a}"`).join(", ")}. Never search for them and never keep one, judged by its main activity (a chess night full of founders is a chess night).\n` : ""}${r.availability ? `When they've said they're free, in their words: "${r.availability}". Weigh an event's day and time against it as they said it: a limit when they said only, a leaning when they said more or prefer.\n` : ""}Already sent to them recently (don't keep these again): ${r.shown.length ? r.shown.join("; ") : "(nothing)"}

Search only for this one ask. Other things they're working on (in who they are) are context for judging fit, not things to look for in this sweep, because each ask gets its own sweep (2026-10-01: a founder-events sweep kept a venue from another ask).
Who a thing is for matters. Read each one for the group it speaks to (a hike club for women, a men's group, a moms' brunch) and say it in the audience field of keep. Never hold something back for who you assume they are: you only know what they have said in their own words, never from a name or a voice. A group-aimed thing fits them when what you know says they belong; when you don't know, you may still keep it if it fits strongly, and Cue will say plainly who it's for so they can tell. Prefer an open event when two fit about equally.

Look with the tools: events first when it's something to go to, the web for programs, places and people. ${SWEEP_TIERS} ${SWEEP_X_GUIDANCE}${o.allSources ? ` ${SWEEP_ALL_SOURCES} ${SWEEP_RECENT}${o.seen?.length ? ` ${seenBeforeLine(o.seen)}` : ""}` : ""}
${SWEEP_QUERY_RULES}
Judge each result yourself against what they asked and who they are; results are candidates, not answers. Everything you keep goes to a member of a private club, so it has to be real and worth their time: a named thing with a way in (who runs it, how to apply or join), never a token or coin promotion, a giveaway, engagement bait or a bare headline. Keep at most ${SWEEP_BUDGET.keep} with keep(), each with one plain sentence on why it fits them, tied to something in their record. Keeping nothing is fine when nothing fits. When you're done, note in skip() the results you looked at and passed on, each with a few words on why, in the same step as your keeps. Then stop.`;
}

// searched: the sweep really looked: a search came back, or nothing stood in its way (it chose not to search, or its queries were
// refused for how they were written, which is the ask's own run). Not when a budget was used up or a source failed and nothing came
// back: that's an outage, not an empty run (services/workingSet.ts empty runs; review and re-review of #133).
// What a sweep reports about the places it looked (the daily sweep's summary): which were searched, and why any wasn't.
export type SweepSources = { events: boolean; web: boolean; x: boolean; failures: string[] };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// Pure: a find's date as Co read it, kept only when its own text shows that day: the month (its name, its first three letters, or as a
// number) next to the day, and not before today. Anything else is no date.
export function shownDate(date: string | undefined | null, text: string, today: string | null): string | null {
  const m = String(date ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, , mm, dd] = m;
  const month = Number(mm), day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (today && `${m[1]}-${mm}-${dd}` < today) return null;
  const t = text.toLowerCase();
  // A year it names next to the day has to be this one ("Oct 17, 2025" isn't 2026-10-17).
  if (new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?,?\\s+(?!${m[1]}\\b)(19|20)\\d{2}\\b`).test(t) && !new RegExp(`\\b${m[1]}\\b`).test(t)) return null;
  const name = MONTHS[month - 1];
  const abbr = name === "september" ? "sept?" : name.slice(0, 3);
  const named = new RegExp(`\\b(${name}|${abbr})\\.?\\s+${day}(st|nd|rd|th)?\\b|\\b${day}(st|nd|rd|th)?\\s+(of\\s+)?(${name}|${abbr})\\b`);
  const numeric = new RegExp(`\\b0?${month}/0?${day}\\b|\\b${m[1]}-${mm}-${dd}\\b`);
  return named.test(t) || numeric.test(t) ? `${m[1]}-${mm}-${dd}` : null;
}

// Every model call inside is this member's in llm_usage (services/llmUsage.ts withMember, cost per member 2026-10-23).
export async function sweepFind(...a: Parameters<typeof sweepFindInScope>): ReturnType<typeof sweepFindInScope> {
  return withMember(a[0].userId, () => sweepFindInScope(...a));
}
async function sweepFindInScope(c: SweepCandidate, opts: { timezone?: string | null; knowledge?: (userId: string) => Promise<MemberKnowledge>; allSources?: boolean; today?: string } = {}): Promise<{ matches: TierMatch[]; did: string[]; searched: boolean; frustratedWithCo: boolean; sources?: SweepSources }> {
  const did: string[] = [];
  // A test member's sweep spends nothing: no search loop, no paid search (services/testMemberSpend.ts; the live-test member still runs).
  if (await skipsPaidSearch(c.userId, "sweep.find")) return { matches: [], did: ["skipped: test member (no paid search)"], searched: false, frustratedWithCo: false };
  // The record, read once. A record that can't be read (a failed name read fails closed) means no sweep: the avoid list and taste
  // couldn't be applied, so nothing is searched, and it isn't an empty run.
  const read = opts.knowledge ?? (async (userId: string) => (await import("./memberKnowledge.js")).memberKnowledge(userId, { include: SWEEP_KNOWLEDGE }));
  const k = await read(c.userId).catch((err: any) => {
    console.error("sweepFind: member record read failed (no sweep this run):", err?.message ?? err);
    return null;
  });
  // Limits that couldn't be read (null, not an empty list) can't be applied: no sweep either.
  if (!k || !k.limits) return { matches: [], did, searched: false, frustratedWithCo: false };
  const record = sweepRecord(k, c.askText);
  // The morning sweep: what it already looked at for this ask on earlier mornings (a read that fails leaves the list empty, logged).
  const seen = opts.allSources
    ? await import("../db/db.js").then((m) => seenBefore(c.userId, c.askText, { query: (sql, args) => m.default.query(sql, args as any[]) })).catch((err: any) => {
        console.error("sweepFind: reading what earlier mornings looked at failed (non-fatal):", err?.message ?? err);
        return [] as { name: string; url: string }[];
      })
    : [];
  let searched = false;
  let blocked = false;
  const found = new Map<string, TierMatch>();
  const kept: TierMatch[] = [];
  let webQueries = 0;
  let xSearches = 0;
  let xPosts = 0;
  let reads = 0;
  // What Co looked at (for the log), its reasons for passing, and any X failure.
  const lookedAt: LookedAt[] = [];
  const passReasons = new Map<string, string>();
  let xError: ReturnType<typeof xFailure> | null = null;
  // Every query, run or refused (sweepQuery.ts): the member never in it, simple, phrased for its source; logged with its outcomes.
  const ledger = new QueryLedger(memberTerms({ firstName: c.firstName, goals: record.goalWords, except: c.askText }), c.askText, record.avoid);
  // A page kept in place of the post that pointed to it: the post counts as kept too.
  const postOf = new Map<string, string>();
  // The places Co has called this sweep (refused or failed calls count), for SWEEP_SOURCES.
  const called = new Set<SweepSource>();
  // Why a place came back with nothing searched (refused, budget, outage), for the daily sweep's report.
  const sourceFailures: string[] = [];
  const exaAdded: { added: number; offered: number; error?: string }[] = [];
  const tools = {
    searchEvents: tool({
      description: "Noise's own events, the public event feed, and openings Cue already found, in the days you name. Put `when` in plain words (\"next two weeks\", \"this weekend\").",
      inputSchema: z.object({ what: z.string(), when: z.string().optional() }),
      execute: async ({ what, when }) => {
        called.add("events");
        const bad = ledger.check("events", what);
        if (bad.length) {
          sourceFailures.push(`events: query refused (${ledger.refusal(what, bad).slice(0, 160)})`);
          return { ok: false, error: ledger.refusal(what, bad) };
        }
        did.push(`events: ${what}${when ? `, ${when}` : ""}`);
        const [r, openings] = await Promise.all([
          eventCandidates(what, c.city, { when: when ?? null, userId: c.userId, timezone: opts.timezone ?? null, limit: 8, source: "sweep" }),
          import("./eventSurfacingSweep.js").then((m) => m.alreadyFoundOpenings(c.userId)).catch(() => [] as TierMatch[]),
        ]).catch((err) => {
          blocked = true;
          sourceFailures.push(`events: the search failed (${String(err?.message ?? err).slice(0, 120)})`);
          throw err;
        });
        for (const { match } of r.candidates) if ("url" in match && match.url) {
          found.set(match.url, match);
          lookedAt.push({ source: "events", name: match.name, url: match.url, query: what });
        }
        ledger.ran("events", what, r.candidates.length);
        // What Exa added to Luma's feed on this search (services/lumaViaExa.ts), for the sweep's log.
        if (r.viaExa) exaAdded.push({ added: r.viaExa.added, offered: r.viaExa.offered, ...(r.viaExa.error ? { error: r.viaExa.error } : {}) });
        searched = true;
        for (const m of openings) if ("url" in m && m.url) found.set(m.url, m);
        return {
          events: r.candidates.map(({ match, lines }) => ({ link: "url" in match ? match.url : null, details: lines })),
          openings: openings.slice(0, 4).map((m) => ({ link: (m as any).url, name: m.name, details: m.reason })),
          note: r.inWindow < 4 ? `${r.viaExa?.nearby ? "Luma is" : "The feed is"} thin here; webSearch may find more.` : undefined,
        };
      },
    }),
    webSearch: tool({
      description: `Search the web; results come back checked against their own pages. Up to ${SWEEP_BUDGET.webQueries} short queries in all.`,
      inputSchema: z.object({ queries: z.array(z.string()).min(1).max(2) }),
      execute: async ({ queries: asks }) => {
        called.add("web");
        const refusals: string[] = [];
        // A query that's only too tight runs loosened, once, and the loosening is logged (sweepQuery.ts checkOrLoosen).
        const loosenedFrom = new Map<string, string>();
        const good = asks.flatMap((q) => {
          const r = ledger.checkOrLoosen("web", q, [c.city ?? ""]);
          if (r.bad.length) {
            refusals.push(ledger.refusal(q, r.bad));
            return [];
          }
          if (r.loosenedFrom) loosenedFrom.set(r.query, r.loosenedFrom);
          return [r.query];
        });
        if (!good.length) {
          sourceFailures.push(`web: queries refused (${refusals.join(" ").slice(0, 160)})`);
          return { ok: false, error: refusals.join(" ") };
        }
        const run = good.slice(0, SWEEP_BUDGET.webQueries - webQueries);
        if (!run.length) return { ok: false, error: "No web searches left." };
        webQueries += run.length;
        did.push(...run.map((q) => `web: ${q}${loosenedFrom.has(q) ? ` (loosened from: ${loosenedFrom.get(q)})` : ""}`));
        const { taskWebSearch } = await import("./taskWeb.js");
        const all = await Promise.all(run.map((q) => taskWebSearch(c.userId, q, { city: c.city, zone: opts.timezone ?? null, source: "sweep", ...(opts.allSources ? { recentHours: RECENT_HOURS } : {}) }).catch(() => null)));
        // Every search failed outright: an outage, not an empty run (re-review of #133). taskWebSearch catches its own failures and says
        // so in its note (review of #134: it never returns null).
        if (all.every((r) => r === null || /^Web search failed/.test(r.note ?? ""))) {
          blocked = true;
          sourceFailures.push("web: the search failed (an outage, nothing came back)");
          return { ok: false, error: "Web search failed just now; nothing came back." };
        }
        const { checkVerified } = await import("./factCheck.js");
        const kept = (await checkVerified(all.flatMap((r) => r?.kept ?? []), { where: "sweep.web_search", userId: c.userId }).catch(() => ({ kept: all.flatMap((r) => r?.kept ?? []) }))).kept;
        run.forEach((q, i) => ledger.ran("web", q, all[i]?.kept?.length ?? 0, loosenedFrom.get(q)));
        const queryOf = new Map<string, string>();
        run.forEach((q, i) => { for (const k of all[i]?.kept ?? []) if (!queryOf.has(k.url)) queryOf.set(k.url, q); });
        for (const k of kept) {
          const facts = [...k.facts, ...(k.date ? [`date: ${k.date}`] : [])].join("; ");
          lookedAt.push({ source: "web", name: k.name, url: k.url, query: queryOf.get(k.url) });
          found.set(k.url, { tier: 3, kind: "opportunity", source: "web", name: k.name, url: k.url, reason: facts || k.name, evidence: `${k.name}. ${facts}`, ...(k.date ? { statedDates: { start: k.date } } : {}), ...(k.deadline ? { deadline: k.deadline } : {}) } as unknown as TierMatch);
        }
        if (all.every((r) => r && /^No web search right now/.test(r.note))) {
          blocked = true;
          sourceFailures.push("web: the day's web search budget is used up");
          return { ok: false, error: "Web search budget is used up for today." };
        }
        if (all.some((r) => r && !/^No web search right now/.test(r.note ?? ""))) searched = true;
        return { results: kept.map((k) => ({ link: k.url, name: k.name, facts: k.facts, date: k.date, deadline: k.deadline })), ...(refusals.length ? { note: refusals.join(" ") } : {}) };
      },
    }),
    searchPosts: tool({
      description: SWEEP_X_TOOL,
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        called.add("x");
        if (xSearches >= SWEEP_BUDGET.xSearches) return { ok: false, error: "No X searches left." };
        const asked = query.trim().slice(0, 200);
        const checked = ledger.checkOrLoosen("x", asked);
        if (checked.bad.length) {
          sourceFailures.push(`x: query refused (${ledger.refusal(asked, checked.bad).slice(0, 160)})`);
          return { ok: false, error: ledger.refusal(asked, checked.bad) };
        }
        const q = checked.query;
        xSearches++;
        const budget = await reserveXSearch(c.userId, "sweep", q);
        if (!budget.ok) {
          blocked = true;
          sourceFailures.push(`x: unavailable (${budget.reason ?? "budget"})`);
          return { ok: false, error: `X search unavailable (${budget.reason ?? "budget"}).` };
        }
        did.push(`x: ${q}${checked.loosenedFrom ? ` (loosened from: ${checked.loosenedFrom})` : ""}`);
        const { searchRecentPosts, X_SEARCH_RESULTS } = await import("./xSearch.js");
        let posts: Awaited<ReturnType<typeof searchRecentPosts>>;
        try {
          // The morning sweep reads only what's new (RECENT_HOURS); the hourly sweep, the last 7 days.
          posts = opts.allSources ? await searchRecentPosts(q, X_SEARCH_RESULTS, { sinceHours: RECENT_HOURS }) : await searchRecentPosts(q, X_SEARCH_RESULTS);
        } catch (err) {
          // Logged by kind and status, never swallowed into "no posts" (2026-10-08).
          xError = xFailure(err);
          blocked = true;
          sourceFailures.push(`x: the search failed (${xError.kind}${xError.status ? `, status ${xError.status}` : ""})`);
          console.error(`sweepFind: X search failed (${xError.kind}${xError.status ? `, status ${xError.status}` : ""}) for user ${c.userId}`);
          return { ok: false, error: xFailedNote(xError) };
        }
        xPosts += posts.length;
        ledger.ran("x", q, posts.length, checked.loosenedFrom);
        searched = true;
        for (const p of posts) {
          lookedAt.push({ source: "x", name: `${p.author ? `@${p.author}: ` : ""}${p.text.slice(0, 60)}`, url: p.url, query: q });
          const post = { tier: 3, kind: "opportunity", source: "x", name: p.text.slice(0, 80), url: p.url, reason: p.text, evidence: p.text } as unknown as TierMatch;
          found.set(p.url, post);
          // The page a post points to can be kept in its place, with the post as
          // its evidence. It's a web page to the gate (only x.com/i/status links
          // pass as posts), found through X.
          for (const l of p.links) {
            if (!postOf.has(l)) postOf.set(l, p.url);
            if (!found.has(l)) found.set(l, { ...post, source: "web", via: "x", url: l } as unknown as TierMatch);
          }
        }
        return {
          posts: posts.map((p) => ({ link: p.url, by: p.author ? `@${p.author}` : undefined, text: p.text.slice(0, 600), links: p.links.length ? p.links : undefined })),
          note: posts.length ? undefined : "No posts for that this week.",
        };
      },
    }),
    readPage: tool({
      description: "Read a page to confirm a detail.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        if (reads >= SWEEP_BUDGET.pageReads) return { ok: false, error: "No page reads left." };
        reads++;
        const { readPageText } = await import("./webOpportunitySearch.js");
        const text = await readPageText(url).catch(() => null);
        const m = found.get(url) as any;
        if (text && m && m.tier === 3) m.evidence = `${m.evidence ?? ""} ${text.slice(0, 3000)}`;
        return text ? { text: text.slice(0, 5000) } : { ok: false, error: "Couldn't read it." };
      },
    }),
    keep: tool({
      description: "Keep one thing for the queue: its link (from a result), the name of the thing as its record states it, one plain sentence on why it fits them, and how it sits with the kind of room they've said they want.",
      inputSchema: z.object({
        link: z.string(),
        name: z.string().optional(),
        why: z.string(),
        taste: z.enum(["matches", "neutral", "clashes"]).optional().describe("Against the kind of room they've told Cue they want, when they have: matches, neutral or clashes."),
        audience: z.string().optional().describe("Only if the thing is aimed at a particular group (women, men, moms, a community): who, in a few words. Leave out when it is open to everyone."),
        date: z.string().optional().describe("The day it happens (YYYY-MM-DD), only when the result or its page shows that day. Leave out when it doesn't say."),
      }),
      execute: async ({ link, name, why, taste, audience, date }) => {
        const m = found.get(link);
        if (!m) return { ok: false, error: "That link isn't one of your results." };
        if (kept.length >= SWEEP_BUDGET.keep) return { ok: false, error: "That's enough for this sweep." };
        // Taste ranks for everyone (Phase A5): what clashes with the room they've said they want isn't kept.
        const fit = record.statedTaste.length ? taste ?? "neutral" : null;
        if (fit === "clashes") {
          passReasons.set(link, "clashes with the kind of room they've said they want");
          return { ok: false, error: "That clashes with the kind of room they've said they want, so it isn't kept." };
        }
        // Its date, kept with it when its own text shows that day (shownDate), so a find that waits for its tier's slot stays while it's
        // fresh instead of closing as "its page didn't say when" (Royce, 2026-10-15).
        const day = m.tier === 3 && !(m as any).statedDates?.start ? shownDate(date, `${m.name} ${m.reason ?? ""} ${(m as any).evidence ?? ""}`, opts.today ?? localDay(new Date(), opts.timezone ?? null)) : null;
        kept.push({ ...m, ...(name && m.tier === 3 ? { name } : {}), ...(day ? { statedDates: { start: day } } : {}), whyItFits: why.trim(), fits: true, rightKind: true, ...(fit ? { taste: fit } : {}), ...(audience && audience.trim() ? { audience: audience.trim().slice(0, 60) } : {}) } as TierMatch);
        return { ok: true };
      },
    }),
    skip: tool({
      description: SWEEP_PASS_TOOL,
      inputSchema: z.object({ passed: z.array(z.object({ link: z.string(), why: z.string() })).max(20) }),
      execute: async ({ passed }) => {
        for (const p of passed.slice(0, 20)) if (p.link && p.why?.trim()) passReasons.set(p.link, p.why.trim());
        return { ok: true };
      },
    }),
  };
  try {
    await generateText({
      model: anthropic(MODELS.sonnet),
      maxOutputTokens: 4000,
      providerOptions: { anthropic: { effort: "low" } },
      tools,
      stopWhen: stepCountIs(opts.allSources ? SWEEP_BUDGET.allSourcesSteps : SWEEP_BUDGET.steps),
      // The daily sweep looks in all three places (SWEEP_SOURCES): a place not yet looked at is the next step's only tool.
      ...(opts.allSources
        ? {
            prepareStep: ({ stepNumber }: { stepNumber: number }) => {
              const must = nextRequiredSource(called, stepNumber);
              return must ? { toolChoice: { type: "tool" as const, toolName: must } } : undefined;
            },
          }
        : {}),
      experimental_telemetry: { isEnabled: true, functionId: "sweep.find", metadata: { userId: c.userId } },
      prompt: sweepPrompt(c, { today: localDay(new Date(), opts.timezone ?? null), record, allSources: opts.allSources, seen }),
    });
  } catch (err: any) {
    console.error("sweepFind: the loop failed (non-fatal):", err?.message ?? err);
    sourceFailures.push(`the search loop failed (${String(err?.message ?? err).slice(0, 120)})`);
  }
  // Facts only: sold out, past, too far, and a name/date the record actually states.
  const gatedOut: GatedOut[] = [];
  // Started, or starting inside the hour (START_LEAD_MINUTES): never kept, the way the reply's search turns it away (Royce, 2026-10-17).
  const factGated = await gateMatches(kept, { userId: c.userId, searchCity: c.city, checkRepeat: false, zone: opts.timezone ?? null, gatedOut, leadMinutes: START_LEAD_MINUTES }).catch(() => kept);
  // Kept but stopped by the fact gate: the gate's reason, unless Co gave one.
  for (const g of gatedOut) if (g.url && !passReasons.has(g.url)) passReasons.set(g.url, `kept, then the fact gate: ${g.reasons.join("; ")}`);
  // Their limits, for every member (Phase A2): a kind they ruled out, judged by its main activity, and an event outside when they're free.
  // The ask itself, so a day or time it names isn't overruled by when they're usually free (re-review of #134).
  const limits = await limitsGate(factGated, k.limits ? { avoid: record.avoid, availability: record.availability } : null, { askText: c.askText }).catch(() => ({ kept: [] as TierMatch[], out: factGated.map((m) => ({ match: m, why: "their limits couldn't be checked" })), read: null }));
  for (const o of limits.out) {
    const url = "url" in o.match && o.match.url ? String(o.match.url) : "";
    if (url) passReasons.set(url, `kept, then their limits: ${o.why}`);
  }
  // What matches the room they want goes first (Phase A5).
  const rankOf = (m: TierMatch) => ((m as any).taste === "matches" ? 0 : (m as any).taste === "clashes" ? 2 : 1);
  const gated = limits.kept.map((m, i) => ({ m, i })).sort((a, b) => rankOf(a.m) - rankOf(b.m) || a.i - b.i).map((x) => x.m);
  const keptUrls = new Set(gated.flatMap((m) => ("url" in m && m.url ? [String(m.url), postOf.get(String(m.url)) ?? ""] : [])).filter(Boolean));
  const passed = passedOver(lookedAt, keptUrls, passReasons);
  // Each query beside what became of its results, and each keep with the query that found it (the tuning log, sweepQuery.ts).
  const { queries, keptBy } = ledger.finish(lookedAt, keptUrls, gated.map((m) => ({ name: m.name, url: "url" in m && m.url ? String(m.url) : "" })), postOf);
  // A place the daily sweep never reached (the loop ended first) is a failure with its reason too.
  if (opts.allSources) for (const s of SWEEP_SOURCES) if (!called.has(s.source)) sourceFailures.push(`${s.source}: not reached (the search ended before it)`);
  const tried = { events: did.some((d) => d.startsWith("events: ")), web: did.some((d) => d.startsWith("web: ")), x: did.some((d) => d.startsWith("x: ")) };
  await recordDecision({ layer: 5, decision: "sweep.find", userId: c.userId, outcome: gated.length ? "act" : "skip", action: `kept ${gated.length}`, proposal: { ask: c.askText.slice(0, 200), did, tried, kept: kept.map((m) => m.name), passedGate: gated.map((m) => m.name), limitsOut: limits.out.map((o) => ({ name: o.match.name, why: o.why })), ...(limits.read ? { limitsRead: limits.read } : {}), xPosts, xKept: gated.filter((m) => (m as any).source === "x" || (m as any).via === "x").length, ...(xError ? { xError } : {}), lookedAt: { x: lookedAt.filter((l) => l.source === "x").length, web: lookedAt.filter((l) => l.source === "web").length, events: lookedAt.filter((l) => l.source === "events").length }, passedOver: passed, queries, keptBy, ...(opts.allSources ? { allSources: true } : {}), ...(sourceFailures.length ? { sourceFailures } : {}), ...(exaAdded.length ? { exaAdded } : {}) } }).catch(() => {});
  return { matches: gated, did, searched: searched || !blocked, frustratedWithCo: record.frustratedWithCo, sources: { ...tried, failures: sourceFailures } }; // mood: carries the read
}
