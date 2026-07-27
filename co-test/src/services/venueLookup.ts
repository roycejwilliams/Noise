import { Client } from "@googlemaps/google-maps-services-js";
import { hardFilterVenues } from "../../../api/src/services/places.js";

const client = new Client({});

export type RealVenueMatch = {
  name: string;
  address: string;
  mapsUrl: string;
  rating: number;
};

// Real, grounded venue search — triggered when someone mentions wanting a
// specific category of place (a gym, a cafe, a climbing spot), backed by a
// live Google Places search, the same API production's Circles venue
// selection uses. Deliberately distinct from generateRecommendation, which
// never names a real venue because it has no data source to back one up —
// this one does, and only ever returns something with a real place_id
// behind it. Built after a real conversation showed Co inventing a
// plausible-sounding gym name from general knowledge with nothing behind
// it — this replaces that guess with an actual lookup.
export async function findRealVenue(venueType: string, city: string): Promise<RealVenueMatch | null> {
  try {
    const response = await client.textSearch({
      params: {
        query: `${venueType} in ${city}`,
        key: process.env.GOOGLE_PLACES_API_KEY!,
      },
    });
    const results = hardFilterVenues(response.data.results ?? []);
    const top = results[0];
    if (!top || !top.place_id || !top.name || !top.formatted_address) return null;

    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}&query_place_id=${top.place_id}`;
    return { name: top.name, address: top.formatted_address, mapsUrl, rating: top.rating ?? 0 };
  } catch (err: any) {
    console.error("venueLookup: findRealVenue failed (non-fatal):", err?.message ?? err);
    return null;
  }
}
