// Model-free checks for how Cue takes turns on a call (Royce, 2026-10-28: "one personality, two rhythms"). The call prompt
// (prompts/co-system-prompt.md through promptForElevenLabs) and the agent's turn config (buildAgentConfig). No API calls, no
// database, nothing pushed:
//   npx tsx evals/calls/turnTaking.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { AGENT_DEFAULTS, buildAgentConfig, promptForElevenLabs } = await import("../../src/services/elevenLabsCalls.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const voice = readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const built = promptForElevenLabs(voice);
const sentenceWith = (text: string, re: RegExp) => text.split(/(?<=[.!?])\s+|\n/).find((s) => re.test(s)) ?? "";

// Letting them finish: a turn that stops mid-thought is not the end of their turn.
check("a mid-thought stop: say very little and let them carry on", /stop mid-thought[^.]*say very little and let them carry on/.test(built));
// Yielding: a cut-in is answered; the old line is not resumed.
check("cut in: drop what you were saying and answer what they just said", /cut in while you're talking, drop what you were saying and answer what they just said/.test(built));
check("cut in: the cut-off point comes back only if it still matters, in new words", /return to the cut-off point only if it still matters, briefly and in new words/.test(built));
// A listening sound that reached the model anyway: carry on, never restart.
check("a listening sound: carry on from where you were, never from the top", /sound of agreement while you talk is them listening: carry on from where you were, never from the top/.test(built));
// Confirming: just the part Cue will act on, never the whole thing again.
check("unclear names, times, numbers: say back just the part you'll act on", /name, time or number came through unclear[^.]*say back just the part you'll act on/.test(built));
check("a consequential request gets the same short playback", /something with consequences/.test(sentenceWith(built, /say back just the part/)));
check("they are never made to repeat the whole thing", /never make them repeat the whole thing/.test(built));
// One personality, two rhythms: the same Cue, spoken.
check("the call says it is the same Cue as in texts, spoken", /same Cue as in texts, with the same warmth, judgment, humor and honesty, talking rather than reading a text out/.test(built));
// No rigid shape: the soft turn cap and the every-turn reflection-then-question formula are gone.
check("no 'most turns are two or three' cap", !/most turns are two or three/.test(built));
check("no every-turn 'reflection and your next question together' formula", !/Say the reflection and your next question together/.test(built));
check("the duplicate ACKNOWLEDGING section is gone", !/ACKNOWLEDGING/.test(built));
check("the bare-reflection fix is kept", /Never end a turn on a bare reflection/.test(built));
// What other tests pin stays (evals/calls/sep23Bugs.ts, evals/calls/cues.ts).
check("one question per turn is kept", /Ask one question per turn\./.test(built) && /never follow it with the same question in other words/.test(built));
check("the cue guide still slots in before the spoken-rhythm line", /\n\nShort sentences, one thought each/.test(built));
// Principles, no quoted lines for Cue to copy: the new sentences carry no quote marks.
for (const re of [/stop mid-thought/, /cut in while you're talking/, /sound of agreement while you talk/, /say back just the part/, /same Cue as in texts/, /Vary the shape/]) {
  const s = sentenceWith(voice, re);
  check(`no quoted example in: ${s.slice(0, 50)}`, !!s && !/["“”]/.test(s));
}
// Each removed rule still has its one home in the prompt (no rule lost, only its copy).
check("'Okay, so' is still ruled out once", (voice.match(/Okay, so/g) ?? []).length === 1);
check("stock lines of empathy are still ruled out (line 16)", /stock lines of empathy/.test(voice));
check("an odd-sounding word is still never repeated back", /don't repeat it back word for word/.test(voice));

// The turn config: listening sounds never interrupt; anything that can be an answer or a stop still does.
const cfg: any = buildAgentConfig({ name: "t", prompt: voice, voiceId: "v", apiUrl: "https://x.test" });
const turn = cfg.conversation_config.turn;
check("turn eagerness stays normal (Royce, 2026-10-08)", turn.turn_eagerness === "normal");
check("listening sounds are ignore terms", ["mm", "mhm", "mm-hmm", "uh-huh", "yeah"].every((t) => turn.interruption_ignore_terms.includes(t)));
check("words that can be an answer or a stop still interrupt", !["okay", "ok", "yes", "no", "wait", "stop", "hold on", "sorry", "what"].some((t) => turn.interruption_ignore_terms.includes(t)));
check("ElevenLabs' curated English list is merged in", turn.merge_with_default_ignore_terms === true && JSON.stringify(turn.interruption_ignore_term_languages) === JSON.stringify(["en"]));
check("the ignore list comes from AGENT_DEFAULTS", JSON.stringify(turn.interruption_ignore_terms) === JSON.stringify(AGENT_DEFAULTS.interruptionIgnoreTerms));
check("the opening line still can't be cut off by a hello", cfg.conversation_config.agent.disable_first_message_interruptions === true);

console.log(`turnTaking: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
