// Review of #140 (fix 2), replayed with the model scripted (zero tokens): while she's away, a look-out Co started holds a text that
// carries an event it found; a promise (an owed delivery, #131) and a look-out she asked for still send it.
//   npx tsx evals/tasks/awayReplay.ts
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
const AWAY = { until: "2026-10-20", quote: "Right now imt raveling", text: "They're away from home (traveling) until 2026-10-20." };
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
  away: AWAY,
});


const turn = async (task: any) => {
  const log = { owed: [] as boolean[], sent: 0, scheduled: [] as number[], scheduledAt: [] as string[], closed: [] as string[], unspent: 0 };
  script.push(
    { tool: "tellThem", input: { what: "The Saturday founder run", links: [RUN.url] } },
    { text: JSON.stringify({ captions: [{ n: 1, caption: "The founder run across the Golden Gate Bridge, Saturday 9am." }], closing: null }) },
    { tool: "scheduleNext", input: { inHours: 48, plan: "look again" } },
  );
  const r = await TT.runTaskTurnWith(task, mkDeps(async (_m, o) => { log.sent++; log.owed.push(!!o?.owed); return { sent: true }; }, log) as any);
  script.length = 0;
  return { log, r };
};
{
  const { log, r } = await turn({ ...base, id: 301, source: "lookout", lookoutOrigin: "co", goal: "Keep an eye out, as promised on a call: rooms in SF", lastTextedAt: null, textsSent: 0, awaitingReply: false });
  check("a Co look-out's event find is held while she's away (nothing sent)", log.sent === 0, { log, did: r.did });
}
{
  const { log } = await turn(base);
  check("a promise (owed delivery) still goes while she's away", log.sent === 1 && log.owed[0] === true, log);
}
{
  const { log } = await turn({ ...base, id: 302, source: "lookout", lookoutOrigin: "member", goal: "Let me know when a founder run comes up", lastTextedAt: null, textsSent: 0, awaitingReply: false });
  check("a look-out she asked for still goes while she's away", log.sent === 1, log);
}

console.log(`away replay: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
