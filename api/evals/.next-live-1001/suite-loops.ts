// Suite 3: open loops and proactive follow-ups (services/openLoops.ts at 9edf68b,
// coTasks, taskTurn.runTaskTurnWith). runLoopSync's member list reads only the
// TEMP shadows, so it can only ever see fixture members.
// Time: NOW() is fixed within a case. Where a scenario needs time to pass
// between two syncs, the fixture backdates seen_at/woke_at; each case says so.
import "../lib/requireMeter.js";
import { DBC, settle } from "./db.js";
import { member, rows, ck, PHONE, ID, NAME, type Case } from "./fixtures.js";

async function task(w: "A" | "B", goal: string, o: { awaiting?: boolean; latest?: string; deadline?: string; status?: string } = {}) {
  const notes = JSON.stringify([{ at: new Date().toISOString(), text: "Started." }, ...(o.latest ? [{ at: new Date().toISOString(), text: o.latest }] : [])]);
  const r = await rows(
    `INSERT INTO co_tasks (user_id, goal, their_words, steps, plan_next, next_check_at, notes, awaiting_reply, deadline, status, created_at) VALUES ($1, $2, $2, '[]', 'keep looking', NOW() + interval '6 hours', $3::jsonb, $4, $5, $6, NOW() - interval '1 day') RETURNING id`,
    [ID[w], goal, notes, !!o.awaiting, o.deadline ?? null, o.status ?? "open"],
  );
  return Number(r[0].id);
}
async function brief(w: "A" | "B", b: any, ageHours = 1) {
  await rows(`INSERT INTO search_briefs (user_id, brief, updated_at) VALUES ($1, $2::jsonb, NOW() - make_interval(hours => $3))`, [ID[w], JSON.stringify(b), ageHours]);
}
async function ask(w: "A" | "B", id: string, text: string) {
  await rows(`INSERT INTO ask_checkins (user_id, ask_id, ask_text) VALUES ($1, $2, $3)`, [ID[w], id, text]);
}
const loopRows = (w: "A" | "B") => rows(`SELECT id, source, source_ref, title, status, status_by, detail, task_id, closed_at, closed_reason, seen_at, changed_at, woke_at FROM open_loops WHERE user_id = $1 ORDER BY id`, [ID[w]]);

async function replyAbout(w: "A", message: string, loopsFact: string | null, recent = "") {
  const G = await import("../../src/harness/replyGrounding.js");
  const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
  const facts = G.baseReplyFacts();
  G.addFact(facts, "known", "They live in San Francisco.");
  if (loopsFact) G.addFact(facts, "ongoing", loopsFact);
  const r: any = await runConversationReplyAgent(
    { ackSent: null, userId: ID[w], phoneNumber: PHONE[w], firstName: NAME[w], resolvedContent: message, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: recent, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any,
    { dryRun: true, record: false, stubSearch: true },
  );
  return { text: String(r.replyText ?? ""), tools: r.toolsCalled ?? [], grounding: (r.grounding ?? []).map((g: any) => ({ outcome: g.outcome, failed: (g.checks ?? []).filter((c: any) => !c.pass).map((c: any) => c.reason ?? c.name) })) };
}

// Task-turn deps: real coTasks writes (TEMP), deterministic finds, captured sends.
async function deps(w: "A", taskId: number, finds: { web?: any[]; search?: any[]; page?: Record<string, string[]> }, recent: string) {
  const T = await import("../../src/services/coTasks.js");
  const sent: string[][] = [];
  const calls = { schedule: 0, close: 0, note: 0 } as Record<string, number>;
  const d: any = {
    person: { first_name: NAME[w], phone_number: PHONE[w], city: "San Francisco" },
    zone: "America/Los_Angeles",
    recent,
    note: async (text: string, stepDone: string | null) => { calls.note++; await T.noteOnTask(ID[w], taskId, text, stepDone); },
    schedule: async (h: number, plan: string) => { calls.schedule++; return (await T.scheduleTask(ID[w], taskId, h, plan))?.nextCheckAt ?? null; },
    close: async (status: any, outcome: string) => { calls.close++; await T.closeTask(ID[w], taskId, status, outcome); },
    textsToday: async () => 0,
    send: async (messages: string[]) => { sent.push(messages); return { sent: true }; },
    markTexted: async () => T.markTexted(ID[w], taskId),
    markFinalTold: async () => T.markFinalTold(ID[w], taskId),
    search: async () => finds.search ?? [],
    web: async () => ({ kept: finds.web ?? [], dropped: [], droppedDetails: [], note: finds.web?.length ? "" : "Nothing new checked out." }),
    readPage: async (url: string) => ({ ok: !!finds.page?.[url], facts: finds.page?.[url] ?? [], text: (finds.page?.[url] ?? []).join(". ") }),
    now: () => new Date(),
  };
  return { d, sent, calls };
}

export const loops: Case[] = [
  {
    suite: "loops", id: "loop-derived-state",
    run: async () => {
      await member("A");
      const O = await import("../../src/services/openLoops.js");
      const t1 = await task("A", "Find a venue for the Oct 10 founder dinner", { awaiting: true, latest: "Asked whether they want Wave or SOMA Loft." });
      const t2 = await task("A", "Find a DJ for Oct 10", { latest: "DJ Kova quoted but the price is unconfirmed." });
      await brief("A", { what: "bookable space for 40", when: "Oct 10", shortlist: [{ name: "Wave", note: "price unconfirmed" }, { name: "SOMA Loft" }], next: "they pick one" });
      await ask("A", "ask-run", "a running group in the Mission");
      await rows(`INSERT INTO proactive_candidates (user_id, type, target_key, topic_key, summary, payload, status, decided_at) VALUES ($1, 'event_offer', 'event_offer:x', 't', 's', $2::jsonb, 'sent', NOW() - interval '1 hour')`, [ID.A, JSON.stringify({ match: { name: "Founders Supper Club" } })]);
      const s1 = await O.syncOpenLoops(ID.A);
      const L = await loopRows("A");
      const by = (src: string, ref?: string) => L.find((l: any) => l.source === src && (!ref || l.source_ref === ref));
      await O.runLoopSync();
      await settle();
      const wakes = await rows(`SELECT count(*)::int AS n FROM harness_decisions WHERE decision = 'loop.changed'`);
      const fact = O.describeLoops(s1.rows, { withIds: true });
      const reply = await replyAbout("A", "how's everything going with the stuff you're working on for me?", fact);
      return {
        checks: [
          ck("task waiting on them -> waiting_on_reply, linked to its task", by("task", String(t1))?.status === "waiting_on_reply" && Number(by("task", String(t1))?.task_id) === t1, by("task", String(t1))),
          ck("unconfirmed price -> unconfirmed", by("task", String(t2))?.status === "unconfirmed", by("task", String(t2))),
          ck("notes with a choice left -> decision_needed, shortlist in detail", by("notes")?.status === "decision_needed" && /Wave/.test(by("notes")?.detail ?? ""), by("notes")),
          ck("open ask -> open; sent offer -> waiting_on_reply", by("ask", "ask-run")?.status === "open" && by("offer")?.status === "waiting_on_reply", [by("ask"), by("offer")]),
          ck("first creation is already seen: nothing changed, nothing woken", s1.changed.length === 0 && L.every((l: any) => l.seen_at && new Date(l.seen_at) >= new Date(l.changed_at)) && wakes[0].n === 0, { changed: s1.changed.length, wakes }),
          ck("reply names what remains (venue choice / price), no loop ids", /Wave|SOMA|venue|DJ|price/i.test(reply.text) && !/\[?loop \d+\]?/i.test(reply.text), reply.text),
          ck("reply doesn't rate itself", !/proactive|on top of (it|everything)|I'?m (always )?(working|tracking)/i.test(reply.text), reply.text),
        ],
        texts: { reply: reply.text },
        observed: { tools: reply.tools, grounding: reply.grounding },
      };
    },
  },
  {
    suite: "loops", id: "loop-incomplete-source", mode: "model-free", runs1: true,
    run: async () => {
      await member("A");
      const O = await import("../../src/services/openLoops.js");
      await ask("A", "ask-x", "a climbing partner");
      await O.syncOpenLoops(ID.A);
      // 1. The ask source read fails, and the ask has meanwhile been resolved: nothing closes.
      await rows(`UPDATE ask_checkins SET resolved_at = NOW() WHERE ask_id = 'ask-x'`);
      DBC.faults = [/FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NULL/];
      await O.syncOpenLoops(ID.A);
      DBC.faults = [];
      const afterFail = (await loopRows("A")).find((l: any) => l.source_ref === "ask-x");
      // 2. The direct read of that one source row fails: still nothing closes.
      DBC.faults = [/SELECT resolved_at FROM ask_checkins WHERE user_id = \$1 AND ask_id = \$2/];
      await O.syncOpenLoops(ID.A);
      DBC.faults = [];
      const afterRowFail = (await loopRows("A")).find((l: any) => l.source_ref === "ask-x");
      // 3. Exactly the cap: 50 other open asks, so the list may be incomplete; the vanished ask stays open.
      await rows(`UPDATE ask_checkins SET resolved_at = NULL WHERE ask_id = 'ask-x'`);
      await rows(`INSERT INTO ask_checkins (user_id, ask_id, ask_text) SELECT $1, 'bulk-' || g, 'ask ' || g FROM generate_series(1, $2) g`, [ID.A, O.SOURCE_READ_CAP]);
      await rows(`UPDATE ask_checkins SET created_at = NOW() - interval '30 days' WHERE ask_id = 'ask-x'`);
      await O.syncOpenLoops(ID.A);
      const atCap = (await loopRows("A")).find((l: any) => l.source_ref === "ask-x");
      // 4. Seven tasks, display shows eight loops at most: truncation never closes anything.
      for (let i = 1; i <= 7; i++) await task("A", `task number ${i}`);
      const s = await O.syncOpenLoops(ID.A);
      const desc = O.describeLoops(s.rows) ?? "";
      const taskLoops = (await loopRows("A")).filter((l: any) => l.source === "task");
      // Finally the real read with the ask resolved: now it may close.
      await rows(`DELETE FROM ask_checkins WHERE ask_id LIKE 'bulk-%'`);
      await rows(`UPDATE ask_checkins SET resolved_at = NOW() WHERE ask_id = 'ask-x'`);
      await O.syncOpenLoops(ID.A);
      const finally_ = (await loopRows("A")).find((l: any) => l.source_ref === "ask-x");
      return {
        checks: [
          ck("a failed source read closes nothing", afterFail && !afterFail.closed_at, afterFail),
          ck("a failed direct row read closes nothing", afterRowFail && !afterRowFail.closed_at, afterRowFail),
          ck(`at exactly ${O.SOURCE_READ_CAP} rows the list counts as incomplete: nothing closed`, atCap && !atCap.closed_at, atCap),
          ck("seven task loops kept though display stops at eight lines", taskLoops.length === 7 && taskLoops.every((l: any) => !l.closed_at) && desc.split(";").length <= 8, { n: taskLoops.length }),
          ck("a complete read of a resolved ask does close it (done)", finally_?.closed_at && finally_.status === "done" && finally_.closed_reason === "source_done", finally_),
        ],
        observed: { faultHits: DBC.faultHits },
      };
    },
  },
  {
    suite: "loops", id: "loop-closed-tombstone", mode: "model-free", runs1: true,
    run: async () => {
      await member("A");
      const O = await import("../../src/services/openLoops.js");
      const t = await task("A", "Find a photographer for the dinner");
      await ask("A", "ask-y", "a pottery class");
      await brief("A", { what: "bookable space", shortlist: [{ name: "Wave" }], next: "they pick one" });
      const s = await O.syncOpenLoops(ID.A);
      const tl = s.rows.find((r) => r.source === "task")!, al = s.rows.find((r) => r.source === "ask")!, nl = s.rows.find((r) => r.source === "notes")!;
      await O.setLoopStatus(ID.A, { id: tl.id, title: tl.title }, "done", "they booked one");
      await O.setLoopStatus(ID.A, { id: al.id, title: al.title }, "dropped", "lost interest");
      const taskRow = (await rows(`SELECT status FROM co_tasks WHERE id = $1`, [t]))[0];
      const askRow = (await rows(`SELECT resolved_at FROM ask_checkins WHERE ask_id = 'ask-y'`))[0];
      await O.syncOpenLoops(ID.A);
      const afterResync = await loopRows("A");
      // Co closes the notes loop; an older brief must not reopen it, a genuinely newer one may.
      await O.setLoopStatus(ID.A, { id: nl.id, title: nl.title }, "done", "picked Wave");
      await O.syncOpenLoops(ID.A);
      const stillClosed = (await loopRows("A")).find((l: any) => l.source === "notes");
      // (NOW() is fixed in a case: the newer brief is stamped a minute after the close.)
      await rows(`UPDATE search_briefs SET brief = $2::jsonb, updated_at = NOW() + interval '1 minute' WHERE user_id = $1`, [ID.A, JSON.stringify({ what: "a second space for the afterparty", next: "they pick one" })]);
      await O.syncOpenLoops(ID.A);
      const reopened = (await loopRows("A")).find((l: any) => l.source === "notes");
      // Stale notes (older than 72h) close as stale, not as done.
      await rows(`UPDATE open_loops SET closed_at = NULL, closed_reason = NULL, status = 'decision_needed', status_by = 'code' WHERE source = 'notes'`);
      await rows(`UPDATE search_briefs SET updated_at = NOW() - make_interval(hours => $2) WHERE user_id = $1`, [ID.A, O.NOTES_FRESH_HOURS + 8]);
      await O.syncOpenLoops(ID.A);
      const stale = (await loopRows("A")).find((l: any) => l.source === "notes");
      return {
        checks: [
          ck("Co's done closes the loop and its task", taskRow.status === "done" && afterResync.find((l: any) => Number(l.id) === tl.id)?.closed_at, { taskRow }),
          ck("Co's dropped closes the loop and resolves its ask", !!askRow.resolved_at && afterResync.find((l: any) => Number(l.id) === al.id)?.status === "dropped", askRow),
          ck("a Co-closed loop stays closed on resync", afterResync.filter((l: any) => [tl.id, al.id].includes(Number(l.id))).every((l: any) => l.closed_at), afterResync),
          ck("an older brief doesn't reopen a Co-closed notes loop", !!stillClosed?.closed_at, stillClosed),
          ck("a genuinely newer brief reopens it", reopened && !reopened.closed_at, reopened),
          ck("stale notes close as stale, never reported done", stale?.closed_at && stale.closed_reason === "stale" && stale.status !== "done", stale),
        ],
      };
    },
  },
  {
    suite: "loops", id: "loop-ambiguous-id",
    run: async () => {
      await member("A"); await member("B");
      const O = await import("../../src/services/openLoops.js");
      await task("A", "Find a venue for the Oct 10 dinner");
      await task("A", "Find a venue for the team offsite");
      await task("B", "Find a venue for the Oct 10 dinner");
      const s = await O.syncOpenLoops(ID.A);
      await O.syncOpenLoops(ID.B);
      const amb = await O.setLoopStatus(ID.A, { title: "venue" }, "unconfirmed", "x");
      const unknown = await O.setLoopStatus(ID.A, { id: 999999, title: "venue" }, "unconfirmed", "x");
      const target = s.rows.find((r) => /offsite/.test(r.title))!;
      const okRes = await O.setLoopStatus(ID.A, { id: target.id, title: "venue" }, "unconfirmed", "price not confirmed");
      const a = await loopRows("A"), b = await loopRows("B");
      const reply = await replyAbout("A", "where are we on the venues?", O.describeLoops((await O.syncOpenLoops(ID.A)).rows, { withIds: true }));
      return {
        checks: [
          ck("an ambiguous title is refused, naming the candidates", !amb.ok && /More than one loop/.test((amb as any).error), amb),
          ck("an unknown id is refused", !unknown.ok && /no open loop/i.test((unknown as any).error), unknown),
          ck("the exact id changes only that loop", okRes.ok && a.find((l: any) => Number(l.id) === target.id)?.status === "unconfirmed" && a.filter((l: any) => l.status === "unconfirmed").length === 1, a),
          ck("B's same-titled loop is untouched", b.every((l: any) => l.status === "open" && l.status_by === "code"), b),
          ck("loop ids never reach the member's text", !/\[?loop \d+\]?|\b\d{3,}\b/i.test(reply.text), reply.text),
        ],
        texts: { reply: reply.text },
      };
    },
  },
  {
    suite: "loops", id: "loop-pending-wake", mode: "model-free", runs1: true,
    run: async () => {
      await member("A");
      const O = await import("../../src/services/openLoops.js");
      const t = await task("A", "Find a venue for Oct 10");
      await O.syncOpenLoops(ID.A);
      // An hour passes (simulated: seen_at backdated), then the task starts waiting on them.
      await rows(`UPDATE open_loops SET seen_at = NOW() - interval '1 hour', changed_at = NOW() - interval '1 hour'`);
      await rows(`UPDATE co_tasks SET awaiting_reply = true WHERE id = $1`, [t]);
      await O.syncOpenLoops(ID.A); // the change
      await O.syncOpenLoops(ID.A); // an intervening read-only sync (a reply turn)
      const pending = (await loopRows("A"))[0];
      // The wake update fails once: the loop must stay pending.
      DBC.faults = [/WITH t AS \(UPDATE co_tasks SET next_check_at = NOW\(\)/];
      await O.runLoopSync();
      DBC.faults = [];
      const afterFail = (await loopRows("A"))[0];
      const taskAfterFail = (await rows(`SELECT next_check_at > NOW() AS later FROM co_tasks WHERE id = $1`, [t]))[0];
      // Now it works: the task is woken and only then is the loop marked seen.
      await O.runLoopSync();
      const afterWake = (await loopRows("A"))[0];
      const taskAfter = (await rows(`SELECT next_check_at <= NOW() AS due FROM co_tasks WHERE id = $1`, [t]))[0];
      const decisions = await rows(`SELECT outcome, action FROM harness_decisions WHERE decision = 'loop.changed' ORDER BY created_at`);
      return {
        checks: [
          ck("the change stays pending across an intervening sync", new Date(pending.changed_at) > new Date(pending.seen_at), pending),
          ck("a failed wake leaves it pending and the task asleep", new Date(afterFail.changed_at) > new Date(afterFail.seen_at) && !afterFail.woke_at && taskAfterFail.later, { afterFail, taskAfterFail }),
          ck("a successful wake moves the task due, then marks the loop seen and woken", taskAfter.due && !!afterWake.woke_at && new Date(afterWake.seen_at) >= new Date(afterWake.changed_at), { afterWake, taskAfter }),
          ck("both attempts were logged (skip, then act)", decisions.length === 2 && decisions[0].outcome === "skip" && decisions[1].outcome === "act", decisions),
        ],
        observed: { simulatedTime: "seen_at/changed_at backdated 1h to stand for a gap between syncs" },
      };
    },
  },
  {
    suite: "loops", id: "loop-debounce-deadline", mode: "model-free", runs1: true,
    run: async () => {
      const O = await import("../../src/services/openLoops.js");
      const T = await import("../../src/services/coTasks.js");
      const now = new Date("2026-10-02T18:00:00Z");
      const h = (n: number) => new Date(now.getTime() - n * 3_600_000);
      const base = { taskId: 1, status: "unconfirmed" as const, changedAt: h(0.1), seenAt: h(1), dueDate: null as string | null };
      const day = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
      const fin = new Date(now.getTime() + 5 * 60_000).toISOString();
      return {
        checks: [
          ck("never woken: wake", O.shouldWake({ ...base, wokeAt: null }, now)),
          ck(`woken ${O.WAKE_EVERY_HOURS - 1}h ago, no deadline: wait`, !O.shouldWake({ ...base, wokeAt: h(O.WAKE_EVERY_HOURS - 1) }, now)),
          ck(`exactly ${O.WAKE_EVERY_HOURS}h: wake`, O.shouldWake({ ...base, wokeAt: h(O.WAKE_EVERY_HOURS) }, now)),
          ck(`due within ${O.URGENT_WITHIN_DAYS} days skips the cooldown`, O.shouldWake({ ...base, wokeAt: h(1), dueDate: day(1) }, now)),
          ck("due in 5 days keeps the cooldown", !O.shouldWake({ ...base, wokeAt: h(1), dueDate: day(5) }, now)),
          ck("already seen: no wake", !O.shouldWake({ ...base, seenAt: now, wokeAt: null }, now)),
          ck("no task behind it: no wake", !O.shouldWake({ ...base, taskId: null as any, wokeAt: null }, now)),
          ck("final check before the deadline always may text", T.mayText({ lastTextedAt: h(1).toISOString(), finalCheckAt: fin, finalTold: false }, 9, now).ok),
          ck("otherwise a task text an hour after the last one waits", !T.mayText({ lastTextedAt: h(1).toISOString() }, 0, now).ok, T.mayText({ lastTextedAt: h(1).toISOString() }, 0, now)),
          ck("after they reply, the gap no longer applies", T.mayText({ lastTextedAt: h(1).toISOString(), theirReplyAt: h(0.5).toISOString() }, 0, now).ok, T.mayText({ lastTextedAt: h(1).toISOString(), theirReplyAt: h(0.5).toISOString() }, 0, now)),
        ],
        observed: { clock: { injected: now.toISOString(), note: "shouldWake/mayText take an injected now; SQL NOW() isn't involved here." }, limits: T.TASK_LIMITS },
      };
    },
  },
  {
    suite: "loops", id: "loop-no-news-vs-change",
    replaced: ["task search/web/readPage: deterministic fixtures (no live search)", "task send: captured in memory"],
    run: async () => {
      await member("A");
      const T = await import("../../src/services/coTasks.js");
      const { runTaskTurnWith } = await import("../../src/services/taskTurn.js");
      const id = await task("A", "Find a venue for 40 people on Oct 10 under $2,000", { latest: "Wave looks right; their price is unconfirmed." });
      const recent = "User said: find me a venue for 40 on Oct 10, under $2k\nCo replied: On it. Wave looks right; I'm confirming their price.";
      // Turn 1: nothing new.
      const t1 = (await T.getTask(ID.A, id))!;
      const q = await deps("A", id, {}, recent);
      const r1 = await runTaskTurnWith(t1, q.d);
      // Turn 2: Wave's page now states the price.
      await rows(`UPDATE co_tasks SET status = 'open', closed_at = NULL WHERE id = $1`, [id]);
      const t2 = (await T.getTask(ID.A, id))!;
      const wave = { name: "Wave", url: "https://wave-sf.invalid/private-events", official: true, facts: ["capacity: 60 seated", "price: $1,800 for a 4-hour evening buyout", "available Oct 10"], excerpts: ["Evening buyouts are $1,800 for four hours. Seats 60."], date: null, deadline: null };
      const q2 = await deps("A", id, { web: [wave], page: { [wave.url]: wave.facts } }, recent);
      const r2 = await runTaskTurnWith(t2, q2.d);
      const sent2 = q2.sent.flat().join(" / ");
      return {
        checks: [
          ck("quiet turn sends nothing", q.sent.length === 0, q.sent),
          ck("quiet turn ends with schedule or finish", q.calls.schedule + q.calls.close >= 1, q.calls),
          ck("a verified price change is told", q2.sent.length >= 1 && /\$?1,?800/.test(sent2), q2.sent),
          ck("changed turn ends with schedule or finish", q2.calls.schedule + q2.calls.close >= 1, q2.calls),
          ck("no unsupported promise or invented detail", !/I'?ll (book|reserve|call|email)|booked|reserved|\$2,?000 (is|was) (confirmed|their price)/i.test(sent2), sent2),
        ],
        texts: { quiet: q.sent, changed: q2.sent },
        observed: { r1, r2 },
      };
    },
  },
  {
    suite: "loops", id: "loop-user-finished",
    replaced: ["task search/web: deterministic fixtures", "task send: captured"],
    run: async () => {
      await member("A");
      const T = await import("../../src/services/coTasks.js");
      const { runTaskTurnWith } = await import("../../src/services/taskTurn.js");
      const venue = await task("A", "Find a venue for the Oct 10 dinner", { latest: "Shortlist: Wave, SOMA Loft." });
      const dj = await task("A", "Find a DJ for the Oct 10 dinner", { latest: "Two DJs to check." });
      const recent = "Co replied: Wave and SOMA Loft are the two venues worth a look.\nUser said: found a venue myself, we booked Wave. still need a DJ though";
      const q = await deps("A", venue, { web: [{ name: "Gallery 9", url: "https://gallery9.invalid", official: true, facts: ["capacity 50"], date: null, deadline: null }] }, recent);
      await runTaskTurnWith((await T.getTask(ID.A, venue))!, q.d);
      const v = (await rows(`SELECT status FROM co_tasks WHERE id = $1`, [venue]))[0];
      const d = (await rows(`SELECT status FROM co_tasks WHERE id = $1`, [dj]))[0];
      const sent = q.sent.flat().join(" / ");
      return {
        checks: [
          ck("the venue task stops (finished or dropped)", ["done", "dropped"].includes(v.status), v),
          ck("the DJ task is untouched", d.status === "open", d),
          ck("no re-selling the venue they already booked", !/Gallery 9|another venue|other options/i.test(sent), sent),
        ],
        texts: { sent: q.sent },
        observed: { note: "Proactive lanes/caps/holds for competing candidates are not exercised here (see report)." },
      };
    },
  },
];
