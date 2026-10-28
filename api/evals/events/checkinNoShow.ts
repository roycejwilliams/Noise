// A guest who didn't make it to a Noise event never gets a "how was tonight?" (or a "did you make it?") about that night as well
// as the no-show note: the no-show flow (services/eventNoShow.ts) owns them. Found walking the flow board against the code
// (2026-10-27). Decided when the debrief is drafted, the morning after (harness/proactiveRegistry.ts draftDebrief), never when
// the check-in row is queued, which happens up to a day before the event ends (review of #275).
// Layer 1: the pure decision, the real read on a fake store, and the wiring. Zero tokens, no network, nothing sent.
//   npx tsx evals/events/checkinNoShow.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const E = await import("../../src/services/eventCheckinFollowUp.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const T = new Date("2026-10-27T03:00:00Z");
const d = E.debriefForPresence;

// 1. The pure decision
check("no presence row: sent as before", d(null, false) === "send");
check("came (any evidence): sent, even after saying they weren't going", d({ not_going_at: T }, true) === "send");
check("said they weren't going, didn't come: skipped", d({ not_going_at: T }, false) === "skip");
check("no-show settled 'said no': skipped (the no-show note covers the night)", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "said_no:queued" }, false) === "skip");
check("no-show settled 'no answer': skipped", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "no_answer:queued" }, false) === "skip");
check("member gone: skipped", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "gone" }, false) === "skip");
check("asked, not settled yet: waits", d({ noshow_asked_at: T, noshow_settled_at: null }, false) === "wait");
check("asked, settled unclear: sent as before", d({ noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "unclear" }, false) === "send");

// 2. The real read (debriefForEvent) on a fake store; a test event never reads Luma
const realQuery = (pool as any).query;
const world = { row: null as any, arrived: false, walkin: false, throws: false };
(pool as any).query = async (sql: string) => {
  if (world.throws) throw new Error("connection refused");
  if (/FROM users u LEFT JOIN event_presence/.test(sql)) return { rows: world.row ? [world.row] : [] };
  if (/arrived_at IS NOT NULL/.test(sql)) return { rows: world.arrived ? [{ x: 1 }] : [] };
  if (/event_walkin_checkins/.test(sql)) return { rows: world.walkin ? [{ x: 1 }] : [] };
  return { rows: [] };
};
const ev = "test-dinner-1027", u = "00000000-0000-4000-8000-0000000000f1";
const base = { email: "jordan@example.com", phone_number: "+14155550101" };
const run = async (o: Partial<typeof world>) => { Object.assign(world, { row: null, arrived: false, walkin: false, throws: false }, o); return E.debriefForEvent(u, ev); };
check("read: never asked, never said anything: sent", (await run({ row: { ...base, not_going_at: null, noshow_asked_at: null } })) === "send");
check("read: said no, no evidence: skipped", (await run({ row: { ...base, noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "said_no:queued" } })) === "skip");
check("read: said no, but a walk-in check-in: sent (came)", (await run({ row: { ...base, noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "said_no:queued" }, walkin: true })) === "send");
check("read: 'not going' days before, then arrived: sent", (await run({ row: { ...base, not_going_at: T, noshow_asked_at: null }, arrived: true })) === "send");
check("read: asked, not settled: waits", (await run({ row: { ...base, noshow_asked_at: T, noshow_settled_at: null } })) === "wait");
check("read: the store can't be read: waits, never sends blind", (await run({ throws: true })) === "wait");

// 2b. The Luma door (a real event id, the guest list injected)
const real = "evt-dinner-1027";
let reads = 0;
const door = (o: { email?: string; fail?: boolean }) => async () => { reads++; if (o.fail) throw new Error("luma: getEventGuestList failed (503)"); return o.email ? [{ email: o.email, phone: null, checked_in_at: "2026-10-28T02:10:00Z" } as any] : []; };
const runL = async (row: any, g: ReturnType<typeof door>) => { Object.assign(world, { row, arrived: false, walkin: false, throws: false }); return E.debriefForEvent(u, real, { guestList: g }); };
check("door: 'not going' Wednesday, scanned at Luma's door Friday: sent (came)", (await runL({ ...base, not_going_at: T, noshow_asked_at: null }, door({ email: base.email }))) === "send");
check("door: said no, not on the door list: skipped", (await runL({ ...base, noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "said_no:queued" }, door({}))) === "skip");
check("door: Luma can't be read and the answer turns on it: waits, never skips on a failed read", (await runL({ ...base, not_going_at: T, noshow_asked_at: null }, door({ fail: true }))) === "wait");
reads = 0;
check("door: never asked, never said anything: sent without reading Luma at all", (await runL({ ...base, not_going_at: null, noshow_asked_at: null }, door({ fail: true }))) === "send" && reads === 0, { reads });

// 2c. The bound, through the real draft: a wait defers the debrief, but never past 3 days from when it was first queued
const { proactiveRegistry: registry, DEBRIEF_WAIT_MAX_HOURS } = await import("../../src/harness/proactiveRegistry.js");
const cand = (ageHours: number) => ({ id: "c1", userId: u, type: "debrief", targetKey: `debrief:${ev}`, topicKey: null, summary: "", priority: 50, attempts: 0, dueAt: new Date(), expiresAt: new Date(Date.now() + 72 * 3_600_000), createdAt: new Date(Date.now() - ageHours * 3_600_000), payload: { eventApiId: ev, eventName: "The Dinner", outcomeFollowupIds: [], checkinFollowupIds: ["f1"], walkinCheckinIds: [], askText: null } }) as any;
const person = { userId: u, firstName: "Jordan", phoneNumber: base.phone_number } as any;
Object.assign(world, { row: { ...base, noshow_asked_at: T, noshow_settled_at: null }, arrived: false, walkin: false, throws: false });
const young = await registry.debrief.draft(cand(1), person);
const old = await registry.debrief.draft(cand(DEBRIEF_WAIT_MAX_HOURS + 1), person);
check("draft: unsettled an hour in: deferred (about 2h), nothing drafted", "defer" in young && Math.abs((young as any).defer.getTime() - Date.now() - 2 * 3_600_000) < 60_000, young);
check("draft: still unsettled past the cap: skipped, nothing sent on a guess", "skip" in old && /never settled/.test((old as any).skip), old);
Object.assign(world, { row: { ...base, noshow_asked_at: T, noshow_settled_at: T, noshow_outcome: "no_answer:queued" } });
const no = await registry.debrief.draft(cand(1), person);
check("draft: a settled no-show: the whole debrief is skipped before any model call", "skip" in no && /no-show flow covers/.test((no as any).skip), no);
(pool as any).query = realQuery;

// 3. Wiring: decided at draft time, before anything is written; the check-in queue itself is unchanged
const reg = fs.readFileSync(new URL("../../src/harness/proactiveRegistry.ts", import.meta.url), "utf8");
const dd = reg.slice(reg.indexOf("async function draftDebrief("), reg.indexOf("async function debriefItemKeys("));
check("draftDebrief asks debriefForEvent for a Noise event before drafting", dd.indexOf("debriefForEvent(c.userId, p.eventApiId)") > 0 && dd.indexOf("debriefForEvent(") < dd.indexOf("draftDebriefText("));
check("a skip ends the whole debrief; a wait defers it, bounded by the candidate's age (2c runs it)", /if \(said === "skip"\) return skip\(/.test(dd) && /c\.createdAt\.getTime\(\) > DEBRIEF_WAIT_MAX_HOURS/.test(dd));
check("draftDebrief still waits until the day is over first", dd.indexOf("hasn't happened yet") > 0 && dd.indexOf("hasn't happened yet") < dd.indexOf("debriefForEvent("));
const ecf = fs.readFileSync(new URL("../../src/services/eventCheckinFollowUp.ts", import.meta.url), "utf8");
check("the queue step doesn't decide it (it runs up to a day before the event ends)", !ecf.slice(ecf.indexOf("export async function enqueueDueEventCheckinFollowUps")).includes("debriefFor"));

console.log(`debrief vs no-show: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
