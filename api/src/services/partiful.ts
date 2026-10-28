// Partiful's public listings as an event source (Royce, 2026-10-28), read the way Luma's feed is read: a city's public explore page
// (partiful.com/explore/sf) lists its public events as schema.org data (an ItemList of /e/<id> links); each event's own page is then
// read for its own record (eventPage.ts: public by its own data, one event, its zone, its city only). Only the explore page's own list is
// followed: never an invite link from anywhere else, and an event page whose data doesn't say it's public is left out.
//
// robots.txt (read 2026-10-28): Partiful names search engines and link-preview bots as allowed and AI-training crawlers (GPTBot,
// ClaudeBot, CCBot...) as disallowed, with no rule for any other agent; Cue's reader isn't a training crawler and isn't named, so the
// explore pages are allowed to it. Every fetch goes through linkReader.ts safeFetch (every redirect hop checked).
//
// Capped: one explore page and PARTIFUL_LIMITS.events event pages a read, the whole read inside PARTIFUL_LIMITS.deadlineMs (what's read
// by then is used), cached per city and day reached for PARTIFUL_LIMITS.cacheMs (the Luma feed's cache, tieredRecommendation.ts).
// A failed explore read throws (the event search says it, and a timeout is an outage by searchFailure.ts transientFailure).
import { readEventPage, type EventPageDeps, type PageEvent } from "./eventPage.js";
import type { EventDetails } from "./eventDetails.js";

export const PARTIFUL_LIMITS = { events: 12, deadlineMs: 10_000, cacheMs: 15 * 60_000 } as const;

// Partiful's explore cities (its own /explore/<slug> pages, 2026-10-28), by the names members' places come in.
export const PARTIFUL_CITIES: Record<string, string> = {
  "san francisco": "sf", sf: "sf", "new york": "nyc", nyc: "nyc", "new york city": "nyc", "los angeles": "la", la: "la",
  chicago: "chi", "washington": "dc", "washington dc": "dc", dc: "dc", boston: "bos", austin: "atx", miami: "mia", london: "lon",
};

// Pure: the explore page for a city, or null (no Partiful listing there: not a failure, nothing to read).
export function partifulExploreUrl(city: string | null | undefined): string | null {
  const c = String(city ?? "").split(",")[0].trim().toLowerCase().replace(/\./g, "");
  const slug = PARTIFUL_CITIES[c];
  return slug ? `https://partiful.com/explore/${slug}` : null;
}

// Pure: the public event links an explore page lists in its own schema.org ItemList (partiful.com/e/<id> only), in order, once each.
export function exploreEventLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: any;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    for (const list of (Array.isArray(data) ? data : [data]).filter((d: any) => d?.["@type"] === "ItemList")) {
      for (const it of Array.isArray(list.itemListElement) ? list.itemListElement : []) {
        const u = String(it?.url ?? it?.item?.url ?? it?.item ?? "").replace(/[?#].*$/, "");
        if (/^https:\/\/partiful\.com\/e\/[A-Za-z0-9_-]+$/.test(u) && !out.includes(u)) out.push(u);
      }
    }
  }
  return out;
}

export type PartifulEvent = { api_id: string; name: string; start_at: string; city: string | null; url: string; online?: boolean; details: EventDetails };

const cache = new Map<string, { at: number; events: PartifulEvent[] }>();
export const clearPartifulCache = () => cache.clear();

// A city's public Partiful events up to `until`, each from its own page's record. Null when Partiful has no explore page for the city.
export async function partifulEvents(city: string | null, until: Date, o: { deps?: EventPageDeps; now?: () => number } = {}): Promise<PartifulEvent[] | null> {
  const explore = partifulExploreUrl(city);
  if (!explore) return null;
  const now = o.now ?? Date.now;
  const key = `${explore}|${until.toISOString().slice(0, 10)}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < PARTIFUL_LIMITS.cacheMs) return hit.events;
  const deps = o.deps ?? (await (await import("./eventPage.js")).realEventPageDeps());
  const page = await deps.fetchHtml(explore).catch((err: any) => ({ html: null, error: String(err?.message ?? err) }));
  // Said so its kind reads right (searchFailure.ts): a network failure as "couldn't be reached", a timeout as itself, a status as itself.
  if (!page.html) throw new Error(`Partiful's explore page ${page.error === "couldn't load" ? "couldn't be reached" : `failed (${page.error ?? "no page"})`}`);
  const links = exploreEventLinks(page.html).slice(0, PARTIFUL_LIMITS.events);
  const deadline = new Promise<null>((r) => setTimeout(() => r(null), PARTIFUL_LIMITS.deadlineMs).unref?.());
  const reads = await Promise.all(links.map((u) => Promise.race([readEventPage(u, { deps }).then((r) => r.event).catch(() => null), deadline])));
  const events = reads
    .map((ev, i) => ({ ev, url: links[i] }))
    .filter((x): x is { ev: PageEvent; url: string } => !!x.ev?.startAt && Date.parse(x.ev.startAt) > now() && Date.parse(x.ev.startAt) <= until.getTime())
    .map(({ ev, url }) => {
      const { name, ...details } = ev;
      return { api_id: url, name, start_at: ev.startAt!, city: ev.city, url, ...(ev.online ? { online: true } : {}), details };
    });
  if (cache.size > 20) cache.clear();
  cache.set(key, { at: now(), events });
  return events;
}
