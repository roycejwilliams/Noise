// The morning-after "how was tonight?" never goes to a guest who didn't make it: the no-show flow (services/eventNoShow.ts) owns
// them, with its "sorry you couldn't make it" note. Found walking the flow board against the code (2026-10-27): the room's roster at
// close counts registered guests who don't share their location, so a no-show who never answered "did you make it?" got both texts.
// Layer 1: the pure decision and the wiring. Zero tokens, no DB, nothing sent.
//   npx tsx evals/events/checkinNoShow.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const E = await import("../../src/services/eventCheckinFollowUp.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const T = new Date("2026-10-27T03:00:00Z");
const d = E.checkinForPresence;

check("no presence row (never asked, never said anything): sent as before", d(null) === "send");
check("came (arrival on record): sent, even after saying they weren't going", d({ arrived_at: T, not_going_at: T }) === "send");
check("said they weren't going: skipped", d({ not_going_at: T }) === "skip");
check("no-show settled 'said no': skipped (the no-show note covers them)", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "said_no:queued" }) === "skip");
check("no-show settled 'no answer' with the door tracked: skipped", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "no_answer:queued" }) === "skip");
check("no-show settled 'no answer', door not tracked (no note owed): still skipped, nothing shows they came", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "no_answer" }) === "skip");
check("member gone: skipped", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "gone" }) === "skip");
check("asked, not settled yet: waits for the next pass", d({ noshow_asked_at: T, noshow_settled_at: null }) === "wait");
check("asked, settled as came (a late door scan): sent", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "came" }) === "send");
check("asked, settled unclear (they replied, no 'no', no evidence): sent as before", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "unclear" }) === "send");

const src = fs.readFileSync(new URL("../../src/services/eventCheckinFollowUp.ts", import.meta.url), "utf8");
const body = src.slice(src.indexOf("export async function enqueueDueEventCheckinFollowUps"));
check("wiring: each due check-in reads the guest's presence before anything is queued", body.indexOf("FROM event_presence WHERE event_api_id = $1 AND user_id = $2") > 0 && body.indexOf("FROM event_presence") < body.indexOf("enqueueDebrief("));
check("wiring: a skip is marked and never queued; a wait (or an unreadable row) leaves the row for the next pass", /if \(decided === "wait"\) continue;/.test(body) && /harness_status = 'skipped_noshow'/.test(body) && /presence === undefined \? "wait"/.test(body));

console.log(`check-in vs no-show: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
