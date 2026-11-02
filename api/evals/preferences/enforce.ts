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
// A reply is never held.
db.inbound.set(A, new Date(Date.now() - 5 * 60_000));
r = await exempt(A, { answers: { askedAt: new Date(Date.now() - 4 * 60_000) } });
check("Cue's answer to the text they just sent goes (a task started from it, minutes later)", r.sent === true);
check("and isn't counted toward their cap", db.sends.some((s) => s.notify_class === "reply"));
r = await exempt(A, { answers: { askedAt: new Date(Date.now() - 20 * 3_600_000) } });
check("a look-out started from an older message is a delivery, not a reply: held", r.sent === false);
// In-room and calls.
check("in-room texts (the close included) ask the gate right before they go", /const rule = await memberRuleGate\(pool, \{ userId, now: new Date\(\), cls: "unsolicited", channel: "text" \}\);\n  if \(!rule\.pass\) \{[\s\S]{0,300}return false;\n  \}\n  if \(opts\.close\) return true;/.test(src("harness/proactive.ts")));
const callState = (memberRule: any): any => ({ callStatus: null, callStatusUpdatedAt: null, optedOut: false, subscriptionActive: true, requireSubscription: false, localHourOk: true, lastCallAt: null, evidence: { scheduledCallDue: true, recentInboundText: true, routerPlaceCallDecision: true, cadenceSet: true, autoIntakeEligible: true }, memberRule });
const held = { name: G.MEMBER_RULE, pass: false, reason: "rule" };
check("a check-in call and an intake call Cue starts are held by their rule", !CG.decideCall(callState(held), { kind: "checkin_cadence" }, new Date()).allowed && !CG.decideCall(callState(held), { kind: "auto_intake" }, new Date()).allowed && !CG.decideCall(callState(held), { kind: "scheduled_call" }, new Date()).allowed);
check("a call they ask for right now is never held", CG.decideCall(callState(held), { kind: "router_decision" }, new Date()).allowed);
check("the call gate reads the rule for the call channel, for the kind it decides", /memberRuleGate\(pool, \{ userId, now, cls: CALL_CLASS\[kind\], channel: "call" \}\)/.test(src("harness/callGate.ts")));

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
const results = await Promise.all([1, 2, 3, 4].map((i) => exempt(A, { targetKey: `task:race:${i}` })));
check("four jobs at once, a cap of one: exactly one message goes", results.filter((x) => x.sent).length === 1 && db.outbox.length === 3);
const retry = await exempt(A, { targetKey: "task:race:1" });
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
check("three sources ready in one window go as one bundle: one lead, the other two ride in it", evAll.eligible.length === 3 && sibs.length === 2 && new Set([lead.id, ...sibs.map((s) => s.id)]).size === 3);
const after = PR.evaluateCandidates({ now: new Date(at910.getTime() + 15 * 60_000), timezone: "America/Los_Angeles", optedOut: false, candidates: [cand("event_offer", { askId: "ask-2" })], sends: [{ type: "event_offer", targetKey: "event_offer:bundle", topicKey: "b", sentAt: at910, exempt: true }], lastInboundAt: null, joinedAt: joined } as any);
check("and nothing else proactive goes in that window", !after.eligible.length);

// ---------------------------------------------------------------- every send path asks the gate (the proof)
// Each place a message leaves (a Sendblue send, a dial, or the shared send functions) is listed here with what gates it. A new one
// fails this test until it's listed: gated, or a reply/system send with its reason.
const SITES: Record<string, { n: number; gate: string }> = {
  "harness/proactive.ts": { n: 6, gate: "sendWithLedger (2) and sendExempt (4): memberRuleGate inside the lock, before the ledger row" },
  "routes/sendblue.ts": { n: 5, gate: "reply: the turn's own answer, STOP/START confirmations, 'Calling you now'" },
  "routes/co.ts": { n: 1, gate: "missed-call follow-up: memberRuleGate before it" },
  "services/eventScoring.ts": { n: 2, gate: "in-room: inRoomSendAllowed (memberRuleGate)" },
  "services/eventUnmatchedFollowUp.ts": { n: 1, gate: "in-room close: inRoomSendAllowed (memberRuleGate)" },
  "services/networkIntroNudge.ts": { n: 1, gate: "reply: the reveal answers their yes" },
  "services/documentDelivery.ts": { n: 1, gate: "deps.send after claimCoInitiatedSend (owed or Cue's own), PDF retry: memberRuleGate" },
  "services/callTools.ts": { n: 1, gate: "reply: a text they asked for on the call they're on" },
  "agent/conversationTools.ts": { n: 1, gate: "reply: the contact card in the turn" },
  "harness/failureCount.ts": { n: 1, gate: "team: ops alert to the team phone, never a member" },
  "otpActions.ts": { n: 1, gate: "system: sign-in codes" },
  "services/sendblue.ts": { n: 1, gate: "the wrapper itself" },
  "services/callTrigger.ts": { n: 1, gate: "dial: decideCall's member_rule" },
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
const ps = src("harness/proactive.ts");
const body = (name: string) => ps.slice(ps.indexOf(`async function ${name}(`), ps.indexOf("\n}\n", ps.indexOf(`async function ${name}(`)));
check("the shared send functions each ask the member's rules", ["sendWithLedger", "sendExempt", "claimCoInitiatedSend", "inRoomSendAllowed"].every((f) => /memberRuleGate\(/.test(body(f))));
check("every proactive type has a class", Object.keys(PR.TYPE_POLICY).every((t) => t in G.PROACTIVE_CLASS) && ["event_change", "call_reminder", "missed_call", "co_event", "direct_ask", "search_result", "task_update", "call_confirm", "task_window", "in_room"].every((t) => t in G.PROACTIVE_CLASS));
check("every sendExempt caller with no retry of its own queues what's held", /queueIfHeld: true/.test(src("agent/eventChangeNotification.ts")) && /queueIfHeld: true/.test(src("jobs/scheduledCall.ts")) && /queueIfHeld: true/.test(src("jobs/index.ts")) && /queueIfHeld: true/.test(src("services/coEventAnnouncement.ts")));
check("the gate's reasons carry ids and field names, never words or another member's status", (() => { const c = G.memberRuleCheck([pref({ id: "77", rule: { max_per_day: 1 } })], { now, cls: "unsolicited", channel: "text", sent: one }); return c.reason === "the member's own rule holds it (rule 77: 1 of 1 today)"; })());
check("each read is one member's rows", /WHERE user_id = \$1 AND sent_at > NOW\(\)/.test(src("harness/notifyGate.ts")) && /WHERE owner_user_id = \$1 AND relation = '\$\{PREF_RELATION\}'/.test(src("services/memberPreferences.ts")));

console.log(`preferences enforce: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
