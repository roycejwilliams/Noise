// Where they are, as a fact with its source, date and expiry (Royce, 2026-11-11). Two rows on the existing want_places table, no new store:
//   - where:home: their home, from a move said in their own words ("moved to New York", "I live in Oakland", "I'm based in Denver"). The
//     home city itself stays co_profiles.city (profileExtraction.ts: a move only, LIVES_THERE), and their zone follows it (memberTime.ts
//     memberZone re-derives when the city changes); this row keeps the quote and the day it was said.
//   - where:trip: somewhere for now ("I'm in NYC", "in LA till Friday", "heading to NYC Thu-Sun", "visiting Boston"), with its window.
//     An unclear "I'm in X" is a trip (the cheaper mistake). A trip ends on its own: past window_end it's ignored and home stands again.
// A near-me search (wantPlace.ts currentUsable, eventSurfacingSweep.ts searchPlace) uses a live trip; a search with a place of its own
// never moves for one. The snapshot's place (personSnapshot.ts) has no source or date: it is never a search place (memberTime.ts reads it
// only as a hint for which state a city name is in).
import pool from "../db/db.js";
import { backedPlace, type CurrentPlace } from "./wantPlace.js";

export const HOME_KEY = "where:home";
export const TRIP_KEY = "where:trip";
// A trip with no end in their words lasts this long from its start.
export const TRIP_DEFAULT_DAYS = 3;
// A trip window longer than this isn't a trip (a stay that long is a move they haven't called one; it isn't guessed either way).
export const TRIP_MAX_DAYS = 21;

const day = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type Trip = { place: string; quote: string; from: string; until: string };
// Pure: the model's whereabouts held to their words: the quote copied from their message, the place in the quote, dates as given (an end
// before the start, or past TRIP_MAX_DAYS, is no trip); no end: TRIP_DEFAULT_DAYS from its start.
export function tripFrom(raw: unknown, message: string, today: string): Trip | null {
  const w = (raw ?? {}) as { place?: unknown; quote?: unknown; from?: unknown; until?: unknown };
  const got = backedPlace(w.place, w.quote, [message]);
  if (!got) return null;
  const from = typeof w.from === "string" && day(w.from) && w.from >= today ? w.from : today;
  const until = typeof w.until === "string" && day(w.until) ? w.until : plusDays(from, TRIP_DEFAULT_DAYS);
  if (until < from || Date.parse(until) - Date.parse(from) > TRIP_MAX_DAYS * 86_400_000) return null;
  return { place: got.place, quote: got.quote, from, until };
}

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
const upsert = (db: Db, userId: string, key: string, text: string, place: string, quote: string, start: string | null, end: string | null) =>
  db.query(
    `INSERT INTO want_places (user_id, want_key, want_text, place, source, quote, window_start, window_end, window_quote) VALUES ($1, $2, $3, $4, 'their_words', $5, $6, $7, $5)
     ON CONFLICT (user_id, want_key) DO UPDATE SET want_text = EXCLUDED.want_text, place = EXCLUDED.place, source = 'their_words', quote = EXCLUDED.quote,
       window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end, window_quote = EXCLUDED.window_quote, read_at = NOW(), updated_at = NOW(),
       resolved_for = NULL, resolved_status = NULL, resolved_label = NULL, resolved_lat = NULL, resolved_lng = NULL, resolved_options = NULL`,
    [userId, key, text, place, quote, start, end],
  );

export async function storeTrip(userId: string, raw: unknown, message: string, deps: { db?: Db; today?: (userId: string) => Promise<string> } = {}): Promise<Trip | null> {
  if (!raw) return null;
  const today = await (deps.today ?? (async (u: string) => {
    const { memberZone, localDay } = await import("./memberTime.js");
    return localDay(new Date(), await memberZone(u));
  }))(userId);
  const t = tripFrom(raw, message, today);
  if (!t) return null;
  await upsert(deps.db ?? pool, userId, TRIP_KEY, "where they are for now", t.place, t.quote, t.from, t.until);
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision({ layer: 4, decision: "where.trip", userId, outcome: "act", action: "stored", proposal: { from: t.from, until: t.until } }).catch(() => {});
  return t;
}

// A move: home's source and date (the city itself is co_profiles.city). A live trip to somewhere else ends: they live elsewhere now.
export async function storeHome(userId: string, place: string, quote: string, db: Db = pool): Promise<void> {
  await upsert(db, userId, HOME_KEY, "where they live", place, quote || place, null, null);
  await db.query(`DELETE FROM want_places WHERE user_id = $1 AND want_key = $2`, [userId, TRIP_KEY]).catch(() => {});
}

// A live trip as their current place: today inside its window. Dated by when they said it (read_at).
export async function liveTrip(userId: string, today: string, db: Db = pool): Promise<CurrentPlace | null> {
  const { rows } = await db.query(`SELECT place, quote, read_at, window_start, window_end FROM want_places WHERE user_id = $1 AND want_key = $2 AND place IS NOT NULL`, [userId, TRIP_KEY]);
  return tripRowCurrent(rows[0] ?? null, today);
}
// Pure: a trip row as a current place, only inside its window.
export function tripRowCurrent(r: { place: string | null; quote: string | null; read_at: Date | string; window_start: Date | string | null; window_end: Date | string | null } | null, today: string): CurrentPlace | null {
  if (!r?.place || !r.quote || !r.window_end) return null;
  const d = (x: Date | string | null) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
  const start = d(r.window_start) ?? "0000-01-01";
  const end = d(r.window_end)!;
  if (today < start || today > end) return null;
  return { place: r.place, quote: r.quote, at: new Date(r.read_at) };
}
