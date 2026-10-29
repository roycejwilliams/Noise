import "dotenv/config";
import pool from "../db/db.js";
import * as R from "../services/placeResolve.js";
import { haversineMiles, type GeoPoint } from "../services/geocoding.js";
import type { PlaceSource } from "../services/wantPlace.js";

// One-time audit of places already on file (Royce, 2026-10-29), after "Bay Area" was found cached as Bay Area, Texas.
//
//   npx tsx src/scripts/auditPlaces.ts            dry run (the default): lists what disagrees, writes nothing
//   npx tsx src/scripts/auditPlaces.ts --apply    also clears inferred places' stored resolutions and deletes bad cache rows
//
// Listed: every want place whose resolution now is ambiguous, rejected, differs from what's stored, or (inferred) is far from home;
// every bare geocode_cache row that lands far from the home of a member who uses that name; every qualified row that's far from
// where it resolves now. Each says how it was set: confirmed (their words or their correction), inferred (Cue's read), or cached.
// A confirmed place is never written, with or without --apply. Geocoder lookups run for each row (Google, and the free open geocoder).
const apply = process.argv.includes("--apply");

async function main() {
  const { rows: wantRows } = await pool.query(
    `SELECT wp.user_id, wp.want_key, wp.place, wp.source, cp.city AS home, wp.resolved_for, wp.resolved_home, wp.resolved_status, wp.resolved_label, wp.resolved_lat, wp.resolved_lng, wp.resolved_options
       FROM want_places wp LEFT JOIN co_profiles cp ON cp.user_id = wp.user_id WHERE wp.place IS NOT NULL`,
  );
  const { rows: cacheRows } = await pool.query(`SELECT query, lat, lng FROM geocode_cache`);
  const homes = new Map<string, GeoPoint | null>();
  const homeOf = async (city: string | null) => {
    if (!city) return null;
    if (!homes.has(city)) homes.set(city, await R.realResolveDeps.home(city).catch(() => null));
    return homes.get(city)!;
  };
  const lookups = new Map<string, R.PlaceCandidate[]>();
  const candidatesFor = async (place: string) => {
    if (!lookups.has(place)) {
      const hits = await R.lookupPlace(place).catch(() => ({ google: [], openMeteo: [] }));
      lookups.set(place, R.mergeCandidates(hits.google, hits.openMeteo, place));
    }
    return lookups.get(place)!;
  };

  const wants = [];
  for (const r of wantRows) {
    const homePt = await homeOf(r.home);
    const fresh = homePt ? R.pickPlace(r.place, await candidatesFor(r.place), { point: homePt, country: R.inUS(homePt) ? "US" : null }) : null;
    const stored: R.StoredResolution | null = r.resolved_status ? { forPlace: r.resolved_for, forHome: r.resolved_home, status: r.resolved_status, label: r.resolved_label, lat: r.resolved_lat, lng: r.resolved_lng, options: r.resolved_options ?? [] } : null;
    const at = stored?.lat != null && stored?.lng != null ? { lat: Number(stored.lat), lng: Number(stored.lng) } : fresh?.status === "resolved" ? { lat: fresh.place.lat, lng: fresh.place.lng } : null;
    wants.push({ w: { userId: r.user_id, key: r.want_key, place: r.place, source: r.source as PlaceSource, homeCity: r.home, resolution: stored }, fresh, homeMiles: homePt && at ? Math.round(haversineMiles(homePt, at)) : null });
  }

  // Who uses each bare name: their want places and their home cities.
  const users = new Map<string, Set<string>>();
  const { rows: profileRows } = await pool.query(`SELECT user_id, city FROM co_profiles WHERE city IS NOT NULL`);
  const use = (name: string, home: string | null) => {
    if (!home) return;
    const k = name.trim().toLowerCase();
    users.set(k, (users.get(k) ?? new Set()).add(home));
  };
  for (const r of wantRows) use(r.place, r.home);
  for (const r of profileRows) use(r.city, r.city);
  const cache = [];
  for (const row of cacheRows) {
    const q = String(row.query);
    if (/^(venue|near):/.test(q)) continue;
    const pt = { lat: Number(row.lat), lng: Number(row.lng) };
    let worstHomeMiles: number | null = null;
    for (const home of users.get(q.toLowerCase()) ?? []) {
      const h = await homeOf(home);
      if (h) worstHomeMiles = Math.max(worstHomeMiles ?? 0, Math.round(haversineMiles(h, pt)));
    }
    let freshMiles: number | null = null;
    if (q.includes(",")) {
      const pick = R.pickPlace(q, await candidatesFor(q), null);
      if (pick.status === "resolved") freshMiles = Math.round(haversineMiles(pt, { lat: pick.place.lat, lng: pick.place.lng }));
    }
    cache.push({ row: { query: q, lat: pt.lat, lng: pt.lng }, worstHomeMiles, freshMiles });
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
