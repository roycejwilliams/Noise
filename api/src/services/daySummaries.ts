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
//   - Visible and removable (Royce 2026-11-06, ruling 5): each 'ok' summary is a line in what Cue knows (services/whatCoKnows.ts,
//     group "Daily notes", ref summary:<day>), read through visibleSummaries below. Removing or correcting one deletes its text and
//     keeps the row as the day's fingerprint (status 'removed', its stamp): the job never writes that day again, and pruneStale never
//     clears a fingerprint.
//
// THE JOB RUNS NIGHTLY (jobs/index.ts, 03:45 Pacific; Royce approved the spend 2026-11-06 at about $0.0015 per member-day). Each run
// logs its model calls and tokens, and runs under a once-only advisory lock (runLocked) so two processes never both pay. Reading is free.
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
Write 2 to 4 plain sentences about what the member was in the middle of that day: what they were dealing with, what they asked Cue for, what was decided or left open. Use "they" for the member and "Cue" for Cue.
Rules:
- Only what the lines say. Never invent, never guess a reason, never add anything from outside the lines.
- Each thing only as far along as they said it is: planned is not started, started is not done.
- Never state that they went to, attended or did something unless they said they did. What they meant to do stays intent ("planned to", "said they would").
- Silence or a missing reply is not a fact: never write that they did not answer, ignored, declined or lost interest.
- Feelings: only how they said they felt, in their own words, and only if they said it. Never read a mood into a line.
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

export type StoredSummary = { id: string; day: string; summary: string; source_ids: string[]; source_stamp: string; status?: string };

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

// Every stored summary of the member (not just the newest few the read loads), checked against how its source rows read through the
// guards now. A summary whose source line was removed, corrected or deleted, or whose own text says a removed thing, is deleted: free,
// no model. The day then has no summary, so the job writes it once more from the guarded lines (or not at all when nothing is left).
// A blank record (a paid attempt that came back empty) goes the same way when its stamp no longer matches, so a changed day gets one
// new try and an unchanged one never gets a second. Returns how many were deleted; guards unreadable (null): nothing is deleted.
export async function pruneStale(db: Db, userId: string, guards: ForgottenRow[] | null): Promise<number> {
  if (guards === null) return 0;
  // A removed day's fingerprint is never pruned: it is what keeps the job from writing that day again.
  const { rows } = await db.query(`SELECT id::text AS id, to_char(day, 'YYYY-MM-DD') AS day, summary, source_ids, source_stamp, status FROM member_day_summaries WHERE user_id = $1 AND status <> 'removed'`, [userId]);
  if (!rows.length) return 0;
  const ids = [...new Set(rows.flatMap((r: any) => r.source_ids as string[]))];
  const src = ids.length ? (await db.query(`SELECT id::text AS id, memory_type, content FROM co_memories WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, ids])).rows : [];
  const stale = (rows as StoredSummary[]).filter((r) => !stillStands(r, src, guards) || (r.status !== "blank" && guardText(r.summary, guards) === null)).map((r) => r.id);
  if (stale.length) await db.query(`DELETE FROM member_day_summaries WHERE user_id = $1 AND id::text = ANY($2::text[])`, [userId, stale]);
  return stale.length;
}

// Right after a removal or correction (services/whatCoKnows.ts applyKnowledgeChanges): the guards are read fresh and the member's stale
// summaries are cleared at once, not at the next reply. Best effort; the read path withholds them anyway.
export async function pruneAfterChange(userId: string, db: Db = pool): Promise<number> {
  const guards = await import("./whatCoKnows.js").then((W) => W.forgottenRows(userId, db as any, { all: true })).catch(() => null);
  return pruneStale(db, userId, guards).catch(() => 0);
}

// ---------------------------------------------------------------- read (free, per reply)

// What the member is shown in what Cue knows (services/whatCoKnows.ts readKnown): every 'ok', non-blank summary that still stands
// against their removals and corrections, newest first, through the removal guard. One read on db (a transaction's client works: the
// queries run one after another). Guards unreadable: nothing (never a note that may carry what they removed). The name strip runs on
// the way out (whatCoKnows.ts strippedItems), as on every line there.
export async function visibleSummaries(userId: string, db: Db = pool, o: { strip?: Strip } = {}): Promise<{ day: string; summary: string }[]> {
  const { rows } = await db.query(
    `SELECT id::text AS id, to_char(day, 'YYYY-MM-DD') AS day, summary, source_ids, source_stamp, status FROM member_day_summaries
     WHERE user_id = $1 AND status = 'ok' AND btrim(summary) <> '' ORDER BY day DESC`,
    [userId],
  );
  if (!rows.length) return [];
  const [guards, strip] = await Promise.all([
    import("./whatCoKnows.js").then((W) => W.forgottenRows(userId, db as any, { all: true })).catch(() => null),
    o.strip ? Promise.resolve(o.strip) : import("./sourceFence.js").then((F) => F.memberFence(userId)).then((f) => (f.failed ? null : f.strip)).catch(() => null),
  ]);
  if (guards === null || strip === null) return [];
  const ids = [...new Set(rows.flatMap((r: any) => r.source_ids as string[]))];
  const src = ids.length ? (await db.query(`SELECT id::text AS id, memory_type, content FROM co_memories WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, ids])).rows : [];
  return usableSummaries(rows as StoredSummary[], src, guards, strip).usable.map((u) => ({ day: u.day, summary: u.summary }));
}

// Pure: THE one decision of which stored notes Cue may use, for both the member's view (visibleSummaries, what Cue knows) and the
// reply/call block (earlierSummaryBlock), so a note never shapes a reply or a call unless the member can see it (ruling 5). A note is
// usable only when it is 'ok' and not blank, every source still reads the same through the guards, the removal guard leaves something,
// and the name strip leaves it EXACTLY as it is: a note the strip would change in any way (it names a member, even as "came up here")
// is skipped in both, never shown as a rewrite. stale: notes whose sources changed (the readers delete them; the job writes the day once more).
export function usableSummaries(rows: StoredSummary[], sources: Pick<SrcRow, "id" | "memory_type" | "content">[], guards: ForgottenRow[], strip: Strip): { usable: { id: string; day: string; summary: string; sources: number }[]; stale: string[] } {
  const usable: { id: string; day: string; summary: string; sources: number }[] = [];
  const stale: string[] = [];
  for (const r of rows) {
    if ((r.status ?? "ok") !== "ok" || !String(r.summary ?? "").trim()) continue;
    if (!stillStands(r, sources, guards)) { stale.push(r.id); continue; }
    const text = guardText(String(r.summary), guards)?.trim();
    if (!text) continue;
    if ((strip(text) ?? "").trim() !== text) continue;
    usable.push({ id: r.id, day: r.day, summary: text, sources: r.source_ids.length });
  }
  return { usable, stale };
}

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
      `SELECT id::text AS id, to_char(day, 'YYYY-MM-DD') AS day, summary, source_ids, source_stamp, status FROM member_day_summaries
       WHERE user_id = $1 AND status = 'ok' AND day < $2::date ORDER BY day DESC LIMIT $3`,
      [userId, cutoff, SUMMARY.recentN * 2],
    );
    if (!rows.length) return "";
    const ids = [...new Set(rows.flatMap((r: any) => r.source_ids as string[]))];
    const src = ids.length ? (await db.query(`SELECT id::text AS id, memory_type, content FROM co_memories WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, ids])).rows : [];
    // The same decision the member's view makes (usableSummaries): only notes they can see in what Cue knows.
    const { usable: good, stale } = usableSummaries(rows as StoredSummary[], src, o.guards, o.strip);
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

// ---------------------------------------------------------------- the job (paid, nightly: jobs/index.ts)

export type JobDeps = {
  db: Db;
  now: Date;
  // One Haiku call for one day. Returns the model's text (or null), with its token counts when it has them.
  summarize: (userId: string, input: { day: string; text: string }) => Promise<string | null | Summarized>;
  fenceFor: (userId: string) => Promise<{ strip: Strip; failed?: boolean }>;
  guardsFor: (userId: string) => Promise<ForgottenRow[] | null>;
  zoneFor: (userId: string) => Promise<string | null>;
  maxDays?: number;
  lookbackDays?: number;
};
export type Summarized = { text: string | null; inputTokens?: number; outputTokens?: number };
// modelCalls counts every request made (one that threw too); tokens are what came back, for the per-run spend log.
export type JobResult = { members: number; days: number; written: number; blank: number; pruned: number; skipped: number; failed: number; modelCalls: number; inputTokens: number; outputTokens: number };

// Pure: the member's local window for a run: from the start of the local day lookbackDays back (so the oldest day is whole, across a
// clock change too) up to, not including, the start of the day after the last summarizable one.
export function runWindow(now: Date, zone: string | null | undefined, lookbackDays: number): { from: Date; to: Date; last: string } {
  const z = wordsZone(zone);
  const last = lastSummarizableDay(now, zone);
  return {
    from: DateTime.fromJSDate(now).setZone(z).minus({ days: lookbackDays }).startOf("day").toJSDate(),
    to: DateTime.fromISO(last, { zone: z }).plus({ days: 1 }).startOf("day").toJSDate(),
    last,
  };
}

// One run. Members with the fewest summaries go first and each gets a fair share of the run's day budget (budget / members, at least
// one), so a backfill of one member never starves the rest. For each member: first every stored summary is checked against the guards
// (all of them) and stale ones are deleted, then every day old enough that has no record and enough to say is summarized, newest
// first. A day with a record, a summary or a blank, is never paid for again at the same stamp (ON CONFLICT DO NOTHING): a summary is
// replaced only after its sources changed, and a day that came back empty is recorded with its stamp and tried again only if the
// stamp changes. Only the member's own rows are read (user_id = $1).
export async function runDaySummaries(d: JobDeps): Promise<JobResult> {
  const res: JobResult = { members: 0, days: 0, written: 0, blank: 0, pruned: 0, skipped: 0, failed: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 };
  const budget = d.maxDays ?? SUMMARY.maxDaysPerRun;
  const lookback = d.lookbackDays ?? SUMMARY.lookbackDays;
  const wide = { from: new Date(d.now.getTime() - (lookback + 1) * 86_400_000), to: new Date(d.now.getTime() - (SUMMARY.minAgeDays - 2) * 86_400_000) };
  const who = await d.db.query(
    `SELECT u.id::text AS user_id FROM users u
     WHERE u.archived_at IS NULL AND EXISTS (SELECT 1 FROM co_memories m WHERE m.user_id = u.id AND m.memory_type IN ('text_exchange', 'call_transcript') AND m.created_at >= $1 AND m.created_at < $2)
     ORDER BY (SELECT count(*) FROM member_day_summaries s WHERE s.user_id = u.id), u.id`,
    [wide.from, wide.to],
  );
  const members = who.rows as { user_id: string }[];
  const share = Math.max(1, Math.floor(budget / Math.max(1, members.length)));
  for (const { user_id: userId } of members) {
    if (res.days >= budget) break;
    res.members++;
    try {
      const fence = await d.fenceFor(userId);
      const guards = await d.guardsFor(userId);
      // Unreadable names or guards: this member waits (never a summary that may carry another member's details or removed words).
      if (fence.failed || guards === null) { res.skipped++; continue; }
      res.pruned += await pruneStale(d.db, userId, guards);
      const zone = await d.zoneFor(userId);
      const win = runWindow(d.now, zone, lookback);
      const have = new Set((await d.db.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM member_day_summaries WHERE user_id = $1`, [userId])).rows.map((r: any) => r.day as string));
      const rows = (await d.db.query(
        `SELECT id::text AS id, memory_type, content, created_at FROM co_memories
         WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript') AND created_at >= $2 AND created_at < $3
           AND (memory_type <> 'text_exchange' OR ${notToTeammate()}) ORDER BY created_at, id`,
        [userId, win.from, win.to],
      )).rows as SrcRow[];
      let mine = 0;
      for (const day of dayInputs(rows, zone, guards, fence.strip)) {
        if (res.days >= budget || mine >= share) break;
        if (day.day > win.last || have.has(day.day)) continue;
        res.days++;
        mine++;
        // A call that threw (a refused or timed-out request) is not recorded: nothing came back to pay for. One that came back empty, or
        // that the name strip blanked, was paid for and is recorded with its stamp below.
        let raw: string | null;
        res.modelCalls++;
        try {
          const got = await d.summarize(userId, { day: day.day, text: day.text });
          if (got && typeof got === "object") {
            raw = got.text;
            res.inputTokens += Number(got.inputTokens) || 0;
            res.outputTokens += Number(got.outputTokens) || 0;
          } else raw = got;
        } catch { res.failed++; continue; }
        const text = cleanSummary(raw, fence.strip);
        const blank = !text;
        await d.db.query(
          `INSERT INTO member_day_summaries (user_id, day, zone, summary, status, source_ids, source_stamp, model) VALUES ($1, $2::date, $3, $4, $5, $6::text[], $7, $8)
           ON CONFLICT (user_id, day) DO NOTHING`,
          [userId, day.day, zone, text ?? "", blank ? "blank" : "ok", day.rows.map((r) => r.id), stampOf(day.rows, guards), "haiku"],
        );
        if (blank) res.blank++;
        else res.written++;
      }
    } catch (err: any) {
      res.failed++;
      console.error("day summaries: a member's run failed (non-fatal):", err?.message ?? err);
    }
  }
  return res;
}

// The real dependencies. This is the only place that spends: one Haiku call per day, under the member's cost mark.
// Cost ceiling per day: thinking cannot be turned off on Haiku 5.x (thinkingRoom.ts adds THINKING_ROOM = 2048 to max_tokens on every request),
// so the output is bounded at maxOutputTokens + 2048 = 2,348 tokens ($0.0012) and the input at about 3,400 tokens ($0.0003): $0.0015 a day,
// at most maxDaysPerRun (60) a run: $0.09. Typical is far below (a short read like this one thinks little), but that is not measured here.
export async function realJobDeps(now = new Date()): Promise<JobDeps> {
  const [{ generateText }, { anthropic }, { MODELS }, { withMember }, { withTraceUser }, W, F, T] = await Promise.all([
    import("ai"), import("@ai-sdk/anthropic"), import("../models.js"), import("./llmUsage.js"), import("./llmTraceText.js"), import("./whatCoKnows.js"), import("./sourceFence.js"), import("./memberTime.js"),
  ]);
  return {
    db: pool,
    now,
    summarize: (userId, i) =>
      withTraceUser(userId, () => withMember(userId, async () => {
        const r = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: SUMMARY.maxOutputTokens, experimental_telemetry: { isEnabled: true, functionId: "memory.daySummary" }, system: SUMMARY_PROMPT, prompt: `Day: ${i.day}\n\n${i.text}`, abortSignal: AbortSignal.timeout(30_000) });
        return { text: r.text, inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 };
      })),
    fenceFor: (u) => F.memberFence(u).catch(() => ({ strip: () => null, failed: true })),
    guardsFor: (u) => W.forgottenRows(u, pool, { all: true }).catch(() => null),
    zoneFor: (u) => T.memberZone(u).catch(() => null),
  };
}

// Pure: one run's spend line for the log: counts and tokens only (never a member, a day or a word), and the cost at list price.
export function runLogLine(r: JobResult, price: { input: number; output: number } | null): string {
  const usd = price ? (r.inputTokens * price.input + r.outputTokens * price.output) / 1_000_000 : null;
  return `day summaries: ${r.modelCalls} model call(s), ${r.inputTokens} input + ${r.outputTokens} output tokens${usd === null ? "" : ` (~$${usd.toFixed(4)})`}; members ${r.members}, written ${r.written}, blank ${r.blank}, pruned ${r.pruned}, skipped ${r.skipped}, failed ${r.failed}`;
}

// The one entry point, run nightly by jobs/index.ts. Every run logs its model calls and tokens so the spend can be tracked (the same
// calls are also in the usage table under functionId memory.daySummary).
// One run at a time across every process on the database: the dev Postgres is shared by every Railway environment, and api and
// co-test both register the jobs, so without this two schedules would pay for the same days twice (the insert's ON CONFLICT keeps one
// row, but both calls are paid). A session advisory lock on its own connection, tried once: held elsewhere, this run is skipped with a
// log line (the other one is doing the work). Released when the run ends; a connection that can't unlock is destroyed, which releases it.
export const RUN_LOCK_KEY = "member_day_summaries:job";
export type LockPool = { connect: () => Promise<{ query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }>; release: (destroy?: boolean) => void }> };
export async function runLocked<T>(lockPool: LockPool, fn: () => Promise<T>): Promise<T | null> {
  const c = await lockPool.connect();
  let got = false;
  try {
    got = (await c.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [RUN_LOCK_KEY])).rows[0]?.ok === true;
  } catch (err) {
    c.release(true);
    throw err;
  }
  if (!got) {
    c.release();
    console.log("day summaries: another run holds the lock; this run is skipped");
    return null;
  }
  try {
    return await fn();
  } finally {
    const unlocked = await c.query(`SELECT pg_advisory_unlock(hashtext($1))`, [RUN_LOCK_KEY]).then(() => true).catch(() => false);
    c.release(!unlocked);
  }
}

export async function runDaySummariesJob(lockPool: LockPool = pool as unknown as LockPool): Promise<JobResult | null> {
  return runLocked(lockPool, async () => {
    const res = await runDaySummaries(await realJobDeps());
    const [{ priceFor }, { MODELS }] = await Promise.all([import("./llmUsage.js"), import("../models.js")]);
    console.log(runLogLine(res, priceFor(String(MODELS.haiku))));
    return res;
  });
}
