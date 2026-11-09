// Replies, texts and calls (Royce, 2026-11-09): venting and wanting help aren't separate boxes; receive the human moment first, don't
// push a solution, don't withhold one they clearly want, give it now when it's ready; a tentative read is theirs to correct.
// Layer 1: source and prompt text only, no model, no database.   npx tsx evals/followThrough/replyNoRigidSplit.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const CORE = await import("../../src/services/coCore.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };

const L = CORE.CO_LISTENING;
check("no rigid boxes: venting and wanting help aren't separate", /Venting and wanting help aren't separate boxes\. Receive the human moment first\./.test(L));
check("venting: no solution pushed into a moment that doesn't call for one", /Don't push a solution into a moment that doesn't call for one/.test(L));
check("useful immediate help: not held back when they clearly want it, and given now", /don't hold back useful help when they clearly want it/.test(L) && /give a real answer now, not later\./.test(L));
check("a tentative read, theirs to correct, only from what they said; still no diagnosis or telling them what's going on", /offer it tentatively, as yours to correct, and only from what they've actually said/.test(L) && /never tell them what's really going on with them/.test(L) && /Never diagnose, never name the feeling/.test(L));
const GL = await import("../../src/services/gptLive.js");
const EL = await import("../../src/services/elevenLabsCalls.js");
const once = (hay: string, needle: string) => hay.split(needle).length === 2;
const VOICE = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8"); // the real voice layer
const live = GL.buildLiveCall({ userId: "u-jordan", callSid: "CA-J", firstName: "Jordan", direction: "inbound", team: false, voiceLayer: VOICE, contextSummary: "Weighing an IP agreement with a cofounder.", rightNow: "It's Monday morning for them.", findsNow: "", callReason: "", timeOfDay: "Monday morning" });
const el = EL.promptForElevenLabs(VOICE);
check("both mediums: texts read both lines in CO_CORE; calls get them through CALL_FROM_CORE only", CORE.CO_CORE.includes(CORE.HEARD_OR_HELPED) && L.includes(CORE.HEARD_OR_HELPED) && /\$\{CO_CORE\}/.test(src("agent/conversationReply.ts")) && EL.CALL_FROM_CORE.includes(CORE.HEARD_OR_HELPED) && EL.CALL_FROM_CORE.includes(CORE.FACTS_OVER_FEELING) && !GL.BACKEND_OTHERS.includes(CORE.HEARD_OR_HELPED) && !GL.BACKEND_OTHERS.includes(CORE.FACTS_OVER_FEELING));
for (const [name, line] of [["HEARD_OR_HELPED", CORE.HEARD_OR_HELPED], ["FACTS_OVER_FEELING", CORE.FACTS_OVER_FEELING]] as const) {
  check(`calls: ${name} appears exactly once in the GPT-Live backend prompt (buildLiveCall backendSystem)`, once(live.backendSystem, line), live.backendSystem.split(line).length - 1);
  check(`calls: ${name} appears exactly once in the ElevenLabs prompt (promptForElevenLabs)`, once(el, line), el.split(line).length - 1);
}
check("facts over feeling (the 11-09 IP call): asked whether to worry or what to do, the answer comes from their facts; reassurance never overrides what they said matters, on texts and calls alike", CORE.FACTS_OVER_FEELING === "When they ask whether to worry or what to do, answer from the facts they gave you, not from how they feel about it: reassurance never overrides what they said matters." && L.includes(`- ${CORE.FACTS_OVER_FEELING}`) && CORE.CO_CORE.includes(CORE.FACTS_OVER_FEELING) && EL.CALL_FROM_CORE.includes(CORE.FACTS_OVER_FEELING));
const reply = src("agent/conversationReply.ts");
check("the text reply's need line is no longer a three-way pick", /Decide what they most need right now\. Often it's more than one thing: to feel heard, real help with something, or to share in something good\./.test(reply) && /Work out what they actually asked or are stuck on, and what you know about them that changes the answer\./.test(reply));
const sb = src("routes/sendblue.ts");
const seek = sb.slice(sb.indexOf("const seekingModeContext ="), sb.indexOf("let coReply: string;"));
check("the seeking line receives a feeling first, then meets the ask directly", /maybe alongside what they're feeling\. If there's a feeling, receive it in a line, then meet the ask directly/.test(seek));
check("no em dash left in that instruction (Cue copies the style of its instructions)", !/[—–]/.test(seek));

console.log(`reply no rigid split: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
