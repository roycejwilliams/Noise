// Model-free checks for Co's voice cues on calls (services/voiceCues.ts,
// 2026-10-04): the allowed set, one per reply, cues never in transcripts or
// texts, and the post-call audit. No API calls, no database:
//   npx tsx evals/calls/cues.ts
import { readFileSync } from "fs";
import { CUE_GUIDE, cueAudit, cuesIn, MAX_CUES_PER_REPLY, stripCues, VOICE_CUES } from "../../src/services/voiceCues.js";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { OPENING_NOTE, promptForElevenLabs, transcriptFromHistory, transcriptFromTurns } = await import("../../src/services/elevenLabsCalls.js");
const { cleanCoMessage } = await import("../../src/services/sendblue.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

// The set, chosen for Co's voice.
check("the allowed set is warmly, softly, thoughtful, laughs", JSON.stringify([...VOICE_CUES]) === JSON.stringify(["warmly", "softly", "thoughtful", "laughs"]));
check("no theatrical or weary cues in the set", !["sighs", "excited", "whispers", "shouting", "flirtatious"].some((c) => (VOICE_CUES as readonly string[]).includes(c)));
check("one cue per reply at most", MAX_CUES_PER_REPLY === 1);

// Parsing and stripping.
check("cues are found in order", JSON.stringify(cuesIn("[softly] That sounds like a lot. [thoughtful] What helped?")) === JSON.stringify(["softly", "thoughtful"]));
check("a cue comes out cleanly, spacing and punctuation tidy", stripCues("[softly] That sounds like a lot.") === "That sounds like a lot." && stripCues("Okay [laughs] , fair.") === "Okay, fair.");
check("a cue outside the set is stripped too, up to three words", stripCues("[sighs] Yeah.") === "Yeah." && stripCues("[low steady voice] Okay.") === "Okay.");
check("capitalized brackets (an event name) are left alone", stripCues("Tickets for [SOLD OUT] Gala") === "Tickets for [SOLD OUT] Gala");
// Review of #62: a text only loses known cues, standing as their own word.
// Kept through the real send path (cleanCoMessage), bracket and all.
const keeps = (x: string, part: string) => cleanCoMessage(x).includes(part) && stripCues(x, "known") === x;
check("a link's query brackets are never touched", keeps("https://lu.ma/e?filter[city]=sf&page[size]=10", "filter[city]=sf&page[size]=10"));
check("a markdown-style link is never touched", keeps("RSVP [here](https://lu.ma/abc)", "[here](https://lu.ma/abc)"));
check("a lowercase event tag or placeholder in a text is never touched", keeps("Dinner [members only] Friday", "[members only]") && keeps("Tickets: [sold out] Gala", "[sold out]") && keeps("Hi [name], welcome.", "[name]"));
check("quoted text keeps its brackets", keeps('She said "[laughs] no way" and left.', '"[laughs] no way"'));
check("no tidy when nothing was removed (spacing and numbers untouched)", stripCues("Pay 4 .5 now.  Two spaces stay.", "known") === "Pay 4 .5 now.  Two spaces stay." && stripCues("a[warmly]b", "known") === "a[warmly]b");
check("a known stray cue is still stripped from a text", cleanCoMessage("[sighs] Okay, talk soon.") === "Okay, talk soon.");
check("only a line that lost a cue is tidied (an indented list keeps its indent)", stripCues("  - item one\n[softly] ok", "known") === "  - item one\nok");
check("the prompt line after the guide starts its own paragraph", /\n\nShort sentences, one thought each/.test(promptForElevenLabs(readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8"))));

// Never in a transcript Co stores, never in a text.
const turns = [
  { role: "agent", message: "[warmly] Hey Jordan, it's Cue." },
  { role: "user", message: "Hey. Rough week, honestly." },
  { role: "agent", message: "[softly] I'm sorry. What happened?" },
  { role: "agent", message: "[laughs]" },
];
const t = transcriptFromTurns(turns);
check("the stored transcript has no cues", !/\[[a-z]/.test(t) && /assistant: Hey Jordan, it's Cue\./.test(t) && /assistant: I'm sorry\. What happened\?/.test(t));
check("a line that was only a cue leaves no empty line", t.split("\n").length === 3);
check("the caller's words are untouched", /user: Hey\. Rough week, honestly\./.test(t));
check("the live conversation history is stripped too", !/\[softly\]/.test(transcriptFromHistory(JSON.stringify(turns))));
check("a text never carries a cue (cleanCoMessage, every send)", cleanCoMessage("[warmly] Glad you made it. [softly] Talk soon.") === "Glad you made it. Talk soon.");

// The guide reaches the call prompt only.
check("the call prompt carries the cue guide", promptForElevenLabs("You are Cue.").includes(CUE_GUIDE));
const realPrompt = readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const callPrompt = promptForElevenLabs(realPrompt);
check("in the real call prompt the guide sits in How you sound, with the spoken-aloud exception, before the opening note", callPrompt.includes("Everything you write is spoken aloud, except a cue in square brackets (below).") && callPrompt.indexOf(CUE_GUIDE) > callPrompt.indexOf("# On the phone") && callPrompt.indexOf(CUE_GUIDE) < callPrompt.indexOf("# What you know about") && callPrompt.trimEnd().endsWith(OPENING_NOTE));
check("the shared prompt file itself never mentions cues (texts read it)", !/square brackets|CUE|\[warmly\]/.test(realPrompt));
check("the guide names exactly the allowed cues, at most one, most replies none", VOICE_CUES.every((c) => CUE_GUIDE.includes(`[${c}]`)) && /Most replies have no cue, fewer than half\. Never more than one in a reply/.test(CUE_GUIDE));
check("the guide keeps Cue's voice and the no-label rule", /never theatrical, never flirtatious/.test(CUE_GUIDE) && /never name it/.test(CUE_GUIDE) && /never said aloud/.test(CUE_GUIDE) && /mirror/.test(CUE_GUIDE));
const persona = readFileSync(new URL("../../src/services/coPersona.ts", import.meta.url), "utf8");
check("Cue's text persona never gets the cue guide", !/CUE_GUIDE|promptForElevenLabs|voiceCues/.test(persona));

// The audit.
const a = cueAudit(["[warmly] Hey Jordan.", "What's going on?", "[softly] [laughs] Okay.", "[sighs] Right.", ""]);
check("the audit counts replies, cued replies and each cue", a.replies === 4 && a.cued === 3 && a.cues.warmly === 1 && a.cues.sighs === 1);
check("the audit flags cues outside the set and replies with more than one", JSON.stringify(a.outside) === JSON.stringify(["sighs"]) && a.overOne === 1);
const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
const post = co.slice(co.indexOf('event.type !== "post_call_transcription"'));
check("every call with a cue is audited after it ends, never failing the webhook", /const cueUse = cueAudit\(turns\.filter/.test(post) && /if \(cueUse\.cued\) recordDecision\(\{[^}]*decision: "call\.cues"/.test(post) && /cue_rules_broken/.test(post) && /proposal: \{ conversationId, \.\.\.cueUse \} \}\)\.catch\(\(\) => \{\}\)/.test(post));

console.log(`voice cue rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
