// One event, however many pages carry it (Royce, 2026-10-28: "the same event is often on Luma and Eventbrite, or cross-posted to
// Partiful"). Two finds are one event when they share a name once case, emoji, punctuation and "#SFTechWeek"-style tags are set aside,
// start within EVENT_SAME.startMinutes of each other, and are in the same city or at the same venue. Of the two, the one with the richest
// verified event data is kept; on a tie, the Luma one (its RSVP path is ours). Read from each find's own record only (its name, its
// page's start, city and venue), never from what anyone wrote about it.
//
// Used where finds already met: the backlog merge (eventSurfacingSweep.ts sameMatch, mergeFinds), the event search's own pages
// (tieredRecommendation.ts eventCandidates), the picker's pool (sweepShadow.ts buildShadowPool) and what was already shown
// (harness/matchGate.ts offerHistory), so a member never gets the same event twice under two links.

export const EVENT_SAME = { startMinutes: 30 } as const;

// What identity reads off a find: the shapes the finds come in (a TierMatch, a backlog item's match, a feed event).
export type EventLike = {
  name?: string | null;
  url?: string | null;
  startAt?: string | null;
  start_at?: string | null;
  event_date?: string | null;
  city?: string | null;
  venue?: string | null;
  details?: { startAt?: string | null; city?: string | null; venue?: string | null; [k: string]: unknown } | null;
};

// Pure: a name with case, emoji, punctuation and hashtags set aside ("SF Tech Week: AI Mixer 🚀 #SFTechWeek" -> "sf tech week ai mixer").
export function eventNameKey(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/#[\p{L}\p{N}_]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const startOf = (e: EventLike): number | null => {
  const s = e.details?.startAt ?? e.startAt ?? e.start_at ?? null;
  const t = s ? Date.parse(String(s)) : NaN;
  return Number.isFinite(t) ? t : null;
};
const placeKey = (s: string | null | undefined) => {
  const c = String(s ?? "").split(",")[0].trim().toLowerCase().replace(/\./g, "");
  const alias: Record<string, string> = { sf: "san francisco", "san fran": "san francisco", nyc: "new york", "new york city": "new york", la: "los angeles" };
  return alias[c] ?? c;
};

// Pure: whether two finds are one event. A find with no start of its own is never merged by name alone (two "Founder Dinner"s on
// different nights are two events).
export function sameEvent(a: EventLike, b: EventLike): boolean {
  const na = eventNameKey(a.name);
  if (!na || na !== eventNameKey(b.name)) return false;
  const sa = startOf(a);
  const sb = startOf(b);
  if (sa === null || sb === null || Math.abs(sa - sb) > EVENT_SAME.startMinutes * 60_000) return false;
  const ca = placeKey(a.details?.city ?? a.city);
  const cb = placeKey(b.details?.city ?? b.city);
  const va = placeKey(a.details?.venue ?? a.venue);
  const vb = placeKey(b.details?.venue ?? b.venue);
  return (!!ca && ca === cb) || (!!va && va === vb);
}

const isLuma = (url: string | null | undefined) => /^https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\//i.test(String(url ?? ""));

// Pure: how much verified event data a find carries (its page's own record: start, end, zone, place, hosts, price, spots, sold out,
// description), for keeping the richer of two.
export function eventRichness(e: EventLike): number {
  const d = (e.details ?? {}) as Record<string, unknown>;
  const has = (v: unknown) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length);
  return ["startAt", "endAt", "timezone", "venue", "address", "city", "hosts", "price", "spotsRemaining", "soldOut", "description"].filter((k) => has(d[k])).length;
}

// Pure: the one to keep of two that are one event: the richer, else the Luma one, else the first.
export function preferEvent<T extends EventLike>(a: T, b: T): T {
  const ra = eventRichness(a);
  const rb = eventRichness(b);
  if (ra !== rb) return ra > rb ? a : b;
  if (isLuma(b.url) && !isLuma(a.url)) return b;
  return a;
}

// Pure: a list with each event kept once (the preferred version, in the first one's place).
export function collapseEvents<T>(items: T[], of: (t: T) => EventLike = (t) => t as unknown as EventLike): T[] {
  const out: T[] = [];
  for (const it of items) {
    const i = out.findIndex((o) => sameEvent(of(o), of(it)));
    if (i === -1) out.push(it);
    else if (preferEvent(of(out[i]), of(it)) === of(it)) out[i] = it;
  }
  return out;
}
