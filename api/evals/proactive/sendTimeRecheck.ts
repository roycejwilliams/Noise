// One send-time recheck (harness/sendTimeRecheck.ts, Cue Memory Spec step 8). Anything Cue starts that waited is read against the member as
// they are now: a safety hold, a hard stretch (mood hold), an away claim, and whether what it serves is still wanted.
//   - each path is held under safety, mood and away: sendExempt (the direct event ask), inRoomSendAllowed, the deferred runner, a Cue-started call
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
  check("changed mind: sendTimeRecheck drops it and logs it (ids only)", !a.go && logged.length === 1 && logged[0].decision === R.SEND_RECHECK && logged[0].action === "dropped_changed_mind" && logged[0].proposal.held === false, logged);
  const b = await R.sendTimeRecheck(ROWAN, task, { now: NOW, closed: async () => { throw new Error("down"); }, record: rec as any });
  check("changed mind: a failed closed read holds nothing back", b.go);
  let readClosed = 0;
  R.setSendHoldReaderForTests(async () => STATES.safety);
  await R.sendTimeRecheck(ROWAN, { ...task, cls: "unsolicited" }, { now: NOW, closed: async () => (readClosed++, dropped), record: rec as any });
  check("changed mind: a held send never reads the closed set", readClosed === 0);
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
const TASTE = /member_preferences|kind_restraint|INSERT INTO co_memories|INSERT INTO co_facts|INSERT INTO proactive_sends|member_claims|co_profiles SET|UPDATE co_profiles/;

for (const [name, s] of Object.entries(STATES)) {
  R.setSendHoldReaderForTests(async () => s);
  const h = harness();
  try {
    // sendExempt: the direct event ask (no door).
    const r = await P.sendExempt(ask());
    check(`sendExempt: the direct event ask is held under ${name}, with when to look again`, !r.sent && /^held: /.test(String(r.reason)) && !!r.retryAt && h.ledger.outbox.length === 0 && h.ledger.sends.length === 0, r);
    check(`sendExempt: held under ${name} is logged with its reason, ids only`, h.decisions.some((d) => d.decision === R.SEND_RECHECK && d.action === `held_${name}` && d.proposal?.kind === "direct_ask" && !/supper|Sam/.test(JSON.stringify(d))), h.decisions);
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
  } finally { h.restore(); R.setSendHoldReaderForTests(null); }
}
{
  // Calm: nothing changes.
  R.setSendHoldReaderForTests(async () => calm);
  const h = harness();
  try {
    const r = await P.sendExempt(ask());
    check("calm: the direct event ask goes as before", r.sent && h.ledger.outbox.length === 1, r);
    check("calm: an in-room nudge claims and goes as before", (await P.inRoomSendAllowed(ROWAN, "ev1", { claim: { targetKey: "in_room:match:ev1", message: "x" } })) === true && h.sql.some((q) => /^INSERT INTO proactive_sends/.test(q)));
  } finally { h.restore(); R.setSendHoldReaderForTests(null); }
}

// ---------------------------------------------------------------- 4. deferred sends: the row waits, rechecked at the minute it comes due
const row = (over: Record<string, unknown> = {}) => ({ id: 1, user_id: ROWAN, phone_number: "+15035550177", type: "direct_ask", target_key: KEY, messages: ["Sam would like to meet you. Open to it?"], timezone: zone, after_kind: null, after_payload: null, due_at: new Date(NOW.getTime() - 60_000), status: "queued", attempts: 0, created_at: new Date(NOW.getTime() - 6 * 3_600_000), error: null, archived: false, ...over });
for (const [name, s] of Object.entries(STATES)) {
  R.setSendHoldReaderForTests(async () => s);
  const h = harness();
  h.setRow(row());
  try {
    const out = await D.runDueDeferredSends(new Date(), { send: P.sendExempt, handlers: D.afterHandlers });
    check(`deferred: a row queued before ${name} is requeued, not sent and not dropped`, out.requeued === 1 && out.sent === 0 && out.skipped === 0 && out.failed === 0 && h.ledger.outbox.length === 0, out);
    check(`deferred: the requeue under ${name} moves it later`, h.deferred.some((d) => d.status === "queued" && d.args[1] instanceof Date && d.args[1].getTime() > Date.now()), h.deferred);
  } finally { h.restore(); R.setSendHoldReaderForTests(null); }
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

// ---------------------------------------------------------------- 5. a call Cue starts itself, and the wiring
{
  const t = src("services/callTrigger.ts");
  const at = t.indexOf("sendTimeRecheck");
  check("call: a Cue-started call (check-in cadence, intake) takes the recheck after the gate and before the dial", at > t.indexOf("decideCall(callState") && at < t.indexOf("claimDial(userId)") && /CUE_STARTED_CALLS\.has\(gateResult\.authorization\)/.test(t));
  check("call: one they asked for or booked is not in the set the recheck reads", (await import("../../src/harness/callGate.js")).CUE_STARTED_CALLS.size === 2 && !["user_initiated", "scheduled_call", "router_decision"].some((k) => (CG as any).CUE_STARTED_CALLS.has(k)));
  const px = src("harness/proactive.ts");
  check("wiring: sendExempt asks inside its lock, after the closed read and before the claim", px.indexOf("sendTimeRecheck(opts.userId") > px.indexOf('stage: "exempt_lock"') && px.indexOf("sendTimeRecheck(opts.userId") > px.indexOf("export async function sendExempt(") && px.indexOf("sendTimeRecheck(opts.userId") < px.indexOf("INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt, kind, notify_class)", px.indexOf("export async function sendExempt(")));
  check("wiring: inRoomSendAllowed asks before it claims", px.indexOf('sendTimeRecheck(userId, { kind: "in_room"') > px.indexOf("export async function inRoomSendAllowed") && px.indexOf('sendTimeRecheck(userId, { kind: "in_room"') < px.indexOf("pg_advisory_xact_lock(hashtext($1))`, [`proactive:${userId}`]);\n    // The member's own rules, the close"));
  const mod = src("harness/sendTimeRecheck.ts");
  check("no model call and no taste write in the recheck", !/generateText|anthropic\(|writeMemory|memberPreferences|kindRestraint|INSERT INTO|UPDATE /.test(mod.replace(/\/\/.*$/gm, "")));
  check("no regex over their words in the recheck (one key pattern only)", (mod.replace(/\/\/.*$/gm, "").match(/\.(test|match)\(/g) ?? []).length === 1);
}

console.log(`sendTimeRecheck: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
process.exit(0);
