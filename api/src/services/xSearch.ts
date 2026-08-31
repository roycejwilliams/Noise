// X (formerly Twitter) recent search — Tier 3's real data source for
// accelerators, fellowships, and other high-agency opportunities, replacing
// the earlier Google-Places-based venue lookup for this tier. Pay-per-use
// pricing confirmed 2026-08-30: $0.005 per post read, no subscription, no
// Enterprise contract needed for recent (last 7 days) search — that's only
// required for full historical archive search back to 2006, which isn't
// what this needs (an accelerator's applications being open NOW is exactly
// a "last 7 days" question). Endpoint shape is X API v2's long-documented
// recent-search contract; not yet live-tested against a real bearer token.
const X_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";

export type XPost = {
  id: string;
  text: string;
  author_id: string;
  url: string; // constructed, not returned by the API — grounding link back to the real post
};

function xHeaders(): Record<string, string> {
  const token = process.env.X_API_BEARER_TOKEN;
  if (!token) throw new Error("xSearch: X_API_BEARER_TOKEN is not configured");
  return { Authorization: `Bearer ${token}` };
}

// max_results kept small (10) deliberately — cost is per post read, and
// Tier 3 only needs one good grounded answer, not a broad sample.
export async function searchRecentPosts(query: string, maxResults = 10): Promise<XPost[]> {
  const url = new URL(X_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("tweet.fields", "author_id,created_at");

  const res = await fetch(url, { headers: xHeaders() });
  if (!res.ok) {
    throw new Error(`xSearch: searchRecentPosts failed (${res.status}): ${await res.text()}`);
  }
  const data: any = await res.json();
  return (data.data ?? []).map((post: any) => ({
    id: post.id,
    text: post.text,
    author_id: post.author_id,
    url: `https://x.com/i/status/${post.id}`,
  }));
}
