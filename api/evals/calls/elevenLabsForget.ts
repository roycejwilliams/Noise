// Model-free checks for deleting ElevenLabs' copy of a call on a schedule (services/elevenLabsForget.ts, 2026-10-18; schedule
// approved 2026-10-23). A stubbed ElevenLabs client and an in-memory database with its own clock: no API calls, nothing deleted,
// nothing fetched, no database.
//   npx tsx evals/calls/elevenLabsForget.ts
import { readFileSync } from "fs";
import {
  CONVERSATION_LINK_PREFIX,
  FORGET,
  attemptDelete,
  backfillMode,
  backfillReport,
  callKind,
  deleteAtElevenLabs,
  forgetAfterCall,
  forgetCallsNow,
  keepDays,
  linkFor,
  planBackfill,
  runBackfill,
  runDeletionPass,
  stuckDeletes,
  transcriptHash,
  type ForgetDeps,
} from "../../src/services/elevenLabsForget.js";
import { markCallReviewed } from "../../src/services/callHealth.js";
import { stuckDeleteFlags } from "../../src/harness/devReview.js";
import { callSaysRemoved, removalRows } from "../../src/services/whatCoKnows.js";
import { conversationLink } from "../../src/services/elevenLabsCalls.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

// Never logged, anywhere: the transcript's own words.
const SECRET = "user: my sister's diagnosis came back and I haven't told anyone";
const TRANSCRIPT = `assistant: Hey Jordan.\n${SECRET}\nassistant: I'm here.`;
const USER = "00000000-0000-0000-0000-000000000001";
const TEST_PHONE = "+14155550123"; // a test member (555-01xx, off production only)
const REAL_PHONE = "+14152223333";
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

type Row = { conversation_id: string; user_id: string; transcript_sha256: string | null; verify: boolean; last_outcome: string | null; status: string; window_kind: string; due_at: number; forget_requested_at: number | null; attempts: number; last_error: string | null; last_attempt_at: number | null; deleted_at: number | null; created_at: number };
type Mem = { user_id: string; memory_type: string; content: string; audio_url: string | null; created_at?: number };
type Health = { conversation_id: string; flagged: boolean; reviewed_at: number | null; late_done_at: number | null; ended_at?: number };

// An in-memory stand-in for the tables the module reads, answering the module's own queries by shape. NOW() is the fake's clock.
function fakeWorld(o: { memories?: Mem[]; processing?: Record<string, string>; throwOn?: RegExp; users?: Record<string, { phone: string; team?: boolean }> } = {}) {
  const rows = new Map<string, Row>();
  const health = new Map<string, Health>();
  const memories = o.memories ?? [];
  const processing = new Map(Object.entries(o.processing ?? {}));
  const queries: string[] = [];
  let now = T0;
  const t = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
  // holdSql: held when flagged-unreviewed (on production only until 30 days after the call), late signals open, or no health row
  // while the row is under 48h old.
  const held = (r: Row, prod: boolean) => {
    const h = health.get(r.conversation_id);
    if (!h) return r.created_at > now - FORGET.noHealthHoldHours * 60 * MIN;
    const flagHold = h.flagged && h.reviewed_at === null && !(prod && (h.ended_at ?? T0) <= now - FORGET.prodHoldDays * DAY);
    return flagHold || h.late_done_at === null;
  };
  const db = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
      queries.push(sql);
      if (o.throwOn && o.throwOn.test(sql)) throw new Error("connection refused");
      const p = params as any[];
      if (/INSERT INTO elevenlabs_deletions/.test(sql)) {
        const old = rows.get(p[0]);
        if (old && p[2] != null && !old.verify && old.status !== "deleted") {
          old.verify = true;
          old.transcript_sha256 = p[2];
        }
        if (!old) rows.set(p[0], { conversation_id: p[0], user_id: p[1], transcript_sha256: p[2] ?? null, verify: p[2] != null, last_outcome: null, status: "pending", window_kind: p[3], due_at: t(p[4]) + Number(p[5]) * DAY, forget_requested_at: null, attempts: 0, last_error: null, last_attempt_at: null, deleted_at: null, created_at: now });
        return { rows: [] };
      }
      if (/UPDATE elevenlabs_deletions d SET status = 'deleting'/.test(sql)) {
        const r = rows.get(p[0]);
        const stale = r && r.status === "deleting" && r.last_attempt_at !== null && r.last_attempt_at < now - p[1] * MIN;
        if (!r || !(r.status === "pending" || stale)) return { rows: [] };
        if (!(r.forget_requested_at !== null || (r.due_at <= now && !held(r, p[2] === true)))) return { rows: [] };
        r.status = "deleting";
        r.attempts++;
        r.last_attempt_at = now;
        return { rows: [{ user_id: r.user_id, transcript_sha256: r.transcript_sha256, attempts: r.attempts, forget_requested_at: r.forget_requested_at, verify: r.verify }] };
      }
      if (/UPDATE elevenlabs_deletions SET status = 'deleted'/.test(sql)) {
        const r = rows.get(p[0])!;
        r.status = "deleted";
        r.deleted_at = now;
        r.last_error = p[1];
        r.last_outcome = p[2];
        return { rows: [] };
      }
      if (/UPDATE elevenlabs_deletions SET status = 'pending', last_error = \$2, last_outcome = \$3/.test(sql)) {
        const r = rows.get(p[0])!;
        r.status = "pending";
        r.last_error = p[1];
        r.last_outcome = p[2];
        return { rows: [] };
      }
      if (/FROM elevenlabs_deletions\s+WHERE status <> 'deleted' AND attempts >= \$1/.test(sql))
        return { rows: [...rows.values()].filter((r) => r.status !== "deleted" && r.attempts >= p[0] && (p[1] === null || r.user_id === p[1])).map((r) => ({ ...r, created_at: new Date(r.created_at) })) };
      if (/UPDATE elevenlabs_deletions SET forget_requested_at/.test(sql)) {
        const r = rows.get(p[0]);
        if (r && r.user_id === p[1] && r.status !== "deleted") {
          r.forget_requested_at ??= now;
          if (r.attempts >= p[2]) r.attempts = 0;
        }
        return { rows: [] };
      }
      if (/SELECT content FROM co_memories WHERE user_id = \$1 AND memory_type = 'call_transcript' AND encode\(sha256/.test(sql))
        return { rows: memories.filter((m) => m.user_id === p[0] && m.memory_type === "call_transcript" && transcriptHash(m.content) === p[1]).map((m) => ({ content: m.content })) };
      if (/SELECT content FROM co_memories/.test(sql)) return { rows: memories.filter((m) => m.user_id === p[0] && m.memory_type === "call_transcript" && m.audio_url === p[1]).map((m) => ({ content: m.content })) };
      if (/SELECT status FROM call_processing/.test(sql)) return { rows: processing.has(p[0]) ? [{ status: processing.get(p[0]) }] : [] };
      if (/SELECT d\.conversation_id, m\.content FROM elevenlabs_deletions d/.test(sql)) {
        const out: any[] = [];
        for (const r of rows.values())
          if (r.user_id === p[0] && r.status !== "deleted") {
            const ms = memories.filter((m) => m.user_id === r.user_id && m.memory_type === "call_transcript" && m.audio_url === p[1] + r.conversation_id);
            if (ms.length) for (const m of ms) out.push({ conversation_id: r.conversation_id, content: m.content });
            else out.push({ conversation_id: r.conversation_id, content: null });
          }
        return { rows: out };
      }
      if (/SELECT d\.conversation_id FROM elevenlabs_deletions d/.test(sql)) {
        const retryMins = (r: Row) => (r.attempts >= p[0] ? FORGET.backoffMinutes : p[1]);
        const due = [...rows.values()].filter(
          (r) =>
            (r.forget_requested_at !== null || (r.due_at <= now && !held(r, p[3] === true))) &&
            ((r.status === "pending" && (r.last_attempt_at === null || r.last_attempt_at < now - retryMins(r) * MIN)) || (r.status === "deleting" && r.last_attempt_at !== null && r.last_attempt_at < now - p[2] * MIN)),
        );
        return { rows: due.sort((a, b) => (a.forget_requested_at === null ? 1 : 0) - (b.forget_requested_at === null ? 1 : 0) || a.due_at - b.due_at).slice(0, p[4]).map((r) => ({ conversation_id: r.conversation_id })) };
      }
      if (/UPDATE call_health SET reviewed_at = NOW\(\)/.test(sql)) {
        const h = health.get(p[0]);
        if (!h || !h.flagged) return { rows: [] };
        h.reviewed_at = now;
        return { rows: [{ conversation_id: p[0] }] };
      }
      if (/FROM co_memories m/.test(sql)) {
        const prefix = p[0] as string;
        // Postgres reads substring(x from $2) with an untyped parameter as the regex form (substring(text from pattern)), which
        // gives NULL here; only from $2::int is the 1-based position form. Every substring in the query must carry the cast.
        const subs = [...sql.matchAll(/substring\(m\.audio_url from (\$2(?:::int)?)\)/g)];
        const positional = subs.length === 3 && subs.every((m) => m[1] === "$2::int");
        return {
          rows: memories
            .filter((m) => m.memory_type === "call_transcript" && (m.audio_url ?? "").startsWith(prefix))
            .map((m) => {
              const id = positional ? m.audio_url!.slice(Number(p[1]) - 1) : null;
              const u = o.users?.[m.user_id] ?? { phone: REAL_PHONE };
              return { user_id: m.user_id, content: m.content, created_at: new Date(m.created_at ?? now), conversation_id: id, phone_number: u.phone, mo_approver: u.team ?? false, deletion_status: id ? (rows.get(id)?.status ?? null) : null, processing_status: id ? (processing.get(`el:${id}`) ?? null) : null };
            }),
        };
      }
      throw new Error(`fake db: unexpected query ${sql.slice(0, 60)}`);
    },
  };
  return { db, rows, health, queries, processing, advance: (minutes: number) => (now += minutes * MIN), now: () => new Date(now) };
}

const ENV = { ELEVENLABS_API_KEY: "ci", NODE_ENV: "test" } as NodeJS.ProcessEnv;
function fakeDeps(world: ReturnType<typeof fakeWorld>, o: { fail?: number | "always"; gone?: boolean; env?: NodeJS.ProcessEnv; throwWith?: string } = {}) {
  const removed: string[] = [];
  const logs: string[] = [];
  let calls = 0;
  const deps: ForgetDeps = {
    db: world.db,
    remove: async (id) => {
      calls++;
      if (o.fail === "always" || (typeof o.fail === "number" && calls <= o.fail)) throw new Error(o.throwWith ?? "ElevenLabs answered 503");
      removed.push(id);
      return o.gone ? "gone" : "deleted";
    },
    log: (l) => logs.push(l),
    env: o.env ?? ENV,
    now: world.now,
  };
  return { deps, removed, logs, calls: () => calls };
}

const storedWorld = (extra: Parameters<typeof fakeWorld>[0] = {}) =>
  fakeWorld({ memories: [{ user_id: USER, memory_type: "call_transcript", content: TRANSCRIPT, audio_url: conversationLink("conv_a") }], processing: { "el:conv_a": "completed" }, ...extra });
const call = (o: { id?: string; sha?: string; phone?: string; team?: boolean } = {}) => ({ userId: USER, conversationId: o.id ?? "conv_a", transcriptSha256: o.sha ?? transcriptHash(TRANSCRIPT), phone: o.phone ?? REAL_PHONE, team: o.team ?? false });
const noSecret = (logs: string[]) => logs.every((l) => !l.includes("diagnosis") && !l.includes(SECRET) && !l.includes("Jordan"));
// Runs the pass every 30 minutes for this many hours.
const passFor = async (w: ReturnType<typeof fakeWorld>, deps: ForgetDeps, hours: number) => {
  for (let i = 0; i < hours * 2; i++) {
    w.advance(30);
    await runDeletionPass(deps);
  }
};

// 1. Windows: 7 days for a member, 30 for the team and test numbers, counted from when our copy was stored.
{
  check("1a who: a test number is test, the team flag is team, anyone else is a member", callKind({ phone: TEST_PHONE, team: false }, ENV) === "test" && callKind({ phone: REAL_PHONE, team: true }, ENV) === "team" && callKind({ phone: REAL_PHONE, team: false }, ENV) === "member");
  check("1b a 555-01xx number is never 'test' on production", callKind({ phone: TEST_PHONE, team: false }, { NODE_ENV: "production" } as NodeJS.ProcessEnv) === "member");
  check("1c the windows are 7 and 30 days", keepDays("member") === 7 && keepDays("team") === 30 && keepDays("test") === 30 && FORGET.memberDays === 7 && FORGET.teamDays === 30);
}
{
  const w = storedWorld();
  const f = fakeDeps(w);
  const out = await forgetAfterCall(call(), f.deps);
  check("1d after the call: queued, nothing deleted", out === "queued" && f.calls() === 0 && w.rows.get("conv_a")?.status === "pending" && w.rows.get("conv_a")?.window_kind === "member");
  check("1e due 7 days after our copy was stored", w.rows.get("conv_a")!.due_at === T0 + 7 * DAY);
  await passFor(w, f.deps, 7 * 24 - 1);
  check("1f a member's call: still kept at day 6 and 23 hours", f.calls() === 0 && w.rows.get("conv_a")?.status === "pending");
  await passFor(w, f.deps, 1);
  check("1g a member's call: deleted on the first pass after day 7", f.removed.join() === "conv_a" && w.rows.get("conv_a")?.status === "deleted");
  check("1h logs name the conversation and the window, never the transcript", f.logs.some((l) => /queued conv_a \(member, due in 7 days\)/.test(l)) && f.logs.some((l) => /deleted conv_a at ElevenLabs/.test(l)) && noSecret(f.logs));
  const again = await forgetAfterCall(call(), f.deps);
  await passFor(w, f.deps, 2);
  check("1i a redelivered webhook for a deleted conversation deletes nothing more", again === "queued" && f.calls() === 1 && w.rows.get("conv_a")?.status === "deleted");
}
for (const [label, o] of [["the team", { team: true }], ["a test number", { phone: TEST_PHONE }]] as const) {
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(o), f.deps);
  await passFor(w, f.deps, 29 * 24);
  const kept = f.calls() === 0;
  await passFor(w, f.deps, 25);
  check(`1j ${label}: kept through day 29, deleted after day 30`, kept && f.removed.join() === "conv_a" && w.rows.get("conv_a")!.window_kind === (label === "the team" ? "team" : "test"));
}
{
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  check("1k a direct attempt before the window is refused by the claim itself", (await attemptDelete("conv_a", f.deps)) === "not_due" && f.calls() === 0 && w.rows.get("conv_a")?.attempts === 0);
}

// 2. Held: a flagged call (or one the member reported) is kept until reviewed, then normal deletion applies.
{
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.health.set("conv_a", { conversation_id: "conv_a", flagged: true, reviewed_at: null, late_done_at: T0 + 2 * DAY });
  await passFor(w, f.deps, 20 * 24);
  check("2a flagged and unreviewed: held well past its 7 days", f.calls() === 0 && w.rows.get("conv_a")?.status === "pending" && w.rows.get("conv_a")?.attempts === 0);
  check("2b marking it reviewed", (await markCallReviewed("conv_a", { db: w.db })) === true && w.health.get("conv_a")!.reviewed_at !== null);
  await passFor(w, f.deps, 1);
  check("2c reviewed, window long past: deleted on the next pass", f.removed.join() === "conv_a");
  check("2d marking a call that isn't flagged does nothing", (await markCallReviewed("conv_none", { db: w.db })) === false);
}
{
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.health.set("conv_a", { conversation_id: "conv_a", flagged: true, reviewed_at: null, late_done_at: T0 + 2 * DAY });
  await passFor(w, f.deps, 2 * 24);
  await markCallReviewed("conv_a", { db: w.db });
  await passFor(w, f.deps, 4 * 24);
  const early = f.calls() === 0;
  await passFor(w, f.deps, 25);
  check("2e reviewed early (day 2): still waits out its 7 days, then deleted", early && f.removed.join() === "conv_a");
}
{
  // The member reported it: the late pass flags it (callHealth.ts refreshLateHealth, tested in callHealth.ts); same hold.
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.health.set("conv_a", { conversation_id: "conv_a", flagged: false, reviewed_at: null, late_done_at: null });
  await passFor(w, f.deps, 8 * 24);
  const waited = f.calls() === 0;
  w.health.get("conv_a")!.late_done_at = w.now().getTime();
  await passFor(w, f.deps, 1);
  check("2f a clean call whose late signals are still being looked for waits; once closed it goes", waited && f.removed.join() === "conv_a");
}
{
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.health.set("conv_a", { conversation_id: "conv_a", flagged: false, reviewed_at: null, late_done_at: T0 + 2 * DAY });
  await passFor(w, f.deps, 7 * 24 + 1);
  check("2g a clean call (not flagged, late signals closed) goes at its window", f.removed.join() === "conv_a");
}

{
  // More held rows than one batch holds never keep a due, unheld one waiting.
  const mems: Mem[] = [];
  const processing: Record<string, string> = {};
  for (let i = 0; i <= FORGET.batch + 1; i++) {
    const id = `conv_${i}`;
    mems.push({ user_id: USER, memory_type: "call_transcript", content: `${TRANSCRIPT} ${i}`, audio_url: conversationLink(id) });
    processing[`el:${id}`] = "completed";
  }
  const w = fakeWorld({ memories: mems, processing });
  const f = fakeDeps(w);
  for (let i = 0; i <= FORGET.batch + 1; i++) {
    await forgetAfterCall(call({ id: `conv_${i}`, sha: transcriptHash(`${TRANSCRIPT} ${i}`) }), f.deps);
    if (i <= FORGET.batch) w.health.set(`conv_${i}`, { conversation_id: `conv_${i}`, flagged: true, reviewed_at: null, late_done_at: T0 });
  }
  await passFor(w, f.deps, 7 * 24 + 1);
  check("2h a batch's worth of held calls never starves a due one", f.removed.join() === `conv_${FORGET.batch + 1}`);
  const svc = readFileSync(new URL("../../src/services/elevenLabsForget.ts", import.meta.url), "utf8");
  const pass = svc.slice(svc.indexOf("export async function runDeletionPass("), svc.indexOf("export async function forgetCallsNow("));
  check("2i the pass's own SQL leaves held rows out", /WHERE \$\{holdSql\("\$4"\)\}/.test(pass) && /isProduction\(deps\.env\), FORGET\.batch\]/.test(pass));
}

// 3. Forget: a removal their call says deletes at once, whatever the window or hold.
{
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.health.set("conv_a", { conversation_id: "conv_a", flagged: true, reviewed_at: null, late_done_at: null });
  const out = await forgetCallsNow(USER, (t) => t.includes("diagnosis"), f.deps);
  check("3a forgotten: deleted immediately, on day 0, though flagged", out.deleted === 1 && f.removed.join() === "conv_a" && w.rows.get("conv_a")?.status === "deleted");
  check("3b the log says it was at their request, without their words", f.logs.some((l) => /forgotten at their request/.test(l)) && noSecret(f.logs));
}
{
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  const out = await forgetCallsNow(USER, () => false, f.deps);
  check("3c a removal their call doesn't say: nothing deleted, the window stands", Object.keys(out).length === 0 && f.calls() === 0 && w.rows.get("conv_a")?.forget_requested_at === null);
}
{
  const w = storedWorld();
  const f = fakeDeps(w, { fail: 1 });
  await forgetAfterCall(call(), f.deps);
  const first = await forgetCallsNow(USER, () => true, f.deps);
  await passFor(w, f.deps, 1);
  check("3d a forget whose delete fails is retried by the next pass, before its window", first.delete_failed === 1 && f.removed.join() === "conv_a" && w.now().getTime() < T0 + DAY);
}
{
  const w = storedWorld();
  const f = fakeDeps(w, { fail: "always" });
  await forgetAfterCall(call(), f.deps);
  w.rows.get("conv_a")!.attempts = FORGET.maxAttempts + 3;
  w.rows.get("conv_a")!.last_attempt_at = w.now().getTime();
  const f2 = fakeDeps(w);
  check("3e a forget gives a stuck conversation a fresh set of quick attempts", (await forgetCallsNow(USER, () => true, f2.deps)).deleted === 1 && f2.removed.join() === "conv_a" && w.rows.get("conv_a")!.attempts === 1);
}
{
  // The forget skips the stored-copy verify (they asked for it gone): our copy may already be gone too.
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.processing.set("el:conv_a", "failed");
  check("3f a forget doesn't need the verify to pass", (await forgetCallsNow(USER, () => true, f.deps)).deleted === 1);
}
{
  const w = storedWorld({ throwOn: /SELECT d\.conversation_id, m\.content/ });
  const f = fakeDeps(w);
  check("3g a forget whose read fails never throws", Object.keys(await forgetCallsNow(USER, () => true, f.deps)).length === 0);
}
{
  // The guard that decides "their call says it": the raw-words guard, specific removals only.
  const gone = removalRows([{ ref: "claim:9", source: "claim", was: "sister's diagnosis came back", now: null }, { ref: "claim:10", source: "claim", was: "moved to Oakland", now: "moved to Berkeley" }]);
  check("3h a removal is a guard row; a correction isn't", gone.length === 1 && gone[0].removed && gone[0].now === null);
  check("3i a call line of theirs saying the removed thing matches", callSaysRemoved(TRANSCRIPT, gone));
  check("3j Cue's own line saying it doesn't, nor an unrelated call", !callSaysRemoved("assistant: How's your sister's diagnosis came back thing?\nuser: fine, work is busy", gone) && !callSaysRemoved("user: the weather is lovely", gone));
  const city = removalRows([{ ref: "profile:city", source: "profile", was: "San Francisco", now: null }]);
  check("3k a one-kind removal (a city) never deletes a call", !callSaysRemoved("user: I live in San Francisco now", city));
  const wck = readFileSync(new URL("../../src/services/whatCoKnows.ts", import.meta.url), "utf8");
  const apply = wck.slice(wck.indexOf("export async function applyKnowledgeChanges("), wck.indexOf("// ---------------------------------------------------------------- what's queued on what changed"));
  check("3l applyKnowledgeChanges forgets calls on a removal, after the change committed, without waiting", apply.indexOf("F.forgetCallsNow(userId") > apply.indexOf('await client.query("COMMIT")') && /if \(applied\.some\(\(a\) => a\.now == null\)\)/.test(apply) && /void import\("\.\/elevenLabsForget\.js"\)/.test(apply));
}

// 3b. Review fixes (2026-10-23).
{
  // Production: a flagged, unreviewed call's hold ends 30 days after the call; on co-test it never does.
  const PROD = { ELEVENLABS_API_KEY: "ci", NODE_ENV: "production" } as NodeJS.ProcessEnv;
  for (const [label, env, gone] of [["production", PROD, true], ["co-test", ENV, false]] as const) {
    const w = storedWorld();
    const f = fakeDeps(w, { env });
    await forgetAfterCall(call(), f.deps);
    w.health.set("conv_a", { conversation_id: "conv_a", flagged: true, reviewed_at: null, late_done_at: T0 + 2 * DAY, ended_at: T0 });
    await passFor(w, f.deps, 29 * 24);
    const kept = f.calls() === 0;
    await passFor(w, f.deps, 25);
    check(`3m ${label}: a flagged call is held through day 29; after day 30 it ${gone ? "goes" : "is still held"}`, kept && (gone ? f.removed.join() === "conv_a" : f.calls() === 0));
  }
}
{
  // Nothing stored (voicemail, empty transcript, no real conversation, a processing failure): queued, nothing to verify.
  const w = fakeWorld({ processing: { "el:conv_v": "failed" } });
  const f = fakeDeps(w);
  check("3n a call with nothing stored is queued, unverified", (await forgetAfterCall({ ...call({ id: "conv_v" }), transcriptSha256: null }, f.deps)) === "queued" && w.rows.get("conv_v")?.verify === false && w.rows.get("conv_v")?.transcript_sha256 === null && f.logs.some((l) => /nothing stored to verify/.test(l)));
  await passFor(w, f.deps, 7 * 24 - 1);
  const kept = f.calls() === 0;
  await passFor(w, f.deps, 2);
  check("3o deleted on the member's 7-day window with nothing to verify", kept && f.removed.join() === "conv_v");
  const wt = fakeWorld();
  const ft = fakeDeps(wt);
  await forgetAfterCall({ ...call({ id: "conv_t", team: true }), transcriptSha256: null }, ft.deps);
  check("3p and on 30 days for the team", wt.rows.get("conv_t")!.due_at === T0 + 30 * DAY && wt.rows.get("conv_t")!.window_kind === "team");
}
{
  // A failed delivery queued unverified, then a retried one stores the transcript: the row becomes a verified one.
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall({ ...call(), transcriptSha256: null }, f.deps);
  await forgetAfterCall(call({ sha: transcriptHash("assistant: not what we stored") }), f.deps);
  check("3q a later store turns the unverified row verified", w.rows.get("conv_a")!.verify === true && w.rows.get("conv_a")!.transcript_sha256 === transcriptHash("assistant: not what we stored"));
  await passFor(w, f.deps, 7 * 24 + 1);
  check("3r and then it is verified like any stored call (a mismatch keeps it)", f.calls() === 0 && w.rows.get("conv_a")!.last_outcome === "not_stored");
}
{
  // processEndedCall keeps one row for identical content: the transcript is stored under another call's link.
  const w = fakeWorld({ memories: [{ user_id: USER, memory_type: "call_transcript", content: TRANSCRIPT, audio_url: conversationLink("conv_first") }], processing: { "el:conv_dup": "completed" } });
  const f = fakeDeps(w);
  await forgetAfterCall(call({ id: "conv_dup" }), f.deps);
  await passFor(w, f.deps, 7 * 24 + 1);
  check("3s the same transcript stored under another link still counts as stored", f.removed.join() === "conv_dup");
}
{
  // Deleting the account: every call forgotten first, stored or not; a failure is retried after the account is gone.
  const w = storedWorld();
  const f = fakeDeps(w, { fail: 1 });
  await forgetAfterCall(call(), f.deps);
  await forgetAfterCall({ ...call({ id: "conv_v" }), transcriptSha256: null }, f.deps);
  const out = await forgetCallsNow(USER, () => true, f.deps);
  check("3t account deletion forgets every call at once, including one with nothing stored", out.deleted === 1 && out.delete_failed === 1 && w.rows.get("conv_a")!.forget_requested_at !== null && w.rows.get("conv_v")!.forget_requested_at !== null);
  await passFor(w, f.deps, 1);
  check("3u the one that failed is retried by the next pass", f.removed.length === 2 && [...w.rows.values()].every((r) => r.status === "deleted"));
  const users = readFileSync(new URL("../../src/routes/users.ts", import.meta.url), "utf8");
  const del = users.slice(users.indexOf('router.delete(\n    "/:id"'), users.indexOf("DELETE FROM users WHERE id = $1"));
  check("3v the account delete forgets their calls before it deletes the user", /await forgetCallsNow\(req\.params\.id, \(\) => true\);/.test(del));
}
{
  const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
  const route = co.slice(co.indexOf('router.post("/el/post-call"'), co.indexOf("// Root-cause guard"));
  check("3w the route queues unstored calls: missed calls, a processing failure, and processing that stored nothing", /handleMissedVoiceCall\(u\[0\], callSid, kind, conversationId\);\n\s*queueUnstored\(\);/.test(route) && /\} catch \(err\) \{[\s\S]{0,200}queueUnstored\(\);\n\s*throw err;/.test(route) && /else if \(ended\.unstored\) queueUnstored\(\);/.test(route) && /transcriptSha256: null/.test(route));
  const pe = co.slice(co.indexOf("async function processEndedCall("), co.indexOf("async function scheduleFollowUpText("));
  check("3x processEndedCall marks voicemail, empty and no-conversation as unstored (never the duplicate paths)", /skipped: "voicemail" \}, unstored: true/.test(pe) && /empty: true \}, unstored: true/.test(pe) && /noRealConversation: true \}, unstored: true/.test(pe) && !/duplicate: true \}, unstored/.test(pe));
}

// 4. Never delete what we haven't stored (the scheduled path verifies every time).
{
  const w = fakeWorld({ processing: { "el:conv_a": "completed" } });
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  await passFor(w, f.deps, 7 * 24 + 1);
  check("4a due, but the transcript was never stored: nothing deleted, reason logged", f.calls() === 0 && w.rows.get("conv_a")?.status === "pending" && f.logs.some((l) => /kept conv_a \(attempt 1\): no stored transcript/.test(l)) && noSecret(f.logs));
}
for (const [label, mem] of [
  ["a different transcript (hash differs)", { user_id: USER, memory_type: "call_transcript", content: "assistant: a different call", audio_url: conversationLink("conv_a") }],
  ["an empty stored row", { user_id: USER, memory_type: "call_transcript", content: "   ", audio_url: conversationLink("conv_a") }],
  ["another member's row", { user_id: "someone-else", memory_type: "call_transcript", content: TRANSCRIPT, audio_url: conversationLink("conv_a") }],
  ["a row that isn't a call_transcript", { user_id: USER, memory_type: "text_exchange", content: TRANSCRIPT, audio_url: conversationLink("conv_a") }],
] as const) {
  const w = fakeWorld({ memories: [mem as Mem], processing: { "el:conv_a": "completed" } });
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.advance(7 * 24 * 60 + 1);
  await runDeletionPass(f.deps);
  check(`4b ${label}: not stored, nothing deleted`, f.calls() === 0 && w.rows.get("conv_a")?.status === "pending");
}
for (const status of ["processing", "failed", undefined]) {
  const w = storedWorld({ processing: status ? { "el:conv_a": status } : {} });
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.advance(7 * 24 * 60 + 1);
  await runDeletionPass(f.deps);
  check(`4c processing ${status ?? "not on file"}: nothing deleted`, f.calls() === 0 && w.rows.get("conv_a")?.status === "pending");
}
{
  const w = storedWorld({ throwOn: /SELECT content FROM co_memories/ });
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.advance(7 * 24 * 60 + 1);
  check("4d the stored-check query fails: nothing deleted, kept pending", (await attemptDelete("conv_a", f.deps)) === "error" && f.calls() === 0 && w.rows.get("conv_a")?.status === "pending" && f.logs.some((l) => /verify failed \(connection refused\)/.test(l)));
}
{
  const w = storedWorld({ throwOn: /INSERT INTO elevenlabs_deletions/ });
  const f = fakeDeps(w);
  check("4e queueing fails: nothing queued or deleted, never throws", (await forgetAfterCall(call(), f.deps)) === "error" && f.calls() === 0);
}
{
  const f = fakeDeps(storedWorld());
  check("4f no conversation id: nothing", (await forgetAfterCall(call({ id: "" }), f.deps)) === "no_id" && f.calls() === 0);
}

// 5. Failures are retried on the next run, bounded.
{
  const w = storedWorld();
  const f = fakeDeps(w, { fail: "always" });
  await forgetAfterCall(call(), f.deps);
  w.advance(7 * 24 * 60);
  await runDeletionPass(f.deps);
  check("5a delete fails: kept pending with the attempt counted", w.rows.get("conv_a")?.status === "pending" && w.rows.get("conv_a")?.attempts === 1);
  w.advance(30);
  await runDeletionPass(f.deps);
  check("5b the very next run (30 minutes on) retries it", f.calls() === 2);
  await passFor(w, f.deps, 10);
  check(`5c ${FORGET.maxAttempts} quick attempts, then it backs off (no more within the day)`, f.calls() === FORGET.maxAttempts && w.rows.get("conv_a")?.status === "pending");
  await passFor(w, f.deps, 24);
  check("5c2 then once a day, never given up", f.calls() === FORGET.maxAttempts + 1 && w.rows.get("conv_a")?.status === "pending");
  check("5d the backing-off attempt says so; every failure logged without text", f.logs.some((l) => /attempt 5\).*retried once a day/.test(l)) && noSecret(f.logs));
  const stuck = await stuckDeletes({}, { db: w.db });
  check("5d2 it is stuck: listed with codes only (id, attempts, last outcome)", stuck.length === 1 && stuck[0].conversationId === "conv_a" && stuck[0].lastOutcome === "delete_failed" && stuck[0].attempts === FORGET.maxAttempts + 1);
  const flags = stuckDeleteFlags(stuck);
  check("5d3 the morning review shows it, codes only", flags.length === 1 && flags[0].type === "elevenlabs_delete_stuck" && flags[0].snippet === `call conv_a: ${FORGET.maxAttempts + 1} attempts, last delete_failed` && noSecret([JSON.stringify(flags)]));
  const dr = readFileSync(new URL("../../src/harness/devReview.ts", import.meta.url), "utf8");
  check("5d4 the review reads stuck deletes per member", /stuckDeleteFlags\(await stuckDeletes\(\{ userId \}\)\.catch\(\(\) => \[\] as StuckDelete\[\]\)\)/.test(dr));
  const later = fakeDeps(w);
  await passFor(w, later.deps, 24);
  check("5d5 a stuck row that finally works is deleted and leaves the list", later.removed.join() === "conv_a" && (await stuckDeletes({}, { db: w.db })).length === 0);
}
{
  const w = storedWorld();
  const f = fakeDeps(w, { fail: 2 });
  await forgetAfterCall(call(), f.deps);
  w.advance(7 * 24 * 60);
  await passFor(w, f.deps, 2);
  check("5e a transient failure clears on a later run", f.removed.join() === "conv_a" && w.rows.get("conv_a")?.status === "deleted");
}
{
  const w = storedWorld();
  const f = fakeDeps(w, { gone: true });
  await forgetAfterCall(call(), f.deps);
  w.advance(7 * 24 * 60);
  check("5f ElevenLabs already lost it (404): marked deleted, said so", (await attemptDelete("conv_a", f.deps)) === "gone" && w.rows.get("conv_a")?.last_error === "already gone at ElevenLabs");
}
{
  const w = storedWorld();
  const f = fakeDeps(w);
  await forgetAfterCall(call(), f.deps);
  w.advance(7 * 24 * 60);
  const r = w.rows.get("conv_a")!;
  r.status = "deleting";
  r.attempts = 1;
  r.last_attempt_at = w.now().getTime();
  check("5g a fresh 'deleting' claim is left alone", (await attemptDelete("conv_a", f.deps)) === "not_due" && f.calls() === 0);
  w.advance(FORGET.staleClaimMinutes + 1);
  await runDeletionPass(f.deps);
  check("5h a stale claim is taken over and verified again before deleting", f.removed.join() === "conv_a" && r.attempts === 2);
}

// 6. Switches.
{
  const w = storedWorld();
  const f = fakeDeps(w, { env: { ELEVENLABS_API_KEY: "ci", ELEVENLABS_DELETE: "off" } as NodeJS.ProcessEnv });
  await forgetAfterCall(call(), f.deps);
  await passFor(w, f.deps, 8 * 24);
  const forgot = await forgetCallsNow(USER, () => true, f.deps);
  check("6a kill switch ELEVENLABS_DELETE=off: nothing deleted (forget included), no attempt used", f.calls() === 0 && w.rows.get("conv_a")?.attempts === 0 && forgot.paused === 1);
  const on = fakeDeps(w);
  await runDeletionPass(on.deps);
  check("6b switched back on: the forgotten one goes first", on.removed.join() === "conv_a");
}
{
  const w = storedWorld();
  const f = fakeDeps(w, { env: {} as NodeJS.ProcessEnv });
  await forgetAfterCall(call(), f.deps);
  w.advance(8 * 24 * 60);
  check("6c no ElevenLabs key: nothing deleted", Object.keys(await runDeletionPass(f.deps)).length === 0 && (await attemptDelete("conv_a", f.deps)) === "no_key" && f.calls() === 0);
}

// 7. The real client: the DELETE it sends and what it throws (global fetch faked for this block; nothing leaves the machine).
{
  const realFetch = globalThis.fetch;
  const seen: { url: string; init: any }[] = [];
  let answer = 200;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return new Response(answer === 200 ? "{}" : `{"detail":"${SECRET}"}`, { status: answer });
  }) as typeof fetch;
  try {
    const ok = await deleteAtElevenLabs("conv/x", { ELEVENLABS_API_KEY: "k1" } as NodeJS.ProcessEnv);
    check("7a DELETE /v1/convai/conversations/{id}, id encoded, with the xi-api-key header", ok === "deleted" && seen[0].url === "https://api.elevenlabs.io/v1/convai/conversations/conv%2Fx" && seen[0].init.method === "DELETE" && seen[0].init.headers["xi-api-key"] === "k1");
    answer = 500;
    const err = await deleteAtElevenLabs("conv_x").then(() => null, (e) => e as Error);
    check("7b a failure throws the status only, never the body", !!err && err.message === "ElevenLabs answered 500");
    answer = 404;
    check("7c 404 is 'gone'", (await deleteAtElevenLabs("conv_x")) === "gone");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 8. The post-call route: queues (never deletes) after the store, never waits on it.
{
  const w = storedWorld({ throwOn: /./ });
  const f = fakeDeps(w, { fail: "always" });
  let threw = false;
  const out = await forgetAfterCall(call(), f.deps).catch(() => {
    threw = true;
  });
  check("8a every step failing: forgetAfterCall still resolves, never throws", !threw && out === "error");
  check("8b even a missing database resolves", (await forgetAfterCall(call(), { ...f.deps, db: null as any })) === "error");
  const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
  const route = co.slice(co.indexOf('router.post("/el/post-call"'), co.indexOf("// Root-cause guard"));
  const at = route.indexOf("if (ended.stored && u[0]) forgetAfterCall(");
  check("8c the route queues after processEndedCall and before answering the webhook", at > route.indexOf("await processEndedCall(") && at < route.indexOf("return res.status(ended.status)"));
  check("8d not awaited, caught, only when the processing stored the transcript, with the team flag", /\n\s*if \(ended\.stored && u\[0\]\) forgetAfterCall\(\{[^\n]*team: u\[0\]\.mo_approver === true \}\)\.catch\(\(\) => \{\}\);/.test(route) && !/await forgetAfterCall/.test(co) && /SELECT id, first_name, phone_number, call_sid, mo_approver FROM users/.test(route));
  const pe = co.slice(co.indexOf("async function processEndedCall("), co.indexOf("async function scheduleFollowUpText("));
  const storedAt = pe.indexOf("stored: { transcriptSha256: transcriptHash(transcript) }");
  check("8e processEndedCall sets stored once, on the path that stored the transcript and marked the call completed", storedAt > 0 && pe.split("stored: {").length === 2 && storedAt > pe.indexOf("storeTranscriptMemory(") && storedAt > pe.indexOf(`finishCallProcessing(chat_id, "completed");\n\n      // Profile is fully extracted`));
  const svc = readFileSync(new URL("../../src/services/elevenLabsForget.ts", import.meta.url), "utf8");
  const fac = svc.slice(svc.indexOf("export async function forgetAfterCall("), svc.indexOf("// The claim:"));
  check("8f forgetAfterCall only queues: it never calls the delete", !/attemptDelete|deps\.remove/.test(fac));
}

// 9. Backfill: dry run counts and writes nothing; apply queues with windows from when our copy was stored.
{
  const mems: Mem[] = [
    { user_id: USER, memory_type: "call_transcript", content: TRANSCRIPT, audio_url: conversationLink("conv_old"), created_at: T0 - 30 * DAY },
    { user_id: USER, memory_type: "call_transcript", content: "assistant: hi\nuser: a recent one", audio_url: conversationLink("conv_new"), created_at: T0 - 2 * DAY },
    { user_id: "u-team", memory_type: "call_transcript", content: "assistant: hi\nuser: team call", audio_url: conversationLink("conv_team"), created_at: T0 - 10 * DAY },
    { user_id: USER, memory_type: "call_transcript", content: "assistant: hi\nuser: hello there friend", audio_url: conversationLink("conv_unfinished") },
    { user_id: USER, memory_type: "call_transcript", content: "", audio_url: conversationLink("conv_empty") },
    { user_id: USER, memory_type: "call_transcript", content: "assistant: old\nuser: an old one", audio_url: conversationLink("conv_done") },
    { user_id: USER, memory_type: "call_transcript", content: "hume era", audio_url: "https://hume.example/audio/1" },
    { user_id: USER, memory_type: "call_transcript", content: "no link", audio_url: null },
  ];
  const processing = { "el:conv_old": "completed", "el:conv_new": "completed", "el:conv_team": "completed", "el:conv_unfinished": "failed", "el:conv_empty": "completed", "el:conv_done": "completed" };
  const w = fakeWorld({ memories: mems, processing, users: { "u-team": { phone: REAL_PHONE, team: true } } });
  await w.db.query(`INSERT INTO elevenlabs_deletions`, ["conv_done", USER, "x", "member", new Date(T0), 7]);
  w.rows.get("conv_done")!.status = "deleted";
  w.queries.length = 0;
  const f = fakeDeps(w);
  const { plan, queued } = await runBackfill(f.deps, backfillMode([]));
  check("9a dry run is the default; --apply is the only way to queue", backfillMode([]) === "dry-run" && backfillMode(["--dry-run"]) === "dry-run" && backfillMode(["--apply"]) === "apply");
  check("9b dry run: nothing deleted, nothing written (one read)", f.calls() === 0 && queued === 0 && w.queries.length === 1 && w.queries.every((q) => !/\b(INSERT|UPDATE|DELETE)\b/.test(q)));
  check("9c it counts each kind, and which are past their window", plan.storedConversations === 6 && plan.wouldQueue === 3 && plan.dueNow === 1 && plan.notFinished === 1 && plan.notStored === 1 && plan.alreadyDeleted === 1);
  const report = f.logs.join("\n");
  check("9d the report is counts only: no conversation ids, no text", /would queue \(stored, processing completed\): 3/.test(report) && !/conv_/.test(report) && noSecret(f.logs));
  const f2 = fakeDeps(w);
  const applied = await runBackfill(f2.deps, "apply");
  check("9e apply queues, deletes nothing itself", applied.queued === 3 && f2.calls() === 0);
  check("9f windows count from when our copy was stored, by who it was with", w.rows.get("conv_old")!.due_at === T0 - 23 * DAY && w.rows.get("conv_new")!.due_at === T0 + 5 * DAY && w.rows.get("conv_team")!.due_at === T0 + 20 * DAY && w.rows.get("conv_team")!.window_kind === "team");
  await passFor(w, f2.deps, 47);
  const heldNoHealth = f2.calls() === 0;
  await passFor(w, f2.deps, 2);
  check("9g with no health row they wait out the 48h late window, then only what is past its window goes, verified", heldNoHealth && f2.removed.join() === "conv_old");
  check("9h backfillReport reads 'to queue' on apply", /to queue \(stored, processing completed\)/.test(backfillReport(plan, "apply")));
  const again = await planBackfill(f2.deps, w.now());
  check("9i a second run queues nothing more", again.wouldQueue === 0 && again.alreadyQueued === 2 && again.alreadyDeleted === 2);
  // Review of #244: substring(... from $2) with an untyped parameter is Postgres' regex form, so every id came back NULL.
  const svcSrc = readFileSync(new URL("../../src/services/elevenLabsForget.ts", import.meta.url), "utf8");
  const subs = [...svcSrc.matchAll(/substring\(([^)]*)\)/g)].map((m) => m[1]);
  check("9j every substring in the backfill query takes its position as $2::int (never the regex form)", subs.length === 3 && subs.every((x) => x === "m.audio_url from $2::int"));
  const offset = CONVERSATION_LINK_PREFIX.length + 1;
  check("9k the position passed is the prefix length + 1, and 1-based slicing there gives back the id", /\[CONVERSATION_LINK_PREFIX, CONVERSATION_LINK_PREFIX\.length \+ 1\]/.test(svcSrc) && linkFor("conv_a1b2").slice(offset - 1) === "conv_a1b2" && conversationLink("x9").slice(offset - 1) === "x9");
  const script = readFileSync(new URL("../../src/scripts/forgetElevenLabsBackfill.ts", import.meta.url), "utf8");
  check("9l the script takes its mode from the arguments only (dry run unless --apply)", /backfillMode\(process\.argv\.slice\(2\)\)/.test(script) && !/"apply"/.test(script));
}

// 10. Wiring and the SQL the fake can't prove.
{
  const mig = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
  check("10a the table has due_at, window_kind and forget_requested_at, a hash and no transcript column", /CREATE TABLE IF NOT EXISTS elevenlabs_deletions \(/.test(mig) && /due_at TIMESTAMPTZ NOT NULL/.test(mig) && /forget_requested_at TIMESTAMPTZ/.test(mig) && /transcript_sha256 TEXT,/.test(mig) && /verify BOOLEAN NOT NULL DEFAULT true/.test(mig) && !/elevenlabs_deletions \([^)]*\bcontent\b/.test(mig));
  const tbl = mig.slice(mig.indexOf("CREATE TABLE IF NOT EXISTS elevenlabs_deletions ("), mig.indexOf("idx_elevenlabs_deletions_due"));
  check("10a2 no foreign key on users (the queue outlives a deleted account), and an existing one is dropped", !/REFERENCES users/.test(tbl) && /DROP CONSTRAINT IF EXISTS elevenlabs_deletions_user_id_fkey/.test(tbl));
  const jobs = readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
  const job = jobs.slice(jobs.indexOf("refreshLateHealth"), jobs.indexOf("refreshLateHealth") + 400);
  check("10b scheduled: the late health signals, then the deletion pass", /cron\.schedule\("\*\/30 \* \* \* \*"/.test(jobs) && job.indexOf("await refreshLateHealth()") < job.indexOf("await runDeletionPass()") && job.includes("await runDeletionPass()"));
  const svc = readFileSync(new URL("../../src/services/elevenLabsForget.ts", import.meta.url), "utf8");
  check("10c no switch turns it on: the only env read besides the key is the off switch", [...svc.matchAll(/env\.([A-Z_]+)/g)].every((m) => ["ELEVENLABS_API_KEY", "ELEVENLABS_DELETE"].includes(m[1])) && /ELEVENLABS_DELETE === "off"/.test(svc));
  const claim = svc.slice(svc.indexOf("const CLAIM_SQL"), svc.indexOf("RETURNING d.user_id"));
  const hold = svc.slice(svc.indexOf("export const holdSql"), svc.indexOf("// After FORGET.maxAttempts quick tries"));
  check("10d the claim's SQL carries the hold", /AND \$\{holdSql\("\$3"\)\}/.test(claim) && /CLAIM_SQL, \[conversationId, FORGET\.staleClaimMinutes, isProduction\(deps\.env\)\]/.test(svc));
  check("10d2 the hold: due unless forgotten; flagged-unreviewed (expiring on production only), late signals open, or no health row under 48h", /d\.forget_requested_at IS NOT NULL OR \(d\.due_at <= NOW\(\)/.test(hold) && /\(h\.flagged AND h\.reviewed_at IS NULL AND NOT \(\$\{prod\}::boolean AND h\.ended_at <= NOW\(\) - make_interval\(days => \$\{FORGET\.prodHoldDays\}\)\)\) OR h\.late_done_at IS NULL/.test(hold) && /EXISTS \(SELECT 1 FROM call_health h2 WHERE h2\.conversation_id = d\.conversation_id\) OR d\.created_at <= NOW\(\) - make_interval\(hours => \$\{FORGET\.noHealthHoldHours\}\)/.test(hold) && FORGET.prodHoldDays === 30 && FORGET.noHealthHoldHours === 48);
  check("10e the queue's due time is the stored time plus the window's days", /\$5::timestamptz \+ make_interval\(days => \$6\)/.test(svc));
  check("10e2 queueing: verified only with a hash; a later store upgrades an unverified row, never a deleted one", /\$3::text IS NOT NULL\)/.test(svc) && /ON CONFLICT \(conversation_id\) DO UPDATE SET verify = true, transcript_sha256 = EXCLUDED\.transcript_sha256, updated_at = NOW\(\)\n\s*WHERE EXCLUDED\.verify AND NOT elevenlabs_deletions\.verify AND elevenlabs_deletions\.status <> 'deleted'`/.test(svc));
  check("10f the retry interval is shorter than the 30-minute run, so the next run always retries", FORGET.retryAfterMinutes < 30);
  const l1 = JSON.parse(readFileSync(new URL("../layer1.json", import.meta.url), "utf8"));
  check("10g registered in layer 1", l1.files.includes("evals/calls/elevenLabsForget.ts") && l1.files.includes("evals/calls/callHealth.ts"));
}

console.log(`elevenlabs forget rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
