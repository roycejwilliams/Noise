// shareFinds records only what went (fix/sharefinds-records-what-went). Before, a call that sent one find and refused another
// returned ok with no recordAs, so the guard (agent/toolGuard.ts) recorded the full input as sent: the refused find landed as a
// content-keyed co_facts `sent` row and in the action ledger's `sent` row. Now the tool hands the guard the finds that went
// (withRecordAs), kept off the result the model reads. Layer 1: the database is a stub, zero tokens.
//   - a partly refused share records only what went: the content-keyed fact, the ledger row and the decision log's recordAs
//   - a fully refused share records nothing as sent (its ledger row is not_done, and no content-keyed fact is written)
//   - the model-facing result is unchanged: it still lists every refused find and why, and carries no recordAs
//   - the backfills (coFacts backfillCoActions and the ledger's) rebuild from the logged recordAs, so they agree
//   npx tsx evals/ledger/shareFindsRecord.ts
const { default: pool } = await import("../../src/db/db.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const log = console.log;
const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const e = console.error; console.log = () => {}; console.error = () => {}; try { return await f(); } finally { console.log = log; console.error = e; } };

const U = "00000000-0000-4000-8000-0000000000a1";
const T0 = new Date("2026-10-20T18:00:00.123Z");
const JAZZ = "https://lu.ma/jazz-thursday";
const SALON = "https://lu.ma/founder-salon";
const STRAY = "https://lu.ma/never-found";
// Two finds in their notes (search_briefs), each with the facts its caption is checked against.
const brief = { kind: "event", what: "jazz", city: "San Francisco", shortlist: [
  { name: "Jazz Night at the Royal Cuckoo", url: JAZZ, note: "Live jazz trio Thursday at 8pm, free entry." },
  { name: "Founder Salon", url: SALON, note: "Small founder salon on Friday at 7pm, twelve seats." },
] };
type Call = { sql: string; p: any[] };
let calls: Call[] = [];
let nextDecision = 900;
(pool as any).query = async (sql: string, p: any[] = []) => {
  calls.push({ sql, p });
  if (/FROM search_briefs/.test(sql)) return { rows: [{ brief }] };
  if (/INSERT INTO harness_decisions/.test(sql)) return { rows: [{ id: String(nextDecision++), created_at: T0 }] };
  if (/INSERT INTO co_facts/.test(sql)) return { rows: [{ id: 1 }] };
  return { rows: [] };
};
(pool as any).connect = async () => ({ query: (sql: string, p?: any[]) => (pool as any).query(sql, p), release: () => {} });
const isLedgerInsert = (c: Call) => /INSERT INTO co_facts/.test(c.sql) && String(c.p[3] ?? "").startsWith("L|");
const ledgerInserts = () => calls.filter(isLedgerInsert);
const legacyInserts = () => calls.filter((c) => /INSERT INTO co_facts/.test(c.sql) && !isLedgerInsert(c));
const decisionOf = (tool: string) => calls.find((c) => /INSERT INTO harness_decisions/.test(c.sql) && c.p.includes(tool));
const proposalOf = (c: Call | undefined) => { for (const v of c?.p ?? []) { if (typeof v === "string" && v.startsWith("{")) { try { const j = JSON.parse(v); if (j && "ability" in j) return j; } catch {} } } return null; };
const L = await import("../../src/services/ledger.js");
const S = await import("../../src/services/ledgerSources.js");
const { toolAction } = await import("../../src/services/coFacts.js");
const waitFor = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); await L.ledgerSettled(); };

const switches = await import("../../src/services/abilitySwitches.js");
switches.setSwitchesForTest({});
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const texts: string[] = [];
const tools = () => createConversationTools({
  userId: U, phoneNumber: "+10000000000", resolvedContent: "any jazz this week? or something for founders", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false,
  dryRun: false, stubSearch: true, sendCoReply: async ({ message }: any) => (texts.push(message), true), facts: { add: () => {}, text: () => "" },
} as any).tools as any;

// ---- a partly refused share: one find goes, one isn't something Cue found
calls = []; texts.length = 0;
const partly: any = await quiet(() => tools().shareFinds.execute({
  items: [{ link: JAZZ, caption: "Live jazz trio Thursday at 8pm, free entry." }, { link: STRAY, caption: "A private supper club on Friday." }],
  why: "they asked for jazz",
}, { toolCallId: "p1", messages: [] }));
await waitFor(() => ledgerInserts().length > 0);
log(`model-facing result (partly refused): ${JSON.stringify(partly)}`);
check("partly refused: the jazz find really went (its link was texted)", texts.includes(JAZZ) && !texts.includes(STRAY), texts);
check("partly refused, model result: ok, the find that went, and the refused one with why", partly?.ok === true && JSON.stringify(partly.sent) === JSON.stringify(["Jazz Night at the Royal Cuckoo"]) && partly.refused?.length === 1 && partly.refused[0].startsWith(`${STRAY}: not something you found`), partly);
check("partly refused, model result: exactly the keys it always had (no recordAs leaks to the model)", JSON.stringify(Object.keys(partly).sort()) === JSON.stringify(["note", "ok", "refused", "sent"]), Object.keys(partly));
const pLedger = ledgerInserts();
check("partly refused, ledger: one sent row, holding only the find that went", pLedger.length === 1 && pLedger[0].p[1] === "sent" && pLedger[0].p[4] === JAZZ && !JSON.stringify(pLedger[0].p).includes(STRAY), pLedger.map((c) => c.p));
check("partly refused, ledger: its keys name only the jazz find", (() => { const m = JSON.parse(pLedger[0]?.p[7] ?? "{}"); return m.items?.includes(`u:${JAZZ}`) && !m.items.some((k: string) => k.includes("never-found")); })(), pLedger[0]?.p[7]);
const pLegacy = legacyInserts();
check("partly refused, old store: one content-keyed sent fact, the jazz find only", pLegacy.length === 1 && pLegacy[0].p[2] === "sent" && pLegacy.every((c) => !JSON.stringify(c.p).includes(STRAY)), pLegacy.map((c) => c.p));
const pDecision = proposalOf(decisionOf("tool.shareFinds"));
check("partly refused, decision log: recordAs holds only what went (so both backfills rebuild the same)", pDecision?.recordAs?.items?.length === 1 && pDecision.recordAs.items[0].link === JAZZ, pDecision);
check("partly refused, decision log: the full ask is still logged as input (the log of what was asked)", pDecision?.input?.items?.length === 2);
// The backfills read recordAs before input (coFacts backfillCoActions: COALESCE(proposal->'recordAs', proposal->'input');
// ledgerSources backfillRows: p.recordAs ?? p.input).
const back = S.backfillRows({ userId: U, memories: [], outbound: [], outboundOther: 0, replied: [], docs: [], ledger: [], tools: [{ id: "900", decision: "tool.shareFinds", action: "done", at: T0, proposal: pDecision }] } as any).filter((b) => b.source === "tool outcomes");
check("partly refused, ledger backfill: rebuilds the same row from the log (jazz only)", back.length === 1 && back[0].row.parts.length === 1 && back[0].row.parts[0].url === JAZZ, back.map((b) => b.row));
const legacyBack = toolAction("shareFinds", pDecision?.recordAs ?? pDecision?.input);
check("partly refused, coFacts backfill: rebuilds the jazz find only", legacyBack?.length === 1 && legacyBack[0].url === JAZZ, legacyBack);
check("partly refused: the refused find is still on the turn's own log (loop.shareFinds)", (() => { const d = calls.find((c) => /INSERT INTO harness_decisions/.test(c.sql) && c.p.includes("loop.shareFinds")); return !!d && JSON.stringify(d.p).includes("not something you found"); })());

// ---- a fully refused share: nothing went
calls = []; texts.length = 0;
const none: any = await quiet(() => tools().shareFinds.execute({ items: [{ link: STRAY, caption: "A private supper club on Friday." }], why: "they asked" }, { toolCallId: "n1", messages: [] }));
await waitFor(() => ledgerInserts().length > 0);
log(`model-facing result (fully refused): ${JSON.stringify(none)}`);
check("fully refused, model result: not ok, nothing sent, the refused find with why", none?.ok === false && none.sent?.length === 0 && none.refused?.length === 1 && none.note === "Nothing sent." && JSON.stringify(Object.keys(none).sort()) === JSON.stringify(["note", "ok", "refused", "sent"]), none);
check("fully refused: nothing was texted", texts.length === 0, texts);
const nLedger = ledgerInserts();
check("fully refused, ledger: no sent row; the one row is not_done", nLedger.length === 1 && nLedger[0].p[1] === "not_done" && JSON.parse(nLedger[0].p[7]).receipt === "not_done", nLedger.map((c) => c.p));
check("fully refused, old store: no content-keyed fact at all", legacyInserts().length === 0, legacyInserts().map((c) => c.p));
check("fully refused, decision log: not done, so the coFacts backfill (done only) never reads it", (() => { const d = decisionOf("tool.shareFinds"); return !!d && d.p.includes("not_done"); })());

// ---- everything went: recorded as before (both finds), each its own sent part
calls = []; texts.length = 0;
const all: any = await quiet(() => tools().shareFinds.execute({
  items: [{ link: JAZZ, caption: "Live jazz trio Thursday at 8pm, free entry." }, { link: SALON, caption: "Small founder salon on Friday at 7pm, twelve seats." }], why: "they asked",
}, { toolCallId: "a1", messages: [] }));
await waitFor(() => ledgerInserts().length > 0);
check("all went, model result: unchanged shape", all?.ok === true && all.sent?.length === 2 && all.refused?.length === 0 && JSON.stringify(Object.keys(all).sort()) === JSON.stringify(["note", "ok", "refused", "sent"]), all);
check("all went: both finds recorded as sent, in the ledger and the old store", ledgerInserts().length === 1 && ledgerInserts()[0].p[1] === "sent" && [JAZZ, SALON].every((u) => JSON.parse(ledgerInserts()[0].p[7]).items.includes(`u:${u}`)) && legacyInserts().length === 2, { l: ledgerInserts().map((c) => c.p), o: legacyInserts().map((c) => c.p) });

// ---- a link sent earlier this turn isn't sent again, and isn't recorded again by this call
calls = []; texts.length = 0;
{
  const t = tools();
  await quiet(() => t.shareFinds.execute({ items: [{ link: JAZZ, caption: "Live jazz trio Thursday at 8pm, free entry." }], why: "first" }, { toolCallId: "s1", messages: [] }));
  await waitFor(() => ledgerInserts().length > 0);
  calls = [];
  const again: any = await quiet(() => t.shareFinds.execute({ items: [{ link: JAZZ, caption: "Live jazz trio Thursday at 8pm, free entry." }, { link: SALON, caption: "Small founder salon on Friday at 7pm, twelve seats." }], why: "second" }, { toolCallId: "s2", messages: [] }));
  await waitFor(() => ledgerInserts().length > 0);
  check("already shared this turn: the second call records only the salon", again?.ok === true && ledgerInserts().length === 1 && ledgerInserts()[0].p[4] === SALON && legacyInserts().length === 1 && legacyInserts()[0].p[5] === SALON, { l: ledgerInserts().map((c) => c.p), o: legacyInserts().map((c) => c.p) });
}

console.log(`shareFinds records what went: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
