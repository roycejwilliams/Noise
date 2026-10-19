// Replies that land together (room simulation gap A1, Royce 2026-10-14: "collisions come as product bugs"). The fake world waits
// a few seeded milliseconds before every query, so reads and writes from different members interleave the way Postgres round
// trips do, and its locks really hold. Each case runs under many timings. Zero tokens, invented people, test-range numbers.
//   npx tsx evals/inroom/collisions.ts
import { W, reset, addMember, addEvent, ask, check, results, latency, memberTurn, type Member } from "./world.js";

// The clock is pinned to 18:00 UTC today, as in flow.ts: a member with no time zone may only be texted 16:00-24:00 UTC, so an
// unpinned run late at night holds every direct ask for the morning and the cases test nothing.
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

const S = await import("../../src/services/eventScoring.js");
const H = await import("../../src/services/eventGuestMatchHandoff.js");
const O = await import("../../src/services/inRoomOffers.js");
const asM = (m: Member) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number!, email: m.email });
const settle = () => new Promise((r) => setTimeout(r, 30));
const timing = (seed: number) => {
  let s = seed;
  latency.next = () => ((s = (s * 1103515245 + 12345) % 2147483648), s % 7);
};
const askedBy = (texts: string[]) => texts.map((t) => t.match(/^(\w+) from .* would like an intro/)?.[1]).filter((x): x is string => !!x);
const TIMINGS = 20;

// Three people say yes to the same person at the same moment.
async function threeYeses(seed: number, blockFirst = false) {
  reset();
  timing(seed);
  const a1 = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware (1)")] });
  const a2 = addMember({ first_name: "Ellis", intent: [ask("a seed investor for climate hardware (2)")] });
  const a3 = addMember({ first_name: "Ada", intent: [ask("a seed investor for climate hardware (3)")] });
  const b = addMember({ first_name: "Noor", intent: [ask("backing climate hardware founders at seed", "offering")] });
  W.scorer = (t, c) => ({ score: c.id === b.id && /\([123]\)/.test(t) ? 88 : 20, share: true });
  if (blockFirst) W.consentViolation = (msg) => /^Jordan from/.test(msg);
  addEvent({ api_id: "ev", name: "Noise Supper" }, [{ m: a1 }, { m: a2 }, { m: a3 }, { m: b }]);
  await S.scoreGuestListForEvent("ev");
  await settle();
  const before = W.sent.filter((x) => x.to === b.phone_number).length;
  const toB = () => W.sent.filter((x) => x.to === b.phone_number).slice(before).map((x) => x.content);
  await Promise.all([a1, a2, a3].map((a) => memberTurn(a.id, () => H.handleMatchNudgeReply("ev", "Noise Supper", "interested", asM(a), asM(b)))));
  await settle();
  const now = toB();
  const openNow = W.offers.filter((o) => o.person_id === b.id && o.status === "open").length;
  // Noor answers each ask as it comes, until nothing more arrives.
  for (let k = 0; k < 5; k++) {
    const open = W.offers.find((o) => o.person_id === b.id && o.status === "open");
    if (!open) break;
    const asker = [a1, a2, a3].find((a) => a.id === open.asker_id)!;
    await memberTurn(b.id, () => H.handleMatchNudgeReply("ev", "Noise Supper", "not_interested" as any, asM(b), asM(asker)));
    await settle();
  }
  latency.next = null;
  return { now, openNow, all: toB() };
}

{
  const bad: unknown[] = [];
  for (let seed = 1; seed <= TIMINGS; seed++) {
    const r = await threeYeses(seed);
    const names = askedBy(r.all);
    if (r.now.length !== 1 || r.openNow !== 1 || names.length !== 3 || new Set(names).size !== 3) bad.push({ seed, now: r.now, all: r.all });
  }
  check(`three yeses to one person at once: one ask now, one open question, the others wait and each goes exactly once (${TIMINGS} timings)`, bad.length === 0, bad.slice(0, 2));
}
{
  const bad: unknown[] = [];
  for (let seed = 1; seed <= TIMINGS; seed++) {
    const r = await threeYeses(seed, true);
    const names = askedBy(r.all);
    if (names.includes("Jordan") || names.length !== 2 || new Set(names).size !== 2) bad.push({ seed, all: r.all });
  }
  check(`an ask that is blocked frees the slot, and the next one waiting goes (never stuck behind a question never sent) (${TIMINGS} timings)`, bad.length === 0, bad.slice(0, 2));
}

// Two people say yes to each other at the same moment.
{
  const bad: unknown[] = [];
  for (let seed = 1; seed <= TIMINGS; seed++) {
    reset();
    timing(seed);
    const a = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware")] });
    const b = addMember({ first_name: "Noor", intent: [ask("backing climate hardware founders at seed", "offering")] });
    W.scorer = () => ({ score: 88, share: true });
    addEvent({ api_id: "ev", name: "Noise Supper" }, [{ m: a }, { m: b }]);
    await S.scoreGuestListForEvent("ev");
    await settle();
    const before = W.sent.length;
    await Promise.all([memberTurn(a.id, () => H.handleMatchNudgeReply("ev", "Noise Supper", "interested", asM(a), asM(b))), memberTurn(b.id, () => H.handleMatchNudgeReply("ev", "Noise Supper", "interested", asM(b), asM(a)))]);
    await settle();
    latency.next = null;
    const intros = W.memoriesWritten.filter((m) => m.memory_type === "event_intro_email_sent").length;
    const asks = askedBy(W.sent.slice(before).map((x) => x.content));
    if (intros !== 2 || asks.length) bad.push({ seed, intros, asks });
  }
  check(`both say yes at the same moment: one introduction, and nobody is asked about a person they just said yes to (${TIMINGS} timings)`, bad.length === 0, bad.slice(0, 2));
}

// A slot held by a send that never confirmed (the server died while drafting) stops holding it.
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware")] });
  const b = addMember({ first_name: "Noor", intent: [ask("backing climate hardware founders at seed", "offering")] });
  const c = addMember({ first_name: "Ellis", intent: [ask("a seed investor for climate hardware too")] });
  W.offers.push({ event_id: "ev", person_id: b.id, candidate_key: c.id, kind: "direct_ask", candidate_id: c.id, candidate_ids: [], asker_id: c.id, status: "sending", opened_at: new Date(Date.now() - (O.SLOT_CLAIM_MINUTES + 1) * 60_000), created_at: new Date() });
  check("a stale 'sending' slot (older than the claim window) doesn't hold their one question", !(await O.hasOpenOffer(b.id)));
  W.offers[0].opened_at = new Date();
  check("a fresh one does: a new ask for them waits", await O.hasOpenOffer(b.id));
  check("... and is queued, not sent", (await O.claimAskSlot({ eventId: "ev", personId: b.id, candidateId: a.id, askerId: a.id })) === "queued" && W.offers.some((o) => o.person_id === b.id && o.candidate_key === a.id && o.status === "queued"));
}

// A restart cut a direct ask off mid-draft (review of #211): the dead ask goes back in line, and the line moves again.
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware (1)")] });
  const c = addMember({ first_name: "Ellis", intent: [ask("a seed investor for climate hardware (2)")] });
  const b = addMember({ first_name: "Noor", intent: [ask("backing climate hardware founders at seed", "offering")] });
  W.scorer = () => ({ score: 20, share: true });
  addEvent({ api_id: "ev", name: "Noise Supper" }, [{ m: a }, { m: b }, { m: c }]);
  const old = new Date(Date.now() - (O.SLOT_CLAIM_MINUTES + 1) * 60_000);
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: b.id, candidate_key: c.id, kind: "direct_ask", candidate_id: c.id, candidate_ids: [], asker_id: c.id, status: "sending", opened_at: old, created_at: new Date(+old - 1000) });
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: b.id, candidate_key: a.id, kind: "direct_ask", candidate_id: a.id, candidate_ids: [], asker_id: a.id, status: "queued", opened_at: null, created_at: new Date(+old) });
  for (const x of [a, c]) W.optIns.push({ event_id: "ev", person_id: x.id, candidate_id: b.id, status: "interested" }); // both said yes to Noor
  const before = W.sent.filter((x) => x.to === b.phone_number).length;
  const toB = () => askedBy(W.sent.filter((x) => x.to === b.phone_number).slice(before).map((x) => x.content));
  const drained = await H.drainStaleAsks();
  await settle();
  check("after a restart: the ask cut off mid-draft is retried first, and only it goes now", drained === 1 && JSON.stringify(toB()) === JSON.stringify(["Ellis"]), { drained, asked: toB(), offers: W.offers.map((o) => [o.candidate_key === a.id ? "Jordan" : "Ellis", o.status]) });
  await memberTurn(b.id, () => H.handleMatchNudgeReply("ev", "Noise Supper", "not_interested", asM(b), asM(c)));
  await settle();
  check("... and once they answer, the ask that was waiting behind it goes", JSON.stringify(toB()) === JSON.stringify(["Ellis", "Jordan"]), toB());
  check("... and a second drain finds nothing to do", (await H.drainStaleAsks()) === 0);
}
// A member who never answers doesn't hold every intro behind it all night (Royce, 2026-10-19; the room sim's Kai and Tess, room 60):
// past OPEN_SLOT_MINUTES unanswered, the next waiting ask goes, and the earlier question stays open, so it can still be answered.
{
  reset();
  const tess = addMember({ first_name: "Tess", intent: [ask("backing climate hardware founders at seed", "offering")] });
  const kai = addMember({ first_name: "Kai", intent: [ask("a seed investor for climate hardware")] });
  const remy = addMember({ first_name: "Remy", intent: [ask("a sailing crew")] });
  W.scorer = () => ({ score: 20, share: true });
  addEvent({ api_id: "ev", name: "Noise Supper" }, [{ m: tess }, { m: kai }, { m: remy }]);
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000);
  // Tess's question about Remy, never answered; Kai said yes to Tess, and his ask waits behind it.
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: tess.id, candidate_key: remy.id, kind: "nudge", candidate_id: remy.id, candidate_ids: [], asker_id: null, status: "open", opened_at: ago(10), created_at: ago(10) });
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: tess.id, candidate_key: kai.id, kind: "direct_ask", candidate_id: kai.id, candidate_ids: [], asker_id: kai.id, status: "queued", opened_at: null, created_at: ago(9) });
  W.optIns.push({ event_id: "ev", person_id: kai.id, candidate_id: tess.id, status: "interested" });
  const before = W.sent.filter((x) => x.to === tess.phone_number).length;
  const toTess = () => askedBy(W.sent.filter((x) => x.to === tess.phone_number).slice(before).map((x) => x.content));
  await H.drainStaleAsks();
  await settle();
  check("an unanswered question under OPEN_SLOT_MINUTES still holds the slot: Kai's ask waits", toTess().length === 0 && W.offers.find((o) => o.candidate_key === kai.id)?.status === "queued", { asked: toTess(), offers: W.offers.map((o) => [o.candidate_key === kai.id ? "Kai" : "Remy", o.status]) });
  // Royce's 20 minutes (2026-10-19): 21 minutes unanswered.
  W.offers.find((o) => o.candidate_key === remy.id)!.opened_at = ago(21);
  await H.drainStaleAsks();
  await settle();
  check("past OPEN_SLOT_MINUTES unanswered, the next waiting ask goes (Kai's ask reaches Tess)", JSON.stringify(toTess()) === JSON.stringify(["Kai"]), { asked: toTess(), offers: W.offers.map((o) => [o.candidate_key === kai.id ? "Kai" : "Remy", o.status]) });
  check("... and Tess's earlier question isn't expired: it stays open, so it can still be answered", W.offers.find((o) => o.candidate_key === remy.id)?.status === "open");
  check("... and only one ask went (the freed slot is taken again by Kai's)", toTess().length === 1 && W.offers.filter((o) => o.person_id === tess.id && o.status === "queued").length === 0);
}
// A queued ask that won't go never holds the line (review of #211): the next one goes.
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware (1)")] });
  const c = addMember({ first_name: "Ellis", intent: [ask("a seed investor for climate hardware (2)")] });
  const b = addMember({ first_name: "Noor", intent: [ask("backing climate hardware founders at seed", "offering")] });
  W.scorer = () => ({ score: 20, share: true });
  addEvent({ api_id: "ev", name: "Noise Supper" }, [{ m: a }, { m: b }, { m: c }]);
  // Ellis's ask waits first, but Noor already said no to Ellis tonight: it can never go.
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: b.id, candidate_key: c.id, kind: "direct_ask", candidate_id: c.id, candidate_ids: [], asker_id: c.id, status: "queued", opened_at: null, created_at: new Date(Date.now() - 2000) });
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: b.id, candidate_key: a.id, kind: "direct_ask", candidate_id: a.id, candidate_ids: [], asker_id: a.id, status: "queued", opened_at: null, created_at: new Date(Date.now() - 1000) });
  W.nudges.push({ event_id: "ev", person_id: b.id, candidate_id: c.id, status: "not_interested", score: 80, created_at: new Date() } as any);
  for (const x of [a, c]) W.optIns.push({ event_id: "ev", person_id: x.id, candidate_id: b.id, status: "interested" });
  const before = W.sent.filter((x) => x.to === b.phone_number).length;
  await H.sendNextQueued(b.id);
  await settle();
  const asked = askedBy(W.sent.filter((x) => x.to === b.phone_number).slice(before).map((x) => x.content));
  check("an ask at the head of the line that can't go leaves it, and the next one goes", JSON.stringify(asked) === JSON.stringify(["Jordan"]) && W.offers.find((o) => o.candidate_key === c.id)?.status === "expired", { asked, offers: W.offers.map((o) => [o.candidate_key === a.id ? "Jordan" : "Ellis", o.status]) });
}
// A waiting ask while another ask to the same person is held for their morning or the pause (review of #211): it waits, never dropped.
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware (1)")] });
  const b = addMember({ first_name: "Noor", intent: [ask("backing climate hardware founders at seed", "offering")] });
  W.scorer = () => ({ score: 20, share: true });
  addEvent({ api_id: "ev", name: "Noise Supper" }, [{ m: a }, { m: b }]);
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: b.id, candidate_key: a.id, kind: "direct_ask", candidate_id: a.id, candidate_ids: [], asker_id: a.id, status: "queued", opened_at: null, created_at: new Date() });
  W.optIns.push({ event_id: "ev", person_id: a.id, candidate_id: b.id, status: "interested" });
  (W as any).deferredAsks = new Set([`${b.id}|direct_ask:`]);
  await H.sendNextQueued(b.id);
  await settle();
  check("an ask waiting behind one held for their morning or the pause stays in line (never dropped)", W.offers.find((o) => o.candidate_key === a.id)?.status === "queued", W.offers.map((o) => o.status));
  (W as any).deferredAsks = new Set();
}
check("every query the cases ran is one the fake world knows exactly (a changed slot query fails here)", W.unknownSql.size === 0, [...W.unknownSql].slice(0, 5));

const { total, failed } = results;
console.log(`in-room collisions: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
