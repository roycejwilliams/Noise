// Co's working notes for what it's finding for someone (the search brief), kept
// across texts in search_briefs, plus two checks done in code on what a web
// result's page states: budget and headcount, and the total for their night.
// Co itself understands the ask, picks the tools and judges results in its own
// loop (agent/loop.ts); the separate understanding call and web fan-out that
// lived here served the old reply search, removed 2026-10-01.
import pool from "../db/db.js";

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
