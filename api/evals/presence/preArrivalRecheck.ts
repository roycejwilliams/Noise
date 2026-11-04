// The pre-arrival text, read again when it's drafted (2026-11-03). Queued up to 3 hours before a Noise event, it went to someone who
// had since said they can't make it, and its "a few people coming fit what you're after" counted every stored ranking: a guest who had
// cancelled, a pair already declined, a reason no longer shareable. Now the draft re-reads their presence and the guest list, and the
// count is the member brief's own (services/eventBrief.ts pickNamed with nobody named). Layer 1: a fake store, zero tokens, nothing sent.
// Every path checked here returns before any model call. Invented members only.
//   npx tsx evals/presence/preArrivalRecheck.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const RAE = "00000000-0000-4000-8000-0000000000a1";
const MAYA = "00000000-0000-4000-8000-0000000000b2";
const ELLIS = "00000000-0000-4000-8000-0000000000c3";
const NOOR = "00000000-0000-4000-8000-0000000000d4";
const SAM = "00000000-0000-4000-8000-0000000000e5";
const EV = "test-ev-prearrival";
const ask = (text: string, shareable = true) => ({ id: text.slice(0, 6), text, type: "seeking", status: "active", kind: "ask", shareable });
const reason = (t: string) => `what they've said they're looking for: "${t}"`;
const rc = (id: string, score: number, share: string) => ({ candidate_id: id, score, reason: "internal", shareReason: reason(share), mutual: false, method: "ask" });

// ---------------------------------------------------------------- the fake store
type World = { guests: string[] | null; presence: Record<string, any>; ranked: any[]; pairs: any[]; intents: Record<string, any[]>; failNotGoing?: boolean; failPresence?: boolean };
let w: World;
const names: Record<string, string> = { [RAE]: "Rae", [MAYA]: "Maya", [ELLIS]: "Ellis", [NOOR]: "Noor", [SAM]: "Sam" };
const fresh = (): World => ({
  guests: [RAE, MAYA, ELLIS, NOOR, SAM],
  presence: {},
  ranked: [rc(MAYA, 90, "raising a seed round"), rc(ELLIS, 80, "hiring a designer"), rc(NOOR, 75, "climate hardware partners"), rc(SAM, 70, "a first sales hire")],
  pairs: [],
  intents: { [RAE]: [ask("seed investors for climate hardware")], [MAYA]: [ask("raising a seed round")], [ELLIS]: [ask("hiring a designer")], [NOOR]: [ask("climate hardware partners")], [SAM]: [ask("a first sales hire")] },
});
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, p: any[] = []) => {
  const q = sql.replace(/\s+/g, " ");
  if (/FROM co_test_events e JOIN users u/.test(q)) {
    if (!w.guests) throw new Error("guest list down");
    return { rows: w.guests.map((id) => ({ user_id: id, first_name: names[id], phone_number: "+15555550100" })) };
  }
  if (/^SELECT \* FROM event_presence WHERE event_api_id = \$1 AND user_id = \$2/.test(q)) if (w.failPresence) throw new Error("down"); else return { rows: w.presence[p[1]] ? [w.presence[p[1]]] : [] };
  if (/SELECT user_id FROM event_presence WHERE event_api_id = \$1 AND user_id = ANY\(\$2::uuid\[\]\) AND not_going_at IS NOT NULL/.test(q)) {
    if (w.failNotGoing) throw new Error("down");
    return { rows: (p[1] as string[]).filter((id) => w.presence[id]?.not_going_at).map((id) => ({ user_id: id })) };
  }
  if (/SELECT ranked_candidates FROM event_guest_rankings/.test(q)) return { rows: [{ ranked_candidates: w.ranked }] };
  if (/SELECT \* FROM co_pairs WHERE \(a_id = \$1/.test(q)) return { rows: w.pairs };
  if (/SELECT user_id, intent FROM co_profiles WHERE user_id = ANY/.test(q)) return { rows: (p[0] as string[]).map((id) => ({ user_id: id, intent: w.intents[id] ?? [] })) };
  if (/SELECT intent FROM co_profiles WHERE user_id = \$1/.test(q)) return { rows: [{ intent: w.intents[p[0]] ?? [] }] };
  if (/INSERT INTO harness_decisions/.test(q)) return { rows: [{ id: "1", created_at: new Date() }] };
  return { rows: [] };
};
const { testNumbersEnabled } = await import("../../src/services/testNumbers.js");
void testNumbersEnabled;
const P = await import("../../src/services/preArrival.js");
const E = await import("../../src/services/eventPresence.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const members = () => (w.guests ?? []).map((id) => ({ user_id: id, first_name: names[id] }));
const orderPair = (x: string, y: string) => (x < y ? { a_id: x, b_id: y } : { a_id: y, b_id: x });

// ---------------------------------------------------------------- 1. the count is the brief's count
w = fresh();
check("all four fit, registered, going, shareable now: four", (await P.strongFits(EV, RAE, members())) === 4);
w = fresh();
w.presence[MAYA] = { not_going_at: new Date() };
check("a guest who said they can't make it isn't counted", (await P.strongFits(EV, RAE, members())) === 3);
w = fresh();
w.guests = [RAE, MAYA, ELLIS];
check("a guest no longer on the list isn't counted", (await P.strongFits(EV, RAE, members())) === 2);
w = fresh();
w.pairs = [{ ...orderPair(RAE, ELLIS), event_id: "ev-older", state: "declined", declined_at: new Date() }, { ...orderPair(RAE, NOOR), event_id: "ev-older", state: "intro_sent", intro_sent_at: new Date() }];
check("a pair declined before, or already introduced, isn't counted (the brief's pair record)", (await P.strongFits(EV, RAE, members())) === 2);
w = fresh();
w.intents[SAM] = [ask("a first sales hire", false)];
check("a reason that is no longer one of their shareable asks isn't counted", (await P.strongFits(EV, RAE, members())) === 3);
w = fresh();
w.ranked = [rc(MAYA, 59, "raising a seed round"), rc(ELLIS, 80, "hiring a designer")];
check("below the strong bar isn't counted", (await P.strongFits(EV, RAE, members())) === 1);
w = fresh();
w.ranked = [rc(RAE, 99, "seed investors for climate hardware"), rc(MAYA, 90, "raising a seed round")];
check("never the recipient", (await P.strongFits(EV, RAE, members())) === 1);
w = fresh();
w.presence[MAYA] = { not_going_at: new Date() };
w.failNotGoing = true;
check("review of #377: a failed read of who cancelled counts nobody (never a guest who cancelled)", (await P.strongFits(EV, RAE, members())) === 0);
w = fresh();
(pool as any).query = ((real) => async (sql: string, p: any[] = []) => (/FROM co_pairs/.test(sql) ? Promise.reject(new Error("down")) : real(sql, p)))((pool as any).query);
check("a pair read that fails counts nobody (no guess)", (await P.strongFits(EV, RAE, members())) === 0);
check("the pure count matches the brief's picker with nobody named", P.countStrongFits({ ranked: [rc(MAYA, 90, "raising a seed round") as any], recipientId: RAE, members: [{ user_id: MAYA, first_name: "Maya" }], notGoing: new Set(), stillShareable: new Map([[MAYA, ["raising a seed round"]]]) }) === 1);

// ---------------------------------------------------------------- 2. the draft re-reads before it writes anything
const realQuery = (pool as any).query;
let until = new Date(Date.now() + 2 * 3_600_000).toISOString();
const cand = (): any => ({ id: "c1", userId: RAE, type: "pre_arrival", payload: { eventId: EV, name: "Founders Table", startAt: "2026-11-05T02:00:00.000Z", timezone: "America/Los_Angeles", canUseLocation: true, until }, createdAt: new Date() });
const draft = async () => { E.clearPresenceCache(); return (proactiveRegistry as any).pre_arrival.draft(cand(), { firstName: "Rae", timezone: "America/Los_Angeles" }); };
w = fresh();
w.presence[RAE] = { not_going_at: new Date() };
let r: any = await draft();
check("they said they can't make it after it was queued: nothing goes", r && "skip" in r && /can't make it/.test(r.skip), r);
w = fresh();
w.presence[RAE] = { pre_arrival_sent_at: new Date() };
r = await draft();
check("already sent for this event: nothing goes", r && "skip" in r && /already sent/.test(r.skip), r);
w = fresh();
w.guests = [MAYA, ELLIS];
r = await draft();
check("no longer on the list: nothing goes", r && "skip" in r && /no longer registered/.test(r.skip), r);
w = fresh();
w.guests = null;
r = await draft();
check("the guest list can't be read: it waits (never sent without the no-names check's list)", r && "defer" in r && /guest list/.test(r.reason), r);
w = fresh();
w.failPresence = true;
r = await draft();
check("review of #377: their presence can't be read: it waits (never read as nothing said)", r && "defer" in r, r);
w = fresh();
until = new Date(Date.now() - 60_000).toISOString();
r = await draft();
check("review of #377: past its window it never goes, recorded as window closed", r && "skip" in r && r.skip === "window closed", r);
w = fresh();
w.guests = null;
until = new Date(Date.now() + 5 * 60_000).toISOString();
r = await draft();
check("review of #377: no room left for a wait inside the window: it skips, never waits past it", r && "skip" in r && /^window closed/.test(r.skip), r);
until = new Date(Date.now() + 2 * 3_600_000).toISOString();
(pool as any).query = realQuery;
const now0 = new Date("2026-11-04T23:00:00Z");
const wt = P.preArrivalWait("2026-11-05T01:00:00Z", now0, "x") as any;
check("a wait is 10 minutes while the window has room", wt.defer?.getTime() === now0.getTime() + 10 * 60_000);
check("no until, no wait", "skip" in P.preArrivalWait(null, now0, "x"));

// ---------------------------------------------------------------- 3. wiring
const reg = src("harness/proactiveRegistry.ts");
check("the draft passes the guest list it read to the count", /P\.strongFits\(p\.eventId, c\.userId, members\)/.test(reg));
check("the location offer still reads the same presence row", /!row\?\.location_yes_at/.test(reg));
check("review of #377: a pre-arrival wait never moves its queue expiry past the original one", /WHEN type IN \('event_offer', 'pre_arrival'\) AND expires_at IS NOT NULL THEN LEAST\(expires_at, \$3\)/.test(src("harness/proactive.ts")));

console.log(`pre-arrival recheck: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
