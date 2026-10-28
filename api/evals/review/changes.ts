// An update says what actually changed, compared in code (Royce, 2026-10-27, wording approved: "Updated the deck: slides 3 and 5
// changed (the timeline now ends in March)."). Layer 1, pure, zero tokens.
//   npx tsx evals/review/changes.ts
import { readFileSync } from "node:fs";
const D = await import("../../src/agent/deckTools.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };
const slide = (h: string, b: string[] = ["a"], image: string | null = null) => ({ headline: h, bullets: b, image });
const was = { slides: [slide("Why now"), slide("The room"), slide("Timeline", ["Jan", "Feb"]), slide("Team"), slide("Ask", ["$500K"])] };
const next = { slides: [slide("Why now"), slide("The room"), slide("Timeline", ["Jan", "Feb", "March"]), slide("Team"), slide("Ask", ["$750K"])] };
check("the slides whose content changed, by number", JSON.stringify(D.changedSlides(was, next)) === "[3,5]", D.changedSlides(was, next));
check("a new slide counts as changed", JSON.stringify(D.changedSlides(was, { slides: [...was.slides, slide("Close")] })) === "[6]");
check("a new picture counts as changed", JSON.stringify(D.changedSlides(was, { slides: was.slides.map((s, i) => (i === 1 ? { ...s, image: "img:2" } : s)) })) === "[2]");
check("nothing changed, nothing listed", D.changedSlides(was, was).length === 0 && D.slidesChangedLine([]) === null);
check("the line reads as approved", D.slidesChangedLine([3, 5]) === "slides 3 and 5 changed" && D.slidesChangedLine([3]) === "slide 3 changed" && D.slidesChangedLine([2, 3, 6]) === "slides 2, 3 and 6 changed");
const src = readFileSync(new URL("../../src/agent/deckTools.ts", import.meta.url), "utf8");
check("updateDeck says the code's list, with Cue's words in brackets, from the version the write was based on", /basis = was;\s*written = next;\s*r = await store\.updateCoPage/.test(src) && /`Updated the deck: \$\{slidesLine \? `\$\{slidesLine\} \(\$\{said\}\)` : said\}\./.test(src));
console.log(`changes: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
