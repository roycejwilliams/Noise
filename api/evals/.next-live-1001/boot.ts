// Untracked local harness (2026-10-01 next-live brief). Imported FIRST, before
// any product module: sets the process environment, then installs the
// network, fetch and pg guards. Nothing in here prints a secret.
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const H = {
  started: Date.now(),
  costCapUsd: Number(process.env.NEXT_COST_CAP_USD || 28),
  costUsd: 0,
  unknownCostCalls: 0,
  providerRequests: { anthropic: 0, openai: 0, other: 0 },
  usage: [] as { provider: string; model: string; status: number; input: number; output: number; cacheRead: number; cacheWrite: number; webSearches: number; costUsd: number | null; caseId: string | null }[],
  unexpectedNet: [] as { host: string; port: string; via: string; caseId: string | null }[],
  expectedBlocked: [] as { host: string; via: string }[], // telemetry etc.
  captured: [] as { transport: string; method: string; path: string; body: any; caseId: string | null; at: number }[],
  respond: null as null | ((t: string, path: string, body: any) => { status: number; body: any } | null),
  caseId: null as string | null,
  pendingUsage: [] as Promise<void>[],
  allowSourceHosts: new Set<string>(),
  localHttp: new Set<string>(),
  sourceLive: false, // a source-live case: read-only GETs to public hosts (Luma feed, pages) go out
  sourceUrls: [] as string[], // "127.0.0.1:<port>" of an in-process router under test
  stopReason: null as string | null,
  inflight: 0, // model requests whose body hasn't been read yet
  sockets: [] as { room: string; event: string }[], // fake socket.io emits
};

// ---------------------------------------------------------------- environment
const inherited = { node: process.env.NODE_ENV, railway: process.env.RAILWAY_ENVIRONMENT_NAME };
if (inherited.node === "production" || inherited.railway === "production" || process.env.ALLOW_REAL_SMS === "true") {
  throw new Error("NEXT_PREFLIGHT refused: inherited production environment or ALLOW_REAL_SMS=true");
}
const envFile = new URL("../../.env", import.meta.url);
const parsed: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  parsed[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}
// Only these real values come in; every other secret is a placeholder in memory.
for (const k of ["DATABASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) if (parsed[k]) process.env[k] = parsed[k];
const PLACEHOLDER = "harness-placeholder-not-a-secret";
for (const k of Object.keys(parsed)) if (!["DATABASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(k)) delete process.env[k];
for (const k of ["SENDBLUE_API_KEY", "SENDBLUE_SECRET_KEY", "SENDBLUE_API_API_KEY", "SENDBLUE_API_API_SECRET", "RESEND_API_KEY", "TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_TEST_AUTH_TOKEN", "TWILIO_TEST_SID", "HUME_API_KEY", "HUME_SECRET_KEY", "ELEVENLABS_API_KEY", "STRIPE_SECRET_KEY", "GOOGLE_PLACES_API_KEY", "JWT_SECRET_KEY", "SENDBLUE_WEBHOOK_SECRET", "LUMA_API_KEY", "XAI_API_KEY"]) process.env[k] = PLACEHOLDER;
Object.assign(process.env, {
  NODE_ENV: "test",
  RAILWAY_ENVIRONMENT_NAME: "dev",
  ALLOW_REAL_SMS: "false",
  SENDBLUE_PHONE_NUMBER: "+14155550199",
  API_URL: "http://co.invalid",
  CO_VCARD_URL: "https://co.invalid/co.vcf",
  TWILIO_PHONE_NUMBER: "+14155550198",
  HUME_CONFIG_ID: "harness-config",
  BROWSER_READ: "off",
});
for (const k of ["LANGFUSE_SECRET_KEY", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_BASE_URL", "KEANA_PHONE_NUMBER", "OTEL_EXPORTER_OTLP_ENDPOINT"]) delete process.env[k];
export const secretsPresent = { DATABASE_URL: !!process.env.DATABASE_URL, ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: !!process.env.OPENAI_API_KEY };

const dbUrl = new URL(process.env.DATABASE_URL || "postgres://x@invalid:1/x");
export const dbEndpoint = { host: dbUrl.hostname, port: dbUrl.port, db: dbUrl.pathname.slice(1) };
if (!["localhost", "127.0.0.1"].includes(dbEndpoint.host) || dbEndpoint.port !== "55432") {
  throw new Error(`NEXT_PREFLIGHT refused: DATABASE_URL must be localhost:55432 (got ${dbEndpoint.host}:${dbEndpoint.port})`);
}

// ---------------------------------------------------------------- prices (USD per million tokens)
// API reference, cached 2026-09-25. Unknown models count as unknown cost.
const PRICES: Record<string, { in: number; out: number; cr: number; cw: number }> = {
  "claude-sonnet-5": { in: 2, out: 10, cr: 0.2, cw: 2.5 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cr: 0.1, cw: 1.25 },
  "claude-haiku-4-5": { in: 1, out: 5, cr: 0.1, cw: 1.25 },
  "text-embedding-3-small": { in: 0.02, out: 0, cr: 0, cw: 0 },
};
const WEB_SEARCH_USD = 0.01;
function priceOf(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches: number }): number | null {
  const p = PRICES[model] ?? Object.entries(PRICES).find(([k]) => model.startsWith(k))?.[1];
  if (!p) return null;
  return (u.input * p.in + u.output * p.out + u.cacheRead * p.cr + u.cacheWrite * p.cw) / 1e6 + u.webSearches * WEB_SEARCH_USD;
}

// ---------------------------------------------------------------- network guard (every TCP connection)
const MODEL_HOSTS = new Set(["api.anthropic.com", "api.openai.com"]);
const TELEMETRY = /langfuse|otel|opentelemetry|sentry|datadog/i;
function allowedSocket(host: string, port: string): boolean {
  if ((host === "localhost" || host === "127.0.0.1" || host === "::1") && port === "55432") return true;
  if ((host === "localhost" || host === "127.0.0.1") && H.localHttp.has(`127.0.0.1:${port}`)) return true;
  if (MODEL_HOSTS.has(host) && port === "443") return true;
  if (H.allowSourceHosts.has(host) && (port === "443" || port === "80")) return true;
  return false;
}
const origConnect = net.Socket.prototype.connect;
(net.Socket.prototype as any).connect = function (this: net.Socket, ...args: any[]) {
  let o: any = args[0];
  if (Array.isArray(o)) o = o[0];
  let host = "", port = "";
  if (o && typeof o === "object") {
    if (o.path) { host = `unix:${o.path}`; port = ""; }
    else { host = String(o.host ?? o.servername ?? "localhost"); port = String(o.port ?? ""); }
  } else { port = String(args[0]); host = typeof args[1] === "string" ? args[1] : "localhost"; }
  if (!allowedSocket(host, port)) {
    const voice = /(^|\.)(twilio\.com|hume\.ai|elevenlabs\.io|resend\.com|sendblue\.(co|com))$/i.test(host);
    if (voice) H.captured.push({ transport: `${host.split(".").slice(-2)[0]}-socket-denied`, method: "CONNECT", path: `${host}:${port}`, body: null, caseId: H.caseId, at: Date.now() });
    else if (TELEMETRY.test(host)) H.expectedBlocked.push({ host, via: "socket" });
    else H.unexpectedNet.push({ host, port, via: "socket", caseId: H.caseId });
    process.nextTick(() => this.destroy(new Error(`harness: connection to ${host}:${port} blocked`)));
    return this;
  }
  return (origConnect as any).apply(this, args);
};

// ---------------------------------------------------------------- fetch: capture transports, meter model calls
const realFetch = globalThis.fetch.bind(globalThis);
const CAPTURE: { re: RegExp; transport: string }[] = [
  { re: /(^|\.)sendblue\.(co|com)$/i, transport: "sendblue" },
  { re: /(^|\.)resend\.com$/i, transport: "email" },
  { re: /(^|\.)twilio\.com$/i, transport: "twilio" },
  { re: /(^|\.)hume\.ai$/i, transport: "hume" },
  { re: /(^|\.)elevenlabs\.io$/i, transport: "elevenlabs" },
  { re: /(^|\.)stripe\.com$/i, transport: "stripe" },
  { re: /(^|\.)luma\.com$|(^|\.)lu\.ma$/i, transport: "luma" },
];
async function readBody(init: any, input: any): Promise<any> {
  try {
    const b = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof b === "string") { try { return JSON.parse(b); } catch { return b.slice(0, 2000); } }
    if (b instanceof URLSearchParams) return Object.fromEntries(b);
    return b == null ? null : `[${typeof b}]`;
  } catch { return "[unreadable]"; }
}
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const host = url.hostname;
  const method0 = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const liveRead = H.sourceLive && method0 === "GET" && url.protocol === "https:" && !/sendblue|resend|twilio|hume|elevenlabs|stripe/i.test(host);
  if (liveRead && !MODEL_HOSTS.has(host)) { H.allowSourceHosts.add(host); H.sourceUrls.push(url.href.slice(0, 300)); }
  const cap = liveRead ? undefined : CAPTURE.find((c) => c.re.test(host));
  if (cap) {
    const body = await readBody(init, input);
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET"));
    H.captured.push({ transport: cap.transport, method, path: url.pathname + url.search, body, caseId: H.caseId, at: Date.now() });
    const fallback = cap.transport === "sendblue" ? { status: "QUEUED", message_handle: `harness-${H.captured.length}`, accountEmail: "x@co.invalid" } : cap.transport === "luma" ? { entries: [], has_more: false } : { id: `harness-${H.captured.length}` };
    const r = H.respond?.(cap.transport, url.pathname + url.search, body) ?? { status: 200, body: fallback };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }
  const isModel = MODEL_HOSTS.has(host);
  if ((host === "127.0.0.1" || host === "localhost") && H.localHttp.has(`127.0.0.1:${url.port}`)) return realFetch(input, init);
  if (!isModel && !H.allowSourceHosts.has(host)) {
    if (TELEMETRY.test(host)) H.expectedBlocked.push({ host, via: "fetch" });
    else H.unexpectedNet.push({ host, port: url.port || "443", via: "fetch", caseId: H.caseId });
    throw new TypeError(`harness: fetch to ${host} blocked`);
  }
  if (isModel) {
    if (H.stopReason) throw new Error(`harness stopped: ${H.stopReason}`);
    if (H.costUsd >= H.costCapUsd) { H.stopReason = `cost cap $${H.costCapUsd} reached`; throw new Error(`harness stopped: ${H.stopReason}`); }
    if (host === "api.anthropic.com") H.providerRequests.anthropic++; else H.providerRequests.openai++;
  } else H.providerRequests.other++;
  if (isModel) H.inflight++;
  let res: Response;
  try { res = await realFetch(input, init); } catch (e) { if (isModel) H.inflight--; throw e; }
  if (isModel) {
    const clone = res.clone();
    const caseId = H.caseId;
    H.pendingUsage.push(
      (async () => {
        const text = await clone.text();
        let model = "unknown", input = 0, output = 0, cacheRead = 0, cacheWrite = 0, webSearches = 0, seen = false;
        for (const line of text.trim().startsWith("{") ? [text] : text.split("\n")) {
          try {
            const j = JSON.parse(line.startsWith("data: ") ? line.slice(6) : line);
            const x = j.message || j;
            model = x.model || model;
            const u = x.usage || j.usage;
            if (u) {
              seen = true;
              input = Math.max(input, u.input_tokens || u.prompt_tokens || 0);
              output = Math.max(output, u.output_tokens || 0);
              cacheRead = Math.max(cacheRead, u.cache_read_input_tokens || 0);
              cacheWrite = Math.max(cacheWrite, u.cache_creation_input_tokens || 0);
              webSearches = Math.max(webSearches, u.server_tool_use?.web_search_requests || 0);
            }
          } catch {}
        }
        const cost = seen ? priceOf(model, { input, output, cacheRead, cacheWrite, webSearches }) : null;
        if (cost == null) H.unknownCostCalls++; else H.costUsd += cost;
        H.usage.push({ provider: host === "api.anthropic.com" ? "anthropic" : "openai", model, status: res.status, input, output, cacheRead, cacheWrite, webSearches, costUsd: cost, caseId });
      })().catch(() => { H.unknownCostCalls++; }).finally(() => { H.inflight--; }),
    );
  }
  return res;
};

// ---------------------------------------------------------------- pg: every pool and client goes through the adapter
export const pg = require("pg");
export type Adapter = {
  query: (text: string, values?: any[]) => Promise<any>;
  connect: () => Promise<{ query: (t: any, v?: any) => Promise<any>; release: (err?: any) => void }>;
};
let adapter: Adapter | null = null;
export function setAdapter(a: Adapter | null) { adapter = a; }
export const OWNER = Symbol("harness-owner");
const origClientConnect = pg.Client.prototype.connect;
export const ownerConnect = origClientConnect;
pg.Client.prototype.connect = function (this: any, cb?: any) {
  if (this[OWNER]) return origClientConnect.call(this, cb);
  const err = new Error("harness: raw pg.Client connections are blocked");
  if (cb) { process.nextTick(() => cb(err)); return; }
  return Promise.reject(err);
};
const noAdapter = () => Promise.reject(new Error("harness: database adapter not ready"));
pg.Pool.prototype.query = function (text: any, values?: any, cb?: any) {
  const t = typeof text === "string" ? text : text?.text;
  const v = typeof text === "object" && text?.values ? text.values : Array.isArray(values) ? values : undefined;
  const cbf = typeof values === "function" ? values : cb;
  const p = adapter ? adapter.query(t, v) : noAdapter();
  if (cbf) { p.then((r: any) => cbf(null, r), (e: any) => cbf(e)); return; }
  return p;
};
pg.Pool.prototype.connect = function (cb?: any) {
  const p = adapter ? adapter.connect() : noAdapter();
  if (cb) { p.then((c: any) => cb(null, c, (e?: any) => c.release(e)), (e: any) => cb(e)); return; }
  return p;
};
pg.Pool.prototype.end = function () { return Promise.resolve(); };

// ---------------------------------------------------------------- timers: stop on watchdog
export const WATCHDOG_MS = Number(process.env.NEXT_WATCHDOG_MS || 50 * 60 * 1000);
setTimeout(() => { console.log("NEXT_ERROR " + JSON.stringify({ stage: "watchdog", ms: WATCHDOG_MS })); process.exit(2); }, WATCHDOG_MS).unref();
