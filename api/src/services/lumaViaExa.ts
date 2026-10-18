// Tier 2 through Exa (Royce, 2026-10-17: "Finish the Tier 2 Exa build. I'm approving it ... it finds the Luma events the feed misses").
// Luma's public Discover feed holds only the city's featured events (55 for San Francisco, 19 for Chicago on 10-17), the same few for
// every want. One Exa search limited to Luma's own pages, written from the want, the city and the asked dates, finds the rest: on 10-17
// it found 7 SF founder events in the asked week that the feed didn't have (the feed's names fit 2), and 8 SF supper clubs in late
// October (the feed: 0).
// Each result is read from its own Luma page (free, no model) and kept only when that page says it's upcoming and inside the asked
// window; it then joins the feed's events (services/tieredRecommendation.ts eventCandidates) and goes through the same nearby filter,
// ranking, page read, gate and start check (#229) as a feed event, and goes out as a Luma link, tier 2. Exa's index keeps old pages
// too, so most results are past (71 of 106 read on 10-17): the page read is what decides, never Exa's text.
// Cost: one Exa search per want, city and dates, $0.022 measured (25 results, no page text). What Exa found (the event pages, not
// their details) is kept for CACHE_HOURS, so a sweep and a reply on the same want don't pay twice; a search that failed isn't kept, and
// the pages are read again each time (eventDetails.ts keeps a read for an hour). Off without EXA_API_KEY, and skipped where a turn can't
// wait for it (calls: services/voiceFinds.ts).
import type { DiscoveredEvent } from "./lumaDiscovery.js";
import type { EventDetails } from "./eventDetails.js";
import type { ExaSearch } from "./exaSearch.js";

export const LUMA_VIA_EXA = { results: 25, timeoutMs: 10_000, cacheHours: 6 } as const;
export const LUMA_DOMAINS = ["lu.ma", "luma.com"];
// Luma paths that are never one event's page.
const NOT_EVENTS = new Set(["discover", "home", "signin", "login", "create", "calendar", "explore", "pricing", "user", "u", "settings", "help"]);

// Pure: the event's slug when the url is one Luma event page (lu.ma/abc123, luma.com/abc123), else null.
export function lumaEventSlug(url: string): string | null {
  const m = String(url).replace(/[?#].*$/, "").match(/^https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/([A-Za-z0-9_-]+)\/?$/i);
  if (!m || NOT_EVENTS.has(m[1].toLowerCase())) return null;
  return m[1];
}
// Pure: Exa's page title without Luma's own suffix.
export const eventTitle = (title: string | null | undefined) => String(title ?? "").replace(/\s*[·|–—-]\s*Luma\s*$/i, "").trim();

export type ViaExaEvent = DiscoveredEvent & { online?: boolean };
// What one search did, for the log (counts only: the query is the member's want). pages: event pages Exa returned; read: how many of
// those pages gave a start; notPublic: read but not listed as public by their host (dropped); kept: public, upcoming and inside the
// window.
// error: what failed and what to do about it, for the log (never the member: they get the feed's events as before).
export type ViaExaReport = { cached: boolean; error: string | null; pages: number; read: number; notPublic: number; kept: number };

// Pure: why a Luma search through Exa failed, said with its fix, from exaSearch's error (or what a call threw). Timed out, refused
// with an HTTP status, unreachable, unreadable: each its own line. Every one ends the same way, because that's what the member got.
const FEED_ALONE = "tier 2 went out from Luma's feed alone";
export function exaFailureReason(error: string | null): string | null {
  if (!error) return null;
  const status = error.match(/^Exa (\d{3})\b\s*(.*)$/);
  if (/timed out/i.test(error)) return `Exa timed out (no answer in ${LUMA_VIA_EXA.timeoutMs / 1000}s); ${FEED_ALONE}; the next search for this want asks Exa again (a failed search isn't kept)`;
  if (status) {
    const s = Number(status[1]);
    const tag = status[2] ? ` ${status[2]}` : "";
    if (s === 401 || s === 403) return `Exa refused the key (HTTP ${s}${tag}): check EXA_API_KEY on this service; ${FEED_ALONE}`;
    if (s === 402) return `Exa says the account is out of credit (HTTP 402${tag}): add credit in Exa's dashboard; ${FEED_ALONE}`;
    if (s === 429) return `Exa rate-limited the search (HTTP 429${tag}); ${FEED_ALONE}; the next search asks again`;
    if (s >= 500) return `Exa's own side failed (HTTP ${s}${tag}); ${FEED_ALONE}; the next search asks again`;
    return `Exa rejected the request (HTTP ${s}${tag}): the request services/lumaViaExa.ts builds needs fixing; ${FEED_ALONE}`;
  }
  if (/couldn't be reached/i.test(error)) return `Exa couldn't be reached (network): check this service's outbound connection to api.exa.ai; ${FEED_ALONE}`;
  if (/couldn't be read/i.test(error)) return `Exa answered with a reply that couldn't be read; ${FEED_ALONE}; the next search asks again`;
  if (/isn't configured/i.test(error)) return EXA_OFF;
  return `the Luma search through Exa threw (${error.replace(/^threw:\s*/, "").slice(0, 120)}); ${FEED_ALONE}`;
}
// Off, not failed: said once per start of the service (services/tieredRecommendation.ts), not on every search.
export const EXA_OFF = "EXA_API_KEY isn't set on this service, so tier 2 is Luma's feed alone; set EXA_API_KEY to turn on the Luma search through Exa";

export type LumaViaExaDeps = {
  exa: (query: string, o: { purpose: string; userId: string | null; pages: number; text: false; includeDomains: string[]; timeoutMs: number }) => Promise<ExaSearch>;
  page: (url: string) => Promise<EventDetails | null>;
  configured: () => boolean;
  now: () => Date;
};

type Found = { slug: string; title: string };
const cache = new Map<string, { at: number; found: Promise<{ found: Found[]; error: string | null }> }>();
export const clearLumaViaExaCache = () => cache.clear();

// Luma events Exa finds for this want: upcoming, inside the window (inRange decides, the same test the feed's events get), with the
// start, city and online flag from each event's own page. null when Exa isn't configured or there's no want. Never throws: a failed
// search or read is fewer events, and says so in the report.
export async function lumaEventsViaExa(
  what: string,
  city: string | null,
  o: { userId?: string | null; inRange: (startAt: string) => boolean; dates: string; deps?: Partial<LumaViaExaDeps> },
): Promise<{ events: ViaExaEvent[]; report: ViaExaReport } | null> {
  const deps = await realDeps(o.deps);
  if (!deps.configured() || !what.trim()) return null;
  const query = `${what.trim()}${city ? ` in ${city}` : ""}, ${o.dates}`;
  const key = query.toLowerCase();
  const now = deps.now();
  const hit = cache.get(key);
  const fresh = hit && now.getTime() - hit.at < LUMA_VIA_EXA.cacheHours * 3_600_000;
  let entry = fresh ? hit : null;
  if (!entry) {
    entry = { at: now.getTime(), found: search(query, o.userId ?? null, deps) };
    if (cache.size > 200) cache.clear();
    cache.set(key, entry);
  }
  const mine = entry;
  const { found, error } = await mine.found;
  // A failed search is never kept: the next ask searches again.
  if (error && cache.get(key) === mine) cache.delete(key);
  const read = await Promise.all(
    found.map(async ({ slug, title }): Promise<ViaExaEvent | "not_public" | null> => {
      // Read at the same url the feed uses, so the reads after this one (ranking, the gate) hit eventDetails' cache.
      const url = `https://lu.ma/${slug}`;
      const d = await deps.page(url).catch(() => null);
      if (!d?.startAt) return null;
      // A host's private or unlisted event never goes to strangers: the public feed only lists public events, and an event Exa found
      // by its url goes out only when its own page says "public". Unknown is not public (fails closed).
      if (d.visibility !== "public") return "not_public" as const;
      return { api_id: d.apiId ?? `luma:${slug}`, name: d.name || title, start_at: d.startAt, city: d.city ?? null, url, ...(d.online ? { online: true } : {}) };
    }),
  );
  const notPublic = read.filter((e) => e === "not_public").length;
  const listed = read.filter((e): e is ViaExaEvent => e !== null && e !== "not_public");
  const events = listed.filter((e) => new Date(e.start_at).getTime() > now.getTime() && o.inRange(e.start_at));
  return { events, report: { cached: !!fresh, error: exaFailureReason(error), pages: found.length, read: listed.length + notPublic, notPublic, kept: events.length } };
}

async function search(query: string, userId: string | null, deps: LumaViaExaDeps): Promise<{ found: Found[]; error: string | null }> {
  const r = await deps
    .exa(query, { purpose: "luma_events", userId, pages: LUMA_VIA_EXA.results, text: false, includeDomains: LUMA_DOMAINS, timeoutMs: LUMA_VIA_EXA.timeoutMs })
    .catch((err: any): ExaSearch => ({ pages: [], cost: null, error: `threw: ${String(err?.message ?? err).slice(0, 80)}` }));
  const seen = new Set<string>();
  const found: Found[] = [];
  for (const p of r.pages) {
    const slug = lumaEventSlug(p.url);
    const title = eventTitle(p.title);
    if (!slug || !title || seen.has(slug.toLowerCase())) continue;
    seen.add(slug.toLowerCase());
    found.push({ slug, title });
  }
  return { found, error: r.error };
}

async function realDeps(d: Partial<LumaViaExaDeps> = {}): Promise<LumaViaExaDeps> {
  const [X, E] = await Promise.all([import("./exaSearch.js"), import("./eventDetails.js")]);
  return {
    exa: d.exa ?? ((q, o) => X.exaSearch(q, o)),
    page: d.page ?? ((url) => E.fetchLumaEventDetails(url)),
    configured: d.configured ?? (() => X.exaConfigured()),
    now: d.now ?? (() => new Date()),
  };
}

// Pure: the feed's events plus the ones Exa found that the feed doesn't have (the same Luma slug, or the same Luma event id when the
// page gave one), feed first.
export function withExaEvents<T extends { url: string; api_id?: string }>(feed: T[], viaExa: T[]): T[] {
  const slugs = new Set(feed.map((e) => lumaEventSlug(e.url)?.toLowerCase()).filter(Boolean));
  const ids = new Set(feed.map((e) => e.api_id).filter(Boolean));
  const out = [...feed];
  for (const e of viaExa) {
    const slug = lumaEventSlug(e.url)?.toLowerCase();
    if ((slug && slugs.has(slug)) || (e.api_id && ids.has(e.api_id))) continue;
    if (slug) slugs.add(slug);
    if (e.api_id) ids.add(e.api_id);
    out.push(e);
  }
  return out;
}
