// Model-free checks for sighs and laughs on calls (services/callSounds.ts,
// 2026-10-04): matching Scribe's tags to the caller's own lines (never Co's),
// recording them as sounds, never feelings, and the wiring. No API calls, no
// database:
//   npx tsx evals/calls/sounds.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const { CALL_SOUNDS, callSoundsOn, soundMoments, soundOf, soundSignals } = await import("../../src/services/callSounds.js");
const { summarizeSignals } = await import("../../src/harness/emotion.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

// Scribe's word stream: spoken words and audio-event tags, in order.
const w = (text: string) => text.split(" ").map((t) => ({ text: t, type: "word" }));
const tag = (text: string) => ({ text, type: "audio_event" });
const turns = [
  { role: "agent", message: "Hey Jordan, it's Co. How did it go?" },
  { role: "user", message: "It's okay, it worked out." },
  { role: "agent", message: "Good to hear. What worked out?" },
  { role: "user", message: "I moved into the new apartment last weekend, it's in the Mission." },
  { role: "agent", message: "That's a big move. How's it feel?" },
];
const words = [
  ...w("Hey Jordan, it's Co. How did it go?"),
  tag("[sighs]"),
  ...w("It's okay, it worked out."),
  ...w("Good to hear. What worked out?"),
  tag("[laughs]"),
  ...w("I moved into the new apartment last weekend,"),
  tag("[chuckles]"),
  ...w("it's in the Mission."),
  ...w("That's a big move."),
  tag("[laughs]"),
  ...w("How's it feel?"),
];
const got = soundMoments(words, turns);
check("a sigh before the caller's words lands on that line", got.some((m) => m.sound === "sighed" && m.line === "It's okay, it worked out."));
check("a laugh before the caller's words lands on that line", got.some((m) => m.sound === "laughed" && /new apartment/.test(m.line)));
check("one per line and sound (a second chuckle on the same line isn't counted twice)", got.filter((m) => m.sound === "laughed").length === 1);
check("a tag in Co's own words is never read as the caller (Co's [laughs] cue)", !got.some((m) => /big move|How's it feel/.test(m.line)));
check("tags that are neither a sigh nor a laugh are ignored", soundOf("[applause]") === null && soundOf("[sighs]") === "sighed" && soundOf("[chuckles]") === "laughed" && soundOf("[laughing]") === "laughed");
check("a tag with no words near it is dropped", soundMoments([tag("[laughs]")], turns).length === 0);
check("no caller lines, nothing recorded", soundMoments(words, turns.filter((t) => t.role !== "user")).length === 0);
const many = Array.from({ length: 6 }, (_, i) => [tag("[sighs]"), ...w(`line number ${i} about the week and the work`)]).flat();
const manyTurns = Array.from({ length: 6 }, (_, i) => ({ role: "user", message: `line number ${i} about the week and the work` }));
check(`at most ${CALL_SOUNDS.maxMoments} a call`, soundMoments(many, manyTurns).length === CALL_SOUNDS.maxMoments);

// Review of #63: Co's own laugh is never the caller's.
const tie = soundMoments(
  [...w("I love that place, it's great for me, that's why I go"), tag("[laughs]"), ...w("thats great I love that for you")],
  [{ role: "user", message: "I love that place, it's great for me, that's why I go" }, { role: "agent", message: "That's great! Love that for you." }],
);
check("a laugh opening Co's line stays Co's, even when an earlier caller line shares its words", tie.length === 0);
const trailing = soundMoments(
  [...w("That's a big move, congrats"), tag("[laughs]"), ...w("Thanks I'm really happy about it")],
  [{ role: "agent", message: "That's a big move, congrats [laughs]" }, { role: "user", message: "Thanks I'm really happy about it" }],
);
check("a laugh right after a Co line where Co laughed (its cue is in the transcript) stays Co's", trailing.length === 0);
const inside = soundMoments(
  [...w("Ha"), tag("[laughs]"), ...w("tell me"), ...w("well it was a long week at work")],
  [{ role: "agent", message: "Ha [laughs] tell me" }, { role: "user", message: "well it was a long week at work" }],
);
check("a laugh inside Co's line stays Co's", inside.length === 0);
const endOfCaller = soundMoments(
  [...w("it was a long week at work"), tag("[sighs]"), ...w("That sounds like a lot")],
  [{ role: "user", message: "it was a long week at work" }, { role: "agent", message: "That sounds like a lot" }],
);
check("a sound at the very end of a caller's line, right before Co, is dropped (can't be told from Co's)", endOfCaller.length === 0);
const opening = soundMoments(
  [...w("How did the week go"), tag("[sighs]"), ...w("I moved into the new place and it's been a lot")],
  [{ role: "agent", message: "How did the week go?" }, { role: "user", message: "I moved into the new place and it's been a lot" }],
);
check("a sigh opening the caller's line is theirs, even when their first word is common", opening.length === 1 && opening[0].sound === "sighed");

// Recorded as a sound, never a feeling.
const sigs = soundSignals([{ sound: "sighed", line: "It's okay, it worked out." }]);
check("recorded as the sound, with their words, tagged sound_tag, valence mixed", sigs[0].emotion === "sighed" && sigs[0].quote === "It's okay, it worked out." && (sigs[0] as any).basis === "sound_tag" && sigs[0].valence === "mixed" && sigs[0].source === "call");
const now = new Date("2026-10-04T20:00:00Z");
const at = new Date("2026-10-04T19:00:00Z");
check("a sound never marks a hard day, even if read as negative", summarizeSignals([{ ...sigs[0], valence: "negative" as const, at }], now).needsCare === false);
check("Co still sees it as a call moment with their words", summarizeSignals([{ ...sigs[0], at }], now).lastCall?.moments[0]?.quote === "It's okay, it worked out.");
const { renderEmotionalContext } = await import("../../src/harness/emotion.js");
const shown = renderEmotionalContext(summarizeSignals([{ ...sigs[0], at }], now), now);
check("Co reads it as what they did ('they sighed when they said'), not a feeling with a strength", /they sighed when they said "It's okay, it worked out\."/.test(shown) && !/sighed \(medium\)/.test(shown));

// Readers that treat a row as a feeling skip sounds.
const read = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");
check("member threads never call a sigh 'the feeling they had'", /AND basis IS DISTINCT FROM 'sound_tag'/.test(read("harness/memberThreads.ts")));
check("the sweep's recent feelings skip sounds", /AND basis IS DISTINCT FROM 'sound_tag'/.test(read("services/sweepSelectContext.ts")));
check("the 'shared how life is going' metric skips every tagged row", /es\.basis IS NULL/.test(read("harness/metrics.ts")));

// Switch, wiring, once per call, logging.
check("on by default, off with SCRIBE_TAGS=off, and needs the ElevenLabs key", callSoundsOn({ ELEVENLABS_API_KEY: "k" } as any) && !callSoundsOn({ ELEVENLABS_API_KEY: "k", SCRIBE_TAGS: "off" } as any) && !callSoundsOn({} as any));
const co = read("routes/co.ts");
const post = co.slice(co.indexOf('event.type !== "post_call_transcription"'));
check("runs after the call is processed, on a real conversation, never awaited", post.indexOf("recordCallSounds(") > post.indexOf("await processEndedCall(") && post.indexOf("recordCallSounds(") > post.indexOf("if (kind && u[0])") && /recordCallSounds\(\{ userId, conversationId, turns \}\)\.catch\(\(\) => \{\}\)/.test(post) && !/await recordCallSounds/.test(post));
check("only on the delivery that processed the call (a duplicate or voicemail never pays for Scribe)", /const processed = ended\.status === 200 && JSON\.stringify\(ended\.body\) === JSON\.stringify\(\{ success: true \}\);\s*if \(processed\) recordCallSounds\(/.test(post));
check("sounds on file never make a retried call skip its text read", /SELECT 1 FROM emotion_signals WHERE memory_id = \$1 AND basis IS DISTINCT FROM 'sound_tag' LIMIT 1/.test(co));
const cs = read("services/callSounds.ts");
check("once per call: skipped when this call's sounds are already on file", /es\.basis = 'sound_tag'\) AS done/.test(cs) && /if \(rows\[0\]\.done\) return;/.test(cs));
check("every pass is logged, including no audio, too long and failures", ["no_transcript", "no_audio", "too_long", "failed", "recorded", "none"].every((a) => cs.includes(`"${a}"`)) && /decision: "call\.sound_tags"/.test(cs));
check("Scribe is asked for audio-event tags, with timeouts on both requests", /form\.append\("tag_audio_events", "true"\)/.test(cs) && (cs.match(/AbortSignal\.timeout/g) ?? []).length >= 2);

console.log(`call sound rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
