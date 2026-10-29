// Jev's shadow feeling read on a few real-shaped texts (services/jevShadow.ts). Paid (fractions of a cent); run deliberately.
import "../lib/requireMeter.js";
const { startJevShadow } = await import("../../src/services/jevShadow.js");
process.env.JEV_MEMBER = "on";
const cases: [string, string, boolean, string][] = [
  ["thanks!", "Anytime.", false, "complete"],
  ["hey", "Good luck tonight.", false, "complete"],
  ["haha you're not wrong, I'd absolutely show up just for the dumplings", "There's a dumpling stand at the night market.", false, "playful"],
  ["this week has been rough, feeling pretty burned out", "How's the week going?", false, "drained"],
  ["ugh my cofounder bailed on the pitch again, I just need to vent", "How did the pitch prep go?", false, "wants_heard"],
  ["should I take the Austin role or stay? I keep going back and forth", "How's the search going?", false, "wants_advice"],
  ["got the offer!! starting in January, can't wait", "Any news on the offer?", false, "hopeful"],
  ["This has nothing to do with Oct 10th.", "Where it actually matters is your Oct 10 block party.", false, "serious"],
];
for (const [msg, co, inline, want] of cases) {
  const r = await startJevShadow(msg, co, inline)!;
  const top = r.answers ? Object.entries(r.answers).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ") : "unavailable";
  const hit = r.answers ? (r.answers as any)[want] : null;
  console.log(`${hit !== null && hit >= 0.8 ? "ok  " : hit !== null && hit > 0.2 ? "weak" : "MISS"} ${JSON.stringify(msg)} want ${want} ${hit?.toFixed(2) ?? "-"} | top: ${top} | ${r.ms}ms`);
}
