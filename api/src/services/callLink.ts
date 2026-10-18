// One-time call links (2026-10-18, member data out of logs). An outbound
// call's TwiML URL used to carry the member's user id and a 2-hour call token
// in its query string, so both sat in Twilio's request logs. Now the URL
// carries only an opaque call id: random, unguessable, good once, and only
// for the same 2 hours the token had. The id maps to the member on our side
// (call_links, db/migrations.ts), and only its hash is kept, so a copy of the
// table can't be replayed as links.
//
// The TwiML route (routes/co.ts /el/outbound-twiml) takes the id: one taker
// gets the member, every later try (Twilio's or anyone's) gets nothing.
// ElevenLabs' own per-call token (services/elevenLabsCalls.ts) is untouched:
// it never rides in a Twilio URL.
import { createHash, randomBytes } from "crypto";
import pool from "../db/db.js";
import { CALL_TOKEN_TTL_SECS } from "./elevenLabsCalls.js";

// The same window the call token had.
export const CALL_LINK_TTL_SECS = CALL_TOKEN_TTL_SECS;

// Where the links live. pg in the product; tests pass their own.
export type CallLinkStore = {
  put(hash: string, userId: string, expiresAt: Date): Promise<void>;
  // Removes the link whatever its age (used, or past its time, it is gone after this) and says who it was for and whether it was still live.
  take(hash: string, now: Date): Promise<{ userId: string; live: boolean } | null>;
  drop(hash: string): Promise<void>;
};

export const pgCallLinks: CallLinkStore = {
  async put(hash, userId, expiresAt) {
    await pool.query(`INSERT INTO call_links (id_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [hash, userId, expiresAt]);
    // Links for calls never answered are never taken: they go here, on the next dial.
    await pool.query(`DELETE FROM call_links WHERE expires_at < NOW()`).catch(() => {});
  },
  async take(hash, now) {
    const { rows } = await pool.query(`DELETE FROM call_links WHERE id_hash = $1 RETURNING user_id, expires_at > $2 AS live`, [hash, now]);
    return rows[0] ? { userId: String(rows[0].user_id), live: rows[0].live === true } : null;
  },
  async drop(hash) {
    await pool.query(`DELETE FROM call_links WHERE id_hash = $1`, [hash]);
  },
};

// 32 random bytes, base64url: 43 characters.
const ID_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const callLinkHash = (id: string) => createHash("sha256").update(id).digest("hex");

export async function issueCallLink(userId: string, store: CallLinkStore = pgCallLinks, now = new Date()): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await store.put(callLinkHash(id), userId, new Date(now.getTime() + CALL_LINK_TTL_SECS * 1000));
  return id;
}

// The member the link was issued for, once, while it is live. Anything else (unknown, used, expired, malformed) is null.
export async function takeCallLink(id: string | null | undefined, store: CallLinkStore = pgCallLinks, now = new Date()): Promise<string | null> {
  if (!id || !ID_SHAPE.test(id)) return null;
  const got = await store.take(callLinkHash(id), now);
  return got?.live ? got.userId : null;
}

// A dial that never went out: its link goes too.
export async function dropCallLink(id: string, store: CallLinkStore = pgCallLinks): Promise<void> {
  await store.drop(callLinkHash(id));
}
