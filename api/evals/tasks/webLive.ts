// Live, dry: 5 real task asks through the task web search (services/taskWeb.ts).
// For each: what was kept and dropped, and an independent re-read of each kept
// page to confirm every fact Co would repeat is on it. Writes nothing, texts
// nobody; the web budget is skipped here only (co-test's database isn't
// reachable from a laptop). About $1.25.
//
//   railway run npx tsx evals/tasks/webLive.ts
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const W = await import("../../src/services/taskWeb.js");
const { readPageText } = await import("../../src/services/webOpportunitySearch.js");
const asks = [
  "an event venue in San Francisco for about 60 people on October 10",
  "local sponsors for a neighborhood block party in San Francisco",
  "a freelance product designer in San Francisco",
  "an investor pitch coach for a first-time founder",
  "San Francisco street closure permit rules for a block party",
];
const flat = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").replace(/\s+/g, " ")} `;
let facts = 0, onPage = 0, kept = 0, dropped = 0;
// ONLY=0,4,3 runs a subset (by index).
const only = process.env.ONLY ? process.env.ONLY.split(",").map(Number) : null;
for (const [i, ask] of asks.entries()) {
  if (only && !only.includes(i)) continue;
  const t0 = Date.now();
  const r = await W.taskWebSearch("00000000-0000-0000-0000-000000000000", ask, { city: "San Francisco", zone: "America/Los_Angeles", skipBudget: true, log: false });
  console.log(`\n=== ${ask}  (${Math.round((Date.now() - t0) / 1000)}s)`);
  for (const k of r.kept) {
    kept++;
    const page = flat((await readPageText(k.url)) ?? "");
    console.log(`  KEPT ${k.name} ${k.official ? "[official]" : "[found page]"} ${k.url}`);
    for (const f of [...k.facts, ...(k.date ? [`date: ${k.date}`] : []), ...(k.deadline ? [`deadline: ${k.deadline}`] : [])]) {
      facts++;
      const value = f.replace(/^[^:]+:\s*/, "");
      // Independent of the gate: every number and every capitalized word of the value is on the page.
      const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
      const tokens = isoDate ? [] : [...(value.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "").replace(/,/g, "")), ...(value.match(/\b[A-Z][a-z]+\b/g) ?? []).map((w) => w.toLowerCase())];
      const missing = tokens.filter((t) => !page.includes(t) && !page.replace(/,/g, "").includes(t));
      const ok = isoDate ? null : missing.length === 0;
      if (ok !== false) onPage++;
      console.log(`       ${ok === false ? "NOT ON PAGE" : ok === null ? "date (checked by the gate)" : "on page"}: ${f}${missing.length ? `  missing: ${missing.join(", ")}` : ""}`);
    }
  }
  for (const d of r.dropped) { dropped++; console.log(`  DROPPED ${d.name}: ${d.why}`); }
  for (const d of r.droppedDetails) console.log(`  dropped detail (${d.name}) ${d.detail}: ${d.why}`);
  if (!r.kept.length && !r.dropped.length) console.log(`  ${r.note}`);
}
console.log(`\nkept ${kept}, dropped ${dropped}; facts Co could repeat: ${facts}, confirmed on their page by re-reading: ${onPage}/${facts}`);
process.exit(0);
