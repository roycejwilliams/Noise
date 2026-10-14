// Outbound calls need a real reason (Royce, 2026-10-08, after a 10-call eval: 4 of 9 outbound calls opened on Co's own
// homework, "the PDF went out this morning, wanted to make sure it landed"). Layer 1: pure reason picking, the call gate, the
// opening checks and the wiring, with a fake database. Zero tokens:
//   npx tsx evals/calls/reasonGate.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
import { readFileSync } from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const R = await import("../../src/services/callReason.js");
const G = await import("../../src/harness/callGate.js");
const O = await import("../../src/services/callOpening.js");
const N = await import("../../src/services/memberStateNudges.js");
type CallReasonState = import("../../src/services/callReason.js").CallReasonState;
type CallState = import("../../src/harness/callGate.js").CallState;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)?.slice(0, 400)}` : ""}`);
  }
};
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

// A document_deliveries row as the receipt store reads it (services/deliveryReceipts.ts): Co's delivered work, read through
// memberKnowledge.
const docRow = (title: string) => ({ id: 1, user_id: "u", doc_key: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), version: 1, title, kind: null, content: null, content_hash: "h", channel: "pdf_text", status: "delivered", line: null, link: null, task_id: null, source: "task", delivered_at: new Date("2026-10-05T17:00:00Z") });
// Every DB call is answered here, by table.
let tables: Record<string, any[]> = {};
const sql: string[] = [];
const fake = async (text: string) => {
  const t = text.replace(/\s+/g, " ");
  sql.push(t);
  for (const [k, rows] of Object.entries(tables)) if (t.includes(k)) return { rows };
  return { rows: [] as any[] };
};
(pool as any).query = fake;
(pool as any).connect = async () => ({ query: fake, release: () => {} });

const ZONE = "America/Los_Angeles";
const pt = (iso: string) => new Date(`${iso}-07:00`);
const NOW = pt("2026-10-06T11:00:00"); // a Tuesday
const DAY = 86_400_000;

const state = (over: Partial<CallReasonState> = {}): CallReasonState => ({
  now: NOW, zone: ZONE, kind: "checkin_cadence", nudges: [], threads: [], claims: [], milestones: [], plans: [], coWork: [], recentReasonKeys: [], ...over,
});
const thread = (over: Partial<import("../../src/harness/memberThreads.js").MemberThread>) => ({
  id: "t1", text: "x", openedQuote: "x", openedAt: new Date(NOW.getTime() - 3 * DAY).toISOString(), status: "open" as const, feeling: null, dueDate: null,
  nextStep: "check_in" as const, kind: "thread" as const, closedQuote: null, lastTouchedAt: new Date(NOW.getTime() - 3 * DAY).toISOString(), ...over,
});
const claim = (over: Partial<import("../../src/services/factLabels.js").Claim>) => ({
  text: "x", provenance: "user_said" as const, kind: "worry" as const, quote: "x", saidOn: "2026-10-04", confirmedOn: "2026-10-04", expiresOn: "2026-10-14", ...over,
});
const callState = (callReason?: import("../../src/services/callReason.js").CallReasonResult): CallState => ({
  callStatus: null, callStatusUpdatedAt: null, optedOut: false, subscriptionActive: true, requireSubscription: false, localHourOk: true, timezoneKnown: true, lastCallAt: null,
  evidence: { scheduledCallDue: true, recentInboundText: true, routerPlaceCallDecision: true, cadenceSet: true, autoIntakeEligible: true, ...(callReason ? { callReason } : {}) },
});

// ================================================================ 1. only Co's own work on file: no call
const PDF_TITLE = "Post-event branding plan for the Sequin AI launch";
const onlyHomework = state({
  coWork: [PDF_TITLE, "draft and text a plan on Cue's post-event presence"],
  threads: [
    thread({ id: "t-pdf", text: "the post-event branding plan for the Sequin AI launch", openedQuote: "send me the branding plan" }),
    thread({ id: "t-co", text: "Cue will send the one-pager on sponsors", openedQuote: "can you put together a one-pager" }),
  ],
  claims: [claim({ kind: "plan", text: "the PDF went out this morning", quote: null, provenance: "user_said" })],
});
const none = R.callReasonFor(onlyHomework);
check("only Cue's deliverables on file: no reason", none.reason === null, none);
check("everything considered is listed, each excluded with why", none.considered.length === 3 && none.considered.every((c) => !c.kept && !!c.why), none.considered);
check("a thread that is a doc Cue delivered is excluded as Cue's deliverable", /deliverable or task/.test(none.considered.find((c) => c.key === "thread:t-pdf")?.why ?? ""), none.considered);
check("a thread that is Cue's own commitment is excluded (askKind isCoCommitment)", /commitment|task|homework/.test(none.considered.find((c) => c.key === "thread:t-co")?.why ?? ""), none.considered);

const blocked = G.decideCall(callState(none), { kind: "checkin_cadence" }, NOW);
check("a Co-started check-in call with no reason from their life is not placed", !blocked.allowed && blocked.checks.some((c) => c.name === "member_reason" && !c.pass), blocked.checks);
check("the block says why, and jobs can tell it apart (blockedForNoReason)", G.blockedForNoReason(blocked.error) && /considered: /.test(blocked.error ?? ""), blocked.error);
check("the console-bound reason carries kinds and whys, never their words or a doc title", !/Sequin|branding|PDF went out/i.test(blocked.error ?? ""), blocked.error);
check("no reason (none on file at all) also blocks", !G.decideCall(callState({ reason: null, considered: [] }), { kind: "checkin_cadence" }, NOW).allowed);
check("an inferred check-in call gets the same check", !G.decideCall({ ...callState({ reason: null, considered: [] }), evidence: { ...callState({ reason: null, considered: [] }).evidence, scheduledCallDue: false, recentInboundText: false, routerPlaceCallDecision: false } }, null, NOW).allowed);

// ================================================================ 2. a reason from their life: placed, and it reaches the opening
{
  // b. something they said yes to, close (the deadline detector, memberStateNudges.ts)
  const snap = { userId: "u1", zone: ZONE, now: NOW, ownLines: [], intros: [], goals: [], intent: [], lastGoalSurfaceAt: null, lastKeptAt: null, commitments: [],
    cared: [{ itemKey: "event:evt1", name: "Founders Supper Club", kind: "event" as const, date: "2026-10-07", caredAt: pt("2026-10-01T12:00:00"), theirWords: "oh I'd love that", url: null, reminderQueued: false }] };
  const nudges = N.detectAll(snap);
  const r = R.callReasonFor(state({ nudges, coWork: [PDF_TITLE] }));
  check("a deadline on something they said yes to is a reason", r.reason?.kind === "deadline" && /Founders Supper Club/.test(r.reason.text), r);
  const placed = G.decideCall(callState(r), { kind: "checkin_cadence" }, NOW);
  check("and the call is placed", placed.allowed && placed.checks.find((c) => c.name === "member_reason")?.pass === true, placed.checks);
  const p = O.openingPrompt({ firstName: "Jordan", direction: "outbound", summary: "Jordan is a founder. " + "pad ".repeat(100), reason: r.reason });
  check("the outbound opening is written from the reason (their moment)", p.includes("Founders Supper Club") && /Cue called because of this, a moment in their life/.test(p), p.slice(0, 600));
  check("the outbound prompt never offers Cue's homework as an opener (\"something Cue owes them\" is gone)", !/something Cue owes them/.test(p) && /Never open on Cue's own work/.test(p));
  const src = O.openingSource("Jordan is a founder. " + "pad ".repeat(100), "outbound", r.reason);
  check("the line is checked against the reason too (its names are in what Cue knows)", /Why Cue is calling: .*Founders Supper Club/.test(src));
  check("a line about their moment passes the checks", O.openingProblems("Hey Jordan, it's Cue. Still on for the Founders Supper Club?", src, "Jordan") === null, O.openingProblems("Hey Jordan, it's Cue. Still on for the Founders Supper Club?", src, "Jordan"));
  check("{{call_reason}} carries it for the call brain", (R.holdCallReason("u-deadline", "checkin_cadence", r), /Founders Supper Club/.test(R.callReasonVariable("u-deadline", "outbound"))));
  check("{{call_reason}} is empty on an inbound call (they called Cue)", R.callReasonVariable("u-deadline", "inbound") === "");
  check("a held reason expires", R.callReasonVariable("u-deadline", "outbound", Date.now() + R.CALL_REASON.ttlMs + 1) === "");
}
{
  // a worry they mentioned
  const r = R.callReasonFor(state({ claims: [claim({ kind: "worry", text: "worried the Series A partner meeting on Thursday won't go well", quote: "honestly nervous about Thursday's partner meeting" })], coWork: [PDF_TITLE] }));
  check("a worry they told Cue about is a reason", r.reason?.kind === "worry" && /partner meeting/.test(r.reason.text), r);
  check("Cue's inference never starts a call", R.callReasonFor(state({ claims: [claim({ provenance: "co_inferred", quote: null, text: "probably stressed about fundraising" })] })).reason === null);
}
{
  // an upcoming event they mentioned, and a dated thread just past
  const r = R.callReasonFor(state({ plans: [{ name: "the Oakland Join-Up", date: "2026-10-09" }] }));
  check("a plan they mentioned in the next days is a reason", r.reason?.kind === "coming_up" && /Oakland Join-Up/.test(r.reason.text) && r.reason.at === "2026-10-09", r);
  check("a plan two weeks out isn't", R.callReasonFor(state({ plans: [{ name: "the Oakland Join-Up", date: "2026-10-25" }] })).reason === null);
  const past = R.callReasonFor(state({ threads: [thread({ id: "t-pitch", text: "pitching at the demo day", dueDate: "2026-10-05", openedQuote: "I pitch at demo day Monday" })] }));
  check("a dated thing of theirs that just happened: 'how did it go'", past.reason?.kind === "how_it_went" && /yesterday/.test(past.reason.text), past);
}
{
  // their own commitment due today (the commitment detector) outranks an open thread
  const now = pt("2026-10-07T09:30:00");
  const snap = { userId: "u1", zone: ZONE, now, ownLines: [], intros: [], cared: [], goals: [], intent: [], lastGoalSurfaceAt: null, lastKeptAt: null,
    commitments: [{ threadId: "c1", text: "send the investor update", quote: "I'll send the investor update Wednesday", openedAt: pt("2026-10-02T10:00:00"), dueDate: "2026-10-07", status: "open", followedUp: false }] };
  const r = R.callReasonFor(state({ now, nudges: N.detectAll(snap), threads: [thread({ id: "t-x", text: "thinking about moving to Oakland" })] }));
  check("their own commitment coming due is the most immediate reason", r.reason?.kind === "their_commitment" && /investor update/.test(r.reason.text), r);
  check("the open thread is still considered", r.considered.some((c) => c.key === "thread:t-x" && c.kept));
}
{
  // an intro is never a call reason (the first line is heard by whoever picks up; the text nudge carries it)
  const snap = { userId: "u1", zone: ZONE, now: NOW, ownLines: [], cared: [], goals: [], intent: [], lastGoalSurfaceAt: null, lastKeptAt: null, commitments: [],
    intros: [{ otherId: "u-ellis", otherFirstName: "Ellis", introducedAt: pt("2026-10-01T12:00:00"), how: "network" as const, eventName: null, reasonAsEmailed: null, hasOutcomeFollowup: false, otherActive: true }] };
  check("an intro alone is no reason to call", R.callReasonFor(state({ nudges: N.detectAll(snap) })).reason === null);
}
{
  // not the same reason twice running; a sensitive one never leads; a celebration counts
  const t = thread({ id: "t-move", text: "the apartment search in Oakland" });
  check("the reason the last call was about isn't used again", R.callReasonFor(state({ threads: [t], recentReasonKeys: ["thread:t-move"] })).reason === null);
  const s = R.callReasonFor(state({ threads: [thread({ id: "t-s", text: "waiting on biopsy results", feeling: "worried" }), thread({ id: "t-ok", text: "the apartment search in Oakland" })] }));
  check("a sensitive moment ranks after one the first line can say", s.reason?.key === "thread:t-ok", s);
  const only = R.callReasonFor(state({ threads: [thread({ id: "t-s", text: "waiting on biopsy results", feeling: "worried" })] }));
  check("a sensitive moment can still be the reason, marked", only.reason?.sensitive === true);
  const g = O.outboundOpeningGuide(only.reason);
  check("and the opening is told not to name it", !/biopsy/.test(g) && /Don't name it/.test(g));
  const c = R.callReasonFor(state({ milestones: [{ key: "thread:t9", kind: "thread_done", text: "they closed their first paying customer", happenedAt: pt("2026-10-04T12:00:00").toISOString() }] }));
  check("something they finished lately is a reason (celebration)", c.reason?.kind === "celebration");
  check("Cue's own milestone (days with Cue) is not", R.callReasonFor(state({ milestones: [{ key: "days:30", kind: "with_co", text: "30 days with Cue", happenedAt: pt("2026-10-04T12:00:00").toISOString() }] })).reason === null);
}

// ================================================================ 3. intake and member-requested calls
{
  const r = R.callReasonFor(state({ kind: "auto_intake" }));
  check("a brand-new member's intake call has its reason (getting to know them)", r.reason?.kind === "intake" && G.decideCall(callState(r), { kind: "auto_intake" }, NOW).allowed);
  check("its opening is about them, not Cue", /open on them/.test(O.outboundOpeningGuide(r.reason)) && /Never open on Cue's own work/.test(O.outboundOpeningGuide(r.reason)));
  for (const kind of ["router_decision", "scheduled_call", "user_initiated"] as const) {
    check(`member-requested (${kind}) needs no reason from the gate`, !R.needsMemberReason(kind) && G.decideCall(callState({ reason: null, considered: [] }), { kind }, NOW).allowed && !G.decideCall(callState(), { kind }, NOW).checks.some((c) => c.name === "member_reason"));
  }
  check("Co-started kinds are exactly check-in cadence and auto intake", R.needsMemberReason("checkin_cadence") && R.needsMemberReason("auto_intake") && R.CO_INITIATED.size === 2);
  sql.length = 0;
  const asked = await R.callReasonForCall("u-asked", "router_decision", NOW);
  check("a member-requested call reads nothing and holds 'they asked'", sql.length === 0 && asked.reason?.kind === "member_asked" && /They asked for this call/.test(R.callReasonVariable("u-asked", "outbound", NOW.getTime())));
  check("an older pure case with no reason read still decides as before", G.decideCall(callState(), { kind: "checkin_cadence" }, NOW).allowed);
}

// ================================================================ 4. the opening never leads with Co's homework (outbound and inbound)
{
  const ctx = "Where things stand now: Cue sent Jordan the post-event branding plan PDF this morning. Jordan is pitching at demo day Thursday. " + "pad ".repeat(100);
  const homework = [
    "Hey Jordan, it's Cue. The PDF went out this morning, wanted to make sure it landed.",
    "Hey Jordan, it's Cue. Wanted to make sure the branding plan came through okay.",
    "Hey Jordan, it's Cue. Did you get the PDF I sent?",
    "Hey Jordan, it's Cue. Did you have a chance to look at the plan?",
    "Hey Jordan, it's Cue. I sent you the branding plan this morning, any thoughts?",
    "Hey Jordan, it's Cue. Following up on the branding plan.",
    "Hey Jordan, it's Cue. The branding plan is in your inbox.",
    "Hey Jordan, it's Cue. I still owe you that plan.",
  ];
  for (const line of homework) check(`refused (homework): ${line}`, O.openingProblems(line, ctx, "Jordan") === "leads with Cue's homework", O.openingProblems(line, ctx, "Jordan"));
  const theirs = ["Hey Jordan, it's Cue. How's the demo day pitch shaping up?", "Hey Jordan, it's Cue. Still pitching at demo day Thursday?", "Jordan, hi. It's Cue. Did the deck go out to the investors?"];
  for (const line of theirs) check(`accepted (their moment): ${line}`, O.openingProblems(line, ctx + " deck investors", "Jordan") === null, O.openingProblems(line, ctx + " deck investors", "Jordan"));
  // Their own deliverables are their news, not Co's homework.
  for (const t of ["my email went out to investors this morning", "the launch plan is done", "my pitch deck is ready", "the lease is in your inbox"]) check(`not Cue's homework (theirs): ${t}`, !R.leadsWithCoHomework(t));
  check("a commitment in their own words (\"I'll send them the deck Friday\") is theirs, not Cue's", R.coWorkWhy("I'll send them the deck Friday", [], true) === null && R.coWorkWhy("I'll send them the deck Friday", []) !== null);
  check("\"the plan is still coming\" is Cue's homework only when the record says Cue owes it", R.leadsWithCoHomework("The launch plan is still coming.", "Where things stand now: Cue owes them a launch plan. Not sent yet.") && !R.leadsWithCoHomework("The launch plan is still coming.", "They are writing their launch plan."));
  const inbound = O.openingPrompt({ firstName: "Jordan", direction: "inbound", summary: ctx });
  check("inbound: never Cue's agenda, and the homework rule is in the prompt", /never open with Cue's own agenda/.test(inbound) && /Never open on Cue's own work/.test(inbound) && !/Co called because/.test(inbound));
  check("the check is the same function for both directions (openingProblems has no direction)", O.openingProblems.length === 3);
}

// ================================================================ 5. the reads (fake database) and the gate's gather
{
  tables = {
    "FROM member_threads WHERE": [{ id: "t-db", text: "the demo day pitch", opened_quote: "I pitch at demo day Thursday", opened_at: pt("2026-10-03T10:00:00"), status: "open", feeling: "nervous", due_date: "2026-10-08", next_step: "check_in", kind: "thread", closed_quote: null, last_touched_at: pt("2026-10-03T10:00:00") }],
    "FROM document_deliveries": [docRow("Demo day pitch notes")],
    "FROM co_tasks": [],
  };
  const s = await R.loadCallReasonState("u-db", "checkin_cadence", NOW);
  check("the loader reads their threads and Cue's own work", s.threads.length === 1 && s.coWork.includes("Demo day pitch notes"), s);
  const r = R.callReasonFor(s);
  check("a thread of theirs that matches a doc Cue delivered is Cue's work, not a reason", r.reason === null && /deliverable/.test(r.considered[0]?.why ?? ""), r);
  tables["FROM document_deliveries"] = [docRow("Sponsor outreach email")];
  const r2 = R.callReasonFor(await R.loadCallReasonState("u-db", "checkin_cadence", NOW));
  check("the same thread is a reason when Cue's work is something else", r2.reason?.kind === "coming_up" && r2.reason.feeling === "nervous", r2);

  // gatherCallState fills the reason (and holds it) for a check-in call
  tables = { "checkin_call_cadence_days": [{ sms_opted_out: false, identity_captured: true, city: null, checkin_call_cadence_days: 7, has_real_profile: true, had_real_call: true }], "FROM document_deliveries": [docRow(PDF_TITLE)] };
  const cs = await G.gatherCallState("u-gather", { call_status: null, call_status_updated_at: null, subscription_status: "active" }, { kind: "checkin_cadence" });
  check("the gate's gather reads the reason for a check-in call", !!cs.evidence.callReason && cs.evidence.callReason.reason === null, cs.evidence);
  check("and holds it for the call", R.heldCallReason("u-gather")?.kind === "checkin_cadence");
  const cs2 = await G.gatherCallState("u-gather", { call_status: null, call_status_updated_at: null, subscription_status: "active" }, { kind: "router_decision" });
  check("a member-requested call replaces anything held with 'they asked'", cs2.evidence.callReason?.reason?.kind === "member_asked" && R.heldCallReason("u-gather")?.kind === "router_decision");
  tables = {};
}

// ================================================================ 6. wiring
{
  const gate = read("src/harness/callGate.ts");
  check("the gate reads the reason in gatherCallState and checks it in decideCall", /evidence\.callReason = await callReasonForCall\(userId, kind, now\)/.test(gate) && /name: "member_reason"/.test(gate));
  const trig = read("src/services/callTrigger.ts");
  check("every dial goes through gatherCallState + decideCall, and the evidence (with the reason) is logged", /gatherCallState\(userId, user, auth\)/.test(trig) && /proposal: \{ requested: auth, evidence: callState\.evidence \}/.test(trig));
  check("the opening is prepared after the gate (so the held reason is this call's)", trig.indexOf("decideCall(") < trig.indexOf("prebuildOpening("));
  const op = read("src/services/callOpening.ts");
  check("prebuildOpening writes the outbound line from the held reason", /heldCallReason\(userId, now\)\?\.result\.reason/.test(op) && /writeOpening\(\{ firstName, direction, summary: s, userId, reason \}\)/.test(op));
  const job = read("src/jobs/proactiveCheckinCall.ts");
  check("the check-in cron logs call.skipped_no_reason with what was considered", /decision: "call\.skipped_no_reason"/.test(job) && /considered: held\?\.result\.considered/.test(job));
  check("a no-reason skip keeps the stamp (next cadence slot re-checks), an hours block still retries", /blockedForNoReason\(result\.error\) && !\/8am-9pm\/\.test\(result\.error\)\) \{[\s\S]*?continue;/.test(job));
}

// Review of #110: homework in disguise is never a reason.
{
  const R2 = await import("../../src/services/callReason.js");
  check("'waiting on the dinner plan Cue is putting together' is Cue's work, not a reason", R2.coWorkWhy("waiting on the dinner plan Cue is putting together", []) !== null);
  check("'excited to get the research on coworking spaces' is Cue's work, not a reason", R2.coWorkWhy("excited to get the research on coworking spaces", []) !== null);
  check("their own news still is a reason ('nervous about the Thursday pitch')", R2.coWorkWhy("nervous about the Thursday pitch", []) === null);
}
// The call path on the member-knowledge layer: when the member-name read fails, memberKnowledge rejects, and every call reader goes
// without member context, never with unstripped data.
{
  const CC = await import("../../src/services/callContext.js");
  const CT = await import("../../src/services/callTools.js");
  const B = await import("../../src/services/callBriefing.js");
  const secret = "Dana's divorce lawyer said Friday";
  tables = {
    "FROM users WHERE id": [{ phone_number: "+15555550100", first_name: "Jordan" }],
    "FROM document_deliveries": [docRow(secret)],
    "FROM ask_checkins": [{ ask_id: "a1", ask_text: secret, kind: "find", created_at: NOW, last_mentioned_at: NOW }],
    "memory_type = 'text_exchange'": [{ content: `Co replied: ${secret}`, created_at: NOW }],
  };
  const real = (pool as any).query;
  (pool as any).query = async (text: string, args?: unknown[]) => {
    if (/event_guest_match_nudges|network_introductions/.test(text)) throw new Error("names read failed");
    return real(text, args);
  };
  const held = await R.callReasonForCall("u-closed", "checkin_cadence", NOW);
  check("names unreadable: no reason for a Co-started call (fails closed)", held.reason === null && held.considered[0]?.key === "read_failed", held);
  const knowledge = await CC.buildCallKnowledge("u-closed").then(() => "resolved", () => "rejected");
  const summary = await CC.buildCallContextSummary("u-closed");
  check("names unreadable: the call context rejects, and the call opens with no member facts (nothing unstripped)", knowledge === "rejected" && summary === CC.CALL_NOTES_UNAVAILABLE && !summary.includes(secret), summary);
  // Review of #122: "" reads as "your first real conversation" in the agent's prompt, so an existing member calling in got intake.
  const E = await import("../../src/services/elevenLabsCalls.js");
  check("...and never as a first conversation: the summary isn't empty and says not to run intake", summary.trim().length > 0 && /If that's empty, this is your first real conversation/.test(E.CALL_CONTEXT_BLOCK) && /not a first conversation/.test(summary) && /don't introduce yourself or run intake/.test(summary));
  const plain = await CC.buildContextSummary("u-closed");
  check("names unreadable: the text reply's summary is empty too", plain === "");
  const member = await CT.loadMemberOnCall("u-closed");
  check("names unreadable: the call tools get the member but no tasks or loops", member.firstName === "Jordan" && member.tasks.length === 0 && member.loops === null && member.city === null);
  const briefing = await B.buildCallBriefing("u-closed", NOW).catch(() => null);
  check("names unreadable: the briefing still builds (no city)", !!briefing && !briefing.rightNow.includes(secret));
  (pool as any).query = real;
  // One read per call setup: the briefing takes their city from the call context's read when it's under way.
  tables = { "LEFT JOIN co_profiles": [{ first_name: "Jordan", city: "Oakland", goals: null, intent: null, updated_at: NOW }] };
  const seen: string[] = [];
  (pool as any).query = async (text: string, args?: unknown[]) => { seen.push(text.replace(/\s+/g, " ")); return real(text, args); };
  const built = CC.buildCallKnowledge("u-share").catch(() => null);
  const shared = CC.callKnowledgeInFlight("u-share");
  const brief = await B.buildCallBriefing("u-share", NOW).catch(() => null);
  await built;
  const profileReads = seen.filter((t) => /FROM users u LEFT JOIN co_profiles/.test(t)).length;
  check("the briefing reuses the call context's member-knowledge read (one layer read per setup)", !!shared && profileReads === 1 && !!brief, { profileReads, shared: !!shared });
  (pool as any).query = real;
  tables = {};
}

console.log(`call reason gate: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
