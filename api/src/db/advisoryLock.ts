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
// 40 minutes).
const lockPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs fn while holding a session-level Postgres advisory lock on `key`.
// Unlike an in-memory Map keyed lock, this is correct across every app
// replica and every request-handling process, since the lock lives in
// Postgres rather than one process's memory.
//
// Waiting polls pg_try_advisory_lock without holding a connection. After
// waitMs it runs fn without the lock rather than dropping the work. A holder
// keeps the lock at most holdMs; after that the lock is released even if fn
// is still running, so one hung turn can't block a person forever.
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; holdMs?: number } = {},
): Promise<T> {
  const lockId = lockKeyToInt(key);
  const waitMs = opts.waitMs ?? 90_000;
  const holdMs = opts.holdMs ?? 120_000;
  const started = Date.now();
  let client: PoolClient | null = null;
  while (Date.now() - started < waitMs) {
    const c = await lockPool.connect();
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
    console.error(`advisoryLock: waited ${waitMs}ms for ${key}, running without the lock`);
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
  const timer = setTimeout(() => {
    console.error(`advisoryLock: ${key} held over ${holdMs}ms, releasing`);
    release();
  }, holdMs);
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    await release();
  }
}
