// Co's own tools on a phone call (2026-10-08 call review: on a call Co had only ElevenLabs' tools, so 12 model requests made zero
// tool calls and Co could only promise "I'll set up a task when we hang up").
// The call brain's endpoint (services/callLlmProxy.ts) runs these on the server mid-turn: the model says a short line, calls a tool,
// the result is fed back and the reply keeps streaming. ElevenLabs only ever sees the text and its own system tools (end_call, etc.).
// These are the texting tools themselves (agent/conversationTools.ts + agent/loopTools.ts), built for the call's member and wrapped by
// the same guard (agent/toolGuard.ts): ability switches, per-turn and per-day limits, the member's own yes where the registry
// (services/capabilities.ts) asks for one, receipts, the decision log and Co's action record (co_facts). No parallel copies.
// Member scope: the member is the call's verified user (routes/callLlm.ts checks the call token); no tool takes a user id, and the
// model's input is parsed by each tool's schema, so a stray field is dropped.
import { z } from "zod";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { createConversationTools } from "../agent/conversationTools.js";
import { guardTools } from "../agent/toolGuard.js";
import type { CallToolset as BaseToolset } from "./callLlmProxy.js";
import { mentionsIn } from "./offerGuard.js";

// The subset that makes sense mid-call: quick writes and quick reads. Web research is not here: it is slow and multi-step, so on a
// call it goes to startTask or researchBrief (background work that texts them), never blocking the voice.
// steerAwayFrom and noteRoomTaste (2026-10-11, the call-memory gap): "stop sending me crypto stuff" or "I want rooms where I can drop
// my guard", said on a call, was lost; nothing on the call path or after it wrote the stop-suggesting list or stated taste.
export const CALL_TOOL_NAMES = ["startTask", "updateTask", "closeTask", "writeDocument", "offerDocument", "researchBrief", "updateNotes", "updateLoop", "findReaction", "searchEvents", "steerAwayFrom", "noteRoomTaste"] as const;
export type CallToolName = (typeof CALL_TOOL_NAMES)[number];

// The turn's bounds (steps, time) are in services/callLlmProxy.ts, where the rounds run.
export type AnthropicTool = { name: string; description: string; input_schema: unknown };
export type CallToolset = BaseToolset & {
  defs: AnthropicTool[];
  // What the tools did this turn, in Co's own receipt lines.
  did: string[];
};

export const CALL_TOOLS_GUIDE = `# Doing things on this call
You can act during the call with your tools, and the result is real. Whenever you'd say you'll do something for them after the call (look for something, put a doc together, follow up, research venues), set it in motion now with the tool, in this same turn: startTask is what makes "I'll look after we hang up" true, writeDocument sends the doc, researchBrief starts the venue research. A promise with no tool behind it is forgotten when the call ends. This outranks any line above about waiting until after the call: the work still happens after the call, but you start it now.
- The order: one short line so they aren't waiting in silence ("On it."), then the tool, then one line on what happened, from what the result says and nothing more. If it comes back not done with something to fix, fix it and call it once more without talking them through it; if it still isn't done, say in one plain line that it didn't go through and what you'll do instead. Any question you have for them comes last, after the result, never before the tool: they can't answer while you're still talking.
- Doing it now replaces the promise: don't also say you'll do it after the call. The call carries on after a tool; say goodbye only when they do.
- Anything that needs real looking (web research, comparing options, finding venues) goes to startTask or researchBrief: they work after the call and text them what comes of it. Don't search the web on the call.
- Documents and briefs arrive by text, not on the call: say they'll be in their texts.
- When they tell you something that belongs to one of your open tasks (a name, a date, a place, a number, a constraint, a change of plan), write it on that task with updateTask in this same turn, in their words. Saying it back ("got it") writes nothing down, and only what's written is there when the work happens after the call. Something about them rather than a task goes in updateNotes.
- If you don't know a name, a place or a number, say you're not sure. Never guess one, and never promise work they didn't ask for.
- A tool that needs their yes needs their own words from what they just said. If they haven't said yes, ask.
- After your goodbye, when they answer it ("you too", "bye"), call end_call and say nothing more: never a second goodbye.`;

// Per call: what the tools did earlier on this call, so a later turn knows (ElevenLabs' history carries only what was said).
// Keyed by the call's token; an hour is longer than any call.
const CALL_MEMORY_MS = 60 * 60_000;
const callMemory = new Map<string, { at: number; did: string[] }>();
function memoryFor(key: string): { at: number; did: string[] } {
  const now = Date.now();
  for (const [k, v] of callMemory) if (now - v.at > CALL_MEMORY_MS) callMemory.delete(k);
  let m = callMemory.get(key);
  if (!m) { m = { at: now, did: [] }; callMemory.set(key, m); }
  m.at = now;
  return m;
}
export function _resetCallMemoryForTest(): void { callMemory.clear(); }

// avoid: the kinds they've asked Co to stop suggesting, read fresh after a tool acts, so a "no more X" said mid-call (or by text during
// it) holds for the rest of the call without touching the cached prompt (callTools turnNote, past the cache breakpoint).
export type MemberOnCall = { phone: string; firstName: string | null; city: string | null; tasks: { id: number; goal: string }[]; loops: string | null; avoid?: string[] };

// Pure: the open tasks (with their ids, for updateTask and closeTask) from the layer's one carrying builder: each open co_task is
// there once, with its "task #N" ref.
export function tasksFromCarrying(carrying: { ref: string | null; what: string }[]): { id: number; goal: string }[] {
  return carrying.flatMap((c) => {
    const id = Number(c.ref?.match(/^task #(\d+)$/)?.[1]);
    return Number.isFinite(id) && id > 0 ? [{ id, goal: c.what }] : [];
  });
}

// The member's details the tools need, by the verified user id only. Their city and open tasks come from the one member-knowledge
// layer (services/memberKnowledge.ts, member-stripped inside); their phone and the loop list (describeLoops, with the
// "not confirmed lately" read the layer doesn't keep, and the [loop N] ids updateLoop takes) are read here.
export async function loadMemberOnCall(userId: string): Promise<MemberOnCall> {
  const [u, k, l, lim] = await Promise.all([
    pool.query(`SELECT phone_number, first_name FROM users WHERE id = $1`, [userId]).then((r) => r.rows[0] ?? null),
    // Fails closed: a layer that can't be read (it throws when the names to strip can't be read) gives no tasks, never unstripped ones.
    import("./memberKnowledge.js").then((m) => m.memberKnowledge(userId, { include: ["carrying"] })).catch(() => null),
    pool
      .query(`SELECT * FROM open_loops WHERE user_id = $1 AND closed_at IS NULL AND status NOT IN ('done','dropped') ORDER BY changed_at DESC LIMIT 8`, [userId])
      .then(async (r) => {
        const O = await import("./openLoops.js");
        return O.describeLoops(r.rows.map((x: any) => ({ id: Number(x.id), title: x.title, status: x.status, detail: x.detail, dueDate: x.due_date ? String(x.due_date instanceof Date ? x.due_date.toISOString() : x.due_date).slice(0, 10) : null, source: x.source, lastConfirmedAt: x.last_confirmed_at ? new Date(x.last_confirmed_at) : null, closedAt: null, closedReason: null, decayAskedAt: x.decay_asked_at ? new Date(x.decay_asked_at) : null })), { withIds: true, zone: await (await import("./memberTime.js")).memberZone(userId) });
      })
      .catch(() => null),
    // The record's one reader for the stop-suggesting list (services/memberKnowledge.ts limits): the member's own words, nobody else's.
    import("./memberKnowledge.js").then((m) => m.realKnowledgeDeps.limits(userId)).catch(() => null),
  ]);
  if (!u) throw new Error("no such member");
  // Another member's details stripped before they become spoken sources (2026-10-09 audit: the call path's own context strips
  // these loops; the tools' copy didn't). Fails closed: no strip, no loops or task goals.
  const safe = await import("./memberSafeMemories.js").then((m) => m.memberSafeLine(userId)).catch(() => null);
  const t = k ? tasksFromCarrying(k.carrying) : [];
  const tasks = t.map((x: any) => ({ id: x.id, goal: safe ? safe(String(x.goal ?? "")) : null })).filter((x: any): x is { id: number; goal: string } => !!x.goal);
  const loops = l && safe ? l.split("\n").map((line: string) => safe(line)).filter((x: string | null): x is string => !!x).join("\n") || null : null;
  return { phone: String(u.phone_number ?? ""), firstName: u.first_name ?? null, city: k?.identity.city ?? null, tasks, loops, avoid: lim?.avoid ?? [] };
}

// Pure: the stop-suggesting list as it stands right now, for this turn only (after the cache breakpoint, so the call's cached prefix is
// untouched). The call's opening context has it too; this keeps it current when it changes during the call.
export function avoidNote(avoid: string[] | undefined): string | null {
  return avoid?.length ? `(Right now they've asked you never to suggest: ${avoid.map((a) => `"${a}"`).join(", ")}.)` : null;
}

export function callToolsNote(m: Pick<MemberOnCall, "tasks" | "loops">, didOnCall: string[]): string {
  return [CALL_TOOLS_GUIDE, callRecords(m, didOnCall)].join("\n");
}

// Co's records for the member, without the guide: what a spoken line may stand on (callLlmProxy.ts callSources).
export function callRecords(m: Pick<MemberOnCall, "tasks" | "loops">, didOnCall: string[]): string {
  return [
    m.tasks.length ? `Your open tasks for them (the #N is for updateTask and closeTask, never to say): ${m.tasks.map((t) => `#${t.id} "${t.goal}"`).join("; ")}.` : "You have no open tasks for them yet.",
    m.loops ?? "",
    didOnCall.length ? `Done earlier on this call (already true; don't do it again): ${didOnCall.slice(-8).join(" ")}` : "",
  ].filter(Boolean).join("\n");
}

// ---------- A fact they gave on the call, written down (2026-10-08 live call: "the studio is called Ellis Works and the date's
// not locked yet", Co said "Got it, Ellis Works" and called no tool, so the open task never learned the name).
// Co decides: the guide above says to write it on the task, and this turn's note (below) says it again when their words carry a
// specific and a task is open. Code guards the fact, not the intent: when Co said the specific back but no tool wrote anything, their
// own words go on the task through the same guarded updateTask (afterTurn). Never Co's words, never a guess at what they meant.
const normWords = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
const MONTH_OR_DAY = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const WRITES = new Set(["updateTask", "updateNotes", "startTask", "closeTask", "updateLoop"]);
const TOPIC_PLAIN = new Set("that this those these with what when where which there their they them your from have just also about into over then than been were will would could should called named date dates time open locked keep side note thing things anything something".split(" "));

// Pure: the names and numbers in their words (each sentence's own first word is only a capital, so sentences are read apart).
export function specificsTheyGave(turnWords: string): string[] {
  const out = new Set<string>();
  for (const s of turnWords.split(/(?<=[.!?])\s+/)) for (const m of mentionsIn(s)) if (m.kind === "name" || m.kind === "time") out.add(m.text);
  for (const m of turnWords.match(/\$?\d[\d,.]*(?:\s?(?:k|%|people|guests|pm|am))?/gi) ?? []) out.add(m.replace(/[.,]$/, ""));
  return [...out].filter((x) => x.length >= 2);
}

// Pure: this turn's note, after their words. Only when a task is open and their words carry a name, number or date.
export function taskFactNote(turnWords: string, tasks: { id: number; goal: string }[]): string | null {
  if (!tasks.length) return null;
  const given = specificsTheyGave(turnWords);
  if (!given.length && !MONTH_OR_DAY.test(turnWords)) return null;
  const what = given.length ? given.map((g) => `"${g}"`).join(", ") : "a date";
  return `(A note from Co's own records, not their words: they just gave you ${what}. If that belongs to one of your open tasks, write it on that task with updateTask in this turn, in their words, then answer. Saying it back doesn't write it down.)`;
}

// Pure: the task their words belong to, or null. The only open task, or the one whose goal shares a word with what they said.
export function taskFor(turnWords: string, tasks: { id: number; goal: string }[]): { id: number; goal: string } | null {
  if (tasks.length === 1) return tasks[0];
  const theirs = new Set(normWords(turnWords).trim().split(" ").filter((w) => w.length >= 4 && !TOPIC_PLAIN.has(w)));
  const hits = tasks.filter((t) => normWords(t.goal).trim().split(" ").some((w) => theirs.has(w)));
  return hits.length === 1 ? hits[0] : null;
}

// Pure: the backstop's write, or null. Their words carry a specific the task doesn't have yet, Co said that specific back this turn
// (so it took it as part of the work), and none of Co's writing tools ran. The note is their own words, nothing else.
export function taskFactBackstop(t: { turnWords: string; spoken: string[]; ran: string[]; tasks: { id: number; goal: string }[] }): { taskId: number; note: string; specifics: string[] } | null {
  if (t.ran.some((n) => WRITES.has(n))) return null;
  const task = taskFor(t.turnWords, t.tasks);
  if (!task) return null;
  const said = normWords(t.spoken.join(" "));
  const goal = normWords(task.goal);
  const echoed = specificsTheyGave(t.turnWords).filter((g) => { const n = normWords(g.replace(/['’]s$/i, "")); return n.trim().length >= 2 && said.includes(n) && !goal.includes(n); });
  if (!echoed.length) return null;
  return { taskId: task.id, note: `On the call they said: "${t.turnWords.trim().slice(0, 260)}"`, specifics: echoed };
}

export type CallToolsInput = {
  userId: string;
  // Identifies this call (its token): what the tools did is remembered across the call's turns.
  callKey: string;
  // What the member said this turn (their yes must be in it) and everything they said on the call (what a document may rest on).
  turnWords: string;
  callWords: string;
  // Co's last line before this turn, so "yes" to an offer is read as that.
  lastCoLine: string | null;
  member: MemberOnCall;
  dryRun?: boolean;
  stubSearch?: boolean;
  // Tests: raw tools in place of the real ones, wrapped by the same guard.
  tools?: Record<string, any>;
};

// Pure enough to test: the call's toolset for one turn, from the texting tools, guarded the same way.
export function buildCallTools(i: CallToolsInput): CallToolset {
  const mem = memoryFor(i.callKey);
  const did: string[] = [];
  const all: Record<string, any> = i.tools ? guardTools(i.tools, { userId: i.userId, resolvedContent: i.turnWords, dryRun: !!i.dryRun, notDone: () => {} }) : createConversationTools({
    turnStartedAt: Date.now(),
    userId: i.userId,
    phoneNumber: i.member.phone,
    resolvedContent: i.turnWords,
    isVoice: true,
    hasPendingOffer: false,
    recentOfferBurstActive: false,
    dryRun: !!i.dryRun,
    stubSearch: !!i.stubSearch,
    // A call has no text thread to post into mid-call: a tool's "looking" line or reply is not sent (documents and briefs still
    // go by their own delivery). Returning false means "not sent", and the tool says so.
    sendCoReply: async () => false,
    firstName: i.member.firstName,
    lastCoMessage: i.lastCoLine,
    // What a tool reads about the turn: the whole call's words (a document rests on what they said on the call), their city.
    // Their open tasks too, so updateTask and closeTask are offered only when there is one (capabilities.ts situations).
    turn: { userId: i.userId, message: i.callWords, profile: { city: i.member.city }, tasks: i.member.tasks.map((t) => `#${t.id} ${t.goal}`) } as any,
    facts: {
      add: (kind, text) => { if (kind === "did_this_turn") { did.push(text); mem.did.push(text); } },
      text: () => did.join("\n"),
    },
  }).tools;
  const picked: Record<string, any> = {};
  for (const n of CALL_TOOL_NAMES) if (all[n]) picked[n] = all[n];
  const defs: AnthropicTool[] = Object.entries(picked).map(([name, t]) => {
    const schema: any = t.inputSchema && typeof t.inputSchema.safeParse === "function" ? z.toJSONSchema(t.inputSchema) : { type: "object", properties: {} };
    delete schema.$schema;
    return { name, description: String(t.description ?? ""), input_schema: schema };
  });
  const run: CallToolset["run"] = async (name, input, toolUseId) => {
    const t = picked[name];
    if (!t) return { ok: false, error: `No tool named ${name} on a call.` };
    const parsed = t.inputSchema && typeof t.inputSchema.safeParse === "function" ? t.inputSchema.safeParse(input ?? {}) : { success: true, data: input ?? {} };
    if (!parsed.success) return { ok: false, error: `The input didn't fit: ${parsed.error.issues.slice(0, 3).map((x: any) => `${x.path.join(".")}: ${x.message}`).join("; ")}. Fix it and try once more, or say plainly it wasn't done.` };
    const t0 = Date.now();
    let result: any;
    try { result = await t.execute(parsed.data, { toolCallId: toolUseId, messages: [] }); }
    catch (err: any) { result = { ok: false, error: `It failed: ${String(err?.message ?? err).slice(0, 160)}. Say plainly it wasn't done.` }; }
    if (!i.dryRun) recordDecision({ layer: 8, decision: "call.tool", userId: i.userId, outcome: result?.ok === false ? "skip" : "act", action: name, proposal: { ms: Date.now() - t0, turn: i.turnWords.slice(0, 200) }, reason: String(result?.error ?? "").slice(0, 200) }).catch(() => {});
    return result;
  };
  return {
    defs,
    names: new Set(Object.keys(picked)),
    note: callToolsNote(i.member, mem.did),
    records: callRecords(i.member, mem.did),
    turnNote: [picked.updateTask ? taskFactNote(i.turnWords, i.member.tasks) : null, avoidNote(i.member.avoid)].filter(Boolean).join("\n") || null,
    did,
    run,
    // The backstop: a specific they gave and Co said back, with nothing written, goes on the task in their own words, through the
    // same guarded updateTask (limits, receipt, decision log, Co's action record).
    afterTurn: async ({ spoken, ran }) => {
      if (!picked.updateTask) return;
      const w = taskFactBackstop({ turnWords: i.turnWords, spoken, ran, tasks: i.member.tasks });
      if (!w) return;
      const r: any = await run("updateTask", { taskId: w.taskId, note: w.note, why: `They gave ${w.specifics.join(", ")} on the call and Co said it back without writing it down.` }, `backstop_${Date.now().toString(36)}`);
      if (!i.dryRun) recordDecision({ layer: 8, decision: "call.task_fact_backstop", userId: i.userId, outcome: r?.ok === false ? "skip" : "act", action: "updateTask", proposal: { taskId: w.taskId, specifics: w.specifics }, reason: String(r?.error ?? "").slice(0, 200) }).catch(() => {});
    },
  };
}
