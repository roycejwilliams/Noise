// Exa follow-ups from the review of #225 (services/exaSearch.ts): (1) a found link loses its ad tracking tags once, where Exa's
// pages come in, so no pick, find or link Cue sends carries them (ref= stays); (2) a search that didn't run (Exa down or timed out,
// or blocked by the web search budget) is said as one by every caller, never as "nothing exists". Zero tokens: Exa, the model and the database are stubbed, nothing leaves the machine.
//   npx tsx evals/exa/followups.ts
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
import { readFileSync } from "fs";

const { default: pool } = await import("../../src/db/db.js");
// Google's geocoder never answers in layer 1 (it used to reach maps.googleapis.com with the placeholder key and fail there; the
// outside-socket guard now refuses that): it fails the same way here, with no network.
(await import("../../src/services/geocoding.js")).geoDeps.google = async () => { throw new Error("layer 1: no geocoder"); };
const X = await import("../../src/services/exaSearch.js");
const T = await import("../../src/services/taskWeb.js");
const O = await import("../../src/services/webOpportunitySearch.js");
const MT = await import("../../src/harness/memberThreads.js");
const LT = await import("../../src/agent/loopTools.js");
// The one way a text leaves (services/sendblue.ts), stood in for: what would have been sent is recorded, nothing goes out.
const { default: sendblue } = await import("../../src/services/sendblue.js");
const texts: string[] = [];
const realSend = sendblue.messages.send;
(sendblue.messages as any).send = async (body: any) => { texts.push(String(body?.content ?? "")); return { status: "QUEUED" }; };
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
};

// ---------------------------------------------------------------- the stub web and database
// Exa answers per query: a function of the query, so one search can fail while another runs.
let exa: (query: string) => { status: number; body: any } = () => ({ status: 200, body: { results: [] } });
let modelText = '{"items": []}';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url instanceof URL ? url.href : typeof url === "string" ? url : url?.url);
  if (u.startsWith("https://api.exa.ai/")) {
    const a = exa(String(JSON.parse(init?.body ?? "{}").query ?? ""));
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }
  if (/api\.anthropic\.com/.test(u)) {
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: modelText }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("", { status: 404 });
}) as typeof fetch;
// No database: every read is empty, writes are swallowed, and the web search budget has room (a fake client for its lock).
let rowsFor: (sql: string) => any[] = () => [];
// Every statement, with its params, so a test can see what was written (nothing reaches a database).
const sqlLog: { sql: string; p: any[] }[] = [];
const realQuery = (pool as any).query;
const realConnect = (pool as any).connect;
(pool as any).query = async (sql: string, p: any[] = []) => {
  sqlLog.push({ sql, p });
  return { rows: rowsFor(sql), rowCount: /^\s*UPDATE co_tasks SET status/.test(sql) ? 1 : 0 };
};
// budget: the day's count each budget check sees, in order (a big count blocks that search); empty means room for every one.
let budget: number[] = [];
(pool as any).connect = async () => ({
  query: async (sql: string, p: any[] = []) => {
    sqlLog.push({ sql, p });
    if (/COUNT\(\*\)::int AS today/.test(sql)) return { rows: [{ today: budget.length ? budget.shift()! : 0 }] };
    // A text's ledger row (harness/proactive.ts sendExempt): claimed, so the stood-in send runs.
    if (/INSERT INTO proactive_sends/.test(sql)) return { rows: [{ id: 1 }] };
    // A line queued at the door (harness/door.ts): the candidate's row is written.
    if (/INSERT INTO proactive_candidates/.test(sql)) return { rows: [{ id: 1 }] };
    return { rows: rowsFor(sql) };
  },
  release: () => {},
});
const FULL = 1_000_000;

const DOWN = () => ({ status: 500, body: { error: "down" } });
const TAGGED = "https://joulesaccelerator.org/apply?cohort=2026&utm_source=newsletter&utm_medium=email&gclid=abc123";
const CLEAN = "https://joulesaccelerator.org/apply?cohort=2026";
const PAGE = { url: TAGGED, title: "Joules Accelerator: apply", publishedDate: "2026-10-01T00:00:00Z", text: "Joules Accelerator. Applications open until Nov 30, 2026. $100K for climate hardware founders." };

try {
  process.env.EXA_API_KEY = "test-key";

  // ================================================================ 1. tracking tags
  const w = X.withoutTracking;
  check("ad and email tracking tags come off a found link (utm_*, gclid, fbclid, mc_cid, msclkid, _hsenc, mkt_tok)", w("https://a.com/e?utm_source=x&utm_campaign=y&gclid=1&fbclid=2&mc_cid=3&mc_eid=4&msclkid=5&_hsenc=6&mkt_tok=7") === "https://a.com/e", w("https://a.com/e?utm_source=x&gclid=1"));
  // Royce, 2026-10-17: "Leave ref= alone, so a referral code or a GitHub branch survives."
  check("ref= stays: a GitHub branch or tag", w("https://github.com/x/y/blob/main/README.md?ref=v2.0") === "https://github.com/x/y/blob/main/README.md?ref=v2.0", w("https://github.com/x/y/blob/main/README.md?ref=v2.0"));
  check("ref= stays: a referral code, while the utm tag beside it goes", w("https://posh.vip/e/party?ref=jordan123&utm_source=ig") === "https://posh.vip/e/party?ref=jordan123", w("https://posh.vip/e/party?ref=jordan123&utm_source=ig"));
  const refPages = X.pagesFrom({ results: [{ url: "https://posh.vip/e/party?ref=jordan123&utm_source=ig", title: "Party", text: "x" }] });
  check("... and a pick that dropped the ref still matches its page, whose own link (ref kept) comes back", refPages[0]?.url === "https://posh.vip/e/party?ref=jordan123" && X.onePage("https://posh.vip/e/party", refPages) === "https://posh.vip/e/party?ref=jordan123");
  check("... and every param that matters stays, as written and in order (an event id, a date)", w("https://www.eventbrite.com/e/founder-dinner?aff=ebdssbdestsearch&utm_source=x&eid=123&date=2026-11-02") === "https://www.eventbrite.com/e/founder-dinner?aff=ebdssbdestsearch&eid=123&date=2026-11-02" && w("https://lu.ma/event/evt-AbC?tk=9a%20b&utm_medium=social") === "https://lu.ma/event/evt-AbC?tk=9a%20b");
  check("... the fragment stays, and a link with nothing to strip comes back exactly as it was", w("https://a.com/p?id=7&utm_source=x#tickets") === "https://a.com/p?id=7#tickets" && w("https://a.com/p?id=7&q=a+b#x") === "https://a.com/p?id=7&q=a+b#x" && w("https://a.com/p") === "https://a.com/p" && w("not a url") === "not a url");
  check("... a param that only starts like a tag stays (refund, reference, source_id)", w("https://a.com/p?refund=1&reference=AB12&source_id=4") === "https://a.com/p?refund=1&reference=AB12&source_id=4");

  const pages = X.pagesFrom({ results: [PAGE, { url: `${CLEAN}&fbclid=zzz`, title: "the same page, shared from Facebook", text: "dupe" }] });
  check("Exa's pages carry the clean link, and two links that differ only by tags are one page", pages.length === 1 && pages[0].url === CLEAN, pages.map((p) => p.url));
  check("the picker sees only the clean link", X.pagesBlock(pages).includes(`[P1] ${CLEAN}\n`) && !/utm_|gclid/.test(X.pagesBlock(pages)));
  check("a pick that kept the tags still matches its page, and the page's clean link is what comes back", X.onePage(TAGGED, pages) === CLEAN && X.onePage(CLEAN, pages) === CLEAN);

  // The task search (the reply's webSearch, task turns, the sweep, the research brief): the url carried on is the page's clean one,
  // even when the model wrote the tagged copy.
  exa = () => ({ status: 200, body: { results: [PAGE] } });
  modelText = JSON.stringify({ items: [{ name: "Joules Accelerator", url: TAGGED, details: [{ label: "deadline", value: "Nov 30, 2026" }], date: null, deadline: "2026-11-30" }] });
  const t = await T.taskWebSearch("u1", "climate hardware accelerators", { skipBudget: true, log: false });
  const urls = [...t.kept, ...t.dropped].map((x) => x.url);
  check("the task search carries the page's clean link on to its checks (never the tagged copy the model wrote)", urls.includes(CLEAN) && !urls.some((u) => /utm_|gclid/.test(u)), urls);

  // The opportunity search (companion check-ins): the same.
  modelText = JSON.stringify({ found: true, name: "Joules Accelerator", url: TAGGED, category: "accelerator", reason: "Applications are open until Nov 30.", deadline: "2026-11-30", date: null });
  const r1 = await O.searchWebForOpportunity("climate hardware accelerators", "San Francisco", null, "2026-10-16", { source: "sweep" });
  check("the opportunity search keeps the page's clean link, not the tagged copy", r1?.url === CLEAN, r1?.url);

  // ================================================================ 2. a failed search is a failed search
  // The task search itself (covered in evals/exa/search.ts too): its note says it failed.
  exa = DOWN;
  const t2 = await T.taskWebSearch("u1", "x", { skipBudget: true, log: false });
  check("the task search, Exa down: its note says the search failed", /^Web search failed: Exa 500/.test(t2.note), t2.note);

  // The reply's webSearch tool: every search failed means nothing was searched; no "nothing held up" receipt backs "I looked".
  const notDone: string[] = [];
  const facts: { kind: string; text: string }[] = [];
  const ctx: any = { userId: "u1", phoneNumber: "+15550100001", firstName: "Jordan", resolvedContent: "any climate hardware accelerators?", turn: { message: "" }, dryRun: true, facts: { add: (kind: string, text: string) => facts.push({ kind, text }) }, sendCoReply: async () => true };
  // A fresh turn for each case (a turn has its own few web searches).
  const make = (): any => LT.loopTools(ctx, { sent: false, sentMessages: [] }, LT.newLoopState(), (wh: string) => notDone.push(wh));
  let tools = make();
  const down = await tools.webSearch.execute({ queries: ["climate hardware accelerators", "hardware accelerator applications"] }, { toolCallId: "t", messages: [] });
  check("the reply's search, Exa down: the tool says the search failed and never ran, not that nothing turned up", down?.ok === false && /failed/.test(down?.error ?? "") && /Never say nothing turned up/.test(down?.error ?? ""), down);
  check("... it's recorded as not done, and no receipt says it searched and nothing held up", notDone.some((n) => /web search didn't run/i.test(n)) && !facts.some((f) => f.kind === "did_this_turn" && /Searched the web/.test(f.text)), { notDone, facts });
  // One search failed, one ran: the one that ran counts; the failed one is named as failed, never as empty.
  notDone.length = 0;
  facts.length = 0;
  exa = (q) => (/applications/.test(q) ? DOWN() : { status: 200, body: { results: [] } });
  tools = make();
  const half = await tools.webSearch.execute({ queries: ["climate hardware accelerators", "hardware accelerator applications"] }, { toolCallId: "t2", messages: [] });
  const rec = facts.find((f) => f.kind === "did_this_turn" && /Searched the web/.test(f.text))?.text ?? "";
  check("one of two searches failed: the receipt names only the one that ran as searched, and the other as failed", half?.ok === true && /"climate hardware accelerators"\): 0 held up/.test(rec) && /"hardware accelerator applications" failed and never ran/.test(rec), rec);
  check("... and the tool's note says some searches didn't run (not the same as nothing there)", /1 of 2 searches didn't run/.test(half?.note ?? "") && !/^Web search failed/.test(half?.note ?? ""), half?.note);
  // A search the budget blocked never ran either (re-review of #235: one blocked + one Exa-failed came back ok:true with
  // 'Searched the web just now ("budgetq accelerators"): 0 held up on their own pages.').
  notDone.length = 0;
  facts.length = 0;
  budget = [FULL, 0];
  exa = DOWN;
  tools = make();
  const mixed = await tools.webSearch.execute({ queries: ["budgetq accelerators", "exa down accelerators"] }, { toolCallId: "t3", messages: [] });
  check("one search blocked by the budget, one failed: nothing ran, so the tool says the search failed, never 'searched, nothing held up'", mixed?.ok === false && /never ran/.test(mixed?.error ?? "") && !facts.some((f) => f.kind === "did_this_turn" && /Searched the web/.test(f.text)) && notDone.some((n) => /didn't run/.test(n)), { mixed, facts, notDone });
  notDone.length = 0;
  facts.length = 0;
  budget = [FULL, 0];
  exa = () => ({ status: 200, body: { results: [] } });
  tools = make();
  const blockedOne = await tools.webSearch.execute({ queries: ["budgetq accelerators", "climate accelerators"] }, { toolCallId: "t4", messages: [] });
  const rec2 = facts.find((f) => f.kind === "did_this_turn" && /Searched the web/.test(f.text))?.text ?? "";
  check("one search blocked by the budget, one ran: the receipt names only the one that ran as searched, the blocked one as never run", blockedOne?.ok === true && /\("climate accelerators"\): 0 held up/.test(rec2) && !/Searched the web just now \([^)]*budgetq/.test(rec2) && /"budgetq accelerators" never ran/.test(rec2), rec2);
  budget = [];

  // The opportunity search: null either way, but the caller is told when it failed.
  exa = DOWN;
  let why: string | null = null;
  const r2 = await O.searchWebForOpportunity("climate hardware accelerators", null, null, "2026-10-16", { source: "sweep", failed: (x) => (why = x) });
  check("the opportunity search, Exa down: nothing back, and the caller is told the search failed", r2 === null && why === "Exa 500", why);
  exa = () => ({ status: 200, body: { results: [] } });
  why = null;
  await O.searchWebForOpportunity("climate hardware accelerators", null, null, "2026-10-16", { source: "sweep", failed: (x) => (why = x) });
  check("... an empty search is not a failure", why === null, why);

  // The companion check-in (harness/memberThreads.ts): its record says the search failed, not "nothing found".
  const thread = { id: 7, text: "find a climate hardware accelerator", opened_quote: "I need an accelerator for my battery startup", opened_at: "2026-10-01T00:00:00Z", status: "open", feeling: null, due_date: null, next_step: "look_up", kind: "goal", closed_quote: null, last_touched_at: "2026-10-02T00:00:00Z" };
  rowsFor = (sql) => (/FROM member_threads/.test(sql) ? [thread] : /SELECT city FROM co_profiles/.test(sql) ? [{ city: "San Francisco" }] : []);
  exa = DOWN;
  const cp = await MT.companionPayloadFor("u1");
  check("the companion check-in, Exa down: recorded as a failed search, never as 'nothing found'", cp.item === null && cp.checks.some((c) => c.name === "web_search" && !c.pass && /the search failed: Exa 500/.test(c.reason ?? "")) && !cp.checks.some((c) => c.reason === "nothing found"), cp.checks);
  exa = () => ({ status: 200, body: { results: [] } });
  const cp2 = await MT.companionPayloadFor("u1");
  check("... and an empty search is still 'nothing found'", cp2.checks.some((c) => c.reason === "nothing found"), cp2.checks);
  rowsFor = () => [];

} finally {
  globalThis.fetch = realFetch;
  (sendblue.messages as any).send = realSend;
  (pool as any).query = realQuery;
  (pool as any).connect = realConnect;
  delete process.env.EXA_API_KEY;
}

console.log(`exa follow-ups: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
