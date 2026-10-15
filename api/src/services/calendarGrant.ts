// Calendar connect for the bounce (Royce, 2026-10-15): "opt-in, trust surface designed FIRST. Before any member ever grants it: the grant
// screen, free/busy read only, the grant visible in 'what Cue knows,' one-tap revoke, never shared. Between two members Cue sees free or
// busy and nothing else. Once granted, the calendar is the only source allowed to HOLD a slot." And: "The free/busy-only split is
// non-negotiable - never reuse the combined Gmail/Drive grant to save time."
//
// So this is its own grant, separate from the Google connection (services/googleAuth.ts, free/busy + Gmail metadata + Drive files):
//   - its own one-time link (google_oauth_states.grant = 'calendar'), whose consent asks for calendar.freebusy and nothing else;
//   - its own token (calendar_grants), encrypted like the Google one, revoked and deleted on its own (Docs and Gmail are untouched);
//   - a plain screen before Google says what Cue will and won't see (routes/google.ts), and the page after it has a one-tap Disconnect;
//   - it shows in what Cue knows (ref grant:calendar), where removing it disconnects.
// What's read: busy or free between two times, for this member only. It's never shown or said to another member: nothing here returns
// anything but this member's own busy spans.
import { createHash, randomBytes } from "crypto";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { decryptToken, encryptToken, googleConfigured, pkcePair, redirectUri, revokeToken } from "./googleAuth.js";

export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.freebusy"] as const;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LINK_TTL_MS = 15 * 60 * 1000;
const base = () => process.env.API_URL?.replace(/\/+$/, "") ?? "";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

// Pure: exactly free/busy, nothing wider and nothing else.
export function calendarScopesOnly(granted: string): boolean {
  const got = granted.split(/\s+/).filter(Boolean);
  return got.length === 1 && got[0] === CALENDAR_SCOPES[0];
}

// Pure: Google's consent screen for the calendar grant: free/busy only, never merged with what they granted before.
export function calendarAuthUrl(state: string, challenge: string, env: NodeJS.ProcessEnv = process.env): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri(env));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", CALENDAR_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

// A one-time link for this member's calendar grant: /google/connect/<state>, which shows the grant screen first.
export async function createCalendarLink(userId: string): Promise<string | null> {
  if (!googleConfigured()) return null;
  const state = randomBytes(24).toString("base64url");
  const { verifier } = pkcePair();
  await pool.query(
    `INSERT INTO google_oauth_states (state, user_id, code_verifier_enc, expires_at, grant_kind) VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), 'calendar')`,
    [state, userId, encryptToken(verifier), LINK_TTL_MS / 1000],
  );
  await recordDecision({ layer: 3, decision: "calendar.connectLink", userId, outcome: "act", action: "created" }).catch(() => {});
  return `${base()}/google/connect/${state}`;
}

export async function grantKindOf(state: string): Promise<"calendar" | "google" | null> {
  const { rows } = await pool.query(`SELECT grant_kind FROM google_oauth_states WHERE state = $1 AND used_at IS NULL AND expires_at > NOW()`, [state]);
  return rows[0] ? (rows[0].grant_kind === "calendar" ? "calendar" : "google") : null;
}

export async function calendarConsentUrlFor(state: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT code_verifier_enc FROM google_oauth_states WHERE state = $1 AND grant_kind = 'calendar' AND used_at IS NULL AND expires_at > NOW()`, [state]);
  if (!rows[0]) return null;
  return calendarAuthUrl(state, createHash("sha256").update(decryptToken(rows[0].code_verifier_enc)).digest("base64url"));
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };

// Google sent them back for a calendar grant. Anything other than exactly free/busy is revoked and not kept. Returns the one-tap
// disconnect token (shown once, on the confirmation page; only its hash is kept).
export async function finishCalendarConnect(state: string, code: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; userId: string | null; revoke?: string; why?: string }> {
  const { rows } = await pool.query(
    `UPDATE google_oauth_states SET used_at = NOW() WHERE state = $1 AND grant_kind = 'calendar' AND used_at IS NULL AND expires_at > NOW() RETURNING user_id, code_verifier_enc`,
    [state],
  );
  const row = rows[0];
  if (!row) return { ok: false, userId: null, why: "link expired or already used" };
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: decryptToken(row.code_verifier_enc) }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const tokens: TokenResponse = res ? ((await res.json().catch(() => ({ error: "unreadable" }))) as TokenResponse) : { error: "exchange failed" };
  if (!tokens.access_token || tokens.error) return { ok: false, userId: row.user_id, why: tokens.error ?? "no token" };
  if (!calendarScopesOnly(tokens.scope ?? "")) {
    await revokeToken(tokens.refresh_token ?? tokens.access_token, fetchImpl).catch(() => {});
    return { ok: false, userId: row.user_id, why: "not free/busy only" };
  }
  const revoke = randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO calendar_grants (user_id, refresh_token_enc, access_token_enc, access_expires_at, scope, revoke_hash, connected_at)
     VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, calendar_grants.refresh_token_enc), access_token_enc = EXCLUDED.access_token_enc,
       access_expires_at = EXCLUDED.access_expires_at, scope = EXCLUDED.scope, revoke_hash = EXCLUDED.revoke_hash, connected_at = NOW()`,
    [row.user_id, tokens.refresh_token ? encryptToken(tokens.refresh_token) : null, encryptToken(tokens.access_token), Math.max(60, (tokens.expires_in ?? 3600) - 60), tokens.scope, sha(revoke)],
  );
  await recordDecision({ layer: 3, decision: "calendar.connect", userId: row.user_id, outcome: "act", action: "connected", proposal: { scope: tokens.scope } }).catch(() => {});
  return { ok: true, userId: row.user_id, revoke };
}

export async function calendarConnected(userId: string, db: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<{ since: string } | null> {
  const { rows } = await db.query(`SELECT connected_at FROM calendar_grants WHERE user_id = $1`, [userId]);
  return rows[0] ? { since: new Date(rows[0].connected_at).toISOString().slice(0, 10) } : null;
}

// Revoked with Google and deleted: nothing of it is kept.
export async function disconnectCalendar(userId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const { rows } = await pool.query(`DELETE FROM calendar_grants WHERE user_id = $1 RETURNING refresh_token_enc, access_token_enc`, [userId]);
  const r = rows[0];
  if (!r) return false;
  const token = r.refresh_token_enc ? decryptToken(r.refresh_token_enc) : r.access_token_enc ? decryptToken(r.access_token_enc) : null;
  if (token) await revokeToken(token, fetchImpl).catch(() => {});
  await recordDecision({ layer: 3, decision: "calendar.disconnect", userId, outcome: "act", action: "revoked" }).catch(() => {});
  return true;
}

// The one-tap disconnect (the confirmation page's button): the token's hash names the grant.
export async function disconnectByToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!token || token.length < 16) return false;
  const { rows } = await pool.query(`SELECT user_id FROM calendar_grants WHERE revoke_hash = $1`, [sha(token)]);
  return rows[0] ? disconnectCalendar(String(rows[0].user_id), fetchImpl) : false;
}

async function calendarToken(userId: string, fetchImpl: typeof fetch): Promise<string | null> {
  const { rows } = await pool.query(`SELECT refresh_token_enc, access_token_enc, access_expires_at > NOW() AS fresh FROM calendar_grants WHERE user_id = $1`, [userId]);
  const r = rows[0];
  if (!r) return null;
  if (r.fresh && r.access_token_enc) return decryptToken(r.access_token_enc);
  if (!r.refresh_token_enc) return null;
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", refresh_token: decryptToken(r.refresh_token_enc), grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const t: TokenResponse = res ? ((await res.json().catch(() => ({}))) as TokenResponse) : {};
  if (!t.access_token) return null;
  await pool.query(`UPDATE calendar_grants SET access_token_enc = $2, access_expires_at = NOW() + make_interval(secs => $3) WHERE user_id = $1`, [userId, encryptToken(t.access_token), Math.max(60, (t.expires_in ?? 3600) - 60)]);
  return t.access_token;
}

export type BusySpan = { start: string; end: string };
// This member's busy spans between two times (free/busy only), read fresh; null when there's no grant or the read failed (then no
// calendar gap is real, and nothing is held).
export async function calendarBusy(userId: string, from: Date, to: Date, fetchImpl: typeof fetch = fetch): Promise<BusySpan[] | null> {
  const token = await calendarToken(userId, fetchImpl).catch(() => null);
  if (!token) return null;
  const res = await fetchImpl("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const j: any = await res.json().catch(() => null);
  const busy = j?.calendars?.primary?.busy;
  return Array.isArray(busy) ? busy.filter((b: any) => b?.start && b?.end).map((b: any) => ({ start: String(b.start), end: String(b.end) })) : null;
}

// Pure: whether [from, to) is free given busy spans (any overlap is busy).
export function spanFree(from: Date, to: Date, busy: BusySpan[]): boolean {
  return !busy.some((b) => Date.parse(b.start) < to.getTime() && Date.parse(b.end) > from.getTime());
}
