// After a call, Cue corrects its own mistakes once, inside the follow-up text (Royce, 2026-10-29: "Once Cue gets the transcript it
// needs to analyze what it said previously and correct itself"). The place: harness/callGrounding.ts auditCall records what Cue said
// on the call that it can't back (invented_fact, promise_unkeepable, a capability claim, an offer whose source check failed) as
// call_correction rows tied to the call (call_key); jobs/postCallFollowUp.ts draftPostCall hands this call's owed ones to its draft as
// a fact plus CALL_CORRECTION_TASK; the registry's onSent marks the ones the sent draft carried delivered; the next text reply
// (recentCallCorrections) keeps "if it comes up" for the rest and "already taken back" for those.
// Covered: an audit with a correction -> the follow-up draft gets the fact and the instruction, marked delivered after send, not
// repeated in the next text; no corrections -> the request is today's; a held/cancelled follow-up -> the correction stays for the next
// text; a kept promise -> no correction; another call's or a fenced line never rides; the offer source check's flags.
// Layer 1: pure functions, the real reads and the registry on a fake store, the draft model faked. Zero tokens, no DB, nothing sent.
//   npx tsx evals/calls/correctionInFollowUp.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const G = await import("../../src/harness/callGrounding.js");
const PC = await import("../../src/jobs/postCallFollowUp.js");
const P = await import("../../src/harness/proactive.js");
const { callKey } = await import("../../src/services/callKey.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const USER = "u-jordan";
const FID = "7d1c0b2e-0000-4000-8000-00000000c412";
const TRANSCRIPT = [
  "assistant: How's the dinner planning going?",
  "user: The guest list is the hard part. I want it small, maybe eight people, founders mostly.",
  "assistant: There's a founders supper at Tartine Manufactory on Thursday at 7, you should go.",
  "user: Oh nice, maybe.",
  "assistant: And I'll book the private room for you before the weekend.",
  "user: Great, thanks. I still don't know who to invite.",
].join("\n");
const OTHER_CALL = "assistant: hi\nuser: a different call";

// ---------------------------------------------------------------- a fake store: co_memories (captured), the call's row, everything else empty
type Mem = { id: string; user_id: string; memory_type: string; content: string; created_at: Date };
const store: { mem: Mem[]; writes: { sql: string; params: any[] }[]; transcript: string | null; ledger: any[] | "fail" } = { mem: [], writes: [], transcript: TRANSCRIPT, ledger: [] };
let seq = 0;
const answer = async (sql: string, params: any[] = []) => {
  const q = String(sql).trim().replace(/\s+/g, " ");
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(q)) return { rows: [] };
  if (/^INSERT INTO co_memories \(user_id, memory_type, content\)/i.test(q)) {
    const row = { id: `m${++seq}`, user_id: params[0], memory_type: params[1], content: params[2], created_at: new Date(Date.now() + seq) };
    store.mem.push(row);
    store.writes.push({ sql: q, params });
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/^UPDATE co_memories SET content = \$3 WHERE id = \$1 AND user_id = \$2 AND memory_type = 'call_correction'/i.test(q)) {
    const r = store.mem.find((m) => m.id === params[0] && m.user_id === params[1] && m.memory_type === "call_correction");
    if (r) r.content = params[2];
    store.writes.push({ sql: q, params });
    return { rows: [], rowCount: r ? 1 : 0 };
  }
  if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) { store.writes.push({ sql: q, params }); return { rows: /RETURNING id/i.test(q) ? [{ id: 901 }] : [], rowCount: 1 }; }
  const corrections = (u: string) => store.mem.filter((m) => m.user_id === u && m.memory_type === "call_correction");
  if (/memory_type = 'call_correction' AND id::text = ANY/i.test(q)) return { rows: corrections(params[0]).filter((m) => (params[1] as string[]).includes(m.id)) };
  if (/memory_type = 'call_correction' AND created_at > NOW\(\) - INTERVAL '7 days' AND content LIKE \$2 ORDER BY created_at$/i.test(q)) {
    const needle = String(params[1]).replace(/^%|%$/g, "");
    return { rows: corrections(params[0]).filter((m) => m.content.includes(needle)) };
  }
  if (/memory_type = 'call_correction' AND created_at > NOW\(\) - INTERVAL '7 days' AND content NOT LIKE '%"retired_at":%' ORDER BY created_at DESC LIMIT 3/i.test(q)) return { rows: [...corrections(params[0])].filter((m) => !m.content.includes('"retired_at":')).reverse().slice(0, 3) };
  if (/FROM harness_decisions WHERE user_id = \$1 AND layer = 8 AND decision IN \('call\.done_on_call'/i.test(q)) {
    if (store.ledger === "fail") throw new Error("ledger read failed");
    return { rows: store.ledger };
  }
  if (/FROM post_call_follow_ups/i.test(q)) return { rows: store.transcript ? [{ transcript: store.transcript, created_at: new Date(Date.now() - 3_600_000) }] : [] };
  return { rows: [] };
};
const realQuery = pool.query, realConnect = (pool as any).connect;
const fake = () => { (pool as any).query = answer; (pool as any).connect = async () => ({ query: answer, release: () => {} }); };
const real = () => { (pool as any).query = realQuery; (pool as any).connect = realConnect; };
const reset = () => { store.mem = []; store.writes = []; store.transcript = TRANSCRIPT; store.ledger = []; };
const row = (o: Record<string, unknown>, id = `r${++seq}`): G.CallCorrection => G.parseCallCorrection({ id, content: JSON.stringify(o) })!;

// The draft model, faked: the prompt it was given, and what it answers.
let prompts: string[] = [];
let reply: (prompt: string) => string = () => "Eight founders is a good size. Who's the one person you'd build the table around?";
P.setProactiveModelForTests(async (p) => { prompts.push(p); return reply(p); });

const INVENTED: G.CallClaim = { quote: "There's a founders supper at Tartine Manufactory on Thursday at 7, you should go.", type: "invented_fact", what: "an event Cue had no source for", specifics: ["Tartine Manufactory", "Thursday at 7"] };
const PROMISE: G.CallClaim = { quote: "And I'll book the private room for you before the weekend.", type: "promise_unkeepable", what: "booking a private room for their dinner" };
const KEEPABLE: G.CallClaim = { quote: "How's the dinner planning going?", type: "ok", what: "" };

// No done list (nothing was done or found on the call), read fine.
const NONE = { items: [] as import("../../src/services/callLedger.js").DoneItem[], found: [] as { name: string; url: string }[] };
const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error, l = console.log;
  console.error = () => {};
  console.log = () => {};
  return fn().finally(() => { console.error = e; console.log = l; });
};

// ================================================================ 1. pure: the row, the carry filter, the fact
{
  const key = callKey(TRANSCRIPT);
  const a = row({ quote: INVENTED.quote, type: "invented_fact", note: "no source", call_key: key });
  const p = row({ quote: PROMISE.quote, type: "promise_unkeepable", note: PROMISE.what, call_key: key });
  const other = row({ quote: "Something else", type: "capability", note: null, call_key: callKey(OTHER_CALL) });
  const old = row({ quote: "An old one", type: "capability", note: null });
  const sent = row({ quote: "Already said", type: "invented_fact", note: null, call_key: key, delivered_at: "2026-10-29T10:00:00Z" });
  check("an audit row parses with its call; an older row has no call; a broken row is nothing", a.callKey === key && a.source === "audit" && old.callKey === null && G.parseCallCorrection({ id: 1, content: "not json" }) === null && G.parseCallCorrection({ id: 1, content: JSON.stringify({ quote: "x", type: "ok" }) }) === null);
  const id = (s: string) => s;
  const carry = G.correctionsToCarry([a, p, other, old, sent], key, [], id, NONE);
  check("only this call's, not yet delivered: another call's, an unkeyed old row and a delivered one never ride", carry.map((c) => c.id).join() === [a.id, p.id].join(), carry);
  check("the member fence failed: none ride (they wait for the next text)", G.correctionsToCarry([a, p], key, [], null, NONE).length === 0);
  check("a line the fence changes (another member named) never rides; the rest do", G.correctionsToCarry([a, p], key, [], (s) => s.replace("Tartine", "[x]"), NONE).map((c) => c.id).join() === p.id);
  check("what was kept couldn't be read: a promise waits, a fact still rides", G.correctionsToCarry([a, p], key, null, id, NONE).map((c) => c.id).join() === a.id);
  // A kept promise is not a mistake any more.
  check("a promise kept since (the room booked, a done task) is not carried", G.correctionsToCarry([a, p], key, ["Book the private room for their founders dinner"], id, NONE).map((c) => c.id).join() === a.id);
  check("something unrelated being done doesn't count as keeping it", G.correctionsToCarry([a, p], key, ["Intro to a seed investor"], id, NONE).length === 2);
  check("only promises can be kept: an invented fact stays wrong whatever was done", !G.keptSince({ type: "invented_fact", quote: INVENTED.quote, note: null }, ["founders supper at Tartine Manufactory"]));
  check("at most two ride: a correction is a line, never a list", G.correctionsToCarry([a, p, row({ quote: "Third", type: "capability", note: null, call_key: key })], key, [], id, NONE).length === G.FOLLOW_UP_CORRECTIONS_MAX);
  const f = G.correctionFact({ quote: INVENTED.quote, type: "invented_fact", note: "no source" });
  check("the fact is Cue's own words from the audit row and why they don't hold, to Cue as 'you'", f === `On the call you said "${INVENTED.quote}", but you had nothing behind it (no source)`, f);
  check("delivered content keeps the row and adds when, once", JSON.parse(G.deliveredContent(JSON.stringify({ quote: "q", type: "capability" }), new Date("2026-10-29T12:00:00Z"))!).delivered_at === "2026-10-29T12:00:00.000Z" && JSON.parse(G.deliveredContent(JSON.stringify({ quote: "q", delivered_at: "x" }), new Date())!).delivered_at === "x" && G.deliveredContent("nope", new Date()) === null);
}

// ================================================================ 1b. F1: never "correct" something Cue did or found on the call
{
  const key = callKey(TRANSCRIPT);
  const id = (s: string) => s;
  const a = row({ quote: INVENTED.quote, type: "invented_fact", note: "no source", call_key: key });
  const jazz = row({ quote: "Rooftop Jazz Night is on Saturday, you'd love it.", type: "invented_fact", note: "no source for Rooftop Jazz Night", call_key: key });
  const sentClaim = row({ quote: "I just texted you the link to the founders breakfast.", type: "invented_fact", note: "no send on record", call_key: key });
  // #320's done labels, as the reflection reads them (strings) and as the audit does (items).
  const SEND_LINE = "the link to Rooftop Jazz Night (https://lu.ma/rooftop-jazz)";
  const DECK_LINE = 'the link to their deck "Northlight pitch" (https://cue.page/d/abc)';
  check("#320's send label parses to its name and link", JSON.stringify(G.doneItemFromLine(SEND_LINE)) === JSON.stringify({ kind: "send", label: SEND_LINE, names: ["Rooftop Jazz Night"], urls: ["https://lu.ma/rooftop-jazz"] }), G.doneItemFromLine(SEND_LINE));
  check("a deck's send label parses to its title and link", G.doneItemFromLine(DECK_LINE).names[0] === "Northlight pitch" && G.doneItemFromLine(DECK_LINE).urls[0] === "https://cue.page/d/abc", G.doneItemFromLine(DECK_LINE));
  check("an owed link sent right after the call parses to its link", G.doneItemFromLine("sent the link https://lu.ma/x right after the call").urls[0] === "https://lu.ma/x");
  check("a correction naming something sent on the call is not one (by its done label)", /done on the call/.test(G.correctionDoneOnCall(jazz, [SEND_LINE]) ?? ""));
  check("by its done item (names and links)", !!G.correctionDoneOnCall(jazz, [{ kind: "send", label: "x", names: ["Rooftop Jazz Night"], urls: ["https://lu.ma/rooftop-jazz"] }]));
  check("a correction naming an event a search found on the call is not one", /found on the call: Tartine Manufactory Founders Supper/.test(G.correctionDoneOnCall(a, [], [{ name: "Tartine Manufactory Founders Supper", url: "https://lu.ma/tartine" }]) ?? ""));
  check("a 'just texted you' claim the done list backs is not one", !!G.correctionDoneOnCall(sentClaim, [{ kind: "send", label: "the link to Founders Breakfast (https://lu.ma/fb)", names: ["Founders Breakfast"], urls: ["https://lu.ma/fb"] }]));
  check("something else done on the call never excuses an unrelated correction", G.correctionDoneOnCall(a, [SEND_LINE], [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz" }]) === null);
  const carry = G.correctionsToCarry([a, jazz], key, [], id, { items: [SEND_LINE], found: [] });
  check("the follow-up carries only what wasn't done or found", carry.map((c) => c.id).join() === a.id, carry);
  check("the done list unread: nothing rides (it can't be checked)", G.correctionsToCarry([a], key, [], id, null).length === 0);
  // The audit: an invented-fact claim or an offer flag naming a find from the call is refused, never saved.
  const found = [{ name: "Tartine Manufactory Founders Supper", url: "https://lu.ma/tartine" }];
  const plan = G.planCallAudit([INVENTED], TRANSCRIPT, { knownBefore: "", records: "", tasks: [], foundOnCall: found, offerFlags: [{ sentence: "The Battery has Tartine Manufactory Founders Supper on Friday at 6pm.", names: ["Tartine Manufactory Founders Supper", "6pm"] }] });
  check("the audit: an invented fact naming a find from the call is refused (found on the call)", !plan.corrections.length && plan.refused.some((r) => /found on the call/.test(r.why)), plan);
  check("the audit: an offer flag naming a find from the call is refused", plan.refused.some((r) => /offer source check: found on the call/.test(r.why)), plan.refused);
}

// ================================================================ 2. the offer source check's flags become corrections only past the record check
{
  const flags = [
    { sentence: INVENTED.quote, names: ["Tartine Manufactory"] },
    { sentence: "The Battery has a mixer Friday at 6pm.", names: ["The Battery", "6pm"] },
    { sentence: "Atrium has a mixer on Friday.", names: ["Atrium"] },
  ];
  const o = G.offerSourceCorrections(flags, [INVENTED], TRANSCRIPT, "", "Cue sent them the Atrium mixer on Oct 20.");
  check("a sentence the audit already listed is the audit's (once)", !o.corrections.some((c) => /Tartine/.test(c.quote)) && !o.refused.some((c) => /Tartine/.test(c.quote)), o);
  check("a flagged name nothing backs becomes an invented-fact correction, marked as the offer check's", o.corrections.length === 1 && /The Battery/.test(o.corrections[0].quote) && o.corrections[0].type === "invented_fact" && o.corrections[0].source === "offer_source", o.corrections);
  check("a flagged name on Cue's records (a real find) is refused, never taken back", o.refused.length === 1 && /Atrium/.test(o.refused[0].quote) && /offer source check/.test(o.refused[0].why), o.refused);
  const plan = G.planCallAudit([INVENTED, PROMISE], TRANSCRIPT, { knownBefore: "", records: "", tasks: [], offerFlags: flags.slice(0, 2) });
  check("planCallAudit folds them in after the audit's own", plan.corrections.length === 3 && plan.corrections[2].source === "offer_source", plan.corrections.map((c) => c.quote));
  check("no flags: the plan is today's", JSON.stringify(G.planCallAudit([INVENTED, PROMISE], TRANSCRIPT, { knownBefore: "", records: "", tasks: [] })) === JSON.stringify(G.planCallAudit([INVENTED, PROMISE], TRANSCRIPT, { knownBefore: "", records: "", tasks: [], offerFlags: [] })));
}

// ================================================================ 3. no corrections: the follow-up request is today's
{
  prompts = [];
  const a = await PC.draftPostCallText("Jordan", TRANSCRIPT, "Planning a founders dinner.");
  const b = await PC.draftPostCallText("Jordan", TRANSCRIPT, "Planning a founders dinner.", [], { theySaid: [], coInferred: [] }, null, null, [], []);
  check("no corrections: the same request as without the argument, word for word", prompts.length === 2 && prompts[0] === prompts[1], prompts.map((p) => p.length));
  check("no corrections: nothing of the correction in it, the rules today's", !/what_you_said_on_the_call_that_was_wrong|carries a correction/.test(prompts[0]) && a?.rules.maxSentences === 3 && a?.rules.maxChars === 360 && a?.rules.forbidden?.length === 1 && a.rules.forbidden[0] === PC.POST_CALL_NO_INTRO && a?.corrections.length === 0 && b?.corrections.length === 0, a);
}

// ================================================================ 4. the whole way: audit -> follow-up draft -> sent -> marked -> next text
const { proactiveRegistry: registry } = await import("../../src/harness/proactiveRegistry.js");
const candidate = { id: "c1", userId: USER, type: "post_call", targetKey: `post_call:${FID}`, topicKey: `post_call:${FID}`, summary: "Short text", payload: { followUpId: FID }, priority: 50, dueAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), attempts: 0, createdAt: new Date() } as any;
fake();
try {
  reset();
  await quiet(() => G.auditCall(USER, TRANSCRIPT, { facts: "They're planning a small founders dinner.", impressions: "" }, { claims: [INVENTED, PROMISE, KEEPABLE], tasks: [], offerFlags: [{ sentence: INVENTED.quote, names: ["Tartine Manufactory"] }] }));
  const saved = store.mem.filter((m) => m.memory_type === "call_correction").map((m) => JSON.parse(m.content));
  check("the audit saves each correction once, tied to the call", saved.length === 2 && saved.every((c) => c.call_key === callKey(TRANSCRIPT)) && saved.map((c) => c.type).join() === "invented_fact,promise_unkeepable", saved);
  // Another call's correction sits beside them.
  store.mem.push({ id: "m-other", user_id: USER, memory_type: "call_correction", content: JSON.stringify({ quote: "I can call your landlord.", type: "capability", note: null, call_key: callKey(OTHER_CALL) }), created_at: new Date() });

  prompts = [];
  const drafted = await quiet(() => registry.post_call.draft(candidate, { userId: USER, firstName: "Jordan", phoneNumber: "+15550000000", city: null, timezone: null }));
  const prompt = prompts[0] ?? "";
  const facts = prompt.slice(prompt.indexOf("CONFIRMED_FACTS"), prompt.indexOf("TASK"));
  check("the follow-up draft gets the correction as a fact, from the audit row (Cue's own words)", /what_you_said_on_the_call_that_was_wrong: On the call you said "There's a founders supper at Tartine Manufactory/.test(facts), facts.slice(-900));
  check("and the instruction, in the task", prompt.includes(PC.CALL_CORRECTION_TASK));
  check("never another call's correction", !/landlord/.test(prompt));
  const meta = "meta" in drafted ? drafted.meta : undefined;
  const ids = (meta?.callCorrectionIds as string[] | undefined) ?? [];
  check("the draft hands the ids it carried to onSent, with a little more room for the line", "messages" in drafted && ids.length >= 1 && (drafted as any).rules.maxSentences === 4 && (drafted as any).rules.maxChars === 460, drafted);
  check("both of this call's ride: the made-up event, and the promise nothing has kept", /Tartine Manufactory/.test(facts) && /book the private room/.test(facts) && ids.length === 2, ids);

  // Sent: those, and only those, are delivered.
  await quiet(() => registry.post_call.onSent!(candidate, { userId: USER, firstName: "Jordan" } as any, ["drafted text"], meta));
  const after = store.mem.filter((m) => m.memory_type === "call_correction").map((m) => ({ id: m.id, ...JSON.parse(m.content) }));
  check("after the send the carried corrections are marked delivered; another call's isn't", after.filter((c) => ids.includes(c.id)).every((c) => !!c.delivered_at) && !after.find((c) => c.id === "m-other")!.delivered_at, after);
  check("the follow-up's own record is marked sent as before", store.writes.some((w) => /UPDATE post_call_follow_ups SET sent_at/.test(w.sql)));

  const next = await G.recentCallCorrections(USER);
  const tartine = next.find((l) => /Tartine/.test(l)) ?? "";
  check("the next text (F9): the follow-up was MEANT to take it back; never stand by it, correct it plainly if it comes up", /text after that call was meant to take it back: never stand by it, and if it comes up, correct it plainly\./.test(tartine) && !/already took it back/.test(tartine), next);
  check("the next text: one the follow-up didn't carry keeps 'if it comes up'", next.filter((l) => /landlord/.test(l)).every((l) => /If it comes up, correct it plainly/.test(l)) && next.some((l) => /landlord/.test(l)), next);

  prompts = [];
  await quiet(() => registry.post_call.draft(candidate, { userId: USER, firstName: "Jordan", phoneNumber: "+15550000000", city: null, timezone: null }));
  check("a later draft for the same call doesn't carry them again", prompts.length === 1 && !/what_you_said_on_the_call_that_was_wrong|carries a correction/.test(prompts[0]), prompts[0]?.length);
} finally {
  real();
}

// ================================================================ 5. held or cancelled: the correction stays for the next text
fake();
try {
  reset();
  // The audit model claiming the offer check's mark: dropped (only code sets it).
  await quiet(() => G.auditCall(USER, TRANSCRIPT, { facts: "", impressions: "" }, { claims: [{ ...INVENTED, source: "offer_source" }], tasks: [] }));
  await quiet(() => registry.post_call.onDropped!(candidate, "expired", "expired"));
  const rows = store.mem.filter((m) => m.memory_type === "call_correction").map((m) => JSON.parse(m.content));
  check("the offer check's mark is code's alone: an audit claim carrying it is saved without it", rows.length === 1 && rows[0].source === undefined, rows);
  check("a follow-up dropped (held past its life, cancelled, opted out): nothing marked delivered", rows.length === 1 && !rows[0].delivered_at, rows);
  check("so the next text still has it, 'if it comes up'", (await G.recentCallCorrections(USER)).some((l) => /Tartine/.test(l) && /If it comes up, correct it plainly/.test(l)));
  // A send without the draft's meta (the mood fallback line, another type's text) marks nothing.
  await quiet(() => registry.post_call.onSent!(candidate, { userId: USER, firstName: "Jordan" } as any, ["a different text"], undefined));
  check("a post-call send that didn't carry it (no meta) marks nothing", !JSON.parse(store.mem.find((m) => m.memory_type === "call_correction")!.content).delivered_at);
  // The draft with the correction came back empty: the follow-up is written once more as today's, and the correction waits.
  prompts = [];
  reply = (p) => (p.includes("carries a correction") ? "SKIP" : "Eight is a good number. Who's the anchor guest?");
  const r = await quiet(() => registry.post_call.draft(candidate, { userId: USER, firstName: "Jordan", phoneNumber: "+15550000000", city: null, timezone: null }));
  // 2026-11-09 (review of #423): it is first tried as the correction alone; only when that is empty too is the follow-up redrafted as today's.
  check("a correction never costs them the follow-up: the correction alone first, then redrafted as today's, nothing carried", "messages" in r && !("meta" in r && r.meta) && prompts.length === 3 && prompts[1].includes(PC.CORRECTION_ALONE) && !/carries a correction/.test(prompts[2]), { r, n: prompts.length });
  // F1 the whole way: a search on the call found the supper, and a link was sent on it. The reflection is told what was done; the
  // Tartine correction never rides; the SKIP retry keeps the done list.
  reset();
  await quiet(() => G.auditCall(USER, TRANSCRIPT, { facts: "", impressions: "" }, { claims: [INVENTED, PROMISE], tasks: [] }));
  const at = new Date(Date.now() - 3_600_000 - 5 * 60_000);
  store.ledger = [
    { decision: "call.done_on_call", action: "searchEvents", proposal: { kind: "read", labels: ["founders dinners, this week"], urls: [], names: [], found: [{ name: "Tartine Manufactory Founders Supper", url: "https://lu.ma/tartine" }] }, created_at: at },
    { decision: "call.done_on_call", action: "shareLink", proposal: { kind: "send", labels: ["the link to Rooftop Jazz Night (https://lu.ma/rooftop-jazz)"], urls: ["https://lu.ma/rooftop-jazz"], names: ["Rooftop Jazz Night"] }, created_at: at },
  ];
  const L = await import("../../src/services/callLedger.js");
  check("the ledger keeps a search's finds with its done row", JSON.stringify(L.foundOnCall(L.ledgerFromRows(store.ledger as any))) === JSON.stringify([{ name: "Tartine Manufactory Founders Supper", url: "https://lu.ma/tartine", when: null, venue: null }]));
  prompts = [];
  reply = () => "Eight is a good number. Who's the anchor guest?";
  const f1 = await quiet(() => registry.post_call.draft(candidate, { userId: USER, firstName: "Jordan", phoneNumber: "+15550000000", city: null, timezone: null }));
  const f1facts = (prompts[0] ?? "").slice((prompts[0] ?? "").indexOf("CONFIRMED_FACTS"), (prompts[0] ?? "").indexOf("TASK"));
  const f1line = f1facts.split("\n").find((l) => l.startsWith("- what_you_said_on_the_call_that_was_wrong:")) ?? "";
  check("F1: a correction about a real find from the call never rides; the rest still do", !/Tartine/.test(f1line) && /book the private room/.test(f1line) && "meta" in f1 && (f1.meta?.callCorrectionIds as string[]).length === 1, f1facts.slice(-600));
  check("the reflection is still told what was done on the call", /done_on_the_call_already_never_mention_resend_or_offer_again: [^\n]*the link to Rooftop Jazz Night/.test(f1facts));
  prompts = [];
  reply = (p) => (p.includes("carries a correction") ? "SKIP" : "Eight is a good number. Who's the anchor guest?");
  await quiet(() => registry.post_call.draft(candidate, { userId: USER, firstName: "Jordan", phoneNumber: "+15550000000", city: null, timezone: null }));
  check("the SKIP retry carries the done list (only the correction drops)", prompts.length === 3 && !/carries a correction/.test(prompts[2]) && /done_on_the_call_already_never_mention_resend_or_offer_again: [^\n]*the link to Rooftop Jazz Night/.test(prompts[2]), prompts.length);
  // The done list can't be read: no correction rides.
  store.ledger = "fail";
  prompts = [];
  reply = () => "Eight is a good number. Who's the anchor guest?";
  const unread = await quiet(() => registry.post_call.draft(candidate, { userId: USER, firstName: "Jordan", phoneNumber: "+15550000000", city: null, timezone: null }));
  check("the done list unread: the follow-up goes as today's, nothing carried", "messages" in unread && !("meta" in unread && unread.meta) && !/carries a correction/.test(prompts[0] ?? ""), unread);
} finally {
  real();
  reply = () => "stub";
}

// ================================================================ 6. the instruction and the wiring (pins)
{
  const t = PC.CALL_CORRECTION_TASK;
  check("the instruction is principle only: no quoted example lines", !/"[^"]{12,}"/.test(t) && !/for example|e\.g\.|like "/i.test(t));
  check("the instruction: once, plainly, briefly, own voice, before or woven in, never machinery, no invented replacement", /once/.test(t) && /plainly and briefly/.test(t) && /own voice/.test(t) && /first or weave it into the follow-up/.test(t) && /never mention checks, records/.test(t) && /CONFIRMED_FACTS doesn't have/.test(t));
  const pc = src("jobs/postCallFollowUp.ts");
  check("the kept read: what they have and what's done, from the layer; no layer, no promise rides", /k\.delivered\.map\(\(d\) => d\.what\), \.\.\.k\.carrying\.filter\(\(c\) => c\.state === "done" \|\| c\.theyHaveIt\)/.test(pc) && /const kept = k \? /.test(pc));
  check("the fact key is a spoken one (it can name the thing, never back a day)", /what_you_said_on_the_call_that_was_wrong: correcting \?/.test(pc) && /said/.test("what_you_said_on_the_call_that_was_wrong"));
  const reg = src("harness/proactiveRegistry.ts");
  check("onSent marks only what the sent draft carried (its meta)", /async onSent\(c, _p, messages, meta\)/.test(reg) && /markCarriedCorrections\(c\.userId, meta\)/.test(reg));
  check("the dispatch hands the sent draft's meta to onSent (never a composed bundle's)", /onSent\?\.\(c, person, result\.delivered, composed \? undefined : draft\.meta\)/.test(src("harness/proactive.ts")));
  check("the webhook hands the call's turns to the source check, run with the finds once the ledger is read; the audit gets the done list, the finds and the flags", /offerSource: \{ turns, given: /.test(src("routes/co.ts")) && /m\.unsourcedInCall\(o\.offerSource!\.turns, \{ \.\.\.o\.offerSource!\.given, foundOnCall: L\.foundLines\(foundOnCall\)\.join\("\\n"\) \}\)/.test(src("routes/co.ts")) && /auditCall\(user_id, cleanTranscript, knownBeforeCall, \{ doneOnCall, foundOnCall, offerFlags, correctionsHeld \}\)/.test(src("routes/co.ts")) && /const correctionsHeld = ledger \? undefined : /.test(src("routes/co.ts")));
  check("the SKIP retry carries doneOnCall (only the correction drops)", /if \(!text && correcting\) return draftPostCallText\(firstName, transcript, contextSummary, promiseResults, claims, confirmationSent, knowledge, doneOnCall\);/.test(pc));
  const ct = src("services/callTools.ts");
  check("a search on the call keeps what it found with its done row (both record sites)", (ct.match(/recordDone\(name, plan\.kind, [^)]*, urls, foundFor\(name, r\)\)/g) ?? []).length === 2 && /recordDoneOnCall\(i\.userId, \{ tool, kind, input, urls, found \}\)/.test(ct));
}

P.setProactiveModelForTests(null);
console.log(`call correction in the follow-up: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
