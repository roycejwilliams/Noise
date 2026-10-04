// Model-free checks for voice flags (services/voiceFlags.ts, 2026-10-03): the
// gate, checking Gemini's answer against the call, what Co sees, and the
// wiring. No API calls, no database:
//   npx tsx evals/voiceFlags/rules.ts
import { readFileSync } from "fs";
import { callerLines, checkFlags, quoteFromCaller, renderVoiceFlags, transcriptForListening, voiceFlagsAllowed, VOICE_FLAG } from "../../src/services/voiceFlags.js";
import { renderEmotionalContext, summarizeSignals } from "../../src/harness/emotion.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

// Gate: test numbers only, only with VOICE_FLAGS=test and a key, never in production.
const TEST = "+14155550123";
const REAL = "+14155551234";
const env = (e: Record<string, string>) => ({ RAILWAY_ENVIRONMENT_NAME: "dev", CO_GEMINI_KEY: "k", ...e }) as NodeJS.ProcessEnv;
check("runs for a test number with VOICE_FLAGS=test", voiceFlagsAllowed(TEST, env({ VOICE_FLAGS: "test" })));
check("never for a real member's number", !voiceFlagsAllowed(REAL, env({ VOICE_FLAGS: "test" })));
check("off by default", !voiceFlagsAllowed(TEST, env({})));
check("there's no 'on' that reaches members", !voiceFlagsAllowed(REAL, env({ VOICE_FLAGS: "on" })) && !voiceFlagsAllowed(TEST, env({ VOICE_FLAGS: "on" })));
check("never in production, even for a test number", !voiceFlagsAllowed(TEST, env({ VOICE_FLAGS: "test", RAILWAY_ENVIRONMENT_NAME: "production" })));
check("not without a Gemini key", !voiceFlagsAllowed(TEST, env({ VOICE_FLAGS: "test", CO_GEMINI_KEY: "" })));

// The call.
const turns = [
  { role: "agent", message: "Hey Jordan, it's Co. How's the week going?", time_in_call_secs: 0 },
  { role: "user", message: "Yeah, I'm fine. Work's been good.", time_in_call_secs: 4 },
  { role: "agent", message: "Good. Anything on your mind?", time_in_call_secs: 9 },
  { role: "user", message: "Oh, the launch got pushed again. Perfect, just perfect.", time_in_call_secs: 12 },
  { role: "user", message: "", time_in_call_secs: 15 },
];
const lines = callerLines(turns);
check("only the caller's lines, with their times", lines.length === 2 && lines[0].atSecs === 4 && lines[1].text.startsWith("Oh, the launch"));
const t = transcriptForListening(turns);
check("the transcript Gemini reads marks Caller and Co with times", /\[0:04\] Caller: Yeah, I'm fine/.test(t) && /\[0:00\] Co: Hey Jordan/.test(t) && !/Caller: $/m.test(t));
check("a quote counts when it's the caller's words, re-punctuated", !!quoteFromCaller("yeah im fine", lines) && !!quoteFromCaller("Perfect, just perfect", lines));
check("Co's words or invented words don't count as the caller's", !quoteFromCaller("How's the week going", lines) && !quoteFromCaller("I'm devastated about it", lines));
// Review of #60: whole words, in order, and what's kept is what they said.
const L = (text: string) => [{ atSecs: 0, text }];
check("whole words only: 'no' isn't in 'I know', 'fine' isn't in 'finest'", !quoteFromCaller("no", L("I know")) && !quoteFromCaller("fine", L("the finest day")));
check("a reworded quote that flips the meaning doesn't match", !quoteFromCaller("I'm not fine", L("I'm fine, not bad")) && !quoteFromCaller("i love it", L("I hate it, I don't love the job")));
check("the caller's own words come back, not Gemini's", quoteFromCaller("i am fine with how the launch is going", L("Honestly I am not fine with how the launch is going, man."))?.said === "I am not fine with how the launch is going,");
check("scattered words across a long line don't count", !quoteFromCaller("fine work good week", L("It's fine. Anyway the work stuff is a whole thing, and honestly it's been a good, long, strange week")));

const flag = (o: Record<string, unknown>) => ({ at: 4, quote: "Yeah, I'm fine.", cue: "sigh", feeling: "worn down", valence: "negative", reading: "heavy sigh before", confidence: 0.9, ...o });
const out = checkFlags(
  {
    flags: [
      flag({}),
      flag({ quote: "Perfect, just perfect", cue: "sarcasm", feeling: "frustrated", confidence: 0.85 }),
      flag({ quote: "I'm devastated", confidence: 0.95 }),
      flag({ cue: "angry_tone" }),
      flag({ confidence: 0.4 }),
      flag({ feeling: "" }),
    ],
  },
  lines,
);
check("a sure flag on the caller's own words is kept", out[0].kept && out[1].kept);
const flipped = checkFlags({ flags: [flag({ quote: "Yeah I'm fine", confidence: 0.9 })] }, [{ atSecs: 0, text: "Yeah, I'm not... I'm fine." }]);
check("a kept flag carries the caller's words, not Gemini's", flipped[0].kept && flipped[0].quote !== "Yeah I'm fine" && /I'm fine/.test(flipped[0].quote));
const dup = checkFlags({ flags: [flag({ confidence: 0.8 }), flag({ quote: "yeah im fine", confidence: 0.9 })] }, lines);
check("two flags on the same words: only the surer is kept", dup.filter((f) => f.kept).length === 1 && dup[1].kept && /same words/.test(dup[0].dropReason ?? ""));
check("a quote the caller never said is dropped, with why", !out[2].kept && /caller said/.test(out[2].dropReason ?? ""));
check("anything but the four cues is dropped", !out[3].kept && /four cues/.test(out[3].dropReason ?? ""));
check("an unsure flag is dropped and kept for the audit", !out[4].kept && /below/.test(out[4].dropReason ?? ""));
check("a flag with no feeling is dropped", !out[5].kept);
const four = ["one two three", "four five six", "seven eight nine", "ten eleven twelve"];
const manyLines = four.map((text) => ({ atSecs: 0, text }));
const many = checkFlags({ flags: [0.71, 0.99, 0.8, 0.9].map((c, i) => flag({ confidence: c, quote: four[i] })) }, manyLines);
check(`at most ${VOICE_FLAG.maxKept} kept, the surest`, many.filter((f) => f.kept).length === VOICE_FLAG.maxKept && !many[0].kept && /surest/.test(many[0].dropReason ?? ""));
check("a malformed answer raises nothing", checkFlags(null, lines).length === 0 && checkFlags({ flags: "x" }, lines).length === 0);
check("confidence is clamped to 0..1", checkFlags({ flags: [flag({ confidence: 7 })] }, lines)[0].confidence === 1);

// What Co sees: beside the text read, never naming it back.
const shown = { at: new Date("2026-10-03T18:00:00Z"), flags: [{ quote: "Yeah, I'm fine.", cue: "sigh" as const, feeling: "worn down", reading: "" }] };
const line = renderVoiceFlags(shown, "2 hours ago") ?? "";
check("Co reads what the voice added, on what words", /sighed when they said "Yeah, I'm fine\." \(worn down\)/.test(line) && /On your call 2 hours ago/.test(line));
check("framed as one read, never named back", /one read of their tone/.test(line) && /never name it back/.test(line));
check("nothing to show, no line", renderVoiceFlags(null, "now") === null && renderVoiceFlags({ at: new Date(), flags: [] }, "now") === null);
const now = new Date("2026-10-03T20:00:00Z");
const callRead = [{ source: "call" as const, emotion: "stressed", intensity: "medium" as const, valence: "negative" as const, about: "the launch", quote: "the launch got pushed", at: new Date("2026-10-03T18:00:00Z") }];
const ctx = { ...summarizeSignals(callRead, now), voice: shown };
const rendered = renderEmotionalContext(ctx, now);
check("the text read's call line and the voice line both show", /their voice showed: stressed/.test(rendered) && /their voice said more than their words/.test(rendered));
const noVoice = summarizeSignals(callRead, now);
check("voice flags change nothing else Co computes (care, recurring, current)", JSON.stringify(summarizeSignals(callRead, now)) === JSON.stringify(noVoice) && renderEmotionalContext(noVoice, now) === rendered.split("\n").filter((l) => !/said more than their words/.test(l)).join("\n"));

// Wiring.
const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
const post = co.slice(co.indexOf('event.type !== "post_call_transcription"'));
check("runs after the call is processed, only on a real conversation, never awaited", post.indexOf("flagVoiceMoments(") > post.indexOf("await processEndedCall(") && post.indexOf("flagVoiceMoments(") > post.indexOf("if (kind && u[0])") && /flagVoiceMoments\(\{[^)]*\}\)\.catch\(\(\) => \{\}\)/.test(post) && !/await flagVoiceMoments/.test(post));
const vf = readFileSync(new URL("../../src/services/voiceFlags.ts", import.meta.url), "utf8");
check("once per call: the run is claimed by conversation id", /ON CONFLICT \(conversation_id\) DO UPDATE/.test(vf) && /RETURNING conversation_id/.test(vf) && /if \(!claimed\.rows\.length\) return;/.test(vf));
check("the audio fetch can't hang a run (timeout)", /signal: AbortSignal\.timeout\(VOICE_FLAG\.audioTimeoutMs\)/.test(vf));
check("a run cut off mid-pass can be taken over later, not before", /DO UPDATE SET status = 'running'[\s\S]*WHERE voice_flag_runs\.status = 'running' AND voice_flag_runs\.created_at < NOW\(\)/.test(vf));
check("Gemini's raw answer is kept on the run, and an empty answer says why", /raw = \$8::jsonb/.test(vf) && /raw = await listenForFlags/.test(vf) && /finishReason/.test(vf));
check("every flag is logged, kept or dropped, with why", /INSERT INTO voice_flags[\s\S]*kept, drop_reason/.test(vf) && /flags\.map\(\(f\) => \(\{[^}]*kept: f\.kept, drop_reason: f\.dropReason/.test(vf));
check("every pass is logged, including no audio, too long and failures", ["no_audio", "too_long", "failed", "done"].every((s) => vf.includes(`"${s}"`)));
check("flags never go into emotion_signals (the sweep and threads read it)", !/emotion_signals/.test(vf.replace(/^\/\/.*$/gm, "")));
const mig = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
check("the tables exist", /CREATE TABLE IF NOT EXISTS voice_flag_runs/.test(mig) && /CREATE TABLE IF NOT EXISTS voice_flags/.test(mig) && /ALTER TABLE voice_flag_runs ADD COLUMN IF NOT EXISTS raw JSONB/.test(mig));

console.log(`voice flag rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
