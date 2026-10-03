// Model-free checks for calls on ElevenLabs (services/elevenLabsCalls.ts,
// 2026-10-03). No API calls, no database:
//   npx tsx evals/calls/elevenlabs.ts
import { readFileSync } from "fs";
import {
  AGENT_DEFAULTS,
  buildAgentConfig,
  hitVoicemail,
  OPENING_LINE,
  OPENINGS,
  COVERAGE_TRANSCRIPT_CHARS,
  missedKind,
  voicemailLeft,
  withTimeout,
  pickOpening,
  conversationLink,
  memberNumberOf,
  prebuildCallContext,
  takeCallContext,
  voicemailVerdict,
  issueCallToken,
  promptForElevenLabs,
  transcriptFromHistory,
  transcriptFromTurns,
  verifyCallToken,
} from "../../src/services/elevenLabsCalls.js";
import { promptFileCandidates } from "../../src/services/coPersona.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const env = { ELEVENLABS_TOOL_SECRET: "test-secret" } as NodeJS.ProcessEnv;
const now = 1_790_000_000;

const trigger = readFileSync(new URL("../../src/services/callTrigger.ts", import.meta.url), "utf8");
const coSrc = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
check("Hume is gone: every call is registered with the ElevenLabs agent, in and out", /\/co\/el\/outbound-twiml/.test(trigger) && !/mediaStreamBridge|media-stream|hume/i.test(trigger) && /direction: "inbound"/.test(coSrc) && !/api\.hume\.ai|router\.post\(\s*"\/webhook"/.test(coSrc));
check("a call that can't connect says so on the line and is noted, never dead air", (coSrc.match(/noteCallFailure\(userId, "registration"\)/g) ?? []).length === 2 && (coSrc.match(/CANT_CONNECT_LINE/g) ?? []).length >= 3);

const tok = issueCallToken("user-1", now, env);
check("a call token verifies for its own member", verifyCallToken("user-1", tok, now + 60, env));
check("...not for another member", !verifyCallToken("user-2", tok, now + 60, env));
check("...not after 2 hours, and not tampered with", !verifyCallToken("user-1", tok, now + 2 * 3600 + 1, env) && !verifyCallToken("user-1", tok.replace(/.$/, (c) => (c === "0" ? "1" : "0")), now, env));
check("...not with another secret, nor missing", !verifyCallToken("user-1", tok, now, { ELEVENLABS_TOOL_SECRET: "other" } as any) && !verifyCallToken("user-1", undefined, now, env) && !verifyCallToken("", tok, now, env));

const turns = [
  { role: "agent", message: "Hey Jordan. What's actually going on with you these days?" },
  { role: "user", message: " Honestly, just moved to SF. " },
  { role: "agent", message: null, tool_calls: [{ tool_name: "assess_conversation_coverage" }] },
  { role: "user", message: "" },
];
check("the transcript reads the way Hume's did: user/assistant lines, empty turns dropped", transcriptFromTurns(turns) === "assistant: Hey Jordan. What's actually going on with you these days?\nuser: Honestly, just moved to SF.");
check("the live history (JSON) becomes the same transcript, in its common shapes", transcriptFromHistory(JSON.stringify([{ role: "user", message: "hi" }, { role: "agent", message: "hey" }])) === "user: hi\nassistant: hey" && transcriptFromHistory(JSON.stringify({ messages: [{ role: "user", content: "yo" }] })) === "user: yo" && transcriptFromHistory("not json") === "" && transcriptFromHistory("") === "");
check("a voicemail is told apart: the voicemail tool fired, or the call ended on it", hitVoicemail([{ role: "agent", message: null, tool_calls: [{ tool_name: "voicemail_detection" }] }]) && hitVoicemail([], "voicemail detected") && !hitVoicemail(turns, "end_call tool was called"));

check("the agent's copy of the prompt says end_call, not hang_up, and knows it already said hello", promptForElevenLabs("call the hang_up tool; hang_up only after").startsWith("call the end_call tool; end_call only after") && /already opened the call with a short greeting in your own voice\. Don't greet them again/.test(promptForElevenLabs("x")));
const prompt = readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
check("the real prompt has no hang_up left in the agent's copy, and keeps its variables", !/\bhang_up\b/.test(promptForElevenLabs(prompt)) && /\{\{first_name\}\}/.test(prompt) && /\{\{context_summary\}\}/.test(prompt));

const cfg: any = buildAgentConfig({ name: "Co (test)", prompt: "P {{first_name}}", voiceId: "voice-1", apiUrl: "https://test.copatible.com" });
const cc = cfg.conversation_config;
check("phone audio is mu-law 8kHz both ways (register-call needs it)", cc.asr.user_input_audio_format === "ulaw_8000" && cc.tts.agent_output_audio_format === "ulaw_8000");
check("Royce's picks: Eleven v4 Turbo voice, Haiku 4.5 live, eager turn-taking", cc.tts.model_id === "eleven_v4_turbo" && cc.agent.prompt.llm === "claude-haiku-4-5" && cc.turn.turn_eagerness === "eager" && AGENT_DEFAULTS.ttsModel === "eleven_v4_turbo");
check("overrides from the env reach the config", (buildAgentConfig({ name: "x", prompt: "p", voiceId: "v", apiUrl: "https://a.b", llm: "claude-sonnet-5", ttsModel: "eleven_flash_v2_5", turnEagerness: "normal" }) as any).conversation_config.agent.prompt.llm === "claude-sonnet-5");
const tools = (cc.agent.prompt.tools as any[]).filter((t) => t.type === "webhook");
check("both of Co's call tools are webhooks to our routes", tools.map((t) => t.name).join() === "assess_conversation_coverage,surface_recommendation" && tools.every((t) => t.type === "webhook" && t.api_schema.url === `https://test.copatible.com/co/el/tool/${t.name}`));
check("every tool call carries the member's id, its token, and the live conversation and duration", tools.every((t) => t.api_schema.request_body_schema.properties.user_id.dynamic_variable === "user_id" && t.api_schema.request_body_schema.properties.call_token.dynamic_variable === "call_token" && t.api_schema.request_body_schema.properties.conversation_history.dynamic_variable === "system__conversation_history" && t.api_schema.request_body_schema.properties.call_duration_secs.dynamic_variable === "system__call_duration_secs"));
const sys = (cc.agent.prompt.tools as any[]).filter((t) => t.type === "system");
const sysTools = sys;
check("end_call and voicemail detection ride in the tools list as system tools (built_in_tools stored nothing); the voicemail line names them", sys.map((t) => t.params.system_tool_type).join() === "end_call,voicemail_detection" && sys.every((t) => t.description) && sys[1].params.voicemail_message.includes("{{first_name}}") && !("built_in_tools" in cc.agent.prompt));
check("the 30-minute cap and its closing line carry over from Hume", cc.conversation.max_duration_seconds === 1800 && /wrap up for now/.test(cc.agent.max_conversation_duration_message));

check("the text persona finds the prompt file from api/ or co-test/", promptFileCandidates("/app/co-test", "/app/co-test/dist/api/src/services/").includes("/app/api/prompts/co-system-prompt.md") && promptFileCandidates("/app/api", "/app/api/dist/services/").includes("/app/api/prompts/co-system-prompt.md"));
const docker = readFileSync(new URL("../../../co-test/Dockerfile", import.meta.url), "utf8");
check("co-test's image carries the prompt file", /COPY api\/prompts \.\/api\/prompts/.test(docker));

const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
check("an ElevenLabs call runs the post-call steps (one caller now)", (co.match(/await processEndedCall\(\{/g) ?? []).length === 1 && /callKey: `el:\$\{conversationId\}`/.test(co));
check("the post-call webhook is signature-checked on the raw body, in both servers", /verifyPostCallWebhook\(raw, req\.headers\["elevenlabs-signature"\]/.test(co) && ["../../src/server.ts", "../../../co-test/src/server.ts"].every((p) => /app\.use\("\/co\/el\/post-call", express\.raw/.test(readFileSync(new URL(p, import.meta.url), "utf8"))));
check("tools refuse a call without a valid token", /if \(!verifyCallToken\(userId, b\.call_token\)\) return res\.status\(401\)/.test(co));

// Voice-layer review fixes (2026-10-03).
check("Co opens the call itself, so nobody waits in silence (the stored line is the fallback)", cc.agent.first_message === OPENING_LINE && OPENING_LINE === "Hey {{first_name}}, it's Co.");
check("the opening can be set per call: the agent allows the override and registration sends it", (cfg as any).platform_settings.overrides.conversation_config_override.agent.first_message === true && /conversationConfigOverride: \{ agent: \{ firstMessage: o\.opening \}/.test(readFileSync(new URL("../../src/services/elevenLabsCalls.ts", import.meta.url), "utf8")) && (coSrc.match(/opening: await chooseOpening\(/g) ?? []).length === 2);
{
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(pickOpening({ direction: "outbound", firstCall: false, hour: 14, firstName: "Jordan", last: null, rand: () => i / 200 }).template);
  check("many variations: an everyday outbound call has 5+ openings to draw from", seen.size >= 5);
  const first = pickOpening({ direction: "outbound", firstCall: true, hour: 14, firstName: "Jordan", last: null, rand: () => 0 }).line;
  check("a first call opens like a first call; the name is filled in", /Jordan/.test(first) && /(finally|looking forward|glad we're)/i.test(first) && !/\{name\}/.test(first));
  check("they called Co: the opening is an inbound one", [0, 0.3, 0.6, 0.99].every((r) => /(Glad you called|This is Co|You've got Co|I'm here)/.test(pickOpening({ direction: "inbound", firstCall: false, hour: 14, firstName: "Jordan", last: null, rand: () => r }).line)));
  check("morning and evening lines appear only at those hours", !OPENINGS.some((t) => /^(Morning|Good morning)/.test(t.text) && t.when?.({ direction: "outbound", firstCall: false, hour: 20 })) && OPENINGS.some((t) => /^Evening/.test(t.text) && t.when?.({ direction: "outbound", firstCall: false, hour: 20 })) && !OPENINGS.some((t) => /^(Morning|Evening|Good morning)/.test(t.text) && t.when?.({ direction: "outbound", firstCall: false, hour: null })));
  let repeats = 0;
  for (let i = 0; i < 300; i++) {
    const a = pickOpening({ direction: "outbound", firstCall: false, hour: 9, firstName: "J", last: null, rand: () => (i * 37 % 100) / 100 });
    const b = pickOpening({ direction: "outbound", firstCall: false, hour: 9, firstName: "J", last: a.template, rand: () => ((i * 53 + 11) % 100) / 100 });
    if (a.template === b.template) repeats++;
  }
  check("never the opening they heard on their last call", repeats === 0);
  check("no opening asks a question, uses a dash, or runs long (the prompt asks the first question)", OPENINGS.every((t) => !/\?/.test(t.text) && !/[\u2014\u2013]/.test(t.text) && t.text.length <= 60 && t.text.includes("{name}")));
}
check("voicemail: the tool's call is checked against whether the person actually talked", voicemailVerdict(true, false) === "voicemail" && voicemailVerdict(true, true) === "misfire" && voicemailVerdict(false, true) === "conversation" && voicemailVerdict(false, false) === "conversation");
check("the voicemail tool is told a bare hello is a person", /A person saying \\?"hello\?/.test(JSON.stringify(sysTools)) || /hello\?/.test(sysTools[1].description));
check("status callbacks find the member: To when Co calls, From when they call Co", memberNumberOf({ To: "+15550001111", From: "+14155550176", Direction: "outbound-api" }, "+14155550176").number === "+15550001111" && memberNumberOf({ To: "+14155550176", From: "+15550002222", Direction: "inbound" }, "+14155550176").inbound === true && memberNumberOf({ To: "+14155550176", From: "+15550002222", Direction: "inbound" }, "+14155550176").number === "+15550002222");
check("each call links to its ElevenLabs conversation", conversationLink("conv_1") === "https://elevenlabs.io/app/agents/history/conv_1" && conversationLink("") === null);
{
  let built = 0;
  const build = async (u: string) => { built++; return `ctx:${u}`; };
  prebuildCallContext("m1", build, 1000);
  const a = await takeCallContext("m1", build, 2000);
  const b = await takeCallContext("m1", build, 3000);
  prebuildCallContext("m2", build, 1000);
  const c = await takeCallContext("m2", build, 1000 + 6 * 60 * 1000);
  check("context built while it rings is used at the answer, once; a stale or missing one is rebuilt", a.prebuilt && a.summary === "ctx:m1" && !b.prebuilt && !c.prebuilt && built === 4);
}
const trig = readFileSync(new URL("../../src/services/callTrigger.ts", import.meta.url), "utf8");
check("the context is started before Twilio dials", trig.indexOf("prebuildCallContext(userId, buildCallContextSummary)") > 0 && trig.indexOf("prebuildCallContext(userId, buildCallContextSummary)") < trig.indexOf("twilioClient.calls.create("));
check("a misfired voicemail goes through as a conversation, logged; inbound statuses never send a missed-call text", /const kind = missedKind\(verdict, personTalked/.test(coSrc) && /decision: "call\.voicemail"/.test(coSrc) && /if \(inbound \|\| !\["no-answer"/.test(coSrc));

// PR #58 review fixes (2026-10-03), one check each.
{
  // 1. Voicemail gate.
  check("1 which finished calls are missed calls: a detected voicemail, or a call Co placed where nobody spoke; never a silent call they placed to Co or a misfire", missedKind("voicemail", false, "outbound") === "voicemail" && missedKind("conversation", false, "outbound") === "silent" && missedKind("conversation", false, "inbound") === null && missedKind("misfire", true, "outbound") === null && missedKind("conversation", true, "outbound") === null);
  check("1 what Co left is recorded with their name", voicemailLeft("Jordan") === "Hey Jordan, it's Co. Sorry I missed you. I'll send you a text.");
  const handler = coSrc.slice(coSrc.indexOf("async function handleMissedVoiceCall("), coSrc.indexOf("// After a call ends (ElevenLabs"));
  check("1 both kinds claim the call once, run the old gate (once per call, none queued, none recent) and log it, and release the claim if the send fails", /INSERT INTO voicemail_calls/.test(handler) && /decideMissedCallFollowUp\(await gatherMissedCallState\(user\.id, callSid\)/.test(handler) && /action: `missed_call_followup:\$\{kind\}`/.test(handler) && /DELETE FROM voicemail_calls WHERE call_sid = \$1/.test(handler) && /Co left this voicemail/.test(handler));
  check("1 the post-call route uses it, and never the member's latest call_sid", /handleMissedVoiceCall\(u\[0\], callSid, kind, conversationId\)/.test(coSrc) && /vars\.system__call_sid \?\? `el:\$\{conversationId\}`/.test(coSrc) && !/u\[0\]\?\.call_sid/.test(coSrc) && /direction: o\.direction,/.test(readFileSync(new URL("../../src/services/elevenLabsCalls.ts", import.meta.url), "utf8")));
  // 2. Failed registration frees the call.
  check("2 a call that can't register resets its live status (both paths, scoped to the call's sid)", (coSrc.match(/await releaseFailedCall\(userId,/g) ?? []).length === 2 && /call_status = 'failed'[^`]*call_sid = \$2/.test(coSrc));
  // 3. Coverage tool is light and its request fits.
  const tl = (cfg as any).conversation_config.agent.prompt.tools.find((t: any) => t.name === "assess_conversation_coverage");
  check("3 the coverage tool is given the call's summary instead of rebuilding it, and reads only the newest part of a long call", tl.api_schema.request_body_schema.properties.context_summary.dynamic_variable === "context_summary" && /typeof b\.context_summary === "string" \? b\.context_summary : await buildCallContextSummary/.test(coSrc) && /\.slice\(-COVERAGE_TRANSCRIPT_CHARS\)/.test(coSrc) && COVERAGE_TRANSCRIPT_CHARS === 24_000);
  check("3 the tools' requests may be 2mb (the default 100kb would reject a long call before the route), set before the global parser in both servers", ["../../src/server.ts", "../../../co-test/src/server.ts"].every((p) => { const t = readFileSync(new URL(p, import.meta.url), "utf8"); const i = t.indexOf('app.use("/co/el/tool", express.json({ limit: "2mb" }))'); return i > 0 && i < t.search(/app\.use\(express\.json\(/); }));
  // 4. The opener can't hold up the answer.
  const slow = await withTimeout(new Promise<string>((r) => setTimeout(() => r("late"), 300)), 20, "fallback");
  const fast = await withTimeout(Promise.resolve("on time"), 20, "fallback");
  check("4 a slow opener lookup gives the fixed greeting after its budget; a fast one is used", slow === "fallback" && fast === "on time" && /withTimeout\(chooseOpeningUnbounded\(/.test(readFileSync(new URL("../../src/services/elevenLabsCalls.ts", import.meta.url), "utf8")));
  // 5. Dead voice-emotion plumbing and stale references are gone.
  const srcOf = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
  check("5 no call path carries voice-emotion data any more", !/humeMoments|renderHumeMoments|HumeUtterance|emotionalHighlights/.test(srcOf("routes/co.ts") + srcOf("harness/emotion.ts") + srcOf("services/callLearning.ts") + srcOf("services/callContext.ts") + srcOf("services/profileExtraction.ts")));
  const results = readFileSync(new URL("../../../co-test/public/results.html", import.meta.url), "utf8");
  const ci = readFileSync(new URL("../../../.github/workflows/co-evals.yml", import.meta.url), "utf8");
  check("5 the dashboard's 'Start a call' goes to a page that exists, and CI no longer sets a Hume key", /href="\/phone"[^>]*>Start a call/.test(results) && !/HUME/.test(ci));
}

console.log(`elevenlabs call rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
