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
import { dispatchKeyFor } from "./coTasks.js";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { createConversationTools } from "../agent/conversationTools.js";
import { guardTools } from "../agent/toolGuard.js";
import type { CallToolset as BaseToolset } from "./callLlmProxy.js";
import { specificsTheyGave } from "../brain/index.js";
// What a call turn is told (the stop list, a fact to write down) is the brain's (brain/index.ts judgeCallTurn); kept here for callers.
export { avoidNote, specificsTheyGave, taskFactNote } from "../brain/index.js";
import { callRunFor, callToolNames, startsWork, toolUse, type CallRun } from "./capabilities.js";

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
// What runs during the call and what waits for after it is the registry's allow-list (services/capabilities.ts CALL_RUN): "now" tools
// run inside the turn with a tight timeout of their own; "after" tools (a page, a deck, a document) are started and carried on in
// the background past a short wait, the link texted when ready, and if one doesn't come together they get one honest text, never
// silence. Past its timeout a "now" tool keeps going on its own (its write lands); a send that didn't come back is owed right after
// the call (services/callLedger.ts, services/callFollowThrough.ts).
const STILL_GOING = Symbol("still going");
// The work's result, or STILL_GOING once ms have passed (the work keeps going either way).
function within<T>(work: Promise<T>, ms: number): Promise<T | typeof STILL_GOING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof STILL_GOING>((r) => { timer = setTimeout(() => r(STILL_GOING), ms); });
  return Promise.race([work, late]).finally(() => { if (timer) clearTimeout(timer); });
}
const BACKGROUND_FAIL_TEXT_MS = 3 * 60 * 1000;
// A start tool run again on the same call this soon after it came back done is a retry of it (a re-sent delegation), not a new ask.
export const START_RETRY_MS = 20_000;
// What a start is for: its goal (startTask) or what's looked for (researchBrief, saveAsk).
const needOf = (input: unknown): string => { const d = (input ?? {}) as { goal?: unknown; what?: unknown }; return String(d.goal ?? d.what ?? "").trim(); };
const NEED_PLAIN = new Set("find look looking search some more options option please launch party event thing things help".split(" "));
const needWords = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).map((w) => w.replace(/(?<=\w{3})s$/, "")).filter((w) => w.length >= 4 && !NEED_PLAIN.has(w)));
// Pure: two starts are the same need: the same need key (coTasks.ts dispatchKeyFor), or their goal words mostly the same (at least
// two shared content words, and most of the shorter one's). One shared word is never enough: "Find caterers" / "caterers and a band"
// share only "caterer", and folding them lost the band (review of #365). "Find vegan caterers in Oakland" / "Vegan caterer options in
// Oakland": the same; "Find caterers" / "And a florist": never. A one-word need retried in other words is the open-task check's
// (coTasks.ts dispatchKeyFor's note), not this one's.
export const SAME_NEED_MIN_SHARED = 2;
export function sameNeed(a: string, b: string, callKey: string): boolean {
  if (!a || !b) return false;
  if (dispatchKeyFor(callKey, a) === dispatchKeyFor(callKey, b)) return true;
  const x = needWords(a), y = needWords(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= SAME_NEED_MIN_SHARED && shared / Math.max(1, Math.min(x.size, y.size)) >= 0.6;
}
// The call subset is the registry's onCall entries on the allow-list (services/capabilities.ts), the same entries the call
// briefing's list is written from (services/callBriefing.ts), so what a call can do and what it's told it can do are one list.
import { VOICE_READ_OFF_ON_CALL_NOTE } from "./voiceReadConsent.js";
export const CALL_TOOL_NAMES: readonly string[] = callToolNames();

// The turn's bounds (steps, time) are in services/callLlmProxy.ts, where the rounds run.
export type AnthropicTool = { name: string; description: string; input_schema: unknown };
export type CallToolset = BaseToolset & {
  defs: AnthropicTool[];
  // What the tools did this turn, in Co's own receipt lines.
  did: string[];
};

export const CALL_TOOLS_GUIDE = `# Doing things on this call
You can act during the call with your tools, and the result is real. Some things happen right now, while you talk: texting them a link to something you already have on file (shareLink), saving what they want found or what they think of something, starting a task or a search that runs after the call, and keeping their notes, tasks and preferences current. A page, a deck or a document is started from the call but made after it, and arrives in their texts. Introductions, anything that needs another member's yes, and anything that costs money never happen on a call: say you'll pick it up by text.
Whenever you'd say you'll do something for them after the call (look for something, put a doc together, follow up, research venues), set it in motion now with the tool, in this same turn: startTask is what makes looking after you hang up true, writeDocument starts the doc, researchBrief starts the venue research. A promise with no tool behind it is forgotten when the call ends. This outranks any line above about waiting until after the call: the work still happens after the call, but you start it now.
- While a tool runs, say a few natural words of your own so they aren't left in silence: about what you're doing, never that it's done, sent or on its way.
- Say you did something only after the tool comes back done, and only what the result says. Before that, nothing is sent or saved yet, so never say it is.
- If it comes back not done, or not back yet, don't say it worked. A link or anything else you were texting them: tell them plainly you'll text it right after the call; it goes the moment they hang up. Something to fix: fix it and call it once more without talking them through it; if it still isn't done, say in one plain line that it didn't go through and what you'll do instead.
- Any question you have for them comes last, after the result, never before the tool: they can't answer while you're still talking.
- Doing it now replaces the promise: don't also say you'll do it after the call. The call carries on after a tool; say goodbye only when they do.
- Anything that needs real looking (web research, comparing options, finding venues) goes to startTask or researchBrief: they work after the call and text them what comes of it. Don't search the web on the call.
- Documents and briefs arrive by text, not on the call: say they'll be in their texts.
- A page or deck you make or change on the call goes to their texts as its link: say it'll be in their texts and don't read it out. For a deck on a call, pass makeDeck a brief (what they want, in their words) and never write the slides yourself; for a change, pass updateDeck the change and never the slides. If a deck needs their taste first, ask the one question out loud (the look they like, or one of your looks by name). A change keeps the same link.
- When they tell you something that belongs to one of your open tasks (a name, a date, a place, a number, a constraint, a change of plan), write it on that task with updateTask in this same turn, in their words. Saying it back writes nothing down, and only what's written is there when the work happens after the call. Something about them rather than a task goes in updateNotes.
- If you don't know a name, a place or a number, say you're not sure. Never guess one, and never promise work they didn't ask for.
- A tool that needs their yes needs their own words from what they just said. If they haven't said yes, ask.
- After your goodbye, when they answer it, call end_call and say nothing more: never a second goodbye.`;

// Per call: what the tools did earlier on this call, so a later turn knows (ElevenLabs' history carries only what was said).
// Keyed by the call's token; an hour is longer than any call.
const CALL_MEMORY_MS = 60 * 60_000;

// okAt: when a page or a deck (by kind) last went through on this call; failTextSent: the one honest text already went.
// voiceReadOff: they said stop (or no) to the voice read on this call: every later turn drops its lines and carries the note.
// onFile: what this call can text them by name (their finds, what searchEvents found on the call, what Cue sent before), read once.
// found: events a search on this call returned, by name. owed: links a send on this call didn't get to them yet (sent the moment
// the call ends). inflight: what a send that's still running was for, by its tool call, so a timeout knows what's owed.
type OnFile = { name: string; url: string; caption: string };
// jobs: durable work started or queued on this call (its goal and their words, or what an owed send was for): what a spoken "I've
// started" or "I'll text you" may stand on (callClaims.ts jobBacked). started: each start tool's last done result and when, so a retry
// inside START_RETRY_MS is that job, whatever its words.
type CallMem = { jobs?: string[]; started?: Record<string, { at: number; need: string; result: unknown }[]>; at: number; did: string[]; okAt?: Record<string, number>; failTextSent?: boolean; voiceReadOff?: boolean; onFile?: Promise<OnFile[]>; found?: OnFile[]; owed?: OnFile[]; inflight?: Map<string, OnFile[]> };
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
// The call's on-file list, read once at the call's first turn so a send later on doesn't wait on it (routes/callLlm.ts).
export function warmCallOnFile(callKey: string, userId: string): void {
  const mem = memoryFor(callKey);
  if (!mem.onFile) { mem.onFile = loadOnFile(userId); mem.onFile.catch(() => { mem.onFile = undefined; }); }
}
// What a send on this call still owes them, for tests and the call's own later turns.
export function owedOnCall(callKey: string): { name: string; url: string }[] {
  return (callMemory.get(callKey)?.owed ?? []).map((o) => ({ name: o.name, url: o.url }));
}
// Whether they turned the voice read off earlier on this call (routes/callLlm.ts strips its lines from the call's messages).
export function callVoiceReadOff(callKey: string): boolean {
  return !!callMemory.get(callKey)?.voiceReadOff;
}

// avoid: the kinds they've asked Co to stop suggesting, read fresh after a tool acts, so a "no more X" said mid-call (or by text during
// it) holds for the rest of the call without touching the cached prompt (callTools turnNote, past the cache breakpoint).
// noTexts: they opted out of texts (or the account is archived): nothing is texted to them from the call, now or after it.
export type MemberOnCall = { phone: string; firstName: string | null; city: string | null; tasks: { id: number; goal: string }[]; loops: string | null; avoid?: string[]; noTexts?: boolean };

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
    pool.query(`SELECT phone_number, first_name, sms_opted_out, archived_at FROM users WHERE id = $1`, [userId]).then((r) => r.rows[0] ?? null),
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
  return { phone: String(u.phone_number ?? ""), firstName: u.first_name ?? null, city: k?.identity.city ?? null, tasks, loops, avoid: lim ? lim.avoid : undefined, noTexts: !!u.sms_opted_out || !!u.archived_at };
}

export function callToolsNote(m: Pick<MemberOnCall, "tasks" | "loops">, didOnCall: string[], o: { voiceReadOff?: boolean } = {}): string {
  return [CALL_TOOLS_GUIDE, callRecords(m, didOnCall), o.voiceReadOff ? VOICE_READ_OFF_ON_CALL_NOTE : ""].filter(Boolean).join("\n");
}

// Co's records for the member, without the guide: what a spoken line may stand on (callLlmProxy.ts callSources).
// found: what a search on this call returned (its name, when and where, from the listing), so a later turn may name it again.
export function callRecords(m: Pick<MemberOnCall, "tasks" | "loops">, didOnCall: string[], found: { name: string; when?: string | null; venue?: string | null }[] = []): string {
  return [
    found.length ? `Found by your search earlier on this call (true as listed): ${found.slice(-8).map((f) => [f.name, f.when, f.venue].filter(Boolean).join(" | ")).join("; ")}.` : "",
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

// Pure: a tool call that texts them (a send): the registry's send kind, except a calendar status or disconnect, which texts nothing.
export function textsThem(name: string, input: unknown): boolean {
  const plan = callRunFor(name);
  if (!plan || plan.run !== "now" || plan.kind !== "send") return false;
  if (name === "calendarConnection") return (input as { action?: unknown } | null)?.action === "connect";
  return true;
}
// Pure: a send's items from its result: shareLink's own list, else the one link it made (or which page or deck it was for).
function sendItems(r: any, input: any, name: string, delivered: boolean): { name: string; url?: string; delivered: boolean }[] {
  if (Array.isArray(r?.items)) return r.items;
  const label = String(r?.made ?? input?.which ?? name).slice(0, 160);
  return [{ name: label, ...(typeof r?.url === "string" ? { url: r.url } : {}), delivered }];
}

// What the model is told when a send isn't confirmed on the call (services/callLlmProxy.ts holds back any "sent" until a send
// comes back done).
const SEND_NOT_BACK = "Not back yet, so it isn't confirmed sent: don't say it went. Tell them you'll text it right after the call; if it hasn't reached them by then, it goes the moment they hang up.";
const SEND_NOT_DONE = "It didn't send on the call. Don't try again now and don't say it went: tell them you'll text it right after the call. It goes the moment they hang up.";
const NOT_BACK = "Not back yet: it keeps going on its own and lands when it's done, but it isn't confirmed. Don't say it's done; carry on, and if it matters to them say you'll confirm by text.";

const normName = (x: string) => ` ${x.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
// Pure: the one thing on file a name means: the same name, or one name inside the other (6+ letters), or most of its words. Two
// equally good matches is no match: never a guess at which one they meant.
export function onFileByName(name: string, onFile: OnFile[]): OnFile | null {
  const want = normName(name);
  if (want.trim().length < 3) return null;
  const exact = onFile.filter((f) => normName(f.name) === want);
  if (exact.length) return exact[0];
  const inside = onFile.filter((f) => { const n = normName(f.name); return (want.trim().length >= 6 && n.includes(want)) || (n.trim().length >= 6 && want.includes(n)); });
  if (inside.length === 1) return inside[0];
  const words = want.trim().split(" ").filter((w) => w.length >= 3 && !TOPIC_PLAIN.has(w));
  if (!words.length) return null;
  const scored = onFile.map((f) => { const n = new Set(normName(f.name).trim().split(" ")); return { f, s: words.filter((w) => n.has(w)).length / words.length }; }).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s);
  return scored.length && (scored.length === 1 || scored[0].s > scored[1].s) ? scored[0].f : null;
}

// Pure: the links a send's result says went (or, for a send that resolved its items first, the ones it was for).
function urlsOf(r: any, meant: OnFile[]): string[] {
  const fromResult = [...(Array.isArray(r?.recordAs?.urls) ? r.recordAs.urls : []), ...(typeof r?.url === "string" ? [r.url] : [])].filter((u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  return fromResult.length ? fromResult : meant.map((m) => m.url);
}
// Pure: what a failed send still owes them: what it was for, or the link the tool says was made but didn't go.
function owedItems(r: any, meant: OnFile[]): OnFile[] {
  if (meant.length) return meant;
  return typeof r?.url === "string" && /^https?:\/\//.test(r.url) ? [{ name: String(r?.made ?? "the link").slice(0, 160), url: r.url, caption: String(r?.made ?? "").slice(0, 160) }] : [];
}
// What a search on this call returned: its events and earlier openings, by name, for shareLink.
// Pure: what a search's result found, each with its link (searchEvents' events and the openings found earlier).
export function foundIn(r: any): (OnFile & { when: string | null; venue: string | null })[] {
  const rows = [...(Array.isArray(r?.events) ? r.events : []), ...(Array.isArray(r?.openingsFoundEarlier) ? r.openingsFoundEarlier : [])];
  return rows.filter((e: any) => typeof e?.link === "string" && /^https?:\/\//.test(e.link) && e?.name).map((e: any) => ({ name: String(e.name), url: String(e.link), caption: String(e.name), ...whenAndVenue(e.details) }));
}
// Pure: a find's listing lines (services/eventDetails.ts renderEventDetails: '"X" starts Friday, October 31 at 8:00 PM and ends 11:00
// PM (America/Los_Angeles).', '"X" is at The Chapel, 777 Valencia St.'), as when and where.
export function whenAndVenue(details: unknown): { when: string | null; venue: string | null } {
  const lines = (Array.isArray(details) ? details : typeof details === "string" ? [details] : []).map(String).filter(Boolean);
  const when = lines.find((l) => /\bstarts\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\b/i.test(l)) ?? null;
  const venue = lines.find((l) => /\bis at\b|\bis online\b/i.test(l)) ?? null;
  return { when: when ? when.slice(0, 200) : null, venue: venue ? venue.slice(0, 200) : null };
}
function rememberFound(mem: CallMem, r: any): void {
  const found = foundIn(r);
  mem.found = [...(mem.found ?? []).filter((f) => !found.some((x: OnFile) => x.url === f.url)), ...found].slice(-30);
}

// What a call may text them by name: their finds (services/voiceFinds.ts, what the call's prompt lists), what Cue sent them before
// (services/turnContext.ts loadSentItems), and what a search on this call found. Read once per call; a failed read is nothing on file.
async function loadOnFile(userId: string): Promise<OnFile[]> {
  const [finds, sent] = await Promise.all([
    import("./voiceFinds.js").then((m) => m.voiceFinds(userId, new Date())).catch(() => null),
    import("./reactionCatchup.js").then((m) => m.sentItems(userId)).catch(() => []),
  ]);
  const out: OnFile[] = [];
  if (finds?.available) for (const f of finds.items) if (f.link && /^https?:\/\//.test(f.link)) out.push({ name: f.name, url: f.link, caption: f.starts ? `${f.name}, ${f.starts}` : f.name });
  for (const x of sent.slice(0, 30)) if (x.url && /^https?:\/\//.test(x.url) && !out.some((o) => o.url === x.url)) out.push({ name: x.name, url: x.url, caption: x.name });
  return out;
}

// shareLink on a call: what they want, by name, resolved against what's on file and texted as its link, then its name (finds go
// out link then caption: Royce, 2026-10-17). Nothing off file is ever sent, and nothing is read out on the line.
function callShareLink(i: CallToolsInput, mem: CallMem, did: string[], textThem: (text: string) => Promise<boolean>) {
  return {
    description: toolUse("shareLink", "call"),
    inputSchema: z.object({ what: z.array(z.string()).min(1).max(3).describe("The name of each thing to text them, as it's listed in what you have on file.") }),
    execute: async ({ what }: { what: string[] }, o?: { toolCallId?: string }) => {
      mem.onFile ??= i.onFile ? Promise.resolve(i.onFile) : loadOnFile(i.userId);
      const onFile = [...(mem.found ?? []), ...(await mem.onFile.catch(() => [] as OnFile[]))];
      const items: OnFile[] = [];
      for (const w of what) { const hit = onFileByName(w, onFile); if (hit && !items.some((x) => x.url === hit.url)) items.push(hit); }
      const missing = what.filter((w) => !onFileByName(w, onFile));
      if (!items.length) return { ok: false, error: `${what.join(", ")} isn't on file, so there's no link to send. Don't promise one: say you don't have a link for it.` };
      // Opted out of texts: nothing goes, now or after the call, and it isn't owed.
      if (i.member.noTexts) return { ok: false, error: "They've turned texts off, so nothing can be texted to them. Don't promise a text: tell them what it is out loud instead, without reading a link." };
      // What this send is for, so a timeout knows what's owed (services/callTools.ts run).
      if (o?.toolCallId) (mem.inflight ??= new Map()).set(o.toolCallId, items);
      if (i.dryRun && !i.sendText) return { ok: true, recordAs: { urls: items.map((x) => x.url), names: items.map((x) => x.name) }, items: items.map((x) => ({ name: x.name, url: x.url, delivered: true })), note: "Test run: nothing was sent." };
      const went: OnFile[] = [];
      for (const it of items) {
        // Its link alone first, so it previews, then its name as on file.
        if (!(await textThem(it.url))) continue;
        await textThem(it.caption).catch(() => false);
        went.push(it);
      }
      for (const it of went) {
        const line = `Texted them the link to ${it.name} (${it.url}) during this call.`;
        did.push(line);
        mem.did.push(line);
      }
      const notSent = items.filter((x) => !went.includes(x));
      // Each item and whether it went: only what went may be called sent (services/callClaims.ts).
      const each = [...went.map((x) => ({ name: x.name, url: x.url, delivered: true })), ...notSent.map((x) => ({ name: x.name, url: x.url, delivered: false }))];
      if (!went.length) return { ok: false, error: "The text didn't send.", items: each };
      // The guard's record names each link with what it is (services/coFacts.ts toolAction), so every later reader names it.
      return { ok: true, recordAs: { urls: went.map((x) => x.url), names: went.map((x) => x.name) }, items: each, ...(notSent.length || missing.length ? { note: `Sent: ${went.map((x) => x.name).join(", ")}.${notSent.length ? ` Didn't send: ${notSent.map((x) => x.name).join(", ")}.` : ""}${missing.length ? ` Not on file: ${missing.join(", ")}.` : ""}` } : {}) };
    },
  };
}

// The durable side of something owed after the call: its ledger row (what the after-call step sends) and a promise task Co owns, so
// a spoken "I'll text it right after" joins it rather than opening a second (services/callCommitments.ts), and if the after-call
// step can't send it, the task's own turn does.
async function oweAfterCall(i: CallToolsInput, items: OnFile[], why: "failed" | "timeout", tool: string): Promise<void> {
  const { COMMIT_PREFIX, DUE_AFTER_MINUTES } = await import("./callCommitments.js");
  const { startTask } = await import("./coTasks.js");
  const names = items.map((x) => x.name).join(", ");
  const r = await startTask({
    userId: i.userId,
    goal: `${COMMIT_PREFIX}text them the link to ${names}`.slice(0, 200),
    theirWords: (i.turnWords || "(said on a call)").replace(/\s+/g, " ").trim().slice(0, 300),
    steps: items.map((x) => ({ text: `Send the link to ${x.name.slice(0, 100)} as its own text: ${x.url}` })),
    firstPlan: "On the call the text with these links didn't go through, and you told them you'd text it right after. Send each link as its own text, then its name, and nothing else about it.",
    inHours: 1,
    source: "promise",
  }).catch(() => null);
  if (r?.ok) await pool.query(`UPDATE co_tasks SET next_check_at = $3 WHERE user_id = $1 AND id = $2`, [i.userId, r.task.id, new Date(Date.now() + DUE_AFTER_MINUTES * 60_000)]).catch(() => {});
  // The ledger row names its task, so the after-call step closes exactly that task once the link has landed.
  await (await import("./callLedger.js")).recordOwedAfterCall(i.userId, { tool, items: items.map((x) => ({ name: x.caption || x.name, url: x.url })), why, taskId: r?.ok ? r.task.id : null });
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
  // Tests: a tool's own timeout on a call in place of the registry's (services/capabilities.ts CALL_RUN), and what's on file.
  msFor?: (name: string) => number | undefined;
  onFile?: OnFile[];
  // Tests: where the owed-after-call record and the open promise task go (default: the decision log and co_tasks).
  owe?: (items: OnFile[], why: "failed" | "timeout", tool: string) => Promise<void>;
  // found: what a search found on the call (searchEvents), kept with its done row so a later correction never takes back a real find.
  done?: (tool: string, kind: string, input: unknown, urls: string[], found?: { name: string; url: string; when?: string | null; venue?: string | null }[]) => Promise<void>;
  // Tests: the text to them during the call, in place of the real send.
  sendText?: (text: string) => Promise<boolean>;
  // GPT-Live (services/gptLive.ts liveCallTools): the names this call may use (services/capabilities.ts liveCallToolNames), and the
  // guide its thinking reads in place of CALL_TOOLS_GUIDE.
  only?: readonly string[];
  guide?: string;
  // Tests: what a stubbed event search returns (agent/loopTools.ts stubEvents, with stubSearch).
  stubEvents?: import("../agent/loopTools.js").StubEvent[];
};

// Pure enough to test: the call's toolset for one turn, from the texting tools, guarded the same way.
export function buildCallTools(i: CallToolsInput): CallToolset {
  const mem = memoryFor(i.callKey);
  // A text to them during the call, from Co's number (a page's or deck's link, or a background tool's honest "it didn't come
  // together"), logged like any text. A test member's texts are logged, never sent (services/sendblue.ts).
  const textThem = i.sendText ?? (async (text: string): Promise<boolean> => {
    const from = process.env.SENDBLUE_PHONE_NUMBER;
    // Opted out of texts (or archived): nothing is texted from the call.
    if (!from || !i.member.phone || i.member.noTexts) return false;
    const sendblue = (await import("./sendblue.js")).default;
    const ok = await sendblue.messages
      .send({ number: i.member.phone, content: text, from_number: from } as any)
      .then(() => true)
      .catch(() => false);
    // A page's or deck's own texts (its link, its "Updated the …:" line) are logged by the tool that sent them (agent/loopTools.ts).
    if (ok && !/\/d\//.test(text) && !/^Updated the (deck|page): /.test(text)) await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`, [i.userId, `Co replied: ${text}`]).catch(() => {});
    return ok;
  });
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
    ...(i.stubEvents ? { stubEvents: i.stubEvents } : {}),
    // A job started on this call carries the call's key, so the same need started again on it is the same job (coTasks.ts dispatchKeyFor).
    callKey: i.callKey,
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
  // On a call, shareLink texts them something on file by its name (the call's prompt carries no links: services/callBriefing.ts),
  // wrapped by the same guard as every tool (limits, receipts, decision log, Co's action record of the links that went).
  if (!i.tools?.shareLink) all.shareLink = guardTools({ shareLink: callShareLink(i, mem, did, textThem) }, { userId: i.userId, resolvedContent: i.turnWords, dryRun: !!i.dryRun, notDone: () => {}, recentExchange: i.recentExchange ?? null }).shareLink;
  const picked: Record<string, any> = {};
  for (const n of i.only ?? CALL_TOOL_NAMES) if (all[n] && CALL_TOOL_NAMES.includes(n)) picked[n] = all[n];
  // GPT-Live: a member with texts off isn't offered a send at all (nothing could go, now or after), so no "texting it now" is ever said.
  if (i.only && i.member.noTexts) for (const n of Object.keys(picked)) if (textsThem(n, { action: "connect" })) delete picked[n];
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
  // The durable record (services/callLedger.ts): what came back done on the call, and what's owed the moment it ends. Tests pass
  // their own; a dry run writes nothing.
  const recordDone = i.done ?? (async (tool: string, kind: string, input: unknown, urls: string[], found?: { name: string; url: string; when?: string | null; venue?: string | null }[]) => { if (!i.dryRun) await (await import("./callLedger.js")).recordDoneOnCall(i.userId, { tool, kind, input, urls, found }); });
  const foundFor = (name: string, r: any) => (name === "searchEvents" ? foundIn(r).map((f) => ({ name: f.name, url: f.url, when: f.when, venue: f.venue })) : undefined);
  const recordOwed = i.owe ?? (async (items: OnFile[], why: "failed" | "timeout", tool: string) => { if (!i.dryRun) await oweAfterCall(i, items, why, tool); });
  // A send that didn't reach them on the call: owed right after it, once per link, and said so to every later turn of the call.
  const writes: Promise<unknown>[] = [];
  // Whether every owed record this call wrote landed (a send promised for after the call is only said once it's queued).
  let owedWriteFailed = false;
  const owe = (items: OnFile[], why: "failed" | "timeout", tool: string) => {
    const fresh = items.filter((x) => !(mem.owed ?? []).some((o) => o.url === x.url));
    if (!fresh.length) return;
    mem.owed = [...(mem.owed ?? []), ...fresh];
    (mem.jobs ??= []).push(`Owed right after the call: ${fresh.map((x) => x.name).join(", ")}`);
    mem.did.push(`Owed right after the call: ${fresh.map((x) => x.name).join(", ")} (the text didn't reach them on the call). Don't send it again on the call; it goes the moment they hang up.`);
    writes.push(recordOwed(fresh, why, tool).catch((err: any) => { owedWriteFailed = true; console.error("call: recording what's owed after the call failed (non-fatal):", err?.message ?? err); }));
  };
  // A send that came back done (on time or late): no longer owed.
  const settleSent = (urls: string[]) => {
    if (!urls.length || !mem.owed?.length) return;
    mem.owed = mem.owed.filter((o) => !urls.includes(o.url));
  };
  const run: CallToolset["run"] = async (name, input, toolUseId) => {
    const t = picked[name];
    // The same need started again on this call within a few seconds (a retried delegation, the same ask re-sent, reworded) is the job
    // just started: the same need key, or most of the same goal words (review of #365, round 2: the tool alone made "and a florist"
    // the caterers job). A different need always starts its own.
    const ask = needOf(input);
    const prev = (mem.started?.[name] ?? []).find((p) => Date.now() - p.at < START_RETRY_MS && sameNeed(p.need, ask, i.callKey));
    if (prev) return { ...(prev.result as object), goal: prev.need, alreadyStarted: true, note: "That was just started on this call; this is the same job, not a new one. If they changed something about it, write it on it with updateTask." };
    // The allow-list holds here too: nothing off it runs on a call, whatever the model asks for.
    const plan: CallRun | null = callRunFor(name);
    if (!t || !plan) return { ok: false, error: `No tool named ${name} on a call.` };
    const parsed = t.inputSchema && typeof t.inputSchema.safeParse === "function" ? t.inputSchema.safeParse(input ?? {}) : { success: true, data: input ?? {} };
    if (!parsed.success) return { ok: false, error: `The input didn't fit: ${parsed.error.issues.slice(0, 3).map((x: any) => `${x.path.join(".")}: ${x.message}`).join("; ")}. Fix it and try once more, or say plainly it wasn't done.` };
    const t0 = Date.now();
    let result: any;
    const work = (async () => t.execute(parsed.data, { toolCallId: toolUseId, messages: [] }))().catch((err: any) => ({ ok: false, error: `It failed: ${String(err?.message ?? err).slice(0, 160)}. Say plainly it wasn't done.` }));
    if (plan.run === "after" && !i.dryRun) {
      // Making or changing a page, deck or document on a call (PR 6) takes longer than a call turn may wait (writing it, the claim
      // check, saving, texting the link). Past a moment it carries on in the background: Co says it'll be in their texts, the link
      // arrives when it's ready, and if it doesn't come together they get one honest text saying so, never silence. The short wait
      // is for the guard's quick answers (no yes yet, an input to fix), which the model must hear.
      const quick = await within(work, plan.waitMs);
      const what = name.endsWith("Deck") ? "deck" : name === "writeDocument" ? "document" : "page";
      if (quick === STILL_GOING) {
        const startedAt = Date.now();
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
              await recordDone(name, "after", parsed.data, []).catch(() => {});
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
        result = { ok: true, pending: true, note: `Still being made: it goes to their texts when it's ready. Say it'll be in their texts; don't say it's done or describe it.` };
      } else {
        result = quick;
        if ((quick as any)?.ok !== false) {
          mem.okAt = { ...(mem.okAt ?? {}), [what]: Date.now() };
          result = { ...(quick as any), delivered: true };
          writes.push(recordDone(name, "after", parsed.data, []).catch(() => {}));
        }
      }
    } else if (plan.run === "now") {
      // Quick and certain, inside its own timeout. Past it the tool keeps going on its own (its write lands, the guard logs it); a
      // send that hasn't come back is owed right after the call, and the model is told not to say it went.
      const ms = i.msFor?.(name) ?? plan.ms;
      const quick = await within(work, ms);
      if (quick === STILL_GOING) {
        const meant = mem.inflight?.get(toolUseId) ?? [];
        if (plan.kind === "send" && meant.length) owe(meant, "timeout", name);
        // However it ends, the record says so: done (and no longer owed), or owed if it failed with something to send.
        work
          .then(async (r: any) => {
            if (r?.ok !== false) {
              const urls = urlsOf(r, meant);
              settleSent(urls);
              if (plan.kind !== "read" || name === "searchEvents") await recordDone(name, plan.kind, r?.recordAs ?? parsed.data, urls, foundFor(name, r)).catch(() => {});
            } else if (plan.kind === "send") {
              const items = owedItems(r, meant);
              if (items.length) owe(items, "failed", name);
            }
          })
          .catch(() => {});
        result = plan.kind === "send"
          ? { ok: false, stillRunning: true, owedAfterCall: meant.length > 0, note: SEND_NOT_BACK, items: meant.map((x) => ({ name: x.name, url: x.url, delivered: false })) }
          : { ok: false, stillRunning: true, note: NOT_BACK };
      } else {
        result = quick;
        const r: any = quick;
        if (r?.ok !== false) {
          const texts = textsThem(name, parsed.data);
          const urls = texts ? urlsOf(r, mem.inflight?.get(toolUseId) ?? []) : [];
          // Delivered only when it really texted them (a calendar status check texts nothing), item by item.
          if (texts) { settleSent(urls); result = { ...r, delivered: true, items: sendItems(r, parsed.data, name, true) }; }
          // What a search on this call found can be texted to them by name, in this turn or a later one.
          if (name === "searchEvents") rememberFound(mem, r);
          // On the record without holding the turn (a plain read, like what Cue knows, isn't an action).
          // A send's record names what it texted (its items' names and links), whichever send it was.
          const label = texts ? (r?.recordAs ?? { urls, names: sendItems(r, parsed.data, name, true).filter((x) => x.url).map((x) => x.name) }) : parsed.data;
          if (plan.kind !== "read" || name === "searchEvents") writes.push(recordDone(name, plan.kind, label, urls, foundFor(name, r)).catch(() => {}));
        } else if (plan.kind === "send") {
          const items = owedItems(r, mem.inflight?.get(toolUseId) ?? []);
          if (items.length) {
            owe(items, "failed", name);
            result = { ok: false, owedAfterCall: true, note: SEND_NOT_DONE, items: items.map((x) => ({ name: x.name, url: x.url, delivered: false })) };
          }
        }
      }
      mem.inflight?.delete(toolUseId);
    } else result = await work;
    // Durable work that came back done: a job this call may speak of.
    if (startsWork(name) && result && (result as any).ok !== false && !(result as any).stillRunning) {
      const d: any = parsed.data ?? {};
      (mem.jobs ??= []).push([d.goal, d.what, d.theirWords, ...(Array.isArray(d.steps) ? d.steps : [])].filter((x) => typeof x === "string" && x).join(" | ").slice(0, 600));
      ((mem.started ??= {})[name] ??= []).push({ at: Date.now(), need: needOf(parsed.data), result });
    }
    // A stop or a no to the voice read on this call: from now on the call drops its lines and every turn's note says so. One still
    // running at its timeout counts too: their stop is never held up by a slow write.
    if (name === "voiceRead" && (result?.ok !== false || result?.stillRunning) && ((parsed.data as any)?.answer === "stop" || (parsed.data as any)?.answer === "no")) mem.voiceReadOff = true;
    if (!i.dryRun) recordDecision({ layer: 8, decision: "call.tool", userId: i.userId, outcome: result?.ok === false ? "skip" : "act", action: name, proposal: { ms: Date.now() - t0, turn: i.turnWords.slice(0, 200) }, reason: String(result?.error ?? "").slice(0, 200) }).catch(() => {});
    return result;
  };
  return {
    defs,
    names: new Set(Object.keys(picked)),
    note: i.guide ? [i.guide, callRecords(i.member, mem.did, mem.found as any), mem.voiceReadOff ? VOICE_READ_OFF_ON_CALL_NOTE : ""].filter(Boolean).join("\n") : callToolsNote(i.member, mem.did, { voiceReadOff: mem.voiceReadOff }),
    // GPT-Live (guide given): what a search found earlier on the call is a source too (2026-11-02: "Rooftop Jazz Night" from turn one
    // was held on turn two as unbacked).
    records: i.guide ? callRecords(i.member, mem.did, mem.found as any) : callRecords(i.member, mem.did),
    // This turn's facts; the brain writes the turn's note from them (brain/index.ts judgeCallTurn).
    turnFacts: { turnWords: i.turnWords, tasks: i.member.tasks, avoid: i.member.avoid, canWriteTasks: !!picked.updateTask },
    did,
    run,
    pending: async () => { await Promise.allSettled(writes); },
    texts: textsThem,
    starts: startsWork,
    // Job text only (callClaims.ts JobState): open tasks' goals and the jobs started or queued on this call. Never finds or loops.
    jobs: { corpus: [...i.member.tasks.map((t) => t.goal), ...(mem.jobs ?? [])].join("\n"), callJobs: (mem.jobs ?? []).join("\n") },
    owedDurable: async () => { await Promise.allSettled(writes); return !owedWriteFailed; },
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
