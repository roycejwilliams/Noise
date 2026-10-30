// GOLDEN harness record/replay (Royce, 2026-10-14: "golden cases must not hit the live API on every CI run. Record real API responses
// once as committed fixtures and have CI run the harness against the recordings. Live API runs only on a deliberate manual trigger").
// Preloaded AFTER the meter (`--import ./evals/lib/meter.mjs --import ./evals/lib/goldenReplay.mjs`), so it wraps the meter's fetch:
// every model call a golden case makes passes through here first, from the ai SDK and the Anthropic and OpenAI clients alike.
//
//   GOLDEN_MODE=replay (the default; CI): each model call is answered from evals/golden/recordings/<case-id>/<hash>.json. A call with no
//     recording, or one asked more times than it was recorded, throws and fails the run with what was asked and how it differs from the
//     nearest recording. Nothing reaches the network: replay never calls the fetch underneath, for any host.
//   GOLDEN_MODE=record: the call goes to the meter (real, capped, priced) and the answer is written as the case's recording. A case's
//     recordings are cleared when it starts, so they always hold exactly one run.
//   GOLDEN_MODE=live: real calls through the meter, nothing read or written (the manual drift check).
//
// A recording is keyed by a hash of the request as Co's code made it, before the meter swaps a model: the host and path, the whole
// JSON body (model, system, messages, tools, max_tokens, temperature, thinking, effort, stream...) with keys sorted, the grader
// marker and any anthropic-beta header. Only body.metadata is left out (not an input to the answer).
//
// When the exact hash misses, replay tries the request's SKELETON (evals/lib/goldenSkeleton.mjs): the same request with its instruction
// allowlisted tone wording masked out (evals/golden/wording.ts). A recording whose stamped skeleton matches answers the call, and the
// case reports what moved; the runner fails it unless evals/golden/moved-ledger.json carries that exact move (run.ts). Facts, the
// member's words, every tool, the model, every parameter and every literal off the allowlist stay in the skeleton, so a change to any
// of them still misses. GOLDEN_STRICT=1 turns any move into a miss. Each recording carries its skeleton stamp (`structure`), written when it is recorded, or by
// `npm run evals:golden:stamp` (replay with GOLDEN_STAMP=1: stamps every recording whose exact hash matched, never one that missed).
//
// The clock is pinned for every mode (GOLDEN_NOW below): "today", "two days out" and every createdAt in a prompt are the same on
// every run, so the hashes are. The runner reads real time from __GOLDEN__.realNow for its own timings.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { movedBetween, skeletonOf, wordingBefore } from "./goldenSkeleton.mjs";

export const GOLDEN_NOW = "2026-10-13T21:00:00.000Z"; // the incident day, 2pm in LA (a Tuesday); the guards fixtures read against it
const MODE = process.env.GOLDEN_MODE === "record" || process.env.GOLDEN_MODE === "live" ? process.env.GOLDEN_MODE : "replay";
const DIR = process.env.GOLDEN_RECORDINGS ?? new URL("../golden/recordings/", import.meta.url).pathname;
const STRICT = process.env.GOLDEN_STRICT === "1";
const STAMP = process.env.GOLDEN_STAMP === "1" && MODE === "replay";
// The wording registry ({ signature, chunks }), handed over by the runner (evals/golden/run.ts) before any case runs. Without it there
// is no skeleton: every miss is a miss.
let wording = null;
const stampOf = (key) => (wording ? { v: wording.signature, ...skeletonOf(key, wording.chunks) } : null);

// ---- the clock, and the zone a bare toLocaleString or getHours reads (a laptop in LA and a CI runner in UTC must build the same prompt)
process.env.TZ = "UTC";
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
const PINNED = RealDate.parse(GOLDEN_NOW);
globalThis.Date = new Proxy(RealDate, {
  construct: (t, args, nt) => Reflect.construct(t, args.length ? args : [PINNED], nt),
  apply: () => new RealDate(PINNED).toString(),
  get: (t, k, r) => (k === "now" ? () => PINNED : Reflect.get(t, k, r)),
});

// ---- the request key
const isModelHost = (host) => /api\.anthropic\.com$/.test(host) || /api\.openai\.com$/.test(host);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const headerOf = (h, name) => {
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name);
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : null;
};
const bodyText = async (input, init) => {
  const b = init?.body ?? (typeof input === "object" && input && typeof input.clone === "function" ? await input.clone().text() : null);
  if (b == null) return "";
  if (typeof b === "string") return b;
  if (b instanceof Uint8Array || b instanceof ArrayBuffer) return new TextDecoder().decode(b);
  return String(b);
};
function keyOf(url, raw, headers) {
  const u = new URL(url);
  let body;
  try { body = JSON.parse(raw); if (body && typeof body === "object") delete body.metadata; } catch { body = raw; }
  const key = canon({ path: `${u.host}${u.pathname}`, grader: String(headerOf(headers, "x-eval-role") ?? "").toLowerCase() === "grader", beta: headerOf(headers, "anthropic-beta") ?? null, body });
  const text = JSON.stringify(key);
  return { key, text, hash: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}

// ---- what a recording says, readably
const excerpt = (s, n = 300) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}...` : t; };
const contentText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text ?? (x?.type === "tool_use" ? `[tool_use ${x.name}]` : x?.type === "tool_result" ? `[tool_result] ${contentText(x.content)}` : "")).join(" ") : "");
function requestSummary(key) {
  const b = key.body && typeof key.body === "object" ? key.body : {};
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  const last = msgs[msgs.length - 1];
  return {
    path: key.path,
    model: b.model ?? null,
    grader: key.grader,
    max_tokens: b.max_tokens ?? null,
    system: excerpt(contentText(b.system) || b.system),
    messages: msgs.length,
    last: last ? `${last.role}: ${excerpt(contentText(last.content))}` : excerpt(b.prompt ?? b.input),
    tools: Array.isArray(b.tools) ? b.tools.map((t) => t?.name ?? t?.type) : [],
  };
}
const parseSse = (txt) => txt.split(/\n\n+/).filter((x) => x.trim()).map((chunk) => {
  const ev = chunk.match(/^event: ?(.*)$/m)?.[1] ?? null;
  const data = chunk.match(/^data: ?(.*)$/m)?.[1] ?? "";
  let d = data;
  try { d = JSON.parse(data); } catch {}
  return { event: ev, data: d };
});
function responseRecord(status, contentType, txt) {
  const sse = /event-stream/.test(contentType);
  if (sse) {
    const events = parseSse(txt);
    const text = events.map((e) => e.data?.delta?.text ?? "").join("");
    const start = events.find((e) => e.data?.type === "message_start")?.data?.message;
    const delta = [...events].reverse().find((e) => e.data?.type === "message_delta")?.data?.usage;
    return { status, content_type: contentType, model: start?.model ?? null, text, usage: { ...(start?.usage ?? {}), ...(delta ?? {}) }, events };
  }
  let body = txt;
  try { body = JSON.parse(txt); } catch {}
  const text = Array.isArray(body?.content) ? body.content.map((c) => c.text ?? (c.type === "tool_use" ? `[tool_use ${c.name} ${JSON.stringify(c.input)}]` : "")).join("") : null;
  return { status, content_type: contentType, model: body?.model ?? null, text, usage: body?.usage ?? null, body };
}
function responseOf(rec) {
  const headers = { "content-type": rec.content_type || "application/json" };
  if (rec.events) return new Response(rec.events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join(""), { status: rec.status, headers });
  return new Response(typeof rec.body === "string" ? rec.body : JSON.stringify(rec.body), { status: rec.status, headers });
}

// ---- the store, one folder per case
const safeId = (id) => String(id).replace(/[^\w.-]+/g, "-");
const caseDir = (id) => join(DIR, safeId(id));
function loadCase(id) {
  const d = caseDir(id);
  const out = new Map();
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    try { const r = JSON.parse(readFileSync(join(d, f), "utf8")); out.set(r.hash, r); } catch {}
  }
  return out;
}
// The case's recordings by skeleton, for the stamps made under the current registry only.
function skeletonIndex(recs) {
  const out = new Map();
  if (!wording) return out;
  for (const r of recs.values()) if (r.structure?.v === wording.signature) out.set(r.structure.hash, [...(out.get(r.structure.hash) ?? []), r]);
  return out;
}
// Stamps one recording file with its skeleton (GOLDEN_STAMP=1, on an exact match only: the recording is this code's own request).
function stampFile(id, rec, stamp) {
  if (!stamp || JSON.stringify(rec.structure ?? null) === JSON.stringify(stamp)) return false;
  rec.structure = stamp;
  writeFileSync(join(caseDir(id), `${rec.hash}.json`), JSON.stringify(rec, null, 2) + "\n");
  return true;
}
// The recording closest to a missed request (longest shared start plus end of the key text), and where they first differ.
function nearestDiff(text, recs) {
  let best = null;
  for (const r of recs.values()) {
    const other = JSON.stringify(canon({ path: r.request.path, grader: r.request.grader, beta: r.request.beta ?? null, body: r.request.body }));
    let p = 0;
    while (p < text.length && p < other.length && text[p] === other[p]) p++;
    let s = 0;
    while (s < text.length - p && s < other.length - p && text[text.length - 1 - s] === other[other.length - 1 - s]) s++;
    if (!best || p + s > best.score) best = { score: p + s, at: p, other, hash: r.hash };
  }
  if (!best) return "no recordings for this case";
  const at = best.at;
  const show = (t) => `...${t.slice(Math.max(0, at - 60), at + 140).replace(/\\n/g, " ")}...`;
  return `nearest recording ${best.hash} first differs at char ${at}:\n        recorded: ${show(best.other)}\n        now:      ${show(text)}`;
}

// ---- one attempt of one case: every call it makes, however deep or late, is its own (AsyncLocalStorage)
// Every context is kept to the end of the run, so a miss that lands after its case returned (a timer, a queue, a worker the case
// started) is still counted: the runner settles, then reads allMisses() before it exits.
const als = new AsyncLocalStorage();
const current = new Map(); // case id -> the attempt allowed to write its recordings
const contexts = [];
const outside = []; // replay misses made outside any case
let active = null; // the attempt running now (cases run one at a time)
let inflight = 0;
let seq = 0;
let served = 0;
let written = 0;
let movedServed = 0;
let stamped = 0;

function noteMiss(ctx, k, kind, why) {
  const s = requestSummary(k.key);
  const late = ctx?.ended ? ` [billed to case ${ctx.id}, whose attempt had already ended: a timer, queue or worker it started${active && active !== ctx ? `, while case ${active.id} was running` : ""}]` : "";
  const text = `${why} for model call ${s.model ?? s.path} (hash ${k.hash}, ${s.messages} messages, last ${JSON.stringify(excerpt(s.last, 120))})${late}${ctx && kind === "none" ? `\n        ${nearestDiff(k.text, ctx.recs)}` : ""}\n        re-record: npm run evals:golden:record -- --only ${ctx?.id ?? "<case>"}`;
  if (!ctx) { outside.push(text); return text; }
  // The SDKs retry a failed call, so one miss can arrive three times: it is reported once.
  if (!ctx.missed.has(`${kind}:${k.hash}`)) { ctx.missed.add(`${kind}:${k.hash}`); ctx.misses.push(text); }
  return text;
}

const real = globalThis.fetch;
globalThis.__GOLDEN_REPLAY__ = true;
globalThis.fetch = async function goldenFetch(input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  let host = "";
  try { host = new URL(url).host; } catch { return real(input, init); }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) return real(input, init);
  // The same in every mode, so a recorded run and its replay take the same path: golden cases reach models and nothing else.
  if (!isModelHost(host)) throw new Error(`GOLDEN: a golden case tried a call to ${host}; golden cases make model calls only (stub pages, searches and sends in the case).`);
  inflight++;
  try {
    const ctx = als.getStore();
    const mode = ctx?.mode ?? MODE;
    const raw = await bodyText(input, init);
    const k = keyOf(url, raw, init?.headers ?? (typeof input === "object" ? input?.headers : null));

    if (mode === "replay") {
      if (!ctx) throw new Error(`GOLDEN REPLAY: ${noteMiss(null, k, "outside", "outside any golden case: no recording can answer")}`);
      let rec = ctx.recs.get(k.hash);
      let moved = null;
      if (rec && STAMP && stampFile(ctx.id, rec, stampOf(k.key))) stamped++;
      if (!rec) {
        // The exact request isn't recorded: try its skeleton (only the instruction wording masked).
        const now = stampOf(k.key);
        const found = now ? ctx.skel.get(now.hash) ?? [] : [];
        if (found.length !== 1) {
          const why = !now ? "no recording" : found.length > 1 ? `no recording (its skeleton matches ${found.length} recordings, so none is used)` : [...ctx.recs.values()].some((r) => r.structure?.v === wording.signature) ? "no recording (not a wording-only change: the facts, the member's words, a tool, the model, a parameter or a prompt literal off the tone allowlist differ, or an instruction was added, dropped or swapped)" : "no recording (this case's recordings carry no skeleton stamp under the current wording registry, so a wording-only change can't be told apart: run npm run evals:golden:stamp on the code they were recorded with)";
          throw new Error(`GOLDEN REPLAY: ${noteMiss(ctx, k, "none", why)}`);
        }
        rec = found[0];
        const m = movedBetween(rec.structure, now);
        if (m.blocked.length) throw new Error(`GOLDEN REPLAY: ${noteMiss(ctx, k, "none", `no recording (a wording literal changed a rule, not just its words: ${m.blocked.join(", ")}; its guard terms (numbers, tool names, never/always/only, call, offer, question, safe, member...) or its output format changed)`)}`);
        if (STRICT) throw new Error(`GOLDEN REPLAY: ${noteMiss(ctx, k, "none", `no recording (GOLDEN_STRICT: the prompt moved: ${m.moved.map((x) => x.id).join(", ") || "nothing named"})`)}`);
        // What each moved literal said when it was recorded, for --ledger to show (evals/golden/ledger.ts).
        let before = {};
        try { before = wordingBefore({ path: rec.request.path, grader: rec.request.grader, beta: rec.request.beta ?? null, body: rec.request.body }, k.key, wording.chunks, m.moved.map((x) => x.id)); } catch {}
        moved = m.moved.map((x) => ({ ...x, before: before[x.id] ?? null }));
      }
      const calls = (ctx.used.get(rec.hash) ?? 0) + 1;
      ctx.used.set(rec.hash, calls);
      // A repeat past what was recorded is a miss, never the last answer served again: the code now asks more often than it did.
      if (calls > rec.responses.length) throw new Error(`GOLDEN REPLAY: ${noteMiss(ctx, k, "over", `called ${calls} times, recorded ${rec.responses.length}`)}`);
      ctx.served++;
      served++;
      if (moved) { movedServed++; ctx.moved.push({ hash: rec.hash, model: rec.request?.model ?? null, moved }); }
      return responseOf(rec.responses[calls - 1]);
    }

    if (!process.env.ANTHROPIC_API_KEY || /^(ci|golden-replay)$/.test(process.env.ANTHROPIC_API_KEY)) throw new Error(`GOLDEN ${mode.toUpperCase()}: no ANTHROPIC_API_KEY; record and live modes make real, metered calls.`);
    const res = await real(input, init);
    if (mode === "live" || !ctx) return res;
    const txt = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    // Only answers are recorded: a 429 or 529 the SDK retries is not, so the recording holds what the code went on to read.
    if (res.ok && current.get(ctx.id) === ctx.attempt) {
      const prior = ctx.recorded.get(k.hash);
      const resp = responseRecord(res.status, ct, txt);
      const rec = prior ?? { hash: k.hash, case: ctx.id, recorded_at: new RealDate(realNow()).toISOString(), golden_now: GOLDEN_NOW, model: resp.model, request: { ...requestSummary(k.key), beta: k.key.beta, body: k.key.body }, responses: [], ...(wording ? { structure: stampOf(k.key) } : {}) };
      rec.responses.push(resp);
      ctx.recorded.set(k.hash, rec);
      mkdirSync(caseDir(ctx.id), { recursive: true });
      writeFileSync(join(caseDir(ctx.id), `${k.hash}.json`), JSON.stringify(rec, null, 2) + "\n");
      written++;
    }
    // The body was read (and decoded) here, so the copy drops the encoding and length the wire version had.
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(txt, { status: res.status, statusText: res.statusText, headers });
  } finally {
    inflight--;
  }
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// The runner's hooks (evals/golden/run.ts). attempt() runs one try of one case in its own context and says what its calls did so far.
globalThis.__GOLDEN__ = {
  mode: MODE,
  now: GOLDEN_NOW,
  realNow,
  dir: DIR,
  hasRecordings: (id) => existsSync(caseDir(id)) && readdirSync(caseDir(id)).some((f) => f.endsWith(".json")),
  async attempt(id, mode, fn) {
    const recs = mode === "replay" ? loadCase(id) : new Map();
    const ctx = { id, mode, attempt: ++seq, ended: false, superseded: false, recs, skel: skeletonIndex(recs), used: new Map(), misses: [], missed: new Set(), served: 0, recorded: new Map(), moved: [] };
    // A record attempt replaces what came before for its case: the replay that found it missing (--missing) no longer counts.
    if (mode === "record") { current.set(id, ctx.attempt); rmSync(caseDir(id), { recursive: true, force: true }); for (const c of contexts) if (c.id === id) c.superseded = true; }
    contexts.push(ctx);
    active = ctx;
    let value;
    try { value = await als.run(ctx, fn); } finally { ctx.ended = true; if (active === ctx) active = null; }
    const unused = mode === "replay" ? [...ctx.recs.keys()].filter((h) => !ctx.used.has(h)) : [];
    return { value, attempt: ctx.attempt, misses: [...ctx.misses], served: ctx.served, recorded: [...ctx.recorded.values()].reduce((a, r) => a + r.responses.length, 0), unused, moved: [...ctx.moved] };
  },
  // Lets late work finish before the run is judged: timers and microtasks get a turn, then in-flight model calls drain (capped).
  async settle(ms = 250, cap = 5_000) {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    await pause(ms);
    const until = realNow() + cap;
    while (inflight > 0 && realNow() < until) await pause(25);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  },
  // Every miss of the run, wherever it landed: { case (null when outside any case), attempt, miss }.
  allMisses: () => [
    ...contexts.filter((c) => !c.superseded).flatMap((c) => c.misses.map((miss) => ({ case: c.id, attempt: c.attempt, miss }))),
    ...outside.map((miss) => ({ case: null, attempt: null, miss })),
  ],
  stats: () => ({ served, written, inflight, moved: movedServed, stamped }),
  // The wording registry (evals/golden/wording.ts): set once, before any case runs.
  setWording: (w) => { wording = w && Array.isArray(w.chunks) ? { signature: String(w.signature), chunks: w.chunks } : null; },
  strict: STRICT,
  stamping: STAMP,
};
