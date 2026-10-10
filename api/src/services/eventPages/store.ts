// Where hosted event pages live (table event_pages, db/migrations.ts). Co owns the content: only data that passed
// parseEventPageData is ever written, and only Co's own flow writes (the makeEventPage tool, agent/eventPageTool.ts). The id is
// the only key to a page: 144 random bits, base64url, never listed anywhere, so anyone with the link can view and nobody can
// find one without it. A page leaves the working set by archived_at (archiveEventPage); an archived page answers 404.
import { randomBytes } from "crypto";
import pool from "../../db/db.js";
import { parseEventPageData, type EventPageData } from "./schema.js";

export type EventPageDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
let db: EventPageDb = pool;
// Tests swap in a stub; nothing else should.
export function useEventPageDb(d: EventPageDb | null): void {
  db = d ?? pool;
}

export type StoredEventPage = { id: string; data: EventPageData; version: number; ownerUserId: string | null; archivedAt: Date | null };

// 18 bytes = 144 bits, 24 base64url characters, no padding.
export const EVENT_PAGE_ID = /^[A-Za-z0-9_-]{24}$/;
export function newEventPageId(): string {
  return randomBytes(18).toString("base64url");
}

// The public base the codebase already uses for member links (invite links, services/invites.ts; partner readouts,
// services/partnerReadoutSend.ts): API_URL. Railway's own domain is the fallback, the way planFile.ts and voiceNote.ts do it.
export function eventPageBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.API_URL ?? "").replace(/\/+$/, "");
  if (/^https?:\/\//.test(base)) return base;
  return env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null;
}
export function eventPageUrl(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = eventPageBase(env);
  if (!base) throw new Error("API_URL isn't set, so there's no link to give");
  return `${base}/e/${id}`;
}

function clean(data: unknown): EventPageData {
  const p = parseEventPageData(data);
  if (!p.ok) throw new Error(`event page data refused: ${p.problems.join("; ")}`);
  return p.data;
}

export async function createEventPage(data: EventPageData, o: { ownerUserId?: string | null; coEventApiId?: string | null } = {}): Promise<{ id: string; url: string }> {
  const clean_ = clean(data);
  const id = newEventPageId();
  // The link is made before the row, so a missing base URL never leaves a page nobody can reach.
  const url = eventPageUrl(id);
  await db.query(`INSERT INTO event_pages (id, owner_user_id, co_event_api_id, data) VALUES ($1, $2, $3, $4)`, [id, o.ownerUserId ?? null, o.coEventApiId ?? null, JSON.stringify(clean_)]);
  return { id, url };
}

// Co only: a new version of the same page, same link. Null when there's no live page by that id.
export async function updateEventPage(id: string, data: EventPageData): Promise<{ version: number } | null> {
  if (!EVENT_PAGE_ID.test(id)) return null;
  const clean_ = clean(data);
  const { rows } = await db.query(`UPDATE event_pages SET data = $2, version = version + 1, updated_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING version`, [id, JSON.stringify(clean_)]);
  return rows[0] ? { version: Number(rows[0].version) } : null;
}

// How a page leaves the working set: the event is over or cancelled, or Co replaced it. The row stays; the link answers 404.
export async function archiveEventPage(id: string): Promise<boolean> {
  if (!EVENT_PAGE_ID.test(id)) return false;
  const { rowCount } = await db.query(`UPDATE event_pages SET archived_at = NOW(), updated_at = NOW() WHERE id = $1 AND archived_at IS NULL`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function loadEventPage(id: string): Promise<StoredEventPage | null> {
  if (!EVENT_PAGE_ID.test(id)) return null;
  const { rows } = await db.query(`SELECT id, owner_user_id, data, version, archived_at FROM event_pages WHERE id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  // What's stored is re-checked on the way out, so a row written before a rule tightened never renders unchecked.
  const p = parseEventPageData(typeof r.data === "string" ? JSON.parse(r.data) : r.data);
  if (!p.ok) {
    console.error(`event page ${id.slice(0, 4)}…: stored data no longer passes the schema: ${p.problems.slice(0, 3).join("; ")}`);
    return null;
  }
  return { id: r.id, data: p.data, version: Number(r.version), ownerUserId: r.owner_user_id ?? null, archivedAt: r.archived_at ? new Date(r.archived_at) : null };
}
