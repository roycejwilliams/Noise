// A find that isn't a Luma page but carries one (Royce, 2026-11-09): many tier-3 finds (an X post, a web page) link the event's Luma page.
// Before registration is offered on such a find, its Luma link is resolved, never guessed:
//   1. only a Luma event link found in the find's own checked content: its link, the X post's text, the page Cue read (its final url
//      and its excerpt). Never searched for, never built from a name.
//   2. a short link in that content (t.co and the like) is expanded only by following its redirect, read-only (linkReader.ts safeFetch:
//      a GET, every hop checked), and kept only if it lands on a Luma event page.
//   3. that public Luma page is read (read-only) and has to be the SAME event: the same day (and within an hour when both carry a time,
//      in the event's own zone), and the same title or the same host. Not sure is no: the find stays link-only, as today.
import { DateTime } from "luxon";
import { canonicalEventUrl } from "./registration.js";

export type FindLike = {
  name: string;
  url: string | null;
  postText?: string | null;
  read?: { finalUrl?: string | null; excerpt?: string | null } | null;
  details?: { startAt?: string | null; timezone?: string | null; hosts?: string[] } | null;
};
export type LumaPage = { name: string | null; startAt: string | null; zone: string | null; hosts: string[] };

const LUMA_LINK = /https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/[A-Za-z0-9_/-]+/gi;
const SHORT_LINK = /https?:\/\/(?:t\.co|bit\.ly|tinyurl\.com|buff\.ly|ow\.ly|lnkd\.in)\/[A-Za-z0-9_-]+/gi;

const contentOf = (f: FindLike) => [f.url ?? "", f.postText ?? "", f.read?.finalUrl ?? "", f.read?.excerpt ?? ""].join("\n");

// Pure: the Luma event links in the find's own content, canonical, once each.
export function lumaLinksIn(f: FindLike): string[] {
  const out: string[] = [];
  for (const m of contentOf(f).match(LUMA_LINK) ?? []) {
    const c = canonicalEventUrl(m.replace(/[).,;!?]+$/, ""));
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
// Pure: the short links in the find's own content (expanded only by following their redirect).
export function shortLinksIn(f: FindLike): string[] {
  return [...new Set((contentOf(f).match(SHORT_LINK) ?? []).map((u) => u.replace(/[).,;!?]+$/, "")))];
}

const words = (s: string | null | undefined) => new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
const STOP = new Set(["the", "and", "for", "with", "event", "night", "meetup", "presents", "edition", "from", "your", "our"]);

// Pure: whether the Luma page is the same event the find described. Null when it can't be told (no date on one side): not the same.
export function sameEvent(find: FindLike, page: LumaPage): { same: boolean; why: string } {
  const fStart = find.details?.startAt ?? null;
  if (!fStart || !page.startAt) return { same: false, why: "a date is missing on one side, so it can't be confirmed as the same event" };
  const zone = page.zone ?? find.details?.timezone ?? "UTC";
  const a = DateTime.fromISO(fStart, { zone }), b = DateTime.fromISO(page.startAt, { zone });
  if (!a.isValid || !b.isValid) return { same: false, why: "a date couldn't be read" };
  if (a.toISODate() !== b.toISODate()) return { same: false, why: `different days (${a.toISODate()} vs ${b.toISODate()})` };
  const timed = /T\d{2}:\d{2}/.test(fStart) && !/T00:00(:00(\.0+)?)?/.test(fStart);
  if (timed && Math.abs(a.toMillis() - b.toMillis()) > 60 * 60_000) return { same: false, why: "different start times" };
  const fw = words(find.name), pw = words(page.name);
  const shared = [...fw].filter((w) => pw.has(w)).length;
  const titleMatch = fw.size > 0 && pw.size > 0 && shared / Math.min(fw.size, pw.size) >= 0.5;
  const fh = new Set((find.details?.hosts ?? []).map((h) => h.toLowerCase().trim()));
  const hostMatch = page.hosts.some((h) => fh.has(h.toLowerCase().trim()));
  if (!titleMatch && !hostMatch) return { same: false, why: "neither the title nor the host matches" };
  return { same: true, why: titleMatch ? "same day and title" : "same day and host" };
}

export type ResolveDeps = {
  // Follows a short link's redirects read-only; the final url, or null.
  expand: (url: string) => Promise<string | null>;
  // Reads a Luma event page's public data, read-only.
  readPage: (url: string) => Promise<LumaPage | null>;
};

// The find's Luma event page, when its own content carries one and it's the same event. Null otherwise (the find stays link-only).
export async function lumaPageForFind(f: FindLike, deps: ResolveDeps): Promise<{ url: string; why: string } | { url: null; why: string }> {
  const direct = f.url ? canonicalEventUrl(f.url) : null;
  if (direct) return { url: direct, why: "the find is a Luma page" };
  let links = lumaLinksIn(f);
  if (!links.length) {
    for (const s of shortLinksIn(f).slice(0, 3)) {
      const to = await deps.expand(s).catch(() => null);
      const c = to ? canonicalEventUrl(to) : null;
      if (c && !links.includes(c)) links.push(c);
    }
  }
  if (!links.length) return { url: null, why: "no Luma link in the find's own content" };
  // More than one Luma event in one find: which one it means can't be told.
  if (links.length > 1) links = links.slice(0, 2);
  const results = await Promise.all(links.map(async (u) => ({ u, page: await deps.readPage(u).catch(() => null) })));
  const same = results.filter((r) => r.page && sameEvent(f, r.page).same);
  if (same.length !== 1) return { url: null, why: same.length ? "more than one Luma page matches" : results[0]?.page ? sameEvent(f, results[0].page).why : "the Luma page couldn't be read" };
  return { url: same[0].u, why: sameEvent(f, same[0].page!).why };
}

// The real dependencies: a read-only redirect follow, and the page's public data through the driver's inspect read.
export async function realResolveDeps(): Promise<ResolveDeps> {
  const { safeFetch } = await import("../linkReader.js");
  const { pageDataFrom } = await import("./lumaDriver.js");
  return {
    expand: async (u) => {
      const r = await safeFetch(u);
      return "finalUrl" in r ? r.finalUrl : null;
    },
    readPage: async (u) => {
      const r = await safeFetch(u);
      if (!("body" in r)) return null;
      const m = r.body.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!m) return null;
      const d = pageDataFrom(JSON.parse(m[1]));
      return { name: d.name, startAt: d.startAt, zone: d.zone, hosts: d.hosts };
    },
  };
}
