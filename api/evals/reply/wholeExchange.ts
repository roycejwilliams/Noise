// The whole exchange (Royce, 2026-11-03): Cue judges its next move against the whole exchange (done / told / meant / unresolved), not
// whether the next sentence sounds reasonable. Built from the real failures in the 11-03 baseline (notes/whole-exchange-baseline-1103.md),
// with invented names and made-up threads of the same shape:
//   1. the feedback re-ask: "how'd the meeting go?" after they'd said it went well
//   2. summary vs advice after a correction: a question in a summary, and the corrected subject ignored
//   3. the double "interested?"
//   4. a question after "thanks"
//   5. finds after "got the venue"
//   6. the wrong referent for "that"
//   7. a resent card
// Plus: the record's parts built from the thread and what's on file, the read's fields held to real ids, the record in the reply's
// uncached tail (the cached prefix byte-stable), the one rewrite on the reply path, and the same check on a call before speech.
// Layer 1: zero tokens, no database. Whether the model picks the right move is unverified until a paid run (golden cases listed in the PR).
//   npx tsx evals/reply/wholeExchange.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

let replyText = "";
const replies: string[] = [];
const systems: any[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  let body: any = {};
  try { body = JSON.parse(String(init?.body ?? "")); } catch {}
  const raw = String(init?.body ?? "");
  let text = "{}";
  if (/You check a text message Cue is about to send/.test(raw)) text = JSON.stringify({ claims: [] });
  else if (/You are replying by iMessage/.test(raw)) (systems.push(body.system), (text = replyText));
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const X = await import("../../src/services/exchangeRecord.js");
const M = await import("../../src/harness/moveCheck.js");
const RT = await import("../../src/services/readTurn.js");
const G = await import("../../src/harness/replyGrounding.js");
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const P = await import("../../src/services/callLlmProxy.js");
const C = await import("../../src/harness/exchangeCount.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) { failed++; process.stdout.write(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}\n`); }
};
const names = (ms: { name: string }[]) => ms.map((m) => m.name);
const rec = (base: Partial<import("../../src/services/exchangeRecord.js").ExchangeBase>, read: Partial<import("../../src/services/exchangeRecord.js").ExchangeRead> | null): import("../../src/services/exchangeRecord.js").ExchangeRecord => ({
  done: base.done ?? [], unresolved: base.unresolved ?? [], priorMeant: base.priorMeant ?? [],
  read: read ? { move: "answer", meant: null, told: [], closes: [], reopens: [], again: null, ...read } : null,
});

// ------------------------------------------------------------------ the record's parts
const THREAD = [
  "User said: hey, any jazz this week?",
  "Co replied: https://example.test/harbor-jazz",
  "Co replied: Harbor Jazz Night, Thursday 8pm at the pier. Does this one interest you?",
  "User said: maybe. also want the book thing",
  "Co replied: https://example.test/mission-book-fair",
  "Co replied: [sent Cue's contact card]",
  "Co replied: Want me to keep an eye out for more readings?",
].join("\n");
{
  const done = X.doneFrom(THREAD, [{ name: "Harbor Jazz Night", url: "https://example.test/harbor-jazz" }, { name: "Oakland Supper Club", url: "https://example.test/supper" }]);
  check("done: newest first, numbered, the offer still unanswered", done[0].id === "D1" && done[0].kind === "offer" && done[0].replied === false, done);
  check("done: the card, both links (named from what's on file), the interest question, and an on-file find not in the window", done.some((d) => d.kind === "card") && done.some((d) => d.kind === "link" && d.label === "Harbor Jazz Night") && done.some((d) => d.kind === "link" && /mission-book-fair/.test(d.label)) && done.some((d) => d.kind === "question" && /interest you/.test(d.label) && d.replied) && done.some((d) => d.kind === "find" && d.label === "Oakland Supper Club"), done);
  check("done: a link already in the window isn't listed twice from what's on file", done.filter((d) => d.url && /harbor-jazz/.test(d.url)).length === 1);
  const un = X.unresolvedFrom({ asks: [{ text: "jazz in Oakland" }], carrying: [{ label: "task #4: \"venue shortlist\"", state: "done" }, { label: "loop: book fair tickets", state: "outstanding" }], closed: [{ label: "Find a private dining room near Hayes Valley", how: "dropped" }] });
  check("unresolved: open, delivered (done is delivered, never solved), and closed at their word", un.map((u) => u.state).join(",") === "open,delivered,open,dropped", un);
}
// ------------------------------------------------------------------ the read's fields, held to real ids
{
  const base = { done: X.doneFrom(THREAD), unresolved: [{ id: "U1", label: "jazz in Oakland", state: "open" as const }, { id: "U2", label: "old dinner", state: "dropped" as const }], priorMeant: [] };
  const add = RT.turnReadAddendum(null, null) + X.exchangeAddendum(base);
  check("the read is asked for the move, refers_to, answered, closes, reopens and asks_again", ["\"move\"", "\"reopens\"", "\"refers_to\"", "\"answered\"", "\"closes\"", "\"asks_again\""].every((k) => add.includes(k)));
  const RB = { reason: "r", answers: null, ambiguousBetween: [], call: "none", wantsRecommendation: false, confidence: "high" };
  const r = RT.parseTurnRead({ ...RB, mode: "reacting", move: "close", move_why: "they're wrapping up", refers_to: { phrase: "that", item: "d2", not_item: "D99" }, answered: [{ q: "Does this one interest you?", a: "maybe" }, { q: "" }], closes: [{ item: "U1", how: "solved" }, { item: "U2", how: "dropped" }, { item: "U9" }], asks_again: "D7" }, [], base).exchange;
  check("parsed: the move, the D id case-folded, an unknown id dropped, empty answers dropped, only open items close", !!r && r.move === "close" && r.meant?.item === "D2" && r.meant?.notItem === null && r.told.length === 1 && r.closes.length === 1 && r.closes[0].item === "U1" && r.again === null, r);
  check("no record, no exchange read (a read without one never invents ids)", RT.parseTurnRead({ ...RB, move: "close" }, [], null).exchange === null);
  check("an unknown move is no move", X.parseExchangeRead({ move: "lecture" }, base) === null);
}

// ------------------------------------------------------------------ 1. the feedback re-ask
{
  const r = rec({ done: [{ id: "D1", kind: "question", label: "How'd the meeting with Theo go?", url: null, replied: true }] }, { told: [{ q: "How'd the meeting with Theo go on Sunday?", a: "went well, we're aligned" }] });
  check("1. asking again how the meeting went, after they said it went well: a re-ask", names(M.moveMisses("Glad you're back. How'd the meeting with Theo go on Sunday?", r)).includes("reask"));
  check("1. ...reworded, still a re-ask", names(M.moveMisses("Did the meeting with Theo on Sunday go well?", r)).includes("reask"));
  check("1. building on their answer is fine", M.moveMisses("Good to hear you and Theo are aligned. Next is the term sheet.", r).length === 0);
  const r2 = rec({}, { told: [{ q: "What did you think of the onboarding walkthrough?", a: "loved it but too long" }] });
  check("1. the feedback question again, after they gave the feedback: a re-ask", names(M.moveMisses("What did you think of the onboarding walkthrough?", r2)).includes("reask"));
}
// ------------------------------------------------------------------ 2. summary vs advice after a correction
{
  const done = [{ id: "D1", kind: "document" as const, label: "Positioning doc for the Lumen pop-up", url: null, replied: true }, { id: "D2", kind: "question" as const, label: "Want me to stress test it?", url: null, replied: true }];
  const r = rec({ done }, { move: "summarize", meant: { phrase: "the problem", item: null, label: null, notItem: "D1", notLabel: done[0].label } });
  const miss = names(M.moveMisses("The positioning doc for the Lumen pop-up is strong. Want me to tighten it?", r));
  check("2. a summary that asks a question is off the move", miss.includes("off_move"), miss);
  check("2. ...and still about what they said they didn't mean: the correction is ignored", miss.includes("ignores_correction"), miss);
  check("2. the summary of what they named, no question: clean", M.moveMisses("You and Theo want a split before any code changes hands, and he hasn't said yes yet.", r).length === 0);
}
// ------------------------------------------------------------------ 3. the double "interested?"
{
  const r = rec({}, { move: "act" });
  check("3. two interest questions in one reply", names(M.moveMisses("Either of these interest you?\n\nDoes this one interest you?", r)).includes("double_ask"));
  check("3. one is fine", M.moveMisses("Harbor Jazz Night is Thursday. Does this one interest you?", r).length === 0);
  const r2 = rec({ done: [{ id: "D1", kind: "question", label: "Does this one interest you?", url: null, replied: false }] }, { move: "act" });
  check("3. a new interest question while the last still has no answer", names(M.moveMisses("Worth a look for Wednesday?", r2)).includes("double_ask"));
}
// ------------------------------------------------------------------ 4. a question after "thanks"
{
  const r = rec({}, { move: "close" });
  check("4. close: a question added after their thanks", names(M.moveMisses("Glad it helped! Anything else you need?", r)).includes("question_after_close"));
  check("4. close: acknowledged once, and stop", M.moveMisses("Glad it helped. Talk soon.", r).length === 0);
  check("4. a safety question is never held (always askable)", M.moveMisses("Glad it helped. Are you safe right now?", r).length === 0);
}
// ------------------------------------------------------------------ 5. finds after "got the venue"
{
  const unresolved = [{ id: "U1", label: "Find a private dining room for twelve near Hayes Valley", state: "open" as const }, { id: "U2", label: "jazz in Oakland", state: "open" as const }];
  const r = rec({ unresolved }, { move: "close", closes: [{ item: "U1", how: "solved" }] });
  const miss = names(M.moveMisses("Congrats! I also found another private dining room near Hayes Valley: https://example.test/room. Want it?", r));
  check("5. a find about the venue they just got: a reopening, a find and a question after a close", miss.includes("reopen") && miss.includes("find_after_close") && miss.includes("question_after_close"), miss);
  check("5. congratulating them is the move", M.moveMisses("Congrats on locking the venue. That's the big one done.", r).length === 0);
  const r2 = rec({ unresolved: [{ id: "U1", label: "Find two DJ options for the October party", state: "dropped" }] }, { move: "answer" });
  check("5. a DJ find days after they dropped the DJ ask: a reopening", names(M.moveMisses("Found a DJ for the October party: https://example.test/dj. Want the details?", r2)).includes("reopen"));
  check("5. an unrelated answer isn't held", M.moveMisses("Thursday works. I'll text you the address.", r2).length === 0);
}
// ------------------------------------------------------------------ 6. the wrong referent for "that"
{
  const done = [{ id: "D1", kind: "link" as const, label: "Harbor Jazz Night", url: "https://example.test/harbor-jazz", replied: true }, { id: "D2", kind: "link" as const, label: "Mission Book Fair", url: "https://example.test/mission-book-fair", replied: true }];
  const r = rec({ done }, { meant: { phrase: "that", item: "D1", label: "Harbor Jazz Night", notItem: null, notLabel: null } });
  check("6. \"that\" meant the jazz night; the draft answers about the book fair", names(M.moveMisses("The Mission Book Fair starts at 10am and it's free.", r)).includes("wrong_referent"));
  check("6. answering about the jazz night is right", M.moveMisses("Harbor Jazz Night starts at 8pm at the pier.", r).length === 0);
  const lines = X.recordLines(r)!;
  check("6. the resolved referent reaches the reply's lines", lines.includes('"that" in their message means D1 (Harbor Jazz Night)'), lines);
}
// ------------------------------------------------------------------ 7. a resent card, and a re-sent link
{
  const done = [{ id: "D1", kind: "card" as const, label: "Cue's contact card", url: null, replied: true }, { id: "D2", kind: "link" as const, label: "Harbor Jazz Night", url: "https://example.test/harbor-jazz", replied: true }];
  const tools = (read: any) => (createConversationTools({ userId: "u1", phoneNumber: "+15555550100", resolvedContent: "thanks", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true, exchange: rec({ done }, read), facts: { add: () => {}, text: () => "" } } as any).tools as any);
  process.env.CO_VCARD_URL ||= "https://example.test/card.vcf";
  const log = console.log; console.log = () => {};
  const refused = await tools({ move: "answer" }).sendContactCard.execute({ theirWords: "thanks" });
  const again = await tools({ move: "act", again: "D1" }).sendContactCard.execute({ theirWords: "send your card again" });
  const noRead = await (createConversationTools({ userId: "u1", phoneNumber: "+15555550100", resolvedContent: "card?", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true, exchange: rec({ done }, null), facts: { add: () => {}, text: () => "" } } as any).tools as any).sendContactCard.execute({ theirWords: "card?" });
  console.log = log;
  check("7. the card already sent, not asked for again: not sent", refused.ok === false && /already went to them/.test(refused.error), refused);
  check("7. asked for again: sent", again.ok === true, again);
  check("7. no read this turn: no guess, the card goes as before", noRead.ok === true, noRead);
  const r = rec({ done }, { move: "answer" });
  check("7. the same link again with no ask: a resend", names(M.moveMisses("Here it is: https://example.test/harbor-jazz", r)).includes("resend"));
  check("7. asked for again: not a resend", M.moveMisses("Same one again: https://example.test/harbor-jazz", rec({ done }, { move: "act", again: "D2" })).length === 0);
}

// ------------------------------------------------------------------ over-blocking on text (review of #368): their latest message wins
{
  const unresolved = [{ id: "U1", label: "Find an apartment in the Mission under 3k", state: "dropped" as const }];
  const r = rec({ unresolved }, { move: "act", reopens: ["U1"] });
  check("text: they bring a dropped ask back (\"looking for an apartment again\"): helping with it is not a reopening", M.moveMisses("Back on it. Here's one in the Mission under 3k: https://example.test/apt. Want more like it?", r).length === 0, M.moveMisses("Back on it. Here's one in the Mission under 3k: https://example.test/apt. Want more like it?", r));
  const lines = X.recordLines(r)!;
  check("text: ...and the tail says it's theirs to reopen, never \"don't reopen\" for it", lines.includes("They're bringing back what they had closed: U1") && !/Closed at their word[^\n]*U1/.test(lines), lines);
  const base = { done: [], unresolved, priorMeant: [] };
  const RB = { reason: "r", answers: null, ambiguousBetween: [], call: "none", wantsRecommendation: false, confidence: "high" };
  check("text: the read's reopens are held to closed items", JSON.stringify(RT.parseTurnRead({ ...RB, move: "act", reopens: ["u1", "U7"] }, [], base).exchange?.reopens) === '["U1"]');
  // A distressed close: the safety and heavy reads win over "close".
  check("text: a well-being question after a close is never held", M.moveMisses("Glad it helped. Are you doing okay?", rec({}, { move: "close" })).length === 0 && M.moveMisses("Okay. How are you holding up?", rec({}, { move: "close" })).length === 0);
  const sb = fs.readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  check("text: a close on a safety turn or a heavy moment (the capped heavyHold) becomes the feeling move", /read0\?\.move === "close" && \(crisisWording \|\| heavyHold\(emotional, new Date\(\)\)\.hold\)/.test(sb) && /move: "feeling" as const/.test(sb));
  check("text: the moves guide says distress is never a close, and a thanks with a question isn't one", X.MOVES_GUIDE.includes("closing words that carry distress") && X.MOVES_GUIDE.includes("a thanks with a question or a request is"));
  check("text: on a turn that touches safety, the draft check never runs (sendReply skips it)", /!ctx\.safetyConcern && !state\.safetyFlagged\) \{\s*const \{ moveMisses/.test(fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8")));
  // "thanks! what time does it start?": answer, not close; a link they asked for again is never dropped.
  const done = [{ id: "D1", kind: "link" as const, label: "Harbor Jazz Night", url: "https://example.test/harbor-jazz", replied: true }];
  check("text: a close that also asks for something again is a request (act)", RT.parseTurnRead({ ...RB, move: "close", asks_again: "D1" }, [], { done, unresolved: [], priorMeant: [] }).exchange?.move === "act");
  check("text: \"thanks! what time does it start?\" read as answer: the answer with a question goes", M.moveMisses("Glad you liked it. It starts at 8. Want me to save you a reminder?", rec({ done }, { move: "answer" })).length === 0);
  check("text: the link they asked for again goes, even on a close", M.moveMisses("Same one again: https://example.test/harbor-jazz", rec({ done }, { move: "close", again: "D1" })).length === 0);
  check("text: only Cue's own item labels are kept between turns, never their pointing words", !/phrase:/.test(sb.slice(sb.indexOf('decision: "turn.meant"'), sb.indexOf('decision: "turn.meant"') + 400)) && /label: thing\(r\.meant\.item\)/.test(sb));
  check("text: the record's database reads start beside the turn's picture", /const exchangeFactsP = hasText \?/.test(sb) && /Promise\.all\(\[turnP!\.catch\(\(\) => null\), tapbacksP, exchangeFactsP\]\)/.test(sb));
}

// ------------------------------------------------------------------ the reply path: one rewrite toward the move, then it goes
{
  const sent: string[] = [];
  const made = createConversationTools({ userId: "u1", phoneNumber: "+15555550100", resolvedContent: "perfect, thanks", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async (o: any) => (sent.push(o.message), true), exchange: rec({}, { move: "close" }), facts: { add: () => {}, text: () => "" } } as any);
  const log = console.log; console.log = () => {};
  const first = await (made.tools as any).sendReply.execute({ message: "Glad it helped! Anything else on your list?" }, { toolCallId: "a" });
  const second = await (made.tools as any).sendReply.execute({ message: "Glad it helped! Anything else on your list?" }, { toolCallId: "b" });
  console.log = log;
  check("reply: a draft that misses the move comes back once, with the move and what missed (no line to say)", first.ok === false && /This turn's move is close/.test(first.error) && /adds a question after they closed/.test(first.error) && !/Say "/.test(first.error), first);
  check("reply: only once a turn; the second try goes on as before (never a loop, never silence)", second.ok === true && made.state.sentMessages.length === 1, second);
  const safe = createConversationTools({ userId: "u1", phoneNumber: "+15555550100", resolvedContent: "thanks", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, safetyConcern: true, sendCoReply: async () => true, exchange: rec({}, { move: "close" }), facts: { add: () => {}, text: () => "" } } as any);
  console.log = () => {};
  const s1 = await (safe.tools as any).sendReply.execute({ message: "I'm here. Are you somewhere you can talk?" }, { toolCallId: "c" });
  console.log = log;
  check("reply: never held on a turn that touches their safety", s1.ok === true);
  const plain = createConversationTools({ userId: "u1", phoneNumber: "+15555550100", resolvedContent: "thanks", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true, exchange: rec({}, { move: "close" }), facts: { add: () => {}, text: () => "" } } as any);
  console.log = () => {};
  const p1 = await (plain.tools as any).sendReply.execute({ message: "Glad it helped. Anything else?" }, { toolCallId: "plain-text-reply" });
  console.log = log;
  check("reply: the plain text sent after the loop ended goes as written (no redraft can follow)", p1.ok === true);
}
// ------------------------------------------------------------------ the record in the reply's uncached tail; the cached prefix byte-stable
{
  const run = async (withRecord: boolean) => {
    const rf = G.createReplyFacts();
    if (withRecord) {
      const r = rec({ done: [{ id: "D1", kind: "link", label: "Harbor Jazz Night", url: "https://example.test/harbor-jazz", replied: true }] }, { move: "close", told: [{ q: "Thursday or Friday?", a: "Thursday" }] });
      rf.exchange = r;
      G.addInstruction(rf, X.recordLines(r)!);
    }
    replyText = "Glad it helped.";
    systems.length = 0;
    const log = console.log, err = console.error; console.log = () => {}; console.error = () => {};
    try {
      await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan", resolvedContent: "perfect, thanks", isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: rf, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "User said: thanks for the jazz link\nCo replied: Enjoy it.", personaPrompt: null, sendCoReply: async () => true } as any, { dryRun: true, record: false });
    } finally { console.log = log; console.error = err; }
    return systems[0] as { text: string }[];
  };
  const a = await run(false), b = await run(true);
  check("tail: the reply ran on the fake model", Array.isArray(a) && Array.isArray(b) && a.length === b.length, [a?.length, b?.length]);
  check("tail: the cached prefix (every block before the turn's own) is byte-identical with and without the record", a.slice(0, -1).every((blk, i) => blk.text === b[i].text));
  const last = b[b.length - 1].text;
  check("tail: the record and the move are in the turn's own block", last.includes("The whole exchange (Cue's record") && last.includes("This turn's move: close") && last.includes('"Thursday or Friday?" → "Thursday"'), last.slice(-900));
  check("tail: the move's logged reason is built by code from the read's fields, never the model's words", X.moveReason({ move: "act", meant: null, told: [{ q: "a", b: "" } as any], closes: [], reopens: ["U1"], again: "D1" }) === "move=act; asked for something again; brought back 1; answered 1 earlier" && !RT.turnReadAddendum(null, null).includes("move_why") && !X.exchangeAddendum({ done: [], unresolved: [], priorMeant: [] }).includes("move_why"));
  check("tail: a text turn whose read failed gets no record lines (no \"never again\" or \"don't reopen\" without a read); a call keeps its note", X.recordLines(rec({ done: [{ id: "D1", kind: "link", label: "Harbor Jazz Night", url: "https://example.test/harbor-jazz", replied: true }] }, null)) === null && !!X.recordLines(rec({ done: [{ id: "D1", kind: "link", label: "Harbor Jazz Night", url: "https://example.test/harbor-jazz", replied: true }] }, null), { call: true }));
}

// ------------------------------------------------------------------ calls: the same check before speech (the #365 hold), and the note
{
  const text = (s: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, { type: "content_block_stop", index: 0 }];
  const body = { model: "x", stream: true, messages: [{ role: "system", content: "You are Cue, on a call." }, { role: "assistant", content: "Hey Sam. How'd the meeting with Theo go?" }, { role: "user", content: "It went really well, we're aligned." }, { role: "assistant", content: "Love that." }, { role: "user", content: "Yeah. Anyway, what's new?" }] };
  const reqs: any[] = [];
  let n = 0;
  const answers = ["How'd the meeting with Theo go?", "Not much on my side. Want to plan the next step with Theo?"];
  const dropped: string[] = [];
  let said = "";
  for await (const c of P.runCallLlm(body as any, { stream: (r: any) => { reqs.push(r); const a = answers[Math.min(n++, answers.length - 1)]; return (async function* () { for (const e of text(a)) yield e as any; })(); }, clean: true, exchange: rec({}, null), callRead: (i) => X.readCallTurn(i, async () => JSON.stringify({ answered: ["Q1"], again: [], back: [] })), onDropped: (s, w) => dropped.push(`${w}: ${s}`) })) {
    const d = c.choices[0].delta as any;
    if (typeof d.content === "string") said += d.content;
  }
  check("call: asking again what they answered on this call is held before it's spoken", dropped.some((x) => /^move held: asks again what they answered on this call/.test(x)), dropped);
  check("call: ...and Cue answers again in its own words (the held-turn retry, with its own note), never silence or a fixed line", /Not much on my side/.test(said) && reqs.length === 2 && JSON.stringify(reqs[1]).includes("repeated something already said, sent or closed") && !JSON.stringify(reqs[1]).includes("can't back here"), said);
  // Without the record (deps.exchange undefined), nothing changes on the call.
  const dropped2: string[] = []; n = 0; said = "";
  for await (const c of P.runCallLlm(body as any, { stream: () => { const a = answers[Math.min(n++, 1)]; return (async function* () { for (const e of text(a)) yield e as any; })(); }, clean: true, onDropped: (s, w) => dropped2.push(w) })) { const d = c.choices[0].delta as any; if (typeof d.content === "string") said += d.content; }
  check("call: off without a record (the check runs only where the call passes one)", !dropped2.some((w) => /move held/.test(w)), dropped2);
  // A safety call is never held by it.
  const safetyBody = { ...body, messages: [...body.messages.slice(0, -1), { role: "user", content: "Honestly I don't want to be here anymore." }] };
  const dropped3: string[] = []; n = 0;
  for await (const _ of P.runCallLlm(safetyBody as any, { stream: () => (async function* () { for (const e of text("I'm here with you. How'd the meeting with Theo go?")) yield e as any; })(), clean: true, exchange: rec({}, null), callRead: async () => ({ answered: ["How'd the meeting with Theo go?"], again: [], back: [] }), onDropped: (s, w) => dropped3.push(w) })) { /* drain */ }
  check("call: never on a safety call", !dropped3.some((w) => /move held/.test(w)), dropped3);
  // Offering to text a link already sent.
  const r = rec({ done: [{ id: "D1", kind: "link", label: "Harbor Jazz Night", url: "https://example.test/harbor-jazz", replied: true }], unresolved: [{ id: "U1", label: "Find a private dining room near Hayes Valley", state: "solved" }] }, null);
  const none = { answered: [], again: [], back: [] };
  check("call: offering again to text what was already sent", M.callSentenceMiss("Want me to text you the Harbor Jazz Night link?", { rec: r, callTurns: [], delivered: [], read: none })?.name === "reoffer");
  check("call: asking about something they closed", M.callSentenceMiss("Still want me looking for a private dining room near Hayes Valley?", { rec: r, callTurns: [], delivered: [], read: none })?.name === "reopen");
  check("call: an ordinary answer passes", M.callSentenceMiss("Thursday at eight works.", { rec: r, callTurns: [], delivered: [], read: none }) === null);
  // Over-blocking (review of #368): their latest words win.
  check("call: \"send me the jazz link again\": offering it is never held", M.callSentenceMiss("Want me to text you the Harbor Jazz Night link?", { rec: r, callTurns: [], delivered: [], read: { ...none, again: ["Harbor Jazz Night"] } }) === null);
  check("call: \"I'm looking for a dining room again\": asking about it is never held", M.callSentenceMiss("Still want me looking for a private dining room near Hayes Valley?", { rec: r, callTurns: [], delivered: [], read: { ...none, back: ["Find a private dining room near Hayes Valley"] } }) === null);
  check("call: no read yet (or it failed): nothing is held for repeating", M.callSentenceMiss("Want me to text you the Harbor Jazz Night link?", { rec: r, callTurns: [], delivered: [], read: null }) === null);
  check("call: a well-being question is never held as a re-ask", M.callSentenceMiss("Are you doing okay?", { rec: r, callTurns: [], delivered: [], read: { ...none, answered: ["Are you doing okay?"] } }) === null);
  // "what?": the read is what decides whether their reply answered.
  const whatTurns = [{ from: "co" as const, text: "How'd the meeting with Theo go?" }, { from: "them" as const, text: "what?" }];
  const inp = M.callReadInput(whatTurns, null, []);
  check("call: the read gets Cue's question with their reply, and their latest words", inp.questions.length === 1 && inp.questions[0].reply === "what?" && inp.latest === "what?" && X.callReadPrompt(inp).includes('"what?", "sorry?", "huh", a mishear'), inp);
  const notAnswered = await X.readCallTurn(inp, async () => JSON.stringify({ answered: [], again: [], back: [] }));
  check("call: \"what?\" isn't an answer: asking it again is said", M.callSentenceMiss("How'd the meeting with Theo go?", { rec: null, callTurns: whatTurns, delivered: [], read: notAnswered }) === null);
  const wentWell = await X.readCallTurn({ ...inp, questions: [{ q: "How'd the meeting with Theo go?", reply: "went well" }] }, async () => '{"answered": ["q1"], "again": ["T9"], "back": []}');
  check("call: an answered question asked again is held; unknown ids are dropped", M.callSentenceMiss("How'd the meeting with Theo go?", { rec: null, callTurns: whatTurns, delivered: [], read: wentWell })?.name === "reask" && wentWell!.again.length === 0, wentWell);
  check("call: nothing to read, no model call", (await X.readCallTurn({ questions: [], sent: [], closed: [], latest: "hi" }, async () => { throw new Error("called"); }))?.answered.length === 0);
  const note = X.callTurnNote(r)!;
  check("call: the turn note carries the moves and the record (after their words, never the cached prompt)", note.includes("Pick the move from the whole exchange") && note.includes("Harbor Jazz Night") && note.includes("Closed at their word"));
  const src = fs.readFileSync(new URL("../../src/services/gptLive.ts", import.meta.url), "utf8");
  check("call: GPT-Live thinking puts the note in turnNotes and passes the record to runCallLlm", /callTurnNote\(exchange\)/.test(src) && /turnNotes, \.\.\.\(exchange !== undefined \? \{ exchange, callRead: o\.callRead \?\?/.test(src));
  const bridge = fs.readFileSync(new URL("../../src/services/gptLiveBridge.ts", import.meta.url), "utf8");
  check("call: the bridge hands every delegated turn the cached record, and logs a held move as its own decision", /callExchange: cachedCallExchange/.test(bridge) && /exchange: d\.callExchange \?\? null/.test(bridge) && /"call\.move_held"/.test(bridge));
  check("call: the record waits at most a moment, then the turn goes on without it (fails open)", /CALL_EXCHANGE_WAIT_MS = \d+/.test(src) && /Promise\.race\(\[p, new Promise<null>/.test(src));
}
// ------------------------------------------------------------------ the text path is wired (source shape)
{
  const sb = fs.readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  check("text: the record is built for the read and handed to it", /X\.baseFrom\(recentConversation, t, xf \?\? null\)/.test(sb) && /record: exchangeBase \}/.test(sb));
  check("text: the record's lines go in as this turn's instruction, and the record to the tools", /replyFacts\.exchange = record/.test(sb) && /addInstruction\(replyFacts, lines\)/.test(sb));
  check("text: the move is logged with its reason; only Cue's own sent things are kept as what \"that\" meant", /decision: "turn\.move_read"/.test(sb) && /\["link", "find", "document", "card"\]/.test(sb));
  const cr = fs.readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
  check("text: the reply hands the record to its tools", /exchange: input\.facts\.exchange \?\? null/.test(cr));
}

// ------------------------------------------------------------------ the nightly count (no model)
{
  const t = (h: number) => new Date(Date.UTC(2026, 10, 3, h));
  const rows = [
    { from: "co" as const, text: "https://example.test/room", at: t(1) },
    { from: "co" as const, text: "Does this one interest you?", at: t(1) },
    { from: "co" as const, text: "https://example.test/room", at: t(5) },
    { from: "co" as const, text: "Worth a look for Wednesday?", at: t(5) },
    { from: "them" as const, text: "got the venue, thanks", at: t(6) },
    { from: "co" as const, text: "Found another private dining room near Hayes Valley: https://example.test/room2", at: t(7) },
    { from: "co" as const, text: "Glad it's sorted. Anything else?", at: t(8) },
  ];
  const hits = C.countMember({ rows, closed: [{ label: "Find a private dining room near Hayes Valley", at: t(6) }], closeTurns: [new Date(t(8).getTime() - 60_000)], since: t(0), until: t(12) });
  const kinds = hits.map((h) => h.kind).sort();
  check("nightly: a repeat, a double ask, a reopening and a question after a close are counted", kinds.includes("repeat") && kinds.includes("double_ask") && kinds.includes("reopen") && kinds.includes("after_close"), kinds);
  const flag = C.hitFlag("u1", hits[0]);
  check("nightly: a flag carries kinds and times only, never words", flag.type === "exchange_miss" && !/room|venue|Hayes/i.test(JSON.stringify(flag)), flag);
  const jobs = fs.readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
  const review = fs.readFileSync(new URL("../../src/harness/devReview.ts", import.meta.url), "utf8");
  check("nightly: scheduled beside the rule check, and on the morning review", /runNightlyExchangeCount\(\)/.test(jobs) && /exchangeCount\.js"\)\.then\(\(E\) => E\.exchangeCounts/.test(review));
}

console.log(`whole exchange: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
