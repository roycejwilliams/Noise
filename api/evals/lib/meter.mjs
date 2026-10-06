// LAYER 2 (live evals): the only way a real model call is made from a test. Preloaded with `node --import` by
// `npm run evals:nightly` and `npm run eval:live -- <file>`; nothing else may spend tokens.
//
//   0. (EVAL_REAL_MODELS=1, on request only: workers run the model production uses, Opus becomes Sonnet; same cap and cost line.)
//   1. Haiku for everything. Every Anthropic request is rewritten to Haiku (Sonnet and Opus ids included), and the
//      options Haiku refuses (effort) are stripped. The ONE exception is the final grading of an output: a call that
//      carries the header x-eval-role: grader (src/models.ts GRADER_HEADERS) runs on Sonnet. The header is removed
//      before it leaves.
//   2. A hard cap per run, in tokens AND dollars (EVAL_TOKEN_CAP, EVAL_COST_CAP_USD). Before each call the meter adds up
//      what has been used plus what in-flight calls may still use; a call that would pass the cap is refused, so the run
//      stops instead of overshooting. The ledger is a file, so the cap holds across the suites of one nightly run.
//   3. The run's cost is printed at the end, every time.
//   4. No other outside host: no web search tool, no voice, no mail, no Luma. A suite that needs them is not a layer 2 suite.
//
// Prices: USD per million tokens (Anthropic list prices; keep in step with src/services/llmUsage.ts PRICES, which
// evals/lib/rules.ts checks). Embeddings: $0.02 per million.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HAIKU = "claude-haiku-4-5-20251001";
export const SONNET = "claude-sonnet-5";
export const PRICE = {
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};
const EMBED_PER_M = 0.02;
const WEB_SEARCH_USD = 0.01;

const CAP_TOKENS = Number(process.env.EVAL_TOKEN_CAP ?? 500_000);
const CAP_USD = Number(process.env.EVAL_COST_CAP_USD ?? 1.0);
const LEDGER = process.env.EVAL_LEDGER ?? join(tmpdir(), `eval-ledger-${process.pid}.jsonl`);

const usd = (kind, u) => {
  const p = PRICE[kind];
  return ((u.input ?? 0) * p.input + (u.output ?? 0) * p.output + (u.cacheWrite ?? 0) * p.cacheWrite + (u.cacheRead ?? 0) * p.cacheRead) / 1e6 + (u.webSearches ?? 0) * WEB_SEARCH_USD;
};

function readLedger() {
  const rows = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const done = new Set(rows.filter((r) => r.t === "actual").map((r) => r.id));
  let tokens = 0;
  let cost = 0;
  let calls = 0;
  const by = { haiku: 0, sonnet: 0, embed: 0 };
  for (const r of rows) {
    if (r.t === "actual") { tokens += r.tokens; cost += r.usd; calls++; by[r.kind] = (by[r.kind] ?? 0) + 1; }
    else if (r.t === "reserve" && !done.has(r.id)) { tokens += r.tokens; cost += r.usd; }
  }
  return { tokens, cost, calls, by };
}
const write = (row) => { try { appendFileSync(LEDGER, JSON.stringify(row) + "\n"); } catch {} };

let capHit = null;
let seq = 0;
const real = globalThis.fetch;
globalThis.__EVAL_METER__ = true;

const headerOf = (init, name) => {
  const h = init?.headers;
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name);
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : null;
};
const withoutHeader = (init, name) => {
  const h = init?.headers;
  if (!h) return init;
  if (typeof h.get === "function") { const c = new Headers(h); c.delete(name); return { ...init, headers: c }; }
  if (Array.isArray(h)) return { ...init, headers: h.filter(([k]) => k.toLowerCase() !== name) };
  const c = { ...h };
  for (const k of Object.keys(c)) if (k.toLowerCase() === name) delete c[k];
  return { ...init, headers: c };
};
const strip = (o) => {
  if (!o || typeof o !== "object") return;
  for (const k of Object.keys(o)) {
    if (k === "effort") delete o[k];
    else strip(o[k]);
  }
};

function refuse(why) {
  capHit = capHit ?? why;
  process.exitCode = 3;
  throw new Error(`EVAL CAP: ${why}. This run stops here so it cannot spend more. Raise EVAL_TOKEN_CAP / EVAL_COST_CAP_USD only if you mean to.`);
}

globalThis.fetch = async function meteredFetch(input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  let host = "";
  try { host = new URL(url).host; } catch { return real(input, init); }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) return real(input, init);

  const isAnthropic = /api\.anthropic\.com$/.test(host);
  const isEmbed = /api\.openai\.com$/.test(host) && /\/embeddings/.test(url);
  if (!isAnthropic && !isEmbed) throw new Error(`LAYER 2: a live eval tried a call to ${host}, which a metered run does not allow (model calls only: Haiku, and Sonnet for grading).`);

  const id = `${process.pid}-${++seq}`;
  const before = readLedger();
  if (before.tokens >= CAP_TOKENS) refuse(`token cap ${CAP_TOKENS.toLocaleString()} reached (${Math.round(before.tokens).toLocaleString()} used)`);
  if (before.cost >= CAP_USD) refuse(`cost cap $${CAP_USD.toFixed(2)} reached ($${before.cost.toFixed(4)} used)`);

  if (isEmbed) {
    let n = 1000;
    try { n = Math.ceil(String(init?.body ?? "").length / 3.5); } catch {}
    write({ t: "reserve", id, tokens: n, usd: (n * EMBED_PER_M) / 1e6 });
    const res = await real(input, init);
    let tokens = n;
    try { const j = await res.clone().json(); tokens = j?.usage?.total_tokens ?? n; } catch {}
    write({ t: "actual", id, kind: "embed", model: "embedding", tokens, usd: (tokens * EMBED_PER_M) / 1e6 });
    return res;
  }

  let body = {};
  try { body = JSON.parse(init?.body ?? "{}"); } catch {}
  const grader = String(headerOf(init, "x-eval-role") ?? "").toLowerCase() === "grader";
  // EVAL_REAL_MODELS=1 (on request, to confirm a Haiku failure the way production runs it): workers keep Sonnet/Haiku as
  // asked, Opus becomes Sonnet. Still metered, still capped, still priced by the model actually used.
  const realModels = process.env.EVAL_REAL_MODELS === "1" && !grader;
  const asked = String(body.model ?? "");
  const kind = grader ? "sonnet" : realModels ? (/haiku/.test(asked) ? "haiku" : "sonnet") : "haiku";
  body.model = grader ? SONNET : realModels ? (/haiku/.test(asked) ? asked : SONNET) : HAIKU;
  if (kind === "haiku") strip(body); // Haiku rejects the effort option the production code sets for Sonnet
  if (Array.isArray(body.tools) && body.tools.some((t) => /web_search/.test(String(t?.type ?? "")))) {
    // A web search is a paid tool and its results are the open web: not a layer 2 case.
    body.tools = body.tools.filter((t) => !/web_search/.test(String(t?.type ?? "")));
    if (!body.tools.length) { delete body.tools; delete body.tool_choice; }
  }
  const estIn = Math.ceil(JSON.stringify(body).length / 3.5);
  const reserveOut = Math.min(Number(body.max_tokens ?? 1024), 4096);
  const reserveTokens = estIn + reserveOut;
  const reserveUsd = usd(kind, { input: estIn, output: reserveOut });
  if (before.tokens + reserveTokens > CAP_TOKENS) refuse(`this call could pass the token cap ${CAP_TOKENS.toLocaleString()} (${Math.round(before.tokens).toLocaleString()} used, up to ${reserveTokens.toLocaleString()} more)`);
  if (before.cost + reserveUsd > CAP_USD) refuse(`this call could pass the cost cap $${CAP_USD.toFixed(2)} ($${before.cost.toFixed(4)} used)`);
  write({ t: "reserve", id, tokens: reserveTokens, usd: reserveUsd });

  const out = withoutHeader({ ...init, body: JSON.stringify(body) }, "x-eval-role");
  const res = await real(input, out);
  const settle = (u) => {
    const tokens = (u.input ?? 0) + (u.output ?? 0) + (u.cacheWrite ?? 0) + (u.cacheRead ?? 0);
    write({ t: "actual", id, kind, model: body.model, tokens, usd: usd(kind, u) });
  };
  if (body.stream) {
    res.clone().text().then((txt) => {
      const u = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      for (const line of txt.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const e = JSON.parse(line.slice(5));
          if (e.type === "message_start") { const m = e.message?.usage ?? {}; u.input = m.input_tokens ?? 0; u.cacheWrite = m.cache_creation_input_tokens ?? 0; u.cacheRead = m.cache_read_input_tokens ?? 0; u.output = m.output_tokens ?? 0; }
          if (e.type === "message_delta") u.output = e.usage?.output_tokens ?? u.output;
        } catch {}
      }
      settle(u);
    }).catch(() => settle({ input: estIn, output: reserveOut }));
  } else {
    // Settled before the caller sees the response, so the ledger is exact by the time the run ends.
    try {
      const j = await res.clone().json();
      const m = j?.usage ?? {};
      settle({ input: m.input_tokens ?? 0, output: m.output_tokens ?? 0, cacheWrite: m.cache_creation_input_tokens ?? 0, cacheRead: m.cache_read_input_tokens ?? 0, webSearches: m.server_tool_use?.web_search_requests ?? 0 });
    } catch {
      settle({ input: estIn, output: reserveOut });
    }
  }
  return res;
};

// The cost of this run, printed every time, whatever else happens.
export function summary() {
  const l = readLedger();
  const line = `EVAL COST: $${l.cost.toFixed(4)} | ${l.calls} model calls (${l.by.haiku ?? 0} Haiku, ${l.by.sonnet ?? 0} Sonnet grading, ${l.by.embed ?? 0} embeddings) | ${Math.round(l.tokens).toLocaleString()} tokens | cap ${CAP_TOKENS.toLocaleString()} tokens / $${CAP_USD.toFixed(2)}${capHit ? ` | STOPPED AT THE CAP: ${capHit}` : ""}`;
  return line;
}
if (!process.env.EVAL_QUIET) process.on("exit", () => { try { console.log(`\n${summary()}`); } catch {} });
