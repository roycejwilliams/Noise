// How Cue answers what a member shared, and "you're dry" feedback (Royce, 2026-10-28). Layer 1, no model calls.
//   TZ=UTC node evals/runLayer1.mjs evals/reply/shareGuide.ts
// What code can hold: the guidance reaches only sharing and feedback turns, it quotes no sample line for Cue to copy, and a text never
// goes out with a sentence that is only a stock phrase. Whether the replies got better is a model question (the texting eval).
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const D = await import("../../src/services/connectDots.js");
const L = await import("../../src/harness/stockLines.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const moment = (mode: any, pushback: string | null = null) => D.momentInstruction({ mode, topic: "coming back from a birthday trip", pushback, lesson: null, dots: [] }) ?? "";

// ---- The guidance, only where it belongs ----
check("a sharing turn gets the sharing guidance", moment("sharing").includes(D.SHARING_GUIDE));
check("a feedback turn gets the feedback guidance", moment("feedback", "replies feel dry").includes(D.FEEDBACK_GUIDE));
check("feedback keeps the pushback line beside it", /They're pushing back on what you said: replies feel dry/.test(moment("feedback", "replies feel dry")));
for (const m of ["asking", "logistics", "planning", "small_talk", "reacting"]) check(`a ${m} turn gets neither`, !moment(m).includes(D.SHARING_GUIDE) && !moment(m).includes(D.FEEDBACK_GUIDE));
check("no moment read, no guidance", D.momentInstruction(null) === null);

// ---- Principles, never sample lines (Cue copies the wording of its instructions) ----
for (const [name, g] of [["sharing", D.SHARING_GUIDE], ["feedback", D.FEEDBACK_GUIDE]] as const) {
  check(`${name} guide quotes no line for Cue to copy`, !/["“”]/.test(g));
  check(`${name} guide carries no stock phrase`, L.stockLine(g) === null);
  check(`${name} guide has no dashes (Cue copies them)`, !/[—–]/.test(g));
}
// Royce's points, each present in the guide (wording reviewed by Royce before it ships).
const G = D.SHARING_GUIDE;
const F0 = D.FEEDBACK_GUIDE;
check("the sharing guide no longer caps questions at one", !/never more than one|one real question/.test(G) && /questions when there's something you genuinely want to understand/.test(G));
// Scoped (Royce 2026-10-29): the new rules live only in the share and feedback guides, stated as overriding the general length and
// question rules for that turn. The rhythm every text reads is co-test's, so a check-in never reads them.
check("both guides override the general length and question rules for their turn, with no length cap", /On this turn this overrides the general length and question rules: match the depth to what they shared, with no length cap\./.test(G) && /On this turn this overrides the general length and question rules: give it the depth it needs, with no length cap\./.test(D.FEEDBACK_GUIDE));
check("questions: several are fine when they are one continuous thought, and the reaction with its question stays one message", /Several questions are fine when they are one continuous thought, each building on the last/.test(G) && /a reaction with the thought or question that grows from it stays one message/.test(G));
check("questions: never a questionnaire, a re-ask, or forced onto a complete moment", /never a questionnaire, never re-asking what they already answered, never a question forced onto a moment that's complete/.test(G));
check("no repeated mirror-then-ask shape; contribute instead", /don't fall into mirroring them and then asking something/.test(G));
check("use what they told you rather than asking again", /Use what they've already told you, in this thread or before, rather than asking again/.test(G));
check("feelings: meet it; help if they want it; a real response when they're telling you how things are", /When it's a feeling, meet it first\. If they want help, find out what would help or walk them through the way forward, shaped around what they're feeling\. If they're telling you how things are or were rather than asking for help, a real response is enough/.test(G));
const RH = (await import("../../src/services/textRhythm.js")).MESSAGE_RHYTHM;
const RP = fs.readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
const SHARE_ONLY = /Depth follows what they asked|Questions are how you understand them|Several in one message are fine|Don't settle into one shape|overrides the general length|a real response is enough|a moment that's already complete needs no question|However many things are listed/;
check("none of the share rules leak into what every text reads (the rhythm, the reply prompt, the send tool)", !SHARE_ONLY.test(RH) && !SHARE_ONLY.test(RP) && !SHARE_ONLY.test(fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8")));
check("a complete moment gets a short warm line, nothing pulled out of them", /When the moment is complete, a short warm line is the whole reply/.test(G));
check("contributes, never restating their words back (2026-10-28 run: the Lisbon and Camille replies recited what they said)", /Add something of your own instead of restating what they told you or simply agreeing/.test(G) && /they know what they said/.test(G) && !/only mirroring/.test(G));
check("carries the thread forward from what they told, never a scheduled feelings check-in", /Use what they've already told you, in this thread or before/.test(G) && /never as a scheduled check-in/.test(G));
check("context shapes tone, never facts; curious, not guessing causes", /shapes your tone, never your facts/.test(G) && /be curious instead/.test(G));
check("timing (belated)", /something already behind them is said as past/.test(G));
check("no therapy or plan turn unless asked", /don't turn it into a question about what would help, a therapy question, or a plan/.test(G));
check("feedback: their words never handed back, what they told used rather than asked again", /with something of your own in it rather than their words handed back, and using what they already told you rather than asking again/.test(F0));
const F = D.FEEDBACK_GUIDE;
check("feedback: brief ownership, then the better reply to what they shared", /Own it in a few words at most, then show it/.test(F) && /their earlier message deserved/.test(F));
check("feedback: no tone explanation, no long apology, no asking to repeat, honest if asked", /Don't explain your tone or how you work/.test(F) && /don't apologize at length/.test(F) && /don't ask them to say it again/.test(F) && /If they ask what went wrong, say honestly/.test(F));

// ---- Stock sentences on texts ----
check("'Makes sense.' alone is a stock sentence on a text", L.textStockSentence("Makes sense.") && L.textStockSentence("That makes sense.") && L.textStockSentence("Yeah, totally makes sense!"));
check("'makes sense' that goes on to say something isn't", !L.textStockSentence("That makes sense, but I'd still wait a week.") && !L.textStockSentence("It makes sense to wait until Friday.") && !L.textStockSentence("You took the week off, which makes sense."));
check("a question is never stock", !L.textStockSentence("Does that make sense?") && !L.textStockSentence("I hear you?"));
check("calls are unchanged: 'That makes sense.' isn't in the call's stock list", L.stockLine("That makes sense.") === null && !L.stockSentence("That makes sense."));
check("the call's stock sentences count on texts too", L.textStockSentence("I hear you.") && L.textStockSentence("And I hear you."));
check("Royce's text: the 'Makes sense.' opener is dropped, the rest kept", L.dropStockSentences("Makes sense. Glad you got the break before it wore you down further.") === "Glad you got the break before it wore you down further.");
check("'I hear you.' as its own paragraph is dropped, the paragraph break kept tidy", L.dropStockSentences("I hear you.\n\nComing back recharged after a birthday trip is a good place to start from.\n\nWhat made it land?") === "Coming back recharged after a birthday trip is a good place to start from.\n\nWhat made it land?");
check("a sentence that goes on ('I hear you, not just processing it.') is the model's to fix, not code's", L.dropStockSentences("Fair call, that one was flat. I hear you, not just processing it.") === "Fair call, that one was flat. I hear you, not just processing it.");
check("a reply that is only stock is left whole, never emptied", L.dropStockSentences("I hear you.") === "I hear you." && L.dropStockSentences("Makes sense.") === "Makes sense.");
check("a reply with no stock sentence is untouched, byte for byte", L.dropStockSentences("Happy belated birthday.\n\nWhat felt different this time?") === "Happy belated birthday.\n\nWhat felt different this time?");
check("the call's stock lines still caught (unchanged)", ["I hear you.", "That's a lot to carry.", "Thank you for sharing that."].every((x) => L.stockLine(x) !== null));

// ---- Wiring ----
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
check("every text reply passes the stock filter after the reply check; a voice note never does (review of #310)", /const final = dropRepeatedQuestion\(result\.final, input\.recentConversation\);\s+return capitalizeSentences\(input\.isVoice \? final : dropStockSentences\(final\)\);/.test(src("agent/conversationReply.ts")));
check("a leading ellipsis is kept when a stock sentence is dropped (review of #310)", L.dropStockSentences("... I hear you. That's a lot to come back to.") === "... That's a lot to come back to." && L.dropStockSentences("...\n\nI hear you.\n\nGlad you're back.") === "...\n\nGlad you're back.");
// Review of #310, then scoped (Royce 2026-10-29): the global follow-up bullets are co-test's; the sharing guide says a complete moment
// needs no question and overrides them on its turn. No flow variant left.
const RP2 = src("agent/conversationReply.ts");
check("the global follow-up bullets are co-test's, and the sharing guide carries the complete-moment rule", /When they say something concrete about what they want or who they're looking for, ask one specific follow-up that sharpens it\./.test(RP2) && /When the moment is complete, a short warm line is the whole reply/.test(G));
check("no flow variant left", !/systemFlow|REPLY_PROMPT/.test(RP2));
check("the moment guidance reaches the reply as an instruction", /const momentNote = momentInstruction\(moment\);\s+if \(momentNote\) addInstruction\(replyFacts, momentNote\);/.test(src("routes/sendblue.ts")));

console.log(`reply share guide: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
