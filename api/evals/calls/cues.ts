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
const { promptForElevenLabs, transcriptFromHistory, transcriptFromTurns } = await import("../../src/services/elevenLabsCalls.js");
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

// Never in a transcript Co stores, never in a text.
const turns = [
  { role: "agent", message: "[warmly] Hey Jordan, it's Co." },
  { role: "user", message: "Hey. Rough week, honestly." },
  { role: "agent", message: "[softly] I'm sorry. What happened?" },
  { role: "agent", message: "[laughs]" },
];
const t = transcriptFromTurns(turns);
check("the stored transcript has no cues", !/\[[a-z]/.test(t) && /assistant: Hey Jordan, it's Co\./.test(t) && /assistant: I'm sorry\. What happened\?/.test(t));
check("a line that was only a cue leaves no empty line", t.split("\n").length === 3);
check("the caller's words are untouched", /user: Hey\. Rough week, honestly\./.test(t));
check("the live conversation history is stripped too", !/\[softly\]/.test(transcriptFromHistory(JSON.stringify(turns))));
check("a text never carries a cue (cleanCoMessage, every send)", cleanCoMessage("[warmly] Glad you made it. [softly] Talk soon.") === "Glad you made it. Talk soon.");

// The guide reaches the call prompt only.
check("the call prompt carries the cue guide", promptForElevenLabs("You are Co.").includes(CUE_GUIDE));
check("the guide names exactly the allowed cues, at most one, most replies none", VOICE_CUES.every((c) => CUE_GUIDE.includes(`[${c}]`)) && /Most replies have no cue\. Never more than one in a reply\./.test(CUE_GUIDE));
check("the guide keeps Co's voice and the no-label rule", /never theatrical, never flirtatious/.test(CUE_GUIDE) && /never name it/.test(CUE_GUIDE) && /never said aloud/.test(CUE_GUIDE) && /mirror/.test(CUE_GUIDE));
const persona = readFileSync(new URL("../../src/services/coPersona.ts", import.meta.url), "utf8");
check("Co's text persona never gets the cue guide", !/CUE_GUIDE|promptForElevenLabs|voiceCues/.test(persona));

// The audit.
const a = cueAudit(["[warmly] Hey Jordan.", "What's going on?", "[softly] [laughs] Okay.", "[sighs] Right.", ""]);
check("the audit counts replies, cued replies and each cue", a.replies === 4 && a.cued === 3 && a.cues.warmly === 1 && a.cues.sighs === 1);
check("the audit flags cues outside the set and replies with more than one", JSON.stringify(a.outside) === JSON.stringify(["sighs"]) && a.overOne === 1);
const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
const post = co.slice(co.indexOf('event.type !== "post_call_transcription"'));
check("every call with a cue is audited after it ends, never failing the webhook", /const cueUse = cueAudit\(turns\.filter/.test(post) && /if \(cueUse\.cued\) recordDecision\(\{[^}]*decision: "call\.cues"/.test(post) && /cue_rules_broken/.test(post) && /proposal: \{ conversationId, \.\.\.cueUse \} \}\)\.catch\(\(\) => \{\}\)/.test(post));

console.log(`voice cue rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
