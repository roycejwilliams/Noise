// The names a member's lines are stripped of come only from their own side (memberSafeMemories.ts MEMBER_NAMES_SQL, NETWORK_NAMES_SQL,
// namesInRecords), in the fake world of evals/inroom/world.ts (its mirror of the SQL, the real double opt-in, ask and send). Zero tokens.
//   npx tsx evals/review/memberNamesOwnSide.ts
// 2026-10-28, Royce: no cross-member leaks. A name on the list is stripped out loud: "Sarah, another member, came up here" (historyLine),
// in the reply's context and on their what-Cue-knows page. The list used to add Sarah to Jo's when Sarah was nudged about Jo, said yes
// about Jo, was asked about Jo, or when Jo was among the people an additive offer counted for her, before anyone told Jo a thing. Then
// the first line of Jo's that said "Sarah" (his sister, or the same Sarah) came back to him as "Sarah, another member".
//   1. Each read from the other side's state alone adds no one; each thing Jo was told or did adds the person.
//   2. Through the real double opt-in: Sarah's yes and an ask to Jo that didn't reach him leave Jo's list as it was; the ask that
//      reaches him adds her.
//   3. Cue's records: a tease that never named the person adds no one; a named offer does.
import { readFileSync } from "node:fs";
import { W, reset, addMember, addEvent, ask } from "../inroom/world.js";

// Pinned to 18:00 UTC, as evals/review/introTrace.ts: a member with no time zone is texted 16:00-24:00 UTC, so a direct ask goes now.
{
  const RealDate = Date;
  const pinned = new RealDate();
  pinned.setUTCHours(18, 0, 0, 0);
  const offset = pinned.getTime() - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...a: any[]) {
      super(...((a.length ? a : [RealDate.now() + offset]) as [any]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  (globalThis as any).Date = PinnedDate;
}

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const MS = await import("../../src/services/memberSafeMemories.js");
const H = await import("../../src/services/eventGuestMatchHandoff.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");
const worldSend = (sendblue as any).messages.send;
const log = console.log, err = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };

const EV = "evt-own";
const build = () => {
  reset();
  const jo = addMember({ first_name: "Jo", last_name: "Lee", intent: [ask("a cofounder for a climate startup")] });
  const sarah = addMember({ first_name: "Sarah", last_name: "Kim", intent: [ask("a cofounder for a climate startup")] });
  addEvent({ api_id: EV, name: "Cue Night" }, [{ m: jo }, { m: sarah }]);
  return { jo, sarah };
};
const pairOf = (x: string, y: string, extra: Record<string, unknown> = {}) => ({ id: `p-${W.pairs.length}`, event_id: EV, a_id: [x, y].sort()[0], b_id: [x, y].sort()[1], origin: "co", state: "asked", created_at: new Date(), intro_sent_at: null, ...extra });
const offer = (person: string, candidate: string | null, extra: Record<string, unknown> = {}) => ({ event_id: EV, person_id: person, candidate_key: candidate ?? "additive", kind: "nudge", candidate_id: candidate, candidate_ids: [], status: "open", opened_at: new Date(), created_at: new Date(), ...extra });
// Jo's own line that says "Sarah": as his context reads it back with this list.
const joLine = (names: string[]) => MS.safeMemory("text_exchange", "Co replied: That sounds hard. Is Sarah still helping with the move?", names);

// ------------------------------------------------------------ 1. the other side's state adds no one; Jo's own side does
const cases: { label: string; set: (w: ReturnType<typeof build>) => void; jo: boolean }[] = [
  { label: "Sarah was nudged about Jo", set: ({ jo, sarah }) => W.nudges.push({ event_id: EV, person_id: sarah.id, candidate_id: jo.id, score: 80, pending: false, anonymous: false }), jo: false },
  { label: "Sarah said yes about Jo", set: ({ jo, sarah }) => W.optIns.push({ event_id: EV, person_id: sarah.id, candidate_id: jo.id, status: "interested" }), jo: false },
  { label: "Sarah passed on Jo", set: ({ jo, sarah }) => W.optIns.push({ event_id: EV, person_id: sarah.id, candidate_id: jo.id, status: "declined" }), jo: false },
  { label: "Sarah was asked about Jo (an open question to her)", set: ({ jo, sarah }) => W.offers.push(offer(sarah.id, jo.id, { kind: "direct_ask", asker_id: jo.id })), jo: false },
  { label: "Jo was among the people an additive offer counted for Sarah", set: ({ jo, sarah }) => W.offers.push(offer(sarah.id, null, { kind: "additive", candidate_ids: [jo.id] })), jo: false },
  { label: "Sarah was among the people an additive offer counted for Jo (never named to him)", set: ({ jo, sarah }) => W.offers.push(offer(jo.id, null, { kind: "additive", candidate_ids: [sarah.id] })), jo: false },
  { label: "a direct ask to Jo about Sarah is queued (it hasn't reached him)", set: ({ jo, sarah }) => W.offers.push(offer(jo.id, sarah.id, { kind: "direct_ask", status: "queued", opened_at: null, asker_id: sarah.id })), jo: false },
  { label: "a direct ask to Jo about Sarah is still being sent", set: ({ jo, sarah }) => W.offers.push(offer(jo.id, sarah.id, { kind: "direct_ask", status: "sending", asker_id: sarah.id })), jo: false },
  { label: "a queued ask to Jo expired with the room, never sent", set: ({ jo, sarah }) => W.offers.push(offer(jo.id, sarah.id, { kind: "direct_ask", status: "expired", opened_at: null, asker_id: sarah.id })), jo: false },
  { label: "a nudge to Jo about Sarah is claimed but not sent (pending)", set: ({ jo, sarah }) => W.nudges.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, score: 80, pending: true, anonymous: false }), jo: false },
  { label: "Jo got an anonymous heads-up (it names no one)", set: ({ jo, sarah }) => W.nudges.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, score: 80, pending: false, anonymous: true }), jo: false },
  {
    label: "Jo said yes to that anonymous heads-up (he still doesn't know who)",
    set: ({ jo, sarah }) => { W.nudges.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, score: 80, pending: false, anonymous: true }); W.optIns.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, status: "interested" }); },
    jo: false,
  },
  { label: "Cue nudged Jo about Sarah by name", set: ({ jo, sarah }) => W.nudges.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, score: 80, pending: false, anonymous: false }), jo: true },
  { label: "a question about Sarah reached Jo", set: ({ jo, sarah }) => W.offers.push(offer(jo.id, sarah.id)), jo: true },
  { label: "a question about Sarah reached Jo and he answered it", set: ({ jo, sarah }) => W.offers.push(offer(jo.id, sarah.id, { status: "answered" })), jo: true },
  { label: "a question about Sarah reached Jo and expired with the room", set: ({ jo, sarah }) => W.offers.push(offer(jo.id, sarah.id, { status: "expired" })), jo: true },
  { label: "Jo answered about Sarah (a pair Cue suggested)", set: ({ jo, sarah }) => { W.pairs.push(pairOf(jo.id, sarah.id)); W.optIns.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, status: "declined" }); }, jo: true },
  {
    label: "the intro email went after an anonymous heads-up",
    set: ({ jo, sarah }) => { W.nudges.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, score: 80, pending: false, anonymous: true }); W.pairs.push(pairOf(jo.id, sarah.id, { state: "intro_sent", intro_sent_at: new Date() })); },
    jo: true,
  },
  {
    label: "both said yes before co_pairs existed (the yeses sent the email)",
    set: ({ jo, sarah }) => { W.optIns.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, status: "interested" }, { event_id: EV, person_id: sarah.id, candidate_id: jo.id, status: "interested" }); W.nudges.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, score: 80, pending: false, anonymous: true }); },
    jo: true,
  },
  {
    label: "Jo asked for Sarah by name and the intro wasn't made",
    set: ({ jo, sarah }) => { W.pairs.push(pairOf(jo.id, sarah.id, { origin: "member" })); W.optIns.push({ event_id: EV, person_id: jo.id, candidate_id: sarah.id, status: "interested" }); },
    jo: false,
  },
];
for (const c of cases) {
  const w = build();
  c.set(w);
  const names = await MS.memberNamesStrict(w.jo.id);
  const line = joLine(names) ?? "";
  if (c.jo) check(`${c.label}: Sarah is on Jo's list, and Cue's own line about her is cut`, names.includes("Sarah") && /Sarah, another member/.test(line), { names, line });
  else check(`${c.label}: Sarah is not on Jo's list, and Jo's line about "Sarah" reads as written`, !names.includes("Sarah") && !/another member/.test(line) && /Is Sarah still helping with the move\?/.test(line), { names, line });
}
{
  // The other way round, for the pairs where only Jo was told: Sarah's list gets Jo only from her own side too.
  const w = build();
  W.nudges.push({ event_id: EV, person_id: w.jo.id, candidate_id: w.sarah.id, score: 80, pending: false, anonymous: false });
  W.optIns.push({ event_id: EV, person_id: w.jo.id, candidate_id: w.sarah.id, status: "interested" });
  const sarahNames = await MS.memberNamesStrict(w.sarah.id);
  check("Jo was nudged about Sarah and said yes: Jo isn't on Sarah's list until Cue asks her", !sarahNames.includes("Jo"), sarahNames);
}

// ------------------------------------------------------------ 2. through the real double opt-in
{
  // Cue nudged Sarah about Jo; Jo heard nothing. Sarah says yes, and the direct ask to Jo fails to send.
  const w = build();
  W.nudges.push({ event_id: EV, person_id: w.sarah.id, candidate_id: w.jo.id, score: 80, pending: false, anonymous: false });
  W.offers.push(offer(w.sarah.id, w.jo.id));
  W.pairs.push(pairOf(w.jo.id, w.sarah.id, { asked_a_at: null, asked_b_at: null, state: "asked" }));
  const joBefore = await MS.memberNamesStrict(w.jo.id);
  (sendblue as any).messages.send = async (body: any) => { if (body.number === w.jo.phone_number) throw new Error("carrier rejected"); return worldSend(body); };
  await quiet(() => H.handleMatchNudgeReply(EV, "Cue Night", "interested", { user_id: w.sarah.id, first_name: "Sarah", phone_number: w.sarah.phone_number!, email: w.sarah.email }, { user_id: w.jo.id, first_name: "Jo", phone_number: w.jo.phone_number!, email: w.jo.email }));
  (sendblue as any).messages.send = worldSend;
  const joUnreached = await MS.memberNamesStrict(w.jo.id);
  const sarahNames = await MS.memberNamesStrict(w.sarah.id);
  check("Sarah was nudged about Jo: he isn't told, and she isn't on his list", !joBefore.includes("Sarah"), joBefore);
  check("Sarah said yes and the ask to Jo didn't reach him: still not on his list (her yes is her side)", W.optIns.some((o) => o.person_id === w.sarah.id && o.candidate_id === w.jo.id) && W.sent.filter((s) => s.to === w.jo.phone_number).length === 0 && !joUnreached.includes("Sarah"), { joUnreached, sent: W.sent });
  check("…and Jo is on Sarah's list all along: Cue named him to her", sarahNames.includes("Jo"), sarahNames);
}
{
  const w = build();
  W.nudges.push({ event_id: EV, person_id: w.sarah.id, candidate_id: w.jo.id, score: 80, pending: false, anonymous: false });
  W.offers.push(offer(w.sarah.id, w.jo.id));
  W.pairs.push(pairOf(w.jo.id, w.sarah.id, { asked_a_at: null, asked_b_at: null, state: "asked" }));
  await quiet(() => H.handleMatchNudgeReply(EV, "Cue Night", "interested", { user_id: w.sarah.id, first_name: "Sarah", phone_number: w.sarah.phone_number!, email: w.sarah.email }, { user_id: w.jo.id, first_name: "Jo", phone_number: w.jo.phone_number!, email: w.jo.email }));
  const joAsked = await MS.memberNamesStrict(w.jo.id);
  check("the ask reaches Jo (it names Sarah): from then on she's on his list", W.sent.filter((s) => s.to === w.jo.phone_number).length === 1 && joAsked.includes("Sarah"), { joAsked, sent: W.sent });
}

// ------------------------------------------------------------ 3. Cue's records
{
  const candidate = { candidate_id: "x", first_name: "Celine", match_reason: "both building in climate", share_safe: true };
  const tease = { memory_type: "network_offer_pending", content: JSON.stringify({ askId: "a1", candidate }) };
  const named = { memory_type: "network_intro_offer_pending", content: JSON.stringify({ askId: "a1", candidate }) };
  check("a tease that never named the person adds no one to the list", MS.namesInRecords([tease]).length === 0, MS.namesInRecords([tease]));
  check("…and is still rewritten to an unnamed line on its own", MS.safeMemory("network_offer_pending", tease.content, []) === "Cue mentioned that another member could be worth meeting, without naming them.");
  check("a named intro offer adds the person it named", JSON.stringify(MS.namesInRecords([named])) === JSON.stringify(["Celine"]), MS.namesInRecords([named]));
  const rows = await MS.memberSafe("u-test", [tease, { memory_type: "text_exchange", content: "Co replied: How was dinner with Celine?" }], []);
  check("a tease in the same batch doesn't turn their own Celine into 'another member'", rows[1] === "Co replied: How was dinner with Celine?", rows);
}

// ------------------------------------------------------------ 4. the network read is own-side, in its SQL
{
  const sql = MS.NETWORK_NAMES_SQL.replace(/\s+/g, " ");
  check("network intros add the other person only once introduced or on this member's own yes", /n\.status = 'introduced' OR \(CASE WHEN n\.person_a_id = \$1 THEN n\.a_interested_at ELSE n\.b_interested_at END\) IS NOT NULL/.test(sql), sql);
  const ev = MS.MEMBER_NAMES_SQL.replace(/\s+/g, " ");
  check("no event read takes a name from the other side: nothing reads WHERE candidate_id = $1 or $1 = ANY(candidate_ids)", !/candidate_id = \$1|\$1 = ANY\(candidate_ids\)|unnest\(candidate_ids\)/.test(ev), ev);
}

// A stuck send expired at room close never counts as reached (review of #295): its opened_at is cleared as it expires.
check("room close clears opened_at on asks that never went out", /opened_at = CASE WHEN status IN \('queued', 'sending'\) THEN NULL ELSE opened_at END/.test(readFileSync(new URL("../../src/services/roomMatching.ts", import.meta.url), "utf8")));
console.log(`member names, own side: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
