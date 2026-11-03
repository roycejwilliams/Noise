// A member's attention (harness/attention.ts, notification grouping PR B, Royce 2026-11-02): grouped by their thread, back-off after
// silence, the defaults with no rule of theirs, and their state. Eli's real day is replayed in evals/proactive/door.ts (1b).
// Layer 1: pure functions and the dispatch's own wiring (read from source), zero tokens, no database, nothing sent.
//   npx tsx evals/proactive/attention.ts
import { readFileSync } from "fs";
const A = await import("../../src/harness/attention.js");
const PR = await import("../../src/harness/proactive.js");
const G = await import("../../src/harness/notifyGate.js");
const CG = await import("../../src/harness/callGate.js");
type Candidate = import("../../src/harness/proactive.js").Candidate;
type Preference = import("../../src/services/memberPreferences.js").Preference;
type Counted = import("../../src/harness/notifyGate.js").Counted;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
};
const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url).pathname, "utf8");
const ZONE = "America/Los_Angeles";
// 2026-11-03 is a Tuesday; Pacific is UTC-8.
const pt = (iso: string) => new Date(`${iso}-08:00`);
const HOUR = 3_600_000;
const NOW = pt("2026-11-03T14:00:00");
const OLD_MEMBER = pt("2026-10-01T10:00:00");
let seq = 0;
const cand = (type: string, payload: any = {}, over: Partial<Candidate> = {}): Candidate => {
  const id = over.id ?? `c${++seq}`;
  return { id, userId: "u-1", type: type as any, targetKey: `${type}:${id}`, topicKey: `${type}:${id}`, summary: `${type} ${id}`, priority: PR.TYPE_POLICY[type as keyof typeof PR.TYPE_POLICY]?.priority ?? 50, dueAt: pt("2026-11-03T08:00:00"), expiresAt: pt("2026-11-10T08:00:00"), payload, attempts: 0, createdAt: pt("2026-11-03T08:00:00"), ...over };
};
const find = (askId: string, extra: any = {}, over: Partial<Candidate> = {}) => cand("event_offer", { askId, fromProfile: askId === "profile", picked: true, match: { tier: 2 }, ...extra }, over);
const att = (o: Partial<import("../../src/harness/attention.js").AttentionState> = {}) => ({ sent: [] as Counted[], inbound: [] as Date[], sentToday: [] as any[], lastAsked: null, ...o });
const rule = (r: any, covers = "all", channel = "all"): Preference => ({ id: "r1", area: "contact", channel, covers, rule: r, basis: "explicit", type: "standing", words: ["their words"], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: ZONE, state: "active", setAt: pt("2026-10-20T10:00:00").toISOString() }) as any;
const checksFor = (o: Partial<Parameters<typeof A.attentionChecks>[0]>) => A.attentionChecks({ now: NOW, zone: ZONE, cls: "unsolicited", channel: "text", joinedAt: OLD_MEMBER, att: att(), prefs: [], ...o });
const names = (ks: { name: string; pass: boolean }[]) => ks.filter((k) => !k.pass).map((k) => k.name);

// ================================================================ 3. grouped by the member's thread
{
  const a1 = find("ask-1", {}, { id: "f1" });
  const a1b = find("ask-1", { match: { tier: 3 } }, { id: "f2" });
  const a2 = find("ask-2", { match: { tier: 3 } }, { id: "f3" });
  check("thread: two finds for one ask share it (ids settle it)", A.sameThread(a1, a1b) && A.sameAsk(a1, a1b));
  check("thread: two different asks with no thread read are different things", !A.sameThread(a1, a2));
  const r = A.threadRiders(a1, [a1b, a2]);
  check("thread: two finds for one ask become the better one (the lead); the other ask's find doesn't ride", r.riders.length === 0 && r.sameAskLeft.map((x) => x.id).join() === "f2" && r.otherThread.map((x) => x.id).join() === "f3");
  // Two asks a read put on the same member thread ride together (still one find per ask).
  const t1 = find("ask-1", { threadRead: { thread: "t-1", at: "x" } }, { id: "g1" });
  const t2 = find("ask-2", { threadRead: { thread: "t-1", at: "x" }, match: { tier: 3 } }, { id: "g2" });
  const t3 = find("ask-2", { threadRead: { thread: "t-1", at: "x" }, match: { tier: 1 } }, { id: "g3" });
  const tr = A.threadRiders(t1, [t2, t3]);
  check("thread: finds for two asks on one thread ride together; a second find for the same ask doesn't", tr.riders.map((x) => x.id).join() === "g2" && tr.sameAskLeft.map((x) => x.id).join() === "g3");
  const p1 = find("profile", {}, { id: "p1" });
  const p2 = find("profile", { match: { tier: 3 } }, { id: "p2" });
  check("thread: finds that only fit their profile share one key, so a morning's tiers still go together", A.sameThread(p1, p2) && A.threadRiders(p1, [p2]).riders.length === 1);
  // A find and a check-in about the same thing become one message about that thing.
  const checkin = cand("companion", { threadId: "t-1" }, { id: "k1" });
  const heavy = cand("companion", { threadId: "t-1", heavy: { endedAt: "x" } }, { id: "k2" });
  const safety = cand("companion", { threadId: "t-1", safetyFollowUp: true }, { id: "k3" });
  const askCheckin = cand("ask_checkin", { askId: "ask-1" }, { id: "k4" });
  const otherCheckin = cand("companion", { threadId: "t-9" }, { id: "k5" });
  const requestedDoor = cand("task_update", { door: true, cls: "requested", taskId: 7, messages: ["Your draft is ready."], threadRead: { thread: "t-1", at: "x" } }, { id: "d1" });
  const classOf = (x: Candidate) => G.candidateClass(x.type, PR.isAnswering(x), x.payload);
  // Review of #367: only from what went, and never a requested find. t1 and t3 are finds for asks they made (requested); a resurfaced
  // find for the same ask (again) is Cue's own.
  const ownSameAsk = find("ask-1", { again: true, threadRead: { thread: "t-1", at: "x" } }, { id: "g4" });
  const ownOtherAsk = find("ask-7", { again: true, threadRead: { thread: "t-1", at: "x" } }, { id: "g5" });
  const folds = A.foldPlan({ included: [t1, t2], pending: [checkin, heavy, safety, askCheckin, otherCheckin, requestedDoor, t3, ownSameAsk, ownOtherAsk], classOf });
  const folded = folds.map((f) => f.candidate.id).sort().join();
  check("fold: the check-ins about the same thing and Cue's own find for the same ask are covered", folded === "g4,k1,k4", folded);
  check("fold: never a requested find (it waits and goes as itself), never Cue's own find for another ask", !/g3|g5/.test(folded));
  check("fold: never the day-after check-in after a heavy moment, never a safety follow-up, never another thread's check-in, never a requested delivery", !/k2|k3|k5|d1/.test(folded));
  check("fold: says why, by id", folds.every((f) => /same (thing|ask)/.test(f.why)));
  check("fold: nothing delivered, nothing covered", A.foldPlan({ included: [], pending: [checkin, ownSameAsk], classOf }).length === 0);
  // A partial send covers only what arrived: an extra counts only when every one of its bubbles went.
  const di = A.deliveredItems("lead", [{ candidate: "x1", messages: ["https://a", "cap a"] }, { candidate: "x2", messages: ["https://b", "cap b"] }], ["lead text", "https://a", "cap a", "https://b"]);
  check("fold: a partial send covers only the items whose words all went", di.join() === "lead,x1");
  check("fold: a send where nothing went covers nothing", A.deliveredItems("lead", [], []).length === 0);
  check("fold: the dispatch folds from what was delivered (deliveredItems over result.delivered)", /foldPlan\(\{ included: deliveredItems\(c, extras, result\.delivered\)/.test(src("harness/proactive.ts")));
  // Different topics wait for different days; one message about a thing a day.
  const sentToday = [find("ask-1", {}, { id: "s1" })];
  check("thread_today: a find for another thing waits for another day once something went today", names(checksFor({ item: a2, att: att({ sentToday }) })).includes("thread_today"));
  check("thread_today: a second message about the same thing the same day waits too", names(checksFor({ item: a1b, att: att({ sentToday }) })).includes("thread_today"));
  check("thread_today: on a quiet day it goes", !names(checksFor({ item: a2 })).includes("thread_today"));
  // The read: only when the ids don't settle it and there's something to group with; its answer is checked in code.
  check("read: a lone item on a quiet day is never read", A.threadReadDue({ pending: [a1], sentToday: [], openThreads: 3 }).length === 0);
  check("read: nothing is read when they have no open threads", A.threadReadDue({ pending: [a1, a2], sentToday: [], openThreads: 0 }).length === 0);
  check("read: an item with its own thread id is never read", A.threadReadDue({ pending: [checkin, a1], sentToday: [], openThreads: 2 }).map((x) => x.id).join() === "f1");
  const labels = new Map([["T1", "t-1"], ["T2", "t-2"]]);
  const parsed = A.readThreadAnswer('{"items": [{"n": 1, "thread": "T2"}, {"n": 2, "thread": null}, {"n": 3, "thread": "T9"}]}', labels, [1, 2, 3]);
  check("read: a label it was given maps to that thread; null is none; a label it wasn't given is no answer", parsed.get(1) === "t-2" && parsed.get(2) === null && !parsed.has(3));
  check("read: the prompt lists their threads and the items, and says null when it can't tell", /T1\. a thread/.test(A.threadReadPrompt([{ n: 1, line: "[event_offer] x" }], [{ label: "T1", text: "a thread" }])) && /you can't tell, say null/.test(A.threadReadPrompt([], [])));
  const items = [{ ...a1, payload: { ...a1.payload } }, { ...a2, payload: { ...a2.payload } }];
  const got = await A.readThreads({ userId: "u-1", items, threads: [{ id: "t-1", text: "x" }], write: false, generate: async () => '{"items": [{"n": 1, "thread": "T1"}]}' });
  check("read: stored on the item it answered for; an item it didn't answer stays unread (read again later)", got.get("f1")?.thread === "t-1" && (items[0].payload as any).threadRead?.thread === "t-1" && !(items[1].payload as any).threadRead);
  const failedRead = await A.readThreads({ userId: "u-1", items: [{ ...a1, payload: {} }], threads: [{ id: "t-1", text: "x" }], write: false, generate: async () => { throw new Error("down"); } });
  check("read: a read that fails stores nothing (the item groups by its ids)", failedRead.size === 0);
  check("read: never a regex over their words: the thread is decided by ids, then the model read", !/RegExp\(|\.test\(.*(?:askText|text)/.test(src("harness/attention.ts").split("// ---------------------------------------------------------------- 6 and 7")[0].replace(/export function withoutPhrase[\s\S]*?\n}\n/, "")));
}

// ================================================================ 6. back off when they're quiet
{
  const text = (iso: string, cls: any = "unsolicited"): Counted => ({ at: pt(iso), cls, channel: "text" });
  const one = att({ sent: [text("2026-11-02T10:00:00")] });
  check("back-off: one unanswered: the next waits 48h after it", names(checksFor({ att: one, now: pt("2026-11-03T14:00:00") })).includes("quiet_backoff") && !names(checksFor({ att: one, now: pt("2026-11-04T10:01:00") })).includes("quiet_backoff"));
  const two = att({ sent: [text("2026-10-29T10:00:00"), text("2026-11-02T10:00:00")] });
  check("back-off: two in a row unanswered: 96h", A.unansweredRun(two, NOW).k === 2 && names(checksFor({ att: two, now: pt("2026-11-05T14:00:00") })).includes("quiet_backoff") && !names(checksFor({ att: two, now: pt("2026-11-06T10:01:00") })).includes("quiet_backoff"));
  check("back-off: bounded at a week however long the silence", A.backoffHours(3) === 168 && A.backoffHours(12) === 168);
  const answered = att({ sent: [text("2026-11-02T10:00:00")], inbound: [pt("2026-11-02T11:00:00")] });
  check("back-off: a reply ends it at once", A.unansweredRun(answered, NOW).k === 0 && !names(checksFor({ att: answered })).includes("quiet_backoff"));
  check("back-off: a requested delivery they didn't answer isn't Cue's silence to back off from", A.unansweredRun(att({ sent: [text("2026-11-02T10:00:00", "requested")] }), NOW).k === 0);
  check("back-off: silence is never consent and never a preference: nothing is recorded from it (no writes in the module's pure part)", !/INSERT|co_facts|memberPreferences\.(?:store|save)/.test(src("harness/attention.ts").split("// ---------------------------------------------------------------- the two model reads")[0]));
  // Never the interest question twice in a row unanswered.
  const composed = { messages: ["https://x", "A room this Friday.", "Does this one interest you?"], closing: "Does this one interest you?", text: "A room this Friday.\nDoes this one interest you?" };
  const asked = { at: pt("2026-11-02T10:00:00"), asked: true };
  const d = A.dropRepeatInterest(composed, asked, pt("2026-11-01T09:00:00"));
  check("interested: the second in a row unanswered goes without its question", d.dropped && d.composed.messages.length === 2 && d.composed.closing === null && !/interest/.test(d.composed.text));
  check("interested: after they wrote back, the question can go again", !A.dropRepeatInterest(composed, asked, pt("2026-11-02T12:00:00")).dropped);
  check("interested: when the last didn't ask it, this one may", !A.dropRepeatInterest(composed, { at: asked.at, asked: false }, null).dropped);
  check("interested: the dispatch drops it from the composed bundle and records that the message asked it", /const r = dropRepeatInterest\(composed, state\.attention\.lastAsked, state\.lastInboundAt\);/.test(src("harness/proactive.ts")) && /if \(composed\?\.closing && result\.delivered\.includes\(composed\.closing\)\) await pool\.query\(`UPDATE proactive_candidates SET payload = payload \|\| '\{"closingAsked": true\}'::jsonb/.test(src("harness/proactive.ts")));
}

// ================================================================ 7. the defaults when there's no rule
{
  const today = (h: string, cls: any = "unsolicited", channel: any = "text"): Counted => ({ at: pt(`2026-11-03T${h}`), cls, channel });
  check("defaults: the first day is quiet", names(checksFor({ joinedAt: pt("2026-11-03T09:00:00") })).includes("first_day_quiet") && !names(checksFor({ joinedAt: pt("2026-11-02T13:59:00") })).includes("first_day_quiet"));
  check("defaults: one unrequested message a day", names(checksFor({ att: att({ sent: [today("09:00:00")], inbound: [pt("2026-11-03T09:30:00")] }) })).includes("default_daily"));
  check("defaults: a requested message earlier today isn't counted", !names(checksFor({ att: att({ sent: [today("09:00:00", "requested")] }) })).includes("default_daily"));
  // Often: 3+ unrequested texts in the window, two in three answered within a day.
  const often = att({ sent: [{ at: pt("2026-10-29T10:00:00"), cls: "unsolicited", channel: "text" }, { at: pt("2026-10-30T10:00:00"), cls: "checkin", channel: "text" }, { at: pt("2026-10-31T10:00:00"), cls: "unsolicited", channel: "text" }, today("09:00:00")], inbound: [pt("2026-10-29T12:00:00"), pt("2026-10-30T12:00:00"), pt("2026-10-31T12:00:00"), pt("2026-11-03T09:30:00")] });
  check("defaults: 'often' is from their reply rate (3 of 3 answered within a day)", A.repliesOften(often, NOW).often && A.repliesOften(often, NOW).sent === 3);
  check("defaults: two a day when they reply often", !names(checksFor({ att: often })).includes("default_daily") && names(checksFor({ att: { ...often, sent: [...often.sent, today("12:00:00")], inbound: [...often.inbound, pt("2026-11-03T12:30:00")] } })).includes("default_daily"));
  check("defaults: a member Cue hasn't written to enough isn't 'often'", !A.repliesOften(att({ sent: [{ at: pt("2026-10-31T10:00:00"), cls: "unsolicited", channel: "text" }], inbound: [pt("2026-10-31T11:00:00")] }), NOW).often);
  check("defaults: no Cue-started text on a day Cue started a call", names(checksFor({ att: att({ sent: [today("09:00:00", "checkin", "call")], inbound: [pt("2026-11-03T09:10:00")] }) })).includes("call_text_same_day"));
  check("defaults: and no Cue-started call on a day Cue started a text", names(checksFor({ channel: "call", cls: "checkin", att: att({ sent: [today("09:00:00")], inbound: [pt("2026-11-03T09:10:00")] }) })).includes("call_text_same_day"));
  check("defaults: a call they booked earlier today doesn't stop a text (only Cue-started counts)", !names(checksFor({ att: att({ sent: [today("09:00:00", "requested", "call")] }) })).includes("call_text_same_day"));
  // Calls: the call gate reads the same defaults (both mediums).
  const callState = (attention: any): any => ({ callStatus: null, callStatusUpdatedAt: null, optedOut: false, subscriptionActive: true, requireSubscription: false, localHourOk: true, lastCallAt: null, evidence: { scheduledCallDue: true, recentInboundText: true, routerPlaceCallDecision: true, cadenceSet: true, autoIntakeEligible: true }, memberRule: null, pickerBudget: null, attention });
  const callAtt = PR.callAttentionFrom({ now: NOW, zone: ZONE, cls: "checkin", joinedAt: OLD_MEMBER, att: att({ sent: [today("09:00:00")], inbound: [pt("2026-11-03T09:10:00")] }), prefs: [] });
  check("calls: a check-in call Cue starts is held on a day Cue started a text", !callAtt.pass && !CG.decideCall(callState(callAtt), { kind: "checkin_cadence" }, NOW).allowed);
  check("calls: a call they booked or asked for never reads the defaults", CG.decideCall(callState(callAtt), { kind: "scheduled_call" }, NOW).allowed && CG.decideCall(callState(callAtt), { kind: "user_initiated" }, NOW).allowed);
  check("calls: a new member's first day is quiet for calls Cue starts too", !PR.callAttentionFrom({ now: NOW, zone: ZONE, cls: "unsolicited", joinedAt: pt("2026-11-03T08:00:00"), att: att(), prefs: [] }).pass);
  check("calls: the gate reads it for calls Cue starts only, from the same module", /attention: kind && CUE_STARTED_CALLS\.has\(kind\) \? await import\("\.\/proactive\.js"\)\.then\(\(P\) => P\.callAttentionCheck\(userId, CALL_CLASS\[kind\], now\)\)/.test(src("harness/callGate.ts")) && /if \(state\.attention && kind && CUE_STARTED_CALLS\.has\(kind\)\) checks\.push\(state\.attention\);/.test(src("harness/callGate.ts")));
  check("defaults: constants, not env switches", !/process\.env/.test(src("harness/attention.ts")));
}

// ================================================================ 7. a member's own rule beats a default (both directions)
{
  const twoToday = att({ sent: [{ at: pt("2026-11-03T09:00:00"), cls: "unsolicited", channel: "text" }], inbound: [pt("2026-11-03T09:05:00")] });
  const more = [rule({ maxPerDay: 3 })];
  check("rule: 'up to 3 a day' beats the default of 1 (more)", !names(checksFor({ att: twoToday, prefs: more })).includes("default_daily"));
  check("rule: ...and beats first-day quiet and the call/text default", !names(checksFor({ joinedAt: pt("2026-11-03T09:00:00"), prefs: more })).includes("first_day_quiet") && !names(checksFor({ prefs: more, att: att({ sent: [{ at: pt("2026-11-03T09:00:00"), cls: "checkin", channel: "call" }], inbound: [pt("2026-11-03T09:05:00")] }) })).includes("call_text_same_day"));
  check("rule: their own number is then enforced by their gate (3 a day: the 4th is held)", !G.memberRuleCheck(more, { now: NOW, cls: "unsolicited", channel: "text", sent: [9, 10, 11].map((h) => ({ at: pt(`2026-11-03T${String(h).padStart(2, "0")}:00:00`), cls: "unsolicited" as const, channel: "text" as const })), zone: ZONE }).pass);
  const less = [rule({ maxPerWeek: 2 })];
  check("rule: 'twice a week' (less) replaces the daily default, and its own gate holds the third", !names(checksFor({ prefs: less })).includes("default_daily") && !G.memberRuleCheck(less, { now: NOW, cls: "unsolicited", channel: "text", sent: [pt("2026-10-30T10:00:00"), pt("2026-11-01T10:00:00")].map((at) => ({ at, cls: "unsolicited" as const, channel: "text" as const })), zone: ZONE }).pass);
  check("rule: a rule about only calls doesn't replace the text default", names(checksFor({ att: twoToday, prefs: [rule({ maxPerDay: 3 }, "all", "call")] })).includes("default_daily"));
  check("rule: an inferred rule isn't theirs to win with (it stays tentative)", names(checksFor({ att: twoToday, prefs: [{ ...rule({ maxPerDay: 3 }), basis: "inferred" } as any] })).includes("default_daily"));
  check("rule: a vague 'less' has no number: the defaults stay", names(checksFor({ att: twoToday, prefs: [rule({ less: true })] })).includes("default_daily"));
}

// ================================================================ 8. their state
{
  const held = { needsCare: true, moodHold: { state: "held", hold: true, heldHours: 2 } as any };
  const capped = { needsCare: true, moodHold: { state: "released_cap", hold: false, heldHours: 49 } as any };
  const base = { now: NOW, timezone: ZONE, optedOut: false, sends: [], lastInboundAt: pt("2026-11-03T08:00:00"), joinedAt: OLD_MEMBER };
  const profileFind = find("profile", {}, { id: "h1" });
  const askFind = find("ask-1", {}, { id: "h2" });
  const companion = cand("companion", { threadId: "t-1" }, { id: "h3" });
  const intro = cand("event_match_nudge", {}, { id: "h4" });
  const lookout = cand("task_update", { door: true, cls: "unsolicited", messages: ["https://x", "y"] }, { id: "h5" });
  const ev = PR.evaluateCandidates({ ...base, ...held, candidates: [profileFind, askFind, companion, intro, lookout] } as any);
  const ok = (id: string) => ev.eligible.some((c) => c.id === id);
  const why = (id: string) => ev.perCandidate.find((p) => p.candidate.id === id)!.checks.filter((k) => !k.pass).map((k) => k.name);
  check("hard day: a find Cue started waits", !ok("h1") && why("h1").includes("hard_day"));
  check("hard day: an offer Cue started waits, and a look-out's find too", why("h4").includes("hard_day") && why("h5").includes("hard_day"));
  check("hard day: companionship goes", ok("h3"));
  check("hard day: what they asked for still goes (an answer to their ask)", ok("h2"));
  const ev2 = PR.evaluateCandidates({ ...base, ...capped, candidates: [profileFind] } as any);
  check("hard day: bounded by the hold's cap (timing only): at the cap the find competes again", ev2.eligible.some((c) => c.id === "h1"));
  check("hard day: a safety follow-up is never held by it", !A.hardDayHolds({ cls: "checkin", purpose: "companion", payload: { safetyFollowUp: true }, held: true }) && !A.hardDayHolds({ cls: "unsolicited", purpose: "offer", payload: { safetyFollowUp: true }, held: true }));
  // A check-in never asserts a feeling they didn't share: Cue's own draft, against their own words only.
  const ELI_DRAFT = "Still thinking about the technical partner and community organizer search. Both still open, both still heavy. How's that sitting with you today?";
  const ELI_WORDS = ["finding people I can potentially partner with to build this, and also finding community organizers. They're both pressing."];
  let seen = "";
  const fails = await A.feelingCheck({ userId: "u-1", draft: ELI_DRAFT, ownWords: ELI_WORDS, generate: async (p) => { seen = p; return '{"asserts": true, "phrase": "both still heavy"}'; } });
  check("feeling: Eli's 11-02 15:30 line fails the check (the read names the phrase)", !fails.pass && fails.name === A.NO_ASSERTED_FEELING && /both still heavy/.test(fails.reason ?? ""));
  check("feeling: the read sees the draft and only their own words (never Cue's inferred feeling)", seen.includes(ELI_DRAFT) && seen.includes("They're both pressing.") && !/discouraged/.test(seen));
  check("feeling: a check-in that only asks passes", (await A.feelingCheck({ userId: "u-1", draft: "How's the partner search going?", ownWords: ELI_WORDS, generate: async () => '{"asserts": false, "phrase": ""}' })).pass);
  check("feeling: a read that can't answer fails closed (the check-in waits; it never goes unchecked)", !(await A.feelingCheck({ userId: "u-1", draft: ELI_DRAFT, ownWords: ELI_WORDS, generate: async () => "not json" })).pass && !(await A.feelingCheck({ userId: "u-1", draft: ELI_DRAFT, ownWords: ELI_WORDS, generate: async () => { throw new Error("down"); } })).pass);
  const P = src("harness/proactive.ts");
  check("feeling: the dispatch runs it on every check-in Cue writes (a door text's too, never a find bundle), and again on the rewrite", /const checkinFeeling = !composed && feelingCheckApplies\(candidateClass\(c\.type, isAnswering\(c\), c\.payload\), c\.payload\);/.test(P) && /draftChecks = await withFeeling\(draftChecks, draft\.text\);/.test(P) && /const fixedChecks = await withFeeling\(withRecord\(withRepeat\(checkDraft\(fixed\.text, fixed\.rules\), fixed\.text\), fixed\.messages\), fixed\.text\);/.test(P));
  check("feeling: their words come from their own lines only (memberThreads.ownLines: texts and their call lines, never Cue's)", /T\.ownLines\(userId\)\)\.then\(\(ls\) => ls\.map\(\(l\) => l\.text\)\)/.test(P));
}

// ================================================================ review of #367
{
  // Intros first: a possible intro is never held by the defaults, the back-off or the one-thread day.
  const busy = att({ sent: [{ at: pt("2026-11-03T09:00:00"), cls: "unsolicited", channel: "text" }, { at: pt("2026-11-02T09:00:00"), cls: "unsolicited", channel: "text" }], sentToday: [find("ask-9", {}, { id: "z9" })] });
  const introAsk = cand("direct_ask", { door: true, cls: "unsolicited", intro: true, messages: ["x"] }, { id: "i1" });
  const nudge = cand("event_match_nudge", {}, { id: "i2" });
  check("intro: an intro ask Cue sends to the other side reads none of the defaults, the back-off or the one-thread day", checksFor({ item: introAsk, att: busy, joinedAt: pt("2026-11-03T09:00:00") }).length === 0 && checksFor({ item: nudge, att: busy }).length === 0);
  check("intro: a find on the same day still does (only intros are exempt)", names(checksFor({ item: find("profile"), att: busy })).length > 0);
  const evI = PR.evaluateCandidates({ now: NOW, timezone: ZONE, optedOut: false, sends: [], lastInboundAt: pt("2026-11-03T08:00:00"), joinedAt: OLD_MEMBER, needsCare: true, moodHold: { state: "held", hold: true, heldHours: 2 }, memberRules: { prefs: [], sent: busy.sent }, attention: busy, candidates: [introAsk] } as any);
  check("intro: a hard day still times it (it waits)", evI.perCandidate[0].checks.some((k) => k.name === "hard_day" && !k.pass));
  check("intro: held by a hard day, it never expires inside the hold (valid-until moves to a day past now)", A.introHeldExpiry(pt("2026-11-03T15:00:00"), NOW)?.getTime() === NOW.getTime() + 24 * HOUR && A.introHeldExpiry(pt("2026-11-09T15:00:00"), NOW) === null);
  check("intro: the dispatch moves it while a hard day holds it", /if \(!isPossibleIntro\(p\.candidate\) \|\| !p\.checks\.some\(\(k\) => k\.name === "hard_day" && !k\.pass\)\) continue;\n    const to = introHeldExpiry\(p\.candidate\.expiresAt, state\.now\);/.test(src("harness/proactive.ts")));
  // The feeling read: never a safety follow-up or a heavy-moment check-in; a read that can't answer waits, never counted.
  check("feeling: never read on a safety follow-up or the check-in after a heavy or hard moment", !A.feelingCheckApplies("checkin", { safetyFollowUp: true }) && !A.feelingCheckApplies("checkin", { heavy: { endedAt: "x" } }) && !A.feelingCheckApplies("checkin", { hardMoment: true }) && A.feelingCheckApplies("checkin", { threadId: "t" }) && !A.feelingCheckApplies("unsolicited", {}));
  const down = await A.feelingCheck({ userId: "u", draft: "x", ownWords: ["y"], generate: async () => { throw new Error("down"); } });
  const unreadable = await A.feelingCheck({ userId: "u", draft: "x", ownWords: null, generate: async () => '{"asserts": false}' });
  const asserted = await A.feelingCheck({ userId: "u", draft: "x", ownWords: ["y"], generate: async () => '{"asserts": true, "phrase": "still heavy"}' });
  check("feeling: the model down, or their words unreadable: infra (it waits), never a failed draft", down.infra === true && unreadable.infra === true && !asserted.infra && asserted.phrase === "still heavy");
  const P = src("harness/proactive.ts");
  check("feeling: an infra failure holds the check-in for a retry without counting an attempt (first draft and rewrite)", (P.match(/if \(infraOf\((?:draftChecks|fixedChecks)\)\) return holdForFeelingRead\(/g) ?? []).length === 2 && /const holdForFeelingRead = async \(why: string\): Promise<void> => \{\n    const at = new Date\(state\.now\.getTime\(\) \+ FEELING_READ_RETRY_MINUTES \* 60_000\);\n    if \(!opts\.dryRun\) \{\n      await pool\.query\(`UPDATE proactive_candidates SET due_at/.test(P) && !/holdForFeelingRead[\s\S]{0,400}attempts = attempts \+ 1/.test(P.slice(P.indexOf("const holdForFeelingRead"), P.indexOf("const holdForFeelingRead") + 600)));
  check("feeling: a check-in at the door is read too, and goes without the sentence the read named", /if \(checkinFeeling && asWritten\) \{\n    const read = await feelingCheck\(/.test(P) && /const cut = withoutPhrase\(draft\.messages, read\.phrase \?\? ""\);/.test(P));
  check("feeling: the cut takes out only that sentence", JSON.stringify(A.withoutPhrase(["Still thinking about the partner search. Both still open, both still heavy. How's that sitting with you today?"], "both still heavy")) === JSON.stringify(["Still thinking about the partner search. How's that sitting with you today?"]));
  check("feeling: a phrase it can't find, or nothing left, is no cut", A.withoutPhrase(["How's it going?"], "heavy") === null && A.withoutPhrase(["It's heavy."], "heavy") === null);
  // Calls: the spoken check-in carries the same rule (the GPT-Live thinking's prompt and the ElevenLabs agent's).
  const EL = await import("../../src/services/elevenLabsCalls.js");
  const GL = await import("../../src/services/gptLive.js");
  check("calls: the thinking behind a GPT-Live call is told never to state a feeling they didn't share", GL.liveCallPrompt("You are Cue.").includes(EL.CALL_CHECKIN_FEELING) && EL.promptForElevenLabs("You are Cue.").includes(EL.CALL_CHECKIN_FEELING) && /unless they said so in their own words/.test(EL.CALL_CHECKIN_FEELING));
  // The race: the defaults are read again inside the send's lock; one dispatch per member at a time, the morning sweep's included.
  check("race: the day's default and the call/text rule are re-read inside sendWithLedger's lock", /if \(!isSafetyFollowUp\(c\) && isUnrequested\(cls\) && !isPossibleIntro\(c\) && !opts\.ignorePacing\) checks\.push\(\.\.\.\(await lockedDefaults\(client,/.test(P) && [...PR.LOCKED_DEFAULTS].sort().join() === "call_text_same_day,default_daily");
  check("race: the morning sweep dispatches through dispatchForUser, which runs one pick per member at a time", /await P\.dispatchForUser\(R\.proactiveRegistry, userId\);/.test(src("services/dailySweep.ts")) && /return withMember\(a\[1\], \(\) => oneDispatchAtATime\(a\[1\], \(\) => dispatchForUserInScope\(\.\.\.a\)\)\);/.test(P) && /if \(dispatchInFlight\.has\(userId\)\) return;\n  dispatchInFlight\.add\(userId\);/.test(P));
  // Bundle size: two find links per message.
  check("bundle: at most 2 finds in one message (the plan's limit)", PR.MAX_PICKED_TOGETHER === 2 && PR.pickSiblingOffers(find("profile", { match: { tier: 1 } }, { id: "b1" }), [find("profile", { match: { tier: 2 } }, { id: "b2" }), find("profile", { match: { tier: 3 } }, { id: "b3" })]).length === 1 && PR.pickSiblingOffers(cand("event_offer", { askId: "ask-1", match: { tier: 1 } }, { id: "n1" }), [cand("event_offer", { askId: "ask-2", match: { tier: 2 } }, { id: "n2" }), cand("event_offer", { askId: "ask-3", match: { tier: 3 } }, { id: "n3" })]).length === 1);
}

// ================================================================ requested items are never delayed by B
{
  const everything = att({
    sent: [{ at: pt("2026-11-03T09:00:00"), cls: "unsolicited", channel: "text" }, { at: pt("2026-11-03T10:00:00"), cls: "checkin", channel: "call" }],
    sentToday: [find("ask-9", {}, { id: "z" })],
    lastAsked: { at: pt("2026-11-03T09:00:00"), asked: true },
  });
  for (const cls of ["requested", "reply"] as const) check(`requested: no attention check reads a ${cls}`, A.attentionChecks({ now: NOW, zone: ZONE, cls, channel: "text", joinedAt: pt("2026-11-03T08:00:00"), att: everything, prefs: [], item: find("ask-1") }).length === 0);
  check("requested: nor a safety follow-up", A.attentionChecks({ now: NOW, zone: ZONE, cls: "checkin", channel: "text", joinedAt: null, att: everything, prefs: [], safety: true }).length === 0);
  const askFind = find("ask-1", {}, { id: "q1", priority: 60 });
  const doorReq = cand("task_update", { door: true, cls: "requested", messages: ["https://x", "y"], taskId: 5 }, { id: "q2" });
  const profile = find("profile", {}, { id: "q3" });
  const state = { now: NOW, timezone: ZONE, optedOut: false, sends: [], lastInboundAt: pt("2026-11-02T08:00:00"), joinedAt: pt("2026-11-03T08:00:00"), needsCare: true, moodHold: { state: "held", hold: true, heldHours: 2 }, memberRules: { prefs: [], sent: everything.sent }, attention: everything, candidates: [askFind, doorReq, profile] };
  const ev = PR.evaluateCandidates(state as any);
  const why = (id: string) => ev.perCandidate.find((p) => p.candidate.id === id)!.checks.filter((k) => !k.pass).map((k) => k.name);
  const B_CHECKS = ["first_day_quiet", "default_daily", "call_text_same_day", "quiet_backoff", "thread_today", "hard_day", "attention_unread"];
  check("requested: on a first day, at the cap, after a call, after silence, on another thread and a hard day, the answer to their ask isn't held by B", !why("q1").some((n) => B_CHECKS.includes(n)), why("q1"));
  check("requested: nor a delivery they asked for at the door", !why("q2").some((n) => B_CHECKS.includes(n)), why("q2"));
  check("requested: while what Cue started is held by every one of them", ["first_day_quiet", "default_daily", "call_text_same_day", "thread_today", "hard_day"].every((n) => why("q3").includes(n)), why("q3"));
  check("requested: a failed read holds only what Cue starts", (() => { const e = PR.evaluateCandidates({ ...state, needsCare: false, joinedAt: null, attention: null } as any); const w = (id: string) => e.perCandidate.find((p) => p.candidate.id === id)!.checks.filter((k) => !k.pass).map((k) => k.name); return w("q3").includes("attention_unread") && !w("q1").includes("attention_unread") && !w("q2").includes("attention_unread"); })());
  check("requested: a pure state without the attention read runs none of it (the existing tests' states)", !PR.evaluateCandidates({ ...state, needsCare: false, joinedAt: null, attention: undefined } as any).perCandidate.some((p) => p.checks.some((k) => B_CHECKS.includes(k.name))));
  check("requested: the fold never covers a requested delivery or a requested find", A.foldPlan({ included: [find("ask-1", {}, { id: "q0" })], pending: [doorReq, askFind], classOf: (x) => G.candidateClass(x.type, PR.isAnswering(x), x.payload) }).length === 0);
}

console.log(`\nattention: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
