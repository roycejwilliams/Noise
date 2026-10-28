// Where Co pages live (table co_pages, db/migrations.ts). Security review, 2026-10-11:
//   The id is the only key to view a page: 18 random bytes (144 bits), base64url, never listed, never sequential or timed. Anyone with
//   the link can view; guessing one is about a 1 in 10^43 shot per try.
//   Changing or taking down a page is the owner's only: every write matches the id AND the owner, so a link one member pastes into
//   another's thread can't be used to change or remove it from there (H1).
//   What's stored has passed the schema (parseCoPageData) and the grounding (grounding.ts: only the owner's words and Co's reads, H2).
//   A page expires 90 days after its last change. Taken down or expired, the link answers 404 and the content is wiped (M2).
//   Its link card's picture (preview, Royce 2026-10-28, option C) is the content too: wiped everywhere data is (take-down, expiry, a
//   reset's old row, a photo of theirs it placed being deleted, the account deleted by cascade) and replaced on every new version.
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
// shot: a link card picture is stored for this very version (loadCoPage; services/coPages/linkPreview.ts serves it).
export type StoredCoPage = { id: string; data: CoArtifactData; version: number; updatedAt: Date; ownerUserId: string; shot?: boolean };
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

// Pure: the member assets an artifact places (services/memberAssets.ts): a deck's logo and slide pictures, a page's logo and
// section pictures.
export function assetIdsIn(d: CoArtifactData): string[] {
  if (isDeckData(d)) return deckAssetIds(d as DeckData);
  const p = d as CoPageData;
  return [...new Set([p.logo, p.coverImage, ...p.sections.map((s) => s.asset)].filter((x): x is string => !!x))];
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

// The link card's picture (Royce, 2026-10-28, option C: no separate picture with the text; the link's own card shows the artifact's
// real first screen, kept with it on this server, never uploaded anywhere). It is the QA render of the version that ships
// (services/designQa.ts CARD_SHOT), stored with that version in the same write, so a card never shows another version. Only a PNG,
// and only up to the cap (a 1280x720 slide of photos runs ~1MB); anything else, or QA that couldn't render, stores nothing and the
// link keeps the drawn card (linkPreview.ts).
export const PREVIEW_SHOT_MAX_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function previewShotOf(png: Buffer | null | undefined): Buffer | null {
  if (!png || !Buffer.isBuffer(png) || png.length <= PNG_MAGIC.length || png.length > PREVIEW_SHOT_MAX_BYTES) return null;
  return png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? png : null;
}

export async function createCoPage(data: unknown, o: { ownerUserId: string; source: PageSource; preview?: Buffer | null }): Promise<{ ok: true; id: string; url: string } | { ok: false; problems: string[] }> {
  if (!o.ownerUserId) return { ok: false, problems: ["a page needs its owner"] };
  const c = checkPage(data, o.source);
  if (!c.ok) return c;
  const notTheirs = await assetsAreTheirs(c.data, o.ownerUserId);
  if (notTheirs.length) return { ok: false, problems: notTheirs };
  const id = newCoPageId();
  // The link is made before the row, so a missing base URL never leaves a page nobody can reach.
  const url = coPageUrl(id);
  await db.query(
    `INSERT INTO co_pages (id, owner_user_id, data, expires_at, preview, preview_version) VALUES ($1, $2, $3, NOW() + make_interval(days => $4), $5::bytea, CASE WHEN $5::bytea IS NULL THEN NULL ELSE 1 END)`,
    [id, o.ownerUserId, JSON.stringify(c.data), PAGE_LIFETIME_DAYS, previewShotOf(o.preview)],
  );
  return { ok: true, id, url };
}

// A new version, same link: the owner's own live page only. Null when there's no such page for them.
// expectVersion (concurrency audit, 2026-10-12): the version the change was written from. Another change that landed in between is
// never overwritten: the result says so (conflict) with the newest version, and the caller recomposes or reads again. A reset that
// moved the page to a fresh link meanwhile is followed there (moved: the new id and link), so the change isn't lost.
// preview: the new version's link card picture (createCoPage above). Every new version replaces the last one's, with none when QA
// couldn't render it: an older version's picture never outlives it.
export type UpdateConflict = { ok: false; problems: string[]; conflict: { id: string; version: number } };
export async function updateCoPage(
  id: string,
  ownerUserId: string,
  data: unknown,
  source: PageSource,
  opts: { expectVersion?: number | null; preview?: Buffer | null } = {},
): Promise<{ ok: true; version: number; moved?: { id: string; url: string } } | { ok: false; problems: string[]; conflict?: UpdateConflict["conflict"] } | null> {
  if (!CO_PAGE_ID.test(id) || !ownerUserId) return null;
  const c = checkPage(data, source);
  if (!c.ok) return c;
  const notTheirs = await assetsAreTheirs(c.data, ownerUserId);
  if (notTheirs.length) return { ok: false, problems: notTheirs };
  const expect = typeof opts.expectVersion === "number" ? opts.expectVersion : null;
  let at = id;
  for (let hop = 0; hop < 3; hop++) {
    const { rows } = await db.query(
      `UPDATE co_pages SET data = $3, version = version + 1, updated_at = NOW(), expires_at = CASE WHEN kept THEN expires_at ELSE NOW() + make_interval(days => $4) END, expiry_warned_at = NULL,
         preview = $7::bytea, preview_version = CASE WHEN $7::bytea IS NULL THEN NULL ELSE version + 1 END
       WHERE id = $1 AND owner_user_id = $2 AND taken_down_at IS NULL AND expires_at > NOW() AND COALESCE(data->>'kind', 'page') = $5 AND ($6::int IS NULL OR version = $6::int) RETURNING version`,
      [at, ownerUserId, JSON.stringify(c.data), PAGE_LIFETIME_DAYS, artifactKind(c.data), expect, previewShotOf(opts.preview)],
    );
    if (rows[0]) return { ok: true, version: Number(rows[0].version), ...(at !== id ? { moved: { id: at, url: coPageUrl(at) } } : {}) };
    const miss = await whyNotUpdated(at, ownerUserId);
    if (miss.movedTo) {
      at = miss.movedTo;
      continue;
    }
    if (miss.liveVersion != null && expect != null && miss.liveVersion !== expect) {
      return { ok: false, problems: ["another change to it landed while this one was being written"], conflict: { id: at, version: miss.liveVersion } };
    }
    return null;
  }
  return null;
}
// Why an owner's update matched nothing: a reset moved it (resetCoPageLink sets moved_to on the old row), it's live at another
// version, or it's gone.
async function whyNotUpdated(id: string, ownerUserId: string): Promise<{ movedTo: string | null; liveVersion: number | null }> {
  const { rows } = await db.query(
    `SELECT version, moved_to, (taken_down_at IS NULL AND expires_at > NOW()) AS live FROM co_pages WHERE id = $1 AND owner_user_id = $2`,
    [id, ownerUserId],
  );
  const r = rows[0];
  if (!r) return { movedTo: null, liveVersion: null };
  return { movedTo: !r.live && r.moved_to && CO_PAGE_ID.test(String(r.moved_to)) ? String(r.moved_to) : null, liveVersion: r.live ? Number(r.version) : null };
}

// "Take that page down": the owner's own page only. The link answers 404 from now on and the content is wiped right away.
export async function takeDownCoPage(id: string, ownerUserId: string): Promise<boolean> {
  if (!CO_PAGE_ID.test(id) || !ownerUserId) return false;
  const { rowCount } = await db.query(
    `UPDATE co_pages SET taken_down_at = NOW(), data = '{}'::jsonb, updated_at = NOW(), preview = NULL, preview_version = NULL WHERE id = $1 AND owner_user_id = $2 AND taken_down_at IS NULL`,
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
  const { rowCount } = await db.query(`UPDATE co_pages SET taken_down_at = NOW(), data = '{}'::jsonb, preview = NULL, preview_version = NULL WHERE taken_down_at IS NULL AND expires_at <= NOW()`);
  return rowCount ?? 0;
}

// For the public route: a live page or null. Expired, taken down, malformed or unknown are all the same null (one plain 404).
export async function loadCoPage(id: string): Promise<StoredCoPage | null> {
  if (!CO_PAGE_ID.test(id)) return null;
  const { rows } = await db.query(
    `SELECT id, owner_user_id, data, version, updated_at, (preview IS NOT NULL AND preview_version = version) AS shot FROM co_pages WHERE id = $1 AND taken_down_at IS NULL AND expires_at > NOW()`,
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
  return { id: String(r.id), data: p.data, version: Number(r.version), updatedAt: new Date(r.updated_at), ownerUserId: String(r.owner_user_id), shot: r.shot === true };
}

// For the card route only: the link card picture of this live artifact's current version, or null (none stored, an older version's,
// taken down or expired). The bytes are read only here, never with the page.
export async function loadPreviewShot(id: string, version: number): Promise<Buffer | null> {
  if (!CO_PAGE_ID.test(id) || !Number.isInteger(version)) return null;
  const { rows } = await db.query(
    `SELECT preview FROM co_pages WHERE id = $1 AND version = $2 AND preview_version = $2 AND preview IS NOT NULL AND taken_down_at IS NULL AND expires_at > NOW()`,
    [id, version],
  );
  return rows[0]?.preview ? Buffer.from(rows[0].preview) : null;
}

// ---------------------------------------------------------------- keep and renewal (2026-10-11)

// "Keep this": no expiry from now on. "Renew": 90 more days from today. The owner's own live artifact only. Null when there's none.
export async function keepCoPage(id: string, ownerUserId: string, mode: "keep" | "renew"): Promise<{ kept: boolean; expiresAt: Date | null; moved?: { id: string; url: string } } | null> {
  if (!CO_PAGE_ID.test(id) || !ownerUserId) return null;
  // A reset that landed first moved it to a fresh link: the keep follows it there (concurrency audit, 2026-10-12).
  let at = id;
  for (let hop = 0; hop < 3; hop++) {
    const { rows } = await db.query(
      mode === "keep"
        ? `UPDATE co_pages SET kept = true, expires_at = 'infinity', expiry_warned_at = NULL WHERE id = $1 AND owner_user_id = $2 AND taken_down_at IS NULL AND expires_at > NOW() RETURNING kept, expires_at`
        : `UPDATE co_pages SET expires_at = CASE WHEN kept THEN expires_at ELSE NOW() + make_interval(days => $3) END, expiry_warned_at = NULL WHERE id = $1 AND owner_user_id = $2 AND taken_down_at IS NULL AND expires_at > NOW() RETURNING kept, expires_at`,
      mode === "keep" ? [at, ownerUserId] : [at, ownerUserId, PAGE_LIFETIME_DAYS],
    );
    if (rows[0]) {
      const when = new Date(rows[0].expires_at);
      return { kept: !!rows[0].kept, expiresAt: Number.isFinite(when.getTime()) ? when : null, ...(at !== id ? { moved: { id: at, url: coPageUrl(at) } } : {}) };
    }
    const miss = await whyNotUpdated(at, ownerUserId);
    if (!miss.movedTo) return null;
    at = miss.movedTo;
  }
  return null;
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
// FOR SHARE (concurrency audit, 2026-10-12): a reset already under way makes this wait and then find the page gone (null, said
// plainly); a share that locks first makes the reset wait, and the reset's second sweep below ends it.
export async function createShareLink(pageId: string, ownerUserId: string, theirWords: string): Promise<{ shareId: string; url: string } | null> {
  if (!CO_PAGE_ID.test(pageId) || !ownerUserId || !theirWords.trim()) return null;
  const shareId = newCoPageId();
  const url = coShareUrl(shareId);
  const { rowCount } = await db.query(
    `INSERT INTO co_page_shares (id, page_id, owner_user_id, their_words)
     SELECT $1, id, owner_user_id, $3 FROM co_pages WHERE id = $2 AND owner_user_id = $4 AND taken_down_at IS NULL AND expires_at > NOW() FOR SHARE`,
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
// its content is wiped, and every share link to it ends. Owner's own live artifact only. Null when there's none. Its link card picture
// moves with the content (the same version) and is wiped from the old row.
export async function resetCoPageLink(id: string, ownerUserId: string): Promise<{ id: string; url: string } | null> {
  if (!CO_PAGE_ID.test(id) || !ownerUserId) return null;
  const fresh = newCoPageId();
  const url = coPageUrl(fresh);
  // One statement, so it all happens or none of it does, and the old row is locked first (FOR UPDATE): two resets at once can't
  // both copy it. The second waits, then finds it already taken down, and makes nothing (Royce, 2026-10-11: "two near-simultaneous
  // resets must never leave two working own-links").
  const { rows } = await db.query(
    `WITH old AS (
       SELECT id, owner_user_id, data, version, created_at, updated_at, expires_at, kept, last_viewed_at, preview, preview_version FROM co_pages
       WHERE id = $2 AND owner_user_id = $3 AND taken_down_at IS NULL AND expires_at > NOW()
       FOR UPDATE
     ), down AS (
       UPDATE co_pages p SET taken_down_at = NOW(), data = '{}'::jsonb, updated_at = NOW(), moved_to = $1, preview = NULL, preview_version = NULL FROM old
       WHERE p.id = old.id AND p.taken_down_at IS NULL
       RETURNING old.owner_user_id, old.data, old.version, old.created_at, old.updated_at, old.expires_at, old.kept, old.last_viewed_at, old.preview, old.preview_version
     ), ins AS (
       INSERT INTO co_pages (id, owner_user_id, data, version, created_at, updated_at, expires_at, kept, last_viewed_at, preview, preview_version)
       SELECT $1, owner_user_id, data, version, created_at, updated_at, expires_at, kept, last_viewed_at, preview, preview_version FROM down
       RETURNING id
     ), rev AS (
       UPDATE co_page_shares SET revoked_at = NOW() WHERE page_id = $2 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM ins) RETURNING id
     )
     SELECT (SELECT id FROM ins) AS id`,
    [fresh, id, ownerUserId],
  );
  if (!rows[0]?.id) return null;
  // A share link made while this reset waited on the page's row was committed after this statement's snapshot, so the sweep above
  // can't see it: a second sweep, now, ends it too (concurrency audit, 2026-10-12).
  await db.query(`UPDATE co_page_shares SET revoked_at = NOW() WHERE page_id = $1 AND revoked_at IS NULL`, [id]).catch(() => {});
  return { id: fresh, url };
}
