// Co's own work and mixed requests (Royce, 2026-10-13): "for requests that are Co's own work the 9am run skips web and X searches -
// they're logged as 'followed as its task', the work continues through the task itself, and a member asking gets the status answer
// from that task's record. Nothing silently switches off, nothing wasted. ... 'Draft the launch plan and keep an eye out for venues'
// is half task, half lookout - split those, the task part follows as a task and the discoverable part stays in the 9am run. Never bin
// a mixed request wholesale into either lane. ... Existing legacy flips get logged and surfaced, not silently bulk-corrected."
// Code guards facts, Co decides intent (review of this branch, 2026-10-13):
//   1. The read: only an entry typed an ask (never a goal) whose text reads as Co's own work in code (goalEdges.ts isCoTaskGoal) is
//      read, once, by Haiku: work, find or mixed (readSplit). Code checks the parts: each in what they asked, neither just the other
//      with a word dropped. Kept on the ask (split_read, SPLIT_VERSION).
//   2. The sweeps (the 9am floor, the hourly ask sweep, a new ask's first search: askSearchPlan, floorPlan): an ask is followed as its
//      task, not searched, only when the read says work AND an open task really is that work. Anything else is searched: a find, a read
//      that failed, work with no task (logged once a day, sweep.own_work_no_task, and listed for the team). A mixed one is searched for
//      its find part; its work part with no task is never started from a sweep (logged once a day, sweep.work_part_unclaimed).
//   3. At creation (profileExtraction.ts persistIntentFrom): a clean work read is today's behavior (no search row; the reply's task
//      carries it). A clean mixed read saves the find part as its own ask and links the work part to the task it is, or starts one
//      only when the member asked for that work outright (askedOutright) and only through the startTask tool's own guards. Anything
//      else (a failed read, a rejected parse, the task cap, open work unreadable, the work unclaimed) saves the whole request as a
//      find row with no kept read, so the sweeps read it again and nothing is lost. Logged: ask.split.
//   4. Legacy flips: open help asks the old morning job likely switched off are listed for the team (co-test /sweeps) and logged once
//      each (ask.legacy_flip). Nothing is corrected.
import Anthropic from "@anthropic-ai/sdk";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { isCoTaskGoal } from "./goalEdges.js";
import { isCoCommitment } from "./askKind.js";
import { meaningWords } from "./profileExtraction.js";
import { recordAnthropicUsage } from "./llmUsage.js";

export type SplitKind = "work" | "find" | "mixed";
export type Split = { work: string; find: string; findIsLookout: boolean };
// kind null: unread. split: only for mixed.
export type SplitRead = { kind: SplitKind | null; split: Split | null; read: boolean; why: string };
export const SPLIT_LIMITS = { timeoutMs: 5000, maxTokens: 200, partChars: 160 } as const;
const unreadAs = (why: string): SplitRead => ({ kind: null, split: null, read: false, why });

export function splitPrompt(text: string, theirWords?: string | null): string {
  return `A member asked Cue (a texting companion) for this: "${text.slice(0, 400)}"${theirWords && theirWords.trim() !== text.trim() ? `\nTheir own words: "${theirWords.slice(0, 500)}"` : ""}

Cue does some things itself (drafting, writing, planning, outlining, preparing something for them) and finds things in the world with its daily search (events, venues, places, people, programs, communities).
What is this request?
- "work": only a piece of work for Cue to do (draft, write, plan, prepare something).
- "find": only something to find, even if it's worded as "have Cue look for..." or it's for a piece of work they're doing themselves.
- "mixed": both a piece of work for Cue AND a separate thing to find.
Answer {"kind": "work"} or {"kind": "find"} or {"kind": "mixed", "work": "the work, in a few words, their terms", "find": "the thing to find, in a few words, their terms", "findIsLookout": true only if their words ask Cue to keep watching or tell them when (keep an eye out, let me know when, look out for), else false}
Never invent a part they didn't ask for. Return ONLY JSON.`;
}

const shares = (part: string, whole: string) => {
  const w = meaningWords(whole);
  return [...meaningWords(part)].some((x) => w.has(x));
};
// Pure: one part is just the other (the same meaning words, or one with a word dropped).
export function restatesPart(a: string, b: string): boolean {
  const x = meaningWords(a), y = meaningWords(b);
  const onlyX = [...x].filter((w) => !y.has(w)).length, onlyY = [...y].filter((w) => !x.has(w)).length;
  return onlyX === 0 || onlyY === 0 || onlyX + onlyY <= 1;
}
// Pure: the read, checked in code. A part they didn't ask for, a missing part, or a find part that is the work part again is unread.
export function parseSplit(raw: string, text: string): SplitRead {
  try {
    const p = parseModelJson<{ kind?: unknown; work?: unknown; find?: unknown; findIsLookout?: unknown }>(raw);
    if (p?.kind === "work" || p?.kind === "find") return { kind: p.kind, split: null, read: true, why: p.kind === "work" ? "Cue's own work" : "something to find" };
    if (p?.kind !== "mixed") return unreadAs("the read came back without a kind");
    const work = String(p.work ?? "").replace(/\s+/g, " ").trim().slice(0, SPLIT_LIMITS.partChars);
    const find = String(p.find ?? "").replace(/\s+/g, " ").trim().slice(0, SPLIT_LIMITS.partChars);
    if (work.length < 3 || find.length < 3) return unreadAs("a part was missing");
    if (!shares(work, text) || !shares(find, text)) return unreadAs("a part isn't in what they asked");
    if (restatesPart(work, find)) return unreadAs("the find part is the work part again");
    return { kind: "mixed", split: { work, find, findIsLookout: p.findIsLookout === true }, read: true, why: "work and something to find" };
  } catch {
    return unreadAs("the read couldn't be parsed");
  }
}

// Haiku 5.5 thinks by default and the ai-sdk drops "thinking disabled" (goalEdges.ts), so the SDK is called directly.
const haikuReader = async (prompt: string): Promise<string> => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SPLIT_LIMITS.timeoutMs);
  try {
    const out: any = await new Anthropic().messages.create({ model: MODELS.haiku, max_tokens: SPLIT_LIMITS.maxTokens, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] } as any, { signal: ctl.signal });
    recordAnthropicUsage("askSplit.read", out.model ?? MODELS.haiku, out.usage);
    return (out.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  } finally {
    clearTimeout(t);
  }
};
let reader: (prompt: string) => Promise<string> = haikuReader;
export function setSplitReaderForTests(r: ((prompt: string) => Promise<string>) | null): void {
  reader = r ?? haikuReader;
}
// Never throws: a read that fails is unread.
export async function readSplit(text: string, theirWords?: string | null): Promise<SplitRead> {
  try {
    return parseSplit(await reader(splitPrompt(text, theirWords)), text);
  } catch (err: any) {
    return unreadAs(`the read failed: ${String(err?.message ?? err).slice(0, 120)}`);
  }
}

// Pure: an ask that reads as Co's own work, in code. Only these are ever read.
export const isOwnWork = (text: string): boolean => isCoTaskGoal(String(text ?? ""));

// ---------------------------------------------------------------- whether they asked for the work outright

// A task starts from their request only when their own message asks Co for that work outright, never when it answers a question or an
// offer of Co's: one strict Haiku read of the exchange (theirYes.ts exchangeText). Anything but a clear yes is "don't start".
export function outrightPrompt(work: string, message: string, recent: string): string {
  return `Cue is a texting companion. The recent exchange, oldest first:
${recent.trim() || "(nothing before it)"}

The member's latest message: "${message.slice(0, 600)}"

Is the member's latest message itself asking Cue, outright and in their own words, to do this work: "${work.slice(0, 200)}"? Answer no if they're answering a question or an offer from Cue, saying yes to something Cue suggested, or only mentioning it.

Return ONLY JSON: {"outright": true or false, "why": "one short line"}`;
}
let outrightReader: (prompt: string) => Promise<string> = haikuReader;
export function setOutrightReaderForTests(r: ((prompt: string) => Promise<string>) | null): void {
  outrightReader = r ?? haikuReader;
}
export async function askedOutright(work: string, message: string, recent: string): Promise<boolean> {
  try {
    const p = parseModelJson<{ outright?: unknown }>(await outrightReader(outrightPrompt(work, message, recent)));
    return p?.outright === true;
  } catch {
    return false;
  }
}
// Pure: the exchange before their message from a learning transcript, as the yes read shows it. A text turn's transcript is the thread's
// log ("User said: …" / "Co replied: …", turnLearning.ts turnTranscript) then "user: <their message>" and "assistant: <Co's reply>"; a
// call's is "user:" / "assistant:" lines. Both are read, so Co's offer in the thread reaches the outright read (review, 2026-10-13).
export async function exchangeFromTranscript(transcript: string): Promise<{ recent: string; message: string }> {
  const { exchangeText } = await import("./theirYes.js");
  const turns: { side: "co" | "member"; text: string }[] = [];
  for (const line of String(transcript ?? "").split("\n")) {
    const m = line.match(/^(user|assistant|User said|User sent|Co replied|Co said|Cue replied|Cue said|Mo said|Mo replied):\s*(.*)$/i);
    if (m) turns.push({ side: /^user/i.test(m[1]) ? "member" : "co", text: m[2] });
    else if (/^\s*\[/.test(line)) continue;
    else if (turns.length && line.trim()) turns[turns.length - 1].text += ` ${line.trim()}`;
  }
  // Their latest message is the last member turn; the exchange is everything before it.
  const last = turns.map((t) => t.side).lastIndexOf("member");
  return last < 0 ? { recent: exchangeText(turns), message: "" } : { recent: exchangeText(turns.slice(0, last)), message: turns[last].text };
}

// ---------------------------------------------------------------- at creation

// The work part as a task: the open one it already is (statusCheck.ts restatedTask, or laneMoves.ts lookoutRestatesTask for a reworded
// one), never a duplicate. A new one only when they asked for it outright, and only through the startTask tool (its quote check, the
// status-check candidate and toolGuard's limits). Otherwise unclaimed: no task.
export type Followed = { ok: true; taskId: number; existing: boolean } | { ok: false; why: string; unclaimed?: boolean };
export type EntryKindOf = (text: string) => Promise<"ask" | "goal">;
export type SplitDeps = {
  kindOf: EntryKindOf;
  read: (text: string, theirWords: string | null) => Promise<SplitRead>;
  follow: (userId: string, split: Split, o: { transcript: string; message: string | null }) => Promise<Followed>;
  log: (d: { userId: string; action: string; reason: string | null; proposal: Record<string, unknown> }) => Promise<void>;
};
export async function existingTaskFor(work: string, open: { id: number; goal: string; source?: string | null }[]): Promise<{ id: number } | null> {
  const S = await import("./statusCheck.js");
  const { lookoutRestatesTask } = await import("./laneMoves.js");
  return S.restatedTask(work, open as any) ?? open.find((w) => w.source !== "lookout" && lookoutRestatesTask(work, [w.goal])) ?? null;
}
export type FollowDeps = {
  open: (userId: string) => Promise<{ id: number; goal: string; source?: string | null }[]>;
  outright: (work: string, message: string, recent: string) => Promise<boolean>;
  start: (userId: string, work: string, message: string) => Promise<Followed>;
};
// The startTask tool, with its own guards (agent/toolGuard.ts limits and log, the quote check, statusCheck's candidate).
export const BACKGROUND_START_WHY = "background: member asked outright, split work part";
async function startThroughTool(userId: string, work: string, message: string): Promise<Followed> {
  const { createConversationTools } = await import("../agent/conversationTools.js");
  const { tools } = createConversationTools({ userId, phoneNumber: "", resolvedContent: message, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, sendCoReply: async () => false, lastCoMessage: null } as any);
  // Tagged as a background start, so the tool log (tool.startTask) and Co's record (co_facts source tool.startTask.background) tell it
  // apart from a start Co chose in a reply.
  const r: any = await (tools as any).startTask.execute({ goal: work, theirWords: message.slice(0, 300), steps: [work], firstStep: `Start on: ${work}`, inHours: 1, why: BACKGROUND_START_WHY, background: true }, {});
  return r?.ok && typeof r.taskId === "number" ? { ok: true, taskId: r.taskId, existing: false } : { ok: false, why: String(r?.error ?? "the task didn't start").slice(0, 160) };
}
const realFollowDeps: FollowDeps = {
  open: async (userId) => (await import("./statusCheck.js")).openWorkFor(userId),
  outright: askedOutright,
  start: startThroughTool,
};
export async function followWorkPart(userId: string, split: Split, o: { transcript: string; message: string | null }, deps: Partial<FollowDeps> = {}): Promise<Followed> {
  const d = { ...realFollowDeps, ...deps };
  const open = await d.open(userId).catch(() => null);
  if (!open) return { ok: false, why: "their open work couldn't be read" };
  const same = await existingTaskFor(split.work, open);
  if (same) return { ok: true, taskId: same.id, existing: true };
  // No message of theirs (saveAsk and a call's capture save Co's own wording of it): nothing to read as their outright ask, so nothing
  // starts; the request keeps its find row (review, 2026-10-13: Co's paraphrase passed the quote check on its own text).
  if (o.message == null || !o.message.trim()) return { ok: false, why: "no message of theirs to read (saved from Cue's own wording)", unclaimed: true };
  const ex = await exchangeFromTranscript(o.transcript);
  if (!(await d.outright(split.work, o.message, ex.recent).catch(() => false))) return { ok: false, why: "they didn't ask for that work outright", unclaimed: true };
  return d.start(userId, split.work, o.message).catch((err: any) => ({ ok: false, why: String(err?.message ?? err).slice(0, 160) }));
}
export const realSplitDeps: SplitDeps = {
  kindOf: async (text) => (await import("./entryKind.js")).classifyEntryKind(text),
  read: (text, theirWords) => readSplit(text, theirWords),
  follow: followWorkPart,
  log: async (d) => {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 4, decision: "ask.split", userId: d.userId, outcome: d.action === "split" ? "act" : "skip", action: d.action, reason: d.reason, proposal: d.proposal });
  },
};
// What to write for each captured ask: the ask (its find part for a split), its entry kind when already read (so it isn't read twice),
// and keepSearchRow: write its find row even though its text reads as Co's own promise (no split was clean, so the sweeps read it again).
export type ToWrite<A> = { ask: A; kind?: "ask" | "goal"; keepSearchRow?: boolean };
export async function splitAsks<A extends { text: string; type: "seeking" | "offering" }>(userId: string, asks: A[], o: { transcript: string; message: string | null }, deps: SplitDeps = realSplitDeps): Promise<ToWrite<A>[]> {
  const out: ToWrite<A>[] = [];
  for (const a of asks) {
    // Only their own request that reads as Co's own work is read: never an offer, never anything else.
    if (a.type !== "seeking" || !isOwnWork(a.text)) { out.push({ ask: a }); continue; }
    const kind = await deps.kindOf(a.text).catch(() => "ask" as const);
    // A goal is direction, never split (entryKind.ts): it's written as it is.
    if (kind === "goal") { out.push({ ask: a, kind }); continue; }
    const r = await deps.read(a.text, o.message).catch((err: any) => unreadAs(`the read failed: ${String(err?.message ?? err).slice(0, 120)}`));
    if (r.kind === "work") { out.push({ ask: a, kind }); continue; } // today's behavior: the reply's task carries it
    if (r.kind === "find") { out.push({ ask: a, kind, keepSearchRow: true }); continue; }
    if (!r.split) {
      await deps.log({ userId, action: "unread", reason: `${r.why}; saved whole as a find row, read again by the sweeps`, proposal: { ask: a.text.slice(0, 200) } }).catch(() => {});
      out.push({ ask: a, kind, keepSearchRow: true });
      continue;
    }
    const f = await deps.follow(userId, r.split, o).catch((err: any) => ({ ok: false, why: String(err?.message ?? err).slice(0, 120) }) as Followed);
    if (!f.ok) {
      await deps.log({ userId, action: f.unclaimed ? "unclaimed" : "not_split", reason: `its work part has no task (${f.why}); saved whole as a find row: the sweeps search its find part`, proposal: { ask: a.text.slice(0, 200), work: r.split.work, find: r.split.find } }).catch(() => {});
      out.push({ ask: a, kind, keepSearchRow: true });
      continue;
    }
    out.push({ ask: { ...a, text: r.split.find } });
    await deps.log({ userId, action: "split", reason: null, proposal: { ask: a.text.slice(0, 200), work: r.split.work, find: r.split.find, findIsLookout: r.split.findIsLookout, taskId: f.taskId, existingTask: f.existing } }).catch(() => {});
  }
  return out;
}

// ---------------------------------------------------------------- the sweeps

// Pure: what a sweep does with one open find ask. Followed (no search) only for work with a task that is it; Co's own promise with no
// task isn't searched either (noted); everything else is searched. search null means no search.
export type FloorNote = "own_work_no_task" | "work_part_unclaimed";
export type FloorPlan = { search: string | null; followed: boolean; why: string; split?: Split; note?: FloorNote };
export function floorPlan(text: string, read: SplitRead | null, taskId: number | null = null): FloorPlan {
  if (!isOwnWork(text)) return { search: text, followed: false, why: "something to find" };
  if (!read || !read.read) return { search: text, followed: false, why: `the split read failed (${read?.why ?? "not read"}): searched whole` };
  if (read.kind === "mixed" && read.split) return { search: read.split.find, followed: false, why: `a mixed request: only "${read.split.find}" is searched${taskId == null ? "; its work part has no task" : ""}`, split: read.split, ...(taskId == null ? { note: "work_part_unclaimed" as const } : {}) };
  if (read.kind === "work" && taskId != null) return { search: null, followed: true, why: "followed as its task" };
  // Co's own promise ("Draft the launch plan") with no task: never searched (nothing on the web finds Co's own work; the 10-08 waste),
  // the same outcome a clean read at creation gives; noted and listed for the team, never silent (review, 2026-10-13).
  if (read.kind === "work" && isCoCommitment(text)) return { search: null, followed: false, why: "Cue's own promise with no task: not searched, listed for the team", note: "own_work_no_task" };
  if (read.kind === "work") return { search: text, followed: false, why: "Cue's own work, but no open task is it: searched whole, never quietly skipped", note: "own_work_no_task" };
  return { search: text, followed: false, why: "something to find" };
}

// The read is kept on the ask (ask_checkins.split_read) and reused until the ask's text changes or the read's version does. A read that
// failed isn't kept: it's read again next run, and meanwhile the ask is searched whole.
export const SPLIT_VERSION = 2;
export type StoredRead = { at: string; version: number; text: string; kind: SplitKind; split: Split | null; why: string };
// Pure: the kept read, when it still applies to this text.
export function cachedRead(stored: unknown, text: string): SplitRead | null {
  const s = stored as StoredRead | null;
  if (!s || s.version !== SPLIT_VERSION || String(s.text ?? "") !== String(text ?? "") || !["work", "find", "mixed"].includes(s.kind)) return null;
  return { kind: s.kind, split: s.split ?? null, read: true, why: `${s.why} (read ${String(s.at).slice(0, 10)})` };
}
export type PlanDeps = {
  read: (text: string, theirWords: string | null) => Promise<SplitRead>;
  store: (askRowId: string, stored: StoredRead) => Promise<void>;
  work: (userId: string) => Promise<{ id: number; goal: string; source?: string | null }[]>;
};
const realPlanDeps: PlanDeps = {
  read: (text, theirWords) => readSplit(text, theirWords),
  store: async (id, stored) => {
    await pool.query(`UPDATE ask_checkins SET split_read = $2::jsonb WHERE id = $1`, [id, JSON.stringify(stored)]);
  },
  work: async (userId) => (await import("./statusCheck.js")).openWorkFor(userId),
};
let planDeps: PlanDeps = realPlanDeps;
export function setPlanDepsForTests(d: Partial<PlanDeps> | null): void {
  planDeps = d ? { ...realPlanDeps, ...d } : realPlanDeps;
}
// What a sweep does with one open find ask (the 9am floor, the hourly ask sweep and a new ask's first search all ask this): the read
// (kept or fresh), the task that is its work (or its work part), and the plan.
export async function askSearchPlan(userId: string, row: { id: string | number; ask_text: string; split_read?: unknown }): Promise<{ read: SplitRead | null; plan: FloorPlan; taskId: number | null }> {
  const text = String(row.ask_text ?? "");
  if (!isOwnWork(text)) return { read: null, plan: floorPlan(text, null), taskId: null };
  let read = cachedRead(row.split_read, text);
  if (!read) {
    read = await planDeps.read(text, null).catch((err: any) => unreadAs(`the read failed: ${String(err?.message ?? err).slice(0, 120)}`));
    if (read.read && read.kind) await planDeps.store(String(row.id), { at: new Date().toISOString(), version: SPLIT_VERSION, text, kind: read.kind, split: read.split, why: read.why }).catch(() => {});
  }
  let taskId: number | null = null;
  if (read.read && (read.kind === "work" || read.kind === "mixed")) {
    // An open task that really is the work (or the work part): read fresh each run, so a closed task stops covering it.
    const open = await planDeps.work(userId).catch(() => [] as { id: number; goal: string; source?: string | null }[]);
    taskId = (await existingTaskFor(read.kind === "mixed" && read.split ? read.split.work : text, open))?.id ?? null;
  }
  return { read, plan: floorPlan(text, read, taskId), taskId };
}

// Once a member's day, per ask: followed as its task (sweep.followed_as_task), own work with no task (sweep.own_work_no_task), or a
// mixed request's work part with no task (sweep.work_part_unclaimed). Writes only the decision log; never moves last_attempted_at.
export type DayDecision = "sweep.followed_as_task" | "sweep.own_work_no_task" | "sweep.work_part_unclaimed";
export async function logOnceADay(decision: DayDecision, row: { id: string | number; user_id: string; ask_text: string }, o: { taskId: number | null; day: string; sweep: string; work?: string | null }, db: Db = pool): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM harness_decisions WHERE decision = $1 AND user_id = $2 AND proposal->>'askId' = $3 AND proposal->>'day' = $4 LIMIT 1`, [decision, row.user_id, String(row.id), o.day]);
  if (rows.length) return false;
  const reason = decision === "sweep.followed_as_task" ? "followed as its task" : decision === "sweep.own_work_no_task" ? "Cue's own work with no task: searched whole" : "a mixed request's work part has no task: its find part is searched";
  await db.query(
    `INSERT INTO harness_decisions (layer, decision, user_id, outcome, action, proposal, checks, confidence, reason) VALUES (5, $1, $2, 'skip', $3, $4, '[]', NULL, $5)`,
    [decision, row.user_id, decision.replace(/^sweep\./, ""), JSON.stringify({ askId: String(row.id), ask: String(row.ask_text ?? "").slice(0, 160), taskId: o.taskId, day: o.day, sweep: o.sweep, ...(o.work ? { work: o.work.slice(0, 160) } : {}) }), reason],
  );
  return true;
}
// The note a plan leaves for the day, if any (followed, or a part with no task).
export async function notePlan(plan: FloorPlan, row: { id: string | number; user_id: string; ask_text: string }, o: { taskId: number | null; day: string; sweep: string }, db: Db = pool): Promise<void> {
  if (plan.followed) await logOnceADay("sweep.followed_as_task", row, o, db);
  else if (plan.note === "own_work_no_task") await logOnceADay("sweep.own_work_no_task", row, o, db);
  else if (plan.note === "work_part_unclaimed") await logOnceADay("sweep.work_part_unclaimed", row, { ...o, work: plan.split?.work ?? null }, db);
}

// ---------------------------------------------------------------- what the team sees (co-test /sweeps)

export type LegacyFlip = { askId: string; userId: string; firstName: string; text: string; createdAt: string; checkedAt: string };
type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
// A flip by the old morning job set kind_checked_at when it ran; an ask classified help at birth has it set when it was made. Later
// than an hour after the ask was made is "possibly flipped": a never-classified older ask classified late reads the same, so it's a
// list to look at, not a verdict. Paged, and filtered to Co's-own-work text before the cap, so the cap never hides one.
export const LEGACY_FLIP_GAP_MINUTES = 60;
export const LEGACY_FLIP_PAGE = 500;
export const LEGACY_FLIP_CAP = 200;
export async function legacyFlips(db: Db = pool): Promise<LegacyFlip[]> {
  const out: LegacyFlip[] = [];
  for (let offset = 0; out.length < LEGACY_FLIP_CAP; offset += LEGACY_FLIP_PAGE) {
    const { rows } = await db.query(
      `SELECT ac.id, ac.user_id, ac.ask_text, ac.created_at, ac.kind_checked_at, u.first_name FROM ask_checkins ac JOIN users u ON u.id = ac.user_id
        WHERE ac.resolved_at IS NULL AND ac.kind = 'help' AND u.archived_at IS NULL AND ac.kind_checked_at > ac.created_at + ($1 || ' minutes')::interval
        ORDER BY ac.created_at DESC, ac.id LIMIT $2 OFFSET $3`,
      [String(LEGACY_FLIP_GAP_MINUTES), LEGACY_FLIP_PAGE, offset],
    );
    for (const r of rows) if (isOwnWork(String(r.ask_text ?? ""))) out.push({ askId: String(r.id), userId: String(r.user_id), firstName: String(r.first_name ?? "(no name)"), text: String(r.ask_text ?? "").slice(0, 200), createdAt: new Date(r.created_at).toISOString(), checkedAt: new Date(r.kind_checked_at).toISOString() });
    if (rows.length < LEGACY_FLIP_PAGE) break;
  }
  return out.slice(0, LEGACY_FLIP_CAP);
}
// One ask.legacy_flip decision per flip, ever. Writes only the decision log; the ask is left exactly as it is.
export async function logLegacyFlips(db: Db = pool): Promise<number> {
  const flips = await legacyFlips(db);
  if (!flips.length) return 0;
  const { rows } = await db.query(`SELECT proposal->>'askId' AS id FROM harness_decisions WHERE decision = 'ask.legacy_flip'`, []);
  const logged = new Set(rows.map((r: any) => String(r.id)));
  let n = 0;
  for (const f of flips.filter((x) => !logged.has(x.askId))) {
    await db.query(
      `INSERT INTO harness_decisions (layer, decision, user_id, outcome, action, proposal, checks, confidence, reason) VALUES (5, 'ask.legacy_flip', $1, 'skip', 'listed', $2, '[]', NULL, $3)`,
      [f.userId, JSON.stringify({ askId: f.askId, text: f.text, createdAt: f.createdAt, checkedAt: f.checkedAt }), "possibly switched off by the old morning job; listed for the team, not corrected"],
    );
    n++;
  }
  return n;
}
// Own work nothing is carrying, for the team: work with no task, a mixed request's work part with no task, a work part a split left
// unclaimed. The latest per ask in the last week, with the member's first name. Reads only.
export type Unclaimed = { what: "own work with no task" | "work part with no task" | "work part unclaimed at creation"; firstName: string; text: string; work: string | null; at: string };
export async function unclaimedWork(days = 7, db: Db = pool): Promise<Unclaimed[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (d.decision, d.user_id, COALESCE(d.proposal->>'askId', d.proposal->>'ask')) d.decision, d.action, d.proposal, d.created_at, u.first_name
       FROM harness_decisions d JOIN users u ON u.id = d.user_id
      WHERE u.archived_at IS NULL AND d.created_at > NOW() - ($1 || ' days')::interval
        AND (d.decision IN ('sweep.own_work_no_task', 'sweep.work_part_unclaimed') OR (d.decision = 'ask.split' AND d.action = 'unclaimed'))
      ORDER BY d.decision, d.user_id, COALESCE(d.proposal->>'askId', d.proposal->>'ask'), d.created_at DESC`,
    [String(days)],
  );
  const what = (d: string): Unclaimed["what"] => (d === "sweep.own_work_no_task" ? "own work with no task" : d === "sweep.work_part_unclaimed" ? "work part with no task" : "work part unclaimed at creation");
  return rows.map((r: any) => ({ what: what(r.decision), firstName: String(r.first_name ?? "(no name)"), text: String(r.proposal?.ask ?? "").slice(0, 200), work: r.proposal?.work ? String(r.proposal.work).slice(0, 160) : null, at: new Date(r.created_at).toISOString() }))
    .sort((a: Unclaimed, b: Unclaimed) => (a.at < b.at ? 1 : -1));
}
