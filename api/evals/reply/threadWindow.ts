// The reply keeps the whole thread (2026-11-02, a founder's thread on dev, replayed here with invented names and paraphrased texts):
//   1. the window counts their texts, not rows: one long answer of Cue's in bubbles no longer pushes out what they said three texts ago,
//      so news and feedback they already gave reach the reply (it asked for the feedback again when it didn't);
//   2. replaying the thread turn by turn, nothing they say later reaches an earlier turn's prompt;
//   3. a text of theirs in paragraphs is their words in full, so a claim quoting its second paragraph isn't cut as unsupported;
//   4. asked "what's going on with him", Cue's answer from their own news is never cut as a report on their thread (it was cut three
//      turns running, leaving a fragment each time, and the corrections never reached them); a status they never gave still is.
// Layer 1: zero tokens, no database. The model is a fake fetch answering by what each request is for; where a real reply matters, the
// fake gives the reply Cue actually sent before this change, so the checks are about what code feeds and keeps, never about wording.
//   npx tsx evals/reply/threadWindow.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";

// ---- the fake model
let threadReports: number[] = [];
let claims: unknown[] = [];
let replyText = "";
const systems: string[] = [];
const kinds: string[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const raw = String(init?.body ?? "");
  let body: any = {};
  try { body = JSON.parse(raw); } catch {}
  const sys = Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? "").join("\n") : String(body.system ?? "");
  let text = "{}";
  if (/Only the member knows where it stands/.test(raw)) (kinds.push("thread_read"), (text = JSON.stringify({ reports: threadReports })));
  else if (/You check a text message Cue is about to send/.test(raw)) (kinds.push("claims"), (text = JSON.stringify({ claims })));
  else if (/You are replying by iMessage/.test(sys + raw)) (kinds.push("reply"), systems.push(sys + raw), (text = replyText));
  else kinds.push("other");
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const W = await import("../../src/services/threadWindow.js");
const G = await import("../../src/harness/replyGrounding.js");
const M = await import("../../src/services/memberWorld.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) {
    failed++;
    process.stdout.write(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}\n`);
  }
};
const quietLog = console.log;
const quietErr = console.error;
const hush = () => { console.log = () => {}; console.error = () => {}; };
const loud = () => { console.log = quietLog; console.error = quietErr; };

// ---- the thread: an invented member (Jordan) and the person they met (Theo). Paraphrased; one row per text or bubble, as logged.
type Row = { content: string; created_at: Date };
let clock = Date.parse("2026-11-02T16:28:00Z");
const log: Row[] = [];
const them = (t: string) => log.push({ content: `User said: ${t}`, created_at: new Date((clock += 20_000)) });
const cue = (...bubbles: string[]) => bubbles.forEach((b) => log.push({ content: `Co replied: ${b}`, created_at: new Date((clock += 2_000)) }));
const FIRST = "Coffee with Theo went well. We might co-host a small night to see if the matching holds up, that's what he cares about first. He's curious about my repo but I'm not sure yet.\n\nThinking about an NDA before anything.\n\nHe had two notes:\n1) the voice replies feel slow\n2) the intro call feels a lot like a rival app's";
them(FIRST);
cue("Him wanting to see the matching first is a good sign.", "Hesitating on the repo is fair.", "Both notes land somewhere real. I've passed both to the team.", "Does the repo ask feel early to you?");
them("Let's talk about Theo for a sec");
cue("Sure, what's on your mind with him?");
them("What should I do? Give me the steps");
cue("Settle roles and equity before he sees code.", "Ask what he needs to see to believe the matching works.", "If he still wants the code, scope the agreement to what he'd see.", "Bring your cofounder in before anything moves.", "Test the matching together at the night you're planning.", "Which part feels least settled?");
them("I told him matching already works with groups. How do I work with other engineers without giving away my IP?");
cue("The split is between showing what it does and handing over what it's made of.", "Bring engineers in on scoped, paid work first.", "Keep the matching core in its own module they never see.", "A real cofounder is an equity conversation first.", "For Theo, a walkthrough may be enough.", "Which way is this pointing?");
const TRIAL = them("I set him up with a trial login so he can poke at it himself") - 1;
cue("Smart move.", "Has he said anything about it yet?");
them("I already sent you his notes");
cue("You're right. The slow voice and the intro call, that's what he sent.");
const SUMMARY = them("ok sum up my issue") - 1;
cue("Matching works and that's your leverage; settle structure before code access.");
const CORRECTION = them("No, I mean the problem with Theo") - 1;
cue("That's the part worth slowing down on.");
// Later in the thread they add two things Cue must not know before they say them.
const COFOUNDER = them("Also I'm weighing Theo as a possible cofounder") - 1;
cue("That changes the repo question.");
const RELEASE = them("And the IP release from my old employer back to me still isn't signed") - 1;
cue("Then that comes before any agreement with him.");
const LATER_FACTS = [/possible cofounder/, /IP release from my old employer/];

// What the database holds at the moment a turn's text arrives: every row up to and including it, newest first (the query's order).
const asOf = (i: number) => log.slice(0, i + 1).reverse();
const text = (rows: Row[]) => rows.map((r) => r.content).join("\n");
const oldWindow = (i: number) => asOf(i).slice(0, 20).reverse();

// ------------------------------------------------------------------ 1. the window counts their texts
{
  const before = text(oldWindow(TRIAL));
  const after = text(W.threadWindow(asOf(TRIAL)));
  check("before: at the trial-login turn the 20-row window had already lost their first text (the two notes)", !before.includes("the voice replies feel slow") && log.slice(0, TRIAL + 1).length > 20, log.slice(0, TRIAL + 1).length);
  check("after: their first text, notes and all, is in the window", after.includes("the voice replies feel slow") && after.includes("Thinking about an NDA before anything."));
  check("the window ends on their latest text and runs oldest first", after.endsWith("User said: I set him up with a trial login so he can poke at it himself") && after.indexOf("Coffee with Theo") < after.indexOf("trial login"));
  const many: Row[] = Array.from({ length: 30 }, (_, i) => ({ content: i % 2 ? `Co replied: line ${i}` : `User said: text ${i}`, created_at: new Date(i * 1000) }));
  const w = W.threadWindow([...many].reverse());
  check(`at most ${W.WINDOW_THEIR_TEXTS} of their texts, plus the line of Cue's the oldest one answered`, w.filter((r) => r.content.startsWith("User said:")).length === W.WINDOW_THEIR_TEXTS && w[0].content === "Co replied: line 9" && w[w.length - 1].content === "Co replied: line 29", w.map((r) => r.content));
  const bubbles: Row[] = [{ content: "User said: hi", created_at: new Date(0) }, ...Array.from({ length: 90 }, (_, i) => ({ content: `Co replied: bubble ${i}`, created_at: new Date(i + 1) }))];
  check(`never more than ${W.WINDOW_MAX_ROWS} rows`, W.threadWindow([...bubbles].reverse()).length === W.WINDOW_MAX_ROWS);
  check("a short thread is all of it", W.threadWindow(asOf(2)).length === 3 && W.threadWindow([]).length === 0);
  const route = (await import("node:fs")).readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  check("the reply's window is this one: the query reads up to the row cap and threadWindow cuts it", /ORDER BY created_at DESC\s+LIMIT \$2`,\s+\[user\.id, WINDOW_MAX_ROWS\],/.test(route) && /const chronological = threadWindow\(chronologicalResult\.rows\);/.test(route) && !/LIMIT 20`,\s+\[user\.id\],\s+\);\s+\/\/ Through the live guards/.test(route));
}

// ------------------------------------------------------------------ 2. answered feedback reaches the reply
// The reply the fake model gives is the one Cue sent before: it asked for the feedback again. What code controls is whether the notes
// were in front of it; with them, the sharing guide's "use what they've already told you rather than asking again" has something to
// use. The reply's own behavior is unverified until a paid run.
const facts = () => G.createReplyFacts();
const replyInput = (message: string, recentConversation: string) => ({
  userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan", resolvedContent: message, isVoice: false, imageForVision: null,
  hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null,
  facts: facts(), toneContext: "", seekingModeContext: "", styleHint: "", recentConversation, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true,
}) as any;
const promptFor = async (i: number, window: Row[]) => {
  systems.length = 0;
  replyText = "Smart move.\n\nHas he said anything about it yet?";
  claims = [];
  threadReports = [];
  hush();
  try {
    await runConversationReplyAgent(replyInput(log[i].content.replace(/^User said: /, ""), text(window)), { dryRun: true, record: false });
  } finally {
    loud();
  }
  return systems.join("\n");
};
{
  const before = await promptFor(TRIAL, oldWindow(TRIAL));
  const after = await promptFor(TRIAL, W.threadWindow(asOf(TRIAL)));
  check("the reply ran on the fake model", systems.length > 0);
  check("before: the reply prompt had no trace of the notes they'd already given", !/voice replies feel slow/.test(before) && !/rival app/.test(before));
  check("after: the notes they already gave are in the reply prompt, in their words", /the voice replies feel slow/.test(after) && /the intro call feels a lot like a rival app's/.test(after));
  check("after: so is what Cue said back (that both went to the team)", /I've passed both to the team\./.test(after));
}

// ------------------------------------------------------------------ 3. replayed turn by turn, nothing later leaks into an earlier turn
{
  const leaks: string[] = [];
  const present: string[] = [];
  for (let i = 0; i < log.length; i++) {
    if (!log[i].content.startsWith("User said:")) continue;
    const window = text(W.threadWindow(asOf(i)));
    LATER_FACTS.forEach((re, k) => {
      const givenAt = k === 0 ? COFOUNDER : RELEASE;
      if (i < givenAt && re.test(window)) leaks.push(`turn ${i}: ${re}`);
      if (i >= givenAt && !re.test(window)) present.push(`turn ${i}: ${re} missing`);
    });
  }
  check("no turn's window carries what they only said later (a possible cofounder, an unsigned IP release)", leaks.length === 0, leaks);
  check("from the turn they say it, it's there", present.length === 0, present);
  const summaryPrompt = await promptFor(SUMMARY, W.threadWindow(asOf(SUMMARY)));
  check("the summary turn's reply prompt has neither later fact", LATER_FACTS.every((re) => !re.test(summaryPrompt)));
  const releasePrompt = await promptFor(RELEASE, W.threadWindow(asOf(RELEASE)));
  check("the turn they give the second one has both", LATER_FACTS.every((re) => re.test(releasePrompt)));
  const world = M.buildMemberWorld({ now: log[SUMMARY].created_at, zone: "America/Los_Angeles", keep: (s: string) => s, tasks: [], briefs: [], searching: { asks: [], goals: [], held: [] }, ahead: null, offeredGoals: [], docOffer: null, threads: [], exchange: asOf(SUMMARY).reverse().map((r) => ({ at: r.created_at, from: r.content.startsWith("User said:") ? ("member" as const) : ("co" as const), text: r.content.replace(/^(User said|Co replied): /, "") })), sent: [], activity: [], safetyHold: false, letPass: [] } as any);
  check("their recent words for the thread read, at the summary turn: nothing said later", world.theirWords.every((w) => LATER_FACTS.every((re) => !re.test(w))));
  check("the thread read sees a long text of theirs whole enough to find its last paragraph", world.theirWords.some((w) => /rival app/.test(w)) && M.THEIR_WORDS_CHARS >= FIRST.length, M.THEIR_WORDS_CHARS);
}

// ------------------------------------------------------------------ 4. a text in paragraphs is their words in full
{
  const recent = text(W.threadWindow(asOf(TRIAL)));
  const words = G.theirOwnWords(recent);
  check("their words keep a text's later paragraphs", words.includes("Thinking about an NDA before anything.") && words.includes("2) the intro call feels a lot like a rival app's"));
  check("…and never take Cue's lines, or the paragraphs of Cue's own replies", !words.includes("Smart move") && !G.theirOwnWords("Co replied: First line.\n\nSecond paragraph of Cue's.\nUser said: mine").includes("Second paragraph"));
  check("a gap marker or a call line ends their text", !G.theirOwnWords("User said: one\n[— 2 days later —]\nloose line").includes("loose line") && !G.theirOwnWords("User said: one\nCue replied: two\nloose").includes("loose"));
  check("the dated and voice-memo forms still read", G.theirOwnWords("User said on September 29, 2026: hello there\nUser sent a voice memo: and this").split("\n").length === 2);
  const rf = G.createReplyFacts();
  const quoted = G.claimChecks([{ text: "you're thinking about an NDA first", type: "member_life", supported: true, factId: null, quote: "Thinking about an NDA before anything." }], rf, { message: "ok", recentConversation: recent });
  check("before this, a member_life claim quoting their second paragraph was cut as \"cited support not found\"; now it stands", quoted[0].pass, quoted);
  const invented = G.claimChecks([{ text: "you already signed the NDA", type: "member_life", supported: true, factId: null, quote: "I already signed the NDA" }], G.createReplyFacts(), { message: "ok", recentConversation: recent });
  check("a quote that isn't in their texts still fails", !invented[0].pass);
}

// ------------------------------------------------------------------ 5. a summary of their own news is never cut as a thread report
{
  const THREAD = { text: "deciding whether to share the repo with Theo", line: "deciding whether to share the repo with Theo (said Mon Nov 2)" };
  const world = M.buildMemberWorld({ now: log[CORRECTION].created_at, zone: "America/Los_Angeles", keep: (s: string) => s, tasks: [], briefs: [], searching: { asks: [], goals: [], held: [] }, ahead: null, offeredGoals: [], docOffer: null, threads: [THREAD], exchange: [], sent: [], activity: [], safetyHold: false, letPass: [] } as any);
  const recent = text(W.threadWindow(asOf(CORRECTION)));
  const src = { message: "No, I mean the problem with Theo", recentConversation: recent };
  const ANSWER = "The problem with Theo specifically: he's curious about your repo before you two have settled roles or equity.";
  const draft = `${ANSWER} That's the part worth slowing down on.`;
  const run = async (o: { reports: number[]; claims: unknown[]; src?: typeof src }) => {
    const rf = G.createReplyFacts();
    G.addMemberWorld(rf, world);
    threadReports = o.reports;
    claims = o.claims;
    kinds.length = 0;
    hush();
    try {
      return await G.groundReply(draft, rf, o.src ?? src, { userId: null, record: false });
    } finally {
      loud();
    }
  };
  check("the answer names their thread, so the thread read is asked about it", M.threadCandidates(world, draft).includes(ANSWER));
  // The fake thread read answers the way the real one did on 11-02: the answer is a "report".
  const theirs = { text: "he's curious about your repo before you two have settled roles or equity", type: "other_person", supported: true, factId: null, quote: "He's curious about my repo but I'm not sure yet." };
  const kept = await run({ reports: [1], claims: [theirs] });
  check("after: backed by their own words this conversation, the answer goes out whole, though the read called it a report", kept.final === draft && kept.outcome === "as_drafted" && !kept.checks.some((c) => c.name === "no_thread_report" && !c.pass), kept);
  check("both reads ran", kinds.includes("thread_read") && kinds.includes("claims"), kinds);
  const unbacked = await run({ reports: [1], claims: [{ ...theirs, supported: false, quote: null }] });
  check("a status they never gave is still cut", !unbacked.final.includes("curious about your repo"), unbacked);
  const fromCue = await run({ reports: [1], claims: [{ ...theirs, quote: "Hesitating on the repo is fair." }] });
  check("a quote of Cue's own line isn't their words: still cut as a report", fromCue.checks.some((c) => c.name === "no_thread_report" && !c.pass), fromCue.checks);
  const old = `User said: He's curious about my repo but I'm not sure yet.\n[— 2 days later —]\nUser said: No, I mean the problem with Theo`;
  const stale = await run({ reports: [1], claims: [theirs], src: { message: "No, I mean the problem with Theo", recentConversation: old } });
  check("their words from before a gap don't make a status current: still cut", stale.checks.some((c) => c.name === "no_thread_report" && !c.pass), stale.checks);
  const part = { text: "before you two have settled roles or equity", type: "other_person", supported: true, factId: null, quote: "Settle roles and equity before he sees code." };
  const mixed = await run({ reports: [1], claims: [{ ...theirs, text: "he's curious about your repo" }, part] });
  check("one claim in the sentence resting on anything but their words and the exemption is off", mixed.checks.some((c) => c.name === "no_thread_report" && !c.pass) && !mixed.final.includes("curious about your repo"), mixed.checks);
  const asked = await run({ reports: [], claims: [] });
  check("a read that says it's no report keeps it, as before", asked.final === draft);
  check("thisConversation: only what follows the last gap marker", G.thisConversation("a\n[— 3 hours later —]\nb\n[— 2 days later —]\nc\nd") === "c\nd" && G.thisConversation("a\nb") === "a\nb");
}

console.log(`thread window: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
