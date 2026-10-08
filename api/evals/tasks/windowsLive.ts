// Live on the DEV database, on the clean test member (texts to it are logged, never sent), with the model metered:
//   A. the reproduction: a call-style "tonight" promise whose first wake finds nothing, clock pinned to 7:30pm their time.
//      Expect the early warning sent before the window passes, once, and the window moved to the morning.
//   B. a plan-doc promise delivered as a document: the document record (co_facts) and the task closed with its loop.
//
//   EVAL_REAL_MODELS=1 EVAL_COST_CAP_USD=2 EVAL_TOKEN_CAP=4000000 npm run eval:live -- evals/tasks/windowsLive.ts
// Prints no phone number and no secret. Refuses to run unless the database is `railway` and the member is a test number.
import "../lib/requireMeter.js";
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const pool = (await import("../../src/db/db.js")).default;
const { isTestNumber } = await import("../../src/services/testNumbers.js");
const { trackCallCommitment } = await import("../../src/services/callCommitments.js");
const { getTask } = await import("../../src/services/coTasks.js");
const { runTaskTurn } = await import("../../src/services/taskTurn.js");
const { writeMemory } = await import("../../src/services/memory.js");
const { localStamp } = await import("../../src/services/memberTime.js");

const db = (await pool.query(`SELECT current_database() AS db`)).rows[0]?.db;
if (db !== "railway" || new URL(process.env.DATABASE_URL!).port !== "55441") throw new Error("not the dev database through this run's own tunnel");
const { rows: m } = await pool.query(`SELECT id, phone_number FROM users WHERE phone_number LIKE '+141555501%' AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`);
if (!m[0] || !isTestNumber(m[0].phone_number)) throw new Error("no clean test member: run testMember reset first");
const userId: string = m[0].id;
const ZONE = "America/Los_Angeles";
console.log(`database: ${db} | test member: ${userId}`);
const show = (label: string, x: unknown) => console.log(`${label}: ${JSON.stringify(x, null, 2)}`);
// The search finds nothing it can verify (the reproduction): the event feed and the web both come back empty.
const nothing = { search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "Nothing came back that proved itself on its page." }) } as any;

// ======================================================================= A. "tonight", nothing found, next check past 8pm
if ((process.env.ONLY ?? "AB").includes("A")) {
  const said = new Date("2026-10-08T02:20:00Z"); // 7:20pm SF, Wednesday
  const wake = new Date("2026-10-08T02:30:00Z"); // 7:30pm SF: the first wake, right after the call
  await writeMemory(userId, "text_exchange", "User said: Can you find me a private dining room for twelve near Hayes Valley for next Thursday?");
  const t = await trackCallCommitment({ userId, sentence: "I'll text you the private dining options tonight.", theirLine: "Can you find me a private dining room for twelve near Hayes Valley for next Thursday?", now: said });
  if (!t.ok) throw new Error(`commitment not tracked: ${t.why}`);
  const task = (await getTask(userId, t.task.id))!;
  console.log(`\n== A. task #${task.id}: ${task.goal}`);
  show("window (their time)", { words: task.window?.words, deadline: localStamp(task.window!.deadline, ZONE), warnBy: localStamp(task.window!.warnBy, ZONE), said: localStamp(said, ZONE), firstWake: localStamp(wake, ZONE) });
  const r = await runTaskTurn(task, { now: () => wake, override: nothing });
  show("turn", { action: r.action, did: r.did, warning: r.warning });
  const sends = await pool.query(`SELECT type, target_key, message, exempt FROM proactive_sends WHERE user_id = $1 AND type = 'task_window' ORDER BY id`, [userId]);
  show("proactive_sends (task_window)", sends.rows);
  const out = await pool.query(`SELECT content, sender FROM outbound_messages WHERE user_id = $1 ORDER BY sent_at`, [userId]).catch(() => ({ rows: [] }));
  show("outbound_messages (logged for the test number, never sent)", out.rows);
  const after = (await getTask(userId, task.id))!;
  show("task after", { status: after.status, nextCheck: after.nextCheckAt ? localStamp(after.nextCheckAt, ZONE) : null, window: after.window ? { words: after.window.words, deadline: localStamp(after.window.deadline, ZONE), warnedFor: after.window.warnedFor?.map((d) => localStamp(d, ZONE)) } : null, notes: after.notes.slice(-3).map((n) => n.text) });
  // Once per window, held by the send path itself: the same task as it was before the warning (the old window, not marked warned)
  // woken again at 7:35pm. The send key is the window, so nothing new goes out.
  const again = await runTaskTurn(task, { now: () => new Date(wake.getTime() + 5 * 60_000), override: nothing });
  const count = (await pool.query(`SELECT count(*)::int AS n FROM proactive_sends WHERE user_id = $1 AND type = 'task_window'`, [userId])).rows[0].n;
  show("second wake, same window", { warning: again.warning, task_window_sends_total: count });
  // Leave nothing running on dev: close the reproduction's task.
  await pool.query(`UPDATE co_tasks SET status = 'dropped', outcome = 'live check done', closed_at = NOW(), next_check_at = NULL WHERE user_id = $1 AND id = $2 AND status = 'open'`, [userId, task.id]);
}

// ======================================================================= B. a plan-doc promise, delivered as a document
if ((process.env.ONLY ?? "AB").includes("B")) {
  const said = new Date("2026-10-08T19:50:00Z"); // 12:50pm SF, Thursday
  const wake = new Date("2026-10-08T20:00:00Z"); // 1pm SF
  const theirs = "After our launch event in November I want the people we meet to remember us. I don't want it to be a one night thing, and I'd like a plan for staying in touch with them.";
  await writeMemory(userId, "text_exchange", `User said: ${theirs}`);
  const t = await trackCallCommitment({ userId, sentence: "I'll put together the plan for staying present with the people from your November launch event and text you the draft this afternoon.", theirLine: theirs, now: said });
  if (!t.ok) throw new Error(`commitment not tracked: ${t.why}`);
  const task = (await getTask(userId, t.task.id))!;
  // The 15-minute loop pass opens the task's loop; run it now so the close below has a loop to close.
  await (await import("../../src/services/openLoops.js")).syncOpenLoops(userId);
  console.log(`\n== B. task #${task.id}: ${task.goal}`);
  show("steps / first plan", { steps: task.steps.map((s) => s.text), plan: task.planNext, window: task.window?.words });
  const r = await runTaskTurn(task, { now: () => wake, override: nothing });
  show("turn", { action: r.action, did: r.did, warning: r.warning });
  const facts = await pool.query(`SELECT relation, object_label, source, meta FROM co_facts WHERE owner_user_id = $1 AND subject = 'co' AND relation = 'sent' ORDER BY created_at`, [userId]);
  show("co_facts (Co's record of the send)", facts.rows);
  const mem = await pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'Co replied: [sent a document%' ORDER BY created_at`, [userId]);
  show("their thread (text_exchange)", mem.rows.map((x: any) => x.content));
  const out = await pool.query(`SELECT content, sender FROM outbound_messages WHERE user_id = $1 ORDER BY sent_at`, [userId]).catch(() => ({ rows: [] }));
  show("outbound_messages since the start (logged, never sent)", out.rows);
  const decision = await pool.query(`SELECT action, outcome, reason, proposal FROM harness_decisions WHERE user_id = $1 AND decision = 'task.writeDocument' ORDER BY created_at`, [userId]).catch((e: any) => ({ rows: [{ error: String(e?.message ?? e).slice(0, 80) }] }));
  show("decision rows (task.writeDocument)", decision.rows);
  const raw = await pool.query(`SELECT status, outcome, followup->'window'->>'closedAt' AS window_closed FROM co_tasks WHERE user_id = $1 AND id = $2`, [userId, task.id]);
  show("task after", raw.rows[0]);
  const loops = await pool.query(`SELECT source, source_ref, status, closed_at IS NOT NULL AS closed, closed_reason FROM open_loops WHERE user_id = $1 ORDER BY id`, [userId]).catch(() => ({ rows: [] }));
  show("open_loops", loops.rows);
}
await pool.end();
