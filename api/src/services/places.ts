import { Client } from "@googlemaps/google-maps-services-js";
import "dotenv/config";

const client = new Client({});

const EARTH_RADIUS_MILES = 3958.8;
// Text Search's location/radius params are only a soft ranking bias — Google
// will still return far-flung results (e.g. a same-named venue in a totally
// different state), so distance is also enforced as a hard filter below.
const MAX_VENUE_DISTANCE_MILES = 30;

type GeoPoint = { lat: number; lng: number };

function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

// Step 2 — Apply hard filters
export function hardFilterVenues(venues: any[], geoCenter?: GeoPoint | null): any[] {
  return venues.filter((v) => {
    if (!v.rating || v.rating < 4.0) return false;
    if (!v.user_ratings_total || v.user_ratings_total < 50) return false;
    if (v.business_status && v.business_status !== "OPERATIONAL") return false;
    if (!v.formatted_address) return false;

    // Hard geographic bound — location/radius above is only a ranking bias,
    // not a restriction, so this is what actually rules out results like a
    // same-named venue hundreds of miles away in the wrong state.
    if (geoCenter && v.geometry?.location) {
      const distance = haversineMiles(geoCenter, {
        lat: v.geometry.location.lat,
        lng: v.geometry.location.lng,
      });
      if (distance > MAX_VENUE_DISTANCE_MILES) return false;
    }

    return true;
  });
}

