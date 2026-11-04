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
type World = { pointed: { id: string; first_name: string }[]; pairs: any[] | null; facts: any[]; inserts: { sql: string; p: any[] }[]; failFacts?: boolean; intro?: boolean };
let w: World = { pointed: [], pairs: [], facts: [], inserts: [] };
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, p: any[] = []) => {
  const q = sql.replace(/\s+/g, " ");
  if (/FROM event_guest_match_nudges n JOIN users u/.test(q)) return { rows: w.pointed };
  if (/SELECT a_id, b_id, a_evidence, b_evidence FROM co_pairs WHERE event_id = \$1 AND \(a_id = \$2 OR b_id = \$2\)/.test(q)) {
    if (!w.pairs) throw new Error("down");
    return { rows: w.pairs };
  }
  if (/FROM co_facts WHERE owner_user_id = \$1 AND relation = 'second_contact'/.test(q)) {
    if (w.failFacts) throw new Error("down");
    return { rows: w.facts.filter((f) => f.owner === p[0] && f.other === p[1] && f.at > p[2]).sort((x, y) => y.at - x.at).map((f) => ({ outcome: f.outcome, plannedOn: f.plannedOn ?? null })) };
  }
  // introsOf (the intro check-in's own read): one intro email to Ellis, five days ago.
  if (/FROM member_connections WHERE \(person_a = \$1 OR person_b = \$1\)/.test(q)) return { rows: w.intro ? [{ other: ELLIS, source: "network", created_at: new Date(Date.now() - 5 * 86_400_000) }] : [] };
  if (/SELECT id, first_name, archived_at FROM users WHERE id = ANY/.test(q)) return { rows: [{ id: ELLIS, first_name: "Ellis", archived_at: null }] };
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
check("nothing said yet: all of them may be asked about", stillToAsk(pointed, [], JORDAN).ask.join() === "Ellis,Noor,Sam");
check("they told Cue they met Ellis (stated): Ellis isn't asked about again", stillToAsk(pointed, [side(JORDAN, ELLIS, { met: stated("yes"), useful: stated("yes") })], JORDAN).ask.join() === "Noor,Sam");
check("they said they never found Noor: Noor isn't asked about either", stillToAsk(pointed, [side(JORDAN, NOOR, { met: stated("no") })], JORDAN).ask.join() === "Ellis,Sam");
check("an inference (the check-in read) doesn't count as their answer", stillToAsk(pointed, [side(JORDAN, SAM, { met: inferred("yes") })], JORDAN).ask.join() === "Ellis,Noor,Sam");
check("the OTHER side's answer never decides what this member is asked", stillToAsk(pointed, [side(ELLIS, JORDAN, { met: stated("yes") })], JORDAN).ask.join() === "Ellis,Noor,Sam");
w = { pointed, pairs: [side(JORDAN, ELLIS, { met: stated("yes") })], facts: [], inserts: [] };
check("through the store: the debrief's list leaves out Ellis", (await peopleCoPointedTo(JORDAN, "ev-dinner")).ask.join() === "Noor,Sam");
w = { pointed, pairs: null, facts: [], inserts: [] };
check("a pair read that fails names nobody (the debrief asks who they met), never someone they may have answered", (await peopleCoPointedTo(JORDAN, "ev-dinner")).ask.length === 0);
check("no event, nobody", (await peopleCoPointedTo(JORDAN, null)).ask.length === 0);
const allTold = stillToAsk([{ id: ELLIS, first_name: "Ellis" }], [side(JORDAN, ELLIS, { met: stated("yes"), useful: stated("no") })], JORDAN);
check("review of #376: what they already said goes to the draft (who, and what), their side only", allTold.ask.length === 0 && allTold.told.length === 1 && allTold.told[0].name === "Ellis" && allTold.told[0].what === "they met, it wasn't a fit", allTold);
{
  const reg = (await import("node:fs")).readFileSync(new URL("../../src/harness/proactiveRegistry.ts", import.meta.url), "utf8");
  check("review of #376: nothing left to ask (everyone told, no walk-in offer, no recommendation follow-up): the debrief is skipped", /if \(pointed\.told\.length && !pointed\.ask\.length && !\(p\.walkinCheckinIds \?\? \[\]\)\.length && !\(p\.outcomeFollowupIds \?\? \[\]\)\.length\) return skip\(/.test(reg));
  check("review of #376: otherwise the draft is told who they already told Cue about and never asks who they met", /they_already_told_cue_how_it_went_with/.test(reg) && /never ask about them again or ask who they met/.test(reg));
}

// ---------------------------------------------------------------- 2. the intro check-in
const now = new Date("2026-10-27T18:00:00Z");
const intro = { otherId: ELLIS, otherFirstName: "Ellis", introducedAt: new Date("2026-10-22T18:00:00Z"), how: "network" as const, eventName: null, reasonAsEmailed: null, hasOutcomeFollowup: false, otherActive: true };
const snap = (i: any) => ({ userId: JORDAN, zone: "America/Los_Angeles", now, ownLines: [], intros: [i], cared: [], goals: [], intent: [], lastGoalSurfaceAt: null, lastKeptAt: null, commitments: [] }) as any;
check("nothing said since the intro: the check-in is queued", N.planNudges(snap(intro), []).queue.length === 1);
check("they already said how it went (without typing the name): nothing is queued", N.planNudges(snap({ ...intro, outcomeSaid: true }), []).queue.length === 0);
check("their own stated word after the intro counts (met, useful, kept talking yes or no)", N.statedSince({ met: stated("yes", "2026-10-24T00:00:00Z") }, intro.introducedAt) && N.statedSince({ useful: stated("no", "2026-10-24T00:00:00Z") }, intro.introducedAt) && N.statedSince({ kept_talking: stated("no", "2026-10-24T00:00:00Z") }, intro.introducedAt));
check("review of #376: a plan (kept talking: not yet) is never an answer", !N.statedSince({ kept_talking: stated("not_yet", "2026-10-24T00:00:00Z") }, intro.introducedAt));
check("review of #376: the latest second-contact word decides; not yet is a plan with its day", JSON.stringify(N.secondContactSince([{ outcome: "not_yet", plannedOn: "2026-10-28" }, { outcome: "met_again" }])) === JSON.stringify({ answered: false, plannedOn: "2026-10-28" }) && N.secondContactSince([{ outcome: "met_again" }]).answered && N.secondContactSince([{ outcome: "not_going_to" }]).answered && !N.secondContactSince([]).answered);
{
  // A plan for the 28th (local): nothing while it's ahead or on the day; the day after, the check-in is due as its own state, and the
  // plan talk ("meeting Ellis on the 28th", said before) doesn't hold it back.
  const planned = { ...intro, plannedOn: "2026-10-28" };
  const lines = [{ at: new Date("2026-10-25T18:00:00Z"), text: "Meeting Ellis on the 28th for coffee" }];
  const on = (t: string, ownLines: any[] = lines) => N.detectIntroNudges({ ...snap(planned), now: new Date(t), ownLines });
  check("review of #376: a plan with a day: no check-in before or on that day", on("2026-10-27T18:00:00Z").length === 0 && on("2026-10-28T23:00:00Z").length === 0);
  const after = on("2026-10-29T18:00:00Z");
  check("review of #376: the day after, the check-in is due, as a new state (re-armed once)", after.length === 1 && after[0].fingerprint !== N.detectIntroNudges(snap(intro))[0]?.fingerprint, after);
  check("review of #376: a mention after the plan's day still holds it (they brought it up)", on("2026-10-30T18:00:00Z", [...lines, { at: new Date("2026-10-29T20:00:00Z"), text: "coffee with Ellis was great" }]).length === 0);
}
check("a word from before this intro doesn't", !N.statedSince({ met: stated("yes", "2026-10-01T00:00:00Z") }, intro.introducedAt));
check("an inference doesn't", !N.statedSince({ met: { ...inferred("yes"), at: "2026-10-24T00:00:00Z" } }, intro.introducedAt));
check("nothing on file doesn't", !N.statedSince(null, intro.introducedAt) && !N.statedSince({}, intro.introducedAt));

// A failed read is unknown, never answered (review of #376): the queued check-in waits, bounded, and the snapshot says it's unread.
w = { pointed: [], pairs: [], facts: [], inserts: [], failFacts: true, intro: true };
let threw = "";
await quiet(() => N.currentEntry(JORDAN, `intro:${ELLIS}`, "fp").catch((e: any) => { threw = String(e?.message ?? e); return null; }));
check("review of #376: the second-contact read failing makes the intro state unread (never answered, never gone)", threw === N.STATE_UNREAD, threw);
w = { pointed: [], pairs: [], facts: [], inserts: [], intro: true };
const answeredSnap = await quiet(() => N.loadSnapshot(JORDAN));
check("the same read working: the intro is there and unanswered", answeredSnap.intros.length === 1 && !answeredSnap.intros[0].outcomeSaid && !answeredSnap.introsUnread, answeredSnap.intros);
w.facts = [{ owner: JORDAN, other: ELLIS, at: new Date(), outcome: "not_yet", plannedOn: "2026-12-01" }];
const planSnap = await quiet(() => N.loadSnapshot(JORDAN));
check("review of #376: a stored plan reaches the intro as its day, not as an answer", planSnap.intros[0]?.plannedOn === "2026-12-01" && !planSnap.intros[0]?.outcomeSaid, planSnap.intros);
const cand = (ageH: number): any => ({ id: "c1", userId: JORDAN, type: "intro_nudge", payload: { entryKey: `intro:${ELLIS}`, fingerprint: "fp", meta: { otherId: ELLIS, otherFirstName: "Ellis" } }, createdAt: new Date(Date.now() - ageH * 3_600_000) });
const failing = { current: async () => { throw new Error(N.STATE_UNREAD); } };
const d1: any = await N.draftStateNudge(cand(1), { firstName: "Jordan" }, failing as any);
check("review of #376: the draft waits an hour on a failed read (never dropped as \"the state changed\")", d1 && "defer" in d1 && d1.reason === N.STATE_UNREAD, d1);
const d2: any = await N.draftStateNudge(cand(N.STATE_UNREAD_MAX_HOURS + 1), { firstName: "Jordan" }, failing as any);
check("review of #376: …bounded: unreadable for two days, it's dropped saying so", d2 && "skip" in d2 && d2.skip.startsWith(N.STATE_UNREAD), d2);
const d3: any = await N.draftStateNudge(cand(1), { firstName: "Jordan" }, { current: async () => null } as any);
check("a state really gone is still skipped as changed", d3 && "skip" in d3 && /has changed/.test(d3.skip), d3);

// ---------------------------------------------------------------- 3. a plan is not a meeting
check("met again on a day still ahead: recorded as not yet, the day kept only as the plan's", JSON.stringify(SC.plannedNotHappened("met_again", "2026-11-10", "2026-11-03")) === JSON.stringify({ outcome: "not_yet", metOn: null, planned: true, plannedOn: "2026-11-10" }));
check("review of #376: the same day, said as a plan (\"dinner with her tonight\"): not yet, planned for today", JSON.stringify(SC.plannedNotHappened("met_again", null, "2026-11-03", "Dinner with Ellis tonight")) === JSON.stringify({ outcome: "not_yet", metOn: null, planned: true, plannedOn: "2026-11-03" }) && SC.plannedNotHappened("met_again", "2026-11-03", "2026-11-03", "we're grabbing coffee later today").outcome === "not_yet");
check("review of #376: the same day, said as done: as they said it", SC.plannedNotHappened("met_again", "2026-11-03", "2026-11-03", "had dinner with Ellis tonight, so good").outcome === "met_again" && SC.plannedNotHappened("talked_again", null, "2026-11-03", "we talked this morning").outcome === "talked_again" && SC.plannedNotHappened("met_again", null, "2026-11-03", "grabbed coffee with Ellis").outcome === "met_again");
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
  check(`${onCall ? "call" : "text"}: a meeting still ahead is saved as not yet, never as met, its day kept as the plan's`, facts.length === 1 && meta.outcome === "not_yet" && !("metOn" in meta) && meta.plannedOn === future && /^Hasn't seen Ellis again yet/.test(facts[0].p[3]), { r, facts: facts.map((f) => f.p) });
  check(`${onCall ? "call" : "text"}: the tool tells Cue it was recorded as planned`, r?.ok === true && r?.recorded === "not_yet" && /Never say they met/.test(r?.note ?? ""), r);
}
w = { pointed: [], pairs: [], facts: [], inserts: [] };
const tonight = (onCall = false) => createConversationTools({
  userId: JORDAN, phoneNumber: "+10000000000", resolvedContent: "Dinner with Ellis tonight!", isVoice: onCall, onCall, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
  sendCoReply: async () => true, facts: { add: () => {}, text: () => "" },
} as any).tools as any;
for (const onCall of [false, true]) {
  w = { pointed: [], pairs: [], facts: [], inserts: [] };
  await quiet(() => tonight(onCall).noteMetAgain.execute({ person: "Ellis", outcome: "met_again", note: "dinner tonight" }, { toolCallId: "t3", messages: [] }));
  check(`review of #376, ${onCall ? "call" : "text"}: "dinner with Ellis tonight", picked as met, is saved as not yet`, JSON.parse(w.inserts.find((i) => i.p[2] === "second_contact")?.p[9] ?? "{}").outcome === "not_yet");
}
w = { pointed: [], pairs: [], facts: [], inserts: [] };
await quiet(() => tools().noteMetAgain.execute({ person: "Ellis", outcome: "met_again", note: "coffee", metOn: "2026-10-25" }, { toolCallId: "t2", messages: [] }));
check("a meeting that happened is saved as it was said, with its day", JSON.parse(w.inserts.find((i) => i.p[2] === "second_contact")?.p[9] ?? "{}").metOn === "2026-10-25");

console.log(`connection after: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
