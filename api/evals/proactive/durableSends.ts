// Durable held sends (services/deferredSends.ts, 2026-10-07). A text due outside the member's hours used to wait in an
// in-process setTimeout that a restart or deploy lost, after the caller had already recorded it as sent. Layer 1: an
// in-memory fake of the tables involved, sendblue stubbed, zero tokens.   npx tsx evals/proactive/durableSends.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.CO_RELAY = "on";
delete process.env.PROACTIVE_PAUSED;
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");
const P = await import("../../src/harness/proactive.js");
const D = await import("../../src/services/deferredSends.js");
const R = await import("../../src/services/relay.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- the fake store
type Row = Record<string, any>;
type Db = {
  users: Map<string, { phone_number: string; sms_opted_out: boolean; archived_at: Date | null; first_name: string; city: string | null }>;
  deferred: Row[];
  proactive: Set<string>;
  memories: { user_id: string; type: string; content: string }[];
  facts: { owner: string; relation: string; label: string }[];
  reminders: Row[];
  relays: Row[];
  zones: Map<string, string>;
  outbound: { user_id: string; content: string; sent_at: Date }[];
};
const fresh = (): Db => ({ users: new Map(), deferred: [], proactive: new Set(), memories: [], facts: [], reminders: [], relays: [], zones: new Map(), outbound: [] });
let db = fresh();
const txKeys: string[] = [];
let retryColumnMissing = false;
let seq = 1;
const now = () => new Date(clockMs());
let fixedClock: number | null = null;
const clockMs = () => fixedClock ?? Date.now();
const copy = <T,>(r: T): T => ({ ...(r as any) });

async function handle(rawSql: string, args: any[] = []): Promise<{ rows: any[] }> {
  const sql = rawSql.replace(/\s+/g, " ").trim();
  // Let other async work interleave, like a real round trip (the double-run test depends on it).
  await new Promise((r) => setImmediate(r));
  // A send's ledger row is written inside its transaction: a failed send rolls it back (harness/proactive.ts sendExempt), so a retry
  // isn't read as "already sent".
  if (/^ROLLBACK/.test(sql)) { for (const k of txKeys.splice(0)) db.proactive.delete(k); return { rows: [] }; }
  if (/^(BEGIN|COMMIT)/.test(sql)) { txKeys.length = 0; return { rows: [] }; }
  if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
  if (/^SELECT COALESCE\(sms_opted_out, false\) AS opted_out FROM users/.test(sql)) return { rows: [{ opted_out: db.users.get(args[0])?.sms_opted_out === true }] };
  if (/^INSERT INTO proactive_sends/.test(sql)) {
    const k = `${args[0]}|${args[2]}`;
    if (db.proactive.has(k)) return { rows: [] };
    db.proactive.add(k);
    txKeys.push(k);
    return { rows: [{ id: seq++ }] };
  }
  if (/^INSERT INTO co_memories/.test(sql)) { db.memories.push({ user_id: args[0], type: args[1], content: args[2] }); return { rows: [{ id: seq++ }] }; }
  if (/^INSERT INTO co_facts/.test(sql)) { db.facts.push({ owner: args[0], relation: args[2], label: args[3] }); return { rows: [] }; }
  // Their stored zone (memberTime.ts memberZone, which the reminder and relay sends read since the 2026-10-29 place fix): the zone their
  // city stands for here, stored with that city.
  if (/^SELECT city, timezone, timezone_city FROM co_profiles WHERE user_id = \$1/.test(sql)) { const u = db.users.get(args[0]); return { rows: u ? [{ city: u.city, timezone: db.zones.get(u.city) ?? null, timezone_city: u.city }] : [] }; }
  if (/FROM geocode_cache/.test(sql)) { const z = db.zones.get(args[0]); return { rows: z ? [{ lat: 0, lng: 0, timezone: z }] : [] }; }
  // deferred_sends
  if (/^INSERT INTO deferred_sends/.test(sql)) {
    if (db.deferred.some((d) => d.user_id === args[0] && d.target_key === args[3])) return { rows: [] };
    const row = { id: seq++, user_id: args[0], phone_number: args[1], type: args[2], target_key: args[3], messages: JSON.parse(args[4]), timezone: args[5], after_kind: args[6], after_payload: args[7] ? JSON.parse(args[7]) : null, due_at: new Date(args[8]), status: "queued", attempts: 0, claimed_at: null, sent_at: null, error: null };
    db.deferred.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (/^SELECT id, status FROM deferred_sends/.test(sql)) return { rows: db.deferred.filter((d) => d.user_id === args[0] && d.target_key === args[1]).map(copy) };
  if (/FROM deferred_sends d JOIN users u/.test(sql)) {
    const [at, stale] = [new Date(args[0]).getTime(), new Date(args[1]).getTime()];
    return {
      rows: db.deferred
        .filter((d) => (d.status === "queued" && d.due_at.getTime() <= at) || (d.status === "sending" && d.claimed_at && d.claimed_at.getTime() < stale))
        .sort((a, b) => a.due_at - b.due_at)
        .map((d) => ({ ...d, phone_number: db.users.get(d.user_id)?.phone_number ?? d.phone_number, archived: !!db.users.get(d.user_id)?.archived_at })),
    };
  }
  if (/^UPDATE deferred_sends SET status = 'sending'/.test(sql)) {
    const d = db.deferred.find((x) => x.id === args[0] && x.attempts === args[1] && ["queued", "sending"].includes(x.status));
    if (!d) return { rows: [] };
    Object.assign(d, { status: "sending", claimed_at: new Date(args[2]), attempts: d.attempts + 1 });
    return { rows: [{ id: d.id }] };
  }
  if (/^UPDATE deferred_sends SET status = \$2, error = \$3, sent_at = \$4/.test(sql)) {
    const d = db.deferred.find((x) => x.id === args[0] && x.attempts === args[4]);
    if (d) Object.assign(d, { status: args[1], error: args[2], sent_at: args[3] });
    return { rows: [] };
  }
  if (/^UPDATE deferred_sends SET status = 'queued', due_at = \$2/.test(sql)) {
    const d = db.deferred.find((x) => x.id === args[0] && x.attempts === args[3]);
    if (d) Object.assign(d, { status: "queued", due_at: new Date(args[1]), error: args[2] });
    return { rows: [] };
  }
  if (/^SELECT 1 FROM deferred_sends WHERE user_id = \$1 AND target_key = \$2/.test(sql)) return { rows: db.deferred.filter((d) => d.user_id === args[0] && d.target_key === args[1] && ["queued", "sending"].includes(d.status)) };
  // member_reminders
  if (/^SELECT r\.user_id, r\.what, r\.queued_at, u\.phone_number FROM member_reminders r JOIN users u ON u\.id = r\.user_id WHERE r\.id = \$1/.test(sql)) {
    const r = db.reminders.find((x) => x.id === args[0]);
    return { rows: r ? [{ user_id: r.user_id, what: r.what, queued_at: r.queued_at, phone_number: db.users.get(r.user_id)?.phone_number }] : [] };
  }
  if (/^SELECT 1 FROM outbound_messages WHERE user_id = \$1 AND sender = 'co' AND sent_at > \$2 AND content = \$3/.test(sql)) {
    return { rows: db.outbound.filter((o) => o.user_id === args[0] && o.sent_at.getTime() > new Date(args[1]).getTime() && o.content === args[2]).map(() => ({ "?column?": 1 })) };
  }
  if (/FROM member_reminders r JOIN users u/.test(sql)) {
    if (retryColumnMissing && /retry_at/.test(sql)) throw new Error('column r.retry_at does not exist');
    return { rows: db.reminders.filter((r) => !r.sent_at && !r.queued_at && r.due_at.getTime() <= Date.now() && r.due_at.getTime() > Date.now() - 2 * 86_400_000 && (!r.retry_at || r.retry_at.getTime() <= Date.now())).map((r) => ({ id: r.id, user_id: r.user_id, what: r.what, phone_number: db.users.get(r.user_id)?.phone_number, city: db.users.get(r.user_id)?.city })) };
  }
  if (/^UPDATE member_reminders SET queued_at = NOW\(\)/.test(sql)) {
    const r = db.reminders.find((x) => x.id === args[0] && !x.sent_at && !x.queued_at);
    if (!r) return { rows: [] };
    r.queued_at = now();
    return { rows: [{ id: r.id }] };
  }
  if (/^UPDATE member_reminders SET attempts = attempts \+ 1/.test(sql)) {
    const r = db.reminders.find((x) => x.id === args[0] && !x.sent_at);
    if (!r) return { rows: [] };
    r.attempts = (r.attempts ?? 0) + 1;
    return { rows: [{ user_id: r.user_id, attempts: r.attempts }] };
  }
  if (/^UPDATE member_reminders SET queued_at = NULL, retry_at = \$2/.test(sql)) { const r = db.reminders.find((x) => x.id === args[0] && !x.sent_at); if (r) Object.assign(r, { queued_at: null, retry_at: new Date(args[1]) }); return { rows: [] }; }
  if (/^UPDATE member_reminders SET sent_at = COALESCE/.test(sql)) { const r = db.reminders.find((x) => x.id === args[0]); if (r) r.sent_at ??= now(); return { rows: [] }; }
  if (/FROM member_reminders r JOIN deferred_sends d/.test(sql)) {
    return { rows: db.reminders.filter((r) => r.user_id === args[0] && !r.sent_at && r.queued_at && db.deferred.some((d) => d.user_id === r.user_id && d.target_key === `reminder:${r.id}` && ["queued", "sending"].includes(d.status))) };
  }
  // member_relays and what relayMessage reads
  if (/^SELECT content FROM co_memories/.test(sql)) return { rows: [] };
  if (/^WITH mine AS/.test(sql)) return { rows: [...db.users.entries()].filter(([id]) => id !== args[0]).map(([id, u]) => ({ id, first_name: u.first_name, source: "introduced" })) };
  if (/^SELECT count\(\*\)::int AS n FROM member_relays/.test(sql)) return { rows: [{ n: db.relays.filter((r) => r.from_user === args[0] && r.to_user === args[1] && ["sent", "queued"].includes(r.status)).length }] };
  if (/^SELECT u.phone_number, cp.city FROM users u/.test(sql)) { const u = db.users.get(args[0]); return { rows: u ? [{ phone_number: u.phone_number, city: u.city }] : [] }; }
  if (/^INSERT INTO member_relays/.test(sql)) { const r = { id: seq++, from_user: args[0], to_user: args[1], message: args[2], status: "pending", created_at: now(), sent_at: null }; db.relays.push(r); return { rows: [{ id: r.id }] }; }
  if (/^UPDATE member_relays SET status = 'queued'/.test(sql)) { const r = db.relays.find((x) => x.id === args[0] && x.status === "pending"); if (r) r.status = "queued"; return { rows: [] }; }
  if (/^UPDATE member_relays SET status = 'sent'/.test(sql)) { const r = db.relays.find((x) => x.id === args[0]); if (r) { r.status = "sent"; r.sent_at ??= now(); } return { rows: [] }; }
  if (/^UPDATE member_relays SET status = \$2/.test(sql)) { const r = db.relays.find((x) => x.id === args[0] && ["pending", "queued"].includes(x.status)); if (r) r.status = args[1]; return { rows: [] }; }
  if (/FROM member_relays r JOIN users uf/.test(sql)) {
    return {
      rows: db.relays
        .filter((r) => (r.from_user === args[0] || r.to_user === args[0]) && ["sent", "queued"].includes(r.status))
        .map((r) => ({ ...r, created_at: r.sent_at ?? r.created_at, from_name: db.users.get(r.from_user)?.first_name, to_name: db.users.get(r.to_user)?.first_name })),
    };
  }
  return { rows: [] }; // harness_decisions, outbound_messages, embeddings: not under test
}
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });

// Every text that would leave: captured, never sent.
const outbox: { to: string; content: string }[] = [];
(sendblue as any).messages.send = async (b: any) => { outbox.push({ to: b.number, content: b.content }); return { message_handle: `t-${outbox.length}` }; };

// Long timers are the old behavior: any setTimeout longer than a minute during a send is a held send in memory.
const longTimers: number[] = [];
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => { if ((ms ?? 0) > 60_000) longTimers.push(ms!); return realSetTimeout(fn, ms, ...rest); };

// A zone whose local hour right now is `hour` (relay and reminder paths read the real clock).
function zoneAtHour(hour: number): string {
  const utc = new Date().getUTCHours();
  let off = (hour - utc + 24) % 24;
  if (off > 14) off -= 24;
  return off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
}
const PHONE_A = "+14155550150";
const PHONE_B = "+14155550151";
function seed() {
  db = fresh();
  outbox.length = 0;
  longTimers.length = 0;
  db.users.set("ua", { phone_number: PHONE_A, sms_opted_out: false, archived_at: null, first_name: "Jordan", city: "Nightville" });
  db.users.set("ub", { phone_number: PHONE_B, sms_opted_out: false, archived_at: null, first_name: "Ellis", city: "Nightville" });
  db.zones.set("Nightville", zoneAtHour(2));
}
const memLines = (u: string) => db.memories.filter((m) => m.user_id === u && m.type === "text_exchange").map((m) => m.content);

// ---------------------------------------------------------------- 1. a night-time send is enqueued, not timed out
{
  seed();
  const tz = "America/Los_Angeles";
  const night = new Date("2026-10-08T06:30:00Z"); // 11:30pm in LA
  const r = await P.sendExemptWhenAllowed({ userId: "ua", phoneNumber: PHONE_A, type: "event_change", targetKey: "stale:x:sold_out", messages: ["Heads up on the gallery night: it's sold out now."], timezone: tz, now: night });
  check("night: nothing goes out now", outbox.length === 0 && !r.sent);
  check("night: it is queued as a row due at their 8am", r.queued && db.deferred.length === 1 && db.deferred[0].status === "queued" && db.deferred[0].due_at.toISOString() === "2026-10-08T15:00:00.000Z");
  check("night: no in-process timer holds it", longTimers.length === 0);
  check("night: no 'Co replied' line or 'texted' fact while it's only queued", memLines("ua").length === 0 && db.facts.length === 0);
  const again = await P.sendExemptWhenAllowed({ userId: "ua", phoneNumber: PHONE_A, type: "event_change", targetKey: "stale:x:sold_out", messages: ["Heads up on the gallery night: it's sold out now."], timezone: tz, now: night });
  check("queueing the same thing twice keeps one row", again.queued && db.deferred.length === 1);
  check("the setTimeout hold is gone from the source", !/setTimeout\(/.test(src("harness/proactive.ts").slice(src("harness/proactive.ts").indexOf("export async function sendExemptWhenAllowed"), src("harness/proactive.ts").indexOf("// Layer 6 in-room nudges"))) && !/setTimeout/.test(src("services/callFollowThrough.ts")));

  // ---------------------------------------------------------------- 2. survives a restart, sends once at 8am
  // A restart: the process's memory is gone; only the rows survive (round-tripped, as a database would hand them back).
  const persisted = JSON.parse(JSON.stringify(db.deferred));
  const survivors = { ...fresh(), users: db.users, zones: db.zones, deferred: persisted.map((d: any) => ({ ...d, due_at: new Date(d.due_at), claimed_at: d.claimed_at ? new Date(d.claimed_at) : null })) };
  db = survivors;
  const D2 = await import(`../../src/services/deferredSends.ts?restart=${Date.now()}`);
  const early = await D2.runDueDeferredSends(new Date("2026-10-08T14:59:00Z"));
  check("after the restart: 7:59am, nothing yet", early.claimed === 0 && outbox.length === 0);
  const eight = await D2.runDueDeferredSends(new Date("2026-10-08T15:00:00Z"));
  check("after the restart: at 8am it sends, once", eight.sent === 1 && outbox.length === 1 && outbox[0].content.startsWith("Heads up on the gallery night"));
  check("sent: the row is marked sent with its time", db.deferred[0].status === "sent" && new Date(db.deferred[0].sent_at).toISOString() === "2026-10-08T15:00:00.000Z");
  check("sent: the 'Co replied' line and the 'texted' fact are written now, on delivery", memLines("ua").length === 1 && db.facts.some((f) => f.owner === "ua" && f.relation === "texted"));
  const later = await D2.runDueDeferredSends(new Date("2026-10-08T15:05:00Z"));
  check("a later run sends nothing more", later.claimed === 0 && outbox.length === 1);
}

// ---------------------------------------------------------------- 3. a reminder isn't recorded as sent until it sends
{
  seed();
  db.reminders.push({ id: 900, user_id: "ua", what: "call Sam about the lease", due_at: new Date(Date.now() - 60_000), sent_at: null, queued_at: null });
  const n = await R.sendDueReminders();
  const rem = db.reminders[0];
  check("reminder due at 2am their time: queued, nothing sent", n === 1 && outbox.length === 0 && db.deferred.length === 1 && db.deferred[0].target_key === "reminder:900");
  check("reminder: sent_at stays empty while queued (only queued_at is claimed)", rem.sent_at === null && rem.queued_at instanceof Date);
  check("reminder: no 'Co replied: Reminder…' line while queued", !memLines("ua").some((l) => /Reminder you asked for/.test(l)));
  const facts = await R.reminderFacts("ua");
  check("reminder: the reply reads it as queued, not sent", facts.length === 1 && /queued for their morning and has NOT been sent/.test(facts[0]));
  const second = await R.sendDueReminders();
  check("reminder: the 5-minute cron doesn't pick a claimed reminder up again", second === 0 && db.deferred.length === 1);
  const due = db.deferred[0].due_at as Date;
  await D.runDueDeferredSends(due);
  check("reminder at their 8am: sent once, and only now is sent_at set", outbox.length === 1 && /Reminder you asked for: call Sam/.test(outbox[0].content) && rem.sent_at instanceof Date);
  check("reminder: the 'Co replied' line is written once, on delivery", memLines("ua").filter((l) => /Reminder you asked for/.test(l)).length === 1);
  check("reminder: no longer reads as queued", (await R.reminderFacts("ua")).length === 0);
}

// ---------------------------------------------------------------- 3b. a failed reminder gives its claim back and tries again (closure audit 11-02)
// Reminder 2 on dev: its send failed once (Sendblue 401) and queued_at stayed set, so the 5-minute cron never picked it up again.
{
  seed();
  db.zones.set("Nightville", zoneAtHour(12));
  db.reminders.push({ id: 910, user_id: "ua", what: "bring up the paralegal search", due_at: new Date(Date.now() - 60_000), sent_at: null, queued_at: null, attempts: 0, retry_at: null });
  const rem = db.reminders[0];
  const realSend = (sendblue as any).messages.send;
  let failNext = 1;
  (sendblue as any).messages.send = async (b: any) => { if (failNext > 0) { failNext--; throw new Error("401 Invalid Credentials"); } return realSend(b); };
  await R.sendDueReminders();
  check("a 401 at noon their time: nothing went out", outbox.length === 0 && rem.sent_at === null);
  check("...the claim is given back, with its first retry about 5 minutes out", rem.queued_at === null && rem.attempts === 1 && rem.retry_at instanceof Date && Math.abs(rem.retry_at.getTime() - (Date.now() + R.REMINDER_RETRY.firstMs)) < 30_000, rem);
  check("...and not before then", (await R.sendDueReminders()) === 0 && outbox.length === 0);
  rem.retry_at = new Date(Date.now() - 1000);
  await R.sendDueReminders();
  check("the retry sends it once, and only now is sent_at set", outbox.length === 1 && /Reminder you asked for: bring up the paralegal search/.test(outbox[0].content) && rem.sent_at instanceof Date);
  rem.retry_at = new Date(Date.now() - 1000);
  await R.sendDueReminders();
  check("never a second text after it went", outbox.length === 1);
  // A try that went out but whose record didn't (its key is on the send ledger): recorded as sent, never sent again.
  seed();
  db.zones.set("Nightville", zoneAtHour(12));
  db.reminders.push({ id: 911, user_id: "ua", what: "call the landlord", due_at: new Date(Date.now() - 60_000), sent_at: null, queued_at: null, attempts: 1, retry_at: new Date(Date.now() - 1000) });
  db.proactive.add("ua|reminder:911");
  await R.sendDueReminders();
  check("a retry whose earlier try already went: no second text, recorded as sent", outbox.length === 0 && db.reminders[0].sent_at instanceof Date);
  // Bounded: a send that keeps failing is tried five times in all, spaced 5, 20, 80 and 320 minutes, then left alone.
  seed();
  db.zones.set("Nightville", zoneAtHour(12));
  db.reminders.push({ id: 912, user_id: "ua", what: "pay the deposit", due_at: new Date(Date.now() - 60_000), sent_at: null, queued_at: null, attempts: 0, retry_at: null });
  (sendblue as any).messages.send = async () => { throw new Error("401 Invalid Credentials"); };
  const gaps: number[] = [];
  for (let i = 0; i < 8; i++) {
    const r = db.reminders[0];
    if (r.retry_at) r.retry_at = new Date(Date.now() - 1000);
    const before = Date.now();
    await R.sendDueReminders();
    if (r.retry_at && r.queued_at === null) gaps.push(Math.round((r.retry_at.getTime() - before) / 60_000));
  }
  const r912 = db.reminders[0];
  check("always failing: five tries, then it stays claimed and isn't tried again", r912.attempts === 5 && r912.queued_at instanceof Date && r912.sent_at === null, r912);
  check("...spaced 5, 20, 80 and 320 minutes", JSON.stringify(gaps.slice(0, 4)) === "[5,20,80,320]", gaps);
  check("the backoff never lands in their quiet hours: a 2am retry waits for 8am", (() => {
    const at = R.reminderRetryAt(1, new Date("2026-10-23T08:58:00Z"), "America/Los_Angeles", P.localHourOk, (a, z) => P.nextLocalHour(a, z, P.RULES.startHour));
    return at?.toISOString() === "2026-10-23T15:00:00.000Z";
  })());
  check("past the last try there's no retry", R.reminderRetryAt(R.REMINDER_RETRY.maxAttempts, new Date(), null, () => true, (a) => a) === null);
  (sendblue as any).messages.send = realSend;
  // Opted out: skipped, the claim kept, never retried.
  seed();
  db.zones.set("Nightville", zoneAtHour(12));
  db.users.get("ua")!.sms_opted_out = true;
  db.reminders.push({ id: 913, user_id: "ua", what: "renew the permit", due_at: new Date(Date.now() - 60_000), sent_at: null, queued_at: null, attempts: 0, retry_at: null });
  await R.sendDueReminders();
  const r913 = db.reminders[0];
  check("opted out: nothing sent, the claim kept, no retry set", outbox.length === 0 && r913.queued_at instanceof Date && !r913.retry_at && (r913.attempts ?? 0) === 0, r913);
  check("...and a later run doesn't try again", (await R.sendDueReminders()) === 0 && outbox.length === 0);
  // A send that threw where it can't be told whether it went (a timeout, a 5xx): checked before any retry (review of #352).
  check("only failures before delivery retry blind: 4xx, our own refusals, a pause", R.failedBeforeDelivery("401 Invalid Credentials") && R.failedBeforeDelivery("429 Too Many Requests") && R.failedBeforeDelivery("sendblue: send breaker open for ...0150, refusing to send") && R.failedBeforeDelivery("proactive outreach is paused"));
  check("...a timeout, a 5xx, a dropped connection or no reason don't", !R.failedBeforeDelivery("Request timed out.") && !R.failedBeforeDelivery("502 Bad Gateway") && !R.failedBeforeDelivery("Connection error.") && !R.failedBeforeDelivery(undefined));
  // Sendblue's list through the real client shape: the SDK's Messages class, whose methods live on its prototype (the send wrapper's
  // spread of client.messages copies none of them, round 2 review of #352). Patched on that prototype, so the module's own client
  // instance answers it, exactly as in production; a lookup through the wrapper would never reach it.
  const { SendblueAPI } = await import("sendblue");
  const MessagesProto: any = Object.getPrototypeOf(new SendblueAPI({ apiKey: "x", apiSecret: "y" }).messages);
  const realList = MessagesProto.list;
  let listCalls = 0;
  check("the send wrapper has no list of its own (why the lookup reads the SDK client)", typeof (sendblue as any).messages.list === "undefined" && typeof realList === "function");
  const timeoutCase = async (o: { list: () => Promise<any>; ours?: boolean }) => {
    seed();
    db.zones.set("Nightville", zoneAtHour(12));
    db.reminders.push({ id: 920, user_id: "ua", what: "send the lease back", due_at: new Date(Date.now() - 60_000), sent_at: null, queued_at: null, attempts: 0, retry_at: null });
    if (o.ours) db.outbound.push({ user_id: "ua", content: "Reminder you asked for: send the lease back", sent_at: new Date() });
    (sendblue as any).messages.send = async () => { throw new Error("Request timed out."); };
    MessagesProto.list = async (...a: any[]) => { listCalls++; return o.list(); };
    await R.sendDueReminders();
    (sendblue as any).messages.send = realSend;
    MessagesProto.list = realList;
    return db.reminders[0];
  };
  const notThere = await timeoutCase({ list: async () => ({ data: [] }) });
  check("a timeout Sendblue's record says didn't go: released and retried (its list was really read)", listCalls === 1 && notThere.queued_at === null && notThere.retry_at instanceof Date && notThere.sent_at === null, notThere);
  const there = await timeoutCase({ list: async () => ({ data: [{ number: PHONE_A, content: "Reminder you asked for: send the lease back", is_outbound: true }] }) });
  check("a timeout Sendblue's record shows went: recorded as sent, never retried", there.sent_at instanceof Date && !there.retry_at && (await R.sendDueReminders()) === 0 && outbox.length === 0, there);
  const unknown = await timeoutCase({ list: async () => { throw new Error("503"); } });
  check("a timeout that can't be checked: left claimed, not retried, not marked sent", unknown.queued_at instanceof Date && !unknown.retry_at && unknown.sent_at === null && (await R.sendDueReminders()) === 0, unknown);
  const ours = await timeoutCase({ ours: true, list: async () => { throw new Error("not reached"); } });
  check("a timeout our own outbound record shows went: recorded as sent", ours.sent_at instanceof Date && !ours.retry_at, ours);
  // The deferred queue words a thrown send "error: <message>": a 401 at their 8am is still known not to have gone, and is retried.
  check("the status is read past the queue's prefix", R.sendFailureStatus("error: 401 Invalid Credentials") === 401 && R.sendFailureStatus("401 Invalid Credentials") === 401 && R.failedBeforeDelivery("error: 401 Invalid Credentials") && !R.failedBeforeDelivery("error: 502 Bad Gateway") && !R.failedBeforeDelivery("error: Request timed out.") && R.sendFailureStatus("error: Request timed out.") === null);
  seed();
  db.reminders.push({ id: 922, user_id: "ua", what: "book the vet", due_at: new Date(Date.now() - 60_000), sent_at: null, queued_at: null, attempts: 0, retry_at: null });
  await R.sendDueReminders(); // 2am their time: queued for their 8am
  (sendblue as any).messages.send = async () => { throw new Error("401 Invalid Credentials"); };
  let listed = 0;
  MessagesProto.list = async () => { listed++; return { data: [] }; };
  let at = db.deferred[0].due_at as Date;
  for (let i = 0; i < 3; i++) { await D.runDueDeferredSends(at); at = new Date(db.deferred[0].due_at.getTime()); }
  (sendblue as any).messages.send = realSend;
  MessagesProto.list = realList;
  const r922 = db.reminders[0];
  check("a 401 at their 8am through the deferred queue: three tries there, then the reminder is released with its retry", db.deferred[0].status === "failed" && /^error: 401/.test(db.deferred[0].error ?? "") && r922.queued_at === null && r922.attempts === 1 && r922.retry_at instanceof Date && r922.sent_at === null, { d: db.deferred[0], r922 });
  check("...known not to have gone, so Sendblue wasn't asked", listed === 0);
  // The retry column missing (its migration didn't run): the old read still sends due reminders.
  seed();
  db.zones.set("Nightville", zoneAtHour(12));
  db.reminders.push({ id: 921, user_id: "ua", what: "water the plants", due_at: new Date(Date.now() - 60_000), sent_at: null, queued_at: null });
  retryColumnMissing = true;
  await R.sendDueReminders();
  retryColumnMissing = false;
  check("the retry column missing never stops reminders: the old read sends it", outbox.length === 1 && db.reminders[0].sent_at instanceof Date);
  check("migration: the retry columns", /member_reminders ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0/.test(src("db/migrations.ts")) && /member_reminders ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ/.test(src("db/migrations.ts")));
}

// ---------------------------------------------------------------- 4. a queued relay shows as queued
{
  seed();
  const r = await R.relayMessage({ fromUserId: "ua", fromFirstName: "Jordan", to: "Ellis", message: "running ten minutes late tomorrow", currentText: "tell Ellis running ten minutes late tomorrow" });
  const relay = db.relays[0];
  check("relay at night: queued, nothing sent; the sender's note is the same one a sent relay gets (2026-11-02: nothing about the other side's hours)", r.ok && (r as any).queued === true && outbox.length === 0 && relay?.status === "queued" && (r as any).note === R.relaySenderNote("Ellis"));
  check("relay: the recipient has no 'Co replied' line yet", memLines("ub").length === 0);
  const senderFacts = await R.relayFacts("ua");
  check("relayFacts (sender): never claims it reached them, never says queued or why", senderFacts.length === 1 && /they asked Cue to pass a message to Ellis/.test(senderFacts[0]) && /Never say when it reached Ellis or whether it has yet/.test(senderFacts[0]) && !/queued|morning|hours/.test(senderFacts[0]));
  check("relayFacts (recipient): nothing until it reaches them", (await R.relayFacts("ub")).length === 0);
  const again = await R.relayMessage({ fromUserId: "ua", fromFirstName: "Jordan", to: "Ellis", message: "running ten minutes late tomorrow", currentText: "tell Ellis running ten minutes late tomorrow" });
  check("relay: a queued one still counts toward one per pair per day", !again.ok && (again as any).reason === "rate_limited");
  await D.runDueDeferredSends(db.deferred[0].due_at);
  check("relay at their 8am: sent once, status sent, sent_at set", outbox.length === 1 && relay.status === "sent" && relay.sent_at instanceof Date && /Jordan asked me to pass this along/.test(outbox[0].content));
  check("relay: the recipient's 'Co replied' line is written once, on delivery", memLines("ub").length === 1);
  check("relayFacts after delivery: the sender's reads exactly as while it waited; the recipient's appears", (await R.relayFacts("ua"))[0] === senderFacts[0] && /Jordan asked Cue to pass this along/.test((await R.relayFacts("ub"))[0] ?? ""));
}
{
  // Inside their hours: sent now, recorded once (the old code wrote the recipient's line twice: once itself, once in sendExempt).
  seed();
  db.zones.set("Nightville", zoneAtHour(12));
  const r = await R.relayMessage({ fromUserId: "ua", fromFirstName: "Jordan", to: "Ellis", message: "running ten minutes late tomorrow", currentText: "tell Ellis running ten minutes late tomorrow" });
  check("relay by day: sent now, status sent, one 'Co replied' line", r.ok && !(r as any).queued && outbox.length === 1 && db.relays[0].status === "sent" && memLines("ub").length === 1 && db.deferred.length === 0);
}

// ---------------------------------------------------------------- 5. double cron runs don't double-send
{
  seed();
  for (let i = 0; i < 3; i++) {
    await P.sendExemptWhenAllowed({ userId: i % 2 ? "ub" : "ua", phoneNumber: i % 2 ? PHONE_B : PHONE_A, type: "direct_ask", targetKey: `k${i}`, messages: [`message ${i} for the morning`], timezone: "America/Los_Angeles", now: new Date("2026-10-08T06:30:00Z") });
  }
  const at = new Date("2026-10-08T15:00:00Z");
  const [a, b] = await Promise.all([D.runDueDeferredSends(at), D.runDueDeferredSends(at)]);
  check(`two overlapping runs: each row claimed once (${a.claimed}+${b.claimed})`, a.claimed + b.claimed === 3);
  check("two overlapping runs: three rows, three texts", outbox.length === 3 && new Set(outbox.map((o) => o.content)).size === 3 && db.deferred.every((d) => d.status === "sent"));
  // The process died mid-send: the row was left 'sending' after its text went out. Re-claimed later, it's "already sent".
  seed();
  await P.sendExemptWhenAllowed({ userId: "ua", phoneNumber: PHONE_A, type: "direct_ask", targetKey: "crash", messages: ["the crash case"], timezone: "America/Los_Angeles", now: new Date("2026-10-08T06:30:00Z") });
  Object.assign(db.deferred[0], { status: "sending", claimed_at: new Date("2026-10-08T15:00:00Z"), attempts: 1 });
  db.proactive.add("ua|crash"); // its send had committed before the crash
  const notStale = await D.runDueDeferredSends(new Date("2026-10-08T15:05:00Z"));
  check("a row mid-send is left alone while its claim is fresh", notStale.claimed === 0);
  const re = await D.runDueDeferredSends(new Date("2026-10-08T15:15:00Z"));
  check("after a crash mid-send: re-claimed, recorded as sent, no second text", re.claimed === 1 && re.sent === 1 && outbox.length === 0 && db.deferred[0].status === "sent");
}

// ---------------------------------------------------------------- 6. opt-out at send time cancels the send
{
  seed();
  db.reminders.push({ id: 901, user_id: "ua", what: "book the table", due_at: new Date(Date.now() - 60_000), sent_at: null, queued_at: null });
  await R.sendDueReminders();
  db.users.get("ua")!.sms_opted_out = true; // STOP overnight
  const r = await D.runDueDeferredSends(db.deferred[0].due_at);
  check("opted out overnight: nothing sent in the morning", outbox.length === 0 && r.skipped === 1);
  check("opted out: the row is skipped (not retried), with why", db.deferred[0].status === "skipped" && /opted out/.test(db.deferred[0].error ?? ""));
  check("opted out: the reminder never reads as sent", db.reminders[0].sent_at === null && memLines("ua").length === 0);
  const again = await D.runDueDeferredSends(new Date(db.deferred[0].due_at.getTime() + 3_600_000));
  check("opted out: a later run doesn't try again", again.claimed === 0 && outbox.length === 0);
}
{
  // The hours rule is the same at send time: a row due at night (e.g. queued by an older build) waits for 8am.
  seed();
  db.deferred.push({ id: 5000, user_id: "ua", phone_number: PHONE_A, type: "direct_ask", target_key: "late", messages: ["late one"], timezone: "America/Los_Angeles", after_kind: null, after_payload: null, due_at: new Date("2026-10-08T05:00:00Z"), status: "queued", attempts: 0, claimed_at: null, sent_at: null, error: null });
  const r = await D.runDueDeferredSends(new Date("2026-10-08T05:00:00Z")); // 10pm in LA
  check("send-time hours check: a due row at 10pm their time is put back to 8am, not sent", r.requeued === 1 && outbox.length === 0 && db.deferred[0].status === "queued" && db.deferred[0].due_at.toISOString() === "2026-10-08T15:00:00.000Z");
}
{
  // Paused: the row waits; nothing is lost.
  seed();
  await P.sendExemptWhenAllowed({ userId: "ua", phoneNumber: PHONE_A, type: "direct_ask", targetKey: "paused", messages: ["while paused"], timezone: "America/Los_Angeles", now: new Date("2026-10-08T06:30:00Z") });
  process.env.PROACTIVE_PAUSED = "true";
  const r = await D.runDueDeferredSends(new Date("2026-10-08T15:00:00Z"));
  delete process.env.PROACTIVE_PAUSED;
  check("paused: nothing sent, the row waits", r.requeued === 1 && outbox.length === 0 && db.deferred[0].status === "queued");
  await D.runDueDeferredSends(new Date("2026-10-08T15:06:00Z"));
  check("unpaused: it sends", outbox.length === 1);
}

// ---------------------------------------------------------------- wiring
{
  const jobs = src("jobs/index.ts");
  check("a minute cron runs the queue", /cron\.schedule\("\* \* \* \* \*"[\s\S]{0,200}runDueDeferredSends\(\)/.test(jobs));
  const mig = src("db/migrations.ts");
  check("migration: deferred_sends with its idempotency key, and the durable-send columns", /CREATE TABLE IF NOT EXISTS deferred_sends/.test(mig) && /UNIQUE \(user_id, target_key\)/.test(mig) && /member_reminders ADD COLUMN IF NOT EXISTS queued_at/.test(mig) && /member_relays ADD COLUMN IF NOT EXISTS sent_at/.test(mig));
  const relay = src("services/relay.ts");
  check("relay/reminder: no 'Co replied' line written by the caller (sendExempt writes it on delivery)", !/writeMemory/.test(relay));
  check("intro asks open their pending question only once sent", /kind: "network_intro_ask"/.test(src("services/networkIntroNudge.ts")) && /kind: "event_direct_ask"/.test(src("services/eventGuestMatchHandoff.ts")));
  check("the hours rule is 8am to 9pm (Royce, 2026-10-08)", P.RULES.startHour === 8 && P.RULES.endHour === 21);
}

// ---- batch 3 additions: an intro ask held past the event is dropped; the asker's side records it without a reason
{
  const D2 = await import("../../src/services/deferredSends.js");
  check("'event over' is a skip, never a retry", D2.outcomeOf({ sent: false, reason: "event over" }, true) === "skipped");
  const srcD = fs.readFileSync(new URL("../../src/services/deferredSends.ts", import.meta.url), "utf8");
  check("an event intro ask checks the event is still on before sending", /row\.after_kind === "event_direct_ask" && \(await eventIsOver\(/.test(srcD));
  check("an unsent intro ask is noted for the asker, never with a reason", /noteIntroAskNotSent\(p\)/.test(srcD) && /without any reason/.test(srcD) && !/opted out/.test(srcD.slice(srcD.indexOf("export async function noteIntroAskNotSent"), srcD.indexOf("export async function runAfter"))));
}
console.log(`\n${total - failed}/${total} passed`);
(globalThis as any).setTimeout = realSetTimeout;
process.exit(failed ? 1 : 0);
