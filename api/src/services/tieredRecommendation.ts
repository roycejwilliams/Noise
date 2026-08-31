import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { listCalendarEvents } from "./luma.js";
import { findEventMatchingAsk, rankByRelevance } from "./lumaDiscovery.js";
import { searchRecentPosts } from "./xSearch.js";
import type { StatedIntent } from "./matching.js";

// The actual "Tiered recommendation engine (Tier 1 event → Tier 2 community/
// meetup → Tier 3 opportunity fallback)" board item. Tries each tier in
// order, returns the first real, grounded match — never invents something
// that doesn't exist, unlike the old generateRecommendation behavior this
// replaces internally (see recommendation.ts).
//
// Tier 3 redefined 2026-08-30 (Royce): not a generic nearby-venue fallback
// anymore — Co's actual audience is founders/builders/"high agency" people,
// so Tier 3 is specifically accelerators, fellowships, and similar real
// opportunities, sourced from X's recent-search (xSearch.ts), not Google
// Places. A physical venue lookup isn't the fallback shape that matches who
// Co is actually for.
// event_api_id is carried through on the two real-event tiers (not Tier 3 —
// an "opportunity" isn't a shared event two people would both attend) so
// callers can key exact same-event matching off it (see eventMatching.ts's
// recordSurfacedEventAndMatch) — if Co surfaces the identical event to two
// different people, that's a certain match, no fuzzy embedding/date-window
// guessing needed the way self-reported mentions require.
// event_date (the event's own date, ISO) travels alongside event_api_id so
// cross-matching against planned_event_mentions' date-windowed fuzzy search
// is possible (see eventMatching.ts) — surfaced_events needs the EVENT's
// date, not merely when Co happened to recommend it.
export type TierMatch =
  | { tier: 1; kind: "co_event"; event_api_id: string; event_date: string; name: string; url?: string; reason: string }
  | { tier: 2; kind: "public_event"; event_api_id: string; event_date: string; name: string; url: string; reason: string }
  | { tier: 3; kind: "opportunity"; name: string; url: string; reason: string };

// Tier 1 — Co's own calendar. Reuses the same ranking core as Tier 2
// (lumaDiscovery.rankByRelevance) since both are "rank real events against
// an ask" with the same signal (name + city) available — Co's own events
// just come from luma.ts's sanctioned API instead of the unofficial
// discovery feed.
async function tryTier1(ask: StatedIntent): Promise<TierMatch | null> {
  const events = await listCalendarEvents().catch((err: any) => {
    console.error("tieredRecommendation: tryTier1 listCalendarEvents failed (non-fatal):", err?.message ?? err);
    return [];
  });
  const match = await rankByRelevance(events, ask);
  if (!match) return null;
  return {
    tier: 1,
    kind: "co_event",
    event_api_id: match.api_id,
    event_date: match.start_at.slice(0, 10),
    name: match.name,
    reason: `Matches a Co event happening ${new Date(match.start_at).toLocaleDateString()}.`,
  };
}

// Tier 2 — any public Luma event, not just Co's own. "Recurring community"
// isn't a confirmed, filterable signal from the discovery feed (see
// lumaDiscovery.ts's header) — approximated here as "a real public event
// that isn't ours," not strictly filtered to recurring-only. Noted as a
// simplification, not hidden.
async function tryTier2(ask: StatedIntent): Promise<TierMatch | null> {
  const match = await findEventMatchingAsk(ask);
  if (!match) return null;
  return {
    tier: 2,
    kind: "public_event",
    event_api_id: match.api_id,
    event_date: match.start_at.slice(0, 10),
    name: match.name,
    url: match.url,
    reason: `A public event that looks like a real fit${match.city ? ` in ${match.city}` : ""}.`,
  };
}

// Tier 3 — a real opportunity (accelerator, fellowship, program), via X's
// recent search (xSearch.ts). The raw ask text isn't a good search query on
// its own ("climate tech founders" won't surface accelerator posts), so this
// asks the model to propose a real search query first, same "ground it,
// never invent one" discipline as before — the difference from the old
// venue version is the grounding element is a real post URL, not a
// place_id.
async function proposeOpportunityQuery(ask: StatedIntent, city: string | null): Promise<string | null> {
  if (!ask.text) return null;
  try {
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.proposeOpportunityQuery" },
      prompt: `Someone wants: "${ask.text}"${city ? ` (based in ${city})` : ""}

If this maps reasonably to the kind of thing a founder or high-agency builder would search X/Twitter for right now — an accelerator, fellowship, cohort-based program, or similar real opportunity with an open or upcoming application — propose a short X search query (keywords, not a question) likely to surface real, recent posts about it. If it doesn't map to that kind of thing at all (e.g. it's purely social, not opportunity-shaped), return null.

Return ONLY valid JSON: {"query": "..." or null}`,
    });
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return typeof parsed?.query === "string" ? parsed.query : null;
  } catch (err: any) {
    console.error("tieredRecommendation: proposeOpportunityQuery failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// Picks ONE real, concrete opportunity out of the raw search results —
// grounded in an actual post's real text and URL, never a summary that
// drifts from what any single post actually said. Returns null rather than
// force a weak pick if nothing in the results is actually concrete/credible.
async function extractRealOpportunity(
  ask: StatedIntent,
  posts: { id: string; text: string; url: string }[],
): Promise<TierMatch | null> {
  if (!posts.length) return null;
  try {
    const digest = posts.map((p, i) => `${i}. ${p.text.replace(/\n+/g, " ")}`).join("\n");
    const { text: raw } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.extractRealOpportunity" },
      prompt: `Someone wants: "${ask.text}"

Here are real recent posts from X, one per line:
${digest}

Pick the ONE post (if any) that names a real, concrete opportunity (a specific accelerator, fellowship, or program — not vague hype, not an unrelated post) genuinely relevant to what they want. Name the opportunity using only what's actually in that post — never add details that aren't there.

Return ONLY valid JSON: {"index": 0, "name": "the specific opportunity name", "reason": "one short grounded sentence"} or {"index": null}`,
    });
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (typeof parsed?.index !== "number" || !posts[parsed.index]) return null;
    return {
      tier: 3,
      kind: "opportunity",
      name: parsed.name ?? posts[parsed.index].text.slice(0, 80),
      url: posts[parsed.index].url,
      reason: parsed.reason ?? "Found via a real, recent post.",
    };
  } catch (err: any) {
    console.error("tieredRecommendation: extractRealOpportunity failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

async function tryTier3(ask: StatedIntent, city: string | null): Promise<TierMatch | null> {
  const query = await proposeOpportunityQuery(ask, city);
  if (!query) return null;
  const posts = await searchRecentPosts(query).catch((err: any) => {
    console.error("tieredRecommendation: tryTier3 searchRecentPosts failed (non-fatal):", err?.message ?? err);
    return [];
  });
  return extractRealOpportunity(ask, posts);
}

// Tries each tier in order, returns the first real match. Null means none of
// the three tiers found anything grounded — the caller (recommendation.ts)
// still has its own generic fallback for that case, same as before this
// existed.
export async function getTieredRecommendation(ask: StatedIntent, city: string | null): Promise<TierMatch | null> {
  return (await tryTier1(ask)) ?? (await tryTier2(ask)) ?? (await tryTier3(ask, city));
}
