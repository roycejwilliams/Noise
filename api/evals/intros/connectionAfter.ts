// After a connection (2026-11-03): what they already told Cue is never asked again, and a plan is never recorded as done.
//   1. The morning-after debrief names only people they haven't already told Cue about (their side of that night's pair, stated).
//   2. The intro check-in ("did you two get a chance to connect?") doesn't go once they've said how it went since the intro.
//   3. noteMetAgain: "we're meeting Tuesday" with a day still ahead is recorded as not yet, never as having met.
// Layer 1: a fake store, zero tokens, nothing sent. Invented members only.
//   npx tsx evals/intros/connectionAfter.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

const JORDAN = "00000000-0000-4000-8000-0000000000a1";
const ELLIS = "00000000-0000-4000-8000-0000000000b2";
const NOOR = "00000000-0000-4000-8000-0000000000c3";
const SAM = "00000000-0000-4000-8000-0000000000d4";
const order = (x: string, y: string) => (x < y ? { a_id: x, b_id: y } : { a_id: y, b_id: x });
const stated = (value: string, at = "2026-11-02T05:00:00Z") => ({ value, source: "text", at, how: "stated" });
const inferred = (value: string) => ({ value, source: "checkin", at: "2026-11-02T05:00:00Z", how: "inferred" });
const side = (x: string, y: string, mine: any) => { const p = order(x, y); return { ...p, a_evidence: p.a_id === x ? mine : {}, b_evidence: p.b_id === x ? mine : {} }; };

// ---------------------------------------------------------------- the fake store
type World = { pointed: { id: string; first_name: string }[]; pairs: any[] | null; facts: any[]; inserts: { sql: string; p: any[] }[] };
let w: World = { pointed: [], pairs: [], facts: [], inserts: [] };
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, p: any[] = []) => {
  const q = sql.replace(/\s+/g, " ");
  if (/FROM event_guest_match_nudges n JOIN users u/.test(q)) return { rows: w.pointed };
  if (/SELECT a_id, b_id, a_evidence, b_evidence FROM co_pairs WHERE event_id = \$1 AND \(a_id = \$2 OR b_id = \$2\)/.test(q)) {
    if (!w.pairs) throw new Error("down");
    return { rows: w.pairs };
  }
  if (/FROM co_facts WHERE owner_user_id = \$1 AND relation = 'second_contact'/.test(q)) return { rows: w.facts.filter((f) => f.owner === p[0] && f.other === p[1] && f.at > p[2]) };
  if (/CASE WHEN a_id = \$1 THEN a_evidence ELSE b_evidence END AS mine FROM co_pairs/.test(q)) {
    return { rows: (w.pairs ?? []).filter((r) => (r.a_id === p[0] && r.b_id === p[1]) || (r.a_id === p[1] && r.b_id === p[0])).map((r) => ({ mine: r.a_id === p[0] ? r.a_evidence : r.b_evidence })) };
  }
  // noteMetAgain's reads: the people Cue introduced them to, their home city (none: the fallback zone).
  if (/FROM member_connections c JOIN users u/.test(q)) return { rows: [{ id: ELLIS, first_name: "Ellis", created_at: new Date("2026-10-20T00:00:00Z") }] };
  if (/INSERT INTO co_facts/.test(q)) { w.inserts.push({ sql: q, p }); return { rows: [] }; }
  if (/INSERT INTO harness_decisions/.test(q)) return { rows: [{ id: "1", created_at: new Date() }] };
  return { rows: [] };
};
const { peopleCoPointedTo, stillToAsk } = await import("../../src/harness/proactiveRegistry.js");
const N = await import("../../src/services/memberStateNudges.js");
const SC = await import("../../src/services/secondContact.js");

// ---------------------------------------------------------------- 1. the debrief's people
const pointed = [{ id: ELLIS, first_name: "Ellis" }, { id: NOOR, first_name: "Noor" }, { id: SAM, first_name: "Sam" }];
check("nothing said yet: all of them may be asked about", stillToAsk(pointed, [], JORDAN).join() === "Ellis,Noor,Sam");
check("they told Cue they met Ellis (stated): Ellis isn't asked about again", stillToAsk(pointed, [side(JORDAN, ELLIS, { met: stated("yes"), useful: stated("yes") })], JORDAN).join() === "Noor,Sam");
check("they said they never found Noor: Noor isn't asked about either", stillToAsk(pointed, [side(JORDAN, NOOR, { met: stated("no") })], JORDAN).join() === "Ellis,Sam");
check("an inference (the check-in read) doesn't count as their answer", stillToAsk(pointed, [side(JORDAN, SAM, { met: inferred("yes") })], JORDAN).join() === "Ellis,Noor,Sam");
check("the OTHER side's answer never decides what this member is asked", stillToAsk(pointed, [side(ELLIS, JORDAN, { met: stated("yes") })], JORDAN).join() === "Ellis,Noor,Sam");
w = { pointed, pairs: [side(JORDAN, ELLIS, { met: stated("yes") })], facts: [], inserts: [] };
check("through the store: the debrief's list leaves out Ellis", (await peopleCoPointedTo(JORDAN, "ev-dinner")).join() === "Noor,Sam");
w = { pointed, pairs: null, facts: [], inserts: [] };
check("a pair read that fails names nobody (the debrief asks who they met), never someone they may have answered", (await peopleCoPointedTo(JORDAN, "ev-dinner")).length === 0);
check("no event, nobody", (await peopleCoPointedTo(JORDAN, null)).length === 0);

// ---------------------------------------------------------------- 2. the intro check-in
const now = new Date("2026-10-27T18:00:00Z");
const intro = { otherId: ELLIS, otherFirstName: "Ellis", introducedAt: new Date("2026-10-22T18:00:00Z"), how: "network" as const, eventName: null, reasonAsEmailed: null, hasOutcomeFollowup: false, otherActive: true };
const snap = (i: any) => ({ userId: JORDAN, zone: "America/Los_Angeles", now, ownLines: [], intros: [i], cared: [], goals: [], intent: [], lastGoalSurfaceAt: null, lastKeptAt: null, commitments: [] }) as any;
check("nothing said since the intro: the check-in is queued", N.planNudges(snap(intro), []).queue.length === 1);
check("they already said how it went (without typing the name): nothing is queued", N.planNudges(snap({ ...intro, outcomeSaid: true }), []).queue.length === 0);
check("their own stated word after the intro counts", N.statedSince({ kept_talking: stated("not_yet", "2026-10-24T00:00:00Z") }, intro.introducedAt));
check("a word from before this intro doesn't", !N.statedSince({ met: stated("yes", "2026-10-01T00:00:00Z") }, intro.introducedAt));
check("an inference doesn't", !N.statedSince({ met: { ...inferred("yes"), at: "2026-10-24T00:00:00Z" } }, intro.introducedAt));
check("nothing on file doesn't", !N.statedSince(null, intro.introducedAt) && !N.statedSince({}, intro.introducedAt));

// ---------------------------------------------------------------- 3. a plan is not a meeting
check("met again on a day still ahead: recorded as not yet, and the day dropped", JSON.stringify(SC.plannedNotHappened("met_again", "2026-11-10", "2026-11-03")) === JSON.stringify({ outcome: "not_yet", metOn: null, planned: true }));
check("talked again on a day still ahead: the same", SC.plannedNotHappened("talked_again", "2026-11-04", "2026-11-03").outcome === "not_yet");
check("today or earlier: as they said it", SC.plannedNotHappened("met_again", "2026-11-03", "2026-11-03").outcome === "met_again" && SC.plannedNotHappened("met_again", "2026-10-30", "2026-11-03").metOn === "2026-10-30");
check("not yet / not going to are never changed; a malformed day is dropped", SC.plannedNotHappened("not_going_to", "2026-12-01", "2026-11-03").outcome === "not_going_to" && SC.plannedNotHappened("met_again", "Tuesday", "2026-11-03").metOn === null);

// Through the real tool: "we're meeting Tuesday", with the model picking met_again and a future day.
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const said = "Ellis and I are meeting next Tuesday for coffee";
const tools = (onCall = false) => createConversationTools({
  userId: JORDAN, phoneNumber: "+10000000000", resolvedContent: said, isVoice: onCall, onCall, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
  sendCoReply: async () => true, facts: { add: () => {}, text: () => "" },
} as any).tools as any;
const future = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
for (const onCall of [false, true]) {
  w = { pointed: [], pairs: [], facts: [], inserts: [] };
  const r = await quiet(() => tools(onCall).noteMetAgain.execute({ person: "Ellis", outcome: "met_again", note: "coffee next Tuesday", metOn: future }, { toolCallId: "t1", messages: [] }));
  const facts = w.inserts.filter((i) => i.p[2] === "second_contact");
  const meta = JSON.parse(facts[0]?.p[9] ?? "{}");
  check(`${onCall ? "call" : "text"}: a meeting still ahead is saved as not yet, with no day, never as met`, facts.length === 1 && meta.outcome === "not_yet" && !("metOn" in meta) && /^Hasn't seen Ellis again yet/.test(facts[0].p[3]), { r, facts: facts.map((f) => f.p) });
  check(`${onCall ? "call" : "text"}: the tool tells Cue it was recorded as planned`, r?.ok === true && r?.recorded === "not_yet" && /Never say they met/.test(r?.note ?? ""), r);
}
w = { pointed: [], pairs: [], facts: [], inserts: [] };
await quiet(() => tools().noteMetAgain.execute({ person: "Ellis", outcome: "met_again", note: "coffee", metOn: "2026-10-25" }, { toolCallId: "t2", messages: [] }));
check("a meeting that happened is saved as it was said, with its day", JSON.parse(w.inserts.find((i) => i.p[2] === "second_contact")?.p[9] ?? "{}").metOn === "2026-10-25");

console.log(`connection after: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
