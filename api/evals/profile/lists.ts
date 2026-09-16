// Model-free checks for profile list hygiene and emotion rendering
// (2026-09-15 call review: 126 goals, complaints about Co stored as
// blockers, "low clarifying" shown in the call prompt).
//   npx tsx evals/profile/lists.ts
import { cityChangeAllowed } from "../../src/services/profileExtraction.js";
import "dotenv/config";
import { isAboutCo, mergeProfileList } from "../../src/services/profileExtraction.js";
import { renderEmotionalContext, summarizeSignals } from "../../src/harness/emotion.js";

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) {
    failed++;
    console.log(`FAIL ${label} ${detail}`);
  }
};

const WORDS = ["hiking", "pottery", "chess", "surfing", "investors", "design", "hiring", "fundraising", "climbing", "cooking", "music", "writing", "running", "reading", "travel", "sales", "marketing", "legal", "tennis", "yoga"];
const many = WORDS.map((w, i) => `${w} ${WORDS[(i + 7) % WORDS.length]}`);
check("cap", mergeProfileList(many, [], 12).length === 12);
const merged = mergeProfileList(["meet other cleantech founders", "grow cleantech startup"], ["meet Series A investors and operators", "scale the team past 8"], 12);
check("newest first", merged[0] === "meet Series A investors and operators", JSON.stringify(merged));
check("rewording collapsed", mergeProfileList(["meet other founders in SF"], ["meet other founders"], 12).length === 1);
check("distinct kept", mergeProfileList(["find a designer"], ["meet Series A investors"], 12).length === 2);
check("Co complaint", isAboutCo("lack of information from Co"));
check("Co's", isAboutCo("Co's links were broken"));
check("co-founder isn't Co", !isAboutCo("finding a technical co-founder"));
check("unrelated", !isAboutCo("raising a Series A"));

const now = new Date("2026-09-15T20:00:00Z");
const low = summarizeSignals([{ source: "text", emotion: "clarifying", intensity: "low", valence: "mixed", about: null, quote: null, at: new Date(now.getTime() - 3600_000) }], now);
check("low read hidden", renderEmotionalContext(low, now) === "", renderEmotionalContext(low, now));
const med = summarizeSignals([{ source: "text", emotion: "frustrated", intensity: "medium", valence: "negative", about: "investor passes", quote: null, at: new Date(now.getTime() - 3600_000) }], now);
check("medium read shown", renderEmotionalContext(med, now).includes("frustrated"));
const lowCall = summarizeSignals([{ source: "call", emotion: "awkwardness", intensity: "low", valence: "negative", about: null, quote: "not really", at: new Date(now.getTime() - 7200_000) }], now);
check("low call moment hidden", !renderEmotionalContext(lowCall, now).includes("awkwardness"));


// Where someone lives only changes when they say so (Royce, 2026-09-16:
// "founding engineer roles in NYC" moved his city off San Francisco).
const cityCases: [boolean, string][] = [
  [!cityChangeAllowed("San Francisco", "NYC", "Cool, I'm also looking for founding engineer roles too in the mean time"), "a role preference doesn't move them"],
  [!cityChangeAllowed("San Francisco", "NYC", "any accelerators in NYC worth applying to?"), "an accelerator preference doesn't move them"],
  [!cityChangeAllowed("San Francisco", "Miami", "are there good events in Miami this weekend?"), "an events question doesn't move them"],
  [cityChangeAllowed("San Francisco", "NYC", "I'm in NYC now, moved last week"), "saying they're there moves them"],
  [cityChangeAllowed("San Francisco", "Austin", "we're moving to Austin next month"), "moving moves them"],
  [cityChangeAllowed("San Francisco", "Oakland", "based in Oakland these days"), "based in moves them"],
  [cityChangeAllowed(null, "San Francisco", "any events this weekend?"), "first city on file is kept"],
  [cityChangeAllowed("San Francisco", "san francisco", "whatever"), "same city is fine"],
  [!cityChangeAllowed("San Francisco", null, "I'm in NYC"), "no new city means no change"],
];
for (const [ok, label] of cityCases) {
  if (!ok) {
    failed++;
    console.log(`FAIL city: ${label}`);
  }
}

console.log(`profile lists, emotion render, city changes: ${20 - failed}/20 passed`);
if (failed) process.exitCode = 1;
