// Model-free checks for message rhythm, coaching and the brand rule (services/textRhythm.ts, beats.ts,
// brandGuard.ts, coTasks.ts isYesToOffer): what Co's texts are told, how a reply is split, that a yes can
// start the check-in, and that the brand holds in what goes out. No API calls, no database:
//   npx tsx evals/rhythm/rules.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const R = await import("../../src/services/textRhythm.js");
const B = await import("../../src/services/beats.js");
const T = await import("../../src/services/coTasks.js");
const { brandSafe } = await import("../../src/services/brandGuard.js");
const { SEND_LIMIT } = await import("../../src/services/sendLimiter.js");
const { CO_VOICE } = await import("../../src/services/coVoice.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

// ---- what Co is told matches how the code sends
check("rhythm: each paragraph is its own message, one beat each, never a wall", /Each paragraph you write is sent as its own message/.test(R.MESSAGE_RHYTHM) && /One paragraph is one beat: a fact, a step, a piece of advice, a question/.test(R.MESSAGE_RHYTHM) && /never write a wall/.test(R.MESSAGE_RHYTHM));
check("rhythm: one to three short sentences each, most replies one to three messages", /one to three short sentences/.test(R.MESSAGE_RHYTHM) && /Most replies are one to three messages; four or five only when each one earns its place/.test(R.MESSAGE_RHYTHM));
check("rhythm: a question is its own last paragraph, one per reply", /A question to them is its own last paragraph/.test(R.MESSAGE_RHYTHM) && /One question per reply/.test(R.MESSAGE_RHYTHM));
check("rhythm: decide whether another message is needed; one when one covers it", /decide whether it is needed/.test(R.MESSAGE_RHYTHM) && /When one short message covers it, send one/.test(R.MESSAGE_RHYTHM));
check("rhythm says nothing that can't happen: no 'several paragraphs in one message'", !/one to three short paragraphs|stack four or more/.test(R.MESSAGE_RHYTHM) && !/Several short messages by default/.test(R.MESSAGE_RHYTHM));
check("coaching: lines, not lectures; the two or three that matter most", /Lines, not lectures/.test(R.COACHING) && /exact sentences they can say/.test(R.COACHING) && /the two or three lines that matter most/.test(R.COACHING));
check("coaching: ask first only when Cue hasn't asked and they haven't asked for direction; acknowledge, one question, no advice yet", /Ask first, advise second, when they bring you a problem with an emotional stake and you haven't asked yet and they haven't asked you for direction/.test(R.COACHING) && /Acknowledge it in one line, then ask what most shapes the right advice/.test(R.COACHING) && !/the one question/.test(R.COACHING) && /give no advice yet/.test(R.COACHING));
check("coaching: once asked, or when they ask what to do, advise; never make them ask twice", /Once you've asked, or they ask what to do, advise; never make them ask twice/.test(R.COACHING));
check("coaching: the follow-up offer is the last message and a yes starts a task", /one short line offering to check in after that moment, as its own final message/.test(R.COACHING) && /That offer is the last message, in place of any further question/.test(R.COACHING) && /startTask/.test(R.COACHING));
check("coaching: safety comes first, the question or lines after, never instead", /None of this holds if they may not be safe: follow the safety guidance first/.test(R.COACHING) && /never instead/.test(R.COACHING));
check("the call version carries the same two carve-outs", /you haven't asked yet and they haven't asked you for direction/.test(R.CALL_COACHING) && /never a question in place of one/.test(R.CALL_COACHING) && /the safety rules come first/.test(R.CALL_COACHING) && !/startTask/.test(R.CALL_COACHING));
check("no block uses an em dash or exclamation point, or quotes an example sentence", ![R.MESSAGE_RHYTHM, R.COACHING, R.CALL_COACHING, R.BRAND].some((t) => /[—–!]/.test(t) || /"[^"]*\?"/.test(t)));
check("none promises anything Cue can't do on its own", [R.MESSAGE_RHYTHM, R.COACHING, R.CALL_COACHING].every((t) => !/\b(?:I'll|I will) /.test(t)));

// ---- where they go
const reply = read("src/agent/conversationReply.ts");
check("texts get the rhythm and the coaching, after Cue's shared core and the moves", /\$\{CO_CORE\}\n\n\$\{MOVES_GUIDE\}\n\n\$\{MESSAGE_RHYTHM\}\n\n\$\{COACHING\}/.test(reply));
check("the rhythm is for texts only: not in the call prompt or in proactive drafts", !/MESSAGE_RHYTHM/.test(read("src/services/elevenLabsCalls.ts")) && !/MESSAGE_RHYTHM/.test(read("src/harness/proactive.ts")));
check("a call gets the spoken coaching and the brand, after the variety guide and before the guardrails", /\$\{VARIETY_GUIDE\}\\n\\n\$\{CALL_COACHING\}\\n\\n\$\{BRAND\}\\n\\n\$\{CALL_GUIDE\}\\n\\n\$\{CAPABILITY_SHEET\}\\n\\n\$\{CALL_NOW\}\\n\\n\$\{callGuardrails\(\)\}/.test(read("src/services/elevenLabsCalls.ts")));
check("the send tool says a question is its own last paragraph, splits only where it helps (2026-11-10: no beat quota), and the offer before a coming moment", /A question to them, when there is one, is its own last paragraph/.test(read("src/agent/conversationTools.ts")) && /keep one connected explanation or a set of steps in one paragraph/.test(read("src/agent/conversationTools.ts")) && /the last paragraph is the offer to check in after it, not another question/.test(read("src/agent/conversationTools.ts")));
check("the ability text agrees: each paragraph already goes out as its own text", /each paragraph in it already goes out as its own text/.test(read("src/services/capabilities.ts")) && !/never call it twice just to split one continuous thought into shorter pieces/.test(read("src/services/capabilities.ts")));
check("Cue's shared core (texts and calls) keeps the no-announcement line, with room for a check-in they said yes to", /Never announce a check-in you decide to make on your own/.test(read("src/services/coCore.ts")) && /A check-in they said yes to is theirs/.test(read("src/services/coCore.ts")));

// ---- a yes can start the check-in task
const offer = "I can check in after tomorrow's coffee, if you want. Want me to?";
for (const y of ["yes", "Yes!", "yeah", "yep", "sure", "ok", "okay", "please", "yes please", "sounds good", "go ahead"]) check(`a yes to Cue's check-in offer counts: ${y}`, T.isYesToOffer(y, offer));
check("but only to an offer: not after a statement, a question about something else, or no offer at all", !T.isYesToOffer("yes", "Coffee tomorrow is the right setting.") && !T.isYesToOffer("yes", "Is it the number that's got you?") && !T.isYesToOffer("yes", null));
check("and only a bare yes: a longer message needs its own words", !T.isYesToOffer("yes but not tomorrow", offer) && !T.isYesToOffer("no", offer) && !T.isYesToOffer("sure, how long would it take", offer));
check("the task start accepts it, and stores what they said yes to", /T\.isYesToOffer\(ctx\.resolvedContent, ctx\.lastCoMessage\)/.test(read("src/agent/conversationTools.ts")) && /\(to Cue's offer:/.test(read("src/agent/conversationTools.ts")));
check("a bare yes alone is still no quote: the old check is untouched", T.wordsAreTheirs("yes", "yes") === false);

// ---- how a reply is split
check("two beats stay two, three stay three, up to five each go alone", B.toBeats("Got it.\n\nHere's the step.").length === 2 && B.toBeats("a\n\nb\n\nc").length === 3 && B.toBeats("a\n\nb\n\nc\n\nd\n\ne").length === 5 && B.MAX_BEATS === 5);
check("never four paragraphs in one message, at any length up to fifteen", Array.from({ length: 15 }, (_, i) => i + 6).every((n) => B.toBeats(Array.from({ length: n }, (_, i) => `p${i}`).join("\n\n")).every((m) => m.split(/\n\s*\n/).length <= Math.ceil(n / 5))));
check("nine paragraphs spread evenly, not four alone and five together", B.toBeats("a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng\n\nh\n\ni").map((m) => m.split("\n\n").length).join() === "2,2,2,2,1");
check("a closing question goes alone after spreading the rest", (() => { const b = B.toBeats("a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng\n\nh\n\nWhat do you want to do?"); return b[b.length - 1] === "What do you want to do?" && b.length === 5 && b.slice(0, -1).every((m) => m.split("\n\n").length <= 2); })());
for (const q of ['Do you want "the long one"?', "Do you want “the long one?”", "Which one feels right? 🙂", "What do you think? Either way works.", "Is that fair?)", "Ready? 🙂👍"]) {
  check(`a closing question rides alone in any form: ${q}`, B.toBeats(`a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng\n\nh\n\ni\n\n${q}`).slice(-1)[0] === q);
}
check("nothing is lost or reordered by splitting", (() => { const src = "a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng\n\nWhy?"; return B.toBeats(src).join("\n\n") === src; })());
check("one line stays one message, and blank input never throws", B.toBeats("one line").length === 1 && B.toBeats("   ").length === 1);

// ---- the send breaker fits five-message replies
check("one busy search turn (a looking line, three links, two replies of five) stays under the unprompted limit", 1 + 3 + 5 + 5 <= SEND_LIMIT.unprompted && SEND_LIMIT.max >= SEND_LIMIT.unprompted * 2);

// ---- the brand holds in what goes out
check("the old names become Noise in anything Cue says", brandSafe("CoPatible LLC owns it, formerly BR3W.") === "Noise LLC owns it, formerly Noise.");
check("whole words only, any case", brandSafe("copatible and BR3w") === "Noise and Noise" && brandSafe("compatible with the plan") === "compatible with the plan");
check("real history the member brings up can be said back", brandSafe("Back when it was BR3W, yes.", "I remember when it was BR3W") === "Back when it was BR3W, yes." && brandSafe("CoPatible too", "I remember when it was BR3W") === "Noise too");
check("it runs on every reply and every proactive draft", /brandSafe\(ctx\.gate \? await ctx\.gate\(draft, \[\.\.\.state\.sentMessages\], answeredSent\(\), findsWaitingNow\) : draft, ctx\.resolvedContent\)/.test(read("src/agent/conversationTools.ts")) && /brandSafe\(cleanCoMessage\(trimmed\)\)/.test(read("src/harness/proactive.ts")));
check("Cue's voice says the company is Noise, and never names the retired word", /The company is Noise, in any talk, legal or about IP included/.test(CO_VOICE) && !/BR3W|CoPatible/.test(CO_VOICE + R.BRAND + R.MESSAGE_RHYTHM + R.COACHING + R.CALL_COACHING));

console.log(`rhythm rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
