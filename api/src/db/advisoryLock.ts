import crypto from "crypto";
import pool from "./db.js";

// Postgres advisory locks take a bigint key — hash the string key down to a
// 32-bit int so this works for any string identifier (a phone number, a
// circle id), not just literal integers. Collisions are possible but
// vanishingly unlikely at this app's scale, and a false-positive serializes
// two unrelated things rather than corrupting anything.
function lockKeyToInt(key: string): number {
  const hash = crypto.createHash("md5").update(key).digest();
  return hash.readInt32BE(0);
}

// Runs fn while holding a session-level Postgres advisory lock on `key`.
// Unlike an in-memory Map keyed lock, this is correct across every app
// replica and every request-handling process, since the lock lives in
// Postgres rather than one process's memory.
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const lockId = lockKeyToInt(key);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockId]);
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
    client.release();
  }
}
