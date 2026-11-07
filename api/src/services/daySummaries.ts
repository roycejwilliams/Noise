// Rolling daily summaries of older conversation (Cue Memory Spec step 10, Royce's approved spec).
//
//   - Recent words go in full (services/threadWindow.ts). Each OLDER day becomes one dated summary per member, kept as the window moves.
//   - A summary is Cue's own note, labelled as one, never quoted as the member's words, and it links to the rows it was built from
//     (member_day_summaries.source_ids; the date also finds them through recall).
//   - Forget by default: a summary is only shown while every line it was built from still reads the same through the live removal and
//     correction guards. A line that was removed, corrected or deleted afterwards changes the stamp; the summary is then withheld at
//     once and deleted, and the day is summarized once more from the guarded lines (or not at all when nothing is left).
//   - No other member's details: the input lines and the written summary both go through the member fence (the name strip), and every
//     read is user_id = $1. Nothing here reads another member's rows.
//
// THE JOB IS NOT SCHEDULED. runDaySummariesJob is exported and nothing registers it (jobs/index.ts has no cron for it; a layer-1 check
// holds that). It makes paid model calls (Haiku), so it stays off until Royce approves the spend. Reading is free and harmless with
// an empty table: until the job has run, the reply and the call get no block.
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { notToTeammate, withoutTeammateLines } from "./teamLines.js";
import { wordsZone } from "./memberTime.js";
import { guardText, type ForgottenRow } from "./whatCoKnows.js";
import type { Strip } from "./sourceFence.js";

export type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
export type SrcRow = { id: string; memory_type: string; content: string; created_at: Date | string };

export const SUMMARY = {
  // The reply and a call show at most this many of the most recent summaries, inside blockChars together.
  recentN: 7,
  blockChars: 2200,
  lineChars: 420,
  // A day is summarized once it is at least this many local days back (yesterday stays in the thread window).
  minAgeDays: 2,
  lookbackDays: 60,
  // Input to one summary, and per run, so one busy day or a backfill is bounded.
  maxInputChars: 12_000,
  minInputChars: 240,
  maxDaysPerRun: 60,
  maxOutputTokens: 300,
  maxSummaryChars: 900,
} as const;

export const SUMMARY_HEAD =
  "Earlier, in summary. Cue's own dated notes of older days, written after the fact. They are not their words and never a quote: do not say they said something because it is here. A detail in one may be out of date or wrong; if it matters, look the day up in their record before leaning on it.";

// Model-facing: the instruction for one day (the Copy section of the PR). Haiku, one call per day.
export const SUMMARY_PROMPT = `You are writing a short dated note for Cue, a member's companion, about ONE past day of the member's conversation with Cue. The lines below are that day, oldest first: "User said" is the member, and the other lines are Cue.
Write 2 to 4 plain sentences about what the member was in the middle of that day: what they were dealing with, what they asked Cue for, what was decided or left open, and how they seemed. Use "they" for the member and "Cue" for Cue.
Rules:
- Only what the lines say. Never invent, never guess a reason, never add anything from outside the lines.
- Never quote them: no quotation marks, no sentence of theirs repeated word for word.
- Say who did what: what they told Cue is different from what Cue offered or found.
- Leave out another person's contact details, and any detail about anyone that is not needed to understand the member's day.
- If the day was only logistics or small talk, say so in one short sentence.
Return the note only.`;

// ---------------------------------------------------------------- pure

export const dayOf = (at: Date | string, zone: string | null | undefined): string => DateTime.fromJSDate(new Date(at)).setZone(wordsZone(zone)).toISODate()!;

// Pure: the last local day that is old enough to summarize.
export const lastSummarizableDay = (now: Date, zone: string | null | undefined): string =>
  DateTime.fromJSDate(now).setZone(wordsZone(zone)).minus({ days: SUMMARY.minAgeDays }).toISODate()!;

// Pure: whether a stored row is part of Cue's conversation with the member (text or call), not a note to a teammate, a search marker or
// a call Cue only placed.
export function isConversationRow(r: Pick<SrcRow, "memory_type" | "content">): boolean {
  const c = String(r.content ?? "");
  if (r.memory_type === "text_exchange") return !c.startsWith("Co is looking:") && withoutTeammateLines(c).trim() === c.trim() && c.trim() !== "";
  if (r.memory_type === "call_transcript") return !c.startsWith("Co initiated call") && c.trim() !== "";
  return false;
}

// Pure: one row as lines for the model or the stamp, through the removal and correction guards. A call's "user:"/"assistant:" lines
// are labelled like texts. Lines the guard drops are gone.
export function guardedLines(r: Pick<SrcRow, "memory_type" | "content">, guards: ForgottenRow[]): string[] {
  const body = String(r.content ?? "");
  const parts = r.memory_type === "call_transcript"
    ? body.split("\n").map((l) => l.replace(/^user:\s*/i, "User said (on a call): ").replace(/^assistant:\s*/i, "Cue said (on a call): "))
    : [body];
  return parts.flatMap((p) => { const g = guardText(p, guards); return g === null || !g.trim() ? [] : [g]; });
}

// Pure: the stamp of a set of source rows as the guards read them now. Same rows read the same way give the same stamp; a row that
// was removed, corrected or deleted changes it.
export function stampOf(rows: Pick<SrcRow, "id" | "memory_type" | "content">[], guards: ForgottenRow[]): string {
  const h = createHash("sha1");
  for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) h.update(`${r.id}\n${guardedLines(r, guards).join("\n")}\n--\n`);
  return h.digest("hex").slice(0, 16);
}

export type DayInput = { day: string; rows: SrcRow[]; lines: string[]; text: string };
// Pure: a member's rows grouped into local days, each as the model's input (guarded, name-stripped). Days with too little to say are
// left out (no row, no cost). Input over the cap keeps the start and the end of the day.
export function dayInputs(rows: SrcRow[], zone: string | null | undefined, guards: ForgottenRow[], strip: Strip): DayInput[] {
  const byDay = new Map<string, SrcRow[]>();
  for (const r of rows) if (isConversationRow(r)) byDay.set(dayOf(r.created_at, zone), [...(byDay.get(dayOf(r.created_at, zone)) ?? []), r]);
  const out: DayInput[] = [];
  for (const [day, rs] of byDay) {
    const sorted = [...rs].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at) || a.id.localeCompare(b.id));
    const lines = sorted.flatMap((r) => guardedLines(r, guards)).flatMap((l) => { const s = strip(l); return s && s.trim() ? [s] : []; });
    let text = lines.join("\n");
    if (text.length < SUMMARY.minInputChars) continue;
    if (text.length > SUMMARY.maxInputChars) {
      const half = Math.floor(SUMMARY.maxInputChars / 2);
      text = `${text.slice(0, half)}\n[the middle of the day is left out]\n${text.slice(-half)}`;
    }
    out.push({ day, rows: sorted, lines, text });
  }
  return out.sort((a, b) => b.day.localeCompare(a.day));
}

// Pure: what the model wrote, made safe to store: no quotation marks (never a quote), stripped of other members' names, bounded.
// null when nothing is left.
export function cleanSummary(raw: string | null | undefined, strip: Strip): string | null {
  let t = String(raw ?? "").replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length > SUMMARY.maxSummaryChars) { const cut = t.slice(0, SUMMARY.maxSummaryChars); t = cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, cut.lastIndexOf(" "))).trim(); }
  const s = strip(t);
  return s && s.trim() ? s.trim() : null;
}

export type StoredSummary = { id: string; day: string; summary: string; source_ids: string[]; source_stamp: string };

// Pure: whether a stored summary still stands: every source row is there and reads the same through the guards as when it was built.
export function stillStands(s: Pick<StoredSummary, "source_ids" | "source_stamp">, sources: Pick<SrcRow, "id" | "memory_type" | "content">[], guards: ForgottenRow[]): boolean {
  const mine = sources.filter((r) => s.source_ids.includes(r.id));
  return mine.length === s.source_ids.length && stampOf(mine, guards) === s.source_stamp;
}

const dayLabel = (day: string, now: Date, zone: string | null | undefined): string => {
  const d = DateTime.fromISO(day, { zone: wordsZone(zone) });
  return d.toFormat(d.year === DateTime.fromJSDate(now).setZone(wordsZone(zone)).year ? "ccc LLL d" : "ccc LLL d, yyyy");
};

// Pure: the "earlier, in summary" block: the most recent summaries that fit, shown oldest first, each labelled as a summary with its
// date and how many lines it covers. Empty when there are none.
export function summaryBlock(items: { day: string; summary: string; sources: number }[], now: Date, zone: string | null | undefined, o: { n?: number; chars?: number } = {}): string {
  const n = o.n ?? SUMMARY.recentN;
  const chars = o.chars ?? SUMMARY.blockChars;
  const picked: string[] = [];
  let used = SUMMARY_HEAD.length;
  for (const it of [...items].sort((a, b) => b.day.localeCompare(a.day)).slice(0, n)) {
    const text = it.summary.length > SUMMARY.lineChars ? `${it.summary.slice(0, SUMMARY.lineChars).replace(/\s+\S*$/, "")} [cut]` : it.summary;
    const line = `- ${dayLabel(it.day, now, zone)} (summary of ${it.sources} line${it.sources === 1 ? "" : "s"}): ${text}`;
    if (used + line.length + 1 > chars) break;
    picked.push(line);
    used += line.length + 1;
  }
  return picked.length ? `${SUMMARY_HEAD}\n${picked.reverse().join("\n")}` : "";
}

// ---------------------------------------------------------------- read (free, per reply)

// The block a reply or a call gets for one member. before: the oldest moment already shown in full in the thread window, so a day the
// window holds is never summarized on top of its own words. Fails closed on anything unreadable: no block, never an error.
export async function earlierSummaryBlock(
  userId: string,
  o: { strip: Strip; fenceFailed?: boolean; guards: ForgottenRow[] | null; zone: string | null | undefined; windowOldest?: Date | null; now?: Date },
  db: Db = pool,
): Promise<string> {
  try {
    // The guards or the names could not be read: nothing is shown rather than a summary that may carry what was removed.
    if (o.fenceFailed || o.guards === null) return "";
    const now = o.now ?? new Date();
    const cutoff = o.windowOldest ? dayOf(o.windowOldest, o.zone) : "9999-12-31";
    const { rows } = await db.query(
      `SELECT id::text AS id, to_char(day, 'YYYY-MM-DD') AS day, summary, source_ids, source_stamp FROM member_day_summaries
       WHERE user_id = $1 AND day < $2::date ORDER BY day DESC LIMIT $3`,
      [userId, cutoff, SUMMARY.recentN * 2],
    );
    if (!rows.length) return "";
    const ids = [...new Set(rows.flatMap((r: any) => r.source_ids as string[]))];
    const src = ids.length ? (await db.query(`SELECT id::text AS id, memory_type, content FROM co_memories WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, ids])).rows : [];
    const good: { day: string; summary: string; sources: number }[] = [];
    const stale: string[] = [];
    for (const r of rows as StoredSummary[]) {
      if (!stillStands(r, src, o.guards)) { stale.push(r.id); continue; }
      const text = guardText(r.summary, o.guards);
      const safe = text === null ? null : o.strip(text);
      if (safe && safe.trim()) good.push({ day: r.day, summary: safe.trim(), sources: r.source_ids.length });
    }
    // Forget by default: a summary built on a line that was since removed or corrected is deleted now (free). Its day is summarized again
    // by the job, once, from the guarded lines.
    if (stale.length) db.query(`DELETE FROM member_day_summaries WHERE user_id = $1 AND id::text = ANY($2::text[])`, [userId, stale]).catch(() => {});
    return summaryBlock(good, now, o.zone);
  } catch {
    return "";
  }
}

// The block for a text reply or a call, reading what it needs itself: nothing (and no further reads) while the member has no summaries.
// windowOldest: the oldest row the thread window shows in full. strip: the member fence's strip when the caller already has one.
export async function earlierSummaryFor(userId: string, o: { windowOldest?: Date | null; strip?: Strip; fenceFailed?: boolean; zone?: string | null } = {}, db: Db = pool): Promise<string> {
  try {
    if (!(await db.query(`SELECT 1 FROM member_day_summaries WHERE user_id = $1 LIMIT 1`, [userId])).rows.length) return "";
    const [guards, fence, zone] = await Promise.all([
      import("./whatCoKnows.js").then((W) => W.forgottenRows(userId, db as any, { all: true })).catch(() => null),
      o.strip ? Promise.resolve({ strip: o.strip, failed: !!o.fenceFailed }) : import("./sourceFence.js").then((F) => F.memberFence(userId)).catch(() => ({ strip: (() => null) as Strip, failed: true })),
      o.zone !== undefined ? Promise.resolve(o.zone) : import("./memberTime.js").then((T) => T.memberZone(userId)).catch(() => null),
    ]);
    return await earlierSummaryBlock(userId, { strip: fence.strip, fenceFailed: !!fence.failed, guards, zone, windowOldest: o.windowOldest }, db);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- the job (paid, not scheduled)

export type JobDeps = {
  db: Db;
  now: Date;
  // One Haiku call for one day. Returns the model's text, or null.
  summarize: (userId: string, input: { day: string; text: string }) => Promise<string | null>;
  fenceFor: (userId: string) => Promise<{ strip: Strip; failed?: boolean }>;
  guardsFor: (userId: string) => Promise<ForgottenRow[] | null>;
  zoneFor: (userId: string) => Promise<string | null>;
  maxDays?: number;
};
export type JobResult = { members: number; days: number; written: number; skipped: number; failed: number };

// One run: for each member with older conversation, every day old enough that has no summary and enough to say. Newest days first,
// at most maxDaysPerRun in all. A day with a summary is never summarized again (ON CONFLICT DO NOTHING); a summary deleted for
// forgetting is the only way a day comes round again. Only the member's own rows are read (user_id = $1).
export async function runDaySummaries(d: JobDeps): Promise<JobResult> {
  const res: JobResult = { members: 0, days: 0, written: 0, skipped: 0, failed: 0 };
  const budget = d.maxDays ?? SUMMARY.maxDaysPerRun;
  const since = new Date(d.now.getTime() - SUMMARY.lookbackDays * 86_400_000);
  const upto = new Date(d.now.getTime() - SUMMARY.minAgeDays * 86_400_000 + 86_400_000);
  const who = await d.db.query(
    `SELECT DISTINCT m.user_id::text AS user_id FROM co_memories m JOIN users u ON u.id = m.user_id
     WHERE u.archived_at IS NULL AND m.memory_type IN ('text_exchange', 'call_transcript') AND m.created_at >= $1 AND m.created_at < $2`,
    [since, upto],
  );
  for (const { user_id: userId } of who.rows as { user_id: string }[]) {
    if (res.days >= budget) break;
    res.members++;
    try {
      const fence = await d.fenceFor(userId);
      const guards = await d.guardsFor(userId);
      // Unreadable names or guards: this member's days wait (never a summary that may carry another member's details or removed words).
      if (fence.failed || guards === null) { res.skipped++; continue; }
      const zone = await d.zoneFor(userId);
      const last = lastSummarizableDay(d.now, zone);
      const have = new Set((await d.db.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM member_day_summaries WHERE user_id = $1`, [userId])).rows.map((r: any) => r.day as string));
      const rows = (await d.db.query(
        `SELECT id::text AS id, memory_type, content, created_at FROM co_memories
         WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript') AND created_at >= $2 AND created_at < $3
           AND (memory_type <> 'text_exchange' OR ${notToTeammate()}) ORDER BY created_at, id`,
        [userId, since, upto],
      )).rows as SrcRow[];
      for (const day of dayInputs(rows, zone, guards, fence.strip)) {
        if (res.days >= budget) break;
        if (day.day > last || have.has(day.day)) continue;
        res.days++;
        const text = cleanSummary(await d.summarize(userId, { day: day.day, text: day.text }).catch(() => null), fence.strip);
        if (!text) { res.failed++; continue; }
        await d.db.query(
          `INSERT INTO member_day_summaries (user_id, day, zone, summary, source_ids, source_stamp, model) VALUES ($1, $2::date, $3, $4, $5::text[], $6, $7)
           ON CONFLICT (user_id, day) DO NOTHING`,
          [userId, day.day, zone, text, day.rows.map((r) => r.id), stampOf(day.rows, guards), "haiku"],
        );
        res.written++;
      }
    } catch (err: any) {
      res.failed++;
      console.error("day summaries: a member's run failed (non-fatal):", err?.message ?? err);
    }
  }
  return res;
}

// The real dependencies. This is the only place that spends: one Haiku call per day, under the member's cost mark.
export async function realJobDeps(now = new Date()): Promise<JobDeps> {
  const [{ generateText }, { anthropic }, { MODELS }, { withMember }, { withTraceUser }, W, F, T] = await Promise.all([
    import("ai"), import("@ai-sdk/anthropic"), import("../models.js"), import("./llmUsage.js"), import("./llmTraceText.js"), import("./whatCoKnows.js"), import("./sourceFence.js"), import("./memberTime.js"),
  ]);
  return {
    db: pool,
    now,
    summarize: (userId, i) =>
      withTraceUser(userId, () => withMember(userId, async () =>
        (await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: SUMMARY.maxOutputTokens, experimental_telemetry: { isEnabled: true, functionId: "memory.daySummary" }, system: SUMMARY_PROMPT, prompt: `Day: ${i.day}\n\n${i.text}`, abortSignal: AbortSignal.timeout(30_000) })).text)),
    fenceFor: (u) => F.memberFence(u).catch(() => ({ strip: () => null, failed: true })),
    guardsFor: (u) => W.forgottenRows(u, pool, { all: true }).catch(() => null),
    zoneFor: (u) => T.memberZone(u).catch(() => null),
  };
}

// The one entry point. NOT registered with any schedule (see the top of this file and the PR).
export async function runDaySummariesJob(): Promise<JobResult> {
  return runDaySummaries(await realJobDeps());
}
