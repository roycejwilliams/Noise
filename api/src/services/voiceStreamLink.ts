// One-time stream links for the voice read's fork (review of #269; the same pattern as #250's call links). Twilio keeps
// the TwiML we hand it in its logs, so the fork's <Parameter> carries only an opaque stream id: random, good once, for
// the call token's 2 hours. The id maps to the member and the call's session on our side (voice_stream_links,
// db/migrations.ts), and only its hash is kept, so a copy of the table can't be replayed as links. The member's id and
// the call token never go to Twilio.
import { createHash, randomBytes } from "crypto";
import pool from "../db/db.js";

// The call token's window (elevenLabsCalls.ts CALL_TOKEN_TTL_SECS; not imported, elevenLabsCalls imports this file).
export const VOICE_STREAM_LINK_TTL_SECS = 2 * 60 * 60;

export type VoiceStreamLinkStore = {
  put(hash: string, userId: string, sessionHash: string, expiresAt: Date): Promise<void>;
  // Removes the link whatever its age (used or past its time, it is gone after this), and says whether it was still live.
  take(hash: string, now: Date): Promise<{ userId: string; sessionHash: string; live: boolean } | null>;
};

export const pgVoiceStreamLinks: VoiceStreamLinkStore = {
  async put(hash, userId, sessionHash, expiresAt) {
    await pool.query(`INSERT INTO voice_stream_links (id_hash, user_id, session_hash, expires_at) VALUES ($1, $2, $3, $4)`, [hash, userId, sessionHash, expiresAt]);
    // Links for calls never answered are never taken: they go here, on the next call.
    await pool.query(`DELETE FROM voice_stream_links WHERE expires_at < NOW()`).catch(() => {});
  },
  async take(hash, now) {
    const { rows } = await pool.query(`DELETE FROM voice_stream_links WHERE id_hash = $1 RETURNING user_id, session_hash, expires_at > $2 AS live`, [hash, now]);
    return rows[0] ? { userId: String(rows[0].user_id), sessionHash: String(rows[0].session_hash), live: rows[0].live === true } : null;
  },
};

// 32 random bytes, base64url: 43 characters.
const ID_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const streamLinkHash = (id: string): string => sha(`voice-stream:${id}`);
// The session a call's voice read lives under: a hash of the call's own key (user and call token), so neither is held
// in the link table, and the call brain (routes/callLlm.ts) finds it from the key it already has.
export const sessionHashOf = (callKey: string): string => sha(`voice-session:${callKey}`);

export async function issueVoiceStreamLink(userId: string, callKey: string, store: VoiceStreamLinkStore = pgVoiceStreamLinks, now = new Date()): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await store.put(streamLinkHash(id), userId, sessionHashOf(callKey), new Date(now.getTime() + VOICE_STREAM_LINK_TTL_SECS * 1000));
  return id;
}

// Who the stream is for and its session, once, while live. Anything else (unknown, used, expired, malformed) is null.
export async function takeVoiceStreamLink(id: string | null | undefined, store: VoiceStreamLinkStore = pgVoiceStreamLinks, now = new Date()): Promise<{ userId: string; sessionHash: string } | null> {
  if (!id || !ID_SHAPE.test(id)) return null;
  const got = await store.take(streamLinkHash(id), now);
  return got?.live ? { userId: got.userId, sessionHash: got.sessionHash } : null;
}

// In memory, for tests.
export function memoryVoiceStreamLinks(): VoiceStreamLinkStore & { rows: Map<string, { userId: string; sessionHash: string; expiresAt: Date }> } {
  const rows = new Map<string, { userId: string; sessionHash: string; expiresAt: Date }>();
  return {
    rows,
    async put(hash, userId, sessionHash, expiresAt) { rows.set(hash, { userId, sessionHash, expiresAt }); },
    async take(hash, now) {
      const r = rows.get(hash);
      rows.delete(hash);
      return r ? { userId: r.userId, sessionHash: r.sessionHash, live: r.expiresAt > now } : null;
    },
  };
}
