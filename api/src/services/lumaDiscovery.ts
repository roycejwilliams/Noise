import { generateEmbedding } from "./embeddings.js";
import type { StatedIntent } from "./matching.js";

// UNOFFICIAL — kept deliberately separate from luma.ts. This calls
// api.luma.com/discover/get-paginated-events, not public-api.luma.com — a
// different domain, unauthenticated, undocumented on docs.luma.com. It's
// almost certainly what powers Luma's own public Discover page for
// anonymous browsing, not a supported third-party integration surface.
// Lower risk than the session-cookie mechanism (no credentials, nothing
// borrowed from a user, genuinely public with zero access control) but not
// confirmed safe either — Luma owes it no stability guarantee and could
// change or remove it without notice. Treat every field here as best-effort.
const DISCOVER_URL = "https://api.luma.com/discover/get-paginated-events";

export type DiscoveredEvent = {
  api_id: string;
  name: string;
  start_at: string;
  city: string | null;
  url: string;
};

// No confirmed location/category filter param — parse.bot's "Discover
// Events by City" listing implies one exists, but the exact param name
// isn't confirmed against real testing, so this fetches unfiltered and
// ranks client-side instead of risking a silently-wrong filter param.
// Genuinely global result set until that's confirmed — a real limitation
// for a Bay-Area-focused product, flagged rather than silently accepted.
async function fetchPublicEvents(limit: number): Promise<DiscoveredEvent[]> {
  const url = new URL(DISCOVER_URL);
  url.searchParams.set("pagination_limit", String(limit));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`lumaDiscovery: fetchPublicEvents failed (${res.status}): ${await res.text()}`);
  }
  const data: any = await res.json();
  return (data.entries ?? [])
    .map((entry: any) => entry.event ?? entry)
    .filter((e: any) => e?.api_id && e?.name)
    .map((e: any) => ({
      api_id: e.api_id,
      name: e.name,
      start_at: e.start_at,
      city: e.geo_address_info?.city ?? null,
      url: `https://lu.ma/${e.url}`,
    }));
}

// First-guess default, same spirit as the other unconfirmed thresholds in
// this codebase — "is this event actually relevant to the ask" is a looser
// question than "are these two mentions the SAME event" (eventMatching.ts's
// 0.85 bar), so this is deliberately lower. Not tuned against real data yet.
const RELEVANCE_THRESHOLD = 0.72;

export type MatchedEvent = DiscoveredEvent & { similarity: number };

// Shared ranking core — takes any list of {name, city}-shaped candidates
// (public discovery events here, but also reused by tieredRecommendation.ts
// for Co's own calendar events, since both are "rank real events against an
// ask" with the same signal available) and returns the single best match if
// it clears the bar, null otherwise. No point surfacing a weak match — same
// reasoning as dropping the embedding-only fallback in eventScoring.ts.
export async function rankByRelevance<T extends { name: string; city?: string | null }>(
  candidates: T[],
  ask: StatedIntent,
): Promise<(T & { similarity: number }) | null> {
  if (!ask.text || !candidates.length) return null;

  const askEmbedding = ask.embedding?.length ? ask.embedding : await generateEmbedding(ask.text).catch(() => null);
  if (!askEmbedding) return null;

  const candidateEmbeddings = await Promise.all(
    candidates.map((c) => generateEmbedding([c.name, c.city].filter(Boolean).join(", ")).catch(() => null)),
  );

  let best: (T & { similarity: number }) | null = null;
  candidates.forEach((candidate, i) => {
    const embedding = candidateEmbeddings[i];
    if (!embedding) return;
    const similarity = cosineSimilarity(askEmbedding, embedding);
    if (similarity >= RELEVANCE_THRESHOLD && (!best || similarity > best.similarity)) {
      best = { ...candidate, similarity };
    }
  });

  return best;
}

// Ranks public Luma events (Tier 2 — anyone else's calendar) against a
// stated ask. event name + city is the only signal available (the discover
// payload has no per-event description field, only a short blurb on the
// hosting calendar/community, not the specific event).
export async function findEventMatchingAsk(ask: StatedIntent): Promise<MatchedEvent | null> {
  const events = await fetchPublicEvents(50).catch((err: any) => {
    console.error("lumaDiscovery: fetchPublicEvents failed (non-fatal):", err?.message ?? err);
    return [] as DiscoveredEvent[];
  });
  return rankByRelevance(events, ask);
}

// The one place in this codebase that computes cosine similarity in JS
// instead of via pgvector's <=> — these embeddings never touch the
// database (the events aren't Co's own data), so there's no SQL table to
// push the comparison into.
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
