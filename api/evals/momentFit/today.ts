// The send-time read knows today's date (quality run 2026-11-09: with no date it sent a brunch two days after it happened).
// Layer 1: pure prompt checks, no model, no network.
//   npx tsx evals/momentFit/today.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const MF = await import("../../src/harness/momentFit.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); } };

const now = new Date("2026-11-09T19:00:00Z"); // Mon Nov 9, 11:00am Pacific
const base = { firstName: "Ellis", message: "A founder brunch on Saturday (Nov 7).", recent: "", call: null, queuedAt: now, now, queued: [] as string[] };
check("today in Pacific by default", MF.todayLine(now) === "Today is Monday, November 9, 2026, 11:00am their time.", MF.todayLine(now));
check("today in their own zone", MF.todayLine(now, "Asia/Tokyo") === "Today is Tuesday, November 10, 2026, 4:00am their time.", MF.todayLine(now, "Asia/Tokyo"));
check("an unknown zone falls back to Pacific, never throws", MF.todayLine(now, "Not/AZone") === MF.todayLine(now));
const p = MF.momentPrompt({ ...base, zone: "America/Los_Angeles" });
check("the prompt carries today's date", p.includes("Today is Monday, November 9, 2026"));
check("the weigh line asks whether anything it names is already past", /already past, and if so drop it/.test(p));
check("momentFit hands the member's zone to the prompt", /kind: o\.kind, zone: o\.zone \}/.test(src("harness/momentFit.ts")));
check("dispatch passes the member's zone to the read", /queued, zone: zoneNow \}\)/.test(src("harness/proactive.ts")));

console.log(`momentFit/today: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
