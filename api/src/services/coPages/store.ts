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
import { pageProblems, type PageSource } from "./grounding.js";

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

export type StoredCoPage = { id: string; data: CoPageData; version: number; updatedAt: Date; ownerUserId: string };

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

// The schema, then the grounding: a page that fails either is never written.
export function checkPage(data: unknown, source: PageSource): { ok: true; data: CoPageData } | { ok: false; problems: string[] } {
  const p = parseCoPageData(data);
  if (!p.ok) return p;
  const problems = pageProblems(p.data, source);
  return problems.length ? { ok: false, problems } : p;
}

export async function createCoPage(data: unknown, o: { ownerUserId: string; source: PageSource }): Promise<{ ok: true; id: string; url: string } | { ok: false; problems: string[] }> {
  if (!o.ownerUserId) return { ok: false, problems: ["a page needs its owner"] };
  const c = checkPage(data, o.source);
  if (!c.ok) return c;
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
  const { rows } = await db.query(
    `UPDATE co_pages SET data = $3, version = version + 1, updated_at = NOW(), expires_at = NOW() + make_interval(days => $4)
     WHERE id = $1 AND owner_user_id = $2 AND taken_down_at IS NULL AND expires_at > NOW() RETURNING version`,
    [id, ownerUserId, JSON.stringify(c.data), PAGE_LIFETIME_DAYS],
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
export async function livePagesFor(ownerUserId: string): Promise<{ id: string; title: string; updatedAt: Date }[]> {
  const { rows } = await db.query(
    `SELECT id, data->>'title' AS title, updated_at FROM co_pages WHERE owner_user_id = $1 AND taken_down_at IS NULL AND expires_at > NOW() ORDER BY updated_at DESC LIMIT 20`,
    [ownerUserId],
  );
  return rows.map((r) => ({ id: String(r.id), title: String(r.title ?? ""), updatedAt: new Date(r.updated_at) }));
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
  const p = parseCoPageData(typeof r.data === "string" ? JSON.parse(r.data) : r.data);
  if (!p.ok) {
    console.error(`co page ${id.slice(0, 4)}…: stored data no longer passes the schema: ${p.problems.slice(0, 3).join("; ")}`);
    return null;
  }
  return { id: String(r.id), data: p.data, version: Number(r.version), updatedAt: new Date(r.updated_at), ownerUserId: String(r.owner_user_id) };
}
