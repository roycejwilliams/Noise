// Status checks (Royce, 2026-10-13): "A member restating something Co is already doing isn't a stop and isn't a new ask - it's a
// status check. Answer it as one: 'already on it, here's where it stands,' and the search keeps running."
// Co decides, code only suggests (review, 2026-10-13: a word match that refused saves and starts dropped new requests).
// Zero tokens: the open work and the fence are stubbed, nothing reads the database.
//   1. the pre-filter: a sentence that names an open task and adds nothing it lacks; near misses, stops, thanks and changes are not
//   2. the reply gets a candidate and where it stands, through the fence, and decides; the wording says when Co next works on it
//   3. saveAsk and startTask say "this looks like task #N" once and go through with differentFrom; a lookout on their own watch words
//      goes ahead; the fact is added once
//   4. the background capture skips only a turn answered as that task's status (fail open); nothing here writes or switches anything
//   npx tsx evals/asks/statusCheck.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
import path from "node:path";
const S = await import("../../src/services/statusCheck.js");
const { createConversationTools } = await import("../../src/agent/conversationTools.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const root = new URL("../../src/", import.meta.url).pathname;
const src = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const ZONE = "America/Los_Angeles";
const SAME = (s: string) => s;

type W = import("../../src/services/statusCheck.js").OpenWork;
const DOCS: W = {
  id: 7,
  goal: "Draft the Sequin AI planning docs",
  steps: [{ text: "Outline the launch timeline", done: true }, { text: "Draft the partner section", done: false }],
  notes: [{ at: "2026-10-12T22:20:00Z", text: "Started." }, { at: "2026-10-13T18:05:00Z", text: "Outlined the launch timeline: walk-through Nov 3, invites Nov 10." }],
  planNext: "Draft the partner section.",
  nextCheckAt: "2026-10-14T17:00:00Z",
  kind: "work",
  source: "ask",
};
const CHECKIN: W = { id: 9, goal: "Check in after the investor pitch on Thursday", steps: [], notes: [], planNext: "Ask how the pitch went", nextCheckAt: "2026-10-16T17:00:00Z", kind: "followup", source: null };
const WALK: W = { id: 10, goal: "Venue walk-through for the Sequin launch on Nov 3", steps: [], notes: [], planNext: null, nextCheckAt: null, kind: "work", source: "promise" };
const LOOKOUT: W = { id: 11, goal: "Live jazz nights in SF worth a date", steps: [], notes: [], planNext: null, nextCheckAt: null, kind: "work", source: "lookout" };
const WORK = [DOCS, CHECKIN, WALK, LOOKOUT];
const task = (id: number, goal: string): W => ({ id, goal, steps: [], notes: [], planNext: null, nextCheckAt: null, kind: "work", source: "ask" });

// ---- 1. the pre-filter
for (const m of [
  "Can you draft the planning docs for Sequin?",
  "Have Co draft the planning docs with Sequin AI",
  "how are the Sequin planning documents coming along?",
  "any update on the planning docs for Sequin AI?",
  "Hey, quick one. Did you start on the Sequin planning docs? Also want something fun this weekend.",
]) check(`restated: "${m}"`, S.restatedTask(m, WORK)?.id === 7, S.restatedTask(m, WORK));
check("restated: a check-in Co holds", S.restatedTask("can you check in with me after my investor pitch?", WORK)?.id === 9);
check("a lookout is left out", S.restatedTask("live jazz nights in SF", WORK) === null);
// Near misses: the same kind of thing, something else (each message adds a word its task lacks).
const NEAR: [string, string][] = [
  ["find a venue in SF for my birthday", "Find a venue in SF for the Sequin launch"],
  ["draft a pitch deck for my seed round", "Draft the pitch deck for the Sequin partnership"],
  ["find founder dinners in Oakland", "Find founder dinners in SF"],
  ["plan my birthday dinner", "Plan the Sequin launch dinner"],
  ["research seed investors in climate", "Research seed investors in fintech"],
  ["draft an intro email to Maya", "Draft an intro email to Ellis"],
  ["find a photographer for the launch party", "Find a DJ for the launch party"],
  ["find a caterer for the team offsite", "Find a venue for the team offsite"],
  ["write the speaker bios for Thursday", "Write the speaker run of show for Thursday"],
  ["look for a running club in the Marina", "Look for a climbing gym in the Marina"],
  ["set up a call with Noor next week", "Set up a call with Ellis next week"],
  ["put together the sponsor list for November", "Put together the guest list for November"],
];
for (const [m, g] of NEAR) check(`near miss, not a candidate: "${m}" vs "${g}"`, S.restatedTask(m, [task(1, g)]) === null);
// The review's near-miss pairs (2026-10-13), each as message vs open task; 4 is a held check-in (kind followup), read the way the tools
// read open work (statusCheck.ts openWorkFor: work and follow-ups).
const REVIEW: [string, W][] = [
  ["find a venue in SF for my birthday", task(21, "Find a venue in SF for the Sequin launch")],
  ["Can you find a venue for my birthday dinner?", task(22, "Find a venue")],
  ["find me a DJ for the Sequin launch party", task(23, "Plan the Sequin launch party")],
  ["can you help me prep for the investor pitch Thursday?", { ...task(24, "Check in after the investor pitch on Thursday"), kind: "followup", source: null }],
  ["Find tech events in SF", task(25, "Find AI events in SF")],
  ["Find an AI event in NYC next month", task(26, "Find AI events in SF")],
  ["find a founder dinner in NYC", task(27, "Find SF founder dinners")],
  ["Draft a follow-up email to the investors", task(28, "Draft an intro email to investors")],
  ["book a dinner reservation for Friday", task(29, "Find a dinner spot for Friday with Maya")],
  ["what's a good wine bar in SF?", task(30, "Find a wine bar in Oakland")],
  ["Great event last night. Can you find me a running club in SF?", task(31, "Find SF events for founders")],
  ["Saw the venue list. Need a photographer for the launch.", task(32, "Find a venue for the launch")],
];
for (const [m, t] of REVIEW) check(`review near miss, not a candidate: "${m}" vs "${t.goal}"`, S.restatedTask(m, [t]) === null, S.restatedTask(m, [t]));
// The same through the tools: with all twelve open, none of the twelve messages is held as a candidate.
{
  S.setOpenWorkForTests(REVIEW.map(([, t]) => t), SAME);
  const quiet = console.log;
  const held: string[] = [];
  for (const [m] of REVIEW) {
    console.log = () => {};
    const t = createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: m, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any);
    const r = await (t.tools as any).saveAsk.execute({ what: m }, {});
    console.log = quiet;
    if (r.ok === false && /looks like task/.test(r.error ?? "")) held.push(m);
  }
  S.setOpenWorkForTests(null);
  check("the tools hold none of the review's near misses (the check-in included)", held.length === 0, held);
}
// Not a status question: stopping, cancelling, thanking, a changed detail.
for (const m of ["stop working on the Sequin planning docs", "cancel the Sequin planning docs", "the Sequin planning docs look great, thanks", "the walk-through moved to Nov 5"]) {
  check(`not a candidate: "${m}"`, S.restatedTask(m, WORK) === null, S.restatedTask(m, WORK));
  check(`…nor against the docs task alone: "${m}"`, S.restatedTask(m, [DOCS]) === null);
}

// ---- 2. the candidate on the reply, through the fence
{
  const sc = S.statusCheckFor("Can you draft the planning docs for Sequin?", WORK, ZONE, SAME);
  check("the candidate names the task as possibly the same, with where it stands", !!sc && /^Possibly the same as open task #7 \("Draft the Sequin AI planning docs"\)\. Where it stands:/.test(sc.fact) && /latest, Outlined the launch timeline: walk-through Nov 3, invites Nov 10 \(/.test(sc.fact) && /Steps done: Outline the launch timeline \(1 of 2\)/.test(sc.fact) && /Next: Draft the partner section\./.test(sc.fact), sc?.fact);
  check("…no stray period before a time", !!sc && !/\.\s*\(/.test(sc.fact), sc?.fact);
  check("…when Co next works on it is never read as a delivery time", !!sc && /Co's next work session on it \(not a delivery time\): around /.test(sc.fact));
  check("…in plain words: no em dash or exclamation point", !!sc && !/[—–!]/.test(sc.fact));
  const closed = S.statusCheckFor("Can you draft the planning docs for Sequin?", WORK, ZONE, null);
  check("the fence can't be read: the task's number only, no goal words, no notes", closed?.fact === "Possibly the same as open task #7.", closed?.fact);
  check("…and the tool hint the same", S.looksLike(DOCS, null) === "This looks like task #7, already open. If it's the same, answer as a status check (already on it, where it stands) and don't call this again. If it's different, call again with differentFrom: 7." && !/Sequin/.test(S.looksLike(DOCS, null)));
  const stripped = S.whereItStands({ ...DOCS, notes: [...DOCS.notes, { at: "2026-10-13T19:00:00Z", text: "Asked Ellis about the partner list." }] }, ZONE, (s) => (/Ellis/.test(s) ? null : s));
  check("a line the fence blanks never reaches the reply", !/Ellis/.test(stripped) && /Where it stands:/.test(stripped), stripped);
  check("the rule lets Co decide: status for asking again or how it's going, anything else handled as itself", /If they're asking for it again or how it's going, answer as a status check/.test(S.CANDIDATE_RULE) && /changing, stopping, adding to or thanking you for it, or asking for something different, handle that instead and ignore this/.test(S.CANDIDATE_RULE) && !/[—–!]/.test(S.CANDIDATE_RULE));
  const rg = src("harness/replyGrounding.ts");
  check("the reply carries the candidate and the rule", /addFact\(rf, "known", opts\.turn\.statusCheck\.fact\);\s*addInstruction\(rf, \(await import\("\.\.\/services\/statusCheck\.js"\)\)\.CANDIDATE_RULE\);/.test(rg));
  const tc = src("services/turnContext.ts");
  check("…built from the turn's own task read, through the turn's fence", /S\.statusCheckFor\(message, S\.openWorkFrom\(rawTasks\), zone, safe\)/.test(tc) && !/openWorkFor\(userId\)/.test(tc));
  check("openWorkFrom keeps open work and check-ins, never a lookout or a closed task", JSON.stringify(S.openWorkFrom([{ ...DOCS, status: "open" }, { ...LOOKOUT, status: "open" }, { ...CHECKIN, status: "open" }, { ...WALK, status: "done" }] as any).map((w) => w.id)) === "[7,9]");
}

// ---- 3. the tools: said once, Co decides; differentFrom goes through
{
  const quiet = console.log;
  const make = (message: string, turn: any = null) => {
    const facts: { kind: string; text: string }[] = [];
    const t = createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: message, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, turn, sendCoReply: async () => true, facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => "" } } as any);
    return { tools: t.tools as any, state: t.state as any, facts };
  };
  S.setOpenWorkForTests(WORK, SAME);
  console.log = () => {};
  const a = make("Can you draft the planning docs for Sequin?");
  const save = await a.tools.saveAsk.execute({ what: "draft the planning docs for Sequin" }, {});
  const start = await a.tools.startTask.execute({ goal: "Draft planning docs for Sequin AI", theirWords: "draft the planning docs for Sequin", steps: ["Outline"], firstStep: "Outline", inHours: 2 }, {});
  console.log = quiet;
  check("saveAsk on a candidate says what it looks like, once, and how to go ahead", save.ok === false && /^This looks like task #7 \("Draft the Sequin AI planning docs"\), already open\. If it's the same, answer as a status check/.test(save.error) && /call again with differentFrom: 7/.test(save.error), save);
  check("startTask in the same turn: held too, with the short reminder (the hint was already given)", start.ok === false && /^Already held as task #7 this turn/.test(start.error), start);
  check("…where it stands goes in the facts once, never twice", a.facts.filter((f) => f.kind === "known" && /open task #7/.test(f.text)).length === 1 && !a.facts.some((f) => f.kind === "ongoing"), a.facts);
  check("…and the turn records it was raised", a.state.statusRaised.join() === "7");
  console.log = () => {};
  const twice = await a.tools.saveAsk.execute({ what: "draft the planning docs for Sequin" }, {});
  console.log = quiet;
  check("asked again without differentFrom: a short reminder, not the whole hint", twice.ok === false && /^Already held as task #7 this turn\. Answer as a status check, or call again with differentFrom: 7/.test(twice.error), twice);
  console.log = () => {};
  const again = await a.tools.saveAsk.execute({ what: "draft the planning docs for Sequin", differentFrom: 7 }, {});
  console.log = quiet;
  check("differentFrom goes through: Co decided it's different", again.ok === true && a.facts.some((f) => f.kind === "ongoing") && a.state.statusOverridden.join() === "7", again);
  const turn = { statusCheck: { taskId: 7, goal: DOCS.goal, fact: "Possibly the same as open task #7." } };
  console.log = () => {};
  const t2 = make("Can you draft the planning docs for Sequin?", turn);
  await t2.tools.saveAsk.execute({ what: "draft the planning docs for Sequin" }, {});
  console.log = quiet;
  check("…and when the turn already carries the candidate, the tool doesn't add it again", !t2.facts.some((f) => f.kind === "known" && /open task #7/.test(f.text)));
  console.log = () => {};
  const w = make("keep an eye out for the Sequin planning docs");
  const watch = await w.tools.startTask.execute({ goal: "Sequin planning docs", theirWords: "keep an eye out for the Sequin planning docs", steps: ["Watch"], firstStep: "Watch", inHours: 24, lookout: true }, {});
  console.log = quiet;
  check("a lookout on their own watch words goes ahead (#194's exemption holds)", watch.ok === true, watch);
  console.log = () => {};
  const b = make("Can you look for founder dinners in SF?");
  const fresh = await b.tools.saveAsk.execute({ what: "founder dinners in SF" }, {});
  const freshTask = await b.tools.startTask.execute({ goal: "Find a venue in SF for my birthday", theirWords: "look for founder dinners in SF", steps: ["Search"], firstStep: "Search", inHours: 2 }, {});
  console.log = quiet;
  check("a genuinely new ask saves as before", fresh.ok === true && b.facts.some((f) => f.kind === "ongoing" && /founder dinners in SF/.test(f.text)), fresh);
  check("…and a genuinely new task starts as before", freshTask.ok === true, freshTask);
  S.setOpenWorkForTests(null);
  const ct = src("agent/conversationTools.ts");
  check("no hard refusal remains in the tools", !/alreadyOnIt|Already on it: task/.test(ct));
  check("the tool path reads the fence and fails closed", /stripForTool\(ctx\.userId\)/.test(ct) && /fenceFrom\(userId, line\)/.test(src("services/statusCheck.ts")) && /f\.failed \? null : f\.strip/.test(src("services/statusCheck.ts")));
}

// ---- 4. the background capture skips only an answered status; nothing writes or switches
{
  check("answered as status: only a hold the tools raised that Co didn't override", S.answeredAsStatus({ raised: [7], overridden: [] }) === 7);
  check("…not once Co said it's different", S.answeredAsStatus({ raised: [7], overridden: [7] }) === null);
  check("…and nothing at all when the tools raised nothing: a candidate Co never acted on proves nothing (fail open)", S.answeredAsStatus({ raised: [], overridden: [] }) === null);
  const cr = src("agent/conversationReply.ts");
  check("the reply path logs it after a sent reply, from the turn state, with their message", /S\.answeredAsStatus\(\{ raised: state\.statusRaised, overridden: state\.statusOverridden \}\)/.test(cr) && /decision: S\.STATUS_TURN[^\n]*proposal: \{ taskId, message: input\.resolvedContent\.slice\(0, 500\) \}/.test(cr) && !/toolsCalled: toolsSoFar/.test(cr));
  const pe = src("services/profileExtraction.ts");
  check("the capture reads only this turn's status (by their message), skips only the same task, and fails open", /S\.statusTurnTasks\(user_id, message\)\.catch\(\(\) => \[\] as number\[\]\)/.test(pe) && /S\.capturedAskIsTask\(a\.text, work\)/.test(pe) && /action: "status_check"/.test(pe) && /"last_user_message", input\.message\)/.test(src("services/turnLearning.ts")) && /proposal->>'message' = \$3/.test(src("services/statusCheck.ts")));
  // Near-equality: on a turn answered as task #N, only that task again is skipped; a broader ask is saved.
  const OAKLAND = task(30, "Find a wine bar in Oakland");
  check("a broader ask is saved even on a status turn: \"What's a good wine bar?\" vs \"Find a wine bar in Oakland\"", S.capturedAskIsTask("What's a good wine bar?", [OAKLAND]) === null);
  check("the same task again is skipped: \"draft the planning docs for Sequin\" vs the Sequin docs task", S.capturedAskIsTask("draft the planning docs for Sequin", [DOCS])?.id === 7);
  // The review's broad asks: Co answered in plain text (no tool hold), so no status turn is recorded and every one is saved.
  const BROAD: [string, W][] = [
    ["What's a good wine bar?", OAKLAND],
    ["any dinners in SF this week?", task(27, "Find SF founder dinners")],
    ["can you find events in SF?", task(25, "Find AI events in SF")],
    ["Intro me to investors", task(28, "Draft an intro email to investors")],
    ["find me a venue in SF", task(21, "Find a venue in SF for the Sequin launch")],
  ];
  for (const [m, t] of BROAD) {
    const recorded = S.answeredAsStatus({ raised: [], overridden: [] });
    const skipped = recorded != null ? S.capturedAskIsTask(m, [t]) : null;
    check(`a broad ask Co answered in plain text is saved: "${m}" (open: "${t.goal}")`, recorded === null && skipped === null);
  }
  check("…and even on a status turn for that task, all but an exact restatement are saved", BROAD.filter(([m, t]) => S.capturedAskIsTask(m, [t])).map(([m]) => m).every((m) => m === "can you find events in SF?"), BROAD.filter(([m, t]) => S.capturedAskIsTask(m, [t])).map(([m]) => m));
  const sc = src("services/statusCheck.ts");
  check("the status-check path writes nothing", !/\b(UPDATE|INSERT|DELETE)\b/.test(sc));
  const ar = src("services/askRetire.ts");
  const branch = ar.slice(ar.indexOf("if (isCoTaskGoal(text)) {"), ar.indexOf("const tied = new Set"));
  check("askRetire leaves a Co-task ask as it is: status-check lane, the search keeps running, no kind change, no note", /status-check lane: Co's own work, the search keeps running \(no kind change, no note\)/.test(branch) && /return;/.test(branch) && !/setAskKind|UPDATE|retire_note|lineInVoice/.test(branch), branch);
}

console.log(`status checks: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
