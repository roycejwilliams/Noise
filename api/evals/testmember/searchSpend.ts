// Test members don't spend on paid search (cost per member, Phase C1, 2026-10-23). Layer 1: the member lookup is stubbed, every
// outside fetch is counted here (and answered with a canned page), nothing reaches a database, a vendor or a model.
//
//   npx tsx evals/testmember/searchSpend.ts
import { readFileSync } from "fs";
import { setTestMemberLookupForTests, skipsForFacts, skipsPaidSearch, type MemberFacts } from "../../src/services/testMemberSpend.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const REAL = "11111111-1111-4111-8111-111111111111";
const TEST = "22222222-2222-4222-8222-222222222222";
const LIVE = "33333333-3333-4333-8333-333333333333";
const ARCHIVED = "44444444-4444-4444-8444-444444444444";
const TEAM = "55555555-5555-4555-8555-555555555555";
const facts: Record<string, MemberFacts> = {
  [REAL]: { phone_number: "+14155550000", archived_phone: null, archived_at: null, live_test_id: LIVE },
  [TEST]: { phone_number: "+15035550142", archived_phone: null, archived_at: null, live_test_id: LIVE },
  [LIVE]: { phone_number: "+14155550177", archived_phone: null, archived_at: null, live_test_id: LIVE },
  [ARCHIVED]: { phone_number: "+14155550166", archived_phone: "+14155550166", archived_at: new Date("2026-10-20"), live_test_id: LIVE },
  [TEAM]: { phone_number: "+14155551234", archived_phone: null, archived_at: null, live_test_id: LIVE },
};
const env = { NODE_ENV: "development" } as NodeJS.ProcessEnv;

// ---------------------------------------------------------------- the rule
check("a real member never skips", !skipsForFacts(REAL, facts[REAL], env));
check("a team account (not a test number) never skips", !skipsForFacts(TEAM, facts[TEAM], env));
check("a 555-01xx test member skips", skipsForFacts(TEST, facts[TEST], env));
check("an archived test account skips", skipsForFacts(ARCHIVED, facts[ARCHIVED], env));
check("the live-test member (newest unarchived +1 415 555-01xx) keeps its searches", !skipsForFacts(LIVE, facts[LIVE], env));
check("an unknown member never skips", !skipsForFacts(REAL, null, env));
check("production: a 555 number can't be a test member, so nothing unarchived skips", !skipsForFacts(TEST, facts[TEST], { RAILWAY_ENVIRONMENT_NAME: "production" } as NodeJS.ProcessEnv));

// ---------------------------------------------------------------- the gate
let lookups = 0;
setTestMemberLookupForTests(async (id) => {
  lookups++;
  return facts[id] ?? null;
});
const logs: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => {
  logs.push(a.map(String).join(" "));
};
const t1 = await skipsPaidSearch(TEST, "probe");
const t2 = await skipsPaidSearch(TEST, "probe");
console.log = origLog;
check("the gate skips a test member and logs one line with ids only", t1 && t2 && logs.length === 2 && logs[0] === `paid search skipped: test member ${TEST} (probe)`);
check("the lookup is cached (one read for two searches)", lookups === 1);
check("no member id, or not an id: never skipped, never looked up", !(await skipsPaidSearch(null, "p")) && !(await skipsPaidSearch("u1", "p")) && lookups === 1);
setTestMemberLookupForTests(async () => {
  throw new Error("db down");
});
const quietErr = console.error;
console.error = () => {};
check("a lookup that fails never skips (a real member is never cut off)", !(await skipsPaidSearch(TEST, "p")));
console.error = quietErr;
setTestMemberLookupForTests(async (id) => facts[id] ?? null);

// ---------------------------------------------------------------- the paid paths, behaviorally
process.env.EXA_API_KEY = "ci-exa";
const hits: string[] = [];
const guarded = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  const host = new URL(url).host;
  hits.push(host);
  if (host === "api.exa.ai") return new Response(JSON.stringify({ results: [{ url: "https://example.org/a", title: "A", text: "A page" }], costDollars: { total: 0.005 } }), { status: 200, headers: { "content-type": "application/json" } });
  return guarded(input, init);
}) as typeof fetch;
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const [l, e] = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.log = l;
    console.error = e;
  }
};
const paidHits = () => hits.filter((h) => h === "api.exa.ai" || h === "api.anthropic.com").length;

const { taskWebSearch } = await import("../../src/services/taskWeb.js");
for (const [who, id, spends] of [["test member", TEST, false], ["real member", REAL, true], ["live-test member", LIVE, true]] as const) {
  hits.length = 0;
  const r = await quiet(() => taskWebSearch(id, "a quiet dinner room for 12", { skipBudget: true, city: "San Francisco" }));
  check(`taskWeb.search: a ${who} ${spends ? "searches" : "makes no search call"}`, spends ? paidHits() > 0 : paidHits() === 0 && /test account/.test(r.note ?? ""));
}

const { findOfficialPage, reserveWebSearch } = await import("../../src/services/webOpportunitySearch.js");
for (const [who, id, spends] of [["test member", TEST, false], ["real member", REAL, true], ["live-test member", LIVE, true]] as const) {
  hits.length = 0;
  await quiet(() => findOfficialPage("Example Room", 5000, undefined, id));
  check(`findOfficialPage: a ${who} ${spends ? "searches" : "makes no search call"}`, spends ? paidHits() > 0 : paidHits() === 0);
}

const { exaSearch } = await import("../../src/services/exaSearch.js");
for (const [who, id, spends] of [["test member", TEST, false], ["real member", REAL, true], ["live-test member", LIVE, true]] as const) {
  hits.length = 0;
  const r = await quiet(() => exaSearch("dinner rooms", { purpose: "probe", userId: id }));
  check(`exa: a ${who} ${spends ? "searches" : "makes no search call"}`, spends ? hits.includes("api.exa.ai") : hits.length === 0 && r.pages.length === 0);
}

const { reserveXSearch } = await import("../../src/services/tieredRecommendation.js");
{
  const x = await quiet(() => reserveXSearch(TEST, "sweep", "q"));
  const w = await quiet(() => reserveWebSearch(TEST, "sweep", "q"));
  check("X and web search budgets refuse a test member before touching the budget", !x.ok && /test account/.test(x.reason ?? "") && !w.ok && /test account/.test(w.reason ?? ""));
  const xr = await quiet(() => reserveXSearch(REAL, "sweep", "q"));
  check("a real member's X budget check runs as before (here: the dead database fails it closed, not the test rule)", !xr.ok && !/test account/.test(xr.reason ?? ""));
}

const { sweepFind } = await import("../../src/services/sweepFind.js");
for (const [who, id, runs] of [["test member", TEST, false], ["real member", REAL, true], ["live-test member", LIVE, true]] as const) {
  let read = 0;
  hits.length = 0;
  const r = await quiet(() =>
    sweepFind({ userId: id, firstName: "Jordan", askText: "a dinner room", city: "San Francisco" }, {
      knowledge: async () => {
        read++;
        return { limits: null } as any; // stops right after the gate: no search either way
      },
    }),
  );
  check(`sweep.find: a ${who} ${runs ? "goes on to its sweep" : "skips the sweep (no record read, no search)"}`, runs ? read === 1 : read === 0 && paidHits() === 0 && r.did.some((d) => /test member/.test(d)));
}
globalThis.fetch = guarded;

// ---------------------------------------------------------------- wiring
for (const [f, path] of [
  ["services/sweepFind.ts", "sweep.find"],
  ["services/taskWeb.ts", "taskWeb.search"],
  ["services/webOpportunitySearch.ts", "findOfficialPage"],
  ["services/webOpportunitySearch.ts", "web_search_budget"],
  ["services/tieredRecommendation.ts", "x_search_budget"],
  ["services/exaSearch.ts", "exa."],
] as const) {
  check(`${f}: gated on the member (${path})`, src(f).includes(`skipsPaidSearch(`) && (src(f).includes(`"${path}`) || src(f).includes(`\`${path}`)));
}
const gate = src("services/testMemberSpend.ts");
check("no switch: the gate reads no env flag of its own", !/process\.env\.[A-Z_]+/.test(gate));
check("the live-test member is the one testMember.ts makes (one shared definition)", /const TEST_PHONE_LIKE = LIVE_TEST_PHONE_LIKE;/.test(src("scripts/testMember.ts")) && /LIVE_TEST_PHONE_LIKE/.test(gate));

setTestMemberLookupForTests(null);
console.log(`test member search spend: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
