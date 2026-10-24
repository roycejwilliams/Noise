// Web search through Exa (Royce, 2026-10-16: "search will drive through Exa going forward"). Exa replaces only the FINDING:
// it returns real pages with their text, a model picks from those pages alone (any url it gives must be one of them), and every
// check after that is Cue's own, unchanged (the page read again, its name and details on it, past or closed turned away, the
// high-end bar). Luma stays the public-event tier and X stays a parallel source; only the web search moves here.
//
// On when EXA_API_KEY is set (a key, not a switch): without one, every caller keeps Anthropic's web search exactly as before.
// Royce, 2026-10-17: "Exa needed to be our main search engine for tier 3 along with X." On for every member wherever the key is set
// (co-test); member wants are the query text, and Exa's answer on data retention is still open.
// Cost: about $0.005 a search plus $0.001 a page of text (Exa's pricing, 2026-10); each search's reported cost is logged.
import { recordDecision } from "../harness/core.js";
import { skipsPaidSearch } from "./testMemberSpend.js";
import { scopeMember } from "./llmUsage.js";

export const EXA = {
  url: "https://api.exa.ai/search",
  // Pages per search, and how much of each page's text the picker reads.
  pages: 8,
  pageChars: 4000,
  // A page Exa read longer ago than this is read again (its cache otherwise): dates and "sold out" go stale.
  maxAgeHours: 48,
  timeoutMs: 20_000,
} as const;

export const exaConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => !!env.EXA_API_KEY?.trim();

export type ExaPage = { url: string; title: string; published: string | null; text: string };
export type ExaSearch = { pages: ExaPage[]; cost: number | null; error: string | null };

// One search. A failed search is no pages and says why; it never throws.
export async function exaSearch(
  query: string,
  o: { pages?: number; text?: boolean; pageChars?: number; country?: string | null; includeDomains?: string[]; sinceHours?: number; timeoutMs?: number; purpose: string; userId?: string | null; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: Date },
): Promise<ExaSearch> {
  const env = o.env ?? process.env;
  if (!exaConfigured(env)) return { pages: [], cost: null, error: "Exa isn't configured" };
  if (await skipsPaidSearch(o.userId, `exa.${o.purpose}`)) return { pages: [], cost: null, error: "a test account: paid search is off for it" };
  const text = o.text !== false;
  const body: Record<string, unknown> = {
    query: scrubQuery(query).slice(0, 600),
    type: "auto",
    numResults: Math.min(20, Math.max(1, o.pages ?? EXA.pages)),
    ...(o.country ? { userLocation: o.country } : {}),
    ...(o.includeDomains?.length ? { includeDomains: o.includeDomains.slice(0, 50) } : {}),
    ...(o.sinceHours ? { startPublishedDate: new Date((o.now ?? new Date()).getTime() - o.sinceHours * 3_600_000).toISOString() } : {}),
    ...(text ? { contents: { text: { maxCharacters: o.pageChars ?? EXA.pageChars }, maxAgeHours: EXA.maxAgeHours } } : {}),
  };
  let out: ExaSearch;
  try {
    const res = await (o.fetchImpl ?? fetch)(EXA.url, {
      method: "POST",
      headers: { "x-api-key": String(env.EXA_API_KEY).trim(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? EXA.timeoutMs),
    });
    const j: any = await res.json().catch(() => null);
    // Only the status and Exa's error tag are kept: its error text can echo the request (the member's want).
    if (!res.ok) out = { pages: [], cost: null, error: `Exa ${res.status}${typeof j?.tag === "string" ? ` ${j.tag.slice(0, 40)}` : ""}` };
    // A reply that can't be read is a failed search, never "nothing exists" (review: a 200 with an unreadable body read as no pages).
    else if (!j || !Array.isArray(j.results)) out = { pages: [], cost: null, error: "Exa sent a reply that couldn't be read" };
    else out = { pages: pagesFrom(j), cost: typeof j?.costDollars?.total === "number" ? j.costDollars.total : null, error: null };
  } catch (err: any) {
    out = { pages: [], cost: null, error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "Exa timed out" : "Exa couldn't be reached" };
  }
  // Counts and cost only: the query is the member's want, and what was kept is logged by the caller's own record.
  await recordDecision({ layer: 7, decision: "exa.search", userId: o.userId ?? scopeMember(), outcome: out.error ? "skip" : "act", action: o.purpose, reason: out.error, proposal: { pages: out.pages.length, cost: out.cost } }).catch(() => {});
  return out;
}

// Several searches at once (a site list, a recent-only pass, more than one search asked for), their pages merged in order, one per
// url. Failed only when every one failed; the cost is the sum of what each reported.
export async function exaSearches(queries: { query: string; includeDomains?: string[]; sinceHours?: number }[], o: Omit<Parameters<typeof exaSearch>[1], "includeDomains" | "sinceHours">): Promise<ExaSearch> {
  const all = await Promise.all(queries.map((q) => exaSearch(q.query, { ...o, includeDomains: q.includeDomains, sinceHours: q.sinceHours })));
  const seen = new Set<string>();
  const pages = all.flatMap((r) => r.pages).filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)));
  const costs = all.map((r) => r.cost).filter((c): c is number => typeof c === "number");
  return { pages, cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null, error: all.every((r) => r.error) ? all[0].error : null };
}

// Pure: what goes to Exa is the want, never a way to reach someone. An email address or a phone number in the query (a task Cue
// wrote can carry one) is taken out.
export function scrubQuery(q: string): string {
  return q
    .replace(/[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/gi, " ")
    .replace(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Known ad and email tracking only (Royce, 2026-10-17: "Strip only known ad tracking (utm and similar). Leave ref= alone, so a
// referral code or a GitHub branch survives."): utm_* campaign tags; ad click ids from Google (gclid, gbraid, wbraid, dclid),
// Meta (fbclid), Microsoft (msclkid), Yandex (yclid), X (twclid) and TikTok (ttclid); Instagram's share id (igshid); and email
// campaign ids from Mailchimp (mc_cid, mc_eid), HubSpot (_hsenc, _hsmi) and Marketo (mkt_tok). Anything else (ref, an event id, a
// date, a listing number) stays.
const TRACKING_PARAM = /^(utm_[a-z0-9_]*|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|twclid|ttclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok)$/i;

// Pure: a found link without its ad tracking tags (review of #225: Exa's links can carry utm_*, gclid, fbclid and the like, and Cue
// shouldn't send them to a member). Every other param is kept exactly as written, in order; a link with none to strip comes back
// as it was.
export function withoutTracking(url: string): string {
  const m = url.match(/^([^?#]*)\?([^#]*)(#.*)?$/);
  if (!m) return url;
  const kept = m[2].split("&").filter((part) => {
    if (!part) return false;
    const key = part.split("=")[0];
    try {
      return !TRACKING_PARAM.test(decodeURIComponent(key.replace(/\+/g, " ")));
    } catch {
      return true;
    }
  });
  const query = kept.join("&");
  if (query === m[2]) return url;
  return `${m[1]}${query ? `?${query}` : ""}${m[3] ?? ""}`;
}

// Pure: Exa's results as pages (https only, one per url, a title and the text it read). Each url loses its tracking tags here, once,
// so every pick, check, find and link after it carries the clean one.
export function pagesFrom(j: any): ExaPage[] {
  const seen = new Set<string>();
  const out: ExaPage[] = [];
  for (const r of Array.isArray(j?.results) ? j.results : []) {
    const url = typeof r?.url === "string" ? withoutTracking(r.url.trim()) : "";
    if (!/^https:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: String(r?.title ?? "").trim().slice(0, 200), published: typeof r?.publishedDate === "string" ? r.publishedDate.slice(0, 10) : null, text: String(r?.text ?? "").trim() });
  }
  return out;
}

// Pure: the pages, for a model that picks from them. Numbered, each with its url, title, date Exa gives, and its text.
export function pagesBlock(pages: ExaPage[]): string {
  return pages.map((p, i) => `[P${i + 1}] ${p.url}\nTitle: ${p.title || "(none)"}${p.published ? `\nPublished: ${p.published}` : ""}\n${p.text || "(no text read)"}`).join("\n\n---\n\n");
}

// What a picker prompt says instead of "search the web": it can't search; these pages are what was found. The search prompts keep
// every rule they had (shape, freshness, the page must state each detail); only where the pages come from changes.
export function fromPagesPrompt(prompt: string, pages: ExaPage[]): string {
  return `${prompt}

You can't search. These pages were found on the web for this just now, with the text on each as read: use only them. Any url you return must be one of these, exactly as written, and every name and detail you give must be stated in that page's text below. If none of them fits, say so in the format above.

${pagesBlock(pages)}`;
}

// Pure: a url the picker returned is one of the pages (a url it made up, or one off another site, is nothing). Compared without the
// scheme, "www.", a trailing slash, the fragment, tracking tags, ref and source, so a copy that lost a slash still counts; the page's
// own url (its ref kept) is what's returned.
export function onePage(url: unknown, pages: ExaPage[]): string | null {
  if (typeof url !== "string") return null;
  const key = (u: string) => {
    try {
      const x = new URL(u.trim());
      for (const k of [...x.searchParams.keys()]) if (TRACKING_PARAM.test(k) || /^(ref|source)$/i.test(k)) x.searchParams.delete(k);
      return `${x.hostname.replace(/^www\./, "").toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.searchParams.toString() ? `?${x.searchParams}` : ""}`;
    } catch {
      return null;
    }
  };
  const k = key(url);
  if (!k) return null;
  return pages.find((p) => key(p.url) === k)?.url ?? null;
}
