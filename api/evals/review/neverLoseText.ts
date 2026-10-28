// Never lose a member's text (2026-10-28: a database password rotation left co-test unable to reach Postgres for ~30 minutes; every
// text was acked, its handle and payload writes failed silently, its turn failed, nothing was saved to replay, and the texts were
// lost). Covers: a failed save holds the text (through the real webhook handler) and the drain replays it once the database answers;
// one answer when the same handle arrives twice or is found twice; the late line once for a text answered over 10 minutes late; the
// team alert once an hour while failing and once on recovery, with no member data; Sendblue's list read only for this environment's
// own number; and logs that carry counts only.
// Zero tokens, no database (a fake pool), nothing sent (test numbers, logged and never sent).
//   npx tsx --import ./evals/lib/modelGuard.mjs evals/review/neverLoseText.ts
import { mkdtempSync, readFileSync, statSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "never-lose-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;
process.env.ALLOW_REAL_SMS = "true";
process.env.TEAM_ALERT_PHONE = "+14155550198";
process.env.SENDBLUE_PHONE_NUMBER = "+14155550100";
delete process.env.SENDBLUE_WEBHOOK_SECRET;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.info(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
};
const read = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

// What the member said and their number: neither may appear in any log line this change writes, or in the team alert.
const SECRET = "I think I'm leaving Marcus and moving to Lisbon in March";
const PHONE = "+14155550147";
const digits = PHONE.replace(/\D/g, "").slice(1);
const logged: string[] = [];
const orig = { log: console.log, error: console.error, warn: console.warn };
for (const k of ["log", "error", "warn"] as const)
  console[k] = (...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(" "));
const ours = () => logged.filter((l) => /^inbound (hold|recovery|outage)/.test(l));
const leaks = (lines: string[]) => lines.filter((l) => l.includes(SECRET) || l.includes("Lisbon") || l.replace(/\D/g, "").includes(digits));

const H = await import("../../src/services/inboundHold.js");
const R = await import("../../src/services/inboundRecovery.js");
const A = await import("../../src/services/inboundOutageAlert.js");
const T = await import("../../src/services/turnFailure.js");

// ---------------------------------------------------------------- the hold: keyed by handle, capped, kept across a restart
{
  let now = 1_000_000_000;
  const file = join(dir, "unit-hold.json");
  const hold = H.createInboundHold({ file, now: () => now, maxSize: 3 });
  const body = { number: PHONE, content: SECRET, message_handle: "h1" };
  hold.hold({ handle: "h1", payload: body, receivedAt: now, active: true });
  body.content = "rewritten later";
  check("a held text keeps what arrived (a copy, not the live body a later step rewrites)", hold.ready().length === 0 && JSON.parse(readFileSync(file, "utf8"))[0].payload.content === SECRET);
  hold.hold({ handle: "h1", payload: { content: "again" }, receivedAt: now + 5, active: true });
  check("the same handle twice is one held text, with its first arrival", hold.size() === 1 && JSON.parse(readFileSync(file, "utf8"))[0].receivedAt === now);
  check("while its first handler runs, the drain can't take it", hold.ready().length === 0 && hold.activeCount() === 1);
  hold.settle("h1");
  check("once that handler gives up, the drain can", hold.ready().map((t) => t.handle).join() === "h1");
  check("the file is the owner's only (0600)", (statSync(file).mode & 0o777) === 0o600);
  const again = H.createInboundHold({ file, now: () => now });
  check("a restart in the same container keeps it, ready for the drain", again.load() === 1 && again.ready()[0]?.payload.content === SECRET);
  for (const h of ["h2", "h3", "h4"]) hold.hold({ handle: h, payload: { number: PHONE }, receivedAt: (now += 10), active: false });
  check("capped by size: the oldest goes first", hold.size() === 3 && !hold.has("h1") && hold.dropped() === 1);
  now += H.HOLD_MAX_AGE_MS + 1;
  check("capped by age: nothing older than a day is kept", hold.ready().length === 0 && hold.size() === 0);
  check("an empty hold leaves no file behind", !existsSync(file));
  check("RAILWAY_VOLUME_MOUNT_PATH when a volume is attached, the temp dir otherwise", H.holdFilePath({ RAILWAY_VOLUME_MOUNT_PATH: "/data" } as any) === "/data/cue-inbound-hold.json" && H.holdFilePath({} as any) === join(tmpdir(), "cue-inbound-hold.json"));
  const fresh = H.createInboundHold({ file: join(dir, "phones.json"), now: () => 0 });
  fresh.hold({ handle: "a", payload: { number: "+1 (415) 555-0147" }, receivedAt: 1, active: false });
  fresh.hold({ handle: "b", payload: { number: "+14155550142" }, receivedAt: 2, active: false });
  fresh.hold({ handle: "c", payload: { number: PHONE }, receivedAt: 3, active: true });
  check("a live turn takes only its own phone's settled texts", fresh.readyFor(PHONE).map((t) => t.handle).join() === "a" && fresh.readyFor(PHONE, "a").length === 0);
}

// ---------------------------------------------------------------- what counts as the database being unreachable
check("the 10-28 password rotation, a refused connection, a dropped one, a pool timeout: unreachable", [
  Object.assign(new Error('password authentication failed for user "postgres"'), { code: "28P01" }),
  Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }),
  new Error("Connection terminated unexpectedly"),
  new Error("timeout exceeded when trying to connect"),
  Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("x"), { code: "57P01" }) }),
].every((e) => H.isDbUnreachable(e)));
check("a bad query or a model error is not", !H.isDbUnreachable(Object.assign(new Error('syntax error at or near "SELEC"'), { code: "42601" })) && !H.isDbUnreachable(new Error("overloaded_error")) && !H.isDbUnreachable(undefined));

// ---------------------------------------------------------------- the drain: waits for the database with backoff, then replays once
{
  let now = 5_000_000;
  const hold = H.createInboundHold({ now: () => now });
  const waits: number[] = [];
  const queue: (() => void)[] = [];
  let up = false;
  const replays: { handle: string; late: boolean }[] = [];
  const claimed = new Set<string>();
  const recovered: Date[] = [];
  const alerts: string[] = [];
  const alert = A.createOutageAlert({ send: async (t) => (alerts.push(t), true), now: () => now });
  const drain = R.createHoldDrain({
    hold,
    dbAnswers: async () => up,
    answer: (items, done) =>
      R.answerTexts(items, {
        foldIn: async (t) => (claimed.has(t.handle) ? false : (claimed.add(t.handle), true)),
        replay: async (t, o) => {
          if (claimed.has(t.handle)) return false;
          claimed.add(t.handle);
          replays.push({ handle: t.handle, late: o.late });
          return true;
        },
        done,
        isDbDown: H.isDbUnreachable,
        now: () => new Date(now),
      }),
    recover: async (o) => void recovered.push(o.before),
    alert,
    schedule: (fn, ms) => (waits.push(ms), queue.push(fn)),
    stopping: () => false,
    now: () => now,
  });
  const step = async () => {
    queue.shift()?.();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  // The 10-28 shape: the save failed, the turn died on the database, the handler gave up.
  hold.hold({ handle: "m1", payload: { number: PHONE, content: SECRET, message_handle: "m1" }, receivedAt: now, active: false });
  const downAt = now;
  drain.kick({ dbDown: true });
  await step();
  now += 5_000;
  await step();
  now += 10_000;
  check("while the database doesn't answer: nothing replayed, the text still held, backing off 5s then 10s then 20s", replays.length === 0 && hold.has("m1") && waits.slice(0, 3).join() === "5000,10000,20000", { waits, replays });
  up = true;
  now += 20_000;
  await step();
  check("once it answers, the held text is replayed, once", replays.length === 1 && replays[0].handle === "m1" && !hold.has("m1"), replays);
  check("... and Sendblue is asked for anything else from the outage window (from when the database was first seen down)", recovered.length === 1 && recovered[0].getTime() === downAt, recovered);
  check("a 35-second outage: answered on time, no late line", replays[0].late === false);
  hold.hold({ handle: "m1", payload: { number: PHONE, content: SECRET, message_handle: "m1" }, receivedAt: now, active: false });
  drain.kick();
  await step();
  check("the same handle found again (held twice, recovered twice) is never answered twice: the one-shot claim stops it", replays.length === 1 && !hold.has("m1"));
  check("the drain wrote no member content or number to the logs", leaks(ours()).length === 0, leaks(ours()));
}

// ---------------------------------------------------------------- one answer per member, and the late line
{
  const at = new Date("2026-10-28T18:00:00Z").getTime();
  const t = (handle: string, minAgo: number, number = PHONE, content = SECRET, extra: Record<string, unknown> = {}) => ({ handle, payload: { number, content, message_handle: handle, ...extra }, receivedAt: at - minAgo * 60_000 });
  const run = async (items: any[], claimed = new Set<string>()) => {
    const folded: string[] = [];
    const replays: { handle: string; late: boolean }[] = [];
    const done: string[] = [];
    const r = await R.answerTexts(items, {
      foldIn: async (x) => (claimed.has(x.handle) ? false : (claimed.add(x.handle), folded.push(x.handle), true)),
      replay: async (x, o) => (claimed.has(x.handle) ? false : (claimed.add(x.handle), replays.push({ handle: x.handle, late: o.late }), true)),
      done: (x) => done.push(x.handle),
      isDbDown: H.isDbUnreachable,
      now: () => new Date(at),
    });
    return { r, folded, replays, done };
  };
  const a = await run([t("x3", 2), t("x1", 25), t("x2", 12), t("y1", 3, "+14155550142")]);
  check("three texts from one member during an outage: the two earlier go on file, the newest is replayed (one answer that sees all three)", a.folded.join() === "x1,x2" && a.replays.filter((r) => r.handle.startsWith("x")).map((r) => r.handle).join() === "x3", a);
  check("... late (the oldest arrived 25 minutes ago): the late line goes first", a.replays.find((r) => r.handle === "x3")?.late === true);
  check("another member's text is its own answer, on time", a.replays.find((r) => r.handle === "y1")?.late === false && a.done.length === 4);
  const dup = await run([t("d1", 15), t("d1", 15)]);
  check("the same handle twice in one batch: answered once, never folded into itself", dup.replays.length === 1 && dup.folded.length === 0, dup);
  const claimed = new Set<string>();
  const first = await run([t("z1", 30)], claimed);
  const second = await run([t("z1", 30)], claimed);
  check("a text recovered twice (the hold and Sendblue's list both found it): one answer, one late line", first.replays.length === 1 && first.replays[0].late && second.replays.length === 0, { first, second });
  check("STOP never gets an apology first, however late", !R.lateLineFits({ content: "STOP" }, at - 60 * 60_000, at) && R.lateLineFits({ content: "hello?" }, at - 11 * 60_000, at) && !R.lateLineFits({ content: "hello?" }, at - 9 * 60_000, at));
  check("groups, outbound statuses and typing events are never answered", R.byPhone([t("g", 20, PHONE, "x", { group_id: "grp" }), t("o", 20, PHONE, "x", { is_outbound: true }), t("ty", 20, PHONE, "x", { type: "typing" })]).length === 0);
  let clock = at;
  const guard = R.createLateGuard(() => clock);
  const g1 = guard.claim(PHONE);
  const g2 = guard.claim("(415) 555-0147");
  clock += R.LATE_LINE_EVERY_MS + 1;
  const g3 = guard.claim(PHONE);
  check("the late line goes to a member once in 30 minutes, whichever path answers them", g1 && !g2 && g3);
  guard.release(PHONE);
  check("... and a line that didn't go may be said by the next answer", guard.claim(PHONE));
  const stop = await R.answerTexts([t("s1", 20), t("s2", 15)], {
    foldIn: async () => {
      throw Object.assign(new Error("Connection terminated unexpectedly"), {});
    },
    replay: async () => true,
    done: () => {},
    isDbDown: H.isDbUnreachable,
    now: () => new Date(at),
  });
  check("the database going away mid-batch stops the batch (what's left stays held)", stop.stoppedOnDb && stop.replayed === 0);
  const doneOdd: string[] = [];
  const odd = await R.answerTexts([t("o1", 20), t("o2", 15)], {
    foldIn: async () => {
      throw new TypeError("something else");
    },
    replay: async () => true,
    done: (x) => doneOdd.push(x.handle),
    isDbDown: H.isDbUnreachable,
    now: () => new Date(at),
  });
  check("any other failure on an earlier text never costs the newest its answer", odd.failed === 1 && odd.replayed === 1 && doneOdd.join() === "o1,o2", odd);
}
check("the late line is one fixed line, short and plain, no outage explanation", R.LATE_REPLY_LINE === "Sorry for the slow reply." && !/database|outage|server|down|system/i.test(R.LATE_REPLY_LINE));
check("a recovered text may be up to a day old; a crashed turn's replay stays at an hour", (() => {
  const base = { member: { optedOut: false, archived: false }, coRepliedSince: false, lastInboundAt: null, callAt: null, receivedAt: new Date("2026-10-28T10:00:00Z"), now: new Date("2026-10-28T13:00:00Z") };
  return T.turnReplayBlocked(base) === "too_old" && T.turnReplayBlocked({ ...base, maxAgeMs: R.RECOVERED_MAX_AGE_MS }) === null && T.turnReplayBlocked({ ...base, maxAgeMs: R.RECOVERED_MAX_AGE_MS, coRepliedSince: true }) === "already_answered" && T.turnReplayBlocked({ ...base, now: new Date("2026-10-29T10:00:01Z"), maxAgeMs: R.RECOVERED_MAX_AGE_MS }) === "too_old";
})());

// ---------------------------------------------------------------- Sendblue's list: this environment's own number only
{
  const now = new Date("2026-10-28T18:00:00Z");
  const anchorAt = new Date("2026-10-28T17:20:00Z");
  const msg = (handle: string, minAgo: number, extra: Record<string, unknown> = {}) => ({ message_handle: handle, is_outbound: false, number: PHONE, from_number: PHONE, to_number: "+14155550100", sendblue_number: "+14155550100", content: SECRET, date_sent: new Date(now.getTime() - minAgo * 60_000).toISOString(), ...extra });
  const listed = [
    msg("anchor", 40),
    msg("missed1", 30),
    msg("missed2", 29, { content: "", media_url: "https://cdn.example/img.jpg" }),
    msg("known", 28),
    msg("held", 27),
    msg("other-number", 26, { sendblue_number: "+14155550199", to_number: "+14155550199" }),
    msg("group", 25, { group_id: "g1", message_type: "group" }),
    msg("outbound", 24, { is_outbound: true }),
    msg("empty", 23, { content: "  " }),
    msg("missed1", 30),
  ];
  const queries: any[] = [];
  const deps = (over: Partial<any> = {}) => ({
    ourNumber: "+14155550100",
    anchor: async () => ({ handle: "anchor", receivedAt: anchorAt }),
    list: async (q: any) => (queries.push(q), { data: listed, hasMore: false }),
    known: async (hs: string[]) => new Set(hs.filter((h) => h === "known" || h === "anchor")),
    held: (h: string) => h === "held",
    now: () => now,
    ...over,
  });
  const f = await R.findMissedTexts(deps(), { before: now });
  check("only texts never handled here: not known, not held, not another number's, no groups, no outbound, no empty ones, each once", f.texts.map((t) => t.handle).join() === "missed1,missed2" && f.skipped === null, f.texts.map((t) => t.handle));
  check("... asked from the newest handled text, two minutes back", queries[0].created_at_gte === new Date(anchorAt.getTime() - R.RECOVERY_MARGIN_MS).toISOString() && queries[0].offset === 0 && queries[0].limit === 100);
  check("... shaped like the webhook body (number is the member's, inbound), with when it arrived", f.texts[0].payload.number === PHONE && f.texts[0].payload.is_outbound === false && f.texts[0].payload.message_handle === "missed1" && new Date(f.texts[0].receivedAt).getTime() === now.getTime() - 30 * 60_000);
  check("no anchor in Sendblue's list (the webhook for this number may point at another environment): nothing recovered", (await R.findMissedTexts(deps({ anchor: async () => ({ handle: "not-there", receivedAt: anchorAt }) }), { before: now })).skipped === "anchor_not_listed");
  check("no handled text to anchor on, or no number set: nothing recovered", (await R.findMissedTexts(deps({ anchor: async () => null }), { before: now })).skipped === "no_anchor" && (await R.findMissedTexts(deps({ ourNumber: undefined }), { before: now })).skipped === "no_sendblue_number");
  const old = await R.findMissedTexts(deps({ now: () => new Date(now.getTime() + 24 * 60 * 60_000) }), { before: now });
  check("at most a day back", old.texts.length === 0, old.texts.map((t) => t.handle));
  let pages = 0;
  await R.findMissedTexts(deps({ list: async (q: any) => (pages++, { data: q.offset === 0 ? [msg("anchor", 40), ...Array.from({ length: 99 }, (_, i) => msg(`p${i}`, 20))] : [], hasMore: q.offset === 0 }) }), { before: now });
  check("pages through 100 at a time and stops when there's no more", pages === 2);
}

// ---------------------------------------------------------------- the team alert: once an hour while failing, once on recovery, no member data
{
  let now = 0;
  const sent: string[] = [];
  let sendOk = true;
  const alert = A.createOutageAlert({ send: async (t) => (sendOk ? (sent.push(t), true) : false), now: () => now });
  const settle = () => new Promise((r) => setImmediate(r));
  alert.noteDbUnreachable();
  await settle();
  for (let i = 0; i < 20; i++) {
    now += 2 * 60_000;
    alert.noteDbUnreachable();
    alert.tick();
  }
  await settle();
  check("the database unreachable: one alert, however many texts fail inside the hour", sent.length === 1 && sent[0] === A.OUTAGE_ALERT_DB, sent);
  now = 60 * 60_000;
  alert.noteDbUnreachable();
  await settle();
  check("still failing an hour on: one more", sent.length === 2, sent);
  alert.noteHealthy("db", { held: 2 });
  now += A.QUIET_FOR_BACK_MS + 1;
  alert.noteHealthy("db", { held: 2 });
  check("not back while texts are still held", sent.length === 2 && alert.state().failing !== null);
  alert.noteHealthy("db", { held: 0 });
  alert.noteHealthy("db", { held: 0 });
  alert.noteHealthy("turn", { held: 0 });
  await settle();
  check("back to normal: one text, once", sent.length === 3 && sent[2] === A.OUTAGE_BACK && alert.state().failing === null, sent);
  now += 10 * 60_000;
  alert.noteDbUnreachable();
  await settle();
  check("a new outage inside the same hour as the last alert: no second alert (at most one an hour)", sent.length === 3);
  now += A.QUIET_FOR_BACK_MS + 1;
  alert.noteHealthy("db", { held: 0 });
  await settle();
  check("... and no 'back' for an outage nobody was told about", sent.length === 3);

  const turns: string[] = [];
  let t2 = 0;
  const b = A.createOutageAlert({ send: async (t) => (turns.push(t), true), now: () => t2 });
  b.noteTurnFailure();
  t2 += 60_000;
  b.noteTurnFailure();
  t2 += A.TURN_FAILURES_WINDOW_MS;
  b.noteTurnFailure();
  await settle();
  check("turn failures: 3 inside 10 minutes, not 3 spread wider", turns.length === 0);
  t2 += 60_000;
  b.noteTurnFailure();
  t2 += 60_000;
  b.noteTurnFailure();
  await settle();
  check("... then the alert", turns.length === 1 && turns[0] === A.OUTAGE_ALERT_TURNS, turns);
  t2 += A.QUIET_FOR_BACK_MS + 1;
  b.noteHealthy("db", { held: 0 });
  await settle();
  check("a turn outage isn't over because the database answers; a real answered turn ends it", turns.length === 1 && b.state().failing !== null);
  b.noteHealthy("turn", { held: 0 });
  await settle();
  check("... back once", turns.length === 2 && turns[1] === A.OUTAGE_BACK);

  sendOk = false;
  let t3 = 0;
  const c = A.createOutageAlert({ send: async () => sendOk, now: () => t3 });
  c.noteDbUnreachable();
  await settle();
  sendOk = true;
  t3 += 60_000;
  c.noteDbUnreachable();
  await settle();
  check("an alert that didn't go doesn't use up the hour: the next failure sends it", c.state().lastAlertAt === 60_000);
  const lines = [A.OUTAGE_ALERT_DB, A.OUTAGE_ALERT_TURNS, A.OUTAGE_BACK];
  check("the alert lines are fixed: no number, no name, no member's words", lines.every((l) => !/\d{4}/.test(l) && !l.includes(SECRET)) && lines.every((l) => l.length < 160));
  check("the alert never touches the database: memory only, sent through the team-alert text path", !/pool|db\.js|harness_alerts/.test(read("services/inboundOutageAlert.ts")) && /sendAlertText\(text\)/.test(read("routes/sendblue.ts")));
}

// ---------------------------------------------------------------- the real webhook: a failed save holds the text; a redelivery is not a second turn
{
  const pool = (await import("../../src/db/db.js")).default as any;
  const queries: { sql: string; params: any[] }[] = [];
  pool.query = async (sql: string, params: any[] = []) => {
    queries.push({ sql: flat(String(sql)), params });
    throw Object.assign(new Error('password authentication failed for user "postgres"'), { code: "28P01" });
  };
  const S = await import("../../src/routes/sendblue.js");
  const router: any = S.sendblueRouter({ to: () => ({ emit: () => {} }) } as any);
  const layer = router.stack.find((l: any) => l.route?.path === "/webhook");
  const post = layer.route.stack[0].handle;
  const deliver = (handle: string) => {
    const acks: number[] = [];
    const res: any = { status: (c: number) => (acks.push(c), res), send: () => res, json: () => res, sendStatus: () => res, headersSent: false };
    const body = { number: PHONE, content: SECRET, message_handle: handle, is_outbound: false, message_type: "message", sendblue_number: "+14155550100", date_sent: new Date().toISOString() };
    const p = post({ body, get: () => undefined, ip: "test" }, res, () => {});
    return { acks, p, body };
  };
  const first = deliver("live-1");
  for (let i = 0; i < 40 && !S.heldInbound.has("live-1"); i++) await new Promise((r) => setTimeout(r, 25));
  check("the database refusing the save (the 10-28 password rotation): Sendblue still gets its 200 at once", first.acks[0] === 200);
  check("... and the text is held, not dropped (it used to vanish here)", S.heldInbound.has("live-1") && S.heldInbound.size() === 1);
  const file = H.holdFilePath();
  check("... in the local file too, so a restart in this container keeps it", existsSync(file) && JSON.parse(readFileSync(file, "utf8")).some((t: any) => t.handle === "live-1" && t.payload.content === SECRET));
  const second = deliver("live-1");
  const done = await Promise.race([second.p.then(() => "returned"), new Promise((r) => setTimeout(() => r("still running"), 1_500))]);
  check("the same text delivered again while held: no second turn (one answer per handle)", done === "returned" && S.heldInbound.size() === 1, done);
  await new Promise((r) => setTimeout(r, 50));
  const alertRow = queries.find((q) => /INSERT INTO outbound_messages/.test(q.sql) && /'ops'/.test(q.sql));
  check("the team was texted the outage line through the team-alert path (to the team number, recorded as a team text)", alertRow?.params[2] === A.OUTAGE_ALERT_DB && alertRow?.params[1] === process.env.TEAM_ALERT_PHONE, alertRow?.params);
  check("... carrying no member data", !!alertRow && !String(alertRow.params[2]).includes(SECRET) && !String(alertRow.params[2]).replace(/\D/g, "").includes(digits));
  const nonAlert = queries.filter((q) => /INSERT INTO outbound_messages/.test(q.sql) && !/'ops'/.test(q.sql));
  check("nothing went to the member while the database was down", nonAlert.every((q) => q.params[1] !== PHONE), nonAlert.map((q) => q.params[1]));
  check("the logs this change writes carry counts only: no member words, no number", ours().length > 0 && leaks(ours()).length === 0, { ours: ours(), leaks: leaks(ours()) });
}

// ---------------------------------------------------------------- the wiring (read from the source)
{
  const src = flat(read("routes/sendblue.ts"));
  check("a failed handle or payload save is noticed (no more .catch(() => true) / .catch(() => {}) that hid it)", /\.catch\(\(\) => \{ saveFailed = true; return true; \}\)/.test(src) && /\.catch\(\(\) => \{ saveFailed = true; \}\)/.test(src) && /if \(saveFailed && holdable\) held = holdInbound\(handle, req\.body, arrivedAt, true\)/.test(src));
  check("the turn's outcome decides: answered leaves the hold, a database failure goes to the drain", /await settleInbound\(\{ handle: holdable \? \(handle as string\) : null, body: req\.body, arrivedAt, held, turnError, replay: !!replay/.test(src) && /const dbDown = t\.held \|\| isDbUnreachable\(t\.turnError\) \|\| !\(await dbAnswers\(\)\)/.test(src));
  check("held and recovered texts replay through the one-shot claim (replayOwedTurn, claimRetry strict) and the phone's lock", /return replayOwedTurn\(t\.handle, \{ recovered: true, late: o\.late \}\)/.test(src) && /const claim = await claimRetry\(handle, \{ strict: o\.recovered \}\)/.test(src) && /withPhoneLock\(lockKey, \(\) => traceTurn\(run\)\)/.test(src));
  check("a text taken into another's answer is claimed once (retry_claimed_at IS NULL) before its line goes on file", /DO UPDATE SET retry_claimed_at = NOW\(\).*WHERE inbound_webhook_handles\.retry_claimed_at IS NULL RETURNING handle/.test(src));
  check("a recovered text is owned by inserting its handle first: a webhook that got there first wins, one that comes later is a duplicate", /VALUES \(\$1, \$2::jsonb, \$3, NOW\(\)\) ON CONFLICT \(handle\) DO NOTHING RETURNING handle`, \[t\.handle, JSON\.stringify\(t\.payload\), new Date\(t\.receivedAt\)\],? \); if \(!rows\.length\) continue; inboundHold\.hold/.test(src));
  check("the late line is sent under the phone's lock, before the turn, and never counts as an answer (it's with the hold lines)", /const run = \(\) => withMember\(null, runTurn\); const runTurn = async \(\) => \{ try \{ \/\/[^\n]*?Never throws\. await beforeTurn\(\);/.test(src) && /const HOLD_LINES = \[[^\]]*LATE_REPLY_LINE\]/.test(src));
  check("Sendblue's list is read through the existing client and keys, for our number only", /client\.messages\.list\(\{ is_outbound: "false", sendblue_number: q\.sendblue_number/.test(flat(read("services/sendblue.ts"))) && /list: \(q\) => listInboundMessages\(\{ \.\.\.q, sendblue_number: ours! \}\)/.test(src));
  check("startup runs the recovery after migrations", /startInboundRecovery\(new Date\(\)\);/.test(read("server.ts")));
  check("no key is ever logged", !/SENDBLUE_(API|SECRET)_KEY/.test(read("services/inboundRecovery.ts") + read("services/inboundHold.ts") + read("services/inboundOutageAlert.ts")));
}

Object.assign(console, orig);
console.log(`never lose a text: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
