// Never lose a member's text (2026-10-28: a database password rotation left co-test unable to reach Postgres for ~30 minutes; every
// text was acked, its handle and payload writes failed silently, its turn failed, nothing was saved to replay, and the texts were
// lost). Covers: a failed save holds the text (through the real webhook handler) and the drain replays it once the database answers;
// one answer when the same handle arrives twice or is found twice; the late line once for a text answered over 10 minutes late; the
// team alert once an hour while failing and once on recovery, with no member data; Sendblue's list read only for this environment's
// own number; and logs that carry counts only.
// Zero tokens, no database (a fake pool), nothing sent (test numbers, logged and never sent).
//   npx tsx --import ./evals/lib/modelGuard.mjs evals/review/neverLoseText.ts
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
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
  // Review of #301 (7): a crashed write's leftover .tmp (here world-readable) never becomes the hold file with its own mode.
  const f7 = join(dir, "perm-hold.json");
  writeFileSync(`${f7}.tmp`, "junk from a crashed write", { mode: 0o644 });
  chmodSync(`${f7}.tmp`, 0o644);
  const h7 = H.createInboundHold({ file: f7 });
  h7.hold({ handle: "p1", payload: { number: PHONE, content: SECRET }, receivedAt: Date.now(), active: false });
  check("a leftover .tmp from a crashed write is replaced: the hold file is still the owner's only (0600), no .tmp left", (statSync(f7).mode & 0o777) === 0o600 && !existsSync(`${f7}.tmp`), (statSync(f7).mode & 0o777).toString(8));
  // A rename that fails (the target is a non-empty directory) leaves no copy of anyone's text behind.
  const f7b = join(dir, "blocked-hold.json");
  mkdirSync(join(f7b, "x"), { recursive: true });
  const h7b = H.createInboundHold({ file: f7b });
  h7b.hold({ handle: "p2", payload: { number: PHONE, content: SECRET }, receivedAt: Date.now(), active: false });
  check("a failed rename cleans up its .tmp (no stray copy of a member's text) and keeps the text in memory", !existsSync(`${f7b}.tmp`) && h7b.has("p2"));
}

// ---------------------------------------------------------------- what counts as the database being unreachable
check("the 10-28 password rotation, a dropped pg connection, a pool timeout, a shutdown: unreachable on their own word", [
  Object.assign(new Error('password authentication failed for user "postgres"'), { code: "28P01" }),
  new Error("Connection terminated unexpectedly"),
  new Error("timeout exceeded when trying to connect"),
  Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("x"), { code: "57P01" }) }),
].every((e) => H.isDbUnreachable(e)));
{
  // Review of #301 (4): a generic network error is what Anthropic, a fetch or Sendblue throw too. On its own it's not the database;
  // only a probe that gets no answer makes it one.
  const generic = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNREFUSED"].map((code) => Object.assign(new Error(`fetch failed: ${code}`), { code }));
  check("a generic network error (an Anthropic, fetch or Sendblue blip) is not the database on its own", generic.every((e) => !H.isDbUnreachable(e)));
  const up = await Promise.all(generic.map((e) => H.dbDownFor(e, async () => true)));
  const down = await Promise.all(generic.map((e) => H.dbDownFor(e, async () => false)));
  check("... only when the database also doesn't answer a probe", up.every((x) => !x) && down.every((x) => x));
  let probed = 0;
  check("... and pg's own word needs no probe", await H.dbDownFor(Object.assign(new Error("x"), { code: "28P01" }), async () => (probed++, true)) && probed === 0);
}
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
        withLock: (_p, fn) => fn(),
        foldIn: async (t) => (claimed.has(t.handle) ? false : (claimed.add(t.handle), true)),
        drop: async (t) => (claimed.has(t.handle) ? false : (claimed.add(t.handle), true)),
        replay: async (t, o) => {
          if (claimed.has(t.handle)) return false;
          claimed.add(t.handle);
          replays.push({ handle: t.handle, late: o.late });
          return true;
        },
        done,
        isDbDown: async (e) => H.dbDownFor(e, async () => up),
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
    const dropped: string[] = [];
    const replays: { handle: string; late: boolean }[] = [];
    const done: string[] = [];
    const r = await R.answerTexts(items, {
      withLock: (_p, fn) => fn(),
      foldIn: async (x) => (claimed.has(x.handle) ? false : (claimed.add(x.handle), folded.push(x.handle), true)),
      drop: async (x) => (claimed.has(x.handle) ? false : (claimed.add(x.handle), dropped.push(x.handle), true)),
      replay: async (x, o) => (claimed.has(x.handle) ? false : (claimed.add(x.handle), replays.push({ handle: x.handle, late: o.late }), true)),
      done: (x) => done.push(x.handle),
      isDbDown: async (e) => H.dbDownFor(e, async () => true),
      now: () => new Date(at),
    });
    return { r, folded, dropped, replays, done };
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
    withLock: (_p, fn) => fn(),
    foldIn: async () => {
      throw Object.assign(new Error("Connection terminated unexpectedly"), {});
    },
    drop: async () => true,
    replay: async () => true,
    done: () => {},
    isDbDown: async (e) => H.dbDownFor(e, async () => true),
    now: () => new Date(at),
  });
  check("the database going away mid-batch stops the batch (what's left stays held)", stop.stoppedOnDb && stop.replayed === 0);
  const doneOdd: string[] = [];
  const odd = await R.answerTexts([t("o1", 20), t("o2", 15)], {
    withLock: (_p, fn) => fn(),
    foldIn: async () => {
      throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    },
    drop: async () => true,
    replay: async () => true,
    done: (x) => doneOdd.push(x.handle),
    isDbDown: async (e) => H.dbDownFor(e, async () => true),
    now: () => new Date(at),
  });
  check("any other failure on an earlier text (a generic network blip while the database answers) never costs the newest its answer", odd.failed === 1 && odd.replayed === 1 && doneOdd.join() === "o1,o2" && !odd.stoppedOnDb, odd);

  // ------------------------------------------------ review of #301 (1): a held STOP is honored through the normal path, first
  const s1 = await run([t("a1", 30, PHONE, "where should we eat Friday?"), t("a2", 25, PHONE, "STOP"), t("a3", 20, PHONE, "also what about Sunday")]);
  check("a held STOP between texts: the earlier text goes on file, STOP goes through the normal turn (opt-out + its confirmation), on time", s1.folded.join() === "a1" && s1.replays.map((r) => `${r.handle}:${r.late}`).join() === "a2:false", s1);
  check("... and after it, nothing: the later text is claimed and dropped, no answer, no late line", s1.dropped.join() === "a3" && !s1.replays.some((r) => r.handle === "a3" || r.late), s1);
  const s2 = await run([t("b1", 40, PHONE, "stop"), t("b2", 35, PHONE, "hey are you there"), t("b3", 30, PHONE, "Start"), t("b4", 25, PHONE, "ok so about Friday")]);
  check("STOP then START: both through the normal turn in order, then the newest answered with the late line", s2.replays.map((r) => `${r.handle}:${r.late}`).join() === "b1:false,b3:false,b4:true" && s2.dropped.join() === "" && s2.folded.join() === "b2", s2);
  const s3 = await run([t("c1", 40), t("c2", 30, PHONE, "UNSUBSCRIBE")]);
  check("STOP as the newest held text: replayed with no late line, nothing after it", s3.replays.map((r) => `${r.handle}:${r.late}`).join() === "c2:false" && s3.folded.join() === "c1", s3);
  check("the plan uses the existing STOP/START words (services/optOut.ts), nothing new", R.keywordOf(t("k", 1, PHONE, " quit ")) === "out" && R.keywordOf(t("k", 1, PHONE, "unstop")) === "in" && R.keywordOf(t("k", 1, PHONE, "please stop texting so much")) === null);
  {
    const folded: string[] = [];
    const live = await R.takeHeldIntoLiveTurn([t("h1", 20), t("h2", 15, PHONE, "STOP")], { foldIn: async (x) => (folded.push(x.handle), true), release: () => {} });
    check("a live text behind a held STOP doesn't run its own turn first: it joins the hold (the drain answers all of them in order)", live === "defer" && folded.length === 0);
  }

  // ------------------------------------------------ review of #301 (3): the drain and a live text from the same phone never overlap
  {
    // One fake phone lock, one claim store, one hold, shared by the drain's batch and a live text's turn that arrives mid-batch.
    let locked = Promise.resolve();
    const withLock = <X,>(_p: string, fn: () => Promise<X>): Promise<X> => {
      const run = locked.then(fn);
      locked = run.then(() => undefined, () => undefined);
      return run;
    };
    const hold = H.createInboundHold();
    for (const [h, m] of [["q1", 20], ["q2", 15]] as const) hold.hold({ handle: h, payload: { number: PHONE, content: SECRET, message_handle: h }, receivedAt: at - m * 60_000, active: false });
    const claimed = new Set<string>();
    const answered: string[] = [];
    const filed: string[] = [];
    let liveRanAt = 0;
    // Two turns for one phone at once is what the phone's lock exists to prevent (two replies, the wrong branch on a double yes).
    let inTurn = 0;
    let most = 0;
    const turn = async () => {
      most = Math.max(most, ++inTurn);
      await new Promise((r) => setTimeout(r, 10));
      inTurn--;
    };
    // The replay the real one makes: the checks (a newer text of theirs answered since is "newer_text", stopped), the claim, the turn.
    const replay = async (x: any) => {
      if (liveRanAt > x.receivedAt) return false;
      if (claimed.has(x.handle)) return false;
      claimed.add(x.handle);
      await turn();
      answered.push(x.handle);
      return true;
    };
    const foldIn = async (x: any) => {
      await new Promise((r) => setTimeout(r, 5));
      if (claimed.has(x.handle)) return false;
      claimed.add(x.handle);
      filed.push(x.handle);
      return true;
    };
    const batch = R.answerTexts(hold.ready(), {
      withLock,
      foldIn,
      drop: foldIn,
      replay,
      done: (x) => hold.release(x.handle),
      isDbDown: async () => false,
      now: () => new Date(at),
    });
    // The live text arrives while the batch is mid-way: its turn waits for the same phone's lock.
    const live = withLock(PHONE, async () => {
      const r = await R.takeHeldIntoLiveTurn(hold.readyFor(PHONE), { foldIn, release: (h) => hold.release(h) });
      liveRanAt = at;
      await turn();
      answered.push("live");
      return r;
    });
    await Promise.all([batch, live]);
    const handled = (h: string) => answered.includes(h) || filed.includes(h);
    check("a live text arriving mid-batch waits for the phone's lock: every held text is answered or on file, none lost to 'newer_text'", handled("q1") && handled("q2") && answered.includes("live") && hold.size() === 0, { answered, filed, held: hold.size() });
    check("... and the newest held text was answered before the live one ran, never alongside it (one turn per phone at a time)", answered.indexOf("q2") > -1 && answered.indexOf("q2") < answered.indexOf("live") && most === 1, { answered, most });
    const kept = H.createInboundHold();
    kept.hold({ handle: "w1", payload: { number: PHONE, content: SECRET }, receivedAt: at - 60_000, active: false });
    await R.takeHeldIntoLiveTurn(kept.readyFor(PHONE), { foldIn: async () => false, release: (h) => kept.release(h) });
    check("a held text the live turn couldn't claim is never let go there (whoever has it, or the drain, settles it)", kept.has("w1"));
  }
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
  const main = queries.filter((q) => !q.created_at_lte);
  check("... the anchor checked on its own (a few minutes either side), then read newest first from two minutes before it", !!queries[0].created_at_lte && main[0]?.created_at_gte === new Date(anchorAt.getTime() - R.RECOVERY_MARGIN_MS).toISOString() && main[0]?.order_direction === "desc" && main[0]?.offset === 0 && main[0]?.limit === 100, queries);
  check("... shaped like the webhook body (number is the member's, inbound), with when it arrived", f.texts[0].payload.number === PHONE && f.texts[0].payload.is_outbound === false && f.texts[0].payload.message_handle === "missed1" && new Date(f.texts[0].receivedAt).getTime() === now.getTime() - 30 * 60_000);
  check("no anchor in Sendblue's list (the webhook for this number may point at another environment): nothing recovered", (await R.findMissedTexts(deps({ anchor: async () => ({ handle: "not-there", receivedAt: anchorAt }) }), { before: now })).skipped === "anchor_not_listed");
  check("no handled text to anchor on, or no number set: nothing recovered", (await R.findMissedTexts(deps({ anchor: async () => null }), { before: now })).skipped === "no_anchor" && (await R.findMissedTexts(deps({ ourNumber: undefined }), { before: now })).skipped === "no_sendblue_number");
  const old = await R.findMissedTexts(deps({ now: () => new Date(now.getTime() + 24 * 60 * 60_000) }), { before: now });
  check("at most a day back", old.texts.length === 0, old.texts.map((t) => t.handle));
  let pages = 0;
  await R.findMissedTexts(deps({ list: async (q: any) => (q.created_at_lte ? { data: [msg("anchor", 40)], hasMore: false } : (pages++, { data: q.offset === 0 ? Array.from({ length: 100 }, (_, i) => msg(`p${i}`, 20)) : [], hasMore: q.offset === 0 })) }), { before: now });
  check("pages through 100 at a time and stops when there's no more", pages === 2, pages);
  // Review of #301 (8): a long outage. 2,500 texts since the anchor, newest first: the newest are read, the page cap leaves out the oldest.
  const many = Array.from({ length: 2500 }, (_, i) => msg(`n${i}`, 39 - i * (38 / 2500)));
  const byNewest = [...many].reverse();
  const big = await R.findMissedTexts(
    deps({ list: async (q: any) => (q.created_at_lte ? { data: [msg("anchor", 40)], hasMore: false } : { data: (q.order_direction === "desc" ? byNewest : many).slice(q.offset, q.offset + q.limit), hasMore: q.offset + q.limit < many.length }), known: async () => new Set() }),
    { before: now },
  );
  const got = new Set(big.texts.map((t) => t.handle));
  check("a long outage: the newest texts are always read (newest first), the page cap leaves out only the oldest, and says so", got.has("n2499") && got.has("n500") && !got.has("n0") && big.capped && got.size === R.RECOVERY_MAX_PAGES * R.RECOVERY_PAGE, { size: got.size, capped: big.capped });
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

  // ------------------------------------------------ review of #301 (2): a turn that already texted them is never replayed
  const base = { handle: "h", holdable: true, held: false, failed: true, dbDown: true, replied: false, replay: false };
  check("a turn that died on the database before texting them: held for the drain", S.settleAction(base) === "hold");
  check("a turn that texted them and then died on the database (logging the reply): never held, never replayed", S.settleAction({ ...base, replied: true }) === "count" && S.settleAction({ ...base, held: true, replied: true }) === "count");
  check("... the same for a replay: one that dies before texting gives its claim back for another try, one that texted is done", S.settleAction({ ...base, replay: true }) === "reclaim" && S.settleAction({ ...base, replay: true, replied: true }) === "count");
  check("a failure that isn't the database, or a turn that ended fine: never held", S.settleAction({ ...base, dbDown: false }) === "count" && S.settleAction({ ...base, failed: false }) === "release");
  // Follow-up review of #301: only a send that answers something marks the turn as having replied. A "looking" line, Cue's own
  // hold line, the late line or a failure note leaves the text owed (held and replayed if the turn then dies), and another flow's
  // text to the same number is never this turn's answer.
  const SB = await import("../../src/services/sendblue.js");
  const TR = await import("../../src/services/turnReplies.js");
  const TF = await import("../../src/services/turnFailure.js");
  const NUM = "+14155550163";
  const sendIt = (text: string) => SB.default.messages.send({ number: NUM, content: text, from_number: "+14155550100" } as any);
  const aTurn = async (lines: { text: string; hold?: boolean }[], during?: () => Promise<unknown>) => {
    await Promise.resolve();
    const st = { replied: false, phone: NUM, isReply: S.isRealReply };
    TR.trackTurnReplies(st);
    for (const l of lines) await (l.hold ? TR.asHoldSend(() => sendIt(l.text)) : sendIt(l.text));
    if (during) await during();
    return st.replied;
  };
  check("a search turn that said 'Looking now…' and then lost the database has not replied: it's still held and replayed", (await aTurn([{ text: "Looking now, give me a minute." }])) === false && S.settleAction({ ...base, replied: false }) === "hold");
  check("... nor one that sent Cue's own hold line, the late line, 'On it, give me a sec.' or a failure note", (await aTurn([{ text: "Checking a few spots near the Mission for Friday.", hold: true }])) === false && (await aTurn([{ text: R.LATE_REPLY_LINE }, { text: "On it, give me a sec." }, { text: TF.TURN_FAILED_NOTE }])) === false);
  check("a turn that sent a real answer has replied (never replayed)", (await aTurn([{ text: "Looking now, give me a minute." }, { text: "Bar Agricole has a table at 8, want it?" }])) === true);
  const other = async () => {
    // Another flow (a proactive text) to the same number, outside this turn.
    await new Promise((r) => setTimeout(r, 1));
    await sendIt("Thinking of you before Thursday's demo.");
  };
  const [quiet, proactive] = await Promise.all([aTurn([{ text: "Looking now, give me a minute." }], () => new Promise((r) => setTimeout(r, 5))), (async () => (await new Promise((r) => setTimeout(r, 0)), other()))()]);
  void proactive;
  check("a proactive text to the same number during the turn is not this turn's reply (no per-number counting)", quiet === false);
  const [t1, t2] = await Promise.all([aTurn([{ text: "Looking now, give me a minute." }]), aTurn([{ text: "Here's the plan for Saturday." }])]);
  check("two turns at once each keep their own flag", t1 === false && t2 === true);
  // Last review of #301: a voice note counts, a send to someone else doesn't, and a tapback the turn chose as its answer counts.
  const inTurn = async (fn: () => Promise<unknown>) => {
    await Promise.resolve();
    const st = { replied: false, phone: NUM, isReply: S.isRealReply };
    TR.trackTurnReplies(st);
    await fn();
    return st.replied;
  };
  check("a voice-note reply (no words, a media_url) is a real reply", (await inTurn(() => SB.default.messages.send({ number: NUM, content: "", media_url: "https://cdn.example/voice.caf", from_number: "+14155550100" } as any))) === true);
  check("a send to another member inside the turn (a direct ask) is not this turn's reply", (await inTurn(() => SB.default.messages.send({ number: "+14155550168", content: "Would you be up for meeting Jordan Thursday?", from_number: "+14155550100" } as any))) === false);
  check("a tapback the turn chose as its answer, to its own member, counts as having answered", (await inTurn(() => SB.sendReaction("test-tap-1", "love", { answerFor: NUM }))) === true);
  check("... the early 'on it' tapback (no answerFor) doesn't, nor one aimed at someone else", (await inTurn(() => SB.sendReaction("test-tap-2", "like"))) === false && (await inTurn(() => SB.sendReaction("test-tap-3", "love", { answerFor: "+14155550168" }))) === false);
  check("the turn's flag is opened with its own member's number; the reply tool's tapback passes the member as answerFor", /const turnReplies: TurnReplies = \{ replied: false, phone: String\(req\.body\?\.number \?\? ""\), isReply: isRealReply \};/.test(flat(read("routes/sendblue.ts"))) && /sendReaction\(ctx\.messageHandle, reactionFor\(reaction\), \{ answerFor: ctx\.phoneNumber \}\)/.test(read("agent/conversationTools.ts")));
  check("isRealReply: the logged 'Co is looking:' form and the fixed hold lines are not answers; words are", !S.isRealReply("Co is looking: checking now") && !S.isRealReply("Let me look, one sec.") && !S.isRealReply("") && S.isRealReply("Sorry for the wait, here it is: the Fillmore at 9."));

  // Follow-up review of #301 (low): a crash replay never takes the claim of a text the drain owns, and never loses one on a blip.
  {
    const qs: { sql: string; params: any[] }[] = [];
    pool.query = async (sql: string, params: any[] = []) => {
      const q = flat(String(sql));
      qs.push({ sql: q, params });
      if (/^UPDATE inbound_webhook_handles SET retry_claimed_at = NOW\(\)/.test(q)) return { rows: [{ payload: { number: "+14155550167", content: SECRET, message_handle: params[0] }, received_at: new Date(Date.now() - 60_000) }] };
      if (/AS replied/.test(q)) throw Object.assign(new Error("Connection terminated unexpectedly"), {});
      return { rows: [], rowCount: 0 };
    };
    const heldOne = S.heldInbound.has("live-1");
    const r1 = await S.replayOwedTurn("live-1");
    check("a text in the hold: the crash replay leaves it to the drain (no claim taken), and reports it as being answered", heldOne && r1 === true && !qs.some((q) => /SET retry_claimed_at = NOW\(\)/.test(q.sql)), qs.map((q) => q.sql.slice(0, 80)));
    qs.length = 0;
    const r2 = await S.replayOwedTurn("crash-1");
    check("a database error in the crash replay's checks: the claim goes back and the text goes to the drain (never 'no member', never lost)", r2 === true && qs.some((q) => /^UPDATE inbound_webhook_handles SET retry_claimed_at = NULL WHERE handle = \$1/.test(q.sql) && q.params[0] === "crash-1") && S.heldInbound.has("crash-1"), qs.map((q) => q.sql.slice(0, 80)));
  }

  // ------------------------------------------------ review of #301 (5): a database blip after the claim never loses a recovered text
  const calls: { sql: string; params: any[] }[] = [];
  let checkRow: () => any = () => {
    throw Object.assign(new Error("Connection terminated unexpectedly"), {});
  };
  pool.query = async (sql: string, params: any[] = []) => {
    const q = flat(String(sql));
    calls.push({ sql: q, params });
    if (/^INSERT INTO inbound_webhook_handles .* RETURNING payload, received_at, retry_claimed_at/.test(q)) return { rows: [{ payload: { number: "+14155550164", content: SECRET, message_handle: params[0] }, received_at: new Date(Date.now() - 20 * 60_000), retry_claimed_at: null }] };
    if (/FROM users u WHERE u\.phone_number = \$1 LIMIT 1/.test(q) && /AS replied/.test(q)) return { rows: [checkRow()] };
    if (/^UPDATE inbound_webhook_handles SET retry_claimed_at = NOW\(\)/.test(q)) return { rows: [{ payload: { number: "+14155550164" }, received_at: new Date() }] };
    return { rows: [], rowCount: 0 };
  };
  const rec = { handle: "rec-1", payload: { number: "+14155550164", content: SECRET, message_handle: "rec-1" }, receivedAt: Date.now() - 20 * 60_000 };
  const threw = await S.replayRecovered(rec, { late: true }).then(() => "returned", (e: any) => (H.isDbUnreachable(e) ? "threw db" : `threw ${e?.message}`));
  check("the replay checks hitting a database error: it throws (stays held for the next pass), never reads as 'no member'", threw === "threw db", threw);
  check("... and the claim was never taken, so the next pass can claim it", !calls.some((c) => /^UPDATE inbound_webhook_handles SET retry_claimed_at = NOW\(\)/.test(c.sql)));
  calls.length = 0;
  checkRow = () => ({ id: "u1", sms_opted_out: true, archived_at: null, replied: false, last_inbound_at: null, call_status_updated_at: null });
  const blocked = await S.replayRecovered({ ...rec, handle: "rec-2", reclaim: true } as any, { late: true });
  const upsert = calls.find((c) => /^INSERT INTO inbound_webhook_handles/.test(c.sql));
  check("a held text whose earlier replay died on the database gives its claim back first (reclaim)", upsert?.params[3] === true && /retry_claimed_at = CASE WHEN \$4::boolean THEN NULL/.test(upsert?.sql ?? ""));
  check("an opted-out member's recovered text: checked, claimed (done), never replayed", blocked === false && calls.some((c) => /^UPDATE inbound_webhook_handles SET retry_claimed_at/.test(c.sql)) && !calls.some((c) => /INSERT INTO phone_debounce|turn.replay.*replayed/.test(c.sql)) && !calls.some((c) => /INSERT INTO harness_decisions/.test(c.sql) && c.params.includes("replayed")), { blocked, calls: calls.map((c) => c.sql.slice(0, 90)) });

  // ------------------------------------------------ review of #301 (6): the late line isn't said twice across a restart
  const sent: string[] = [];
  pool.query = async (sql: string, params: any[] = []) => {
    const q = flat(String(sql));
    if (/AS said_lately/.test(q)) return { rows: [{ id: "u-" + params[0], sms_opted_out: false, archived_at: null, said_lately: params[0] === "+14155550165" }] };
    if (/INSERT INTO outbound_messages/.test(q)) return sent.push(`${params[1]}|${params[2]}`), { rows: [] };
    if (/INSERT INTO co_memories/.test(q)) return { rows: [{ id: 1 }] };
    return { rows: [], rowCount: 0 };
  };
  const afterRestart = await S.sayLate("+14155550165");
  const fresh = await S.sayLate("+14155550166");
  await new Promise((r) => setTimeout(r, 50));
  check("the late line said in the last 30 minutes (on file, from before a restart): not said again", afterRestart === false && !sent.some((x) => x.startsWith("+14155550165")), sent);
  check("... otherwise it goes, the one fixed line", fresh === true && sent.includes(`+14155550166|${R.LATE_REPLY_LINE}`), sent);
}

// ---------------------------------------------------------------- the wiring (read from the source)
{
  const src = flat(read("routes/sendblue.ts"));
  check("a failed handle or payload save is noticed (no more .catch(() => true) / .catch(() => {}) that hid it)", /\.catch\(\(\) => \{ saveFailed = true; return true; \}\)/.test(src) && /\.catch\(\(\) => \{ saveFailed = true; \}\)/.test(src) && /if \(saveFailed && holdable\) held = holdInbound\(handle, req\.body, arrivedAt, true\)/.test(src));
  check("the turn's outcome decides (settleAction): answered leaves the hold, a database failure before any text goes to the drain", /await settleInbound\(\{ handle: typeof handle === "string" && handle \? handle : null, holdable, body: req\.body, arrivedAt: replay\?\.receivedAt \?\? arrivedAt, held, turnError, replied: repliedBeforeFailure \?\? false,/.test(src) && /const dbDown = failed && \(t\.held \|\| \(await dbDownFor\(t\.turnError, dbAnswers\)\)\)/.test(src));
  check("(2) whether it really answered them is the turn's own flag, opened after the late line, read at the failure before any failure note", /turnError = error; notePossibleReply\(\);.*tellMemberTurnFailed\(lockKey/.test(src) && /turnError = err; notePossibleReply\(\);/.test(src) && /repliedBeforeFailure \?\?= turnReplies\.replied;/.test(src) && /if \(!\(await beforeTurn\(\)\)\) return; \/\/[^\n]*? trackTurnReplies\(turnReplies\);/.test(src) && !/sendsTo/.test(src));
  check("(2) Cue's own 'looking' lines are sent as holds, in the turn and in the loop's search tool; every send reports through noteSent", /const sent = await \(hold \? asHoldSend\(send\) : send\(\)\);/.test(src) && /if \(await asHoldSend\(\(\) => say\(line\.trim\(\), `\$\{HOLD_PREFIX\} \$\{line\.trim\(\)\}`\)\)\)/.test(flat(read("agent/loopTools.ts"))) && /return sent\.then\(\(res: any\) => \{ noteSent\(\{ to, content, media: !!\(body as \{ media_url\?: string \}\)\.media_url \}\);/.test(flat(read("services/sendblue.ts"))));
  check("(3) the drain answers each member's held texts under their phone's lock; their replays don't take it again", /withLock: \(phone, fn\) => withPhoneLock\(phone, fn\)/.test(src) && /await replayHandler\(payload, receivedAt, \{ late: o\.late && !keyword, lockHeld: true \}\)/.test(src) && /await track\(lockKey && !replay\?\.lockHeld \? withPhoneLock\(lockKey, \(\) => traceTurn\(run\)\) : traceTurn\(run\)\);/.test(src));
  check("(5) recovered texts: checks strict and before the claim, STOP/START never blocked, one-shot claim, up to a day", /const member = await replayCheckRow\(phone, receivedAt, \{ strict: true \}\); const blocked = keyword \? null : turnReplayBlocked\(/.test(src) && /if \(!\(await claimRetry\(t\.handle, \{ strict: true \}\)\)\) return false;/.test(src) && /maxAgeMs: RECOVERED_MAX_AGE_MS/.test(src));
  check("(1) a live text behind a held STOP/START joins the hold instead of running first", /if \(taken === "defer" && holdable\) \{ inboundHold\.hold\(.*deferred = true; holdDrain\.kick\(\); return false; \}/.test(src) && /if \(!\(await beforeTurn\(\)\)\) return;/.test(src));
  check("a text taken into another's answer is claimed once (retry_claimed_at IS NULL) before its line goes on file", /DO UPDATE SET retry_claimed_at = NOW\(\).*WHERE inbound_webhook_handles\.retry_claimed_at IS NULL RETURNING handle/.test(src));
  check("a recovered text is owned by inserting its handle first: a webhook that got there first wins, one that comes later is a duplicate", /VALUES \(\$1, \$2::jsonb, \$3, NOW\(\)\) ON CONFLICT \(handle\) DO NOTHING RETURNING handle`, \[t\.handle, JSON\.stringify\(t\.payload\), new Date\(t\.receivedAt\)\],? \); if \(!rows\.length\) continue; inboundHold\.hold/.test(src));
  check("the late line is sent under the phone's lock, before the turn, and never counts as an answer (it's with the hold lines)", /const run = \(\) => withMember\(null, runTurn\); const runTurn = async \(\) => \{ try \{ \/\/[^\n]*?Never throws\. if \(!\(await beforeTurn\(\)\)\) return;/.test(src) && /const HOLD_LINES = \[[^\]]*LATE_REPLY_LINE\]/.test(src));
  check("Sendblue's list is read through the existing client and keys, for our number only", /client\.messages\.list\(\{ is_outbound: "false", sendblue_number: q\.sendblue_number/.test(flat(read("services/sendblue.ts"))) && /list: \(q\) => listInboundMessages\(\{ \.\.\.q, sendblue_number: ours! \}\)/.test(src));
  check("startup runs the recovery after migrations", /startInboundRecovery\(new Date\(\)\);/.test(read("server.ts")));
  check("no key is ever logged", !/SENDBLUE_(API|SECRET)_KEY/.test(read("services/inboundRecovery.ts") + read("services/inboundHold.ts") + read("services/inboundOutageAlert.ts")));
}

Object.assign(console, orig);
console.log(`never lose a text: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
