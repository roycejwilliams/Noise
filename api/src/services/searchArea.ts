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

// tx: runs its writes in one transaction on one connection: the area and the drop of what was found for the old one both happen, or
// neither does (review of #336), so the tool's result is the truth either way.
export type SetAreaDeps = {
  db: Db;
  tx: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
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
const NOT_SAVED = "it couldn't be saved just now";

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
    const done = await deps.tx(async (db) => {
      await clearAreaIn(db, userId, { quote: backed.quote, because: "their search area set back to home" });
      return true;
    }).catch((err: any) => (console.error("setSearchArea: setting it back to home failed (nothing changed):", err?.message ?? err), false));
    return done ? { ok: true, changed: "home", home } : { ok: false, error: NOT_SAVED };
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
  const saved = await deps.tx(async (db) => {
    const before = await searchAreaOf(userId, db);
    await db.query(
      `INSERT INTO want_places (user_id, want_key, want_text, place, source, quote, noted_at, resolved_for, resolved_home, resolved_status, resolved_label, resolved_lat, resolved_lng, resolved_options, resolved_home_country, resolved_at)
         VALUES ($1, $2, $3, $4, 'their_words', $5, NOW(), $6, $7, $8, $9, $10, $11, $12::jsonb, $13, CASE WHEN $8::text IS NULL THEN NULL ELSE NOW() END)
       ON CONFLICT (user_id, want_key) DO UPDATE SET place = EXCLUDED.place, source = 'their_words', quote = EXCLUDED.quote, noted_at = NOW(), updated_at = NOW(),
         resolved_for = EXCLUDED.resolved_for, resolved_home = EXCLUDED.resolved_home, resolved_status = EXCLUDED.resolved_status, resolved_label = EXCLUDED.resolved_label,
         resolved_lat = EXCLUDED.resolved_lat, resolved_lng = EXCLUDED.resolved_lng, resolved_options = EXCLUDED.resolved_options, resolved_home_country = EXCLUDED.resolved_home_country, resolved_at = EXCLUDED.resolved_at`,
      [userId, AREA_KEY, AREA_TEXT, backed.place, backed.quote.slice(0, 300), s?.forPlace ?? null, s?.forHome ?? null, s?.status ?? null, s?.label ?? null, s?.lat ?? null, s?.lng ?? null, JSON.stringify(s?.options ?? []), s?.homeCountry ?? null],
    );
    // What was found where wants with no place looked before (home, or the old area) goes; the same area said again moves nothing.
    if (!before || before.place !== backed.place) await dropFallbackFinds(db, userId, "their search area changed");
    return true;
  }).catch((err: any) => (console.error("setSearchArea: saving it failed (nothing changed):", err?.message ?? err), false));
  if (!saved) return { ok: false, error: NOT_SAVED };
  return { ok: true, changed: "set", place: backed.place, label: s?.label ?? null, home, quote: backed.quote };
}

// Their area set back to home (the row's place cleared) inside the caller's transaction, and what was found for it dropped; with no
// area set, nothing moved and nothing goes. onlyPlace: only while the area is still that place (a rule they withdrew clears the area it
// set, never one set since: member preferences PR C). Returns whether the area changed.
export async function clearAreaIn(db: Db, userId: string, o: { quote?: string | null; because: string; onlyPlace?: string | null }): Promise<boolean> {
  const only = o.onlyPlace ? o.onlyPlace.trim().replace(/[.,;:!?]+$/, "") : null;
  const cleared = await db.query(
    `UPDATE want_places SET place = NULL, source = 'removed', quote = $3, updated_at = NOW(), resolved_for = NULL, resolved_home = NULL, resolved_status = NULL, resolved_label = NULL, resolved_lat = NULL, resolved_lng = NULL, resolved_options = NULL, resolved_home_country = NULL, resolved_at = NULL
      WHERE user_id = $1 AND want_key = $2 AND place IS NOT NULL AND ($4::text IS NULL OR lower(place) = lower($4::text))`,
    [userId, AREA_KEY, (o.quote ?? "").slice(0, 300), only],
  );
  if (cleared.rowCount) await dropFallbackFinds(db, userId, o.because);
  return !!cleared.rowCount;
}
// The same, in its own transaction (a rule withdrawn in conversation).
export async function clearSearchArea(userId: string, o: { because: string; onlyPlace?: string | null }, deps: Pick<SetAreaDeps, "tx">): Promise<boolean> {
  return deps.tx((db) => clearAreaIn(db, userId, { because: o.because, onlyPlace: o.onlyPlace ?? null }));
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

// Their area as corrected in what Cue knows (whatCoKnows.ts, after the change committed): resolved now against their home and stored
// on its row, so the next search uses it and the reply knows whether it's settled.
export async function settleArea(userId: string, place: string, deps: SetAreaDeps): Promise<{ ok: true; label: string | null } | { ok: false; ask?: string[]; why: string }> {
  const home = await deps.home(userId).catch(() => null);
  if (!home) return { ok: true, label: null };
  let kept: StoredResolution | null = null;
  const r = await (await import("./placeResolve.js")).resolveWantPlace(
    { userId, key: AREA_KEY, place, source: "corrected", homeCity: home },
    { ...deps.resolve, row: async () => null, store: async (u, k, s) => { kept = s; await deps.resolve.store(u, k, s); } },
  ).catch(() => null);
  const stored = kept as StoredResolution | null;
  if (r?.place?.verdict === "ambiguous") return { ok: false, ask: stored?.options ?? String(r.place.label).split(" / ").filter(Boolean), why: "it could be more than one place" };
  if (r?.place?.verdict === "rejected") return { ok: false, why: `no place called ${place} came back near what they'd mean` };
  if (!r || r.retry || !r.city || !stored) return { ok: false, why: `where ${place} is couldn't be checked just now` };
  return { ok: true, label: stored.label };
}

// ---------------------------------------------------------------- what was found for the old fallback
// When the area is set, cleared back to home, corrected or removed, what a want with no place of its own looks at has moved, so the
// finds found for the old one go (Royce, 2026-10-29: a corrected place "invalidates that ask's old cached location and its cached
// results"; review of #336): its pooled finds are dropped, and its pending offers are cancelled as "place corrected" (workingSet.ts
// isFailedAttempt: no decision, so the same event can queue again if it's found for the new place). A want's own place, and its finds,
// are never touched.
// Pure: a find searched where a want with no place looks (their home city, or their area), not at a want's own place.
// A goal searched where its plan names ("plan") looks there only while no area is set, so its finds move with the area too.
export const isFallbackFind = (it: any): boolean => ["home", "area", "plan"].includes(String(it?.match?.searchedIn?.source ?? ""));
export const withoutFallbackFinds = (items: unknown[]): unknown[] => items.filter((it) => !isFallbackFind(it));
export async function dropFallbackFinds(db: Db, userId: string, because: string): Promise<{ dropped: number; cancelled: { id: string; what: string }[] }> {
  let dropped = 0;
  const { rows } = await db.query(`SELECT ask_id, items FROM event_backlogs WHERE user_id = $1 FOR UPDATE`, [userId]);
  for (const b of rows) {
    const items = Array.isArray(b.items) ? b.items : [];
    const kept = withoutFallbackFinds(items);
    if (kept.length === items.length) continue;
    dropped += items.length - kept.length;
    await db.query(`UPDATE event_backlogs SET items = $3, updated_at = NOW() WHERE user_id = $1 AND ask_id = $2`, [userId, b.ask_id, JSON.stringify(kept)]);
  }
  const cancelled: { id: string; what: string }[] = [];
  const cands = (await db.query(`SELECT id, summary, payload::text AS payload FROM proactive_candidates WHERE user_id = $1 AND status = 'pending' AND type = 'event_offer'`, [userId])).rows;
  for (const c of cands) {
    let pl: any = null;
    try { pl = JSON.parse(String(c.payload)); } catch { pl = null; }
    if (!isFallbackFind(pl)) continue;
    const r = await db.query(`UPDATE proactive_candidates SET status = 'skipped', skip_reason = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending'`, [c.id, userId, `place corrected: ${because}`.slice(0, 300)]);
    if (r.rowCount) cancelled.push({ id: String(c.id), what: `event_offer: ${String(c.summary ?? "").slice(0, 120)}` });
  }
  return { dropped, cancelled };
}

// After the setSearchArea tool changed their area: their where-to-search rules follow it (services/memberPreferences.ts syncAreaRules),
// so a rule and the area never disagree. Rules are only linked or retired here; nothing is spent, shared or sent.
export async function syncAreaRulesAfter(userId: string, r: Extract<SetAreaResult, { ok: true }>): Promise<unknown> {
  return (await import("./memberPreferences.js")).syncAreaRules(userId, r.changed === "home" ? null : { place: r.place });
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

// What a where-to-search rule is held against (services/memberPreferences.ts ruleApplied): their area, and their home city (a rule naming
// home sets searches back to home, so it's applied while no area is set). Read only for a member with such a rule; a failed read
// throws, and the caller says the rule isn't applied.
export async function areaCtxOf(userId: string, db: Db = pool): Promise<{ area: { place: string } | null; home: string | null }> {
  const [a, h] = await Promise.all([searchAreaOf(userId, db), db.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId])]);
  return { area: a ? { place: a.place } : null, home: (h.rows[0]?.city as string | undefined) ?? null };
}

export const realSetAreaDeps = (): SetAreaDeps => ({
  db: pool,
  tx: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
  home: async (userId) => {
    const { rows } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]);
    return rows[0]?.city ?? null;
  },
  resolve: realResolveDeps,
});
