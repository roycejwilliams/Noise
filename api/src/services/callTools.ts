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

// The subset that makes sense mid-call: quick writes and quick reads. Web research is not here: it is slow and multi-step, so on a
// call it goes to startTask or researchBrief (background work that texts them), never blocking the voice.
export const CALL_TOOL_NAMES = ["startTask", "updateTask", "closeTask", "writeDocument", "offerDocument", "researchBrief", "updateNotes", "updateLoop", "findReaction", "searchEvents"] as const;
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
- A tool that needs their yes needs their own words from what they just said. If they haven't said yes, ask.
- When you've said goodbye and they've had a beat to answer, call end_call.`;

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

export type MemberOnCall = { phone: string; firstName: string | null; city: string | null; tasks: { id: number; goal: string }[]; loops: string | null };

// The member's details the tools need, from the database, by the verified user id only.
export async function loadMemberOnCall(userId: string): Promise<MemberOnCall> {
  const [u, p, t, l] = await Promise.all([
    pool.query(`SELECT phone_number, first_name FROM users WHERE id = $1`, [userId]).then((r) => r.rows[0] ?? null),
    pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]).then((r) => r.rows[0] ?? null).catch(() => null),
    import("./coTasks.js").then((m) => m.openTasks(userId)).catch(() => []),
    pool
      .query(`SELECT * FROM open_loops WHERE user_id = $1 AND closed_at IS NULL AND status NOT IN ('done','dropped') ORDER BY changed_at DESC LIMIT 8`, [userId])
      .then(async (r) => {
        const O = await import("./openLoops.js");
        return O.describeLoops(r.rows.map((x: any) => ({ id: Number(x.id), title: x.title, status: x.status, detail: x.detail, dueDate: x.due_date ? String(x.due_date instanceof Date ? x.due_date.toISOString() : x.due_date).slice(0, 10) : null, source: x.source, lastConfirmedAt: x.last_confirmed_at ? new Date(x.last_confirmed_at) : null, closedAt: null, closedReason: null, decayAskedAt: x.decay_asked_at ? new Date(x.decay_asked_at) : null })), { withIds: true });
      })
      .catch(() => null),
  ]);
  if (!u) throw new Error("no such member");
  return { phone: String(u.phone_number ?? ""), firstName: u.first_name ?? null, city: p?.city ?? null, tasks: t.map((x: any) => ({ id: x.id, goal: x.goal })), loops: l };
}

export function callToolsNote(m: Pick<MemberOnCall, "tasks" | "loops">, didOnCall: string[]): string {
  return [
    CALL_TOOLS_GUIDE,
    m.tasks.length ? `Your open tasks for them (the #N is for updateTask and closeTask, never to say): ${m.tasks.map((t) => `#${t.id} "${t.goal}"`).join("; ")}.` : "You have no open tasks for them yet.",
    m.loops ?? "",
    didOnCall.length ? `Done earlier on this call (already true; don't do it again): ${didOnCall.slice(-8).join(" ")}` : "",
  ].filter(Boolean).join("\n");
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
  return {
    defs,
    names: new Set(Object.keys(picked)),
    note: callToolsNote(i.member, mem.did),
    did,
    run: async (name, input, toolUseId) => {
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
    },
  };
}
