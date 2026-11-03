// Never reopen what they closed (harness/closedSubject.ts, Royce 2026-11-03). The whole-exchange baseline's top failure: finds after a
// drop (venue finds 7h after "got the venue", a DJ find days after "not doing the party", "found another one for this weekend" after
// the weekend ask was dropped). Every proactive path re-reads what the candidate serves right before drafting and inside the send lock;
// a closed subject drops it (proactive.dropped_closed). And one acknowledgment: the goal_closed moment stays quiet when the reply that
// closed the goal already said it.
// Layer 1: zero tokens, no database (fakes), no outside calls. Invented members (Rowan, Tess, Ilse).
//   npx tsx evals/proactive/closedSubjects.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
import fs from "node:fs";
import { installFakeLedger } from "../lib/fakeLedger.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const CS = await import("../../src/harness/closedSubject.js");
const P = await import("../../src/harness/proactive.js");
const G = await import("../../src/harness/notifyGate.js");
const D = await import("../../src/services/deferredSends.js");
const CR = await import("../../src/services/callReason.js");
const GJ = await import("../../src/services/goalJourney.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const { default: pool } = await import("../../src/db/db.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");
// No outside call from this file: what a send records afterward (its memory embedding) answers with a zero vector.
const EMB = await import("../../src/services/embeddings.js");
EMB.setEmbeddingsClientForTests({ embeddings: { create: async (b: any) => ({ data: (Array.isArray(b.input) ? b.input : [b.input]).map((_: unknown, index: number) => ({ index, embedding: new Array(1536).fill(0) })) }) } } as any);

const ROWAN = "u-rowan";
type Rows = Parameters<typeof CS.closedSetFrom>[0];
const empty = (): Rows => ({ asks: [], tasks: [], askTasks: [], intent: [], threads: [], loops: [] });
const cand = (type: string, payload: Record<string, unknown> = {}, targetKey = `${type}:x`): any => ({ id: `${type}-${Math.random().toString(36).slice(2, 7)}`, userId: ROWAN, type, targetKey, topicKey: targetKey, summary: "", priority: 50, dueAt: new Date(0), expiresAt: null, payload, attempts: 0, createdAt: new Date(0) });
const clsOf = (c: any) => G.candidateClass(c.type, P.isAnswering(c), c.payload);
const closedFor = (c: any, rows: Rows) => CS.closedSubjectFor(c, CS.closedSetFrom(rows), clsOf(c));

// ---------------------------------------------------------------- 1. the baseline shapes
{
  // "got the venue": the venue ask closed at their word (the #351 retire read writes closed_reason member).
  const rows = { ...empty(), asks: [{ id: "71", ask_id: "a-venue", closed_reason: "member" }] };
  const find = cand("event_offer", { askId: "a-venue", askText: "a venue for the launch", fromProfile: false, match: { name: "The Loft" } });
  check("venue: a find for the venue ask after \"got the venue\" is dropped", closedFor(find, rows)?.ref.kind === "ask");
  check("venue: by the ask row's id too", closedFor(cand("event_offer", { askId: "71", fromProfile: false }), rows) !== null);
  check("venue: a reminder about a venue already shown still goes (the #361 exemption)", closedFor(cand("event_offer", { askId: "a-venue", reminder: true, fromProfile: false }), rows) === null);
  // The venue ask closed some other way (Cue delivered a find for a question): the #361 rule for finds is unchanged.
  check("venue: a find for an ask closed as delivered stays dead, as #361 had it", closedFor(find, { ...empty(), asks: [{ id: "71", ask_id: "a-venue", closed_reason: "delivered" }] }) !== null);
  // The venue look-out ran as Cue's task (source lookout), its results at the door (task_update, taskId): the task was dropped at their word.
  const lookoutResult = cand("task_update", { door: true, cls: "requested", taskId: 41, messages: ["https://example.com/loft", "Two more venues"] }, "task:41:1730000000000");
  const dropped = { ...empty(), tasks: [{ id: 41, status: "dropped", outcome: "Dropped: they said it's no longer needed" }] };
  check("venue: the look-out's queued venue results are dropped once they dropped the task", closedFor(lookoutResult, dropped)?.ref.id === "41");
  // The same task closed by Cue itself (its last result still waiting at the door): requested work they still want goes.
  check("a task Cue closed itself never stops its own result", closedFor(lookoutResult, { ...empty(), tasks: [{ id: 41, status: "done", outcome: "Sent the shortlist." }] }) === null);
  check("a task closed with their words in the commitment log counts as theirs", closedFor(lookoutResult, { ...empty(), tasks: [{ id: 41, status: "done", outcome: "We booked it", their_word: true }] }) !== null);
}
{
  // "not doing the party": the DJ ask dropped (moved_on, quoted from their words), and the party thread changed at their word.
  const rows: Rows = { ...empty(), asks: [{ id: "88", ask_id: "a-dj", closed_reason: "moved_on" }], threads: [{ id: "th-party", status: "changed", closed_quote: "not doing the party anymore" }], askTasks: [{ id: 52, target_key: "ask_checkin:a-dj" }] };
  check("DJ: a DJ find after \"not doing the party\" is dropped", closedFor(cand("event_offer", { askId: "a-dj", fromProfile: false }), rows) !== null);
  check("DJ: the task still open for that ask closes with it (its results are dropped)", closedFor(cand("task_update", { door: true, cls: "requested", taskId: 52 }, "task:52:1"), rows)?.ref.kind === "task");
  check("DJ: a check-in on the party thread is dropped", closedFor(cand("companion", { threadId: "th-party" }), rows)?.ref.kind === "thread");
  check("DJ: \"how did the party go\" is dropped", closedFor(cand("window_followup", { threadId: "th-party" }, "thread:th-party"), rows) !== null);
  check("DJ: a profile find the thread read tied to the party is dropped", closedFor(cand("event_offer", { askId: "profile", fromProfile: true, threadRead: { thread: "th-party", at: "2026-11-01" } }), rows) !== null);
  check("DJ: a thread that changed without their quote (a dedupe) closes nothing", closedFor(cand("companion", { threadId: "th-party" }), { ...empty(), threads: [{ id: "th-party", status: "changed", closed_quote: null }] }) === null);
  check("DJ: Cue's closeAsk tool on their word counts as theirs", CS.askClosedAtTheirWord("closed by Cue: no longer wanted") && CS.askClosedAtTheirWord("member") && CS.askClosedAtTheirWord("moved_on"));
  check("DJ: answered, delivered, expired, co and moved are not their word", ["answered", "delivered", "expired", "co", "moved", "archived", null].every((r) => !CS.askClosedAtTheirWord(r as any)));
}
{
  // "found another one for this weekend" after the weekend ask was dropped: a find for that ask, any shape, never goes.
  const rows = { ...empty(), asks: [{ id: "93", ask_id: "a-weekend", closed_reason: "closed by Cue: they said they're staying in" }] };
  check("weekend: another weekend find after the drop is dropped", closedFor(cand("event_offer", { askId: "a-weekend", fromProfile: false }), rows) !== null);
  check("weekend: the bounce plan for it is dropped", closedFor(cand("bounce_proposal", { askId: "a-weekend" }), rows) !== null);
  check("weekend: the ask's check-in is dropped", closedFor(cand("ask_checkin", { askCheckinId: "93", askId: "a-weekend" }), rows) !== null);
  check("weekend: \"still want me looking?\" for it is dropped", closedFor(cand("goal_recheck", { kind: "ask", askId: "93" }), rows) !== null);
}
{
  // Requested work they still want: dropped only when they closed it themselves.
  const answered = { ...empty(), asks: [{ id: "95", ask_id: "a-q", closed_reason: "answered" }] };
  // A possible intro for their ask (requested: it answers what they asked for) after Cue answered the ask: they still want it.
  check("requested: an intro tease for an ask Cue answered still goes", clsOf(cand("network_tease", { askId: "a-q" })) === "requested" && closedFor(cand("network_tease", { askId: "a-q" }), answered) === null);
  check("requested: the same tease after they closed the ask is dropped", closedFor(cand("network_tease", { askId: "a-q" }), { ...empty(), asks: [{ id: "95", ask_id: "a-q", closed_reason: "member" }] }) !== null);
  check("a check-in (not requested) on an ask Cue already answered is dropped, as the check-in gate would", closedFor(cand("ask_checkin", { askCheckinId: "95", askId: "a-q" }), answered) !== null);
  check("unrequested: Cue's own plan for an ask that expired is dropped", closedFor(cand("bounce_proposal", { askId: "a-q" }), { ...empty(), asks: [{ id: "95", ask_id: "a-q", closed_reason: "expired" }] }) !== null);
}
{
  // Goals, loops, member-state nudges.
  const rows: Rows = { ...empty(), intent: [{ id: "g1", kind: "goal", status: "resolved", closed_by: "member", text: "open a ceramics studio" }, { id: "g2", kind: "goal", status: "active", text: "learn Portuguese" }], loops: [{ id: 9, status: "done", closed_reason: "co" }, { id: 10, status: "dropped", closed_reason: "stale" }], threads: [{ id: "th-run", status: "resolved", closed_quote: "ran it!" }] };
  check("goal: a seasonal check-in on a goal they closed is dropped", closedFor(cand("goal_checkin", { goalId: "g1" }), rows)?.ref.kind === "goal");
  check("goal: one on a goal still active goes", closedFor(cand("goal_checkin", { goalId: "g2" }), rows) === null);
  check("goal: the goal_closed moment itself is never dropped by this", closedFor(cand("goal_closed", { goalId: "g1" }), rows) === null);
  check("loop: \"still on your plate?\" for a loop marked done is dropped", closedFor(cand("loop_check", { loopId: 9 }), rows) !== null);
  // Sends with no payload, read by their key alone (sendExempt's lock, deferred rows).
  check("key: a goal check-in sent as a task update (task:<id>:checkin:<goal>) reads its goal", CS.subjectRefs({ type: "task_update", targetKey: "task:61:checkin:g1" }).some((r) => r.kind === "goal" && r.id === "g1"));
  check("key: ...and is dropped once that goal closed, its task still open", closedFor(cand("task_update", { cls: "checkin" }, "task:61:checkin:g1"), rows)?.ref.kind === "goal");
  check("key: ...one on a goal still active goes", closedFor(cand("task_update", { cls: "checkin" }, "task:61:checkin:g2"), rows) === null);
  check("key: a research brief's key (research_brief:<task>) reads its task", CS.subjectRefs({ type: "task_update", targetKey: "research_brief:44" }).some((r) => r.kind === "task" && r.id === "44"));
  check("key: a brief whose task they dropped is dropped; one Cue closed itself goes", closedFor(cand("task_update", { cls: "requested" }, "research_brief:44"), { ...empty(), tasks: [{ id: 44, status: "dropped", outcome: "Dropped: they said no longer needed" }] }) !== null && closedFor(cand("task_update", { cls: "requested" }, "research_brief:44"), { ...empty(), tasks: [{ id: 44, status: "done", outcome: "Sent the brief." }] }) === null);
  check("key: an unrelated key carries no subject", CS.subjectRefs({ type: "co_event", targetKey: "noshow_ask:evt-1" }).length === 0);
  check("loop: a loop that only went stale isn't a close", closedFor(cand("loop_check", { loopId: 10 }), rows) === null);
  check("nudge: a goal nudge on a closed goal is dropped", closedFor(cand("goal_nudge", { entryKey: "goal:g1", fingerprint: "f" }), rows) !== null);
  check("nudge: a commitment nudge on a thread they resolved is dropped", closedFor(cand("commitment_nudge", { entryKey: "commitment:th-run", fingerprint: "f" }), rows) !== null);
  check("nothing closed: nothing dropped", closedFor(cand("event_offer", { askId: "a-open", fromProfile: false }), rows) === null && closedFor(cand("companion", { threadId: "th-open" }), rows) === null);
  check("a profile find with no thread read serves no subject", CS.subjectRefs(cand("event_offer", { askId: "profile", fromProfile: true })).length === 0);
  check("a call's promise is never an ask row", CS.subjectRefs(cand("event_offer", { askId: "promise:abc", fromProfile: false })).length === 0);
  check("ops texts serve nothing", ["name_change", "announcement", "voice_read_ask", "product_update"].every((t) => CS.subjectRefs(cand(t, { goalId: "g1" })).length === 0));
}

// ---------------------------------------------------------------- 2. the read (one member's rows), and the log line
{
  const seen: string[] = [];
  const db = {
    query: async (sql: string, a: any[] = []) => {
      seen.push(sql);
      if (a[0] !== ROWAN) return { rows: [] };
      if (/FROM ask_checkins/.test(sql)) return { rows: [{ id: "71", ask_id: "a-venue", closed_reason: "member" }] };
      if (/FROM co_tasks WHERE user_id = \$1 AND status IN \('done','dropped'\)/.test(sql)) return { rows: [{ id: 41, status: "dropped", outcome: "Cue stopped" }, { id: 42, status: "done", outcome: "Sent it." }] };
      if (/FROM co_tasks WHERE user_id = \$1 AND status = 'open'/.test(sql)) return { rows: [{ id: 52, target_key: "ask_checkin:a-venue" }] };
      if (/FROM co_profiles/.test(sql)) return { rows: [{ intent: [{ id: "g1", kind: "goal", status: "resolved", closed_by: "member" }] }] };
      if (/FROM member_threads/.test(sql)) return { rows: [{ id: "th-1", status: "resolved", closed_quote: "done" }] };
      if (/FROM open_loops/.test(sql)) return { rows: [{ id: 9, status: "done", closed_reason: "co" }] };
      if (/commitment\.outcome/.test(sql)) return { rows: [{ id: "41" }] };
      return { rows: [] };
    },
  };
  const set = await CS.loadClosedSubjects(ROWAN, db);
  check("read: asks by both ids, at their word", set.get("ask:a-venue")?.theirWord === true && set.get("ask:71")?.theirWord === true);
  check("read: a task whose close kept their words in the commitment log is theirs", set.get("task:41")?.theirWord === true);
  check("read: a task Cue closed itself is on file but not theirs", set.get("task:42")?.theirWord === false);
  check("read: the open task for the closed ask closes with it", set.get("task:52")?.theirWord === true);
  check("read: goals, threads, loops", set.has("goal:g1") && set.has("thread:th-1") && set.has("loop:9"));
  check("read: one member's rows only", seen.length === 7 && seen.every((q) => /user_id = \$1/.test(q)));
  const dec = CS.droppedClosedDecision({ userId: ROWAN, stage: "send_lock", candidate: { id: "c1", type: "event_offer", targetKey: "event_offer:x" }, hit: set.get("ask:a-venue")! });
  const WS = await import("../../src/services/workingSet.js");
  check("a find dropped for a closed subject is never a judgment of the find (it may serve another ask)", WS.isFailedAttempt(CS.closedReason(set.get("ask:a-venue")!)) && CS.SUBJECT_CLOSED === "what it serves has closed");
  check("log: proactive.dropped_closed with ids and states only", dec.decision === "proactive.dropped_closed" && dec.action === "send_lock:event_offer" && dec.proposal.ref === "ask:a-venue" && dec.reason.startsWith(CS.SUBJECT_CLOSED) && !/venue for/.test(JSON.stringify(dec)));
}

// ---------------------------------------------------------------- 3. inside the send lock (the daily pick's send, a held send, a document claim)
function zoneAtHour(hour: number): string {
  let off = (hour - new Date().getUTCHours() + 24) % 24;
  if (off > 14) off -= 24;
  return off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
}
const person = { userId: ROWAN, firstName: "Rowan", phoneNumber: "+15035550177", city: "Portland", timezone: zoneAtHour(13) };
function withClosed(closedRows: { asks?: any[]; tasks?: any[]; threads?: any[] }) {
  const f = installFakeLedger(pool, sendblue);
  const inner = (pool as any).query;
  const sql: string[] = [];
  const decisions: any[] = [];
  const wrap = async (s: string, a: any[] = []) => {
    const q = s.replace(/\s+/g, " ").trim();
    sql.push(q);
    if (/^INSERT INTO harness_decisions/.test(q)) {
      decisions.push({ decision: a[1], action: a[4], proposal: a[5] ? JSON.parse(a[5]) : null, reason: a[8] });
      return { rows: [{ id: "1", created_at: new Date() }] };
    }
    if (/FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NOT NULL/.test(q)) return { rows: closedRows.asks ?? [] };
    if (/FROM co_tasks WHERE user_id = \$1 AND status IN \('done','dropped'\)/.test(q)) return { rows: closedRows.tasks ?? [] };
    if (/FROM member_threads WHERE user_id = \$1 AND status IN \('resolved','changed'\)/.test(q)) return { rows: closedRows.threads ?? [] };
    return inner(s, a);
  };
  (pool as any).query = wrap;
  (pool as any).connect = async () => ({ query: wrap, release: () => {} });
  return { ...f, sql, decisions };
}
{
  // The pick composed a check-in on the party thread; they said "not doing the party" while it was being written.
  const f = withClosed({ threads: [{ id: "th-party", status: "changed", closed_quote: "not doing the party" }] });
  try {
    const c = cand("companion", { threadId: "th-party", thread: { text: "the launch party" } }, "companion:thread:th-party:r1");
    const r = await P.sendWithLedgerForTests(c, person as any, ["How's the party planning going?"], { ignorePacing: true });
    check("lock: a send whose thread closed while it was written doesn't go", !r.sent && f.ledger.outbox.length === 0 && f.ledger.sends.length === 0, r);
    check("lock: it says why, and hands back what closed", !r.sent && r.failed.some((k) => k.name === "subject_closed") && (r as any).closed?.[0]?.candidate.id === c.id);
    check("lock: read inside the transaction, before the ledger row", f.sql.findIndex((q) => /FROM member_threads/.test(q)) > f.sql.findIndex((q) => /pg_advisory_xact_lock/.test(q)) && f.sql.some((q) => /^SAVEPOINT closed_read/.test(q)));
    // A ride-along find for an ask they dropped stops the whole send; the lead waits for the next pick.
    const lead = cand("event_offer", { askId: "a-open", fromProfile: false }, "event_offer:lead");
    const rider = cand("event_offer", { askId: "a-dj", fromProfile: false }, "event_offer:dj");
    const f2 = withClosed({ asks: [{ id: "88", ask_id: "a-dj", closed_reason: "moved_on" }] });
    try {
      const r2 = await P.sendWithLedgerForTests(lead, person as any, ["https://example.com/a", "One for you."], { ignorePacing: true }, [{ candidate: rider, messages: ["https://example.com/dj", "A DJ night."] }]);
      check("lock: a closed rider stops the send; only it is handed back", !r2.sent && (r2 as any).closed?.length === 1 && (r2 as any).closed[0].candidate.id === rider.id && f2.ledger.outbox.length === 0, r2);
    } finally { f2.restore(); }
  } finally { f.restore(); }
  // Nothing closed: it goes as before.
  const g = withClosed({});
  try {
    const c = cand("companion", { threadId: "th-open" }, "companion:thread:th-open:r1");
    const r = await P.sendWithLedgerForTests(c, person as any, ["How did the move go?"], { ignorePacing: true });
    check("lock: an open subject sends as before", r.sent && g.ledger.outbox.length === 1, r);
  } finally { g.restore(); }
}
{
  // A task's result sent straight out (it answered their latest message): they dropped the task meanwhile.
  const f = withClosed({ tasks: [{ id: 41, status: "dropped", outcome: "Dropped: they said it's no longer needed" }] });
  try {
    const r = await P.sendExempt({ userId: ROWAN, phoneNumber: person.phoneNumber, type: "task_update", targetKey: "task:41:1730000000000", messages: ["Found two venues for you"], timezone: person.timezone });
    check("held send: a task result for a task they dropped never goes", !r.sent && f.ledger.outbox.length === 0 && String(r.reason).startsWith(CS.SUBJECT_CLOSED), r);
    check("held send: logged as proactive.dropped_closed", f.decisions.some((d) => d.decision === "proactive.dropped_closed" && d.action === "exempt_lock:task_update" && d.proposal?.ref === "task:41"), f.decisions);
    const ok = await P.sendExempt({ userId: ROWAN, phoneNumber: person.phoneNumber, type: "task_update", targetKey: "task:77:1730000000000", messages: ["Here's the draft"], timezone: person.timezone });
    check("held send: another task's result goes as before", ok.sent && f.ledger.outbox.length === 1, ok);
    const claim = await P.claimCoInitiatedSend({ userId: ROWAN, type: "task_update", targetKey: "task:41:doc:1", message: "[document] Venues", kind: "find", timezone: person.timezone, owed: { askedAt: null } });
    check("document claim: a look-out's document for the dropped task is never claimed", !claim.ok && String((claim as any).reason).startsWith(CS.SUBJECT_CLOSED), claim);
  } finally { f.restore(); }
  // Cue closed the task itself: its result, owed, still goes.
  const g = withClosed({ tasks: [{ id: 41, status: "done", outcome: "Sent the shortlist." }] });
  try {
    const r = await P.sendExempt({ userId: ROWAN, phoneNumber: person.phoneNumber, type: "task_update", targetKey: "task:41:1730000000001", messages: ["Two more for you"], timezone: person.timezone });
    check("held send: a result for a task Cue closed itself still goes", r.sent, r);
  } finally { g.restore(); }
}
{
  // Deferred rows (held for hours or a rule): read again before they go or enter the door.
  const closedRead = async () => CS.closedSetFrom({ ...empty(), tasks: [{ id: 41, status: "dropped", outcome: "Dropped: what it served is off, at their word" }] });
  const row = { user_id: ROWAN, type: "task_update" as const, target_key: "task:41:1", after_kind: null };
  check("deferred: a held task result for a task they dropped is closed", (await D.deferredRowClosed(row, closedRead))?.ref.id === "41");
  check("deferred: a relay or a reminder serves nothing here", (await D.deferredRowClosed({ ...row, type: "event_change" as any, target_key: "reminder:5" }, closedRead)) === null);
  check("deferred: a failed read holds nothing back", (await D.deferredRowClosed(row, async () => { throw new Error("down"); })) === null);
  check("deferred: the drop is skipped, never retried", D.outcomeOf({ sent: false, reason: `${CS.SUBJECT_CLOSED}: task 41 (dropped, at their word)` }, true) === "skipped");
}

// ---------------------------------------------------------------- 4. where each path reads it (the dispatch: start, before the draft, the lock)
{
  const P_SRC = src("harness/proactive.ts");
  const body = P_SRC.slice(P_SRC.indexOf("async function dispatchForUserInScope"));
  const start = body.indexOf('closedAmong(all, closedAtStart)');
  const pre = body.indexOf('dropClosed(registry, userId, closedBeforeDraft, "before_draft")');
  check("dispatch: every queued candidate is read at the start, before the pick sees it", start > 0 && start < body.indexOf("evaluateCandidates(state, opts)"));
  check("dispatch: read again right before drafting, ahead of the relevance read, the bundle and the draft", pre > 0 && pre < body.indexOf("needsRelevanceCheck(c, state.now)") && pre < body.indexOf("B.composeBundle(") && pre < body.indexOf("registry[c.type].draft(c, person)"));
  check("dispatch: a closed sibling never rides (it leaves what the bundle is built from, before the bundle)", body.indexOf("ev.eligible.splice(ev.eligible.indexOf(f.candidate), 1)") > pre && body.indexOf("ev.eligible.splice(ev.eligible.indexOf(f.candidate), 1)") < body.indexOf("pickSiblingOffers(c, ev.eligible)"));
  check("dispatch: what closed inside the lock is dropped and logged", /result\.closed\?\.length\) await dropClosed\(registry, userId, result\.closed, "send_lock"\)/.test(body));
  const lock = P_SRC.slice(P_SRC.indexOf("async function sendWithLedger("), P_SRC.indexOf("export const sendWithLedgerForTests"));
  check("sendWithLedger: read inside the lock, before the ledger row and the send", lock.indexOf("closedInLock(client") > lock.indexOf("pg_advisory_xact_lock") && lock.indexOf("closedInLock(client") < lock.indexOf("INSERT INTO proactive_sends"));
  const D_SRC = src("services/deferredSends.ts");
  check("deferred: read before the door hand-off and the send", D_SRC.indexOf("deferredRowClosed(row") < D_SRC.indexOf("doorTakesRow(row)) {") && D_SRC.indexOf("deferredRowClosed(row") > 0);
  const reg = src("harness/proactiveRegistry.ts");
  check("door: a closed drop never tells the task to say it again", /closedNow \? `\$\{DOOR_DROPPED_NOTE\}: what it served had closed/.test(reg));
}

// ---------------------------------------------------------------- 5. calls Cue starts
{
  const now = new Date("2026-11-03T18:00:00Z");
  const base = { now, zone: "America/Los_Angeles", kind: "checkin_cadence" as const, nudges: [] as any[], threads: [] as any[], claims: [] as any[], milestones: [] as any[], plans: [] as any[], coWork: [], recentReasonKeys: [] };
  const claim = { text: "planning the launch party with a DJ", provenance: "user_said", kind: "plan", quote: "planning the launch party", saidOn: "2026-11-01", confirmedOn: "2026-11-01", expiresOn: "2026-11-08" };
  const closed = { keys: new Set<string>(["goal:g1", "thread:th-party"]), labels: ["find a DJ for the launch party"] };
  const without = CR.callReasonFor({ ...base, claims: [claim] } as any);
  const withClosed = CR.callReasonFor({ ...base, claims: [claim], closed } as any);
  check("call: before, the dropped party was a reason to call", without.reason?.text === claim.text);
  check("call: a Cue-started call never opens on what they dropped", withClosed.reason === null && withClosed.considered.some((x) => !x.kept && /dropped lately/.test(x.why ?? "")), withClosed);
  const goalNudge = { type: "goal_nudge", kind: "goal_nudge", entryKey: "goal:g1", fingerprint: "f", dueAt: now, expiresAt: new Date(now.getTime() + 86_400_000), facts: { the_goal_in_their_words: "open a ceramics studio" }, meta: {}, summary: "" };
  const g = CR.callReasonFor({ ...base, nudges: [goalNudge], closed } as any);
  check("call: a goal they closed is never the reason, by its id", g.reason === null && g.considered.some((x) => /they closed it \(goal:g1\)/.test(x.why ?? "")), g);
  check("call: a celebration of what they finished is still a reason", CR.reopensClosed({ kind: "celebration", key: "milestone:m1", text: "find a DJ for the launch party" }, closed) === null);
  check("call: a reason with nothing closed is untouched", CR.reopensClosed({ kind: "coming_up", key: "claim:plan:x", text: "dinner with their sister on Friday" }, closed) === null);
  check("call: the closed read is part of the call reason's reads", /loadClosedCallSubjects\(userId, pool\)/.test(src("services/callReason.ts")));
  // The labels: only what they dropped (a solved venue leaves the party ahead), from the #368 record's closedLately.
  const callDb = { query: async (sql: string) => {
    if (/UNION ALL/.test(sql)) return { rows: [{ label: "Find a DJ for the launch party", status: "dropped" }, { label: "Find a venue for the launch party", status: "done" }] };
    if (/FROM ask_checkins/.test(sql)) return { rows: [{ id: "88", ask_id: "a-dj", closed_reason: "member" }] };
    return { rows: [] };
  } };
  const loaded = await CR.loadClosedCallSubjects(ROWAN, callDb);
  check("call: the labels are what they dropped, never what they solved", loaded.labels.length === 1 && /DJ/.test(loaded.labels[0]) && loaded.keys.has("ask:a-dj"), loaded);
  check("call: \"got the venue\" leaves the party itself a reason to call", CR.reopensClosed({ kind: "coming_up", key: "claim:plan:p", text: "the launch party next Friday" }, loaded) === null);
  check("call: dropping the DJ doesn't make the whole party a reopening", !CR.sameThing("the launch party next Friday", "Find a DJ for the launch party"));
}

// ---------------------------------------------------------------- 6. one acknowledgment (the goal_closed moment)
{
  const goal = "open a ceramics studio";
  check("ack: the turn's move was close", GJ.replyAcknowledgedClose({ moves: ["close"], lines: [], goal }).acknowledged);
  check("ack: a warm word in Cue's reply", GJ.replyAcknowledgedClose({ moves: ["answer"], lines: ["Congrats, that's a big one."], goal }).acknowledged);
  check("ack: a plain word that names the goal", GJ.replyAcknowledgedClose({ moves: ["answer"], lines: ["Got it, I'll stop looking for ceramics studio spaces."], goal }).acknowledged);
  check("ack: a plain word about something else isn't it", !GJ.replyAcknowledgedClose({ moves: ["act"], lines: ["Got it, sending the doc now."], goal }).acknowledged);
  check("ack: a question isn't an acknowledgment", !GJ.replyAcknowledgedClose({ moves: ["ask"], lines: ["Want me to find a new studio space? Congrats on the lease?"], goal }).acknowledged);
  check("ack: a warm sentence before a question still is", GJ.replyAcknowledgedClose({ moves: ["answer"], lines: ["Congrats! Want me to send the lease checklist?"], goal }).acknowledged);
  check("ack: no reply in the turn: the moment goes", !GJ.replyAcknowledgedClose({ moves: [], lines: [], goal }).acknowledged);

  // The closing turn, read from Cue's own sent reply: their text at 10:00, Cue's reply at 10:01, the close at 10:02.
  const closedAt = new Date("2026-11-03T18:02:00Z");
  const turnDb = (o: { inbound: Date | null; replies: string[]; moves: string[]; call?: string }) => ({
    query: async (sql: string) => {
      if (/content LIKE 'User said:%' AND .*created_at <= \$2/.test(sql)) return { rows: o.inbound ? [{ created_at: o.inbound }] : [] };
      if (/content LIKE 'User said:%' AND .*created_at > \$2 ORDER BY created_at LIMIT 1/.test(sql)) return { rows: [] };
      if (/memory_type = 'text_exchange' AND .*created_at > \$2 AND created_at < \$3/.test(sql)) return { rows: [{ content: "User said: we signed the lease!" }, ...o.replies.map((r) => ({ content: `Co replied: ${r}` }))] };
      if (/turn\.move_read/.test(sql)) return { rows: o.moves.map((action) => ({ action })) };
      if (/call_transcript/.test(sql)) return { rows: o.call ? [{ content: o.call }] : [] };
      return { rows: [] };
    },
  });
  const t = await GJ.closingTurnReply(ROWAN, closedAt, turnDb({ inbound: new Date("2026-11-03T18:00:00Z"), replies: ["That's huge. You did it."], moves: ["close"] }));
  check("turn: Cue's reply and move in the closing turn", t.moves.includes("close") && t.lines[0] === "That's huge. You did it.", t);
  const c = await GJ.closingTurnReply(ROWAN, closedAt, turnDb({ inbound: null, replies: [], moves: [], call: "User: we signed the lease on the studio\nAgent: Congratulations, you made it happen.\nUser: thanks" }));
  check("turn: closed on a call, Cue's side of that call", c.lines.length === 1 && /Congratulations/.test(c.lines[0]) && GJ.replyAcknowledgedClose({ ...c, goal }).acknowledged, c);

  // The moment's draft: already acknowledged, it skips with no model call.
  const f = installFakeLedger(pool, sendblue);
  const inner = (pool as any).query;
  const db = turnDb({ inbound: new Date("2026-11-03T18:00:00Z"), replies: ["Love that. You did it."], moves: ["close"] });
  (pool as any).query = async (s: string, a: any[] = []) => (/co_memories|turn\.move_read/.test(s) ? db.query(s) : inner(s, a));
  try {
    const moment = { ...cand("goal_closed", { goalId: "g1", text: goal, startedIn: "October 2026", closedIn: "November 2026" }, "goal_closed:g1"), createdAt: closedAt };
    const d = await proactiveRegistry.goal_closed.draft(moment, { userId: ROWAN, firstName: "Rowan", phoneNumber: person.phoneNumber, city: "Portland", timezone: "America/Los_Angeles" } as any);
    check("moment: the reply already said it, so the goal_closed moment skips", "skip" in d && d.skip.startsWith(GJ.ACKNOWLEDGED_IN_REPLY), d);
  } finally { f.restore(); }
  check("turn: their talk with a teammate is never read as the closing turn", /notToTeammate\(\)/.test(src("services/goalJourney.ts").slice(src("services/goalJourney.ts").indexOf("export async function closingTurnReply"))));
  check("moment: the check runs before the draft is written", (() => { const r = src("harness/proactiveRegistry.ts"); const g = r.slice(r.indexOf("  goal_closed: {")); return g.indexOf("replyAcknowledgedClose") > 0 && g.indexOf("replyAcknowledgedClose") < g.indexOf("draftProactive("); })());
}

console.log(`closedSubjects: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
process.exit(0);
