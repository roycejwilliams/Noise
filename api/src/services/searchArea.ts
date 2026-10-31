// Where Cue searches for a member from now on, when they say so (Royce's 10-31 text: "Let's switch the search to San Francisco please
// going forward"; Cue answered "switching to SF from here on out" with nothing behind it). The place still lives on the want (wantPlace.ts,
// Royce 2026-10-15): this is only what stands in for their home city for a want with no place of its own (an ask or goal that names no
// place, and the morning and hourly searches of their goals together). Their home city never changes; an ask or goal that names a place
// keeps it.
//
// Kept on want_places under one reserved key (AREA_KEY), so it is resolved, stored, shown and corrected the way a want's place is:
//   - set only from their own words this message (wantPlace.ts backedPlace: the quote is copied from their message and names the place);
//   - resolved before it's kept (placeResolve.ts resolveWantPlace against their home: region and country checked, the answer stored on
//     the row with the point, never a bare name in a shared cache). Ambiguous: nothing changes and Cue asks which one; a name that
//     doesn't resolve, or a lookup that's down, changes nothing either, and Cue says so;
//   - their home city by name sets it back to home (the row's place is cleared);
//   - shown in what Cue knows (whatCoKnows.ts, ref place:area:search), corrected or removed there like any want's place.
import pool from "../db/db.js";
import { realResolveDeps, type ResolveDeps, type StoredResolution } from "./placeResolve.js";
import type { PlaceSource } from "./wantPlace.js";

export const AREA_KEY = "area:search";
// The row's want_text: what this row is, for anyone reading the table (never shown to the member).
const AREA_TEXT = "where they asked Cue to search from now on";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

// label: where on the map it's searched (placeResolve.ts), when that was resolved for the place it has now.
export type SearchArea = { place: string; source: PlaceSource; quote: string | null; label: string | null };

// Their search area, or null (no row, or removed: their home city stands in, as before this existed).
export async function searchAreaOf(userId: string, db: Db = pool): Promise<SearchArea | null> {
  const { rows } = await db.query(`SELECT place, source, quote, resolved_for, resolved_status, resolved_label FROM want_places WHERE user_id = $1 AND want_key = $2 AND place IS NOT NULL`, [userId, AREA_KEY]);
  const r = rows[0];
  if (!r?.place) return null;
  const label = r.resolved_status === "resolved" && r.resolved_for === r.place && r.resolved_label ? String(r.resolved_label) : null;
  return { place: String(r.place), source: String(r.source) as PlaceSource, quote: r.quote ?? null, label };
}

export type SetAreaDeps = {
  db: Db;
  home: (userId: string) => Promise<string | null>;
  resolve: ResolveDeps;
};
export type SetAreaResult =
  // set: kept, searched at label. home: their home city by name, so the area is cleared and home stands in again.
  | { ok: true; changed: "set"; place: string; label: string | null; home: string | null; quote: string }
  | { ok: true; changed: "home"; home: string }
  // ask: the place could mean more than one; nothing changed.
  | { ok: false; ask: string[]; place: string }
  | { ok: false; error: string };

// Set (or clear back to home) their search area from their own words this message. Writes only when the place is settled.
// recent: the exchange before their message, so an answer to Cue's "which Springfield?" ("the Missouri one") can settle it.
export async function setSearchArea(userId: string, input: { place: string; theirWords: string; message: string; recent?: string | null }, deps: SetAreaDeps): Promise<SetAreaResult> {
  const W = await import("./wantPlace.js");
  const R = await import("./placeResolve.js");
  const backed = W.backedPlace(input.place, input.theirWords, [input.message]) ?? answerToWhich(input);
  if (!backed) return { ok: false, error: "the place isn't in their own words in this message" };
  const home = await deps.home(userId).catch(() => null);
  // Their home city by name: back to home (the area cleared), never their home written as an area.
  if (home && W.samePlace(backed.place, home) && R.sameQualifiers(backed.place, home)) {
    await deps.db.query(
      `UPDATE want_places SET place = NULL, source = 'removed', quote = $3, updated_at = NOW(), resolved_for = NULL, resolved_home = NULL, resolved_status = NULL, resolved_label = NULL, resolved_lat = NULL, resolved_lng = NULL, resolved_options = NULL, resolved_home_country = NULL, resolved_at = NULL
        WHERE user_id = $1 AND want_key = $2`,
      [userId, AREA_KEY, backed.quote.slice(0, 300)],
    );
    return { ok: true, changed: "home", home };
  }
  // Resolved fresh against their home, the same way a want's place is; the answer is kept only when both lookups were in hand.
  let kept: StoredResolution | null = null;
  const r = await R.resolveWantPlace(
    { userId, key: AREA_KEY, place: backed.place, source: "their_words", homeCity: home },
    { ...deps.resolve, row: async () => null, store: async (_u, _k, s) => { kept = s; } },
  ).catch(() => null);
  const stored = kept as StoredResolution | null;
  if (r?.place?.verdict === "ambiguous") return { ok: false, ask: stored?.options?.length ? stored.options : String(r.place.label).split(" / ").filter(Boolean), place: backed.place };
  if (r?.place?.verdict === "rejected") return { ok: false, error: `no place called ${backed.place} came back near what they'd mean` };
  // No home on file: the place as they said it, unresolved (the search uses the word, as every want does for a member with no home).
  const unplaced = !home && r && !r.skip && !r.retry;
  if (!unplaced && (!r || r.retry || !r.city || !stored)) return { ok: false, error: `where ${backed.place} is couldn't be checked just now` };
  const s = stored;
  await deps.db.query(
    `INSERT INTO want_places (user_id, want_key, want_text, place, source, quote, noted_at, resolved_for, resolved_home, resolved_status, resolved_label, resolved_lat, resolved_lng, resolved_options, resolved_home_country, resolved_at)
       VALUES ($1, $2, $3, $4, 'their_words', $5, NOW(), $6, $7, $8, $9, $10, $11, $12::jsonb, $13, CASE WHEN $8::text IS NULL THEN NULL ELSE NOW() END)
     ON CONFLICT (user_id, want_key) DO UPDATE SET place = EXCLUDED.place, source = 'their_words', quote = EXCLUDED.quote, noted_at = NOW(), updated_at = NOW(),
       resolved_for = EXCLUDED.resolved_for, resolved_home = EXCLUDED.resolved_home, resolved_status = EXCLUDED.resolved_status, resolved_label = EXCLUDED.resolved_label,
       resolved_lat = EXCLUDED.resolved_lat, resolved_lng = EXCLUDED.resolved_lng, resolved_options = EXCLUDED.resolved_options, resolved_home_country = EXCLUDED.resolved_home_country, resolved_at = EXCLUDED.resolved_at`,
    [userId, AREA_KEY, AREA_TEXT, backed.place, backed.quote.slice(0, 300), s?.forPlace ?? null, s?.forHome ?? null, s?.status ?? null, s?.label ?? null, s?.lat ?? null, s?.lng ?? null, JSON.stringify(s?.options ?? []), s?.homeCountry ?? null],
  );
  return { ok: true, changed: "set", place: backed.place, label: s?.label ?? null, home, quote: backed.quote };
}

// Pure: a place settled by their answer to Cue's question ("Springfield, Missouri" from "the Missouri one" after "which Springfield?"):
// the quote is copied from their message and names part of the place, and every part of it is in their message or the exchange just
// before. Nothing they didn't say, or weren't just asked about, is ever kept.
export function answerToWhich(i: { place: string; theirWords: string; message: string; recent?: string | null }): { place: string; quote: string } | null {
  const sq = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
  const place = String(i.place ?? "").trim().replace(/[.;:!?]+$/, "");
  const quote = String(i.theirWords ?? "").trim();
  const parts = place.split(",").map((p) => p.trim()).filter(Boolean);
  if (!quote || parts.length < 2 || !sq(i.message).includes(sq(quote))) return null;
  const has = (text: string, part: string) => new RegExp(`(^|[^a-z0-9])${sq(part).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9])`).test(sq(text));
  if (!parts.some((p) => has(quote, p))) return null;
  return parts.every((p) => has(i.message, p) || has(i.recent ?? "", p)) ? { place, quote } : null;
}

// The turn's receipt for a change that went through (the reply check's DONE THIS TURN): what changed, what didn't.
export function areaReceipt(r: Extract<SetAreaResult, { ok: true }>): string {
  if (r.changed === "home") return `Set where Cue searches for them back to their home, ${r.home}, from now on: asks and goals that name no place of their own, and their daily search, look there again.`;
  return `Set where Cue searches for them from now on: ${r.label ?? r.place} (their words: "${r.quote.slice(0, 160)}"). Asks and goals that name no place of their own, and their daily search, look there from the next search on; asks and goals that name a place keep it.${r.home ? ` Their home city stays ${r.home}.` : ""}`;
}

// The turn's line while it's set (routes/sendblue.ts): where searches with no place of their own look, and that home didn't change.
export function areaFact(a: SearchArea, home: string | null): string {
  return `Where Cue searches for them when an ask or goal names no place of its own, as they asked${a.quote ? ` ("${a.quote.slice(0, 160)}")` : ""}: ${a.label ?? a.place}. Their daily search looks there too; asks and goals that name a place keep it.${home ? ` Their home city is still ${home}.` : ""}`;
}

export const realSetAreaDeps = (): SetAreaDeps => ({
  db: pool,
  home: async (userId) => {
    const { rows } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]);
    return rows[0]?.city ?? null;
  },
  resolve: realResolveDeps,
});
