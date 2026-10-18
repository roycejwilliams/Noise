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

// ---------------------------------------------------------------- what Exa is sent (Royce, 2026-10-18, option (d): "Send Exa only a
// generic search, never the member's words.") Exa's API terms (1.2(c)) license Exa to keep and use whatever it's sent, forever. So
// the query is built only from fixed parts: kinds of event from this list (matched in the want, never copied from it), the city,
// the dates Cue worked out, and online or in person. No name, company, goal, plan or any other word of theirs. A want with no kind
// on the list searches plain "events" for the city and dates.
// Matches are narrow on purpose: a word that's also everyday talk ("talk about her raise", "book a table", "no energy") isn't one.
export const EVENT_KINDS: readonly { kind: string; match: RegExp }[] = [
  { kind: "startup founder", match: /\b(founders?|startups?|entrepreneurs?)\b/i },
  { kind: "investor", match: /\b(investors?|vcs?|venture capital|angels? investors?|lps?)\b/i },
  { kind: "climate tech", match: /\b(climate|clean ?tech|sustainab\w*|renewables?|clean energy)\b/i },
  { kind: "hardware", match: /\b(hardware|robotics?|deep ?tech|hard ?tech)\b/i },
  { kind: "AI", match: /\b(ai|a\.i\.|machine learning|llms?|artificial intelligence)\b/i },
  { kind: "tech", match: /\b(tech|engineers?|developers?|devtools|software|coding)\b/i },
  { kind: "design", match: /\b(design|designers?|ux)\b/i },
  { kind: "hackathon", match: /\bhackathons?\b/i },
  { kind: "demo day", match: /\b(demo days?|pitch (nights?|events?))\b/i },
  { kind: "networking", match: /\b(networking|mixers?)\b/i },
  { kind: "meetup", match: /\bmeet-?ups?\b/i },
  { kind: "talk", match: /\b(talks|panels?|fireside chats?|lectures?|speaker series|speaker events?)\b/i },
  { kind: "conference", match: /\b(conferences?|summits?)\b/i },
  { kind: "workshop", match: /\b(workshops?|classes?)\b/i },
  { kind: "supper club", match: /\bsupper clubs?\b/i },
  { kind: "chef's table dinner", match: /\bchef'?s tables?\b/i },
  { kind: "dinner", match: /\b(dinners?|dining)\b/i },
  { kind: "wine tasting", match: /\b(wine|tastings?)\b/i },
  { kind: "happy hour", match: /\b(happy hours?|drinks|cocktails?)\b/i },
  { kind: "live music", match: /\b(live music|concerts?|gigs?|shows?)\b/i },
  { kind: "jazz", match: /\bjazz\b/i },
  { kind: "art gallery opening", match: /\b(galler(y|ies)|art openings?|art receptions?|exhibitions?|exhibits?)\b/i },
  { kind: "art", match: /\b(art|artists?)\b/i },
  { kind: "film screening", match: /\b(films?|screenings?|movies?|cinema)\b/i },
  { kind: "comedy", match: /\b(comedy|stand-?up)\b/i },
  { kind: "book club", match: /\b(book clubs?|author talks?|book readings?|poetry readings?|literary)\b/i },
  { kind: "run club", match: /\b(run clubs?|running clubs?|group runs?|5k|10k)\b/i },
  { kind: "hiking", match: /\b(hik(e|es|ing)|trails?|outdoors?)\b/i },
  { kind: "yoga", match: /\byoga\b/i },
  { kind: "wellness", match: /\b(wellness|meditation|breathwork|sound baths?)\b/i },
  { kind: "dance", match: /\b(danc(e|es|ing)|club nights?|djs?)\b/i },
  { kind: "party", match: /\bpart(y|ies)\b/i },
  { kind: "community", match: /\bcommunity\b/i },
  { kind: "fundraiser", match: /\b(fundraisers?|galas?|charity)\b/i },
];
const MAX_KINDS = 3;
// A city is a place name only: letters, spaces and . ' - , at most 40 characters (anything else is left out of the search).
const CITY = /^[A-Za-z][A-Za-z .'-]{1,39}$/;
// The dates as eventCandidates writes them ("October 19 to October 25, 2026"); anything else is left out.
const DATES = /^[A-Z][a-z]+ \d{1,2} to [A-Z][a-z]+ \d{1,2}, \d{4}$/;

// Pure: the one Exa query for a Luma event search, from fixed parts only, and the kinds it used.
export function lumaExaQuery(what: string, city: string | null, dates: string): { query: string; kinds: string[] } {
  const text = String(what ?? "");
  const kinds = EVENT_KINDS.filter((k) => k.match.test(text)).map((k) => k.kind);
  // "supper club" and "chef's table dinner" already say dinner; "art gallery opening" already says art.
  const shown = kinds.filter((k) => !(k === "dinner" && kinds.some((x) => /dinner|supper/.test(x) && x !== "dinner")) && !(k === "art" && kinds.includes("art gallery opening"))).slice(0, MAX_KINDS);
  const how = /\b(online|virtual|zoom|remote)\b/i.test(text) ? " online" : /\bin[- ]person\b/i.test(text) ? " in person" : "";
  const place = city && CITY.test(city.trim()) ? ` in ${city.trim()}` : "";
  const when = DATES.test(dates.trim()) ? `, ${dates.trim()}` : "";
  return { query: `${shown.length ? `${shown.join(", ")} ` : ""}events${how}${place}${when}`, kinds: shown };
}
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
// refused: pages Luma wouldn't serve (HTTP 429), left out unread.
// kinds: the fixed kinds the search used (from EVENT_KINDS, never their words).
export type ViaExaReport = { cached: boolean; error: string | null; pages: number; read: number; notPublic: number; refused?: number; kept: number; kinds?: string[] };

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
// Luma refused this search's page reads (429): said with its count, and what happens next.
export const lumaRefusedReason = (refused: number, pages: number, pauseMinutes: number) =>
  `Luma refused ${refused} of ${pages} page reads (429): those events couldn't be checked, so they were left out; the Luma search through Exa pauses for ${pauseMinutes} minutes so the feed's own page reads go first`;
// Luma refusing reads in the last few minutes: no Exa search at all (its results couldn't be read, so it would be paid for nothing).
export const lumaRefusingReason = (pauseMinutes: number) =>
  `Luma refused page reads (429) in the last ${pauseMinutes} minutes, so no Luma search through Exa (its results couldn't be read); ${FEED_ALONE}; it searches again once ${pauseMinutes} minutes pass without a refusal`;

// ---------------------------------------------------------------- the daily budget (Royce, 2026-10-18: "60 a day, 20 held for member asks")
// All members together: LUMA_EXA_DAILY_CAP Exa searches in any 24 hours, LUMA_EXA_REQUEST_RESERVE of them held for what a member
// asked for (replies and tasks); the sweep stops at the cap minus the reserve. Limits, not switches. A cache hit makes no Exa call,
// so it doesn't count. The same shape and lock as the web search budget (services/webOpportunitySearch.ts reserveWebSearch).
const envLimit = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
export const LUMA_EXA_BUDGET = { dailyCap: envLimit(process.env.LUMA_EXA_DAILY_CAP, 60), requestReserve: envLimit(process.env.LUMA_EXA_REQUEST_RESERVE, 20) };
export type LumaExaSource = "request" | "sweep";

// Pure: whether one more Luma search through Exa fits today's budget, and why not, with what the member got.
export function lumaExaBudget(usedToday: number, source: LumaExaSource, dailyCap: number = LUMA_EXA_BUDGET.dailyCap, requestReserve: number = LUMA_EXA_BUDGET.requestReserve): { ok: boolean; reason: string | null } {
  const reserve = Math.max(0, Math.min(requestReserve, dailyCap));
  if (usedToday >= dailyCap) return { ok: false, reason: `the daily cap of ${dailyCap} Luma searches through Exa is reached; ${FEED_ALONE}; it frees up as the 24-hour window rolls` };
  if (source === "sweep" && usedToday >= dailyCap - reserve)
    return { ok: false, reason: `the sweep's share of Luma searches through Exa is used (${dailyCap - reserve} of ${dailyCap}; the rest is held for member asks); ${FEED_ALONE}; it frees up as the 24-hour window rolls` };
  return { ok: true, reason: null };
}

// Reserves one search against the budget, or says why not. The count and the insert happen under one transaction-scoped advisory
// lock, so two searches can't both take the last slot. Fails closed: if the budget can't be checked, there's no Exa search. The log
// keeps who, which share and when: never the query (it's the member's want).
export async function reserveLumaExaSearch(userId: string | null, source: LumaExaSource, db?: { connect: () => Promise<any> }): Promise<{ ok: boolean; reason: string | null }> {
  let client: any = null;
  try {
    client = await (db ?? (await import("../db/db.js")).default).connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('luma_exa_search_budget'))");
    const { rows } = await client.query(`SELECT COUNT(*)::int AS today FROM luma_exa_search_log WHERE created_at > NOW() - INTERVAL '1 day'`);
    const decision = lumaExaBudget(Number(rows[0]?.today ?? 0), source);
    if (!decision.ok) {
      await client.query("ROLLBACK");
      return decision;
    }
    await client.query(`INSERT INTO luma_exa_search_log (user_id, source) VALUES ($1, $2)`, [userId, source]);
    await client.query("COMMIT");
    return decision;
  } catch (err: any) {
    await client?.query("ROLLBACK").catch(() => {});
    return { ok: false, reason: `the daily budget for Luma searches through Exa couldn't be checked (${String(err?.message ?? err).slice(0, 80)}), so no Exa search; ${FEED_ALONE}` };
  } finally {
    client?.release?.();
  }
}

// Off, not failed: said once per start of the service (services/tieredRecommendation.ts), not on every search.
export const EXA_OFF = "EXA_API_KEY isn't set on this service, so tier 2 is Luma's feed alone; set EXA_API_KEY to turn on the Luma search through Exa";

export type LumaViaExaDeps = {
  exa: (query: string, o: { purpose: string; userId: string | null; pages: number; text: false; includeDomains: string[]; timeoutMs: number }) => Promise<ExaSearch>;
  // A page's details, null when it has none, or "refused" when Luma wouldn't serve it (429).
  page: (url: string) => Promise<EventDetails | null | "refused">;
  configured: () => boolean;
  now: () => Date;
  // Luma refused a page read in the last LUMA_REFUSAL_PAUSE_MINUTES (services/eventDetails.ts).
  refusing: () => boolean;
  pauseMinutes: number;
  reserve: (userId: string | null, source: LumaExaSource) => Promise<{ ok: boolean; reason: string | null }>;
};

type Found = { slug: string; title: string };
// reason: a refusal already said in full (the budget), not an Exa error to explain.
type Searched = { found: Found[]; error: string | null; reason?: string };
const cache = new Map<string, { at: number; found: Promise<Searched> }>();
export const clearLumaViaExaCache = () => cache.clear();

// Luma events Exa finds for this want: upcoming, inside the window (inRange decides, the same test the feed's events get), with the
// start, city and online flag from each event's own page. null when Exa isn't configured or there's no want. Never throws: a failed
// search or read is fewer events, and says so in the report.
export async function lumaEventsViaExa(
  what: string,
  city: string | null,
  o: { userId?: string | null; source?: LumaExaSource; inRange: (startAt: string) => boolean; dates: string; deps?: Partial<LumaViaExaDeps> },
): Promise<{ events: ViaExaEvent[]; report: ViaExaReport } | null> {
  const deps = await realDeps(o.deps);
  if (!deps.configured() || !what.trim()) return null;
  // Luma is refusing reads: no search, and no reads of a cached one either (each would add to what Luma is refusing).
  if (deps.refusing()) return { events: [], report: { cached: false, error: lumaRefusingReason(deps.pauseMinutes), pages: 0, read: 0, notPublic: 0, refused: 0, kept: 0 } };
  // Never their words: the query (and so the cache key) is built from fixed parts only.
  const { query, kinds } = lumaExaQuery(what, city, o.dates);
  const key = query.toLowerCase();
  const now = deps.now();
  const hit = cache.get(key);
  const fresh = hit && now.getTime() - hit.at < LUMA_VIA_EXA.cacheHours * 3_600_000;
  let entry = fresh ? hit : null;
  if (!entry) {
    // Only a search that will call Exa takes a slot of the daily budget; the sweep is the default share (the stricter one).
    const userId = o.userId ?? null;
    entry = {
      at: now.getTime(),
      found: deps
        .reserve(userId, o.source ?? "sweep")
        .catch((err: any) => ({ ok: false, reason: `the daily budget for Luma searches through Exa couldn't be checked (${String(err?.message ?? err).slice(0, 80)}), so no Exa search; ${FEED_ALONE}` }))
        .then((b): Promise<Searched> => (b.ok ? search(query, userId, deps) : Promise.resolve({ found: [], error: "budget", reason: b.reason ?? "no budget" }))),
    };
    if (cache.size > 200) cache.clear();
    cache.set(key, entry);
  }
  const mine = entry;
  const { found, error, reason } = await mine.found;
  // A failed search is never kept: the next ask searches again.
  if (error && cache.get(key) === mine) cache.delete(key);
  const read = await Promise.all(
    found.map(async ({ slug, title }): Promise<ViaExaEvent | "not_public" | "refused" | null> => {
      // Read at the same url the feed uses, so the reads after this one (ranking, the gate) hit eventDetails' cache.
      const url = `https://lu.ma/${slug}`;
      const d = await deps.page(url).catch(() => null);
      if (d === "refused") return "refused" as const;
      if (!d?.startAt) return null;
      // A host's private or unlisted event never goes to strangers: the public feed only lists public events, and an event Exa found
      // by its url goes out only when its own page says "public". Unknown is not public (fails closed).
      if (d.visibility !== "public") return "not_public" as const;
      return { api_id: d.apiId ?? `luma:${slug}`, name: d.name || title, start_at: d.startAt, city: d.city ?? null, url, ...(d.online ? { online: true } : {}) };
    }),
  );
  const notPublic = read.filter((e) => e === "not_public").length;
  const refused = read.filter((e) => e === "refused").length;
  const listed = read.filter((e): e is ViaExaEvent => e !== null && e !== "not_public" && e !== "refused");
  const events = listed.filter((e) => new Date(e.start_at).getTime() > now.getTime() && o.inRange(e.start_at));
  const why = reason ?? exaFailureReason(error) ?? (refused ? lumaRefusedReason(refused, found.length, deps.pauseMinutes) : null);
  return { events, report: { cached: !!fresh, error: why, pages: found.length, read: listed.length + notPublic, notPublic, refused, kept: events.length, kinds } };
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
    page: d.page ?? ((url) => E.readLumaEventPage(url).then((r) => (r.refused ? ("refused" as const) : r.details))),
    configured: d.configured ?? (() => X.exaConfigured()),
    now: d.now ?? (() => new Date()),
    refusing: d.refusing ?? (() => E.lumaRefusedRecently()),
    pauseMinutes: d.pauseMinutes ?? E.LUMA_REFUSAL_PAUSE_MINUTES,
    reserve: d.reserve ?? ((userId, source) => reserveLumaExaSearch(userId, source)),
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
