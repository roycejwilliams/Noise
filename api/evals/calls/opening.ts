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
const { assembleCallSummary, CALL_CONTEXT_MAX, CALL_SENT_MAX } = await import("../../src/services/callContext.js");
const { OPENING_WRITER, openingProblems, openingPrompt, prebuildOpening, takeOpening } = await import("../../src/services/callOpening.js");
const { AGENT_DEFAULTS, OPENING_NOTE, buildAgentConfig, prebuildCallContext, promptForElevenLabs, withoutExampleOpeners } = await import("../../src/services/elevenLabsCalls.js");

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
const sum = assembleCallSummary({ lessons: ["keep to the cost constraint"], sentLines, threads: [{ text: "sponsors for the event" }], base });
check("every part of the picture reaches the call, even with five long sent events", ["What you know about them right now", "What they've told you in the last two days", "Ongoing summary", "How they've been feeling", "Recent texts"].every((h) => sum.includes(h)));
check(`the whole thing fits ${CALL_CONTEXT_MAX} characters`, sum.length <= CALL_CONTEXT_MAX);
const sentBlock = sum.slice(sum.indexOf("What you sent them lately"));
check("the sent block is capped at about 2,000 characters in whole lines and comes last", CALL_SENT_MAX <= 2000 && sentBlock.length <= 2000 && sum.endsWith(sentBlock) && sentBlock.split("\n").every((l, i) => i === 0 || l.startsWith("- From the page")));
check("how to be with them, then what they're in the middle of, lead", sum.indexOf("How to be with them") === 0 && sum.indexOf("What they're in the middle of") < sum.indexOf("What you know about them right now"));
const longSecond = assembleCallSummary({ lessons: [], sentLines: [], threads: [], base: ["A: short", "B: " + "q".repeat(9000), "C: also short"].join("\n\n") });
check("a section too long to fit is skipped, not the end of the build (later short ones still arrive)", longSecond.includes("A: short") && longSecond.includes("C: also short") && !longSecond.includes("qqqq"));
check("nothing sent: no empty sent block, the rest intact", !assembleCallSummary({ lessons: [], sentLines: [], threads: [], base }).includes("What you sent them lately"));
check("a single sent line longer than its cap is skipped, not truncated mid-fact", assembleCallSummary({ lessons: [], sentLines: ["x".repeat(CALL_SENT_MAX + 50), "short one"], threads: [], base: "" }).includes("- short one"));
check("empty in, empty out", assembleCallSummary({ lessons: [], sentLines: [], threads: [], base: "" }) === "");
const ctxSrc = read("src/services/callContext.ts");
check("buildCallKnowledge uses the assembly (no second, stopping loop)", /const summary = assembleCallSummary\(\{ lessons, sentLines, threads, base \}\);/.test(ctxSrc) && !/if \(next\.length > CALL_CONTEXT_MAX\) break;/.test(ctxSrc));

// ---- the opening line
const knows = `What you know about them right now:\nRoyce is building Co. He's trying to find sponsors for the October 10 event after the Civic Joy Fund fell through.\n` + "pad ".repeat(100);
const ok = (line: string) => openingProblems(line, knows, "Royce") === null;
const why = (line: string) => openingProblems(line, knows, "Royce");
check("a line that uses their name and picks up something real is accepted", ok("Hey Royce, it's Co. Last we talked you were finding sponsors for the October 10 event. Where did that land?"));
check("it must use their name", why("It's Co. Last we talked you were finding sponsors.") === "doesn't use their name");
check("a name or place that isn't in what Co knows is refused", /not in what Co knows: Berkeley/.test(why("Hey Royce, it's Co. How did Berkeley go?") ?? "") && /not in what Co knows: 14/.test(why("Hey Royce, it's Co. Did the 14 sponsors reply?") ?? ""));
check("a possessive of a name that is in what Co knows is accepted", openingProblems("Hey Royce, it's Co. Did the Civic Joy Fund's sponsor come through?", "Civic Joy Fund fell through. " + "pad ".repeat(100), "Royce") === null);
check("a possessive of a name that isn't there is still refused", /not in what Co knows: Berkeley/.test(openingProblems("Hey Royce, it's Co. Did Berkeley's host reply?", "Civic Joy Fund fell through. " + "pad ".repeat(100), "Royce") ?? ""));
check("Haiku (inbound) is not sent an effort setting it rejects; Sonnet (outbound) is", /\.\.\.\(o\.direction === "outbound" \? \{ providerOptions: \{ anthropic: \{ effort: "low" as const \} \} \} : \{\}\)/.test(read("src/services/callOpening.ts")));
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
check("the shared prompt file keeps its example openers (texts read it)", /Some ways this might sound:/.test(shared) && /Skip the highlight reel/.test(shared));
check("the call's copy leaves the example openers out", !/Some ways this might sound/.test(forCall) && !/Skip the highlight reel/.test(forCall) && !/Not the resume version/.test(forCall) && !/Use your own words if none of these feel right/.test(forCall));
check("and keeps what follows them", /Then listen\. Fully\./.test(forCall) && /What you already know about \{\{first_name\}\}/.test(forCall) && /open by picking up from something specific and real in it/.test(forCall));
check("stripping needs the exact block and leaves any other prompt alone", withoutExampleOpeners("plain prompt") === "plain prompt");
// "It should never say the scripted things" (Royce, 2026-10-04): the prompt quoted ready-made lines and Co repeated them word for word
// ("That sounds like it changed a lot of things", "That's a lot happening at once").
const quoted = shared.split("\n").filter((l) => /^"/.test(l));
check("the call prompt quotes no ready-made acknowledgement, reflection or question for Co to repeat", !/changed a lot of things|takes courage to sit with|finding your footing|a lot happening at once|a lot is changing at once|real shift|tell me what you're working toward now|what matters most to you right now|get one of these right/i.test(forCall));
check("what quoted lines remain are only the first-call openers (stripped from calls), the closing, the what-are-you answer and 'sounds good' notes", quoted.every((l) => /Good to finally talk|glad we're finally connecting|real version of how things are going|What's actually going on|"Sounds good," "thank you,"|That's what I needed\. Here's what happens next/.test(l)));
check("the reflection, heavy-moment and prioritization lines are described, not quoted, and ask for new words every time", /new every time/.test(shared) && /something real: it names the specific thing they told you/i.test(shared) && /put it differently every call/i.test(shared));
check("the opening note: already said, don't repeat, carry on from it, never fall back to a general question", /already been said/.test(OPENING_NOTE) && /Don't greet them again or repeat it/.test(OPENING_NOTE) && /Carry on from it/.test(OPENING_NOTE) && /general/.test(OPENING_NOTE) && !/first real question/.test(OPENING_NOTE));
check("the note is last in the call prompt", promptForElevenLabs(shared).trimEnd().endsWith(OPENING_NOTE));

// ---- the agent's settings
const cfg: any = buildAgentConfig({ name: "t", prompt: "p", voiceId: "v", apiUrl: "https://x.test" });
check("the agent is no longer at temperature 0 (Hume ran at 1)", AGENT_DEFAULTS.temperature > 0.5 && AGENT_DEFAULTS.temperature <= 1 && cfg.conversation_config.agent.prompt.temperature === AGENT_DEFAULTS.temperature);
check("the live voice defaults to Sonnet 4.6 and the override still wins (one variable back to Haiku)", AGENT_DEFAULTS.llm === "claude-sonnet-4-6" && cfg.conversation_config.agent.prompt.llm === "claude-sonnet-4-6" && (buildAgentConfig({ name: "t", prompt: "p", voiceId: "v", apiUrl: "https://x.test", llm: "claude-haiku-4-5" }) as any).conversation_config.agent.prompt.llm === "claude-haiku-4-5" && /ELEVENLABS_LLM/.test(read("src/scripts/pushElevenLabsAgent.ts")));
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

console.log(`call opening rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
