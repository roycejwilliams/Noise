// Model-free checks for the date guard (services/dateGuard.ts, 2026-09-26):
// past things can't be offered, future ones can't be followed up on, and
// earlier search results are marked as earlier. No model, no DB.
//
//   npx tsx evals/dates/rules.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const D = await import("../../src/services/dateGuard.js");
const { ledgerLine } = await import("../../src/services/coFacts.js");
const { searchNoteLine } = await import("../../src/harness/replyGrounding.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const today = "2026-09-27";
const r = (m: any, asked?: any) => D.readDates(D.itemDays(m), today, asked);

// Every date source
check("an event date", r({ event_date: "2026-09-26" }).status === "past");
check("an event page's start, in Pacific time (late UTC is still that evening here)", D.itemDays({ details: { startAt: "2026-09-27T02:00:00Z" } }).start === "2026-09-26");
check("a post's stated dates, spanning", r({ statedDates: { start: "2026-10-05", end: "2026-10-11" } }).end === "2026-10-11");
check("a deadline", r({ deadline: "2026-10-01" }).status === "upcoming");
check("nothing known is undated, and neither rule applies", r({}).status === "undated" && D.offerable(r({})).ok && D.followable(r({})).ok);

// The three states
check("yesterday is over", r({ event_date: "2026-09-26" }).status === "past");
check("today is today", r({ event_date: "2026-09-27" }).status === "today");
check("a multi-day thing that started yesterday is still today", r({ statedDates: { start: "2026-09-26", end: "2026-09-28" } }).status === "today");
check("next week is coming up", r({ event_date: "2026-10-07" }).status === "upcoming");

// The rules
check("past can't be offered", !D.offerable(r({ event_date: "2026-09-26" })).ok);
check("today can be offered", D.offerable(r({ event_date: "2026-09-27" })).ok);
const weekend = { start: "2026-09-26", end: "2026-09-27" };
check("outside the dates asked can't be offered", !D.offerable(r({ statedDates: { start: "2026-10-05", end: "2026-10-11" } }, weekend)).ok);
check("inside them can", D.offerable(r({ event_date: "2026-09-27" }, weekend)).ok);
check("the future can't be followed up on", !D.followable(r({ event_date: "2026-10-07" })).ok);
check("today can't either (it isn't over)", !D.followable(r({ event_date: "2026-09-27" })).ok);
check("the past can", D.followable(r({ event_date: "2026-09-26" })).ok);

// What Co reads
check("over, with the day", D.dateNote(r({ event_date: "2026-09-26" })) === " (already over: it was Saturday, September 26)");
check("coming up, said plainly", D.dateNote(r({ event_date: "2026-10-07" })) === " (coming up: Wednesday, October 7, so it hasn't happened yet)");
check("outside the asked dates, said plainly", /outside the dates they asked about\)$/.test(D.dateNote(r({ statedDates: { start: "2026-10-05", end: "2026-10-11" } }, weekend))));
check("no date, no note", D.dateNote(r({})) === "");
check("a recorded send carries its status", ledgerLine({ relation: "sent", label: "Mahjong After Dark", url: "https://lu.ma/m", at: new Date("2026-09-24T23:00:00Z"), when: "2026-09-26" }, today) === 'On 2026-09-24 Co sent them "Mahjong After Dark" (https://lu.ma/m) (already over: it was Saturday, September 26).');
check("an earlier search says it's earlier", /^On Thursday, September 24, Co searched .* That was an earlier search: a new ask needs a new one\.$/.test(searchNoteLine("[search] Co searched for \"weekend\" and sent 1 thing: \"Mahjong After Dark\".", new Date("2026-09-24T20:00:00Z"), today)));
check("today's search doesn't", /^Earlier today, /.test(searchNoteLine("[search] Co searched.", new Date(), D.localToday())) && !/earlier search/.test(searchNoteLine("[search] Co searched.", new Date(), D.localToday())));

// Wiring
check("event facts carry the status", /const note = dateNote\(readDates\(itemDays\(match\), localToday\(\), asked\)\);/.test(src("harness/replyGrounding.ts")));
check("an unprompted offer is checked when it's about to go out", /const when = offerable\(readDates\(itemDays\(p\.match\), localToday\(\)\)\);\s*if \(!when\.ok\) return skip/.test(src("harness/proactiveRegistry.ts")));
check("sent finds record their own dates", /when: d\.start, whenEnd: d\.end/.test(src("services/recommendation.ts")));
check("the claim check holds offers and follow-ups to the status", /an offer is supported only if a FACT shows it's still ahead/.test(src("harness/replyGrounding.ts")) && /- followup: asking how something went/.test(src("harness/replyGrounding.ts")));

console.log(`date rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
