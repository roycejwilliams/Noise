// Cue's helpers on GPT-Live calls (Royce, 2026-11-02: "Wire the existing helpers into the current GPT-Live call path"). Every case runs
// through the real bridge (services/gptLiveBridge.ts, fake Twilio and OpenAI sockets), the real call brain (callLlmProxy.ts runCallLlm,
// a scripted Claude), the real call toolset (callTools.ts buildCallTools over the texting tools, wrapped by agent/toolGuard.ts) and the
// real task store (services/coTasks.ts) on an in-memory co_tasks. What's checked is what reached GPT-Live, what the rows say, and what
// went out by text afterward, not only which tool was picked.
//   1. a quick lookup (the event feed) answers live, and only what it returned is said
//   2. longer work becomes a job mid-call: its co_tasks row exists before Cue says it started; it's delivered by text afterward and
//      closes as done only once that text went
//   3. an abrupt hang-up mid-tool: the job lands once, and nothing after the call opens it again
//   4. the same need asked again (and a delegation run twice) is the same job; a delivery that failed is retried without a second text
//   5. a dispatch that fails is said plainly; nothing promises it later
//   6. missing permission (no yes, texts off, off the GPT-Live list) never acts, and nothing claims it did
//   7. a correction lands on the same job; a stop closes it and says what had already happened
//   8. a safety turn builds no helpers and runs none; its answer goes word for word
//   9. unverified claims are held from speech before GPT-Live hears them (a name, a time, "booked", "started")
//  10. the word cap: a safety line is never cut, and what the cap held back reaches the next turn
// Layer 1: no network, no tokens, no database. Invented member (Jordan).
//   TZ=UTC node evals/runLayer1.mjs evals/calls/gptLiveHelpers.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import { EventEmitter } from "node:events";

// The task turn's model (services/taskTurn.ts generateText), scripted: each answer is one tool call or one text. The call's own Claude
// is the bridge's upstream, scripted per case below.
const script: ({ tool: string; input: any } | { text: string })[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const a = script.shift() ?? { text: "Nothing more." };
  const content = "tool" in a ? [{ type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name: a.tool, input: a.input }] : [{ type: "text", text: a.text }];
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "scripted", content, stop_reason: "tool" in a ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const pool = (await import("../../src/db/db.js")).default as any;
const G = await import("../../src/services/gptLive.js");
const B = await import("../../src/services/gptLiveBridge.js");
const CT = await import("../../src/services/callTools.js");
const CAP = await import("../../src/services/capabilities.js");
const CL = await import("../../src/services/callClaims.js");
const CC = await import("../../src/services/callCommitments.js");
const TK = await import("../../src/services/callTasks.js");
const TT = await import("../../src/services/taskTurn.js");
const T = await import("../../src/services/coTasks.js");
const SP = await import("../../src/services/speakable.js");
const Y = await import("../../src/services/theirYes.js");
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
(await import("../../src/services/statusCheck.js")).setOpenWorkForTests([], null);
let yes = true;
Y.setYesJudgeForTests(async () => ({ yes, why: "stub", read: true }));

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 3000) => { for (let t = 0; t < ms && !ok(); t += 10) await sleep(10); };
const VOICE = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const USER = "u-jordan";

// ---------------------------------------------------------------- the in-memory store: co_tasks and the decision log
// timeline: what happened, in order, across the store and the voice ("db:insert #1", "say:...").
const timeline: string[] = [];
const db = { tasks: [] as any[], decisions: [] as any[], failInsert: false, insertDelayMs: 0, nextId: 1 };
const reset = () => { db.nextId = 1; db.tasks = []; db.decisions = []; db.failInsert = false; db.insertDelayMs = 0; timeline.length = 0; CT._resetCallMemoryForTest(); };
const handle = async (raw: string, a: any[] = []): Promise<{ rows: any[]; rowCount?: number }> => {
  const sql = raw.replace(/\s+/g, " ").trim();
  await new Promise((r) => setImmediate(r));
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
  if (/^INSERT INTO harness_decisions/.test(sql)) { db.decisions.push({ decision: a[1], outcome: a[3], action: a[4], proposal: a[5] ? JSON.parse(a[5]) : null, reason: a[8] }); return { rows: [{ id: String(db.decisions.length), created_at: new Date() }] }; }
  if (/^SELECT \* FROM co_tasks WHERE user_id = \$1 AND dispatch_key = \$2 AND status = 'open'/.test(sql)) return { rows: db.tasks.filter((t) => t.user_id === a[0] && t.dispatch_key === a[1] && t.status === "open") };
  if (/^SELECT \* FROM co_tasks WHERE user_id = \$1 AND status = 'open' AND kind = 'work'/.test(sql)) return { rows: db.tasks.filter((t) => t.user_id === a[0] && t.status === "open") };
  if (/^SELECT \* FROM co_tasks WHERE user_id = \$1 AND id = \$2/.test(sql)) return { rows: db.tasks.filter((t) => t.user_id === a[0] && t.id === Number(a[1])) };
  if (/^SELECT id, goal, their_words FROM co_tasks WHERE user_id = \$1 AND status = 'dropped'/.test(sql)) return { rows: db.tasks.filter((t) => t.user_id === a[0] && t.status === "dropped") };
  if (/^INSERT INTO co_tasks \(user_id, goal, their_words, steps, plan_next, next_check_at, notes, deadline, final_check_at, source, followup, dispatch_key\)/.test(sql)) {
    if (db.insertDelayMs) await sleep(db.insertDelayMs);
    if (db.failInsert) throw new Error("connection terminated");
    if (a[11] && db.tasks.some((t) => t.user_id === a[0] && t.dispatch_key === a[11] && t.status === "open")) throw new Error("duplicate key value violates unique constraint idx_co_tasks_dispatch_open");
    const row = { id: db.nextId++, user_id: a[0], goal: a[1], their_words: a[2], steps: JSON.parse(a[3]), plan_next: a[4], next_check_at: a[5], status: "open", wakes: 0, notes: JSON.parse(a[6]), texts_sent: 0, last_texted_at: null, created_at: new Date(), deadline: a[7], final_check_at: a[8], final_told: false, awaiting_reply: false, their_reply_at: null, kind: "work", followup: a[10] ? JSON.parse(a[10]) : null, target_key: null, source: a[9], outcome: null, dispatch_key: a[11] };
    db.tasks.push(row);
    timeline.push(`db:insert #${row.id}`);
    return { rows: [row], rowCount: 1 };
  }
  if (/^UPDATE co_tasks SET steps = \$3::jsonb, notes = \$4::jsonb/.test(sql)) { const t = db.tasks.find((x) => x.user_id === a[0] && x.id === Number(a[1])); if (!t) return { rows: [] }; t.steps = JSON.parse(a[2]); t.notes = JSON.parse(a[3]); timeline.push(`db:note #${t.id}`); return { rows: [t], rowCount: 1 }; }
  if (/^UPDATE co_tasks SET status = \$3, outcome = \$4/.test(sql)) { const t = db.tasks.find((x) => x.user_id === a[0] && x.id === Number(a[1]) && x.status === "open"); if (!t) return { rows: [], rowCount: 0 }; t.status = a[2]; t.outcome = a[3]; t.next_check_at = null; timeline.push(`db:close #${t.id} ${a[2]}`); return { rows: [t], rowCount: 1 }; }
  return { rows: [], rowCount: 0 };
};
// The advisory lock, as Postgres holds it: one transaction per key at a time, released at COMMIT or ROLLBACK.
let lockTail: Promise<void> = Promise.resolve();
pool.query = handle;
pool.connect = async () => {
  let release: (() => void) | null = null;
  const query = async (sql: string, a?: any[]) => {
    if (/pg_advisory_xact_lock/.test(sql)) { const prev = lockTail; let done!: () => void; lockTail = new Promise<void>((r) => (done = r)); await prev; release = done; return { rows: [] }; }
    if (/^\s*(COMMIT|ROLLBACK)/.test(sql)) { release?.(); release = null; return { rows: [] }; }
    return handle(sql, a);
  };
  return { query, release: () => { release?.(); release = null; } };
};

// ---------------------------------------------------------------- the call: fake sockets, a scripted Claude, the real toolset
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(d: unknown) { const m = JSON.parse(String(d)); this.sent.push(m); if (typeof m.content === "string" && m.content && m.delegation_id) timeline.push(`say:${m.content}`); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  in(m: unknown) { this.emit("message", JSON.stringify(m)); }
}
const text = (s: string, index = 0) => [
  { type: "content_block_start", index, content_block: { type: "text" } },
  ...(s.match(/.{1,8}/gs) ?? []).map((t) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index },
];
const tool = (id: string, name: string, args: unknown, index = 1) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } },
  { type: "content_block_stop", index },
];
const JAZZ = { name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", tier: 2 as const, lines: ['"Rooftop Jazz Night" starts Saturday, November 7 at 8:00 PM and ends 11:00 PM (America/Los_Angeles).', '"Rooftop Jazz Night" is at The Chapel, 777 Valencia St.'] };
type Opts = { member?: Partial<Parameters<typeof CT.buildCallTools>[0]["member"]>; sends?: (text: string) => Promise<boolean>; outbound?: boolean; settleMs?: number; gaps?: Record<number, number> };
function bridge(replies: any[][], o: Opts = {}) {
  reset();
  const tw = new FakeSocket(), ai = new FakeSocket();
  const records: any[] = [], reqs: any[] = [], texted: string[] = [];
  let builds = 0;
  const member = { phone: "+14155550175", firstName: "Jordan", city: "San Francisco", tasks: [] as { id: number; goal: string }[], loops: null, avoid: [], noTexts: false, ...(o.member ?? {}) };
  B.setLiveDeps({
    connectOpenAI: () => { setImmediate(() => ai.emit("open")); return ai as any; },
    apiKey: () => "sk-test",
    // gaps: request n's stream pauses gapMs before its first tool use (a tool decided while something else happens on the line).
    upstream: (r: any) => { reqs.push(JSON.parse(JSON.stringify(r))); const n = reqs.length; const ev = replies.shift() ?? text("Mm."); return (async function* () { for (const e of ev) { if ((e as any).type === "content_block_start" && (e as any).content_block?.type === "tool_use" && o.gaps?.[n]) await sleep(o.gaps[n]); await new Promise((x) => setImmediate(x)); yield e as any; } })(); },
    record: (d) => records.push(d),
    postCall: async () => {},
    minutes: () => {},
    log: () => {},
    now: Date.now,
    wordsSettleMs: o.settleMs ?? 800, amdHoldMs: 60_000,
    maxSessionMs: 60_000, startTimeoutMs: 60_000, heartbeatMs: 60_000, silenceEndMs: 60_000, endGraceMs: 60_000, endWaitMs: 60_000,
    guardRows: async () => [],
    safetyCut: async () => {},
    // The real builder's work, with the member handed in (no members table here) and the event feed stubbed: the same allow-list,
    // guide and guard as liveCallTools.
    callTools: async (call, req) => {
      builds++;
      // Open tasks read fresh each turn, as loadMemberOnCall does.
      const tasks = db.tasks.filter((t) => t.status === "open").map((t) => ({ id: t.id, goal: t.goal }));
      return CT.buildCallTools({ userId: call.userId, callKey: call.callKey, member: { ...member, tasks }, ...G.liveCallWords(req, Y.exchangeText), only: CAP.liveCallToolNames(), guide: G.LIVE_TOOLS_GUIDE, stubSearch: true, stubEvents: [JAZZ], sendText: o.sends ?? (async (t) => { texted.push(t); return true; }) });
    },
  });
  B.handleGptLiveStream(tw as any);
  B.setLiveDeps(null);
  const call = G.buildLiveCall({ userId: USER, callSid: `CA-${Math.random().toString(36).slice(2)}`, firstName: "Jordan", direction: o.outbound ? "outbound" : "inbound", team: true, voiceLayer: VOICE, contextSummary: "Jordan is launching a ceramics studio in the Mission on the 14th.", rightNow: "", findsNow: "", callReason: "", timeOfDay: null });
  tw.in({ event: "start", streamSid: "MZ1", start: { customParameters: { s: G.issueLiveLink(call) } } });
  const said = (id: string) => ai.sent.filter((m: any) => m.delegation_id === id && m.event_id !== `quiet_${id}` && m.content).map((m: any) => m.content).join(" ");
  const lat = (n = 1) => records.filter((r) => r.decision === "call.turn_latency" && r.action === "gpt_live")[n - 1]?.proposal;
  let at = 0;
  const shown = new Set<any>();
  const turn = async (words: string, id: string, n: number) => {
    at += 3000;
    ai.in({ type: "session.input_transcript.delta", delta: words, start_ms: at, end_ms: at + 900 });
    ai.in({ type: "session.delegation.created", offset_ms: at + 1000, delegation: { id, target: "client" } });
    await until(() => !!lat(n));
    // GPT-Live says the answer (its transcript), so the next turn sees it.
    const answer = said(id);
    if (process.env.SHOW) console.log(`  member: ${words}\n  cue:    ${answer || "(nothing)"}${records.filter((r) => /claim_held|offer_unsourced/.test(r.decision) && !shown.has(r)).map((r) => { shown.add(r); return `\n          [held: "${r.proposal.sentence}" (${r.reason})]`; }).join("")}`);
    if (answer) { at += 1200; ai.in({ type: "session.output_transcript.delta", delta: answer, start_ms: at, end_ms: at + 900 }); }
    return answer;
  };
  return { tw, ai, records, reqs, texted, call, said, lat, turn, builds: () => builds, start: async () => { await sleep(5); ai.in({ type: "session.started", session: { id: "live_help" } }); } };
}
const decisions = (d: string) => db.decisions.filter((x) => x.decision === d);

// ---------------------------------------------------------------- 0. the GPT-Live allow-list
{
  const live = CAP.liveCallToolNames();
  check("0. GPT-Live's list is the call allow-list's quick tools: the event feed, starting a task or a brief, saving, correcting, a link on file", ["searchEvents", "startTask", "researchBrief", "saveAsk", "updateTask", "closeTask", "shareLink", "correctWhatCoKnows"].every((t) => live.includes(t)), live);
  check("0. never: a page, deck or document made in this process (not durable), a public share, a link reset, a calendar grant, a permanent delete", ["makePage", "updatePage", "makeDeck", "updateDeck", "writeDocument", "shareArtifact", "resetLink", "calendarConnection", "takeDownPage", "deleteImages"].every((t) => !live.includes(t)), live);
  check("0. never: web search, page reads, intros, invites or anything that costs money (never on the call list at all)", ["webSearch", "readPage", "requestEventIntro", "sendInvite", "shareFinds", "draftEmail"].every((t) => !live.includes(t)) && live.every((t) => CT.CALL_TOOL_NAMES.includes(t)));
  check("0. a job is what startTask, researchBrief and saveAsk start; a send or a save isn't", ["startTask", "researchBrief", "saveAsk"].every(CAP.startsWork) && !["shareLink", "updateNotes", "searchEvents"].some(CAP.startsWork));
}

// ---------------------------------------------------------------- 1. a verified quick lookup, used live
{
  const b = bridge([
    [...text("Let me look at what's on."), ...tool("t1", "searchEvents", { what: "live jazz", when: "this weekend" })],
    text("Rooftop Jazz Night, Saturday at 8 at The Chapel on Valencia. Want me to text you the link?"),
    [...text("Sending it now."), ...tool("t2", "shareLink", { what: ["Rooftop Jazz Night"] })],
    text("Sent, it's in your texts."),
  ]);
  await b.start();
  const a1 = await b.turn("Anything good for live jazz this weekend?", "d1", 1);
  check("1. the feed's answer is spoken live, in the same turn: its name, day, time and place, all from the result", /Rooftop Jazz Night, Saturday at 8 at The Chapel/.test(a1), a1);
  check("1. the line before the lookup went first, and nothing claimed a result before it came back", a1.indexOf("Let me look") === 0, a1);
  check("1. the thinking had the tools and the GPT-Live guide on that turn", b.reqs[0]?.tools?.some((t: any) => t.name === "searchEvents") && JSON.stringify(b.reqs[0]?.system).includes("# Doing things on this call") && !JSON.stringify(b.reqs[0]?.system).includes(G.NOTHING_ON_THIS_CALL));
  check("1. the turn's latency row carries the tool (name, time, outcome; no words)", b.lat(1)?.toolsOffered === true && b.lat(1)?.tools?.[0]?.name === "searchEvents" && b.lat(1)?.tools?.[0]?.outcome === "done", b.lat(1));
  const a2 = await b.turn("Yes please, text it to me.", "d2", 2);
  check("1. on a yes, the link goes to their texts mid-call (link, then its name) and only then is 'sent' said", b.texted[0] === JAZZ.url && /Rooftop Jazz Night/.test(b.texted[1] ?? "") && /Sent, it's in your texts\./.test(a2), { texted: b.texted, a2 });
  b.tw.close();
}

// ---------------------------------------------------------------- 2. longer work, dispatched mid-call, delivered by text afterward
let jobRow: any = null;
{
  const ASK = "Can you find me a caterer for the launch, about 40 people, nothing too fancy?";
  const b = bridge([
    // Claude says it's on it before calling the tool: that line waits for the row.
    [...text("I'm on it."), ...tool("s1", "startTask", { goal: "Find caterers for a 40-person launch", theirWords: ASK, steps: ["Search caterers in the Mission", "Text the best two"], firstStep: "Search caterers in the Mission", inHours: 1 })],
    text("I'll text you what I find on caterers for the launch."),
  ]);
  await b.start();
  const a = await b.turn(ASK, "d1", 1);
  jobRow = db.tasks[0];
  check("2. one co_tasks row: their own words, the goal, the steps, an owner (the member), open and due soon", db.tasks.length === 1 && jobRow.user_id === USER && jobRow.their_words === ASK && /caterers/i.test(jobRow.goal) && jobRow.steps.length === 2 && jobRow.status === "open" && !!jobRow.next_check_at, db.tasks);
  check("2. keyed to this call and this need (one job per call and need)", jobRow.dispatch_key === T.dispatchKeyFor(b.call.callKey, "Find caterers for a 40-person launch") && jobRow.dispatch_key.startsWith(`call:${b.call.callKey}:`), jobRow.dispatch_key);
  const ins = timeline.indexOf("db:insert #1"), firstClaim = timeline.findIndex((l) => /^say:.*(I'm on it|I'll text you)/.test(l));
  check("2. the row is written BEFORE GPT-Live hears that it started or that a text is coming", ins >= 0 && firstClaim > ins, timeline);
  check("2. both lines are said, once a job backs them", /I'm on it\..*I'll text you what I find on caterers/.test(a), a);
  check("2. the tool's receipt is in the decision log as done", decisions("tool.startTask").some((d) => d.action === "done"), decisions("tool.startTask"));
  check("2. the call's ledger has the job (what the after-call steps read)", decisions("call.done_on_call").some((d) => d.action === "startTask" && /caterers/i.test(JSON.stringify(d.proposal))), decisions("call.done_on_call"));
  b.tw.close();
  await sleep(20);
  // After the call: the job's own turn (the 15-minute task cron), delivered through the task's text path.
  const sends: string[][] = [];
  const closed: string[] = [];
  const CATER = { name: "Mission Table Catering", url: "https://missiontable.example/events", tier: 2, facts: ["serves 20 to 80 guests", "Mission District"] };
  const deps: any = {
    person: { first_name: "Jordan", phone_number: "+14155550175", city: "San Francisco" }, recent: "", zone: "America/Los_Angeles",
    note: async () => {}, schedule: async () => null, scheduleAt: async () => null, close: async (s: string, o: string) => { closed.push(`${s}: ${o}`); },
    textsToday: async () => 0, markTexted: async () => {}, markFinalTold: async () => {},
    send: async (m: string[]) => { sends.push(m); return { sent: true }; },
    search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "" }), readPage: async () => ({ ok: true, facts: [], text: "" }),
    now: () => new Date("2026-11-03T18:00:00Z"), sentSince: async () => sends.flat().map((t) => ({ at: new Date("2026-11-03T18:00:00Z"), text: t, kind: /^https?:/.test(t) ? "link" : "text" })),
    onFile: async () => [CATER], rejected: async () => [],
  };
  const t = (await T.getTask(USER, jobRow.id))!;
  // A job dispatched on a call closes as done only after a send about it went: finishing first is refused.
  script.push({ tool: "finish", input: { status: "done", outcome: "found caterers" } }, { text: "ok" });
  await TT.runTaskTurnWith(t, { ...deps, sentSince: async () => [] });
  check("2. afterward: 'done' before anything went out is refused (completed only once its delivery is known)", closed.length === 0, closed);
  script.length = 0;
  script.push(
    { tool: "tellThem", input: { what: "A caterer for the 40-person launch", links: [CATER.url] } },
    { text: JSON.stringify({ captions: [{ n: 1, caption: "Mission Table Catering does events for 20 to 80 in the Mission." }], closing: null }) },
    { tool: "finish", input: { status: "done", outcome: "sent a caterer" } },
  );
  await TT.runTaskTurnWith(t, deps);
  script.length = 0;
  check("2. afterward: the result goes by text through the task's send path (its link, then what it is)", sends.length === 1 && sends[0].includes(CATER.url), sends);
  check("2. ...and only then does the job close as done", closed.length === 1 && /^done/.test(closed[0]), closed);
}

// ---------------------------------------------------------------- 3. an abrupt hang-up while the job is being written
{
  const ASK = "Could you keep an eye out for a ceramics teacher who could run a class at the launch?";
  const b = bridge([
    [...text("Good idea."), ...tool("s1", "startTask", { goal: "Find a ceramics teacher for a launch class", theirWords: ASK, steps: ["Look for teachers"], firstStep: "Look for teachers", inHours: 2 })],
    text("I've started looking for a ceramics teacher, and I'll text you who I find."),
  ]);
  db.insertDelayMs = 0;
  await b.start();
  b.ai.in({ type: "session.input_transcript.delta", delta: ASK, start_ms: 0, end_ms: 900 });
  db.insertDelayMs = 120;
  b.ai.in({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "d1", target: "client" } });
  await until(() => b.said("d1").includes("Good idea"));
  // They hang up while the row is still being written.
  b.tw.in({ event: "stop" });
  await until(() => db.tasks.length > 0, 2000);
  await sleep(200);
  check("3. hung up mid-tool: the job still lands, once", db.tasks.length === 1 && db.tasks[0].status === "open", db.tasks);
  check("3. nothing after the hang-up reached GPT-Live (the claim line was never sent into a closed call)", !/I've started looking/.test(b.said("d1")), b.said("d1"));
  // After the call: the transcript's ask and the spoken promise don't open a second task.
  const opened: any[] = [];
  const started = await TK.tasksFromCall(USER, `assistant: Hey Jordan.\nuser: ${ASK} I really want someone good.\nassistant: Good idea.`, {
    read: async () => [{ goal: "Find a ceramics teacher to run a class at the launch", quote: ASK }],
    start: (async (x: any) => { opened.push(x); return { ok: true, task: { id: 99 } }; }) as any,
    alreadyDone: async () => false, record: async () => {}, existing: async () => db.tasks.map((t) => ({ id: t.id, goal: t.goal, theirWords: t.their_words, status: t.status })), note: async () => null,
  });
  check("3. after the call, the same ask read from the transcript is the job already open: no second task", opened.length === 0 && started.length === 1, { opened, started });
  const jobs = decisions("call.done_on_call").filter((d) => d.proposal?.kind === "start").flatMap((d) => d.proposal.labels);
  const reworded = ["I'll text you who I find for the ceramics class.", "I'll send you the caterer options tonight."];
  const left = CC.coveredByJobs(reworded, jobs);
  check("3. a promise GPT-Live said in its own words is the job's (no second promise task); one about something else stays", left.length === 1 && /caterer/.test(left[0]), { jobs, left });
}

// ---------------------------------------------------------------- 4. the same need twice, a delegation run twice, a delivery retried
{
  const ASK = "Can you look for a venue for the after-party, maybe 60 people?";
  const start = (id: string, goal: string) => [...text("Sure."), ...tool(id, "startTask", { goal, theirWords: ASK, steps: ["Look for venues"], firstStep: "Look for venues", inHours: 1 })];
  const b = bridge([
    start("s1", "After-party venue for 60 people"),
    text("I've started on the after-party venue."),
    // The same need again, a few turns later, its words in another order.
    start("s2", "Venue for 60 people for the after-party"),
    text("That's the same one I already started; it's still going."),
  ]);
  await b.start();
  await b.turn(ASK, "d1", 1);
  const a2 = await b.turn("And you're looking for the after-party venue for sixty, right?", "d2", 2);
  check("4. the same need started again on the same call is the same job: one row", db.tasks.length === 1, db.tasks.map((t) => t.goal));
  check("4. ...and the second start came back as that job, not a new one (one receipt: a repeat inside the retry window never reaches the guard)", decisions("tool.startTask").length === 1 && /same one I already started/.test(a2) && JSON.stringify(b.reqs[b.reqs.length - 1].messages).includes("alreadyStarted"), { a2 });
  // The store's own backstop: two starts with the same key at once never both insert.
  const key = T.dispatchKeyFor("u-jordan:gl:race", "Find a florist");
  const both = await Promise.all([T.startTask({ userId: USER, goal: "Find a florist", theirWords: "a florist please", steps: [], firstPlan: "look", inHours: 1, dispatchKey: key }), T.startTask({ userId: USER, goal: "Find a florist", theirWords: "a florist please", steps: [], firstPlan: "look", inHours: 1, dispatchKey: key })]);
  check("4. two starts of the same job at once: one row, the second gets it back", db.tasks.filter((t) => t.dispatch_key === key).length === 1 && both.every((r) => r.ok) && both.some((r: any) => r.existing), both.map((r: any) => r.existing ?? false));
  b.tw.close();
  // A delivery whose send failed is retried by the next wake, and only one text goes.
  const t = (await T.getTask(USER, db.tasks[0].id))!;
  const sends: string[][] = [];
  let fail = true;
  const VENUE = { name: "The Lodge on 18th", url: "https://lodge18.example/private", tier: 2, facts: ["holds 60 standing"] };
  const deps: any = {
    person: { first_name: "Jordan", phone_number: "+14155550175", city: "San Francisco" }, recent: "", zone: "America/Los_Angeles",
    note: async () => {}, schedule: async () => null, scheduleAt: async () => null, close: async () => {},
    textsToday: async () => 0, markTexted: async () => {}, markFinalTold: async () => {},
    send: async (m: string[]) => { if (fail) return { sent: false, reason: "send failed" }; sends.push(m); return { sent: true }; },
    search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "" }), readPage: async () => ({ ok: true, facts: [], text: "" }),
    now: () => new Date("2026-11-03T18:00:00Z"), sentSince: async () => sends.flat().map((x) => ({ at: new Date("2026-11-03T18:00:00Z"), text: x, kind: /^https?:/.test(x) ? "link" : "text" })),
    onFile: async () => [VENUE], rejected: async () => [],
  };
  const closed: string[] = [];
  deps.close = async (s: string) => { closed.push(s); };
  const deliver = () => [
    { tool: "tellThem", input: { what: "A venue for the after-party", links: [VENUE.url] } },
    { text: JSON.stringify({ captions: [{ n: 1, caption: "The Lodge on 18th holds 60 standing." }], closing: null }) },
    { tool: "finish", input: { status: "done", outcome: "sent a venue" } },
  ];
  script.push(...deliver());
  await TT.runTaskTurnWith(t, deps);
  script.length = 0;
  check("4. a delivery that didn't go: nothing counted as sent, and the job isn't closed as done", sends.length === 0 && closed.length === 0, { sends, closed });
  fail = false;
  script.push(...deliver());
  await TT.runTaskTurnWith(t, deps);
  script.length = 0;
  check("4. the retry delivers it once, and only then is it done", sends.length === 1 && closed.join() === "done", { sends, closed });
  // A later result from the same call job (it has texted before): still a requested result, so it goes through the door's requested
  // band and the member's rules as one. A call job is an "ask" task, and taskTurn sends every non-lookout task's text as owed
  // (services/taskTurn.ts tellThem: owed || source !== "lookout"), so no coInitiated, class "requested" (notifyGate PROACTIVE_CLASS).
  const owedFlags: unknown[] = [];
  const again = { ...t, lastTextedAt: "2026-11-01T17:00:00Z", textsSent: 1, theirReplyAt: null };
  script.push({ tool: "tellThem", input: { what: "One more venue for the after-party", links: [VENUE.url] } }, { text: JSON.stringify({ captions: [{ n: 1, caption: "The Lodge on 18th holds 60 standing." }], closing: null }) }, { text: "ok" });
  await TT.runTaskTurnWith(again as any, { ...deps, send: async (m: string[], o: any) => { owedFlags.push(o?.owed); return { sent: true }; } });
  script.length = 0;
  check("4. a call job's later result is still sent as requested (owed), not as Cue's own find", owedFlags.length >= 1 && owedFlags.every((x) => x === true), owedFlags);
}

// ---------------------------------------------------------------- 5. a dispatch that fails, said honestly
{
  const ASK = "Can you find a photographer for the launch?";
  const b = bridge([
    [...text("I'll get a search going for a photographer."), ...tool("s1", "startTask", { goal: "Find a launch photographer", theirWords: ASK, steps: ["Look"], firstStep: "Look", inHours: 1 })],
    text("I've started on it, and I'll text you the photographers I find."),
    // The held turn's retry, told what it couldn't back.
    text("That didn't go through on my end, so nothing's running for it yet."),
  ]);
  await b.start();
  db.failInsert = true;
  const a = await b.turn(ASK, "d1", 1);
  check("5. the job wasn't written, and nothing said it started or promised a text", db.tasks.length === 0 && !/I'll get a search going|I've started|I'll text you/.test(a), { a, tasks: db.tasks.length });
  check("5. what they hear is that it didn't go through", /didn't go through/.test(a), a);
  check("5. the guard's receipt says not done (a throw leaves a receipt), and the held lines are logged as held claims", decisions("tool.startTask").some((d) => d.action === "not_done") && b.records.filter((r) => r.decision === "call.claim_held").length >= 2, { tool: decisions("tool.startTask"), held: b.records.filter((r) => r.decision === "call.claim_held").map((r) => r.reason) });
  b.tw.close();
}

// ---------------------------------------------------------------- 6. missing permissions
{
  // No yes: a venue brief needs their yes (the registry's confirm), and the read says this isn't one.
  yes = false;
  const b = bridge([
    [...text("One sec."), ...tool("r1", "researchBrief", { what: "a launch venue for 40", headcount: 40, city: "San Francisco", theirYes: "venues are a pain" })],
    text("I've started the venue brief, it'll come as a document."),
    text("I can put a venue brief together if you want one."),
  ]);
  await b.start();
  const a = await b.turn("Ugh, venues are a pain.", "d1", 1);
  yes = true;
  check("6. no yes: no brief starts, and 'I've started the venue brief' is never said", db.tasks.length === 0 && !/I've started the venue brief/.test(a) && decisions("tool.researchBrief").some((d) => d.action === "needs_yes"), { a, d: decisions("tool.researchBrief") });
  b.tw.close();
}
{
  // Texts off: nothing is texted, now or later, and no line says it went or will.
  const b = bridge([
    [...text("Let me look."), ...tool("q1", "searchEvents", { what: "jazz", when: "this weekend" })],
    text("Rooftop Jazz Night is Saturday at 8."),
    [...text("Texting it now."), ...tool("l1", "shareLink", { what: ["Rooftop Jazz Night"] })],
    text("I'll text it to you right after the call."),
    text("Texts are off for you, so here it is: Rooftop Jazz Night."),
  ], { member: { noTexts: true } });
  await b.start();
  await b.turn("Anything for jazz this weekend?", "d0", 1).catch(() => "");
  const a = await b.turn("Text me that jazz one?", "d1", 2);
  check("6. texts off: nothing texted, and no 'I'll text it after' reaches them (nothing is queued for a member with texts off)", b.texted.length === 0 && !/I'll text it|right after the call/.test(a), { a, texted: b.texted });
  check("6. ...and what they hear is the thing itself, out loud", /Texts are off for you, so here it is: Rooftop Jazz Night/.test(a), a);
  check("6. ...a member with texts off isn't offered a send at all, and no 'texting it now' is said", !b.reqs.some((r) => (r.tools ?? []).some((t: any) => t.name === "shareLink")) && !/Texting it now/.test(a), a);
  b.tw.close();
}
{
  // Off the GPT-Live list: a public share link is never made, whatever the model asks for.
  const b = bridge([
    [...text("Let me make a link."), ...tool("x1", "shareArtifact", { which: "launch page" })],
    text("Done, anyone with the link can see it now."),
    text("I can't share that from a call."),
  ]);
  await b.start();
  const a = await b.turn("Can you make my launch page public?", "d1", 1);
  check("6. off the GPT-Live list: never offered, never run, and 'done' is held", !b.reqs[0].tools.some((t: any) => t.name === "shareArtifact") && !decisions("tool.shareArtifact").length && !/Done/.test(a), { a, tools: b.reqs[0].tools.map((t: any) => t.name) });
  check("6. ...the model is told it isn't available, and the turn still answers (never ends on the line before the tool)", JSON.stringify(b.reqs[1]?.messages ?? "").includes("No tool named shareArtifact on a call") && /can't share that from a call/.test(a), a);
  b.tw.close();
}
{
  // An outbound call before AMD's verdict: no tools at all (nothing acts on what a recording said).
  const b = bridge([text("Hi Jordan.")], { outbound: true });
  await b.start();
  b.ai.in({ type: "session.input_transcript.delta", delta: "Hi, you've reached Jordan, find me a caterer please, leave a message.", start_ms: 0, end_ms: 900 });
  b.ai.in({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "d1", target: "client" } });
  await sleep(150);
  check("6. outbound before a person is confirmed: the turn's tools are never built", b.builds() === 0 && !(b.reqs[0]?.tools ?? []).some((t: any) => t.name === "startTask"), { builds: b.builds(), tools: (b.reqs[0]?.tools ?? []).map((t: any) => t.name) });
  b.tw.close();
}

// ---------------------------------------------------------------- 7. a correction mid-call, then a stop
{
  const ASK = "Find me a caterer for the launch, 40 people.";
  const b = bridge([
    [...text("On it."), ...tool("s1", "startTask", { goal: "Caterer for a 40-person launch", theirWords: ASK, steps: ["Search caterers"], firstStep: "Search caterers", inHours: 1 })],
    text("Started, I'll text you what I find on caterers."),
    // The correction goes on the same job.
    [...text("Got it, sixty."), ...tool("u1", "updateTask", { taskId: 1, note: "They said it's 60 people now, not 40, and vegetarian." })],
    text("I've changed it to sixty, vegetarian."),
    // The stop.
    [...tool("c1", "closeTask", { taskId: 1, status: "dropped", outcome: "they're sorting the caterer themselves", theirWords: "forget the caterer, I'll sort it myself" }, 0)],
    text("Okay, I've stopped it. Nothing had gone out yet."),
  ]);
  await b.start();
  await b.turn(ASK, "d1", 1);
  const a2 = await b.turn("Actually make it sixty, and vegetarian.", "d2", 2);
  check("7. the correction is written on the same job (their words), and no second job starts", db.tasks.length === 1 && db.tasks[0].notes.some((n: any) => /60 people now, not 40, and vegetarian/.test(n.text)) && /changed it to sixty/.test(a2), { notes: db.tasks[0]?.notes, a2 });
  const a3 = await b.turn("Forget the caterer, I'll sort it myself.", "d3", 3);
  check("7. the stop closes that job (dropped, on their word) before any of it ran", db.tasks[0].status === "dropped" && timeline.includes("db:close #1 dropped"), db.tasks[0]);
  check("7. ...and the result tells Cue what had already happened, which is what it says", /stopped it\. Nothing had gone out yet/.test(a3) && b.reqs.some((r) => JSON.stringify(r.messages).includes("Stopped before it ran: nothing from it went out.")), a3);
  // After the call, the transcript's ask doesn't open it again.
  const opened: any[] = [];
  await TK.tasksFromCall(USER, `user: ${ASK} Actually make it sixty, and vegetarian. Forget the caterer, I'll sort it myself.`, { read: async () => [{ goal: "Find a caterer for a 60-person launch", quote: ASK }], start: (async (x: any) => { opened.push(x); return { ok: true, task: { id: 9 } }; }) as any, alreadyDone: async () => false, record: async () => {}, existing: async () => db.tasks.map((t) => ({ id: t.id, goal: t.goal, theirWords: t.their_words, status: t.status })), note: async () => null });
  check("7. a job they stopped on the call is never reopened from the transcript afterward", opened.length === 0, opened);
  b.tw.close();
}
{
  // A stop after the job had already run and texted them: Cue is told so, and can't say it was undone.
  reset();
  const r = await T.startTask({ userId: USER, goal: "Find a florist", theirWords: "a florist please", steps: [], firstPlan: "look", inHours: 1 });
  db.tasks[0].wakes = 1; db.tasks[0].texts_sent = 1;
  const set = CT.buildCallTools({ userId: USER, callKey: "u-jordan:gl:stop", member: { phone: "+14155550175", firstName: "Jordan", city: "San Francisco", tasks: [{ id: (r as any).task.id, goal: "Find a florist" }], loops: null }, turnWords: "stop the florist thing, I don't want it", callWords: "stop the florist thing, I don't want it", lastCoLine: null, only: CAP.liveCallToolNames(), guide: G.LIVE_TOOLS_GUIDE });
  const out: any = await set.run("closeTask", { taskId: (r as any).task.id, status: "dropped", outcome: "they don't want it", theirWords: "I don't want it" }, "c9");
  check("7. stopped after it had texted: the result says it already texted them once, and that it can't be taken back", out?.ok === true && /already texted them 1 time/.test(out.already) && /can't be taken back/.test(out.already), out);
}

// ---------------------------------------------------------------- 8. a safety turn launches no helper
{
  const LINE = "I'm really glad you told me. If you're thinking about ending your life, please call or text 988 right now, and stay with me.";
  const b = bridge([text(LINE)]);
  await b.start();
  await b.turn("Honestly I don't want to be here anymore.", "d1", 1);
  const exact = b.ai.sent.find((m: any) => m.delegation_id === "d1" && m.type === "session.instructions.append");
  check("8. a safety turn: the toolset is never built, and the thinking has no tool but end_call", b.builds() === 0 && (b.reqs[0]?.tools ?? []).map((t: any) => t.name).join() === "end_call", { builds: b.builds(), tools: (b.reqs[0]?.tools ?? []).map((t: any) => t.name) });
  check("8. its answer goes word for word (sayExactly), 988 included, with no claim check in the way", !!exact && exact.content.includes("988") && exact.content.includes("stay with me"), exact);
  b.tw.close();
}

// ---------------------------------------------------------------- 9. unverified claims, held before GPT-Live hears them
{
  const b = bridge([
    text("The Blue Lantern has a jazz set Friday at 9. I booked you a table. I've started looking for more."),
    text("I don't have anything solid on Friday yet. Want me to look?"),
  ]);
  await b.start();
  const a = await b.turn("Is there anything for jazz on Friday?", "d1", 1);
  const held = b.records.filter((r) => r.decision === "call.claim_held" || r.decision === "call.offer_unsourced").map((r) => r.proposal.sentence);
  check("9. a name and a time nothing returned, a booking, and 'I've started' with no job: none reach GPT-Live", !/Blue Lantern|booked|I've started/.test(a), a);
  check("9. each is logged as held, and the turn still answers in Cue's own words", held.length === 3 && /don't have anything solid/.test(a), { held, a });
  // The claim families themselves, on Cue's own words.
  const J = { thisTurn: 0, corpus: "", onCall: false };
  check("9. families: 'I'm on it', 'it's in motion', 'I've kicked it off' are started; 'I'll text you what I find' a promise; 'you're booked' a booking", CL.jobClaimKind("I'm on it.") === "started" && CL.jobClaimKind("It's in motion.") === "started" && CL.jobClaimKind("I've kicked it off.") === "started" && CL.jobClaimKind("I'll text you what I find.") === "promise" && CL.jobClaimKind("You're booked for Friday.") === "booked");
  check("9. never claims: a question, an offer, a negation", [CL.jobClaimKind("Want me to look into it?"), CL.jobClaimKind("I haven't started on it yet."), CL.jobClaimKind("Should I text you the link?")].every((k) => k === null));
  check("9. backing: a job about caterers backs 'I'll text you the caterers', not 'I'll send the florists'; a booking is never backed", CL.jobBacked("I'll text you the caterers I find.", { ...J, thisTurn: 1, corpus: "Find caterers for a 40-person launch" }) && !CL.jobBacked("I'll send you the florists.", { ...J, thisTurn: 1, corpus: "Find caterers for a 40-person launch" }) && !CL.jobBacked("I booked it.", { thisTurn: 3, corpus: "booked", onCall: true }));
  b.tw.close();
}

// ---------------------------------------------------------------- 10. the word cap: never a safety line, and nothing lost silently
{
  const ORD = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth", "Eleventh", "Twelfth"];
  const steps = ORD.map((o) => `${o}, check the kiln shelf for cracks before you load the next piece of work onto it.`).join(" ");
  const s = new SP.SpeakableStream({ keep: (x: string) => /\b988\b/.test(x) });
  const out = [...s.push(`${steps} If you feel unsafe at any point, call or text 988.`), ...s.end()].join("");
  check("10. past the cap, a safety line is still said, and what the cap held goes out before it, in order (nothing dropped)", /988/.test(out) && out.indexOf("Twelfth") < out.indexOf("988") && ORD.every((o, k) => k === 0 || out.indexOf(`${ORD[k - 1]},`) < out.indexOf(`${o},`)) && s.unsaid().length === 0, out.slice(-200));
  const plain = new SP.SpeakableStream({ keep: (x: string) => /\b988\b/.test(x) });
  [...plain.push(steps), ...plain.end()];
  check("10. with no safety line, what the cap held back is kept, whole sentences, in order", plain.unsaid().length > 3 && /^[A-Z][a-z]+th, check the kiln shelf/.test(plain.unsaid()[0]), plain.unsaid().slice(0, 2));
  const b = bridge([text(steps), text("Next, check the shelf again.")]);
  await b.start();
  await b.turn("Walk me through prepping the kiln?", "d1", 1);
  await b.turn("Okay, go on.", "d2", 2);
  const last = b.reqs[b.reqs.length - 1];
  const next = JSON.stringify(last?.system ?? "") + JSON.stringify(last?.messages ?? "");
  check("10. the long answer itself went out whole sentences only, under the cap", SP.wordCount(b.said("d1")) <= SP.MAX_REPLY_WORDS + 25 && /onto it\.$/.test(b.said("d1")), b.said("d1"));
  check("10. the next turn is told where the last answer stopped, so it goes on from there", /your last answer stopped at the length one phone turn allows/.test(next) && /th, check the kiln shelf/.test(next), next.slice(0, 300));
  b.tw.close();
}

// ---------------------------------------------------------------- 11. the prompts say what's true now
{
  check("11. GPT-Live's own prompt: it can't act itself, its thinking can", /only your thinking can/.test(G.NOTHING_ON_THIS_CALL_LIVE) && !/Nothing can be set up, looked up, sent or scheduled on this call/.test(G.liveInstructions({ firstName: "Jordan", direction: "inbound", team: true })));
  check("11. the guide: need over naming a helper, a vent received first, no recap work, and a promise only with a task behind it", /even if they didn't name a helper/.test(G.LIVE_TOOLS_GUIDE) && /A feeling or a vent is received first/.test(G.LIVE_TOOLS_GUIDE) && /Never start work just to recap the call/.test(G.LIVE_TOOLS_GUIDE) && /only when a task for it came back done/.test(G.LIVE_TOOLS_GUIDE));
  check("11. a turn with no answer never tells GPT-Live to promise a text", !/text them on it after the call/.test(fs.readFileSync(new URL("../../src/services/gptLiveBridge.ts", import.meta.url), "utf8")));
}

// ---------------------------------------------------------------- 12. review of #365: what a claim may stand on
{
  // Hole 1: a find listed on the call is not a job. Searching backs naming the find; it never backs "I've started looking" or "I'll text
  // you more".
  const b = bridge([
    [...text("Let me look."), ...tool("q1", "searchEvents", { what: "jazz", when: "this weekend" })],
    text("Rooftop Jazz Night is Saturday at 8. I've started looking for jazz at The Chapel. I'll text you more jazz nights I find."),
    text("That's the one I see for now."),
  ]);
  await b.start();
  const a = await b.turn("Anything for jazz this weekend?", "d1", 1);
  check("12. a find on the call names itself, but backs no 'I've started looking' and no 'I'll text you more' (no job behind them)", /Rooftop Jazz Night is Saturday at 8/.test(a) && !/I've started looking|I'll text you more/.test(a) && db.tasks.length === 0, a);
  b.tw.close();
}
{
  // Hole 2: a job for one need on the call doesn't back a subject-less promise about another.
  const ASK = "Can you find me a caterer for the launch, 40 people?";
  const b = bridge([
    [...text("Sure."), ...tool("s1", "startTask", { goal: "Find a caterer for a 40-person launch", theirWords: ASK, steps: ["Search"], firstStep: "Search", inHours: 1 })],
    text("I'll text you what I find."),
    text("I'll text you what I find."),
    text("Want me to start on a photographer too?"),
  ]);
  await b.start();
  const a1 = await b.turn(ASK, "d1", 1);
  const a2 = await b.turn("And a photographer for it as well?", "d2", 2);
  check("12. 'I'll text you what I find' stands on this turn's own job (the caterer)", /I'll text you what I find/.test(a1), a1);
  check("12. ...but not on the next turn, about a photographer nothing was started for", !/I'll text you what I find/.test(a2) && /start on a photographer/.test(a2) && db.tasks.length === 1, a2);
  const J = { thisTurn: 0, corpus: "Find a caterer for a 40-person launch", callJobs: "Find a caterer for a 40-person launch", onCall: true, need: "" };
  check("12. jobBacked: a found listing alone backs nothing; a subject needs job text; a subject-less promise needs a job for this need", !CL.jobBacked("I'll text you more jazz nights I find.", { thisTurn: 0, corpus: "", callJobs: "", onCall: false, need: "anything for jazz" }) && CL.jobBacked("I'll text you the caterers I find.", J) && !CL.jobBacked("I'll text you what I find.", { ...J, need: "and a photographer?" }) && CL.jobBacked("I'll text you what I find.", { ...J, need: "the caterer, sixty people now" }) && !CL.jobBacked("I'll text you the caterers.", { ...J, onCall: false }));
  b.tw.close();
}
{
  // Inside the 20 s window: a reworded retry of the same need is that job; a different need starts its own (review of #365, round 2).
  const ASK = "Can you find caterers for the launch party?";
  const b = bridge([
    [...text("Sure."), ...tool("s1", "startTask", { goal: "Find caterers for the launch party", theirWords: ASK, steps: ["Search"], firstStep: "Search", inHours: 1 })],
    text("On it."),
    // The same need, reworded, seconds later (a re-sent delegation): its words in another order, "find" moved and "some" added.
    [...text("Sure."), ...tool("s2", "startTask", { goal: "Caterers for the launch party, find some", theirWords: ASK, steps: ["Search"], firstStep: "Search", inHours: 1 })],
    text("I'll text you the caterer options."),
    // A different need, seconds later.
    [...text("Sure."), ...tool("s3", "startTask", { goal: "Find a florist for the launch party", theirWords: "and a florist", steps: ["Search"], firstStep: "Search", inHours: 1 })],
    text("I'll text you the florists I find."),
    // Caterers and a band: one shared word ("caterer") with the caterers job is not the same need (review of #365's follow-up: it
    // folded into "Find caterers" and the band was lost).
    [...text("Sure."), ...tool("s4", "startTask", { goal: "Caterers and a band for the launch party", theirWords: "caterers and a band", steps: ["Search"], firstStep: "Search", inHours: 1 })],
    text("I'll text you the bands I find."),
  ]);
  await b.start();
  await b.turn(ASK, "d1", 1);
  const a2 = await b.turn(ASK, "d2", 2);
  check("12. a reworded retry of the same need inside 20 s is that job: one row, and its claim stands on that job's goal", db.tasks.length === 1 && /caterer options/.test(a2), { tasks: db.tasks.map((t) => t.goal), a2 });
  const a3 = await b.turn("And a florist too.", "d3", 3);
  check("12. a different need inside 20 s starts its own job, and 'I'll text you the florists' stands on that one", db.tasks.length === 2 && db.tasks.some((t) => /florist/i.test(t.goal)) && /florists I find/.test(a3), { tasks: db.tasks.map((t) => t.goal), a3 });
  const a4 = await b.turn("Actually caterers and a band.", "d4", 4);
  check("12. 'caterers and a band' inside 20 s of 'Find caterers' starts its own job (the band isn't lost)", db.tasks.length === 3 && db.tasks.some((t) => /band/i.test(t.goal)) && /bands I find/.test(a4), { tasks: db.tasks.map((t) => t.goal), a4 });
  const same = (a: string, b: string) => CT.sameNeed(a, b, "k");
  check("12. sameNeed: a retry that adds no subject is the same job (action and filler words don't count)",
    same("find a florist", "florists nearby") && same("Find caterers for the launch party", "Caterers for the launch party, find some") &&
    same("Find vegan caterers in Oakland", "Vegan caterer options in Oakland") && same("Book a photographer", "a photographer"),
    { florist: same("find a florist", "florists nearby") });
  const pairs: [string, string][] = [["Find caterers", "caterers and a band"], ["golf club", "book club"], ["farmers market", "Saturday market"], ["pottery classes", "yoga classes"], ["tutor in Spanish", "tutor in math"],
    ["Find caterers for the launch party", "Caterers and a band for the launch party"], ["Find caterers for the launch party", "Find a florist for the launch party"], ["Find caterers", "And a florist"], ["Find caterers", "find some"]];
  check("12. sameNeed: any new subject is a new job (a duplicate over a lost request); never the tool alone", pairs.every(([a, b]) => !same(a, b)), pairs.filter(([a, b]) => same(a, b)));
  b.tw.close();
}
{
  // An alreadyStarted result never lends the second call's words to the job text.
  const P = await import("../../src/services/callLlmProxy.js");
  const fake = { defs: [{ name: "startTask", description: "s", input_schema: { type: "object", properties: {} } }], names: new Set(["startTask"]), note: "", starts: () => true, jobs: { corpus: "", callJobs: "" }, turnFacts: { turnWords: "and a florist", tasks: [], canWriteTasks: false },
    run: async () => ({ ok: true, taskId: 1, goal: "Find caterers for the launch party", alreadyStarted: true }) };
  const reqs: any[] = [[...text("Sure."), ...tool("s", "startTask", { goal: "Find a florist" })], text("I'll text you the florists I find."), text("That's the caterers job; want me to start on a florist?")];
  let out = "";
  for await (const c of P.runCallLlm({ messages: [{ role: "system", content: "You are Cue." }, { role: "user", content: "and a florist" }] } as any, { stream: () => (async function* () { for (const e of reqs.shift() ?? text("Mm.")) yield e as any; })(), clean: true, tools: fake as any, jobClaims: true })) out += c.choices[0].delta.content ?? "";
  check("12. a start returned as another job (alreadyStarted) backs only that job's goal: 'the florists' is held", !/florists I find/.test(out) && /start on a florist/.test(out), out);
}

// ---------------------------------------------------------------- 13. review of #365: the safety cap, and tools only with a person
{
  const P = await import("../../src/services/callLlmProxy.js");
  const LONG = "If you're thinking about ending your life, please call or text 988 right now, because the people there are trained for exactly this moment and will stay on the line with you for as long as you need, day or night.";
  const STEPS = ["First, put some distance between you and anything you could use to hurt yourself.", "Second, call or text 988, or a friend you trust, and tell them what you told me.", "Third, if you're in danger right now, call 911.", "Fourth, stay somewhere with other people tonight if you can.", "Fifth, text me when you've done the first two, so I know you're okay.", "Sixth, I'll be here, and we can keep talking as long as you want."];
  const answer = [LONG, ...STEPS, ...STEPS.map((x) => x.replace(/^(\w+),/, "Again, $1,"))].join(" ");
  let out = "";
  const ev = text(answer);
  for await (const c of P.runCallLlm({ messages: [{ role: "system", content: "You are Cue." }, { role: "user", content: "Honestly I don't want to be here anymore." }] } as any, { stream: () => (async function* () { for (const e of ev) yield e as any; })(), clean: true })) out += c.choices[0].delta.content ?? "";
  check("13. a safety turn's answer is never capped: past 90 words, every step is said", SP.wordCount(out) > SP.MAX_REPLY_WORDS + 25 && STEPS.every((x) => out.includes(x)), SP.wordCount(out));
  check("13. ...and a long crisis sentence goes whole, never split at a comma", out.includes(LONG), out.slice(0, 260));
}
{
  // Outbound, AMD "unknown": answers may be released, but no tool runs (nothing acts on what a recording could produce).
  const b = bridge([text("Hi Jordan.")], { outbound: true });
  await b.start();
  G.noteAnsweredBy(b.call.callSid!, "unknown");
  b.ai.in({ type: "session.input_transcript.delta", delta: "Hello?", start_ms: 0, end_ms: 600 });
  b.ai.in({ type: "session.delegation.created", offset_ms: 700, delegation: { id: "d1", target: "client" } });
  await until(() => !!b.lat(1));
  check("13. AMD 'unknown' releases the answer but never the tools", b.builds() === 0 && /Hi Jordan/.test(b.said("d1")), { builds: b.builds(), said: b.said("d1") });
  b.tw.close();
}
{
  // Outbound, AMD human: tools are given; a voicemail found while the turn is running stops the tool before it acts.
  const b = bridge([
    [...text("One sec."), ...tool("s1", "startTask", { goal: "Find a caterer", theirWords: "a caterer", steps: ["Search"], firstStep: "Search", inHours: 1 })],
    text("Okay."),
  ], { outbound: true, settleMs: 20, gaps: { 1: 250 } });
  await b.start();
  G.noteAnsweredBy(b.call.callSid!, "human");
  b.ai.in({ type: "session.input_transcript.delta", delta: "Hello?", start_ms: 0, end_ms: 600 });
  b.ai.in({ type: "session.delegation.created", offset_ms: 700, delegation: { id: "d1", target: "client" } });
  await sleep(60);
  // The tool hasn't been called yet: the line turns out to be a machine whose greeting just ended.
  G.noteAnsweredBy(b.call.callSid!, "machine_end_beep");
  await until(() => !!b.lat(1));
  check("13. AMD human: tools given; voicemail found mid-turn: the tool is refused, nothing written", b.builds() === 1 && db.tasks.length === 0 && b.ai.sent.some((m: any) => m.event_id === "voicemail"), { builds: b.builds(), tasks: db.tasks.length });
  b.tw.close();
}
{
  // The turn's own notes go after their words, never into the cached system prompt; the cap note is never on a safety turn.
  const b = bridge([text("Okay.")]);
  await b.start();
  const out = await G.thinkOnCall(b.call, [{ who: "member", text: "Honestly I don't want to be here anymore.", startMs: 0, endMs: 900 }], (r: any) => { b.reqs.push(r); return (async function* () { for (const e of text("I'm here. Call or text 988 right now.")) yield e as any; })(); }, undefined, undefined, undefined, undefined, { carry: ["Ninth, check the shelf."], tools: async () => null });
  const r = b.reqs[b.reqs.length - 1];
  const last = JSON.stringify(r.messages[r.messages.length - 1]);
  check("13. no-tools note after their words (system unchanged); no cap note on a safety turn", !JSON.stringify(r.system).includes(G.NOTHING_ON_THIS_CALL) && last.includes(G.NOTHING_ON_THIS_CALL) && !JSON.stringify(r).includes("your last answer stopped") && /988/.test(out.text), last.slice(0, 200));
  b.tw.close();
}

console.log(`gptLiveHelpers: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
process.exit(0);
