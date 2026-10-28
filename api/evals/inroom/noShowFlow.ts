// The no-show flow for Noise's own events (services/eventNoShow.ts, decided 2026-10-23): the one "did you make it?" ask about 45
// minutes in, "yes I'm here" counting as arrived, "no" or silence (with the door tracked) getting the note, and the note itself:
// never a name or anything about who came, an intro offer only with a strong consenting fit. Zero tokens, invented people,
// test-range numbers, the fake world of evals/inroom/world.ts.
//   npx tsx evals/inroom/noShowFlow.ts
import { W, reset, addMember, addEvent, ask, check, results, type Member } from "./world.js";

// Pinned to 18:00 UTC today (11am Pacific, inside everyone's hours), as in flow.ts.
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

const N = await import("../../src/services/eventNoShow.js");
const P = await import("../../src/services/eventPresence.js");
const PA = await import("../../src/services/preArrival.js");
const U = await import("../../src/services/eventUnmatchedFollowUp.js");
const S = await import("../../src/services/eventScoring.js");
const PR = await import("../../src/harness/proactive.js");
const { readFileSync } = await import("node:fs");
N.openTestNumbersForTests(true);

const MIN = 60_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const later = (h: number) => new Date(Date.now() + h * 3_600_000);
const sentTo = (m: Member) => W.sent.filter((s) => s.to === m.phone_number);
const asksTo = (m: Member) => sentTo(m).filter((s) => /^Did you make it to /.test(s.content));
const fresh = () => {
  reset();
  P.clearPresenceCache();
};
// A night 50 minutes in, 40 minutes to go: the ask is due and the end-of-night close is due too.
const night = (api_id: string, guests: Member[], o: Record<string, unknown> = {}) => addEvent({ api_id, name: "Noise Supper", start_at: iso(-50 * MIN), end_at: iso(40 * MIN), ...o }, guests.map((m) => ({ m })));
const checkIn = (ev: string, m: Member) => {
  const g = W.events.get(ev)!.guests.find((x) => x.email === m.email) as any;
  g.checked_in_at = new Date().toISOString();
};
const asCandidate = (row: any): any => ({ id: "1", userId: row.user_id, type: row.type, targetKey: row.target_key, topicKey: row.topic_key, summary: row.summary, priority: 88, dueAt: row.due_at, expiresAt: row.expires_at, payload: row.payload, attempts: 0, createdAt: new Date() });
const person = (m: Member) => ({ userId: m.id, firstName: m.first_name, phoneNumber: m.phone_number!, city: null, timezone: null });
const deps = (o: Partial<import("../../src/services/eventNoShow.js").NoteDeps> = {}) => ({ approved: true, struggling: async () => false, about: async () => "A long supper about building things that last.", now: () => new Date(), ...o });
const noteFor = (m: Member) => W.candidates.find((c) => c.user_id === m.id && c.type === "noshow_note");
const allNames = () => [...W.members.values()].map((m) => m.first_name);
const textOf = (r: any) => ("messages" in r ? r.messages.join(" ") : "");
const nameIn = (t: string, self: string) => allNames().filter((n) => n !== self).find((n) => new RegExp(`\\b${n}\\b`).test(t)) ?? null;
// Their reply, a moment after the ask.
const said = (m: Member, content: string) => W.memoriesWritten.push({ user_id: m.id, memory_type: "text_exchange", content: `User said: ${content}`, created_at: new Date(Date.now() + 1000) });

// ============================================================ 1. the ask: once, only to registered guests with no evidence they came
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  const noor = addMember({ first_name: "Noor" });
  const ada = addMember({ first_name: "Ada" });
  const remy = addMember({ first_name: "Remy" });
  const sam = addMember({ first_name: "Sam" });
  const blake = addMember({ first_name: "Blake", sms_opted_out: true });
  const casey = addMember({ first_name: "Casey" });
  night("ev1", [jordan, noor, ada, remy, sam, blake]);
  W.events.get("ev1")!.guests.push({ email: casey.email, phone: null, name: "Casey", approval_status: "pending_approval" });
  checkIn("ev1", noor); // Luma door check-in
  W.presence.set(`ev1|${ada.id}`, { sharing_seen_at: null, arrived_at: new Date() }); // Cue saw them arrive
  W.walkins.push({ event_api_id: "ev1", person_id: remy.id }); // walk-in check-in
  await PA.setGoing("ev1", sam.id, false); // said ahead they can't make it

  // Too early (30 minutes in): nobody yet.
  W.events.get("ev1")!.start_at = iso(-30 * MIN);
  P.clearPresenceCache();
  check("ask: nothing before 45 minutes in", (await N.runNoShowAsks(new Date(), { approved: true })) === 0 && W.sent.length === 0);
  W.events.get("ev1")!.start_at = iso(-50 * MIN);
  P.clearPresenceCache();
  const n = await N.runNoShowAsks(new Date(), { approved: true });
  check("ask: goes to the one registered guest with no evidence they came", n === 1 && asksTo(jordan).length === 1, W.sent);
  check("ask: never to a Luma check-in, an arrival, a walk-in, a 'can't make it', an opted-out or a pending guest", [noor, ada, remy, sam, blake, casey].every((m) => sentTo(m).length === 0));
  check("ask: the fixed line, the event's name, nobody else's", asksTo(jordan)[0]?.content === N.noShowAskText({ name: "Noise Supper", start_at: W.events.get("ev1")!.start_at, timezone: "America/Los_Angeles" }) && !nameIn(asksTo(jordan)[0]?.content ?? "", "Jordan"), asksTo(jordan)[0]);
  check("ask: marked asked on their presence row", !!W.presence.get(`ev1|${jordan.id}`)?.noshow_asked_at);
  await N.runNoShowAsks(new Date(), { approved: true });
  await Promise.all([N.runNoShowAsks(new Date(), { approved: true }), N.runNoShowAsks(new Date(), { approved: true })]);
  check("ask: once, however many passes (one at a time or at once)", asksTo(jordan).length === 1, asksTo(jordan));
  check("ask: on the ledger once per member per event", W.proactiveSends.filter((s) => s.user_id === jordan.id && s.target_key === "noshow_ask:ev1").length === 1);
  // Past the room's open window (its last 30 minutes): no ask for a newcomer.
  const late = addMember({ first_name: "Late" });
  W.events.get("ev1")!.guests.push({ email: late.email, phone: null, name: "Late", approval_status: "approved" });
  W.events.get("ev1")!.end_at = iso(20 * MIN);
  P.clearPresenceCache();
  await N.runNoShowAsks(new Date(), { approved: true });
  check("ask: never in the room's last 30 minutes", sentTo(late).length === 0);
}

// ============================================================ 2. approval: false stops everything
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  night("ev2", [jordan]);
  const src = readFileSync(new URL("../../src/services/eventNoShow.ts", import.meta.url), "utf8");
  check("approval: the constant is true (Royce approved 2026-10-23), in code, no env switch", N.NOSHOW_COPY_APPROVED === true && /export const NOSHOW_COPY_APPROVED: boolean = true;/.test(src) && !/process\.env[^\n]*NOSHOW/.test(src));
  check("approval: unapproved (false), no ask", (await N.runNoShowAsks(new Date(), { approved: false })) === 0 && W.sent.length === 0 && !W.presence.get(`ev2|${jordan.id}`)?.noshow_asked_at);
  W.presence.set(`ev2|${jordan.id}`, { sharing_seen_at: null, arrived_at: null, noshow_asked_at: new Date(Date.now() - 5 * MIN) });
  checkIn("ev2", jordan);
  W.events.get("ev2")!.guests[0].email = "someone.else@example.test"; // the check-in is someone else's: the door was tracked
  check("approval: unapproved, no note queued and nothing settled", (await N.runNoShowNotes(later(2), { approved: false })) === 0 && !W.candidates.length && !W.presence.get(`ev2|${jordan.id}`)?.noshow_settled_at);
  const r = await N.draftNoShowNote(asCandidate({ user_id: jordan.id, type: "noshow_note", target_key: "noshow_note:ev2", payload: { eventId: "ev2", name: "Noise Supper", startAt: W.events.get("ev2")!.start_at, timezone: null } }), person(jordan), deps({ approved: false }));
  check("approval: unapproved, a queued note waits (nothing built or sent)", "defer" in r && W.llmCalls.length === 0 && W.sent.length === 0);
}

// ============================================================ 3. "yes I'm here": arrived, the normal night and the goodbye
{
  fresh();
  const jordan = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware")] });
  const noor = addMember({ first_name: "Noor" });
  night("ev3", [jordan, noor]);
  checkIn("ev3", noor);
  await S.scoreGuestListForEvent("ev3");
  await N.runNoShowAsks(new Date(), { approved: true });
  check("yes: asked first", asksTo(jordan).length === 1);
  said(jordan, "yes I'm here!");
  const arrived = await P.recordTextArrival(jordan.id); // what Cue's markArrived records
  check("yes: their yes records the arrival", arrived?.eventApiId === "ev3" && !!W.presence.get(`ev3|${jordan.id}`)?.arrived_at);
  const before = sentTo(jordan).length;
  await U.processDueUnmatchedFollowUps({ approved: true });
  check("yes: they get the end-of-night goodbye like anyone who came", sentTo(jordan).length - before === 1 && /glad you came/i.test(sentTo(jordan).at(-1)?.content ?? ""), sentTo(jordan));
  await N.runNoShowNotes(later(2), { approved: true });
  check("yes: no sorry note", !noteFor(jordan) && W.presence.get(`ev3|${jordan.id}`)?.noshow_outcome === "came");
}

// ============================================================ 4. "no": the note, once the night is over
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  night("ev4", [jordan]);
  await N.runNoShowAsks(new Date(), { approved: true });
  said(jordan, "no, couldn't make it tonight");
  await PA.setGoing("ev4", jordan.id, false); // what Cue's updateGoing records
  check("no: an open ask is found for a 'no' after the night", (await N.openNoShowAsk(jordan.id))?.eventApiId === "ev4");
  check("no: nothing while the night is still on", (await N.runNoShowNotes(new Date(), { approved: true })) === 0 && !noteFor(jordan));
  await N.runNoShowNotes(later(2), { approved: true });
  const c = noteFor(jordan);
  const end = new Date(W.events.get("ev4")!.end_at!);
  check("no: the note is queued, due when the night is over", !!c && +c.due_at === +end && c.target_key === "noshow_note:ev4" && c.payload.said === "said_no", c);
  check("no: settled, never asked or queued twice", W.presence.get(`ev4|${jordan.id}`)?.noshow_outcome === "said_no:queued" && (await N.runNoShowNotes(later(3), { approved: true })) === 0 && W.candidates.length === 1 && !(await N.openNoShowAsk(jordan.id)));
}

// ============================================================ 5. no answer: the note next morning only when the door was tracked
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  const noor = addMember({ first_name: "Noor" });
  night("ev5", [jordan, noor]);
  checkIn("ev5", noor);
  await N.runNoShowAsks(new Date(), { approved: true });
  await N.runNoShowNotes(later(2), { approved: true });
  const c = noteFor(jordan);
  const end = new Date(W.events.get("ev5")!.end_at!);
  const due = c ? new Date(c.due_at) : null;
  const local = due ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(due) : "";
  check("no answer + door tracked: the note is queued for their next morning (8am, their time)", !!c && !!due && due > end && Number(local) === 8 && +due === +PR.nextLocalHour(end, null, PR.RULES.startHour), { due, local });
  check("no answer: nobody who checked in is asked or noted", !noteFor(noor) && sentTo(noor).length === 0);
  // End to end through the pick's gates at the due time, with the pre-arrival text (topic event:ev5) sent and never answered and
  // the no-show ask on the ledger: nothing holds it (review of #272: it shared the pre-arrival text's topic and was held as a re-ask).
  const cand = asCandidate(c);
  const sends = [
    { type: "pre_arrival", targetKey: "pre_arrival:ev5", topicKey: "event:ev5", sentAt: new Date(Date.now() - 3 * 3_600_000), exempt: false },
    { type: "co_event", targetKey: "noshow_ask:ev5", topicKey: "noshow_ask:ev5", sentAt: new Date(), exempt: true },
  ];
  const st = { now: due!, sends, lastInboundAt: null, needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [], away: null, joinedAt: null, timezone: null, optedOut: false, midConversation: false };
  const held = [...PR.candidateChecks(cand, st), ...PR.userLevelChecks(st as any, { lane: PR.laneOf("noshow_note") })].filter((k) => !k.pass).map((k) => k.name);
  check("no answer + door tracked: at its morning, nothing in the pick's gates holds the note", cand.topicKey === "noshow_note:ev5" && held.length === 0, held);
}
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  const noor = addMember({ first_name: "Noor" });
  night("ev6", [jordan, noor]);
  W.presence.set(`ev6|${noor.id}`, { sharing_seen_at: null, arrived_at: new Date() }); // came, but nobody was checked in on Luma
  await N.runNoShowAsks(new Date(), { approved: true });
  await N.runNoShowNotes(later(2), { approved: true });
  // Review of #274 (2026-10-27): silence at an untracked door stays open through the settle window, so a "no" the next morning
  // still finds it; a full day of silence settles with nothing owed, as before.
  check("no answer + door not tracked: no note, and not settled yet (silence can't be told from coming)", asksTo(jordan).length === 1 && !noteFor(jordan) && !W.presence.get(`ev6|${jordan.id}`)?.noshow_settled_at);
  // A "no" late in the settle window (it runs from the night's end, 40 minutes after the ask) still finds the ask (review of #281:
  // the ask's own window ran 24h from the ask, so the last of the settle window found nothing open).
  const realNow = Date.now;
  Date.now = () => realNow() + 24 * 3_600_000 + 20 * MIN;
  const lateOpen = await N.openNoShowAsk(jordan.id);
  Date.now = realNow;
  check("... a 'no' late in the settle window still finds the open ask", lateOpen?.eventApiId === "ev6", lateOpen);
  await PA.setGoing("ev6", jordan.id, false); // the next morning: "no, I couldn't make it"
  await N.runNoShowNotes(later(14), { approved: true });
  check("... a 'no' the next morning still gets the note", !!noteFor(jordan) && W.presence.get(`ev6|${jordan.id}`)?.noshow_outcome === "said_no:queued", W.presence.get(`ev6|${jordan.id}`));
}
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  const noor = addMember({ first_name: "Noor" });
  night("ev6b", [jordan, noor]);
  W.presence.set(`ev6b|${noor.id}`, { sharing_seen_at: null, arrived_at: new Date() });
  await N.runNoShowAsks(new Date(), { approved: true });
  await N.runNoShowNotes(later(2), { approved: true });
  await N.runNoShowNotes(later(N.NOSHOW_SETTLE_HOURS + 3), { approved: true });
  check("no answer + door not tracked, silent past the settle window: settled, nothing", !noteFor(jordan) && W.presence.get(`ev6b|${jordan.id}`)?.noshow_outcome === "no_answer");
}
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  const noor = addMember({ first_name: "Noor" });
  night("ev7", [jordan, noor]);
  checkIn("ev7", noor);
  await N.runNoShowAsks(new Date(), { approved: true });
  said(jordan, "haha what a week");
  await N.runNoShowNotes(later(2), { approved: true });
  check("an unclear reply (not a no, no evidence): nothing, never 'sorry you couldn't make it' to someone who may have come", !noteFor(jordan) && W.presence.get(`ev7|${jordan.id}`)?.noshow_outcome === "unclear");
}
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  const noor = addMember({ first_name: "Noor" });
  night("ev8", [jordan, noor]);
  checkIn("ev8", noor);
  await N.runNoShowAsks(new Date(), { approved: true });
  W.lumaGuestListFail = true;
  await N.runNoShowNotes(later(2), { approved: true });
  check("no answer, guest list unreadable: not settled, tried again", !noteFor(jordan) && !W.presence.get(`ev8|${jordan.id}`)?.noshow_settled_at);
  W.lumaGuestListFail = false;
  await N.runNoShowNotes(later(2), { approved: true });
  check("... and once it reads, the note is queued", !!noteFor(jordan));
}
{
  // Pure rules.
  const asked = new Date(1_000_000);
  check("verdict: evidence wins, then a 'no' after the ask, then silence; anything else is unclear", N.verdict(true, { asked_at: asked, not_going_at: new Date(2_000_000), last_inbound_at: null }) === "came" && N.verdict(false, { asked_at: asked, not_going_at: new Date(2_000_000), last_inbound_at: new Date(2_000_000) }) === "said_no" && N.verdict(false, { asked_at: asked, not_going_at: null, last_inbound_at: new Date(500_000) }) === "no_answer" && N.verdict(false, { asked_at: asked, not_going_at: null, last_inbound_at: new Date(2_000_000) }) === "unclear");
  const end = new Date();
  check("due: a no once it's over; silence the next morning only with the door tracked", +N.noteDueAt("said_no", { end, zone: null, doorTracked: false })! === +end && N.noteDueAt("no_answer", { end, zone: null, doorTracked: false }) === null && !!N.noteDueAt("no_answer", { end, zone: null, doorTracked: true }) && N.noteDueAt("unclear", { end, zone: null, doorTracked: true }) === null && N.noteDueAt("came", { end, zone: null, doorTracked: true }) === null);
}

// ============================================================ 6. the note: fixed lines, no names, the intro only with the fit's own yes
const climb = (shareable = true) => ask("backing climate hardware founders at seed", "offering", shareable);
const why = `what they've said they can offer: "backing climate hardware founders at seed"`;
const DESC = "A long supper about building things that last. Doors at seven, food at eight.";
const ABOUT = "A long supper about building things that last.";
const NT = (soft = false) => N.noShowNote("Noise Supper", { kind: "next_table", name: "Noise Table Two", startAt: iso(9 * 86_400_000), timezone: null, url: null }, soft, ABOUT);
const realReveal = (await import("../../src/services/networkIntroNudge.js")).prepareReveal;
async function noteNight(o: { shareable?: boolean; score?: number; ellisCame?: boolean; nextTable?: boolean; soft?: boolean; paired?: boolean; optedIn?: boolean; about?: string | null; brief?: "yes" | "no" | "unanswered" | "yes_other_event" } = {}) {
  fresh();
  const jordan = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware")] });
  const ellis = addMember({ first_name: "Ellis", intent: [climb(o.shareable ?? true)] });
  const noor = addMember({ first_name: "Noor" });
  night("evn", [jordan, ellis, noor]);
  checkIn("evn", noor);
  if (o.ellisCame ?? true) checkIn("evn", ellis);
  if (o.nextTable) addEvent({ api_id: "evnext", name: "Noise Table Two", start_at: iso(9 * 86_400_000), end_at: iso(9 * 86_400_000 + 3 * 3_600_000) });
  W.rankings.set(`evn|${jordan.id}`, { ranked_candidates: [{ candidate_id: ellis.id, score: o.score ?? 85, reason: "internal", shareReason: why, mutual: false, method: "ask" }] });
  // Ellis's answer to being named in a member brief (services/eventBrief.ts): for this event, or for another one.
  if (o.brief) {
    const k = o.brief === "yes_other_event" ? `evother|${ellis.id}` : `evn|${ellis.id}`;
    W.presence.set(k, { sharing_seen_at: null, arrived_at: null, ...(W.presence.get(k) ?? {}), name_asked_at: new Date(), name_ok: o.brief === "yes" || o.brief === "yes_other_event" ? true : o.brief === "no" ? false : null });
  }
  if (o.paired) W.nudges.push({ event_id: "evn", person_id: jordan.id, candidate_id: ellis.id, score: 85, pending: false, anonymous: false, sent_at: Date.now() });
  P.clearPresenceCache();
  await N.runNoShowAsks(new Date(), { approved: true });
  await N.runNoShowNotes(later(2), { approved: true });
  const row = noteFor(jordan);
  const c = row ? asCandidate(row) : null;
  const callsBefore = W.llmCalls.length;
  // The real reveal and its gates run; only the fit's own earlier yes to an intro with Jordan is set here (the fake world keeps
  // that yes on the same network_introductions row its "already suggested" gate reads, so it can't hold both).
  const reveal = async (u: string, f: string, cand: any) => {
    const r = await realReveal(u, f, cand);
    return "message" in r ? { ...r, optedIn: o.optedIn ?? true } : r;
  };
  const r = c ? await N.draftNoShowNote(c, person(jordan), deps({ struggling: async () => !!o.soft, about: async () => (o.about === undefined ? DESC : o.about), reveal })) : null;
  const calls = W.llmCalls.slice(callsBefore).map((x) => x.kind);
  return { jordan, ellis, noor, c, r: r as any, calls };
}
{
  const { jordan, ellis, c, r, calls } = await noteNight({});
  const t = textOf(r);
  check("intro: a strong fit who came, agreed to be shared and already said yes to Jordan: the fixed intro note", t === N.noShowNote("Noise Supper", { kind: "intro" }, false, ABOUT) && c.payload.intro?.candidate?.candidate_id === ellis.id, { t, intro: c?.payload?.intro });
  check("intro: never names or describes them in the note", !/Ellis/.test(t) && !/climate|seed|founder|backing/i.test(t) && !nameIn(t, "Jordan"), t);
  check("intro: the reveal (the answer to their yes) is ready, naming them only then", /Ellis/.test(c.payload.intro?.reveal ?? ""));
  check("intro: the note passes the harness's own checks", PR.checkDraft(r.text, r.rules).every((k: any) => k.pass), PR.checkDraft(r.text, r.rules).filter((k: any) => !k.pass));
  check("no model draft: the only model call is the reveal's (never the note's words)", calls.every((k) => k === "networkReveal" || k === "consent"), calls);
  await N.afterNoShowNoteSent(c);
  const pend = W.memoriesWritten.find((m) => m.user_id === jordan.id && m.memory_type === "network_offer_pending");
  check("intro: once sent, the offer is their open network question (the existing double opt-in path)", !!pend && JSON.parse(pend.content).candidate?.candidate_id === ellis.id && JSON.parse(pend.content).candidate?.share_safe === true);
}
{
  const { c, r } = await noteNight({ optedIn: false, nextTable: true });
  const t = textOf(r);
  check("leak: the fit hasn't said yes to an intro with them: no intro offer, no name anywhere, the next table instead", t === NT() && !c.payload.intro && !/Ellis/.test(JSON.stringify({ t, payload: c.payload })), { t, payload: c?.payload });
}
{
  const { c, r } = await noteNight({ optedIn: false, brief: "yes" });
  const t = textOf(r);
  check("brief consent: the fit said yes to being named in this event's member brief: the intro is offered, no name in the note", t === N.noShowNote("Noise Supper", { kind: "intro" }, false, ABOUT) && c.payload.intro?.candidate?.candidate_id && !/Ellis/.test(t), { t, intro: c?.payload?.intro });
}
for (const [label, brief] of [["said no to being named", "no"], ["never answered the brief question", "unanswered"], ["said yes for a different event", "yes_other_event"]] as const) {
  const { c, r } = await noteNight({ optedIn: false, brief, nextTable: true });
  const t = textOf(r);
  check(`brief consent: the fit ${label}: the next table, name nowhere`, t === NT() && !c.payload.intro && !/Ellis/.test(JSON.stringify({ t, payload: c.payload })), { t, payload: c?.payload });
}
for (const [label, o] of [
  ["the fit hasn't said yes to them", { optedIn: false }],
  ["their ask isn't shareable (no consent to be shared)", { shareable: false }],
  ["a weak fit (score 50)", { score: 50 }],
  ["the fit didn't come", { ellisCame: false }],
  ["they were already a pair at the event", { paired: true }],
] as const) {
  const { c, r } = await noteNight(o);
  const t = textOf(r);
  check(`intro: no offer when ${label}`, t === N.noShowNote("Noise Supper", { kind: "none" }, false, ABOUT) && !c.payload.intro && !/Ellis/.test(t), { t, intro: c?.payload?.intro });
}
{
  const { r } = await noteNight({ shareable: false, nextTable: true });
  check("next table: with no intro to offer, the approved next-table line (no question)", textOf(r) === NT() && !/\?/.test(textOf(r)), textOf(r));
}
{
  const { r } = await noteNight({ shareable: false, nextTable: true, soft: true });
  check("hard week: still sent and the next table still offered (feelings change tone, never cancel)", textOf(r) === NT(true) && /Noise Table Two/.test(textOf(r)), textOf(r));
  const { r: r2 } = await noteNight({ soft: true });
  check("hard week: the gentle intro line", textOf(r2) === N.noShowNote("Noise Supper", { kind: "intro" }, true, ABOUT) && /whenever you feel up to it/.test(textOf(r2)), textOf(r2));
  const soft = [N.noShowNote("Noise Supper", { kind: "none" }, true), N.noShowNote("Noise Supper", { kind: "intro" }, true), NT(true)];
  check("hard week: the fixed lines never say Cue knows how they've been", soft.every((f) => f.startsWith("Sorry you couldn't make it to Noise Supper.") && !/take (good )?care|hope you|been (rough|hard)|tough|feeling/i.test(f)), soft);
}
{
  // What the night was: one sentence, verbatim from the event's own description, or nothing.
  const names = ["Ellis", "Noor"];
  check("about: the first sentence, verbatim", N.aboutLine(DESC, names) === ABOUT && DESC.includes(N.aboutLine(DESC, names)!));
  for (const d of [
    "Twelve of us filled the table and stayed late.",
    "The room was packed with builders.",
    "A couple of the founders you'd like were there.",
    "An intimate dinner for 12 founders building climate hardware.",
    "Supper with Ellis, who hosts the conversation.",
    "Is this the best supper in town?",
    "A supper — long and slow.",
    "Details at https://lu.ma/x for the night.",
    "Hi.",
  ]) check(`about: "${d.slice(0, 40)}" is dropped, never edited`, N.aboutLine(d, names) === null, N.aboutLine(d, names));
  const { r } = await noteNight({ shareable: false, about: "Twelve of us filled the table and stayed late. More soon." });
  check("about: an unsafe description leaves the note with no line about the night", textOf(r) === N.noShowNote("Noise Supper", { kind: "none" }, false, null), textOf(r));
  const { r: r3 } = await noteNight({ shareable: false, about: null });
  check("about: no description, no line about the night", textOf(r3) === N.noShowNote("Noise Supper", { kind: "none" }, false, null), textOf(r3));
  for (const kind of ["none", "intro"] as const) for (const soft of [false, true]) for (const about of [null, ABOUT]) {
    const f = N.noShowNote("Noise Supper", { kind } as any, soft, about);
    check(`fixed note (${kind}${soft ? ", soft" : ""}${about ? ", about" : ""}): no em dash, passes the harness checks`, !/[—–]/.test(f) && PR.checkDraft(f, { maxSentences: 4, maxChars: 420, mustIncludeAny: ["supper"] }).every((k) => k.pass), PR.checkDraft(f, { maxSentences: 4, maxChars: 420, mustIncludeAny: ["supper"] }).filter((k) => !k.pass));
  }
  check("fixed note (next table, about): no em dash, passes the harness checks", !/[—–]/.test(NT()) && PR.checkDraft(NT(), { maxSentences: 4, maxChars: 420, mustIncludeAny: ["supper"] }).every((k) => k.pass));
}
{
  const { jordan, r } = await noteNight({});
  W.presence.get(`evn|${jordan.id}`)!.arrived_at = new Date();
  const again = await N.draftNoShowNote(asCandidate(noteFor(jordan)), person(jordan), deps());
  check("came after all (an arrival recorded since): the note is skipped", "skip" in again && !!r);
}
check("never a name: no text sent in this file names another member", W.sent.every((s) => !nameIn(s.content, [...W.members.values()].find((m) => m.phone_number === s.to)?.first_name ?? "")), W.sent);

// ============================================================ 7. delivery: holds, ledger, hours, test numbers
{
  fresh();
  const jordan = addMember({ first_name: "Jordan", safetyHold: true });
  night("evs", [jordan]);
  await N.runNoShowAsks(new Date(), { approved: true });
  check("safety hold: no ask", asksTo(jordan).length === 0 && !W.presence.get(`evs|${jordan.id}`)?.noshow_asked_at);
}
{
  const c: any = { id: "1", userId: "u", type: "noshow_note", targetKey: "noshow_note:ev", topicKey: "event:ev", summary: "s", priority: 88, dueAt: new Date(Date.now() - MIN), expiresAt: null, payload: {}, attempts: 0, createdAt: new Date() };
  const base = { now: new Date(), sends: [] as any[], lastInboundAt: null, needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [], away: null, joinedAt: null };
  const failed = (s: any) => PR.candidateChecks(c, s).filter((k) => !k.pass).map((k) => k.name);
  check("safety hold: the note waits (no offers while they may not be safe)", failed({ ...base, safetyHold: true }).includes("safety_hold"));
  check("mood: a hard week never holds the note (feelings change the tone, never whether)", failed({ ...base, needsCare: true }).length === 0, failed({ ...base, needsCare: true }));
  check("ledger: a note already sent for this event is never sent again", failed({ ...base, sends: [{ type: "noshow_note", targetKey: "noshow_note:ev", topicKey: "event:ev", sentAt: new Date(), exempt: false }] }).includes("not_sent_before"));
  check("pacing: the note is paced like any proactive text (not an answer, not exempt)", !PR.isAnswering(c) && PR.pacedByEngagement(c));
}
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  W.proactiveSends.push({ user_id: jordan.id, type: "noshow_note", target_key: "noshow_note:evl", message: "m" });
  const q = await PR.enqueueCandidate({ userId: jordan.id, type: "noshow_note", targetKey: "noshow_note:evl", summary: "s", payload: {} });
  check("ledger: a note already on the ledger is never queued again", !q.queued && !W.candidates.length);
}
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  // 06:00 UTC, 11pm Pacific: outside their hours.
  const night11 = new Date(Date.now() + 12 * 3_600_000);
  addEvent({ api_id: "evq", name: "Noise Supper", start_at: new Date(night11.getTime() - 50 * MIN).toISOString(), end_at: new Date(night11.getTime() + 40 * MIN).toISOString() }, [{ m: jordan }]);
  await N.runNoShowAsks(night11, { approved: true });
  check("quiet hours: no ask, and not marked asked", asksTo(jordan).length === 0 && !W.presence.get(`evq|${jordan.id}`)?.noshow_asked_at);
}
{
  fresh();
  N.openTestNumbersForTests(false);
  const jordan = addMember({ first_name: "Jordan" });
  night("evt", [jordan]);
  await N.runNoShowAsks(new Date(), { approved: true });
  const r = await N.draftNoShowNote(asCandidate({ user_id: jordan.id, type: "noshow_note", target_key: "noshow_note:evt", payload: { eventId: "evt", name: "Noise Supper", startAt: W.events.get("evt")!.start_at, timezone: null } }), person(jordan), deps());
  check("test numbers: a 555-01xx number gets no ask and no note outside tests", asksTo(jordan).length === 0 && "skip" in r && N.testRangeNumber(jordan.phone_number) && !N.testRangeNumber("+14155550000") && !N.testRangeNumber("+14155551234"));
  N.openTestNumbersForTests(true);
}
{
  fresh();
  const jordan = addMember({ first_name: "Jordan" });
  night("evf", [jordan]);
  W.lumaGuestListFail = true;
  await N.runNoShowAsks(new Date(), { approved: true });
  check("ask: an unreadable guest list asks nobody (Cue can't tell who checked in)", asksTo(jordan).length === 0);
}
{
  const src = readFileSync(new URL("../../src/services/eventNoShow.ts", import.meta.url), "utf8");
  const logs = [...src.matchAll(/console\.log\(([^;]*)\);/g)].map((m) => m[1]);
  check("logs: ids only (no names, no message text)", logs.every((l) => !/first_name|firstName|content|text\b|message/i.test(l)), logs);
  const lines = [N.noShowAskText({ name: "Noise Supper", start_at: iso(0), timezone: null }), N.noShowNote("Noise Supper", { kind: "intro" }, false, ABOUT), N.noShowNote("Noise Supper", { kind: "intro" }, true), NT(true)];
  check("copy: no em dashes in any line or brief", lines.every((l) => !/[—–]/.test(l)), lines);
}

const { total, failed } = results;
console.log(`no-show flow: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
