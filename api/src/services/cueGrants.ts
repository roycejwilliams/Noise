// Cue's own Google grants, one scope each, on Cue's published Google project (Royce, 2026-10-15).
//
// The calendar (the bounce): "opt-in, trust surface designed FIRST. Before any member ever grants it: the grant screen, free/busy read
// only, the grant visible in 'what Cue knows,' one-tap revoke, never shared. Between two members Cue sees free or busy and nothing else.
// Once granted, the calendar is the only source allowed to HOLD a slot." And: "The free/busy-only split is non-negotiable - never reuse
// the combined Gmail/Drive grant to save time."
// Docs: "drive.file gets its own grant in the published project, same pattern as the calendar split." A Google Doc Cue makes goes into
// their Drive on this grant; Cue sees only the files it created there.
//
// Each grant is separate from the Google connection (services/googleAuth.ts, which keeps Gmail metadata on the Co Club project, in
// Testing):
//   - its own one-time link (google_oauth_states.grant_kind), whose consent asks for its one scope and nothing else;
//   - its own token (calendar_grants, docs_grants), encrypted like the Google one, revoked and deleted on its own;
//   - a plain screen before Google says what Cue will and won't see (routes/google.ts), and the page after it has a one-tap Disconnect;
//   - it shows in what Cue knows (ref grant:calendar, grant:docs), where removing it disconnects;
//   - its own OAuth client in Cue's own Google Cloud project (GOOGLE_CUE_CLIENT_ID / _SECRET; option A): free/busy and drive.file are
//     non-sensitive scopes, so that project can be published without the restricted Gmail review the Co Club project needs. Never the
//     combined grant's client, and no fallback to it: without Cue's client these grants are off.
// What the calendar reads: busy or free between two times, for this member only. Nothing here returns anything but this member's own
// busy spans, and never to another member.
import { createHash, randomBytes } from "crypto";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { decryptToken, encryptToken, pkcePair, redirectUri, revokeToken, tokenAndBaseReady } from "./googleAuth.js";

export type GrantKind = "calendar" | "docs";
export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.freebusy"] as const;
export const DOCS_SCOPES = ["https://www.googleapis.com/auth/drive.file"] as const;
// Table names are constants here, never from input.
const GRANTS: Record<GrantKind, { scope: string; table: "calendar_grants" | "docs_grants"; label: string }> = {
  calendar: { scope: CALENDAR_SCOPES[0], table: "calendar_grants", label: "calendar" },
  docs: { scope: DOCS_SCOPES[0], table: "docs_grants", label: "docs" },
};
const KINDS = Object.keys(GRANTS) as GrantKind[];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LINK_TTL_MS = 15 * 60 * 1000;
const base = () => process.env.API_URL?.replace(/\/+$/, "") ?? "";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const clientId = (env: NodeJS.ProcessEnv = process.env) => env.GOOGLE_CUE_CLIENT_ID ?? "";
const clientSecret = (env: NodeJS.ProcessEnv = process.env) => env.GOOGLE_CUE_CLIENT_SECRET ?? "";

export function cueGrantsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(clientId(env) && clientSecret(env) && tokenAndBaseReady(env));
}
export const calendarConfigured = cueGrantsConfigured;
export const docsConfigured = cueGrantsConfigured;

// Pure: exactly the grant's one scope, nothing wider and nothing else.
export function scopeOnly(kind: GrantKind, granted: string): boolean {
  const got = granted.split(/\s+/).filter(Boolean);
  return got.length === 1 && got[0] === GRANTS[kind].scope;
}
export const calendarScopesOnly = (granted: string) => scopeOnly("calendar", granted);

// Pure: Google's consent screen for one grant: its one scope, never merged with what they granted before.
export function grantAuthUrl(kind: GrantKind, state: string, challenge: string, env: NodeJS.ProcessEnv = process.env): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", clientId(env));
  u.searchParams.set("redirect_uri", redirectUri(env));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GRANTS[kind].scope);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}
export const calendarAuthUrl = (state: string, challenge: string, env: NodeJS.ProcessEnv = process.env) => grantAuthUrl("calendar", state, challenge, env);

// A one-time link for this member's grant: /google/connect/<state>, which shows the grant screen first.
// Grant screens are for members only (Royce, 2026-10-15): never an applicant, a guest, a partner-night guest or an archived account.
// Checked here, where every link is made, not only by the routing in front of it (review of the grants work).
export async function isGrantMember(userId: string, db: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM users WHERE id = $1 AND invite_verified = true AND identity_captured = true AND archived_at IS NULL`, [userId]);
  return rows.length > 0;
}

export async function createGrantLink(kind: GrantKind, userId: string): Promise<string | null> {
  if (!cueGrantsConfigured()) return null;
  if (!(await isGrantMember(userId).catch(() => false))) {
    await recordDecision({ layer: 3, decision: `${GRANTS[kind].label}.connectLink`, userId, outcome: "skip", action: "not_a_member" }).catch(() => {});
    return null;
  }
  const state = randomBytes(24).toString("base64url");
  const { verifier } = pkcePair();
  await pool.query(
    `INSERT INTO google_oauth_states (state, user_id, code_verifier_enc, expires_at, grant_kind) VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5)`,
    [state, userId, encryptToken(verifier), LINK_TTL_MS / 1000, kind],
  );
  await recordDecision({ layer: 3, decision: `${GRANTS[kind].label}.connectLink`, userId, outcome: "act", action: "created" }).catch(() => {});
  return `${base()}/google/connect/${state}`;
}
export const createCalendarLink = (userId: string) => createGrantLink("calendar", userId);
export const createDocsLink = (userId: string) => createGrantLink("docs", userId);

export async function grantKindOf(state: string): Promise<GrantKind | "google" | null> {
  const { rows } = await pool.query(`SELECT grant_kind FROM google_oauth_states WHERE state = $1 AND used_at IS NULL AND expires_at > NOW()`, [state]);
  if (!rows[0]) return null;
  return (KINDS as string[]).includes(rows[0].grant_kind) ? (rows[0].grant_kind as GrantKind) : "google";
}

export async function grantConsentUrlFor(kind: GrantKind, state: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT code_verifier_enc FROM google_oauth_states WHERE state = $1 AND grant_kind = $2 AND used_at IS NULL AND expires_at > NOW()`, [state, kind]);
  if (!rows[0]) return null;
  return grantAuthUrl(kind, state, createHash("sha256").update(decryptToken(rows[0].code_verifier_enc)).digest("base64url"));
}
export const calendarConsentUrlFor = (state: string) => grantConsentUrlFor("calendar", state);

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };

// Google sent them back for one grant. Anything other than exactly its scope is revoked and not kept. Returns the one-tap disconnect
// token (shown once, on the confirmation page; only its hash is kept).
export async function finishGrantConnect(kind: GrantKind, state: string, code: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; userId: string | null; revoke?: string; why?: string }> {
  const g = GRANTS[kind];
  const { rows } = await pool.query(
    `UPDATE google_oauth_states SET used_at = NOW() WHERE state = $1 AND grant_kind = $2 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id, code_verifier_enc`,
    [state, kind],
  );
  const row = rows[0];
  if (!row) return { ok: false, userId: null, why: "link expired or already used" };
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: decryptToken(row.code_verifier_enc) }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const tokens: TokenResponse = res ? ((await res.json().catch(() => ({ error: "unreadable" }))) as TokenResponse) : { error: "exchange failed" };
  if (!tokens.access_token || tokens.error) return { ok: false, userId: row.user_id, why: tokens.error ?? "no token" };
  if (!scopeOnly(kind, tokens.scope ?? "")) {
    await revokeToken(tokens.refresh_token ?? tokens.access_token, fetchImpl).catch(() => {});
    return { ok: false, userId: row.user_id, why: `not ${kind === "calendar" ? "free/busy" : "Drive files"} only` };
  }
  const revoke = randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO ${g.table} (user_id, refresh_token_enc, access_token_enc, access_expires_at, scope, revoke_hash, connected_at)
     VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, ${g.table}.refresh_token_enc), access_token_enc = EXCLUDED.access_token_enc,
       access_expires_at = EXCLUDED.access_expires_at, scope = EXCLUDED.scope, revoke_hash = EXCLUDED.revoke_hash, connected_at = NOW()`,
    [row.user_id, tokens.refresh_token ? encryptToken(tokens.refresh_token) : null, encryptToken(tokens.access_token), Math.max(60, (tokens.expires_in ?? 3600) - 60), tokens.scope, sha(revoke)],
  );
  await recordDecision({ layer: 3, decision: `${g.label}.connect`, userId: row.user_id, outcome: "act", action: "connected", proposal: { scope: tokens.scope } }).catch(() => {});
  return { ok: true, userId: row.user_id, revoke };
}
export const finishCalendarConnect = (state: string, code: string, fetchImpl: typeof fetch = fetch) => finishGrantConnect("calendar", state, code, fetchImpl);

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
export async function grantConnected(kind: GrantKind, userId: string, db: Db = pool): Promise<{ since: string } | null> {
  const { rows } = await db.query(`SELECT connected_at FROM ${GRANTS[kind].table} WHERE user_id = $1`, [userId]);
  return rows[0] ? { since: new Date(rows[0].connected_at).toISOString().slice(0, 10) } : null;
}
export const calendarConnected = (userId: string, db: Db = pool) => grantConnected("calendar", userId, db);
export const docsConnected = (userId: string, db: Db = pool) => grantConnected("docs", userId, db);

// Revoked with Google and deleted: nothing of it is kept.
export async function disconnectGrant(kind: GrantKind, userId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const { rows } = await pool.query(`DELETE FROM ${GRANTS[kind].table} WHERE user_id = $1 RETURNING refresh_token_enc, access_token_enc`, [userId]);
  // The busy times read from their calendar go with it ("what it had is deleted").
  if (kind === "calendar") await pool.query(`UPDATE google_snapshots SET busy = NULL WHERE user_id = $1`, [userId]).catch(() => {});
  const r = rows[0];
  if (!r) return false;
  const token = r.refresh_token_enc ? decryptToken(r.refresh_token_enc) : r.access_token_enc ? decryptToken(r.access_token_enc) : null;
  if (token) await revokeToken(token, fetchImpl).catch(() => {});
  await recordDecision({ layer: 3, decision: `${GRANTS[kind].label}.disconnect`, userId, outcome: "act", action: "revoked" }).catch(() => {});
  return true;
}
export const disconnectCalendar = (userId: string, fetchImpl: typeof fetch = fetch) => disconnectGrant("calendar", userId, fetchImpl);
export const disconnectDocs = (userId: string, fetchImpl: typeof fetch = fetch) => disconnectGrant("docs", userId, fetchImpl);

// The one-tap disconnect (the confirmation page's button): the token's hash names the grant (only that kind, when the page names one).
export async function disconnectByToken(token: string, fetchImpl: typeof fetch = fetch, only?: GrantKind): Promise<GrantKind | null> {
  if (!token || token.length < 16) return null;
  for (const kind of only ? [only] : KINDS) {
    const { rows } = await pool.query(`SELECT user_id FROM ${GRANTS[kind].table} WHERE revoke_hash = $1`, [sha(token)]);
    if (rows[0]) return (await disconnectGrant(kind, String(rows[0].user_id), fetchImpl)) ? kind : null;
  }
  return null;
}

// A fresh access token for this member's grant, refreshed on Cue's client when it's run out; null when there's no grant. A refresh
// Google refuses as revoked forgets the grant here too.
export async function grantToken(kind: GrantKind, userId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const t0 = GRANTS[kind].table;
  const { rows } = await pool.query(`SELECT refresh_token_enc, access_token_enc, access_expires_at > NOW() AS fresh FROM ${t0} WHERE user_id = $1`, [userId]);
  const r = rows[0];
  if (!r) return null;
  if (r.fresh && r.access_token_enc) return decryptToken(r.access_token_enc);
  if (!r.refresh_token_enc) return null;
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), refresh_token: decryptToken(r.refresh_token_enc), grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const t: TokenResponse = res ? ((await res.json().catch(() => ({}))) as TokenResponse) : {};
  if (!t.access_token) {
    if (t.error === "invalid_grant") {
      await pool.query(`DELETE FROM ${t0} WHERE user_id = $1`, [userId]).catch(() => {});
      // Revoked at Google: the busy times read through it go too, as on a disconnect here (review of the grants work).
      if (kind === "calendar") await pool.query(`UPDATE google_snapshots SET busy = NULL WHERE user_id = $1`, [userId]).catch(() => {});
    }
    return null;
  }
  await pool.query(`UPDATE ${t0} SET access_token_enc = $2, access_expires_at = NOW() + make_interval(secs => $3) WHERE user_id = $1`, [userId, encryptToken(t.access_token), Math.max(60, (t.expires_in ?? 3600) - 60)]);
  return t.access_token;
}
export const docsToken = (userId: string, fetchImpl: typeof fetch = fetch) => grantToken("docs", userId, fetchImpl);

export type BusySpan = { start: string; end: string };
// This member's busy spans between two times (free/busy only), read fresh; null when there's no grant or the read failed (then no
// calendar gap is real, and nothing is held).
export async function calendarBusy(userId: string, from: Date, to: Date, fetchImpl: typeof fetch = fetch): Promise<BusySpan[] | null> {
  const token = await grantToken("calendar", userId, fetchImpl).catch(() => null);
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
