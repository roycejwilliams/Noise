import { Client } from "@googlemaps/google-maps-services-js";
import { hardFilterVenues } from "./places.js";

const client = new Client({});

export type RealVenueMatch = {
  name: string;
  address: string;
  mapsUrl: string;
  rating: number;
};

// Real, grounded venue search — triggered when someone mentions wanting a
// specific category of place (a gym, a cafe, a climbing spot), backed by a
// live Google Places search. Deliberately distinct from generateRecommendation,
// which never names a real venue because it has no data source to back one up
// — this one does, and only ever returns something with a real place_id
// behind it. Built after a real conversation showed Co inventing a
// plausible-sounding gym name from general knowledge with nothing behind
// it — this replaces that guess with an actual lookup.
export async function findRealVenue(venueType: string, city: string): Promise<RealVenueMatch | null> {
  const results = await findRealVenues(venueType, city, 1);
  return results[0] ?? null;
}

// Google's text search is fuzzy — confirmed a real climbing-gym search
// returned "Great Western Power Company" (an events venue, not a gym) as
// its 4th result, which cleared hardFilterVenues fine since that filter
// only checks rating/reviews/status/address, not category. Rather than
// require an exact type match (too strict — a real climbing gym is often
// typed just "gym" or "establishment", not "climbing_gym"), this only
// excludes results whose primary type is CLEARLY unrelated to an activity
// venue, unless the requested category is itself one of those types (a
// search for "bar" or "restaurant" shouldn't exclude bars/restaurants).
const CLEARLY_UNRELATED_TYPES = ["bar", "night_club", "restaurant", "lodging", "real_estate_agency", "car_dealer", "casino"];

function isObviouslyMismatched(venueType: string, types: string[] | undefined): boolean {
  if (!types?.length) return false;
  const requestedLower = venueType.toLowerCase();
  const primaryType = types[0];
  if (!CLEARLY_UNRELATED_TYPES.includes(primaryType)) return false;
  // Don't exclude a bar when someone actually asked for a bar, etc.
  return !CLEARLY_UNRELATED_TYPES.some((t) => requestedLower.includes(t.replace("_", " ")));
}

// Same search, up to `count` real results instead of just the top one —
// built after a real request for "2-5 climbing gyms" only ever got one
// (findRealVenue always took just results[0]). Each entry is independently
// verified to have a real place_id/name/address; never pads with anything
// invented if fewer than `count` real matches clear the filter.
export async function findRealVenues(venueType: string, city: string, count: number): Promise<RealVenueMatch[]> {
  try {
    const response = await client.textSearch({
      params: {
        query: `${venueType} in ${city}`,
        key: process.env.GOOGLE_PLACES_API_KEY!,
      },
    });
    const results = hardFilterVenues(response.data.results ?? []).filter(
      (v: any) => !isObviouslyMismatched(venueType, v.types),
    );
    return results
      .slice(0, Math.max(1, Math.min(count, 5)))
      .filter((v: any) => v.place_id && v.name && v.formatted_address)
      .map((v: any) => ({
        name: v.name,
        address: v.formatted_address,
        mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name)}&query_place_id=${v.place_id}`,
        rating: v.rating ?? 0,
      }));
  } catch (err: any) {
    console.error("venueLookup: findRealVenues failed (non-fatal):", err?.message ?? err);
    return [];
  }
}
