// Lane moves (Royce, 2026-10-13): "A task becomes a lookout only on my words. Every other lane change is Co proposing and me
// confirming, and every confirmed change leaves a one-line, member-visible note. No silent re-promotion through a side door."
// Zero tokens: the store, the database and the model are stubbed.
//   1. the rules: task to lookout only on their words; task to goal, goal to lookout, lookout to goal on their yes; nothing else
//   2. moveLane without their yes changes nothing and leaves no line: the quoted yes must be their words in this message (code; a
//      clean retry hint, never a re-ask), the read of their answer must say yes to this offer (Haiku, stubbed here; an error is not a
//      yes), and Co's last text must have offered this move
//   3. with their yes it moves, logs lane.move with their quoted yes, and the reply carries its one line exactly once
//   4. task to lookout through moveLane is refused, yes or not
//   5. the kind jobs (askKind.ts, goalEdges.ts) leave an intent 'lookout' ask alone
//   6. a one-off ask never adds a goal or an interest (profileExtraction.ts storeProfile)
//   7. outside laneMoves.ts nothing writes an ask's kind or intent, or a task's source, and only the profile read (under its guard)
//      adds to co_profiles goals or activity_preferences
//   npx tsx evals/lanes/moves.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
import path from "node:path";
const L = await import("../../src/services/laneMoves.js");
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const { ABILITIES } = await import("../../src/services/capabilities.js");
const { yesIsTheirs } = await import("../../src/agent/toolGuard.js");
const Y = await import("../../src/services/theirYes.js");
// The read of their answer, stubbed: yes unless a case says otherwise. Every read is kept so a case can see what the judge was shown.
let verdict: () => Promise<{ yes: boolean; why: string; read: boolean }> = async () => ({ yes: true, why: "stub yes", read: true });
const reads: { offer: string | null; message: string; ability: string }[] = [];
Y.setYesJudgeForTests(async (r) => (reads.push(r), verdict()));
const K = await import("../../src/services/askKind.js");
const G = await import("../../src/services/goalEdges.js");
const CC = await import("../../src/services/callContext.js");
const P = await import("../../src/services/profileExtraction.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const root = new URL("../../src/", import.meta.url).pathname;
const src = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const count = (hay: string, needle: string) => hay.toLowerCase().split(needle.toLowerCase()).length - 1;

// An in-memory member: one goal, one task, one lookout.
function fakeStore() {
  const lanes: Record<string, L.LaneItem[]> = {
    task: [{ lane: "task", store: "task", id: "12", text: "find a venue for the November dinner" }],
    lookout: [{ lane: "lookout", store: "ask", id: "a-1", text: "founder runs in the Marina" }],
    goal: [{ lane: "goal", store: "goal_entry", id: "g-1", text: "jazz nights in SF" }],
  };
  const writes: string[] = [];
  const logs: any[] = [];
  const store: L.LaneStore = {
    items: async (_u, lane) => [...(lanes[lane] ?? [])],
    addGoal: async (_u, text) => { writes.push(`goal+ ${text}`); lanes.goal.push({ lane: "goal", store: "goal_entry", id: `g-${lanes.goal.length + 1}`, text }); return true; },
    addLookout: async (_u, text) => { writes.push(`lookout+ ${text}`); lanes.lookout.push({ lane: "lookout", store: "ask", id: `a-${lanes.lookout.length + 1}`, text }); return true; },
    leave: async (_u, item) => { writes.push(`${item.lane}- ${item.text}`); lanes[item.lane] = lanes[item.lane].filter((i) => i.id !== item.id); return true; },
    log: async (d) => { logs.push(d); },
  };
  return { store, lanes, writes, logs };
}
const quiet = console.log;
const OFFER = "Want me to keep the jazz nights as a lookout instead of a goal?";
const make = (message: string, o: { lastCoMessage?: string; recentExchange?: string; laneNotesOwed?: string[] } = {}) => {
  const facts: { kind: string; text: string }[] = [];
  const t = createConversationTools({
    userId: "u", phoneNumber: "+10000000000", resolvedContent: message, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true,
    ackSent: "👍", lastCoMessage: o.lastCoMessage ?? OFFER, recentExchange: o.recentExchange, laneNotesOwed: o.laneNotesOwed,
    sendCoReply: async () => true, facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => "" },
  } as any);
  return { tools: t.tools as any, state: t.state as any, facts };
};
const moved = (facts: { kind: string; text: string }[]) => facts.some((f) => f.kind === "did_this_turn" && /^(\(dry run\) )?Moved /.test(f.text));

// ---- 1. the rules
check("a task becomes a lookout only on their own words", L.ruleFor("task", "lookout") === "their_words");
check("task to goal, goal to lookout and lookout to goal are Cue's to propose and theirs to confirm", (["task>goal", "goal>lookout", "lookout>goal"] as const).every((m) => L.ruleFor(m.split(">")[0] as any, m.split(">")[1] as any) === "confirmed"));
check("nothing else moves: no lookout or goal back into tasks, nothing into or out of interests", [["lookout", "task"], ["goal", "task"], ["goal", "interest"], ["task", "interest"], ["interest", "goal"], ["interest", "lookout"]].every(([f, t]) => L.ruleFor(f as any, t as any) === null));
const ability = ABILITIES.find((a) => a.tool === "moveLane");
check("moveLane is in the registry and needs their own yes in this message", !!ability && ability.confirm === "their_yes" && !!ability.limits?.perTurn);
check("what Cue reads about moving lanes has no em dash or exclamation point and no role noun", !!ability && !/[—–!]/.test(`${ability.can} ${ability.use}`) && !/\b(assistant|matchmaker|concierge|coach|secretary)\b/i.test(`${ability.can} ${ability.use}`));

// ---- 2. no yes, no move, no line
{
  const f = fakeStore();
  L.setLaneStoreForTests(f.store);
  console.log = () => {};
  const { tools, state, facts } = make("hmm, maybe, I'm not sure about the jazz thing");
  check("moveLane asks for their yes", Object.keys(tools.moveLane.inputSchema.shape ?? {}).includes("theirYes"));
  const none = await tools.moveLane.execute({ item: "jazz nights in SF", from: "goal", to: "lookout", label: "the jazz nights" }, {});
  const madeUp = await tools.moveLane.execute({ item: "jazz nights in SF", from: "goal", to: "lookout", label: "the jazz nights", theirYes: "yes move it" }, {});
  console.log = quiet;
  check("a quote that isn't in their message moves nothing", none.ok === false && madeUp.ok === false, [none, madeUp]);
  check("…and Cue is told to quote again, not to ask them again", /Quote only the words in their message that say yes/.test(madeUp.error) && !/ask them/i.test(madeUp.error), madeUp);
  check("…without a model read (the fact comes first)", reads.length === 0);
  check("…the store is untouched", f.writes.length === 0 && f.lanes.goal.length === 1 && f.lanes.lookout.length === 1, f.writes);
  check("…and no line waits for the reply, and no move is claimed", state.laneNotes.length === 0 && !moved(facts));
  const direct = await L.moveLane({ userId: "u", from: "goal", to: "lookout", item: "jazz nights in SF", theirYes: "yes", message: "not now", recent: `Cue: ${OFFER}` }, f.store);
  check("the module holds it too: a yes that isn't in their message moves nothing", direct.ok === false && f.writes.length === 0);
  // The quote is theirs, but the read says it isn't a yes to this (review, 2026-10-13): the judge decides, nothing moves.
  verdict = async () => ({ yes: false, why: "they're unsure", read: true });
  for (const [msg, quote] of [["not sure, let me think", "sure"], ["don't do it", "do it"], ["no, don't move it", "move it"]] as const) {
    console.log = () => {};
    const { tools: t2, state: s2 } = make(msg);
    const r = await t2.moveLane.execute({ item: "jazz nights in SF", from: "goal", to: "lookout", label: "the jazz nights", theirYes: quote }, {});
    console.log = quiet;
    check(`the read says "${msg}" isn't a yes, so nothing moves`, r.ok === false && /doesn't read as a yes/.test(r.error) && f.writes.length === 0 && s2.laneNotes.length === 0, r);
  }
  check("…the read sees the offer, their message and the ability", reads.length === 3 && reads[0].recent === `Cue: ${OFFER}` && reads[0].message === "not sure, let me think" && /tasks, lookouts and goals/.test(reads[0].ability), reads[0]);
  // A read that failed, or came back unreadable, is not a yes.
  verdict = async () => { throw new Error("timeout"); };
  {
    console.log = () => {};
    const { tools: t4, state: s4 } = make("yes, move it");
    const r = await t4.moveLane.execute({ item: "jazz nights in SF", from: "goal", to: "lookout", label: "the jazz nights", theirYes: "yes, move it" }, {});
    console.log = quiet;
    check("a judge error moves nothing (fail closed)", r.ok === false && /couldn't be checked/.test(r.error) && !/propose/i.test(r.error) && f.writes.length === 0 && s4.laneNotes.length === 0, r);
  }
  check("an unreadable answer is not a yes", Y.parseYes("stub").yes === false && Y.parseYes("stub").read === false && Y.parseYes('{"yes": "maybe"}').read === false && Y.parseYes('{"yes": true, "why": "said yes"}').yes === true);
  verdict = async () => ({ yes: true, why: "stub yes", read: true });
  {
    console.log = () => {};
    const { tools: t3, state: s3 } = make("yes", { lastCoMessage: "Want me to draft the email to Sequin for you?" });
    const r = await t3.moveLane.execute({ item: "jazz nights in SF", from: "goal", to: "lookout", label: "the jazz nights", theirYes: "yes" }, {});
    console.log = quiet;
    check("a yes to a different offer moves nothing", r.ok === false && /wasn't to this move/.test(r.error) && f.writes.length === 0 && s3.laneNotes.length === 0, r);
    check("…and the refusal is logged", f.logs.some((d) => d.action === "not_offered"));
  }
  L.setLaneStoreForTests(null);
}
check("the quote fact takes whole words", yesIsTheirs("yes please", "Yes please! do it") && yesIsTheirs("go ahead", "no problem, go ahead") && !yesIsTheirs("ok", "booking it") && !yesIsTheirs("no", "I know") && !yesIsTheirs("", "yes"));
check("…and leaves intent to the read: no negation words decide anything in code", yesIsTheirs("Yes", "Yes! Can't wait") && yesIsTheirs("why not", "why not") && yesIsTheirs("yes", "yes, don't wait for me") && !/DECLINES|BARE_NO|NEGATIONS/.test(src("services/theirYes.ts")));
check("the read is one short Haiku call, only from the tool guard", /MODELS\.haiku/.test(src("services/theirYes.ts")) && /confirmYes\(/.test(src("agent/toolGuard.ts")) && !/confirmYes|judgeYes/.test(src("agent/conversationReply.ts")));
check("offersMove reads Cue's question about this move only", L.offersMove(`Cue: ${OFFER}`, "lookout", "jazz nights in SF") && !L.offersMove(`Cue: ${OFFER}`, "goal", "founder runs in the Marina") && !L.offersMove("Cue: I moved the jazz nights to your lookouts.", "lookout", "jazz nights in SF") && L.offersMove("Cue: Should the venue search for the November dinner be one of your goals?", "goal", "find a venue for the November dinner"));
check("…not one from further back than Cue's turn before their previous message", !L.offersMove(`Cue: ${OFFER}\nMember: hmm\nCue: ok\nMember: wait\nCue: sure thing`, "lookout", "jazz nights in SF"));

// ---- the read sees the exchange, not Co's last line: a clarifying question in between, a link last, beats joined
{
  const clarifying = Y.exchangeFromLog(["Co replied: Want me to keep the jazz nights as a lookout instead of a goal?", "User said: What's the difference?", "Co replied: A lookout means I watch and text you when one comes up.", "Co replied: A goal just shapes what I look for.", "User said: ok yes do it"].join("\n"));
  const linkLast = Y.exchangeFromLog(["User said: anything Friday?", "Co replied: Here's the Friday one.", "Co replied: And want me to keep the jazz nights as a lookout instead of a goal?", "Co replied: https://lu.ma/jazz-fri"].join("\n"));
  const intro = Y.exchangeFromLog(["Co replied: Want an intro to Maya?", "User said: Who is she?", "Co replied: She runs the founders dinner at Linden."].join("\n"));
  check("the clarifying flow keeps the offer in view", /Cue: Want me to keep the jazz nights as a lookout/.test(clarifying) && /Member: What's the difference\?/.test(clarifying) && /lookout means I watch .* \/ A goal just shapes/.test(clarifying), clarifying);
  check("…the link-last flow too, the link shown as a link and the beats joined", /Cue: Here's the Friday one\. \/ And want me to keep the jazz nights .* \/ \[link: https:\/\/lu\.ma\/jazz-fri\]$/.test(linkLast), linkLast);
  check("…and the intro offer behind a question back", /Cue: Want an intro to Maya\?\nMember: Who is she\?\nCue: She runs the founders dinner/.test(intro), intro);
  check("offersMove finds the offer in both", L.offersMove(clarifying, "lookout", "jazz nights in SF") && L.offersMove(linkLast, "lookout", "jazz nights in SF"));
  // As production has it: the thread already ends with their current message (fourth review: the offer was lost behind it).
  const linkLastLive = Y.exchangeFromLog(["User said: anything Friday?", "Co replied: Here's the Friday one.", "Co replied: And want me to keep the jazz nights as a lookout instead of a goal?", "Co replied: https://lu.ma/jazz-fri", "User said: yes"].join("\n"));
  check("…and with their current message already at the end of the thread", /Member: ok yes do it$/.test(clarifying) && L.offersMove(clarifying, "lookout", "jazz nights in SF") && L.offersMove(linkLastLive, "lookout", "jazz nights in SF"));
  const memo = Y.turnsFromLog(["Co replied: Sounds fun.", "User sent a voice memo: I'm thinking about jazz", "Co replied: Want me to keep the jazz nights as a lookout instead of a goal?"].join("\n"));
  check("a voice memo reads as theirs, not glued onto Cue's line", memo.length === 3 && memo[1].side === "member" && /thinking about jazz/.test(memo[1].text) && !/thinking about jazz/.test(memo[0].text));
  check("the window is capped", Y.exchangeText(Array.from({ length: 40 }, (_, i) => ({ side: i % 2 ? "member" : "co", text: "x".repeat(300) } as const))).length <= Y.EXCHANGE_LIMITS.chars + 1);
  for (const [name, recent] of [["clarifying", clarifying], ["link last", linkLast]] as const) {
    const f = fakeStore();
    L.setLaneStoreForTests(f.store);
    reads.length = 0;
    console.log = () => {};
    const { tools, state } = make("ok yes, move it", { lastCoMessage: "A goal just shapes what I look for.", recentExchange: recent });
    const r = await tools.moveLane.execute({ item: "jazz nights in SF", from: "goal", to: "lookout", label: "the jazz nights", theirYes: "ok yes, move it" }, {});
    console.log = quiet;
    check(`${name}: the read gets the whole window with the offer in it, and the move goes through`, r.ok === true && reads.length === 1 && reads[0].recent === recent && /keep the jazz nights as a lookout/.test(reads[0].recent) && state.laneNotes.length === 1, { r, reads });
    L.setLaneStoreForTests(null);
  }
  const cr = src("agent/conversationReply.ts");
  check("texts and calls both hand the read the exchange", /recentExchange: exchangeFromLog\(input\.recentConversation\)/.test(cr) && /recentExchange: exchangeText\(msgs\.slice\(0, i\)/.test(src("routes/callLlm.ts")) && /recent: ctx\.recentExchange/.test(src("agent/toolGuard.ts")));
  check("the read asks whether Cue offered this action in the exchange", /did Cue offer THIS action/.test(Y.yesPrompt({ recent: clarifying, message: "ok yes", ability: "x" })) && /If no offer of this action appears in the exchange, no\./.test(Y.yesPrompt({ recent: "", message: "", ability: "" })));
}

// ---- 3. with their yes: it moves, it's logged, and the reply carries the line exactly once
{
  const f = fakeStore();
  L.setLaneStoreForTests(f.store);
  console.log = () => {};
  const msg = "yes, move it";
  const { tools, state, facts } = make(msg);
  const r = await tools.moveLane.execute({ item: "jazz nights in SF", from: "goal", to: "lookout", label: "the jazz nights", theirYes: "yes, move it" }, {});
  const line = "moved the jazz nights from goals to lookouts";
  check("with their yes (the read stubbed to yes) it moves", r.ok === true && r.line === line, r);
  check("…out of goals and into lookouts", f.lanes.goal.length === 0 && f.lanes.lookout.some((i) => i.text === "jazz nights in SF"), f.writes);
  check("…logged as lane.move with their quoted yes", f.logs.length === 1 && f.logs[0].outcome === "act" && f.logs[0].action === "goal>lookout" && f.logs[0].proposal.theirYes === "yes, move it" && f.logs[0].proposal.note === line, f.logs);
  check("…and exactly one line waits for the reply", state.laneNotes.length === 1 && state.laneNotes[0] === line && moved(facts));
  const tap = await tools.reactInsteadOfReplying.execute({ reaction: "🫡" }, {});
  const leave = await tools.leaveItAtReaction.execute({}, {});
  check("a move's line never rides on a tapback: the turn needs words", tap.ok === false && leave.ok === false && !state.reacted);
  await tools.sendReply.execute({ message: "Done, I'll keep watching for those.\n\nAnything else on your mind?" }, {});
  // Another tool ran since the reply: without one, a second text this turn is held whole (agent/conversationTools.ts wrapSendsForOneReply).
  state.workSinceSend = true;
  await tools.sendReply.execute({ message: "Moved the jazz nights from goals to lookouts. Talk soon." }, {});
  console.log = quiet;
  const all = state.sentMessages.join("\n");
  check("the reply carries the line, once, in a text that was going anyway", count(state.sentMessages[0], line) === 1 && /^Done, I'll keep watching for those\. Moved the jazz nights from goals to lookouts\./.test(state.sentMessages[0]), state.sentMessages);
  check("…never a second time this turn, even when Cue writes it again", count(all, line) === 1 && state.sentMessages.length === 2 && /Talk soon/.test(state.sentMessages[1]), state.sentMessages);
  check("…and it's marked said", state.laneNotes.length === 0 && state.laneNotesSent.length === 1);
  check("the line has no em dash or exclamation point", !/[—–!]/.test(line));
  L.setLaneStoreForTests(null);
}

// ---- 4. task to lookout is refused through moveLane, yes or not
{
  const f = fakeStore();
  L.setLaneStoreForTests(f.store);
  console.log = () => {};
  const msg = "yes, make the venue search a lookout";
  const { tools, state } = make(msg);
  const r = await tools.moveLane.execute({ item: "task #12", from: "task", to: "lookout", label: "the venue search", theirYes: msg }, {});
  console.log = quiet;
  check("task to lookout through moveLane is refused even with a yes", r.ok === false && /only on their own words/.test(r.error), r);
  check("…nothing moved and no line waits", f.writes.length === 0 && state.laneNotes.length === 0);
  check("…the refusal is logged", f.logs.some((d) => d.action === "refused_their_words_only"));
  const back = await L.moveLane({ userId: "u", from: "lookout", to: "task", item: "founder runs in the Marina", theirYes: "yes", message: "yes", recent: "Cue: Want me to make the founder runs a task?" }, f.store);
  check("a lookout never goes back into tasks", back.ok === false && f.writes.length === 0);
  const goalToTask = await L.moveLane({ userId: "u", from: "task", to: "goal", item: "task #12", theirYes: "sure", message: "sure, that's really a goal", recent: "Cue: Should the venue for the November dinner be one of your goals instead?" }, f.store);
  check("task to goal works on a yes, by its task number", goalToTask.ok === true && goalToTask.note === "moved find a venue for the November dinner from tasks to goals" && f.lanes.task.length === 0, goalToTask);
  L.setLaneStoreForTests(null);
}

// ---- the line reaches them: a retry carries it, a move after the reply asks for one short reply, a link doesn't block it
{
  const line = "moved the jazz nights from goals to lookouts";
  console.log = () => {};
  const { tools, state } = make("hey, any news?", { laneNotesOwed: [line] });
  await tools.sendReply.execute({ message: "Nothing new yet, still looking." }, {});
  console.log = quiet;
  check("a retry still carries the first try's line", count(state.sentMessages.join("\n"), line) === 1 && state.laneNotes.length === 0, state.sentMessages);
  const cr = src("agent/conversationReply.ts");
  check("…handed over by the retry path", /const laneNotesOwed = \[\.\.\.state\.laneNotes\]/.test(cr) && /runConversationReplyAgent\(\{ \.\.\.input, laneNotesOwed \}/.test(cr) && /laneNotesOwed: input\.laneNotesOwed/.test(cr));
  check("moveLane is a call-first tool", /followUp, moveLane\), call that tool first/.test(cr));
}
{
  const f = fakeStore();
  L.setLaneStoreForTests(f.store);
  console.log = () => {};
  const { tools, state } = make("yes, move it");
  await tools.sendReply.execute({ message: "Sounds good." }, {});
  const r = await tools.moveLane.execute({ item: "jazz nights in SF", from: "goal", to: "lookout", label: "the jazz nights", theirYes: "yes, move it" }, {});
  await tools.sendReply.execute({ message: "Done." }, {});
  console.log = quiet;
  check("a move after the reply went says to send one short reply now", r.ok === true && /already went, so send one short reply now/.test(r.note), r);
  check("…and that reply carries the line", count(state.sentMessages.join("\n"), "moved the jazz nights from goals to lookouts") === 1, state.sentMessages);
  L.setLaneStoreForTests(null);
}
check("a pending line lets one reply through after a link", /if \(!answers && !state\.laneNotes\.length\)/.test(src("agent/conversationTools.ts")));

// ---- the line itself
check("the line is clean: no quotes, dashes or exclamation points", L.laneNote(`the "jazz" nights — Fridays!`, "goal", "lookout") === "moved the jazz nights, Fridays from goals to lookouts");
check("Cue's label is used only when it names the same thing", L.noteLabel("the jazz nights", "jazz nights in SF") === "the jazz nights" && L.noteLabel("your big plan", "jazz nights in SF") === "jazz nights in SF");
{
  const line = "moved the jazz nights from goals to lookouts";
  const twice = L.carryLaneNotes("Moved the jazz nights from goals to lookouts. Done.\n\nmoved the jazz nights from goals to lookouts.", [line]);
  check("a line Cue wrote twice goes out once", count(twice.text, line) === 1 && twice.carried.length === 1, twice);
  const q = L.carryLaneNotes("Want anything else?", [line]);
  check("in a reply that's only a question, the line leads", q.text === "Moved the jazz nights from goals to lookouts. Want anything else?", q);
  check("nothing pending, nothing added", L.carryLaneNotes("Sounds good.", []).text === "Sounds good.");
}

// ---- 5. the kind jobs leave a lookout alone
check("a lookout keeps its kind", L.askKindAfter({ kind: "find", intent: "lookout" }, "help") === null && L.askKindAfter({ kind: "help", intent: "lookout" }, "find") === null);
check("a lookout never read gets find, which is what a lookout is", L.askKindAfter({ kind: null, intent: "lookout" }, "help") === "find");
check("any other ask still gets the kind it's read as", L.askKindAfter({ kind: "find", intent: "question" }, "help") === "help" && L.askKindAfter({ kind: null, intent: null }, "person") === "person");
{
  // A tiny ask_checkins table, enough for classifyOpenAsks' reads and setAskKind's guarded write.
  const rows = [
    { id: 1, ask_text: "keep an eye out for someone to help plan my launch", kind: "find", intent: "lookout", kind_checked_at: null, kind_version: 1, resolved_at: null },
    { id: 2, ask_text: "let me know when a founder dinner comes up", kind: null, intent: "lookout", kind_checked_at: null, kind_version: 1, resolved_at: null },
    { id: 3, ask_text: "plan out the event with me", kind: null, intent: "question", kind_checked_at: null, kind_version: 1, resolved_at: null },
    { id: 4, ask_text: "I'll send the outline tonight", kind: "find", intent: "lookout", kind_checked_at: "x", kind_version: 2, resolved_at: null },
    { id: 5, ask_text: "I'll send the outline tonight", kind: "find", intent: null, kind_checked_at: "x", kind_version: 2, resolved_at: null },
  ];
  const sqls: string[] = [];
  const db = {
    query: async (sql: string, args: any[] = []) => {
      sqls.push(sql);
      if (/^\s*SELECT id, (?:user_id, )?ask_text, kind, intent FROM ask_checkins WHERE resolved_at IS NULL AND \(kind_checked_at IS NULL/.test(sql)) return { rows: rows.filter((r) => !r.resolved_at && (r.kind_checked_at === null || (r.kind === "find" && r.kind_version < args[1]))) };
      if (/^\s*SELECT id, ask_text, kind, intent FROM ask_checkins WHERE resolved_at IS NULL AND kind = 'find' AND intent IS DISTINCT FROM 'lookout'/.test(sql)) return { rows: rows.filter((r) => !r.resolved_at && r.kind === "find" && r.intent !== "lookout") };
      if (/^\s*UPDATE ask_checkins SET kind = COALESCE\(\$2, kind\)/.test(sql)) {
        const [id, next, version, , readKind, readIntent] = args;
        const r = rows.find((x) => x.id === id && x.kind === readKind && x.intent === readIntent);
        if (!r) return { rows: [], rowCount: 0 };
        r.kind = next ?? r.kind; r.kind_checked_at = "now" as any; r.kind_version = version ?? r.kind_version;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
    },
  };
  const asked: string[] = [];
  console.log = () => {};
  await K.classifyOpenAsks(25, { db, classify: async (t) => { asked.push(t); return "help"; } });
  console.log = quiet;
  const by = (id: number) => rows.find((r) => r.id === id)!;
  check("the kind job leaves a lookout's kind alone (and marks it checked, so it isn't read every run)", by(1).kind === "find" && by(1).kind_checked_at !== null, by(1));
  check("…gives a never-read lookout find, without a model call", by(2).kind === "find" && !asked.includes(by(2).ask_text), { row: by(2), asked });
  check("…still classifies everything else", by(3).kind === "help");
  // Royce, 2026-10-13: an already-classified find ask that reads as Co's own work isn't switched off either (status-check lane).
  check("…and never moves a lookout that reads like Cue's own promise to help, nor an already-read ask (the search keeps running)", by(4).kind === "find" && by(5).kind === "find", [by(4), by(5)]);
  check("every kind write is guarded on the row it read", sqls.filter((q) => /UPDATE ask_checkins/.test(q)).every((q) => /intent IS NOT DISTINCT FROM \$6/.test(q)));
}
{
  // goalEdges: a find ask restating a work goal is retired to help, a lookout restating it is not.
  const helped: number[] = [];
  const goal = "partnering with Sequin AI for a November launch party";
  const deps: any = {
    model: async () => JSON.stringify([{ n: 1, kind: "work", edges: [], until: null, superseded_by: null, why: "their own partnership" }]),
    states: async () => new Map(), setState: async () => true, corrections: async () => [], retired: CC.retiredBy,
    findAsks: async () => [{ id: 1, text: goal, intent: "lookout" }, { id: 2, text: goal, intent: null }],
    helpAsk: async (_u: string, id: number) => { helped.push(id); }, log: async () => {},
  };
  await G.planGoalSweep("u1", [goal], { city: "San Francisco", zone: "America/Los_Angeles", now: new Date("2026-10-13T17:00:00Z") }, deps);
  check("the goal sweep retires a find ask from a work goal, never a lookout", helped.length === 1 && helped[0] === 2, helped);
  check("…and its real reader never selects a lookout", /AND intent IS DISTINCT FROM 'lookout'/.test(src("services/goalEdges.ts").slice(src("services/goalEdges.ts").indexOf("findAsks: async")).split("\n")[0]));
}

// ---- 6. a one-off ask never adds a goal or an interest
check("an errand read as a question is one-off", L.isOneOffAsk({ entryKind: "ask", type: "seeking", intent: "question" }));
check("an unread one is not: fail open to the extraction's rule, never into holding", !L.isOneOffAsk({ entryKind: "ask", type: "seeking", intent: null }));
check("a lookout, a goal, or an offer of theirs is not", !L.isOneOffAsk({ entryKind: "ask", type: "seeking", intent: "lookout" }) && !L.isOneOffAsk({ entryKind: "goal", type: "seeking", intent: null }) && !L.isOneOffAsk({ entryKind: "ask", type: "offering", intent: "question" }));
{
  // What members say about themselves beside a one-off ask is theirs: never held (review, 2026-10-13: a word-overlap hold held all 8).
  const selfStatements: [string, string][] = [
    ["research the top seed investors", "raise a pre-seed round"],
    ["find founder dinners", "meet more founders"],
    ["find venues for my launch party", "launch my startup in November"],
    ["find me a running club in the Marina", "get back into running"],
    ["draft an intro email to Sequin AI", "partner with Sequin AI on the November event"],
    ["send me the link to Pitch Protocol", "pitch at demo days this fall"],
    ["find jazz bars open late tonight", "jazz"],
    ["any advice on hiring my first engineer?", "hire a founding engineer"],
  ];
  const held = selfStatements.filter(([ask, g]) => P.heldAsOneOff([g], [], ask).length);
  check("none of 8 self-statements beside a one-off ask is held", held.length === 0, held);
  check("the exact restatement of the one-off ask is held", P.heldAsOneOff(["find venues for the launch party"], [], "Research venues for my launch party").length === 1 && P.heldAsOneOff(["founder dinners"], [], "Find me founder dinners this week").length === 1);
  check("…unless it was already on file", P.heldAsOneOff(["founder dinners"], ["founder dinners in SF"], "Find me founder dinners this week").length === 0);
  check("the rule itself is the extraction's, in its own words", /goals and activity_preferences come only from what they say about themselves or want for themselves, never from the subject of a one-off request/.test(src("services/turnLearning.ts")));
  check("…and an unreadable ask holds nothing", /reading the turn's ask failed \(non-fatal\):", err\?\.message \?\? err\);\s*return null;/.test(src("services/turnLearning.ts")));
  const sp = src("services/profileExtraction.ts");
  const store = sp.slice(sp.indexOf("export async function storeProfile"), sp.indexOf("export async function storeTranscriptMemory"));
  check("storeProfile holds them before the merge, for goals and interests", /heldAsOneOff\(clean\.goals, existing\?\.goals, oneOff\.text\)/.test(store) && /heldAsOneOff\(clean\.activity_preferences, existing\?\.activity_preferences, oneOff\.text\)/.test(store) && store.indexOf("heldAsOneOff(") < store.indexOf("mergeProfileList(existing?.goals"));
  check("…from the turn's own ask read (the intent split), passed in by the text turn", /turnAskLane\(input\.userId, written\)/.test(src("services/turnLearning.ts")) && /turnAsk,/.test(src("services/turnLearning.ts")) && /defaultDeps\(\)\.intent!/.test(src("services/laneMoves.ts")));
}
{
  const task = "find a venue for the November dinner";
  check("a lookout without their watch words never restates one of their tasks", L.lookoutRestatesTask("watch for jazz nights in SF", ["find jazz nights in SF"]) === "find jazz nights in SF" && L.lookoutRestatesTask("founder runs in the Marina", [task]) === null);
  check("…paraphrases included", L.lookoutRestatesTask("keep an eye out for venues for the November dinner", [task]) === task && L.lookoutRestatesTask("watch for November dinner venues", [task]) === task);
  const ct = src("agent/conversationTools.ts");
  check("…held in startTask unless their own message asks to watch; a yes to Cue's watch offer doesn't exempt it; open asks count", /if \(lookout && !\(T\.WATCH_ASK\.test\(ctx\.resolvedContent\) && T\.wordsAreTheirs\(theirWords, ctx\.resolvedContent\)\)\)/.test(ct) && /intent IS DISTINCT FROM 'lookout'/.test(ct.slice(ct.indexOf("if (lookout && !(T.WATCH_ASK"), ct.indexOf("lookoutRestatesTask(goal")) ) && /lookoutRestatesTask\(goal, \[\.\.\.state\.closedTaskGoals, \.\.\.open\]\)/.test(ct));
}
{
  const lm = src("services/laneMoves.ts");
  const leave = lm.slice(lm.indexOf("  leave: async"), lm.indexOf("  log: async"));
  check("a goal moved out leaves co_profiles.goals, its history kept in goal_states", /UPDATE co_profiles SET goals = \$2/.test(leave) && /setGoalState\(userId, item\.text, "stale"/.test(leave));
  check("…and the profile read doesn't put it back", /reason LIKE 'moved to %'/.test(src("services/profileExtraction.ts")) && /!movedOut\.some/.test(src("services/profileExtraction.ts")));
}

// ---- the door: a new member's first request never becomes a lookout without their words (Royce, 2026-10-13: "Stop it, no exception")
{
  const D = await import("../../src/services/theDoor.js");
  const C = await import("../../src/services/commitmentLog.js");
  const p = { taskId: 41, at: "2026-10-14T01:00:00.000Z" };
  const now = new Date("2026-10-13T20:00:00Z");
  const played = D.settleFromJudgment(p, { playedBack: true, promisedFollowUp: false, when: null, latestBy: null }, 0, now);
  const nothing = D.settleFromJudgment(p, { playedBack: false, promisedFollowUp: false, when: null, latestBy: null }, 0, now);
  check("a first read whose text promised nothing withdraws the look (it used to become Cue's own lookout)", played.task.kind === "withdraw" && played.given === true, played);
  check("…and one that said nothing at all withdraws it too", nothing.task.kind === "withdraw", nothing);
  check("…withdrawn on the ledger, never missed: it was never said", C.outcomeOf("dropped", D.FIRST_LOOK_WITHDRAWN, [], { source: "promise" }) === "withdrawn");
  const dr = src("services/theDoor.ts");
  const settle = dr.slice(dr.indexOf("export async function settleFirstRead"));
  check("…closed as dropped with that wording, so nothing searches, paces or sends for it", /if \(d\.task\.kind === "withdraw"\)[\s\S]{0,300}closeTask\(userId, id, "dropped", FIRST_LOOK_WITHDRAWN\)/.test(settle) && !/source\s*=|laneMoves|lookoutFrom/.test(settle), settle.slice(0, 400));
  const promised = D.settleFromJudgment(p, { playedBack: true, promisedFollowUp: true, when: "by 6pm", latestBy: "2026-10-14T01:00:00.000Z" }, 0, now);
  const sooner = D.settleFromJudgment(p, { playedBack: true, promisedFollowUp: true, when: "tonight", latestBy: "2026-10-13T23:00:00.000Z" }, 0, now);
  check("a first read that carried a promise stays Cue's promise (kept, or moved to the time it said)", promised.task.kind === "keep" && sooner.task.kind === "move", [promised, sooner]);
  check("…the look starts as a promise task, never a lookout", /startTask\(\{[^}]*source: "promise" \}\)/.test(dr.slice(dr.indexOf("export async function giveFirstRead"), dr.indexOf("export type FirstLookRow"))));
  // Their own "keep an eye out for X" in that first message: a lookout the same way as any ask, by the intent split from their words.
  const writes: any[][] = [];
  const db = { query: async (_sql: string, args: unknown[] = []) => (writes.push(args), { rows: [], rowCount: 1 }) };
  const A = await import("../../src/services/askLifecycle.js");
  check("their own 'keep an eye out for X' reads as a lookout (the intent split's rule)", A.intentFor({ id: "r1", ask_text: "keep an eye out for founder dinners in SF" }, null) === "lookout" && /keep an eye out/.test(A.intentPrompt([{ n: "A1", ask: "founder dinners", words: ["keep an eye out for founder dinners in SF"] }])));
  check("…and the split's read is written as the ask's intent, once", (await L.settleAskIntent("r1", "lookout", "they said keep an eye out", db)) === true && writes[0][1] === "lookout");
}

// ---- 7. architecture: every lane write has one home
{
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
  const files = walk(root).map((f) => ({ f: path.relative(root, f), c: fs.readFileSync(f, "utf8") }));
  // The SET clause of each UPDATE on a table (up to WHERE or the end of the query string).
  const sets = (c: string, table: string) => [...c.matchAll(new RegExp(`UPDATE\\s+${table}\\s+SET((?:(?!\\bWHERE\\b)[^\`])*)`, "gi"))].map((m) => m[1]);
  const HOME = "services/laneMoves.ts";
  const kindIntent = files.filter(({ f, c }) => f !== HOME && sets(c, "ask_checkins").some((s) => /\b(kind|intent)\s*=/.test(s))).map((x) => x.f);
  check("outside laneMoves.ts nothing writes an ask's kind or intent", kindIntent.length === 0, kindIntent);
  // No exception, the door included (Royce, 2026-10-13): nothing anywhere changes a task's source or marks a task a first-read look.
  const taskSource = files.filter(({ c }) => sets(c, "co_tasks").some((s) => /\bsource\s*=/.test(s))).map((x) => x.f);
  check("nothing anywhere changes a task's source (no task becomes a lookout, the door's first look included)", taskSource.length === 0, taskSource);
  const doorLookWriters = files.filter(({ c }) => /lookoutFrom"?\s*:\s*"first_read"|'\{"lookoutOrigin":"co","lookoutFrom":"first_read"\}'/.test(c)).map((x) => x.f);
  check("nothing writes a first-read lookout any more", doorLookWriters.length === 0, doorLookWriters);
  // Reviewed writers of the goal and interest lists that aren't new lane entries: whatCoKnows.ts corrects or removes an item in place at
  // their yes (a dynamic field name), routes/co.ts is the member editing their own profile (a dynamic SET). Neither matches below.
  // laneMoves.ts only takes a goal moved out at their yes off the list (review, 2026-10-13); it never adds one.
  const ALLOWED = new Set(["services/profileExtraction.ts", "services/laneMoves.ts"]);
  const lists = files.filter(({ f, c }) => !ALLOWED.has(f) && (sets(c, "co_profiles").some((s) => /\b(goals|activity_preferences)\s*=/.test(s)) || [...c.matchAll(/INSERT\s+INTO\s+co_profiles\s*\(([^)]*)\)/gi)].some((m) => /\b(goals|activity_preferences)\b/.test(m[1])))).map((x) => x.f);
  check("only the profile read adds to co_profiles goals or activity_preferences", lists.length === 0, lists);
  check("…and the dynamic writers are still only the reviewed ones", files.filter(({ c }) => /UPDATE co_profiles SET \$\{/.test(c)).map((x) => x.f).sort().join(",") === "routes/co.ts,services/whatCoKnows.ts", files.filter(({ c }) => /UPDATE co_profiles SET \$\{/.test(c)).map((x) => x.f));
  // A new lookout task: only from these, each a new lookout, never a task changing lane.
  const LOOKOUT_STARTERS: Record<string, string> = {
    "agent/conversationTools.ts": "startTask on their own watch words, or Cue's own lookout, which never restates a task (lookoutRestatesTask)",
    "harness/callGrounding.ts": "a lookout Cue promised on a call: new, from the call, not from a task",
    "services/goalOwnership.ts": "a goal's watch piece the member picked (pickGoalItems, their yes)",
    "services/coTasks.ts": "reads a row's source; writes none",
  };
  const starters = files.filter(({ f, c }) => f !== HOME && /\bsource:\s*(?:[^,}\n]*\?\s*)?"lookout"/.test(c)).map((x) => x.f).sort();
  check("new lookout tasks start only where reviewed", starters.join(",") === Object.keys(LOOKOUT_STARTERS).sort().join(","), starters);
  const literal = files.filter(({ f, c }) => f !== HOME && [...c.matchAll(/INSERT\s+INTO\s+co_tasks[^`]*/gi)].some((m) => /'lookout'/.test(m[0]))).map((x) => x.f);
  check("no insert writes a lookout task by hand", literal.length === 0, literal);
  const upserts = files.filter(({ f, c }) => f !== HOME && [...c.matchAll(/INSERT\s+INTO\s+ask_checkins[^`]*/gi)].some((m) => /ON\s+CONFLICT[^`]*DO\s+UPDATE\s+SET[^`]*\b(kind|intent)\s*=/i.test(m[0]))).map((x) => x.f);
  check("no upsert rewrites an ask's kind or intent", upserts.length === 0, upserts);
  // Every writer of co_profiles.intent (asks and goal entries), each with its reason. A new one has to be added here, on purpose.
  const INTENT_WRITERS: Record<string, string> = {
    "services/profileExtraction.ts": "captures a new ask or goal from their own words",
    "services/laneMoves.ts": "a confirmed move: a goal or lookout entry in, a goal entry marked moved",
    "services/askKind.ts": "closes an ask's entry (markIntentResolved)",
    "services/askSharing.ts": "their yes or no to sharing an ask in intros",
    "services/goalJourney.ts": "a goal closed at their word; check-in clocks",
    "services/whatCoKnows.ts": "corrects or removes an entry at their yes",
    "scripts/reclassifyEntries.ts": "hand-run, dev tunnel only, applies an approved list",
    "scripts/resolveActiveAsk.ts": "hand-run test tool",
    "scripts/setStatedAsk.ts": "hand-run test tool",
    "scripts/settleTextlessIntent.ts": "hand-run cleanup of entries with no ask text",
  };
  const intentWriters = files.filter(({ c }) => sets(c, "co_profiles").some((x) => /\bintent\s*=/.test(x)) || [...c.matchAll(/INSERT\s+INTO\s+co_profiles\s*\(([^)]*)\)/gi)].some((m) => /\bintent\b/.test(m[1]))).map((x) => x.f).sort();
  check("co_profiles.intent is written only by the reviewed writers", intentWriters.join(",") === Object.keys(INTENT_WRITERS).sort().join(","), intentWriters);
  // Every change to a goal's state, each with its reason.
  const GOAL_STATE_WRITERS: Record<string, string> = {
    "services/goalEdges.ts": "the store itself, and the sweep's set-asides from context (told in the next reply)",
    "agent/loopTools.ts": "markGoal: done, stale or active again, from what they said",
    "services/goalJourney.ts": "a goal closed at their word",
    "services/laneMoves.ts": "a confirmed move out of, or back into, goals",
    "services/whatCoKnows.ts": "a corrected or removed goal drops its state at their yes",
    "services/goalRecheck.ts": "the stale-goal recheck (#193): idle after one unanswered question, back to active on their mention",
    "services/askRetire.ts": "pick it back up: a goal the recheck idled, back to active at their word after its stopped-looking note",
  };
  const stateWriters = files.filter(({ c }) => /INSERT\s+INTO\s+goal_states|DELETE\s+FROM\s+goal_states|setGoalState\(/.test(c) || sets(c, "goal_states").some((x) => /\bstate\s*=/.test(x))).map((x) => x.f).sort();
  check("goal states change only through the reviewed writers", stateWriters.join(",") === Object.keys(GOAL_STATE_WRITERS).sort().join(","), stateWriters);
  check("the intent split writes through laneMoves.ts", /settleAskIntent\(String\(x\.row\.id\), intent, why\)/.test(src("services/askLifecycle.ts")));
  check("the door no longer paces a first look as Cue's own lookout", !/paceDoorLook|co_initiated/.test(src("services/theDoor.ts")) && !/paceDoorLook/.test(src("services/laneMoves.ts")));
}

console.log(`lane moves: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
