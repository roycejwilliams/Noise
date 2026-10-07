// Scores a pilot run (evals/browserPilot/results/run-*.json, newest unless a path is given) against the hand-checked
// truth (truth.json). No model calls; it re-parses the saved raw answers with the shared parser so both readers are
// read the same way.   npm run eval:live -- evals/browserPilot/score.ts [results file]
import "../lib/requireMeter.js";
import { readFileSync, readdirSync } from "node:fs";
const S = await import("../../src/services/sdkBrowserReader.js");
const dir = new URL("./results/", import.meta.url).pathname;
const file = process.argv[2] ?? dir + readdirSync(dir).filter((f) => f.endsWith(".json")).sort().at(-1);
const run = JSON.parse(readFileSync(file, "utf8"));
const truth = JSON.parse(readFileSync(new URL("./truth.json", import.meta.url), "utf8"));
// Each field is right, unknown (no answer) or wrong (a confident answer that isn't so). A price range that contains the
// slot's real rate counts as right-but-a-range; one that doesn't is wrong.
type V = "right" | "range" | "unknown" | "wrong";
const priceV = (f: any, t: number | null): V => {
  if (f?.priceRange && t !== null) return t >= f.priceRange[0] - 1 && t <= f.priceRange[1] + 1 ? "range" : "wrong";
  if (f?.hourlyPrice === null || f?.hourlyPrice === undefined) return t === null ? "right" : "unknown";
  return t !== null && Math.abs(f.hourlyPrice - t) <= 1 ? "right" : "wrong";
};
const eqV = (a: any, b: any): V => (a === null || a === undefined ? "unknown" : a === b ? "right" : "wrong");
const availV = (a: any, b: any): V => (a === "unknown" || !a ? "unknown" : a === b ? "right" : "wrong");
const score = (f: any, t: any) => ({ price: priceV(f, t.hourlyPrice), min: eqV(f?.minimumHours, t.minimumHours), cap: eqV(f?.capacity, t.capacity), avail: availV(f?.available, t.available) });
const tot = { old: { right: 0, range: 0, unknown: 0, wrong: 0, usd: 0, ms: 0 }, sdk: { right: 0, range: 0, unknown: 0, wrong: 0, usd: 0, ms: 0 } };
console.log("(ok right, ~ range containing it, ? unknown, X wrong)\nlisting                     | old: price min cap avail | sdk: price min cap avail | old $ / s | sdk $ / s");
for (const c of run.cases) {
  const id = c.url.split("/").pop();
  const t = truth[id];
  const oldF = c.old.facts ?? S.parseFacts(c.old.raw ?? "");
  const o = score(oldF, t), s = score(c.sdk.facts, t);
  for (const [k, x] of [["old", o], ["sdk", s]] as const) for (const v of Object.values(x)) (tot as any)[k][v]++;
  tot.old.usd += c.old.usd; tot.sdk.usd += c.sdk.usd; tot.old.ms += c.old.ms; tot.sdk.ms += c.sdk.ms;
  const m = (v: V) => ({ right: "ok", range: "~ ", unknown: "? ", wrong: "X " })[v];
  console.log(`${t.name.padEnd(27).slice(0, 27)} | ${[o.price, o.min, o.cap, o.avail].map(m).join("  ")}      | ${[s.price, s.min, s.cap, s.avail].map(m).join("  ")}      | $${c.old.usd.toFixed(4)} / ${(c.old.ms / 1000).toFixed(1)} | $${c.sdk.usd.toFixed(4)} / ${(c.sdk.ms / 1000).toFixed(1)}`);
}
const k = run.cases.length;
const line = (n: string, x: any) => `${n}: ${x.right} right, ${x.range} range (contains the real rate), ${x.unknown} unknown, ${x.wrong} WRONG`;
console.log(`\nfields (of ${k * 4}) | ${line("old", tot.old)} | ${line("sdk", tot.sdk)}`);
console.log(`cost per task: old $${(tot.old.usd / k).toFixed(4)}, sdk $${(tot.sdk.usd / k).toFixed(4)} | time per task: old ${(tot.old.ms / k / 1000).toFixed(1)}s, sdk ${(tot.sdk.ms / k / 1000).toFixed(1)}s`);
