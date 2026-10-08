// Model-free checks for "pick up where we left off" on calls (2026-10-04): the
// context a call gets, the opening line written from it, and the agent's own
// settings. No API calls, no database:
//   npx tsx evals/calls/opening.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { VARIETY_GUIDE, stockLine, repeatedOpeners, stockReport, coLinesOf } = await import("../../src/harness/stockLines.js");
const { assembleCallSummary, CALL_CONTEXT_MAX, CALL_SENT_MAX, promiseFacts, trimToLines, CONTEXT_SHARES, CONTEXT_MAX } = await import("../../src/services/callContext.js");
const { OPENING_WRITER, openingProblems, openingPrompt, prebuildOpening, takeOpening } = await import("../../src/services/callOpening.js");
const { AGENT_DEFAULTS, OPENING_NOTE, buildAgentConfig, prebuildCallContext, promptForElevenLabs } = await import("../../src/services/elevenLabsCalls.js");

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

// ---- the context a call gets
// The real failure (2026-10-04): the sent events took most of 4,500 characters and the
// build stopped at the first section that didn't fit, so what they'd told Co lately,
// the ongoing recap and the person picture never reached the call.
const sentLines = Array.from({ length: 5 }, (_, i) => `From the page for "Event ${i}" (read today): ${"what: event; host: Somebody; venue: A Place; ".repeat(14)}`);
const base = [
  "Things they've corrected (the corrected version wins over anything below): goal was wrong on Sep 25",
  "What you know about them right now:\nA founder building Co, sorting sponsors after the Civic Joy Fund fell through. " + "x".repeat(900),
  "What they've told you in the last two days (newest facts win over anything below):\n- their first paying customer is the priority",
  "Ongoing summary: " + "y".repeat(500),
  "How they've been feeling:\nstretched thin about the sponsor search",
  "Recent texts: " + "z".repeat(700),
].join("\n\n");
const sum = assembleCallSummary({ now: "- Partnering with Sequin AI on a November event: in progress", lastCalls: "- Oct 7, today: they cancelled the October date and are planning November with Sequin AI.", settled: "- goal, Oct 7: partnering with Sequin AI (not \"first paying customer\")", lessons: ["keep to the cost constraint"], sentLines, threads: [{ text: "sponsors for the event" }, { text: "x", line: "an old thread (they said Sep 21; OLD, so ask whether it is still true and never state it as current)" }], base });
check("every part of the picture reaches the call, even with five long sent events", ["What you know about them right now", "What they've told you in the last two days", "Ongoing summary", "How they've been feeling", "Recent texts"].every((h) => sum.includes(h)));
check(`the whole thing fits ${CALL_CONTEXT_MAX} characters`, sum.length <= CALL_CONTEXT_MAX);
const sentBlock = sum.slice(sum.indexOf("What you sent them lately"));
check("the sent block is capped at about 2,000 characters in whole lines and comes last", CALL_SENT_MAX <= 2000 && sentBlock.length <= 2000 && sum.endsWith(sentBlock) && sentBlock.split("\n").every((l, i) => i === 0 || l.startsWith("- From the page")));
const at = (h: string) => sum.indexOf(h);
check("the current situation leads: where things stand, the last calls, what they're in the middle of, then settled corrections and how to be with them", at("Where things stand now") === 0 && at("Where things stand now") < at("Your last calls") && at("Your last calls") < at("What they're in the middle of") && at("What they're in the middle of") < at("Settled (") && at("Settled (") < at("How to be with them") && at("How to be with them") < at("What you know about them right now"));
check("an OLD thread is not listed as current: it comes after the rest, as a question", !sum.slice(at("What they're in the middle of"), at("Settled (")).includes("an old thread") && at("Older threads, not current") > at("Recent texts") && at("Older threads, not current") < at("What you sent them lately"));
const longSecond = assembleCallSummary({ lessons: [], sentLines: [], threads: [], base: ["A: short", "B: " + "q".repeat(9000), "C: also short"].join("\n\n") });
check("a section too long to fit is skipped, not the end of the build (later short ones still arrive)", longSecond.includes("A: short") && longSecond.includes("C: also short") && !longSecond.includes("qqqq"));
check("nothing sent: no empty sent block, the rest intact", !assembleCallSummary({ lessons: [], sentLines: [], threads: [], base }).includes("What you sent them lately"));
check("a single sent line longer than its cap is skipped, not truncated mid-fact", assembleCallSummary({ lessons: [], sentLines: ["x".repeat(CALL_SENT_MAX + 50), "short one"], threads: [], base: "" }).includes("- short one"));
check("empty in, empty out", assembleCallSummary({ lessons: [], sentLines: [], threads: [], base: "" }) === "");
const ctxSrc = read("src/services/callContext.ts");
check("buildCallKnowledge uses the assembly (no second, stopping loop)", /const summary = assembleCallSummary\(\{ now: loops \|\| null, lastCalls: lastCalls \|\| null, settled: settled \|\| null, lessons, sentLines, threads, base \}\);/.test(ctxSrc) && !/if \(next\.length > CALL_CONTEXT_MAX\) break;/.test(ctxSrc));
check("the call reads the same model of the person as texting (personModel.ts)", /personModelParts\(userId\)/.test(ctxSrc) && /p\.model\?\.threadList/.test(ctxSrc) && /p\.model\?\.loops/.test(ctxSrc));

// ---- the opening line
const knows = `What you know about them right now:\nRoyce is building Co. He's trying to find sponsors for the October 10 event after the Civic Joy Fund fell through.\n` + "pad ".repeat(100);
const ok = (line: string) => openingProblems(line, knows, "Royce") === null;
const why = (line: string) => openingProblems(line, knows, "Royce");
check("a line that uses their name and picks up something real is accepted", ok("Hey Royce, it's Co. Last we talked you were finding sponsors for the October 10 event. Where did that land?"));
check("it must use their name", why("It's Co. Last we talked you were finding sponsors.") === "doesn't use their name");
check("a name or place that isn't in what Co knows is refused", /not in what Co knows: Berkeley/.test(why("Hey Royce, it's Co. How did Berkeley go?") ?? "") && /not in what Co knows: 14/.test(why("Hey Royce, it's Co. Did the 14 sponsors reply?") ?? ""));
check("a possessive of a name that is in what Co knows is accepted", openingProblems("Hey Royce, it's Co. Did the Civic Joy Fund's sponsor come through?", "Civic Joy Fund fell through. " + "pad ".repeat(100), "Royce") === null);
check("a possessive of a name that isn't there is still refused", /not in what Co knows: Berkeley/.test(openingProblems("Hey Royce, it's Co. Did Berkeley's host reply?", "Civic Joy Fund fell through. " + "pad ".repeat(100), "Royce") ?? ""));
check("inbound Haiku 5.x is asked directly with thinking off (ai-sdk drops it); outbound Sonnet 4.6 gets no effort option", /thinking: \{ type: "disabled" \}/.test(read("src/services/callOpening.ts")) && /\^claude-sonnet-4\/\.test\(model\) \? \{\}/.test(read("src/services/callOpening.ts")) && OPENING_WRITER.outboundModel === "claude-sonnet-4-6");
check("Co and I aren't treated as names; sentence starts aren't either", ok("Hey Royce, it's Co. Did the sponsor search move?") && ok("Royce, hi. I wanted to hear about the sponsors."));
check("never names or guesses a feeling", why("Hey Royce, it's Co. You sound stressed about the sponsors.") === "names a feeling" && why("Hey Royce, I'm hearing frustration about the sponsors.") === "names a feeling");
check("no cue, bracket, dash or placeholder", why("[warmly] Hey Royce, it's Co.") === "brackets or a cue" && why("Hey Royce, it's Co {{x}}") === "brackets or a cue" && why("Hey Royce — it's Co.") === "a dash" && why("Hey Royce, it's Co -- sponsors?") === "a dash");
check("no stock lines", why("Hey Royce, how are you?") === "a stock line" && why("Hey Royce. Good to hear your voice.") === "a stock line" && why("Hey Royce, I was thinking about you.") === "a stock line");
check("NONE, empty, long and many-line answers are refused", why("NONE") === "nothing to pick up" && why("") === "empty" && why("Royce " + "word ".repeat(60)) !== null && why("Hey Royce.\nIt's Co.") === "more than one line");
check("surrounding quotes don't hide a bad line", why('"Hey, it\'s Co."') === "doesn't use their name" && ok('"Hey Royce, it\'s Co. How are the sponsors going?"'));
const prompt = openingPrompt({ firstName: "Royce", direction: "outbound", summary: knows });
check("the writer is told to use only what's there, name no feeling, and say NONE when nothing fits", /only use facts that are in what Co knows/i.test(prompt) && /never name or guess how they feel/i.test(prompt) && /answer exactly: NONE/.test(prompt) && prompt.includes("it's Co"));
check("an inbound caller isn't told Co is calling", !openingPrompt({ firstName: "Royce", direction: "inbound", summary: knows }).includes(`("it's Co")`));
check("a first call (no context) isn't written, the pool greets", OPENING_WRITER.minContext > 100);

// prepared while it rings, taken when they answer
prebuildOpening("u1", "Royce", "outbound", Promise.resolve("short"));
const first = await takeOpening("u1", 500);
check("with too little context there's nothing to pick up, and the answer says why (pool greets)", first.line === null && /first call/.test(first.why ?? ""));
check("nothing prepared falls back right away", (await takeOpening("never-prepared", 50)).line === null);
prebuildOpening("u2", "Royce", "outbound", new Promise(() => {}));
const t0 = Date.now();
const slow = await takeOpening("u2", 120);
check("a line that isn't ready by the wait is dropped on time (the pool greets), never held", slow.line === null && Date.now() - t0 < 600);
prebuildOpening("u3", "Royce", "outbound", Promise.resolve("short"), Date.now() - OPENING_WRITER.ttlMs - 1000);
check("a prepared line older than five minutes isn't used", /none prepared/.test((await takeOpening("u3", 50)).why ?? ""));

// ---- wired into both paths
const co = read("src/routes/co.ts");
const trig = read("src/services/callTrigger.ts");
const el = read("src/services/elevenLabsCalls.ts");
check("outbound: the context and the opening are prepared while it rings", /const summary = prebuildCallContext\(userId, buildCallContextSummary\);\s*[^;]*\s*prebuildOpening\(userId, user\.first_name \?\? "", "outbound", summary\);/.test(trig));
check("prebuildCallContext hands back the summary it is building", /export function prebuildCallContext\(.*\): Promise<string> \{/.test(el));
check("both call paths take the written opening, the pool only as the fallback", (co.match(/opening: await openingForCall\(/g) ?? []).length === 2 && /written\.line \?\? \(await chooseOpening\(userId, firstName, direction\)\)/.test(co));
check("inbound waits a bounded time, outbound only for what was prepared", /withTimeout\(writeOpening\([^)]*\), OPENING_WRITER\.inboundBudgetMs/.test(co) && /\? await takeOpening\(userId\)/.test(co));
check("the opening's source is logged, a fallback apart from the pool's own record", /decision: r\.line \? "call\.opening" : "call\.opening_fallback"/.test(read("src/services/callOpening.ts")) && /recordOpening\(userId, direction, written\)/.test(co));

// ---- the prompt the agent runs on
const shared = read("prompts/co-system-prompt.md");
const forCall = promptForElevenLabs(shared);
// "It should never say the scripted things" (Royce, 2026-10-04; 2026-10-08 call review: "Got it... So the October date is off...
// What's the piece that feels most unsettled?"). The voice layer quotes no ready-made acknowledgement, reflection or question.
// What the member might say ("is that possible?", "what should I do") may be quoted; a line for Co to say may not.
const THEIR_WORDS = /^(?:is that possible\?|what should I do,?|can you point me somewhere,?|what do you think|I just don't know what to do|hello\?)$/i;
check("the voice layer quotes no example lines for Co to copy (only things the member might say)", [...shared.matchAll(/"([^"]*\s[^"]*\s[^"]*[.?!])"/g)].every((m) => THEIR_WORDS.test(m[1].trim())), [...shared.matchAll(/"([^"]*\s[^"]*\s[^"]*[.?!])"/g)].map((m) => m[1]));
check("the call prompt quotes no ready-made acknowledgement, reflection or question for Co to repeat", !/changed a lot of things|takes courage to sit with|finding your footing|a lot happening at once|a lot is changing at once|real shift|tell me what you're working toward now|what matters most to you right now|get one of these right|Does that cover what you needed|piece that feels most unsettled/i.test(forCall));
check("a first call (empty context) is still pointed somewhere real", /If that's empty, this is your first real conversation/.test(forCall));
// 2026-10-08: on Royce's inbound calls Co opened every time with the same update on a doc it was carrying.
check("the opening note: already said, don't repeat, carry on from it; when they called, they lead; old news isn't repeated", /already been said/.test(OPENING_NOTE) && /Don't greet them again or repeat it/.test(OPENING_NOTE) && /Carry on from it/.test(OPENING_NOTE) && /\{\{direction\}\}/.test(OPENING_NOTE) && /they called you, so they lead/.test(OPENING_NOTE) && /already told them on an earlier call isn't news/.test(OPENING_NOTE) && !/first real question/.test(OPENING_NOTE));
check("the note is last in the call prompt", promptForElevenLabs(shared).trimEnd().endsWith(OPENING_NOTE));

// ---- the agent's settings
const cfg: any = buildAgentConfig({ name: "t", prompt: "p", voiceId: "v", apiUrl: "https://x.test" });
check("the agent is no longer at temperature 0 (Hume ran at 1)", AGENT_DEFAULTS.temperature > 0.5 && AGENT_DEFAULTS.temperature <= 1 && cfg.conversation_config.agent.prompt.temperature === AGENT_DEFAULTS.temperature);
check("the live voice defaults to Sonnet 4.6 and the override still wins (one variable to try another model)", AGENT_DEFAULTS.llm === "claude-sonnet-4-6" && cfg.conversation_config.agent.prompt.llm === "claude-sonnet-4-6" && (buildAgentConfig({ name: "t", prompt: "p", voiceId: "v", apiUrl: "https://x.test", llm: "claude-haiku-4-5" }) as any).conversation_config.agent.prompt.llm === "claude-haiku-4-5" && /ELEVENLABS_LLM/.test(read("src/scripts/pushElevenLabsAgent.ts")));
check("it can be set without code (ELEVENLABS_TEMPERATURE) and per build", /ELEVENLABS_TEMPERATURE/.test(read("src/scripts/pushElevenLabsAgent.ts")) && buildAgentConfig({ name: "t", prompt: "p", voiceId: "v", apiUrl: "https://x.test", temperature: 0.3 }).conversation_config.agent.prompt.temperature === 0.3);


// ---- stock lines (2026-10-04: "it should never say the scripted things")
for (const l of ["I hear you.", "Thank you for sharing that with me.", "That takes courage.", "That's a lot to carry.", "I'm so glad you told me.", "That sounds like it changed a lot of things.", "I can only imagine.", "That must be so hard.", "Not the polished version, what's actually going on?", "I hear that."]) check(`stock line caught: ${l}`, stockLine(l) !== null);
for (const l of ["How did the sponsor call go?", "I heard back from nobody yet, so what's next?", "That's a big number for a first month.", "Tell me more about the venue."]) check(`ordinary line left alone: ${l}`, stockLine(l) === null);
check("curly apostrophes read the same", stockLine("That’s a lot to carry") !== null);
check("three lines opening the same way are repeated", repeatedOpeners(["So what happened next?", "So what happened with it?", "So what happened after?", "Tell me more."]).length === 1);
check("two are not", repeatedOpeners(["So what happened next?", "So what happened with it?", "Tell me more."]).length === 0);
check("report counts both", (() => { const r = stockReport(["I hear you.", "Go on."]); return r.stock.length === 1 && r.repeated.length === 0; })());
check("Co lines come from a transcript", coLinesOf("user: hi\nassistant: Hey Sam.\nuser: yo\nassistant: Go on.").length === 2);
check("the opening writer refuses a stock line", openingProblems("Hey Sam, I hear you, how did the Fund call go?", "the Fund call", "Sam") !== null);
check("the post-call audit logs call.stock_lines", /call\.stock_lines/.test(read("src/routes/co.ts")) && /stockReport\(coLinesOf\(/.test(read("src/routes/co.ts")));

check("the call prompt carries the variety guide, once", promptForElevenLabs("Hello. Everything you write is spoken aloud.").split(VARIETY_GUIDE).length === 2);
check("the variety guide quotes no stock line", stockLine(VARIETY_GUIDE) === null);


// ---- review fixes on #66
const CTX = "Royce is a founder. The Civic Joy Fund fell through for the Oct 10 event. He is sorting sponsors and the venue in Berkeley; budget 2014 dollars. ".repeat(3);
const bad = (line: string) => openingProblems(line, CTX, "Royce") !== null;
check("a sensitive topic is refused", bad("Hey Royce, it's Co. Last we talked the biopsy results were pending."));
check("a sentence-start name not in the context is refused", bad("Hey Royce, it's Co. Noor said yes to meeting you."));
// An opening never contradicts itself (Royce, 2026-10-08). The opening written for him on the merged code asked whether he had
// reviewed a plan Co said it still owed; it fails and the pool greets instead.
{
  const owes = "Where things stand now: Co owes Royce a post-event branding plan for Co's post-event presence after the launch, waiting on Jacqueline's input. " + "pad ".repeat(100);
  const r = openingProblems("Hey Royce, it's Co. Have you had a chance to review that post-event branding plan I owe you, or still waiting on Jacqueline's input?", owes, "Royce");
  check("the 10/8 opening (reviewed a plan Co still owes) is refused as contradicting itself", /^contradicts itself/.test(r ?? ""), r);
  check("a good one on the same context passes: \"I still owe you that planning doc on Co's post-event presence…\"", openingProblems("Hey Royce, it's Co. I still owe you that branding plan on Co's post-event presence. Has Jacqueline weighed in?", owes, "Royce") === null, openingProblems("Hey Royce, it's Co. I still owe you that branding plan on Co's post-event presence. Has Jacqueline weighed in?", owes, "Royce"));
  check("\"still\" with a completion verb is refused", /^contradicts itself/.test(openingProblems("Hey Royce, it's Co. Is the branding plan still finished?", owes, "Royce") ?? ""));
  check("two clauses with opposite states of one thing are refused", /^contradicts itself/.test(openingProblems("Hey Royce, it's Co. The branding plan is done, but the plan isn't finished.", owes, "Royce") ?? ""));
  check("an either-or question is not a contradiction", openingProblems("Hey Royce, it's Co. Did Jacqueline's input come back, or still waiting on her?", owes, "Royce") === null, openingProblems("Hey Royce, it's Co. Did Jacqueline's input come back, or still waiting on her?", owes, "Royce"));
  check("the check is the shared one in speakable.ts", /selfContradiction\(line\)/.test(read("src/services/callOpening.ts")));
}
check("speaking for another member is refused", bad("Hey Royce, it's Co. Want the intro?"));
check("a number only inside a bigger number is refused", bad("Hey Royce, it's Co. Did the 201 sponsors reply?"));
check("a relative time not in the context is refused", bad("Hey Royce, it's Co. Is tomorrow's event still on?"));
check("a plain feeling word is refused", bad("Hey Royce, it's Co. Still stressed about the sponsors?"));
check("a short first name does not match inside another word", bad("Hey there, it's Co. Any luck with the Fund?") && openingProblems("Hey Roy, it's Co. Any luck with the Fund?", CTX, "Roy") === null);
check("a grounded line still passes", openingProblems("Hey Royce, it's Co. Last we talked the Civic Joy Fund fell through, any luck finding another sponsor?", CTX, "Royce") === null);
check("inbound waits at most 1.2s for the writer (it writes in ~0.7-1s)", OPENING_WRITER.inboundBudgetMs <= 1200);
check("the writer reads as much context as a call gets", OPENING_WRITER.maxContext >= CALL_CONTEXT_MAX);
check("a first call writes no opening", (await (await import("../../src/services/callOpening.js")).writeOpening({ firstName: "Sam", direction: "outbound", summary: "short" })).line === null);
{
  prebuildOpening("u-take", "Sam", "outbound", Promise.resolve(""));
  await takeOpening("u-take");
  check("taking an opening removes it, so a second call can't reuse it", (await takeOpening("u-take")).why === "none prepared");
}
check("ordinary speech is not a stock line", ["I hear you're moving to Austin.", "I hear that the venue fell through, is that right?", "Thanks for telling me the date.", "That must be hard to schedule around.", "So what's actually going on with the lease?", "Where you're at right now with the budget is what I'd like to hear."].every((l) => stockLine(l) === null));
check("a stock line still caught after the tightening", ["I hear you.", "I hear you, and that's a lot to carry.", "That must be so hard.", "Thank you for telling me."].every((l) => stockLine(l) !== null));
check("a Co turn continued on the next line is one line", coLinesOf("assistant: First part.\nSecond part.\nuser: ok").length === 1 && coLinesOf("assistant: First part.\nSecond part.\nuser: ok")[0].includes("Second"));
check("the call prompt's first-call pointer is not left dangling", !promptForElevenLabs(read("prompts/co-system-prompt.md")).includes("open as below instead"));
check("the prompt no longer says temperature 0.7", !/Set to 0\.7/.test(read("prompts/co-system-prompt.md")));

check("no stock line survives anywhere in the built call prompt", stockLine(promptForElevenLabs(read("prompts/co-system-prompt.md"))) === null && !promptForElevenLabs(read("prompts/co-system-prompt.md")).split("\n").some((l) => stockLine(l) !== null));


// ---- platform review fixes (2026-10-04)
{
  const cfg: any = buildAgentConfig({ name: "t", prompt: read("prompts/co-system-prompt.md"), voiceId: "v", apiUrl: "https://x.test" });
  const built: string = cfg.conversation_config.agent.prompt.prompt;
  check("ElevenLabs reads numbers and dates as words", cfg.conversation_config.tts.text_normalisation_type === "elevenlabs");
  check("the opening can't be cut off by a hello", cfg.conversation_config.agent.disable_first_message_interruptions === true);
  check("the backup model is the nearest Sonnet by a dated id, pinned (never Haiku)", cfg.conversation_config.agent.prompt.backup_llm_config.preference === "override" && cfg.conversation_config.agent.prompt.backup_llm_config.order[0] === AGENT_DEFAULTS.backupLlm && /^claude-sonnet-4-5@/.test(AGENT_DEFAULTS.backupLlm));
  check("the suggested audio tags are the allowed cues", cfg.conversation_config.tts.suggested_audio_tags.map((x: any) => x.tag).join() === "warmly,softly,thoughtful,laughs");
  check("safety sits under a Guardrails heading near the end, before the discretion lines", built.includes("# Guardrails") && built.indexOf("# Guardrails") > built.indexOf("# On the phone") && built.indexOf("# Guardrails") < built.indexOf("Discretion: you never speak for another member") && built.indexOf("Are you safe right now?") > built.indexOf("# Guardrails"));
  check("it is said once, not copied", built.split("Are you safe right now?").length === 2);
  check("the call prompt gives no timed silence lines", !/past \d seconds|Still there\?/.test(built));
  check("no leftover temperature section", !/TEMPERATURE|Set to 0\./.test(built));
  check("the safety script no longer scripts a stock line", !/glad they told you/.test(built));
}

// ---- what the speech recognizer is told to expect (2026-10-06 call: "Co" heard as "you", "Boardy" as "Bumble")
{
  const { CALL_KEYWORDS, CALL_KEYWORDS_MAX, callKeywords } = await import("../../src/services/elevenLabsCalls.js");
  const cfg: any = buildAgentConfig({ name: "t", prompt: read("prompts/co-system-prompt.md"), voiceId: "v", apiUrl: "https://x.test" });
  const kw: string[] = cfg.conversation_config.asr.keywords;
  check("the agent's recognizer is boosted for Co and Boardy", kw.includes("Co") && kw.includes("Boardy") && kw.includes("CoPatible"));
  check("each call may add its own words (the agent allows the asr.keywords override)", cfg.platform_settings.overrides.conversation_config_override.asr?.keywords === true && cfg.platform_settings.overrides.conversation_config_override.agent.first_message === true);
  const finds = "Candidates, not picks: mention only the one or two that fit.\nLooking for: founder and investor events\n- Netic Dance Workshop with Kyle Hanagami, BlackPink Choreographer | A free dance workshop Saturday | link on file\n- The Oakland Join-Up: Fall Activity Fair | Sunday 10 to 2 | link on file\n- Haunted Agent Night at Heavybit | starts tomorrow at 6:30 PM | link on file";
  const per = callKeywords({ firstName: "Royce", findsNow: finds });
  check("a call's words: the standing list first, then their first name", CALL_KEYWORDS.every((w, i) => per[i] === w) && per.includes("Royce"));
  check("names in the titles of what Co found are added (people, venues, event names)", ["Netic Dance Workshop", "Kyle Hanagami", "BlackPink Choreographer", "The Oakland Join-Up", "Fall Activity Fair", "Haunted Agent Night"].every((w) => per.includes(w)), per);
  check("descriptions and instruction lines are not mined ('Candidates', 'Saturday', 'Looking')", !per.some((w) => /Candidates|Saturday|Looking|Sunday/.test(w)), per);
  check("deduped without regard to case (Heavybit is already standing)", per.filter((w) => w.toLowerCase() === "heavybit").length === 1);
  check("nothing found: just the standing list and their name", callKeywords({ firstName: "Royce", findsNow: "Nothing to offer right now. Don't offer an event." }).join() === [...CALL_KEYWORDS, "Royce"].join());
  const many = Array.from({ length: 80 }, (_, i) => `- Event Number${i} Gathering | x`).join("\n");
  check(`capped at ${CALL_KEYWORDS_MAX}, the standing words kept`, callKeywords({ firstName: "Royce", findsNow: many }).length === CALL_KEYWORDS_MAX && callKeywords({ firstName: "Royce", findsNow: many }).includes("Boardy"));
  const src = read("src/services/elevenLabsCalls.ts");
  check("registration sends the call's words as the asr override, alongside the opening line", /conversationConfigOverride: \{\s*asr: \{ keywords: callKeywords\(\{ firstName: o\.firstName, findsNow: o\.findsNow \}\) \},\s*\.\.\.\(o\.opening \? \{ agent: \{ firstMessage: o\.opening \} \} : \{\}\),/.test(src));
  const built: string = cfg.conversation_config.agent.prompt.prompt;
  check("the call brain is told how Co and Boardy get misheard, and not to say the misheard word back", /Co, often arrives as "you"/.test(built) && /Boardy arrives as "Bumble"/.test(built) && /never say the misheard word back/.test(built));
}


// ---- 2026-10-08: no narration in the opening or in what it's written from; texts get every part of their context
{
  const ctx = "Where things stand now: promised on the call a plan on Co's post-event presence after the Sequin AI event. Not sent yet.";
  check("the opening never narrates Co's own state", openingProblems("Hey Royce, it's Co. I still haven't found anything solid yet for that planning doc on Co's post-event presence to text you.", ctx, "Royce") !== null && openingProblems("Hey Royce, it's Co. Working on the Sequin plan now, want an update?", ctx, "Royce") !== null);
  check("a plain pickup of what Co owes passes", openingProblems("Hey Royce, it's Co. The Sequin AI plan is still coming, want to shape it together first?", ctx, "Royce") === null, openingProblems("Hey Royce, it's Co. The Sequin AI plan is still coming, want to shape it together first?", ctx, "Royce"));
  const pf = promiseFacts([
    { at: "2026-10-08T00:30:34Z", content: 'Looked into "draft and text a plan on Co\'s post-event presence" after the call, as Co said it would, and found nothing good enough to send yet.' },
    { at: "2026-10-08T00:30:55Z", content: 'Looked into "draft and text a plan on Co\'s post-event presence" after the call, as Co said it would, and found nothing good enough to send yet.' },
  ]);
  check("promise records read as plain facts, one per promise, never 'nothing good enough'", pf.length === 1 && /^Promised on the call: draft and text a plan on Co's post-event presence\. Not sent yet\.$/.test(pf[0].text) && !/good enough/.test(pf[0].text), pf);
  const long = Array.from({ length: 80 }, (_, i) => `- picture line ${i} with some words about them`).join("\n");
  const t = trimToLines(long, CONTEXT_SHARES.picture);
  check("a long part is trimmed at a line to its share, so it can't crowd the rest out", t.length <= CONTEXT_SHARES.picture && t.endsWith("about them"));
  check("the shares fit inside the text context, with room for the profile lines", Object.values(CONTEXT_SHARES).reduce((a, b) => a + b, 0) + 6 * 60 < CONTEXT_MAX);
  check("a part that doesn't fit is skipped, never the end of the summary (no 'break' in the fill loop)", /if \(next\.length > CONTEXT_MAX\) continue;/.test(readFileSync(new URL("../../src/services/callContext.ts", import.meta.url), "utf8")));
}
console.log(`call opening rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
