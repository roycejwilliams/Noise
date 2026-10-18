// A failed X search never puts the search terms in the logs (2026-10-18, member
// data out of logs). X's error body can repeat the query back, so the error
// carries X's status and a fixed reason only. X is a stubbed fetch here: no real
// call, no tokens.
//   npx tsx evals/tier3/xErrorLog.ts
process.env.X_API_BEARER_TOKEN = "dummy-x-token";
import fs from "node:fs";
import { format } from "node:util";
const X = await import("../../src/services/xSearch.js");
const SF = await import("../../src/services/sweepFind.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};

// What a member-shaped query looks like, and pieces of it a body might echo.
const QUERY = "Jordan Ellis climate fintech seed round divorce";
const PIECES = ["Jordan", "Ellis", "climate fintech", "divorce", "seed round"];
const leaks = (s: string) => PIECES.filter((p) => s.includes(p));

// Stub X: answers with the status and body given, echoing the query the way X's error bodies do.
let calls = 0;
function stubX(status: number, body: (q: string) => string, contentType = "application/json") {
  globalThis.fetch = (async (input: any) => {
    calls++;
    const url = new URL(typeof input === "string" ? input : input?.url ?? String(input));
    if (url.host !== "api.x.com") throw new Error(`unexpected host ${url.host}`);
    return new Response(body(url.searchParams.get("query") ?? ""), { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
}

// Everything printed to the console while fn runs, and whatever it threw.
async function captured(fn: () => Promise<unknown>): Promise<{ out: string; err: any }> {
  const lines: string[] = [];
  const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(keep) as (keyof typeof keep)[]) (console as any)[k] = (...a: unknown[]) => lines.push(format(...a));
  let err: any = null;
  try {
    await fn();
  } catch (e) {
    err = e;
    // How callers log a failure: the message, the error itself, its stack.
    console.error("caller: X search failed (non-fatal):", (e as any)?.message ?? e);
    console.error(e);
    console.error(String((e as any)?.stack ?? ""));
  } finally {
    Object.assign(console, keep);
  }
  return { out: lines.join("\n"), err };
}

const bodies: [string, number, (q: string) => string, string?][] = [
  ["400 invalid query", 400, (q) => JSON.stringify({ errors: [{ parameters: { query: [q] }, message: `There were errors processing your request: Invalid query '${q}'` }], title: "Invalid Request", detail: "One or more parameters to your request was invalid.", type: "https://api.twitter.com/2/problems/invalid-request" })],
  ["401 unauthorized", 401, (q) => JSON.stringify({ title: "Unauthorized", detail: `Unauthorized for query ${q}` })],
  ["429 rate limited", 429, (q) => JSON.stringify({ title: "Too Many Requests", detail: `Too Many Requests: ${q}` })],
  ["503 outage (html)", 503, (q) => `<html><body>Service unavailable while searching ${q}</body></html>`, "text/html"],
];

for (const [label, status, body, ct] of bodies) {
  stubX(status, body, ct);
  const before = calls;
  const { out, err } = await captured(() => X.searchRecentPosts(QUERY));
  check(`${label}: the stub was called and its body did hold the query`, calls === before + 1 && leaks(body(X.xSearchQuery(QUERY))).length === PIECES.length);
  check(`${label}: the search fails`, err instanceof Error);
  const all = [out, String(err?.message ?? ""), String(err?.stack ?? ""), JSON.stringify(err ?? null), String(err?.cause ?? "")].join("\n");
  check(`${label}: nothing logged or thrown carries the query`, leaks(all).length === 0, `leaked: ${leaks(all).join(", ")} | ${out.slice(0, 300)}`);
  check(`${label}: the error still says X's status`, String(err?.message).includes(`(${status})`), String(err?.message));
  check(`${label}: the error is the fixed reason for that status`, err?.message === X.xSearchFailure(status), String(err?.message));
}

// sweepFind still reads the kind from the new message (its log says kind and status only).
{
  const kind = (s: number) => SF.xFailure(new Error(X.xSearchFailure(s)));
  check("xFailure: 401 and 403 read as auth", kind(401).kind === "auth" && kind(403).kind === "auth" && kind(403).status === 403);
  check("xFailure: 429 reads as rate limited", JSON.stringify(kind(429)) === JSON.stringify({ kind: "rate_limited", status: 429 }));
  check("xFailure: 503 reads as server", kind(503).kind === "server" && kind(503).status === 503);
  check("xFailure: 400 reads as a plain error with its status", JSON.stringify(kind(400)) === JSON.stringify({ kind: "error", status: 400 }));
}

// 200 with a body that isn't JSON: the parser's own error would quote the body.
{
  stubX(200, (q) => `${q} is not json`, "text/plain");
  const { out, err } = await captured(() => X.searchRecentPosts(QUERY));
  const all = [out, String(err?.message ?? ""), String(err?.stack ?? "")].join("\n");
  check("200 with an unreadable body: fails with a fixed reason", err?.message === "xSearch: searchRecentPosts failed (200): unreadable response", String(err?.message));
  check("200 with an unreadable body: nothing carries the query", leaks(all).length === 0, `leaked: ${leaks(all).join(", ")}`);
}

// A good answer still comes back as posts (the fix changed only the failure path).
{
  stubX(200, () => JSON.stringify({ data: [{ id: "1", text: "Applications open", author_id: "9" }], includes: { users: [{ id: "9", username: "prog" }] } }));
  const posts = await X.searchRecentPosts(QUERY);
  check("a 200 answer still returns its posts", posts.length === 1 && posts[0].author === "prog" && posts[0].url === "https://x.com/i/status/1");
}

// Pinned in the source: searchRecentPosts never reads X's error body into anything.
{
  const src = fs.readFileSync(new URL("../../src/services/xSearch.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function searchRecentPosts"));
  check("searchRecentPosts never calls res.text()", !/\.text\(\)/.test(fn));
  check("searchRecentPosts logs nothing itself", !/console\.(log|error|warn|info|debug)\(/.test(fn));
}

console.log(`x error log: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
