// In-room matching, end to end, model-free (analysis/in-room-matching, 2026-10-07).
// Runs the REAL code path: Luma guest list -> matchGuestsToUsers -> scoreMatchedGroup -> maybeSendMatchNudge
// (gateShareReason, draftWithConsent, claim, in-room cap, send) -> handleMatchNudgeReply -> intro email, plus
// walk-ins, the additive offer, the end-of-night unmatched pass and the named-guest intro. The database, Luma,
// Anthropic and Sendblue are fakes (evals/inroom/world.ts). Invented people, test-range numbers, zero tokens.
//
//   npx tsx evals/inroom/flow.ts
//
// check()   = behavior that should hold (a FAIL is a regression).
// finding() = an open defect from the analysis: it FAILS while the defect reproduces and passes once fixed.
import { W, reset, addMember, addEvent, ask, goal, check, finding, results, type Member } from "./world.js";

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
  addEvent({ api_id: "evt-happy", name: "Co Supper" }, [{ m: jordan }, { m: ellis }, { m: noor }]);
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
  await H.handleMatchNudgeReply("evt-happy", "Co Supper", "interested", asMNC(jordan), asMNC(ellis));
  check("opt-in: Jordan's yes alone sends no intro", !W.memoriesWritten.some((m) => m.memory_type === "event_intro_email_sent"));
  check("opt-in: Jordan's yes sends Ellis one direct ask (he had no nudge of his own)", sentTo(ellis).length === 1, sentTo(ellis));
  await H.handleMatchNudgeReply("evt-happy", "Co Supper", "interested", asMNC(ellis), asMNC(jordan));
  const intros = W.memoriesWritten.filter((m) => m.memory_type === "event_intro_email_sent");
  check("opt-in: both yes -> one intro email, recorded for both", intros.length === 2 && new Set(intros.map((m) => m.user_id)).size === 2);
  const pend = await H.findPendingMatchNudge(jordan.id);
  check("opt-in: nothing left pending for Jordan after answering", pend === null);
  finding(
    "copy: the in-room intro email says 'Co figured you two should actually meet BEFORE it' though both are in the room (or past it)",
    intros.length > 0, // the body text is fixed in sendIntroEmail
  );
}

// ============================================================ 2. thresholds and ties
for (const [s, expect] of [[59, false], [60, true], [100, true], [0, false]] as const) {
  reset();
  const a = addMember({ first_name: "Avery", intent: [ask("product designers")] });
  const b = addMember({ first_name: "Blake", intent: [ask("design work on a fintech app", "offering")] });
  addEvent({ api_id: `evt-th-${s}`, name: "Co Night" }, [{ m: a }, { m: b }]);
  scores({ "product designers": { Blake: s }, fintech: { Avery: 0 } });
  await freshPass(`evt-th-${s}`);
  check(`threshold: score ${s} ${expect ? "nudges" : "does not nudge"}`, !!nudgeOf(`evt-th-${s}`, a) === expect);
}
{
  reset();
  const a = addMember({ first_name: "Avery", intent: [ask("product designers")] });
  const b = addMember({ first_name: "Blake", intent: [ask("design for fintech", "offering")] });
  const c = addMember({ first_name: "Casey", intent: [ask("design for health apps", "offering")] });
  addEvent({ api_id: "evt-tie", name: "Co Night" }, [{ m: a }, { m: b }, { m: c }]);
  scores({ "product designers": { Blake: 75, Casey: 75 } });
  await freshPass("evt-tie");
  const pick = nudgeOf("evt-tie", a)?.candidate_id;
  check("ties: exactly one nudge for a tie", W.nudges.filter((n) => n.person_id === a.id).length === 1);
  finding("ties: a tie is broken by the model's output order (guest-list order), not by mutuality or any tiebreak rule", pick === b.id, { picked: pick === b.id ? "Blake (listed first)" : "Casey" });
}

// ============================================================ 3. empty, tiny rooms, thin profiles
{
  reset();
  addEvent({ api_id: "evt-empty", name: "Co Night" }, []);
  const r0 = await freshPass("evt-empty");
  check("empty room: nothing scored, nothing sent", r0.matchedCount === 0 && W.sent.length === 0);
  const solo = addMember({ first_name: "Sarah Hao", intent: [ask("a running partner")] });
  addEvent({ api_id: "evt-solo", name: "Co Night" }, [{ m: solo }]);
  const r1 = await freshPass("evt-solo");
  check("room of one: nothing to rank, no text", r1.scoredCount === 0 && W.sent.length === 0);
}
{
  reset();
  const a = addMember({ first_name: "Jordan" }); // nothing on file
  const b = addMember({ first_name: "Ellis" });
  addEvent({ api_id: "evt-thin", name: "Co Night" }, [{ m: a }, { m: b }]);
  const r = await freshPass("evt-thin");
  check("thin: two members with no ask and no goal get an ask solicitation, not a nudge", r.solicitedCount === 2 && W.nudges.length === 0 && W.candidates.every((c) => c.type === "ask_solicitation"), { r, cands: W.candidates.map((c) => c.type) });
  const r2 = await freshPass("evt-thin");
  check("thin: solicitation is not repeated inside the 3-day cooldown", r2.solicitedCount === 0);
}
{
  // A goals-only member can be matched FROM (goal frame) but never TO: shareReason only reads open asks.
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("an angel investor in edtech")] });
  const g = addMember({ first_name: "Noor", intent: [goal("invest in early edtech founders")] });
  addEvent({ api_id: "evt-goal", name: "Co Night" }, [{ m: a }, { m: g }]);
  scores({ "angel investor": { Noor: 92 }, "invest in early edtech": { Jordan: 90 } });
  await freshPass("evt-goal");
  check("goals-only: Noor is scored using her goal as the frame", W.rankings.has(`evt-goal|${g.id}`));
  finding("goals-only: Noor (goal 'invest in early edtech founders', score 92) can never be suggested to Jordan: no open ask = no shareReason = no nudge", !nudgeOf("evt-goal", a), { jordanNudged: !!nudgeOf("evt-goal", a) });
  check("goals-only: Noor herself is nudged about Jordan (his ask is shareable)", nudgeOf("evt-goal", g)?.candidate_id === a.id);
}
{
  // Top candidate has no shareable reason; the strong #2 is never tried.
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a technical cofounder")] });
  const top = addMember({ first_name: "Ellis", intent: [goal("start a company")] });
  const second = addMember({ first_name: "Sarah Hao", intent: [ask("joining a startup as technical cofounder", "offering")] });
  addEvent({ api_id: "evt-second", name: "Co Night" }, [{ m: a }, { m: top }, { m: second }]);
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
  addEvent({ api_id: "evt-rsvp", name: "Co Night" }, [{ m: a }, { m: declined, status: "declined" }, { m: wait, status: "waitlist" }]);
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
  addEvent({ api_id: "evt-arch", name: "Co Night" }, [{ m: a }, { m: arch }, { m: out }]);
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
  const ev = addEvent({ api_id: "evt-phone", name: "Co Night" }, [{ m: a }, { m: b, via: "phone" }]);
  ev.guests[1].phone = b.phone_number!.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 ($1) $2-$3");
  const r = await freshPass("evt-phone");
  finding("matching: a guest whose Luma phone is formatted '+1 (415) 555-01xx' with no email is invisible (exact-string phone match)", r.matchedCount === 1, r);
  reset();
  const c = addMember({ first_name: "Jordan", intent: [ask("x")] });
  const d = addMember({ first_name: "Ellis", intent: [ask("y")] });
  addEvent({ api_id: "evt-case", name: "Co Night" }, [{ m: c }, { m: d, emailCase: "upper" }]);
  check("matching: email match is case-insensitive", (await freshPass("evt-case")).matchedCount === 2);
}

// ============================================================ 5. timing windows
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  const ev = addEvent({ api_id: "evt-early", name: "Co Night", start_at: new Date(Date.now() + 3_600_000).toISOString(), end_at: new Date(Date.now() + 4 * 3_600_000).toISOString() }, [{ m: a }, { m: b }]);
  scores({ "growth marketer": { Ellis: 90 }, "growth marketing roles": { Jordan: 70 } });
  await freshPass("evt-early");
  check("window: an hour before the start, the match is ranked but not sent or claimed", W.sent.length === 0 && W.nudges.length === 0 && W.rankings.has(`evt-early|${a.id}`));
  ev.start_at = new Date(Date.now() - 60_000).toISOString();
  await freshPass("evt-early");
  check("window: the re-score after the start sends the withheld match", !!nudgeOf("evt-early", a) && sentTo(a).length === 1);
  reset();
  const c = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const d = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  addEvent({ api_id: "evt-late", name: "Co Night", start_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), end_at: new Date(Date.now() + 20 * 60_000).toISOString() }, [{ m: c }, { m: d }]);
  scores({ "growth marketer": { Ellis: 90 } });
  await freshPass("evt-late");
  check("window: nothing in the last 30 minutes", W.sent.length === 0);
  reset();
  const e = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const f = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  addEvent({ api_id: "evt-noend", name: "Co Night", start_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), end_at: null }, [{ m: e }, { m: f }]);
  scores({ "growth marketer": { Ellis: 90 } });
  await freshPass("evt-noend");
  finding("window: an event with no end_at that started 3 DAYS ago still sends an 'in the room' nudge on any later re-score", sentTo(e).length === 1);
  // presence hold: sharing location and not arrived yet
  reset();
  const g = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const h = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  addEvent({ api_id: "evt-hold", name: "Co Night" }, [{ m: g }, { m: h }]);
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
  addEvent({ api_id: "evt-flaky", name: "Co Night" }, [{ m: a }, { m: b }]);
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
  addEvent({ api_id: "evt-dup", name: "Co Night" }, [{ m: a }, { m: b }]);
  scores({ "growth marketer": { Ellis: 90 }, "growth stage startup": { Jordan: 80 } });
  const ev = { start_at: W.events.get("evt-dup")!.start_at, end_at: W.events.get("evt-dup")!.end_at };
  const pool = [a, b].map((m) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number!, email: m.email, intent: m.intent, goals: m.goals, blockers: m.blockers, activity_preferences: m.activity_preferences }));
  await Promise.all([S.scoreMatchedGroup("evt-dup", "Co Night", pool, ev), S.scoreMatchedGroup("evt-dup", "Co Night", pool, ev)]);
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
  const ev = addEvent({ api_id: "evt-late-reg", name: "Co Night" }, [{ m: a }, { m: b }]);
  scores({ "growth marketer": { Ellis: 80, "Sarah Hao": 95 } });
  await freshPass("evt-late-reg");
  check("late: Jordan nudged about Ellis first", nudgeOf("evt-late-reg", a)?.candidate_id === b.id);
  // Late Luma registration
  ev.guests.push({ email: late.email, phone: null, name: late.first_name, approval_status: "approved" });
  await freshPass("evt-late-reg");
  check("late: the existing match is never swapped", nudgeOf("evt-late-reg", a)?.candidate_id === b.id);
  const add = sentTo(a)[1]?.content ?? "";
  check("late: a stronger late arrival produces one additive offer that names no one", sentTo(a).length === 2 && !/Sarah/.test(add), add);
  const addMem = W.memoriesWritten.find((m) => m.user_id === a.id && /Additive offer/.test(m.content))?.content ?? "";
  finding("LEAK: the additive-offer memory written to Jordan's history carries the unnamed arrival's name ('Sarah Hao'), and memberSafe passes event_guest_match_nudge rows through whole", /Sarah Hao/.test(addMem) && /Sarah Hao/.test(MS.safeMemory("event_guest_match_nudge", addMem, []) ?? ""), addMem);
  const facts = MS.introFacts([{ memory_type: "event_guest_match_nudge", content: addMem }]);
  finding("LEAK: introFacts turns it into a 'Co's record' fact for the reply, so 'yes, who?' can be answered with Sarah Hao's name with no share-reason gate or consent check", facts.some((f) => /Sarah Hao/.test(f)), facts);
  const pending = await H.findPendingMatchNudge(a.id);
  finding("CONSENT: after 'want to hear who?', the only open item is the ORIGINAL Ellis nudge, so Jordan's 'yes' to hearing who is read as yes to Ellis (and Ellis gets a direct ask)", pending?.candidate_id === b.id, pending);
  // The reveal: Jordan's yes to "want to hear who?" names one new person, through the share gate.
  const rev = pending?.kind === "additive" ? await H.handleAdditiveReply(pending.event_id, "Co Night", "interested", { user_id: a.id, first_name: a.first_name, phone_number: a.phone_number!, email: a.email }, pending.candidate_ids ?? []) : { revealed: null };
  finding("additive: there is no code path that ever reveals the new people Jordan said yes to hearing about", rev.revealed?.first_name !== "Sarah Hao", rev);
  check("additive: after the reveal, Jordan's open question is Sarah Hao (their next yes binds to her)", (await H.findPendingMatchNudge(a.id))?.candidate_id === late.id);
}
{
  // Walk-in by text, with no presence check: anyone who texts the phrase during the event joins the pool.
  reset();
  const host = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const remote = addMember({ first_name: "Ellis", intent: [ask("a growth stage startup to join")] });
  addEvent({ api_id: "evt-walk", name: "SF Founders Meetup" }, [{ m: host }]);
  scores({ "growth marketer": { Ellis: 90 }, "growth stage startup": { Jordan: 80 } });
  const det = await WK.detectCheckinPhrase("I'm currently at a Co sponsored event - SF Founders Meetup");
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
  addEvent({ api_id: "evt-oo", name: "Co Night" }, [{ m: a }, { m: b }, { m: c }]);
  // Jordan's top is Ellis; Ellis's top is Noor; Noor's top is Ellis.
  scores({ "growth marketer": { Ellis: 80, Noor: 10 }, "designer for my app": { Noor: 90, Jordan: 5 }, "design work": { Ellis: 88, Jordan: 5 } });
  W.members.get(b.id)!.intent!.push(ask("growth marketing gigs", "offering")); // Ellis's newest ask is the share reason
  await freshPass("evt-oo");
  check("ordering: Ellis is nudged about Noor (his own top)", nudgeOf("evt-oo", b)?.candidate_id === c.id);
  const ellisTextsBefore = sentTo(b).length;
  // Jordan says yes to Ellis -> Ellis gets a direct ask about Jordan, which OVERWRITES Ellis's row about Noor.
  await H.handleMatchNudgeReply("evt-oo", "Co Night", "interested", asMNC(a), asMNC(b));
  await new Promise((r) => setTimeout(r, 50));
  const row = nudgeOf("evt-oo", b);
  finding("ordering: Jordan's yes overwrites Ellis's pending nudge about Noor; Ellis's next reply (even if he meant Noor) resolves to Jordan", row?.candidate_id === a.id, { candidate: row?.candidate_id === a.id ? "Jordan" : "Noor" });
  // Noor says yes to Ellis -> Ellis is asked AGAIN (now about Noor), flipping the row back.
  await H.handleMatchNudgeReply("evt-oo", "Co Night", "interested", asMNC(c), asMNC(b));
  await new Promise((r) => setTimeout(r, 50));
  finding("ordering: Ellis receives his nudge plus a direct ask per asker, outside the in-room cap (direct_ask is exempt)", sentTo(b).length - ellisTextsBefore >= 1, { ellisTexts: sentTo(b).length });
  // One-sided: Ellis says no to whoever is pending now.
  const p = await H.findPendingMatchNudge(b.id);
  if (p) await H.handleMatchNudgeReply("evt-oo", "Co Night", "not_interested", asMNC(b), { user_id: p.candidate_id, first_name: p.candidate_first_name, phone_number: p.candidate_phone, email: p.candidate_email });
  check("one-sided: no intro email without both yeses", !W.memoriesWritten.some((m) => m.memory_type === "event_intro_email_sent"));
}

// ============================================================ 10. end-of-night unmatched pass
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("a sailing crew")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("people to sail with on weekends", "offering")] });
  const end = new Date(Date.now() + 20 * 60_000).toISOString(); // send_at = end - 30m is already due
  addEvent({ api_id: "evt-un", name: "Co Night", start_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), end_at: end }, [{ m: a }, { m: b }]);
  scores({ "sailing crew": { Ellis: 40 }, "sail with": { Jordan: 35 } }); // both below 60
  await freshPass("evt-un");
  check("unmatched: below-bar pair gets no real nudge", W.nudges.length === 0);
  check("unmatched: both scheduled for the end-of-night pass", W.unmatchedFollowups.length === 2);
  await U.processDueUnmatchedFollowUps();
  await settle();
  const pairTexts = W.llmCalls.filter((c) => c.kind === "unmatchedPairDraft").length;
  finding("unmatched: the 'give the leftovers a shot at each other' pass can NEVER send: it runs at end-30m, exactly when checkEventWindow starts refusing", pairTexts === 0 && W.nudges.length === 0, { pairDrafts: pairTexts });
  finding("unmatched: so both get the solo 'nothing stood out tonight' text instead, though they share an interest", W.llmCalls.filter((c) => c.kind === "soloAck").length === 2 && sentTo(a).length === 1 && sentTo(b).length === 1);
}

// ============================================================ 11. PROACTIVE_PAUSED
{
  reset();
  process.env.PROACTIVE_PAUSED = "true";
  const a = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const b = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  addEvent({ api_id: "evt-paused", name: "Co Night" }, [{ m: a }, { m: b }]);
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
  addEvent({ api_id: "evt-named", name: "Co Night" }, [{ m: req }, { m: jo }]);
  W.checkinFollowups.push({ user_id: req.id, event_api_id: "evt-named", event_name: "Co Night" });
  const r = await H.resolveNamedEventGuest(req.id, "Jordan");
  finding("named intro: 'I met Jordan' resolves to member 'Jo' (prefix match both ways), who is then told Noor wants an intro", !("error" in r) && r.target.user_id === jo.id);
  reset();
  const req2 = addMember({ first_name: "Noor", intent: [ask("x")] });
  const sam = addMember({ first_name: "Samantha", intent: [ask("y")] });
  addEvent({ api_id: "evt-named2", name: "Co Night" }, [{ m: req2 }, { m: sam, status: "declined" }]);
  W.checkinFollowups.push({ user_id: req2.id, event_api_id: "evt-named2", event_name: "Co Night" });
  const r2 = await H.resolveNamedEventGuest(req2.id, "Sam");
  finding("named intro: 'Sam' resolves to Samantha, a guest who DECLINED the event, and she gets the direct ask", !("error" in r2) && r2.target.user_id === sam.id);
  reset();
  const q = addMember({ first_name: "Noor", intent: [ask("x")] });
  const s1 = addMember({ first_name: "Sam", intent: [ask("y")] });
  const s2 = addMember({ first_name: "Sam", intent: [ask("z")] });
  addEvent({ api_id: "evt-named3", name: "Co Night" }, [{ m: q }, { m: s1 }, { m: s2 }]);
  W.checkinFollowups.push({ user_id: q.id, event_api_id: "evt-named3", event_name: "Co Night" });
  const r3 = await H.resolveNamedEventGuest(q.id, "Sam");
  check("named intro: two members named Sam -> ambiguous, nobody contacted", "error" in r3 && /more than one/.test(r3.error));
  finding("named intro (side channel): the ambiguous branch makes Co ask for 'one more detail', which only happens when 2+ MEMBERS share that name; a probe learns that", "error" in r3);
}

// ============================================================ 13. what the nudge says about the other person
{
  reset();
  const a = addMember({ first_name: "Jordan", intent: [ask("an intro to seed investors")] });
  // Ellis's match comes from his OLD offering; his NEWEST ask is a personal errand.
  const b = addMember({ first_name: "Ellis", intent: [ask("seed checks for consumer founders", "offering"), ask("a new job since my startup is running out of money")] });
  addEvent({ api_id: "evt-reason", name: "Co Night" }, [{ m: a }, { m: b }]);
  scores({ "seed investors": { Ellis: 88 } });
  await freshPass("evt-reason");
  const t = sentTo(a)[0]?.content ?? "";
  finding("LEAK: the share reason is the candidate's NEWEST open ask quoted verbatim, not the ask that matched: Jordan is told Ellis is looking for 'a new job since my startup is running out of money'", /running out of money/.test(t), t);
  reset();
  const c = addMember({ first_name: "Jordan", intent: [ask("someone who knows the bay area food scene")] });
  const d = addMember({ first_name: "Noor", intent: [ask("a good immigration lawyer for my H-1B transfer")] });
  addEvent({ api_id: "evt-errand", name: "Co Night" }, [{ m: c }, { m: d }]);
  scores({ "food scene": { Noor: 70 } });
  await freshPass("evt-errand");
  finding("LEAK: an errand ask Co was running for Noor ('immigration lawyer for my H-1B transfer') is quoted to a stranger in the room", /H-1B/.test(sentTo(c)[0]?.content ?? ""), sentTo(c)[0]?.content);
}

// ============================================================ summary
console.log(`\nin-room flow: ${results.total - results.failed}/${results.total} passed (${results.findings.length} open findings, ${results.failed - results.findings.length} other failures)`);
if (W.unknownSql.size && process.argv.includes("--sql")) console.log([...W.unknownSql].join("\n"));
process.exit(results.failed ? 1 : 0);
