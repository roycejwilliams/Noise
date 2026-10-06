// Jev's shadow labels on today's real texts (services/jevShadow.ts). Fractions of a cent.
import "../lib/requireMeter.js";
const { startJevShadow } = await import("../../src/services/jevShadow.js");
process.env.JEV_MEMBER = "on";
const cases: [string, string, boolean, string][] = [
  ["thanks!", "Anytime.", false, "small_talk"],
  ["Are they around the same time?", "Good. A room full of people building 0 to 1.", false, "logistics"],
  ["This has nothing to do with Oct 10th.", "Where it actually matters is your Oct 10 block party.", false, "pushback"],
  ["I'm in", "Found the SF meetup you asked about: daytonaio's AI Builders Demo Night.", true, "reacting"],
  ["We should find time and date for any event we surface", "Makes sense, that's a real gap.", false, "feedback"],
  ["this week has been rough, feeling pretty burned out", "How's the week going?", false, "sharing"],
  ["any founder dinners this weekend?", "Good luck tonight.", false, "wants_search"],
];
for (const [msg, co, inline, want] of cases) {
  const r = await startJevShadow(msg, co, inline)!;
  const top = r.labels ? Object.entries(r.labels).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ") : "unavailable";
  const hit = r.labels ? (r.labels as any)[want] : null;
  console.log(`${hit !== null && hit >= 0.8 ? "ok  " : hit !== null && hit > 0.2 ? "weak" : "MISS"} ${JSON.stringify(msg)} want ${want} ${hit?.toFixed(2) ?? "-"} | top: ${top} | ${r.ms}ms`);
}
