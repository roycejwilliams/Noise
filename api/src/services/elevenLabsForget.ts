// Forget by default at ElevenLabs (Royce, 2026-10-18; the schedule approved 2026-10-23). After a call ElevenLabs keeps the whole
// conversation (audio and transcript) in its history. We already get the transcript in the post-call webhook and store it as the
// member's call_transcript memory, so once our copy is stored theirs is deleted on a schedule:
//   - a member's call: FORGET.memberDays (7) after our copy was stored
//   - a call with the team (users.mo_approver) or a test number (services/testNumbers.ts): FORGET.teamDays (30)
//   - a call the after-call health check flagged (services/callHealth.ts), or one the member reported: held, never deleted, until
//     it is marked reviewed (callHealth.ts markCallReviewed); then the window above applies
//   - a member removing something from what Cue knows (services/whatCoKnows.ts applyKnowledgeChanges) that one of their kept calls
//     says: that call is deleted at ElevenLabs at once, whatever its window or hold (forgetCallsNow)
//
// Order, every time (the scheduled pass and the backfill alike):
//   1. the transcript arrived (post-call webhook) and processEndedCall stored it (routes/co.ts); only then is the call queued
//      (forgetAfterCall), with its due time
//   2. the claim takes the row only when it is due and not held (the hold is in the claim's SQL, so no caller can skip it)
//   3. verify: a call_transcript row for this conversation exists, is not empty, and hashes to what we received; and the call's
//      processing (call_processing, el:<conversation id>) is 'completed', so nothing still reads ElevenLabs' copy
//   4. delete the conversation at ElevenLabs (DELETE /v1/convai/conversations/{id})
// A forget (step 2 bypasses window and hold) skips step 3: the member asked for it gone, and the row was only ever queued after our
// copy was stored.
// A call with nothing stored (voicemail, an empty transcript, no real conversation, a processing failure) is queued too, on the same
// window, with nothing to verify (verify = false). Deleting the account (routes/users.ts) forgets every one of the member's calls
// first; the rows have no foreign key on users, so a failed delete is still retried after the account is gone.
// Any step failing keeps the conversation, logs why (the conversation id and a reason, never transcript text) and leaves it for the
// next pass: FORGET.maxAttempts quick tries, then once a day, shown in the morning review as stuck (a forget restarts the quick tries).
// On production a flagged call's hold ends FORGET.prodHoldDays after the call (the morning review only runs on co-test).
//
// Kill switch: ELEVENLABS_DELETE=off stops every delete (rows wait as pending, no attempt is used up). Nothing else turns it on:
// it runs wherever ELEVENLABS_API_KEY is set.
import { createHash } from "crypto";
import pool from "../db/db.js";
import { isTestNumber, testNumbersEnabled } from "./testNumbers.js";

export const FORGET = {
  maxAttempts: 5,
  // The pass runs every 30 minutes (jobs/index.ts); a failed row is due again after this, so the next pass always retries it.
  retryAfterMinutes: 20,
  // A row left 'deleting' this long was cut off (a crash or redeploy): the next pass takes it over.
  staleClaimMinutes: 10,
  batch: 25,
  timeoutMs: 10_000,
  memberDays: 7,
  teamDays: 30,
  // Past maxAttempts quick tries: once a day, and shown in the morning review as stuck.
  backoffMinutes: 24 * 60,
  // Production only: a flagged, unreviewed call stops being held this long after it ended (the review runs on co-test only).
  prodHoldDays: 30,
  // A call with no health row (the check failed) is held as if its late signals were open, for this long after it was queued.
  noHealthHoldHours: 48,
} as const;

export type CallKind = "member" | "team" | "test";
// Pure: whose call it was. A test number first (it can only exist off production), then the team flag.
export function callKind(o: { phone: unknown; team: boolean }, env: NodeJS.ProcessEnv = process.env): CallKind {
  if (isTestNumber(o.phone, env)) return "test";
  return o.team ? "team" : "member";
}
export const keepDays = (kind: CallKind): number => (kind === "member" ? FORGET.memberDays : FORGET.teamDays);

// Where a stored call transcript points at its conversation (co_memories.audio_url, elevenLabsCalls.ts conversationLink).
export const CONVERSATION_LINK_PREFIX = "https://elevenlabs.io/app/agents/history/";
export const linkFor = (conversationId: string): string => `${CONVERSATION_LINK_PREFIX}${conversationId}`;
export const transcriptHash = (transcript: string): string => createHash("sha256").update(transcript, "utf8").digest("hex");

export type ForgetDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
export type ForgetDeps = {
  db: ForgetDb;
  // Deletes the conversation at ElevenLabs: "deleted", or "gone" when ElevenLabs no longer has it. Throws on any other answer.
  remove: (conversationId: string) => Promise<"deleted" | "gone">;
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
  // When our copy was stored (the window counts from it). Tests pass their own clock.
  now?: () => Date;
};

export type ForgetOutcome = "queued" | "deleted" | "gone" | "paused" | "no_key" | "no_id" | "not_due" | "not_stored" | "not_finished" | "delete_failed" | "error";

// The real call: the endpoint and key the rest of the code uses for conversations (fetchConversationTurns).
export async function deleteAtElevenLabs(conversationId: string, env: NodeJS.ProcessEnv = process.env): Promise<"deleted" | "gone"> {
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY ?? "" },
    signal: AbortSignal.timeout(FORGET.timeoutMs),
  });
  if (r.ok) return "deleted";
  if (r.status === 404) return "gone";
  // The status only: what an error body says is not ours to log.
  throw new Error(`ElevenLabs answered ${r.status}`);
}

export const realForgetDeps = (): ForgetDeps => ({ db: pool, remove: (id) => deleteAtElevenLabs(id), log: (l) => console.log(l), env: process.env });

// A failure as a short reason: its name and status, cut short. Nothing here ever holds transcript text (remove only gets the id).
const why = (err: any): string => String(err?.name && err.name !== "Error" ? `${err.name}: ${err?.message ?? ""}` : (err?.message ?? err)).slice(0, 120);

const paused = (env: NodeJS.ProcessEnv) => env.ELEVENLABS_DELETE === "off";

// Queued after the call. A stored call (our transcript's hash) is verified before its delete; a call with nothing stored (voicemail,
// an empty transcript, no real conversation, a processing failure) has nothing to verify and goes on the same window. A later
// delivery that does store the transcript turns an unverified row into a verified one.
const QUEUE_SQL = `INSERT INTO elevenlabs_deletions (conversation_id, user_id, transcript_sha256, status, window_kind, due_at, verify)
  VALUES ($1, $2, $3, 'pending', $4, $5::timestamptz + make_interval(days => $6), $3::text IS NOT NULL)
  ON CONFLICT (conversation_id) DO UPDATE SET verify = true, transcript_sha256 = EXCLUDED.transcript_sha256, updated_at = NOW()
    WHERE EXCLUDED.verify AND NOT elevenlabs_deletions.verify AND elevenlabs_deletions.status <> 'deleted'`;

// After a call (routes/co.ts, not awaited): queued with its due time. transcriptSha256 null: nothing was stored, nothing to verify.
// Nothing is deleted here; the scheduled pass deletes it once due. Never throws: the member-facing post-call flow has already run.
export async function forgetAfterCall(o: { userId: string; conversationId: string; transcriptSha256: string | null; phone: unknown; team: boolean }, deps: ForgetDeps = realForgetDeps()): Promise<ForgetOutcome> {
  try {
    if (!o.conversationId) return "no_id";
    const kind = callKind({ phone: o.phone, team: o.team }, deps.env);
    await deps.db.query(QUEUE_SQL, [o.conversationId, o.userId, o.transcriptSha256 ?? null, kind, deps.now?.() ?? new Date(), keepDays(kind)]);
    deps.log(`elevenlabs-delete: queued ${o.conversationId} (${kind}, due in ${keepDays(kind)} days${o.transcriptSha256 ? "" : ", nothing stored to verify"})`);
    return "queued";
  } catch (err) {
    deps.log(`elevenlabs-delete: not queued ${o.conversationId}: ${why(err)}`);
    return "error";
  }
}

// Due and not held, or asked to be forgotten. Held: the after-call health check flagged it (or the member reported it) and nobody
// has marked it reviewed (on production that hold ends FORGET.prodHoldDays after the call), or its late signals are still being
// looked for, or there is no health row at all and the late window hasn't passed (the check failed: treated as still open).
// prod: the parameter saying this is production.
export const holdSql = (prod: string): string => `(d.forget_requested_at IS NOT NULL OR (d.due_at <= NOW()
      AND NOT EXISTS (SELECT 1 FROM call_health h WHERE h.conversation_id = d.conversation_id
        AND ((h.flagged AND h.reviewed_at IS NULL AND NOT (${prod}::boolean AND h.ended_at <= NOW() - make_interval(days => ${FORGET.prodHoldDays}))) OR h.late_done_at IS NULL))
      AND (EXISTS (SELECT 1 FROM call_health h2 WHERE h2.conversation_id = d.conversation_id) OR d.created_at <= NOW() - make_interval(hours => ${FORGET.noHealthHoldHours}))))`;
// After FORGET.maxAttempts quick tries, a row is tried once a day (FORGET.backoffMinutes) and shows in the morning review as stuck.
const retryDue = (max: string, quick: string) => `d.last_attempt_at < NOW() - make_interval(mins => CASE WHEN d.attempts >= ${max} THEN ${FORGET.backoffMinutes} ELSE ${quick} END)`;
const isProduction = (env: NodeJS.ProcessEnv): boolean => !testNumbersEnabled(env);

// The claim: the hold is in its SQL, so no caller can skip it.
const CLAIM_SQL = `UPDATE elevenlabs_deletions d SET status = 'deleting', attempts = attempts + 1, last_attempt_at = NOW(), updated_at = NOW()
  WHERE d.conversation_id = $1
    AND (d.status = 'pending' OR (d.status = 'deleting' AND d.last_attempt_at < NOW() - make_interval(mins => $2)))
    AND ${holdSql("$3")}
  RETURNING d.user_id, d.transcript_sha256, d.attempts, d.forget_requested_at, d.verify`;

// One attempt for one queued conversation: claim, verify, delete. Never throws.
export async function attemptDelete(conversationId: string, deps: ForgetDeps): Promise<ForgetOutcome> {
  if (paused(deps.env)) {
    deps.log(`elevenlabs-delete: paused (ELEVENLABS_DELETE=off), ${conversationId} waits`);
    return "paused";
  }
  if (!deps.env.ELEVENLABS_API_KEY) return "no_key";
  let claim: { user_id: string; transcript_sha256: string | null; attempts: number; forget_requested_at: unknown; verify: boolean } | undefined;
  try {
    claim = (await deps.db.query(CLAIM_SQL, [conversationId, FORGET.staleClaimMinutes, isProduction(deps.env)])).rows[0];
  } catch (err) {
    deps.log(`elevenlabs-delete: kept ${conversationId}: claim failed (${why(err)})`);
    return "error";
  }
  // Not due yet, held, already deleted, or another pass has it.
  if (!claim) return "not_due";
  const forget = claim.forget_requested_at != null;
  const attempt = Number(claim.attempts) || 1;
  // outcome is the code the morning review shows for a stuck row (last_outcome); reason is for the log only.
  const keep = async (outcome: ForgetOutcome, reason: string): Promise<ForgetOutcome> => {
    const stuck = attempt >= FORGET.maxAttempts;
    await deps.db
      .query(`UPDATE elevenlabs_deletions SET status = 'pending', last_error = $2, last_outcome = $3, updated_at = NOW() WHERE conversation_id = $1`, [conversationId, reason, outcome])
      .catch(() => {});
    deps.log(`elevenlabs-delete: kept ${conversationId} (attempt ${attempt}): ${reason}${stuck ? "; retried once a day from now, and shown in the morning review" : ""}`);
    return outcome;
  };
  if (!forget && claim.verify !== false) {
    try {
      // Stored: our copy is there, not empty, and is the transcript we received. Its link first; else the same transcript stored
      // under another link (processEndedCall keeps one row for identical content).
      const linked = await deps.db.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_transcript' AND audio_url = $2`, [claim.user_id, linkFor(conversationId)]);
      const match = (rows: any[]) => rows.some((r) => typeof r.content === "string" && r.content.trim() !== "" && transcriptHash(r.content) === claim!.transcript_sha256);
      const ours =
        match(linked.rows) ||
        match((await deps.db.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_transcript' AND encode(sha256(convert_to(content, 'UTF8')), 'hex') = $2`, [claim.user_id, claim.transcript_sha256])).rows);
      if (!ours) return await keep("not_stored", "no stored transcript matches this conversation");
      // Finished: the call's processing completed, so nothing in it still reads ElevenLabs' copy and no retry will.
      const proc = await deps.db.query(`SELECT status FROM call_processing WHERE chat_id = $1`, [`el:${conversationId}`]);
      if (proc.rows[0]?.status !== "completed") return await keep("not_finished", `the call's processing is ${proc.rows[0]?.status ?? "not on file"}`);
    } catch (err) {
      return await keep("error", `verify failed (${why(err)})`);
    }
  }
  let result: "deleted" | "gone";
  try {
    result = await deps.remove(conversationId);
  } catch (err) {
    return await keep("delete_failed", `delete failed (${why(err)})`);
  }
  await deps.db
    .query(`UPDATE elevenlabs_deletions SET status = 'deleted', deleted_at = NOW(), updated_at = NOW(), last_error = $2, last_outcome = $3 WHERE conversation_id = $1`, [conversationId, result === "gone" ? "already gone at ElevenLabs" : null, result])
    .catch((err) => deps.log(`elevenlabs-delete: deleted ${conversationId} but could not mark it (${why(err)})`));
  deps.log(`elevenlabs-delete: ${result === "gone" ? "already gone" : "deleted"} ${conversationId} at ElevenLabs (attempt ${attempt}${forget ? ", forgotten at their request" : ""}${claim.verify === false ? ", nothing stored to verify" : ""})`);
  return result;
}

// The scheduled pass (jobs/index.ts, every 30 minutes): rows that are due and not held (or asked to be forgotten), first-time and
// failed alike (quick retries, then daily), and claims a crash left behind. Held rows are left out here too, so they never fill the
// batch. Each goes through attemptDelete, whose claim checks due and hold again. Never throws.
export async function runDeletionPass(deps: ForgetDeps = realForgetDeps()): Promise<Partial<Record<ForgetOutcome, number>>> {
  const counts: Partial<Record<ForgetOutcome, number>> = {};
  if (paused(deps.env) || !deps.env.ELEVENLABS_API_KEY) return counts;
  try {
    const { rows } = await deps.db.query(
      `SELECT d.conversation_id FROM elevenlabs_deletions d
       WHERE ${holdSql("$4")}
         AND ((d.status = 'pending' AND (d.last_attempt_at IS NULL OR ${retryDue("$1", "$2")}))
           OR (d.status = 'deleting' AND d.last_attempt_at < NOW() - make_interval(mins => $3)))
       ORDER BY d.forget_requested_at NULLS LAST, d.due_at LIMIT $5`,
      [FORGET.maxAttempts, FORGET.retryAfterMinutes, FORGET.staleClaimMinutes, isProduction(deps.env), FORGET.batch],
    );
    for (const r of rows) {
      const out = await attemptDelete(String(r.conversation_id), deps);
      counts[out] = (counts[out] ?? 0) + 1;
    }
  } catch (err) {
    deps.log(`elevenlabs-delete: pass failed (${why(err)})`);
  }
  return counts;
}

export type StuckDelete = { conversationId: string; userId: string; attempts: number; lastOutcome: string | null; since: string };
// Rows past their quick retries and still not deleted: for the morning review (codes only: the id, the count, the last outcome).
export async function stuckDeletes(o: { userId?: string } = {}, deps: Pick<ForgetDeps, "db"> = realForgetDeps()): Promise<StuckDelete[]> {
  const { rows } = await deps.db.query(
    `SELECT conversation_id, user_id, attempts, last_outcome, created_at FROM elevenlabs_deletions
     WHERE status <> 'deleted' AND attempts >= $1 AND ($2::uuid IS NULL OR user_id = $2) ORDER BY created_at LIMIT 100`,
    [FORGET.maxAttempts, o.userId ?? null],
  );
  return rows.map((r: any) => ({ conversationId: String(r.conversation_id), userId: String(r.user_id), attempts: Number(r.attempts), lastOutcome: r.last_outcome == null ? null : String(r.last_outcome), since: new Date(r.created_at).toISOString() }));
}

// The member asked for something gone: their kept calls that saysIt picks are deleted at ElevenLabs at once, whatever the window or
// hold. A removal from what Cue knows (services/whatCoKnows.ts) passes the raw-words guard on our stored transcript; deleting the
// account (routes/users.ts) passes () => true. A call with nothing stored is offered "". The transcript is read here and never
// logged. A failed delete is retried by the pass (forget_requested_at stays set, and the row outlives the account). Never throws.
export async function forgetCallsNow(userId: string, saysIt: (transcript: string) => boolean, deps: ForgetDeps = realForgetDeps()): Promise<Partial<Record<ForgetOutcome, number>>> {
  const counts: Partial<Record<ForgetOutcome, number>> = {};
  try {
    const { rows } = await deps.db.query(
      `SELECT d.conversation_id, m.content FROM elevenlabs_deletions d
       LEFT JOIN co_memories m ON m.user_id = d.user_id AND m.memory_type = 'call_transcript' AND m.audio_url = $2 || d.conversation_id
       WHERE d.user_id = $1 AND d.status <> 'deleted'`,
      [userId, CONVERSATION_LINK_PREFIX],
    );
    const ids = [...new Set(rows.filter((r) => saysIt(typeof r.content === "string" ? r.content : "")).map((r) => String(r.conversation_id)))];
    for (const id of ids) {
      // A fresh set of quick attempts for a stuck one; a row mid-claim keeps its claim (the stale-claim rule takes it over).
      await deps.db.query(
        `UPDATE elevenlabs_deletions SET forget_requested_at = COALESCE(forget_requested_at, NOW()),
           attempts = CASE WHEN attempts >= $3 THEN 0 ELSE attempts END, updated_at = NOW()
         WHERE conversation_id = $1 AND user_id = $2 AND status <> 'deleted'`,
        [id, userId, FORGET.maxAttempts],
      );
      deps.log(`elevenlabs-delete: forget asked for ${id}`);
      const out = await attemptDelete(id, deps);
      counts[out] = (counts[out] ?? 0) + 1;
    }
  } catch (err) {
    deps.log(`elevenlabs-delete: forget failed (${why(err)})`);
  }
  return counts;
}

// ---- backfill (src/scripts/forgetElevenLabsBackfill.ts): calls stored before this shipped. Dry run by default, counts only.
export type BackfillPlan = {
  storedConversations: number;
  wouldQueue: number;
  // Of those, how many are already past their window (counted from when our copy was stored): the next pass deletes them.
  dueNow: number;
  alreadyDeleted: number;
  alreadyQueued: number;
  notStored: number;
  notFinished: number;
  candidates: { conversationId: string; userId: string; transcriptSha256: string; kind: CallKind; storedAt: Date }[];
};

export function backfillMode(argv: string[]): "dry-run" | "apply" {
  return argv.includes("--apply") ? "apply" : "dry-run";
}

// Read-only: every stored call transcript that points at an ElevenLabs conversation, sorted into what a run would do.
export async function planBackfill(deps: Pick<ForgetDeps, "db" | "env">, now: Date = new Date()): Promise<BackfillPlan> {
  const { rows } = await deps.db.query(
    `SELECT m.user_id, m.content, m.created_at, substring(m.audio_url from $2::int) AS conversation_id, u.phone_number, u.mo_approver,
            d.status AS deletion_status, cp.status AS processing_status
     FROM co_memories m
     LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN elevenlabs_deletions d ON d.conversation_id = substring(m.audio_url from $2::int)
     LEFT JOIN call_processing cp ON cp.chat_id = 'el:' || substring(m.audio_url from $2::int)
     WHERE m.memory_type = 'call_transcript' AND m.audio_url LIKE $1 || '%'`,
    [CONVERSATION_LINK_PREFIX, CONVERSATION_LINK_PREFIX.length + 1],
  );
  const plan: BackfillPlan = { storedConversations: 0, wouldQueue: 0, dueNow: 0, alreadyDeleted: 0, alreadyQueued: 0, notStored: 0, notFinished: 0, candidates: [] };
  const seen = new Set<string>();
  for (const r of rows) {
    const id = String(r.conversation_id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    plan.storedConversations++;
    const status = r.deletion_status as string | null;
    if (status === "deleted") plan.alreadyDeleted++;
    else if (status) plan.alreadyQueued++;
    else if (typeof r.content !== "string" || !r.content.trim()) plan.notStored++;
    else if (r.processing_status !== "completed") plan.notFinished++;
    else {
      const kind = callKind({ phone: r.phone_number, team: r.mo_approver === true }, deps.env);
      const storedAt = r.created_at ? new Date(r.created_at) : now;
      plan.wouldQueue++;
      if (storedAt.getTime() + keepDays(kind) * 86_400_000 <= now.getTime()) plan.dueNow++;
      plan.candidates.push({ conversationId: id, userId: String(r.user_id), transcriptSha256: transcriptHash(r.content), kind, storedAt });
    }
  }
  return plan;
}

// Counts only: no ids, no names, no text.
export function backfillReport(plan: BackfillPlan, mode: "dry-run" | "apply"): string {
  return [
    `ElevenLabs backfill (${mode})`,
    `  stored call transcripts pointing at an ElevenLabs conversation: ${plan.storedConversations}`,
    `  ${mode === "apply" ? "to queue" : "would queue"} (stored, processing completed): ${plan.wouldQueue}`,
    `    of those already past their window (deleted by the next pass): ${plan.dueNow}`,
    `  already deleted: ${plan.alreadyDeleted}`,
    `  already queued: ${plan.alreadyQueued}`,
    `  kept: stored transcript empty: ${plan.notStored}`,
    `  kept: processing not completed: ${plan.notFinished}`,
  ].join("\n");
}

// Dry run (the default) reads and counts; it writes nothing and deletes nothing. Apply (needs Royce's yes) queues each candidate
// with its window counted from when our copy was stored; the scheduled pass deletes each once due (verify included). Old calls
// have no health check on file, so they are never held.
export async function runBackfill(deps: ForgetDeps, mode: "dry-run" | "apply"): Promise<{ plan: BackfillPlan; queued: number }> {
  const plan = await planBackfill(deps, deps.now?.() ?? new Date());
  deps.log(backfillReport(plan, mode));
  if (mode !== "apply") return { plan, queued: 0 };
  let queued = 0;
  for (const c of plan.candidates) {
    await deps.db.query(QUEUE_SQL, [c.conversationId, c.userId, c.transcriptSha256, c.kind, c.storedAt, keepDays(c.kind)]);
    queued++;
  }
  deps.log(`ElevenLabs backfill: queued ${queued}; the scheduled pass deletes each once due`);
  return { plan, queued };
}
