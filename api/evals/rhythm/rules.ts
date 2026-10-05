// Model-free checks for message rhythm, coaching and the brand rule (services/textRhythm.ts, beats.ts):
// what Co's texts are told, how a reply is split, and that the tools agree. No API calls, no database:
//   npx tsx evals/rhythm/rules.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const R = await import("../../src/services/textRhythm.js");
const B = await import("../../src/services/beats.js");
const { CO_VOICE } = await import("../../src/services/coVoice.js");
const { promiseSentence } = await import("../../src/services/promises.js");

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

// ---- the three blocks say what was asked
check("rhythm: several short messages by default, one beat each", /Several short messages by default/.test(R.MESSAGE_RHYTHM) && /A beat is one move: a fact, a step, a piece of advice, a question/.test(R.MESSAGE_RHYTHM));
check("rhythm: never four paragraphs in one message", /Never stack four or more paragraphs into one message/.test(R.MESSAGE_RHYTHM));
check("rhythm: one to three short paragraphs, most one or two sentences", /one to three short paragraphs at most, and most are one or two sentences/.test(R.MESSAGE_RHYTHM));
check("rhythm: a question rides alone, last", /A question to them rides alone, as its own last message/.test(R.MESSAGE_RHYTHM));
check("rhythm: most replies are one to three messages, one question per reply", /Most replies are one to three messages; four or five only when each one earns its place/.test(R.MESSAGE_RHYTHM) && /One question per reply/.test(R.MESSAGE_RHYTHM) && /never buried at the bottom of a wall or at the end of another paragraph/.test(R.MESSAGE_RHYTHM));
check("coaching: after the lines, the follow-up offer is the last message instead of another question", /That offer is the last message, in place of any further question/.test(R.COACHING) && /one line of framing, the two or three lines they can say, then one short line offering to check in/.test(R.COACHING) && !/"[^"]*\?"/.test(R.COACHING));
check("the send tool says it where the last paragraph is chosen", /the last paragraph is the offer to check in after it, not another question/.test(read("src/agent/conversationTools.ts")));
check("rhythm: decide whether another message is needed before sending it", /decide whether it is actually needed/.test(R.MESSAGE_RHYTHM) && /When one short message covers it, send one/.test(R.MESSAGE_RHYTHM));
check("coaching: lines, not lectures; one sentence of framing, then the words", /Lines, not lectures/.test(R.COACHING) && /exact sentences they can say/.test(R.COACHING) && /one sentence, then the words/.test(R.COACHING));
check("coaching: ask first, advise second, the one question that shapes the advice", /Ask first, advise second/.test(R.COACHING) && /the one question that most shapes the right advice and stop there: that reply is the question, no advice yet/.test(R.COACHING));
check("coaching: offer the follow-up as its own last message; yes starts a real task", /one short line offering to check in after that moment, as its own final message/.test(R.COACHING) && /startTask/.test(R.COACHING));
check("the follow-up it offers is a thing Co can do: startTask exists and is a Co ability", /id: "task_start"/.test(read("src/services/capabilities.ts")));
check("brand: Co, never CoPatible or BR3W, even in legal or IP talk", /Never "CoPatible"/.test(R.BRAND) && /never "BR3W"/.test(R.BRAND) && /legal or about IP/.test(R.BRAND) && /real history they bring up themselves/.test(R.BRAND));
check("brand: in the voice of every text, proactive ones too", /never "CoPatible" and never "BR3W", even when the talk is legal or about IP/.test(CO_VOICE));
check("none of the blocks uses an em dash or an exclamation point", ![R.MESSAGE_RHYTHM, R.COACHING, R.BRAND, R.CALL_COACHING].some((t) => /[—–!]/.test(t)));
check("none promises anything Co can't do on its own", [R.MESSAGE_RHYTHM, R.COACHING, R.CALL_COACHING].every((t) => !/\b(?:I'll|I will) /.test(t)) && promiseSentence(R.COACHING) === null);

// ---- where they go
const reply = read("src/agent/conversationReply.ts");
check("texts get the rhythm and the coaching, after the listening guide", /\$\{TEXT_LISTENING\}\n\n\$\{MESSAGE_RHYTHM\}\n\n\$\{COACHING\}/.test(reply));
check("the rhythm is for texts only: not in the call prompt or in proactive drafts", !/MESSAGE_RHYTHM/.test(read("src/services/elevenLabsCalls.ts")) && !/MESSAGE_RHYTHM/.test(read("src/harness/proactive.ts")));
const calls = read("src/services/elevenLabsCalls.ts");
check("a call gets the two spoken coaching rules and the brand, not the task offer", /\$\{CALL_COACHING\}\\n\\n\$\{BRAND\}/.test(calls) && !/startTask/.test(R.CALL_COACHING) && /Ask first, advise second/.test(R.CALL_COACHING));
check("the send tool's wording agrees: a question is its own last paragraph, up to five beats", /A question to them is always its own last paragraph/.test(read("src/agent/conversationTools.ts")) && /up to five when each earns its place/.test(read("src/agent/conversationTools.ts")));
check("the ability text no longer says most replies should never be split", /each paragraph in it already goes out as its own text/.test(read("src/services/capabilities.ts")) && !/never call it twice just to split one continuous thought into shorter pieces/.test(read("src/services/capabilities.ts")));

// ---- how a reply is split
check("two beats stay two, three stay three", B.toBeats("Got it.\n\nHere's the step.").length === 2 && B.toBeats("a\n\nb\n\nc").length === 3);
check("up to five beats each go alone", B.toBeats("a\n\nb\n\nc\n\nd\n\ne").length === 5 && B.MAX_BEATS === 5);
check("never four paragraphs stacked into one message", B.toBeats("a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng").every((m) => m.split(/\n\s*\n/).length <= 3));
check("a long reply's closing question still goes alone", (() => {
  const beats = B.toBeats("a\n\nb\n\nc\n\nd\n\ne\n\nf\n\nWhat do you want to do?");
  return beats[beats.length - 1] === "What do you want to do?" && beats.length === 5;
})());
check("a closing question in curly or quoted form still rides alone", (() => B.toBeats('a\n\nb\n\nc\n\nd\n\ne\n\nf\n\nDo you want "the long one"?').slice(-1)[0] === 'Do you want "the long one"?')());
check("without a question the last bubble holds the tail", (() => { const b = B.toBeats("a\n\nb\n\nc\n\nd\n\ne\n\nf"); return b.length === 5 && b[4] === "e\n\nf"; })());
check("nothing is lost or reordered by splitting", (() => { const src = "a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng\n\nWhy?"; return B.toBeats(src).join("\n\n") === src; })());
check("one line stays one message, and blank input never throws", B.toBeats("one line").length === 1 && B.toBeats("   ").length === 1);

console.log(`rhythm rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
