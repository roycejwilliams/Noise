// Where Co pages live (table co_pages, db/migrations.ts). Security review, 2026-10-11:
//   The id is the only key to view a page: 18 random bytes (144 bits), base64url, never listed, never sequential or timed. Anyone with
//   the link can view; guessing one is about a 1 in 10^43 shot per try.
//   Changing or taking down a page is the owner's only: every write matches the id AND the owner, so a link one member pastes into
//   another's thread can't be used to change or remove it from there (H1).
//   What's stored has passed the schema (parseCoPageData) and the grounding (grounding.ts: only the owner's words and Co's reads, H2).
//   A page expires 90 days after its last change. Taken down or expired, the link answers 404 and the content is wiped (M2).
import { randomBytes } from "crypto";
import pool from "../../db/db.js";
import { parseCoPageData, type CoPageData } from "./schema.js";
import { deckProblems, pageProblems, type PageSource } from "./grounding.js";
import { deckAssetIds, isDeckData, parseCoDeckData, type DeckData } from "./deck.js";

export type CoPageDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
let db: CoPageDb = pool;
// Tests swap in a stub; nothing else should.
export function useCoPageDb(d: CoPageDb | null): void {
  db = d ?? pool;
}

export const CO_PAGE_ID = /^[A-Za-z0-9_-]{24}$/;
export const PAGE_LIFETIME_DAYS = 90;
export function newCoPageId(): string {
  return randomBytes(18).toString("base64url");
}

// A row holds one artifact: a page (CoPageData) or a deck (DeckData, kind "deck"). Same link, rules and lifetime for both.
export type CoArtifactData = CoPageData | DeckData;
export type StoredCoPage = { id: string; data: CoArtifactData; version: number; updatedAt: Date; ownerUserId: string };
export const artifactKind = (d: unknown): "page" | "deck" => (isDeckData(d) ? "deck" : "page");
// The gate for either type: a deck's own schema, else the page's.
export function parseCoArtifact(input: unknown): { ok: true; data: CoArtifactData } | { ok: false; problems: string[] } {
  return isDeckData(input) ? parseCoDeckData(input) : parseCoPageData(input);
}

// The public base for member links: API_URL, else Railway's own domain (as invites, readouts and plan files do).
export function coPageBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.API_URL ?? "").replace(/\/+$/, "");
  if (/^https?:\/\//.test(base)) return base;
  return env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null;
}
export function coPageUrl(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = coPageBase(env);
  if (!base) throw new Error("API_URL isn't set, so there's no link to give");
  return `${base}/d/${id}`;
}

// Pure: the member assets an artifact places (services/memberAssets.ts). A page places none yet.
export function assetIdsIn(d: CoArtifactData): string[] {
  return isDeckData(d) ? deckAssetIds(d as DeckData) : [];
}
// Every asset it places must be the owner's own (never another member's image), and placing one counts as using it.
async function assetsAreTheirs(d: CoArtifactData, ownerUserId: string): Promise<string[]> {
  const ids = assetIdsIn(d);
  if (!ids.length) return [];
  const A = await import("../memberAssets.js");
  const owned = await A.ownedAssetIds(ownerUserId, ids);
  const bad = ids.filter((i) => !owned.has(i));
  if (bad.length) return [`${bad.length} image(s) aren't theirs or are no longer saved; use only their own image numbers`];
  await A.touchAssets(ids).catch(() => {});
  return [];
}

// The schema, then the grounding: a page that fails either is never written.
export function checkPage(data: unknown, source: PageSource): { ok: true; data: CoArtifactData } | { ok: false; problems: string[] } {
  const p = parseCoArtifact(data);
  if (!p.ok) return p;
  const problems = isDeckData(p.data) ? deckProblems(p.data as DeckData, source) : pageProblems(p.data as CoPageData, source);
  return problems.length ? { ok: false, problems } : p;
}

export async function createCoPage(data: unknown, o: { ownerUserId: string; source: PageSource }): Promise<{ ok: true; id: string; url: string } | { ok: false; problems: string[] }> {
  if (!o.ownerUserId) return { ok: false, problems: ["a page needs its owner"] };
  const c = checkPage(data, o.source);
  if (!c.ok) return c;
  const notTheirs = await assetsAreTheirs(c.data, o.ownerUserId);
  if (notTheirs.length) return { ok: false, problems: notTheirs };
  const id = newCoPageId();
  // The link is made before the row, so a missing base URL never leaves a page nobody can reach.
  const url = coPageUrl(id);
  await db.query(
    `INSERT INTO co_pages (id, owner_user_id, data, expires_at) VALUES ($1, $2, $3, NOW() + make_interval(days => $4))`,
    [id, o.ownerUserId, JSON.stringify(c.data), PAGE_LIFETIME_DAYS],
  );
  return { ok: true, id, url };
}

// A new version, same link: the owner's own live page only. Null when there's no such page for them.
export async function updateCoPage(id: string, ownerUserId: string, data: unknown, source: PageSource): Promise<{ ok: true; version: number } | { ok: false; problems: string[] } | null> {
  if (!CO_PAGE_ID.test(id) || !ownerUserId) return null;
  const c = checkPage(data, source);
  if (!c.ok) return c;
  const notTheirs = await assetsAreTheirs(c.data, ownerUserId);
  if (notTheirs.length) return { ok: false, problems: notTheirs };
  const { rows } = await db.query(
    `UPDATE co_pages SET data = $3, version = version + 1, updated_at = NOW(), expires_at = CASE WHEN kept THEN expires_at ELSE NOW() + make_interval(days => $4) END, expiry_warned_at = NULL
     WHERE id = $1 AND owner_user_id = $2 AND taken_down_at IS NULL AND expires_at > NOW() AND COALESCE(data->>'kind', 'page') = $5 RETURNING version`,
    [id, ownerUserId, JSON.stringify(c.data), PAGE_LIFETIME_DAYS, artifactKind(c.data)],
  );
  return rows[0] ? { ok: true, version: Number(rows[0].version) } : null;
}

// "Take that page down": the owner's own page only. The link answers 404 from now on and the content is wiped right away.
export async function takeDownCoPage(id: string, ownerUserId: string): Promise<boolean> {
  if (!CO_PAGE_ID.test(id) || !ownerUserId) return false;
  const { rowCount } = await db.query(
    `UPDATE co_pages SET taken_down_at = NOW(), data = '{}'::jsonb, updated_at = NOW() WHERE id = $1 AND owner_user_id = $2 AND taken_down_at IS NULL`,
    [id, ownerUserId],
  );
  return (rowCount ?? 0) > 0;
}

// The owner's live pages, newest first (so "take down the page you sent me" can find it). Titles only.
export async function livePagesFor(ownerUserId: string): Promise<{ id: string; title: string; updatedAt: Date; kind: "page" | "deck" }[]> {
  const { rows } = await db.query(
    `SELECT id, data->>'title' AS title, COALESCE(data->>'kind', 'page') AS kind, updated_at FROM co_pages WHERE owner_user_id = $1 AND taken_down_at IS NULL AND expires_at > NOW() ORDER BY updated_at DESC LIMIT 20`,
    [ownerUserId],
  );
  return rows.map((r) => ({ id: String(r.id), title: String(r.title ?? ""), updatedAt: new Date(r.updated_at), kind: r.kind === "deck" ? ("deck" as const) : ("page" as const) }));
}

// Expired pages lose their content (run daily from jobs). The row stays so the link keeps answering 404, never someone else's page.
export async function wipeExpiredCoPages(): Promise<number> {
  const { rowCount } = await db.query(`UPDATE co_pages SET taken_down_at = NOW(), data = '{}'::jsonb WHERE taken_down_at IS NULL AND expires_at <= NOW()`);
  return rowCount ?? 0;
}

// For the public route: a live page or null. Expired, taken down, malformed or unknown are all the same null (one plain 404).
export async function loadCoPage(id: string): Promise<StoredCoPage | null> {
  if (!CO_PAGE_ID.test(id)) return null;
  const { rows } = await db.query(
    `SELECT id, owner_user_id, data, version, updated_at FROM co_pages WHERE id = $1 AND taken_down_at IS NULL AND expires_at > NOW()`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  // Re-checked on the way out, so a row written before a rule tightened never renders unchecked.
  const p = parseCoArtifact(typeof r.data === "string" ? JSON.parse(r.data) : r.data);
  if (!p.ok) {
    console.error(`co page ${id.slice(0, 4)}…: stored data no longer passes the schema: ${p.problems.slice(0, 3).join("; ")}`);
    return null;
  }
  return { id: String(r.id), data: p.data, version: Number(r.version), updatedAt: new Date(r.updated_at), ownerUserId: String(r.owner_user_id) };
}

// ---------------------------------------------------------------- keep and renewal (2026-10-11)

// "Keep this": no expiry from now on. "Renew": 90 more days from today. The owner's own live artifact only. Null when there's none.
export async function keepCoPage(id: string, ownerUserId: string, mode: "keep" | "renew"): Promise<{ kept: boolean; expiresAt: Date | null } | null> {
  if (!CO_PAGE_ID.test(id) || !ownerUserId) return null;
  const { rows } = await db.query(
    mode === "keep"
      ? `UPDATE co_pages SET kept = true, expires_at = 'infinity', expiry_warned_at = NULL WHERE id = $1 AND owner_user_id = $2 AND taken_down_at IS NULL AND expires_at > NOW() RETURNING kept, expires_at`
      : `UPDATE co_pages SET expires_at = CASE WHEN kept THEN expires_at ELSE NOW() + make_interval(days => $3) END, expiry_warned_at = NULL WHERE id = $1 AND owner_user_id = $2 AND taken_down_at IS NULL AND expires_at > NOW() RETURNING kept, expires_at`,
    mode === "keep" ? [id, ownerUserId] : [id, ownerUserId, PAGE_LIFETIME_DAYS],
  );
  if (!rows[0]) return null;
  const at = new Date(rows[0].expires_at);
  return { kept: !!rows[0].kept, expiresAt: Number.isFinite(at.getTime()) ? at : null };
}

// Their link opened: the artifact is in use. The first ten minutes don't count (the link preview fetches it as it's sent).
export async function noteViewed(id: string): Promise<void> {
  if (!CO_PAGE_ID.test(id)) return;
  await db.query(`UPDATE co_pages SET last_viewed_at = NOW() WHERE id = $1 AND created_at < NOW() - INTERVAL '10 minutes'`, [id]);
}

// Live, not kept, expiring within the warning window, not yet warned, and in use: their link or a share link opened in the last 30
// days. (An edit renews the 90 days, so one inside its last week was never edited in the last month; opening is the signal.)
export const EXPIRY_WARN_DAYS = 7;
export async function expiringInUse(): Promise<{ id: string; ownerUserId: string; title: string; kind: "page" | "deck"; expiresAt: Date }[]> {
  const { rows } = await db.query(
    `SELECT id, owner_user_id, data->>'title' AS title, COALESCE(data->>'kind', 'page') AS kind, expires_at FROM co_pages
     WHERE taken_down_at IS NULL AND NOT kept AND expiry_warned_at IS NULL AND expires_at > NOW() AND expires_at < NOW() + make_interval(days => $1)
       AND last_viewed_at > NOW() - INTERVAL '30 days'`,
    [EXPIRY_WARN_DAYS],
  );
  return rows.map((r) => ({ id: String(r.id), ownerUserId: String(r.owner_user_id), title: String(r.title ?? ""), kind: r.kind === "deck" ? ("deck" as const) : ("page" as const), expiresAt: new Date(r.expires_at) }));
}
export async function markExpiryWarned(id: string): Promise<void> {
  await db.query(`UPDATE co_pages SET expiry_warned_at = NOW() WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------- share links (2026-10-11)

// A separate view-only link to one of the owner's live artifacts, made only when they ask (their words are kept with it). The row is
// the log of its creation. The owner's own link stays theirs; revoking a share link never touches it.
export function coShareUrl(shareId: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = coPageBase(env);
  if (!base) throw new Error("API_URL isn't set, so there's no link to give");
  return `${base}/d/v/${shareId}`;
}
export async function createShareLink(pageId: string, ownerUserId: string, theirWords: string): Promise<{ shareId: string; url: string } | null> {
  if (!CO_PAGE_ID.test(pageId) || !ownerUserId || !theirWords.trim()) return null;
  const shareId = newCoPageId();
  const url = coShareUrl(shareId);
  const { rowCount } = await db.query(
    `INSERT INTO co_page_shares (id, page_id, owner_user_id, their_words)
     SELECT $1, id, owner_user_id, $3 FROM co_pages WHERE id = $2 AND owner_user_id = $4 AND taken_down_at IS NULL AND expires_at > NOW()`,
    [shareId, pageId, theirWords.slice(0, 400), ownerUserId],
  );
  return (rowCount ?? 0) > 0 ? { shareId, url } : null;
}
// Ends every live share link to it. The owner's own link keeps working.
export async function revokeShareLinks(pageId: string, ownerUserId: string): Promise<number> {
  if (!CO_PAGE_ID.test(pageId) || !ownerUserId) return 0;
  const { rowCount } = await db.query(`UPDATE co_page_shares SET revoked_at = NOW() WHERE page_id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`, [pageId, ownerUserId]);
  return rowCount ?? 0;
}
export async function liveShareCount(pageId: string, ownerUserId: string): Promise<number> {
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM co_page_shares WHERE page_id = $1 AND owner_user_id = $2 AND revoked_at IS NULL`, [pageId, ownerUserId]);
  return Number(rows[0]?.n ?? 0);
}
// For the public share route: the artifact behind a live share link, or null (revoked, unknown, or the artifact is gone).
export async function loadShared(shareId: string): Promise<StoredCoPage | null> {
  if (!CO_PAGE_ID.test(shareId)) return null;
  const { rows } = await db.query(`SELECT page_id FROM co_page_shares WHERE id = $1 AND revoked_at IS NULL`, [shareId]);
  return rows[0] ? loadCoPage(String(rows[0].page_id)) : null;
}

// ---------------------------------------------------------------- a fresh link (2026-10-11)

// "Reset my link": a member's own link is a link anyone they forward it to can open (members don't sign in on the web), so the way
// to revoke it is a new one. The same artifact (content, version, keep and expiry) moves to a fresh id; the old link answers 404 and
// its content is wiped, and every share link to it ends. Owner's own live artifact only. Null when there's none.
export async function resetCoPageLink(id: string, ownerUserId: string): Promise<{ id: string; url: string } | null> {
  if (!CO_PAGE_ID.test(id) || !ownerUserId) return null;
  const fresh = newCoPageId();
  const url = coPageUrl(fresh);
  // One statement, so it all happens or none of it does, and the old row is locked first (FOR UPDATE): two resets at once can't
  // both copy it. The second waits, then finds it already taken down, and makes nothing (Royce, 2026-10-11: "two near-simultaneous
  // resets must never leave two working own-links").
  const { rows } = await db.query(
    `WITH old AS (
       SELECT id, owner_user_id, data, version, created_at, updated_at, expires_at, kept, last_viewed_at FROM co_pages
       WHERE id = $2 AND owner_user_id = $3 AND taken_down_at IS NULL AND expires_at > NOW()
       FOR UPDATE
     ), down AS (
       UPDATE co_pages p SET taken_down_at = NOW(), data = '{}'::jsonb, updated_at = NOW() FROM old
       WHERE p.id = old.id AND p.taken_down_at IS NULL
       RETURNING old.owner_user_id, old.data, old.version, old.created_at, old.updated_at, old.expires_at, old.kept, old.last_viewed_at
     ), ins AS (
       INSERT INTO co_pages (id, owner_user_id, data, version, created_at, updated_at, expires_at, kept, last_viewed_at)
       SELECT $1, owner_user_id, data, version, created_at, updated_at, expires_at, kept, last_viewed_at FROM down
       RETURNING id
     ), rev AS (
       UPDATE co_page_shares SET revoked_at = NOW() WHERE page_id = $2 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM ins) RETURNING id
     )
     SELECT (SELECT id FROM ins) AS id`,
    [fresh, id, ownerUserId],
  );
  if (!rows[0]?.id) return null;
  return { id: fresh, url };
}
