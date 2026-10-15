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

check("the four follow-ups are Co's to time", F.handedToCo(t("window_followup")) && F.handedToCo(t("ask_checkin")) && F.handedToCo(t("debrief")) && F.handedToCo(t("companion", "companion:advice:3")));
check("operations, check-ins, story texts and offers stay on their schedules", !F.handedToCo(t("call_reminder")) && !F.handedToCo(t("event_change")) && !F.handedToCo(t("companion", "companion:thread:9")) && !F.handedToCo(t("companion", "companion:milestone:x")) && !F.handedToCo(t("event_offer")) && !F.handedToCo(t("post_call")));
const now = new Date("2026-09-30T18:00:00Z");
check("a new follow-up is created, a repeat updates the open one", F.followUpAction(null, now) === "create" && F.followUpAction({ status: "open", closedAt: null }, now) === "update");
check("once Co decided (sent or let go), the old timers don't reopen it for 14 days", F.followUpAction({ status: "dropped", closedAt: new Date(now.getTime() - 3 * 86_400_000) }, now) === "ignore" && F.followUpAction({ status: "done", closedAt: new Date(now.getTime() - 20 * 86_400_000) }, now) === "create");
check("FOLLOWUPS_BY_CO=off switches back to the fixed timers", !F.followUpsByCo({ FOLLOWUPS_BY_CO: "off" } as any) && F.followUpsByCo({} as any));
const pro = src("harness/proactive.ts");
check("the handover happens at the one place every sender queues through", /if \(!input\.fromCo\) \{\s*const F = await import\("\.\.\/services\/followUps\.js"\);\s*if \(F\.followUpsByCo\(\) && F\.handedToCo\(input\)\) return F\.startFollowUp\(input\);/.test(pro));
const fu = src("services/followUps.ts");
check("when Co checks in, it goes back through the same queue and daily pick (every limit applies)", /enqueueCandidate\(\{ userId, type: f\.type as any, [^}]*fromCo: true \}\)/.test(fu));
check("a debrief still collects both of its parts", /input\.merge\(ex\.followup\?\.payload, input\.payload\)/.test(fu));
check("no decision means Co looks again tomorrow; follow-ups end after 5 looks or 14 days", /await deps\.later\(24,/.test(fu) && /task\.wakes > FOLLOWUP_LIMITS\.maxWakes \|\| age > FOLLOWUP_LIMITS\.maxDays/.test(fu));
check("due follow-ups run with the task job", /if \(t\.kind === "followup"\) await import\("\.\/followUps\.js"\)/.test(src("services/taskTurn.ts")));
check("follow-ups don't count toward the 5 open work tasks or wake on replies", /status = 'open' AND kind = 'work' ORDER BY/.test(src("services/coTasks.ts")) && /AND awaiting_reply AND kind = 'work'/.test(src("services/coTasks.ts")));
console.log(`follow-up rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
