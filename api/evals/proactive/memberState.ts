// Member-state proactiveness and restraint with memory (services/memberStateNudges.ts, services/kindRestraint.ts, 2026-10-08).
// Layer 1: pure detectors and gates, a fake store for the preference write, a fake model for the drafts. Zero tokens.
//   npx tsx evals/proactive/memberState.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const N = await import("../../src/services/memberStateNudges.js");
const K = await import("../../src/services/kindRestraint.js");
const P = await import("../../src/harness/proactive.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const { PROACTIVE_PURPOSE } = await import("../../src/harness/proactivePurpose.js");
const { proactivePaused, pausedTypes } = await import("../../src/services/proactivePause.js");
const { gate } = await import("../../src/harness/core.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// Every DB call in this file is answered here: the preference write is captured, anything else is empty.
const sql: { text: string; args: any[] }[] = [];
const fake = async (text: string, args: any[] = []) => { sql.push({ text: text.replace(/\s+/g, " ").trim(), args }); return { rows: [] as any[] }; };
(pool as any).query = fake;
(pool as any).connect = async () => ({ query: fake, release: () => {} });

const ZONE = "America/Los_Angeles";
const DAY = 86_400_000;
const HOUR = 3_600_000;
// 2026-10-06 is a Tuesday; Pacific is UTC-7 that week.
const pt = (iso: string) => new Date(`${iso}-07:00`);
const localHour = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", hourCycle: "h23" }).format(d));

const base = (now: Date, over: Partial<import("../../src/services/memberStateNudges.js").Snapshot> = {}): import("../../src/services/memberStateNudges.js").Snapshot => ({
  userId: "u-jordan", zone: ZONE, now, ownLines: [], intros: [], cared: [], goals: [], intent: [], lastGoalSurfaceAt: null, lastKeptAt: null, commitments: [], ...over,
});
const cand = (type: any, over: Partial<import("../../src/harness/proactive.js").Candidate> = {}): import("../../src/harness/proactive.js").Candidate => ({
  id: "c1", userId: "u-jordan", type, targetKey: `${type}:x`, topicKey: `${type}:x`, summary: "s", priority: P.TYPE_POLICY[type as keyof typeof P.TYPE_POLICY].priority,
  dueAt: new Date(0), expiresAt: null, payload: {}, attempts: 0, createdAt: new Date(0), ...over,
});

// ================================================================ a. an intro nobody followed up
{
  const introducedAt = pt("2026-10-02T12:00:00");
  const intro = { otherId: "u-ellis", otherFirstName: "Ellis", introducedAt, how: "event" as const, eventName: "The Founders Dinner", reasonAsEmailed: null, hasOutcomeFollowup: false, otherActive: true };
  // An event intro email can go out ahead of the event, so its nudge waits 5 days (review, 2026-10-08); a network intro waits 3.
  check("intro: an event intro four days old isn't nudged yet (the event may not have happened)", N.planNudges(base(pt("2026-10-06T11:00:00"), { intros: [intro], ownLines: [] }), []).queue.length === 0);
  check("intro: a network intro four days old is", N.planNudges(base(pt("2026-10-06T11:00:00"), { intros: [{ ...intro, how: "network" as const, eventName: null }], ownLines: [] }), []).queue.length === 1);
  check("intro: an event intro's facts say 'around' the event, never 'after' it", N.introNudgeFacts(intro, pt("2026-10-08T11:00:00")).co_introduced_you_two_by_email === "around The Founders Dinner");
  const now = pt("2026-10-08T11:00:00");
  const s = base(now, { intros: [intro], ownLines: [{ at: pt("2026-10-03T09:00:00"), text: "the dinner was great, thanks" }] });
  const first = N.planNudges(s, []);
  check("intro: an event intro six days old they haven't brought up produces one nudge", first.queue.length === 1 && first.queue[0].type === "intro_nudge" && first.queue[0].kind === "intro_followup");
  const e = first.queue[0];
  check("intro: it goes inside their day (late morning to early evening, 8am-9pm window)", localHour(e.dueAt) >= 8 && localHour(e.dueAt) < 21 && e.expiresAt > e.dueAt);
  const stored = [{ entryKey: e.entryKey, fingerprint: e.fingerprint, status: "sent" }];
  check("intro: after it went, silence for the same state (next pass)", N.planNudges(s, stored).queue.length === 0);
  check("intro: silence for the same state days later too", N.planNudges({ ...s, now: pt("2026-10-09T11:00:00") }, stored).queue.length === 0);
  // The target key carries the state, and the ledger never takes a target twice.
  const sentTarget = N.targetKeyOf(e);
  const blocked = P.candidateChecks(cand("intro_nudge", { targetKey: sentTarget }), { now, sends: [{ type: "intro_nudge", targetKey: sentTarget, topicKey: null, sentAt: now, exempt: false }], lastInboundAt: null });
  check("intro: the same state's target can't be sent twice (not_sent_before)", blocked.some((c) => c.name === "not_sent_before" && !c.pass));
  // The state changes: they were introduced again (a new email). One more, then silence again.
  const again = { ...intro, introducedAt: pt("2026-10-12T12:00:00") };
  const s2 = base(pt("2026-10-18T11:00:00"), { intros: [again] });
  const re = N.planNudges(s2, stored);
  check("intro: a changed state re-arms the entry once (new fingerprint, new target)", re.queue.length === 1 && re.queue[0].fingerprint !== e.fingerprint && N.targetKeyOf(re.queue[0]) !== sentTarget);
  check("intro: and then silence for that state", N.planNudges(s2, [{ entryKey: e.entryKey, fingerprint: re.queue[0].fingerprint, status: "queued" }]).queue.length === 0);
  check("intro: nothing when they've named the person since", N.planNudges(base(now, { intros: [intro], ownLines: [{ at: pt("2026-10-04T10:00:00"), text: "Grabbing coffee with Ellis next week" }] }), []).queue.length === 0);
  check("intro: nothing before it's had a few days", N.planNudges(base(pt("2026-10-03T11:00:00"), { intros: [intro] }), []).queue.length === 0);
  check("intro: nothing when the intro has its own outcome follow-up (one topic, one follow-up)", N.planNudges(base(now, { intros: [{ ...intro, hasOutcomeFollowup: true }] }), []).queue.length === 0);
  check("intro: nothing about someone who is no longer a member", N.planNudges(base(now, { intros: [{ ...intro, otherActive: false }] }), []).queue.length === 0);

  // ---- no cross-member leak: the nudge is built from the recipient's own state only.
  const withOtherSide = { ...intro, otherRepliedAt: pt("2026-10-03T08:00:00"), otherSaid: "SECRET_OTHER_WORDS", otherOpenedEmail: true } as any;
  const withoutOtherSide = { ...intro, otherRepliedAt: null, otherSaid: null, otherOpenedEmail: false } as any;
  const a = N.detectIntroNudges(base(now, { intros: [withOtherSide] }));
  const b = N.detectIntroNudges(base(now, { intros: [withoutOtherSide] }));
  check("leak: whether the other member replied, opened or said anything never changes the nudge (existence, state or words)", JSON.stringify(a) === JSON.stringify(b) && a.length === 1);
  const factKeys = Object.keys(a[0].facts).sort().join(",");
  check("leak: the draft facts are only the recipient's view (name, how, how long ago, what the email said)", factKeys === "co_introduced_you_two_by_email,days_since_the_intro_email,their_name,why_the_intro_email_said_you_should_meet,worth_asking,you_have_not_mentioned_them_since");
  check("leak: no reply status and none of the other member's words in the facts", !/SECRET_OTHER_WORDS|repl|opened|seen|read|status|interested/i.test(JSON.stringify(a[0].facts)));
  check("leak: the facts builder takes no input about the other member's side", !/repl|status|interested|opened|seen/i.test(src("services/memberStateNudges.ts").match(/export function introNudgeFacts\(([^)]*)\)/)?.[1] ?? "x"));
  const leakSrc = src("services/memberStateNudges.ts").slice(src("services/memberStateNudges.ts").indexOf("async function introsOf"), src("services/memberStateNudges.ts").indexOf("async function caredOf"));
  check("leak: the intro read never touches the other member's texts, interest or replies", !/user_id = p\.id|a_interested_at|b_interested_at|text_exchange/.test(leakSrc) && /WHERE user_id = \$1 AND memory_type = 'event_intro_email_sent'/.test(leakSrc));

  // The draft: the model writes it, code checks it says nothing about the other member's side.
  const prompts: string[] = [];
  let reply = "";
  P.setProactiveModelForTests(async (p) => { prompts.push(p); return reply; });
  const c = { id: "c9", userId: "u-jordan", type: "intro_nudge", payload: { entryKey: e.entryKey, fingerprint: e.fingerprint, kind: e.kind, facts: e.facts, meta: e.meta } };
  const deps = { current: async () => e, leak: async () => null };
  reply = "Did you and Ellis get a chance to connect after The Founders Dinner? Happy to draft a short note you could send.";
  const ok: any = await N.draftStateNudge(c, { firstName: "Jordan" }, deps);
  const okChecks = gate(P.checkDraft(ok.text ?? "", ok.rules ?? {})).ok;
  check("draft: a good nudge names the person and passes every check", "messages" in ok && okChecks && ok.rules.mustIncludeAny?.includes("Ellis"));
  check("draft: the prompt carries none of the other member's side", prompts.length > 0 && !/SECRET_OTHER_WORDS/.test(prompts[0]) && /their_name: Ellis/.test(prompts[0]));
  reply = "Has Ellis gotten back to you yet about the intro?";
  const status: any = await N.draftStateNudge(c, { firstName: "Jordan" }, deps);
  check("draft: a line about whether the other one replied fails its checks (and is redrafted or dropped, never sent)", "rules" in status && !gate(P.checkDraft(status.text, status.rules)).ok);
  reply = "Ellis said she'd love to meet you properly, want me to set something up?";
  const claim: any = await N.draftStateNudge(c, { firstName: "Jordan" }, deps);
  check("draft: a line claiming what the other one said or wants is dropped", "skip" in claim);
  const leaky: any = await N.draftStateNudge(c, { firstName: "Jordan" }, { current: async () => e, leak: async () => "a private fact" });
  check("draft: a line carrying something only the other member may see is dropped", "skip" in leaky);
  const moved: any = await N.draftStateNudge(c, { firstName: "Jordan" }, { current: async () => null, leak: async () => null });
  check("draft: the state is re-read at draft time; changed means no text", "skip" in moved && prompts.length === 4);
  reply = "Just checking in on Ellis!";
  const filler: any = await N.draftStateNudge(c, { firstName: "Jordan" }, deps);
  check("draft: 'just checking in' never passes", "rules" in filler && !gate(P.checkDraft(filler.text, filler.rules)).ok);
  P.setProactiveModelForTests(null);
}

// ================================================================ b. a deadline on something they cared about
{
  const opp = { itemKey: "name:the climate fellowship", name: "The Climate Fellowship", kind: "opportunity" as const, date: "2026-10-09", caredAt: pt("2026-10-01T15:00:00"), theirWords: "ooh I want to apply", url: "https://example.org/fellowship", reminderQueued: false };
  const early = N.planNudges(base(pt("2026-10-06T09:00:00"), { cared: [opp] }), []);
  check("deadline: not queued days ahead of its time", early.queue.length === 0 && early.held.some((h) => /not close enough/.test(h.why)));
  const now = pt("2026-10-06T11:00:00");
  const plan = N.planNudges(base(now, { cared: [opp] }), []);
  const e = plan.queue[0];
  check("deadline: one nudge for an opportunity they said yes to, with a deadline close", plan.queue.length === 1 && e?.type === "deadline_nudge" && e.kind === "deadline");
  const deadline = pt("2026-10-09T00:00:00");
  check("deadline: timed before the deadline with lead (two days ahead, 10am their time)", e.dueAt < deadline && localHour(e.dueAt) === 10 && e.dueAt.getTime() === pt("2026-10-07T10:00:00").getTime());
  check("deadline: expires before the deadline passes (noon on the day), never after", e.expiresAt <= pt("2026-10-09T12:00:00") && e.expiresAt > e.dueAt);
  check("deadline: the facts name it, its date, and their own words", e.facts.the_thing === "The Climate Fellowship" && /Friday, October 9 \(2026-10-09\)/.test(String(e.facts.the_deadline_date)) && e.facts.what_they_said_when_co_sent_it === "ooh I want to apply");
  check("deadline: once per state", N.planNudges(base(pt("2026-10-07T12:00:00"), { cared: [opp] }), [{ entryKey: e.entryKey, fingerprint: e.fingerprint, status: "sent" }]).queue.length === 0);
  check("deadline: a moved deadline re-arms it", N.planNudges(base(pt("2026-10-12T11:00:00"), { cared: [{ ...opp, date: "2026-10-15" }] }), [{ entryKey: e.entryKey, fingerprint: e.fingerprint, status: "sent" }]).queue.length === 1);
  check("deadline: nothing after the deadline", N.detectDeadlineNudges(base(pt("2026-10-10T11:00:00"), { cared: [opp] })).length === 0);
  check("deadline: nothing on the deadline afternoon (too late to be useful)", N.detectDeadlineNudges(base(pt("2026-10-09T13:00:00"), { cared: [opp] })).length === 0);
  check("deadline: nothing when they said yes to it the day before the heads-up (they know)", N.detectDeadlineNudges(base(now, { cared: [{ ...opp, caredAt: pt("2026-10-06T15:00:00") }] })).length === 0);
  check("deadline: nothing when the sweep's own day-before reminder is queued or sent (one heads-up)", N.detectDeadlineNudges(base(now, { cared: [{ ...opp, reminderQueued: true }] })).length === 0);
  check("deadline: nothing for a date with no year (never guessed)", N.detectDeadlineNudges(base(now, { cared: [{ ...opp, date: "Oct 9" }] })).length === 0);
  const ev = N.detectDeadlineNudges(base(pt("2026-10-06T11:00:00"), { cared: [{ ...opp, kind: "event", name: "Gallery Night at SFMOMA", date: "2026-10-07T19:00:00-07:00" }] }));
  check("deadline: an event the day before, by 10am, gone well before it starts", ev.length === 1 && ev[0].expiresAt <= pt("2026-10-07T12:00:00") && ev[0].dueAt.getTime() === pt("2026-10-06T11:00:00").getTime());
  check("deadline: the link goes as its own message", src("services/memberStateNudges.ts").includes("return { messages: [text, ...url], text, rules };"));
  // The dispatch gate keeps it inside 8am-9pm and before the deadline.
  const c = cand("deadline_nudge", { dueAt: e.dueAt, expiresAt: e.expiresAt, payload: { kind: "deadline" } });
  const at = (d: Date) => P.evaluateCandidates({ now: d, timezone: ZONE, optedOut: false, candidates: [c], sends: [], lastInboundAt: null });
  check("deadline: at 11pm their time it waits (local_hours)", at(pt("2026-10-07T23:00:00")).eligible.length === 0 && at(pt("2026-10-07T23:00:00")).userChecks.some((k) => k.name === "local_hours" && !k.pass));
  check("deadline: at 10:30am the day it's due it can go", at(pt("2026-10-07T10:30:00")).eligible.length === 1);
  check("deadline: after it expired it can't go", at(pt("2026-10-09T13:00:00")).eligible.length === 0);
}

// ================================================================ c. a goal gone quiet
{
  const now = pt("2026-10-06T11:00:00");
  const g1 = { id: "g1", text: "Raise a pre-seed round for the climate startup", confirmedAt: new Date(now.getTime() - 30 * DAY), state: "active" as const, coTask: false };
  const g2 = { id: "g2", text: "Find a design partner for the brand refresh", confirmedAt: new Date(now.getTime() - 25 * DAY), state: "active" as const, coTask: false };
  const one = N.planNudges(base(now, { goals: [g1, g2] }), []);
  check("goal: at most one gentle surface, the one quiet longest", one.queue.length === 1 && one.queue[0].type === "goal_nudge" && one.queue[0].entryKey === "goal:g1");
  check("goal: the draft facts are their goal in their words only", Object.keys(one.queue[0].facts).join(",") === "the_goal_in_their_words");
  check("goal: never for a done goal", N.detectGoalNudge(base(now, { goals: [{ ...g1, state: "done" }] })).length === 0);
  check("goal: never for a stale (set-aside) goal", N.detectGoalNudge(base(now, { goals: [{ ...g1, state: "stale" }] })).length === 0);
  check("goal: never for a goal that is Co's own task", N.detectGoalNudge(base(now, { goals: [{ ...g1, coTask: true }] })).length === 0);
  check("goal: none within the seasonal window (a goal check-in or nudge 20 days ago)", N.detectGoalNudge(base(now, { goals: [g1], lastGoalSurfaceAt: new Date(now.getTime() - 20 * DAY) })).length === 0);
  check("goal: one again after the season", N.detectGoalNudge(base(now, { goals: [g1], lastGoalSurfaceAt: new Date(now.getTime() - 60 * DAY) })).length === 1);
  check("goal: none when they mentioned it lately", N.detectGoalNudge(base(now, { goals: [g1], ownLines: [{ at: new Date(now.getTime() - 5 * DAY), text: "pre-seed raise is going slowly, two more investor calls" }] })).length === 0);
  check("goal: none when they kept a find lately (movement)", N.detectGoalNudge(base(now, { goals: [g1], lastKeptAt: new Date(now.getTime() - 5 * DAY) })).length === 0);
  check("goal: none for a goal set in the last three weeks", N.detectGoalNudge(base(now, { goals: [{ ...g1, confirmedAt: new Date(now.getTime() - 10 * DAY) }] })).length === 0);
  const old = { ...g1, confirmedAt: new Date(now.getTime() - 70 * DAY) };
  const intent = [{ id: "g1", kind: "goal", status: "active", text: g1.text, confirmed_at: old.confirmedAt.toISOString() }];
  check("goal: a goal past the season belongs to the seasonal check-in, not a nudge (no double)", N.detectGoalNudge(base(now, { goals: [old], intent })).length === 0);
  const st = { now, sends: [{ type: "goal_checkin", targetKey: "goal_checkin:g9:2026-09", topicKey: "goal:g9", sentAt: new Date(now.getTime() - 30 * DAY), exempt: false }], lastInboundAt: null };
  check("goal: the gate holds a goal nudge inside the season after a goal check-in", P.candidateChecks(cand("goal_nudge"), st).some((k) => k.name === "goal_season" && !k.pass));
  check("goal: and a goal check-in inside the season after a goal nudge", P.candidateChecks(cand("goal_checkin"), { ...st, sends: [{ ...st.sends[0], type: "goal_nudge" }] }).some((k) => k.name === "goal_season" && !k.pass));
  check("goal: held while they're struggling (never a pressure on a bad day)", P.HOLD_WHILE_STRUGGLING.has("goal_nudge") && P.HOLD_WHILE_STRUGGLING.has("commitment_nudge") && !P.HOLD_WHILE_STRUGGLING.has("intro_nudge") && !P.HOLD_WHILE_STRUGGLING.has("deadline_nudge"));
}

// ================================================================ d. something they said they'd do
{
  const t = { threadId: "t1", text: "send the deck to Noor", quote: "I'll send Noor the deck Friday", openedAt: pt("2026-10-05T18:00:00"), dueDate: "2026-10-09", status: "open", followedUp: false };
  check("commitment: not queued days ahead", N.planNudges(base(pt("2026-10-06T11:00:00"), { commitments: [t] }), []).queue.length === 0);
  const now = pt("2026-10-08T12:00:00");
  const plan = N.planNudges(base(now, { commitments: [t] }), []);
  const e = plan.queue[0];
  check("commitment: one nudge, the morning it's due, before it's late", plan.queue.length === 1 && e.type === "commitment_nudge" && e.dueAt.getTime() === pt("2026-10-09T09:00:00").getTime() && e.expiresAt.getTime() === pt("2026-10-09T17:00:00").getTime());
  check("commitment: the facts are their own words and the date", e.facts.their_own_words === t.quote && /2026-10-09/.test(String(e.facts.the_due_date)));
  const atDraft = N.detectCommitmentNudges(base(pt("2026-10-09T09:30:00"), { commitments: [t] }))[0];
  check("commitment: re-read when it goes, the facts say today (not the queue-time 'tomorrow'), same state", atDraft?.fingerprint === e.fingerprint && atDraft.facts.when_relative_to_today === "today" && /2026-10-09/.test(String(atDraft.facts.today)));
  check("draft: the words come from the entry re-read at draft time", /const now = await \(deps\.current \?\? currentEntry\)/.test(src("services/memberStateNudges.ts")) && /draftFactsOf\(\{ payload: \{ facts: now\.facts \} \}\)/.test(src("services/memberStateNudges.ts")));
  check("commitment: once per state", N.planNudges(base(pt("2026-10-09T10:00:00"), { commitments: [t] }), [{ entryKey: e.entryKey, fingerprint: e.fingerprint, status: "sent" }]).queue.length === 0);
  check("commitment: none when they talked about it in the last day and a half", N.detectCommitmentNudges(base(pt("2026-10-09T10:00:00"), { commitments: [t], ownLines: [{ at: pt("2026-10-08T20:00:00"), text: "finishing the deck tonight for Noor" }] })).length === 0);
  check("commitment: none for one said on the day it's due", N.detectCommitmentNudges(base(pt("2026-10-09T10:00:00"), { commitments: [{ ...t, openedAt: pt("2026-10-09T08:00:00") }] })).length === 0);
  check("commitment: none after 5pm on the day (too late), none after the day", N.detectCommitmentNudges(base(pt("2026-10-09T18:00:00"), { commitments: [t] })).length === 0 && N.detectCommitmentNudges(base(pt("2026-10-10T10:00:00"), { commitments: [t] })).length === 0);
  check("commitment: none once it's resolved or its follow-up went", N.detectCommitmentNudges(base(now, { commitments: [{ ...t, status: "resolved" }] })).length === 0 && N.detectCommitmentNudges(base(now, { commitments: [{ ...t, followedUp: true }] })).length === 0);
}

// ================================================================ restraint with memory
{
  // Royce, 2026-10-08: 30 days off, then ONE trial; trial let pass, off another 30; trial answered, back on. Counting from deploy.
  {
    const a = pt("2026-09-01T10:00:00");
    const i1 = { id: "i1", kind: "intro_followup" as const, sentAt: a, message: "Did you and Ellis get a chance to connect?" };
    const i2 = { id: "i2", kind: "intro_followup" as const, sentAt: new Date(a.getTime() + 3 * DAY), message: "Want me to draft a short note to Sarah?" };
    const offAt = new Date(i2.sentAt.getTime() + 2 * DAY);
    const at = (d: number) => K.evaluateKindRestraint({ sends: [i1, i2], inbound: [], now: new Date(offAt.getTime() + d * DAY) }).get("intro_followup")!;
    check("trial: off for 29 days after two let pass", at(29).suppressed && !at(29).trial);
    check("trial: at 30 days one trial message may go (not 'enabled': the preference stays off)", !at(30).suppressed && at(30).trial === true);
    const trial = { id: "t1", kind: "intro_followup" as const, sentAt: new Date(offAt.getTime() + 31 * DAY), message: "Still want an intro to someone in climate?" };
    const pending = K.evaluateKindRestraint({ sends: [i1, i2, trial], inbound: [], now: new Date(trial.sentAt.getTime() + 3 * HOUR) }).get("intro_followup")!;
    check("trial: while the trial waits for its answer, no second one", pending.suppressed);
    const ignored = K.evaluateKindRestraint({ sends: [i1, i2, trial], inbound: [], now: new Date(trial.sentAt.getTime() + 3 * DAY) }).get("intro_followup")!;
    check("trial let pass: off again, the 30 days start over from it", ignored.suppressed && ignored.since!.getTime() > offAt.getTime() && ignored.evidence.join() === "t1");
    const stored = [{ kind: "intro_followup" as const, state: "suppressed" as const, suppressedAt: offAt, enabledAt: null, evidence: ["i1", "i2"] }];
    check("trial let pass: the newer off date is written (so the next trial waits the full 30 days)", K.preferenceChanges(new Map([["intro_followup", ignored]]), stored).some((c) => c.to === "suppressed"));
    check("a trial window is never written as 'enabled'", K.preferenceChanges(new Map([["intro_followup", at(30)]]), stored).length === 0);
    const answered = K.evaluateKindRestraint({ sends: [i1, i2, trial], inbound: [{ at: new Date(trial.sentAt.getTime() + 2 * HOUR), text: "yes please" }], now: new Date(trial.sentAt.getTime() + 3 * DAY) }).get("intro_followup")!;
    check("trial answered: back on, and recorded as enabled", !answered.suppressed && !answered.trial && K.preferenceChanges(new Map([["intro_followup", answered]]), stored).some((c) => c.to === "enabled"));
    const fromStore = K.evaluateKindRestraint({ sends: [], inbound: [], stored, now: new Date(offAt.getTime() + 31 * DAY) }).get("intro_followup")!;
    check("an older suppression held only by the store also gets its trial after 30 days", !fromStore.suppressed && fromStore.trial === true);
    check("counting starts at deploy: only sends from the first kind-tagged send count", /ps\.sent_at >= COALESCE\(\(SELECT MIN\(sent_at\) FROM proactive_sends WHERE kind IS NOT NULL\), 'infinity'::timestamptz\)/.test(fs.readFileSync(new URL("../../src/services/kindRestraint.ts", import.meta.url), "utf8")));
  }
  const t0 = pt("2026-09-20T10:00:00");
  const s1 = { id: "s1", kind: "intro_followup" as const, sentAt: t0, message: "Did you and Ellis get a chance to connect?" };
  const s2 = { id: "s2", kind: "intro_followup" as const, sentAt: new Date(t0.getTime() + 3 * DAY), message: "Want me to draft a short note to Sarah for you?" };
  const now = new Date(t0.getTime() + 6 * DAY);
  const v = K.evaluateKindRestraint({ sends: [s1, s2], inbound: [], now });
  check("restraint: two of a kind let pass in a row suppress that kind", v.get("intro_followup")!.suppressed && v.get("intro_followup")!.evidence.join() === "s1,s2");
  check("restraint: other kinds are untouched", !v.get("find")!.suppressed && !v.get("deadline")!.suppressed);
  check("restraint: one let pass is not enough", !K.evaluateKindRestraint({ sends: [s1], inbound: [], now }).get("intro_followup")!.suppressed);
  check("restraint: a send still inside its window isn't counted yet", !K.evaluateKindRestraint({ sends: [s1, s2], inbound: [], now: new Date(s2.sentAt.getTime() + 2 * HOUR) }).get("intro_followup")!.suppressed);
  check("restraint: a thumbs down is not an answer", K.evaluateKindRestraint({ sends: [s1, s2], inbound: [{ at: new Date(s2.sentAt.getTime() + HOUR), text: "Disliked “Want me to draft a short note to Sarah for you?”" }], now }).get("intro_followup")!.suppressed);
  check("restraint: a reply in the window breaks the streak", !K.evaluateKindRestraint({ sends: [s1, s2], inbound: [{ at: new Date(s1.sentAt.getTime() + 5 * HOUR), text: "not yet, this week" }], now }).get("intro_followup")!.suppressed);
  // Offers that rode in one text are one message.
  const batch = [0, 1, 2].map((i) => ({ id: `f${i}`, kind: "find" as const, sentAt: new Date(t0.getTime() + i * 2000), message: `Offer ${i}` }));
  check("restraint: three offers in one text count once (not suppressed by one unanswered text)", !K.evaluateKindRestraint({ sends: batch, inbound: [], now }).get("find")!.suppressed);
  check("restraint: kinds map from the existing types", K.kindOf("event_offer", {}) === "find" && K.kindOf("event_offer", { reminder: true }) === "deadline" && K.kindOf("event_match_nudge") === "find" && K.kindOf("goal_checkin") === "goal_nudge" && K.kindOf("window_followup", { kind: "commitment" }) === "member_commitment" && K.kindOf("companion") === null && K.kindOf("debrief") === null && K.kindOf("intro_nudge") === "intro_followup");

  // The learned preference is written, and the decision logged.
  sql.length = 0;
  const changes = K.preferenceChanges(v, []);
  check("restraint: the flip to suppressed is a change to record", changes.length === 1 && changes[0].kind === "intro_followup" && changes[0].to === "suppressed");
  await K.syncKindPreferences("u-jordan", v, []);
  const ins = sql.find((q) => /^INSERT INTO member_kind_preferences/.test(q.text));
  check("restraint: the preference row records kind, state, reason and the evidence ids", !!ins && ins.args[1] === "intro_followup" && ins.args[2] === "suppressed" && JSON.parse(ins.args[6]).join() === "s1,s2" && /let 2 intro_followup texts/.test(ins.args[5]));
  check("restraint: and a decision row (proactive.kindRestraint suppress:intro_followup)", sql.some((q) => /^INSERT INTO harness_decisions/.test(q.text) && q.args[1] === "proactive.kindRestraint" && q.args[4] === "suppress:intro_followup"));
  sql.length = 0;
  await K.syncKindPreferences("u-jordan", v, [{ kind: "intro_followup", state: "suppressed", suppressedAt: s2.sentAt, enabledAt: null, evidence: ["s1", "s2"] }]);
  check("restraint: nothing written again while it stays the same", sql.length === 0);

  // The gate: every kind it covers, in the dispatch checks.
  const st = { now, sends: [], lastInboundAt: null, suppressedKinds: ["intro_followup", "find", "deadline", "goal_nudge", "member_commitment"] as any };
  const held = (c: any) => P.candidateChecks(c, st).some((k) => k.name === "kind_restraint" && !k.pass);
  check("restraint: the dispatch gate holds every suppressed kind", held(cand("intro_nudge")) && held(cand("deadline_nudge")) && held(cand("goal_nudge")) && held(cand("commitment_nudge")) && held(cand("event_offer", { payload: { askId: "profile", fromProfile: true } })) && held(cand("event_match_nudge")) && held(cand("goal_checkin")) && held(cand("event_offer", { payload: { askId: "a1", reminder: true } })));
  check("restraint: an answer to their own explicit ask is never held (they asked)", !held(cand("event_offer", { payload: { askId: "a1" } })));
  check("restraint: untracked types are never held (companion, debrief)", !held(cand("companion")) && !held(cand("debrief")));
  check("restraint: the gate is in the pick and re-checked at send time", /suppressedKinds: raw\.suppressed,/.test(src("harness/proactive.ts")) && /suppressedKinds: await loadKindRestraint\(client, person\.userId, now\)/.test(src("harness/proactive.ts")));

  // Re-enabled by an answer: a positive tapback on one of them (any time later), or a reply in the window of a later one.
  const loved = K.evaluateKindRestraint({ sends: [s1, s2], inbound: [{ at: new Date(t0.getTime() + 8 * DAY), text: "Loved “Want me to draft a short note to Sarah for you?”" }], now: new Date(t0.getTime() + 9 * DAY) });
  check("re-enable: a positive tapback on one of them turns the kind back on", !loved.get("intro_followup")!.suppressed && loved.get("intro_followup")!.evidence.join() === "s2");
  const back = K.preferenceChanges(loved, [{ kind: "intro_followup", state: "suppressed", suppressedAt: s2.sentAt, enabledAt: null, evidence: ["s1", "s2"] }]);
  check("re-enable: recorded as a change (enable)", back.length === 1 && back[0].to === "enabled");
  sql.length = 0;
  await K.syncKindPreferences("u-jordan", loved, [{ kind: "intro_followup", state: "suppressed", suppressedAt: s2.sentAt, enabledAt: null, evidence: ["s1", "s2"] }]);
  check("re-enable: the row goes back to enabled and the decision says enable", sql.some((q) => /^INSERT INTO member_kind_preferences/.test(q.text) && q.args[2] === "enabled") && sql.some((q) => q.args[4] === "enable:intro_followup"));
  const threaded = K.evaluateKindRestraint({ sends: [s1, s2], inbound: [{ at: new Date(t0.getTime() + 10 * DAY), text: `yes please [Replying to Co's text: "Did you and Ellis get a chance to connect?"]` }], now: new Date(t0.getTime() + 11 * DAY) });
  check("re-enable: a threaded reply to one of them, however late, turns it back on", !threaded.get("intro_followup")!.suppressed);
  const f1 = { id: "a1", kind: "find" as const, sentAt: t0, message: "The Climate Fellowship" };
  const f2 = { id: "a2", kind: "find" as const, sentAt: new Date(t0.getTime() + 3 * DAY), message: "Gallery Night" };
  const f3 = { id: "a3", kind: "find" as const, sentAt: new Date(t0.getTime() + 9 * DAY), message: "Founders Dinner" };
  const replied = K.evaluateKindRestraint({ sends: [f1, f2, f3], inbound: [{ at: new Date(f3.sentAt.getTime() + 2 * HOUR), text: "ooh that one, yes" }], now: new Date(t0.getTime() + 12 * DAY) });
  check("re-enable: a reply to the next one of that kind (an answer to their own ask still goes) turns it back on", !replied.get("find")!.suppressed && K.evaluateKindRestraint({ sends: [f1, f2], inbound: [], now: new Date(t0.getTime() + 8 * DAY) }).get("find")!.suppressed);
  const stored = [{ kind: "goal_nudge" as const, state: "suppressed" as const, suppressedAt: new Date(t0.getTime() - 200 * DAY), enabledAt: null, evidence: ["old1", "old2"] }];
  // 2026-10-08 (Royce): nothing is muted for good; an old suppression gets its one trial after 30 days, a recent one holds.
  const recentStored = [{ ...stored[0], suppressedAt: new Date(now.getTime() - 10 * DAY) }];
  check("re-enable: a suppression held by the store holds for 30 days, then allows one trial", K.evaluateKindRestraint({ sends: [], inbound: [], stored: recentStored, now }).get("goal_nudge")!.suppressed && K.evaluateKindRestraint({ sends: [], inbound: [], stored, now }).get("goal_nudge")!.trial === true);
  check("re-enable: tapback reading", K.readInbound({ at: now, text: "Liked “hey”" }).signal === "positive" && K.readInbound({ at: now, text: "Disliked “hey”" }).signal === "negative" && K.readInbound({ at: now, text: "Reacted 👎 to “hey”" }).signal === "negative" && K.readInbound({ at: now, text: "Reacted 🔥 to “hey”" }).signal === "positive" && K.readInbound({ at: now, text: "sounds good" }).quoted === null);
}

// ================================================================ hours, pause, opt-out still gate everything
{
  const now = pt("2026-10-07T11:00:00");
  for (const type of ["intro_nudge", "deadline_nudge", "goal_nudge", "commitment_nudge"] as const) {
    const c = cand(type);
    const ev = (o: Partial<import("../../src/harness/proactive.js").PickState>) => P.evaluateCandidates({ now, timezone: ZONE, optedOut: false, candidates: [c], sends: [], lastInboundAt: null, ...o });
    check(`${type}: eligible inside their hours`, ev({}).eligible.length === 1);
    check(`${type}: never outside 8am-9pm their time`, ev({ now: pt("2026-10-07T21:30:00") }).eligible.length === 0 && ev({ now: pt("2026-10-07T07:30:00") }).eligible.length === 0);
    check(`${type}: never after opt-out`, ev({ optedOut: true }).eligible.length === 0);
    check(`${type}: spaced from any text Co sent (3h)`, ev({ sends: [{ type: "companion", targetKey: "k", topicKey: null, sentAt: new Date(now.getTime() - HOUR), exempt: false }] }).eligible.length === 0);
    check(`${type}: registered (draft, purpose, policy)`, typeof (proactiveRegistry as any)[type]?.draft === "function" && !!(PROACTIVE_PURPOSE as any)[type] && !!(P.TYPE_POLICY as any)[type]);
  }
  // 2026-10-08 review: a deadline heads-up is Co's own, so it counts against the daily cap too (three yeses, not three texts a day).
  check("caps: every member-state nudge counts against the daily cap (none is an answer)", !P.isAnswering(cand("intro_nudge")) && !P.isAnswering(cand("goal_nudge")) && !P.isAnswering(cand("commitment_nudge")) && !P.isAnswering(cand("deadline_nudge")));
  const ess = fs.readFileSync(new URL("../../src/services/eventSurfacingSweep.ts", import.meta.url), "utf8");
  check("a sweep reminder is skipped when a deadline nudge already covered it, by both keys (events and opportunities)", /entry_key = ANY\(\$2::text\[\]\) AND status IN \('queued','sent'\)/.test(ess) && /deadline:\$\{offerItemKey\(item\.match as any\)\}/.test(ess));
  const { offerItemKey } = await import("../../src/services/offerReactions.js");
  check("the nudge's opportunity key is the reaction's item key (name:<lowercased name>), which the sweep now checks", offerItemKey({ name: "Founders Fellowship" } as any) === "name:founders fellowship" && offerItemKey({ name: "x", event_api_id: "abc" } as any) === "event:abc");
  check("one deadline heads-up a day at most (type gap)", (P.TYPE_POLICY as any).deadline_nudge.typeGapDays === 1);
  check("an intro is nudged only when its email is on record as sent (member_connections), never from network_introductions alone", /if \(prev\) byOther\.set/.test(fs.readFileSync(new URL("../../src/services/memberStateNudges.ts", import.meta.url), "utf8")));
  const capped = P.evaluateCandidates({ now, timezone: ZONE, optedOut: false, candidates: [cand("goal_nudge")], sends: [{ type: "ask_checkin", targetKey: "k", topicKey: null, sentAt: new Date(now.getTime() - 4 * HOUR), exempt: false }], lastInboundAt: new Date(now.getTime() - 3.5 * HOUR) });
  check("caps: a goal nudge waits behind the day's other-lane text (daily cap)", capped.eligible.length === 0 && capped.perCandidate[0].checks.some((k) => k.name === "daily_cap" && !k.pass));
  check("pause: PROACTIVE_PAUSED stops the dispatcher", proactivePaused({ PROACTIVE_PAUSED: "true" } as any) && /export async function runProactiveDispatch[\s\S]{0,120}if \(proactivePaused\(\)\) return;/.test(src("harness/proactive.ts")));
  check("pause: PROACTIVE_PAUSED_TYPES holds the new types like any other", pausedTypes({ PROACTIVE_PAUSED_TYPES: "intro_nudge,goal_nudge" } as any).join() === "intro_nudge,goal_nudge" && /status = 'pending' AND NOT \(type = ANY\(\$2::text\[\]\)\)/.test(src("harness/proactive.ts")));
  process.env.PROACTIVE_PAUSED = "true";
  sql.length = 0;
  const paused = await N.runMemberStateNudges(now);
  check("pause: the hourly pass queues nothing while paused (pending ones wait; nothing is dropped)", paused.queued === 0 && sql.length === 0);
  delete process.env.PROACTIVE_PAUSED;
  check("one sender: nudges are candidates in the one dispatcher, never sent here", !/sendblue|sendExempt\(/.test(src("services/memberStateNudges.ts")) && /enqueueCandidate\(\{/.test(src("services/memberStateNudges.ts")));
  check("hourly: the pass is on the hourly cadence", /cron\.schedule\("5 \* \* \* \*"[\s\S]{0,200}runMemberStateNudges/.test(src("jobs/index.ts")));
}

console.log(`\nmember state + restraint: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
