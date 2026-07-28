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

export type OpeningPeriod = {
  open: { day: number; time: string };
  close?: { day: number; time: string };
};

// Coarse day-part a venue_type is expected to be open during — used because
// at this stage (venue selection) there's no single concrete time window yet
// to check hours against; that only exists downstream once the availability
// poll picks a real window from this venue's hours. "days" restricts to
// specific weekdays (0=Sun..6=Sat); omitted means any day is fine.
const VENUE_TYPE_DAYPART: Record<string, { days?: number[]; startMinutes: number; endMinutes: number }> = {
  dinner: { startMinutes: 17 * 60, endMinutes: 22 * 60 },
  coworking: { days: [1, 2, 3, 4, 5], startMinutes: 9 * 60, endMinutes: 17 * 60 },
  outdoor: { startMinutes: 9 * 60, endMinutes: 18 * 60 },
  social: { startMinutes: 18 * 60, endMinutes: 23 * 60 },
  experience: { startMinutes: 10 * 60, endMinutes: 21 * 60 },
};

function hhmmToMinutes(hhmm: string): number {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2, 4), 10);
}

// Hard-filter check — true if the venue has at least one weekly period
// overlapping the daypart its venue_type is normally used during. Venues
// with no opening_hours data at all (common for parks/public outdoor spots,
// or just a Places data gap) pass through here — absence of data is a flag
// for Co to weigh, in scoreVenuesWithCo, not a reason to drop the venue.
export function isOpenDuringVenueTypeDaypart(
  periods: OpeningPeriod[] | null | undefined,
  venueType: string,
): boolean {
  if (!periods || !periods.length) return true;
  const daypart = VENUE_TYPE_DAYPART[venueType] ?? VENUE_TYPE_DAYPART.dinner;

  return periods.some((p) => {
    if (daypart.days && !daypart.days.includes(p.open.day)) return false;
    if (!p.close) return true; // open 24 hours that day
    const openMin = hhmmToMinutes(p.open.time);
    let closeMin = hhmmToMinutes(p.close.time);
    if (p.close.day !== p.open.day || closeMin <= openMin) closeMin += 24 * 60; // crosses midnight
    return openMin < daypart.endMinutes && closeMin > daypart.startMinutes;
  });
}

// Fetched once per candidate, before scoring — textSearch results only carry
// open_now (a right-now boolean), not the weekly periods needed to judge
// whether a venue will be open during the daypart its venue_type implies.
async function fetchOpeningHoursPeriods(place_id: string): Promise<OpeningPeriod[] | null> {
  try {
    const details = await client.placeDetails({
      params: {
        place_id,
        fields: ["opening_hours"],
        key: process.env.GOOGLE_PLACES_API_KEY!,
      },
    });
    return (details.data.result?.opening_hours as any)?.periods ?? null;
  } catch {
    return null; // non-fatal — treated as unknown hours, not a rejection
  }
}

// Per-category venue standards for scoreVenuesWithCo — dinner's rules
// (quiet, seated, no counter-service) don't apply to a coworking space or a
// hike, so each venue_type gets its own checklist instead of one hardcoded
// restaurant-shaped prompt that silently steered every category that way.
const VENUE_TYPE_STANDARDS: Record<string, string> = {
  dinner: `✓ Independent/local over chains
✓ Conversation-friendly — not too loud
✓ Group seating for {group_size} people
✓ Unique and memorable over generic
✓ Bookable (has phone or website)
✗ No tourist traps
✗ No chains or franchises`,
  coworking: `✓ Independent/local over chains
✓ Work-friendly — reliable wifi, seating that supports a group working or chatting
✓ Group seating for {group_size} people
✓ Unique and memorable over generic
✓ Bookable (has phone or website)
✗ No tourist traps
✗ No loud bars or nightlife venues
✗ No chains or franchises`,
  outdoor: `✓ Real outdoor setting (park, trail, garden, waterfront, rooftop, etc.)
✓ Accessible and safe for a group of {group_size}
✓ Unique and memorable over generic
✓ Bookable or freely accessible (has phone, website, or is public)
✗ No indoor-only venues
✗ No tourist traps
✗ No chains or franchises`,
  social: `✓ Independent/local over chains
✓ Group-friendly — space to gather and talk for {group_size} people
✓ Unique and memorable over generic
✓ Bookable (has phone or website)
✗ No tourist traps
✗ No chains or franchises`,
  experience: `✓ An actual activity or class, not just a place to sit
✓ Group-friendly for {group_size} people
✓ Unique and memorable over generic
✓ Bookable (has phone or website)
✗ No tourist traps
✗ No chains or franchises`,
};

// Step 3 — Co scores venues against CoPatible standards
export async function scoreVenuesWithCo(
  venues: any[],
  venueType: string,
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
    .map((v, i) => {
      const hoursNote =
        v.opening_hours_periods === null || v.opening_hours_periods === undefined
          ? " — hours unknown, weigh accordingly"
          : "";
      return `${i + 1}. ${v.name} — ${v.formatted_address} — Rating: ${v.rating} (${v.user_ratings_total} reviews)${hoursNote}`;
    })
    .join("\n");

  const standards = (
    VENUE_TYPE_STANDARDS[venueType] ?? VENUE_TYPE_STANDARDS.dinner
  ).replace(/{group_size}/g, String(circleProfile.group_size));

  const { text: rawPick } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    prompt: `You are Co, selecting a "${venueType}" venue for a CoPatible circle experience.

CoPatible venue standards for "${venueType}":
${standards}

Walk-in preference: nobody books a table on the group's behalf — Co arranges the gathering, not a reservation. A walk-in party of ${circleProfile.group_size} at a busy dinner slot risks not being seated. So prefer walk-in-friendly venues — casual dining, counter service, coffee shops, hikes/walks, outdoor spots, drop-in activities — over a formal sit-down restaurant that would normally expect a reservation for a group this size. This is a soft preference, not a disqualifier: if the strongest options among these candidates are genuinely all reservation-style sit-down spots, still pick the best one rather than forcing a worse fit for the sake of this preference.

Circle context:
- Vibe: ${circleProfile.vibe}
- Life chapters: ${circleProfile.life_chapters.join(", ")}
- Connection style: ${circleProfile.connection_style}
- Group size: ${circleProfile.group_size}

Venues to evaluate:
${venueList}

Pick the single best venue number that fits CoPatible's standards for this circle. Also rate your own confidence in this pick as fit_score, a number from 0 to 1 — not the venue's Google rating, but how well THIS venue actually fits THIS circle's vibe, connection style, and standards. 1.0 means it's clearly right; something closer to 0.5-0.6 means it's the best of a mediocre set, not a strong fit.
Return ONLY valid JSON:
{
  "pick": 1,
  "reason": "one sentence why this fits",
  "fit_score": 0.85
}`,
  });

  try {
    const clean = rawPick.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const picked = venues[parsed.pick - 1];
    const fitScore = typeof parsed.fit_score === "number" ? Math.max(0, Math.min(1, parsed.fit_score)) : null;
    return { ...picked, co_reason: parsed.reason, co_fit_score: fitScore };
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
  excludeNames: string[] = [],
): Promise<any | null> {
  const raw = await searchVenues(venueType, neighborhood, city, circleProfile.group_size, geoCenter);
  const filtered = hardFilterVenues(raw, geoCenter).filter((v) => !excludeNames.includes(v.name));

  if (!filtered.length) return null;

  // Capped at 10 candidates (same cap scoreVenuesWithCo applies) before the
  // per-candidate Place Details call for hours — this pipeline already made
  // one such call per moment (for the winner's website); this adds up to ten,
  // only for opening_hours, only at venue-selection time.
  const candidates = filtered.slice(0, 10);
  const withHours = await Promise.all(
    candidates.map(async (v) => ({
      ...v,
      opening_hours_periods: v.place_id ? await fetchOpeningHoursPeriods(v.place_id) : null,
    })),
  );
  const dayPartFiltered = withHours.filter((v) =>
    isOpenDuringVenueTypeDaypart(v.opening_hours_periods, venueType),
  );

  if (!dayPartFiltered.length) return null;

  const winner = await scoreVenuesWithCo(dayPartFiltered, venueType, circleProfile);
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
      // non-fatal — venue_booking_url just stays null
    }
  }

  return { ...winner, venue_booking_url: website };
}

// Looked up again at booking-confirmation time (using the place_id saved at
// moment creation) rather than trying to carry it forward in memory across
// what can be a much later, separate request.
export async function getVenueContactInfo(
  place_id: string,
): Promise<{ phone: string | null; mapsUrl: string | null }> {
  try {
    const details = await client.placeDetails({
      params: {
        place_id,
        fields: ["formatted_phone_number", "url"],
        key: process.env.GOOGLE_PLACES_API_KEY!,
      },
    });
    return {
      phone: details.data.result?.formatted_phone_number ?? null,
      mapsUrl: details.data.result?.url ?? null,
    };
  } catch (err: any) {
    console.error("getVenueContactInfo failed (non-fatal):", err?.message ?? err);
    return { phone: null, mapsUrl: null };
  }
}
