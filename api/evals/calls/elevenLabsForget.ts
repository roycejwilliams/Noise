// Model-free checks for deleting ElevenLabs' copy of a call (services/elevenLabsForget.ts, 2026-10-18). A stubbed ElevenLabs
// client and an in-memory database: no API calls, nothing deleted, nothing fetched, no database.
//   npx tsx evals/calls/elevenLabsForget.ts
import { readFileSync } from "fs";
import {
  FORGET,
  attemptDelete,
  backfillMode,
  backfillReport,
  deleteAtElevenLabs,
  forgetAfterCall,
  linkFor,
  planBackfill,
  retryPendingDeletes,
  runBackfill,
  transcriptHash,
  type ForgetDeps,
} from "../../src/services/elevenLabsForget.js";
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
const PHONE = "+14155550123"; // a test member (555-01xx): voice flags may run for it
const REAL_PHONE = "+14152223333"; // a member's number: voice flags never run for it

type Row = { conversation_id: string; user_id: string; transcript_sha256: string; status: string; attempts: number; last_error: string | null; last_attempt_at: number | null; deleted_at: number | null; created_at: number };
type Mem = { user_id: string; memory_type: string; content: string; audio_url: string | null };

// An in-memory stand-in for the three tables the module reads, answering the module's own queries by shape.
function fakeWorld(o: { memories?: Mem[]; processing?: Record<string, string>; throwOn?: RegExp; users?: Record<string, string> } = {}) {
  const rows = new Map<string, Row>();
  const memories = o.memories ?? [];
  const processing = new Map(Object.entries(o.processing ?? {}));
  const queries: string[] = [];
  let now = 1_800_000_000_000;
  const min = 60_000;
  const db = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
      queries.push(sql);
      if (o.throwOn && o.throwOn.test(sql)) throw new Error("connection refused");
      const p = params as any[];
      if (/INSERT INTO elevenlabs_deletions/.test(sql)) {
        if (!rows.has(p[0])) rows.set(p[0], { conversation_id: p[0], user_id: p[1], transcript_sha256: p[2], status: /'held'/.test(sql) ? "held" : "pending", attempts: 0, last_error: /'held'/.test(sql) ? p[3] : null, last_attempt_at: null, deleted_at: null, created_at: now });
        return { rows: [] };
      }
      if (/UPDATE elevenlabs_deletions SET status = 'deleting'/.test(sql)) {
        const r = rows.get(p[0]);
        const stale = r && r.status === "deleting" && r.last_attempt_at !== null && r.last_attempt_at < now - p[2] * min;
        if (!r || r.attempts >= p[1] || !(r.status === "pending" || stale)) return { rows: [] };
        r.status = "deleting";
        r.attempts++;
        r.last_attempt_at = now;
        return { rows: [{ user_id: r.user_id, transcript_sha256: r.transcript_sha256, attempts: r.attempts }] };
      }
      if (/UPDATE elevenlabs_deletions SET status = 'deleted'/.test(sql)) {
        const r = rows.get(p[0])!;
        r.status = "deleted";
        r.deleted_at = now;
        r.last_error = p[1];
        return { rows: [] };
      }
      if (/UPDATE elevenlabs_deletions SET status = \$2/.test(sql)) {
        const r = rows.get(p[0])!;
        r.status = p[1];
        r.last_error = p[2];
        return { rows: [] };
      }
      if (/SELECT content FROM co_memories/.test(sql)) return { rows: memories.filter((m) => m.user_id === p[0] && m.memory_type === "call_transcript" && m.audio_url === p[1]).map((m) => ({ content: m.content })) };
      if (/SELECT status FROM call_processing/.test(sql)) return { rows: processing.has(p[0]) ? [{ status: processing.get(p[0]) }] : [] };
      if (/SELECT conversation_id FROM elevenlabs_deletions/.test(sql)) {
        const due = [...rows.values()].filter((r) => r.attempts < p[0] && ((r.status === "pending" && (r.last_attempt_at === null || r.last_attempt_at < now - p[1] * min)) || (r.status === "deleting" && r.last_attempt_at !== null && r.last_attempt_at < now - p[2] * min)));
        return { rows: due.sort((a, b) => a.created_at - b.created_at).slice(0, p[3]).map((r) => ({ conversation_id: r.conversation_id })) };
      }
      if (/FROM co_memories m/.test(sql)) {
        const prefix = p[0] as string;
        return {
          rows: memories
            .filter((m) => m.memory_type === "call_transcript" && (m.audio_url ?? "").startsWith(prefix))
            .map((m) => {
              const id = m.audio_url!.slice(prefix.length);
              return { user_id: m.user_id, content: m.content, conversation_id: id, phone_number: o.users?.[m.user_id] ?? REAL_PHONE, deletion_status: rows.get(id)?.status ?? null, processing_status: processing.get(`el:${id}`) ?? null };
            }),
        };
      }
      throw new Error(`fake db: unexpected query ${sql.slice(0, 60)}`);
    },
  };
  return { db, rows, queries, processing, advance: (minutes: number) => (now += minutes * min) };
}

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
    env: o.env ?? ({ ELEVENLABS_API_KEY: "ci", NODE_ENV: "test" } as NodeJS.ProcessEnv),
  };
  return { deps, removed, logs, calls: () => calls };
}

const storedWorld = (extra: Parameters<typeof fakeWorld>[0] = {}) =>
  fakeWorld({ memories: [{ user_id: USER, memory_type: "call_transcript", content: TRANSCRIPT, audio_url: conversationLink("conv_a") }], processing: { "el:conv_a": "completed" }, ...extra });
const call = (id = "conv_a", sha = transcriptHash(TRANSCRIPT), phone: string = REAL_PHONE) => ({ userId: USER, conversationId: id, transcriptSha256: sha, phone });
const noSecret = (logs: string[]) => logs.every((l) => !l.includes("diagnosis") && !l.includes(SECRET) && !l.includes("Jordan"));

// 1. Order: delete only after a confirmed store.
{
  const w = storedWorld();
  const f = fakeDeps(w);
  const out = await forgetAfterCall(call(), f.deps);
  check("1a stored, verified and processing completed: deleted once", out === "deleted" && f.removed.join() === "conv_a" && w.rows.get("conv_a")?.status === "deleted");
  const order = w.queries.map((q) => (/INSERT/.test(q) ? "queue" : /'deleting'/.test(q) ? "claim" : /co_memories/.test(q) ? "verify-stored" : /call_processing/.test(q) ? "verify-finished" : /'deleted'/.test(q) ? "mark-deleted" : "?"));
  check("1b order: queue, claim, verify stored, verify finished, then delete and mark", order.join(",") === "queue,claim,verify-stored,verify-finished,mark-deleted");
  check("1c the log names the conversation, never the transcript", f.logs.some((l) => /deleted conv_a/.test(l)) && noSecret(f.logs));
  const again = await forgetAfterCall(call(), f.deps);
  check("1d a redelivered webhook for a deleted conversation deletes nothing more", again === "not_due" && f.calls() === 1);
  check("1e the link we verify against is the one stored with the transcript", linkFor("conv_a") === conversationLink("conv_a"));
}

// 2. Never delete what we haven't stored.
{
  const w = fakeWorld({ processing: { "el:conv_a": "completed" } });
  const f = fakeDeps(w);
  const out = await forgetAfterCall(call(), f.deps);
  check("2a transcript never stored (store failed): nothing deleted, kept for the next pass", out === "not_stored" && f.calls() === 0 && w.rows.get("conv_a")?.status === "pending");
  check("2b its reason is logged without text", f.logs.some((l) => /kept conv_a \(attempt 1\/5\): no stored transcript/.test(l)) && noSecret(f.logs));
}
{
  const w = fakeWorld({ memories: [{ user_id: USER, memory_type: "call_transcript", content: "assistant: a different call", audio_url: conversationLink("conv_a") }], processing: { "el:conv_a": "completed" } });
  const f = fakeDeps(w);
  check("2c a stored row that isn't this transcript (hash differs): nothing deleted", (await forgetAfterCall(call(), f.deps)) === "not_stored" && f.calls() === 0);
}
{
  const w = fakeWorld({ memories: [{ user_id: USER, memory_type: "call_transcript", content: "   ", audio_url: conversationLink("conv_a") }], processing: { "el:conv_a": "completed" } });
  const f = fakeDeps(w);
  check("2d an empty stored row: nothing deleted", (await forgetAfterCall(call("conv_a", transcriptHash("   ")), f.deps)) === "not_stored" && f.calls() === 0);
}
{
  const w = fakeWorld({ memories: [{ user_id: "someone-else", memory_type: "call_transcript", content: TRANSCRIPT, audio_url: conversationLink("conv_a") }], processing: { "el:conv_a": "completed" } });
  const f = fakeDeps(w);
  check("2e the same transcript under another member's id doesn't count as stored", (await forgetAfterCall(call(), f.deps)) === "not_stored" && f.calls() === 0);
}
{
  const w = fakeWorld({ memories: [{ user_id: USER, memory_type: "text_exchange", content: TRANSCRIPT, audio_url: conversationLink("conv_a") }], processing: { "el:conv_a": "completed" } });
  const f = fakeDeps(w);
  check("2f only a call_transcript row counts as stored", (await forgetAfterCall(call(), f.deps)) === "not_stored" && f.calls() === 0);
}

// 3. Verify failures: processing not finished, or the check itself failed.
for (const status of ["processing", "failed", undefined]) {
  const w = storedWorld({ processing: status ? { "el:conv_a": status } : {} });
  const f = fakeDeps(w);
  const out = await forgetAfterCall(call(), f.deps);
  check(`3a processing ${status ?? "not on file"}: nothing deleted`, out === "not_finished" && f.calls() === 0 && w.rows.get("conv_a")?.status === "pending");
}
{
  const w = storedWorld({ throwOn: /SELECT content FROM co_memories/ });
  const f = fakeDeps(w);
  const out = await forgetAfterCall(call(), f.deps);
  check("3b the stored-check query fails: nothing deleted, kept pending, reason logged", out === "error" && f.calls() === 0 && w.rows.get("conv_a")?.status === "pending" && f.logs.some((l) => /verify failed \(connection refused\)/.test(l)));
}
{
  const w = storedWorld({ throwOn: /call_processing/ });
  const f = fakeDeps(w);
  check("3c the processing check fails: nothing deleted", (await forgetAfterCall(call(), f.deps)) === "error" && f.calls() === 0);
}
{
  const w = storedWorld({ throwOn: /INSERT INTO elevenlabs_deletions/ });
  const f = fakeDeps(w);
  const out = await forgetAfterCall(call(), f.deps);
  check("3d queueing fails: nothing deleted, never throws", out === "error" && f.calls() === 0);
}

// 4. Delete failures: kept, retried on the next pass, bounded.
{
  const w = storedWorld();
  const f = fakeDeps(w, { fail: "always" });
  const first = await forgetAfterCall(call(), f.deps);
  check("4a delete fails: kept pending with the attempt counted", first === "delete_failed" && w.rows.get("conv_a")?.status === "pending" && w.rows.get("conv_a")?.attempts === 1);
  const early = await retryPendingDeletes(f.deps);
  check("4b the next pass waits its interval before trying again", Object.keys(early).length === 0 && f.calls() === 1);
  for (let i = 0; i < 10; i++) {
    w.advance(FORGET.retryAfterMinutes + 1);
    await retryPendingDeletes(f.deps);
  }
  check(`4c bounded: exactly ${FORGET.maxAttempts} attempts, then gave_up`, f.calls() === FORGET.maxAttempts && w.rows.get("conv_a")?.status === "gave_up" && w.rows.get("conv_a")?.attempts === FORGET.maxAttempts);
  check("4d the last attempt says it gives up and the conversation stays", f.logs.some((l) => /attempt 5\/5\).*giving up, it stays at ElevenLabs/.test(l)));
  w.advance(1000);
  await retryPendingDeletes(f.deps);
  check("4e a gave_up row is never tried again", f.calls() === FORGET.maxAttempts);
  // The delete gets only the id, and the real client throws the status only (6b): no failure can carry their words.
  check("4f every failure logged with its reason and never the transcript", f.logs.length >= FORGET.maxAttempts && f.logs.every((l) => /answered 503/.test(l)) && noSecret(f.logs));
}
{
  const w = storedWorld();
  const f = fakeDeps(w, { fail: 2 });
  await forgetAfterCall(call(), f.deps);
  w.advance(FORGET.retryAfterMinutes + 1);
  await retryPendingDeletes(f.deps);
  w.advance(FORGET.retryAfterMinutes + 1);
  const third = await retryPendingDeletes(f.deps);
  check("4g a transient failure clears on a later pass", third.deleted === 1 && w.rows.get("conv_a")?.status === "deleted" && f.removed.length === 1 && noSecret(f.logs));
}
{
  const w = storedWorld();
  const f = fakeDeps(w, { gone: true });
  check("4h ElevenLabs already lost it (404): marked deleted, said so", (await forgetAfterCall(call(), f.deps)) === "gone" && w.rows.get("conv_a")?.last_error === "already gone at ElevenLabs");
}
{
  // A pass that crashed mid-delete leaves 'deleting': taken over only once stale.
  const w = storedWorld();
  const f = fakeDeps(w);
  await w.db.query(`INSERT INTO elevenlabs_deletions (conversation_id, user_id, transcript_sha256, status) VALUES ($1, $2, $3, 'pending')`, ["conv_a", USER, transcriptHash(TRANSCRIPT)]);
  const r = w.rows.get("conv_a")!;
  r.status = "deleting";
  r.attempts = 1;
  r.last_attempt_at = 1_800_000_000_000;
  check("4i a fresh 'deleting' claim is left alone", (await attemptDelete("conv_a", f.deps)) === "not_due" && f.calls() === 0);
  w.advance(FORGET.staleClaimMinutes + 1);
  await retryPendingDeletes(f.deps);
  check("4j a stale claim is taken over and verified again before deleting", f.removed.join() === "conv_a" && r.attempts === 2);
}

// 5. Switches and holds.
{
  const w = storedWorld();
  const f = fakeDeps(w, { env: { ELEVENLABS_API_KEY: "ci", ELEVENLABS_DELETE: "off" } as NodeJS.ProcessEnv });
  const out = await forgetAfterCall(call(), f.deps);
  const retried = await retryPendingDeletes(f.deps);
  check("5a kill switch ELEVENLABS_DELETE=off: queued, nothing deleted, no attempt used", out === "paused" && f.calls() === 0 && w.rows.get("conv_a")?.status === "pending" && w.rows.get("conv_a")?.attempts === 0 && Object.keys(retried).length === 0);
}
{
  const w = storedWorld();
  const f = fakeDeps(w, { env: {} as NodeJS.ProcessEnv });
  check("5b no ElevenLabs key: nothing deleted", (await forgetAfterCall(call(), f.deps)) === "no_key" && f.calls() === 0);
}
{
  const w = storedWorld();
  const env = { ELEVENLABS_API_KEY: "ci", VOICE_FLAGS: "test", CO_GEMINI_KEY: "g", NODE_ENV: "test" } as NodeJS.ProcessEnv;
  const f = fakeDeps(w, { env });
  const out = await forgetAfterCall(call("conv_a", transcriptHash(TRANSCRIPT), PHONE), f.deps);
  w.advance(1000);
  await retryPendingDeletes(f.deps);
  check("5c a call voice flags will listen to is held, never deleted, and the retry pass skips it", out === "held" && f.calls() === 0 && w.rows.get("conv_a")?.status === "held");
  const f2 = fakeDeps(storedWorld(), { env });
  check("5d voice flags on, but a real member's number: deleted as usual", (await forgetAfterCall(call(), f2.deps)) === "deleted");
}
{
  const f = fakeDeps(storedWorld());
  check("5e no conversation id: nothing", (await forgetAfterCall(call(""), f.deps)) === "no_id" && f.calls() === 0);
}

// 6. The real client: the DELETE it sends and what it throws (global fetch faked for this block; nothing leaves the machine).
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
    check("6a DELETE /v1/convai/conversations/{id}, id encoded, with the xi-api-key header", ok === "deleted" && seen[0].url === "https://api.elevenlabs.io/v1/convai/conversations/conv%2Fx" && seen[0].init.method === "DELETE" && seen[0].init.headers["xi-api-key"] === "k1");
    answer = 500;
    const err = await deleteAtElevenLabs("conv_x").then(() => null, (e) => e as Error);
    check("6b a failure throws the status only, never the body", !!err && err.message === "ElevenLabs answered 500");
    answer = 404;
    check("6c 404 is 'gone'", (await deleteAtElevenLabs("conv_x")) === "gone");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 7. The member-facing post-call flow never waits on, or fails from, the delete.
{
  const w = storedWorld({ throwOn: /./ });
  const f = fakeDeps(w, { fail: "always" });
  let threw = false;
  const t0 = Date.now();
  const out = await forgetAfterCall(call(), f.deps).catch(() => {
    threw = true;
  });
  check("7a every step failing: forgetAfterCall still resolves, never throws", !threw && out === "error" && Date.now() - t0 < 1000);
  const broken: ForgetDeps = { ...f.deps, db: null as any };
  check("7b even a missing database resolves", (await forgetAfterCall(call(), broken)) === "error");
  const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
  const route = co.slice(co.indexOf('router.post("/el/post-call"'), co.indexOf("// Root-cause guard"));
  const at = route.indexOf("forgetAfterCall(");
  check("7c the route calls it after processEndedCall and before answering the webhook", at > route.indexOf("await processEndedCall(") && at < route.indexOf("return res.status(ended.status)"));
  check("7d not awaited, and its promise is caught", /\n\s*if \(ended\.stored && u\[0\]\) forgetAfterCall\([^\n]*\)\.catch\(\(\) => \{\}\);/.test(route) && !/await forgetAfterCall/.test(co));
  check("7e only when the processing stored the transcript", /if \(ended\.stored && u\[0\]\) forgetAfterCall/.test(route));
  const pe = co.slice(co.indexOf("async function processEndedCall("), co.indexOf("async function scheduleFollowUpText("));
  const storedAt = pe.indexOf("stored: { transcriptSha256: transcriptHash(transcript) }");
  check("7f processEndedCall sets stored once, on the path that stored the transcript and marked the call completed", storedAt > 0 && pe.split("stored: {").length === 2 && storedAt > pe.indexOf("storeTranscriptMemory(") && storedAt > pe.indexOf(`finishCallProcessing(chat_id, "completed");\n\n      // Profile is fully extracted`));
  check("7g the frustration fallback (the one fetch of ElevenLabs' copy) is awaited inside processing, before completed", pe.indexOf("await emotionDone;") > 0 && pe.indexOf("await emotionDone;") < storedAt);
  check("7h voice flags start before the delete is considered", route.indexOf("flagVoiceMoments(") > 0 && route.indexOf("flagVoiceMoments(") < at);
}

// 8. Backfill: dry run counts and deletes nothing.
{
  const mems: Mem[] = [
    { user_id: USER, memory_type: "call_transcript", content: TRANSCRIPT, audio_url: conversationLink("conv_ready") },
    { user_id: USER, memory_type: "call_transcript", content: "assistant: hi\nuser: hello there friend", audio_url: conversationLink("conv_unfinished") },
    { user_id: "u-test", memory_type: "call_transcript", content: "assistant: hi\nuser: test call here", audio_url: conversationLink("conv_voiceflag") },
    { user_id: USER, memory_type: "call_transcript", content: "", audio_url: conversationLink("conv_empty") },
    { user_id: USER, memory_type: "call_transcript", content: "assistant: old\nuser: an old one", audio_url: conversationLink("conv_done") },
    { user_id: USER, memory_type: "call_transcript", content: "hume era", audio_url: "https://hume.example/audio/1" },
    { user_id: USER, memory_type: "call_transcript", content: "no link", audio_url: null },
  ];
  const processing = { "el:conv_ready": "completed", "el:conv_unfinished": "failed", "el:conv_voiceflag": "completed", "el:conv_empty": "completed", "el:conv_done": "completed" };
  const env = { ELEVENLABS_API_KEY: "ci", VOICE_FLAGS: "test", CO_GEMINI_KEY: "g", NODE_ENV: "test" } as NodeJS.ProcessEnv;
  const w = fakeWorld({ memories: mems, processing, users: { "u-test": PHONE } });
  await w.db.query(`INSERT INTO elevenlabs_deletions (conversation_id, user_id, transcript_sha256, status) VALUES ($1, $2, $3, 'pending')`, ["conv_done", USER, "x"]);
  w.rows.get("conv_done")!.status = "deleted";
  w.queries.length = 0;
  const f = fakeDeps(w, { env });
  const { plan, outcomes } = await runBackfill(f.deps, backfillMode([]));
  check("8a dry run is the default; --apply is the only way to delete", backfillMode([]) === "dry-run" && backfillMode(["--dry-run"]) === "dry-run" && backfillMode(["--apply"]) === "apply");
  check("8b dry run: nothing deleted", f.calls() === 0 && Object.keys(outcomes).length === 0);
  check("8c dry run: nothing written (one read, no INSERT/UPDATE/DELETE)", w.queries.length === 1 && w.queries.every((q) => !/\b(INSERT|UPDATE|DELETE)\b/.test(q)));
  check("8d it counts each kind", plan.storedConversations === 5 && plan.wouldDelete === 1 && plan.notFinished === 1 && plan.held === 1 && plan.notStored === 1 && plan.alreadyDeleted === 1);
  const report = f.logs.join("\n");
  check("8e the report is counts only: no conversation ids, no text", /would delete \(stored, processing completed\): 1/.test(report) && !/conv_/.test(report) && noSecret(f.logs));
  // Apply, on the fake only: just the ready one goes, through the same verify.
  const f2 = fakeDeps(w, { env });
  const applied = await runBackfill(f2.deps, "apply");
  check("8f apply deletes only stored, completed, unheld conversations, verified the same way", f2.removed.join() === "conv_ready" && applied.outcomes.deleted === 1 && w.rows.get("conv_ready")?.status === "deleted");
  check("8g backfillReport reads 'to delete' on apply", /to delete \(stored, processing completed\)/.test(backfillReport(plan, "apply")));
  const again = await planBackfill(f2.deps);
  check("8h a second run finds nothing more to delete", again.wouldDelete === 0 && again.alreadyDeleted === 2);
  const script = readFileSync(new URL("../../src/scripts/forgetElevenLabsBackfill.ts", import.meta.url), "utf8");
  check("8i the script takes its mode from the arguments only (dry run unless --apply)", /backfillMode\(process\.argv\.slice\(2\)\)/.test(script) && !/"apply"/.test(script));
}

// 9. Wiring.
{
  const mig = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
  check("9a the table exists, with a hash and no transcript column", /CREATE TABLE IF NOT EXISTS elevenlabs_deletions \(/.test(mig) && /transcript_sha256 TEXT NOT NULL/.test(mig) && !/elevenlabs_deletions \([^)]*\bcontent\b/.test(mig));
  const jobs = readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
  check("9b the retry pass is scheduled", /retryPendingDeletes\(\)/.test(jobs));
  const svc = readFileSync(new URL("../../src/services/elevenLabsForget.ts", import.meta.url), "utf8");
  check("9c no switch turns it on: the only env read besides the key is the off switch", [...svc.matchAll(/env\.([A-Z_]+)/g)].every((m) => ["ELEVENLABS_API_KEY", "ELEVENLABS_DELETE"].includes(m[1])) && /ELEVENLABS_DELETE === "off"/.test(svc));
  const l1 = JSON.parse(readFileSync(new URL("../layer1.json", import.meta.url), "utf8"));
  check("9d registered in layer 1", l1.files.includes("evals/calls/elevenLabsForget.ts"));
  // The fake database answers by shape, so the bound written in the SQL itself is checked here: both the claim and the retry
  // pass's pick stop at FORGET.maxAttempts.
  check("9e the claim's SQL caps attempts at FORGET.maxAttempts", /WHERE conversation_id = \$1 AND attempts < \$2\n[\s\S]{0,200}RETURNING user_id, transcript_sha256, attempts`,\n\s*\[conversationId, FORGET\.maxAttempts, FORGET\.staleClaimMinutes\]/.test(svc));
  check("9f the retry pass's SQL caps attempts too", /WHERE attempts < \$1\n[\s\S]{0,300}LIMIT \$4`,\n\s*\[FORGET\.maxAttempts, /.test(svc));
}

console.log(`elevenlabs forget rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
