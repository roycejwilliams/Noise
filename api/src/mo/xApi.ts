// X API calls Mo makes as Co's own X account (never a personal one).
//
// Reading (search with author profiles) uses the app bearer token Co already
// has for Tier 3 (X_API_BEARER_TOKEN). Writing (a public reply, a like, a DM)
// and reading Co's DM inbox act as Co's account, so they're signed with
// OAuth 1.0a user-context keys, which don't expire:
//   X_MO_CONSUMER_KEY / X_MO_CONSUMER_SECRET  (the app)
//   X_MO_ACCESS_TOKEN / X_MO_ACCESS_SECRET    (Co's account)
//   X_MO_USER_ID                                 (Co's account id)
// Royce sets these; until they exist, Mo runs shortlist-only.
import { createHmac, randomBytes } from "crypto";

const API = "https://api.x.com/2";

export type MoAuthor = { id: string; username: string; name: string; location: string | null; description: string | null };
export type MoPost = { id: string; text: string; url: string; author: MoAuthor };

export function xWriteConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.X_MO_CONSUMER_KEY && env.X_MO_CONSUMER_SECRET && env.X_MO_ACCESS_TOKEN && env.X_MO_ACCESS_SECRET && env.X_MO_USER_ID);
}

// RFC 3986 encoding, as OAuth 1.0a requires.
export function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// OAuth 1.0a HMAC-SHA1 signature. Query parameters are signed; a JSON body
// is not (only form bodies are).
export function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const base = [
    method.toUpperCase(),
    pct(url),
    pct(
      Object.keys(params)
        .sort()
        .map((k) => `${pct(k)}=${pct(params[k])}`)
        .join("&"),
    ),
  ].join("&");
  return createHmac("sha1", `${pct(consumerSecret)}&${pct(tokenSecret)}`).update(base).digest("base64");
}

function oauthHeader(method: string, url: string, query: Record<string, string> = {}): string {
  const env = process.env;
  const oauth: Record<string, string> = {
    oauth_consumer_key: env.X_MO_CONSUMER_KEY!,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_MO_ACCESS_TOKEN!,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = oauthSignature(method, url, { ...query, ...oauth }, env.X_MO_CONSUMER_SECRET!, env.X_MO_ACCESS_SECRET!);
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(", ")
  );
}

export class XApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`X API ${status}: ${body.slice(0, 300)}`);
  }
}

async function userCall(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<any> {
  if (!xWriteConfigured()) throw new Error("mo: Co's X account keys aren't set");
  const url = `${API}${path}`;
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const res = await fetch(url + qs, {
    method,
    headers: {
      Authorization: oauthHeader(method, url, opts.query),
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new XApiError(res.status, text);
  return text ? JSON.parse(text) : {};
}

// Recent posts with each author's profile (handle, name, location, bio),
// which Tier 3's search doesn't ask for.
export async function searchPostsWithAuthors(query: string, maxResults = 20): Promise<MoPost[]> {
  const token = process.env.X_API_BEARER_TOKEN;
  if (!token) throw new Error("mo: X_API_BEARER_TOKEN is not configured");
  const url = new URL(`${API}/tweets/search/recent`);
  url.searchParams.set("query", /-is:retweet/.test(query) ? query : `${query} -is:retweet lang:en`);
  url.searchParams.set("max_results", String(Math.min(100, Math.max(10, maxResults))));
  url.searchParams.set("tweet.fields", "author_id,created_at");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name,location,description");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new XApiError(res.status, await res.text());
  const data: any = await res.json();
  const users = new Map<string, MoAuthor>(
    (data.includes?.users ?? []).map((u: any) => [
      u.id,
      { id: u.id, username: u.username, name: u.name, location: u.location ?? null, description: u.description ?? null },
    ]),
  );
  return (data.data ?? [])
    .filter((p: any) => users.has(p.author_id))
    .map((p: any) => ({ id: p.id, text: p.text, url: `https://x.com/${users.get(p.author_id)!.username}/status/${p.id}`, author: users.get(p.author_id)! }));
}

export async function replyToPost(postId: string, text: string): Promise<string> {
  const r = await userCall("POST", "/tweets", { body: { text, reply: { in_reply_to_tweet_id: postId } } });
  return r?.data?.id;
}

export async function likePost(postId: string): Promise<void> {
  await userCall("POST", `/users/${process.env.X_MO_USER_ID}/likes`, { body: { tweet_id: postId } });
}

// Throws XApiError 403 when they don't accept DMs from Co.
export async function sendDm(participantId: string, text: string): Promise<void> {
  await userCall("POST", `/dm_conversations/with/${participantId}/messages`, { body: { text } });
}

export type DmEvent = { id: string; senderId: string; text: string; createdAt: string };

export async function recentDmEvents(): Promise<DmEvent[]> {
  const r = await userCall("GET", "/dm_events", {
    query: { event_types: "MessageCreate", "dm_event.fields": "id,sender_id,text,created_at", max_results: "100" },
  });
  return (r?.data ?? []).map((e: any) => ({ id: e.id, senderId: e.sender_id, text: e.text ?? "", createdAt: e.created_at }));
}

// A DM refused because they don't accept DMs from Co (vs. a real failure).
export function isDmClosed(err: unknown): boolean {
  return err instanceof XApiError && (err.status === 403 || (err.status === 400 && /not allowed|cannot send|can't send/i.test(err.body)));
}
