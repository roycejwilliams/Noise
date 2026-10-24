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
// Two questions open for one person (review of #211, the probe): Tess's question about Remy is 21 minutes unanswered, Kai's ask goes,
// and her bare "yes" bound to Kai, the newest, and sent Kai's intro email. Now a reply binds only if it names one; a bare yes records
// nothing and sends nothing, and Cue asks which, by the two first names it already told her. At most two open at once.
const MR = await import("../../src/services/messageRouter.js");
const routed = (itemId: string): any => ({ answers: { itemId, value: "yes" }, ambiguousBetween: [], call: "none", wantsRecommendation: false, confidence: "high", reason: "a yes" });
async function twoOpen() {
  reset();
  const tess = addMember({ first_name: "Tess", intent: [ask("backing climate hardware founders at seed", "offering")] });
  const kai = addMember({ first_name: "Kai", intent: [ask("a seed investor for climate hardware")] });
  const remy = addMember({ first_name: "Remy", intent: [ask("a sailing crew")] });
  const noor = addMember({ first_name: "Noor", intent: [ask("a seed investor for climate hardware too")] });
  W.scorer = () => ({ score: 20, share: true });
  addEvent({ api_id: "ev", name: "Noise Supper" }, [{ m: tess }, { m: kai }, { m: remy }, { m: noor }]);
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000);
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: tess.id, candidate_key: remy.id, kind: "nudge", candidate_id: remy.id, candidate_ids: [], asker_id: null, status: "open", opened_at: ago(21), created_at: ago(21) });
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: tess.id, candidate_key: kai.id, kind: "direct_ask", candidate_id: kai.id, candidate_ids: [], asker_id: kai.id, status: "queued", opened_at: null, created_at: ago(9) });
  W.optIns.push({ event_id: "ev", person_id: kai.id, candidate_id: tess.id, status: "interested" });
  await H.drainStaleAsks();
  await settle();
  const pendings = await H.findPendingMatchNudges(tess.id);
  const items = await MR.matchNudgeItems(tess.id, pendings);
  // As in the probe: Remy's question went 21 minutes ago, she said something else since, and Cue's last message is Kai's ask alone
  // (so the older "Cue asked two things at once" check doesn't apply).
  const convo = `Co replied: Remy is here tonight and worth meeting. Want an intro?\nUser said: one sec, grabbing a drink\nCo replied: Ha, enjoy.\nCo replied: Kai from Noise Supper would like an intro. Open to it?`;
  const itemFor = (m: Member) => items.find((i) => i.detail === m.first_name)!;
  // The route's own step (routes/sendblue.ts): only a resolved match_nudge reaches handleMatchNudgeReply.
  const reply = async (message: string, out: any) => {
    const d = MR.decideActions(out, items, { message, recentConversation: convo });
    if (d.resolve?.item.kind === "match_nudge" && d.resolve.item.ref?.kind === "match_nudge") {
      const p = d.resolve.item.ref.pending;
      await memberTurn(tess.id, () => H.handleMatchNudgeReply(p.event_id, p.event_name, d.resolve!.value === "yes" ? "interested" : "not_interested", asM(tess), { user_id: p.candidate_id, first_name: p.candidate_first_name, phone_number: p.candidate_phone, email: p.candidate_email }));
      await settle();
    }
    return d;
  };
  const emails = () => W.memoriesWritten.filter((m) => m.memory_type === "event_intro_email_sent").length;
  const tessYes = () => W.optIns.filter((o) => o.person_id === tess.id && o.status === "interested").map((o) => W.members.get(o.candidate_id)?.first_name);
  return { tess, kai, remy, noor, pendings, items, itemFor, reply, emails, tessYes };
}
{
  const t = await twoOpen();
  check("two open: Kai's ask went after 21 minutes, so Tess has two questions open, and the reply path sees both", t.items.length === 2 && JSON.stringify(t.items.map((i) => i.detail).sort()) === JSON.stringify(["Kai", "Remy"]), t.items.map((i) => i.detail));
  const d = await t.reply("yes", routed(t.itemFor(t.kai).id));
  check("the probe: Tess's bare 'yes' (read as Kai's, the newest) binds to nothing: no intro email, no yes recorded", !d.resolve && t.emails() === 0 && t.tessYes().length === 0, { resolve: d.resolve?.item.id, emails: t.emails(), yes: t.tessYes() });
  check("... both questions stay open", W.offers.filter((o) => o.person_id === t.tess.id && o.status === "open").length === 2);
  check("... and Cue is told to ask which, by the two first names it already told her", d.clarifyAbout === "items" && /\bRemy\b/.test(d.clarifyContext) && /\bKai\b/.test(d.clarifyContext), d.clarifyContext);
  const leak = [t.noor.first_name, t.kai.email, t.kai.phone_number, t.remy.email, t.remy.phone_number, "seed investor", "sailing"].filter((x) => x && d.clarifyContext.includes(String(x)));
  check("... and nothing about anyone else reaches it: no other member's name, no contact details, no one's asks", leak.length === 0, leak);
  const d2 = await t.reply("yes!", routed(t.itemFor(t.remy).id));
  check("a bare yes read as the older question binds to nothing either", !d2.resolve && t.emails() === 0 && t.tessYes().length === 0);
  const d3 = await t.reply("yes to Remy and Kai", routed(t.itemFor(t.kai).id));
  check("a yes naming both binds to nothing (it doesn't identify one)", !d3.resolve && t.emails() === 0 && t.tessYes().length === 0);
}
{
  const t = await twoOpen();
  const d = await t.reply("yes, Kai sounds great", routed(t.itemFor(t.kai).id));
  check("a yes naming Kai binds to Kai: the intro goes (Kai already said yes; one introduction, a line on each side)", d.resolve?.item.detail === "Kai" && t.emails() === 2 && W.memoriesWritten.filter((m) => m.memory_type === "event_intro_email_sent").every((m) => [t.tess.id, t.kai.id].includes(m.user_id)) && JSON.stringify(t.tessYes()) === JSON.stringify(["Kai"]), { resolve: d.resolve?.item.detail, emails: t.emails(), yes: t.tessYes() });
  check("... and Remy's question stays open", W.offers.find((o) => o.person_id === t.tess.id && o.candidate_key === t.remy.id)?.status === "open");
}
{
  const t = await twoOpen();
  const d = await t.reply("remy yes", routed(t.itemFor(t.kai).id));
  check("a yes naming Remy never binds to Kai, even when the reader picked Kai", !d.resolve && t.emails() === 0 && t.tessYes().length === 0);
  const d2 = await t.reply("remy yes", routed(t.itemFor(t.remy).id));
  check("... and read as Remy's, it binds to Remy: her yes is recorded, no email (Remy hasn't said yes)", d2.resolve?.item.detail === "Remy" && t.emails() === 0 && JSON.stringify(t.tessYes()) === JSON.stringify(["Remy"]));
}
{
  // Two open questions about two people who share a first name: the name can't tell them apart.
  const items = [{ id: "match_nudge:ev:a", kind: "match_nudge" as const, detail: "Remy", description: "", askedAt: null }, { id: "match_nudge:ev:b", kind: "match_nudge" as const, detail: "Remy", description: "", askedAt: null }];
  check("two open questions about two Remys: 'yes Remy' binds to neither", !MR.namesOneOpenIntro(items[0], items, "yes Remy") && !MR.namesOneOpenIntro(items[1], items, "yes Remy"));
  const additive = [{ id: "match_nudge:ev:additive", kind: "match_nudge" as const, detail: null, description: "", askedAt: null }, items[0]];
  check("an additive offer (names nobody) with another question open: a bare yes binds to neither", !MR.namesOneOpenIntro(additive[0], additive, "yes") && !MR.namesOneOpenIntro(additive[1], additive, "yes"));
  check("a name inside another word isn't the name ('Kaitlyn' isn't Kai)", !MR.namesOneOpenIntro({ id: "k", kind: "match_nudge", detail: "Kai" }, [{ id: "k", kind: "match_nudge", detail: "Kai" }, { id: "r", kind: "match_nudge", detail: "Remy" }], "Kaitlyn said hi, yes"));
}
{
  // One question open: unchanged (the bare yes binds, as before).
  reset();
  const tess = addMember({ first_name: "Tess", intent: [ask("backing climate hardware founders at seed", "offering")] });
  const kai = addMember({ first_name: "Kai", intent: [ask("a seed investor for climate hardware")] });
  W.scorer = () => ({ score: 20, share: true });
  addEvent({ api_id: "ev", name: "Noise Supper" }, [{ m: tess }, { m: kai }]);
  W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id: tess.id, candidate_key: kai.id, kind: "direct_ask", candidate_id: kai.id, candidate_ids: [], asker_id: kai.id, status: "open", opened_at: new Date(Date.now() - 60_000), created_at: new Date() });
  W.optIns.push({ event_id: "ev", person_id: kai.id, candidate_id: tess.id, status: "interested" });
  const items = await MR.matchNudgeItems(tess.id, await H.findPendingMatchNudges(tess.id));
  const d = MR.decideActions(routed(items[0]?.id ?? ""), items, { message: "yes", recentConversation: "Co replied: Kai from Noise Supper would like an intro. Open to it?" });
  check("one question open: a bare yes binds to it, as before", items.length === 1 && d.resolve?.item.detail === "Kai" && !d.clarifyContext, { items: items.map((i) => i.detail), resolve: d.resolve?.item.detail });
}
{
  // The pileup: two questions open, both past OPEN_SLOT_MINUTES; a third ask waits, the 5-minute drain never sends it, and no nudge
  // or additive offer opens a third.
  const t = await twoOpen();
  const ellis = addMember({ first_name: "Ellis", intent: [ask("a seed investor for climate hardware (3)")] });
  W.optIns.push({ event_id: "ev", person_id: ellis.id, candidate_id: t.tess.id, status: "interested" });
  for (const o of W.offers.filter((x) => x.person_id === t.tess.id && x.status === "open")) o.opened_at = new Date(Date.now() - 45 * 60_000);
  check("two open past the 20 minutes: the slot stays taken", await O.hasOpenOffer(t.tess.id));
  check("... a new ask is queued, not sent", (await O.claimAskSlot({ eventId: "ev", personId: t.tess.id, candidateId: ellis.id, askerId: ellis.id })) === "queued");
  const before = W.sent.filter((x) => x.to === t.tess.phone_number).length;
  for (let k = 0; k < 3; k++) await H.drainStaleAsks();
  await settle();
  check("... and the drain never sends it while two are open", W.sent.filter((x) => x.to === t.tess.phone_number).length === before && W.offers.filter((o) => o.person_id === t.tess.id && o.status === "open").length === 2 && W.offers.find((o) => o.candidate_key === ellis.id)?.status === "queued");
  const src = (await import("node:fs")).readFileSync(new URL("../../src/services/eventScoring.ts", import.meta.url), "utf8");
  check("... and a match nudge or an additive offer waits too (each claims its place under the slot lock before drafting)", /O\.claimOfferSlot\(\{[^}]*kind: "nudge"/.test(src) && /O\.claimOfferSlot\(\{[^}]*kind: "additive"/.test(src) && !/openQuestionCount/.test(src) && !(await O.claimOfferSlot({ eventId: "ev", personId: t.tess.id, kind: "nudge", candidateId: ellis.id })));
  // Tess answers one by name: the slot frees and Ellis's ask goes.
  await memberTurn(t.tess.id, () => H.handleMatchNudgeReply("ev", "Noise Supper", "not_interested", asM(t.tess), asM(t.remy)));
  await settle();
  check("... once she answers one, the waiting ask goes", W.sent.filter((x) => x.to === t.tess.phone_number).length === before + 1 && W.offers.find((o) => o.candidate_key === ellis.id)?.status === "open");
}
// A nudge or an additive heads-up takes its place under the same lock as a direct ask, counting what's open AND on its way (review of
// #211: one open, one direct ask on its way and a nudge made three; the nudge only counted open rows, then opened after its send).
const offer = (person_id: string, candidate_key: string, status: string, kind = "direct_ask", minsAgo = 1) => W.offers.push({ event_id: "ev", event_name: "Noise Supper", person_id, candidate_key, kind, candidate_id: kind === "additive" ? null : candidate_key, candidate_ids: [], asker_id: null, status, opened_at: new Date(Date.now() - minsAgo * 60_000), created_at: new Date() });
const inPlay = (id: string) => W.offers.filter((o) => o.person_id === id && (o.status === "open" || o.status === "sending")).length;
{
  reset();
  const tess = addMember({ first_name: "Tess" });
  offer(tess.id, "remy", "open", "direct_ask", 45);
  offer(tess.id, "ellis", "sending");
  check("one open + one direct ask on its way + a match nudge: the nudge gets no place (never three)", (await O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "nudge", candidateId: "kai" })) === null && inPlay(tess.id) === 2);
  check("... nor an additive offer", (await O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "additive", candidateIds: ["kai"] })) === null && inPlay(tess.id) === 2);
}
let raceMax = 0;
for (let seed = 1; seed <= TIMINGS; seed++) {
  // The same at the same moment: one open, then a direct ask and two nudges race for her places.
  reset();
  timing(seed);
  const tess = addMember({ first_name: "Tess" });
  offer(tess.id, "remy", "open", "direct_ask", 45);
  await Promise.all([
    O.claimAskSlot({ eventId: "ev", personId: tess.id, candidateId: "ellis", askerId: "ellis" }),
    O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "nudge", candidateId: "kai" }),
    O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "nudge", candidateId: "jo" }),
  ]);
  raceMax = Math.max(raceMax, inPlay(tess.id));
}
latency.next = () => 0;
check(`a direct ask and two nudges racing beside one open question: never more than two open or on their way (${TIMINGS} timings)`, raceMax === 2, raceMax);
{
  reset();
  const tess = addMember({ first_name: "Tess" });
  offer(tess.id, "remy", "open", "direct_ask", 45);
  check("an additive offer (it names no one) doesn't open while another question is open", (await O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "additive", candidateIds: ["kai"] })) === null && !W.offers.some((o) => o.candidate_key === "additive"));
  W.offers.find((o) => o.candidate_key === "remy")!.status = "answered";
  offer(tess.id, "ellis", "sending");
  check("... nor while a direct ask is on its way", (await O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "additive", candidateIds: ["kai"] })) === null);
  W.offers.splice(W.offers.findIndex((o) => o.candidate_key === "ellis"), 1);
  offer(tess.id, "additive", "answered", "additive", 90);
  const claim = await O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "additive", candidateIds: ["kai"] });
  check("... with nothing else open it takes its place (its own earlier, answered heads-up doesn't count)", !!claim && W.offers.find((o) => o.candidate_key === "additive")?.status === "sending");
  await O.releaseOfferSlot(claim!);
  check("... and a send that doesn't happen puts the earlier heads-up back as it was", W.offers.find((o) => o.candidate_key === "additive")?.status === "answered");
  const nudge = await O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "nudge", candidateId: "kai" });
  await O.releaseOfferSlot(nudge!);
  check("... a released nudge place with nothing before it is gone", !!nudge && !W.offers.some((o) => o.candidate_key === "kai"));
  const held = await O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "nudge", candidateId: "zed" });
  const threw = await O.draftingInSlot(held!, async () => { throw new Error("draft crashed"); }).then(() => false, () => true);
  check("a draft that throws frees the nudge's place (and the error still goes on)", threw && !W.offers.some((o) => o.candidate_key === "zed"));
  const kept = await O.claimOfferSlot({ eventId: "ev", personId: tess.id, kind: "nudge", candidateId: "zed" });
  const got = await O.draftingInSlot(kept!, async () => "a draft");
  check("... a draft that returns leaves it held for the send", got === "a draft" && W.offers.find((o) => o.candidate_key === "zed")?.status === "sending");
  await O.releaseOfferSlot(kept!);
  const es = (await import("node:fs")).readFileSync(new URL("../../src/services/eventScoring.ts", import.meta.url), "utf8");
  check("... and the match nudge's own claim is released when its draft throws, so a later pass can retry", /draftFn\)\)\.catch\(async \(err: any\) => \{\n[^\n]*\n\s+await releaseMatchNudgeClaim\(eventId, person\.user_id\)\.catch\(\(\) => \{\}\);\n\s+throw err;/.test(es));
  offer(tess.id, "kai", "sending", "nudge", 30);
  check("a nudge claim that never confirmed is never put in the direct-ask line", (await O.requeueStaleAsks()).length === 0 && W.offers.find((o) => o.candidate_key === "kai")?.status === "sending");
}
check("every query the cases ran is one the fake world knows exactly (a changed slot query fails here)", W.unknownSql.size === 0, [...W.unknownSql].slice(0, 5));

const { total, failed } = results;
console.log(`in-room collisions: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
