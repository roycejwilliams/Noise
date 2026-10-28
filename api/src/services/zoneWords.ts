// How Cue says an event's time when the listing doesn't give its own time zone (Royce, 2026-10-28 ruling on #298):
//   - the time isn't approximate, only the zone is: never "around". The listed date and time are said as they are, in the zone of the
//     city it's in, with the short zone name (PT, ET, CT, MT; the zone's own abbreviation elsewhere), "5 PM" on the hour, "5:30 PM"
//     otherwise, and the assumption said once, naming the city (ZONE_ASSUMED);
//   - when Cue can't establish the zone (no city, a failed lookup, an online event), no time is turned into a confirmed one: the
//     listing's time zone is said to be unclear, pointing to the listing (ZONE_UNCLEAR). A start that carries its own offset is the
//     listing's own time, said as listed.
// COPY (Royce's exact lines): ZONE_ASSUMED and ZONE_UNCLEAR.
import { DateTime } from "luxon";

const US_SHORT: Record<string, string> = { PST: "PT", PDT: "PT", EST: "ET", EDT: "ET", CST: "CT", CDT: "CT", MST: "MT", MDT: "MT" };

// Pure: the short zone name for a moment in a zone ("PT", "ET", ... or the zone's own abbreviation).
export function shortZone(dt: DateTime): string {
  const n = dt.offsetNameShort ?? "";
  return US_SHORT[n] ?? n;
}
// Pure: "5 PM" on the hour, "5:30 PM" otherwise.
export const clockTime = (dt: DateTime): string => dt.toFormat(dt.minute === 0 ? "h a" : "h:mm a");

// Pure: a start in an assumed zone: "Wednesday, October 7 at 5 PM PT". A start with no offset is the listing's clock time in that zone.
export function assumedZoneTime(value: string, zone: string): string | null {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  const dt = hasOffset ? DateTime.fromISO(value, { setZone: true }).setZone(zone) : DateTime.fromISO(value, { zone });
  return dt.isValid ? `${dt.toFormat("cccc, LLLL d")} at ${clockTime(dt)} ${shortZone(dt)}` : null;
}

// Pure: whether a start carries its own non-UTC offset (the listing's own time, said as listed, with no zone assumed).
export const listedWithOffset = (value: string): boolean => {
  const m = value.trim().match(/([+-])(\d{2}):?(\d{2})$/);
  return !!m && !(m[2] === "00" && m[3] === "00");
};

export const ZONE_ASSUMED = (city: string) => `The listing doesn't specify a timezone, so I'm assuming local time in ${city}.`;
export const ZONE_UNCLEAR = (name: string) => `The listing for "${name}" doesn't say what time zone its start time is in. Check the page before you plan around it.`;
// What the model is told alongside an assumed-zone time in a fact (said once, never dropped).
export const ZONE_ASSUMED_MARK = "Say this assumption once when you give the time, in these words or close to them, and don't leave it out.";
