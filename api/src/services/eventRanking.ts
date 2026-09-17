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
import { orderForOffering } from "./eventOrder.js";

export const RELEVANCE_BAR_WITH_DESCRIPTION = 0.3;
const DESCRIPTION_CHARS = 500;
// Enough for a thin weekend or a busy one, without a page fetch per event in
// a month-long window.
const MAX_CANDIDATES = 40;

export type RankedEvent<T> = T & { similarity: number; details?: EventDetails };
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
  opts: { limit?: number; bar?: number; topScores?: { name: string; similarity: number }[] } = {},
): Promise<{ ranked: RankedEvent<T>[]; closest: Closest | null }> {
  const pool = candidates.slice(0, MAX_CANDIDATES);
  if (!askText || !pool.length) return { ranked: [], closest: null };
  const details = await Promise.all(pool.map((c) => (c.url ? fetchLumaEventDetails(c.url).catch(() => null) : Promise.resolve(null))));
  const texts = pool.map((c, i) => rankingText(c.name, details[i] ?? undefined));

  const now = Date.now();
  const missing = texts.map((t, i) => [t, i] as const).filter(([t]) => {
    const hit = embeddingCache.get(t);
    return !hit || now - hit.at > EMBED_TTL_MS;
  });
  const [askVector, ...fresh] = await generateEmbeddings([askText, ...missing.map(([t]) => t)]);
  missing.forEach(([t], k) => embeddingCache.set(t, { at: now, vector: fresh[k] }));
  if (embeddingCache.size > 2000) embeddingCache.clear();

  const scored: RankedEvent<T>[] = pool.map((c, i) => ({
    ...c,
    details: details[i] ?? undefined,
    similarity: cosineSimilarity(askVector, embeddingCache.get(texts[i])?.vector ?? askVector.map(() => 0)),
  }));
  const byScore = [...scored].sort((a, b) => b.similarity - a.similarity);
  opts.topScores?.push(...byScore.slice(0, 5).map((e) => ({ name: e.name, similarity: Math.round(e.similarity * 1000) / 1000 })));

  const bar = opts.bar ?? RELEVANCE_BAR_WITH_DESCRIPTION;
  const ranked = orderForOffering(scored.filter((e) => e.similarity >= bar)).slice(0, opts.limit ?? 6);
  const best = byScore[0];
  const closest: Closest | null = best
    ? { name: best.name, url: best.url ?? null, date: best.start_at.slice(0, 10), similarity: Math.round(best.similarity * 1000) / 1000 }
    : null;
  return { ranked, closest };
}
