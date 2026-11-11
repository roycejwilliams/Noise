// Ranking real events against what someone asked for (Royce, 2026-09-16).
//
// Titles alone were a poor signal: "Claude Fable 5.1 Build Day" scored 0.335
// against "Find a founder or builder meetup this weekend", under the 0.35
// bar, while "7Pacific SF Bakery Run" scored 0.34. Nothing reached the
// relevance check and Co said it found nothing. Ranking now reads each
// event's own description, which is what says what it actually is.
//
//   score   embedding of "name. description" against the ask
//   bar     RELEVANCE_BAR_WITH_DESCRIPTION, calibrated on 40 real SF events
//           across five asks: real matches landed at 0.37 and up, unrelated
//           events around the 0.24 median. The relevance check after this
//           reads the description too, so the bar only has to cut noise.
//   order   open events before sold-out ones (14 of those 40 were sold out,
//           and the gate turns sold-out events away afterwards), then score
//   closest the best event that didn't make it, so a search with nothing to
//           offer can still name the nearest thing
import { generateEmbeddings } from "./embeddings.js";
import { cosineSimilarity } from "./lumaDiscovery.js";
import { fetchLumaEventDetails, type EventDetails } from "./eventDetails.js";
import { localDate, offerScore, orderForOffering, spreadAcrossDays } from "./eventOrder.js";

export const RELEVANCE_BAR_WITH_DESCRIPTION = 0.3;
const DESCRIPTION_CHARS = 500;
// Enough for a thin weekend or a busy one, without a page fetch per event in
// a month-long window. Spread across the days in the window rather than the
// first 40 in feed order (code review, 2026-09-17: a long window only ever
// ranked its first days).
const MAX_CANDIDATES = 40;
// Pages read per ranking, at most (the rest are ranked on what they carry).
export const RANK_PAGE_READS = 12;

export type RankedEvent<T> = T & { similarity: number; profileSimilarity?: number | null; offerScore?: number; details?: EventDetails };
export type Closest = { name: string; url: string | null; date: string | null; similarity: number };

const embeddingCache = new Map<string, { at: number; vector: number[] }>();
const EMBED_TTL_MS = 6 * 60 * 60 * 1000;

function rankingText(name: string, details: EventDetails | undefined): string {
  const desc = (details?.description ?? "").replace(/\s+/g, " ").slice(0, DESCRIPTION_CHARS);
  return desc ? `${name}. ${desc}` : name;
}


export async function rankEventsByDescription<T extends { name: string; url?: string | null; start_at: string }>(
  candidates: T[],
  askText: string,
  opts: {
    limit?: number;
    bar?: number;
    topScores?: { name: string; similarity: number; profile?: number | null }[];
    zone?: string | null;
    // What Co knows they want right now (services/personSnapshot.ts
    // profileForSearch). Orders events that match the ask.
    profileText?: string | null;
    // No subject in the ask: every event in the window counts, ordered by the
    // profile.
    browse?: boolean;
    // Whose read this is (eventDetails.ts lumaPace): a reply's never waits behind a sweep's.
    lane?: import("./eventDetails.js").LumaLane;
  } = {},
): Promise<{ ranked: RankedEvent<T>[]; closest: Closest | null }> {
  const pool = spreadAcrossDays(candidates, MAX_CANDIDATES, opts.zone);
  const profileText = opts.profileText?.trim() || null;
  if ((!askText && !(opts.browse && profileText)) || !pool.length) return { ranked: [], closest: null };
  // An event that already has its details (one Exa found, read from Luma's API: services/lumaViaExa.ts) isn't read again from its page.
  // Pages are read for at most RANK_PAGE_READS of the rest, the ones whose own text fits the ask best (second review of #456: 40 page
  // reads per ranking held a reply's search ~40s); the others are ranked on their name alone.
  const needs = pool.filter((c) => !(c as { details?: EventDetails }).details && !!c.url);
  const toRead = new Set(needs.length > RANK_PAGE_READS && askText ? await prefilterByFit(needs, askText, RANK_PAGE_READS) : needs);
  const details = await Promise.all(pool.map((c) => ((c as { details?: EventDetails }).details ? Promise.resolve((c as { details?: EventDetails }).details!) : c.url && toRead.has(c) ? fetchLumaEventDetails(c.url, { lane: opts.lane }).catch(() => null) : Promise.resolve(null))));
  const texts = pool.map((c, i) => rankingText(c.name, details[i] ?? undefined));

  const now = Date.now();
  const missing = texts.map((t, i) => [t, i] as const).filter(([t]) => {
    const hit = embeddingCache.get(t);
    return !hit || now - hit.at > EMBED_TTL_MS;
  });
  const heads = [askText || profileText!, ...(profileText ? [profileText] : [])];
  const vectors = await generateEmbeddings([...heads, ...missing.map(([t]) => t)]);
  const askVector = vectors[0];
  const profileVector = profileText ? vectors[1] : null;
  const fresh = vectors.slice(heads.length);
  missing.forEach(([t], k) => embeddingCache.set(t, { at: now, vector: fresh[k] }));
  if (embeddingCache.size > 2000) embeddingCache.clear();

  const round = (x: number) => Math.round(x * 1000) / 1000;
  const scored: RankedEvent<T>[] = pool.map((c, i) => {
    const vector = embeddingCache.get(texts[i])?.vector ?? askVector.map(() => 0);
    const similarity = cosineSimilarity(askVector, vector);
    const profileSimilarity = profileVector ? cosineSimilarity(profileVector, vector) : null;
    return { ...c, details: details[i] ?? undefined, similarity, profileSimilarity, offerScore: offerScore(similarity, profileSimilarity, !!opts.browse) };
  });
  const byScore = [...scored].sort((a, b) => b.similarity - a.similarity);
  opts.topScores?.push(
    ...[...scored]
      .sort((a, b) => (b.offerScore ?? 0) - (a.offerScore ?? 0))
      .slice(0, 5)
      .map((e) => ({ name: e.name, similarity: round(e.similarity), profile: e.profileSimilarity == null ? null : round(e.profileSimilarity) })),
  );

  const bar = opts.bar ?? RELEVANCE_BAR_WITH_DESCRIPTION;
  // The ask is the gate; the profile only orders what passes it. A browse ask
  // has no subject to gate on, so everything in the window is eligible.
  const eligible = opts.browse ? scored : scored.filter((e) => e.similarity >= bar);
  const ranked = orderForOffering(eligible).slice(0, opts.limit ?? 6);
  const best = byScore[0];
  const closest: Closest | null = best
    ? { name: best.name, url: best.url ?? null, date: localDate(best.start_at, opts.zone), similarity: Math.round(best.similarity * 1000) / 1000 }
    : null;
  return { ranked, closest };
}

// The cheap pass: each candidate's own text (name, and its description when it already has one), against the ask, by the same
// embeddings the ranking uses; the best `max` go on. A failed embedding read falls back to the spread across days.
export async function prefilterByFit<T extends { name: string; start_at: string }>(candidates: T[], askText: string, max: number, embed: (texts: string[]) => Promise<number[][]> = generateEmbeddings): Promise<T[]> {
  try {
    const texts = candidates.map((c) => rankingText(c.name, (c as { details?: EventDetails }).details));
    const vectors = await embed([askText, ...texts]);
    const ask = vectors[0];
    return candidates
      .map((c, i) => {
        const sim = vectors[i + 1] ? cosineSimilarity(ask, vectors[i + 1]) : NaN;
        return { c, s: Number.isFinite(sim) ? sim : -1 };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, max)
      .map((x) => x.c);
  } catch {
    return spreadAcrossDays(candidates, max);
  }
}
