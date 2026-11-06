// Silence is not rejection, for the task engine, and calls that see task progress (Royce, 2026-11-06). Zero tokens, stubbed store.
//   1. A task that runs out with no answer closes as "expired" with a neutral line and writes no taste, outcome, kind or goal signal.
//   2. A task's unanswered text never counts toward turning a kind off; an answer to it still counts; other kinds still do.
//   3. A stated decline (their quoted word) still closes as a decline, released.
//   4. A call's context carries each open task's progress: owner only, open only, bounded, and never a result it doesn't have.
//   npx tsx evals/tasks/silenceNotNo.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const CT = await import("../../src/services/coTasks.js");
const TT = await import("../../src/services/taskTurn.js");
const K = await import("../../src/services/kindRestraint.js");
const L = await import("../../src/services/commitmentLog.js");
const CP = await import("../../src/services/callTaskProgress.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// The store: every query is captured; the task close returns one closed row.
let rowSource = "ask";
const sql: { text: string; args: any[] }[] = [];
const fake = async (text: string, args: any[] = []) => {
  const t = text.replace(/\s+/g, " ").trim();
  sql.push({ text: t, args });
  if (/^UPDATE co_tasks SET status = \$3/.test(t)) return { rowCount: 1, rows: [{ id: 7, kind: "work", source: rowSource, followup: {}, steps: [{ text: "look", done: false }], goal: "Find pottery classes", texts_sent: 2 }] };
  return { rowCount: 0, rows: [] as any[] };
};
(pool as any).query = fake;
(pool as any).connect = async () => ({ query: fake, release: () => {} });
const SIGNAL = /suggestion_outcomes|member_kind_preferences|co_lessons|co_lesson|co_goals SET|co_memories|proactive_sends|member_preferences|stale/i;
const writes = () => sql.filter((q) => /^(INSERT|UPDATE|DELETE)/i.test(q.text));

// 1. Running out.
{
  sql.length = 0;
  rowSource = "promise";
  const closed = await CT.closeRanOut("u-jordan", 7);
  rowSource = "ask";
  const upd = sql.find((q) => /^UPDATE co_tasks SET status = \$3/.test(q.text))!;
  check("running out closes the task", closed && !!upd);
  check("it closes as expired with the neutral line", upd.args[2] === "expired" && upd.args[3] === CT.RAN_OUT_OUTCOME && /no answer/i.test(CT.RAN_OUT_OUTCOME) && /says nothing about what they want/i.test(CT.RAN_OUT_OUTCOME));
  check("the line has no rejection words", !/\b(declin|reject|not interested|didn'?t want|no longer|their word|dropped:|they said)\b/i.test(CT.RAN_OUT_OUTCOME));
  check("no taste, outcome, kind, lesson or goal write comes with it", !writes().some((q) => SIGNAL.test(q.text)), writes().map((q) => q.text.slice(0, 80)));
  check("the ledger does not read it as their word (never 'released')", L.outcomeOf("expired", CT.RAN_OUT_OUTCOME, [], { sentAnything: true }) !== "released");
  const decision = sql.find((q) => /harness_decisions/.test(q.text) && JSON.stringify(q.args).includes("commitment.outcome"));
  check("the ledger row carries no quoted word of theirs", !decision || !/theirWord/.test(JSON.stringify(decision.args)));
}
{
  // The whole wake: a task past its wakes goes through the turn's own exhaustion path.
  sql.length = 0;
  const task: any = { id: 7, userId: "u-jordan", goal: "Find pottery classes", theirWords: "find me pottery classes", steps: [], planNext: null, nextCheckAt: null, status: "open", wakes: CT.TASK_LIMITS.maxWakes, notes: [], textsSent: 3, lastTextedAt: new Date().toISOString(), createdAt: new Date().toISOString(), deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: true, theirReplyAt: null, kind: "work", source: "ask" };
  const r = await TT.runTaskTurn(task);
  check("a task past its wakes, unanswered, ends as expired", r.action === "expired");
  const upd = sql.find((q) => /^UPDATE co_tasks SET status = \$3/.test(q.text));
  check("and closes with the neutral line", upd?.args[2] === "expired" && upd?.args[3] === CT.RAN_OUT_OUTCOME, upd?.args);
  check("the wake wrote nothing else about taste, kinds, lessons or goals", !writes().some((q) => SIGNAL.test(q.text)), writes().map((q) => q.text.slice(0, 80)));
  check("the exhaustion path is closeRanOut, nowhere a bare 'expired' with its own words", /await closeRanOut\(userId, task\.id\)/.test(src("services/taskTurn.ts")) && !/"expired", "Ran out/.test(src("services/taskTurn.ts")));
}

// 2. A task's text left unanswered is not a let-pass.
{
  const DAY = 86_400_000;
  const t0 = new Date("2026-11-01T17:00:00Z");
  const send = (id: string, kind: any, d: number, neutralSilence = false) => ({ id, kind, sentAt: new Date(t0.getTime() + d * DAY), message: `Text ${id} about something different`, ...(neutralSilence ? { neutralSilence } : {}) });
  const now = new Date(t0.getTime() + 20 * DAY);
  const find = (sends: any[], inbound: any[] = []) => K.evaluateKindRestraint({ sends, inbound, now }).get("find")!;
  check("control: two ordinary finds let pass turn the kind off", find([send("a", "find", 0), send("b", "find", 4)]).suppressed);
  const quiet = find([send("a", "find", 0, true), send("b", "find", 4, true), send("c", "find", 8, true)]);
  check("three look-out finds with no answer do not turn the kind off", !quiet.suppressed && !quiet.trial, quiet);
  check("and nothing is written as a learned preference", K.preferenceChanges(new Map([["find", quiet]]), []).length === 0);
  check("a look-out find and an ordinary one let pass count only the ordinary one", !find([send("a", "find", 0, true), send("b", "find", 4)]).suppressed);
  const answered = find([send("a", "find", 0, true), send("b", "find", 4)], [{ at: new Date(t0.getTime() + 0.2 * DAY), text: "yes please send those" }]);
  check("an answer to a look-out find still counts as an answer", !answered.suppressed && answered.evidence.join() === "a", answered);
  check("the history marks the task engine's own texts (task_update) as neutral", /String\(r\.type\) === "task_update" \? \{ neutralSilence: true \}/.test(src("services/kindRestraint.ts")));
  check("other kinds are untouched by it", !K.evaluateKindRestraint({ sends: [send("a", "find", 0, true)], inbound: [], now }).get("intro_followup")!.suppressed);
}

// 3. A stated decline is still a decline.
{
  const said = "no thanks, I'm not interested in that anymore";
  check("a task closed on their word is released, not missed", L.outcomeOf("dropped", `They said so: "${said}"`, [], { theirWord: said, sentAnything: true }) === "released");
  check("a close with no word of theirs is not released", L.outcomeOf("dropped", "Cue stopped working on it.", [], {}) === "missed");
  check("an opt-out close is released (their act, not silence)", L.outcomeOf("dropped", "Member opted out or archived.", [], {}) === "released");
  sql.length = 0;
  rowSource = "promise";
  await CT.closeTask("u-jordan", 7, "dropped", `They said so: "${said}"`, { theirWord: said });
  const d = sql.find((q) => /harness_decisions/.test(q.text) && JSON.stringify(q.args).includes("commitment.outcome"));
  check("closing on their word logs a released outcome with their word", !!d && JSON.stringify(d.args).includes("released") && JSON.stringify(d.args).includes("not interested"), d?.args);
  rowSource = "ask";
  check("a ran-out close is never given their word", /closeTask\(userId, id, "expired", RAN_OUT_OUTCOME\)/.test(src("services/coTasks.ts")));
}

// 4. A call sees task progress.
{
  const NOW = new Date("2026-11-06T18:00:00Z");
  const task = (over: any = {}): any => ({
    id: 11, userId: "u-jordan", goal: "Find pottery classes in the Mission", theirWords: "find me pottery classes", steps: [{ text: "search", done: true }, { text: "text options", done: false }], planNext: "Check the studio calendars", nextCheckAt: "2026-11-07T17:00:00Z", status: "open", wakes: 2,
    notes: [{ at: "2026-11-05T16:00:00Z", text: "Started." }, { at: "2026-11-05T18:00:00Z", text: "Read three studio calendars; two have Saturday beginner slots." }], textsSent: 1, lastTextedAt: "2026-11-05T19:00:00Z", createdAt: "2026-11-04T17:00:00Z", deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null,
    kind: "work", source: "ask", followup: { found: [{ name: "Clay Room Beginner Wheel", url: "https://example.com/clay" }] }, ...over,
  });
  const out = CP.renderTaskProgress([task()], "America/Los_Angeles")!;
  check("an open task shows its goal, last step, what was found, what was sent and the next look", /pottery classes/.test(out) && /Read three studio calendars/.test(out) && /Sent them 1 text/.test(out) && /Next look around/.test(out) && /Steps 1 of 2/.test(out), out);
  check("results the task merely saw are never shown as found", !/Clay Room|Found so far/.test(out), out);
  check("the section tells the call to answer from it and never imply a result", /answer from these lines/.test(out) && /never suggest a result you don't have/.test(out));
  const bare = CP.renderTaskProgress([task({ notes: [], steps: [], followup: {}, textsSent: 0, lastTextedAt: null, nextCheckAt: null })], "America/Los_Angeles")!;
  check("a task with nothing yet says so and names no result", /Nothing sent them yet/.test(bare) && /No progress noted yet/.test(bare) && !/found/i.test(bare.split("\n").slice(1).join(" ")), bare);
  check("a closed task is never shown", CP.renderTaskProgress([task({ status: "done" }), task({ status: "expired" }), task({ status: "dropped" })], null) === null);
  check("a follow-up or brief is not 'working on'", CP.renderTaskProgress([task({ kind: "followup" }), task({ kind: "research_brief" })], null) === null);
  check("a look-out Cue started itself is not shown; one they asked for is", CP.renderTaskProgress([task({ source: "lookout", lookoutOrigin: "co" })], null) === null && !!CP.renderTaskProgress([task({ source: "lookout", lookoutOrigin: "member" })], null));
  const many = Array.from({ length: 5 }, (_, i) => task({ id: i + 1, goal: `Goal number ${i} ${"words ".repeat(60)}`, notes: [{ at: "2026-11-05T18:00:00Z", text: "x ".repeat(300) }] }));
  const big = CP.renderTaskProgress(many, null)!;
  check("the section is bounded in tasks, line length and total size", big.split("\n").length - 1 <= CP.CALL_TASK_PROGRESS.tasks && big.length <= CP.CALL_TASK_PROGRESS.sectionChars + 5 && big.split("\n").slice(1).every((l) => l.length <= CP.CALL_TASK_PROGRESS.lineChars + 3), { n: big.length });

  // Owner only, through the real reader: a store holding two members' tasks, open and closed, answered by the query's own filters.
  const store = [
    { id: 1, user_id: "u-jordan", status: "open", kind: "work", goal: "Jordan's open search", at: 3 },
    { id: 2, user_id: "u-jordan", status: "done", kind: "work", goal: "Jordan's finished search", at: 2 },
    { id: 3, user_id: "u-ellis", status: "open", kind: "work", goal: "Ellis's open search", at: 1 },
  ];
  const reads: { text: string; args: any[] }[] = [];
  (pool as any).query = async (text: string, args: any[] = []) => {
    const t = text.replace(/\s+/g, " ").trim();
    reads.push({ text: t, args });
    if (!/FROM co_tasks WHERE user_id = \$1 AND status = 'open' AND kind = 'work'/.test(t)) return { rows: [] };
    return { rows: store.filter((r) => r.user_id === args[0] && r.status === "open" && r.kind === "work").map((r) => ({ ...r, theirs: 1, their_words: "", steps: [], notes: [], texts_sent: 0, wakes: 0, created_at: NOW, followup: null, source: "ask", final_told: false, awaiting_reply: false })) };
  };
  const mine = (await CP.callTaskProgress("u-jordan", null))!;
  check("the call's reader returns the member's own open task", /Jordan's open search/.test(mine), mine);
  check("never a closed task of theirs", !/finished search/.test(mine));
  check("never another member's task", !/Ellis/.test(mine));
  check("the query is the member's own open work, bound to their id", reads.every((q) => q.args[0] === "u-jordan") && reads.some((q) => /user_id = \$1 AND status = 'open'/.test(q.text)));
  check("a failed read is no section, not a guess", (await CP.callTaskProgress("u-jordan", null, async () => { throw new Error("db down"); })) === null);
  check("it is wired into the call's context, each line through the member-safety strip", /callTaskProgress\(userId, zone\)/.test(src("services/callContext.ts")) && /strip\(section\.split/.test(src("services/callContext.ts")));
  check("it only reads: no write in the module", !/INSERT|UPDATE|DELETE/.test(src("services/callTaskProgress.ts").replace(/\/\/.*$/gm, "")));
}

console.log(`${total - failed}/${total} passed`);
if (failed) process.exit(1);
