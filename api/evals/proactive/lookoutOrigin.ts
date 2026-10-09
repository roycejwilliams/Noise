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
  check("a look-out Co opens from its own call promise is recorded as Co's", CG.promiseThreadTask({ what: "founder runs", quotes: ["I'll keep an ear out for founder runs"] }, "").lookoutOrigin === "co");
  check("the reply loop's startTask records a look-out they asked for as theirs", /lookout \? \{ source: "lookout" as const, lookoutOrigin: "member" as const \}/.test(src("agent/conversationTools.ts")));
  check("the origin is kept in the task's followup JSON", JSON.parse(CT.followupJson({ source: "lookout", lookoutOrigin: "member" })!).lookoutOrigin === "member");
  check("a look-out with no origin given is recorded as Co's", JSON.parse(CT.followupJson({ source: "lookout" })!).lookoutOrigin === "co");
  check("a non-look-out records no origin", CT.followupJson({ source: "ask" }) === null);
  check("the window and the origin sit together", (() => { const f = JSON.parse(CT.followupJson({ source: "lookout", lookoutOrigin: "co", window: { words: "by tonight" } as any })!); return f.lookoutOrigin === "co" && f.window?.words === "by tonight"; })());
  check("read back from the row", CT.lookoutOriginOf("lookout", { lookoutOrigin: "member" }) === "member" && CT.lookoutOriginOf("lookout", { lookoutOrigin: "co" }) === "co");
  check("a look-out opened before origins reads as Co's (the only look-outs then were Co's promises)", CT.lookoutOriginOf("lookout", null) === "co");
  check("a task that isn't a look-out has no origin", CT.lookoutOriginOf("ask", { lookoutOrigin: "member" }) === null);
}

// 1/2. What each counts as.
{
  check("a Co-initiated look-out's text is a find", TT.lookoutKind({ source: "lookout", lookoutOrigin: "co" }) === "find");
  check("a member-requested look-out's text has no kind (never counted)", TT.lookoutKind({ source: "lookout", lookoutOrigin: "member" }) === null);
  check("other task updates have no kind", TT.lookoutKind({ source: "ask", lookoutOrigin: null }) === null);
  const tt = src("services/taskTurn.ts");
  check("a member-requested look-out is owed every time", /task\.lookoutOrigin === "member"/.test(tt) && /const owed = task\.source === "promise" \|\| task\.lookoutOrigin === "member" \|\|/.test(tt));
  check("the send path reads the recorded origin (lookoutKind), never a guess", /const coInitiated = o\?\.owed \? undefined : \{ kind: lookoutKind\(task\) \}/.test(tt));
  check("the ledger row carries the kind, so restraint counts it", /VALUES \(\$1, \$2, \$3, \$3, \$4, true, \$5\)/.test(src("harness/proactive.ts")) && /opts\.coInitiated\?\.kind \?\? null/.test(src("harness/proactive.ts")));
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

console.log(`look-out origin: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
