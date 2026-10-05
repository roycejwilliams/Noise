// The 2026-10-01 code review's findings, run against the real functions
// with a mocked database and sender (no live DB, no sends). Model-free.
//   npx tsx evals/loop/probes.ts
process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/none";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const pool = (await import("../../src/db/db.js")).default as any;
const O = await import("../../src/services/openLoops.js");
const LT = await import("../../src/agent/loopTools.js");

let fails = 0;
const check = (l: string, ok: boolean, d = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${l}${!ok && d ? `\n   ${d}` : ""}`); };

type Row = Record<string, any>;
let loops: Row[] = [];
let tasks: Row[] = [];
let failTasks = false;
const log: string[] = [];
let nextId = 100;
const handle = async (sql: string, args: any[] = []): Promise<{ rows: Row[] }> => {
  log.push(sql.replace(/\s+/g, " ").slice(0, 80));
  if (/SELECT DISTINCT user_id/.test(sql)) return { rows: [{ user_id: "u" }] };
  if (/FROM co_tasks WHERE user_id = \$1 AND status = 'open' AND kind = 'work'/.test(sql)) { if (failTasks) throw new Error("connection reset"); return { rows: tasks.filter((t) => t.status === "open") }; }
  if (/SELECT status FROM co_tasks/.test(sql)) return { rows: tasks.filter((t) => t.id === args[1]) };
  if (/FROM search_briefs|FROM ask_checkins|FROM proactive_candidates/.test(sql)) return { rows: [] };
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
  if (/SELECT \* FROM open_loops WHERE user_id = \$1 AND \(closed_at IS NULL OR closed_reason = 'co'\)/.test(sql)) return { rows: loops.filter((r) => !r.closed_at || r.closed_reason === "co") };
  if (/SELECT \* FROM open_loops WHERE user_id = \$1 AND closed_at IS NULL AND task_id IS NOT NULL/.test(sql)) return { rows: loops.filter((r) => !r.closed_at && r.task_id && (!r.seen_at || r.changed_at > r.seen_at)) };
  if (/SELECT \* FROM open_loops WHERE user_id = \$1 AND closed_at IS NULL/.test(sql)) return { rows: loops.filter((r) => !r.closed_at) };
  if (/^\s*INSERT INTO open_loops/.test(sql)) {
    const [, source, ref, title, status, detail, due, taskId] = args;
    let r = loops.find((x) => x.source === source && x.source_ref === ref);
    const now = new Date();
    if (!r) { r = { id: nextId++, user_id: "u", source, source_ref: ref, title, status, detail, due_date: due, task_id: taskId, status_by: "code", changed_at: now, seen_at: now, woke_at: null, closed_at: null, closed_reason: null }; loops.push(r); }
    else { if (r.closed_at) r.status_by = "code"; Object.assign(r, { title, status, detail, closed_at: null, closed_reason: null }); if (/changed_at = NOW\(\)/.test(sql)) r.changed_at = now; }
    return { rows: [r] };
  }
  if (/UPDATE open_loops SET status = COALESCE\(\$2, status\)/.test(sql)) { const r = loops.find((x) => x.id === args[0])!; Object.assign(r, { status: args[1] ?? r.status, closed_reason: args[2], closed_at: new Date() }); return { rows: [] }; }
  if (/UPDATE open_loops SET status = \$2, status_by = 'co'/.test(sql)) { const r = loops.find((x) => x.id === args[0])!; const closing = ["done", "dropped"].includes(args[1]); Object.assign(r, { status: args[1], status_by: "co", changed_at: new Date(), seen_at: new Date(), closed_at: closing ? new Date() : null, closed_reason: closing ? "co" : null }); return { rows: [] }; }
  if (/UPDATE co_tasks SET status = \$3/.test(sql)) { const t = tasks.find((x) => x.id === args[1]); if (t) t.status = args[2]; return { rows: t ? [t] : [] } as any; }
  if (/WITH t AS \(UPDATE co_tasks/.test(sql)) { const t = tasks.find((x) => x.id === args[1] && x.status === "open"); if (!t) return { rows: [] }; t.next_check_at = new Date(); const r = loops.find((x) => x.id === args[0])!; r.woke_at = r.seen_at = new Date(); return { rows: [{ id: r.id }] }; }
  if (/INSERT INTO harness_decisions|decisions/i.test(sql)) return { rows: [] };
  return { rows: [] };
};
pool.query = (sql: string, args?: any[]) => handle(sql, args);
pool.connect = async () => ({ query: (sql: string, args?: any[]) => handle(sql, args), release: () => {} });

const task7 = () => ({ id: 7, goal: "Find a venue for Oct 10", deadline: null, awaiting_reply: false, notes: [], status: "open" });

// 1. A failed task read doesn't close the loop.
tasks = [task7()];
await O.syncOpenLoops("u");
check("setup: task loop open", loops.length === 1 && !loops[0].closed_at);
failTasks = true;
await O.syncOpenLoops("u");
check("finding 1: a failed co_tasks read leaves the loop open", !loops[0].closed_at, JSON.stringify(loops[0]));
failTasks = false;
// A task that really closed does close its loop.
tasks[0].status = "done";
await O.syncOpenLoops("u");
check("a task that's really done closes its loop as done", !!loops[0].closed_at && loops[0].status === "done" && loops[0].closed_reason === "source_done");

// 2. A loop Co closes doesn't reopen next sync, and its task closes with it.
loops = []; tasks = [task7()];
await O.syncOpenLoops("u");
const r2 = await O.setLoopStatus("u", { id: loops[0].id, title: "venue" }, "done", "they booked it");
check("setLoopStatus by id works", r2.ok);
check("finding 2: closing the loop closes its task", tasks[0].status === "done");
tasks[0].status = "open"; // even if the task were still listed
await O.syncOpenLoops("u");
check("finding 2: next sync keeps Co's close (no reopen)", !!loops[0].closed_at && loops[0].status === "done", JSON.stringify(loops[0]));

// 3. A change seen earlier (by a text turn) still wakes the task later.
loops = []; tasks = [task7()];
await O.syncOpenLoops("u");
tasks[0].awaiting_reply = true; // the loop moves to waiting_on_reply
await new Promise((r) => setTimeout(r, 5)); // a later transaction, as in Postgres
await O.syncOpenLoops("u"); // a text turn sees it; nothing woken there
check("setup: change is pending", loops[0].changed_at > loops[0].seen_at && loops[0].status === "waiting_on_reply");
await O.runLoopSync(); // unchanged in this pass, but pending
check("finding 3: an earlier-seen change wakes the task", !!tasks[0].next_check_at && !!loops[0].woke_at);
// A wake that can't land stays pending.
loops = []; tasks = [task7()];
await O.syncOpenLoops("u");
loops[0].changed_at = new Date(Date.now() + 1000);
tasks[0].status = "paused"; // not open and not closed: the wake can't land
await O.runLoopSync();
check("finding 3: a wake that didn't land isn't recorded", !loops[0].woke_at);

// 5. An ambiguous title is refused.
loops = []; tasks = [task7(), { ...task7(), id: 8, goal: "Find a venue for the offsite" }];
await O.syncOpenLoops("u");
const r5 = await O.setLoopStatus("u", { title: "venue" }, "unconfirmed", null);
check("finding 5: 'venue' with two venue loops is refused", !r5.ok && /More than one loop fits/.test((r5 as any).error) && loops.every((l) => l.status_by === "code"));

// 4. A failed caption isn't recorded as sent.
const facts: string[] = [];
const notDone: string[] = [];
const sends: string[] = [];
const ctx: any = {
  userId: "u", phoneNumber: "+15550000000", dryRun: false, stubSearch: true,
  sendCoReply: async ({ message }: any) => { sends.push(message); return message.startsWith("https://") ? true : false; },
  facts: { add: (k: string, t: string) => facts.push(`${k}: ${t}`), text: () => "" },
  turn: null,
};
const state: any = { sent: false, sentMessages: [] };
const loop = LT.newLoopState();
loop.found.set("https://wave.example/", { name: "Wave", url: "https://wave.example/", facts: "Wave. capacity: 120 standing; price: $180/hr", match: null, blocked: null } as any);
const tools: any = LT.loopTools(ctx, state, loop, (w: string) => notDone.push(w));
const out = await tools.shareFinds.execute({ items: [{ link: "https://wave.example/", caption: "Wave holds 120 standing, $180/hr." }] }, { toolCallId: "t", messages: [] });
check("finding 4: the link went, the caption failed (retried once)", sends.filter((x) => x.startsWith("https://")).length === 1 && sends.filter((x) => !x.startsWith("https://")).length === 2, JSON.stringify(sends));
check("finding 4: no fact says the caption was sent", !facts.some((f) => /with the caption/.test(f)) && facts.some((f) => /caption didn't send/.test(f)), JSON.stringify(facts));
check("finding 4: Co is told to carry the caption in its reply", out.ok && (out as any).uncaptioned?.[0] === "Wave" && /caption didn't go out/.test((out as any).note) && notDone.some((n) => /caption for Wave/.test(n)));

// Beats and bursts: a newer text mid-reply, a beat that fails partway.
{
  const CT = await import("../../src/agent/conversationTools.js");
  const B = await import("../../src/services/beats.js");
  const IR = await import("../../src/services/inlineReply.js");
  const beatsOut: string[] = [];
  const notes: string[] = [];
  let calls = 0;
  const mk = (failAt: number | null) =>
    CT.createConversationTools({
      userId: "u", phoneNumber: "+15550000000", resolvedContent: "how do I plan it", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
      sendCoReply: async ({ message }: any) => { calls++; if (failAt !== null && calls === failAt) return false; beatsOut.push(message); return true; },
      facts: { add: (k, t) => notes.push(`${k}: ${t}`), text: () => "" },
    } as any);
  const t0 = Date.now();
  const a = mk(null);
  const r1: any = await (a.tools.sendReply as any).execute({ message: "Start with the room.\n\nThen the list.\n\nThen the door." }, { toolCallId: "1", messages: [] });
  check("a three-beat reply goes out as three texts, in order, paced", r1.ok && beatsOut.join("|") === "Start with the room.|Then the list.|Then the door." && Date.now() - t0 >= 2 * B.BEAT_GAP_MS - 50, JSON.stringify(beatsOut));
  beatsOut.length = 0; calls = 0; notes.length = 0;
  const b = mk(2);
  const r2: any = await (b.tools.sendReply as any).execute({ message: "One.\n\nTwo.\n\nThree." }, { toolCallId: "2", messages: [] });
  check("a beat that fails stops the rest; what went out counts, the miss is a receipt", r2.ok && b.state.sent && beatsOut.join("|") === "One." && notes.some((n) => /Only part of the reply went out/.test(n)), JSON.stringify({ beatsOut, notes }));
  check("a text that looks unfinished waits longer for the rest of the burst", B.burstWaitMs("so I was thinking about the venue and") > B.burstWaitMs("Thanks, that works.") && B.burstWaitMs("wait") > B.burstWaitMs("Thanks, that works."));
  check("a newer text arriving mid-reply threads the reply under the one it answers", IR.threadReason({ theyRepliedInline: false, newerTextSince: true }) === "newer_text");
}

// Replays: a crashed or cut-off turn runs again only when nothing reached them.
{
  const TF = await import("../../src/services/turnFailure.js");
  const rec = new Date("2026-10-01T12:00:00Z");
  const ok = { member: { optedOut: false, archived: false }, coRepliedSince: false, lastInboundAt: new Date(rec.getTime() + 200), callAt: null, receivedAt: rec, now: new Date(rec.getTime() + 60_000) };
  check("replay runs when nothing reached them", TF.turnReplayBlocked(ok) === null);
  check("replay never runs after a Co text, a newer text of theirs, a call, or an hour", TF.turnReplayBlocked({ ...ok, coRepliedSince: true }) === "already_answered" && TF.turnReplayBlocked({ ...ok, lastInboundAt: new Date(rec.getTime() + 30_000) }) === "newer_text" && TF.turnReplayBlocked({ ...ok, callAt: new Date(rec.getTime() + 1000) }) === "call_placed" && TF.turnReplayBlocked({ ...ok, now: new Date(rec.getTime() + 2 * 3_600_000) }) === "too_old" && TF.turnReplayBlocked({ ...ok, member: { optedOut: true, archived: false } }) === "opted_out");
  const fs = await import("node:fs");
  const sb = fs.readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  check("each retry is claimed once (timer or restart pass, never both)", /SET retry_claimed_at = NOW\(\) WHERE handle = \$1 AND retry_claimed_at IS NULL RETURNING/.test(sb) && /if \(handle && !\(await claimRetry\(handle\)\)\) return;/.test(sb));
  check("a crashed turn schedules one replay; a replay never schedules another", /if \(!replay && typeof handle === "string" && handle\) scheduleTurnReplay\(handle, TURN_REPLAY_AFTER_MS\)/.test(sb) && /resumeLater: replay \? undefined :/.test(sb));
  check("a replay logs their message once and skips the checks it already passed", /const logTextExchange = replay \? \(userId: string, content: string\) => logTextExchangeOnce/.test(sb) && /if \(!replay\) markRead/.test(sb) && /if \(!replay && lockKey && !bodyForStamp\.is_outbound/.test(sb));
  check("unfinished turns and lost retries are swept every 2 minutes, claimed once", /cron\.schedule\("\*\/2 \* \* \* \*"[\s\S]{0,200}reportUnfinishedTurns\(\)/.test(fs.readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8")) && /SET finished_at = NOW\(\) WHERE handle = \$1 AND finished_at IS NULL RETURNING handle/.test(sb) && /retry_due_at < NOW\(\) - INTERVAL '3 minutes'/.test(sb));
  const cr = fs.readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
  check("the reply's deadline and tool budget run from when their text arrived", /const replyDeadline = turnStart \+/.test(cr) && /turnStartedAt: turnStart/.test(cr) && /newLoopState\(ctx\.turnStartedAt\)/.test(fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8")) && /turnStartedAt,\n\s*resumeLater/.test(sb));
}

console.log(fails ? `\n${fails} failed` : "\nall probes passed");
process.exit(fails ? 1 : 0);
