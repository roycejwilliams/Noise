// Google Calendar and Gmail, read-only (Royce, 2026-09-28: "Gmail for tracking
// sponsor outreach, Calendar so I actually know when you're free instead of
// guessing"). Off until the Google OAuth client exists (GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_KEY on the service).
//
// The member connects by text: Co sends a one-time link bound to them
// (15 minutes, single use), which starts Google's consent screen with a
// random state and PKCE. Only two read scopes are ever asked for: free/busy
// on their calendars, and Gmail metadata (who, subject, when; never a
// message body). Tokens are encrypted at rest with AES-256-GCM, kept to that
// member only, and "disconnect Google" deletes and revokes them.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";

// The only scopes Co ever asks for, and the only ones it accepts back.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/gmail.metadata",
] as const;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const LINK_TTL_MS = 15 * 60 * 1000;

export function googleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && tokenKey(env) && baseUrl(env));
}

function baseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const b = env.API_URL?.replace(/\/+$/, "");
  return b && /^https:\/\//.test(b) ? b : null;
}

export function redirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return env.GOOGLE_REDIRECT_URI || `${baseUrl(env)}/google/callback`;
}

// ------------------------------------------------------------ encryption

// GOOGLE_TOKEN_KEY: 32 random bytes, base64 (openssl rand -base64 32).
function tokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.GOOGLE_TOKEN_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function encryptToken(plain: string, key: Buffer | null = tokenKey()): string {
  if (!key) throw new Error("google: GOOGLE_TOKEN_KEY missing or not 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

export function decryptToken(sealed: string, key: Buffer | null = tokenKey()): string {
  if (!key) throw new Error("google: GOOGLE_TOKEN_KEY missing or not 32 bytes");
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("google: unreadable token");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

// ------------------------------------------------------------ PKCE and scopes

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// Every granted scope must be one Co asked for; anything wider is refused.
export function scopesAllowed(granted: string): boolean {
  const got = granted.split(/\s+/).filter(Boolean);
  return got.length > 0 && got.every((s) => (GOOGLE_SCOPES as readonly string[]).includes(s));
}

export function authUrl(state: string, challenge: string, env: NodeJS.ProcessEnv = process.env): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri(env));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

// ------------------------------------------------------------ the connect link

// A one-time link for this member: /google/connect/<state>. The state is
// random, single use, and expires in 15 minutes.
export async function createConnectLink(userId: string): Promise<string | null> {
  if (!googleConfigured()) return null;
  const state = randomBytes(24).toString("base64url");
  const { verifier } = pkcePair();
  await pool.query(
    `INSERT INTO google_oauth_states (state, user_id, code_verifier_enc, expires_at) VALUES ($1, $2, $3, NOW() + make_interval(secs => $4))`,
    [state, userId, encryptToken(verifier), LINK_TTL_MS / 1000],
  );
  await recordDecision({ layer: 3, decision: "google.connectLink", userId, outcome: "act", action: "created" }).catch(() => {});
  return `${baseUrl()}/google/connect/${state}`;
}

// Opens Google's consent screen for a live, unused state.
export async function consentUrlFor(state: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT code_verifier_enc FROM google_oauth_states WHERE state = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [state],
  );
  if (!rows[0]) return null;
  const verifier = decryptToken(rows[0].code_verifier_enc);
  return authUrl(state, createHash("sha256").update(verifier).digest("base64url"));
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };

export async function exchangeCode(code: string, verifier: string, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()) as TokenResponse;
}

// Google sends them back here. The state must be live and unused; it's
// spent whatever happens next.
export async function finishConnect(state: string, code: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; userId: string | null; why?: string }> {
  const { rows } = await pool.query(
    `UPDATE google_oauth_states SET used_at = NOW() WHERE state = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id, code_verifier_enc`,
    [state],
  );
  const row = rows[0];
  if (!row) return { ok: false, userId: null, why: "link expired or already used" };
  const tokens = await exchangeCode(code, decryptToken(row.code_verifier_enc), fetchImpl).catch(() => ({ error: "exchange failed" }) as TokenResponse);
  if (!tokens.access_token || tokens.error) return { ok: false, userId: row.user_id, why: tokens.error ?? "no token" };
  if (!scopesAllowed(tokens.scope ?? "")) {
    // Wider than asked (or nothing): don't keep it.
    await revokeToken(tokens.refresh_token ?? tokens.access_token, fetchImpl).catch(() => {});
    return { ok: false, userId: row.user_id, why: "unexpected scopes" };
  }
  await pool.query(
    `INSERT INTO google_connections (user_id, refresh_token_enc, access_token_enc, access_expires_at, scopes, connected_at)
     VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, google_connections.refresh_token_enc),
       access_token_enc = EXCLUDED.access_token_enc, access_expires_at = EXCLUDED.access_expires_at, scopes = EXCLUDED.scopes, connected_at = NOW()`,
    [row.user_id, tokens.refresh_token ? encryptToken(tokens.refresh_token) : null, encryptToken(tokens.access_token), Math.max(60, (tokens.expires_in ?? 3600) - 60), tokens.scope],
  );
  await recordDecision({ layer: 3, decision: "google.connect", userId: row.user_id, outcome: "act", action: "connected", proposal: { scopes: tokens.scope } }).catch(() => {});
  return { ok: true, userId: row.user_id };
}

// ------------------------------------------------------------ using and ending it

export async function isConnected(userId: string): Promise<{ connected: boolean; scopes: string[] }> {
  const { rows } = await pool.query(`SELECT scopes FROM google_connections WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  return { connected: !!rows[0], scopes: String(rows[0]?.scopes ?? "").split(/\s+/).filter(Boolean) };
}

// A fresh access token for this member only, refreshed when it's run out.
export async function accessTokenFor(userId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT refresh_token_enc, access_token_enc, access_expires_at > NOW() AS fresh FROM google_connections WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.fresh && r.access_token_enc) return decryptToken(r.access_token_enc);
  if (!r.refresh_token_enc) return null;
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: decryptToken(r.refresh_token_enc),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const t = (await res.json()) as TokenResponse;
  if (!t.access_token) {
    // Revoked on Google's side: forget it here too.
    if (t.error === "invalid_grant") await pool.query(`DELETE FROM google_connections WHERE user_id = $1`, [userId]).catch(() => {});
    return null;
  }
  await pool.query(`UPDATE google_connections SET access_token_enc = $2, access_expires_at = NOW() + make_interval(secs => $3) WHERE user_id = $1`, [
    userId,
    encryptToken(t.access_token),
    Math.max(60, (t.expires_in ?? 3600) - 60),
  ]);
  return t.access_token;
}

async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  });
}

// "Disconnect Google": revoked with Google, deleted here, and the cached
// calendar and email summary go with it.
export async function disconnectGoogle(userId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const { rows } = await pool.query(`DELETE FROM google_connections WHERE user_id = $1 RETURNING refresh_token_enc, access_token_enc`, [userId]);
  await pool.query(`DELETE FROM google_snapshots WHERE user_id = $1`, [userId]).catch(() => {});
  const r = rows[0];
  if (!r) return false;
  const token = r.refresh_token_enc ? decryptToken(r.refresh_token_enc) : r.access_token_enc ? decryptToken(r.access_token_enc) : null;
  if (token) await revokeToken(token, fetchImpl).catch(() => {});
  await recordDecision({ layer: 3, decision: "google.disconnect", userId, outcome: "act", action: "revoked" }).catch(() => {});
  return true;
}
