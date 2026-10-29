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
import { specificsTheyGave } from "../brain/index.js";
// What a call turn is told (the stop list, a fact to write down) is the brain's (brain/index.ts judgeCallTurn); kept here for callers.
export { avoidNote, specificsTheyGave, taskFactNote } from "../brain/index.js";
import { callToolNames } from "./capabilities.js";

// The subset that makes sense mid-call: quick writes and quick reads. Web research is not here: it is slow and multi-step, so on a
// call it goes to startTask or researchBrief (background work that texts them), never blocking the voice.
// steerAwayFrom and noteRoomTaste (2026-10-11, the call-memory gap): "stop sending me crypto stuff" or "I want rooms where I can drop
// my guard", said on a call, was lost; nothing on the call path or after it wrote the stop-suggesting list or stated taste.
// Decks (PR 6, 2026-10-11): a member can ask for a deck and change it during a call, by the same rules as text: the link goes to their
// texts, the one taste question is asked out loud, edits keep the link, and their own board, images and shares work the same. On a
// call Co passes a brief (makeDeck) or the change (updateDeck), never the slides: the deck is written from what they said
// (services/deckCompose.ts) while the call carries on, so the caller isn't kept in silence while a whole deck is written.
// openArtifact isn't on a call: updateDeck with the change reads the deck itself, and opening first used up the turn's time
// (live run: the change was never made, and Co promised it anyway).
// Tools that may outlast a call turn's wait, and how long to wait before carrying them on in the background.
const LONG_ON_CALL = new Set(["makeDeck", "updateDeck", "makePage", "updatePage"]);
const LONG_ON_CALL_WAIT_MS = 3500;
const STILL_GOING = Symbol("still going");
const BACKGROUND_FAIL_TEXT_MS = 3 * 60 * 1000;
// The call subset is the registry's onCall entries (services/capabilities.ts), the same entries the call briefing's list is
// written from (services/callBriefing.ts), so what a call can do and what it's told it can do are one list.
import { VOICE_READ_OFF_ON_CALL_NOTE } from "./voiceReadConsent.js";
export const CALL_TOOL_NAMES: readonly string[] = callToolNames();
export type CallToolName = string;

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
- A page or deck you make or change on the call goes to their texts as its link: say it's in their texts and don't read it out. For a deck on a call, pass makeDeck a brief (what they want, in their words) and never write the slides yourself; for a change, pass updateDeck the change and never the slides. If a deck needs their taste first, ask the one question out loud (the look they like, a Pinterest board, or one of your looks by name). A change keeps the same link.
- When they tell you something that belongs to one of your open tasks (a name, a date, a place, a number, a constraint, a change of plan), write it on that task with updateTask in this same turn, in their words. Saying it back ("got it") writes nothing down, and only what's written is there when the work happens after the call. Something about them rather than a task goes in updateNotes.
- If you don't know a name, a place or a number, say you're not sure. Never guess one, and never promise work they didn't ask for.
- A tool that needs their yes needs their own words from what they just said. If they haven't said yes, ask.
- After your goodbye, when they answer it ("you too", "bye"), call end_call and say nothing more: never a second goodbye.`;

// Per call: what the tools did earlier on this call, so a later turn knows (ElevenLabs' history carries only what was said).
// Keyed by the call's token; an hour is longer than any call.
const CALL_MEMORY_MS = 60 * 60_000;

// okAt: when a page or a deck (by kind) last went through on this call; failTextSent: the one honest text already went.
// voiceReadOff: they said stop (or no) to the voice read on this call: every later turn drops its lines and carries the note.
type CallMem = { at: number; did: string[]; okAt?: Record<string, number>; failTextSent?: boolean; voiceReadOff?: boolean };
const callMemory = new Map<string, CallMem>();
function memoryFor(key: string): CallMem {
  const now = Date.now();
  for (const [k, v] of callMemory) if (now - v.at > CALL_MEMORY_MS) callMemory.delete(k);
  let m = callMemory.get(key);
  if (!m) { m = { at: now, did: [] }; callMemory.set(key, m); }
  m.at = now;
  return m;
}
export function _resetCallMemoryForTest(): void { callMemory.clear(); }
// Whether they turned the voice read off earlier on this call (routes/callLlm.ts strips its lines from the call's messages).
export function callVoiceReadOff(callKey: string): boolean {
  return !!callMemory.get(callKey)?.voiceReadOff;
}

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
        // Through the removals first (services/whatCoKnows.ts guardText), as the call's own context reads them (personModel.ts): a
        // loop whose title says something they had Cue forget isn't a spoken source; its detail loses that part.
        const W = await import("./whatCoKnows.js");
        const removed = r.rows.length ? (await W.forgottenRows(userId).catch(() => [])).filter((g) => g.removed) : [];
        const loopRows = removed.length ? r.rows.flatMap((x: any) => { const title = W.guardText(String(x.title ?? ""), removed); return title === null ? [] : [{ ...x, title, detail: x.detail ? W.guardText(String(x.detail), removed) : x.detail }]; }) : r.rows;
        return O.describeLoops(loopRows.map((x: any) => ({ id: Number(x.id), title: x.title, status: x.status, detail: x.detail, dueDate: x.due_date ? String(x.due_date instanceof Date ? x.due_date.toISOString() : x.due_date).slice(0, 10) : null, source: x.source, lastConfirmedAt: x.last_confirmed_at ? new Date(x.last_confirmed_at) : null, closedAt: null, closedReason: null, decayAskedAt: x.decay_asked_at ? new Date(x.decay_asked_at) : null })), { withIds: true, zone: await (await import("./memberTime.js")).memberZone(userId) });
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
  // A failed read leaves avoid undefined, so the caller keeps the last good list (routes/callLlm.ts memberOnCall), never an empty one.
  return { phone: String(u.phone_number ?? ""), firstName: u.first_name ?? null, city: k?.identity.city ?? null, tasks, loops, avoid: lim ? lim.avoid : undefined };
}

export function callToolsNote(m: Pick<MemberOnCall, "tasks" | "loops">, didOnCall: string[], o: { voiceReadOff?: boolean } = {}): string {
  return [CALL_TOOLS_GUIDE, callRecords(m, didOnCall), o.voiceReadOff ? VOICE_READ_OFF_ON_CALL_NOTE : ""].filter(Boolean).join("\n");
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
const WRITES = new Set(["updateTask", "updateNotes", "startTask", "closeTask", "updateLoop"]);
const TOPIC_PLAIN = new Set("that this those these with what when where which there their they them your from have just also about into over then than been were will would could should called named date dates time open locked keep side note thing things anything something".split(" "));

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
  // The call's last few turns before this one (services/theirYes.ts exchangeText): what a yes on the call answers.
  recentExchange?: string | null;
  member: MemberOnCall;
  dryRun?: boolean;
  stubSearch?: boolean;
  // Tests: raw tools in place of the real ones, wrapped by the same guard.
  tools?: Record<string, any>;
};

// Pure enough to test: the call's toolset for one turn, from the texting tools, guarded the same way.
export function buildCallTools(i: CallToolsInput): CallToolset {
  const mem = memoryFor(i.callKey);
  // A text to them during the call, from Co's number (a page's or deck's link, or a background tool's honest "it didn't come
  // together"), logged like any text. A test member's texts are logged, never sent (services/sendblue.ts).
  const textThem = async (text: string): Promise<boolean> => {
    const from = process.env.SENDBLUE_PHONE_NUMBER;
    if (!from || !i.member.phone) return false;
    const sendblue = (await import("./sendblue.js")).default;
    const ok = await sendblue.messages
      .send({ number: i.member.phone, content: text, from_number: from } as any)
      .then(() => true)
      .catch(() => false);
    // A page's or deck's own texts (its link, its "Updated the …:" line) are logged by the tool that sent them (agent/loopTools.ts).
    if (ok && !/\/d\//.test(text) && !/^Updated the (deck|page): /.test(text)) await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`, [i.userId, `Co replied: ${text}`]).catch(() => {});
    return ok;
  };
  const did: string[] = [];
  const all: Record<string, any> = i.tools ? guardTools(i.tools, { userId: i.userId, resolvedContent: i.turnWords, dryRun: !!i.dryRun, notDone: () => {}, recentExchange: i.recentExchange ?? (i.lastCoLine ? `Cue: ${i.lastCoLine}` : null) }) : createConversationTools({
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
    onCall: true,
    // A page's or deck's link (agent/loopTools.ts say) goes to their texts mid-call, from Co's number, logged like any text (PR 6).
    sendLinkText: i.dryRun ? undefined : textThem,
    firstName: i.member.firstName,
    lastCoMessage: i.lastCoLine,
    recentExchange: i.recentExchange ?? null,
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
  // On a call a deck is never written into the tool's input (PR 6: told to pass a brief, the model still wrote every slide, and the
  // caller sat through 30 seconds of silence): makeDeck takes a brief, updateDeck the change, and the slides are written after.
  for (const n of ["makeDeck", "updateDeck"]) {
    const t = picked[n];
    if (t?.inputSchema && typeof t.inputSchema.omit === "function") picked[n] = { ...t, inputSchema: t.inputSchema.omit({ title: true, subtitle: true, slides: true }) };
  }
  // No answer rides in a link's text on a call (review of PR 6: it would reach their texts without the reply's fact check, which a
  // call doesn't run); the answer is spoken.
  for (const n of ["makePage", "updatePage", "makeDeck", "updateDeck", "shareArtifact", "resetLink"]) {
    const t = picked[n];
    if (t?.inputSchema?.shape?.alsoAnswer && typeof t.inputSchema.omit === "function") picked[n] = { ...t, inputSchema: t.inputSchema.omit({ alsoAnswer: true }) };
  }
  if (picked.makeDeck?.inputSchema?.shape?.brief)
    picked.makeDeck = {
      ...picked.makeDeck,
      inputSchema: picked.makeDeck.inputSchema.extend({
        brief: z.string().describe("What deck they want, in their words: what it's for and what it should cover."),
        line: z.string().nullable().optional().describe("The one line in the text that carries the link, read in their texts (\"Here's the Northlight pitch deck.\"); never \"in your texts\". Plain words."),
      }),
    };
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
    // Making or changing a page or deck on a call (PR 6) can take longer than a call turn may wait (the claim check, saving, texting
    // the link). Past a few seconds it carries on in the background: Co says it'll be in their texts, the link arrives when it's
    // ready, and if it doesn't come together they get one honest text saying so, never silence.
    const work = (async () => t.execute(parsed.data, { toolCallId: toolUseId, messages: [] }))().catch((err: any) => ({ ok: false, error: `It failed: ${String(err?.message ?? err).slice(0, 160)}. Say plainly it wasn't done.` }));
    if (LONG_ON_CALL.has(name) && !i.dryRun) {
      const quick = await Promise.race([work, new Promise((r) => setTimeout(() => r(STILL_GOING), LONG_ON_CALL_WAIT_MS))]);
      if (quick === STILL_GOING) {
        const startedAt = Date.now();
        const what = name.endsWith("Deck") ? "deck" : "page";
        // The next turn must know it's on its way (review of PR 6: unseen, "and add our pricing" made a second deck).
        const making = `A ${what} they asked for is being made right now and will arrive in their texts in a minute or two. Don't make it again; a change to it waits until it has arrived.`;
        mem.did.push(making);
        // Once it's done, either way, that note gives way to what happened (review of PR 6).
        const settled = (line: string | null) => {
          const k = mem.did.indexOf(making);
          if (k >= 0) mem.did.splice(k, 1, ...(line ? [line] : []));
          else if (line) mem.did.push(line);
        };
        work
          .then(async (r: any) => {
            if (r?.ok !== false) {
              mem.okAt = { ...(mem.okAt ?? {}), [what]: Date.now() };
              settled(`The ${what} they asked for on this call is done and in their texts.`);
              return;
            }
            // Not made (a line it couldn't back, say): the next turn of this call learns why and makes it again, as a text turn
            // would. Only if no other one of the same kind goes through in the next few minutes do they get one honest text, once.
            settled(`The ${what} you started on this call didn't go through and isn't in their texts: ${String(r?.error ?? "").replace(/\s+/g, " ").slice(0, 300)} Make it again now from only what they said.`);
            await recordDecision({ layer: 3, decision: "call.background_tool", userId: i.userId, outcome: "skip", action: "failed", proposal: { tool: name, error: String(r?.error ?? "").slice(0, 200) } }).catch(() => {});
            setTimeout(() => {
              if ((mem.okAt?.[what] ?? 0) > startedAt || mem.failTextSent) return;
              mem.failTextSent = true;
              textThem(`I couldn't finish the ${what} we talked about. Text me what you'd like on it and I'll make it here.`).catch(() => false);
            }, BACKGROUND_FAIL_TEXT_MS).unref?.();
          })
          .catch(() => {});
        result = { ok: true, pending: true, note: `Still being made: the link goes to their texts in a moment. Say it'll be in their texts; don't say it's done or describe it.` };
      } else {
        result = quick;
        if ((quick as any)?.ok !== false) mem.okAt = { ...(mem.okAt ?? {}), [name.endsWith("Deck") ? "deck" : "page"]: Date.now() };
      }
    } else result = await work;
    // A stop or a no to the voice read on this call: from now on the call drops its lines and every turn's note says so.
    if (name === "voiceRead" && result?.ok !== false && ((parsed.data as any)?.answer === "stop" || (parsed.data as any)?.answer === "no")) mem.voiceReadOff = true;
    if (!i.dryRun) recordDecision({ layer: 8, decision: "call.tool", userId: i.userId, outcome: result?.ok === false ? "skip" : "act", action: name, proposal: { ms: Date.now() - t0, turn: i.turnWords.slice(0, 200) }, reason: String(result?.error ?? "").slice(0, 200) }).catch(() => {});
    return result;
  };
  return {
    defs,
    names: new Set(Object.keys(picked)),
    note: callToolsNote(i.member, mem.did, { voiceReadOff: mem.voiceReadOff }),
    records: callRecords(i.member, mem.did),
    // This turn's facts; the brain writes the turn's note from them (brain/index.ts judgeCallTurn).
    turnFacts: { turnWords: i.turnWords, tasks: i.member.tasks, avoid: i.member.avoid, canWriteTasks: !!picked.updateTask },
    did,
    run,
    // The backstop: a specific they gave and Co said back, with nothing written, goes on the task in their own words, through the
    // same guarded updateTask (limits, receipt, decision log, Co's action record).
    afterTurn: async ({ spoken, ran }) => {
      if (!picked.updateTask) return;
      const w = taskFactBackstop({ turnWords: i.turnWords, spoken, ran, tasks: i.member.tasks });
      if (!w) return;
      const r: any = await run("updateTask", { taskId: w.taskId, note: w.note, why: `They gave ${w.specifics.join(", ")} on the call and Cue said it back without writing it down.` }, `backstop_${Date.now().toString(36)}`);
      if (!i.dryRun) recordDecision({ layer: 8, decision: "call.task_fact_backstop", userId: i.userId, outcome: r?.ok === false ? "skip" : "act", action: "updateTask", proposal: { taskId: w.taskId, specifics: w.specifics }, reason: String(r?.error ?? "").slice(0, 200) }).catch(() => {});
    },
  };
}
