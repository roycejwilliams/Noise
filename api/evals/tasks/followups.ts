// Follow-ups handed to Co (services/followUps.ts). Model-free.
//   npx tsx evals/tasks/followups.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const F = await import("../../src/services/followUps.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const t = (type: string, targetKey = "x") => ({ type, targetKey }) as any;

check("the four follow-ups are Cue's to time", F.handedToCo(t("window_followup")) && F.handedToCo(t("ask_checkin")) && F.handedToCo(t("debrief")) && F.handedToCo(t("companion", "companion:advice:3")));
check("operations, check-ins, story texts and offers stay on their schedules", !F.handedToCo(t("call_reminder")) && !F.handedToCo(t("event_change")) && !F.handedToCo(t("companion", "companion:thread:9")) && !F.handedToCo(t("companion", "companion:milestone:x")) && !F.handedToCo(t("event_offer")) && !F.handedToCo(t("post_call")));
const now = new Date("2026-09-30T18:00:00Z");
check("a new follow-up is created, a repeat updates the open one", F.followUpAction(null, now) === "create" && F.followUpAction({ status: "open", closedAt: null }, now) === "update");
check("once Cue decided (sent or let go), the old timers don't reopen it for 14 days", F.followUpAction({ status: "dropped", closedAt: new Date(now.getTime() - 3 * 86_400_000) }, now) === "ignore" && F.followUpAction({ status: "done", closedAt: new Date(now.getTime() - 20 * 86_400_000) }, now) === "create");
check("FOLLOWUPS_BY_CO=off switches back to the fixed timers", !F.followUpsByCo({ FOLLOWUPS_BY_CO: "off" } as any) && F.followUpsByCo({} as any));
const pro = src("harness/proactive.ts");
check("the handover happens at the one place every sender queues through", /if \(!input\.fromCo\) \{\s*const F = await import\("\.\.\/services\/followUps\.js"\);\s*if \(F\.followUpsByCo\(\) && F\.handedToCo\(input\)\) return F\.startFollowUp\(input\);/.test(pro));
const fu = src("services/followUps.ts");
check("when Cue checks in, it goes back through the same queue and daily pick (every limit applies)", /enqueueCandidate\(\{ userId, type: f\.type as any, [^}]*fromCo: true \}\)/.test(fu));
check("a debrief still collects both of its parts", /input\.merge\(ex\.followup\?\.payload, input\.payload\)/.test(fu));
check("no decision means Cue looks again tomorrow; follow-ups end after 5 looks or 14 days", /await deps\.later\(24,/.test(fu) && /task\.wakes > FOLLOWUP_LIMITS\.maxWakes \|\| age > FOLLOWUP_LIMITS\.maxDays/.test(fu));
check("due follow-ups run with the task job", /if \(t\.kind === "followup"\) await import\("\.\/followUps\.js"\)/.test(src("services/taskTurn.ts")));
check("follow-ups don't count toward the 5 open work tasks or wake on replies", /status = 'open' AND kind = 'work' ORDER BY/.test(src("services/coTasks.ts")) && /AND awaiting_reply AND kind = 'work'/.test(src("services/coTasks.ts")));
// A debrief's wake reads the record first (2026-11-11: two debriefs for a declined event and an unanswered send sat open and fed "how both
// went" into a reply): nothing on record closes it before the decider; any yes, plan or registration wakes it as before.
const deb = (payload: any = {}) => ({ type: "debrief", payload: { outcomeFollowupIds: ["x"], ...payload } });
check("a debrief with nothing on record (declined or no reply) closes at its wake", F.debriefWakeCloses(deb(), { level: "none" }) && F.debriefWakeCloses(deb({ checkinFollowupIds: [] }), { level: "none" }));
check("a stated plan, registration or stated going still wakes the debrief", !F.debriefWakeCloses(deb(), { level: "intent" }) && !F.debriefWakeCloses(deb(), { level: "attended" }));
check("a Noise check-in or walk-in part is left to the send-time door read", !F.debriefWakeCloses(deb({ checkinFollowupIds: ["c"] }), { level: "none" }) && !F.debriefWakeCloses(deb({ walkinCheckinIds: ["w"] }), { level: "none" }));
check("an unreadable record or another follow-up type never closes at the wake", !F.debriefWakeCloses(deb(), null) && !F.debriefWakeCloses({ type: "ask_checkin", payload: {} }, { level: "none" }));
check("the wake gate runs before the decider and reads the same record as the send-time draft", /if \(await debriefWakeGate\(userId, task\)\) return;[\s\S]*runFollowUpTurnWith\(task,/.test(fu) && /R\.debriefRecordEvidence\(/.test(fu) && /const evidence = await debriefRecordEvidence\(c\.userId, p, startedAt, came\)/.test(src("harness/proactiveRegistry.ts")));
const A = await import("../../src/services/whatsAhead.js");
const aheadText = A.aheadLine({ tasks: [{ id: 1, goal: 'Morning-after follow-up on "SF Private Dinner" (asks whether they went; how it went only with evidence they did)', kind: "followup", nextCheckAt: "2026-11-11T18:00:00Z", deadline: null, debriefOf: "SF Private Dinner" }], queuedFinds: 0 }, { asks: [], goals: [] } as any, "America/Los_Angeles");
check("the ahead line says a debrief as whether they made it, never how it went", /whether they made it to "SF Private Dinner"/.test(aheadText) && !/Morning-after follow-up/.test(aheadText));
console.log(`follow-up rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
