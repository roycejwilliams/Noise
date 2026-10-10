// What a member can do on a Co event page (Royce, spec 6 and 9: "Structured actions only: RSVP (going / maybe / can't),
// reactions, comments, and ask-Co-a-question. No free editing of page content by anyone but Co." / "Co can update the page from
// interactions ... the agent edits content, members never do.").
//
// Behind EVENT_PAGE_ACTIONS_ENABLED (Royce: "Interaction layer second, behind its own flag until I review it"). The repo
// otherwise has no feature toggles; this one is his explicit request. Off: the routes 404 and the page shows only the members line.
//
// Members only: every action names the member from their sealed page token (identity.ts), verified on every request.
// Every action is a row in event_page_actions AND a fact in the member's own record (memory.ts). A question also opens a Co task
// (services/coTasks.ts) so Co answers them in their own text thread, inside the task's pacing; nothing is sent from here.
// Page content changes only through applyInteractionUpdates, and Co's answer reaches the page only from Co's own tool
// (eventPageTools, the task turn), never from a member's words.
import { tool } from "ai";
import { z } from "zod";
import pool from "../../db/db.js";
import type { CoTask } from "../coTasks.js";
import { loadEventPage, updateEventPage, type EventPageData, type EventPageRecord } from "./contract.js";
import { pagePath } from "./identity.js";
import { factFor, realMemoryDeps, type ActionKind, type MemoryDeps } from "./memory.js";

export type { ActionKind } from "./memory.js";

// ---------------------------------------------------------------- the flag

export const ACTIONS_FLAG = "EVENT_PAGE_ACTIONS_ENABLED";
export function actionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(String(env[ACTIONS_FLAG] ?? "").trim());
}

// ---------------------------------------------------------------- the fixed vocabulary

export const ACTION_KINDS = ["rsvp", "reaction", "comment", "question"] as const;
export const RSVP_VALUES = ["going", "maybe", "cant"] as const;
export type RsvpValue = (typeof RSVP_VALUES)[number];
export const RSVP_LABEL: Record<RsvpValue, string> = { going: "Going", maybe: "Maybe", cant: "Can't make it" };
// A small fixed set. Anything else is refused.
export const REACTIONS = ["❤️", "🔥", "👏", "🥂"] as const;
export const TEXT_CAP: Record<"comment" | "question", number> = { comment: 500, question: 300 };
// Per member, across all pages (a rolling hour and day, counting every insert, retracted or not).
export const RATE_LIMITS: Record<ActionKind, { perHour: number; perDay: number }> = {
  rsvp: { perHour: 10, perDay: 30 },
  reaction: { perHour: 20, perDay: 60 },
  comment: { perHour: 5, perDay: 20 },
  question: { perHour: 3, perDay: 10 },
};

// What other members see of each other on a page. DECISION FOR ROYCE: the default is the most private sensible option.
//   headcount        how many members are going, shown only once at least `headcountMin` are (a count of one or two can point
//                    at a person)
//   reactionCounts   totals per reaction: off (a member sees only their own)
//   othersComments   off: a member sees only their own comments ("only you and Co see this"). Turn on only if Royce opts in;
//                    even then it's first name and words, never a question (questions are always private to the asker and Co)
export type VisibilityPolicy = { headcount: boolean; headcountMin: number; reactionCounts: boolean; othersComments: boolean };
export const VISIBILITY: VisibilityPolicy = { headcount: true, headcountMin: 3, reactionCounts: false, othersComments: false };

// ---------------------------------------------------------------- plain text

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#47": "/", "#x2f": "/" };
const decode = (s: string) => s.replace(/&(#?[a-z0-9]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);

// Pure: their words as plain text. Entities decoded then tags removed until nothing changes (so "&lt;b&gt;" can't come back as a
// tag), script/style bodies dropped, markdown emphasis, code and heading marks removed, a [label](url) link kept as its words and
// url, control characters gone, whitespace collapsed, capped. Rendering escapes again regardless.
export function plainText(input: unknown, cap: number): string {
  let s = String(input ?? "").normalize("NFC");
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = decode(s)
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\/?[a-z!][^<>]*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");
    if (s === before) break;
  }
  s = s
    .replace(/[<>]/g, " ")
    .replace(/!?\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, label, url) => `${label} ${url}`.trim())
    .replace(/(\*\*|__|~~|`+)/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = [...s];
  return chars.length > cap ? chars.slice(0, cap).join("").trim() : s;
}

// ---------------------------------------------------------------- the store

export type ActionRow = { id: string; pageId: string; userId: string; kind: ActionKind; value: string; createdAt: Date; retractedAt: Date | null };
export type PageSummary = { going: number; maybe: number; cant: number; reactions: Record<string, number> };
export type OthersComment = { firstName: string; text: string; at: Date };

export type ActionStore = {
  insert: (a: { pageId: string; userId: string; kind: ActionKind; value: string; at: Date }) => Promise<ActionRow>;
  // Retracts this member's live rows on this page that match; returns them. Only ever the member's own rows.
  retract: (w: { pageId: string; userId: string; kind?: ActionKind; value?: string; id?: string }) => Promise<ActionRow[]>;
  // This member's live rows on this page.
  mine: (pageId: string, userId: string) => Promise<ActionRow[]>;
  // Everything this member did of a kind since a moment (for rate limits), retracted or not.
  countSince: (userId: string, kind: ActionKind, since: Date) => Promise<number>;
  summary: (pageId: string) => Promise<PageSummary>;
  // Live comments by OTHER members (first name and words), read only when the policy shows them.
  othersComments: (pageId: string, exceptUserId: string) => Promise<OthersComment[]>;
  // Every member-written text on the page (comments and questions, live or not), for the never-pasted check on Co's answers.
  memberTexts: (pageId: string) => Promise<string[]>;
  // First names of everyone who acted on the page, for the no-names check on Co's answers.
  memberNames: (pageId: string) => Promise<string[]>;
  // A question row, by id, on this page.
  question: (pageId: string, id: string) => Promise<ActionRow | null>;
};

const rowOf = (r: any): ActionRow => ({
  id: String(r.id),
  pageId: String(r.page_id),
  userId: String(r.user_id),
  kind: r.kind,
  value: String(r.value ?? ""),
  createdAt: new Date(r.created_at),
  retractedAt: r.retracted_at ? new Date(r.retracted_at) : null,
});

export const pgActionStore: ActionStore = {
  insert: async (a) =>
    rowOf(
      (await pool.query(`INSERT INTO event_page_actions (page_id, user_id, kind, value, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [a.pageId, a.userId, a.kind, a.value, a.at]))
        .rows[0],
    ),
  retract: async (w) =>
    (
      await pool.query(
        `UPDATE event_page_actions SET retracted_at = NOW()
         WHERE page_id = $1 AND user_id = $2 AND retracted_at IS NULL
           AND ($3::text IS NULL OR kind = $3) AND ($4::text IS NULL OR value = $4) AND ($5::bigint IS NULL OR id = $5)
         RETURNING *`,
        [w.pageId, w.userId, w.kind ?? null, w.value ?? null, w.id ?? null],
      )
    ).rows.map(rowOf),
  mine: async (pageId, userId) =>
    (await pool.query(`SELECT * FROM event_page_actions WHERE page_id = $1 AND user_id = $2 AND retracted_at IS NULL ORDER BY created_at`, [pageId, userId])).rows.map(rowOf),
  countSince: async (userId, kind, since) =>
    Number((await pool.query(`SELECT COUNT(*)::int AS n FROM event_page_actions WHERE user_id = $1 AND kind = $2 AND created_at > $3`, [userId, kind, since])).rows[0]?.n ?? 0),
  summary: async (pageId) => {
    const { rows } = await pool.query(
      `SELECT a.kind, a.value, COUNT(*)::int AS n FROM event_page_actions a JOIN users u ON u.id = a.user_id AND u.archived_at IS NULL
       WHERE a.page_id = $1 AND a.retracted_at IS NULL AND a.kind IN ('rsvp', 'reaction') GROUP BY a.kind, a.value`,
      [pageId],
    );
    const s: PageSummary = { going: 0, maybe: 0, cant: 0, reactions: {} };
    for (const r of rows) {
      if (r.kind === "rsvp" && (RSVP_VALUES as readonly string[]).includes(r.value)) s[r.value as RsvpValue] = Number(r.n);
      if (r.kind === "reaction") s.reactions[r.value] = Number(r.n);
    }
    return s;
  },
  othersComments: async (pageId, exceptUserId) =>
    (
      await pool.query(
        `SELECT u.first_name, a.value, a.created_at FROM event_page_actions a JOIN users u ON u.id = a.user_id AND u.archived_at IS NULL
         WHERE a.page_id = $1 AND a.kind = 'comment' AND a.retracted_at IS NULL AND a.user_id <> $2 ORDER BY a.created_at DESC LIMIT 30`,
        [pageId, exceptUserId],
      )
    ).rows.map((r: any) => ({ firstName: String(r.first_name ?? "").trim() || "A member", text: String(r.value), at: new Date(r.created_at) })),
  memberTexts: async (pageId) =>
    (await pool.query(`SELECT value FROM event_page_actions WHERE page_id = $1 AND kind IN ('comment', 'question')`, [pageId])).rows.map((r: any) => String(r.value)),
  memberNames: async (pageId) =>
    (
      await pool.query(
        `SELECT DISTINCT u.first_name, u.last_name FROM event_page_actions a JOIN users u ON u.id = a.user_id WHERE a.page_id = $1`,
        [pageId],
      )
    ).rows.flatMap((r: any) => [r.first_name, r.last_name].map((n) => String(n ?? "").trim()).filter((n) => n.length >= 2)),
  question: async (pageId, id) => {
    if (!/^\d+$/.test(id)) return null;
    const r = (await pool.query(`SELECT * FROM event_page_actions WHERE page_id = $1 AND id = $2 AND kind = 'question'`, [pageId, id])).rows[0];
    return r ? rowOf(r) : null;
  },
};

// ---------------------------------------------------------------- asking Co a question: a task, answered in their thread

// The marker in a page question's task goal: how the task turn knows which page and question it's about (eventPageTools).
export const QUESTION_MARKER = /\[event page ([^\s\]]{1,80}) question (\d{1,18})\]/;

export type QuestionQueue = (q: { userId: string; pageId: string; actionId: string; title: string; text: string }) => Promise<{ ok: boolean; why?: string; taskId?: number }>;

// Pure: a page question's task goal. The marker goes before the title, so the 200-character goal cap never cuts it.
export function questionGoal(title: string, url: string, pageId: string, actionId: string): string {
  const marker = `[event page ${pageId} question ${actionId}]`;
  const head = `Answer their question from Co's event page ${marker}, ${url}, for "`;
  const room = Math.max(0, 200 - head.length - 1);
  return `${head}${title.trim().slice(0, Math.min(60, room))}"`;
}

// The real queue: a Co task (services/coTasks.ts startTask). It wakes within the hour, reads the page (the public page, never a
// member's view), and answers them by text through the task's own pacing and checks. Their words are the task's quote.
export const coTaskQueue: QuestionQueue = async (q) => {
  const { startTask } = await import("../coTasks.js");
  const base = (process.env.API_URL ?? "").replace(/\/+$/, "");
  const url = base ? `${base}${pagePath(q.pageId)}` : pagePath(q.pageId);
  const r = await startTask({
    userId: q.userId,
    goal: questionGoal(q.title, url, q.pageId, q.actionId),
    theirWords: q.text,
    steps: [{ text: "Read the event page", done: false }, { text: "Answer them by text", done: false }],
    firstPlan: "Read the event page with readPage, then answer them by text. If the answer would help every guest, also put it on the page with answerOnEventPage, in your own words and naming no one.",
    inHours: 1,
    source: "ask",
  });
  return r.ok ? { ok: true, taskId: r.task.id } : { ok: false, why: r.why };
};

// ---------------------------------------------------------------- taking an action

export type ActionDeps = {
  store: ActionStore;
  memory: MemoryDeps;
  loadPage: (id: string) => Promise<EventPageRecord | null>;
  queueQuestion: QuestionQueue;
  now: () => Date;
};
export const realActionDeps = (): ActionDeps => ({ store: pgActionStore, memory: realMemoryDeps, loadPage: loadEventPage, queueQuestion: coTaskQueue, now: () => new Date() });

export type ActionInput =
  | { kind: "rsvp"; value: unknown }
  | { kind: "reaction"; value: unknown; on?: boolean }
  | { kind: "comment"; text: unknown }
  | { kind: "question"; text: unknown }
  | { kind: "retract"; id: unknown };

export type ActionResult =
  | { ok: true; did: string; action: ActionRow | null; queued?: boolean }
  | { ok: false; status: 400 | 404 | 409 | 429 | 503; error: string };

const isArchived = (p: EventPageRecord) => !!p.archivedAt;

// Pure: over the limit for this kind?
export function overLimit(kind: ActionKind, hour: number, day: number): string | null {
  const L = RATE_LIMITS[kind];
  if (hour >= L.perHour) return `That's a lot of those in the last hour. Try again a little later.`;
  if (day >= L.perDay) return `That's the limit for today. Try again tomorrow.`;
  return null;
}

async function limited(kind: ActionKind, userId: string, d: ActionDeps): Promise<string | null> {
  const now = d.now().getTime();
  const [hour, day] = await Promise.all([d.store.countSince(userId, kind, new Date(now - 3_600_000)), d.store.countSince(userId, kind, new Date(now - 86_400_000))]);
  return overLimit(kind, hour, day);
}

// Writes the action's fact; if the member's record can't take it, the action is taken back (every action is also memory).
async function remember(row: ActionRow, title: string, d: ActionDeps): Promise<boolean> {
  try {
    await d.memory.write(factFor({ userId: row.userId, pageId: row.pageId, actionId: row.id, kind: row.kind, value: row.value, title, at: row.createdAt }));
    return true;
  } catch (err: any) {
    console.error("event page: memory write failed, taking the action back:", err?.message ?? err);
    await d.store.retract({ pageId: row.pageId, userId: row.userId, id: row.id }).catch(() => {});
    return false;
  }
}

const NOT_SAVED: ActionResult = { ok: false, status: 503, error: "That didn't save. Try again in a moment." };

// One member's action on one page. The member is already verified (identity.ts); pageId and userId never come from the body.
export async function takeAction(pageId: string, userId: string, input: ActionInput, d: ActionDeps): Promise<ActionResult> {
  const page = await d.loadPage(pageId);
  if (!page || isArchived(page)) return { ok: false, status: 404, error: "This page isn't here." };
  const title = String(page.data?.title ?? "");
  const at = d.now();

  if (input.kind === "retract") {
    const id = String(input.id ?? "");
    if (!/^\d{1,18}$/.test(id)) return { ok: false, status: 400, error: "Nothing to take back." };
    const mine = (await d.store.mine(pageId, userId)).find((r) => r.id === id);
    // RSVPs change by choosing another; only their own comments, questions and reactions are taken back.
    if (!mine || mine.kind === "rsvp") return { ok: false, status: 404, error: "Nothing to take back." };
    const gone = await d.store.retract({ pageId, userId, id });
    await d.memory.retire(userId, gone.map((g) => g.id)).catch(() => {});
    return { ok: true, did: `took back a ${mine.kind}`, action: null };
  }

  const kind = input.kind;
  const over = await limited(kind, userId, d);
  if (over) return { ok: false, status: 429, error: over };

  if (kind === "rsvp") {
    const value = String(input.value ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (!(RSVP_VALUES as readonly string[]).includes(value)) return { ok: false, status: 400, error: "Choose going, maybe or can't." };
    const current = (await d.store.mine(pageId, userId)).find((r) => r.kind === "rsvp");
    if (current?.value === value) return { ok: true, did: "rsvp unchanged", action: current };
    const old = await d.store.retract({ pageId, userId, kind: "rsvp" });
    const row = await d.store.insert({ pageId, userId, kind, value, at });
    if (!(await remember(row, title, d))) return NOT_SAVED;
    await d.memory.retire(userId, old.map((o) => o.id)).catch(() => {});
    return { ok: true, did: `rsvp ${value}`, action: row };
  }

  if (kind === "reaction") {
    const value = String(input.value ?? "").trim();
    if (!(REACTIONS as readonly string[]).includes(value)) return { ok: false, status: 400, error: "That reaction isn't one of the set." };
    const has = (await d.store.mine(pageId, userId)).find((r) => r.kind === "reaction" && r.value === value);
    const on = input.on ?? !has;
    if (!on) {
      const gone = has ? await d.store.retract({ pageId, userId, kind, value }) : [];
      await d.memory.retire(userId, gone.map((g) => g.id)).catch(() => {});
      return { ok: true, did: "reaction removed", action: null };
    }
    if (has) return { ok: true, did: "reaction unchanged", action: has };
    const row = await d.store.insert({ pageId, userId, kind, value, at });
    if (!(await remember(row, title, d))) return NOT_SAVED;
    return { ok: true, did: "reaction added", action: row };
  }

  // comment or question: their words, plain and capped
  const text = plainText(input.text, TEXT_CAP[kind]);
  if (!text) return { ok: false, status: 400, error: kind === "question" ? "Write your question first." : "Write something first." };
  const row = await d.store.insert({ pageId, userId, kind, value: text, at });
  if (!(await remember(row, title, d))) return NOT_SAVED;
  if (kind === "comment") return { ok: true, did: "comment added", action: row };
  const q = await d.queueQuestion({ userId, pageId, actionId: row.id, title, text }).catch((err: any) => ({ ok: false, why: String(err?.message ?? err) }));
  // Not queued (five open tasks, say): the question is still in their record, and a text reply shows it as unanswered.
  if (!q.ok) console.error(`event page: question ${row.id} not queued as a task (${q.why ?? "unknown"}); it stays in their record`);
  return { ok: true, did: "question asked", action: row, queued: q.ok };
}

// ---------------------------------------------------------------- what the viewer sees (data for actionsView.ts)

export type MemberState = { rsvp: RsvpValue | null; reactions: string[]; comments: { id: string; text: string; at: Date }[]; questions: { id: string; text: string; at: Date }[] };
export type PageView = { headcountLine: string | null; reactionCounts: Record<string, number> | null; othersComments: OthersComment[] };

// Pure: the headcount line, or null under the threshold (or when the policy hides it).
export function headcountLine(s: PageSummary, policy: VisibilityPolicy = VISIBILITY): string | null {
  if (!policy.headcount || s.going < Math.max(1, policy.headcountMin)) return null;
  return `${s.going} members going`;
}

// Pure: one member's own live rows as their state.
export function stateOf(rows: ActionRow[]): MemberState {
  const live = rows.filter((r) => !r.retractedAt);
  const rsvp = live.filter((r) => r.kind === "rsvp").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return {
    rsvp: rsvp && (RSVP_VALUES as readonly string[]).includes(rsvp.value) ? (rsvp.value as RsvpValue) : null,
    reactions: live.filter((r) => r.kind === "reaction").map((r) => r.value),
    comments: live.filter((r) => r.kind === "comment").map((r) => ({ id: r.id, text: r.value, at: r.createdAt })),
    questions: live.filter((r) => r.kind === "question").map((r) => ({ id: r.id, text: r.value, at: r.createdAt })),
  };
}

// What a member sees: their own state, plus only what the policy shows of everyone else.
export async function memberView(pageId: string, userId: string, store: ActionStore, policy: VisibilityPolicy = VISIBILITY): Promise<{ state: MemberState; page: PageView }> {
  const [rows, summary, others] = await Promise.all([
    store.mine(pageId, userId),
    store.summary(pageId),
    policy.othersComments ? store.othersComments(pageId, userId) : Promise.resolve([] as OthersComment[]),
  ]);
  return {
    state: stateOf(rows),
    page: { headcountLine: headcountLine(summary, policy), reactionCounts: policy.reactionCounts ? summary.reactions : null, othersComments: policy.othersComments ? others : [] },
  };
}

// ---------------------------------------------------------------- Co updates the page

// Pure: what's wrong with text Co wants on the page (its rephrased question or its answer). Co's words only: never a member's
// pasted (any run of six words from a member's comment or question), never a member's name, plain text, Co's voice.
export function coPageTextProblems(text: string, o: { memberTexts: string[]; memberNames: string[]; cap: number }): string[] {
  const out: string[] = [];
  const t = String(text ?? "").trim();
  if (!t) return ["it's empty"];
  if ([...t].length > o.cap) out.push(`it's over ${o.cap} characters`);
  if (plainText(t, o.cap * 2) !== t.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim()) out.push("it has markup; write plain text");
  if (/[—–]/.test(t)) out.push("it has a dash; use a comma or a period");
  if (/!/.test(t)) out.push("it has an exclamation point");
  if (/\b(?:I'm|I am|as) (?:your |the |an? )?(?:assistant|matchmaker|AI|bot|host)\b/i.test(t)) out.push("it calls Co by a role; Co is just Co");
  const words = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9']+/g) ?? [];
  const mine = words(t).join(" ");
  const RUN = 6;
  for (const m of o.memberTexts) {
    const w = words(m);
    for (let i = 0; i + RUN <= w.length; i++) {
      if (` ${mine} `.includes(` ${w.slice(i, i + RUN).join(" ")} `)) {
        out.push("it repeats a member's own words; say it in your own words");
        i = w.length;
      }
    }
    if (out.some((p) => p.startsWith("it repeats"))) break;
  }
  for (const n of o.memberNames) {
    if (n.length >= 2 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t)) {
      out.push("it names a member; the page names no one");
      break;
    }
  }
  return out;
}

export const ANSWER_CAP = { question: 200, answer: 400 };

// Pure: the page's notes with one answered question added (once: the same question isn't added twice).
export function notesWithAnswer(notes: string | null | undefined, question: string, answer: string): string {
  const base = String(notes ?? "").trim();
  const q = `Q: ${question.trim()}`;
  if (base.split("\n").some((l) => l.trim().toLowerCase() === q.toLowerCase())) return base;
  return `${base}${base ? "\n\n" : ""}${q}\nA: ${answer.trim()}`;
}

export type UpdateDeps = {
  store: ActionStore;
  loadPage: (id: string) => Promise<EventPageRecord | null>;
  updatePage: (id: string, data: EventPageData) => Promise<{ version: number }>;
  policy?: VisibilityPolicy;
};
export const realUpdateDeps = (): UpdateDeps => ({ store: pgActionStore, loadPage: loadEventPage, updatePage: updateEventPage });

// Co's answer for the page. Only eventPageTools builds one (from Co's tool input); a member's request never reaches here.
export type CoAnswer = { by: "co"; questionId: string; question: string; answer: string };

export type UpdateResult = { ok: true; derived: { headcountLine: string | null }; version: number | null } | { ok: false; why: string };

// Recomputes what the page derives from interactions and, when Co answers a question for every guest, writes it to the page's
// notes through the content layer (the version bumps). The headcount is derived live in the actions slot (actionsView.ts), so it's
// never stale and never bumps the version; it's returned here for whoever wants it.
export async function applyInteractionUpdates(pageId: string, opts: { answer?: CoAnswer } = {}, d: UpdateDeps = realUpdateDeps()): Promise<UpdateResult> {
  const page = await d.loadPage(pageId);
  if (!page) return { ok: false, why: "no such page" };
  const derived = { headcountLine: headcountLine(await d.store.summary(pageId), d.policy ?? VISIBILITY) };
  const a = opts.answer;
  if (!a) return { ok: true, derived, version: null };
  if (a.by !== "co") return { ok: false, why: "only Co writes the page" };
  if (isArchived(page)) return { ok: false, why: "the page is archived" };
  const q = await d.store.question(pageId, a.questionId);
  if (!q || q.kind !== "question") return { ok: false, why: "that question isn't on this page" };
  const [memberTexts, memberNames] = await Promise.all([d.store.memberTexts(pageId), d.store.memberNames(pageId)]);
  const problems = [
    ...coPageTextProblems(a.question, { memberTexts, memberNames, cap: ANSWER_CAP.question }).map((p) => `the question: ${p}`),
    ...coPageTextProblems(a.answer, { memberTexts, memberNames, cap: ANSWER_CAP.answer }).map((p) => `the answer: ${p}`),
  ];
  if (problems.length) return { ok: false, why: problems.join("; ") };
  const notes = notesWithAnswer(page.data.notes ?? null, a.question, a.answer);
  if (notes === String(page.data.notes ?? "").trim()) return { ok: true, derived, version: page.version };
  const { version } = await d.updatePage(pageId, { ...page.data, notes });
  return { ok: true, derived, version };
}

// The task turn's page tool (services/taskTurn.ts spreads this into its tools): only for a task opened from a page question,
// only while the flag is on. Co writes the question in its own words and the answer; code checks both before the page changes.
export function eventPageTools(task: Pick<CoTask, "goal">, env: NodeJS.ProcessEnv = process.env, deps: () => UpdateDeps = realUpdateDeps): Record<string, any> {
  if (!actionsEnabled(env)) return {};
  const m = String(task.goal ?? "").match(QUESTION_MARKER);
  if (!m) return {};
  const [, pageId, questionId] = m;
  return {
    answerOnEventPage: tool({
      description:
        "Put this question and your answer on the event page itself, for every guest, when the answer helps everyone (where to park, what to wear, when doors open). Write the question in your own words and never name or quote anyone; answer only from what the page or your verified results say. Still answer them by text. Skip it for anything personal to them.",
      inputSchema: z.object({ question: z.string().describe("The question, in your own words, naming no one."), answer: z.string().describe("Your answer, plain and short.") }),
      execute: async ({ question, answer }) => {
        const r = await applyInteractionUpdates(pageId, { answer: { by: "co", questionId, question, answer } }, deps()).catch((err: any) => ({ ok: false as const, why: String(err?.message ?? err) }));
        return r.ok ? { ok: true, note: "It's on the page." } : { ok: false, error: `Not on the page: ${r.why}.` };
      },
    }),
  };
}
