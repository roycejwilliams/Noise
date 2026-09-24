// Read-only live check for event arrival: Luma gives venue coordinates, time
// zones and guest statuses the way services/eventPresence.ts expects, and
// Sendblue's location read works. Prints counts and shapes, never names,
// numbers or coordinates.
//
//   railway run --service co-test --environment dev -- npx tsx evals/presence/live.ts
import "dotenv/config";
import { listCalendarEvents, getEventGuestList } from "../../src/services/luma.js";
import { fetchSharedLocations, venueFor } from "../../src/services/eventPresence.js";

const events = await listCalendarEvents();
const upcoming = events.filter((e) => new Date(e.start_at).getTime() > Date.now() - 86_400_000);
console.log(`events: ${events.length} on the calendar, ${upcoming.length} today or later`);
let located = 0;
for (const e of events) if (await venueFor(e)) located++;
console.log(`  with a venue Co can locate (Luma coordinates or a street address): ${located}`);
console.log(`  with a time zone: ${events.filter((e) => e.timezone).length}`);
console.log(`  with a venue line: ${events.filter((e) => e.venue).length}`);
const next = upcoming.sort((a, b) => a.start_at.localeCompare(b.start_at))[0];
if (next) {
  const guests = await getEventGuestList(next.api_id);
  const statuses: Record<string, number> = {};
  for (const g of guests) statuses[g.approval_status] = (statuses[g.approval_status] ?? 0) + 1;
  console.log(`next event: coords ${next.latitude != null ? "yes" : "no"}, tz ${next.timezone ?? "none"}; guest statuses ${JSON.stringify(statuses)}`);
}
const { sharing, fixes } = await fetchSharedLocations();
console.log(`sendblue: ${sharing.size} sharing a location with Co's number, ${fixes.size} with a fresh fix`);
process.exit(0);
