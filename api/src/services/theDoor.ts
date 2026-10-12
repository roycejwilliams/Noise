// The door (Royce, 2026-10-12): "Design a new member's first hour: what the first conversation feels like and what they walk away
// with. A private club gets judged at the door. Build what's missing from that journey."
//
// THE FIRST HOUR BEFORE THIS (read from the code, origin/co-test 04cee0d):
//   1. A new number texts. routes/sendblue.ts asks for an invite code (onboardingLines.ts GATE_ASK); a good code gets "You're in"
//      (naming the member who invited them), how Co works, Co's contact card, and the name and email ask.
//   2. Name and email (harness/intake.ts) are captured, then Co offers a five-minute call or texting (CALL_OFFER).
//   3. "Text is fine" opens the real conversation. From then on every reply is the normal reply agent. While they have fewer than
//      two findable interests on file, a reply may ask one easy question (services/coldStart.ts), and what they name is saved quietly
//      with saveAsk. A new member's goal sweep runs as soon as their seeds change, and any find goes out later through the proactive
//      lanes, paced and capped, with no time anyone told them.
//   After an hour, Co knows their name, email, how they'd like to talk and a few things they're after. What the member has in hand:
//   a saved contact card and a pleasant chat. Nobody told them what Co took from it, nothing found was theirs yet, and they have no
//   idea what Co does next or when. Being let in should feel like being understood, then looked after.
//
// WHAT THIS ADDS: the first read. Once, in a new member's first conversation, when Co has heard enough to say it back, Co gives them:
//   - one line saying back what it understood they're after, in their terms (never a reading of their character or feelings);
//   - one real thing for them now, when a search this turn finds something that genuinely fits (the existing search tools and
//     shareFinds, which only send links from real results);
//   - what Co will do next and when: a first look at the thing they named, with a time in their own zone ("this evening around 6",
//     "tomorrow around 10am"). That time is real because the tool opens a task for it (services/coTasks.ts) whose only check is a
//     final check, and a task's final check always texts them where it stands, even when nothing real turned up.
//
// HOW IT FITS THE ARCHITECTURE:
//   - Co decides, code guards facts. It is a tool (firstRead) with its registry entry in services/capabilities.ts. Code decides only
//     when the moment is on offer (doorDecision, pure: a new member, never given before, at least two of their texts since they got
//     in, never in a heavy moment, while frustrated with Co, or beside a call offer). The tool holds the facts: once ever, new
//     members only, what Co will look for has to be in their own words, and the time comes from code, never the model's arithmetic.
//   - Never claims what didn't happen. With unprompted texts paused (PROACTIVE_PAUSED) a task couldn't text them, so the tool opens
//     none and tells Co not to name a time. The task's receipt starts "Started task #", so the reply's own "I'll text you this
//     evening" is covered by it and never opens a second task (services/promises.ts STARTED_WORK).
//   - No feature switch: the tool exists exactly while the door is open for that member (a Situation in capabilities.ts), the same
//     way task tools exist only with an open task. No group chats, nothing sent to anyone else.
//   - One member only: every read and write is scoped to their own user id.
//
// WHAT IT DOESN'T DO, ON PURPOSE: it doesn't rewrite the approved onboarding lines (evals pin them, and the gate and intake already
// read well), doesn't add a summary document or page (a first conversation is too early for an artifact, and a doc would read like a
// form), and doesn't send anything on its own: the first read rides inside a reply Co was already writing.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { COLD_START, isNewMember } from "./coldStart.js";
import { notToTeammate } from "./teamLines.js";

export const DOOR = {
  // Their texts since they got in before the first read is on offer: the "text is fine" answer, then something real.
  minTheirTexts: 2,
  // A first look asked for before this local hour happens this evening; after it, tomorrow morning.
  eveningCutoffHour: 14,
  eveningHour: 18,
  morningHour: 10,
  // What Co will look for and what it understood stay short: they ride on a task and a record, not a document.
  maxLine: 220,
} as const;

export type DoorView = {
  joinedAt: Date | null;
  // When the first read was given, if it was.
  givenAt: Date | null;
  // Their texts since identity was captured.
  theirTexts: number;
};

export type DoorState = { open: boolean; why: string };

// Pure: whether the first read is still Co's to give (the tool exists only while this is open).
export function doorOpen(v: DoorView, now: Date = new Date()): DoorState {
  if (v.givenAt) return { open: false, why: "the first read was already given" };
  if (!isNewMember(v.joinedAt, now)) return { open: false, why: `not a new member (joined more than ${COLD_START.newMemberDays} days ago)` };
  if (v.theirTexts < DOOR.minTheirTexts) return { open: false, why: `only ${v.theirTexts} text(s) from them since they got in` };
  return { open: true, why: `a new member, ${v.theirTexts} texts in, no first read yet` };
}

// Pure: whether this reply is offered the moment. Open, and nothing about this turn makes it the wrong one.
export function doorDecision(o: { view: DoorView; now?: Date; heavy: boolean; frustrated?: boolean; otherQuestion?: string | null }): { offer: boolean; why: string } {
  const s = doorOpen(o.view, o.now ?? new Date());
  if (!s.open) return { offer: false, why: s.why };
  if (o.heavy) return { offer: false, why: "a heavy moment" };
  if (o.frustrated) return { offer: false, why: "frustrated with Co right now" };
  if (o.otherQuestion) return { offer: false, why: `this reply already has something else to offer (${o.otherQuestion})` };
  return { offer: true, why: s.why };
}

// Pure: the instruction a reply gets while the moment is on offer. Written the way Co should text, with no quoted example line
// (evals/texting: Co copies the wording it's shown).
export function doorInstruction(firstName: string | null | undefined): string {
  const who = firstName?.trim() || "They";
  return `${who} just got in, and this is your first real conversation. Once you've heard enough to say it back, give them their first read, once, with firstRead. Call firstRead first, then in your reply: one line that says back what you understood they're after, in their terms, only from what they told you, never about their character or feelings. Then, if a search this turn finds one real thing that genuinely fits, share the best one with shareFinds. Then say plainly what you'll do next and when, using the time firstRead gives you. Nothing more after that, no new question. If you haven't heard enough yet, or their message needs a real answer about something else, just answer them and leave this for a later reply. Never announce it as a summary or a profile, and never as a list.`;
}

// Pure: when the first look happens, in their zone. Before the cutoff it's this evening; after it, tomorrow morning. Always at least
// a few hours out, so the look has time to run before it reports.
export function firstLookAt(now: Date, zone: string): { at: Date; words: string; localDate: string } {
  const local = DateTime.fromJSDate(now).setZone(zone);
  const evening = local.hour < DOOR.eveningCutoffHour;
  const day = evening ? local : local.plus({ days: 1 });
  const at = day.set({ hour: evening ? DOOR.eveningHour : DOOR.morningHour, minute: 0, second: 0, millisecond: 0 });
  const words = evening ? `this evening, around ${DOOR.eveningHour - 12}` : `tomorrow morning, around ${DOOR.morningHour}`;
  return { at: at.toJSDate(), words: `${words} (${at.toFormat("cccc")})`, localDate: at.toFormat("yyyy-LL-dd") };
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

export type FirstReadInput = { understood: string; lookFor: string; theirWords: string };

// Pure: why the first read can't be given with these inputs, or null when it can. Facts only, never wording.
export function firstReadProblem(i: FirstReadInput, o: { view: DoorView; now: Date; theirText: string; wordsAreTheirs: (q: string, t: string) => boolean }): string | null {
  // The text count is what puts it on offer; the tool itself only needs something heard from them and the door not closed for good.
  if (o.view.givenAt) return "You already gave them their first read. Don't give it again; just answer them.";
  if (!isNewMember(o.view.joinedAt, o.now)) return "They aren't new, so there's no first read to give. Just answer them.";
  if (o.view.theirTexts < 1) return "You haven't heard anything from them yet. Get to know them first.";
  if (clean(i.understood).length < 8) return "Say what you understood in a few words.";
  if (clean(i.lookFor).length < 3) return "Say what you'll look for, in their terms.";
  if (!o.wordsAreTheirs(clean(i.theirWords), o.theirText)) return "theirWords must be copied exactly from what they wrote. The first look is for something they told you about, not a guess.";
  return null;
}

// Pure: what the first look's task is, from the first read.
export function firstLookTask(i: FirstReadInput, look: { at: Date; words: string; localDate: string }, now: Date) {
  const lookFor = clean(i.lookFor).slice(0, 160);
  return {
    goal: `First look for them: ${lookFor}`,
    theirWords: clean(i.theirWords).slice(0, 300),
    steps: [`Look for ${lookFor}: events, the web, recent posts`, "Text them the best real thing that fits, or plainly what didn't turn up and what you'll try next"],
    firstPlan: `Look for ${lookFor}, then text them by ${look.words} with the best real thing, or plainly where it stands`,
    inHours: Math.max(1, Math.ceil((look.at.getTime() - now.getTime()) / 3_600_000)),
    // Their own day, and the final check at the time Co named: the final check always tells them where it stands.
    deadline: { deadline: look.localDate, finalCheckAt: look.at.toISOString() },
  };
}

// ---------- reads and writes (one member each)

export async function loadDoor(userId: string): Promise<DoorView> {
  const joined = await pool.query(`SELECT created_at FROM users WHERE id = $1`, [userId]).then((r) => (r.rows[0]?.created_at ? new Date(r.rows[0].created_at) : null));
  // Most turns are established members: one read and done.
  if (!isNewMember(joined)) return { joinedAt: joined, givenAt: null, theirTexts: 0 };
  const [given, captured] = await Promise.all([
    pool
      .query(`SELECT created_at FROM harness_decisions WHERE user_id = $1 AND decision = 'door.first_read' AND outcome = 'act' ORDER BY created_at LIMIT 1`, [userId])
      .then((r) => (r.rows[0]?.created_at ? new Date(r.rows[0].created_at) : null)),
    pool
      .query(`SELECT created_at FROM harness_decisions WHERE user_id = $1 AND decision = 'intake.identity' AND action = 'capture' ORDER BY created_at DESC LIMIT 1`, [userId])
      .then((r) => (r.rows[0]?.created_at ? new Date(r.rows[0].created_at) : null)),
  ]);
  const since = captured ?? joined ?? new Date(0);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > $2`,
    [userId, since],
  );
  return { joinedAt: joined, givenAt: given, theirTexts: Number(rows[0]?.n ?? 0) };
}

// Their own recent texts, for the quote check.
export async function theirRecentTexts(userId: string, limit = 12): Promise<string> {
  const { rows } = await pool.query(
    `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r: any) => String(r.content)).join("\n");
}

export type FirstReadResult =
  | { ok: true; timed: true; taskId: number | null; at: string; words: string; fact: string; note: string }
  | { ok: true; timed: false; fact: string; note: string }
  | { ok: false; error: string };

// The first read: recorded once, and its first look scheduled as a task when a task could really text them.
export async function giveFirstRead(
  i: FirstReadInput,
  o: { userId: string; message: string; dryRun: boolean; now?: Date; paused: boolean },
): Promise<FirstReadResult> {
  const now = o.now ?? new Date();
  const [{ wordsAreTheirs, startTask }, { memberZoneOrFallback, localStamp }] = await Promise.all([import("./coTasks.js"), import("./memberTime.js")]);
  const view: DoorView = o.dryRun ? { joinedAt: now, givenAt: null, theirTexts: DOOR.minTheirTexts } : await loadDoor(o.userId);
  const theirText = `${o.message}\n${o.dryRun ? "" : await theirRecentTexts(o.userId).catch(() => "")}`;
  const problem = firstReadProblem(i, { view, now, theirText, wordsAreTheirs });
  if (problem) return { ok: false, error: problem };
  const lookFor = clean(i.lookFor).slice(0, 160);
  const record = async (proposal: Record<string, unknown>) => {
    if (o.dryRun) return;
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 3, decision: "door.first_read", userId: o.userId, outcome: "act", action: proposal.timed ? "timed" : "untimed", proposal: { understood: clean(i.understood).slice(0, DOOR.maxLine), lookFor, ...proposal } });
  };

  // Nothing Co starts on its own can reach them right now, so no time is promised.
  if (o.paused) {
    await record({ timed: false, why: "unprompted texts are paused" });
    return {
      ok: true,
      timed: false,
      fact: `Gave them their first read: what Co understood (${clean(i.understood).slice(0, 160)}). No first look was scheduled.`,
      note: `Recorded. Co can't text them first right now, so don't name a time or promise a later text. Say back what you understood, share one real find if you have it, and tell them plainly they can ask you about ${lookFor} any time.`,
    };
  }

  const zone = await memberZoneOrFallback(o.userId);
  const look = firstLookAt(now, zone);
  const plan = firstLookTask(i, look, now);
  let taskId: number | null = null;
  if (!o.dryRun) {
    const r = await startTask({ userId: o.userId, goal: plan.goal, theirWords: plan.theirWords, steps: plan.steps, firstPlan: plan.firstPlan, inHours: plan.inHours, deadline: plan.deadline, source: "promise" });
    if (!r.ok) return { ok: false, error: `The first look couldn't be scheduled (${r.why}). Say back what you understood, but don't name a time or promise a later text.` };
    taskId = r.task.id;
  }
  await record({ timed: true, taskId, at: look.at.toISOString(), words: look.words, zone });
  const stamp = localStamp(look.at, zone);
  return {
    ok: true,
    timed: true,
    taskId,
    at: look.at.toISOString(),
    words: look.words,
    fact: `Started task${taskId ? ` #${taskId}` : ""}: a first look for ${lookFor}. Co will text them by ${stamp} with the best real thing it finds, or plainly what didn't turn up.`,
    note: `Recorded. Your first look for ${lookFor} is set: you'll text them by ${look.words}, their time, with the best real thing you find or plainly where it stands. Say that time in your own words. Never promise what you'll find.`,
  };
}
