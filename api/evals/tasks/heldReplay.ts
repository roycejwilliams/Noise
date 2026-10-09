// Review of #129, replayed with the model scripted (zero tokens):
//   H2: a promised delivery after an unanswered question is still owed (it goes exempt, never held for pacing)
//   H1: a send held for pacing moves the next look to the hold, past a sooner one the turn scheduled, and gives the wake back
//   npx tsx evals/tasks/heldReplay.ts
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
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const NOW = new Date("2026-10-09T18:00:00Z"); // 11am Pacific
const RUN = { name: "Builders who Run, Golden Gate Bridge 4M", url: "https://lu.ma/2i3qsijp", tier: 2, facts: ["date: 2026-10-10", "starts 2026-10-10 09:00", "Golden Gate Bridge"] };
const base: any = {
  id: 201, userId: "u", goal: "Keep your promise: send the Saturday founder run link", theirWords: "yes send it", steps: [{ text: "Send it", done: false }], planNext: "Send it",
  status: "open", wakes: 2, textsSent: 1, createdAt: "2026-10-09T03:00:00Z", deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: true, kind: "work", window: null, notes: [],
  // Co asked a question earlier ("Golden Gate or the Embarcadero one?") and they haven't answered.
  lastTextedAt: "2026-10-09T15:00:00Z", theirReplyAt: null, source: "promise",
};
const mkDeps = (send: (m: string[], o?: { owed: boolean }) => Promise<any>, log: any) => ({
  person: { first_name: "Jordan", phone_number: "+14155550100", city: "San Francisco" }, recent: "", zone: "America/Los_Angeles",
  note: async () => {}, schedule: async (h: number) => { log.scheduled.push(h); return new Date(NOW.getTime() + h * 3_600_000).toISOString(); },
  scheduleAt: async (at: Date) => { log.scheduledAt.push(at.toISOString()); return at.toISOString(); },
  close: async (s: string) => { log.closed.push(s); }, textsToday: async () => 0, markTexted: async () => {}, markFinalTold: async () => {},
  unspendWake: async () => { log.unspent++; },
  send, search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "" }), readPage: async () => ({ ok: true, facts: [], text: "" }),
  now: () => NOW, sentSince: async () => [], onFile: async () => [RUN], rejected: async () => [],
});

// H2: the promised link, after an unanswered question.
{
  const log = { owed: [] as boolean[], scheduled: [] as number[], scheduledAt: [] as string[], closed: [] as string[], unspent: 0 };
  script.push(
    { tool: "tellThem", input: { what: "The Saturday run", links: [RUN.url] } },
    { text: JSON.stringify({ captions: [{ n: 1, caption: "The founder run across the Golden Gate Bridge, Saturday 9am." }], closing: null }) },
    { tool: "finish", input: { status: "done", outcome: "sent the run link" } },
  );
  const r0 = await TT.runTaskTurnWith(base, mkDeps(async (_m, o) => { log.owed.push(!!o?.owed); return { sent: true }; }, log) as any);
  if (process.env.DEBUG_HELD) console.log("H2", JSON.stringify(r0), "left", script.length);
  script.length = 0;
  check("the promised link after an unanswered question goes as owed (never held)", log.owed.length === 1 && log.owed[0] === true, log);
}

// H1: a lookout update held for the unanswered pause.
{
  const hold = new Date(NOW.getTime() + 24 * 3_600_000);
  const log = { owed: [] as boolean[], scheduled: [] as number[], scheduledAt: [] as string[], closed: [] as string[], unspent: 0 };
  script.push(
    { tool: "tellThem", input: { what: "One more founder run this Sunday", links: [RUN.url] } },
    { text: JSON.stringify({ captions: [{ n: 1, caption: "The founder run across the Golden Gate Bridge, Saturday 9am." }], closing: null }) },
    { tool: "scheduleNext", input: { inHours: 1, plan: "try again in an hour" } },
  );
  const r = await TT.runTaskTurnWith({ ...base, id: 202, source: "lookout", goal: "Keep an eye out for founder runs", lastTextedAt: null, textsSent: 0, awaitingReply: false }, mkDeps(async (_m, o) => { log.owed.push(!!o?.owed); return { sent: false, reason: "held: lookout has no reply yet", retryAt: hold }; }, log) as any);
  script.length = 0;
  check("a lookout's update goes as Co-initiated", log.owed[0] === false, log);
  check("the next look moves to the hold, past the hour the turn asked for", log.scheduledAt.includes(hold.toISOString()), log);
  check("the held wake is given back (it doesn't count toward maxWakes)", log.unspent === 1, { log, did: r.did });
}

console.log(`held replay: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
