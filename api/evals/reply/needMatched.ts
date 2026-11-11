// Reply judgment (Royce, 2026-11-10): the code paths around the reply match the need, not a texting template. Zero tokens; the model's
// own judgment is measured by evals/reply/needQuality.ts (metered, Royce runs it).
//   npx tsx evals/reply/needMatched.ts
// The reported shapes (synthetic): "you built it" to a request to explain matching; a one-fragment scenario; two near-identical answers
// to "be descriptive"; a wine-spot answer in four bubbles (link, description, the description again, a question).
import { readFileSync } from "node:fs";
import { REPAIR_ASK, replyLengthLine, lengthLineFor } from "../../src/agent/conversationReply.js";
import { keepTogether, toBeats } from "../../src/services/beats.js";
import { CO_CORE, EXPLAIN_FULLY, REPAIR_ON_PUSHBACK } from "../../src/services/coCore.js";
import { CO_TEXT_CHANNEL } from "../../src/services/coVoice.js";
import { CALL_FROM_CORE } from "../../src/services/elevenLabsCalls.js";
import { TEAM_EXPLAIN_LINE } from "../../src/services/extensions.js";
import { narratesInternalState } from "../../src/services/speakable.js";
import { CHECKIN_RULE } from "../../src/services/memberWorld.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
};

// ---------------------------------------------------------------- the length line follows the need
for (const m of ["Tell me more about your matching system", "Give me a scenario", "Walk me through it step by step", "Explain it like I'm seeing it for the first time", "Describe how intros work, step by step"]) {
  check(`a request for the whole picture is never capped: "${m}"`, replyLengthLine(m) === null, replyLengthLine(m));
}
for (const m of ["That doesn't explain it", "You said the same thing twice", "You said that already", "That's not what I asked", "you're repeating yourself", "Be real descriptive", "Give me a larger description"]) {
  const line = replyLengthLine(m);
  check(`pushback gets the repair line, not a cap: "${m}"`, REPAIR_ASK.test(m) && !!line && /answer again differently/.test(line), line);
}
// Review of #443: pushback about Cue's answer only; a casual "that's not it" is about them.
for (const m of ["that's not it, I'm just tired", "I still don't understand why she left", "that's not it lol, the other cafe"]) {
  check(`casual, not pushback on the answer: no repair line: "${m}"`, !REPAIR_ASK.test(m), m);
}
// Review of #443: "describe", "more about" and "seeing it" alone keep the brevity line (casual turns stay brief).
for (const m of ["describe the vibe there", "more about that later", "can't wait to be seeing it"]) {
  const line = replyLengthLine(m);
  check(`casual words alone keep the brevity line: "${m}"`, !!line && /as briefly as it needs/.test(line), line);
}
const quick = replyLengthLine("Any good wine spot near Hayes?");
check("a quick question stays quick, with no fixed count", !!quick && /as briefly as it needs/.test(quick) && !/\b(one|two|three) (or \w+ )?sentences?\b/i.test(quick), quick);
check("casual talk isn't turned into advice or a pitch", /don't turn it into advice, a task or a pitch/.test(quick ?? ""));
check("a share keeps its own depth (no line)", lengthLineFor("just landed", "sharing", false) === null);

// ---------------------------------------------------------------- the channel and the shared core
check("the text channel no longer sets a sentence budget", !/Two or three short sentences/.test(CO_TEXT_CHANNEL) && /as long as the moment needs/.test(CO_TEXT_CHANNEL));
check("the shared core asks for the substance of an explanation, labelled scenarios, today vs proposed, no deflection", CO_CORE.includes(EXPLAIN_FULLY) && /Label a made-up scenario as one/.test(EXPLAIN_FULLY) && /how something works today apart from how it could work/.test(EXPLAIN_FULLY) && /you built it/.test(EXPLAIN_FULLY));
check("the shared core repairs on pushback, now, and names a wrong link without repeating it", CO_CORE.includes(REPAIR_ON_PUSHBACK) && /never the same answer reworded/.test(REPAIR_ON_PUSHBACK) && /in this reply, not as a promise/.test(REPAIR_ON_PUSHBACK) && /verified one/.test(REPAIR_ON_PUSHBACK));
check("calls carry the same two lines (consistent, not identical)", CALL_FROM_CORE.includes(EXPLAIN_FULLY) && CALL_FROM_CORE.includes(REPAIR_ON_PUSHBACK) && /leave room for them to come in/.test(EXPLAIN_FULLY));
check("no filler, no automatic agreement before the answer", /glad we're on the same page/.test(CO_CORE) && /no automatic agreement or acknowledgment before the answer/.test(CO_CORE));
check("a teammate is still explained to, never 'you built it' (text; calls carry EXPLAIN_FULLY)", /explain it fully and concretely all the same/.test(TEAM_EXPLAIN_LINE) && /addInstruction\(rf, TEAM_EXPLAIN_LINE\)/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")));
const reply = readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
check("the reply's length rule is need-matched, with the vent-plus-ask case", /Match what the moment needs, not a length/.test(reply) && /A vent with a practical ask gets both/.test(reply) && !/reply in one or two sentences\. They: "just landed"/.test(reply));
check("the old 'one or two sentences' line is gone", !/Reply in one or two sentences/.test(reply));

// ---------------------------------------------------------------- splitting only where it helps
// Review of #443: nothing is dropped in code (a draft, two versions, should / should-not pairs all go; a repeat is the prompt's to avoid).
const draft = "Here's a draft you could send:\n\nHi Sam, loved meeting you at the supper. Coffee next week?\n\nOr a shorter version:\n\nHi Sam, coffee next week?";
const db = toBeats(draft);
check("a draft paragraph and two draft versions are all kept", db.length === 4 && db.some((b) => b.includes("loved meeting you")) && db.some((b) => b === "Hi Sam, coffee next week?"), db);
const pair = toBeats("You should mention the demo date.\n\nYou should not mention the demo date if it might slip.");
check("a should / should-not pair is kept", pair.length === 2, pair);
const wine = ["https://example.test/the-cellar", "The Cellar on Fell: small natural-wine bar, quiet on weeknights.", "The Cellar on Fell is a small natural-wine bar that's quiet on weeknights.", "Want a backup in case it's full?"];
check("no code-level repeat drop: every paragraph goes (the prompt avoids repeats)", toBeats(wine.join("\n\n")).length === 4);
check("keepTogether only joins lists, never drops", keepTogether(["a b c d e f", "a b c d e f g"]).length === 2);
const tool = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
check("the prompt line against repeats stays", /Never a paragraph that repeats an earlier one\./.test(tool));
// The single-text path sends the message whole when it is one beat: with nothing dropped, one beat is the whole message.
const one = "Here's how it goes:\n\n1. RSVP.\n\n2. Cue reads the room.";
check("one beat carries every word of the message (the single-send path sends the message itself)", toBeats(one).length === 1 && toBeats(one)[0].replace(/\s+/g, " ") === one.replace(/\s+/g, " "));
check("two different paragraphs both go", toBeats("That's a lot to carry.\n\nHere's what I'd do first: call the venue tomorrow morning.").length === 2);
check("the send tool's split rule: only where it helps, connected explanations together, no beat quota", /keep one connected explanation or a set of steps in one paragraph/.test(tool) && !/Most replies are one to three short beats/.test(tool));

// ---------------------------------------------------------------- "anything yet?" is an ask, answered honestly
check("CHECKIN_RULE is scoped to check-ins with no ask (a direct progress question is an ask)", /^A check-in or casual opener with no ask/.test(CHECKIN_RULE));
check("an honest 'nothing fit yet, and why' passes the narration rule", narratesInternalState("Nothing that fits the engineer search yet: the two I saw were founder programs, not ways to meet engineers.") === null);
check("machinery talk still doesn't", narratesInternalState("Nothing new on my end yet.") !== null);

// 2026-11-10 free diagnosis of the paid run: the walkthrough never numbers (the golden no-list rule), no step or sentence counts; no verified
// link is said plainly; restating never upgrades what they said (grounding); the quality fixtures seed what the real path gives.
check("the walkthrough is in order, plainly, all in one text: no numbering, no step or sentence counts", /Give the steps in order, plainly, all in one text, with no numbers or bullets\./.test(reply) && !/numbered|up to 6 steps|one to three sentences/.test(reply.slice(reply.indexOf("The exception is a request for help"), reply.indexOf("The exception is a request for help") + 1200)));
check("no verified link: said plainly", /if you don't, say so plainly/.test(REPAIR_ON_PUSHBACK));
const grounding = readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
check("grounding: a hope or guess of theirs said back as how it turned out is a claim", /Restating never upgrades what they said: a hope, guess, plan or worry of theirs said back as done, true or as how it turned out/.test(grounding));
const need = readFileSync(new URL("./needQuality.ts", import.meta.url), "utf8");
check("needQuality seeds the real path's facts (running work, sent records)", /runningWorkLine\(\[\], \[\], \{ asks: c\.seed\.running/.test(need) && /sentFindFacts\(/.test(need) && (need.match(/seed: \{/g) ?? []).length === 4);

// Fix 3 (2026-11-10 paid run): a description of how Cue works on their word isn't a promise made now; a bare promise still is.
{
  const RG = await import("../../src/harness/replyGrounding.js");
  const rf = RG.baseReplyFacts();
  check("'You tell me what you want…, I keep an eye out…' is not an unbacked promise", RG.unbackedFollowup("The rest is the same instinct, just running all the time. You tell me what you want (a kind of person, a room, a program), I keep an eye out and bring you what fits.", rf) === null);
  check("'When you tell me what you're after, I keep watching for it' is not one either", RG.unbackedFollowup("When you tell me what you're after, I keep watching for it.", rf) === null);
  check("'When you get there, I'll text you the address' is still a promise (future, not a description)", RG.unbackedFollowup("When you get there, I'll text you the address.", rf) !== null);
  check("a bare 'I'll keep an eye out' with nothing running is still cut", RG.unbackedFollowup("I'll keep an eye out for engineers this week.", rf) !== null);
  check("a promise in another sentence of the same reply is still cut", RG.unbackedFollowup("You tell me what you want, I keep an eye out. I'll text you the moment something turns up.", rf) !== null);
}

// Fixes 1 and 2 (2026-11-10 paid run): the eval grades what was sent in order (a shared link included), runs a subset, and a dry run's
// listOpenAsks can report the fixture's running search.
{
  const needSrc = readFileSync(new URL("./needQuality.ts", import.meta.url), "utf8");
  check("needQuality grades the dry-run sends in order (shared links and replies)", /would share link \(\\S\+\)/.test(needSrc) && /separate texts in send order/.test(needSrc));
  check("needQuality takes --only and passes the fixture's running search to listOpenAsks", /--only/.test(needSrc) && /dryRunOpenAsks: c\.seed\.running\.map/.test(needSrc));
  check("needQuality prints tools and fact-check cuts", /tools: \$\{/.test(needSrc) && /fact check \$\{g\.outcome\}/.test(needSrc));
  const T = await import("../../src/agent/conversationTools.js");
  const quiet = console.log;
  console.log = () => {};
  const t = T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "anything yet?", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, dryRunOpenAsks: [{ text: "ways to meet backend engineers in SF", type: "seeking" }], sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any);
  const open = await (t.tools as any).listOpenAsks.execute({}, { toolCallId: "1", messages: [] });
  const none = await (T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "x", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any).tools as any).listOpenAsks.execute({}, { toolCallId: "2", messages: [] });
  console.log = quiet;
  check("dry-run listOpenAsks reports the fixture's asks; without them, nothing (as before)", open.asks?.[0]?.text === "ways to meet backend engineers in SF" && none.asks?.length === 0, { open, none });
}

console.log(`\nneed-matched replies: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
