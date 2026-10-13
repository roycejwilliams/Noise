// X (formerly Twitter) recent search — Tier 3's real data source for
// accelerators, fellowships, and other high-agency opportunities, replacing
// the earlier Google-Places-based venue lookup for this tier. Pay-per-use
// pricing confirmed 2026-08-30: $0.005 per post read, no subscription, no
// Enterprise contract needed for recent (last 7 days) search — that's only
// required for full historical archive search back to 2006, which isn't
// what this needs (an accelerator's applications being open NOW is exactly
// a "last 7 days" question).
import { xPostLinks } from "./linkReader.js";

const X_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";

// 20 posts a search, as the old Tier 3 pipeline read (2026-09-17: a good post
// buried past the top 10 was never seen). 2026-10-07: back to 20 after the
// loop's searches came back at 10 with nothing usable.
export const X_SEARCH_RESULTS = 20;

export type XPost = {
  id: string;
  // The post as written, with X's t.co short links replaced by where they
  // really go (2026-10-07: posts arrived as bare t.co links, so nothing could
  // be checked or sent).
  text: string;
  author_id: string;
  author: string | null; // @username, when X returned it
  // The post itself, always in the x.com/i/status/<id> form the match gate
  // checks for (harness/matchGate.ts checkGrounding).
  url: string;
  links: string[]; // what the post links to, expanded (not X's own photo/post links)
};

function xHeaders(): Record<string, string> {
  const token = process.env.X_API_BEARER_TOKEN;
  if (!token) throw new Error("xSearch: X_API_BEARER_TOKEN is not configured");
  return { Authorization: `Bearer ${token}` };
}

// English originals only. -is:retweet (2026-09-02): the same post retweeted
// 4+ times crowded out real candidates. lang:en (2026-09-18, restored
// 2026-10-07): other-language spam did the same. A query that already says
// either keeps its own.
export function xSearchQuery(query: string): string {
  const q = query.trim();
  return [q, /-is:retweet/.test(q) ? "" : "-is:retweet", /\blang:/.test(q) ? "" : "lang:en"].filter(Boolean).join(" ");
}

// sinceHours: only posts from the last that many hours (the 9am daily sweep looks at what's new overnight, services/dailySweep.ts).
export function xSearchUrl(query: string, maxResults = X_SEARCH_RESULTS, now = new Date(), sinceHours?: number): URL {
  const url = new URL(X_SEARCH_URL);
  if (sinceHours) url.searchParams.set("start_time", new Date(now.getTime() - sinceHours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"));
  url.searchParams.set("query", xSearchQuery(query));
  // X's own bounds for recent search.
  url.searchParams.set("max_results", String(Math.min(100, Math.max(10, maxResults))));
  // entities: the real URLs behind t.co. note_tweet: the full text of long posts.
  url.searchParams.set("tweet.fields", "author_id,created_at,entities,note_tweet");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username");
  return url;
}

// One post from the API response, with its links expanded. Pure.
export function expandPost(post: any, usernames: Map<string, string> = new Map()): XPost {
  const long = post?.note_tweet?.text ? post.note_tweet : null;
  let text = String(long?.text ?? post?.text ?? "");
  const ents: any[] = [...(post?.entities?.urls ?? []), ...(long?.entities?.urls ?? [])];
  for (const u of ents) {
    if (!u?.url) continue;
    const real = String(u.unwound_url ?? u.expanded_url ?? "");
    // A photo or video's link is the post itself: drop it from the text.
    const media = u.media_key || /\/(photo|video)\/\d+/.test(real);
    text = text.split(u.url).join(media || !real ? "" : real);
  }
  const author = usernames.get(post?.author_id) ?? null;
  return {
    id: post.id,
    text: text.replace(/[ \t]+\n/g, "\n").trim(),
    author_id: post.author_id,
    author,
    url: `https://x.com/i/status/${post.id}`,
    // X's own pages (articles behind a login) aren't a program's page.
    links: xPostLinks({ entities: { urls: ents } }).filter((l) => !/^https?:\/\/(www\.)?(x|twitter)\.com\//.test(l)),
  };
}

export async function searchRecentPosts(query: string, maxResults = X_SEARCH_RESULTS, opts: { sinceHours?: number } = {}): Promise<XPost[]> {
  const res = await fetch(xSearchUrl(query, maxResults, new Date(), opts.sinceHours), { headers: xHeaders() });
  if (!res.ok) {
    throw new Error(`xSearch: searchRecentPosts failed (${res.status}): ${await res.text()}`);
  }
  const data: any = await res.json();
  const usernames = new Map<string, string>((data.includes?.users ?? []).map((u: any) => [u.id, u.username]));
  return (data.data ?? []).map((post: any) => expandPost(post, usernames));
}
