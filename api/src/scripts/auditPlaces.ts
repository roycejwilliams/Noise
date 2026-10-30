import "dotenv/config";
import pool from "../db/db.js";
import * as R from "../services/placeResolve.js";
import { haversineMiles, type GeoPoint } from "../services/geocoding.js";
import { regionFor, STATE_NAMES } from "../services/areaCodes.js";
import type { PlaceSource } from "../services/wantPlace.js";

// One-time audit of places already on file (Royce, 2026-10-29), after "Bay Area" was found cached as Bay Area, Texas.
//
//   npx tsx src/scripts/auditPlaces.ts            dry run (the default): lists what disagrees, writes nothing at all
//   npx tsx src/scripts/auditPlaces.ts --apply    also clears inferred places' stored resolutions and deletes bad cache rows
//
// Listed: every want place whose resolution now is ambiguous, rejected, differs from what's stored, or (inferred) is far from home;
// every cache row that disagrees with where its uses resolve now (a member's place by that name, a member's home city by that name in
// their home region, or for a qualified row its own resolution). Each says how it was set: confirmed (their words or their
// correction), inferred (Cue's read), or cached. A confirmed place is never written, with or without --apply.
// Reads only: the cache is read by its rows and places are looked up directly (placeResolve.ts lookupPlace: Google plus the local
// GeoNames table, writes nothing); the one write path is applyAudit, and only with --apply.
const apply = process.argv.includes("--apply");

async function main() {
  const { rows: wantRows } = await pool.query(
    `SELECT wp.user_id, wp.want_key, wp.place, wp.source, cp.city AS home, wp.resolved_for, wp.resolved_home, wp.resolved_status, wp.resolved_label, wp.resolved_lat, wp.resolved_lng, wp.resolved_options
       FROM want_places wp LEFT JOIN co_profiles cp ON cp.user_id = wp.user_id WHERE wp.place IS NOT NULL`,
  );
  const { rows: cacheRows } = await pool.query(`SELECT query, lat, lng FROM geocode_cache`);
  const cached = new Map<string, GeoPoint>(cacheRows.map((r: any) => [String(r.query), { lat: Number(r.lat), lng: Number(r.lng) }]));
  const lookups = new Map<string, R.PlaceCandidate[]>();
  const candidatesFor = async (place: string) => {
    if (!lookups.has(place)) {
      const hits = await R.lookupPlace(place).catch(() => ({ google: [], local: [] }));
      lookups.set(place, R.mergeCandidates(hits.google, hits.local, place));
    }
    return lookups.get(place)!;
  };
  // A home, read only: its cache row as the sweep reads it, else its most prominent hit; its country from the hits at that point.
  const homes = new Map<string, R.Home | null>();
  const homeOf = async (city: string | null) => {
    if (!city) return null;
    if (!homes.has(city)) {
      const c = await candidatesFor(city);
      const pick = R.pickPlace(city, c, null);
      const p = cached.get(city.trim()) ?? (pick.status === "resolved" ? { lat: pick.place.lat, lng: pick.place.lng } : null);
      homes.set(city, p ? { point: p, country: R.countryAt(p, c) } : null);
    }
    return homes.get(city)!;
  };

  const wants = [];
  // Where each bare name's uses resolve now (by lowercased name).
  const uses = new Map<string, { at: GeoPoint; with: "want" | "home" }[]>();
  const use = (name: string, at: GeoPoint, w: "want" | "home") => {
    const k = name.trim().toLowerCase();
    uses.set(k, [...(uses.get(k) ?? []), { at, with: w }]);
  };
  for (const r of wantRows) {
    const home = await homeOf(r.home);
    const fresh = home ? R.pickPlace(r.place, await candidatesFor(r.place), home) : null;
    const stored: R.StoredResolution | null = r.resolved_status ? { forPlace: r.resolved_for, forHome: r.resolved_home, status: r.resolved_status, label: r.resolved_label, lat: r.resolved_lat, lng: r.resolved_lng, options: r.resolved_options ?? [] } : null;
    const at = stored?.lat != null && stored?.lng != null ? { lat: Number(stored.lat), lng: Number(stored.lng) } : fresh?.status === "resolved" ? { lat: fresh.place.lat, lng: fresh.place.lng } : null;
    if (fresh?.status === "resolved") use(r.place, { lat: fresh.place.lat, lng: fresh.place.lng }, "want");
    wants.push({ w: { userId: r.user_id, key: r.want_key, place: r.place, source: r.source as PlaceSource, homeCity: r.home, resolution: stored }, fresh, homeMiles: home && at ? Math.round(haversineMiles(home.point, at)) : null });
  }
  // A home city's row, against that city in the member's home region (their phone's state, or the state their city names).
  const { rows: profileRows } = await pool.query(`SELECT cp.city, u.phone_number FROM co_profiles cp JOIN users u ON u.id = cp.user_id WHERE cp.city IS NOT NULL AND u.archived_at IS NULL`);
  for (const r of profileRows) {
    const st = regionFor({ city: r.city, phone: r.phone_number });
    if (!st || String(r.city).includes(",")) continue;
    const pick = R.pickPlace(`${r.city}, ${STATE_NAMES[st] ?? st}`, await candidatesFor(`${r.city}, ${st}`), null);
    if (pick.status === "resolved") use(r.city, { lat: pick.place.lat, lng: pick.place.lng }, "home");
  }

  const cache = [];
  for (const row of cacheRows) {
    const q = String(row.query);
    if (/^(venue|near):/.test(q)) continue;
    const pt = { lat: Number(row.lat), lng: Number(row.lng) };
    let conflictMiles: number | null = null;
    let conflictWith: "want" | "home" | "itself" | null = null;
    if (q.includes(",")) {
      const pick = R.pickPlace(q, await candidatesFor(q), null);
      if (pick.status === "resolved") (conflictMiles = Math.round(haversineMiles(pt, { lat: pick.place.lat, lng: pick.place.lng }))), (conflictWith = "itself");
    } else {
      for (const u of uses.get(q.toLowerCase()) ?? []) {
        const m = Math.round(haversineMiles(pt, u.at));
        if (conflictMiles == null || m > conflictMiles) (conflictMiles = m), (conflictWith = u.with);
      }
    }
    cache.push({ row: { query: q, lat: pt.lat, lng: pt.lng }, conflictMiles, conflictWith });
  }

  const findings = R.auditPlan(wants, cache);
  for (const f of findings) console.log(`${f.kind}\t${f.how}\t${f.ref}\t${f.finding}\t${f.action}`);
  const counts = { confirmed: findings.filter((f) => f.how === "confirmed").length, inferred: findings.filter((f) => f.how === "inferred").length, cached: findings.filter((f) => f.how === "cached").length };
  console.log(`\n${findings.length} finding(s): ${counts.confirmed} confirmed (reported only), ${counts.inferred} inferred, ${counts.cached} cache rows`);
  const writes = await R.applyAudit(findings, pool, apply);
  console.log(apply ? `applied ${writes.length} write(s)` : `dry run: nothing written (--apply would make ${writes.length} write(s))`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
