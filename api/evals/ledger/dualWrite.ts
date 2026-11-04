// The action ledger, PR 1 of the snapshot rollout (snapshot design 2026-10-29 §3; services/ledger.ts, services/ledgerSources.ts,
// scripts/ledgerBackfill.ts, scripts/ledgerReconcile.ts). Layer 1: the database is a stub, zero tokens.
//   - each new writer, through its real call site, writes exactly one co_facts row, and the old store is still written
//   - one act, one row: a second write of the same act meets the unique key; a backfill rerun writes nothing
//   - the event offer triple and the recommendation pair are one row each; a find logged as a recommendation and as a shareFinds
//     call is one act, in either order
//   - the backfill's dry run over fixtures (counts per source, nothing reaches the database)
//   - the reconcile reports what's unmatched, with its contents, and never matches across members
//   - a failed ledger write never fails or delays the send, and is logged as a decision row without the label
//   - today's readers of co_facts leave the ledger's rows out (nothing reads them yet)
//   npx tsx evals/ledger/dualWrite.ts
import { readFileSync } from "node:fs";
const { default: pool } = await import("../../src/db/db.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const log = console.log;
const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const e = console.error; console.log = () => {}; console.error = () => {}; try { return await f(); } finally { console.log = log; console.error = e; } };

const U = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const T0 = new Date("2026-10-20T18:00:00.123Z");
type Call = { sql: string; p: any[] };
let calls: Call[] = [];
let nextDecision = 500;
const docRow = { id: 77, user_id: U, doc_key: "plan", version: 2, title: "Friday Dinner Plan", kind: null, content: {}, content_hash: "h", channel: "pdf_text", status: "delivered", line: null, link: null, task_id: null, source: "reply", change_note: null, error: null, attempts: 0, next_retry_at: null, delivered_at: T0 };
(pool as any).query = async (sql: string, p: any[] = []) => {
  calls.push({ sql, p });
  if (/INSERT INTO outbound_messages/.test(sql)) return { rows: [{ user_id: U, sent_at: T0 }] };
  if (/INSERT INTO harness_decisions/.test(sql)) return { rows: [{ id: String(nextDecision++), created_at: T0 }] };
  if (/'event_offer_pending'/.test(sql) && /INSERT INTO co_memories/.test(sql)) return { rows: [{ id: "pend-1", created_at: T0 }] };
  if (/'recommendation_offered', u\.x FROM UNNEST/.test(sql)) return { rows: (p[1] as string[]).map((c, i) => ({ id: `ro-${i}`, created_at: T0, content: c })) };
  if (/INSERT INTO document_deliveries/.test(sql)) return { rows: [docRow] };
  if (/INSERT INTO co_facts/.test(sql)) return { rows: [{ id: 1 }] };
  return { rows: [] };
};
// A transaction (saveBacklogMerged) gets a client that runs through the same stub.
(pool as any).connect = async () => ({ query: (sql: string, p?: any[]) => (pool as any).query(sql, p), release: () => {} });
const isLedgerInsert = (c: Call) => /INSERT INTO co_facts/.test(c.sql) && String(c.p[3] ?? "").startsWith("L|");
const ledgerInserts = () => calls.filter(isLedgerInsert);
const legacyInserts = () => calls.filter((c) => /INSERT INTO co_facts/.test(c.sql) && !isLedgerInsert(c));
const L = await import("../../src/services/ledger.js");
const S = await import("../../src/services/ledgerSources.js");
const waitFor = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); await L.ledgerSettled(); };

// ------------------------------------------------------------ each writer, through its call site: exactly one row

// texted: the one send wrapper (services/sendblue.ts), to a test number (logged like a real send, never sent).
const { default: sendblue } = await import("../../src/services/sendblue.js");
calls = [];
const res: any = await sendblue.messages.send({ number: "+14155550142", content: "Here's the one I mentioned.", from_number: "+10000000000" } as any);
await waitFor(() => ledgerInserts().length > 0);
const outbound = calls.find((c) => /INSERT INTO outbound_messages/.test(c.sql));
check("texted: one send writes exactly one ledger row, anchored on its outbound_messages row and time", ledgerInserts().length === 1 && ledgerInserts()[0].p[1] === "texted" && ledgerInserts()[0].p[3] === `L|outbound:${res?.message_handle}` && +ledgerInserts()[0].p[6] === +T0 && ledgerInserts()[0].p[0] === U, ledgerInserts().map((c) => c.p));
check("texted: the old store is still written (outbound_messages)", !!outbound && outbound.p[0] === res?.message_handle);
check("texted: its meta says ledger and carries the handle", (() => { const m = JSON.parse(ledgerInserts()[0]?.p[7] ?? "{}"); return m.ledger === 1 && m.kind === "text" && m.handle === res?.message_handle; })());

// Tool outcomes: the guard (agent/toolGuard.ts), through the real shareLink tool; then the same tool switched off (not done).
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const { abilityForTool } = await import("../../src/services/capabilities.js");
const switches = await import("../../src/services/abilitySwitches.js");
switches.setSwitchesForTest({});
const tools = () => createConversationTools({
  userId: U, phoneNumber: "+10000000000", resolvedContent: "send me that link", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
  sendCoReply: async () => true, facts: { add: () => {}, text: () => "the find: https://lu.ma/abc123" },
} as any).tools as any;
calls = [];
await quiet(() => tools().shareLink.execute({ urls: ["https://lu.ma/abc123"], why: "they asked" }, { toolCallId: "t1", messages: [] }));
await waitFor(() => ledgerInserts().length > 0);
const done = ledgerInserts();
const doneMeta = JSON.parse(done[0]?.p[7] ?? "{}");
check("tool outcome (done): exactly one ledger row, its own relation, anchored on the decision row", done.length === 1 && done[0].p[1] === "sent" && /^L\|decision:\d+$/.test(done[0].p[3]) && doneMeta.receipt === "done" && doneMeta.tool === "shareLink" && done[0].p[4] === "https://lu.ma/abc123", done.map((c) => c.p));
check("tool outcome (done): the old stores are still written (the decision row and the content-keyed fact)", calls.some((c) => /INSERT INTO harness_decisions/.test(c.sql) && c.p[1] === "tool.shareLink") && legacyInserts().length === 1);
switches.setSwitchesForTest({ [abilityForTool("shareLink")!.id]: "test" });
calls = [];
await quiet(() => tools().shareLink.execute({ urls: ["https://lu.ma/abc123"], why: "they asked" }, { toolCallId: "t2", messages: [] }));
await waitFor(() => ledgerInserts().length > 0);
const off = ledgerInserts();
check("tool outcome (switched off): exactly one ledger row, not_done, receipt off; the old content-keyed fact isn't written", off.length === 1 && off[0].p[1] === "not_done" && JSON.parse(off[0].p[7]).receipt === "off" && legacyInserts().length === 0, off.map((c) => c.p));
switches.setSwitchesForTest({});

// The event offer triple: onEventOfferSent writes event_offer_pending (and, revealed, event_offer_resolved): one ledger row.
const sweep = await import("../../src/services/eventSurfacingSweep.js");
calls = [];
const match = { tier: 3, kind: "opportunity", name: "Founder Breakfast", url: "https://example.com/breakfast", reason: "fits" };
await quiet(() => sweep.onEventOfferSent(U, { match, askText: "breakfast things", askId: "ask-1" } as any, true));
await waitFor(() => ledgerInserts().length > 0);
const offer = ledgerInserts();
check("event offer: exactly one ledger row for the triple, its answer on it", offer.length === 1 && offer[0].p[1] === "sent" && offer[0].p[3] === "L|memory:pend-1" && JSON.parse(offer[0].p[7]).offer_state === "revealed_directly" && JSON.parse(offer[0].p[7]).kind === "offer", offer.map((c) => c.p));
check("event offer: the old stores are still written (pending and resolved)", calls.some((c) => /'event_offer_pending'/.test(c.sql)) && calls.some((c) => /'event_offer_resolved'/.test(c.sql)));
calls = [];
L.ledgerOfferState(U, "pend-1", "interested");
await L.ledgerSettled();
const upd = calls.filter((c) => /UPDATE co_facts/.test(c.sql));
check("event offer: a later answer updates that one row in place, scoped to the member", upd.length === 1 && upd[0].p[0] === U && upd[0].p[1] === "L|memory:pend-1" && upd[0].p[2] === "interested" && /owner_user_id = \$1/.test(upd[0].sql) && ledgerInserts().length === 0);

// The recommendation pair: recordRecommendationsSent writes recommendation_offered + recommendation: one ledger row per find.
const { recordRecommendationsSent } = await import("../../src/services/recommendation.js");
calls = [];
const rec = { tier: 2, kind: "public_event", event_api_id: "evt-1", event_date: "2026-10-25", name: "Demo Night", url: "https://lu.ma/demo", reason: "fits" };
await quiet(() => recordRecommendationsSent(U, [rec as any], ["https://lu.ma/demo?ref=cue"]));
await waitFor(() => ledgerInserts().length > 0);
const recRows = ledgerInserts();
const recMeta = JSON.parse(recRows[0]?.p[7] ?? "{}");
check("recommendation: exactly one ledger row for the pair, keyed by the link it went under, its own url and its name", recRows.length === 1 && recRows[0].p[3] === "L|memory:ro-0" && ["u:https://lu.ma/demo?ref=cue", "u:https://lu.ma/demo", "n:demo night"].every((k) => recMeta.items.includes(k)) && recMeta.event_api_id === "evt-1", recRows.map((c) => c.p));
check("recommendation: the old stores are still written (both memories and the content-keyed fact)", calls.some((c) => /'recommendation_offered'/.test(c.sql)) && calls.some((c) => /'recommendation', \$2/.test(c.sql)) && legacyInserts().length === 1);

// The announcement of Noise's own event writes recommendation_offered by hand: its builder makes one row.
const ann = L.recommendationRow({ userId: U, memoryId: "ro-9", at: T0, name: "Noise Supper Club", eventApiId: "evt-9", tier: "1" });
check("announcement: one row, one thing, keyed by name", ann.parts.length === 1 && ann.relation === "sent" && L.objectKey(ann) === "L|memory:ro-9" && ann.parts[0].keys.includes("n:noise supper club"));
const ac = readFileSync(new URL("../../src/services/coEventAnnouncement.ts", import.meta.url), "utf8");
check("announcement: the call site writes it from the recommendation_offered row it just made", /'recommendation_offered', \$2\) RETURNING id, created_at/.test(ac) && /L\.ledgerWrite\(L\.recommendationRow\(/.test(ac));

// ------------------------------------------------------------ idempotency: one act, one row

const store = L.memoryLedgerStore();
const live = L.textedRow({ userId: U, handle: "h-1", content: "See you at 7.", at: T0 });
check("idempotent: the same act written twice is one row (the unique key)", (await L.writeLedgerRow(store, live)) === "written" && (await L.writeLedgerRow(store, live)) === "conflict" && store.rows.length === 1);
const pgSrc = readFileSync(new URL("../../src/services/ledger.ts", import.meta.url), "utf8");
const cf = readFileSync(new URL("../../src/services/coFacts.ts", import.meta.url), "utf8");
const KEY = "ON CONFLICT (owner_user_id, relation, object_key, happened_at) DO NOTHING";
check("idempotent: the ledger insert uses the same ON CONFLICT key as backfillCoActions", pgSrc.includes(KEY) && cf.includes(KEY));

// Fixtures: one member's old stores (times a few ms apart, as they land).
const at = (ms: number) => new Date(T0.getTime() + ms);
const LINK = "https://lu.ma/salon";
const fixture = (ledger: any[] = []): any => ({
  userId: U,
  replied: [
    { id: "m-r1", at: at(0), text: "Morning! How did the pitch go?" },                // also in outbound: one act
    { id: "m-r2", at: at(-86_400_000 * 30), text: "Welcome in." },                   // before outbound_messages existed
    { id: "m-r3", at: at(60_000), text: LINK },                                       // the shareFinds link
    { id: "m-r4", at: at(61_500), text: "Founder salon Thursday, small and quiet." }, // its caption
    { id: "m-r5", at: at(90_000), text: "[sent a document: Friday Dinner Plan]" },    // a note, not a text
  ],
  outbound: [
    { handle: "h-1", at: at(5), content: "Morning! How did the pitch go?" },
    { handle: "h-2", at: at(60_010), content: LINK },
    { handle: "h-3", at: at(61_510), content: "Founder salon Thursday, small and quiet." },
  ],
  outboundOther: 1,
  tools: [
    { id: "d-1", decision: "tool.shareFinds", action: "done", at: at(63_000), proposal: { input: { items: [{ link: LINK, caption: "Founder salon Thursday, small and quiet." }] } } },
    { id: "d-2", decision: "tool.makeDeck", action: "not_done", at: at(120_000), proposal: { input: { title: "x" } } },
    { id: "d-3", decision: "tool.correctWhatCoKnows", action: "done", at: at(130_000), proposal: { removal: true, changes: { remove: 1, correct: 0 }, kinds: ["profile"] } },
  ],
  memories: [
    // the shareFinds find's pair, written right after its caption
    { id: "m-ro1", type: "recommendation_offered", at: at(61_540), content: JSON.stringify({ name: "Founder Salon: Builders Edition", event_api_id: "evt-s" }) },
    { id: "m-rc1", type: "recommendation", at: at(61_560), content: "Cue surfaced 1 tiered recommendation(s) — [Tier public_event] Founder Salon: Builders Edition: A public event." },
    // an event offer triple, the surfacing line 2.4s after (as on dev) and the resolved row
    { id: "m-p1", type: "event_offer_pending", at: at(200_000), content: JSON.stringify({ askText: "rooftop things", match: { name: "Rooftop Mixer", url: "https://lu.ma/roof" } }) },
    { id: "m-res1", type: "event_offer_resolved", at: at(200_010), content: "revealed_directly" },
    { id: "m-s1", type: "event_discovery_surfacing", at: at(202_400), content: "Sent directly (short notice): Rooftop Mixer" },
  ],
  docs: [
    { id: "7", at: at(89_000), title: "Friday Dinner Plan", channel: "pdf_text", version: 1, docKey: "plan", link: null, status: "delivered" },
    { id: "8", at: at(92_000), title: "Friday Dinner Plan", channel: "pdf_text", version: 2, docKey: "plan", link: null, status: "delivered" },
  ],
  ledger,
});

calls = [];
const src = fixture();
const dry = L.memoryLedgerStore(src.ledger);
const counts = await S.runBackfill(dry, src);
check("backfill dry run: nothing reaches the database", calls.length === 0, calls.map((c) => c.sql.slice(0, 60)));
const w = (k: string) => counts[k]?.written ?? 0;
check("backfill dry run: counts per source over the fixtures", w("outbound texts") === 3 && w("transcript lines") === 1 && w("event offers") === 1 && w("recommendations offered") === 1 && w("documents") === 2 && w("tool outcomes") === 2 && counts["surfacing lines"]?.collapsed === 1 && counts["tool outcomes"]?.collapsed === 1 && !counts["recommendation lines"], counts);
check("backfill: a transcript line with its own outbound row is one act (written from outbound only); a note isn't a text", dry.rows.filter((r) => r.relation === "texted").length === 4 && !dry.rows.some((r) => /^\[sent a document/.test(r.label)));
const offerRows = dry.rows.filter((r) => r.meta.kind === "offer");
check("backfill: the event triple is one row, its answer on it (the surfacing line 2.4s later collapses into it)", offerRows.length === 1 && offerRows[0].meta.offer_state === "revealed_directly" && offerRows[0].objectKey === "L|memory:m-p1", offerRows);
const finds = dry.rows.filter((r) => r.relation === "sent" && (r.meta.kind === "find" || r.meta.kind === "tool"));
check("backfill: a find logged as a recommendation pair and as a shareFinds call is one act", finds.length === 1 && finds[0].meta.kind === "find" && finds[0].url === LINK && finds[0].label === "Founder Salon: Builders Edition", finds);
check("backfill: two deliveries of a document 3s apart are two acts (versions 1 and 2)", dry.rows.filter((r) => r.meta.kind === "document").map((r) => r.meta.version).join(",") === "1,2");
const removal = dry.rows.find((r) => r.objectKey === "L|decision:d-3");
check("backfill: a removal receipt's row names the tool only, never their words", removal?.label === "used correctWhatCoKnows" && !JSON.stringify(removal?.meta).includes("profile"), removal);
check("backfill: a refused tool call is one not_done row", dry.rows.some((r) => r.objectKey === "L|decision:d-2" && r.relation === "not_done" && r.meta.receipt === "not_done"));
const again = await S.runBackfill(dry, { ...src, ledger: dry.rows });
check("idempotent: a second backfill run writes nothing", Object.values(again).every((c) => c.written === 0), again);
// The live write and the backfill of the same act: one row.
const liveStore = L.memoryLedgerStore();
await L.writeLedgerRow(liveStore, L.textedRow({ userId: U, handle: "h-1", content: "Morning! How did the pitch go?", at: at(5) }));
const afterLive = await S.runBackfill(liveStore, fixture(liveStore.rows));
check("idempotent: a backfill after the live dual write keeps the live row (already)", afterLive["outbound texts"].conflict === 1 && afterLive["outbound texts"].written === 2);

// Live order, both ways: the recommendation first (as shareFinds does), then the tool's outcome; and the other way round.
for (const order of [["rec", "tool"], ["tool", "rec"]]) {
  const st = L.memoryLedgerStore();
  const r = L.recommendationRow({ userId: U, memoryId: "x1", at: at(1_000), name: "Founder Salon", url: null, sentAs: LINK });
  const t = L.toolOutcomeRow({ userId: U, tool: "shareFinds", receipt: "done", input: { items: [{ link: LINK, caption: "Founder salon Thursday" }] }, decisionId: "9", at: at(2_500) });
  const results = [];
  for (const o of order) results.push(await L.writeLedgerRow(st, o === "rec" ? r : t));
  check(`double counting (${order.join(" then ")}): one sent row for the find`, st.rows.filter((x) => x.relation === "sent").length === 1 && results[1] === "collapsed", { results, rows: st.rows });
}
// Partly sent: a shareFinds call with two finds, one already recorded, keeps only the other.
{
  const st = L.memoryLedgerStore();
  await L.writeLedgerRow(st, L.recommendationRow({ userId: U, memoryId: "x2", at: T0, name: "A", sentAs: "https://a.example" }));
  const t = L.toolOutcomeRow({ userId: U, tool: "shareFinds", receipt: "done", input: { items: [{ link: "https://a.example", caption: "A cap" }, { link: "https://b.example", caption: "B cap" }] }, decisionId: "10", at: T0 });
  const r = await L.writeLedgerRow(st, t);
  const row = st.rows.find((x) => x.objectKey === "L|decision:10");
  check("double counting: a call that sent two finds, one already recorded, keeps only the other", r === "written" && row?.label === "B cap" && row?.url === "https://b.example" && row?.meta.collapsed === 1, row);
}
// The same find far apart in time is two acts.
{
  const st = L.memoryLedgerStore();
  await L.writeLedgerRow(st, L.recommendationRow({ userId: U, memoryId: "x3", at: T0, name: "A", sentAs: "https://a.example" }));
  check("the same find sent again days later is a second act", (await L.writeLedgerRow(st, L.recommendationRow({ userId: U, memoryId: "x4", at: at(3 * 86_400_000), name: "A", sentAs: "https://a.example" }))) === "written");
}

// ------------------------------------------------------------ reconcile

const full = S.reconcileMember(src, dry.rows);
check("reconcile: after the backfill, every old-store act is matched and nothing is held twice", full.unmatched.length === 0 && full.doubles.length === 0 && full.notes === 1 && full.outboundOther === 1, full);
check("reconcile: every source is counted", ["outbound texts", "transcript lines", "tool outcomes", "event offers", "offer answers", "surfacing lines", "recommendations offered", "recommendation lines", "documents"].every((k) => (full.bySource[k]?.total ?? 0) > 0), full.bySource);
const missing = dry.rows.filter((r) => r.objectKey !== "L|outbound:h-2" && r.objectKey !== "L|decision:d-2");
const partial = S.reconcileMember(src, missing);
const report = (await import("../../src/scripts/ledgerReconcile.js")).reconcileReport([{ ...partial, group: "test" }]);
// The missing texted row leaves both records of that send unmatched (its outbound row and its transcript line).
check("reconcile: what's unmatched is reported with its contents", partial.unmatched.length === 3 && partial.unmatched.some((u) => u.source === "outbound texts" && u.text === LINK) && partial.unmatched.some((u) => u.source === "transcript lines" && u.text === LINK) && partial.unmatched.some((u) => u.source === "tool outcomes" && /tool\.makeDeck not_done/.test(u.text)) && /unmatched 3/.test(report) && report.includes(LINK), { unmatched: partial.unmatched, report });
check("reconcile: with no ledger rows, every act is unmatched", S.reconcileMember(src, []).unmatched.length === Object.values(full.bySource).reduce((a, b) => a + b.total, 0));
// Another member's rows never match this member's acts.
const theirs = dry.rows.map((r) => ({ ...r, userId: OTHER }));
check("no cross-member match: another member's ledger rows match nothing of this member's", S.reconcileMember(src, theirs).unmatched.length === S.reconcileMember(src, []).unmatched.length);
const dbl = [...dry.rows, { ...finds[0], objectKey: "L|memory:dup", at: at(62_000) }];
check("reconcile: a find held twice is reported as a double", S.reconcileMember(src, dbl).doubles.length === 1);

// ------------------------------------------------------------ scoping, failure, readers

const seen: Call[] = [];
await S.loadSources(async (sql, p) => { seen.push({ sql, p: p as any[] }); return { rows: [{}] }; }, U);
const tables = seen[0].sql.match(/FROM (co_memories|outbound_messages|harness_decisions|document_deliveries|co_facts)\b[^)]*/g) ?? [];
check("no cross-member leak: every source read is scoped to the member", seen.length === 1 && seen[0].p[0] === U && tables.length === 7 && tables.every((t) => /\b(owner_)?user_id = \$1\b/.test(t)), tables);
const pgSeen: Call[] = [];
const pgStore = L.pgLedgerStore(async (sql, p) => { pgSeen.push({ sql, p: p as any[] }); return { rows: [] }; });
await L.writeLedgerRow(pgStore, L.recommendationRow({ userId: U, memoryId: "x5", at: T0, name: "A" }));
check("no cross-member leak: the ledger's own reads and writes are the member's", pgSeen.length === 2 && pgSeen.every((c) => c.p[0] === U) && /owner_user_id = \$1/.test(pgSeen[0].sql));

calls = [];
let insertsTried = 0;
L.setLedgerStoreForTest({ nearby: async () => { throw Object.assign(new Error("db down"), { code: "57P01" }); }, insert: async () => { insertsTried++; throw new Error("db down"); } });
const before = Date.now();
const sent2: any = await quiet(async () => sendblue.messages.send({ number: "+14155550143", content: "On it.", from_number: "+10000000000" } as any));
check("a failing ledger never fails the send", !!sent2?.message_handle);
const r1 = L.ledgerWrite(L.recommendationRow({ userId: U, memoryId: "x6", at: T0, name: "A" }));
check("a ledger write never delays its caller: it returns at once, before any write", r1 === undefined && insertsTried === 0 && Date.now() - before < 1000);
await quiet(async () => { await waitFor(() => calls.filter((c) => /INSERT INTO harness_decisions/.test(c.sql) && c.p[1] === "ledger.write_failed").length >= 2); });
const fails = calls.filter((c) => /INSERT INTO harness_decisions/.test(c.sql) && c.p[1] === "ledger.write_failed");
check("a failed ledger write is logged as a decision row, with the kind and error class, never the label", fails.length === 2 && fails.every((c) => c.p[2] === U && !/On it|"A"/.test(JSON.stringify(c.p))) && fails.some((c) => /57P01/.test(String(c.p[8]))), fails.map((c) => c.p));
L.setLedgerStoreForTest(null);

const read = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");
const readers: [string, RegExp][] = [
  ["services/coFacts.ts", /relation <> 'exited' AND NOT \(meta \? 'ledger'\)/],
  ["services/coFacts.ts", /NOT \(f\.meta \? 'ledger'\) AND abs\(/],
  ["services/coFacts.ts", /source NOT LIKE '%backfill' AND NOT \(meta \? 'ledger'\)/],
  ["agent/loopTools.ts", /url IS NOT NULL AND NOT \(meta \? 'ledger'\)/],
  ["routes/sendblue.ts", /object_label LIKE \$2 \|\| '%'\) AND NOT \(meta \? 'ledger'\)/],
  ["services/turnContext.ts", /relation = 'sent' AND NOT \(meta \? 'ledger'\)/],
  ["services/memberKnowledge.ts", /retired_at IS NULL AND NOT \(meta \? 'ledger'\)/],
  ["services/followThrough.ts", /relation IN \('sent', 'texted'\) AND retired_at IS NULL AND NOT \(meta \? 'ledger'\)/],
  ["services/followThrough.ts", /relation <> 'exited' AND NOT \(meta \? 'ledger'\) ORDER BY/],
];
check("nothing reads the ledger yet: today's readers of Cue's own rows leave them out", readers.every(([f, re]) => re.test(read(f))), readers.filter(([f, re]) => !re.test(read(f))).map(([f]) => f));
const db = read("scripts/ledgerDb.ts");
const bf = read("scripts/ledgerBackfill.ts");
check("the dry run and the reconcile only ever read: BEGIN READ ONLY (checked), dev server only, always rolled back", /BEGIN READ ONLY/.test(db) && /transaction_read_only/.test(db) && /DEV_SYSTEM_ID/.test(db) && /openDevDb\(args, \{ readOnly: dry \}\)/.test(bf) && /openDevDb\(args, \{ readOnly: true \}\)/.test(read("scripts/ledgerReconcile.ts")) && /memoryLedgerStore\(src\.ledger\)/.test(bf));
process.env.DATABASE_URL = "postgres://x:y@db.example.com:5432/railway";
const refused = await (await import("../../src/scripts/ledgerDb.js")).openDevDb(["--dry-run", "--confirm-db", "railway"], { readOnly: true }).then(() => "opened", (e: any) => String(e?.message));
check("the scripts refuse anything but a local tunnel, before connecting", /^refusing: not a local tunnel/.test(refused), refused);

// ------------------------------------------------------------ review of #324

// (1) Same name, different links: two finds. The review's probe, through the call site and the store.
calls = [];
const runs = [
  { tier: 2, kind: "public_event", event_api_id: null, event_date: "2026-11-02", name: "Sunday Run Club", url: "https://lu.ma/run-sf", reason: "fits" },
  { tier: 2, kind: "public_event", event_api_id: null, event_date: "2026-11-02", name: "Sunday Run Club", url: "https://lu.ma/run-oakland", reason: "fits" },
];
{
  const st = L.memoryLedgerStore();
  L.setLedgerStoreForTest(st);
  await quiet(() => recordRecommendationsSent(U, runs as any));
  await L.ledgerSettled();
  L.setLedgerStoreForTest(null);
  const urls = st.rows.map((r) => r.url).sort();
  check("two \"Sunday Run Club\" finds at /run-sf and /run-oakland in one call are two rows, each with its own link (paired by position)", st.rows.length === 2 && urls.join(" ") === "https://lu.ma/run-oakland https://lu.ma/run-sf", st.rows.map((r) => [r.objectKey, r.url]));
  const sql = calls.find((c) => /'recommendation_offered', u\.x FROM UNNEST/.test(c.sql))?.sql ?? "";
  check("…the rows come back in the order inserted (WITH ORDINALITY ... ORDER BY)", /WITH ORDINALITY AS u\(x, n\) ORDER BY u\.n RETURNING id, created_at, content/.test(sql));
}
check("sameThing: a shared link is the same thing; one name at two links is not; a name with a link on one side only is", L.sameThing(["u:a", "n:x"], ["u:a", "n:y"]) && !L.sameThing(["u:a", "n:x"], ["u:b", "n:x"]) && L.sameThing(["n:x"], ["u:b", "n:x"]) && L.sameThing(["n:x"], ["n:x"]) && !L.sameThing(["n:x"], ["n:y"]));
{
  // The reconcile follows the same rule: a recommendation whose own row is missing isn't covered by a same-named find at another page.
  const st = L.memoryLedgerStore();
  await L.writeLedgerRow(st, L.recommendationRow({ userId: U, memoryId: "rA", at: T0, name: "Sunday Run Club", url: null, sentAs: "https://lu.ma/run-sf" }));
  const two: any = {
    userId: U, outboundOther: 0, docs: [], ledger: [], outbound: [],
    replied: [
      { id: "c1", at: at(-20), text: "Run SF caption" },
      { id: "c2", at: at(-10), text: "Run Oakland caption" },
    ],
    tools: [{ id: "dd", decision: "tool.shareFinds", action: "done", at: at(30), proposal: { input: { items: [{ link: "https://lu.ma/run-sf", caption: "Run SF caption" }, { link: "https://lu.ma/run-oakland", caption: "Run Oakland caption" }] } } }],
    memories: [
      { id: "rA", type: "recommendation_offered", at: at(-15), content: JSON.stringify({ name: "Sunday Run Club", event_api_id: null }) },
      { id: "rB", type: "recommendation_offered", at: at(-5), content: JSON.stringify({ name: "Sunday Run Club", event_api_id: null }) },
    ],
  };
  const rec2 = S.reconcileMember(two, st.rows);
  check("reconcile, same rule: the second same-named find (another page, its own row missing) is reported unmatched", rec2.unmatched.some((u) => u.ref === "rB") && !rec2.unmatched.some((u) => u.ref === "rA"), rec2.unmatched);
  const filled = L.memoryLedgerStore();
  await S.runBackfill(filled, two);
  check("…and the backfill writes both, each with its own link", filled.rows.filter((r) => r.meta.kind === "find").map((r) => r.url).sort().join(" ") === "https://lu.ma/run-oakland https://lu.ma/run-sf" && S.reconcileMember(two, filled.rows).unmatched.length === 0, filled.rows.map((r) => [r.objectKey, r.url]));
}
// The probe's other two cases. A partly refused shareFinds is recorded from what went only (its recordAs, fixed in
// fix/sharefinds-records-what-went; the tool through the guard is tested in evals/ledger/shareFindsRecord.ts), so with the one that
// went already recorded as a recommendation, nothing new is written. The same link sent on purpose twice within the window is one
// act, by design.
{
  const st = L.memoryLedgerStore();
  await L.writeLedgerRow(st, L.recommendationRow({ userId: U, memoryId: "j1", at: T0, name: "Jazz Night", url: "https://lu.ma/jazz", sentAs: "https://lu.ma/jazz" }));
  const r = await L.writeLedgerRow(st, L.toolOutcomeRow({ userId: U, tool: "shareFinds", receipt: "done", input: { items: [{ link: "https://lu.ma/jazz", caption: "Jazz Night, Thursday" }] }, decisionId: "9", at: at(2_000) }));
  check("a partly refused shareFinds (recorded as what went) never keeps the refused item as sent", r === "collapsed" && !st.rows.some((x) => x.url === "https://lu.ma/refused") && st.rows.length === 1, { r, rows: st.rows.map((x) => x.url) });
  const s3 = L.memoryLedgerStore();
  await L.writeLedgerRow(s3, L.toolOutcomeRow({ userId: U, tool: "shareLink", receipt: "done", input: { urls: ["https://lu.ma/a"] }, decisionId: "1", at: T0 }));
  const x2 = await L.writeLedgerRow(s3, L.toolOutcomeRow({ userId: U, tool: "shareLink", receipt: "done", input: { urls: ["https://lu.ma/a"] }, decisionId: "2", at: at(90_000) }));
  check("by design: the same link sent twice within the window is one act", x2 === "collapsed" && s3.rows.length === 1);
}

// (2) A team alert is never an act toward a member: the sender flag, never the post-hoc 'ops' rewrite.
calls = [];
const alert: any = await sendblue.messages.send({ number: "+14155550144", content: "Cue alert: something to look at.", from_number: "+10000000000", sender: "ops" } as any);
await waitFor(() => calls.some((c) => /INSERT INTO outbound_messages/.test(c.sql)), 1000);
await new Promise((r) => setTimeout(r, 50));
await L.ledgerSettled();
const alertRow = calls.find((c) => /INSERT INTO outbound_messages/.test(c.sql));
check("team alert: recorded with sender 'ops' by the wrapper, and no ledger row", !!alert?.message_handle && alertRow?.p[3] === "ops" && ledgerInserts().length === 0, { p: alertRow?.p, ledger: ledgerInserts().length });
check("…and its sender never reaches Sendblue (taken off the body)", /const \{ sender: senderIn, \.\.\.body \} = bodyIn;/.test(read("services/sendblue.ts")) && /client\.messages\.send\(\{ \.\.\.body, content \}/.test(read("services/sendblue.ts")));
check("…the backfill agrees: it reads sender 'co' only", /FROM outbound_messages WHERE user_id = \$1 AND sender = 'co'/.test(read("services/ledgerSources.ts")));

// The reverse direction: ledger rows with nothing behind them, with counts and contents.
{
  const orphanRows = [...dry.rows, { userId: U, relation: "texted", objectKey: "L|outbound:gone", label: "A text whose row is gone", url: null, at: at(5_000), source: "outbound:gone", meta: { ledger: 1, kind: "text" } },
    { userId: U, relation: "did", objectKey: "L|decision:old", label: "saved an ask", url: null, at: new Date(Date.now() - 90 * 86_400_000), source: "tool.saveAsk", meta: { ledger: 1, kind: "tool" } }];
  const rv = S.reconcileMember(src, orphanRows);
  check("reverse: a ledger row whose old-store row is gone is reported with its contents", rv.orphans.length === 1 && rv.orphans[0].objectKey === "L|outbound:gone" && rv.orphans[0].label === "A text whose row is gone" && rv.agedOut === 1, rv.orphans);
  const rep = (await import("../../src/scripts/ledgerReconcile.js")).reconcileReport([{ ...rv, group: "test" }]);
  check("reverse: the report gives the count and the contents", /with no old-store row 1/.test(rep) && rep.includes("A text whose row is gone"), rep);
  check("reverse: after the backfill, every ledger row has its old-store row", S.reconcileMember(src, dry.rows).orphans.length === 0);
}

// (5) A text held twice (a transcript row beside its outbound row) is a double; the same words sent twice with their own handles are not.
{
  const t1 = { userId: U, relation: "texted", objectKey: "L|outbound:h-9", label: "See you there.", url: null, at: at(0), source: "outbound:h-9", meta: { ledger: 1, kind: "text" } };
  const t2 = { ...t1, objectKey: "L|memory:m-9", source: "memory:m-9", at: at(50) };
  const t3 = { ...t1, objectKey: "L|outbound:h-10", source: "outbound:h-10", at: at(70) };
  const t4 = { ...t1, objectKey: "L|memory:m-10", source: "memory:m-10", at: at(60) };
  const empty: any = { userId: U, replied: [], outbound: [], outboundOther: 0, tools: [], memories: [], docs: [], ledger: [] };
  const d = S.reconcileMember(empty, [t1, t2, t3]);
  check("duplicate texted rows (one send under its handle and its transcript line) are flagged; two real sends are counted apart", d.doubles.filter((x) => x.key.startsWith("text:")).length === 2 && d.repeatedTexts === 1, d);
  const d2 = S.reconcileMember(empty, [t2, t4]);
  check("two transcript lines with the same words (an old repeated send) are two sends, not a double", d2.doubles.length === 0 && d2.repeatedTexts === 1, d2);
}

// (4) Shutdown waits for the queued writes, bounded.
{
  let release!: () => void;
  L.setLedgerStoreForTest({ nearby: async () => [], insert: () => new Promise<boolean>((r) => { release = () => r(true); }) });
  L.ledgerWrite(L.textedRow({ userId: U, handle: "h-s", content: "x", at: T0 }));
  const t0 = Date.now();
  const timed = await L.settleWithin(200);
  check("shutdown: a stuck write never holds the exit past the bound", timed === "timed_out" && Date.now() - t0 < 1000);
  release();
  check("shutdown: queued writes that land in time are waited for", (await L.settleWithin(1000)) === "settled");
  L.setLedgerStoreForTest(null);
  check("shutdown: the ledger registers its wait as a shutdown hook, 3s at most", /onShutdown\(\(\) => settleWithin\(SHUTDOWN_WAIT_MS\)\)/.test(read("services/ledger.ts")) && L.SHUTDOWN_WAIT_MS === 3000);
}

// (6) A tool row that can't be built is a failed ledger write, logged; an offer's answer is never a silent no-op.
check("toolGuard: an error building the row logs ledger.write_failed instead of being swallowed", /catch \(err\) \{[\s\S]{0,160}return ledgerFailed\(\{ userId: ctx\.userId,/.test(read("agent/toolGuard.ts")));
{
  calls = [];
  const fq = async (sql: string, p?: unknown[]) => { calls.push({ sql, p: p as any[] }); return { rows: [] as any[] }; };
  const r = await L.applyOfferState(fq, U, "pend-x", "interested");
  check("offer answer with no row anywhere: a ledger.offer_state_unmatched decision, scoped to the member", r === "unmatched" && calls.some((c) => /INSERT INTO harness_decisions/.test(c.sql) && c.p[1] === "ledger.offer_state_unmatched" && c.p[2] === U) && calls.filter((c) => /co_facts|co_memories/.test(c.sql)).every((c) => c.p[0] === U));
}

// (3) Forgetting. No member forget path deletes the ledger's sources today (removals are read-time guarded; see the PR); deleting
// the account deletes the user row, and co_facts cascades with it (run against a real Postgres in evals/ledger/ledgerSql.ts).
check("forgetting: account deletion deletes the user row, and co_facts' owner cascades", /DELETE FROM users WHERE id = \$1/.test(read("routes/users.ts")) && /owner_user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/.test(read("db/migrations.ts")));
check("forgetting: the residue audit counts ledger rows with the rest of co_facts", /table: "co_facts", owner: "owner_user_id", cols: \["object_label"\]/.test(read("scripts/forgetResidueAudit.ts")));

console.log(`ledger dual write: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
