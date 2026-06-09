import { anthropic } from "@ai-sdk/anthropic";
import { Client } from "@googlemaps/google-maps-services-js";
import { generateText } from "ai";
import "dotenv/config";

const client = new Client({});

// Step 1 — Query Google Places for candidates
export async function searchVenues(
  venueType: string,
  neighborhood: string,
  city: string,
  groupSize: number,
): Promise<any[]> {
  const query = `${venueType} in ${neighborhood} ${city}`;

  const response = await client.textSearch({
    params: {
      query,
      key: process.env.GOOGLE_PLACES_API_KEY!,
    },
  });

  return response.data.results ?? [];
}

// Step 2 — Apply hard filters
export function hardFilterVenues(venues: any[]): any[] {
  return venues.filter((v) => {
    if (!v.rating || v.rating < 4.0) return false;
    if (!v.user_ratings_total || v.user_ratings_total < 50) return false;
    if (v.business_status && v.business_status !== "OPERATIONAL") return false;
    if (!v.formatted_address) return false;
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
): Promise<any | null> {
  // Check partner venues first
  // (imported and queried in co.ts)

  // Fall back to Google Places
  const raw = await searchVenues(
    venueType,
    neighborhood,
    city,
    circleProfile.group_size,
  );
  const filtered = hardFilterVenues(raw);

  if (!filtered.length) return null;

  return await scoreVenuesWithCo(filtered, circleProfile);
}
