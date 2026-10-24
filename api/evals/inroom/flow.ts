// In-room matching, end to end, model-free (analysis/in-room-matching, 2026-10-07).
// Runs the REAL code path: Luma guest list -> matchGuestsToUsers -> scoreMatchedGroup -> maybeSendMatchNudge
// (gateShareReason, draftWithConsent, claim, in-room cap, send) -> handleMatchNudgeReply -> intro email, plus
// walk-ins, the additive offer, the end-of-night unmatched pass and the named-guest intro. The database, Luma,
// Anthropic and Sendblue are fakes (evals/inroom/world.ts). Invented people, test-range numbers, zero tokens.
//
//   npx tsx evals/inroom/flow.ts
//
// In layer 1 since 2026-10-07 (every open finding fixed): it gates pushes.
//
// check()   = behavior that should hold (a FAIL is a regression).
// finding() = an open defect from the analysis: it FAILS while the defect reproduces and passes once fixed.
import { W, reset, addMember, addEvent, ask, goal, check, finding, results, type Member } from "./world.js";

// The clock is pinned to 18:00 UTC today (2026-10-08 fix): a member with no time zone may only be texted 16:00-24:00 UTC
// (harness/proactive.ts localHourOk), so outside that window a direct ask is queued instead of sent and the result depended
// on when the test ran. Event times are all relative to now, so they move with the pinned clock.
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
const U = await import("../../src/services/eventUnmatchedFollowUp.js");
const WK = await import("../../src/services/eventWalkinCheckin.js");
const MS = await import("../../src/services/memberSafeMemories.js");
const P = await import("../../src/harness/proactive.js");

// Pairwise scores by asker ask text -> candidate first name.
function scores(table: Record<string, Record<string, number>>): void {
  W.scorer = (askText, cand) => {
    const row = Object.entries(table).find(([a]) => askText.includes(a))?.[1] ?? {};
    return { score: row[cand.first_name] ?? 0, share: true };
  };
}
const sentTo = (m: Member) => W.sent.filter((s) => s.to === m.phone_number);
const nudgeOf = (ev: string, m: Member) => W.nudges.find((n) => n.event_id === ev && n.person_id === m.id);
const settle = () => new Promise((r) => setTimeout(r, 30));
const freshPass = async (ev: string) => {
  W.scoringDebounce.clear();
  const r = await S.scoreGuestListForEvent(ev);
  await settle();
  return r;
};

// ============================================================ 1. the happy path
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: [ask("a seed investor for a climate hardware startup")] });
  const ellis = addMember({ first_name: "Ellis", intent: [ask("climate hardware founders to back at seed", "offering")] });
  const noor = addMember({ first_name: "Noor", intent: [ask("a ceramics studio to share")] });
  addEvent({ api_id: "evt-happy", name: "Cue Supper" }, [{ m: jordan }, { m: ellis }, { m: noor }]);
  scores({ "seed investor": { Ellis: 85, Noor: 5 }, "climate hardware founders": { Jordan: 82, Noor: 0 }, ceramics: { Jordan: 10, Ellis: 10 } });
  const r = await freshPass("evt-happy");
  check("happy: 3 members matched off the guest list", r.matchedCount === 3, r);
  check("happy: Jordan nudged about Ellis", nudgeOf("evt-happy", jordan)?.candidate_id === ellis.id);
  finding("offering-only: Ellis (only an OFFERING ask: 'climate hardware founders to back at seed') is never scored as an asker; he gets an ask solicitation instead of a nudge about Jordan", r.scoredCount === 2 && r.solicitedCount === 1 && !nudgeOf("evt-happy", ellis), r);
  check("happy: Noor (no strong match) not nudged", !nudgeOf("evt-happy", noor) && sentTo(noor).length === 0);
  const t = sentTo(jordan)[0]?.content ?? "";
  check("happy: Jordan's text names Ellis and uses only Ellis's own stated offering", /Ellis/.test(t) && /climate hardware founders to back at seed/.test(t), t);
  check("happy: no phone or email in any nudge", W.sent.every((s) => !/@|\d{3}[\s.-]?\d{4}/.test(s.content)));
  check("happy: claims cleared after send (pending=false)", W.nudges.every((n) => n.pending === false));
  check("happy: each in-room send is on the ledger", W.proactiveSends.filter((s) => s.type === "in_room").length === sentTo(jordan).length + sentTo(ellis).length + sentTo(noor).length);

  // double opt-in, Jordan first
  const asMNC = (m: Member) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number!, email: m.email });
  await H.handleMatchNudgeReply("evt-happy", "Cue Supper", "interested", asMNC(jordan), asMNC(ellis));
  check("opt-in: Jordan's yes alone sends no intro", !W.memoriesWritten.some((m) => m.memory_type === "event_intro_email_sent"));
  check("opt-in: Jordan's yes sends Ellis one direct ask (he had no nudge of his own)", sentTo(ellis).length === 1, sentTo(ellis));
  await H.handleMatchNudgeReply("evt-happy", "Cue Supper", "interested", asMNC(ellis), asMNC(jordan));
  const intros = W.memoriesWritten.filter((m) => m.memory_type === "event_intro_email_sent");
  check("opt-in: both yes -> one intro email, recorded for both", intros.length === 2 && new Set(intros.map((m) => m.user_id)).size === 2);
  const pend = await H.findPendingMatchNudge(jordan.id);
  check("opt-in: nothing left pending for Jordan after answering", pend === null);
  const { readFileSync } = await import("node:fs");
  const introSrc = readFileSync(new URL("../../src/services/eventGuestMatchHandoff.ts", import.meta.url), "utf8");
  finding(
    "copy: the in-room intro email says 'Cue figured you two should actually meet BEFORE it' though both are in the room (or past it)",
    intros.length > 0 && /meet before it|Before \$\{eventName\}/.test(introSrc),
  );
}

// ============================================================ 2. thresholds and ties
for (const [s, expect] of [[59, false], [60, true], [100, true], [0, false]] as const) {
  reset();
  const a = addMember({ first_name: "Avery", intent: [ask("product designers")] });
  const b = addMember({ first_name: "Blake", intent: [ask("design work on a fintech app", "offering")] });
  addEvent({ api_id: `evt-th-${s}`, name: "Cue Night" }, [{ m: a }, { m: b }]);
  scores({ "product designers": { Blake: s }, fintech: { Avery: 0 } });
  await freshPass(`evt-th-${s}`);
  check(`threshold: score ${s} ${expect ? "nudges" : "does not nudge"}`, !!nudgeOf(`evt-th-${s}`, a) === expect);
}
{
  reset();
  const a = addMember({ first_name: "Avery", intent: [ask("product designers")] });
  const b = addMember({ first_name: "Blake", intent: [ask("design for fintech", "offering")] });
  const c = addMember({ first_name: "Casey", intent: [ask("design for health apps", "offering")] });
  addEvent({ api_id: "evt-tie", name: "Cue Night" }, [{ m: a }, { m: b }, { m: c }]);
  scores({ "product designers": { Blake: 75, Casey: 75 } });
  await freshPass("evt-tie");
  const pick = nudgeOf("evt-tie", a)?.candidate_id;
  check("ties: exactly one nudge for a tie", W.nudges.filter((n) => n.person_id === a.id).length === 1);
  // The same room with the guest list in the other order: a fair tiebreak picks the same person.
  W.nudges.length = 0; W.sent.length = 0; W.offers.length = 0; W.proactiveSends.length = 0;
  addEvent({ api_id: "evt-tie2", name: "Cue Night" }, [{ m: a }, { m: c }, { m: b }]);
  await freshPass("evt-tie2");
  const pick2 = nudgeOf("evt-tie2", a)?.candidate_id;
  finding("ties: a tie is broken by the model's output order (guest-list order), not by mutuality or any tiebreak rule", !pick || pick !== pick2, { first: pick === b.id ? "Blake" : "Casey", swapped: pick2 === b.id ? "Blake" : "Casey" });
  // Mutual interest wins a tie.
  reset();
  const a3 = addMember({ first_name: "Avery", intent: [ask("product designers")] });
  const b3 = addMember({ first_name: "Blake", intent: [ask("design for fintech", "offering")] });
  const c3 = addMember({ first_name: "Casey", intent: [ask("design for health apps", "offering")] });
  addEvent({ api_id: "evt-tie3", name: "Cue Night" }, [{ m: a3 }, { m: b3 }, { m: c3 }]);
  W.scorer = (askText, cand) => ({ score: askText.includes("product designers") ? 75 : 0, share: true, mutual: cand.first_name === "Casey" });
  await freshPass("evt-tie3");
  check("ties: mutual interest wins a tie", nudgeOf("evt-tie3", a3)?.candidate_id === c3.id);
}

// ============================================================ 3. empty, tiny rooms, thin profiles
{
  reset();
  addEvent({ api_id: "evt-empty", name: "Cue Night" }, []);
  const r0 = await freshPass("evt-empty");
  check("empty room: nothing scored, nothing sent", r0.matchedCount === 0 && W.sent.length === 0);
  const solo = addMember({ first_name: "Sarah Hao", intent: [ask("a running partner")] });
  addEvent({ api_id: "evt-solo", name: "Cue Night" }, [{ m: solo }]);
  const r1 = await freshPass("evt-solo");
  check("room of one: nothing to rank, no text", r1.scoredCount === 0 && W.sent.length === 0);
}
{
  reset();
  const a = addMember({ first_name: "Jordan" }); // nothing on file
  const b = addMember({ first_name: "Ellis" });
  addEvent({ api_id: "evt-thin", name: "Cue Night" }, [{ m: a }, { m: b }]);
  const r = await freshPass("evt-thin");
  check("thin: two members with no ask and no goal get an ask solicitation, not a nudge", r.solicitedCount === 2 && W.nudges.length === 0 && W.candidates.every((c) => c.type === "ask_solicitation"), { r, cands: W.candidates.map((c) => c.type) });
  const r2 = await freshPass("evt-thin");
  check("thin: solicitation is not repeated inside the 3-day cooldown", r2.solicitedCount === 0);
}
{
  // A goals-only member is never framed by her goal (Royce, 2026-10-18: "What we know about a member shapes how, never which helper"):
  // with no ask for the night she's asked what she'd like from the room, like anyone with no ask. She's still a candidate for others,
  // and never suggested TO anyone from her goal: shareReason only reads open asks.
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("an angel investor in edtech")] });
  const g = addMember({ first_name: "Noor", intent: [goal("invest in early edtech founders")] });
  addEvent({ api_id: "evt-goal", name: "Cue Night" }, [{ m: a }, { m: g }]);
  scores({ "angel investor": { Noor: 92 }, "invest in early edtech": { Jordan: 90 } });
  await freshPass("evt-goal");
  check("goals-only: Noor is not scored against her goal; she's asked what she'd like from the room (an ask solicitation)", !W.rankings.has(`evt-goal|${g.id}`) && W.candidates.some((c) => c.user_id === g.id && c.type === "ask_solicitation"), { cands: W.candidates.map((c) => [c.user_id, c.type]) });
  check("goals-only: Jordan (his ask is the frame) is still scored, with Noor among his candidates", W.rankings.has(`evt-goal|${a.id}`));
  check("goals-only: Jordan is never told about Noor from her private goal (no reason he may see, so no forward nudge)", !nudgeOf("evt-goal", a));
  check("goals-only: Noor gets no nudge picked by her goal", !nudgeOf("evt-goal", g));
  // The way Noor reaches Jordan without exposing her goal: she says yes to him, and only then is he asked about her.
  const asM = (m: Member) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number!, email: m.email });
  await H.handleMatchNudgeReply("evt-goal", "Cue Night", "interested", asM(g), asM(a));
  await new Promise((r) => setTimeout(r, 30));
  const askedJordan = sentTo(a).some((s) => /Noor/.test(s.content));
  finding("goals-only: Noor (goal 'invest in early edtech founders', score 92) can never be suggested to Jordan: no open ask = no shareReason = no nudge", !askedJordan, { jordanAskedAboutNoor: askedJordan });
  check("goals-only: what Jordan hears about Noor never carries her goal", sentTo(a).every((s) => !/invest in early edtech/.test(s.content)));
}
{
  // Top candidate has no shareable reason; the strong #2 is never tried.
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a technical cofounder")] });
  const top = addMember({ first_name: "Ellis", intent: [goal("start a company")] });
  const second = addMember({ first_name: "Sarah Hao", intent: [ask("joining a startup as technical cofounder", "offering")] });
  addEvent({ api_id: "evt-second", name: "Cue Night" }, [{ m: a }, { m: top }, { m: second }]);
  scores({ "technical cofounder": { Ellis: 90, "Sarah Hao": 85 } });
  await freshPass("evt-second");
  finding("top-1 only: Jordan's #1 (Ellis, 90) has no shareable reason, so Jordan gets NO nudge even though #2 (Sarah Hao, 85) is strong and shareable", !nudgeOf("evt-second", a));
}

// ============================================================ 4. RSVP status, archived, opted out
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const declined = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering"), ask("a growth stage startup to join")] });
  const wait = addMember({ first_name: "Noor", intent: [ask("growth marketing advice", "offering")] });
  addEvent({ api_id: "evt-rsvp", name: "Cue Night" }, [{ m: a }, { m: declined, status: "declined" }, { m: wait, status: "waitlist" }]);
  scores({ "growth marketer": { Ellis: 90, Noor: 70 }, "growth stage startup": { Jordan: 80 } });
  const r = await freshPass("evt-rsvp");
  const { eventMembers } = await import("../../src/services/eventPresence.js");
  const members = await eventMembers("evt-rsvp");
  check("rsvp: eventMembers (brief/pre-arrival/presence) only counts approved guests", members.length === 1);
  finding("rsvp: scoring counts DECLINED and WAITLISTED guests as in the room (matchGuestsToUsers ignores approval_status)", r.matchedCount === 3, r);
  finding("rsvp: Jordan is told a DECLINED guest (Ellis) is 'here tonight', with Ellis's ask", nudgeOf("evt-rsvp", a)?.candidate_id === declined.id && /Ellis/.test(sentTo(a)[0]?.content ?? ""), sentTo(a)[0]?.content);
  finding("rsvp: the declined guest is texted an in-room nudge for an event they said no to", sentTo(declined).length > 0);
}
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const arch = addMember({ first_name: "Ellis", archived_at: new Date().toISOString(), intent: [ask("a growth stage startup to join")] });
  const out = addMember({ first_name: "Noor", sms_opted_out: true, intent: [ask("growth marketing advice", "offering")] });
  addEvent({ api_id: "evt-arch", name: "Cue Night" }, [{ m: a }, { m: arch }, { m: out }]);
  scores({ "growth marketer": { Ellis: 90, Noor: 95 }, "growth stage startup": { Jordan: 80 } });
  const r = await freshPass("evt-arch");
  check("opted out: an opted-out member is never in the pool (not scored, not named, not texted)", sentTo(out).length === 0 && !W.nudges.some((n) => n.candidate_id === out.id));
  finding("archived: an ARCHIVED member is still in the scoring pool, named to others and texted", r.matchedCount === 2 && nudgeOf("evt-arch", a)?.candidate_id === arch.id && sentTo(arch).length > 0, r);
}
{
  // Phone-format mismatch: Luma has the phone formatted, users has E.164; no email on the Luma row.
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  const ev = addEvent({ api_id: "evt-phone", name: "Cue Night" }, [{ m: a }, { m: b, via: "phone" }]);
  ev.guests[1].phone = b.phone_number!.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 ($1) $2-$3");
  const r = await freshPass("evt-phone");
  finding("matching: a guest whose Luma phone is formatted '+1 (415) 555-01xx' with no email is invisible (exact-string phone match)", r.matchedCount === 1, r);
  reset();
  const c = addMember({ first_name: "Jordan", intent: [ask("x")] });
  const d = addMember({ first_name: "Ellis", intent: [ask("y")] });
  addEvent({ api_id: "evt-case", name: "Cue Night" }, [{ m: c }, { m: d, emailCase: "upper" }]);
  check("matching: email match is case-insensitive", (await freshPass("evt-case")).matchedCount === 2);
}

// ============================================================ 5. timing windows
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  const ev = addEvent({ api_id: "evt-early", name: "Cue Night", start_at: new Date(Date.now() + 3_600_000).toISOString(), end_at: new Date(Date.now() + 4 * 3_600_000).toISOString() }, [{ m: a }, { m: b }]);
  scores({ "growth marketer": { Ellis: 90 }, "growth marketing roles": { Jordan: 70 } });
  await freshPass("evt-early");
  check("window: an hour before the start, the match is ranked but not sent or claimed", W.sent.length === 0 && W.nudges.length === 0 && W.rankings.has(`evt-early|${a.id}`));
  ev.start_at = new Date(Date.now() - 60_000).toISOString();
  await freshPass("evt-early");
  check("window: the re-score after the start sends the withheld match", !!nudgeOf("evt-early", a) && sentTo(a).length === 1);
  reset();
  const c = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const d = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  addEvent({ api_id: "evt-late", name: "Cue Night", start_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), end_at: new Date(Date.now() + 20 * 60_000).toISOString() }, [{ m: c }, { m: d }]);
  scores({ "growth marketer": { Ellis: 90 } });
  await freshPass("evt-late");
  check("window: nothing in the last 30 minutes", W.sent.length === 0);
  reset();
  const e = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const f = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  addEvent({ api_id: "evt-noend", name: "Cue Night", start_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), end_at: null }, [{ m: e }, { m: f }]);
  scores({ "growth marketer": { Ellis: 90 } });
  await freshPass("evt-noend");
  finding("window: an event with no end_at that started 3 DAYS ago still sends an 'in the room' nudge on any later re-score", sentTo(e).length === 1);
  // presence hold: sharing location and not arrived yet
  reset();
  const g = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const h = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  addEvent({ api_id: "evt-hold", name: "Cue Night" }, [{ m: g }, { m: h }]);
  W.presence.set(`evt-hold|${g.id}`, { sharing_seen_at: new Date(), arrived_at: null });
  scores({ "growth marketer": { Ellis: 90 } });
  await freshPass("evt-hold");
  check("presence: a member sharing location who hasn't arrived is held (no send, claim released or never taken)", sentTo(g).length === 0 && !nudgeOf("evt-hold", g));
  W.presence.set(`evt-hold|${g.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  await freshPass("evt-hold");
  check("presence: once arrived, the re-score sends it", sentTo(g).length === 1);
}

// ============================================================ 6. Luma details outage turns an in-room nudge into a queued anonymous heads-up
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  addEvent({ api_id: "evt-flaky", name: "Cue Night" }, [{ m: a }, { m: b }]);
  scores({ "growth marketer": { Ellis: 90 } });
  // /v1/event/get fails (500) while the guest list still works.
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.host === "public-api.luma.com" && u.pathname === "/v1/event/get") return new Response("boom", { status: 500 });
    return real(input, init);
  }) as typeof fetch;
  await freshPass("evt-flaky");
  globalThis.fetch = real;
  const q = W.candidates.filter((c) => c.type === "event_match_nudge");
  finding("timing: a transient Luma /event/get failure turns the live in-room nudge for a CO event into a queued, anonymous, 14-day 'event_match_nudge' for the daily pick", W.sent.length === 0 && q.length >= 1 && q.every((c) => c.payload.anonymous === true), { queued: q.length });
}

// ============================================================ 7. duplicates, concurrency, caps
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("a growth stage startup to join")] });
  addEvent({ api_id: "evt-dup", name: "Cue Night" }, [{ m: a }, { m: b }]);
  scores({ "growth marketer": { Ellis: 90 }, "growth stage startup": { Jordan: 80 } });
  const ev = { start_at: W.events.get("evt-dup")!.start_at, end_at: W.events.get("evt-dup")!.end_at };
  const pool = [a, b].map((m) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number!, email: m.email, intent: m.intent, goals: m.goals, blockers: m.blockers, activity_preferences: m.activity_preferences }));
  await Promise.all([S.scoreMatchedGroup("evt-dup", "Cue Night", pool, ev), S.scoreMatchedGroup("evt-dup", "Cue Night", pool, ev)]);
  check("dup: two overlapping passes send each person exactly one nudge", sentTo(a).length === 1 && sentTo(b).length === 1, { a: sentTo(a).length, b: sentTo(b).length });
  await freshPass("evt-dup");
  await freshPass("evt-dup");
  check("dup: later passes never re-send the match nudge", sentTo(a).length === 1);
  const debounced = await S.scoreGuestListForEvent("evt-dup");
  check("dup: a webhook within 15s is debounced", debounced.matchedCount === 0);
}
{
  reset();
  const a = addMember({ first_name: "Jordan" });
  // The per-event cap uses LIKE 'in_room:%:<eventId>%', so a different event whose id starts with this one counts.
  W.proactiveSends.push(
    { user_id: a.id, type: "in_room", target_key: "in_room:match:evt-1234" },
    { user_id: a.id, type: "in_room", target_key: "in_room:additive:evt-1234:1" },
    { user_id: a.id, type: "in_room", target_key: "in_room:additive:evt-1234:2" },
  );
  finding("cap: three texts at event evt-1234 use up the in-room cap for a DIFFERENT event evt-12 (prefix LIKE)", !(await P.inRoomSendAllowed(a.id, "evt-12")));
  check("cap: the event's own cap is 3", !(await P.inRoomSendAllowed(a.id, "evt-1234")));
}

// ============================================================ 8. late registration, walk-in, additive offer
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  const late = addMember({ first_name: "Sarah Hao", intent: [ask("growth marketing for B2B", "offering")] });
  const ev = addEvent({ api_id: "evt-late-reg", name: "Cue Night" }, [{ m: a }, { m: b }]);
  scores({ "growth marketer": { Ellis: 80, "Sarah Hao": 95 } });
  await freshPass("evt-late-reg");
  check("late: Jordan nudged about Ellis first", nudgeOf("evt-late-reg", a)?.candidate_id === b.id);
  // Late Luma registration
  ev.guests.push({ email: late.email, phone: null, name: late.first_name, approval_status: "approved" });
  await freshPass("evt-late-reg");
  check("late: the existing match is never swapped", nudgeOf("evt-late-reg", a)?.candidate_id === b.id);
  // The additive heads-up names no one, so it waits while Jordan's question about Ellis is open (review of #211), and isn't lost:
  // answering that question starts a room pass (inRoomOffers.ts answerOffer → rescoreIfAdditiveWaiting), which sends it, once.
  check("late: while the question about Ellis is open, no additive heads-up goes beside it", sentTo(a).length === 1, sentTo(a).map((x) => x.content));
  const OF = await import("../../src/services/inRoomOffers.js");
  W.scoringDebounce.clear(); // the last pass was more than 15s ago
  await H.handleMatchNudgeReply("evt-late-reg", "Cue Night", "not_interested", { user_id: a.id, first_name: a.first_name, phone_number: a.phone_number!, email: a.email }, { user_id: b.id, first_name: b.first_name, phone_number: b.phone_number!, email: b.email });
  check("late: answering the question about Ellis starts a room pass for the waiting heads-up", (await OF.additiveRescore) === true);
  await new Promise((r) => setTimeout(r, 30));
  check("... which sends it", sentTo(a).length === 2, sentTo(a).map((x) => x.content));
  check("... once: nothing is waiting any more, and a later pass sends no second one", !(await OF.rescoreIfAdditiveWaiting("evt-late-reg", a.id)) && (await freshPass("evt-late-reg"), sentTo(a).length === 2));
  const add = sentTo(a)[1]?.content ?? "";
  check("late: a stronger late arrival produces one additive offer that names no one", sentTo(a).length === 2 && !/Sarah/.test(add), add);
  const addMem = W.memoriesWritten.find((m) => m.user_id === a.id && /Additive offer/.test(m.content))?.content ?? "";
  finding("LEAK: the additive-offer memory written to Jordan's history carries the unnamed arrival's name ('Sarah Hao'), and memberSafe passes event_guest_match_nudge rows through whole", /Sarah Hao/.test(addMem) && /Sarah Hao/.test(MS.safeMemory("event_guest_match_nudge", addMem, []) ?? ""), addMem);
  const facts = MS.introFacts([{ memory_type: "event_guest_match_nudge", content: addMem }]);
  finding("LEAK: introFacts turns it into a 'Cue's record' fact for the reply, so 'yes, who?' can be answered with Sarah Hao's name with no share-reason gate or consent check", facts.some((f) => /Sarah Hao/.test(f)), facts);
  const pending = await H.findPendingMatchNudge(a.id);
  finding("CONSENT: after 'want to hear who?', the only open item is the ORIGINAL Ellis nudge, so Jordan's 'yes' to hearing who is read as yes to Ellis (and Ellis gets a direct ask)", pending?.candidate_id === b.id, pending);
  // The reveal: Jordan's yes to "want to hear who?" names one new person, through the share gate.
  const rev = pending?.kind === "additive" ? await H.handleAdditiveReply(pending.event_id, "Cue Night", "interested", { user_id: a.id, first_name: a.first_name, phone_number: a.phone_number!, email: a.email }, pending.candidate_ids ?? []) : { revealed: null };
  finding("additive: there is no code path that ever reveals the new people Jordan said yes to hearing about", rev.revealed?.first_name !== "Sarah Hao", rev);
  check("additive: after the reveal, Jordan's open question is Sarah Hao (their next yes binds to her)", (await H.findPendingMatchNudge(a.id))?.candidate_id === late.id);
  // A late answer never re-scores a room that's over.
  const rk = W.rankings.get(`evt-late-reg|${a.id}`)!;
  rk.ranked_candidates = rk.ranked_candidates.map((r: any) => ({ ...r, additivePending: true }));
  ev.start_at = new Date(Date.now() - 5 * 3_600_000).toISOString();
  ev.end_at = new Date(Date.now() - 3_600_000).toISOString();
  W.scoringDebounce.clear();
  check("late: a heads-up still waiting when the room has closed: answering starts no pass", !(await OF.rescoreIfAdditiveWaiting("evt-late-reg", a.id)) && !W.scoringDebounce.has("evt-late-reg"));
}
{
  // Walk-in by text, with no presence check: anyone who texts the phrase during the event joins the pool.
  reset();
  const host = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const remote = addMember({ first_name: "Ellis", intent: [ask("a growth stage startup to join")] });
  addEvent({ api_id: "evt-walk", name: "SF Founders Meetup" }, [{ m: host }]);
  scores({ "growth marketer": { Ellis: 90 }, "growth stage startup": { Jordan: 80 } });
  const det = await WK.detectCheckinPhrase("I'm currently at a Cue sponsored event - SF Founders Meetup");
  check("walk-in: the QR phrase resolves to the live event", det?.eventApiId === "evt-walk");
  await WK.recordCheckin("evt-walk", remote.id);
  await freshPass("evt-walk");
  finding("walk-in: a member who only TEXTS the check-in phrase (no location, no Luma RSVP) is scored, gets Jordan's name + ask, and is named to Jordan as 'here tonight'", nudgeOf("evt-walk", remote)?.candidate_id === host.id && nudgeOf("evt-walk", host)?.candidate_id === remote.id);
}

// ============================================================ 9. double opt-in ordering and the direct-ask overwrite
{
  reset();
  const asMNC = (m: Member) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number!, email: m.email });
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("a designer for my app")] });
  const c = addMember({ first_name: "Noor", intent: [ask("design work for apps", "offering")] });
  addEvent({ api_id: "evt-oo", name: "Cue Night" }, [{ m: a }, { m: b }, { m: c }]);
  // Jordan's top is Ellis; Ellis's top is Noor; Noor's top is Ellis.
  scores({ "growth marketer": { Ellis: 80, Noor: 10 }, "designer for my app": { Noor: 90, Jordan: 5 }, "design work": { Ellis: 88, Jordan: 5 } });
  W.members.get(b.id)!.intent!.push(ask("growth marketing gigs", "offering")); // Ellis's newest ask is the share reason
  await freshPass("evt-oo");
  check("ordering: Ellis is nudged about Noor (his own top)", nudgeOf("evt-oo", b)?.candidate_id === c.id);
  const ellisTextsBefore = sentTo(b).length;
  // Jordan says yes to Ellis -> Ellis gets a direct ask about Jordan, which OVERWRITES Ellis's row about Noor.
  await H.handleMatchNudgeReply("evt-oo", "Cue Night", "interested", asMNC(a), asMNC(b));
  await new Promise((r) => setTimeout(r, 50));
  const row = nudgeOf("evt-oo", b);
  finding("ordering: Jordan's yes overwrites Ellis's pending nudge about Noor; Ellis's next reply (even if he meant Noor) resolves to Jordan", row?.candidate_id === a.id, { candidate: row?.candidate_id === a.id ? "Jordan" : "Noor" });
  // Noor says yes to Ellis -> Ellis is asked AGAIN (now about Noor), flipping the row back.
  await H.handleMatchNudgeReply("evt-oo", "Cue Night", "interested", asMNC(c), asMNC(b));
  await new Promise((r) => setTimeout(r, 50));
  finding("ordering: Ellis receives his nudge plus a direct ask per asker, outside the in-room cap (direct_ask is exempt)", sentTo(b).length - ellisTextsBefore >= 1, { ellisTexts: sentTo(b).length });
  // One-sided: Ellis says no to whoever is pending now.
  const p = await H.findPendingMatchNudge(b.id);
  if (p) await H.handleMatchNudgeReply("evt-oo", "Cue Night", "not_interested", asMNC(b), { user_id: p.candidate_id, first_name: p.candidate_first_name, phone_number: p.candidate_phone, email: p.candidate_email });
  check("one-sided: no intro email without both yeses", !W.memoriesWritten.some((m) => m.memory_type === "event_intro_email_sent"));
}

// ============================================================ 10. the end-of-night close (Royce, 2026-10-14)
// "Everyone gets the same end-of-night close, and it says nothing about matching ... Below-bar pairing stays dead either way."
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a sailing crew")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("people to sail with on weekends", "offering")] });
  const n = addMember({ first_name: "Noor", intent: [ask("a seed investor for a climate hardware startup")] });
  const m = addMember({ first_name: "Remy", intent: [ask("backing climate hardware founders at seed", "offering")] });
  const end = new Date(Date.now() + 45 * 60_000).toISOString(); // send_at = end - 50m is already due; the in-room window (end - 30m) is still open
  addEvent({ api_id: "evt-un", name: "Cue Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, [{ m: a }, { m: b }, { m: n }, { m: m }]);
  scores({ "sailing crew": { Ellis: 40 }, "sail with": { Jordan: 35 }, "seed investor": { Remy: 88 }, "backing climate": { Noor: 85 } });
  await freshPass("evt-un");
  check("close: a below-bar pair gets no nudge", !nudgeOf("evt-un", a) && !nudgeOf("evt-un", b));
  check("close: a real match still gets its nudge", !!nudgeOf("evt-un", n));
  check("close: everyone in the room is scheduled for the close", W.unmatchedFollowups.length === 4);
  // Jordan and Noor arrived; Remy was checked in at Luma's door; Ellis registered, never showed, and texted Cue from home during the
  // event (a text is no evidence they came: review of #208).
  W.presence.set(`evt-un|${a.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  W.presence.set(`evt-un|${n.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  const remyGuest = (W.events.get("evt-un")!.guests as any[]).find((g) => g.email === m.email);
  remyGuest.checked_in_at = new Date().toISOString();
  W.memoriesWritten.push({ user_id: b.id, memory_type: "text_exchange", content: "User said: long week, staying in tonight", created_at: new Date() });
  const before = new Map([a, b, n, m].map((x) => [x.id, sentTo(x).length]));
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  const closes = (x: Member) => sentTo(x).slice(before.get(x.id));
  check("close: no below-bar pairing is ever drafted", !W.llmCalls.some((c) => c.kind === "unmatchedPairDraft"));
  check("close: no 'nothing stood out' text is ever drafted", !W.llmCalls.some((c) => c.kind === "soloAck"));
  check("close: everyone who came gets exactly one close, matched or not", closes(a).length === 1 && closes(n).length === 1 && closes(m).length === 1, { a: closes(a), n: closes(n), m: closes(m) });
  check("close: a registered no-show gets nothing, even one who texted during the event (no 'glad you came' without evidence they came)", closes(b).length === 0);
  check("close: the same close for everyone, and it says nothing about matching", [a, n, m].every((x) => /glad you came/i.test(closes(x)[0]?.content ?? "") && !U.MATCH_TALK.test(closes(x)[0]?.content ?? "")), [a, n, m].map((x) => closes(x)[0]?.content));
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("close: sent once (a second pass sends nothing)", closes(a).length === 1 && closes(n).length === 1 && closes(m).length === 1);
}
{
  // Two passes at once (a slow pass overlapping the next */15 tick, or two containers during a deploy): each close goes once
  // (review of #208/#218: both passes used to send to everyone).
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a sailing crew")] });
  const n = addMember({ first_name: "Noor", intent: [ask("backing climate hardware founders at seed", "offering")] });
  const end = new Date(Date.now() + 10 * 60_000).toISOString();
  addEvent({ api_id: "evt-two", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, [{ m: a }, { m: n }]);
  await freshPass("evt-two");
  for (const x of [a, n]) W.presence.set(`evt-two|${x.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  const before = new Map([a, n].map((x) => [x.id, sentTo(x).length]));
  await Promise.all([U.processDueUnmatchedFollowUps({ approved: true }), U.processDueUnmatchedFollowUps({ approved: true })]);
  await settle();
  check("close: two passes at once send each close once", [a, n].every((x) => sentTo(x).length - before.get(x.id)! === 1), [a, n].map((x) => sentTo(x).slice(before.get(x.id))));
}
{
  // A close the pause held is tried again by the next pass while the room is open, not dropped (review of #208).
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a sailing crew")] });
  const end = new Date(Date.now() + 10 * 60_000).toISOString();
  addEvent({ api_id: "evt-held", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, [{ m: a }]);
  await freshPass("evt-held");
  W.presence.set(`evt-held|${a.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  const before = sentTo(a).length;
  process.env.PROACTIVE_PAUSED = "true";
  const callsBefore = W.llmCalls.length;
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  const whilePaused = sentTo(a).length - before;
  const draftsWhilePaused = W.llmCalls.length - callsBefore;
  delete process.env.PROACTIVE_PAUSED;
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("close: held by the pause, then sent once the pause lifts", whilePaused === 0 && sentTo(a).length - before === 1, { whilePaused, after: sentTo(a).slice(before) });
  check("close: a close the pause holds costs no draft", draftsWhilePaused === 0, { draftsWhilePaused });
}
{
  // Past the in-room limit (Royce, 2026-10-14: "A cap that leaves the most engaged people in the room without a goodbye is
  // inverted - one line, once, always"): someone who already had the most in-room texts still gets the close, and the close never
  // uses up a slot for a later in-room text.
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a sailing crew")] });
  const end = new Date(Date.now() + 45 * 60_000).toISOString();
  addEvent({ api_id: "evt-cap", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, [{ m: a }]);
  const P = await import("../../src/harness/proactive.js");
  for (let k = 0; k < P.MAX_IN_ROOM_SENDS_PER_EVENT; k++) W.proactiveSends.push({ user_id: a.id, type: "in_room", target_key: `in_room:additive:evt-cap:${k}`, message: "earlier" });
  check("close: the in-room limit is reached before the close", !(await P.inRoomSendAllowed(a.id, "evt-cap")));
  W.presence.set(`evt-cap|${a.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  W.unmatchedFollowups.push({ user_id: a.id, event_api_id: "evt-cap", event_name: "Co Night", send_at: Date.now() - 60_000, sent_at: null });
  const before = sentTo(a).length;
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("close: someone past the in-room text limit still gets the close", sentTo(a).slice(before).length === 1 && /glad you came/i.test(sentTo(a).slice(before)[0]?.content ?? ""), sentTo(a).slice(before));
  W.proactiveSends.splice(0, W.proactiveSends.length, { user_id: a.id, type: "in_room", target_key: "in_room:match:evt-cap", message: "m" }, { user_id: a.id, type: "in_room", target_key: "in_room:close:evt-cap", message: "c" }, { user_id: a.id, type: "in_room", target_key: "in_room:additive:evt-cap:1", message: "x" });
  check("close: the close never counts toward the in-room limit", await P.inRoomSendAllowed(a.id, "evt-cap"));
  const src = (await import("node:fs")).readFileSync(new URL("../../src/services/eventUnmatchedFollowUp.ts", import.meta.url), "utf8");
  check("close: the kill switches still hold it (pause and matching stop)", /inRoomSendAllowed\(person\.user_id, eventId, \{ close: true \}\)/.test(src));
}
{
  // A draft that slips into matching talk never goes out as written: the plain close does.
  check("close: match talk in a draft is replaced by the plain close", U.closeText("So glad you came. Sorry nobody was right for you tonight.") === U.CLOSE_FALLBACK && U.closeText("Glad you came, hope you met some good people") === U.CLOSE_FALLBACK && U.closeText("Really glad you came tonight.") === "Really glad you came tonight." && U.closeText("") === U.CLOSE_FALLBACK);
}

{
  // The close's copy was approved by Royce (2026-10-23). Unapproved (false) nothing is drafted, sent or marked done; approved inside
  // the window it goes; a close whose room is over by then expires unsent (no late goodbye).
  check("close approval: the constant is true (Royce approved 2026-10-23), in code, no env switch", U.CLOSE_APPROVED === true && /export const CLOSE_APPROVED: boolean = true;/.test((await import("node:fs")).readFileSync(new URL("../../src/services/eventUnmatchedFollowUp.ts", import.meta.url), "utf8")) && !/process\.env[^\n]*CLOSE_APPROVED/.test((await import("node:fs")).readFileSync(new URL("../../src/services/eventUnmatchedFollowUp.ts", import.meta.url), "utf8")));
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a sailing crew")] });
  const end = new Date(Date.now() + 10 * 60_000).toISOString();
  addEvent({ api_id: "evt-appr", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, [{ m: a }]);
  await freshPass("evt-appr");
  W.presence.set(`evt-appr|${a.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  const before = sentTo(a).length;
  const callsBefore = W.llmCalls.length;
  await U.processDueUnmatchedFollowUps({ approved: false });
  await settle();
  const row = () => W.unmatchedFollowups.find((r) => r.event_api_id === "evt-appr" && r.user_id === a.id);
  check("close approval: unapproved, nothing is drafted or sent", sentTo(a).length === before && W.llmCalls.length === callsBefore, { sent: sentTo(a).slice(before), calls: W.llmCalls.slice(callsBefore).map((c) => c.kind) });
  check("close approval: unapproved, nothing is marked done or claimed", !!row() && !row()!.sent_at && !W.unmatchedNotices.some((n) => n.event_id === "evt-appr"));
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("close approval: approved inside the window, it goes once", sentTo(a).length - before === 1 && !!row()?.sent_at, sentTo(a).slice(before));

  // Approved only after the room is over: expired, never sent late.
  reset();
  const b = addMember({ first_name: "Ellis", intent: [ask("a sailing crew")] });
  addEvent({ api_id: "evt-late", name: "Co Night", start_at: new Date(Date.now() - 4 * 3_600_000).toISOString(), end_at: new Date(Date.now() - 30 * 60_000).toISOString() }, [{ m: b }]);
  W.presence.set(`evt-late|${b.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  W.unmatchedFollowups.push({ user_id: b.id, event_api_id: "evt-late", event_name: "Co Night", send_at: Date.now() - 80 * 60_000, sent_at: null });
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("close approval: a close whose room is over expires unsent (no late goodbye)", sentTo(b).length === 0 && !!W.unmatchedFollowups.find((r) => r.user_id === b.id)?.sent_at && !W.llmCalls.some((c) => c.kind === "closeDraft"));
  // Unreadable event: bounded by the end it was scheduled against.
  const now = new Date();
  check("close window: no timing, inside the scheduled end, not expired; past it, expired", !U.closeExpired(null, new Date(now.getTime() - 10 * 60_000), now) && U.closeExpired(null, new Date(now.getTime() - (U.UNMATCHED_SEND_BEFORE_END_MINUTES + 1) * 60_000), now) && U.closeExpired("over", now, now) && !U.closeExpired("closing", new Date(0), now));
}
{
  // A walk-in who texted the check-in phrase but Cue never saw arrive is outside the matching roster (inRoomPool), but the check-in
  // counts as attendance: they get the close (review of #208), and they're still not matched.
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a sailing crew")] });
  const w = addMember({ first_name: "Remy", intent: [ask("people to sail with on weekends", "offering")] });
  const end = new Date(Date.now() + 10 * 60_000).toISOString();
  addEvent({ api_id: "evt-walk", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, [{ m: a }]);
  W.walkins.push({ event_api_id: "evt-walk", person_id: w.id });
  scores({ "sailing crew": { Remy: 90 }, "sail with": { Jordan: 90 } });
  await freshPass("evt-walk");
  check("walk-in close: the unarrived walk-in is not in the matching roster (no nudge either way)", !nudgeOf("evt-walk", w) && !nudgeOf("evt-walk", a) && !(await S.inRoomPool("evt-walk")).some((g) => g.user_id === w.id));
  check("walk-in close: the scoring pass doesn't schedule them", !W.unmatchedFollowups.some((r) => r.user_id === w.id));
  W.presence.set(`evt-walk|${a.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("walk-in close: the walk-in who checked in gets the close once", sentTo(w).length === 1 && /glad you came/i.test(sentTo(w)[0]?.content ?? ""), sentTo(w));
  check("walk-in close: the arrived guest gets it too", sentTo(a).length === 1);
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("walk-in close: once", sentTo(w).length === 1);
  // The check-in schedules their close on its own (no other close due at that event yet).
  reset();
  const v = addMember({ first_name: "Noor", intent: [ask("a sailing crew")] });
  addEvent({ api_id: "evt-walk2", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, []);
  W.walkins.push({ event_api_id: "evt-walk2", person_id: v.id });
  await U.scheduleWalkinClose("evt-walk2", "Co Night", v.id);
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("walk-in close: a check-in at an event with nobody else scheduled still gets its close", sentTo(v).length === 1, sentTo(v));
  // A walk-in who left gets no goodbye (same as anyone who left).
  reset();
  const x = addMember({ first_name: "Ellis", intent: [ask("a sailing crew")] });
  const y = addMember({ first_name: "Kai", intent: [ask("a sailing crew")] });
  addEvent({ api_id: "evt-walk3", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, [{ m: y }]);
  W.walkins.push({ event_api_id: "evt-walk3", person_id: x.id });
  W.presence.set(`evt-walk3|${x.id}`, { left_at: new Date() });
  W.presence.set(`evt-walk3|${y.id}`, { sharing_seen_at: new Date(), arrived_at: new Date() });
  await freshPass("evt-walk3");
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("walk-in close: a walk-in who left gets nothing", sentTo(x).length === 0 && sentTo(y).length === 1);
}
{
  // Luma's guest list read fails at close time: a guest known only from Luma's door check-in isn't marked done; the next pass, inside
  // the window, sends it (review of #208). Past the window it expires.
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a sailing crew")] });
  const end = new Date(Date.now() + 10 * 60_000).toISOString();
  addEvent({ api_id: "evt-lf", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, [{ m: a }]);
  await freshPass("evt-lf");
  (W.events.get("evt-lf")!.guests as any[])[0].checked_in_at = new Date().toISOString();
  W.lumaGuestListFail = true;
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  const row = () => W.unmatchedFollowups.find((r) => r.event_api_id === "evt-lf" && r.user_id === a.id);
  check("luma fail: the door-checked-in guest isn't marked done and gets nothing yet", sentTo(a).length === 0 && !row()!.sent_at);
  W.lumaGuestListFail = false;
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("luma fail: the next pass, Luma back, sends it once", sentTo(a).length === 1 && !!row()!.sent_at, sentTo(a));
  // Still failing when the room is over: expired, nothing late.
  reset();
  const b = addMember({ first_name: "Ellis", intent: [ask("a sailing crew")] });
  const end2 = new Date(Date.now() + 10 * 60_000).toISOString();
  addEvent({ api_id: "evt-lf2", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end2 }, [{ m: b }]);
  await freshPass("evt-lf2");
  W.lumaGuestListFail = true;
  await U.processDueUnmatchedFollowUps({ approved: true });
  W.events.get("evt-lf2")!.end_at = new Date(Date.now() - 60_000).toISOString();
  W.lumaGuestListFail = false;
  (W.events.get("evt-lf2")!.guests as any[])[0].checked_in_at = new Date().toISOString();
  await U.processDueUnmatchedFollowUps({ approved: true });
  await settle();
  check("luma fail: past the window it expires unsent", sentTo(b).length === 0 && !!W.unmatchedFollowups.find((r) => r.user_id === b.id)?.sent_at);
}

// ============================================================ 11. PROACTIVE_PAUSED
{
  reset();
  process.env.PROACTIVE_PAUSED = "true";
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  addEvent({ api_id: "evt-paused", name: "Cue Night" }, [{ m: a }, { m: b }]);
  scores({ "growth marketer": { Ellis: 90 } });
  await freshPass("evt-paused");
  finding("pause: with PROACTIVE_PAUSED=true the in-room match nudge still sends (raw sendblue, no pause check)", sentTo(a).length === 1);
  delete process.env.PROACTIVE_PAUSED;
}

// ============================================================ 12. named-guest intro (requestEventIntro)
{
  reset();
  const req = addMember({ first_name: "Noor", intent: [ask("x")] });
  const jo = addMember({ first_name: "Jo", intent: [ask("y")] });
  addEvent({ api_id: "evt-named", name: "Cue Night" }, [{ m: req }, { m: jo }]);
  W.checkinFollowups.push({ user_id: req.id, event_api_id: "evt-named", event_name: "Cue Night" });
  const r = await H.resolveNamedEventGuest(req.id, "Jordan");
  finding("named intro: 'I met Jordan' resolves to member 'Jo' (prefix match both ways), who is then told Noor wants an intro", "target" in r && r.target.user_id === jo.id);
  reset();
  const req2 = addMember({ first_name: "Noor", intent: [ask("x")] });
  const sam = addMember({ first_name: "Samantha", intent: [ask("y")] });
  addEvent({ api_id: "evt-named2", name: "Cue Night" }, [{ m: req2 }, { m: sam, status: "declined" }]);
  W.checkinFollowups.push({ user_id: req2.id, event_api_id: "evt-named2", event_name: "Cue Night" });
  const r2 = await H.resolveNamedEventGuest(req2.id, "Sam");
  finding("named intro: 'Sam' resolves to Samantha, a guest who DECLINED the event, and she gets the direct ask", "target" in r2 && r2.target.user_id === sam.id);
  reset();
  const q = addMember({ first_name: "Noor", intent: [ask("x")] });
  const s1 = addMember({ first_name: "Sam", intent: [ask("y")] });
  const s2 = addMember({ first_name: "Sam", intent: [ask("z")] });
  addEvent({ api_id: "evt-named3", name: "Cue Night" }, [{ m: q }, { m: s1 }, { m: s2 }]);
  W.checkinFollowups.push({ user_id: q.id, event_api_id: "evt-named3", event_name: "Cue Night" });
  const r3 = await H.resolveNamedEventGuest(q.id, "Sam");
  check("named intro: two members named Sam -> Cue asks for the last name, the same as for anyone, and nobody is contacted", "needsDetail" in r3 && !("target" in r3));
  // With full names: the right Sam, and a full name two guests share contacts no one (answered like 'not found').
  W.members.get(s1.id)!.last_name = "Okafor"; W.members.get(s2.id)!.last_name = "Reyes";
  const r4 = await H.resolveNamedEventGuest(q.id, "Sam", "Reyes");
  check("named intro: first + last name finds exactly that guest", !("error" in r4) && "target" in r4 && r4.target.user_id === s2.id);
  W.members.get(s1.id)!.last_name = "Reyes";
  const r5 = await H.resolveNamedEventGuest(q.id, "Sam Reyes");
  check("named intro: two guests with the same full name -> no one is contacted", "error" in r5);
  finding("named intro (side channel): the ambiguous branch makes Cue ask for 'one more detail', which only happens when 2+ MEMBERS share that name; a probe learns that", "error" in r3);
}

// ============================================================ 13. what the nudge says about the other person
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("an intro to seed investors")] });
  // Ellis's match comes from his OLD offering; his NEWEST ask is a personal errand.
  const b = addMember({ first_name: "Ellis", intent: [ask("seed checks for consumer founders", "offering"), ask("a new job since my startup is running out of money")] });
  addEvent({ api_id: "evt-reason", name: "Cue Night" }, [{ m: a }, { m: b }]);
  scores({ "seed investors": { Ellis: 88 } });
  await freshPass("evt-reason");
  const t = sentTo(a)[0]?.content ?? "";
  finding("LEAK: the share reason is the candidate's NEWEST open ask quoted verbatim, not the ask that matched: Jordan is told Ellis is looking for 'a new job since my startup is running out of money'", /running out of money/.test(t), t);
  reset();
  const c = addMember({ first_name: "Jordan", intent: [ask("someone who knows the bay area food scene")] });
  const d = addMember({ first_name: "Noor", intent: [ask("a good immigration lawyer for my H-1B transfer")] });
  addEvent({ api_id: "evt-errand", name: "Cue Night" }, [{ m: c }, { m: d }]);
  scores({ "food scene": { Noor: 70 } });
  await freshPass("evt-errand");
  finding("LEAK: an errand ask Cue was running for Noor ('immigration lawyer for my H-1B transfer') is quoted to a stranger in the room", /H-1B/.test(sentTo(c)[0]?.content ?? ""), sentTo(c)[0]?.content);
}

// ============================================================ summary
console.log(`\nin-room flow: ${results.total - results.failed}/${results.total} passed (${results.findings.length} open findings, ${results.failed - results.findings.length} other failures)`);
if (W.unknownSql.size && process.argv.includes("--sql")) console.log([...W.unknownSql].join("\n"));
process.exit(results.failed ? 1 : 0);
