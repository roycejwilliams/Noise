// Forget by default at ElevenLabs (Royce, 2026-10-18). After a call ElevenLabs keeps the whole conversation (audio and
// transcript) in its history. We already get the transcript in the post-call webhook and store it as the member's
// call_transcript memory, so once that copy is on our side and the call's processing has finished, theirs is deleted.
//
// Order, every time (the post-call attempt, the retry pass and the backfill alike):
//   1. the transcript arrived (post-call webhook) and processEndedCall stored it (routes/co.ts)
//   2. verify: a call_transcript row for this conversation exists, is not empty, and hashes to what we received;
//      and the call's processing (call_processing, el:<conversation id>) is 'completed', so nothing still reads ElevenLabs' copy
//      (the frustration-score fallback, fetchConversationTurns, runs inside that processing)
//   3. delete the conversation at ElevenLabs (DELETE /v1/convai/conversations/{id})
// Any step failing keeps the conversation, logs why (the conversation id and the reason, never transcript text) and leaves it
// for the next pass, up to FORGET.maxAttempts; then it is marked gave_up and stays at ElevenLabs.
//
// Held, never deleted here: a call whose audio voice flags would read (services/voiceFlags.ts, VOICE_FLAGS=test on test numbers
// only, dormant since 2026-10-04): that pass downloads the recording after the webhook.
//
// Kill switch: ELEVENLABS_DELETE=off stops every delete (rows wait as pending, no attempt is used up). Nothing else turns it on:
// it runs wherever ELEVENLABS_API_KEY is set.
import { createHash } from "crypto";
import pool from "../db/db.js";
import { voiceFlagsAllowed } from "./voiceFlags.js";

export const FORGET = {
  maxAttempts: 5,
  // The retry pass picks a pending row up again after this.
  retryAfterMinutes: 30,
  // A row left 'deleting' this long was cut off (a crash or redeploy): the next pass takes it over.
  staleClaimMinutes: 10,
  batch: 25,
  timeoutMs: 10_000,
} as const;

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
};

export type ForgetOutcome = "deleted" | "gone" | "held" | "paused" | "no_key" | "no_id" | "not_due" | "not_stored" | "not_finished" | "delete_failed" | "error";

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

// After a call's processing finished with its transcript stored (routes/co.ts, not awaited). Never throws: the member-facing
// post-call flow has already run and nothing here can change it.
export async function forgetAfterCall(o: { userId: string; conversationId: string; transcriptSha256: string; phone: unknown }, deps: ForgetDeps = realForgetDeps()): Promise<ForgetOutcome> {
  try {
    if (!o.conversationId) return "no_id";
    if (voiceFlagsAllowed(o.phone, deps.env)) {
      await deps.db.query(
        `INSERT INTO elevenlabs_deletions (conversation_id, user_id, transcript_sha256, status, last_error) VALUES ($1, $2, $3, 'held', $4) ON CONFLICT (conversation_id) DO NOTHING`,
        [o.conversationId, o.userId, o.transcriptSha256, "voice flags read this call's audio"],
      );
      deps.log(`elevenlabs-delete: held ${o.conversationId}: voice flags read this call's audio`);
      return "held";
    }
    await deps.db.query(
      `INSERT INTO elevenlabs_deletions (conversation_id, user_id, transcript_sha256, status) VALUES ($1, $2, $3, 'pending') ON CONFLICT (conversation_id) DO NOTHING`,
      [o.conversationId, o.userId, o.transcriptSha256],
    );
    return await attemptDelete(o.conversationId, deps);
  } catch (err) {
    deps.log(`elevenlabs-delete: kept ${o.conversationId}: ${why(err)}`);
    return "error";
  }
}

// One attempt for one queued conversation: claim, verify, delete. Never throws.
export async function attemptDelete(conversationId: string, deps: ForgetDeps): Promise<ForgetOutcome> {
  if (paused(deps.env)) {
    deps.log(`elevenlabs-delete: paused (ELEVENLABS_DELETE=off), ${conversationId} waits`);
    return "paused";
  }
  if (!deps.env.ELEVENLABS_API_KEY) return "no_key";
  let claim: { user_id: string; transcript_sha256: string; attempts: number } | undefined;
  try {
    claim = (
      await deps.db.query(
        `UPDATE elevenlabs_deletions SET status = 'deleting', attempts = attempts + 1, last_attempt_at = NOW(), updated_at = NOW()
         WHERE conversation_id = $1 AND attempts < $2
           AND (status = 'pending' OR (status = 'deleting' AND last_attempt_at < NOW() - make_interval(mins => $3)))
         RETURNING user_id, transcript_sha256, attempts`,
        [conversationId, FORGET.maxAttempts, FORGET.staleClaimMinutes],
      )
    ).rows[0];
  } catch (err) {
    deps.log(`elevenlabs-delete: kept ${conversationId}: claim failed (${why(err)})`);
    return "error";
  }
  // Already deleted, given up, held, or another pass has it.
  if (!claim) return "not_due";
  const attempt = Number(claim.attempts) || FORGET.maxAttempts;
  const keep = async (outcome: ForgetOutcome, reason: string): Promise<ForgetOutcome> => {
    const last = attempt >= FORGET.maxAttempts;
    await deps.db
      .query(`UPDATE elevenlabs_deletions SET status = $2, last_error = $3, updated_at = NOW() WHERE conversation_id = $1`, [conversationId, last ? "gave_up" : "pending", reason])
      .catch(() => {});
    deps.log(`elevenlabs-delete: kept ${conversationId} (attempt ${attempt}/${FORGET.maxAttempts}): ${reason}${last ? "; giving up, it stays at ElevenLabs" : ""}`);
    return outcome;
  };
  try {
    // Stored: our copy is there, not empty, and is the transcript we received.
    const stored = await deps.db.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_transcript' AND audio_url = $2`, [claim.user_id, linkFor(conversationId)]);
    const ours = stored.rows.some((r) => typeof r.content === "string" && r.content.trim() !== "" && transcriptHash(r.content) === claim!.transcript_sha256);
    if (!ours) return await keep("not_stored", "no stored transcript matches this conversation");
    // Finished: the call's processing completed, so nothing in it still reads ElevenLabs' copy and no retry will.
    const proc = await deps.db.query(`SELECT status FROM call_processing WHERE chat_id = $1`, [`el:${conversationId}`]);
    if (proc.rows[0]?.status !== "completed") return await keep("not_finished", `the call's processing is ${proc.rows[0]?.status ?? "not on file"}`);
  } catch (err) {
    return await keep("error", `verify failed (${why(err)})`);
  }
  let result: "deleted" | "gone";
  try {
    result = await deps.remove(conversationId);
  } catch (err) {
    return await keep("delete_failed", `delete failed (${why(err)})`);
  }
  await deps.db
    .query(`UPDATE elevenlabs_deletions SET status = 'deleted', deleted_at = NOW(), updated_at = NOW(), last_error = $2 WHERE conversation_id = $1`, [conversationId, result === "gone" ? "already gone at ElevenLabs" : null])
    .catch((err) => deps.log(`elevenlabs-delete: deleted ${conversationId} but could not mark it (${why(err)})`));
  deps.log(`elevenlabs-delete: ${result === "gone" ? "already gone" : "deleted"} ${conversationId} at ElevenLabs (attempt ${attempt})`);
  return result;
}

// The next pass (jobs/index.ts): pending rows due again, and claims a crash left behind. Never throws.
export async function retryPendingDeletes(deps: ForgetDeps = realForgetDeps()): Promise<Partial<Record<ForgetOutcome, number>>> {
  const counts: Partial<Record<ForgetOutcome, number>> = {};
  if (paused(deps.env) || !deps.env.ELEVENLABS_API_KEY) return counts;
  try {
    const { rows } = await deps.db.query(
      `SELECT conversation_id FROM elevenlabs_deletions
       WHERE attempts < $1
         AND ((status = 'pending' AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(mins => $2)))
           OR (status = 'deleting' AND last_attempt_at < NOW() - make_interval(mins => $3)))
       ORDER BY created_at LIMIT $4`,
      [FORGET.maxAttempts, FORGET.retryAfterMinutes, FORGET.staleClaimMinutes, FORGET.batch],
    );
    for (const r of rows) {
      const out = await attemptDelete(String(r.conversation_id), deps);
      counts[out] = (counts[out] ?? 0) + 1;
    }
  } catch (err) {
    deps.log(`elevenlabs-delete: retry pass failed (${why(err)})`);
  }
  return counts;
}

// ---- backfill (src/scripts/forgetElevenLabsBackfill.ts): calls stored before this shipped. Dry run by default, counts only.
export type BackfillPlan = {
  storedConversations: number;
  wouldDelete: number;
  alreadyDeleted: number;
  alreadyQueued: number;
  gaveUp: number;
  held: number;
  notStored: number;
  notFinished: number;
  candidates: { conversationId: string; userId: string; transcriptSha256: string }[];
};

export function backfillMode(argv: string[]): "dry-run" | "apply" {
  return argv.includes("--apply") ? "apply" : "dry-run";
}

// Read-only: every stored call transcript that points at an ElevenLabs conversation, sorted into what a run would do.
export async function planBackfill(deps: Pick<ForgetDeps, "db" | "env">): Promise<BackfillPlan> {
  const { rows } = await deps.db.query(
    `SELECT m.user_id, m.content, substring(m.audio_url from $2) AS conversation_id, u.phone_number,
            d.status AS deletion_status, cp.status AS processing_status
     FROM co_memories m
     LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN elevenlabs_deletions d ON d.conversation_id = substring(m.audio_url from $2)
     LEFT JOIN call_processing cp ON cp.chat_id = 'el:' || substring(m.audio_url from $2)
     WHERE m.memory_type = 'call_transcript' AND m.audio_url LIKE $1 || '%'`,
    [CONVERSATION_LINK_PREFIX, CONVERSATION_LINK_PREFIX.length + 1],
  );
  const plan: BackfillPlan = { storedConversations: 0, wouldDelete: 0, alreadyDeleted: 0, alreadyQueued: 0, gaveUp: 0, held: 0, notStored: 0, notFinished: 0, candidates: [] };
  const seen = new Set<string>();
  for (const r of rows) {
    const id = String(r.conversation_id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    plan.storedConversations++;
    const status = r.deletion_status as string | null;
    if (status === "deleted") plan.alreadyDeleted++;
    else if (status === "gave_up") plan.gaveUp++;
    else if (status === "pending" || status === "deleting") plan.alreadyQueued++;
    else if (status === "held" || voiceFlagsAllowed(r.phone_number, deps.env)) plan.held++;
    else if (typeof r.content !== "string" || !r.content.trim()) plan.notStored++;
    else if (r.processing_status !== "completed") plan.notFinished++;
    else {
      plan.wouldDelete++;
      plan.candidates.push({ conversationId: id, userId: String(r.user_id), transcriptSha256: transcriptHash(r.content) });
    }
  }
  return plan;
}

// Counts only: no ids, no names, no text.
export function backfillReport(plan: BackfillPlan, mode: "dry-run" | "apply"): string {
  return [
    `ElevenLabs backfill (${mode})`,
    `  stored call transcripts pointing at an ElevenLabs conversation: ${plan.storedConversations}`,
    `  ${mode === "apply" ? "to delete" : "would delete"} (stored, processing completed): ${plan.wouldDelete}`,
    `  already deleted: ${plan.alreadyDeleted}`,
    `  already queued for the retry pass: ${plan.alreadyQueued}`,
    `  gave up earlier (left at ElevenLabs): ${plan.gaveUp}`,
    `  held (voice flags read the audio): ${plan.held}`,
    `  kept: stored transcript empty: ${plan.notStored}`,
    `  kept: processing not completed: ${plan.notFinished}`,
  ].join("\n");
}

// Dry run (the default) reads and counts; it writes nothing and deletes nothing. Apply (needs Royce's yes) queues each candidate
// and runs the same attempt as the post-call path, verify included.
export async function runBackfill(deps: ForgetDeps, mode: "dry-run" | "apply"): Promise<{ plan: BackfillPlan; outcomes: Partial<Record<ForgetOutcome, number>> }> {
  const plan = await planBackfill(deps);
  deps.log(backfillReport(plan, mode));
  const outcomes: Partial<Record<ForgetOutcome, number>> = {};
  if (mode !== "apply") return { plan, outcomes };
  for (const c of plan.candidates) {
    await deps.db.query(
      `INSERT INTO elevenlabs_deletions (conversation_id, user_id, transcript_sha256, status) VALUES ($1, $2, $3, 'pending') ON CONFLICT (conversation_id) DO NOTHING`,
      [c.conversationId, c.userId, c.transcriptSha256],
    );
    const out = await attemptDelete(c.conversationId, deps);
    outcomes[out] = (outcomes[out] ?? 0) + 1;
  }
  deps.log(`ElevenLabs backfill outcomes: ${Object.entries(outcomes).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  return { plan, outcomes };
}
