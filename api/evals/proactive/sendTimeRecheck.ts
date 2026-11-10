// One send-time recheck (harness/sendTimeRecheck.ts, Cue Memory Spec step 8). Anything Cue starts that waited is read against the member as
// they are now: a safety hold, a hard stretch (mood hold), an away claim, and whether what it serves is still wanted.
//   - each path is held under safety, mood and away: sendExempt (the direct event ask), inRoomSendAllowed, the deferred runner, a Cue-started call
//     (since 2026-11-09 the direct event ask under mood is held by the send-time read's wait, not by its class: evals/proactive/hardDayExempt.ts)
//   - a safety message is exempt; what they asked for and replies go
//   - a changed mind stops a queued send
//   - a hold writes no taste signal (no memory, preference, kind restraint or ledger row), and only a decision row
// Layer 1: zero tokens, no database (fakes), no outside calls. Invented members (Rowan).
//   npx tsx evals/proactive/sendTimeRecheck.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
import fs from "node:fs";
import { installFakeLedger } from "../lib/fakeLedger.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const R = await import("../../src/harness/sendTimeRecheck.js");
const MF = await import("../../src/harness/momentFit.js");
const P = await import("../../src/harness/proactive.js");
const CS = await import("../../src/harness/closedSubject.js");
const D = await import("../../src/services/deferredSends.js");
const CG = await import("../../src/harness/callGate.js");
const { default: pool } = await import("../../src/db/db.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");
const EMB = await import("../../src/services/embeddings.js");
EMB.setEmbeddingsClientForTests({ embeddings: { create: async (b: any) => ({ data: (Array.isArray(b.input) ? b.input : [b.input]).map((_: unknown, index: number) => ({ index, embedding: new Array(1536).fill(0) })) }) } } as any);

const ROWAN = "u-rowan";
const NOW = new Date("2026-11-06T18:00:00Z");
const calm: import("../../src/harness/sendTimeRecheck.js").HoldState = { safetyHold: false, mood: { state: "none", hold: false, heldHours: null }, away: null };
const state = (o: Partial<typeof calm>) => ({ ...calm, ...o });
const hard = { state: "held" as const, hold: true, heldHours: 5 };
const away = { until: "2026-11-12", quote: "I'm in Lisbon until the 12th", text: "away until 2026-11-12" };
const STATES = { safety: state({ safetyHold: true }), mood: state({ mood: hard }), away: state({ away }) };

// ---------------------------------------------------------------- 1. the verdict
{
  const ask = { kind: "direct_ask", cls: "unsolicited" as const, targetKey: "direct_ask:ev1:cand:asker", eventBound: true };
  for (const [name, s] of Object.entries(STATES)) {
    const v = R.recheckVerdict(ask, s, null, NOW);
    check(`verdict: Cue's own event ask is held under ${name}`, !v.go && v.held && v.hold === name && v.retryAt!.getTime() > NOW.getTime(), v);
  }
  check("verdict: calm goes", R.recheckVerdict(ask, calm, null, NOW).go);
  check("verdict: away holds until the day after it ends", (() => { const v = R.recheckVerdict(ask, STATES.away, null, NOW); return !v.go && v.held && v.retryAt!.toISOString().startsWith("2026-11-13"); })());
  // Who is held (the doctrine the pick keeps).
  const requested = { kind: "task_update", cls: "requested" as const, targetKey: "task:41:1" };
  check("verdict: what they asked for goes under safety, mood and away", Object.values(STATES).every((s) => R.recheckVerdict({ ...requested, eventBound: true }, s, null, NOW).go));
  check("verdict: a reply always goes", Object.values(STATES).every((s) => R.recheckVerdict({ ...ask, cls: "reply" }, s, null, NOW).go));
  check("verdict: a check-in waits on a hard stretch, not on away", !R.recheckVerdict({ kind: "goal_checkin", cls: "checkin" }, STATES.mood, null, NOW).go && R.recheckVerdict({ kind: "goal_checkin", cls: "checkin", eventBound: true }, STATES.away, null, NOW).go);
  check("verdict: away holds only what brings them into an event", R.recheckVerdict({ kind: "co_event", cls: "unsolicited" }, STATES.away, null, NOW).go);
  // Safety purpose.
  check("safety: a message whose purpose is safety is never held, whatever is on", Object.values({ ...STATES, all: state({ safetyHold: true, mood: hard, away }) }).every((s) => R.recheckVerdict({ ...ask, safety: true }, s, null, NOW).go));
  // The close.
  const close = { kind: "in_room", cls: "unsolicited" as const, eventBound: true, close: true };
  check("close: the goodbye is held by the safety hold only", !R.recheckVerdict(close, STATES.safety, null, NOW).go && R.recheckVerdict(close, STATES.mood, null, NOW).go && R.recheckVerdict(close, STATES.away, null, NOW).go);
  // Unreadable.
  const u = R.recheckVerdict(ask, null, null, NOW);
  check("unreadable: Cue's own send waits a little (fail closed), what they asked for goes", !u.go && u.held && u.hold === "unreadable" && R.recheckVerdict(requested, null, null, NOW).go, u);
  check("event key: a direct event ask reads as event-bound, a relay does not", R.eventBoundSend("direct_ask", "direct_ask:ev1:cand:asker") && !R.eventBoundSend("direct_ask", "relay:5") && !R.eventBoundSend("direct_ask", "reminder:9") && R.eventBoundSend("event_offer", null));
}

// ---------------------------------------------------------------- 1b. arriving ends an away hold for that event
{
  const ask = { kind: "direct_ask", cls: "unsolicited" as const, targetKey: "direct_ask:ev1:rowan:sam", eventBound: true, eventId: "ev1" };
  const here = state({ away, arrived: true });
  check("arrival: an away claim plus arrival at that event lets the event ask through", R.recheckVerdict(ask, here, null, NOW).go);
  check("arrival: away with no arrival still holds", !R.recheckVerdict(ask, state({ away, arrived: false }), null, NOW).go);
  check("arrival: arrival at another event means nothing (no event named, no pass)", !R.recheckVerdict({ ...ask, eventId: null }, here, null, NOW).go);
  check("arrival does not lift a safety or mood hold", !R.recheckVerdict(ask, state({ away, arrived: true, safetyHold: true }), null, NOW).go && !R.recheckVerdict(ask, state({ away, arrived: true, mood: hard }), null, NOW).go);
  check("arrival: the event comes from the key only when the candidate is the member", R.directAskEvent("direct_ask:ev1:rowan:sam", "rowan") === "ev1" && R.directAskEvent("direct_ask:ev1:sam:rowan", "rowan") === null && R.directAskEvent("relay:5", "rowan") === null);
}

// ---------------------------------------------------------------- 2. a changed mind
{
  const rows = (o: Partial<Parameters<typeof CS.closedSetFrom>[0]>) => CS.closedSetFrom({ asks: [], tasks: [], askTasks: [], intent: [], threads: [], loops: [], ...o });
  const task = { kind: "task_update", cls: "requested" as const, targetKey: "task:41:1730000000000", changedMind: true };
  const dropped = rows({ tasks: [{ id: 41, status: "dropped", outcome: "Dropped: they said it's no longer needed" }] });
  const v = R.recheckVerdict(task, calm, dropped, NOW);
  check("changed mind: a queued result for a task they dropped stops, and is a drop not a hold", !v.go && v.hold === "changed_mind" && !v.held && v.reason.startsWith(CS.SUBJECT_CLOSED), v);
  check("changed mind: the drop reads as skipped (never retried) in the deferred runner", D.outcomeOf({ sent: false, reason: !v.go ? v.reason : "" }, true) === "skipped");
  check("changed mind: a goal they closed stops its check-in", !R.recheckVerdict({ kind: "goal_checkin", cls: "checkin", payload: { goalId: "g1" } }, calm, rows({ intent: [{ id: "g1", kind: "goal", status: "resolved", closed_by: "member" }] }), NOW).go);
  check("changed mind: a thread they changed (with their quote) stops its follow-up", !R.recheckVerdict({ kind: "companion", cls: "unsolicited", payload: { threadId: "th1" } }, calm, rows({ threads: [{ id: "th1", status: "changed", closed_quote: "not doing the party anymore" }] }), NOW).go);
  check("changed mind: a loop marked done stops its check", !R.recheckVerdict({ kind: "loop_check", cls: "checkin", payload: { loopId: 9 } }, calm, rows({ loops: [{ id: 9, status: "done", closed_reason: "member" }] }), NOW).go);
  check("changed mind: a task Cue closed itself never stops its own result", R.recheckVerdict(task, calm, rows({ tasks: [{ id: 41, status: "done", outcome: "Sent the shortlist." }] }), NOW).go);
  check("changed mind: another task's result goes", R.recheckVerdict({ ...task, targetKey: "task:77:1" }, calm, dropped, NOW).go);
  // The async one: the closed read is injected; a hold is decided before the closed read (no wasted query); a failed read stands for nothing closed.
  R.setSendHoldReaderForTests(async () => calm);
  const logged: any[] = [];
  const rec = async (d: any) => void logged.push(d);
  const a = await R.sendTimeRecheck(ROWAN, task, { now: NOW, closed: async () => dropped, record: rec as any });
  check("changed mind: sendTimeRecheck drops it and logs the shared proactive.dropped_closed row (ids only)", !a.go && logged.length === 1 && logged[0].decision === CS.DROPPED_CLOSED && logged[0].action === "send_recheck:task_update" && logged[0].proposal.ref === "task:41" && logged[0].proposal.theirWord === true, logged);
  check("changed mind: a narrowed ask (still open) or a thread changed without their words drops nothing", R.recheckVerdict({ kind: "ask_checkin", cls: "checkin", payload: { askCheckinId: "9" } }, calm, rows({}), NOW).go && R.recheckVerdict({ kind: "companion", cls: "unsolicited", payload: { threadId: "th1" } }, calm, rows({ threads: [{ id: "th1", status: "changed", closed_quote: null }] }), NOW).go);
  const b = await R.sendTimeRecheck(ROWAN, task, { now: NOW, closed: async () => { throw new Error("down"); }, record: rec as any });
  check("changed mind: a failed closed read holds nothing back", b.go);
  let readClosed = 0;
  R.setSendHoldReaderForTests(async () => STATES.safety);
  const c2 = await R.sendTimeRecheck(ROWAN, { ...task, cls: "unsolicited" }, { now: NOW, closed: async () => (readClosed++, dropped), record: rec as any });
  check("changed mind: what they closed is dropped, not held, even under a safety hold", readClosed === 1 && !c2.go && !c2.held);
  readClosed = 0;
  await R.sendTimeRecheck(ROWAN, { kind: "in_room", cls: "unsolicited", targetKey: "in_room:match:ev1" }, { now: NOW, closed: async () => (readClosed++, dropped), record: rec as any });
  check("changed mind: a send that names no subject reads no closed set", readClosed === 0);
  const rp = await R.sendTimeRecheck(ROWAN, { ...task, cls: "unsolicited", reply: true }, { now: NOW, closed: async () => dropped, record: rec as any });
  check("changed mind: an answer to their latest message skips the holds, never the close", !rp.go && !rp.held);
  R.setSendHoldReaderForTests(null);
}

// ---------------------------------------------------------------- 3. every path, with the real send code and a fake ledger
function harness() {
  const f = installFakeLedger(pool, sendblue);
  const inner = (pool as any).query;
  const sql: string[] = [];
  const decisions: any[] = [];
  const deferred: { status: string; sql: string; args: any[] }[] = [];
  let deferredRow: any = null;
  const wrap = async (s: string, a: any[] = []) => {
    const q = s.replace(/\s+/g, " ").trim();
    sql.push(q);
    if (/^INSERT INTO harness_decisions/.test(q)) {
      decisions.push({ decision: a[1], action: a[4], outcome: a[3], proposal: a[5] ? JSON.parse(a[5]) : null, reason: a[8] });
      return { rows: [{ id: "1", created_at: new Date() }] };
    }
    if (/FROM deferred_sends d JOIN users u/.test(q)) return { rows: deferredRow ? [deferredRow] : [] };
    if (/^UPDATE deferred_sends SET status = 'sending'/.test(q)) return { rows: [{ id: 1 }] };
    if (/^UPDATE deferred_sends/.test(q)) { deferred.push({ status: /status = 'queued'/.test(q) ? "queued" : String(a[1]), sql: q, args: a }); return { rows: [] }; }
    return inner(s, a);
  };
  (pool as any).query = wrap;
  (pool as any).connect = async () => ({ query: wrap, release: () => {} });
  return { ...f, sql, decisions, deferred, setRow: (r: any) => (deferredRow = r) };
}
const zone = (() => { let off = (13 - new Date().getUTCHours() + 24) % 24; if (off > 14) off -= 24; return off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`; })();
const KEY = "direct_ask:ev1:cand1:rowan";
const ask = () => ({ userId: ROWAN, phoneNumber: "+15035550177", type: "direct_ask" as const, targetKey: KEY, messages: ["Sam is also going to the supper club tonight and would like to meet you. Open to it?"], timezone: zone });
// The send-time read sendExempt asks on a hard day (harness/momentFit.ts exemptMomentRead, 2026-11-09): stubbed state and context; the
// verdict is the stub's. Under mood the direct event ask is no longer held by its class: the read's wait holds it.
const READ_CTX = { firstName: "Rowan", zone: null, recent: "[Mon 9:10am] User said: long week, honestly", call: { ready: true as const, line: null }, queued: [] };
const exemptReadFor = (name: string, verdict: "send" | "wait" | "drop" = "wait") => {
  MF.setExemptReadDepsForTests({ state: async () => ({ needsCare: name === "mood", safetyHold: name === "safety" }), context: async () => READ_CTX });
  MF.setMomentModelForTests(async () => JSON.stringify({ verdict, why: "not the moment for an intro" }));
};
const exemptReadOff = () => { MF.setExemptReadDepsForTests(null); MF.setMomentModelForTests(null); };
const TASTE = /member_preferences|kind_restraint|INSERT INTO co_memories|INSERT INTO co_facts|INSERT INTO proactive_sends|member_claims|co_profiles SET|UPDATE co_profiles/;

for (const [name, s] of Object.entries(STATES)) {
  R.setSendHoldReaderForTests(async () => s);
  exemptReadFor(name);
  const h = harness();
  try {
    // sendExempt: the direct event ask (no door).
    const r = await P.sendExempt(ask());
    check(`sendExempt: the direct event ask is held under ${name}, with when to look again`, !r.sent && /^held: /.test(String(r.reason)) && !!r.retryAt && h.ledger.outbox.length === 0 && h.ledger.sends.length === 0, r);
    // Under mood it's the send-time read's wait (moment_wait), never the class hold (held_mood).
    check(`sendExempt: held under ${name} is logged with its reason, ids only`, h.decisions.some((d) => d.decision === R.SEND_RECHECK && d.action === (name === "mood" ? "moment_wait" : `held_${name}`) && d.proposal?.kind === "direct_ask" && !/supper|Sam/.test(JSON.stringify(d))), h.decisions);
    check(`taste: a hold under ${name} writes no memory, preference, claim, kind restraint or ledger row`, !h.sql.some((q) => TASTE.test(q)), h.sql.filter((q) => TASTE.test(q)));
    // sendExemptWhenAllowed queues it (held, never dropped).
    const wa = await P.sendExemptWhenAllowed({ ...ask(), timezone: zone });
    check(`sendExemptWhenAllowed: held under ${name}, so it asks for the queue and keeps its reason`, !wa.sent && /held:/.test(String(wa.reason ?? "")) || wa.queued, wa);
    // The same send answering their latest message, and a requested one, go.
    const req = await P.sendExempt({ ...ask(), type: "task_update", targetKey: "task:77:1730000000000", messages: ["Here is the draft"] });
    check(`sendExempt: what they asked for goes under ${name}`, req.sent && h.ledger.outbox.length === 1, req);
    // And a send whose purpose is safety.
    const safe = await P.sendExempt({ ...ask(), targetKey: "direct_ask:ev9:cand1:rowan", safety: true, messages: ["Just checking you got home okay."] });
    check(`sendExempt: a safety message goes under ${name}`, safe.sent && h.ledger.outbox.length === 2, safe);
    // In-room.
    const claim = { targetKey: "in_room:match:ev1", message: "Sam is two tables over." };
    const before = h.sql.length;
    const inRoom = await P.inRoomSendAllowed(ROWAN, "ev1", { claim });
    const claimed = h.sql.slice(before).some((q) => /^INSERT INTO proactive_sends/.test(q));
    check(`inRoomSendAllowed: an in-room nudge is held under ${name} and claims nothing`, inRoom === false && !claimed, { inRoom, claimed });
    const close = await P.inRoomSendAllowed(ROWAN, "ev1", { close: true });
    check(`inRoomSendAllowed: the close ${name === "safety" ? "is held by the safety hold" : "still goes (a goodbye)"} under ${name}`, close === (name !== "safety"), close);
  } finally { h.restore(); R.setSendHoldReaderForTests(null); exemptReadOff(); }
}
{
  // Calm: nothing changes (no hard-day read, so no send-time read either).
  R.setSendHoldReaderForTests(async () => calm);
  exemptReadFor("calm");
  const h = harness();
  try {
    const r = await P.sendExempt(ask());
    check("calm: the direct event ask goes as before", r.sent && h.ledger.outbox.length === 1, r);
    check("calm: an in-room nudge claims and goes as before", (await P.inRoomSendAllowed(ROWAN, "ev1", { claim: { targetKey: "in_room:match:ev1", message: "x" } })) === true && h.sql.some((q) => /^INSERT INTO proactive_sends/.test(q)));
  } finally { h.restore(); R.setSendHoldReaderForTests(null); exemptReadOff(); }
}

// Arrival at that event, through the real send code: the reader is asked about this event only.
{
  const asked: (string | null | undefined)[] = [];
  R.setSendHoldReaderForTests(async (_u, _n, ev) => (asked.push(ev), state({ away, arrived: ev === "ev1" })));
  const h = harness();
  try {
    const ok = await P.sendExempt({ ...ask(), targetKey: "direct_ask:ev1:" + ROWAN + ":sam" });
    check("arrival: away plus arrival at ev1, the direct ask goes", ok.sent && h.ledger.outbox.length === 1 && asked.includes("ev1"), { ok, asked });
    const other = await P.sendExempt({ ...ask(), targetKey: "direct_ask:ev2:" + ROWAN + ":sam" });
    check("arrival: arrived at ev1 only, a direct ask for ev2 still holds", !other.sent && /^held: /.test(String(other.reason)) && asked.includes("ev2"), other);
    check("arrival: away plus arrival, the in-room nudge for ev1 goes", (await P.inRoomSendAllowed(ROWAN, "ev1", { claim: { targetKey: "in_room:match:ev1", message: "x" } })) === true);
    check("arrival: the in-room nudge for ev2 holds", (await P.inRoomSendAllowed(ROWAN, "ev2")) === false);
  } finally { h.restore(); R.setSendHoldReaderForTests(null); }
  // The pre-check ahead of a real attempt (eventScoring) writes no decision row; the real attempt does.
  R.setSendHoldReaderForTests(async () => STATES.mood);
  const q = harness();
  try {
    await P.inRoomSendAllowed(ROWAN, "ev1", { peek: true });
    const peeked = q.decisions.filter((d) => d.decision === R.SEND_RECHECK).length;
    await P.inRoomSendAllowed(ROWAN, "ev1", { claim: { targetKey: "in_room:match:ev1", message: "x" } });
    check("noise: a peek writes no decision row, the real attempt writes one", peeked === 0 && q.decisions.filter((d) => d.decision === R.SEND_RECHECK).length === 1, q.decisions);
    check("noise: the scoring pre-check peeks", /inRoomSendAllowed\(person\.user_id, eventId, \{ peek: true \}\)/.test(src("services/eventScoring.ts")));
  } finally { q.restore(); R.setSendHoldReaderForTests(null); }
}

// ---------------------------------------------------------------- 4. deferred sends: the row waits, rechecked at the minute it comes due
// The deferred runner reads the real clock (runDueDeferredSends(new Date())), so the row is aged against it, not the pinned NOW:
// pinned, it aged past the 72h window three days after NOW and the hold checks failed for a date reason (seen 2026-11-09).
const row = (over: Record<string, unknown> = {}) => ({ id: 1, user_id: ROWAN, phone_number: "+15035550177", type: "direct_ask", target_key: KEY, messages: ["Sam would like to meet you. Open to it?"], timezone: zone, after_kind: null, after_payload: null, due_at: new Date(Date.now() - 60_000), status: "queued", attempts: 0, created_at: new Date(Date.now() - 6 * 3_600_000), error: null, archived: false, ...over });
for (const [name, s] of Object.entries(STATES)) {
  R.setSendHoldReaderForTests(async () => s);
  exemptReadFor(name);
  const h = harness();
  h.setRow(row());
  try {
    const out = await D.runDueDeferredSends(new Date(), { send: P.sendExempt, handlers: D.afterHandlers });
    check(`deferred: a row queued before ${name} is requeued, not sent and not dropped`, out.requeued === 1 && out.sent === 0 && out.skipped === 0 && out.failed === 0 && h.ledger.outbox.length === 0, out);
    check(`deferred: the requeue under ${name} moves it later`, h.deferred.some((d) => d.status === "queued" && d.args[1] instanceof Date && d.args[1].getTime() > Date.now()), h.deferred);
  } finally { h.restore(); R.setSendHoldReaderForTests(null); exemptReadOff(); }
}
{
  R.setSendHoldReaderForTests(async () => calm);
  const h = harness();
  h.setRow(row());
  try {
    const out = await D.runDueDeferredSends(new Date(), { send: P.sendExempt, handlers: D.afterHandlers });
    check("deferred: calm, the row goes as before", out.sent === 1 && h.ledger.outbox.length === 1, out);
  } finally { h.restore(); R.setSendHoldReaderForTests(null); }
  // A changed mind on a queued task result: skipped with its reason.
  const g = harness();
  const innerQ = (pool as any).query;
  (pool as any).query = async (s: string, a: any[] = []) => (/FROM co_tasks WHERE user_id = \$1 AND status IN \('done','dropped'\)/.test(s.replace(/\s+/g, " ")) ? { rows: [{ id: 41, status: "dropped", outcome: "Dropped: they said it's no longer needed" }] } : innerQ(s, a));
  g.setRow(row({ type: "task_update", target_key: "task:41:1730000000000", messages: ["Two more venues"] }));
  R.setSendHoldReaderForTests(async () => calm);
  try {
    const out = await D.runDueDeferredSends(new Date(), { send: P.sendExempt, handlers: D.afterHandlers });
    check("deferred: a queued result for a task they dropped since is skipped, never sent", out.skipped === 1 && out.sent === 0 && g.ledger.outbox.length === 0, out);
  } finally { g.restore(); R.setSendHoldReaderForTests(null); }
}

// A hold is not a send attempt; a held Cue-started row has a window.
{
  const over = async (e: string) => e === "ev-over";
  const old = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const cue = { type: "direct_ask" as const, target_key: "direct_ask:ev1:cand1:rowan", after_kind: null, after_payload: null, created_at: old(10) };
  check("window: a fresh held Cue-started row has none", (await D.heldPastWindow(cue, NOW, over)) === null);
  check("window: past 72h since it was queued, it is past", /^past its window: held more than 72h/.test((await D.heldPastWindow({ ...cue, created_at: old(73) }, NOW, over)) ?? ""));
  check("window: 71h is still inside it", (await D.heldPastWindow({ ...cue, created_at: old(71) }, NOW, over)) === null);
  check("window: its event being over ends it, from the key or the after step", /event is over/.test((await D.heldPastWindow({ ...cue, target_key: "direct_ask:ev-over:cand1:rowan" }, NOW, over)) ?? "") && /event is over/.test((await D.heldPastWindow({ ...cue, target_key: "x", after_kind: "event_direct_ask", after_payload: { eventId: "ev-over" } }, NOW, over)) ?? ""));
  check("window: a relay, a reminder or a call reminder is not Cue-started, so it has none", (await Promise.all(["relay:5", "reminder:9", "call_reminder:3"].map((k) => D.heldPastWindow({ ...cue, target_key: k, created_at: old(200) }, NOW, over)))).every((x) => x === null));
  check("window: the drop is skipped, never retried", D.outcomeOf({ sent: false, reason: `${D.PAST_WINDOW}: its event is over` }, true) === "skipped");
  // Through the runner: a safety hold on a row 80h old drops it with its reason (and its after step hears it); a fresh one is requeued without spending an attempt.
  R.setSendHoldReaderForTests(async () => STATES.safety);
  const h = harness();
  const heard: any[] = [];
  const handlers = { ...D.afterHandlers, event_direct_ask: async (_p: any, o: string, r?: string) => void heard.push([o, r]) } as any;
  h.setRow(row({ created_at: new Date(Date.now() - 80 * 3_600_000) }));
  try {
    const out = await D.runDueDeferredSends(new Date(), { send: P.sendExempt, handlers });
    check("window: a held Cue-started row past its window is skipped, not sent and not requeued", out.skipped === 1 && out.requeued === 0 && h.ledger.outbox.length === 0 && h.decisions.some((d) => d.decision === "proactive.deferredSend" && d.action === "skipped" && /past its window/.test(String(d.reason))), { out, d: h.decisions.map((d) => d.action) });
  } finally { h.restore(); }
  const g = harness();
  g.setRow(row({ created_at: new Date(Date.now() - 2 * 3_600_000) }));
  try {
    const out = await D.runDueDeferredSends(new Date(), { send: P.sendExempt, handlers: D.afterHandlers });
    check("attempts: a held row is requeued and gives its attempt back", out.requeued === 1 && g.deferred.some((d) => /attempts = attempts - 1/.test(d.sql)), g.deferred.map((d) => d.sql));
  } finally { g.restore(); R.setSendHoldReaderForTests(null); }
  void heard;
  check("attempts: only a hold gives it back (a real failure still counts)", /attempts = attempts - \$\{unspend \? 1 : 0\}/.test(src("services/deferredSends.ts")) && !/requeue\(new Date\(now\.getTime\(\) \+ DEFERRED_LIMITS\.retryAfterMs\), result\.reason \?\? "send failed"\s*,\s*true\)/.test(src("services/deferredSends.ts")));
}

// ---------------------------------------------------------------- 5. a call Cue starts itself, and the wiring
{
  const t = src("services/callTrigger.ts");
  const at = t.indexOf("sendTimeRecheck");
  check("call: a Cue-started call (check-in cadence, intake) takes the recheck after the gate and before the dial", at > t.indexOf("decideCall(callState") && at < t.indexOf("claimDial(userId)") && /CUE_STARTED_CALLS\.has\(gateResult\.authorization\)/.test(t));
  check("call: one they asked for or booked is not in the set the recheck reads", (await import("../../src/harness/callGate.js")).CUE_STARTED_CALLS.size === 2 && !["user_initiated", "scheduled_call", "router_decision"].some((k) => (CG as any).CUE_STARTED_CALLS.has(k)));
  const px = src("harness/proactive.ts");
  check("wiring: sendExempt asks inside its lock and reads the closed subjects through the recheck, before the claim", px.indexOf("sendTimeRecheck(\n      opts.userId") > px.indexOf("export async function sendExempt(") && /closed: \(uid\) => closedInLock\(client/.test(px) && !/heldSendClosed\(client, \{ userId: opts\.userId/.test(px) && px.indexOf("sendTimeRecheck(\n      opts.userId") < px.indexOf("INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt, kind, notify_class)", px.indexOf("export async function sendExempt(")));
  check("wiring: inRoomSendAllowed asks before it claims", px.indexOf('sendTimeRecheck(userId, { kind: "in_room"') > px.indexOf("export async function inRoomSendAllowed") && px.indexOf('sendTimeRecheck(userId, { kind: "in_room"') < px.indexOf("pg_advisory_xact_lock(hashtext($1))`, [`proactive:${userId}`]);\n    // The member's own rules, the close"));
  const mod = src("harness/sendTimeRecheck.ts");
  check("no model call and no taste write in the recheck", !/generateText|anthropic\(|writeMemory|memberPreferences|kindRestraint|INSERT INTO|UPDATE /.test(mod.replace(/\/\/.*$/gm, "")));
  check("no regex over their words in the recheck (two key patterns only)", (mod.replace(/\/\/.*$/gm, "").match(/\.(test|match)\(/g) ?? []).length === 2);
}

console.log(`sendTimeRecheck: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
process.exit(0);
