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

const { total, failed } = results;
console.log(`in-room collisions: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
