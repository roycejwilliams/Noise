// Payload first (Royce, 2026-10-04): "Three caterers that fit 60 people by
// Friday, here they are" beats "still want caterer options?" every time.
//
// Before a proactive text that asks whether Co should do something goes out,
// Co checks whether it could simply do it. Work that's internal and reversible
// (research, gathering options, drafting, shortlisting) is handed to one of
// Co's tasks (services/coTasks.ts), which does it on the next task wake (within
// 15 minutes) and texts the result only once it's verified (services/
// taskTurn.ts); the question never goes out. Questions stay only for what the
// member owns (practicing a pitch, deciding, telling Co something only they
// know) and for steps that are irreversible or seen by others (an intro, a
// booking, a payment, an email sent in their name).
//
// The same disease as the tease bug (#59) one level up: Co promising instead
// of delivering. A check-in is the weakest form of proactiveness, delivery the
// strongest.
//
// Co reads the draft (a model read, not a regex: what counts as "work Co could
// do" is judgment); code holds it to facts: the question it names must be in
// the draft, the work must be one of the internal kinds, and the member's words
// it's for must be theirs.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { mayText, openTasks, startTask, taskTextsToday, wordsAreTheirs, type CoTask } from "../services/coTasks.js";
import { notToTeammate } from "../services/teamLines.js";

// Kinds whose question is by design one Co must ask, or whose text already is
// the payload: an event offer carries the event itself; a network tease leads
// to an intro (seen by another person); an in-room match nudge is an intro; a
// lapse notice is about paying. A companion check-in is the companion touch
// itself (companion first): swapping it for a task update would lose it.
export const PAYLOAD_FIRST_EXEMPT = new Set(["event_offer", "network_tease", "event_match_nudge", "artifact_expiry", "bounce_proposal", "bounce_watch", "bounce_calendar_offer", "companion", "brief_name_ask", "event_brief", "event_followthrough", "noshow_note", "loop_check", "goal_checkin", "goal_closed", "goal_recheck", "room_share_ask", "name_change", "announcement", "voice_read_ask", "intro_close"]);

// Work Co can do on its own and undo by saying nothing, and that a task turn
// can deliver: it texts only verified results (taskTurn.ts). Drafting and
// shortlisting stay questions until a live task test shows a task delivers
// them (review of #59: no tool writes a draft, and options they already have
// aren't verified facts, so the question would turn into silence).
export const DOABLE = ["research", "gather_options"] as const;
export const KEEP_ASKING = ["draft", "shortlist", "member_action", "irreversible_or_visible", "only_they_know", "none"] as const;
type WorkKind = (typeof DOABLE)[number] | (typeof KEEP_ASKING)[number];

export type OfferRead = {
  question: string | null;
  kind: WorkKind;
  work: string | null;
  theirWords: string | null;
  sameAsTask: number | null;
};

export type PayloadDecision =
  | { handOff: true; work: string; theirWords: string; taskId: number | null; why: string }
  | { handOff: false; why: string };

const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Pure: only what the member wrote, their own lines ("User said: …"). The ask a
// check-in is about is Co's restatement of it, so it never counts as their
// words (review of #59); their older lines are read from the thread instead.
export function theirText(recent: string): string {
  return recent
    .split("\n")
    .map((l) => l.match(/^\s*User said:\s*(.+)$/i)?.[1]?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

// Their own texts to Co from the last month (not their talk with a teammate),
// oldest first, so an ask from days ago can still be grounded in what they said.
export const THEIR_WORDS_DAYS = 30;
export async function theirLines(userId: string): Promise<string> {
  const { rows } = await pool
    .query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%'
       AND ${notToTeammate()} AND created_at > NOW() - ($2 || ' days')::interval ORDER BY created_at DESC LIMIT 300`,
      [userId, THEIR_WORDS_DAYS],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => String(r.content)).reverse().join("\n");
}

// Pure: what Co's read means, held to facts. "theirs" is only the member's own text.
export function decidePayloadFirst(read: OfferRead | null, draft: string, theirs: string, tasks: Pick<CoTask, "id">[]): PayloadDecision {
  if (!read || !read.question) return { handOff: false, why: "no question offering work" };
  if (!norm(draft).includes(norm(read.question))) return { handOff: false, why: "the question named isn't in the draft" };
  if (!(DOABLE as readonly string[]).includes(read.kind)) return { handOff: false, why: `stays a question: ${read.kind}` };
  const work = (read.work ?? "").trim();
  if (work.length < 8) return { handOff: false, why: "the work isn't clear enough to do" };
  const taskId = read.sameAsTask !== null && tasks.some((t) => t.id === read.sameAsTask) ? read.sameAsTask : null;
  // A new task needs what they actually asked for, in their words.
  if (taskId === null && !wordsAreTheirs(read.theirWords, theirs)) return { handOff: false, why: "no words of theirs this work is for" };
  return { handOff: true, work: work.slice(0, 200), theirWords: (read.theirWords ?? "").trim(), taskId, why: `${read.kind}: do it instead of asking "${read.question}"` };
}

export function payloadFirstPrompt(o: { draft: string; recent: string; theirAsk?: string | null; tasks: Pick<CoTask, "id" | "goal">[] }): string {
  return `Cue (an AI companion that texts its members) is about to send this text on its own initiative:
"${o.draft}"

Their recent texts with Cue, oldest first:
${o.recent.slice(-2500) || "(none)"}
${o.theirAsk ? `\nWhat they asked Cue for, as Cue noted it: "${o.theirAsk}"\n` : ""}
Things Cue is already working on for them:
${o.tasks.map((t) => `- [${t.id}] ${t.goal}`).join("\n") || "(none)"}

Does this text ask whether Cue should do something, or whether they still want something Cue would get them ("still want those caterer options?", "want me to dig into X?", "should I pull a few venues?")? If it does, could Cue simply do that itself and send the result instead of asking?

Classify the work the question offers:
- research: looking something up, checking a fit, finding out facts
- gather_options: finding venues, vendors, events, people, prices to choose from
- draft: writing something for them to review (Cue doesn't send it)
- shortlist: narrowing options they already have
- member_action: something only they can do (practice a pitch, go to an event, decide)
- irreversible_or_visible: sending an intro or a message in their name, booking, paying, anything another person sees
- only_they_know: asking how they are, how something went, what they want
- none: the text asks no question like this

Return ONLY JSON: {"question": "the exact question from the text, or null", "kind": one of the kinds above, "work": "what Cue would do, as a short goal (e.g. find three caterers for 60 people by Friday), or null", "theirWords": "the member's own words this work is for, copied exactly from one of their texts (a "User said:" line), or null", "sameAsTask": the [id] of the matching thing Cue is already working on, or null}`;
}

export async function readOffer(draft: string, recent: string, tasks: Pick<CoTask, "id" | "goal">[], theirAsk: string | null = null): Promise<OfferRead | null> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      maxOutputTokens: 400,
      // A short classification: low effort, so thinking can't eat the cap (evals/guards).
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "proactive.payloadFirst" },
      prompt: payloadFirstPrompt({ draft, recent, theirAsk, tasks }),
    });
    const j = parseModelJson<Partial<OfferRead>>(text);
    const kinds = [...DOABLE, ...KEEP_ASKING] as readonly string[];
    return {
      question: typeof j.question === "string" && j.question.trim() ? j.question.trim() : null,
      kind: (kinds.includes(String(j.kind)) ? j.kind : "none") as WorkKind,
      work: typeof j.work === "string" ? j.work : null,
      theirWords: typeof j.theirWords === "string" ? j.theirWords : null,
      sameAsTask: typeof j.sameAsTask === "number" ? j.sameAsTask : null,
    };
  } catch (err: any) {
    console.error("payloadFirst read failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// The work, given to a task due now: the one Co already has for it, or a new
// one. The task cron (every 15 minutes) does it and texts the verified result.
export async function handOffWork(userId: string, d: Extract<PayloadDecision, { handOff: true }>): Promise<{ ok: true; taskId: number; started: boolean } | { ok: false; why: string }> {
  let taskId = d.taskId;
  let started = false;
  // Only hand it off if the result could go out: a task that texted in the last
  // 20 hours, or a member at today's task-text limit, would sit on it (review of #59).
  const today = await taskTextsToday(userId).catch(() => 0);
  const existing = taskId !== null ? (await openTasks(userId)).find((t) => t.id === taskId) : undefined;
  const can = mayText(existing ?? { lastTextedAt: null }, today, new Date());
  if (!can.ok) return { ok: false, why: `the result couldn't go out yet: ${can.why}` };
  if (taskId === null) {
    const s = await startTask({
      userId,
      goal: d.work,
      theirWords: d.theirWords,
      steps: [],
      firstPlan: `Do it now and send them the result, instead of asking whether they still want it: ${d.work}`,
      inHours: 1,
    });
    if (!s.ok) {
      // Already on it under the same goal: wake that one.
      const same = s.why === "already working on that" ? (await openTasks(userId)).find((t) => norm(t.goal) === norm(d.work)) : undefined;
      if (!same) return { ok: false, why: s.why };
      const sameCan = mayText(same, today, new Date());
      if (!sameCan.ok) return { ok: false, why: `the result couldn't go out yet: ${sameCan.why}` };
      taskId = same.id;
    } else {
      taskId = s.task.id;
      started = true;
    }
  }
  // The hand-off goes first and the task's own plan follows it whole (a
  // deadline's last-check plan stays). Not capped: a long plan used to cut the
  // hand-off off entirely (re-review of #59).
  const { rowCount } = await pool.query(
    `UPDATE co_tasks SET next_check_at = NOW(),
       plan_next = CASE WHEN $4 THEN $3 ELSE 'Now: ' || $3 || COALESCE(' Then: ' || plan_next, '') END, updated_at = NOW()
     WHERE user_id = $1 AND id = $2 AND status = 'open'`,
    [userId, taskId, `do it and send them the result, instead of asking: ${d.work}`, started],
  );
  if (!rowCount) return { ok: false, why: "that task isn't open anymore" };
  return { ok: true, taskId, started };
}

export type PayloadFirstResult = { handedTo: number; started: boolean; why: string } | { wouldHandOff: string } | { hold: string } | { kept: string } | null;

// The ask a candidate is about, as Co noted it, when it carries one (context for the read; never their words).
export function theirAskOf(payload: unknown): string | null {
  const p = (payload ?? {}) as { askText?: unknown; asked?: unknown };
  const a = typeof p.askText === "string" ? p.askText : typeof p.asked === "string" ? p.asked : null;
  return a && a.trim() ? a.trim() : null;
}

// The whole step: null or { kept } when the text goes out as written; { handedTo }
// when the work went to a task instead; { hold } when Co could do it but can't
// deliver it now (at its task limit, or a task text would be blocked), so the
// question doesn't go out: the candidate is dropped and its source asks again on
// its own schedule (a 24h hold was re-queued every hour; review of #59).
export async function payloadFirst(o: { userId: string; kind: string; draft: string; recent: string; theirAsk?: string | null; dryRun?: boolean }): Promise<PayloadFirstResult> {
  if (PAYLOAD_FIRST_EXEMPT.has(o.kind)) return null;
  if (!/\?/.test(o.draft)) return null;
  const tasks = await openTasks(o.userId).catch(() => [] as CoTask[]);
  const theirs = theirText(`${await theirLines(o.userId)}\n${o.recent}`);
  const d = decidePayloadFirst(await readOffer(o.draft, o.recent, tasks, o.theirAsk ?? null), o.draft, theirs, tasks);
  if (!d.handOff) return { kept: d.why };
  if (o.dryRun) return { wouldHandOff: d.why };
  const h = await handOffWork(o.userId, d);
  if (!h.ok) return { hold: `could do it, but: ${h.why}` };
  return { handedTo: h.taskId, started: h.started, why: d.why };
}
