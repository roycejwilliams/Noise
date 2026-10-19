// Update announcements (Royce, 2026-10-19): the one-time rename notice (services/nameChange.ts), generalized. When something changes
// for members, Cue tells each member it applies to once, in a text of its own, and only says what changed, what it means for them,
// and one thing to try. Royce's complaint about the rename: members got "Quick one: I'm going by Cue now. Same me, new name." and
// nothing about what the shift means or what Cue can do now.
//
// Each announcement here is fixed, approved wording. No model writes any of it (Cue has a history of overclaiming its own actions,
// so the words that say what it does are set by hand and checked against the code). Never a changelog, never stats, never "I
// shipped X" (feedback: no system-stats texts about Cue itself).
//   key       its ledger target_key: one proactive_sends row per member (unique on user_id + target_key) means once, ever.
//   approved  a code constant, no env switch: an announcement whose wording Royce hasn't approved is never queued, and its draft,
//             if it were ever reached, defers without reading anything.
//   audience  members who knew what it changes: joined before the change (the rename's cutoff). Someone who joined after only ever
//             knew the new behavior and is never told about a change they didn't live through. The rest of who is left out is the
//             same for every announcement: no phone, archived, opted out, never finished joining, already told or already queued.
//   expiry    when what hasn't gone by then never goes: a fixed day, or a number of days after the first one was queued.
//   tryLines  the one "thing to try" line, picked from approved lines by the member's situation, in code, at send time ($0). What
//             Cue knows about them only picks among approved words; it never decides whether they get it.
//   foldLead  for an announcement that follows the rename: a member the rename notice hasn't reached yet gets ONE text that opens
//             with the rename's own words instead of the follow-up's lead, and the rename's ledger key is claimed with it, inside
//             the send lock (harness/proactive.ts sendWithLedger's ride). Never two texts.
//
// Delivery is the normal proactive path (harness/proactive.ts), exactly as the rename notice: hours, opt-out, the conversation hold,
// the safety hold, the hold on a hard day (HOLD_WHILE_STRUGGLING), pacing, a quiet member's taper, archived accounts skipped. A full
// announcement is too long to ride in another text and never does: it goes as its own text, at the lowest priority, only on a day
// nothing else is ready (quietDayOnly), and nothing rides in it except the rename it carries.
import pool from "../db/db.js";
import { goalTexts } from "./goalJourney.js";
import { NAME_CHANGE_EXPIRES, NAME_CHANGE_KEY, NAME_CHANGE_TEXT, carriesNameChange } from "./nameChange.js";
import type { Candidate, DraftResult, EnqueueInput, ProactiveType } from "../harness/proactive.js";

// What the "thing to try" line is picked by. Read at send time from the member's own record; a read that fails is the default.
export type Situation = { hasOwnGoal: boolean };
export type TryLine = { when: "default" | "own_goal"; line: string };

export type Announcement = {
  key: string;
  type: Extract<ProactiveType, "name_change" | "announcement">;
  approved: boolean;
  // Team-facing: what it is, for the decision log and the pick (never sent).
  summary: string;
  // The fixed text, in order: what changed, then what it means for them. The try line goes last.
  lead: string;
  body: string;
  tryLines: TryLine[];
  foldLead?: string;
  audience: "knew_co";
  expires: { at: Date } | { daysAfterFirstQueued: number };
};

// ---------------------------------------------------------------- the registry

// The rename notice, ported as it was (services/nameChange.ts holds its words, its riding line and its end): approved and live since
// 2026-10-14, queued by queueNameChange, drafted by proactiveRegistry.name_change, riding in other texts on the stop-note terms.
// Nothing about it changes for any member it has reached or will reach.
export const RENAME: Announcement = {
  key: NAME_CHANGE_KEY,
  type: "name_change",
  approved: true,
  summary: "Tell them, once, that it goes by Cue now",
  lead: NAME_CHANGE_TEXT,
  body: "",
  tryLines: [],
  audience: "knew_co",
  expires: { at: NAME_CHANGE_EXPIRES },
};

// "The shift": the follow-up to the rename for members who knew Co. PROPOSED wording (option A), waiting on Royce. Until he approves
// it word for word, nothing is queued (SHIFT_APPROVED). The claims in it were checked against the code on 2026-10-19; see the PR.
export const SHIFT_APPROVED = false;
export const SHIFT_KEY = "announcement:shift";
export const SHIFT_LEAD = "A bit more on the new name.";
export const SHIFT_BODY =
  "Noise is for the stretches when life is shifting: a new city, a new role, starting something. My part is knowing what you're in the middle of and finding the person worth meeting for it, at a Noise night or between them. I only introduce you when you both say yes.";
export const SHIFT_TRY_DEFAULT = "If something's shifting for you right now, tell me and I'll start looking for who you should meet.";
export const SHIFT_TRY_GOAL = "Tell me where things stand with what you're working on, and I'll look for someone who's been through it.";
export const SHIFT_LIVE_DAYS = 21;
export const SHIFT: Announcement = {
  key: SHIFT_KEY,
  type: "announcement",
  approved: SHIFT_APPROVED,
  summary: "Tell them, once, what the new name means for them and one thing to try",
  lead: SHIFT_LEAD,
  body: SHIFT_BODY,
  // First match wins; the default is last.
  tryLines: [
    { when: "own_goal", line: SHIFT_TRY_GOAL },
    { when: "default", line: SHIFT_TRY_DEFAULT },
  ],
  foldLead: NAME_CHANGE_TEXT,
  audience: "knew_co",
  expires: { daysAfterFirstQueued: SHIFT_LIVE_DAYS },
};

// Every announcement, in the order they are queued. The rename is queued by its own job first (jobs/index.ts), so a member's rename
// candidate exists before a follow-up that carries it.
export const ANNOUNCEMENTS: readonly Announcement[] = [RENAME, SHIFT];
export function announcementByKey(key: string): Announcement | null {
  return ANNOUNCEMENTS.find((a) => a.key === key) ?? null;
}

// Proactive drafting rules for an announcement's own text: it is longer than a check-in, one paragraph, no question, no link.
export const ANNOUNCEMENT_RULES = { maxChars: 520, maxSentences: 6 } as const;

// ---------------------------------------------------------------- pure

// The try line for this member: the first approved line their situation fits, else the default. Never null when the announcement
// has lines.
export function pickTryLine(a: Pick<Announcement, "tryLines">, s: Situation): string | null {
  const fits = (t: TryLine) => t.when === "default" || (t.when === "own_goal" && s.hasOwnGoal);
  return a.tryLines.find(fits)?.line ?? null;
}

// The text: the lead (or, for a member the rename hasn't reached, the rename's words), the body, the try line. One text.
export function announcementText(a: Announcement, s: Situation, o: { nameTold: boolean }): string {
  const lead = a.foldLead && !o.nameTold ? a.foldLead : a.lead;
  return [lead, a.body, pickTryLine(a, s)].filter((x): x is string => !!x && !!x.trim()).join(" ");
}

// The same text as if the rename had already reached them: what goes if, inside the send lock, the rename's key was already taken
// (another text carried it a moment ago). Null if this text doesn't open with the rename's words.
export function unfolded(a: Announcement, messages: string[]): string[] | null {
  if (!a.foldLead || messages.length !== 1 || !messages[0].startsWith(a.foldLead)) return null;
  return [`${a.lead}${messages[0].slice(a.foldLead.length)}`];
}

// The rename riding in this announcement's own text, claimed with it inside the send lock (sendWithLedger's ride): the member's
// queued rename notice when there is one (it is then marked sent with this text), or, when none is queued (it was dropped, or never
// queued), the rename's key claimed under this announcement's own row, so the rename is never queued or sent after it.
// null: nothing to claim (this text doesn't carry the rename). "unfoldable": it carries the rename but its fallback can't be built,
// so it must not go this time.
export function nameFold(c: Candidate, messages: string[], pending: Candidate[]): { candidate: Candidate; without: string[] } | "unfoldable" | null {
  const a = announcementByKey(c.targetKey);
  if (!a?.foldLead || !carriesNameChange(messages.join("\n"))) return null;
  const without = unfolded(a, messages);
  if (!without) return "unfoldable";
  const queued = pending.find((x) => x.type === "name_change" && x.targetKey === NAME_CHANGE_KEY && x.userId === c.userId);
  return { candidate: queued ?? { ...c, type: "name_change", targetKey: NAME_CHANGE_KEY, topicKey: NAME_CHANGE_KEY }, without };
}

// What the day's pick sees (harness/proactive.ts dispatch): an announcement only on a day nothing else is ready, and then one at a
// time, the oldest first. It never competes with, or rides in, anything else.
export function quietDayOnly<T extends Pick<Candidate, "type" | "createdAt">>(eligible: T[]): T[] {
  const others = eligible.filter((x) => x.type !== "announcement");
  if (others.length) return others;
  const first = [...eligible].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0];
  return first ? [first] : [];
}

// When it ends: a fixed day, or so many days after its first candidate was queued (so a member queued later gets no fresh window).
export function expiryOf(a: Pick<Announcement, "expires">, firstQueuedAt: Date | null, now: Date): Date {
  if ("at" in a.expires) return a.expires.at;
  return new Date((firstQueuedAt ?? now).getTime() + a.expires.daysAfterFirstQueued * 86_400_000);
}

// A member row from the audience query. The query already leaves these out; this is the same rule in code, so a wrong row is still
// never queued.
export type AudienceRow = { id: string; created_at: Date | string; archived_at: Date | string | null; sms_opted_out: boolean | null; has_phone: boolean; identity_captured: boolean | null; told: boolean; queued: boolean };
export function inAudience(r: AudienceRow, cutoff: Date): boolean {
  return new Date(r.created_at).getTime() < cutoff.getTime() && !r.archived_at && r.sms_opted_out !== true && r.has_phone && r.identity_captured === true && !r.told && !r.queued;
}

// ---------------------------------------------------------------- queue

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
export type QueueDeps = { db: Db; enqueue: (input: EnqueueInput) => Promise<{ queued: boolean }>; log: (line: string) => void };
const realQueueDeps = async (): Promise<QueueDeps> => ({ db: pool, enqueue: (await import("../harness/proactive.js")).enqueueCandidate, log: (l) => console.log(l) });

// Who knew Co: members who joined before the rename's first notice was queued. The first time the rename is queued fixes it, so a
// member who joins after the rename, and only ever heard "Cue", is never told about a name they never knew. Null before then.
export async function renameCutoff(db: Db = pool): Promise<Date | null> {
  const { rows } = await db.query(`SELECT MIN(created_at) AS at FROM proactive_candidates WHERE type = 'name_change'`);
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

// Queues one announcement for everyone it is for. Idempotent: a member already queued or told is skipped (and enqueueCandidate
// refuses a key that was sent, skipped or expired). Returns how many were queued.
export async function queueAnnouncement(a: Announcement, now: Date = new Date(), deps?: Partial<QueueDeps> & { approved?: boolean }): Promise<number> {
  const d = { ...(await realQueueDeps()), ...deps };
  if (!(deps?.approved ?? a.approved)) {
    d.log(`announcement ${a.key}: its wording is waiting on Royce's approval; nothing queued`);
    return 0;
  }
  // The rename fixes its own cutoff the first time it runs; a follow-up waits until the rename has started.
  const cutoff = (await renameCutoff(d.db)) ?? (a.key === NAME_CHANGE_KEY ? now : null);
  if (!cutoff) return 0;
  const { rows: first } = await d.db.query(`SELECT MIN(created_at) AS at FROM proactive_candidates WHERE target_key = $1`, [a.key]);
  const expiresAt = expiryOf(a, first[0]?.at ? new Date(first[0].at) : null, now);
  if (expiresAt.getTime() <= now.getTime()) return 0;
  const { rows } = await d.db.query(
    `SELECT u.id, u.created_at, u.archived_at, u.sms_opted_out, (u.phone_number IS NOT NULL) AS has_phone, u.identity_captured,
            EXISTS (SELECT 1 FROM proactive_sends s WHERE s.user_id = u.id AND s.target_key = $2) AS told,
            EXISTS (SELECT 1 FROM proactive_candidates c WHERE c.user_id = u.id AND c.target_key = $2) AS queued
       FROM users u
      WHERE u.created_at < $1 AND u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false
        AND u.phone_number IS NOT NULL AND u.identity_captured = true
        AND NOT EXISTS (SELECT 1 FROM proactive_sends s WHERE s.user_id = u.id AND s.target_key = $2)
        AND NOT EXISTS (SELECT 1 FROM proactive_candidates c WHERE c.user_id = u.id AND c.target_key = $2)`,
    [cutoff, a.key],
  );
  let queued = 0;
  for (const r of rows as AudienceRow[]) {
    if (!inAudience(r, cutoff)) continue;
    const q = await d
      .enqueue({ userId: r.id, type: a.type, targetKey: a.key, summary: a.summary, payload: {}, dueAt: now, expiresAt })
      .catch((err: any) => {
        console.error(`announcement ${a.key}: queueing failed (non-fatal):`, err?.message ?? err);
        return { queued: false };
      });
    if (q.queued) queued++;
  }
  return queued;
}

// Every announcement after the rename (the rename keeps its own job, services/nameChange.ts queueNameChange, which runs first).
export async function queueUpdateAnnouncements(now: Date = new Date()): Promise<number> {
  let n = 0;
  for (const a of ANNOUNCEMENTS) if (a.key !== NAME_CHANGE_KEY) n += await queueAnnouncement(a, now);
  return n;
}

// ---------------------------------------------------------------- draft (send time)

export type DraftDeps = { told: (userId: string, key: string) => Promise<boolean>; situation: (userId: string) => Promise<Situation>; now: () => Date };

// Their own goals, as the record holds them now: goals and goal entries, minus any done or set aside, minus Cue's own tasks.
export async function situationOf(userId: string): Promise<Situation> {
  try {
    const [{ rows }, GE] = await Promise.all([pool.query(`SELECT goals, intent FROM co_profiles WHERE user_id = $1`, [userId]), import("./goalEdges.js")]);
    const states = await GE.goalStates(userId);
    const own = GE.liveGoals(goalTexts(rows[0]?.intent, rows[0]?.goals), null, states).filter((g) => !GE.isCoTaskGoal(g));
    return { hasOwnGoal: own.length > 0 };
  } catch {
    return { hasOwnGoal: false };
  }
}
const realDraftDeps: DraftDeps = {
  told: async (userId, key) => (await pool.query(`SELECT 1 FROM proactive_sends WHERE user_id = $1 AND target_key = $2`, [userId, key])).rows.length > 0,
  situation: situationOf,
  now: () => new Date(),
};

// The announcement's own text, re-read at send time: unapproved waits (it can't be queued, so this is a backstop), past its end it
// never goes, already told means nothing goes, and a member the rename hasn't reached gets the rename's words in the same text.
export async function draftAnnouncement(c: Pick<Candidate, "userId" | "targetKey" | "expiresAt">, deps: Partial<DraftDeps> & { approved?: boolean } = {}): Promise<DraftResult> {
  const d = { ...realDraftDeps, ...deps };
  const a = announcementByKey(c.targetKey);
  if (!a || a.type !== "announcement") return { skip: "not an announcement Cue has" };
  const now = d.now();
  if (!(deps.approved ?? a.approved)) return { defer: new Date(now.getTime() + 24 * 3_600_000), reason: "its wording is waiting on Royce's approval" };
  const ends = "at" in a.expires ? a.expires.at : c.expiresAt;
  if (ends && ends.getTime() <= now.getTime()) return { skip: "past its end" };
  if (await d.told(c.userId, a.key)) return { skip: "already told" };
  const nameTold = a.foldLead ? await d.told(c.userId, NAME_CHANGE_KEY) : true;
  const text = announcementText(a, await d.situation(c.userId), { nameTold });
  return { messages: [text], text, rules: { ...ANNOUNCEMENT_RULES } };
}
