// From a call to a multi-day task (Royce, 2026-10-06: Co told him "resource drops, that's not really how I work" when he asked for
// memos and resources through the week, though Co's tasks do exactly that by text).
//
// A call has no tool that opens a task, and shouldn't: Co would stall mid-conversation. After the call, this reads what the MEMBER
// asked Co to work on over days (their lines only), and opens the same kind of task a text would (services/coTasks.ts), so every
// limit holds: 5 open, 30 days, one text per task a day, a task opens only with a quote of their own words.
//   - Sonnet reads the transcript (post-call: nobody is waiting)
//   - code checks each quote is verifiably in the member's own lines before anything opens
//   - at most 2 tasks per call, once per call (a retried delivery doesn't open them again)
//   - the result is written where the after-call text reads it, so the text can say, truthfully, that Co is on it
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { callKey } from "./callKey.js";
import { noteOnTask, openTasks, startTask, wordsAreTheirs } from "./coTasks.js";
import { sameCallCommitment } from "./followThrough.js";
import { theirLinesOnly } from "../harness/proactiveSpecifics.js";

export const MAX_TASKS_PER_CALL = 2;
export type Wanted = { goal?: unknown; quote?: unknown };

export function callTasksPrompt(theirLines: string): string {
  return `Below is what a member said on a phone call with Co. Find the things they asked Co to WORK ON over days: resources or memos sent through the week, preparing them for something (a pitch, a conversation), lining up or comparing options, researching something for them, keeping an eye out and texting what turns up.

Only what THEY asked for, in their own words. Not what Co offered or promised, not a topic they mentioned, not a feeling, not something they will do themselves, not a one-time question answered on the call. If they asked for nothing like that, return none.

For each: "goal" is one plain sentence of what to work on, from their ask ("Send pre-seed fundraising resources and ideas through the week"); "quote" is the exact words they said, copied from below.

Their lines:
${theirLines.slice(-12000)}

Return ONLY JSON: {"tasks": [{"goal": "...", "quote": "..."}]}. At most ${MAX_TASKS_PER_CALL}.`;
}

// Pure: only asks whose quote is really in their own lines, with a real goal; capped.
export function verifiedAsks(wanted: Wanted[], theirLines: string): { goal: string; quote: string }[] {
  const out: { goal: string; quote: string }[] = [];
  for (const w of wanted) {
    const goal = typeof w.goal === "string" ? w.goal.trim() : "";
    const quote = typeof w.quote === "string" ? w.quote.trim() : "";
    if (goal.length < 8 || !wordsAreTheirs(quote, theirLines)) continue;
    out.push({ goal: goal.slice(0, 200), quote: quote.slice(0, 300) });
    if (out.length >= MAX_TASKS_PER_CALL) break;
  }
  return out;
}

export type CallTaskDeps = {
  read: (prompt: string) => Promise<Wanted[]>;
  start: typeof startTask;
  alreadyDone: (userId: string, key: string) => Promise<boolean>;
  record: (userId: string, key: string, content: string) => Promise<void>;
  // Open tasks from this call already (a promise Co made live opens one the moment it's said), and a note on one.
  existing?: (userId: string) => Promise<{ id: number; goal: string; theirWords: string }[]>;
  note?: (userId: string, taskId: number, text: string) => Promise<unknown>;
};

// Tasks opened in the last few hours that are still open: a call's live promises, and anything else from this call.
export const CALL_WINDOW_HOURS = 3;
async function recentOpen(userId: string): Promise<{ id: number; goal: string; theirWords: string }[]> {
  const since = Date.now() - CALL_WINDOW_HOURS * 3_600_000;
  return (await openTasks(userId)).filter((t) => new Date(t.createdAt).getTime() > since);
}

async function readWanted(prompt: string): Promise<Wanted[]> {
  const { text } = await generateText({ model: anthropic(MODELS.sonnet), providerOptions: { anthropic: { effort: "low" } }, experimental_telemetry: { isEnabled: true, functionId: "call.tasks.read", recordInputs: false, recordOutputs: false }, prompt });
  return parseModelJson<{ tasks?: Wanted[] }>(text).tasks ?? [];
}

const realDeps: CallTaskDeps = {
  read: readWanted,
  start: startTask,
  alreadyDone: async (userId, key) => (await pool.query(`SELECT 1 FROM call_promise_results WHERE user_id = $1 AND call_key = $2 AND content LIKE 'Started working on%' LIMIT 1`, [userId, key])).rows.length > 0,
  record: async (userId, key, content) => { await pool.query(`INSERT INTO call_promise_results (user_id, call_key, content) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [userId, key, content]); },
  existing: recentOpen,
  note: noteOnTask,
};

// Returns the goals it started. Never throws: a call's post-processing must not fail on this.
export async function tasksFromCall(userId: string, transcript: string, deps: CallTaskDeps = realDeps): Promise<string[]> {
  try {
    const theirs = theirLinesOnly(transcript).replace(/^\s*user\s*:\s*/gim, "").trim();
    if (theirs.length < 40) return [];
    const key = callKey(transcript);
    if (await deps.alreadyDone(userId, key)) return [];
    const asks = verifiedAsks(await deps.read(callTasksPrompt(theirs)), theirs);
    const started: string[] = [];
    const open = deps.existing ? await deps.existing(userId).catch(() => []) : [];
    for (const a of asks) {
      // The same commitment as a task already open from this call (Co promised it live, in answer to these words): that task
      // carries it, with their ask written on it, instead of a second task for the same thing (2026-10-08: tasks 111 and 114).
      const same = open.find((t) => sameCallCommitment({ goal: a.goal, theirWords: a.quote }, t));
      if (same) {
        await deps.note?.(userId, same.id, `They asked for this on the call: "${a.goal}" (their words: "${a.quote.slice(0, 160)}"). This task carries it.`)?.catch(() => null);
        started.push(a.goal);
        continue;
      }
      const s = await deps.start({
        userId,
        goal: a.goal,
        theirWords: a.quote,
        steps: [],
        firstPlan: `They asked for this on a call: "${a.quote.slice(0, 160)}". Do the first useful step, and text them only when you have something real.`,
        inHours: 6,
        source: "ask",
      });
      if (s.ok) started.push(a.goal);
    }
    if (started.length) await deps.record(userId, key, `Started working on ${started.map((g) => `"${g}"`).join(" and ")} after the call, because they asked for it. Co will text what it finds over the next days (at most one text a day per task); no promise of what or when.`);
    return started;
  } catch (err: any) {
    console.error("callTasks: failed (non-fatal):", err?.message ?? err);
    return [];
  }
}
