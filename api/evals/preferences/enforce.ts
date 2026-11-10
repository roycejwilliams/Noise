// Member preferences, PR B (harness/notifyGate.ts): the one gate on every send, rechecked right before it goes. Zero tokens and no
// database: an in-memory store with a real per-member lock (the advisory lock's behavior), so concurrent sends really race.
//   npx tsx evals/preferences/enforce.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
const G = await import("../../src/harness/notifyGate.js");
const PR = await import("../../src/harness/proactive.js");
const CG = await import("../../src/harness/callGate.js");
const P = await import("../../src/services/memberPreferences.js");
const D = await import("../../src/services/deferredSends.js");
const { default: pool } = await import("../../src/db/db.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const SRC = new URL("../../src/", import.meta.url).pathname;
const src = (f: string) => readFileSync(SRC + f, "utf8");

// ---------------------------------------------------------------- an in-memory store with a per-member lock
type Send = { user_id: string; type: string; target_key: string; sent_at: Date; exempt: boolean; notify_class: string | null };
const db = { sends: [] as Send[], prefs: [] as any[], inbound: new Map<string, Date>(), outbox: [] as { to: string; content: string }[], deferred: [] as any[], txNow: () => new Date() };
const locks = new Map<string, Promise<void>>();
const run = async (raw: string, a: any[] = [], tx?: { at: Date; release?: () => void }) => {
  const sql = raw.replace(/\s+/g, " ").trim();
  await new Promise((r) => setImmediate(r));
  if (/pg_advisory_xact_lock/.test(sql)) {
    const key = String(a[0]);
    while (locks.has(key)) await locks.get(key);
    let release!: () => void;
    locks.set(key, new Promise<void>((r) => (release = () => { locks.delete(key); r(); })));
    if (tx) tx.release = release;
    return { rows: [] };
  }
  if (/^(COMMIT|ROLLBACK)/.test(sql)) { tx?.release?.(); if (tx) tx.release = undefined; return { rows: [] }; }
  if (/^BEGIN/.test(sql)) { if (tx) tx.at = db.txNow(); return { rows: [] }; }
  if (/sms_opted_out/.test(sql) && /FROM users/.test(sql)) return { rows: [{ opted_out: false }] };
  if (/^SELECT MAX\(created_at\) AS at FROM co_memories/.test(sql)) return { rows: [{ at: db.inbound.get(a[0]) ?? null }] };
  if (/FROM co_memories WHERE user_id = \$1 AND memory_type = 'call_transcript' AND content LIKE 'Co initiated call%'/.test(sql)) return { rows: [] };
  if (/^SELECT type, sent_at, notify_class FROM proactive_sends/.test(sql)) return { rows: db.sends.filter((s) => s.user_id === a[0]) };
  if (/^SELECT type, target_key, topic_key, sent_at, exempt FROM proactive_sends/.test(sql)) return { rows: /DISTINCT ON/.test(sql) ? [] : db.sends.filter((s) => s.user_id === a[0]).map((s) => ({ ...s, topic_key: s.target_key })) };
  if (/^SELECT id, object_label, happened_at, retired_at, meta FROM co_facts/.test(sql)) return { rows: db.prefs.filter((r) => r.owner_user_id === a[0] && !r.retired_at) };
  if (/^INSERT INTO proactive_sends/.test(sql) && /VALUES \(\$1, 'in_room', \$2/.test(sql)) {
    if (db.sends.some((s) => s.user_id === a[0] && s.target_key === a[1])) return { rows: [] };
    db.sends.push({ user_id: a[0], type: "in_room", target_key: a[1], sent_at: tx?.at ?? new Date(), exempt: false, notify_class: "unsolicited" });
    return { rows: [{ id: db.sends.length }] };
  }
  if (/^INSERT INTO proactive_sends/.test(sql)) {
    if (db.sends.some((s) => s.user_id === a[0] && s.target_key === a[2])) return { rows: [] };
    const cls = /notify_class\)\s*VALUES[^)]*'reply'\)/.test(sql) ? "reply" : /'unsolicited'\)$/.test(sql) ? "unsolicited" : a[a.length - 1];
    db.sends.push({ user_id: a[0], type: a[1], target_key: a[2], sent_at: tx?.at ?? new Date(), exempt: true, notify_class: typeof cls === "string" ? cls : null });
    return { rows: [{ id: db.sends.length }] };
  }
  if (/^INSERT INTO deferred_sends/.test(sql)) {
    db.deferred.push({ user_id: a[0], type: a[2], target_key: a[3], due_at: a[8] });
    return { rows: [{ id: db.deferred.length }] };
  }
  if (/stamped_at/.test(sql)) return { rows: [{ stamped_at: null, co_reply_at: null, running: false }] };
  return { rows: [] };
};
(pool as any).query = (s: string, a?: any[]) => run(s, a);
(pool as any).connect = async () => {
  const tx = { at: new Date() } as { at: Date; release?: () => void };
  return { query: (s: string, a?: any[]) => run(s, a, tx), release: () => tx.release?.() };
};
(sendblue as any).messages.send = async (b: any) => {
  db.outbox.push({ to: b.number, content: b.content });
  return { message_handle: `fake-${db.outbox.length}` };
};
const reset = () => { db.sends = []; db.prefs = []; db.inbound.clear(); db.outbox = []; db.deferred = []; };

// A rule as PR A stores it (co_facts relation 'prefers').
const NY = "America/New_York";
let pid = 0;
const rule = (user: string, o: { covers?: string; area?: string; channel?: string; rule: any; basis?: string; type?: string; expiresAt?: string | null }) => {
  db.prefs.push({ id: ++pid, owner_user_id: user, object_label: "their words", happened_at: new Date("2026-11-02T17:11:00Z"), retired_at: null, meta: { pref: 1, area: o.area ?? "contact", covers: o.covers ?? "all", channel: o.channel ?? "all", basis: o.basis ?? "explicit", type: o.type ?? "standing", ruleRaw: o.rule, words: ["their words"], source: { via: "text", ref: null }, startsAt: "2026-11-02T17:11:00Z", expiresAt: o.expiresAt ?? null, zone: NY } });
};
const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";
const phone = "+15035550101";
const exempt = (user: string, over: any = {}) => PR.sendExempt({ userId: user, phoneNumber: phone, type: "task_update", targetKey: `task:${Math.random()}`, messages: ["one", "two", "three"], timezone: NY, ...over });

// ---------------------------------------------------------------- the incident: "only message me once per day", on every path
reset();
rule(A, { rule: { max_per_day: 1 } });
let r = await exempt(A);
check("the day's first message goes (three bubbles)", r.sent === true && db.outbox.length === 3);
check("its three bubbles are one message: one ledger row, counted once", db.sends.filter((s) => s.user_id === A).length === 1 && G.memberRuleCheck(await P.activePreferences(A), { now: new Date(), cls: "unsolicited", channel: "text", sent: (await G.loadCounted(pool as any, A)) }).pass === false);
r = await exempt(A);
check("a task's results the same day are held by their rule, with when it may go", r.sent === false && /the member's own rule/.test(r.reason ?? "") && !!r.retryAt && db.outbox.length === 3);
r = await exempt(A, { type: "event_change", targetKey: "event_change:x", queueIfHeld: true });
check("a notice they're owed is held too and queued for when it may go, never dropped", r.sent === false && db.deferred.some((d) => d.target_key === "event_change:x"));
const qd = await PR.sendExemptWhenAllowed({ userId: A, phoneNumber: phone, type: "direct_ask", targetKey: "relay:1", messages: ["hi"], timezone: NY, now: new Date(Math.max(Date.now(), Date.parse("2026-11-02T18:00:00Z"))) });
check("a relayed message or reminder through sendExemptWhenAllowed is queued when held", qd.queued === true && db.deferred.some((d) => d.target_key === "relay:1"));
const claimed = await PR.claimCoInitiatedSend({ userId: A, type: "task_update", targetKey: "task:9:doc:1", message: "[document] x", kind: null, timezone: NY, owed: { askedAt: new Date("2026-11-01T10:00:00Z") } });
check("a document they asked for yesterday is held by the rule (a delivery is a notification)", claimed.ok === false && /member's own rule/.test((claimed as any).reason));
const co = await PR.claimCoInitiatedSend({ userId: A, type: "task_update", targetKey: "task:9:doc:2", message: "[document] y", kind: "find", timezone: NY });
check("a document Cue starts is held by it", co.ok === false && /member's own rule/.test((co as any).reason));
// The pick sees it before anything is drafted.
const cand = (type: string, payload: any = {}, id = String(Math.random())): any => ({ id, userId: A, type, targetKey: `${type}:${id}`, topicKey: id, summary: "", priority: 50, dueAt: new Date(0), expiresAt: null, payload, attempts: 0, createdAt: new Date(0) });
const sentA = await G.loadCounted(pool as any, A);
const state = (cands: any[], prefs: any[], sent = sentA, now = new Date()): any => ({ now, timezone: NY, optedOut: false, candidates: cands, sends: [], lastInboundAt: null, memberRules: { prefs, sent } });
const prefsA = await P.activePreferences(A);
const ev = PR.evaluateCandidates(state([cand("event_offer", { askId: "ask-1" }), cand("companion"), cand("event_offer", { askId: "profile", fromProfile: true, morningDay: "2026-11-02" })], prefsA), { ignorePacing: true });
check("the daily pick: an ask's find, a check-in and a morning find are all held by the rule (ignorePacing doesn't skip it)", ev.perCandidate.every((p) => p.checks.some((c) => c.name === G.MEMBER_RULE && !c.pass)));
check("a safety follow-up keeps its precedence", PR.evaluateCandidates(state([cand("companion", { safetyFollowUp: true })], prefsA)).perCandidate[0].checks.every((c) => c.name !== G.MEMBER_RULE));
check("sendWithLedger rechecks it inside its lock", /const \{ retryAt: _r, \.\.\.rule \} = await memberRuleGate\(client, \{ userId: person\.userId, now, cls, channel: "text" \}\);/.test(src("harness/proactive.ts")));
// A delivery minutes after their text is still a delivery (R1): held by an "all" rule and counted. Only the turn's own answer is a reply.
db.inbound.set(A, new Date(Date.now() - 5 * 60_000));
r = await exempt(A, { answers: { askedAt: new Date(Date.now() - 4 * 60_000) } });
check("a task's result minutes after their text is a requested delivery: their 'all' rule holds it", r.sent === false && /member's own rule/.test(r.reason ?? ""));
check("sendExempt never turns a delivery into a reply (answers only skips the spacing)", !/"reply" : opts\.cls/.test(src("harness/proactive.ts")) && /const answersLast = !!opts\.answers && answersLastText/.test(src("harness/proactive.ts")) && /if \(!opts\.coInitiated && !answersLast && SPACED_EXEMPT\.has/.test(src("harness/proactive.ts")));
check("a document they asked for is requested, never a reply, however fresh", /const cls: SendClass = o\.cls \?\? \(o\.owed \? "requested" : "unsolicited"\);/.test(src("harness/proactive.ts")));
reset();
db.inbound.set(A, new Date(Date.now() - 5 * 60_000));
db.sends.push({ user_id: A, type: "event_offer", target_key: "event_offer:x", sent_at: new Date(Date.now() - 10 * 60_000), exempt: true, notify_class: "unsolicited" });
r = await exempt(A, { answers: { askedAt: new Date(Date.now() - 4 * 60_000) } });
check("with no rule, a result answering their latest message skips the spacing (R4) and counts as requested", r.sent === true && db.sends.some((x) => x.notify_class === "requested"));
r = await exempt(A, { answers: { askedAt: new Date(Date.now() - 20 * 3_600_000) } });
check("a look-out started from an older message keeps the spacing", r.sent === false && /went out less than 3h ago/.test(r.reason ?? ""));
reset();
rule(A, { rule: { max_per_day: 1 } });
// Soon notices (R2): about something within hours, a held rule lets it through (and it counts).
await exempt(A, { type: "event_change", targetKey: "event_change:first" });
r = await exempt(A, { type: "event_change", targetKey: "event_change:soon", soonAt: new Date(Date.now() + 2 * 3_600_000) });
check("an event change for an event two hours out gets through a held rule", r.sent === true);
r = await exempt(A, { type: "call_reminder", targetKey: "call_reminder:1", soonAt: new Date(Date.now() + 15 * 60_000) });
check("a reminder for a call they booked 15 minutes out gets through", r.sent === true);
r = await exempt(A, { type: "event_change", targetKey: "event_change:later", soonAt: new Date(Date.now() + 3 * 86_400_000) });
check("one for an event three days out is held (queued if asked)", r.sent === false);
r = await exempt(A, { targetKey: "task:soon", soonAt: new Date(Date.now() + 3_600_000), cls: "unsolicited" });
check("soon never lets Cue's own outreach through", r.sent === false);
check("the reminder, the event change and the no-show ask pass when they're about", /soonAt: new Date\(row\.scheduled_for\)/.test(src("jobs/scheduledCall.ts")) && /soonAt: await \(await import\("\.\.\/db\/db\.js"\)\)\.default\.query\(`SELECT start_at FROM luma_event_snapshots/.test(src("agent/eventChangeNotification.ts")) && /cls: "requested", soonAt: event\.start_at/.test(src("services/eventNoShow.ts")));
// In-room: the gate and the claim in one locked transaction.
reset();
rule(A, { rule: { max_per_day: 1 } });
const ir = await Promise.all([1, 2].map((i) => PR.inRoomSendAllowed(A, "evt-1", { claim: { targetKey: `in_room:additive:evt-1:${i}`, message: "x" } })));
check("two in-room texts at once against a cap of one: one is claimed, the other held", ir.filter(Boolean).length === 1 && db.sends.filter((x) => x.type === "in_room").length === 1);
const closeOk = await PR.inRoomSendAllowed(A, "evt-1", { close: true, claim: { targetKey: "in_room:close:evt-1", message: "bye" } });
check("the close follows their rule too (R3)", !closeOk);
check("a failed in-room send takes its claim back", /await releaseInRoomClaim\(person\.user_id, `in_room:close:\$\{eventId\}`\)/.test(src("services/eventUnmatchedFollowUp.ts")) && (src("services/eventScoring.ts").match(/releaseInRoomClaim\(/g) ?? []).length === 2);
// The missed-call follow-up and the PDF retry: claimed (counted) under the lock.
check("the missed-call text is claimed with its class before it goes, and released if it fails", /claimCoInitiatedSend\(\{ userId: user\.id, type: "missed_call"[^\n]*ruleOnly: true, cls: "unsolicited" \}\)/.test(src("routes/co.ts")) && src("routes/co.ts").indexOf("claimCoInitiatedSend({ userId: user.id") < src("routes/co.ts").indexOf("await sendblue.messages.send({\n      number: user.phone_number") && /releaseCoInitiatedClaim\(user\.id, claim\.ledgerId\)/.test(src("routes/co.ts")));
reset();
rule(A, { rule: { max_per_day: 1 } });
await exempt(A, { type: "event_change", targetKey: "event_change:one" });
const mc = await PR.claimCoInitiatedSend({ userId: A, type: "missed_call", targetKey: "missed_call_followup:CA1", message: "[missed-call follow-up]", kind: null, timezone: NY, ruleOnly: true, cls: "unsolicited" });
check("so the missed-call text is held by their cap, like any send", mc.ok === false && /member's own rule/.test((mc as any).reason));
// Booked calls (R2): their own exception to the rules they had when they booked; a later rule moves the call, never fails it.
{
  const booked = new Date("2026-11-02T12:00:00Z");
  const mk = (id: string, setAt: string): any => ({ id, area: "contact", covers: "all", channel: "all", basis: "explicit", type: "standing", words: [], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: NY, state: "active", setAt, rule: { none: true } });
  const before = mk("1", "2026-11-01T12:00:00.000Z");
  const after = mk("2", "2026-11-02T13:00:00.000Z");
  const at = new Date("2026-11-02T20:00:00Z");
  check("a rule set before they booked the call doesn't hold it", G.memberRuleCheck([before], { now: at, cls: "requested", channel: "call", sent: [], rulesAfter: booked }).pass);
  check("a rule set after holds it, with when it may go", (() => { const c = G.memberRuleCheck([after], { now: at, cls: "requested", channel: "call", sent: [], rulesAfter: booked }); return !c.pass && !!c.retryAt; })());
  check("the call gate passes the booking time, and a held booked call is moved (pending, new time, reminder reset), never failed", /rulesAfter: kind === "scheduled_call" \? await bookedAt/.test(src("harness/callGate.ts")) && /heldUntil: callState\.memberRule!\.retryAt/.test(src("services/callTrigger.ts")) && /SET status = 'pending', scheduled_for = \$2, reminder_sent_at = NULL/.test(src("jobs/scheduledCall.ts")));
  check("a queued call reminder whose call is no longer pending and ahead is dropped", /row\.type === "call_reminder" && !\(await callStillAhead/.test(src("services/deferredSends.ts")) && /status = 'pending' AND scheduled_for > \$2/.test(src("services/deferredSends.ts")));
}
// A booked call that was moved: its reminder is a new one (keyed by the call's time) and says the new time.
{
  const SC = await import("../../src/jobs/scheduledCall.js");
  const k1 = SC.callReminderKey(7, new Date("2026-11-04T18:00:00Z")), k2 = SC.callReminderKey(7, new Date("2026-11-05T18:00:00Z"));
  reset();
  const first = await exempt(A, { type: "call_reminder", targetKey: k1 });
  const second = await exempt(A, { type: "call_reminder", targetKey: k2 });
  check("a moved call's reminder isn't 'already sent' from the first time", k1 !== k2 && first.sent && second.sent);
  check("it tells them the new time, in their zone", SC.movedReminderText(new Date("2026-11-05T18:30:00Z"), NY) === "Our call is now at 1:30pm your time. I'll call you then.");
  check("the job keys by time, marks a move, and says the new time when it was moved", /targetKey: callReminderKey\(row\.id, new Date\(row\.scheduled_for\)\)/.test(src("jobs/scheduledCall.ts")) && /moved_at = NOW\(\)/.test(src("jobs/scheduledCall.ts")) && /row\.moved_at \? movedReminderText/.test(src("jobs/scheduledCall.ts")) && /\.split\(":"\)\[0\]/.test(src("services/deferredSends.ts")));
}
// Placed calls count by their kind.
check("a placed call counts by its kind: asked for now isn't counted, booked is requested, check-in a check-in, intake Cue's own", G.callClassOf("router_decision") === "reply" && G.callClassOf("inferred scheduled_call") === "requested" && G.callClassOf("checkin_cadence") === "checkin" && G.callClassOf("auto_intake") === "unsolicited");
// Owed work never loses its wakes to a hold, and nothing held is lost.
{
  const RB = await import("../../src/services/researchBrief.js");
  check("a research brief held by a rule or the spacing waits however many wakes it's had, and gives its wake back", RB.briefLineOutcome({ sent: false, reason: "held: a task_update went out less than 3h ago" }, 99) === "hold" && /if \(held\) await unspendWake\(task\.userId, task\.id\)/.test(src("services/researchBrief.ts")) && /held \?\? nextSendable/.test(src("services/researchBrief.ts")));
}
check("a reminder they set is requested; a held window warning is queued; the call follow-through is asked at the call's end", /reminderText\(r\.what\)\], timezone: zone, cls: "requested"/.test(src("services/relay.ts")) && /type: "task_window"[^\n]*queueIfHeld: true/.test(src("services/taskTurn.ts")) && /answers: \{ askedAt: endedAt \?\? null \}/.test(src("services/callFollowThrough.ts")) && !/askedAt: new Date\(\)/.test(src("services/callFollowThrough.ts")) && /\^\(\?:reminder\|network-intro\|event-intro\):\/\.test/.test(src("services/deferredSends.ts")) && /rowClass\(row\) \? \{ cls: rowClass\(row\)! \}/.test(src("services/deferredSends.ts")));
const callState = (memberRule: any): any => ({ callStatus: null, callStatusUpdatedAt: null, optedOut: false, subscriptionActive: true, requireSubscription: false, localHourOk: true, lastCallAt: null, evidence: { scheduledCallDue: true, recentInboundText: true, routerPlaceCallDecision: true, cadenceSet: true, autoIntakeEligible: true }, memberRule });
const held = { name: G.MEMBER_RULE, pass: false, reason: "rule" };
check("a check-in call and an intake call Cue starts are held by their rule", !CG.decideCall(callState(held), { kind: "checkin_cadence" }, new Date()).allowed && !CG.decideCall(callState(held), { kind: "auto_intake" }, new Date()).allowed && !CG.decideCall(callState(held), { kind: "scheduled_call" }, new Date()).allowed);
check("a call they ask for right now is never held", CG.decideCall(callState(held), { kind: "router_decision" }, new Date()).allowed);
check("the call gate reads the rule for the call channel, for the kind it decides", /memberRuleGate\(pool, \{ userId, now, cls: CALL_CLASS\[kind\], channel: "call", rulesAfter:/.test(src("harness/callGate.ts")));

// ---------------------------------------------------------------- scope: what a rule covers, and only that
const now = new Date("2026-11-04T16:00:00Z"); // Wednesday 11am New York
const pref = (o: any) => ({ id: "1", area: "contact", covers: "all", channel: "all", basis: "explicit", type: "standing", words: [], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: NY, state: "active", setAt: "", ...o, rule: P.ruleFrom(o.rule ?? {}) });
const one = [{ at: new Date("2026-11-04T13:00:00Z"), cls: "unsolicited" as const, channel: "text" as const }];
const passes = (p: any, cls: any, channel: any = "text", sent: any[] = one, at = now) => G.memberRuleCheck([p], { now: at, cls, channel, sent }).pass;
check("'no check-ins' holds check-ins only, never a find or a delivery", !passes(pref({ area: "checkins", covers: "checkins", rule: { none: true } }), "checkin") && passes(pref({ area: "checkins", covers: "checkins", rule: { none: true } }), "unsolicited") && passes(pref({ area: "checkins", covers: "checkins", rule: { none: true } }), "requested"));
check("'stop reaching out' (unsolicited) holds Cue's own texts but not a delivery they asked for", !passes(pref({ covers: "unsolicited", rule: { none: true } }), "unsolicited") && passes(pref({ covers: "unsolicited", rule: { none: true } }), "requested"));
check("an 'all notifications' rule holds deliveries and notices too, never a reply", !passes(pref({ rule: { max_per_day: 1 } }), "requested") && passes(pref({ rule: { max_per_day: 1 } }), "reply"));
check("'no calls' holds calls, never texts; a texts rule never holds a call", !passes(pref({ channel: "call", rule: { none: true } }), "unsolicited", "call") && passes(pref({ channel: "call", rule: { none: true } }), "unsolicited", "text") && passes(pref({ channel: "text", rule: { none: true } }), "unsolicited", "call"));
check("an inferred rule, a one-time exception and a vague 'less' never hold a send", passes(pref({ basis: "inferred", rule: { none: true } }), "unsolicited") && passes(pref({ type: "one_time", rule: { none: true } }), "unsolicited") && passes(pref({ rule: { less: true } }), "unsolicited"));
check("a rule another member set never holds this member's send", (await (async () => { reset(); rule(B, { rule: { none: true } }); return (await exempt(A)).sent; })()));

// ---------------------------------------------------------------- their local day, their weekdays, their hours, expiry
const sunNight = new Date("2026-11-09T04:30:00Z"); // Sunday 11:30pm New York, Monday in UTC
check("weekdays are theirs: Sunday 11:30pm New York is still Sunday", !passes(pref({ rule: { no_days: [7] } }), "unsolicited", "text", [], sunNight) && passes(pref({ rule: { no_days: [7] } }), "unsolicited", "text", [], new Date("2026-11-09T05:30:00Z")));
const lateUtc = [{ at: new Date("2026-11-04T03:00:00Z"), cls: "unsolicited" as const, channel: "text" as const }]; // Tuesday 10pm New York
check("the day boundary is theirs: a text at 10pm their Tuesday doesn't use Wednesday's one", passes(pref({ rule: { max_per_day: 1 } }), "unsolicited", "text", lateUtc));
check("held by the daily cap, it may go at the start of their next day", G.memberRuleCheck([pref({ rule: { max_per_day: 1 } })], { now, cls: "unsolicited", channel: "text", sent: one }).retryAt?.toISOString() === "2026-11-05T05:00:00.000Z");
check("'not before 10': held at 9am their time, may go at 10", (() => { const c = G.memberRuleCheck([pref({ rule: { earliest: "10:00" } })], { now: new Date("2026-11-04T14:00:00Z"), cls: "unsolicited", channel: "text", sent: [] }); return !c.pass && c.retryAt?.toISOString() === "2026-11-04T15:00:00.000Z"; })());
check("a week's cap counts the last 7 days and frees up when the oldest ages out", (() => { const s = [2, 3].map((d) => ({ at: new Date(now.getTime() - d * 86_400_000), cls: "unsolicited" as const, channel: "text" as const })); const c = G.memberRuleCheck([pref({ rule: { max_per_week: 2 } })], { now, cls: "unsolicited", channel: "text", sent: s }); return !c.pass && c.retryAt?.getTime() === now.getTime() + 4 * 86_400_000; })());
check("an expired rule holds nothing ('no check-ins this week' is over Monday)", passes(pref({ area: "checkins", covers: "checkins", rule: { none: true }, expiresAt: "2026-11-09T04:59:59.999Z" }), "checkin", "text", [], new Date("2026-11-09T06:00:00Z")));

// ---------------------------------------------------------------- caps hold across concurrent jobs, retries and bubbles
reset();
rule(A, { rule: { max_per_day: 1 } });
// Notices (no spacing of their own), so only the rule decides.
const results = await Promise.all([1, 2, 3, 4].map((i) => exempt(A, { type: "event_change", targetKey: `event_change:race:${i}` })));
check("four jobs at once, a cap of one: exactly one message goes", results.filter((x) => x.sent).length === 1 && db.outbox.length === 3);
const retry = await exempt(A, { type: "event_change", targetKey: "event_change:race:1" });
check("a retry of the one that went is a no-op, not a second message", retry.sent === false);
reset();
rule(A, { rule: { max_per_day: 2 } });
// Notices (no spacing of their own), so only the rule decides.
await Promise.all([1, 2, 3].map((i) => exempt(A, { type: "event_change", targetKey: `event_change:two:${i}`, messages: ["a", "b"] })));
check("'no more than two notifications a day': two messages, however many bubbles each, even sent in the same instant", db.outbox.length === 4 && db.sends.length === 2);
check("a find riding in another send isn't a message of its own; older rows count once per send time", G.countedRows([{ sentAt: now, type: "event_offer", cls: "unsolicited" }, { sentAt: now, type: "event_offer", cls: G.RIDING }, { sentAt: new Date(0), type: "event_offer", cls: null }, { sentAt: new Date(0), type: "event_offer", cls: null }]).length === 2);

// ---------------------------------------------------------------- queued work after a correction
reset();
const due: any[] = [];
const fakeSend: any = async (o: any) => PR.sendExempt(o);
rule(A, { rule: { none: true } });
const dueRow = { id: 1, user_id: A, phone_number: phone, type: "event_change", target_key: "event_change:q", messages: ["moved"], timezone: NY, after_kind: null, after_payload: null, due_at: new Date(), status: "queued", attempts: 0 };
const wasQuery = (pool as any).query;
let requeuedTo: Date | null = null;
(pool as any).query = async (s: string, a: any[] = []) => {
  if (/FROM deferred_sends d JOIN users u/.test(s)) return { rows: [dueRow] };
  if (/^\s*UPDATE deferred_sends SET status = 'sending'/.test(s)) return { rows: [{ id: 1 }] };
  if (/UPDATE deferred_sends SET status = 'queued', due_at = \$2/.test(s)) { requeuedTo = a[1]; return { rows: [] }; }
  return wasQuery(s, a);
};
const out = await D.runDueDeferredSends(new Date("2026-11-04T16:00:00Z"), { send: fakeSend, handlers: {} as any });
(pool as any).query = wasQuery;
check("a text queued before they set a rule is rechecked when it comes due: held and requeued, not sent, not dropped", out.requeued === 1 && out.sent === 0 && !!requeuedTo && db.outbox.length === 0);
void due;

// ---------------------------------------------------------------- the burst: three sources in one morning, one message
reset();
const joined = new Date("2026-11-01T21:59:54Z");
const t8 = new Date("2026-11-02T16:02:00Z");
const sends8 = [{ type: "event_offer", targetKey: "event_offer:a", topicKey: "a", sentAt: t8, exempt: true }];
const morning = cand("event_offer", { askId: "profile", fromProfile: true, picked: true, morningDay: "2026-11-02", match: { tier: 2 } });
const at910 = new Date("2026-11-02T17:10:00Z");
const ev910 = PR.evaluateCandidates({ now: at910, timezone: "America/Los_Angeles", optedOut: false, candidates: [morning], sends: sends8, lastInboundAt: new Date("2026-11-01T22:56:56Z"), joinedAt: joined } as any);
check("the 9:10 morning find no longer skips the spacing: held 68 minutes after the 8:02 find", !ev910.eligible.length && ev910.perCandidate[0].checks.some((c) => c.name === "spacing" && !c.pass));
check("its quotas are still skipped (the morning rule otherwise stands)", ev910.perCandidate[0].checks.every((c) => !["daily_cap", "weekly_cap", "unanswered_pause"].includes(c.name) || c.pass));
db.sends.push({ user_id: A, type: "event_offer", target_key: "event_offer:a", sent_at: new Date(Date.now() - 13 * 60_000), exempt: true, notify_class: "unsolicited" });
db.inbound.set(A, new Date(Date.now() - 17 * 3_600_000));
r = await exempt(A, { targetKey: "task:1108:1" });
check("a task's results 13 minutes after a find on their first day are held by the spacing (no rule set)", r.sent === false && /went out less than 3h ago/.test(r.reason ?? "") && !!r.retryAt);
const ask8 = cand("event_offer", { askId: "ask-1", picked: true, match: { tier: 2 } }, "ask");
const morn = cand("event_offer", { askId: "profile", fromProfile: true, picked: true, morningDay: "2026-11-02", match: { tier: 1 } }, "morn");
const third = cand("event_offer", { askId: "profile", fromProfile: true, picked: true, morningDay: "2026-11-02", match: { tier: 3 } }, "third");
const evAll = PR.evaluateCandidates({ now: at910, timezone: "America/Los_Angeles", optedOut: false, candidates: [ask8, morn, third], sends: [], lastInboundAt: null, joinedAt: joined } as any);
const lead = PR.leadPick(PR.codePick(evAll.eligible)!, evAll.eligible);
const sibs = PR.pickSiblingOffers(lead, evAll.eligible);
check("three sources ready in one window: one bundle of two finds (the plan's two-link limit), the third waits", evAll.eligible.length === 3 && sibs.length === 1 && new Set([lead.id, ...sibs.map((s) => s.id)]).size === 2);
const after = PR.evaluateCandidates({ now: new Date(at910.getTime() + 15 * 60_000), timezone: "America/Los_Angeles", optedOut: false, candidates: [cand("event_offer", { askId: "ask-2" })], sends: [{ type: "event_offer", targetKey: "event_offer:bundle", topicKey: "b", sentAt: at910, exempt: true }], lastInboundAt: null, joinedAt: joined } as any);
check("and nothing else proactive goes in that window", !after.eligible.length);

// ---------------------------------------------------------------- every send path asks the gate (the proof)
// Each place a message leaves (a Sendblue send, a dial, or the shared send functions) is listed here with what gates it. A new one
// fails this test until it's listed: gated, or a reply/system send with its reason.
// proof: what in that file shows the gate (or why none applies): checked, not just counted.
const SITES: Record<string, { n: number; gate: string; proof: RegExp }> = {
  "harness/proactive.ts": { n: 6, gate: "sendWithLedger (2) and sendExempt (4): memberRuleGate inside the lock, before the ledger row", proof: /await memberRuleGate\(client, \{ userId: person\.userId[\s\S]*await memberRuleGate\(client, \{ userId: opts\.userId/ },
  "routes/sendblue.ts": { n: 5, gate: "reply: the turn's own answer, STOP/START confirmations, 'Calling you now'", proof: /^(?=[\s\S]*isOptOutKeyword\(content\))(?=[\s\S]*const confirmation = "Calling you now\.";)(?=[\s\S]*export async function sendCoReply)/ },
  "routes/co.ts": { n: 1, gate: "missed-call follow-up: claimCoInitiatedSend (rule + count) before it", proof: /const claim = await P\.claimCoInitiatedSend\(\{ userId: user\.id, type: "missed_call"[\s\S]{0,600}if \(!claim\.ok\) \{[\s\S]{0,300}return;[\s\S]*await sendblue\.messages\.send\(\{\n      number: user\.phone_number/ },
  "services/eventScoring.ts": { n: 2, gate: "in-room: inRoomSendAllowed (rule + claim under the lock)", proof: /inRoomSendAllowed\(person\.user_id, eventId, \{ claim: \{ targetKey: `in_room:match:[\s\S]*inRoomSendAllowed\(person\.user_id, eventId, \{ claim: \{ targetKey: additiveKey/ },
  "services/eventUnmatchedFollowUp.ts": { n: 1, gate: "in-room close: inRoomSendAllowed (rule + claim under the lock)", proof: /inRoomSendAllowed\(person\.user_id, eventId, \{ close: true, claim:[\s\S]{0,400}await sendblue\.messages\.send/ },
  "services/networkIntroNudge.ts": { n: 1, gate: "reply: the reveal answers their yes", proof: /resolveNetworkTeaseReply|reveal send failed/ },
  "services/callTools.ts": { n: 1, gate: "reply: a text they asked for on the call they're on", proof: /sendblue\.messages/ },
  "agent/conversationTools.ts": { n: 1, gate: "reply: the contact card in the turn", proof: /sendContactCard: tool\(/ },
  "harness/failureCount.ts": { n: 1, gate: "team: ops alert to the team phone, never a member", proof: /TEAM_ALERT_PHONE[\s\S]{0,800}sender: "ops"/ },
  "otpActions.ts": { n: 1, gate: "system: sign-in codes", proof: /otp|code/i },
  "services/sendblue.ts": { n: 1, gate: "the wrapper itself", proof: /const sendblue = \{/ },
  "services/callTrigger.ts": { n: 1, gate: "dial: decideCall's member_rule, read by gatherCallState", proof: /const callState = await gatherCallState\(userId, user, auth\);\n  const gateResult = decideCall\(callState, auth, new Date\(\)\);[\s\S]*if \(!gateResult\.allowed\) \{[\s\S]*await dial\(\{/ },
};
const found: Record<string, number> = {};
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { if (!/scripts$/.test(p)) walk(p); continue; }
    if (!/\.ts$/.test(f)) continue;
    const n = (readFileSync(p, "utf8").match(/\.messages\s*\.send\(|\.messages\s*\n\s*\.send\(|\bdial\(\{/g) ?? []).length;
    if (n) found[p.replace(SRC, "")] = n;
  }
};
walk(SRC);
for (const [f, n] of Object.entries(found)) check(`send site ${f} (${n}) is listed with its gate`, SITES[f]?.n === n);
for (const f of Object.keys(SITES)) check(`listed send site ${f} still exists`, !!found[f]);
for (const [f, x] of Object.entries(SITES)) check(`send site ${f} proves its gate (${x.gate})`, x.proof.test(src(f)));
// The call gate really holds on the rule: decideCall pushes it, and gatherCallState reads it for the kind it decides.
check("the call gate applies the member's rule to every kind but a call they ask for now", /if \(state\.memberRule && kind && CALL_CLASS\[kind\] !== "reply"\) checks\.push\(state\.memberRule\);/.test(src("harness/callGate.ts")) && /memberRule: kind \? await import\("\.\/notifyGate\.js"\)/.test(src("harness/callGate.ts")));
const ps = src("harness/proactive.ts");
const body = (name: string) => ps.slice(ps.indexOf(`async function ${name}(`), ps.indexOf("\n}\n", ps.indexOf(`async function ${name}(`)));
check("the shared send functions each ask the member's rules", ["sendWithLedger", "sendExempt", "claimCoInitiatedSend", "inRoomSendAllowed"].every((f) => /memberRuleGate\(/.test(body(f))));
check("every proactive type has a class", Object.keys(PR.TYPE_POLICY).every((t) => t in G.PROACTIVE_CLASS) && ["event_change", "call_reminder", "missed_call", "co_event", "direct_ask", "search_result", "task_update", "call_confirm", "task_window", "in_room"].every((t) => t in G.PROACTIVE_CLASS));
check("every sendExempt caller with no retry of its own queues what's held", /queueIfHeld: true/.test(src("agent/eventChangeNotification.ts")) && /queueIfHeld: true/.test(src("jobs/scheduledCall.ts")) && /queueIfHeld: true/.test(src("jobs/index.ts")) && /queueIfHeld: true/.test(src("services/coEventAnnouncement.ts")));
check("the gate's reasons carry ids and field names, never words or another member's status", (() => { const c = G.memberRuleCheck([pref({ id: "77", rule: { max_per_day: 1 } })], { now, cls: "unsolicited", channel: "text", sent: one }); return c.reason === "the member's own rule holds it (rule 77: 1 of 1 today)"; })());
check("each read is one member's rows", /WHERE user_id = \$1 AND sent_at > NOW\(\)/.test(src("harness/notifyGate.ts")) && /WHERE owner_user_id = \$1 AND relation = '\$\{PREF_RELATION\}'/.test(src("services/memberPreferences.ts")));

console.log(`preferences enforce: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
