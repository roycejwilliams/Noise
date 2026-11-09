// One text, one change (services/announcements.ts ONE_CHANGE, 2026-11-08), the monthly override, never stacked, the send-time judgment
// for announcements (harness/momentFit.ts), and the first-use note (services/firstUseNotes.ts). Layer 1, zero tokens: the pick (each
// situation gets its line; none fits gets nothing; a failed read gets nothing), the override, never beside anything else of theirs, a
// hard day judged rather than held, and the note said once. Nothing is sent and no model is called: databases and the moment read are
// faked.
//
//   npx tsx evals/proactive/announcementOneChange.ts
import fs from "node:fs";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const AN = await import("../../src/services/announcements.js");
const F = await import("../../src/services/firstUseNotes.js");
const MF = await import("../../src/harness/momentFit.js");
const P = await import("../../src/harness/proactive.js");
const { MAKER_ASK } = await import("../../src/harness/replyGrounding.js");
const { capitalizeSentences } = await import("../../src/services/textStyle.js");

const now = new Date("2026-11-20T18:00:00Z");
const H = 3_600_000;
const before = new Date("2026-10-01T00:00:00Z");
type S = import("../../src/services/announcements.js").ChangeSituation;
const sit = (o: Partial<S> = {}): S => ({ joinedAt: before, talkDays: 0, usedRemovedMaker: false, hadCalls: false, makerChangeTold: false, ...o });
const pick = (o: Partial<S>) => AN.pickChange(AN.ONE_CHANGE, sit(o))?.id ?? null;

// ---------------------------------------------------------------- 1. the registry: one text, one change, waiting on approval
check("registry: the one-change announcement is registered, its own key and type", AN.announcementByKey(AN.ONE_CHANGE_KEY) === AN.ONE_CHANGE && AN.ONE_CHANGE.type === "announcement");
check("registry: not approved yet (a code constant), so nothing is queued", AN.ONE_CHANGE_APPROVED === false && AN.ONE_CHANGE.approved === false && !/process\.env/.test(src("services/announcements.ts")));
check("registry: no list, no separate texts, no lead, no 'on my side'", !AN.ONE_CHANGE.texts && AN.ONE_CHANGE.lead === "" && AN.ONE_CHANGE.body === "" && !AN.ONE_CHANGE.narrationApproved && AN.ONE_CHANGE_CHANGES.every((c) => !/on my side|^\s*·|\n/i.test(c.line)));
check("registry: three changes, each its own approved line, priority and moment", AN.ONE_CHANGE_CHANGES.map((c) => c.id).join() === "helpers,recall,notes" && AN.ONE_CHANGE_CHANGES.map((c) => c.priority).join() === "1,2,3");
check("registry: the old entries are untouched (they've been sent)", AN.UPDATE_1102.texts?.[0] === "A few things changed on my side:" && AN.UPDATE_1102.texts?.length === 3 && !AN.UPDATE_1102.changes && !AN.SHIFT.changes && !AN.RENAME.changes && AN.ANNOUNCEMENTS.indexOf(AN.ONE_CHANGE) === 3);
check("registry: the old entries keep the monthly limit (no override on them)", AN.ANNOUNCEMENTS.every((a) => !a.overrideMonthly));
check("registry: the audience is everyone who joined before the latest change, each change checked again at the pick", "joinedBefore" in (AN.ONE_CHANGE.audience as object) && (AN.ONE_CHANGE.audience as { joinedBefore: Date }).joinedBefore.getTime() === AN.DAILY_NOTES_LANDED_AT.getTime());

// ---------------------------------------------------------------- 2. the copy
check("copy: the drafted lines, as in the PR's Copy section", AN.ONE_CHANGE_HELPERS === "I've stopped making decks, pages and email drafts so I can put that time into who you should meet. If you need one made, tell me and I'll look for someone you could meet who does that." && AN.ONE_CHANGE_RECALL === "I can look back on what we've talked about before now, by text or on a call. Ask me about something from a while ago and I'll look for it." && AN.ONE_CHANGE_NOTES === "I keep short notes on what we talk about now, and you can see every one. Ask me what I know about you, and any note you'd rather I didn't keep is gone when you say so.");
for (const c of AN.ONE_CHANGE_CHANGES) {
  const sent = capitalizeSentences(c.line);
  const bad = P.checkDraft(sent, AN.ANNOUNCEMENT_RULES).filter((k) => !k.pass);
  check(`copy: ${c.id} passes the proactive draft checks as written (no exception needed)`, sent === c.line && bad.length === 0, { bad, len: c.line.length });
  check(`copy: ${c.id} has no exclamation, emoji, question or role`, !/[!?]/.test(c.line) && !/\p{Extended_Pictographic}/u.test(c.line) && !/noise'?s ai|\bmatchmak|\bassistant\b|\bconcierge\b|\bmy role\b/i.test(c.line));
  check(`copy: ${c.id} is never a changelog (no counts, versions, 'shipped', 'features', 'update')`, !/\d|\bshipp|\bfeature|\bupdate|\bversion|\bnew in\b|\brelease/i.test(c.line));
}
check("copy: the helpers line promises a look, never a find (an intro ask is a look among the people Cue knows)", !/find you someone|does it well/i.test(AN.ONE_CHANGE_HELPERS) && /look for someone you could meet/.test(AN.ONE_CHANGE_HELPERS));
check("copy: the notes line says the notes go, not 'anything' (an arrival record stays)", !/anything you'd rather/i.test(AN.ONE_CHANGE_NOTES) && /any note you'd rather/.test(AN.ONE_CHANGE_NOTES));
check("copy: the recall line promises a look (a lookup can miss)", !/I'll find it/.test(AN.ONE_CHANGE_RECALL));

// ---------------------------------------------------------------- 3. the pick
check("pick: used a removed maker (and not told) gets the helpers line", pick({ usedRemovedMaker: true }) === "helpers");
check("pick: had calls gets the recall line", pick({ hadCalls: true }) === "recall");
check("pick: talked on enough days gets the notes line", pick({ talkDays: AN.NOTES_MIN_DAYS }) === "notes");
check("pick: one day short of enough is nothing", pick({ talkDays: AN.NOTES_MIN_DAYS - 1 }) === null);
check("pick: more than one fits, the highest priority wins (helpers, then recall, then notes)", pick({ usedRemovedMaker: true, hadCalls: true, talkDays: 9 }) === "helpers" && pick({ hadCalls: true, talkDays: 9 }) === "recall");
check("pick: already told about the makers (a reply said it), the helpers line is out", pick({ usedRemovedMaker: true, makerChangeTold: true }) === null && pick({ usedRemovedMaker: true, makerChangeTold: true, talkDays: 5 }) === "notes");
check("pick: none fits, nothing (never a generic fallback)", pick({}) === null);
check("pick: every read failed, nothing", AN.pickChange(AN.ONE_CHANGE, { joinedAt: null, talkDays: null, usedRemovedMaker: null, hadCalls: null, makerChangeTold: null }) === null);
check("pick: a failed read is only that change out (told unread: no helpers line; calls unread: no recall line)", pick({ usedRemovedMaker: true, makerChangeTold: null }) === null && pick({ hadCalls: null, talkDays: 4 }) === "notes" && pick({ usedRemovedMaker: null, hadCalls: true }) === "recall");
check("pick: joined after a change landed, that change never fits", pick({ joinedAt: new Date(AN.HELPERS_REMOVED_AT.getTime() + 1000), usedRemovedMaker: true }) === null && pick({ joinedAt: new Date(AN.RECALL_LANDED_AT.getTime() + 1000), hadCalls: true }) === null && pick({ joinedAt: new Date(AN.DAILY_NOTES_LANDED_AT.getTime() + 1000), talkDays: 9 }) === null);
check("pick: joined between two changes gets only the later one", pick({ joinedAt: new Date(AN.HELPERS_REMOVED_AT.getTime() + 1000), usedRemovedMaker: true, talkDays: 9 }) === "notes");
check("pick: unknown join date fits nothing", pick({ joinedAt: null, usedRemovedMaker: true, hadCalls: true, talkDays: 9 }) === null);
check("pick: a predicate that throws fits nothing, the next one still can", AN.pickChange({ changes: [{ id: "x", line: "x", landed: now, priority: 1, fits: () => { throw new Error("boom"); } }, { id: "y", line: "y", landed: now, priority: 2, fits: () => true }] }, sit())?.id === "y");
check("pick: an announcement with no changes picks nothing", AN.pickChange(AN.SHIFT, sit({ usedRemovedMaker: true })) === null);

// ---------------------------------------------------------------- 4. the draft at send time
const cand = (o: Record<string, unknown> = {}): any => ({ id: "c1", userId: "u-jordan", targetKey: AN.ONE_CHANGE_KEY, expiresAt: new Date(now.getTime() + 10 * 24 * H), ...o });
const base = { approved: true, now: () => now, told: async () => false, othersWaiting: async () => false };
{
  const d = await AN.draftAnnouncement(cand(), { ...base, changeSituation: async () => sit({ hadCalls: true }) });
  check("draft: one text, the one change that fits", "messages" in d && d.messages.length === 1 && d.messages[0] === AN.ONE_CHANGE_RECALL && d.text === AN.ONE_CHANGE_RECALL && (d.meta as any)?.change === "recall", d);
  const none = await AN.draftAnnouncement(cand(), { ...base, changeSituation: async () => sit() });
  check("draft: nothing fits, nothing goes (skip)", "skip" in none && /none of its changes fits/.test(none.skip), none);
  const threw = await AN.draftAnnouncement(cand(), { ...base, changeSituation: async () => { throw new Error("db down"); } });
  check("draft: the situation can't be read, nothing goes", "skip" in threw, threw);
  const unapproved = await AN.draftAnnouncement(cand(), { ...base, approved: false, changeSituation: async () => sit({ hadCalls: true }) });
  check("draft: unapproved waits (it can't be queued either)", "defer" in unapproved);
  let reads = 0;
  const told = await AN.draftAnnouncement(cand(), { ...base, told: async () => true, changeSituation: async () => (reads++, sit({ hadCalls: true })) });
  check("draft: already told, nothing goes and no situation read", "skip" in told && reads === 0);
  const ended = await AN.draftAnnouncement(cand({ expiresAt: new Date(now.getTime() - 1000) }), { ...base, changeSituation: async () => sit({ hadCalls: true }) });
  check("draft: past its end, nothing goes", "skip" in ended && /end/.test(ended.skip));
}

// ---------------------------------------------------------------- 5. never stacked
{
  let asked: any = null;
  const waits = await AN.draftAnnouncement(cand(), { ...base, zone: "America/New_York", othersWaiting: async (o) => ((asked = o), true), changeSituation: async () => sit({ hadCalls: true }) });
  check("stack: anything else of theirs about to go, it waits (a defer, never a drop)", "defer" in waits && waits.defer.getTime() === now.getTime() + AN.STACK_WAIT_HOURS * H && /never goes beside it/.test(waits.reason), waits);
  check("stack: the read gets the member, this candidate (left out of its own count), their zone and whether it carries the rename", asked?.userId === "u-jordan" && asked?.candidateId === "c1" && asked?.zone === "America/New_York" && asked?.carriesRename === false, asked);
  const unread = await AN.draftAnnouncement(cand(), { ...base, othersWaiting: async () => { throw new Error("db down"); }, changeSituation: async () => sit({ hadCalls: true }) });
  check("stack: the read fails, it waits (never sent blind)", "defer" in unread && /couldn't read/.test(unread.reason), unread);
  // Every announcement, the old ones too (the shift and the 11-02 update).
  for (const key of [AN.SHIFT_KEY, AN.UPDATE_1102_KEY]) {
    const d = await AN.draftAnnouncement(cand({ targetKey: key }), { ...base, othersWaiting: async () => true, situation: async () => ({ hasOwnGoal: false }) });
    check(`stack: ${key} waits too`, "defer" in d, d);
  }
  let shiftAsked: any = null;
  await AN.draftAnnouncement(cand({ targetKey: AN.SHIFT_KEY }), { ...base, othersWaiting: async (o) => ((shiftAsked = o), false), situation: async () => ({ hasOwnGoal: false }) });
  check("stack: the shift (which carries the rename) doesn't count the rename notice it claims", shiftAsked?.carriesRename === true);

  // The read itself: pending candidates due by the end of their day, and queued deferred sends.
  const seen: { sql: string; args: unknown[] }[] = [];
  const db = (waiting: unknown) => ({ query: async (sql: string, args: unknown[] = []) => (seen.push({ sql, args }), { rows: waiting === undefined ? [] : [{ waiting }] }) });
  check("stack read: a pending candidate due today or a queued deferred send holds it", (await AN.othersWaitingOf({ userId: "u", candidateId: "c1", zone: "America/Los_Angeles", now, carriesRename: false }, db(true))) === true);
  check("stack read: nothing waiting lets it go", (await AN.othersWaitingOf({ userId: "u", candidateId: "c1", zone: null, now, carriesRename: false }, db(false))) === false);
  const noAnswer = await AN.othersWaitingOf({ userId: "u", candidateId: "c1", zone: null, now, carriesRename: false }, db(undefined)).then(() => "answered", () => "threw");
  check("stack read: no answer throws (the draft then waits)", noAnswer === "threw");
  const sql = AN.OTHERS_WAITING_SQL.replace(/\s+/g, " ");
  check("stack read: pending candidates of theirs, not this one, not another announcement, due inside the window, not past their end", /FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending' AND \(\$2::text IS NULL OR id::text <> \$2\)/.test(sql) && /type <> 'announcement'/.test(sql) && /due_at >= \$5 AND due_at < \$3/.test(sql) && /expires_at IS NULL OR expires_at > \$6/.test(sql));
  check("stack read: the window is from STALE_DUE_HOURS ago to the end of their day, and now is the expiry test", (seen[0].args[4] as Date).getTime() === now.getTime() - AN.STALE_DUE_HOURS * H && (seen[0].args[5] as Date).getTime() === now.getTime() && AN.STALE_DUE_HOURS === 6);
  // The rule itself (the same one the SQL holds): a stale past-due candidate (gated, NULL expiry) never blocks; one due later today does.
  const z = "America/Los_Angeles";
  check("stack rule: a candidate past due by more than 6 hours with no expiry doesn't block", !AN.countsAsWaiting({ dueAt: new Date(now.getTime() - 7 * H), expiresAt: null }, now, z) && !AN.countsAsWaiting({ dueAt: new Date(now.getTime() - 5 * 24 * H), expiresAt: null }, now, z));
  check("stack rule: one due later today blocks", AN.countsAsWaiting({ dueAt: new Date(now.getTime() + 2 * H), expiresAt: null }, now, z) && AN.countsAsWaiting({ dueAt: new Date(now.getTime() + 2 * H), expiresAt: new Date(now.getTime() + 24 * H) }, now, z));
  check("stack rule: one due a little while ago (inside 6 hours) still blocks", AN.countsAsWaiting({ dueAt: new Date(now.getTime() - 5 * H), expiresAt: null }, now, z));
  check("stack rule: one due tomorrow, or past its end, doesn't block", !AN.countsAsWaiting({ dueAt: new Date(AN.endOfLocalDay(now, z).getTime() + H), expiresAt: null }, now, z) && !AN.countsAsWaiting({ dueAt: new Date(now.getTime() + H), expiresAt: new Date(now.getTime() - 1000) }, now, z));
  check("stack rule: the SQL's bounds are the rule's window", (seen[0].args[2] as Date).getTime() === AN.waitingWindow(now, z).to.getTime() && (seen[0].args[4] as Date).getTime() === AN.waitingWindow(now, z).from.getTime());
  check("stack read: any deferred send of theirs queued or going out", /FROM deferred_sends WHERE user_id = \$1 AND status IN \('queued', 'sending'\)/.test(sql));
  const end = seen[0].args[2] as Date;
  check("stack read: 'today' ends at the end of their local day", end.toISOString() === "2026-11-21T07:59:59.999Z", end);
  check("stack read: an unknown zone falls back to Pacific", AN.endOfLocalDay(now, "Not/AZone").toISOString() === "2026-11-21T07:59:59.999Z" && AN.endOfLocalDay(now, "America/New_York").toISOString() === "2026-11-21T04:59:59.999Z");
  // The day's pick still sees an announcement only when nothing else is ready (quietDayOnly), before any of this.
  const q = (type: string, id: string) => ({ id, type, createdAt: now }) as any;
  check("stack: quiet day only is unchanged: with anything else eligible, the announcement isn't picked", AN.quietDayOnly([q("announcement", "a"), q("companion", "c")]).map((x) => x.id).join() === "c");
  const pr = src("harness/proactive.ts");
  check("stack: the dispatch still filters the pick through quietDayOnly", /const quiet = \(await import\("\.\.\/services\/announcements\.js"\)\)\.quietDayOnly\(withoutName\);/.test(pr));
  check("stack: a wait never moves an announcement's end", /WHEN type = 'announcement' THEN expires_at/.test(pr));
}

// ---------------------------------------------------------------- 6. the monthly limit and its explicit override
{
  check("override: none by default", AN.monthlyOverride(AN.ONE_CHANGE) === null);
  check("override: an explicit, dated one is honored", JSON.stringify(AN.monthlyOverride({ overrideMonthly: { by: "the CTO", on: "2026-11-20" } })) === JSON.stringify({ by: "the CTO", on: "2026-11-20" }));
  check("override: a malformed one is no exception (no who, or no real day)", AN.monthlyOverride({ overrideMonthly: { by: " ", on: "2026-11-20" } }) === null && AN.monthlyOverride({ overrideMonthly: { by: "x", on: "soon" } }) === null);
  let queried = 0;
  const busy = { query: async () => (queried++, { rows: [{ target_key: AN.SHIFT_KEY, state: "sent", n: 4 }] }) };
  const held = await AN.monthlyLimit(busy, AN.ONE_CHANGE, now);
  check("monthly: without an override, another announcement this month still blocks it", /one announcement a month/.test(held ?? "") && queried === 1, held);
  const waived = await AN.monthlyLimit(busy, { ...AN.ONE_CHANGE, overrideMonthly: { by: "the CTO", on: "2026-11-20" } }, now);
  check("monthly: with an explicit override, nothing blocks it (and nothing is read)", waived === null && queried === 1);
  // Through the queue: with the override it is queued even though another went this month, and the log says why.
  const rows = [{ id: "u-1", created_at: before, archived_at: null, sms_opted_out: false, has_phone: true, invite_verified: true, told: false, queued: false, phone_number: "+14155550301", simulated: false }];
  const qdb = { query: async (sql: string) => (/target_key <> \$1/.test(sql) ? { rows: [{ target_key: AN.SHIFT_KEY, state: "sent", n: 4 }] } : /FROM users u/.test(sql) ? { rows } : { rows: [{ at: null }] }) };
  const enq: any[] = [], lines: string[] = [];
  const n0 = await AN.queueAnnouncement(AN.ONE_CHANGE, now, { db: qdb, enqueue: async (i) => (enq.push(i), { queued: true }), log: (l) => lines.push(l), approved: true });
  check("queue: without the override, blocked by this month's other announcement", n0 === 0 && enq.length === 0 && lines.some((l) => /one announcement a month/.test(l)), lines);
  lines.length = 0;
  const n1 = await AN.queueAnnouncement({ ...AN.ONE_CHANGE, overrideMonthly: { by: "the CTO", on: "2026-11-20" } }, now, { db: qdb, enqueue: async (i) => (enq.push(i), { queued: true }), log: (l) => lines.push(l), approved: true });
  check("queue: with the override, queued, and the log names the exception", n1 === 1 && enq.length === 1 && lines.some((l) => /monthly limit is waived for it \(said by the CTO on 2026-11-20\)/.test(l)), lines);
  check("queue: unapproved still queues nothing, override or not", (await AN.queueAnnouncement({ ...AN.ONE_CHANGE, overrideMonthly: { by: "the CTO", on: "2026-11-20" } }, now, { db: qdb, enqueue: async () => ({ queued: true }), log: () => {} })) === 0);
}

// ---------------------------------------------------------------- 7. the situation reads (fail closed, one at a time)
{
  const ok: Record<string, unknown[]> = {
    users: [{ created_at: before }], talk: [{ n: 4 }], calls: [{ had: true }], used: [{ used: true }], told: [{ told: false }],
  };
  const fake = (fail: string[] = []) => ({
    query: async (sql: string) => {
      const which = /FROM users WHERE id/.test(sql) ? "users" : /COUNT\(DISTINCT/.test(sql) ? "talk" : /call_transcript/.test(sql) ? "calls" : /document_deliveries/.test(sql) ? "used" : /proactive_sends/.test(sql) ? "told" : "?";
      if (fail.includes(which)) throw new Error("db down");
      return { rows: ok[which] ?? [] };
    },
  });
  const all = await AN.changeSituationOf("u", fake());
  check("reads: every signal read", all.joinedAt?.getTime() === before.getTime() && all.talkDays === 4 && all.hadCalls === true && all.usedRemovedMaker === true && all.makerChangeTold === false, all);
  for (const k of ["users", "talk", "calls", "used", "told"]) {
    const s = await AN.changeSituationOf("u", fake([k]));
    const field = { users: "joinedAt", talk: "talkDays", calls: "hadCalls", used: "usedRemovedMaker", told: "makerChangeTold" }[k] as keyof S;
    const others = (Object.keys(all) as (keyof S)[]).filter((f) => f !== field);
    check(`reads: ${k} failing is only ${field} unread (null), the rest still read`, s[field] === null && others.every((f) => s[f] !== null), s);
  }
  const empty = await AN.changeSituationOf("u", { query: async () => ({ rows: [] }) });
  check("reads: no rows back is unread, never 'no'", empty.joinedAt === null && empty.talkDays === null && empty.hadCalls === null && empty.usedRemovedMaker === null && empty.makerChangeTold === null, empty);
  check("reads: talk days count their own texts and voice memos, distinct days, never a teammate line, in the notes' lookback", /COUNT\(DISTINCT/.test(AN.TALK_DAYS_SQL) && /User said:%/.test(AN.TALK_DAYS_SQL) && /User sent a voice memo:%/.test(AN.TALK_DAYS_SQL) && AN.TALK_DAYS_SQL.includes("!~ ' \\[to [A-Za-z]+\\]$'") && /60 days/.test(AN.TALK_DAYS_SQL));
  check("reads: calls are a stored transcript or a call's summary note", /memory_type = 'call_transcript'/.test(AN.HAD_CALLS_SQL) && /\[Call\] %/.test(AN.HAD_CALLS_SQL));
  // The removed-maker read: Cue's own action record of a maker tool that did it (not a refused call), before the removal, plus the rows
  // that honestly remain.
  const seen: { sql: string; args: unknown[] }[] = [];
  await F.usedRemovedMaker("u", { query: async (sql: string, args: unknown[] = []) => (seen.push({ sql, args }), { rows: [{ used: false }] }) });
  const tools = seen[0].args[1] as string[];
  check("reads: the removed makers are pages, decks, documents, plan sheets and email drafts, in their tool names", ["makePage", "updatePage", "makeDeck", "updateDeck", "writeDocument", "emailPlan", "draftEmail"].every((t) => tools.includes(`tool.${t}`) && tools.includes(`tool.${t}.background`)));
  check("reads: only before the removal, and never a refused call", (seen[0].args[2] as Date).getTime() === AN.HELPERS_REMOVED_AT.getTime() && /relation <> 'not_done'/.test(seen[0].sql) && /document_deliveries/.test(seen[0].sql) && /co_pages/.test(seen[0].sql) && /artifact_design_log/.test(seen[0].sql));
  const toldSeen: { sql: string; args: unknown[] }[] = [];
  await F.makerChangeTold("u", { query: async (sql: string, args: unknown[] = []) => (toldSeen.push({ sql, args }), { rows: [{ told: true }] }) });
  check("reads: told is the first-use note's record, or the one-change announcement's makers line on the ledger", toldSeen[0].args.includes(F.MAKER_FIRST_USE_KEY) && toldSeen[0].args.includes(AN.ONE_CHANGE_KEY) && toldSeen[0].args.includes(AN.ONE_CHANGE_HELPERS));
}

// ---------------------------------------------------------------- 8. the send-time judgment, not a mood blanket
{
  check("judgment: an announcement goes to the moment read (send / wait / drop)", MF.momentFitApplies("unsolicited", {}, { type: "announcement" }) === true);
  check("judgment: one they pulled ('anything for me?') isn't read", MF.momentFitApplies("unsolicited", {}, { type: "announcement", pulled: true }) === false);
  check("judgment: check-ins are as before (an optional one is read, a requested one and an ask check-in are not)", MF.momentFitApplies("checkin", {}, { type: "goal_checkin" }) === true && MF.momentFitApplies("requested", {}, { type: "reminder" }) === false && MF.momentFitApplies("checkin", {}, { type: "ask_checkin" }) === false && MF.momentFitApplies("unsolicited", {}, { type: "event_offer" }) === false);
  check("judgment: no class hold on a hard day (not in HOLD_WHILE_STRUGGLING)", !P.HOLD_WHILE_STRUGGLING.has("announcement"));
  const base2 = { firstName: "Jordan", message: AN.ONE_CHANGE_RECALL, recent: "[Nov 19] Them: rough week", call: null, queuedAt: now, now };
  check("judgment: the hard day is told to the read as a reason for more thought, never a verdict", MF.momentPrompt({ ...base2, hardDay: true }).includes(MF.HARD_DAY_LINE) && /not a reason on its own to stay silent/.test(MF.HARD_DAY_LINE));
  check("judgment: without it the prompt is exactly as before", !MF.momentPrompt(base2).includes(MF.HARD_DAY_LINE) && MF.momentPrompt(base2) === MF.momentPrompt({ ...base2, hardDay: false }));
  check("judgment: every read the hard day is on gets the line (2026-11-09: announcements and check-ins alike)", MF.momentHardDay({ kind: "announcement", hardDay: true }) && MF.momentHardDay({ kind: "goal_checkin", hardDay: true }) && !MF.momentHardDay({ kind: "announcement", hardDay: false }));
  const prompts: string[] = [];
  MF.setMomentModelForTests(async (p) => (prompts.push(p), '{"verdict":"wait","why":"they are in the middle of something hard"}'));
  const ready = { ready: true as const, line: null };
  const va = await MF.momentFit({ userId: "u", ...base2, call: ready, kind: "announcement", hardDay: true });
  const vc = await MF.momentFit({ userId: "u", ...base2, call: ready, kind: "goal_checkin", hardDay: true });
  MF.setMomentModelForTests(null);
  check("judgment: the read sees the line for an announcement and for a check-in on a hard day", prompts[0].includes(MF.HARD_DAY_LINE) && prompts[1].includes(MF.HARD_DAY_LINE));
  check("judgment: its verdict decides (a wait is a wait, capped like every moment wait)", va.verdict === "wait" && va.read === "model" && vc.verdict === "wait" && MF.momentAction(va, { waits: 0 }, now).act === "wait" && MF.momentAction(va, { waits: MF.MOMENT_FIT.maxWaits }, now).act === "drop");
  const pr = src("harness/proactive.ts");
  check("judgment: the dispatch tells the read the capped hard-day hold and the kind", /kind: c\.type, hardDay: hardDayLine, queued, zone: zoneNow \}\);/.test(pr) && /const hardDayLine = STR\.hardDayLineFor\(\{ held: heldForMood\(state\), on: hardDayOn,/.test(pr) && MF.hardDayLineFor({ held: true, on: true, cls: "unsolicited", type: "announcement", payload: {} }) && !MF.hardDayLineFor({ held: false, on: true, cls: "unsolicited", type: "announcement", payload: {} }));
  check("judgment: no hard_day class check for an announcement (nor, since 2026-11-09, for any find or offer)", !/hardDayHolds\(/.test(pr) && !/name: "hard_day", pass: false, reason: `a hard day: only companionship goes/.test(pr));
  // Doesn't bypass the never-stacked rule: the read happens before the draft, the draft (with its stack read) always runs before a send,
  // and a defer returns before anything is sent.
  const iKept = pr.indexOf("if (moment.kept) {"), iDraft = pr.indexOf("await drafting(c.type, () => registry[c.type].draft(c, person))"), iDefer = pr.indexOf('if ("defer" in draft) {'), iJudge = pr.indexOf("if (momentRead && (!moment.preJudged");
  check("judgment: never bypasses the stack read (kept-draft read, then the draft, then its defer, then the fresh read, then the send)", iKept > 0 && iKept < iDraft && iDraft < iDefer && iDefer < iJudge);
}

// ---------------------------------------------------------------- 9. the first-use note: once, plainly, the first time it matters
{
  const ask = (m: string) => F.asksForRemovedMaker(m);
  for (const m of ["can you draft an email to my landlord", "make me a deck for Friday", "can you make me a pitch deck for friday", "could you build a landing page for it", "help me write an email to my old manager", "could you help me write a one-pager", "write an email for me to the venue", "draft me a quick email to Sam"]) check(`note: an ask aimed at Cue to make one: "${m}"`, ask(m));
  for (const m of ["I need to write a resignation email tomorrow, wish me luck", "I have to write an email to my boss about quitting and I am dreading it", "just finished my draft of the email to investors", "could you send me the doc from the event", "my presentation went badly", "she never answered my email", "can you share the deck from last night", "I wrote a doc about it"]) check(`note: not an ask to make one: "${m}"`, !ask(m));
  check("note: the decline rule's MAKER_ASK is unchanged (it still matches what it did, the note's read is its own)", MAKER_ASK.test("could you send me the doc from the event") && /F && F\.asksForRemovedMaker\(theirMessage\) \?/.test(src("harness/replyGrounding.ts")));
  const joinedBefore = async () => before, joinedAfter = async () => new Date(AN.HELPERS_REMOVED_AT.getTime() + H);
  check("note: joined before, not told: the facts go in", (await F.makerFirstUseNote("u", { joinedAt: joinedBefore, told: async () => false })) === F.MAKER_FIRST_USE_FACTS);
  check("note: already told: nothing", (await F.makerFirstUseNote("u", { joinedAt: joinedBefore, told: async () => true })) === null);
  check("note: joined after the change: nothing (they only knew the new way)", (await F.makerFirstUseNote("u", { joinedAt: joinedAfter, told: async () => false })) === null);
  check("note: a failed read: nothing this time", (await F.makerFirstUseNote("u", { joinedAt: joinedBefore, told: async () => { throw new Error("db"); } })) === null && (await F.makerFirstUseNote("u", { joinedAt: async () => { throw new Error("db"); }, told: async () => false })) === null);
  check("note: neutral facts for Cue to phrase, never a line to send (no quoted line, says it's once, offers the look)", !/"/.test(F.MAKER_FIRST_USE_FACTS) && /in your own words/.test(F.MAKER_FIRST_USE_FACTS) && /only time/.test(F.MAKER_FIRST_USE_FACTS) && /look for someone they could meet/.test(F.MAKER_FIRST_USE_FACTS));
  // Recorded only once a reply carrying it went; never twice.
  F.resetFirstUseNotes();
  const writes: { sql: string; args: unknown[] }[] = [];
  const db = { query: async (sql: string, args: unknown[] = []) => (writes.push({ sql, args }), { rows: [] }) };
  check("record: nothing pending, nothing written", (await F.confirmMakerFirstUse("u", db)) === false && writes.length === 0);
  F.noteMakerFirstUse("u", true);
  check("record: a reply that carried it went: written once", (await F.confirmMakerFirstUse("u", db, now)) === true && writes.length === 1 && writes[0].args.includes(F.MAKER_FIRST_USE_KEY) && writes[0].args.includes(F.FIRST_USE_SOURCE) && /WHERE NOT EXISTS/.test(writes[0].sql) && /'team'/.test(writes[0].sql));
  check("record: a second send in the same turn writes nothing more", (await F.confirmMakerFirstUse("u", db)) === false && writes.length === 1);
  F.noteMakerFirstUse("u", true);
  F.noteMakerFirstUse("u", false);
  check("record: a later reply that didn't carry it never records it (the turn resets it)", (await F.confirmMakerFirstUse("u", db)) === false && writes.length === 1);
  F.noteMakerFirstUse("u", true);
  check("record: one member's note never records another's", (await F.confirmMakerFirstUse("u-other", db)) === false && writes.length === 1);
  F.resetFirstUseNotes();
  // Once means once: after the record, the told read says yes, and the next ask gets no note.
  const toldNow = await F.makerFirstUseNote("u", { joinedAt: joinedBefore, told: async () => writes.length > 0 });
  check("once: after it's recorded, the next ask gets no note", toldNow === null);
  const RG = src("harness/replyGrounding.ts");
  check("wiring: the reply adds the note beside the decline rule, and notes it every turn (given or not)", /F && F\.asksForRemovedMaker\(theirMessage\) \? await F\.makerFirstUseNote\(userId\)/.test(RG) && /if \(note\) addInstruction\(rf, note\);/.test(RG) && /F\?\.noteMakerFirstUse\(userId, !!note\);/.test(RG) && /if \(MAKER_ASK\.test\(theirMessage\)\) addInstruction\(rf, MAKER_DECLINE_RULE\);/.test(RG));
  check("wiring: it's recorded from the reply's own send, only when it went", /if \(ok\) import\("\.\.\/services\/firstUseNotes\.js"\)\.then\(\(F\) => F\.confirmMakerFirstUse\(user\.id\)\)/.test(src("routes/sendblue.ts")));
}

console.log(`announcementOneChange: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
