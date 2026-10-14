// The pre-arrival text and opt-in location (services/preArrival.ts). Model-free.
//   npx tsx evals/presence/preArrival.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const P = await import("../../src/services/preArrival.js");
const F = await import("../../src/services/followUps.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const start = "2026-10-10T02:00:00.000Z"; // 7pm in San Francisco

// Who and when
check("only registered members who haven't said they can't make it", P.preArrivalEligible({ registered: true, notGoing: false, alreadySent: false, eventListed: true }).ok && !P.preArrivalEligible({ registered: false, notGoing: false, alreadySent: false, eventListed: true }).ok && !P.preArrivalEligible({ registered: true, notGoing: true, alreadySent: false, eventListed: true }).ok);
check("once per event", !P.preArrivalEligible({ registered: true, notGoing: false, alreadySent: true, eventListed: true }).ok && /targetKey: `pre_arrival:\$\{event\.api_id\}`/.test(src("services/eventPresence.ts")));
check("nothing for an event no longer on the calendar", !P.preArrivalEligible({ registered: true, notGoing: false, alreadySent: false, eventListed: false }).ok);
const w = P.preArrivalWindow(start);
check("the window is 3 hours to 1 hour before the start", w.from.toISOString() === "2026-10-09T23:00:00.000Z" && w.until.toISOString() === "2026-10-10T01:00:00.000Z");
check("Cue's 'later' can't pass the end of the window, and at the end it goes", F.boundedLater(new Date("2026-10-09T23:30:00Z"), 5, w.until.toISOString()).lastCall && F.boundedLater(new Date("2026-10-09T23:30:00Z"), 5, w.until.toISOString()).at.toISOString() === w.until.toISOString() && F.atWindowEnd(new Date("2026-10-10T00:55:00Z"), w.until.toISOString()) && !F.atWindowEnd(new Date("2026-10-10T00:00:00Z"), w.until.toISOString()));
check("its timing is Cue's, and it goes through the daily pick (hours, caps)", F.handedToCo({ type: "pre_arrival", targetKey: "pre_arrival:x" } as any) && /pre_arrival: \{ priority: 95 \}/.test(src("harness/proactive.ts")) && /"in_room", "pre_arrival"[,\]]/.test(src("harness/proactive.ts")));
check("it never goes out after the event starts", /expiresAt: new Date\(new Date\(event\.start_at\)\.getTime\(\) - 30 \* 60_000\)/.test(src("services/eventPresence.ts")));

// What it says
check("no other guest is named", P.namesAnyone("Maya from the design crowd will be there.", ["Maya", "Jo"]) === "Maya" && P.namesAnyone("A few people coming fit what you're after.", ["Maya", "Jo"]) === null && /return skip\(`named another guest/.test(src("harness/proactiveRegistry.ts")));
check("who fits is a count, and only when two or more fit", /fits >= P\.PRE_ARRIVAL\.minCrowd/.test(src("harness/proactiveRegistry.ts")) && P.PRE_ARRIVAL.minCrowd === 2 && /never describe or name anyone/.test(src("harness/proactiveRegistry.ts")));
check("without a known ask it asks what they want from the event, and that counts as the ask", /what_they_want_from_this_event: "unknown: ask them/.test(src("harness/proactiveRegistry.ts")) && /INSERT INTO event_ask_solicitations/.test(src("harness/proactiveRegistry.ts")));
check("the location offer is fixed wording added in code, once", /P\.LOCATION_OFFER\] : \[\]/.test(src("harness/proactiveRegistry.ts")) && /!row\?\.location_yes_at/.test(src("harness/proactiveRegistry.ts")));

// Location
const yes = { event_api_id: "e1", location_yes_at: new Date(), location_stopped_at: null };
check("location is never read without their yes", !P.mayReadLocation(null, "e1", true) && !P.mayReadLocation({ ...yes, location_yes_at: null }, "e1", true));
check("location is never read outside the event's window", !P.mayReadLocation(yes, "e1", false) && P.mayReadLocation(yes, "e1", true));
check("the yes doesn't carry over to another event", !P.mayReadLocation(yes, "e2", true));
check("stop ends it", !P.mayReadLocation({ ...yes, location_stopped_at: new Date() }, "e1", true) && P.isStopSharing("stop sharing my location") && P.isStopSharing("please stop tracking me") && !P.isStopSharing("don't stop the music"));
check("the yes has to be theirs, and a no isn't a yes", P.yesToSharing("yes sharing now", "yes sharing now, see you there") && !P.yesToSharing("yes", "no thanks") && !P.yesToSharing("no, don't track me", "no, don't track me"));
check("the poll only uses a location with that event's yes", /if \(!mayReadLocation\(row \? \{ event_api_id: event\.api_id, location_yes_at: row\.location_yes_at, location_stopped_at: row\.location_stopped_at \} : null, event\.api_id, true\)\) continue;/.test(src("services/eventPresence.ts")));
check("at most one far-away note, only around the start", P.farNoteDue({ startAt: start, now: new Date(new Date(start).getTime() + 15 * 60_000), arrived: false, noteSent: false, distanceM: 8000 }) && !P.farNoteDue({ startAt: start, now: new Date(new Date(start).getTime() + 15 * 60_000), arrived: false, noteSent: true, distanceM: 8000 }) && !P.farNoteDue({ startAt: start, now: new Date(new Date(start).getTime() + 15 * 60_000), arrived: false, noteSent: false, distanceM: 500 }) && !P.farNoteDue({ startAt: start, now: new Date(new Date(start).getTime() - 60 * 60_000), arrived: false, noteSent: false, distanceM: 8000 }));
check("coordinates are never stored", !/latitude|longitude/.test(src("services/preArrival.ts").replace(/\/\/.*$/gm, "")) && !/INSERT INTO event_presence[^;]*(lat|lng)/.test(src("services/eventPresence.ts")));
check("stop sharing is handled in code before any reply", /if \(P\.isStopSharing\(resolvedContent\)\) await P\.stopSharing\(user\.id\)/.test(src("routes/sendblue.ts")));
check("on the way, Cue answers normally, records going, never pressures, never offers the host", /never pressure them to come, and never offer to contact the host/.test(src("harness/replyGrounding.ts")) && /updateGoing: tool\(/.test(src("agent/conversationTools.ts")));

console.log(`pre-arrival rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
