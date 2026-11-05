// Look-outs, split by origin (Royce, 2026-10-09). Zero tokens: the model is scripted.
//   1. member-requested look-outs ("let me know when...", "keep an eye out for X") are deliveries: never counted toward backoff
//   2. Co-initiated look-outs (from Co's own promise) are finds: counted and held exactly like sweep finds
//   3. the origin is recorded when the look-out opens, never inferred at send time
//   npx tsx evals/proactive/lookoutOrigin.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";

type Answer = { tool: string; input: any } | { text: string };
const script: Answer[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const a = script.shift() ?? { text: "Nothing more." };
  const content = "tool" in a ? [{ type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name: a.tool, input: a.input }] : [{ type: "text", text: a.text }];
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "scripted", content, stop_reason: "tool" in a ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

import fs from "node:fs";
const CT = await import("../../src/services/coTasks.js");
const TT = await import("../../src/services/taskTurn.js");
const P = await import("../../src/harness/proactive.js");
const KR = await import("../../src/services/kindRestraint.js");
const CG = await import("../../src/harness/callGrounding.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// 3. Recorded at open.
{
  check("a look-out Cue opens from its own call promise is recorded as Cue's", CG.promiseThreadTask({ what: "founder runs", quotes: ["I'll keep an ear out for founder runs"] }, "").lookoutOrigin === "co");
  check("the reply loop's startTask records the origin it reads from their message", /const origin = lookout \? T\.lookoutOriginAt\(\{ message: ctx\.resolvedContent, quote: theirWords, lastCoMessage: ctx\.lastCoMessage, offerLogged \}\) : null;/.test(src("agent/conversationTools.ts")));
  // Review of #131: theirs only when they asked to be told over time, now.
  const at = (message: string, quote: string, lastCoMessage: string | null = null, offerLogged = true) => CT.lookoutOriginAt({ message, quote, lastCoMessage, offerLogged });
  check("\"let me know when the Lisbon run club posts dates\" is theirs", at("let me know when the Lisbon run club posts dates", "let me know when the Lisbon run club posts dates") === "member");
  check("\"keep an eye out for pottery classes in the Mission\" is theirs", at("can you keep an eye out for pottery classes in the Mission?", "keep an eye out for pottery classes") === "member");
  check("a wish, not a request to watch (\"been wanting to try pottery\"), is Cue's", at("I've been wanting to try pottery", "been wanting to try pottery") === "co");
  check("a watch ask from an older message, quoted now, is Cue's (asked now or not at all)", at("cool thanks", "let me know when the Lisbon run club posts dates") === "co");
  check("\"yes\" to Cue's \"want me to keep an eye out for...?\" is theirs", at("yes", "yes", "Want me to keep an eye out for founder runs this month?") === "member");
  check("\"sure\" to Cue's \"should I let you know when it opens?\" is theirs", at("sure", "sure", "Should I let you know when the waitlist opens?") === "member");
  check("\"yes\" to an offer that isn't about watching is Cue's", at("yes", "yes", "Want me to send you the menu?") === "co");
  check("\"yes\" to a statement (no question) is Cue's", at("yes", "yes", "I'll keep an eye out for founder runs.") === "co");
  check("a short yes to a watching offer passes the reply loop's own yes check", CT.isYesToOffer("yeah", "Want me to keep an eye out for founder runs?"));
  // Re-review of #131: Co pays to open the door, in code.
  check("a yes to a watching offer that was never logged as a find (a proactive or task text) opens Cue's look-out", at("yeah", "yeah", "Want me to let you know when more dates open up?", false) === "co");
  check("\"tell me if this sounds crazy...\" isn't a watch ask", at("Tell me if this sounds crazy, I want to host a supper club", "Tell me if this sounds crazy") === "co");
  check("the reply loop looks the offer up on the ledger before calling it theirs", /const offerLogged = offer \? await import\("\.\.\/harness\/proactive\.js"\)\.then\(\(P\) => P\.replyWatchOfferLogged\(ctx\.userId, String\(ctx\.lastCoMessage \?\? ""\)\)\)/.test(src("agent/conversationTools.ts")));
  check("the logged offer matches Cue's last line however its beats were split", P.watchOfferMatches("Want me to keep an eye out for founder runs this month?", "Nice one. Want me to keep an eye out for founder runs this month?") && !P.watchOfferMatches("Want me to keep an eye out for founder runs?", "Want me to send the menu?"));
  check("the origin is kept in the task's followup JSON", JSON.parse(CT.followupJson({ source: "lookout", lookoutOrigin: "member" })!).lookoutOrigin === "member");
  check("a look-out with no origin given is recorded as Cue's", JSON.parse(CT.followupJson({ source: "lookout" })!).lookoutOrigin === "co");
  check("a non-look-out records no origin", CT.followupJson({ source: "ask" }) === null);
  check("the window and the origin sit together", (() => { const f = JSON.parse(CT.followupJson({ source: "lookout", lookoutOrigin: "co", window: { words: "by tonight" } as any })!); return f.lookoutOrigin === "co" && f.window?.words === "by tonight"; })());
  check("read back from the row", CT.lookoutOriginOf("lookout", { lookoutOrigin: "member" }) === "member" && CT.lookoutOriginOf("lookout", { lookoutOrigin: "co" }) === "co");
  check("a look-out opened before origins reads as Cue's (the only look-outs then were Cue's promises)", CT.lookoutOriginOf("lookout", null) === "co");
  check("a task that isn't a look-out has no origin", CT.lookoutOriginOf("ask", { lookoutOrigin: "member" }) === null);
}

// Review of #131: what the task and the reply read about it follows its origin.
{
  const MK = await import("../../src/services/memberKnowledge.js");
  const task = (lookoutOrigin: "member" | "co", goal: string, theirWords: string) => ({ id: 9, userId: "u", goal, theirWords, steps: [], planNext: null, status: "open", wakes: 1, textsSent: 0, createdAt: "2026-10-09T00:00:00Z", deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, kind: "work", window: null, notes: [], lastTextedAt: null, theirReplyAt: null, nextCheckAt: null, source: "lookout", lookoutOrigin }) as any;
  const mine = TT.taskTurnPrompt({ task: task("member", "Lisbon run club dates", "let me know when the Lisbon run club posts dates"), firstName: "Jordan", now: "Fri Oct 9, 1pm", zone: null, recent: "" });
  check("a member look-out's turn says they asked and are waiting, never a call promise", /because they asked you to/.test(mine) && /They're waiting to hear/.test(mine) && !/as you told them on a call/.test(mine) && !/Nobody is waiting/.test(mine));
  const cos = TT.taskTurnPrompt({ task: task("co", "Keep an eye out, as promised on a call: founder runs", "(said on a call)"), firstName: "Jordan", now: "Fri Oct 9, 1pm", zone: null, recent: "" });
  check("a Cue look-out's turn is still Cue's promise from a call", /as you told them on a call you would/.test(cos));
  const carry = (t: any) => MK.carryingOf({ tasks: [t], briefs: [], receipts: [], ledger: [], loops: [], promises: [], now: new Date("2026-10-09T20:00:00Z"), zone: null });
  check("a member look-out carries as their task, not \"your promise on a call\"", carry(task("member", "Lisbon run club dates", "let me know when")).every((c: any) => c.kind === "task"), carry(task("member", "x y z", "let me know when")));
  check("a Cue look-out still carries as Cue's look-out", carry(task("co", "Keep an eye out, as promised on a call: founder runs", "(said on a call)")).some((c: any) => c.kind === "lookout"));
}

// 1/2. What each counts as.
{
  check("a Co-initiated look-out's text is a find", TT.lookoutKind({ source: "lookout", lookoutOrigin: "co" }) === "find");
  check("a member-requested look-out's text has no kind (never counted)", TT.lookoutKind({ source: "lookout", lookoutOrigin: "member" }) === null);
  check("other task updates have no kind", TT.lookoutKind({ source: "ask", lookoutOrigin: null }) === null);
  const tt = src("services/taskTurn.ts");
  check("a member-requested look-out is owed every time", /task\.lookoutOrigin === "member"/.test(tt) && /const owed = task\.source === "promise" \|\| task\.lookoutOrigin === "member" \|\|/.test(tt));
  check("the send path reads the recorded origin (lookoutKind), never a guess", /const coInitiated = o\?\.owed \? undefined : \{ kind: lookoutKind\(task\) \}/.test(tt));
  check("the ledger row carries the kind, so restraint counts it", /VALUES \(\$1, \$2, \$3, \$3, \$4, true, \$5(, \$6)?\)/.test(src("harness/proactive.ts")) && /opts\.coInitiated\?\.kind \?\? null/.test(src("harness/proactive.ts")));
}

// A Co-initiated look-out find counts toward the two-ignored suppression, the same as sweep finds.
{
  const now = new Date("2026-10-20T18:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const lookoutSends = [
    { id: "1", kind: "find" as const, sentAt: ago(100), message: "Saw a founder run Saturday at the Marina" },
    { id: "2", kind: "find" as const, sentAt: ago(50), message: "Another founder run, Sunday at Crissy Field" },
  ];
  const ignored = KR.evaluateKindRestraint({ sends: lookoutSends, inbound: [], now });
  check("two ignored Co-initiated look-out finds in a row suppress finds", KR.suppressedKinds(ignored).includes("find"), [...ignored.entries()]);
  const mixed = KR.evaluateKindRestraint({ sends: [lookoutSends[0], { id: "3", kind: "find" as const, sentAt: ago(70), message: "Pitch night Tuesday" }], inbound: [], now });
  check("a look-out find and a sweep find ignored in a row count together", KR.suppressedKinds(mixed).includes("find"));
  const replied = KR.evaluateKindRestraint({ sends: lookoutSends, inbound: [{ at: ago(10), text: "oh nice, which one is closer?" }], now });
  check("a reply re-enables", !KR.suppressedKinds(replied).includes("find"), [...replied.entries()]);
}

// Replayed turns: finds are suppressed for this member; one look-out of each origin has a find to send.
{
  const NOW = new Date("2026-10-20T18:00:00Z");
  const RUN = { name: "Builders who Run, Golden Gate Bridge 4M", url: "https://lu.ma/2i3qsijp", tier: 2, facts: ["date: 2026-10-24", "starts 2026-10-24 09:00", "Golden Gate Bridge"] };
  // The real gate, as sendExempt applies it: owed goes; Co-initiated waits on coInitiatedChecks with their suppressed kinds.
  const gate = (task: any, log: any) => async (m: string[], o?: { owed: boolean }) => {
    if (o?.owed) { log.sent.push(m); return { sent: true }; }
    const failed = P.coInitiatedChecks({ now: NOW, timezone: "America/Los_Angeles", optedOut: false, sends: [], lastInboundAt: NOW, suppressedKinds: ["find"] }, TT.lookoutKind(task)).filter((c) => !c.pass);
    if (failed.length) { log.held.push(failed.map((c) => c.name)); return { sent: false, reason: `held: ${failed.map((c) => c.reason).join("; ")}`, retryAt: P.coInitiatedRetryAt({ now: NOW, sends: [] }, failed.map((c) => c.name)) }; }
    log.sent.push(m); return { sent: true };
  };
  const base: any = { id: 300, userId: "u", steps: [{ text: "Watch for it", done: false }], planNext: "Look", status: "open", wakes: 1, textsSent: 0, createdAt: "2026-10-18T03:00:00Z", deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, kind: "work", window: null, notes: [], lastTextedAt: null, theirReplyAt: null, source: "lookout" };
  const deps = (task: any, log: any) => ({
    person: { first_name: "Jordan", phone_number: "+14155550100", city: "San Francisco" }, recent: "", zone: "America/Los_Angeles",
    note: async () => {}, schedule: async () => null, scheduleAt: async () => null, close: async () => {}, textsToday: async () => 0, markTexted: async () => {}, markFinalTold: async () => {}, unspendWake: async () => {},
    send: gate(task, log), search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "" }), readPage: async () => ({ ok: true, facts: [], text: "" }),
    now: () => NOW, sentSince: async () => [], onFile: async () => [RUN], rejected: async () => [],
  });
  const turn = async (task: any) => {
    const log = { sent: [] as string[][], held: [] as string[][] };
    script.push(
      { tool: "tellThem", input: { what: "A founder run this Saturday", links: [RUN.url] } },
      { text: JSON.stringify({ captions: [{ n: 1, caption: "A founder run across the Golden Gate Bridge, Saturday 9am." }], closing: null }) },
      { tool: "scheduleNext", input: { inHours: 48, plan: "keep watching" } },
    );
    await TT.runTaskTurnWith(task, deps(task, log) as any);
    script.length = 0;
    return log;
  };
  const member = await turn({ ...base, goal: "Let them know when a founder run comes up", theirWords: "let me know when there's a founder run", lookoutOrigin: "member" });
  check("a member-requested look-out find sends even while finds are suppressed", member.sent.length === 1 && member.held.length === 0, member);
  const co = await turn({ ...base, id: 301, goal: "Keep an eye out, as promised on a call: founder runs", theirWords: "(said on a call)", lookoutOrigin: "co" });
  check("a Co-initiated look-out find is held while finds are suppressed", co.sent.length === 0 && co.held.some((h) => h.includes("kind_restraint")), co);
  // And the other direction: what suppressed Co's look-out didn't touch theirs (same member, same suppression, same turn order).
  const memberAgain = await turn({ ...base, id: 302, goal: "Let them know when a founder run comes up", theirWords: "let me know when there's a founder run", lookoutOrigin: "member" });
  check("suppression of Co-initiated look-outs never touches member-requested ones", memberAgain.sent.length === 1 && memberAgain.held.length === 0, memberAgain);
}

// (a) A watching offer Co makes inside a reply is logged as a Co-initiated find (Royce, 2026-10-09, option 1).
{
  check("the offer is found in what Cue sent", CT.watchOfferIn("Nice. Want me to keep an eye out for founder runs this month?") === "Want me to keep an eye out for founder runs this month?");
  check("\"should I let you know when the waitlist opens?\" is an offer", CT.watchOfferIn("Should I let you know when the waitlist opens?") !== null);
  check("a statement isn't an offer (no question)", CT.watchOfferIn("I'll keep an eye out for founder runs.") === null);
  check("a question that doesn't offer to watch isn't one", CT.watchOfferIn("Want me to send the menu?") === null);
  check("a question about someone else isn't Cue's offer (\"Did Maya let you know when it starts?\")", CT.watchOfferIn("Did Maya let you know when the party starts?") === null && !CT.isYesToWatchOffer("yes", "Did Maya let you know when the party starts?"));
  check("the reply logs it after it went, never gates it", /const offer = \(await import\("\.\.\/services\/coTasks\.js"\)\)\.watchOfferIn\(state\.sentMessages\.join\("\\n"\)\);[\s\S]{0,200}recordReplyWatchOffer\(input\.userId, offer\)/.test(src("agent/conversationReply.ts")) && /if \(state\.sent && !opts\.dryRun && opts\.record !== false\) \{\s*const offer/.test(src("agent/conversationReply.ts")));
  check("it goes on the ledger as a find (exempt, so it never takes a cap)", /VALUES \(\$1, \$2, \$3, \$3, \$4, true, 'find', \$5(, 'reply')?\)/.test(src("harness/proactive.ts")) && P.REPLY_WATCH_OFFER_TYPE === "watch_offer");
  const now = new Date("2026-10-20T18:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const v = KR.evaluateKindRestraint({ sends: [{ id: "o1", kind: "find", sentAt: ago(120), message: "Want me to keep an eye out for founder runs?" }, { id: "s1", kind: "find", sentAt: ago(60), message: "A pitch night Tuesday" }], inbound: [], now });
  check("an offer they let pass counts toward the two-ignored suppression with sweep finds", KR.suppressedKinds(v).includes("find"));
  check("restraint reads the ledger's kind, so the offer row counts", /ps\.kind/.test(src("services/kindRestraint.ts")));
}

// (b) A yes/yeah to Co's watching offer opens a member look-out that delivers exempt.
{
  for (const yes of ["yes", "yeah", "yep", "sure", "yes please"]) {
    check(`"${yes}" to "want me to keep an eye out?" passes the reply loop's yes check`, CT.isYesToOffer(yes, "Want me to keep an eye out for founder runs?"));
    check(`"${yes}" to a logged offer opens it as theirs`, CT.lookoutOriginAt({ message: yes, quote: yes, lastCoMessage: "Want me to keep an eye out for founder runs?", offerLogged: true }) === "member");
  }
}

// (d) Explicit watch language routes to a look-out, not saveAsk.
{
  const CAP = src("services/capabilities.ts");
  const start = CAP.slice(CAP.indexOf('tool: "startTask"'), CAP.indexOf('id: "task_update"'));
  const save = CAP.slice(CAP.indexOf('tool: "saveAsk"'), CAP.indexOf('id: "reactions"'));
  check("startTask's guidance: explicit watch language is a look-out (lookout: true), never saveAsk", /Explicit watch language[\s\S]{0,200}startTask with lookout: true, never saveAsk/.test(start));
  check("saveAsk's guidance: vaguer interest stays here; explicit watch language goes to the look-out", /vaguer interest/.test(save) && /startTask with lookout: true, not saveAsk/.test(save) && !/or they want Cue to keep an eye out\./.test(save));
}

console.log(`look-out origin: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
