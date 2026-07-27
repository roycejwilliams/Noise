import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { OpeningPeriod } from "./places.js";

export type CandidateWindow = { label: string; start: string; end: string };

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatOpeningHours(periods: OpeningPeriod[] | null | undefined): string {
  if (!periods || !periods.length) {
    return "Hours unknown — use general judgment for the venue type.";
  }
  return periods
    .map((p) => {
      const openStr = `${p.open.time.slice(0, 2)}:${p.open.time.slice(2)}`;
      if (!p.close) return `${DAY_NAMES[p.open.day]}: open 24 hours`;
      const closeStr = `${p.close.time.slice(0, 2)}:${p.close.time.slice(2)}`;
      return `${DAY_NAMES[p.open.day]}: ${openStr}–${closeStr}`;
    })
    .join("\n");
}

// Turns the venue's real weekly hours (structured) and each member's stated
// schedule preference (freeform text from onboarding, e.g. "weekday
// evenings") into one shared shortlist of concrete windows the whole circle
// votes on. Both inputs are fuzzy in different ways — hours are structured
// but per-weekday, preferences are unstructured — so this is a judgment call
// rather than an algorithmic intersection, same pattern as the rest of this
// pipeline (momentData, scoreVenuesWithCo) turning mixed structured/freeform
// inputs into a structured pick.
export async function generateCandidateWindows(
  openingHoursPeriods: OpeningPeriod[] | null | undefined,
  memberAvailabilityPatterns: (string | null | undefined)[],
  venueType: string,
): Promise<CandidateWindow[]> {
  const today = new Date();
  const preferences = memberAvailabilityPatterns.filter((p): p is string => Boolean(p));

  try {
    const { text: raw } = await generateText({
      model: anthropic("claude-sonnet-4-6"),
      prompt: `You are Co, scheduling a "${venueType}" circle moment.

Today's date is ${today.toDateString()}.

The venue's real weekly opening hours:
${formatOpeningHours(openingHoursPeriods)}

The circle's stated schedule preferences (freeform, from onboarding calls — may be empty or conflicting):
${preferences.length ? preferences.map((p) => `- ${p}`).join("\n") : "- No strong preferences stated"}

Propose exactly 3 candidate time windows for this moment. Each window must be:
- A specific real date between 3 and 10 days from today
- 2 hours long
- Fully inside the venue's actual open hours above (if hours are unknown, use sensible judgment for a "${venueType}" moment)
- Reasonably aligned with the circle's stated preferences where there are any

Return ONLY valid JSON, no preamble or markdown:
[
  { "label": "Thu 7/24 7:00 PM", "start": "2026-07-24T19:00:00", "end": "2026-07-24T21:00:00" },
  { "label": "...", "start": "...", "end": "..." },
  { "label": "...", "start": "...", "end": "..." }
]`,
    });

    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (w): w is CandidateWindow =>
          typeof w?.label === "string" && typeof w?.start === "string" && typeof w?.end === "string",
      )
      .slice(0, 3);
  } catch (err) {
    console.error("generateCandidateWindows failed (non-fatal, falls back to single suggested_time poll):", err);
    return [];
  }
}
