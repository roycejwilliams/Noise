import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../../../api/src/db/db.js";
import { findBestVenue } from "../../../api/src/services/places.js";
import { generateCandidateWindows, type CandidateWindow } from "../../../api/src/services/scheduling.js";

// Ported from api/src/routes/co.ts (production) per CIRCLES_SCOPING.md item
// 1 — selectVenueForCircle, getCircleBookingContext, createMomentForCircle,
// verbatim except for imports/relative paths. Everything these depend on
// (pool, places.ts, scheduling.ts) is either DB-schema-compatible with
// co-test's init.sql or has no DB dependency at all, so no behavioral fork
// was needed here (unlike matching.ts — see that file's header).
//
// KNOWN BLOCKER, not fixed here per this task's scope: co-test's `moments`
// table (init.sql) is missing venue_type, vibe, neighborhood, and
// candidate_windows columns that createMomentForCircle's INSERT writes.
// This file will build/typecheck fine but createMomentForCircle will fail
// at runtime with a real Postgres error the first time it's actually
// invoked, until a co-test-only migration adds those columns (matches
// CIRCLES_SCOPING.md item 5's general "new DB migrations file" note, now
// concretely: exactly these four columns on `moments`).
//
// Not ported: notifyMemberOfMoment (the Sendblue send + circle-invite
// wiring around this) — that's Moderator/webhook logic, explicitly separate
// scope (CIRCLES_SCOPING.md item 2), not touched by this task.

// Venue selection — partner venues first, then Google Places. Pulled out of
// createMomentForCircle so the Keana venue-approval reject path (sendblue.ts)
// can re-run it after a rejection, excluding whatever's already been turned
// down for this moment instead of just re-rolling the exact same pick.
export async function selectVenueForCircle(
  city: string,
  venueType: string,
  neighborhood: string,
  groupSize: number,
  circleProfile: {
    vibe: string;
    life_chapters: string[];
    connection_style: string;
    group_size: number;
  },
  excludeNames: string[] = [],
): Promise<any | null> {
  const partnerVenue = await pool.query(
    `SELECT * FROM co_venues
     WHERE city = $1
     AND type = $2
     AND active = TRUE
     AND (capacity_max IS NULL OR capacity_max >= $3)
     AND NOT (name = ANY($4::text[]))
     ORDER BY RANDOM()
     LIMIT 1`,
    [city, venueType, groupSize, excludeNames],
  );

  if (partnerVenue.rows[0]) {
    const contact: string = partnerVenue.rows[0].contact ?? "";
    const partnerBookingUrl = contact.startsWith("http") ? contact : null;

    return {
      name: partnerVenue.rows[0].name,
      formatted_address: partnerVenue.rows[0].neighborhood,
      co_reason: "CoPatible partner venue",
      booking_method: partnerVenue.rows[0].booking_method,
      contact: partnerVenue.rows[0].contact,
      payment_tier: partnerVenue.rows[0].payment_tier,
      venue_booking_url: partnerBookingUrl,
    };
  }

  // Fall back to Google Places + Co scoring — city string only, no
  // GPS-based geo bias/filter (see note above findBestVenue call site).
  return findBestVenue(venueType, neighborhood, city, circleProfile, undefined, excludeNames);
}

// Steps 1-6 of createMomentForCircle's setup — pulled out so the Keana
// venue-rejection path (sendblue.ts) can rebuild the same circle context
// (city, group size, dominant style, shared chapters) without duplicating
// this aggregation when it needs to re-run venue selection.
export async function getCircleBookingContext(circle_id: string) {
  // Fetch only members who've actually accepted their circle invite. Anyone
  // still 'pending' hasn't opted in yet and was never notified of this
  // moment — including them here would inflate the consensus denominator
  // with people who don't even know the moment exists.
  const membersResult = await pool.query(
    `SELECT cm.member_id, cp.activity_preferences, cp.connection_style, cp.life_chapters, cp.city, cp.availability_pattern
     FROM circle_members cm
     JOIN co_profiles cp ON cp.user_id = cm.member_id
     WHERE cm.circle_id = $1 AND cm.status = 'accepted'`,
    [circle_id],
  );

  const members = membersResult.rows;
  if (!members.length) return null;

  const circleResult = await pool.query(
    `SELECT owner_id FROM circles WHERE id = $1`,
    [circle_id],
  );
  const circle = circleResult.rows[0];
  if (!circle) return null;

  // Find most common activity preferences across the group
  //combines the array of all members activity preferences
  const allActivities = members.flatMap((m) => m.activity_preferences);
  //acc holds the record pair
  const activityCount = allActivities.reduce(
    (acc: Record<string, number>, activity: string) => {
      acc[activity] = (acc[activity] || 0) + 1;
      return acc;
    },
    // starts with a empty object
    {},
  );

  ///Converts the object into an array of [key, value] pairs:
  const topActivities = Object.entries(activityCount)
    //If b is bigger than a → positive → b goes first → highest numbers first
    //If a is bigger than b → negative → a goes first
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .slice(0, 3)
    //Because the word activity is placed before the comma, JavaScript automatically assigns whatever is at index 0 to that variable.
    .map(([activity]) => activity);

  // Get dominant connection style
  const connectionStyles = members.map((m) => m.connection_style);
  //After checking all items, the array is rearranged so the most frequent styles are first:
  const dominantStyle =
    connectionStyles.sort(
      (a: string, b: string) =>
        connectionStyles.filter((s: string) => s === b).length -
        connectionStyles.filter((s: string) => s === a).length,
    )[0] || "small_group";

  // Get shared life chapters
  const allChapters = members.flatMap((m) => m.life_chapters);
  const uniqueChapters = [...new Set(allChapters)];

  const city = members[0].city ?? "San Francisco";
  const groupSize = members.length;

  return { members, circle, topActivities, dominantStyle, uniqueChapters, city, groupSize };
}

// Creates a Moment for a circle without texting anyone — used both by the
// admin-triggered route in production (which notifies everyone immediately
// after) and by the circle-accept flow in sendblue.ts (which only reveals
// the moment to members as they individually accept their circle invite).
// Neither caller is ported yet (Moderator/webhook wiring, separate scope) —
// this function is complete and callable on its own once invoked.
export async function createMomentForCircle(circle_id: string) {
  const context = await getCircleBookingContext(circle_id);
  if (!context) return null;
  const { members, circle, topActivities, dominantStyle, uniqueChapters, city, groupSize } = context;

  // City (the text string, not GPS coordinates) is the sole geographic
  // authority for venue search — a member's coordinates are never used
  // to bias or hard-filter this. Confirmed for real: a single stale
  // coordinate (leftover test data pointing at NYC for an SF user) sent
  // an entire circle's venue search across the country, and the "hard"
  // distance filter didn't catch it because it enforced proximity to
  // that same bad point, not the circle's actual city.

  const { text: rawMoment } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    prompt: `You are Co, a life concierge creating a curated real-world experience for a small circle of people.

Circle details:
- Group size: ${groupSize} people
- City: ${city}
- Shared activities they enjoy: ${topActivities.join(", ")}
- Life chapters they are navigating: ${uniqueChapters.join(", ")}
- Connection style: ${dominantStyle}

Create a specific, curated Moment for this group. Return ONLY valid JSON with no preamble:

{
  "moments_name": "short evocative name for the experience",
  "description": "1-2 sentences MAX. Keep under 300 characters.",
  "venue_type": "one of: dinner | coworking | outdoor | social | experience",
  "neighborhood": "specific ${city} neighborhood that fits the vibe",
  "vibe": "3-4 words describing the atmosphere",
  "suggested_time": "day and time suggestion (e.g. Thursday 7pm)",
  "vibes": ["vibe1", "vibe2", "vibe3"]
}

Make it feel intimate, specific, and intentional. Not generic.`,
  });

  // Step 7 — Parse Anthropic response
  let momentData: any = {};
  try {
    const clean = rawMoment.replace(/```json|```/g, "").trim();
    momentData = JSON.parse(clean);
  } catch {
    console.error("Failed to parse moment data:", rawMoment);
    return null;
  }

  // Truncate description as safety measure
  momentData.description = momentData.description?.slice(0, 390) ?? "";

  // Step 7.5 — Find best venue (partner venues first, then Google Places)
  const selectedVenue = await selectVenueForCircle(
    city,
    momentData.venue_type,
    momentData.neighborhood,
    groupSize,
    {
      vibe: momentData.vibe,
      life_chapters: uniqueChapters,
      connection_style: dominantStyle,
      group_size: groupSize,
    },
  );

  // Step 8 — Create the Moment
  const momentStart = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Simultaneous availability poll's candidate windows — computed here
  // (once, shared by every member) from the venue's real opening hours
  // plus the circle's stated schedule preferences, so it's grounded
  // instead of the single free-text suggested_time guess above. Only
  // worth the extra LLM call for groups large enough to actually get a
  // poll (see the groupSize >= 4 gate downstream in notifyMemberOfMoment).
  // Falls back to an empty array (and the old single-time poll) if this
  // fails or the venue's hours were never resolved.
  const candidateWindows: CandidateWindow[] =
    groupSize >= 4
      ? await generateCandidateWindows(
          selectedVenue?.opening_hours_periods,
          members.map((m: any) => m.availability_pattern),
          momentData.venue_type,
        )
      : [];

  const momentResult = await pool.query(
    `INSERT INTO moments
     (creator_id, moments_name, location, location_name, moment_start, visibility_type, description, circle_id, vibes, venue, suggested_time, status, venue_booking_url, venue_place_id, venue_type, vibe, neighborhood, candidate_windows)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [
      circle.owner_id,
      momentData.moments_name,
      "(0,0)",
      selectedVenue?.formatted_address ??
        `${momentData.neighborhood} — ${momentData.venue_type}`,
      momentStart,
      "circle",
      momentData.description,
      circle_id,
      momentData.vibes ?? [],
      selectedVenue?.name ?? null,
      momentData.suggested_time ?? null,
      "polling",
      selectedVenue?.venue_booking_url ?? null,
      selectedVenue?.place_id ?? null,
      momentData.venue_type ?? null,
      momentData.vibe ?? null,
      momentData.neighborhood ?? null,
      candidateWindows.length ? JSON.stringify(candidateWindows) : null,
    ],
  );

  const moment = momentResult.rows[0];

  // Pre-warm OG image before any iMessage links go out — avoids preview
  // timeout. Points at production's real app.copatible.com — harmless for
  // a co-test moment (the ID won't exist there, so this just 404s), kept
  // for fidelity with the real pipeline; non-blocking, errors swallowed.
  fetch(`https://app.copatible.com/api/og/moments/${moment.id}`).catch(() => {});

  // Step 8.5 — Seed moment_responses for each circle member, including the
  // owner (now a normal circle_members row too) — null = awaiting reply.
  const responseUserIds = members.map((m: any) => m.member_id);
  for (const userId of responseUserIds) {
    await pool.query(
      `INSERT INTO moment_responses (moment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [moment.id, userId],
    );
  }

  return { moment, selectedVenue, momentData, members, circle };
}
