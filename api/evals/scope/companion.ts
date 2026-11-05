// The purpose boundary, PR C: the companion, and the commitments script. Layer 1: model stubbed, store faked, zero tokens.
//   - milestone texts: "went" and "thread_done" stay; "N days with Cue" is gone (Cue talking about itself)
//   - advice follow-ups and reflection check-ins run only on threads inside the boundary
//   - a personal share gets listening: no ask, look-out or task comes out of it (text and call)
//   - src/scripts/scopeCommitments.ts: counts-only dry run, an honest --apply, nothing deleted
//   npx tsx evals/scope/companion.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const dbm = await import("../../src/db/db.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const pool: any = dbm.default;
const log: { sql: string; params: any[] }[] = [];
let answer: (sql: string, params: any[]) => any[] | null = () => null;
const fakeQuery = async (sql: string, params: any[] = []) => {
  log.push({ sql: String(sql), params });
  if (/INSERT INTO co_tasks/i.test(sql)) return { rowCount: 1, rows: [{ id: 900, user_id: params[0], goal: params[1], their_words: params[2], steps: [], plan_next: "", next_check_at: new Date(Date.now() + 3_600_000), notes: [], status: "open", wakes: 0, texts_sent: 0, created_at: new Date(), kind: "work", source: "ask", followup: null }] };
  const rows = answer(String(sql), params);
  return { rows: rows ?? [], rowCount: rows ? rows.length : 0 };
};
pool.query = fakeQuery;
pool.connect = async () => ({ query: fakeQuery, release() {} });
const reset = (a: typeof answer = () => null) => { log.length = 0; answer = a; };
const quiet = console.log;

// ---- 1. milestones: went and thread_done stay, N days with Cue is gone
const M = await import("../../src/services/milestones.js");
{
  const source = {
    joinedAt: "2025-09-01T00:00:00Z", now: "2026-11-04T00:00:00Z",
    went: [{ itemKey: "evt-1", name: "Founders Dinner", at: "2026-11-01T00:00:00Z" }],
    closed: [
      { id: "t1", text: "finding a co-founder for the climate project", openedQuote: "I need a co-founder", closedQuote: "we found one", at: "2026-11-02T00:00:00Z" },
      { id: "t2", text: "buying a new laptop", openedQuote: "need a laptop", closedQuote: "got it", at: "2026-11-02T00:00:00Z" },
    ],
  };
  const m = M.deriveMilestones(source);
  check("a member of over a year gets no days-with-Cue milestone", !m.some((x) => (x.kind as string) === "with_co" || /been with Cue/.test(x.text)) && !("DAY_MARKS" in M));
  check("a stated 'went' and a closed in-scope thread are still marked", m.some((x) => x.kind === "went" && /Founders Dinner/.test(x.text)) && m.some((x) => x.kind === "thread_done" && /co-founder/.test(x.text)));
  check("a closed thread about a purchase is not a moment in their story with Cue", !m.some((x) => /laptop/.test(x.text)));
  reset((sql) => (/FROM member_milestones m/.test(sql) ? [{ key: "days:30", kind: "with_co", text: "x", happened_at: new Date(), confirmed: true }] : null));
  await M.loadMilestones("u1");
  await M.milestoneConfirmed("u1", "days:30");
  check("a days-with-Cue row stored before is never read back: not marked, not said, not confirmed", log.filter((l) => /member_milestones/.test(l.sql)).every((l) => /m\.kind <> 'with_co'/.test(l.sql)) && log.length >= 2);
}

// ---- 2. advice follow-ups and reflection check-ins: only on threads inside the boundary
{
  const AD = await import("../../src/services/advice.js");
  const old = (id: number, topic: string, gist: string) => ({ id, topic, gist, givenAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), followedUpAt: null });
  check("advice about a laptop purchase is never followed up", AD.dueAdvice([old(1, "which laptop to buy", "get the 14 inch, compare prices")], new Date()) === null);
  check("advice about approaching someone at a dinner is", AD.dueAdvice([old(2, "how to approach Dana at the founders dinner", "open with her climate work")], new Date())?.id === 2);
  const R = await import("../../src/harness/memberReflection.js");
  const thread = (id: string, text: string) => ({ id, text, status: "open", openedQuote: text, dueDate: null, feeling: null });
  const facts = (threads: any[]): any => ({ sends: [], replies: 1, lastReplyAt: "2026-11-03T10:00", offerShare: 0.5, threads, zone: null });
  const out = R.gateReflection({ move: "check_in", threadId: "a", reasoning: "r" }, facts([thread("a", "booking a dentist appointment")]));
  const inn = R.gateReflection({ move: "check_in", threadId: "b", reasoning: "r" }, facts([thread("b", "meeting people in climate tech before the move")]));
  check("a reflection check-in on an errand thread holds, with the check recorded", out.move.move === "hold" && out.checks.some((c) => c.name === "reflection_thread_in_scope" && !c.pass), out);
  check("a reflection check-in on a people thread goes ahead", inn.move.move === "check_in" && inn.move.threadId === "b", inn);
  check("the weekly reflection drops out-of-scope threads before the model sees them", /facts\.threads = facts\.threads\.filter\(\(t\) => classifyScope\(t\.text\)\.scope !== "out"\)/.test(src("harness/memberReflection.ts")));
}

// ---- 3. a personal share gets listening: no ask, look-out or task comes out of it (text and call)
const S = await import("../../src/harness/scope.js");
check("a loss and a lonely stretch told without asking for anything is a personal share", S.sharedNotAsked("My dad passed away last week and I've been really lonely") && S.sharedNotAsked("I'm exhausted, this month has been brutal") && S.sharedNotAsked("we broke up with each other on Sunday, my divorce is final"));
check("the same disclosure with a request in it is not, so the ask goes ahead", !S.sharedNotAsked("I've been lonely since the move, can you find me a founders dinner?") && !S.sharedNotAsked("I'm burned out and I want to meet other founders") && !S.sharedNotAsked("What time is the Mercury dinner?"));
const T = await import("../../src/agent/conversationTools.js");
const mk = (msg: string, voice: boolean) => T.createConversationTools({ userId: "u1", phoneNumber: "+10000000000", resolvedContent: msg, isVoice: voice, onCall: voice, callKey: voice ? "call-1" : undefined, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, isTeam: false, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any);
const workRows = () => log.filter((l) => /\b(INSERT INTO|UPDATE)\b[^;]{0,40}\b(co_tasks|ask_checkins|co_asks|research_finds|member_reminders|goal_|lookout)/i.test(l.sql));
for (const voice of [false, true]) {
  const how = voice ? "call" : "text";
  const share = "My dad passed away last week and I've been really lonely";
  reset();
  console.log = () => {};
  const save = await (mk(share, voice).tools as any).saveAsk.execute({ what: "people who understand losing a parent" }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
  const task = await (mk(share, voice).tools as any).startTask.execute({ goal: "find a grief group", theirWords: share, steps: ["search for grief groups"], firstStep: "search", inHours: 3 }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
  const watch = await (mk(share, voice).tools as any).startTask.execute({ goal: "keep an eye out for grief support dinners", theirWords: share, steps: ["watch"], firstStep: "watch", inHours: 3, lookout: true }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
  console.log = quiet;
  check(`7 (${how}): a personal share saves no ask, starts no task and no look-out, and the model is told to listen`, save.ok === false && task.ok === false && watch.ok === false && workRows().length === 0 && /Listen/.test(save.error ?? "") && /No ask, look-out or task comes out of it/.test(task.error ?? "") && /no question just to keep it going/.test(watch.error ?? ""), { save, task, watch, rows: workRows().map((l) => l.sql.slice(0, 50)) });
  reset();
  console.log = () => {};
  const ask = "I've been lonely since the move, can you find me a founders dinner this week?";
  const fine = await (mk(ask, voice).tools as any).startTask.execute({ goal: "founders dinners this week", theirWords: ask, steps: ["look for founders dinners"], firstStep: "look", inHours: 3 }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
  console.log = quiet;
  check(`7 (${how}): the same feeling with a real ask in it still starts the dinner search`, fine.ok === true, fine);
}
check("the post-call and text capture drop an ask whose own words are a personal share, and the prompts say a personal update is never an ask", /isPureShare\(wopts\.messageKind/.test(src("services/profileExtraction.ts")) && /a personal update \(a loss, an illness, a hard stretch, news about their week\) told without asking for anything/.test(src("services/turnLearning.ts")) && /a personal update \(a loss, an illness, a hard stretch, news about their week\) told without asking for anything/.test(src("services/profileExtraction.ts")));
{
  const cap = await import("../../src/services/capabilities.js");
  const use = (id: string) => cap.ABILITIES.find((a) => a.id === id)?.use ?? "";
  check("the matching and saving tools say a personal update is heard, never answered with a search, a save or a task", /Never for a personal update/.test(use("save_ask")) && /Never for a personal update/.test(use("goal_take_on") + use("start_task") + cap.ABILITIES.find((a) => a.tool === "startTask")!.use) && /Never in answer to a personal update/.test(cap.ABILITIES.find((a) => a.tool === "searchEvents")!.use ?? ""));
}

// ---- 4. the commitments script: counts only, nothing without --apply, an honest close, nothing deleted
{
  const SCR = await import("../../src/scripts/scopeCommitments.js");
  const row = (o: any) => ({ id: 1, user_id: "u1", goal: "x", their_words: "x", steps: [], plan_next: null, kind: "work", followup: null, source: "ask", ...o });
  const tasks = [
    row({ id: 1, goal: "Find a dentist near the Mission" }),
    row({ id: 2, goal: "Compare laptops under $1500" }),
    row({ id: 3, goal: "Keep an eye out, as promised on a call: cheaper flights to Lisbon", source: "lookout", followup: { lookoutFrom: "first_read" } }),
    row({ id: 4, kind: "followup", goal: "Check in on their ask: a cheaper phone plan", followup: { type: "ask_checkin", summary: "Check in on their ask: a cheaper phone plan" } }),
    row({ id: 5, goal: "Check in on their goal: get my taxes done", followup: { checkin: "checkin", goalId: 5 } }),
    row({ id: 6, kind: "research_brief", goal: "Research: a venue for my launch dinner for 40" }),
    row({ id: 7, goal: "Find founder dinners in the Mission this week" }),
    row({ id: 8, goal: "Prep for my coffee with Dana Whitfield" }),
  ];
  const asks = [
    { id: "a1", ask_text: "Find me the cheapest phone plan", kind: "find", intent: null },
    { id: "a2", ask_text: "Keep an eye on job listings in climate tech", kind: "find", intent: "lookout" },
    { id: "a3", ask_text: "Book me a dentist", kind: "help", intent: null },
    { id: "a4", ask_text: "Founder dinners in the Mission", kind: "find", intent: null },
  ];
  const follow = [
    { id: "f1", match: { tier: 3, name: "Harbor Climate Accelerator cohort", statedDates: { end: "2026-12-01" } } },
    { id: "f2", match: { tier: 2, name: "Founders Dinner", event_date: "2026-11-12" } },
  ];
  const reads = (sql: string, params: any[] = []) => (/^\s*UPDATE ask_checkins/i.test(sql) ? [{}] : /^\s*UPDATE/i.test(sql) ? (params[0] as unknown[]).map(() => ({})) : /FROM co_tasks WHERE status = 'open'/.test(sql) ? tasks : /FROM ask_checkins WHERE resolved_at IS NULL/.test(sql) ? asks : /FROM recommendation_outcome_followups/.test(sql) ? follow : null);
  reset(reads);
  const r = await SCR.scopeCommitmentCounts(pool);
  const c = r.counts;
  check("dry run counts the open out-of-scope commitments by kind", c.tasks.work === 4 && c.tasks.followup === 1 && c.tasks.research_brief === 0 && c.asks.find === 1 && c.asks.lookout === 1 && c.asks.help === 1 && c.programFollowUps === 1, c);
  check("dry run says which the member asked for (they get one line) and which close quietly", c.handBack === 2 && c.closeQuietly === 3, c);
  check("in-scope tasks, asks and event follow-ups are not counted", !r.taskIds.includes(7) && !r.taskIds.includes(8) && !r.askRows.some((a) => a.id === "a4") && !r.followUpIds.includes("f2"), r);
  check("a dry run only reads", log.every((l) => /^\s*SELECT/i.test(l.sql)), log.map((l) => l.sql.slice(0, 40)));
  const printed = JSON.stringify(c);
  check("the output is counts only: no text, id or name", !/dentist|laptop|phone plan|u1|Dana|Harbor/i.test(printed) && Object.values(c).every((v) => typeof v === "number" || (typeof v === "object" && Object.values(v as object).every((n) => typeof n === "number"))), printed);
  reset(reads);
  const done = await SCR.applyScopeCommitments(pool);
  const writes = log.filter((l) => !/^\s*SELECT/i.test(l.sql));
  check("apply makes tasks due so the next wake closes them honestly; it texts nothing and closes nothing itself", writes.some((w) => /UPDATE co_tasks SET next_check_at = NOW\(\)/.test(w.sql)) && !writes.some((w) => /status = '(?:done|dropped)'/.test(w.sql) && /co_tasks/.test(w.sql)) && done.tasksMadeDue === r.taskIds.length, { writes: writes.map((w) => w.sql.slice(0, 70)), done });
  check("apply keeps the asks (only their kind moves), drops the program follow-up, and deletes nothing", writes.some((w) => /UPDATE ask_checkins SET kind = COALESCE\(\$2, kind\)/.test(w.sql) && w.params[1] === "outside" && !/resolved_at = /.test(w.sql)) && done.asksMarkedOutside === 3 && writes.some((w) => /harness_status = 'dropped'/.test(w.sql)) && !writes.some((w) => /DELETE/i.test(w.sql)));
  const scr = src("scripts/scopeCommitments.ts");
  check("it runs only on the command line, defaults to the dry run, and never sends a text", /npx tsx src\/scripts\/scopeCommitments\.ts --dry-run/.test(scr) && /const dry = args\.includes\("--dry-run"\) \|\| !apply/.test(scr) && !/sendExempt|sendblue|sendMessage/i.test(scr));
}

// ---- 4b. a failed read is an error, never zero counts; the lookout origin is the runtime's; the kind change goes through laneMoves
{
  const SCR = await import("../../src/scripts/scopeCommitments.js");
  const broken: any = { query: async (sql: string) => { if (/FROM ask_checkins/.test(sql)) throw Object.assign(new Error("connection reset: secret-host.internal"), { code: "ECONNRESET" }); return { rows: [] }; } };
  const err: any = await SCR.scopeCommitmentCounts(broken).then(() => null, (e: unknown) => e);
  check("a failed read throws an error that names the step and the code, never counts of zero", err instanceof SCR.ScopeStepError && /reading open asks failed \(ECONNRESET\)/.test(err.message), String(err));
  check("…and the error carries no host, text or member", !/secret-host|u1/.test(String(err?.message)));
  const scr = src("scripts/scopeCommitments.ts");
  check("it uses the runtime's lookoutOriginOf, so the dry-run counts are what a wake does", /lookoutOrigin: lookoutOriginOf\(r\.source, r\.followup\)/.test(scr));
  check("it never writes an ask's kind itself: the one writer is laneMoves.setAskKind", /setAskKind\(db,/.test(scr) && !/UPDATE ask_checkins SET kind/.test(scr));
  check("it prints 'no counts reported' when it fails", /no counts reported/.test(scr));
}

if (failed) { console.log(`\n${failed} of ${total} checks failed.`); process.exit(1); }
console.log(`scope boundary (C): ${total} checks passed.`);
process.exit(0);
