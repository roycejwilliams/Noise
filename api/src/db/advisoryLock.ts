import crypto from "crypto";
import { Pool, type PoolClient } from "pg";

// Postgres advisory locks take a bigint key — hash the string key down to a
// 32-bit int so this works for any string identifier (a phone number, a
// circle id), not just literal integers. Collisions are possible but
// vanishingly unlikely at this app's scale, and a false-positive serializes
// two unrelated things rather than corrupting anything.
function lockKeyToInt(key: string): number {
  const hash = crypto.createHash("md5").update(key).digest();
  return hash.readInt32BE(0);
}

// Lock sessions use their own small pool, so people waiting in line never
// take the connections the work itself needs (2026-09-15: nine webhook
// retries waiting on one phone's lock held every connection in the shared
// pool, the lock holder couldn't run a query, and the phone was stuck for
// 40 minutes). Raised from 10 to 30 (2026-09-17 code review): with 10+
// phones mid-turn at once, 10 connections was itself the bottleneck —
// connect() had nothing to wait ON but more of the same pool, so the
// waitMs loop's 90s bound didn't actually hold in practice. connectionTimeoutMillis
// bounds each individual connect() attempt, rather than letting it hang
// indefinitely past that same waitMs budget.
const lockPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 30, connectionTimeoutMillis: 5_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs fn while holding a session-level Postgres advisory lock on `key`.
// Unlike an in-memory Map keyed lock, this is correct across every app
// replica and every request-handling process, since the lock lives in
// Postgres rather than one process's memory.
//
// Waiting polls pg_try_advisory_lock without holding a connection. After
// waitMs it runs fn without the lock rather than dropping the work — same
// fallback on a connect() failure (2026-09-17 code review: an uncaught
// rejection there used to throw out of this function entirely, dropping the
// inbound message instead of just running it unserialized).
//
// A holder's lock is extended in holdMs steps for as long as fn is still
// running (2026-09-17 code review), not force-released at a single fixed
// holdMs mark — a real turn that legitimately runs past 120s (a slow
// search) used to have its lock pulled out from under it mid-run, letting a
// waiter start concurrently with it, which is exactly what this lock exists
// to prevent. maxHoldMs is the actual safety net: a genuinely hung turn
// (e.g. a fetch with no timeout of its own) still can't block one phone's
// messages forever.
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; holdMs?: number; maxHoldMs?: number } = {},
): Promise<T> {
  const lockId = lockKeyToInt(key);
  const waitMs = opts.waitMs ?? 90_000;
  const holdMs = opts.holdMs ?? 120_000;
  const maxHoldMs = opts.maxHoldMs ?? 10 * 60_000;
  const started = Date.now();
  let client: PoolClient | null = null;
  while (!client && Date.now() - started < waitMs) {
    let c: PoolClient;
    try {
      // Bounded by connectionTimeoutMillis above, so a pool that's out of
      // connections (10+ phones mid-turn) fails this attempt fast instead of
      // hanging past waitMs.
      c = await lockPool.connect();
    } catch (err: any) {
      console.error(`advisoryLock: connect() failed for ${key} (non-fatal, retrying within waitMs):`, err?.message ?? err);
      await sleep(250);
      continue;
    }
    const got = await c
      .query("SELECT pg_try_advisory_lock($1) AS ok", [lockId])
      .then((r) => r.rows[0]?.ok === true)
      .catch(() => false);
    if (got) {
      client = c;
      break;
    }
    c.release();
    await sleep(250);
  }
  if (!client) {
    // Never drop the message: whether nobody ever got the lock in time, or
    // every connect() attempt in the loop failed, the turn still runs, just
    // unserialized against any other in-flight turn for this same key.
    console.error(`advisoryLock: couldn't get the lock for ${key} within ${waitMs}ms, running without it`);
    return fn();
  }
  const held = client;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await held.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
    held.release();
  };
  let done = false;
  let timer: ReturnType<typeof setTimeout>;
  const armTimer = () => {
    timer = setTimeout(() => {
      if (done) return;
      if (Date.now() - started >= maxHoldMs) {
        console.error(`advisoryLock: ${key} held over ${maxHoldMs}ms (past the hard ceiling), releasing regardless`);
        release();
        return;
      }
      // Still running, and under the ceiling: extend rather than release.
      armTimer();
    }, holdMs);
  };
  armTimer();
  try {
    return await fn();
  } finally {
    done = true;
    clearTimeout(timer!);
    await release();
  }
}
