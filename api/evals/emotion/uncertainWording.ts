// Model-free checks that emotion scores and voice reads reach the model as uncertain context for delivery, never as proof, a
// diagnosis, or a reason to doubt what the member said (Royce, 2026-10-28). Wording only: what the reads decide (needsCare, the mood
// hold, safety) is untouched and tested elsewhere (evals/voiceRead/rules.ts, evals/emotion/callRules.ts). No API calls, no database:
//   npx tsx evals/emotion/uncertainWording.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const E = await import("../../src/harness/emotion.js");
const V = await import("../../src/services/voiceRead.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`, detail ?? "");
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// The text reply: both prompts (default and flow) introduce the reads as uncertain, for delivery, outranked by their words.
const reply = src("agent/conversationReply.ts");
const header = /How \$\{input\.firstName\} may have been feeling: reads of their recent texts and calls, plus a frustration score from calls\. Reads can be wrong: they shape how you say things, never what you claim, and their words outrank them\./g;
check("both reply prompts say the reads can be wrong, shape delivery only, and are outranked by their words", (reply.match(header) ?? []).length === 2);
check("the old header that read the score as their words is gone", !/their words, plus a frustration score from calls\):/.test(reply));
check("the reads are no longer where the reply starts from", !/Start from this\. Decide what they most need/.test(reply));
check("the redundant empty-read line is gone", !/If nothing notable is listed, just read the conversation\./.test(reply));
check("the no-diagnosis rule is kept in both prompts", /Never name or diagnose the feeling/.test(reply) && /without naming or diagnosing the feeling/.test(reply));

// The rendered reads: each line says it is a read.
const now = new Date("2026-10-28T18:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const text = { source: "text" as const, emotion: "stressed", intensity: "high" as const, valence: "negative" as const, about: "the launch", quote: null, at: ago(60), target: "life" as const, basis: null };
const score = { source: "call" as const, emotion: "frustrated", intensity: "high" as const, valence: "negative" as const, about: null, quote: "the venue fell through", at: ago(600), target: "life" as const, basis: "frustration_score" as const };
const atCue = { source: "text" as const, emotion: "frustrated", intensity: "high" as const, valence: "negative" as const, about: "the event picks", quote: null, at: ago(30), target: "co" as const, basis: null };
const rendered = E.renderEmotionalContext(E.summarizeSignals([text, score, atCue], now), now);
check("a text read is labeled a read", /Right now \(read from their texts, /.test(rendered), rendered);
check("a call moment (a frustration score reads words, not voice) is a read of the call, not what their voice showed", /a read of the call picked up: frustrated \(high\)/.test(rendered) && !/their voice showed/.test(rendered), rendered);
check("a hard day is a lean of the reads, not a fact", /The last day's reads point to a hard time\./.test(rendered) && !/They've been struggling/.test(rendered), rendered);
check("frustration with Cue is what the reads suggest, still pointed at Cue doing better", /Reads suggest they're frustrated with what Cue has turned up lately \(the event picks\)\. If so, that's about Cue, not a hard day in their life: look wider and try harder/.test(rendered), rendered);
check("the rendered reads name no diagnosis words", !/\b(?:diagnos\w*|disorder|depress\w*|anxiety disorder)\b/i.test(rendered));

// The call: the context's emotion heading (dynamic variable, filled per call).
check("the call context heads the reads as maybe-wrong, not something they told (the block above says to treat context as told)", /How they may have been feeling \(reads that can be wrong, not something they told you\):/.test(src("services/callContext.ts")));

// The live voice line on a call: every line is a maybe for delivery and never tells Cue to doubt their words.
const lines: string[] = [];
for (const d of V.VOICE_DIMS) {
  const read = { windows: 3, dims: { flat: 0, tight: 0, low: 0, sharp: 0, bright: 0, [d]: 0.9 }, strongest: d, score: 0.9 } as any;
  for (const w of ["I'm fine, all good", "We moved it to Thursday", "It's awful, I hate it"]) {
    const l = V.voiceLine(read, w, { noisy: false, safety: false }).line;
    if (l) lines.push(l);
  }
}
check("every kind of voice line was produced", lines.length === 10, lines.length);
check("the lead says the read can be wrong and never weighs against what they said", /can be wrong/.test(V.VOICE_LINE_LEAD) && /never whether you believe what they said/.test(V.VOICE_LINE_LEAD));
check("every voice line is a maybe", lines.every((l) => /\bmay\b/.test(l.slice(V.VOICE_LINE_LEAD.length))), lines);
check("no voice line tells Cue to doubt or override their words", lines.every((l) => !/face value|don't take|don't believe|really means|not what they say/i.test(l)), lines);
// A masked low mood still gets room (Royce, "emotion is everything"), as an offer, never a probe of the read.
check("flat and low mismatches still leave room for one open question", lines.filter((l) => /flatter than their words|lower than their words/.test(l)).length === 2 && lines.filter((l) => /flatter than their words|lower than their words/.test(l)).every((l) => /one open question/.test(l)), lines);
check("a safety call still gets no voice line", V.voiceLine({ windows: 3, dims: { flat: 0.9, tight: 0, low: 0, sharp: 0, bright: 0 }, strongest: "flat", score: 0.9 } as any, "I'm fine", { noisy: false, safety: true }).line === null);

console.log(`uncertainWording: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
