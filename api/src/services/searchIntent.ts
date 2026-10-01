// Understanding what they're asking for before searching (Royce, 2026-09-30:
// "The search is terrible and legit takes my words and tries to search ... Co
// should focus on understanding the user fully"). The whole message used to be
// the query (a 250-character sentence), and every ask went to the event search,
// so "a bookable space for a DJ set" came back as meetups.
//
// Now, the way teams that fixed this do it:
//   1. understand the ask first, from the message, the recent conversation and
//      what Co knows about them: what kind of thing, where, when, budget, how
//      many, vibe (structured intent, as Uber Eats and Airbnb search do);
//   2. route by kind: events to the event search, places, vendors, people and
//      services to a web search whose results must prove themselves on their own
//      page (services/taskWeb.ts) ("match the tool to the intent", Anthropic);
//   3. fan out a few short queries instead of one long one (Google AI Mode's
//      query fan-out; Anthropic: agents default to "overly long, specific queries
//      that return few results");
//   4. filter on budget and headcount in code, then rank;
//   5. broaden when results are thin (start narrow-ish, then wider).
// Measured by evals/search/understandLive.ts.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { parseModelJson } from "./modelJson.js";
import { notToTeammate, withoutTeammateLines } from "./teamLines.js";
import type { TierMatch } from "./tieredRecommendation.js";
import { checkFacts, factCheckMode, type Verdict } from "./factCheck.js";

export const KINDS = ["event", "program", "venue", "vendor", "person", "place", "info"] as const;
export type Kind = (typeof KINDS)[number];
export type SearchIntent = {
  kind: Kind;
  what: string; // the thing, in a few words ("bookable loft or event space")
  city: string | null;
  area: string | null; // neighborhood or area
  nearby?: string[]; // the neighborhoods next to it, for a wider round
  when: string | null; // their words for the time ("Oct 10")
  budget: number | null; // top of their budget, in dollars
  headcount: number | null;
  hours?: number | null; // how long they need it, when they said
  vibe: string | null;
  summary: string; // one short line describing the whole ask
  queries: string[]; // 2 to 4 short search queries
  sites: string[]; // where this kind of thing is listed
  ask: string | null; // the one question to ask when something essential is missing
  // Co's own loop keeps its working notes here too (agent/loopTools.ts).
  shortlist?: { name: string; url: string; note?: string }[];
  picked?: string | null;
  contacts?: { name: string; email: string }[];
  next?: string | null;
  tried?: string[];
};

export const SEARCH_LIMITS = { maxQueryChars: 70, maxQueries: 4, keep: 3, briefHours: 72 };

// The brief carries across texts the way a person keeps one in their head
// (2026-09-30, Instinct: "120 people" re-ranked the same venue search, a map
// pin set the area, "bookable from Peerspace" changed where it looked). Fresh
// for three days; a new ask replaces it.
export async function loadBrief(userId: string): Promise<SearchIntent | null> {
  const { rows } = await pool
    .query(`SELECT brief FROM search_briefs WHERE user_id = $1 AND updated_at > NOW() - make_interval(hours => $2)`, [userId, SEARCH_LIMITS.briefHours])
    .catch(() => ({ rows: [] as any[] }));
  return rows[0]?.brief ?? null;
}

export async function saveBrief(userId: string, brief: SearchIntent): Promise<void> {
  await pool
    .query(`INSERT INTO search_briefs (user_id, brief, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET brief = EXCLUDED.brief, updated_at = NOW()`, [userId, JSON.stringify(brief)])
    .catch((err: any) => console.error("searchIntent: saving the brief failed (non-fatal):", err?.message ?? err));
}

// The brief in a line for the reply, so Co can say what it searched for.
export function describeBrief(i: SearchIntent): string {
  return [i.what, i.area ?? i.city, i.when, i.headcount ? `${i.headcount} people` : null, i.budget ? `under $${i.budget}` : null, i.vibe].filter(Boolean).join(", ");
}

// Tiers 1 and 2 (Co's calendar, the public event feed) only for events;
// everything else, programs included, is the verified web tier. Programs used
// to wait for the daily sweep's X search; asked for live, they're searched live.
export function routeFor(kind: Kind): "events" | "web" {
  return kind === "event" ? "events" : "web";
}

const cleanQuery = (q: string) => q.replace(/\s+/g, " ").replace(/["“”]/g, "").trim().slice(0, SEARCH_LIMITS.maxQueryChars);

export function parseIntent(raw: string, fallbackCity: string | null): SearchIntent | null {
  try {
    const p = parseModelJson<any>(raw);
    if (!p || !KINDS.includes(p.kind)) return null;
    const num = (v: unknown) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : typeof v === "string" && /\d/.test(v) ? Number(v.replace(/[^\d.]/g, "")) || null : null);
    const str = (v: unknown, n = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
    const what = str(p.what, 80) ?? "";
    const queries = (Array.isArray(p.queries) ? p.queries : []).filter((q: unknown) => typeof q === "string" && q.trim()).map(cleanQuery).filter((q: string, i: number, a: string[]) => q.length >= 3 && a.indexOf(q) === i).slice(0, SEARCH_LIMITS.maxQueries);
    return {
      kind: p.kind,
      what,
      city: str(p.city, 60) ?? fallbackCity,
      area: str(p.area, 80),
      when: str(p.when, 60),
      budget: num(p.budget),
      headcount: num(p.headcount),
      hours: num(p.hours) && num(p.hours)! <= 24 ? num(p.hours) : null,
      vibe: str(p.vibe, 80),
      nearby: (Array.isArray(p.nearby) ? p.nearby : []).filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => s.trim().slice(0, 40)).slice(0, 4),
      summary: str(p.summary, 160) ?? what,
      queries: queries.length ? queries : [cleanQuery([what, str(p.area, 40), str(p.city, 30) ?? fallbackCity].filter(Boolean).join(" "))],
      sites: (Array.isArray(p.sites) ? p.sites : []).filter((s: unknown) => typeof s === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)).slice(0, 6),
      ask: str(p.ask, 200),
    };
  } catch {
    return null;
  }
}

// The brief's time, ready for the date reader (askWindow.ts). A range written
// with weekday names ("Saturday Oct 3 - Sunday Oct 4") read as its first day
// only, so "this weekend" was searched as Saturday (2026-09-30). Weekday names
// are dropped when the text also has real dates.
export function whenForWindow(when: string | null | undefined): string | null {
  if (!when?.trim()) return null;
  const hasDate = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b/i.test(when);
  return hasDate ? when.replace(/\b(mon|tues|wednes|thurs|fri|satur|sun)day,?\s*/gi, "").replace(/\s+/g, " ").trim() : when.trim();
}

// An event found on the web counts only when its own page dates it inside the
// window they asked about (an event with no date on its page isn't sent for a
// time-bound ask).
export function datedInWindow(m: { statedDates?: { start: string } | null }, windowStart: string | null | undefined, windowEnd: string | null | undefined): boolean {
  if (!windowStart || !windowEnd) return true;
  const d = m.statedDates?.start;
  if (!d) return false;
  return d >= windowStart.slice(0, 10) && d <= windowEnd.slice(0, 10);
}

// Wider queries for a second round when the first came back thin: the
// neighborhoods next to theirs first (2026-09-30: a pin near Divisadero and Oak
// found one space; Instinct found Wave on Haight, a few blocks over), then the
// whole city without the neighborhood or vibe.
export function broaden(i: SearchIntent): string[] {
  const size = i.headcount ? `${i.headcount} people` : "";
  const city = i.city?.split(",")[0] ?? "";
  const next = (i.nearby ?? []).slice(0, 2);
  return [
    ...(next.length ? [cleanQuery([i.what, next.join(" or "), city].filter(Boolean).join(" "))] : []),
    cleanQuery([i.what, city, size].filter(Boolean).join(" ")),
    ...(i.sites[0] ? [cleanQuery(`${i.sites[0].split(".")[0]} ${i.what} ${city}`)] : []),
  ].filter((q, k, a) => q && a.indexOf(q) === k);
}

// In the area they named (a neighborhood, or the streets around a map pin):
// those go first.
export function inArea(facts: string[], area: string | null): boolean {
  if (!area) return false;
  const words = area.toLowerCase().split(/[\/,&]|\band\b|\bnear\b/).map((w) => w.replace(/\b(st|street|ave|avenue|district|sf)\b/g, "").trim()).filter((w) => w.length >= 4);
  const text = facts.join(" ").toLowerCase();
  return words.some((w) => text.includes(w));
}

// 2 in their area, 1 next to it, 0 elsewhere or unknown.
export function areaScore(facts: string[], i: Pick<SearchIntent, "area" | "nearby">): number {
  return inArea(facts, i.area) ? 2 : (i.nearby ?? []).some((n) => inArea(facts, n)) ? 1 : 0;
}

const DEFAULT_HOURS = 4;

// The total for their night, worked out in code and shown as math, so Co never
// does arithmetic in a text (Instinct, 2026-09-30: "$180/hr on Saturdays. Four
// hours is about $720"). Only from an hourly rate on the page; a stated minimum
// counts.
export function priceEstimate(facts: string[], hours: number | null | undefined): string | null {
  const line = facts.find((f) => /\$\s?\d[\d,]*(\.\d+)?\s*(\/\s?(hr|hour)|per hour|an hour|hourly)/i.test(f));
  if (!line) return null;
  const m = line.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:[–-]\s*\$?\s?(\d[\d,]*))?\s*(\/\s?(hr|hour)|per hour|an hour|hourly)/i);
  if (!m) return null;
  const rate = Number(m[1].replace(/,/g, ""));
  const top = m[2] ? Number(m[2].replace(/,/g, "")) : null;
  if (!rate || rate > 5000) return null;
  const min = facts.join(" ").match(/(\d+)\s*(?:hr|hour)s?\s*min(imum)?/i);
  const minimum = min ? Number(min[1]) : 0;
  const h = Math.max(hours ?? DEFAULT_HOURS, minimum);
  const why = hours ? "" : minimum > DEFAULT_HOURS ? ` (their ${minimum}-hour minimum)` : ` (${DEFAULT_HOURS} hours assumed)`;
  const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  return `estimate: ${fmt(rate)}${top ? `–${fmt(top)}` : ""}/hr × ${h} hrs ≈ ${fmt(rate * h)}${top ? `–${fmt(top * h)}` : ""}${why}, before fees`;
}

// Budget and headcount, checked in code against what the page says.
// tight: holds most of them but not all (75-85%), said plainly and ranked after
// full fits (2026-09-30: two NoPa spaces for 100 were dropped for a 120 ask).
export function fitsConstraints(facts: string[], i: Pick<SearchIntent, "budget" | "headcount"> & { hours?: number | null }): { ok: boolean; why: string | null; tight?: string } {
  const text = facts.join(" ").toLowerCase();
  if (i.budget) {
    const prices = facts.filter((f) => /^(price|cost|rate|fee|starting|from|rental|minimum|min spend)/i.test(f) || /\$\s?\d/.test(f)).flatMap((f) => (f.match(/\$\s?(\d[\d,]*)/g) ?? []).map((m) => Number(m.replace(/[^\d]/g, ""))));
    const perHour = /\/\s?hr|per hour|an hour|hourly/.test(text);
    const lowest = prices.length ? Math.min(...prices) : null;
    // An hourly rate over their hours (4 when they didn't say); a flat price as is.
    if (lowest !== null && (perHour ? lowest * (i.hours ?? DEFAULT_HOURS) : lowest) > i.budget * 1.15) return { ok: false, why: `over budget (from $${lowest}${perHour ? "/hr" : ""})` };
  }
  if (i.headcount) {
    // Square footage and addresses aren't headcounts (2026-09-30: "40,000
    // square feet" was read as room for 40).
    const caps = facts
      .filter((f) => /^(capacity|guests|holds|standing|seated)/i.test(f) || /\b(guests|people|capacity|standing|seated)\b/i.test(f))
      .map((f) => f.replace(/\d[\d,.]*\s*(sq\.?\s*(ft|feet)|square\s*f(ee|oo)t|sf\b)/gi, " ").replace(/\d+\s+[A-Z][a-z]+\.?\s+(St|Ave|Blvd|Pl|Street|Avenue|Way|Rd)\b/g, " "))
      .flatMap((f) => (f.match(/(?<![\d,.])\d{2,4}(?![\d,])/g) ?? []).map(Number))
      .filter((n) => n >= 5 && n <= 5000);
    const most = caps.length ? Math.max(...caps) : null;
    if (most !== null && most < i.headcount * 0.75) return { ok: false, why: `too small (up to ${most})` };
    if (most !== null && most < i.headcount * 0.85) return { ok: true, why: null, tight: `fit: holds up to ${most}, tight for ${i.headcount}` };
  }
  return { ok: true, why: null };
}

export function intentPrompt(o: { message: string; recent: string; city: string | null; known: string; today: string; brief?: SearchIntent | null }): string {
  return `Someone is texting Co, a friend who finds things for them. Understand EXACTLY what they want found right now, using their latest message AND the conversation before it (their latest message often builds on earlier ones: "for SF tech week", "generalize it", "120 people", "in this area" with a map photo, "bookable from peerspace"). Also use what Co knows about them.

Today: ${o.today}. Their city on file: ${o.city ?? "unknown"}.
What Co knows about them: ${o.known || "(little)"}
${o.brief ? `
The search Co is already working on for them: ${JSON.stringify({ kind: o.brief.kind, what: o.brief.what, city: o.brief.city, area: o.brief.area, when: o.brief.when, budget: o.brief.budget, headcount: o.brief.headcount, vibe: o.brief.vibe, sites: o.brief.sites })}
If their latest message adds to or changes it (a headcount, an area, a site, a budget, "wider", "something else like that"), return the UPDATED brief: keep everything they didn't change. Only start fresh if they're asking for a different thing.
` : ""}
Recent conversation (oldest first):
${o.recent || "(none)"}

Their latest message: "${o.message}"

A photo they sent appears as "[sent a photo showing: ...]": a map means the area around the pin or the streets it names.

Return ONLY JSON:
{"kind": "event" (something happening at a time they'd attend) | "program" (an accelerator, grant, fellowship, application) | "venue" (a space to book or use) | "vendor" (a service or person to hire: DJ, caterer, photographer) | "person" (people to meet or reach, like founders with space) | "place" (a restaurant, bar, spot to go) | "info" (a fact or how-to),
 "what": "the thing in a few words, their terms",
 "city": "..." or null, "area": "neighborhood or area" or null, "nearby": ["up to 4 neighborhoods right next to that area, only when an area is set"], "when": "the time in their own words, as they said it (\"this weekend\", \"Friday night\", \"Oct 10\"), not turned into dates; Co works the dates out from their words" or null,
 "budget": top of their budget in dollars or null, "headcount": number or null, "hours": how many hours they need it (from their times, e.g. 8pm to midnight is 4) or null, "vibe": "a few words" or null,
 "summary": "one short line describing the whole ask",
 "queries": ["2 to 4 SHORT web search queries, 3 to 7 words each, the way an expert would type them, each a different angle: the thing plus the area, the thing on the site where it's listed, a synonym"],
 "sites": ["domains where this kind of thing is listed, e.g. peerspace.com, tagvenue.com, giggster.com for spaces; thebash.com, gigsalad.com for DJs; eventbrite.com, lu.ma for events"],
 "ask": "the ONE question to ask only if something essential is truly missing and can't be inferred (usually null)"}`;
}

async function contextFor(userId: string): Promise<{ recent: string; known: string }> {
  const [{ rows: convo }, { rows: snap }] = await Promise.all([
    pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 12`, [userId]).catch(() => ({ rows: [] as any[] })),
    pool.query(`SELECT snapshot FROM person_snapshots WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] })),
  ]);
  const s = snap[0]?.snapshot ?? null;
  const known = s ? [s.work, s.place, ...(s.wantsNow ?? []).slice(0, 3)].filter(Boolean).join("; ") : "";
  return { recent: withoutTeammateLines(convo.map((r: any) => String(r.content)).reverse().join("\n")).slice(-2500), known };
}

export async function understandAsk(userId: string, message: string, city: string | null, opts: { recent?: string; known?: string; brief?: SearchIntent | null } = {}): Promise<SearchIntent | null> {
  const [ctx, brief] = await Promise.all([
    opts.recent !== undefined ? { recent: opts.recent, known: opts.known ?? "" } : contextFor(userId),
    opts.brief !== undefined ? opts.brief : loadBrief(userId),
  ]);
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      maxOutputTokens: 2000,
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "search.understand", metadata: { userId } },
      prompt: intentPrompt({ message, recent: ctx.recent, city, known: ctx.known, today: new Date().toISOString().slice(0, 10), brief }),
    });
    return parseIntent(text, city);
  } catch (err: any) {
    console.error("searchIntent: understanding failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// Places, vendors, people and services: short queries in parallel, every result
// verified on its own page, filtered on budget and headcount, then a wider round
// if nothing held up. Returned as web matches the reply flow already sends.
export async function webFind(
  userId: string,
  intent: SearchIntent,
  opts: { zone?: string | null; skipBudget?: boolean; log?: boolean; checkFacts?: typeof checkFacts } = {},
): Promise<{ matches: TierMatch[]; tried: string[]; dropped: string[]; factChecks: { name: string; fact: string; verdict: Verdict }[] }> {
  const { taskWebSearch, cantCheck } = await import("./taskWeb.js");
  const tried: string[] = [];
  const dropped: string[] = [];
  // Said plainly, so the reply can explain it (they asked for Peerspace).
  const blocked = intent.sites.filter(cantCheck);
  if (blocked.length) dropped.push(`${blocked.join(", ")} listings: they hide the venue or block checking, so Co looked for places with their own pages`);
  const kept = new Map<string, { name: string; url: string; facts: string[]; excerpts: string[]; official: boolean; tight: string | null; date: string | null }>();
  const round = async (queries: string[]) => {
    const results = await Promise.all(
      queries.map((q) => {
        tried.push(q);
        return taskWebSearch(userId, q, { city: intent.city, zone: opts.zone ?? null, skipBudget: opts.skipBudget, log: opts.log, sites: intent.sites, source: "request" }).catch(() => null);
      }),
    );
    for (const r of results) {
      if (!r) continue;
      for (const d of r.dropped) dropped.push(`${d.name}: ${d.why}`);
      for (const k of r.kept) {
        // A name alone isn't something to send (2026-09-30: "DJ Busy B" with
        // nothing about it).
        if (!k.facts.length) {
          dropped.push(`${k.name}: nothing about it on its page`);
          continue;
        }
        const fit = fitsConstraints(k.facts, intent);
        if (!fit.ok) {
          dropped.push(`${k.name}: ${fit.why}`);
          continue;
        }
        if (!kept.has(k.url)) kept.set(k.url, { name: k.name, url: k.url, facts: k.facts, excerpts: k.excerpts ?? [], official: k.official, tight: fit.tight ?? null, date: k.date ?? null });
      }
    }
  };
  const started = Date.now();
  await round(intent.queries.slice(0, 3));
  // A wider round only when the first came back thin and there's time left in
  // a live reply (it's capped at 45s; services/recommendation.ts).
  // Thin counts full fits: a tight one alone still earns the wider round.
  const full = () => [...kept.values()].filter((k) => !k.tight).length;
  if (full() < 2 && Date.now() - started < 22_000) await round(broaden(intent).filter((q) => !tried.includes(q)).slice(0, 2));
  const order = (list: typeof candidates) => list.sort((a, b) => Number(!b.tight) - Number(!a.tight) || areaScore(b.facts, intent) - areaScore(a.facts, intent) || Number(b.official) - Number(a.official) || b.facts.length - a.facts.length);
  const candidates = [...kept.values()];
  // The second reader on the best few (services/factCheck.ts): does the page say
  // this about this thing? Recorded in shadow mode; a "no" drops the fact when on.
  const top = order(candidates).slice(0, SEARCH_LIMITS.keep + 2);
  const mode = factCheckMode();
  let factChecks: { name: string; fact: string; verdict: Verdict }[] = [];
  if (mode !== "off") {
    const items = top.flatMap((r) => r.facts.map((fact, j) => ({ r, j, item: { thing: r.name, fact, passage: r.excerpts[j] ?? "" } }))).filter((x) => x.item.passage);
    if (items.length) {
      const { verdicts, by } = await (opts.checkFacts ?? checkFacts)(items.map((x) => x.item));
      factChecks = items.map((x, k) => ({ name: x.r.name, fact: x.item.fact, verdict: verdicts[k] }));
      // Shadow mode records only; the reply is told about drops that happened.
      if (mode === "on") factChecks.forEach((c) => c.verdict === "no" && dropped.push(`${c.name}: "${c.fact}" isn't what its page says (${mode === "on" ? "dropped" : "shadow"}, ${by.join("/")})`));
      if (mode === "on") {
        for (const r of top) {
          const bad = new Set(factChecks.filter((c) => c.name === r.name && c.verdict === "no").map((c) => c.fact));
          const keep = r.facts.map((f, j) => ({ f, e: r.excerpts[j] })).filter((x) => !bad.has(x.f));
          r.facts = keep.map((x) => x.f);
          r.excerpts = keep.map((x) => x.e ?? "");
        }
      }
    }
  }
  const ranked = order(top.filter((r) => r.facts.length)).slice(0, SEARCH_LIMITS.keep);
  const matches: TierMatch[] = ranked.map((r) => {
    const estimate = priceEstimate(r.facts, intent.hours);
    const facts = [...r.facts, ...(estimate ? [estimate] : []), ...(r.tight ? [r.tight] : [])].join("; ");
    return { tier: 3, kind: "opportunity", source: "web", name: r.name, url: r.url, reason: facts || r.name, evidence: `${r.name}. ${facts}`, opportunity: { postText: `${r.name}. ${facts}` }, ...(r.date ? { statedDates: { start: r.date } } : {}) } as unknown as TierMatch;
  });
  await recordDecision({ layer: 5, decision: "search.web", userId, outcome: matches.length ? "act" : "skip", action: `kept ${matches.length}`, proposal: { intent, tried, kept: ranked.map((r) => ({ name: r.name, url: r.url })), dropped: dropped.slice(0, 20), factCheck: { mode, checks: factChecks } } }).catch(() => {});
  return { matches, tried, dropped, factChecks };
}
