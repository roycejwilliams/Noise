import { anthropic } from "@ai-sdk/anthropic";
import { Client } from "@googlemaps/google-maps-services-js";
import { generateText } from "ai";
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

// Step 1 — Query Google Places for candidates
export async function searchVenues(
  venueType: string,
  neighborhood: string,
  city: string,
  groupSize: number,
  geoCenter?: GeoPoint | null,
): Promise<any[]> {
  const query = `${venueType} for ${groupSize} people in ${neighborhood} ${city}`;

  const response = await client.textSearch({
    params: {
      query,
      key: process.env.GOOGLE_PLACES_API_KEY!,
      // Biases results toward where the circle actually lives — "city" is a
      // free-text field (sometimes a loose region like "San Francisco Bay
      // Area") that Places can't reliably geocode on its own.
      ...(geoCenter
        ? {
            location: `${geoCenter.lat},${geoCenter.lng}`,
            radius: MAX_VENUE_DISTANCE_MILES * 1609.344,
          }
        : {}),
    },
  });

  return response.data.results ?? [];
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

// Step 3 — Co scores venues against CoPatible standards
export async function scoreVenuesWithCo(
  venues: any[],
  circleProfile: {
    vibe: string;
    life_chapters: string[];
    connection_style: string;
    group_size: number;
  },
): Promise<any | null> {
  if (!venues.length) return null;

  const venueList = venues
    .slice(0, 10)
    .map(
      (v, i) =>
        `${i + 1}. ${v.name} — ${v.formatted_address} — Rating: ${v.rating} (${v.user_ratings_total} reviews)`,
    )
    .join("\n");

  const { text: rawPick } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    prompt: `You are Co, selecting a venue for a CoPatible circle experience.

CoPatible venue standards:
✓ Independent/local over chains
✓ Conversation-friendly — not too loud
✓ Group seating for ${circleProfile.group_size} people
✓ Unique and memorable over generic
✓ Bookable (has phone or website)
✗ No tourist traps
✗ No fast casual or counter service only
✗ No chains or franchises

Circle context:
- Vibe: ${circleProfile.vibe}
- Life chapters: ${circleProfile.life_chapters.join(", ")}
- Connection style: ${circleProfile.connection_style}
- Group size: ${circleProfile.group_size}

Venues to evaluate:
${venueList}

Pick the single best venue number that fits CoPatible's standards for this circle.
Return ONLY valid JSON:
{
  "pick": 1,
  "reason": "one sentence why this fits"
}`,
  });

  try {
    const clean = rawPick.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const picked = venues[parsed.pick - 1];
    return { ...picked, co_reason: parsed.reason };
  } catch {
    return venues[0]; // fallback to highest rated
  }
}

// Main function — full pipeline
export async function findBestVenue(
  venueType: string,
  neighborhood: string,
  city: string,
  circleProfile: {
    vibe: string;
    life_chapters: string[];
    connection_style: string;
    group_size: number;
  },
  geoCenter?: GeoPoint | null,
): Promise<any | null> {
  const raw = await searchVenues(venueType, neighborhood, city, circleProfile.group_size, geoCenter);
  const filtered = hardFilterVenues(raw, geoCenter);

  if (!filtered.length) return null;

  const winner = await scoreVenuesWithCo(filtered, circleProfile);
  if (!winner) return null;

  // Fetch website from Place Details — textSearch doesn't include it
  let website: string | null = null;
  if (winner.place_id) {
    try {
      const details = await client.placeDetails({
        params: {
          place_id: winner.place_id,
          fields: ["website"],
          key: process.env.GOOGLE_PLACES_API_KEY!,
        },
      });
      website = details.data.result?.website ?? null;
    } catch {
      // non-fatal — fall through to Resy fallback
    }
  }

  const resyUrl = `https://resy.com/cities/sf?query=${encodeURIComponent(winner.name)}`;
  const opentableUrl = `https://www.opentable.com/s/?term=${encodeURIComponent(winner.name)}&metroId=4`;
  const venue_booking_url = website ?? resyUrl;

  return { ...winner, venue_booking_url, resyUrl, opentableUrl };
}
