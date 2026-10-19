import pool from "../db/db.js";
import { draftProactive, type OutputRules } from "../harness/proactive.js";

export type AskCheckinPayload = {
  askCheckinId: string;
  askId: string;
  askText: string;
  checkinCount: number;
  hasMatches: boolean;
};

// Co Loop Stage 5 check-in on an open ask. Layer 7 (2026-09-14): jobs/index.ts
// only queues an "ask_checkin" candidate when there's movement (open leads
// for the ask) or 14 days have passed; the proactive harness decides when it
// goes out. Never "no match yet" as the whole message.
//
// recent: Cue's last few ask check-ins to them (recentAskCheckins), newest first. The task used to quote one example frame, and
// drafts copied it ("Still looking for ..., or has that shifted?" four times in six days, Stage 1 #13); now there's no quoted
// example, and the ones they already got are shown as frames not to reuse.
export async function draftAskCheckin(firstName: string, p: AskCheckinPayload, recent: string[] = []): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.askCheckin",
    firstName,
    facts: {
      what_they_told_you_they_want: p.askText,
      times_you_have_checked_in_on_this: p.checkinCount,
      open_leads: p.hasMatches ? "Cue has some possible leads but nothing to introduce yet" : "none yet",
    },
    task: askCheckinTask(p, recent),
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 260 } };
}

// Pure: the drafting task. No quoted example frame; the recent check-ins (at most 3, each one line) as frames not to reuse.
export function askCheckinTask(p: Pick<AskCheckinPayload, "checkinCount">, recent: string[] = []): string {
  const escalate = p.checkinCount >= 2;
  const base = escalate
    ? `You've checked in on this ${p.checkinCount} times already. Ask, lightly, whether it's still something they want, and make it easy to say no. Name what it is in plain words.`
    : `Check that this is still what they want, naming it in plain words, so Cue keeps looking for the right thing. Don't imply anything is lined up. If there's nothing worth asking right now, return SKIP.`;
  const lines = recent.map((r) => r.replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean).slice(0, 3);
  return lines.length ? `${base}\n\nYour last check-ins on their asks, which they already got (don't reuse their opening or their shape; say it a new way):\n${lines.map((l) => `- "${l}"`).join("\n")}` : base;
}

// Cue's last 3 ask check-ins to this member, newest first, through the forget guards (services/whatCoKnows.ts guardText, removals
// only): a line saying something they had Cue forget isn't shown again. A failed read, of the sends or of the guards, is none (fails
// closed: the task then reads as it always did, never with unguarded lines).
export async function recentAskCheckins(userId: string, q: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<string[]> {
  const rows = await q
    .query(`SELECT message FROM proactive_sends WHERE user_id = $1 AND type = 'ask_checkin' AND message IS NOT NULL AND message <> '' ORDER BY sent_at DESC LIMIT 3`, [userId])
    .then((r) => r.rows.map((x: any) => String(x.message)))
    .catch(() => [] as string[]);
  if (!rows.length) return rows;
  const W = await import("../services/whatCoKnows.js").catch(() => null);
  const guards = W ? await W.forgottenRows(userId, q).catch(() => null) : null;
  if (!W || !guards) return [];
  const removed = guards.filter((r) => r.removed);
  return removed.length ? rows.map((m) => W.guardText(m, removed)).filter((m): m is string => m !== null && m.trim() !== "") : rows;
}
