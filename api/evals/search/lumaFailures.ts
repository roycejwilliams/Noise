// A broken source never passes for an empty search (Royce, 2026-11-10: "a failed verification service must never become 'nothing
// found' or evidence that no matching events exist"). From 2026-10-31 every Luma API call answered 403 ("Your calendar must have an
// active Luma Plus plan to make API requests"); lookupLumaEntity read that as "Luma knows no such event", so every Exa-found Luma link
// died silently at the lookup (looked 0, kept 0, no error) while the paid Exa searches kept running. Here: each kind of outcome is its
// own answer, a denial pauses the API for the whole source (said once per search, in the log and the sweep's failures), no paid Exa
// search runs while its results can't be checked, and recovery is one free API call after a bounded pause.
// Zero tokens: Luma's API and Exa are stubbed; nothing leaves the machine.
//   npx tsx evals/search/lumaFailures.ts
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
delete process.env.EXA_API_KEY;

const L = await import("../../src/services/luma.js");
const V = await import("../../src/services/lumaViaExa.js");
const S = await import("../../src/services/sweepFind.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};

const PLUS = "Your calendar must have an active Luma Plus plan to make API requests";
const env = { LUMA_API_KEY: "test-key" } as NodeJS.ProcessEnv;
let clock = Date.parse("2026-11-10T17:00:00Z");
let calls: string[] = [];
// A fake Luma API: answer(path) decides the response.
const fake = (answer: (url: URL) => Response | Promise<Response> | "throw") =>
  (async (input: any) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams.toString()}`);
    const a = await answer(url);
    if (a === "throw") throw new Error("The operation was aborted due to timeout");
    return a;
  }) as unknown as typeof fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deps = (answer: Parameters<typeof fake>[0]) => ({ fetchImpl: fake(answer), now: () => clock, env });
const fresh = () => {
  L.resetLumaPublicApi();
  calls = [];
  clock = Date.parse("2026-11-10T17:00:00Z");
};

// ================================================================ each outcome its own answer (services/luma.ts)
{
  fresh();
  const r = await L.lookupLumaEntity("abc123", deps(() => json(403, { message: PLUS })));
  check("a 403 is 'denied', never null ('no such event')", r === "denied", r);
  const d = L.lumaApiDenied(clock);
  check("the denial is kept with Luma's own words and a 30-minute pause", !!d && d.status === 403 && d.message === PLUS && d.until - clock === 30 * 60_000, d);
  check("the denial never carries the key", !JSON.stringify(d).includes("test-key"));
  calls = [];
  const again = await L.lookupLumaEntity("other1", deps(() => json(200, {})));
  check("while the pause is in force, no call goes out: 'denied' for the source, not one 403 per event", again === "denied" && calls.length === 0, { again, calls });
  const ev = await L.getPublicLumaEvent("evt-1", deps(() => json(200, {})));
  check("the event read is paused too", ev === "denied" && calls.length === 0, ev);
}
{
  fresh();
  check("a 401 is 'denied' too", (await L.lookupLumaEntity("k1", deps(() => json(401, { message: "Invalid API key" })))) === "denied");
}
{
  fresh();
  check("a 404 is 'no such event' (null)", (await L.lookupLumaEntity("gone1", deps(() => json(404, { message: "not found" })))) === null);
  check("a 200 naming no event or calendar is 'no such event' (null)", (await L.lookupLumaEntity("none1", deps(() => json(200, { entity: null })))) === null);
  check("a 404 doesn't start a denial", L.lumaApiDenied(clock) === null);
}
{
  fresh();
  const r = await L.lookupLumaEntity("slow1", deps(() => "throw"));
  check("a timeout or network error is 'failed', not null", r === "failed", r);
  calls = [];
  await L.lookupLumaEntity("slow1", deps(() => json(404, {})));
  check("a failure isn't cached: the next check asks again", calls.length === 1, calls);
}
{
  fresh();
  check("a 5xx is 'failed'", (await L.lookupLumaEntity("s5", deps(() => json(502, {})))) === "failed");
  check("a 200 that can't be read is 'failed'", (await L.lookupLumaEntity("s6", deps(() => new Response("<html>oops</html>", { status: 200 })))) === "failed");
  check("another 4xx (400) is 'failed', not 'no such event'", (await L.lookupLumaEntity("s7", deps(() => json(400, { message: "bad" })))) === "failed");
  check("a 429 is still 'refused'", (await L.lookupLumaEntity("s8", deps(() => json(429, {})))) === "refused");
  check("an event read that timed out is 'failed', not null", (await L.getPublicLumaEvent("evt-9", deps(() => "throw"))) === "failed");
  check("an event read that's a 404 is null", (await L.getPublicLumaEvent("evt-10", deps(() => json(404, {})))) === null);
}
{
  fresh();
  const ok = await L.lookupLumaEntity("good1", deps(() => json(200, { entity: { type: "event", event: { id: "evt-good1", slug: "good1", start_at: "2026-11-12T02:00:00Z", end_at: null } } })));
  check("a 200 event still resolves", typeof ok === "object" && ok?.type === "event" && ok.id === "evt-good1", ok);
}

// ================================================================ bounded backoff and a free recovery check
{
  check("the pause doubles with each denial in a row: 30, 60, 120 minutes", L.deniedPauseMs(1) === 30 * 60_000 && L.deniedPauseMs(2) === 60 * 60_000 && L.deniedPauseMs(3) === 120 * 60_000);
  check("and stops at a day", L.deniedPauseMs(20) === 24 * 60 * 60_000);
  fresh();
  await L.lookupLumaEntity("a1", deps(() => json(403, { message: PLUS })));
  calls = [];
  check("in force: the state is 'denied' with no call", (await L.lumaApiState(deps(() => json(404, {})))) === "denied" && calls.length === 0, calls);
  clock += 31 * 60_000;
  const st = await L.lumaApiState(deps(() => json(403, { message: PLUS })));
  check("after the pause: one free probe (an entity lookup), denied again", st === "denied" && calls.length === 1 && calls[0].startsWith("/v1/entities/lookup"), { st, calls });
  check("the second denial in a row pauses for an hour", L.lumaApiDenied(clock)?.until === clock + 60 * 60_000, L.lumaApiDenied(clock));
  clock += 61 * 60_000;
  calls = [];
  const back = await L.lumaApiState(deps(() => json(404, { message: "no such slug" })));
  check("a probe Luma answers (404 is an answer) clears the denial: 'ok'", back === "ok" && L.lastLumaApiDenial() === null, { back, d: L.lastLumaApiDenial() });
  fresh();
  await L.lookupLumaEntity("a2", deps(() => json(403, { message: PLUS })));
  clock += 31 * 60_000;
  const noAnswer = await L.lumaApiState(deps(() => "throw"));
  check("a probe that got no answer isn't proof the key works: still 'denied'", noAnswer === "denied", noAnswer);
  check("no key at all is 'off', a setting", (await L.lumaApiState({ env: {} as NodeJS.ProcessEnv })) === "off");
  fresh();
  calls = [];
  check("never denied: 'ok' with no call", (await L.lumaApiState(deps(() => json(500, {})))) === "ok" && calls.length === 0);
}

// ================================================================ the search: no paid Exa search when its results can't be checked
let exaCalls = 0;
let reserves = 0;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
let pageReads = 0;
const via = (o: { state?: "ok" | "denied" | "off"; lookup?: (slug: string) => Promise<any>; event?: (id: string) => Promise<any>; pages?: { url: string; title: string }[]; page?: (slug: string) => Promise<any> }) => ({
  exa: async () => (exaCalls++, { pages: (o.pages ?? []).map((p) => ({ ...p, published: null, text: "" })), cost: 0.022, error: null }),
  lookup: o.lookup ?? (async () => null),
  event: o.event ?? (async () => null),
  lumaApi: () => true,
  apiState: async () => o.state ?? "ok",
  denial: () => (o.state === "denied" ? { at: Date.now(), until: Date.now() + 30 * 60_000, status: 403, message: PLUS, streak: 1 } : null),
  // The page route (PR b): blocked unless a test says otherwise, so these tests are about the API alone.
  page: async (slug: string) => (pageReads++, o.page ? o.page(slug) : { kind: "blocked", why: "HTTP 403" }),
  configured: () => true,
  now: () => new Date(),
  refusing: () => false,
  pauseMinutes: 10,
  reserve: async () => (reserves++, { ok: true, reason: null }),
  place: async () => ({ name: "San Francisco" }),
});
const run = (d: ReturnType<typeof via>, what = "founder dinners") => {
  V.clearLumaViaExaCache();
  V.resetLumaPages();
  return V.lumaEventsViaExa(what, "San Francisco", { userId: null, source: "sweep", inRange: () => true, dates: "November 10 to November 24, 2026", deps: d });
};
{
  exaCalls = 0; reserves = 0;
  const r = await run(via({ state: "denied", pages: [{ url: "https://lu.ma/abc123", title: "Dinner" }] }));
  check("the API refusing the key and Luma's pages not served: no Exa search, no budget slot taken", exaCalls === 0 && reserves === 0, { exaCalls, reserves });
  check("and it says so, once, as a source-wide failure (not 'nothing found'), naming both routes", !!r && r.report.sourceDown === true && /refused the key \(HTTP 403: "Your calendar must have an active Luma Plus plan/.test(r.report.error ?? "") && /weren't served to us \(HTTP 403\)/.test(r.report.error ?? "") && /no Luma search through Exa runs/.test(r.report.error ?? ""), r?.report);
  check("the failure reaches the sweep's failures (not a setting)", S.eventSearchFailures({ viaExa: { error: r!.report.error } }).length === 1);
}
{
  exaCalls = 0;
  const r = await run(via({ state: "ok", pages: [] }));
  check("a healthy API and an empty search: no error, nothing down (empty is empty)", !!r && r.report.error === null && !r.report.sourceDown && r.report.pages === 0 && exaCalls === 1, r?.report);
}
{
  const pages = ["https://lu.ma/aaa111", "https://lu.ma/bbb222", "https://lu.ma/ccc333"].map((url, i) => ({ url, title: `Event ${i}` }));
  const r = await run(via({ state: "ok", pages, lookup: async () => "denied" }));
  check("denied mid-search: every link counted as denied, none as looked, past or not public", !!r && r.report.denied === 3 && r.report.looked === 0 && r.report.notPublic === 0 && r.report.kept === 0, r?.report);
  check("and said once with the counts: unchecked, not 'no such event'", /3 of 3 Luma links went unchecked \(not "no such event"\)/.test(r?.report.error ?? "") && r?.report.sourceDown === true, r?.report.error);
}
{
  const pages = ["https://lu.ma/ddd444", "https://lu.ma/eee555"].map((url, i) => ({ url, title: `Event ${i}` }));
  const r = await run(via({ state: "ok", pages, lookup: async (slug) => (slug === "ddd444" ? "failed" : null) }));
  check("a check with no answer is 'failed' (unchecked), a 404 is just gone", !!r && r.report.failed === 1 && /1 of 2 Luma checks got no usable answer/.test(r.report.error ?? "") && !r.report.sourceDown, r?.report);
}
{
  const pages = [{ url: "https://lu.ma/fff666", title: "Dinner" }];
  const r = await run(via({ state: "ok", pages, lookup: async () => ({ type: "event", id: "evt-f", slug: "fff666", startAt: at(48), endAt: null }), event: async () => "failed" }));
  check("an event read with no answer is 'failed', not dropped as not public", !!r && r.report.failed === 1 && r.report.notPublic === 0 && r.report.read === 0, r?.report);
}

console.log(`lumaFailures: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
