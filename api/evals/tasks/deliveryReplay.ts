// Replay of the 2026-10-09 8:47am delivery (Royce's call, task #136), zero tokens: the model is scripted to do what it did that
// morning, and the code has to hold Royce's rules (2026-10-09):
//   the run link goes out (it's on file), the Tech Week events carry their links, no picker-rejected item appears, one message
//   total, and no sentence claims a check that never happened.
//   npx tsx evals/tasks/deliveryReplay.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";

type Answer = { tool: string; input: any } | { text: string };
const script: Answer[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const a = script.shift() ?? { text: "Nothing more." };
  const content = "tool" in a ? [{ type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name: a.tool, input: a.input }] : [{ type: "text", text: a.text }];
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "scripted", content, stop_reason: "tool" in a ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const TT = await import("../../src/services/taskTurn.js");
const SP = await import("../../src/services/speakable.js");
const CC = await import("../../src/services/callCommitments.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const RUN = { name: "Builders who Run — Golden Gate Bridge 4M", url: "https://lu.ma/2i3qsijp", tier: 2, facts: ["date: 2026-10-10", "starts 2026-10-10 09:00", "Golden Gate Bridge"] };
const LONG = { name: "Long Lead Time: A Hardware Happy Hour @ TechCrunch Disrupt", url: "https://lu.ma/j0d8zw82", tier: 2, facts: ["date: 2026-10-12", "starts 2026-10-12 18:00", "San Francisco"] };
const GAMES = { name: "San Francisco | Claude for Games", url: "https://lu.ma/claudeforgames", tier: 2, facts: ["date: 2026-10-12", "starts 2026-10-12 17:00"] };
const coBefore = "Actually, one of the things that came up is Builders who Run, a free Saturday 9am run across the Golden Gate Bridge for founders. Want me to text you the link?";
const NOW = new Date("2026-10-09T15:45:00Z"); // 8:45am Pacific
const task: any = {
  id: 136, userId: "u", goal: CC.commitmentGoalAbout("Done, I'll send that over now.", coBefore), theirWords: "Yeah, that would be perfect.",
  steps: [{ text: "Send what you said you would", done: false }], planNext: "Send it now", status: "open", wakes: 3, textsSent: 0, lastTextedAt: null,
  createdAt: "2026-10-08T23:23:43Z", deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "work", source: "promise", window: null,
  notes: [{ at: "2026-10-09T00:50:00Z", text: 'Also said on the call: "But for this weekend, I\'ll send what I\'ve got." (after they said: "whatever you could really find, just send it my way"). Send it in the same message as the rest of this task.' }],
};
const log = { sent: [] as string[][], notes: [] as string[], closed: [] as string[] };
const deps: any = {
  person: { first_name: "Jordan", phone_number: "+14155550100", city: "San Francisco" }, recent: "", zone: "America/Los_Angeles",
  note: async (t: string) => { log.notes.push(t); }, schedule: async () => null, scheduleAt: async () => null, close: async (s: string, o: string) => { log.closed.push(`${s}: ${o}`); },
  textsToday: async () => 2, markTexted: async () => {}, markFinalTold: async () => {},
  send: async (m: string[]) => { log.sent.push(m); return { sent: true }; },
  search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "" }), readPage: async () => ({ ok: true, facts: [], text: "" }),
  now: () => NOW, sentSince: async () => [],
  onFile: async () => [RUN, LONG, GAMES],
  rejected: async () => ["San Francisco | Claude for Games"],
};

check(`the call promise knows what "that" was (${task.goal.slice(0, 110)})`, /Builders who Run/.test(task.goal));

// What the model did that morning, then what it should do.
script.push(
  // 1. the 8:47am text, as it was: no links, a confirmed-count opener, an invented broken link, a rejected item
  { tool: "tellThem", input: { what: "From the call: two confirmed for Tech Week, Long Lead Time Hardware Happy Hour at TechCrunch Disrupt and Claude for Games Build Day. Left the run club off since the link wasn't working." } },
  // 2. links, but leaving the promised run link out
  { tool: "tellThem", input: { what: "Two Tech Week picks for Monday", links: [LONG.url, GAMES.url] } },
  { text: JSON.stringify({ captions: [{ n: 1, caption: "A hardware happy hour at TechCrunch Disrupt, Monday 6pm in San Francisco." }], closing: null }) },
  // 3. the whole delivery: the run link plus the weekend and Tech Week picks, Claude for Games included by the model
  { tool: "tellThem", input: { what: "The run for Saturday, plus a Tech Week pick for the weekend", links: [RUN.url, LONG.url, GAMES.url] } },
  { text: JSON.stringify({ captions: [{ n: 1, caption: "The founder run across the Golden Gate Bridge, Saturday 9am, this weekend." }, { n: 2, caption: "A hardware happy hour at TechCrunch Disrupt, Monday 6pm in San Francisco." }], closing: null }) },
  // 4. the weekend close-out it tried at 9am
  { tool: "tellThem", input: { what: "Weekend close-out: Brain Optimization Summit on Sunday" } },
  { tool: "finish", input: { status: "done", outcome: "sent the run and the picks" } },
);
const r = await TT.runTaskTurnWith(task, deps);
if (process.env.DEBUG_REPLAY) console.log(JSON.stringify(r.texts));
script.length = 0;

const all = log.sent.flat().join("\n");
check(`one message total (${log.sent.length} send${log.sent.length === 1 ? "" : "s"})`, log.sent.length === 1, log.sent);
check("the run link goes out (it was on file)", all.includes(RUN.url), all);
check("the Tech Week event carries its link", all.includes(LONG.url), all);
check("no picker-rejected item appears (Claude for Games)", !/claude for games|claudeforgames/i.test(all), all);
check("no sentence claims a check that never happened", !SP.inventedFailure(all) && !/wasn'?t working|couldn'?t confirm/i.test(all), all);
check("no process narration", !/from the call|confirmed|left .* off|sending (?:both|them) now/i.test(all), all);
check("the promise closes only on the whole delivery", log.closed.length === 1 && /^done/.test(log.closed[0]), { closed: log.closed, did: r.did });
check("the first attempt (the 8:47 text as it was) never went out", !log.sent.some((m) => m.some((x) => /two confirmed/i.test(x))));

// A plain-text mention of the rejected item is refused too.
{
  const log2: string[][] = [];
  script.push({ tool: "tellThem", input: { what: "The run for Saturday, and Claude for Games Build Day on Monday", links: [RUN.url] } });
  await TT.runTaskTurnWith({ ...task, notes: [] }, { ...deps, send: async (m: string[]) => { log2.push(m); return { sent: true }; } });
  script.length = 0;
  check("a text naming the rejected item (\"Claude for Games Build Day\") is refused", !log2.flat().some((x) => /claude for games/i.test(x)), log2);
}

// Review of #117: an honest plain line or a question still goes before the delivery (a task never gets stuck).
for (const [label, what, reply] of [
  ["an honest \"there's no run this Saturday\"", "There's no founder run this Saturday", "There's no founder run this Saturday, the next one is the 17th."],
  ["a clarifying question", "Ask which neighborhood they'd start from", "Starting from the Marina or closer to downtown?"],
] as const) {
  const sent: string[][] = [];
  script.push({ tool: "tellThem", input: { what } }, { text: reply });
  await TT.runTaskTurnWith({ ...task, notes: [] }, { ...deps, onFile: async () => [], send: async (m: string[]) => { sent.push(m); return { sent: true }; } });
  script.length = 0;
  check(`${label} still goes (no stuck promise)`, sent.length === 1, sent);
}
// Rejects never block a whole city or series.
{
  const sent: string[][] = [];
  script.push({ tool: "tellThem", input: { what: "The hardware happy hour in San Francisco on Monday", links: [LONG.url] } }, { text: JSON.stringify({ captions: [{ n: 1, caption: "A hardware happy hour at TechCrunch Disrupt, Monday 6pm in San Francisco." }], closing: null }) });
  await TT.runTaskTurnWith({ ...task, goal: "Keep your word from the call: \"I'll text you the hardware happy hour.\"", notes: [] }, { ...deps, send: async (m: string[]) => { sent.push(m); return { sent: true }; } });
  script.length = 0;
  check("rejecting \"San Francisco | Claude for Games\" doesn't block things in San Francisco", sent.flat().includes(LONG.url), sent);
}
// Ordinary lines aren't failure claims or narration.
const fine = ["The site is live now.", "Registration form is live.", "It is live from 7pm.", "it wasn't loading for you?", "You couldn't get tickets last time, so here's an early one.", "You can't get a better rooftop.", "The link is working fine."];
check(`ordinary lines aren't failure claims: ${fine.filter((t) => SP.inventedFailure(t)).join(" | ") || "none"}`, fine.every((t) => !SP.inventedFailure(t)));
const plain = ["Let's pick up where we left off.", "Five confirmed guests so far for the dinner.", "3 verified founders are coming.", "The host couldn't confirm the venue yet.", "As promised, here's the plan."];
check(`ordinary lines aren't narration: ${plain.filter((t) => SP.narratesInternalState(t)).join(" | ") || "none"}`, plain.every((t) => !SP.narratesInternalState(t)));

// Pure pieces
check("narration rules catch the 8:47 opener and the left-off line", !!SP.narratesInternalState("From the call: two confirmed for Tech Week.") && !!SP.narratesInternalState("Left the run club off since the link wasn't working."));
check("invented failures are caught; plain facts aren't", SP.inventedFailure("Left the run club off since the link wasn't working.") && SP.inventedFailure("I couldn't confirm the run.") && !SP.inventedFailure("The run is Saturday at 9am.") && !SP.inventedFailure("Registration opens Monday."));

console.log(`delivery replay: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
