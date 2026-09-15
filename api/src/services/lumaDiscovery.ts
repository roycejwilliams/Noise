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
export async function fetchPublicEvents(limit: number): Promise<DiscoveredEvent[]> {
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

// Calibrated against real data (Royce, 2026-09-02) — the 0.72 first-guess
// default turned out to reject even a textbook-perfect match: "Looking to
// meet other AI builders and founders in San Francisco..." vs a real,
// live "AI Builders Breakfast @ Tesla" (San Francisco, next day) scored
// only 0.517 — nowhere close to 0.72. This embedding model's cosine
// similarity for a full-sentence ask against a short event-name candidate
// just runs lower than 0.72 would ever allow, regardless of how good the
// match actually is — a real ceiling issue with the old value, not a case
// of that one match being unusually weak.
//
// Live-measured spread across a mix of real candidates: genuine
// good-to-strong matches landed at 0.406-0.517 (AI Builders Breakfast:
// 0.517; a founder-focused coffee meetup: 0.406); genuinely unrelated
// events (a fragrance talk, an adults' game night, a microscopy lunch
// talk) landed at 0.087-0.201 — including one event whose NAME sounded
// AI-adjacent ("The Agent Has Entered the Chat") but scored 0.169, closer
// to the unrelated cluster than the real matches. 0.35 sits in the clear
// gap between those two clusters, with real margin on both sides.
const RELEVANCE_THRESHOLD = 0.35;

// Shared ranking core — takes any list of {name, city}-shaped candidates
// (public discovery events here, but also reused by tieredRecommendation.ts
// for Co's own calendar events, since both are "rank real events against an
// ask" with the same signal available) and returns the single best match if
// it clears the bar, null otherwise. No point surfacing a weak match — same
// reasoning as dropping the embedding-only fallback in eventScoring.ts.
//
// Proximity used to be a soft bias here (appending the user's city to the
// ask text before embedding, Royce 2026-08-30: "city and the proximity to
// each user matter") — replaced 2026-09-02 with a real hard radius filter
// (geocoding.ts's withinRadius, applied by tieredRecommendation.ts's
// tryTier1/tryTier2 BEFORE candidates ever reach this function) after Royce
// pointed out the actual failure mode: a Walnut Creek user asking about
// "the Bay Area" or "San Francisco" needs a real ~50mi radius, not a
// literal city-string/embedding match, which would either miss real nearby
// events (different city string) or let through a same-vibe event states
// away (embedding similarity has no real distance sense). This function is
// now purely topic relevance — geography is handled entirely upstream.
export async function rankByRelevance<T extends { name: string; city?: string | null }>(
  candidates: T[],
  ask: StatedIntent,
): Promise<(T & { similarity: number }) | null> {
  if (!ask.text || !candidates.length) return null;

  const askEmbedding = ask.embedding?.length ? ask.embedding : await generateEmbedding(ask.text).catch(() => null);
  if (!askEmbedding) return null;

  const candidateEmbeddings = await Promise.all(
    candidates.map((c) => generateEmbedding(c.name).catch(() => null)),
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
