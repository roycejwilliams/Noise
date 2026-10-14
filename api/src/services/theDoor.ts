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
//   - what Co will do next and when: a first look at the thing they named, with a time in their own zone ("today, around 6pm",
//     "tomorrow, around 10am"), or only "by tomorrow" when their zone isn't known. That time is real because the tool opens a task for it (services/coTasks.ts) whose only check is a
//     final check, and a task's final check always texts them where it stands, even when nothing real turned up.
//
// HOW IT FITS THE ARCHITECTURE:
//   - Co decides, code guards facts. It is a tool (firstRead) with its registry entry in services/capabilities.ts. The tool is
//     available while the door is open (doorOpen: a new member, never given before, at least three of their texts since they got
//     in). The reply is told the moment is there (doorDecision) except in a heavy moment, while they're frustrated with Co, or
//     beside a call offer; those only withdraw the instruction, the tool stays available and Co decides. The tool holds the facts:
//     once ever, new members only, what Co will look for and what it says it understood use only words from what they wrote, the
//     quote is theirs, and the time comes from code, never the model's arithmetic.
//   - Never claims what didn't happen. With unprompted texts paused (PROACTIVE_PAUSED) a task couldn't text them, so the tool opens
//     none and tells Co not to name a time. The task's receipt starts "Started task #", so the reply's own "I'll text you this
//     evening" is covered by it and never opens a second task (services/promises.ts STARTED_WORK).
//   - No feature switch: the tool exists exactly while the door is open for that member (a Situation in capabilities.ts), the same
//     way task tools exist only with an open task. No group chats, nothing sent to anyone else.
//   - Said, not just recorded: the first read counts as given only once a text that went out says it back (settleFirstRead after
//     the reply). A reply that drops it leaves the door open for the next one, which reuses the same first-look task.
//   - Their words only: what Co will look for and what it says it understood can't add words they never used, short names
//     included (SF, NYC, AI). With no city on file, the reply's facts say so (harness/replyGrounding.ts).
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
  // Their texts since they got in before the first read is on offer: the "text is fine" answer, then two real ones.
  minTheirTexts: 3,
  // A first look asked for before this local hour happens today at 6pm; after it, tomorrow at 10am.
  eveningCutoffHour: 14,
  eveningHour: 18,
  morningHour: 10,
  // With no zone known: no clock time is promised ("by tomorrow"), and the look runs at this UTC hour, inside 8am to 9pm in every
  // mainland US zone (11am Pacific, 2pm Eastern), at least this many hours out.
  unzonedUtcHour: 18,
  minLeadHours: 3,
  // A first look is reused only while its time is at least this far ahead, so the time Co says is never already past.
  reuseMarginMin: 30,
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
  if (o.frustrated) return { offer: false, why: "frustrated with Cue right now" };
  if (o.otherQuestion) return { offer: false, why: `this reply already has something else to offer (${o.otherQuestion})` };
  return { offer: true, why: s.why };
}

// Pure: the instruction a reply gets while the moment is on offer. Written the way Co should text, with no quoted example line
// (evals/texting: Co copies the wording it's shown).
export function doorInstruction(firstName: string | null | undefined): string {
  const who = firstName?.trim() || "They";
  return `${who} just got in, and this is your first real conversation. Once you've heard enough to say it back, give them their first read, once, with firstRead. Call firstRead first, then in your reply: one line that says back what you understood they're after, in their terms, only from what they told you, never about their character or feelings. Then, if a search this turn finds one real thing that genuinely fits, share the best one with shareFinds. Then say plainly what you'll do next and when, using the time firstRead gives you. Nothing more after that, no new question. If you haven't heard enough yet, or their message needs a real answer about something else, just answer them and leave this for a later reply. Never announce it as a summary or a profile, and never as a list.`;
}

// Pure: when the first look happens. In their zone: before the cutoff it's today at 6pm, after it tomorrow at 10am, with words that
// are true at any hour (a 1am message hears "today", never "this evening" or "tonight"). With no zone known, no clock time is promised:
// "by tomorrow", checked at a fixed UTC hour that's daytime across the US. Always a few hours out, so the look has time to run.
export function firstLookAt(now: Date, zone: string | null): { at: Date; words: string; localDate: string; clock: boolean } {
  if (!zone) {
    let at = DateTime.fromJSDate(now).setZone("UTC").set({ hour: DOOR.unzonedUtcHour, minute: 0, second: 0, millisecond: 0 });
    while (at.toMillis() - now.getTime() < DOOR.minLeadHours * 3_600_000) at = at.plus({ days: 1 });
    return { at: at.toJSDate(), words: "by tomorrow", localDate: at.toFormat("yyyy-LL-dd"), clock: false };
  }
  const local = DateTime.fromJSDate(now).setZone(zone);
  const today = local.hour < DOOR.eveningCutoffHour;
  const day = today ? local : local.plus({ days: 1 });
  const at = day.set({ hour: today ? DOOR.eveningHour : DOOR.morningHour, minute: 0, second: 0, millisecond: 0 });
  const words = today ? `today, around ${DOOR.eveningHour - 12}pm` : `tomorrow, around ${DOOR.morningHour}am`;
  return { at: at.toJSDate(), words: `${words} (${at.toFormat("cccc")}, their time)`, localDate: at.toFormat("yyyy-LL-dd"), clock: true };
}

// Words that frame a playback without claiming anything about them ("you're new and looking for..."). Everything else in what Co
// says it understood, or will look for, has to be a word they used.
const FRAMING = new Set(
  "that this these those with from into about your you're youre they them their what when where which while want wants wanting looking look find finding meet meeting people folks person someone some more most just really here there then like have having been being would could should also start starting first still right very kind sort thing things space room rooms around through over you've you'd you'll it's i'll after outside before near".split(" "),
);
const norm = (t: string) => t.replace(/[’‘]/g, "'").replace(/[^A-Za-z0-9' ]+/g, " ");
const words = (t: string) => norm(t).toLowerCase().split(/\s+/).filter(Boolean);
// Short tokens that name something: an acronym (SF, NYC, AI), or a capitalized word that doesn't start a sentence (LA in "around
// LA"). Short lowercase words are function words and are skipped.
const namesSomething = (token: string, sentenceStart: boolean) => /[A-Z].*[A-Z]/.test(token) || (/^[A-Z]/.test(token) && !sentenceStart);

// Pure: one word is in a list of words, counting forms of it ("founder" for "founders"). Short words only match whole.
function sameWordIn(w: string, theirs: string[]): boolean {
  if (w.length < 4) return theirs.includes(w);
  const stem = w.slice(0, Math.max(4, w.length - 3));
  return theirs.some((t) => t.startsWith(stem) || (t.length >= 4 && w.startsWith(t.slice(0, Math.max(4, t.length - 3)))));
}

// Pure: the words in a line that count as content: 4+ letters and not framing, plus short names (SF, NYC, AI), lowercased.
function contentWords(line: string): string[] {
  const out: string[] = [];
  const raw = line.replace(/[’‘]/g, "'");
  const re = /[A-Za-z0-9']+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const token = m[0].replace(/'s$/i, "");
    const w = token.toLowerCase();
    const before = raw.slice(0, m.index).trimEnd();
    const sentenceStart = !before || /[.!?:;]$/.test(before);
    if (FRAMING.has(w)) continue;
    if (w.length < 4 ? token.length >= 2 && namesSomething(token, sentenceStart) : true) out.push(w);
  }
  return [...new Set(out)];
}

// Pure: the words in a line that aren't in what they wrote (a word counts when they used it or a form of it: "founder" for
// "founders"). Short lowercase words and framing words are skipped; short names (SF, LA, AI) are not.
export function wordsNotTheirs(line: string, theirText: string): string[] {
  const theirs = words(theirText);
  return contentWords(line).filter((w) => !sameWordIn(w, theirs));
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
  // Both named in one error, so a single retry can fix both.
  const lookMissing = wordsNotTheirs(i.lookFor, o.theirText);
  const readMissing = wordsNotTheirs(i.understood, o.theirText);
  const parts = [
    lookMissing.length ? `lookFor uses words they never said: ${lookMissing.slice(0, 6).join(", ")}` : null,
    readMissing.length ? `understood uses words they never said: ${readMissing.slice(0, 6).join(", ")}` : null,
  ].filter(Boolean);
  if (parts.length) return `${parts.join("; ")}. Use only their own words for both, adding nothing.`;
  return null;
}

// Pure: what the first look's task is, from the first read.
export function firstLookTask(i: FirstReadInput, look: { at: Date; words: string; localDate: string }, now: Date) {
  const lookFor = clean(i.lookFor).slice(0, 160);
  return {
    goal: `First look for them: ${lookFor}`,
    theirWords: clean(i.theirWords).slice(0, 300),
    steps: [`Look for ${lookFor}: events, the web, recent posts`, "Text them the best real thing that fits, or plainly what didn't turn up and what you'll try next"],
    firstPlan: `Look for ${lookFor}, then text them ${look.words} with the best real thing, or plainly where it stands`,
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

// What a given first read carries until a sent text shows it was said (settleFirstRead).
export type FirstReadPending = { understood: string; lookFor: string; timed: boolean; taskId: number | null; at: string | null; words: string | null; zone: string | null };

export type FirstReadResult =
  | { ok: true; timed: boolean; pending: FirstReadPending; fact: string; note: string }
  | { ok: false; error: string };

const FIRST_LOOK_GOAL = "First look for them:";
// How a first look whose promise never went out closes (settleFirstRead): withdrawn on the ledger (commitmentLog.ts outcomeOf).
export const FIRST_LOOK_WITHDRAWN = "The first look's promise was not in the text that went out, so it was withdrawn: never said, never owed.";

// The first read. Its first look is scheduled as a task when a task could really text them; it counts as given only once a sent
// text carries the playback (settleFirstRead), so a reply that drops it leaves the door open, and a second call reuses the task
// instead of opening another.
export async function giveFirstRead(
  i: FirstReadInput,
  o: { userId: string; message: string; dryRun: boolean; now?: Date; paused: boolean },
): Promise<FirstReadResult> {
  const now = o.now ?? new Date();
  const [{ wordsAreTheirs, startTask }, { memberZone, localStamp }] = await Promise.all([import("./coTasks.js"), import("./memberTime.js")]);
  const view: DoorView = o.dryRun ? { joinedAt: now, givenAt: null, theirTexts: DOOR.minTheirTexts } : await loadDoor(o.userId);
  const theirText = `${o.message}\n${o.dryRun ? "" : await theirRecentTexts(o.userId).catch(() => "")}`;
  const problem = firstReadProblem(i, { view, now, theirText, wordsAreTheirs });
  if (problem) return { ok: false, error: problem };
  const understood = clean(i.understood).slice(0, DOOR.maxLine);
  const lookFor = clean(i.lookFor).slice(0, 160);
  const playback = `Open your text with one line that says back what you understood, close to this and in your own voice: "${understood}".`;

  // Nothing Co starts on its own can reach them right now, so no time is promised.
  if (o.paused) {
    return {
      ok: true,
      timed: false,
      pending: { understood, lookFor, timed: false, taskId: null, at: null, words: null, zone: null },
      fact: `First read: Cue is saying back what it understood (${understood.slice(0, 160)}). No first look was scheduled.`,
      note: `${playback} Cue can't text them first right now, so don't name a time or promise a later text. Tell them plainly they can ask you about ${lookFor} any time.`,
    };
  }

  // Their real zone, or none: a fallback zone would turn "6pm" into the wrong hour for someone in New York.
  const zone = await memberZone(o.userId);
  // A first look set by an earlier call (its text never went out): kept only while it's still ahead and hasn't reported; one whose
  // time passed unreported is dropped and a fresh one starts. One that already reported closes the door (lookDecision).
  const firstLooks = o.dryRun ? [] : await firstLookTasks(o.userId);
  const d = lookDecision(firstLooks, now);
  if (d.kind === "closed") {
    await closeDoor(o.userId, d.why);
    return { ok: false, error: "Your first look already reported to them, so there's no first read to give now. Just answer them." };
  }
  if (d.kind === "fresh" && d.drop) {
    const { closeTask } = await import("./coTasks.js");
    await closeTask(o.userId, d.drop, "dropped", "Its time passed before the first read went out; a fresh first look replaces it.").catch(() => {});
  }
  const existing = d.kind === "reuse" ? d.task : null;
  let look: { at: Date; words: string; clock: boolean };
  let taskId: number | null = null;
  if (existing) {
    look = { at: new Date(existing.finalCheckAt!), words: zone ? localStamp(existing.finalCheckAt!, zone) : "by tomorrow", clock: !!zone };
    taskId = existing.id;
  } else {
    const l = firstLookAt(now, zone);
    look = l;
    if (!o.dryRun) {
      const plan = firstLookTask(i, l, now);
      const r = await startTask({ userId: o.userId, goal: plan.goal, theirWords: plan.theirWords, steps: plan.steps, firstPlan: plan.firstPlan, inHours: plan.inHours, deadline: plan.deadline, source: "promise" });
      if (!r.ok) return { ok: false, error: `The first look couldn't be scheduled (${r.why}). Say back what you understood, but don't name a time or promise a later text.` };
      taskId = r.task.id;
    }
  }
  const stamp = look.clock ? localStamp(look.at, zone) : "tomorrow (their time zone isn't known, so no clock time was promised)";
  return {
    ok: true,
    timed: true,
    pending: { understood, lookFor, timed: true, taskId, at: look.at.toISOString(), words: look.words, zone },
    fact: `Started task${taskId ? ` #${taskId}` : ""}: a first look for ${lookFor}. Cue will text them by ${stamp} with the best real thing it finds, or plainly what didn't turn up.`,
    note: look.clock
      ? `${playback} Then say you'll text them ${look.words} with the best real thing you find or plainly where it stands, in your own words. Never promise what you'll find.`
      : `${playback} Then say you'll text them by tomorrow with the best real thing you find or plainly where it stands. Their time zone isn't known, so say "by tomorrow" and never a clock time. Never promise what you'll find.`,
  };
}

export type FirstLookRow = { id: number; status: string; finalCheckAt: string | null; finalTold: boolean };

// Pure: what to do with first-look tasks already on file. Reuse one still ahead and unreported (with a margin, so the time Co says
// is never already past); close the door when one already reported; otherwise start fresh, dropping one whose time passed unreported.
export function lookDecision(rows: FirstLookRow[], now: Date): { kind: "reuse"; task: FirstLookRow } | { kind: "closed"; why: string } | { kind: "fresh"; drop: number | null } {
  if (rows.some((t) => t.finalTold)) return { kind: "closed", why: "the first look already reported to them" };
  const open = rows.filter((t) => t.status === "open" && t.finalCheckAt);
  const ahead = open.find((t) => new Date(t.finalCheckAt!).getTime() - now.getTime() > DOOR.reuseMarginMin * 60_000);
  if (ahead) return { kind: "reuse", task: ahead };
  return { kind: "fresh", drop: open[0]?.id ?? null };
}

async function firstLookTasks(userId: string): Promise<FirstLookRow[]> {
  const { rows } = await pool.query(
    `SELECT id, status, final_check_at, final_told FROM co_tasks WHERE user_id = $1 AND goal LIKE $2 ORDER BY id DESC LIMIT 5`,
    [userId, `${FIRST_LOOK_GOAL}%`],
  );
  return rows.map((r: any) => ({ id: Number(r.id), status: String(r.status), finalCheckAt: r.final_check_at ? new Date(r.final_check_at).toISOString() : null, finalTold: !!r.final_told }));
}

async function closeDoor(userId: string, why: string): Promise<void> {
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision({ layer: 3, decision: "door.first_read", userId, outcome: "act", action: "closed", reason: why });
}

// What the text that went out did with the first read, judged once by Haiku (judgeFirstReadText): no wording is guessed by regex.
// latestBy: the latest moment the follow-up it promised could mean, as an ISO time, or null when it gave no time.
export type FirstReadJudgment = { playedBack: boolean; promisedFollowUp: boolean; when: string | null; latestBy: string | null };

export type TaskFate =
  | { kind: "keep" }
  | { kind: "move"; at: string }
  | { kind: "withdraw" }
  | { kind: "none" };

// Pure: two separate decisions from one judgment. (a) The read is given when the text played it back or promised the follow-up;
// otherwise once more, and a second miss closes the door. (b) The task: a promise that went out is kept as a promise, moved earlier
// when the text promised sooner than the task's time. A text that promised nothing withdraws it (Royce, 2026-10-13: "A new member's
// first request never becomes a lookout without their words"): never searched, never paced as Co's own look, nothing sent; their
// request becomes a lookout only if their own words ask Co to keep an eye out (the intent split, askLifecycle.ts). A judge that
// failed (null) keeps everything: given, promise kept.
export function settleFromJudgment(p: Pick<FirstReadPending, "taskId" | "at">, j: FirstReadJudgment | null, priorUnsaid: number, now: Date): { given: boolean; action: string; task: TaskFate } {
  if (!j) return { given: true, action: "judge_failed_kept", task: p.taskId ? { kind: "keep" } : { kind: "none" } };
  const given = j.playedBack || j.promisedFollowUp || priorUnsaid >= 1;
  const action = j.playedBack && j.promisedFollowUp ? "played_back_and_promised" : j.playedBack ? "played_back" : j.promisedFollowUp ? "promised" : priorUnsaid >= 1 ? "closed_after_retry" : "unsaid";
  if (!p.taskId) return { given, action, task: { kind: "none" } };
  if (j.promisedFollowUp) {
    const said = j.latestBy ? new Date(j.latestBy) : null;
    const taskAt = p.at ? new Date(p.at) : null;
    if (said && Number.isFinite(said.getTime()) && taskAt && said.getTime() < taskAt.getTime()) {
      // They were told sooner than the task would run: it runs by then, never before a few minutes from now.
      return { given, action, task: { kind: "move", at: new Date(Math.max(said.getTime() - 30 * 60_000, now.getTime() + 5 * 60_000)).toISOString() } };
    }
    return { given, action, task: { kind: "keep" } };
  }
  return { given, action, task: { kind: "withdraw" } };
}

export function judgePrompt(p: Pick<FirstReadPending, "understood" | "lookFor" | "at" | "zone">, sent: string, now: Date): string {
  const zone = p.zone ?? "UTC";
  return `Cue (a texting companion) just sent a new member the text below. Cue meant to (1) say back what it understood they're after, close to: "${p.understood}", and (2) tell them it will look for "${p.lookFor}" and text them by a time.

Now, their time: ${DateTime.fromJSDate(now).setZone(zone).toFormat("cccc yyyy-LL-dd HH:mm ZZ")}${p.zone ? "" : " (their zone isn't known; read times as UTC)"}.

The text that went out:
"""${sent.slice(0, 1200)}"""

Answer with ONLY strict JSON: {"playedBack": boolean, "promisedFollowUp": boolean, "when": string or null, "latestBy": string or null}.
- playedBack: the text says back, in any words, what they're after (not just "got it").
- promisedFollowUp: the text promises Cue will text, tell or get back to them later.
- when: the time words of that promise as written ("by six tonight"), else null.
- latestBy: the latest moment those words could mean, as an ISO 8601 time with offset ("tonight" means 21:00 their time, "this evening" 21:00, "tomorrow" 21:00 tomorrow, "by 6pm" 18:00), else null.`;
}

export function parseJudgment(raw: string): FirstReadJudgment | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.playedBack !== "boolean" || typeof j.promisedFollowUp !== "boolean") return null;
    const latest = typeof j.latestBy === "string" && Number.isFinite(new Date(j.latestBy).getTime()) ? new Date(j.latestBy).toISOString() : null;
    return { playedBack: j.playedBack, promisedFollowUp: j.promisedFollowUp, when: typeof j.when === "string" ? j.when.slice(0, 80) : null, latestBy: latest };
  } catch {
    return null;
  }
}

// One Haiku read of the sent text; null on any failure (the caller keeps everything).
export async function judgeFirstReadText(p: FirstReadPending, sent: string, now: Date = new Date()): Promise<FirstReadJudgment | null> {
  try {
    const [{ generateText }, { anthropic }, { MODELS }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js")]);
    const { text } = await Promise.race([
      generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 1500, experimental_telemetry: { isEnabled: true, functionId: "door.judgeFirstRead" }, prompt: judgePrompt(p, sent, now) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
    ]);
    return parseJudgment(text);
  } catch {
    return null;
  }
}

// After the reply went out: bookkeeping, never a gate on the text.
export async function settleFirstRead(userId: string, p: FirstReadPending, sent: string, judge: typeof judgeFirstReadText = judgeFirstReadText): Promise<boolean> {
  const now = new Date();
  const [prior, j] = await Promise.all([
    pool
      .query(`SELECT count(*)::int AS n FROM harness_decisions WHERE user_id = $1 AND decision = 'door.first_read_unsaid'`, [userId])
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => 0),
    judge(p, sent, now),
  ]);
  const d = settleFromJudgment(p, j, prior, now);
  if (p.taskId) {
    const id = p.taskId;
    if (d.task.kind === "withdraw") {
      // Never said, so never owed: withdrawn on the ledger (commitmentLog.ts outcomeOf reads this wording), not missed.
      const { closeTask } = await import("./coTasks.js");
      await closeTask(userId, id, "dropped", FIRST_LOOK_WITHDRAWN).catch(() => {});
    } else if (d.task.kind === "move") {
      await pool.query(`UPDATE co_tasks SET next_check_at = $3, final_check_at = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open'`, [userId, id, d.task.at]).catch(() => {});
    }
  }
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision({
    layer: 3,
    decision: d.given ? "door.first_read" : "door.first_read_unsaid",
    userId,
    outcome: d.given ? "act" : "skip",
    action: d.action,
    reason: d.given ? null : "the text that went out carried neither the playback nor a promise; the door stays open for one more try",
    proposal: { ...p, judgment: j, task: d.task, sent: sent.slice(0, 400) },
  });
  return d.given;
}
