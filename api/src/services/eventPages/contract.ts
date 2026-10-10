// TEMPORARY STUB of the content layer's contract. The content layer (branch feat/event-pages) owns schema.ts, store.ts, the
// event_pages table and GET /e/:id. This file exists only so the interaction layer (branch feat/event-page-actions) typechecks
// on its own. When feat/event-pages lands, REPLACE this whole file with:
//
//   export type { EventPageData } from "./schema.js";
//   export { loadEventPage, updateEventPage } from "./store.js";
//   export type EventPageRecord = NonNullable<Awaited<ReturnType<typeof loadEventPage>>>;
//
// and drop the `pageOf` adapter below if loadEventPage already returns { id, data, version }.

// The page's content, written by Co only (schema.ts). Field names follow the shared contract.
export type EventPageData = {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  timezone: string;
  venueName?: string | null;
  address?: string | null;
  schedule?: unknown;
  whatToBring?: unknown;
  // Co's free-text notes. The interaction layer appends Co's answered questions here (applyInteractionUpdates).
  notes?: string | null;
  hostLine?: string | null;
  imageUrl?: string | null;
};

// One row of event_pages as the interaction layer reads it.
export type EventPageRecord = {
  id: string;
  data: EventPageData;
  version: number;
  archivedAt?: Date | string | null;
};

// Resolved at runtime, so this branch builds without the content layer's files. A missing store is a missing page.
const STORE = "./store.js";
async function store(): Promise<any | null> {
  return import(STORE).catch(() => null);
}

// Accepts either shape the content layer may return (camelCase or the raw row).
export function pageOf(row: any): EventPageRecord | null {
  if (!row) return null;
  const data = row.data ?? null;
  if (!data || typeof data !== "object") return null;
  return { id: String(row.id), data, version: Number(row.version ?? 0), archivedAt: row.archivedAt ?? row.archived_at ?? null };
}

export async function loadEventPage(id: string): Promise<EventPageRecord | null> {
  const s = await store();
  return s?.loadEventPage ? pageOf(await s.loadEventPage(id)) : null;
}

// Co only: bumps the version (store.ts). Never called from a member's request.
export async function updateEventPage(id: string, data: EventPageData): Promise<{ version: number }> {
  const s = await store();
  if (!s?.updateEventPage) throw new Error("event pages: the content layer's store isn't here");
  return s.updateEventPage(id, data);
}
