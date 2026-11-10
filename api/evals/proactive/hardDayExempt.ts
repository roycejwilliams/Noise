// The last blanket hard-day hold, gone (Royce, 2026-11-08/09: "a hard day informs whether a particular message helps now; it never
// blanket-silences, and at the cap there's a fresh judgment, never an automatic release"). Cue's own event announcement (co_event) and an
// intro ask (direct_ask) that never reach the dispatch (an in-room ask has no door; a held one comes back through the deferred runner)
// used to be held as a whole class by the send-time recheck's mood hold and let go at its 48h cap with no read. Now sendExempt asks the
// same send-time read the dispatch asks for a find (harness/momentFit.ts exemptMomentRead), told of the hard stretch, before its lock;
// the recheck's mood hold skips them (judged). Safety holds untouched; requested sends, replies, safety sends and relays never read.
// Model-free (the read is stubbed), no database (a fake ledger), no outside calls:
//   npx tsx evals/proactive/hardDayExempt.ts
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
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const MF = await import("../../src/harness/momentFit.js");
const R = await import("../../src/harness/sendTimeRecheck.js");
const P = await import("../../src/harness/proactive.js");
const D = await import("../../src/services/deferredSends.js");
const { default: pool } = await import("../../src/db/db.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");
const EMB = await import("../../src/services/embeddings.js");
EMB.setEmbeddingsClientForTests({ embeddings: { create: async (b: any) => ({ data: (Array.isArray(b.input) ? b.input : [b.input]).map((_: unknown, index: number) => ({ index, embedding: new Array(1536).fill(0) })) }) } } as any);

const ROWAN = "u-rowan";
const NOW = new Date("2026-11-09T22:00:00Z");
const KEY = "direct_ask:ev1:u-rowan:sam";
const ASK = "Sam is at the supper club tonight too and would like to meet you. Open to it?";
const calmWords = "[Mon 9:10am] User said: Weighing whether to bring on a cofounder. Not urgent, just thinking it through.\n[Mon 9:30am] User said: I'd like to meet a few people before deciding.";
const distressWords = "[Mon 2:10am] User said: I can't sleep. Everything is piling up and I feel like I'm drowning.\n[Mon 2:20am] User said: I just need it to stop for a bit.";
const ctx = (recent: string) => async () => ({ firstName: "Rowan", zone: "America/Los_Angeles", recent, call: { ready: true as const, line: null }, queued: [] as string[] });
const onHardDay = { needsCare: true, safetyHold: false };

// The model stub: records each prompt, answers with the given verdict.
const prompts: string[] = [];
const model = (verdict: "send" | "wait" | "drop") => MF.setMomentModelForTests(async (p) => (prompts.push(p), JSON.stringify({ verdict, why: "stub" })));
const reset = () => { prompts.length = 0; MF.setMomentModelForTests(null); MF.setExemptReadDepsForTests(null); R.setSendHoldReaderForTests(null); };

// ---------------------------------------------------------------- 1. which sends the read covers
{
  const r = (o: Partial<Parameters<typeof MF.exemptHardDayRead>[0]>) => MF.exemptHardDayRead({ cls: "unsolicited", type: "direct_ask", targetKey: KEY, ...o });
  check("route: Cue's intro ask (direct_ask, its own) is read on a hard day", r({}));
  check("route: Cue's own event announcement (co_event) is read on a hard day", r({ type: "co_event", targetKey: "co_event:ev1" }));
  check("route: a network intro ask is read too", r({ targetKey: "network_direct_ask:a:b" }));
  check("route: what they asked for (requested) is never read", !r({ cls: "requested" }) && !r({ type: "co_event", cls: "requested", targetKey: "noshow_ask:ev1" }));
  check("route: a reply, a safety send and another member's relayed words are never read", !r({ reply: true }) && !r({ safety: true }) && !r({ targetKey: "relay:9" }));
  check("route: a task update Cue started is not one of these (unchanged)", !r({ type: "task_update", targetKey: "task:4:1" }));
  check("route: both kinds are in HARD_DAY_READ_TYPES (the entries now apply here too)", MF.HARD_DAY_READ_TYPES.has("co_event") && MF.HARD_DAY_READ_TYPES.has("direct_ask"));
}

// ---------------------------------------------------------------- 2. THE KEY CHECK: the same intro ask, a calm and a distressed member
{
  const run = async (recent: string, verdict: "send" | "wait" | "drop") => {
    prompts.length = 0;
    model(verdict);
    const out = await MF.exemptMomentRead({ userId: ROWAN, type: "direct_ask", targetKey: KEY, messages: [ASK], cls: "unsolicited", now: NOW }, { state: async () => onHardDay, context: ctx(recent), record: async () => ({}) as any });
    const p = prompts[0] ?? "";
    MF.setMomentModelForTests(null);
    return { out, p, calls: prompts.length };
  };
  const calmSend = await run(calmWords, "send");
  const distressWait = await run(distressWords, "wait");
  check("key: both reach the read, once each", calmSend.calls === 1 && distressWait.calls === 1);
  check("key: both carry the hard-day line and the same intro ask", [calmSend, distressWait].every((r) => r.p.includes(MF.HARD_DAY_LINE) && r.p.includes("supper club tonight")));
  check("key: each carries their actual state, in their own words", calmSend.p.includes("Not urgent, just thinking it through.") && !calmSend.p.includes("drowning") && distressWait.p.includes("I feel like I'm drowning.") && !distressWait.p.includes("Not urgent"));
  check("key: the read's send goes (calm)", calmSend.out.read && calmSend.out.action.act === "send");
  check("key: the read's wait waits (distressed)", distressWait.out.read && distressWait.out.action.act === "wait");
  const calmWait = await run(calmWords, "wait");
  const distressSend = await run(distressWords, "send");
  check("key: code doesn't auto-send the calm one (the read's wait holds it)", calmWait.out.read && calmWait.out.action.act === "wait");
  check("key: code doesn't auto-hold the distressed one (the read's send sends it)", distressSend.out.read && distressSend.out.action.act === "send");
  // At the cap: the hold's 48h is up (moodHold released_cap) but the hard-day read (needsCare) is still on: still read, fresh.
  const capped = await run(distressWords, "wait");
  check("cap: past the 48h cap, needsCare still on, it is read again (a fresh judgment), and its wait holds it: never an automatic release", capped.calls === 1 && capped.out.read && capped.out.action.act === "wait");
  // Nothing on: no read, no call (as in the dispatch).
  prompts.length = 0;
  model("send");
  const calmDay = await MF.exemptMomentRead({ userId: ROWAN, type: "direct_ask", targetKey: KEY, messages: [ASK], cls: "unsolicited", now: NOW }, { state: async () => ({ needsCare: false, safetyHold: false }), context: ctx(calmWords) });
  check("ordinary day: no hard-day read, no read and no model call", !calmDay.read && prompts.length === 0);
  const safety = await MF.exemptMomentRead({ userId: ROWAN, type: "direct_ask", targetKey: KEY, messages: [ASK], cls: "unsolicited", now: NOW }, { state: async () => ({ needsCare: true, safetyHold: true }), context: ctx(calmWords) });
  check("safety hold: not read (the recheck's safety hold holds it, untouched)", !safety.read && prompts.length === 0);
  const unread = await MF.exemptMomentRead({ userId: ROWAN, type: "direct_ask", targetKey: KEY, messages: [ASK], cls: "unsolicited", now: NOW }, { state: async () => { throw new Error("down"); }, context: ctx(calmWords) });
  check("unreadable state: nothing judged, marked unreadable (the recheck then keeps its holds: fail closed)", !unread.read && unread.unreadable === true && prompts.length === 0);
  const noCtx = await MF.exemptMomentRead({ userId: ROWAN, type: "direct_ask", targetKey: KEY, messages: [ASK], cls: "unsolicited", now: NOW }, { state: async () => onHardDay, context: async () => { throw new Error("down"); }, record: async () => ({}) as any });
  check("no context: the read waits, never sends, and spends no call", noCtx.read && noCtx.action.act === "wait" && prompts.length === 0);
  const req = await MF.exemptMomentRead({ userId: ROWAN, type: "direct_ask", targetKey: "intro_text:1", messages: ["Here's the intro you asked for"], cls: "requested", now: NOW }, { state: async () => onHardDay, context: ctx(distressWords) });
  check("requested: what they asked for during distress is never read", !req.read && prompts.length === 0);
  // The wait says how long it waited.
  const logged: any[] = [];
  prompts.length = 0;
  model("wait");
  await MF.exemptMomentRead({ userId: ROWAN, type: "direct_ask", targetKey: KEY, messages: [ASK], cls: "unsolicited", now: NOW, queuedAt: new Date(NOW.getTime() - 26 * 3_600_000) }, { state: async () => onHardDay, context: ctx(calmWords), record: async (d: any) => (logged.push(d), {}) as any });
  check("queued: a held row's read is told it waited (\"1 day ago\")", /It was queued 1 day ago\./.test(prompts[0] ?? ""));
  check("log: the verdict is one decision row, ids and kinds only (never their words)", logged.length === 1 && logged[0].decision === R.SEND_RECHECK && logged[0].action === "moment_wait" && logged[0].proposal.kind === "direct_ask" && !/supper|drowning|Sam/.test(JSON.stringify(logged[0])), logged);
  reset();
}

// ---------------------------------------------------------------- 3. the recheck: no class hold for what's judged; everything else unchanged
{
  const calm = { safetyHold: false, mood: { state: "none" as const, hold: false, heldHours: null }, away: null };
  const mood = { ...calm, mood: { state: "held" as const, hold: true, heldHours: 5 } };
  const ask = { kind: "direct_ask", cls: "unsolicited" as const, targetKey: KEY, eventBound: true };
  check("recheck: a judged intro ask is never held by the mood hold", R.recheckVerdict({ ...ask, judged: true }, mood, null, NOW).go);
  check("recheck: a judged co_event announcement is never held by the mood hold", R.recheckVerdict({ kind: "co_event", cls: "unsolicited", targetKey: "co_event:ev1", judged: true }, mood, null, NOW).go);
  check("recheck: the safety hold still holds a judged one (untouched)", (() => { const v = R.recheckVerdict({ ...ask, judged: true }, { ...calm, safetyHold: true }, null, NOW); return !v.go && v.held && v.hold === "safety"; })());
  check("recheck: away still holds a judged one", (() => { const v = R.recheckVerdict({ ...ask, judged: true }, { ...calm, away: { until: "2026-11-12", quote: "in Lisbon", text: "away" } as any }, null, NOW); return !v.go && v.held && v.hold === "away"; })());
  check("recheck: everything not judged keeps the mood hold as before (an in-room nudge, a check-in)", !R.recheckVerdict({ kind: "in_room", cls: "unsolicited", targetKey: "in_room:match:ev1" }, mood, null, NOW).go && !R.recheckVerdict({ kind: "goal_checkin", cls: "checkin" }, mood, null, NOW).go);
}

// ---------------------------------------------------------------- 4. through the real send code (a fake ledger): code follows the read
function harness() {
  const f = installFakeLedger(pool, sendblue);
  const inner = (pool as any).query;
  const order: string[] = [];
  const decisions: any[] = [];
  let deferredRow: any = null;
  const deferred: { status: string; args: any[] }[] = [];
  const wrap = async (s: string, a: any[] = []) => {
    const q = s.replace(/\s+/g, " ").trim();
    order.push(q.slice(0, 40));
    if (/^INSERT INTO harness_decisions/.test(q)) {
      decisions.push({ decision: a[1], action: a[4], outcome: a[3], proposal: a[5] ? JSON.parse(a[5]) : null, reason: a[8] });
      return { rows: [{ id: "1", created_at: new Date() }] };
    }
    if (/FROM deferred_sends d JOIN users u/.test(q)) return { rows: deferredRow ? [deferredRow] : [] };
    if (/^UPDATE deferred_sends SET status = 'sending'/.test(q)) return { rows: [{ id: 1 }] };
    if (/^UPDATE deferred_sends/.test(q)) { deferred.push({ status: /status = 'queued'/.test(q) ? "queued" : String(a[1]), args: a }); return { rows: [] }; }
    return inner(s, a);
  };
  (pool as any).query = wrap;
  (pool as any).connect = async () => ({ query: wrap, release: () => {} });
  MF.setMomentModelForTests(async (p) => (order.push("MODEL"), prompts.push(p), JSON.stringify({ verdict: current, why: "stub" })));
  return { ...f, order, decisions, deferred, setRow: (r: any) => (deferredRow = r) };
}
let current: "send" | "wait" | "drop" = "wait";
const zone = (() => { let off = (13 - new Date().getUTCHours() + 24) % 24; if (off > 14) off -= 24; return off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`; })();
const send = (over: Record<string, unknown> = {}) => ({ userId: ROWAN, phoneNumber: "+15035550177", type: "direct_ask" as const, targetKey: KEY, messages: [ASK], timezone: zone, ...over });
const HELD = { safetyHold: false, mood: { state: "held" as const, hold: true, heldHours: 5 }, away: null };
const CAPPED = { safetyHold: false, mood: { state: "released_cap" as const, hold: false, heldHours: 49 }, away: null };
for (const [label, holds, recent] of [["calm words", HELD, calmWords], ["distressed words", HELD, distressWords], ["at the cap", CAPPED, distressWords]] as const) {
  for (const verdict of ["send", "wait", "drop"] as const) {
    reset();
    current = verdict;
    R.setSendHoldReaderForTests(async () => holds as any);
    MF.setExemptReadDepsForTests({ state: async () => onHardDay, context: ctx(recent) });
    const h = harness();
    try {
      const r = await P.sendExempt(send());
      const modelAt = h.order.indexOf("MODEL"), lockAt = h.order.findIndex((q) => /^BEGIN/.test(q));
      check(`send (${label}, read says ${verdict}): it reached the read once, before the send lock`, prompts.length === 1 && modelAt >= 0 && (lockAt === -1 || modelAt < lockAt) && prompts[0].includes(MF.HARD_DAY_LINE), { modelAt, lockAt, n: prompts.length });
      if (verdict === "send") check(`send (${label}): the read's send goes (never held by the hard day's class)`, r.sent === true && h.ledger.outbox.length === 1, r);
      if (verdict === "wait") check(`send (${label}): the read's wait holds it, with when to look again, nothing sent${label === "at the cap" ? " (the cap is no release)" : ""}`, !r.sent && /^held: /.test(String(r.reason)) && !!r.retryAt && h.ledger.outbox.length === 0 && h.decisions.some((d) => d.action === "moment_wait"), r);
      if (verdict === "drop") check(`send (${label}): the read's drop ends it (not a hold, never retried)`, !r.sent && /^doesn't fit now: /.test(String(r.reason)) && !r.retryAt && h.ledger.outbox.length === 0 && D.outcomeOf(r, true) === "skipped", r);
    } finally { h.restore(); reset(); }
  }
}
{
  // Requested and relayed: never read, even on a hard day.
  R.setSendHoldReaderForTests(async () => HELD as any);
  MF.setExemptReadDepsForTests({ state: async () => onHardDay, context: ctx(distressWords) });
  const h = harness();
  try {
    const r = await P.sendExempt(send({ targetKey: "intro_text:7", cls: "requested", messages: ["Here's the intro you asked for."] }));
    check("send: an intro they asked for goes on a hard day with no read", r.sent && prompts.length === 0, { r, n: prompts.length });
    const relay = await P.sendExempt(send({ targetKey: "relay:5", messages: ["Sam says: see you there"] }));
    check("send: another member's relayed words aren't read (they keep their own capped hold)", prompts.length === 0 && !relay.sent && /^held: /.test(String(relay.reason)), relay);
  } finally { h.restore(); reset(); }
}
{
  // Unreadable state before the lock: fail closed, the recheck's mood hold keeps it.
  R.setSendHoldReaderForTests(async () => HELD as any);
  MF.setExemptReadDepsForTests({ state: async () => null, context: ctx(distressWords) });
  const h = harness();
  try {
    const r = await P.sendExempt(send());
    check("send: state unreadable before the lock: no read, and the recheck holds it (fail closed, never sent)", !r.sent && /^held: /.test(String(r.reason)) && prompts.length === 0, r);
  } finally { h.restore(); reset(); }
}
{
  // The deferred runner: a held intro ask comes due on a hard day; the read is asked, told how long it waited, and its wait requeues it.
  current = "wait";
  R.setSendHoldReaderForTests(async () => HELD as any);
  MF.setExemptReadDepsForTests({ state: async () => onHardDay, context: ctx(distressWords) });
  const h = harness();
  h.setRow({ id: 1, user_id: ROWAN, phone_number: "+15035550177", type: "direct_ask", target_key: KEY, messages: [ASK], timezone: zone, after_kind: null, after_payload: null, due_at: new Date(Date.now() - 60_000), status: "queued", attempts: 0, created_at: new Date(Date.now() - 30 * 3_600_000), error: null, archived: false });
  try {
    const out = await D.runDueDeferredSends(new Date(), { send: P.sendExempt, handlers: D.afterHandlers });
    check("deferred: a held intro ask coming due on a hard day reaches the read (never sent on the clock)", prompts.length === 1 && out.requeued === 1 && out.sent === 0 && h.ledger.outbox.length === 0, out);
    check("deferred: the read is told it waited a day", /It was queued 1 day ago\./.test(prompts[0] ?? ""));
  } finally { h.restore(); reset(); }
}

// ---------------------------------------------------------------- 5. the wiring
{
  const px = src("harness/proactive.ts");
  const fn = px.slice(px.indexOf("export async function sendExempt("), px.indexOf("export async function sendExemptWhenAllowed("));
  check("wiring: sendExempt asks the read before it takes the send lock", fn.indexOf("STR.exemptMomentRead(") > 0 && fn.indexOf("STR.exemptMomentRead(") < fn.indexOf("const client = await pool.connect();"));
  check("wiring: the recheck in the lock is told it was judged", /eventId: directAskEvent\(opts\.targetKey, opts\.userId\), safety: opts\.safety, judged \}/.test(fn));
  check("wiring: the deferred runner passes when the row was queued", /respectHours: true, now, queuedAt,/.test(src("services/deferredSends.ts")));
  check("wiring: the recheck itself stays model-free", !/generateText|anthropic\(|momentFit\(/.test(src("harness/sendTimeRecheck.ts").replace(/\/\/.*$/gm, "")));
}

console.log(`\nhard day, exempt sends: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
