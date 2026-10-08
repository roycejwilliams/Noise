// Backfill co_profiles.timezone from the city on file (services/memberTime.ts). Dry run by default: it reads only (the geocode
// cache and the offline zone lookup, inside a READ ONLY transaction) and prints counts, never cities, names or numbers.
//
//   tsx src/scripts/backfillMemberZones.ts            dry run: what it would set
//   tsx src/scripts/backfillMemberZones.ts --apply    store the zones (memberZone per member: geocodes a city not yet cached)
//
// Not required for correctness: every read through memberZone fills a missing zone too. Members with no city keep none and are
// measured in the fallback zone (Pacific).
import { find as findTimezone } from "geo-tz";
import pool from "../db/db.js";
import { FALLBACK_ZONE, memberZone, zoneFromProfile } from "../services/memberTime.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const client = await pool.connect();
  const out = { db: "", members: 0, noCity: 0, alreadySet: 0, wouldSet: 0, wouldRefresh: 0, notCached: 0, zones: {} as Record<string, number> };
  try {
    await client.query("BEGIN READ ONLY");
    out.db = (await client.query(`SELECT current_database() AS d`)).rows[0].d;
    // Before the migration has run, the columns read as empty.
    const has = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'co_profiles' AND column_name = 'timezone_city'`)).rows.length > 0;
    const { rows } = await client.query(
      `SELECT cp.user_id, cp.city, ${has ? "cp.timezone, cp.timezone_city" : "NULL::text AS timezone, NULL::text AS timezone_city"} FROM co_profiles cp JOIN users u ON u.id = cp.user_id WHERE u.archived_at IS NULL`,
    );
    // Read-only lookup: the geocode cache's own zone, or its lat/lng through the offline zone table. A city never geocoded is counted.
    const lookup = async (city: string): Promise<string | null> => {
      const c = await client.query(`SELECT lat, lng, timezone FROM geocode_cache WHERE query = $1`, [city.trim()]);
      if (!c.rows[0]) { out.notCached++; return null; }
      return c.rows[0].timezone ?? findTimezone(Number(c.rows[0].lat), Number(c.rows[0].lng))[0] ?? null;
    };
    for (const r of rows) {
      out.members++;
      if (!String(r.city ?? "").trim()) out.noCity++;
      const z = await zoneFromProfile(r, lookup);
      if (z.store) (r.timezone ? out.wouldRefresh++ : out.wouldSet++);
      else if (r.timezone) out.alreadySet++;
      const k = z.zone ?? `(none: fallback ${FALLBACK_ZONE})`;
      out.zones[k] = (out.zones[k] ?? 0) + 1;
    }
    await client.query("ROLLBACK");
    if (apply) for (const r of rows) await memberZone(r.user_id);
  } finally {
    client.release();
  }
  console.log(JSON.stringify({ mode: apply ? "applied" : "dry run", ...out }, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error("backfillMemberZones failed:", err?.message ?? err);
  process.exit(1);
});
