// Following through when a call ends (services/callFollowThrough.ts) and one voice standard for calls and texts
// (services/speakable.ts narratesInternalState). Layer 1: stubbed clock, stubbed model, stubbed store, zero tokens.
//   npx tsx evals/calls/followThrough.ts
// Replays 2026-10-08: Co promised a planning doc on a call; after hangup the only text came 75 minutes later, off the dispatch
// queue, and said "On it. Starting the post-event branding plan ... once it's worth sending."
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const F = await import("../../src/services/callFollowThrough.js");
const { narratesInternalState } = await import("../../src/services/speakable.js");
const { checkDraft, PROACTIVE_PURPOSE } = await import("../../src/harness/proactive.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

const TODAY_BAD = "On it. Starting the post-event branding plan for how Co stays present after the Sequin AI launch, and I'll text you what I put together once it's worth sending.";
const GOOD = "Got it, I'll put together the plan for keeping Co visible after the Sequin launch and text you the draft tonight.";

// ---------- the narration detector (calls and texts share it)
{
  const bad = [
    TODAY_BAD,
    "Starting the venue shortlist now.",
    "Working on it, I'll text you soon.",
    "I'm working on the plan for your launch.",
    "I've started pulling options together.",
    "I'm still working on the draft.",
    "Got it, starting on the memo.",
    "I'll send it once it's worth sending.",
    "I'll text you once it's in good shape.",
    "Nothing worth sending yet.",
    "Looked into it and haven't found anything good enough to send.",
    "Your plan is in progress.",
    "It's on my list.",
    "Digging into the caterers now.",
    "Looking into it.",
  ];
  for (const b of bad) check(`narration flagged: "${b}"`, narratesInternalState(b) !== null);
  const good = [
    GOOD,
    "Here's the plan for after the launch: three ways to keep the room talking about you.",
    "Working on anything fun this week?",
    "How's the pitch you're working on coming along?",
    "Got it, I'll send you the three venue links in a few minutes.",
    "The draft is below. The part I'm least sure of is the guest list, since I don't know who's confirmed.",
    "I couldn't find a caterer that does 40 people on a Tuesday. Do you have a budget in mind?",
    "You said you're working on the deck tonight, so I'll keep this short.",
    "That's worth a look: it's the one place with a private room.",
  ];
  for (const g of good) check(`good line passes: "${g}"`, narratesInternalState(g) === null);
  check("speech cues don't hide it: '[warmly] Starting the plan.'", narratesInternalState("[warmly] Starting the plan.") !== null);
  check("curly apostrophes too: 'I’m working on it'", narratesInternalState("I’m working on it.") !== null);
}

// ---------- every outbound text Co drafts is held to it (harness/proactive.ts checkDraft)
{
  const c = checkDraft(TODAY_BAD, { maxSentences: 3, maxChars: 360 });
  check("checkDraft fails today's text on narration", c.some((x) => x.name === "draft_narrates_state" && !x.pass));
  const g = checkDraft("Here's what I found for the launch dinner.", { maxSentences: 3 });
  check("checkDraft passes a plain line on narration", g.some((x) => x.name === "draft_narrates_state" && x.pass));
  check("the confirmation is its own exempt type, a companion message", PROACTIVE_PURPOSE.call_confirm === "companion");
}

// ---------- the confirmation's shape: what Co understood, what they get, when
const COMMIT = [{ taskId: 111, sentence: "I'll text you what I put together on how Co keeps its presence after the November event", wakes: 0 }];
{
  const ok = F.confirmationChecks(GOOD, COMMIT).filter((c) => !c.pass);
  check(`a good confirmation passes every check (${ok.map((c) => c.reason ?? c.name).join("; ")})`, ok.length === 0);
  check("today's text fails the confirmation checks", F.confirmationChecks(TODAY_BAD, COMMIT).some((c) => !c.pass));
  check("no 'when': missing when", F.confirmationShape("Got it, I'll put together the plan for keeping Co present after the November event.", COMMIT).some((m) => /when/.test(m)));
  check("no 'what they get': missing it", F.confirmationShape("Thanks for the call, the November event plan sounds great tonight.", COMMIT).some((m) => /what they get/.test(m)));
  check("nothing from the call: missing what Co understood", F.confirmationShape("Got it, I'll send it over tonight.", COMMIT).some((m) => /understood/.test(m)));
  check("a dash still fails (texting voice: commas)", F.confirmationChecks("Got it - I'll put together the plan for Co's presence after the November event and text you the draft tonight.", COMMIT).some((c) => !c.pass && /dash/.test(c.reason ?? "")) || F.confirmationChecks("Got it — I'll put together the plan for Co's presence after the November event and text you the draft tonight.", COMMIT).some((c) => !c.pass && /dash/.test(c.reason ?? "")));
  check("a confirmation may name when it's coming (the later-action rule doesn't veto it)", F.confirmationChecks("Got it, I'll text you the November event plan tomorrow.", COMMIT).every((c) => c.pass));
  check("delivery window: afternoon in SF", F.deliveryWindow(new Date("2026-10-07T21:00:00Z"), "America/Los_Angeles") === "this afternoon");
  check("delivery window: evening in SF is tonight", F.deliveryWindow(new Date("2026-10-08T01:00:00Z"), "America/Los_Angeles") === "tonight");
  check("delivery window: held to 9am is this morning", F.deliveryWindow(new Date("2026-10-08T16:00:00Z"), "America/Los_Angeles") === "this morning");
  check("goal back to Co's sentence", F.sentenceOfGoal('Keep your word from the call: "I\'ll text you the links"') === "I'll text you the links");
  const fb = F.fallbackConfirmation([{ sentence: "I'll text you the links right after we hang up" }], "tonight");
  check(`fallback is Co's own words, with a when and no narration: "${fb}"`, !!fb && /^Got it, I'll text you the links/.test(fb) && /tonight\.$/.test(fb) && !narratesInternalState(fb) && !/hang up/.test(fb));
}

// ---------- the trigger: call end -> confirmation now -> the deliverable on its own completion
type Ev = { at: number; what: string; text?: string };
function harness(o: { nowIso: string; zone?: string | null; drafts?: (string | null)[]; commitments?: typeof COMMIT; deliverable?: string }) {
  let clock = new Date(o.nowIso).getTime();
  const events: Ev[] = [];
  const drafts = [...(o.drafts ?? [GOOD])];
  const prompts: any[] = [];
  let laterFn: (() => Promise<any>) | null = null;
  let laterAt: Date | null = null;
  let held: { ids: number[]; until: Date } | null = null;
  const decisions: any[] = [];
  const deps: any = {
    now: () => new Date(clock),
    track: async () => { events.push({ at: clock, what: "track" }); },
    commitments: async () => o.commitments ?? COMMIT,
    person: async () => ({ firstName: "Jordan", phone: "+14155550123", zone: o.zone === undefined ? "America/Los_Angeles" : o.zone, reachable: true }),
    draft: async (x: any) => { prompts.push(x); clock += 4000; return drafts.shift() ?? null; },
    send: async (x: any) => { clock += 500; events.push({ at: clock, what: "send", text: x.text }); return { sent: true }; },
    // The task's own turn: it does the work and its own text goes out when it finishes (taskTurn.ts tellThem -> sendExempt).
    runTask: async (_u: string, c: any) => { events.push({ at: clock, what: `run:${c.taskId}` }); clock += 60_000; events.push({ at: clock, what: "deliver", text: o.deliverable ?? "Here's the plan: ..." }); return { ran: true, action: "scheduled" }; },
    hold: async (_u: string, ids: number[], until: Date) => { held = { ids, until }; },
    later: (at: Date, fn: () => Promise<any>) => { laterAt = at; laterFn = fn; },
    record: async (d: any) => { decisions.push(d); },
  };
  return { deps, events, prompts, decisions, get laterFn() { return laterFn; }, get laterAt() { return laterAt; }, get held() { return held; }, setClock: (iso: string) => { clock = new Date(iso).getTime(); } };
}

const TRANSCRIPT = `assistant: What do you want the November event to leave behind?
user: Honestly I want people to still be thinking about Co a week later. Can you help me plan that?
assistant: Yes. I'll text you what I put together on how Co keeps its presence after the November event.
user: Perfect, thank you.`;

{
  // 6:40pm in San Francisco: inside their hours. Call ended at the stubbed clock; no cron runs in this test at all.
  const ended = new Date("2026-10-08T01:40:00Z");
  const h = harness({ nowIso: ended.toISOString() });
  const r = await F.followThroughOnCallEnd({ userId: "u1", transcript: TRANSCRIPT, startedAt: new Date(ended.getTime() - 600_000), endedAt: ended }, h.deps);
  const sendEv = h.events.find((e) => e.what === "send");
  check("call end: the confirmation is sent in the same call-end flow, not queued", r.action === "sent" && !!sendEv && h.laterFn === null && h.held === null);
  check(`call end: confirmation lands well inside 60s on the stubbed clock (${r.confirmMs}ms)`, typeof r.confirmMs === "number" && r.confirmMs < 60_000);
  check("call end: the confirmation is the drafted shape", sendEv?.text === GOOD);
  check("call end: commitments said on the direct path are opened first", h.events[0]?.what === "track");
  const work = await r.work!;
  const order = h.events.map((e) => e.what);
  check(`the deliverable runs right after the confirmation, as its own completion event (${order.join(" > ")})`, work.length === 1 && work[0].ran && order.indexOf("send") < order.indexOf("run:111") && order.indexOf("run:111") < order.indexOf("deliver"));
  check("the deliverable needs no sweep: it was started by the call end itself, with no hold and no timer", h.held === null && h.laterFn === null);
  check("the decision log has the confirmation and its latency", h.decisions.some((d) => d.decision === "call.followthrough" && d.action === "confirm_sent" && typeof d.proposal.confirmMs === "number"));
  const facts = h.prompts[0]?.facts ?? {};
  check("the draft is given what Co said, their words, and when", /presence after the November event/.test(facts.co_commitment_on_call) && /thinking about Co a week later/.test(facts.their_words_on_the_call) && facts.delivery_window === "tonight");
  check("their words exclude Co's lines", !/What do you want the November event/.test(facts.their_words_on_the_call));
}
{
  // Two commitments: one confirmation, two deliverable turns.
  const h = harness({ nowIso: "2026-10-07T20:00:00Z", commitments: [...COMMIT, { taskId: 112, sentence: "I'll send you the venue links", wakes: 1 }] });
  const r = await F.followThroughOnCallEnd({ userId: "u1", transcript: TRANSCRIPT }, h.deps);
  const work = await r.work!;
  check("two commitments: one confirmation text, both tasks run", h.events.filter((e) => e.what === "send").length === 1 && work.map((w) => w.taskId).join(",") === "111,112");
}
{
  // Quiet hours: 11:30pm in San Francisco. Queued to their 9am, nothing sent now, task backstop just after it.
  const h = harness({ nowIso: "2026-10-08T06:30:00Z" });
  const r = await F.followThroughOnCallEnd({ userId: "u1", transcript: TRANSCRIPT }, h.deps);
  check("night: nothing sent now", r.action === "held" && !h.events.some((e) => e.what === "send" || e.what.startsWith("run:")));
  check(`night: held to 9am their time (${r.heldUntil})`, r.heldUntil === "2026-10-08T16:00:00.000Z" && h.laterAt?.toISOString() === "2026-10-08T16:00:00.000Z");
  check("night: the task's own check is set just after the morning send, as the backstop", !!h.held && h.held.ids.join() === "111" && h.held.until.toISOString() === "2026-10-08T16:10:00.000Z");
  h.setClock("2026-10-08T16:00:00Z");
  const m = await h.laterFn!();
  await m.work;
  const order = h.events.map((e) => e.what);
  check("morning: the confirmation goes, then the deliverable", m.action === "sent" && order.indexOf("send") >= 0 && order.indexOf("send") < order.indexOf("deliver"));
  check("morning: the draft's 'when' is this morning", h.prompts[0]?.facts?.delivery_window === "this morning");
}
{
  // Unknown zone: the US-safe window (after 16:00 UTC) still applies.
  const h = harness({ nowIso: "2026-10-08T03:00:00Z", zone: null });
  const r = await F.followThroughOnCallEnd({ userId: "u1", transcript: TRANSCRIPT }, h.deps);
  check("unknown zone at 03:00 UTC is held", r.action === "held");
}
{
  const h = harness({ nowIso: "2026-10-07T20:00:00Z", commitments: [] });
  const r = await F.followThroughOnCallEnd({ userId: "u1", transcript: TRANSCRIPT }, h.deps);
  check("no commitment on the call: no confirmation", r.action === "none" && !h.events.some((e) => e.what === "send"));
}
{
  // First draft narrates; the redraft is told what broke and is sent.
  const h = harness({ nowIso: "2026-10-07T20:00:00Z", drafts: [TODAY_BAD, GOOD] });
  const r = await F.followThroughOnCallEnd({ userId: "u1", transcript: TRANSCRIPT }, h.deps);
  check("redraft: the narrating draft is never sent, the fixed one is", r.action === "sent" && r.text === GOOD && !h.events.some((e) => e.text === TODAY_BAD));
  check("redraft: told what broke", /narrat|Co's own activity|judgment/.test(h.prompts[1]?.redo?.failed ?? ""));
}
{
  // Both drafts narrate: Co's own words from the call, not silence.
  const h = harness({ nowIso: "2026-10-07T20:00:00Z", drafts: [TODAY_BAD, "Working on it now."] });
  const r = await F.followThroughOnCallEnd({ userId: "u1", transcript: TRANSCRIPT }, h.deps);
  check(`fallback: something still lands, in Co's words from the call ("${r.text}")`, r.action === "sent" && r.fallback === true && /^Got it, I'll text you what I put together/.test(r.text ?? "") && !narratesInternalState(r.text ?? ""));
}

// ---------- wiring (read from the source: the real path)
{
  const co = src("routes/co.ts");
  const proc = co.slice(co.indexOf("async function processEndedCall"));
  const ft = proc.indexOf("followThroughOnCallEnd(");
  check("post-call processing calls the follow-through", ft > 0);
  check("it runs before the transcript store, the audit and the profile read (nothing slow ahead of it)", ft < proc.indexOf("Step 1 — Store raw transcript") && ft < proc.indexOf("auditCall(") && ft < proc.indexOf("learnFromCall("));
  check("it is not awaited: the call's processing never waits on it", /import\("\.\.\/services\/callFollowThrough\.js"\)\.then\(\(m\) => m\.followThroughOnCallEnd/.test(proc));
  check("the webhook passes the call's start and end", /startedAt: Number\(data\.metadata\?\.start_time_unix_secs\)/.test(co) && /call_duration_secs/.test(co));
  check("the webhook audits spoken lines with the same narration rule", /decision: "call\.narration"/.test(co) && /narratesInternalState/.test(co));
  const ftSrc = src("services/callFollowThrough.ts");
  check("the deliverable turn is claimed the way the cron claims (no double run)", /wakes = wakes \+ 1/.test(ftSrc) && /AND wakes = \$3/.test(ftSrc) && /runTaskTurn\(task\)/.test(ftSrc));
  check("the confirmation is exempt from spacing but respects their hours", /type: CONFIRM_TYPE[^}]*respectHours: true/.test(ftSrc));
  const cc = src("services/callCommitments.ts");
  check("a confirmation never counts as the commitment kept", /ps\.type = 'call_confirm'/.test(cc));
  const pc = src("jobs/postCallFollowUp.ts");
  check("the after-call reflection no longer says 'worth sending' or 'you're on it'", !/worth sending yet/.test(pc) && !/you're on it/.test(pc));
  check("the after-call reflection knows the confirmation went out", /confirmation_you_already_sent_after_the_call/.test(pc));
  const tt = src("services/taskTurn.ts");
  check("a promise task sends when done or says what's missing (no 'only if something real')", /send it when it's done/.test(tt) && !/Only text them if you have something real to tell them; if there isn't, say nothing/.test(tt));
}


// ---- 2026-10-08 merged live test: a task turn texted a status report 20s after the confirmation, and one call opened two tasks
{
  const LIVE_BAD = "No confirmed details yet on private dining rooms near Hayes Valley for twelve. Have a few leads, just nothing solid enough to send you. I'll have it soon.";
  check("the live status report is flagged as narration", narratesInternalState(LIVE_BAD) !== null);
  for (const l of ["Nothing solid enough to send yet.", "I've got a few leads.", "I'll have it soon.", "Still looking into rooms near Hayes Valley."]) check(`flagged: "${l}"`, narratesInternalState(l) !== null);
  for (const l of ["Here are three rooms near Hayes Valley that seat twelve: Rich Table, Absinthe and Jardiniere.", "I couldn't find a room near Hayes Valley that seats twelve and feels like a home. Want me to widen it to the Mission and NoPa?", "What date are you thinking?"]) check(`passes: "${l.slice(0, 50)}"`, narratesInternalState(l) === null);
  check("a promise task says nothing until it's done, unless it needs something from them or truly can't be done", /If it isn't done yet, keep working and say nothing: no progress reports/.test(src("services/taskTurn.ts")));
  const FT = await import("../../src/services/followThrough.js");
  check("one call's ask and promise for the same thing are one commitment", FT.sameCallCommitment({ goal: 'Keep your word from the call: "I\'ll send you three private dining rooms near Hayes Valley that seat twelve."' }, { goal: "Find a few private dinner venue options for twelve near Hayes Valley with a homey feel" }));
  check("two different things from one call stay two", !FT.sameCallCommitment({ goal: "Find a few private dinner venue options for twelve near Hayes Valley" }, { goal: "Draft a sponsor deck for the November launch" }));
  check("the call's ask read uses the same-call bar", /sameCallCommitment\(\{ goal: a\.goal, theirWords: a\.quote \}, t\)/.test(src("services/callTasks.ts")));
}
console.log(`follow-through: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
