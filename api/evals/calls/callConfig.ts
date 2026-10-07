// The call agent's config and what the call brain is handed (Royce, 2026-10-06, review of the first ElevenLabs call). Layer 1: no model, no network.
//   npx tsx evals/calls/callConfig.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const E = await import("../../src/services/elevenLabsCalls.js");
const V = await import("../../src/services/voiceFinds.js");
const B = await import("../../src/services/callBriefing.js");
const { default: pool } = await import("../../src/db/db.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

const prompt = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const cfg: any = E.buildAgentConfig({ name: "Co", prompt, voiceId: "v", apiUrl: "https://x.test" });
const c = cfg.conversation_config, ap = c.agent.prompt;
const tools: any[] = ap.tools;
const text = JSON.stringify(cfg);

// ---- 2. the call brain is Haiku 4.5, and never a bigger model
check("the call brain is Haiku 4.5", ap.llm === "claude-haiku-4-5");
check("the fallback is the same model by its dated id: nothing slower is ever tried", ap.backup_llm_config.preference === "override" && ap.backup_llm_config.order.join() === "claude-haiku-4-5@20251001");
check("no Sonnet or Opus is named anywhere in the call brain's model settings", !/sonnet|opus/i.test(JSON.stringify({ llm: ap.llm, backup: ap.backup_llm_config })));
check("a slow first token falls back after 3s, not 4", ap.cascade_timeout_seconds === 3);
check("Sonnet stays where nobody waits: post-call, recaps, grading still use it", /MODELS\.sonnet/.test(src("services/claims.ts")) && /MODELS\.sonnet/.test(src("harness/callGrounding.ts")));

// ---- 1. turn detection and tools
check("turn detection: eager endpointing, speculative turns, the v3 turn model, pinned so a push can't drift", c.turn.turn_eagerness === "eager" && c.turn.speculative_turn === true && c.turn.turn_model === "turn_v3");
const cov = tools.find((t) => t.name === "assess_conversation_coverage");
check("the coverage check runs in the background (async): Co never waits on it, and it can't hold up a sentence", cov?.execution_mode === "async" && cov?.pre_tool_speech === "off");
check("the find is no longer a tool Co waits on: no surface_recommendation tool at all", !tools.some((t) => t.name === "surface_recommendation") && !/surface_recommendation/.test(ap.prompt));
check("the tools that remain add no spoken filler", tools.filter((t) => t.type === "webhook").every((t) => t.pre_tool_speech === "off"));
check("end_call and voicemail detection are still there", tools.some((t) => t.name === "end_call") && tools.some((t) => t.name === "voicemail_detection"));
check("the prompt tells Co to run the coverage check first in a turn, before any words", /as the very first thing you do in a turn, before you say a word, never part-way through what you are saying/.test(ap.prompt));
check("and to open every reply with a short first sentence (the voice starts when the first sentence is done)", /Start every reply with a short first sentence, under ten words/.test(ap.prompt));

check("Haiku's habits are named in the prompt: short speech, no 'I appreciate' opener, no AI disclaimer, never 'not how I work' for multi-day help", /about 60 words at most/.test(ap.prompt) && /Never open with "I appreciate"/.test(ap.prompt) && /No disclaimers about being an AI/.test(ap.prompt) && /never say it isn't how you work: say yes, that you'll set it up when you hang up/.test(ap.prompt));

// ---- 5. keywords
const kw: string[] = c.asr.keywords;
check("the recognizer is told the names it got wrong: Co, Boardy, and the others", ["Co", "Boardy", "CoPatible", "Instinct", "Muse", "Luma"].every((k) => kw.includes(k)));

// ---- 7. capability sheet and member context
const sheet = B.CAPABILITY_SHEET;
check("the sheet is in the call prompt", ap.prompt.includes("# What Co can do today"));
check("it says Co does multi-day work and how to ask for it by text, and bans 'not how I work'", /works on it over the following days \(up to 30\)/.test(sheet) && /Right after you hang up, Co sets up what they asked for as a task/.test(sheet) && /Never say this is "not how I work"/.test(sheet) && !/A call can't start a task live/.test(sheet));
check("it does not promise what Co can't: no finding investors or a particular advisor, no group texts, no daily messages", /Co can't find investors, sponsors or funders on demand/.test(sheet) && /never starts a group text/.test(sheet) && /can't promise a daily message/.test(sheet));
check("it says a call keeps its promise to look into something after the call", /After a call, Co does look into what you said you'd look into/.test(sheet));
check("it stops the questions it has answers to: say what you have and ask if it's still right", /Never ask for something you already know/.test(sheet) && /You told me weekends, is that still true\?/.test(sheet));
check("the sheet is one page (under 560 words)", sheet.split(/\s+/).length < 560);
check("the member context is still in the prompt", /\{\{context_summary\}\}/.test(ap.prompt));
check("the clock and the finds are per-call variables in the prompt, with placeholders", /\{\{right_now\}\}/.test(ap.prompt) && /\{\{finds_now\}\}/.test(ap.prompt) && "right_now" in c.agent.dynamic_variables.dynamic_variable_placeholders && "finds_now" in c.agent.dynamic_variables.dynamic_variable_placeholders);
check("guardrails still come last, after the sheet", ap.prompt.indexOf("# What Co can do today") < ap.prompt.indexOf("# Guardrails"));

// ---- 3. time check: the replay
// The call was Oct 5 at 9:48pm Pacific (2026-10-06T04:48Z). The event started Oct 6 at 6:30pm Pacific: TOMORROW evening, not tonight.
const NOW = new Date("2026-10-06T04:48:00Z");
const TOMORROW_630 = "2026-10-07T01:30:00Z";
const w = V.whenFromNow(TOMORROW_630, "America/Los_Angeles", NOW)!;
check("replay: the Haunted Agent event is worded as TOMORROW (Tuesday, October 6, 6:30 PM), never tonight", /^tomorrow, Tuesday, October 6 at 6:30 PM/.test(w) && !/tonight|today/.test(w));
check("a start later the same evening is 'today' and says how far away it is", V.whenFromNow("2026-10-06T06:30:00Z", "America/Los_Angeles", NOW)!.startsWith("today, ") && /in about 2 hours/.test(V.whenFromNow("2026-10-06T06:30:00Z", "America/Los_Angeles", NOW)!));
check("a start in minutes says minutes", /in 20 minutes/.test(V.whenFromNow("2026-10-06T05:08:00Z", "America/Los_Angeles", NOW)!));
check("a start days away is the weekday and date, with no 'today/tomorrow'", /^Saturday, October 10 at 2:00 PM/.test(V.whenFromNow("2026-10-10T21:00:00Z", "America/Los_Angeles", NOW)!));
check("an event that has already started is dropped", !V.stillAhead("2026-10-06T01:30:00Z", "2026-10-06T03:30:00Z", NOW) && !V.stillAhead("2026-10-06T04:00:00Z", null, NOW));
check("one that has ended is dropped even if its start is missing", !V.stillAhead(null, "2026-10-06T03:00:00Z", NOW));
check("one still ahead, or with no time on file (a shortlist note), is kept", V.stillAhead(TOMORROW_630, "2026-10-07T03:30:00Z", NOW) && V.stillAhead(null, null, NOW));
check("the lookup filters on the details' start/end and words the time from now", /stillAhead\(match\.details\?\.startAt, match\.details\?\.endAt, now\)/.test(src("services/voiceFinds.ts")) && /starts: whenFromNow\(/.test(src("services/voiceFinds.ts")));
check("the note tells the voice model to say when only as 'starts' says", /never call something "tonight" or "today" unless `starts` says today/.test(V.VOICE_NOTE));

// ---- the briefing: built while it rings, never a pause after hello
const queries: string[] = [];
(pool as any).query = async (sql: string) => { queries.push(sql); return { rows: [] }; };
const br = await B.buildCallBriefing("u1", NOW);
check("the clock line carries the day and the time, and 'tonight' only if the start says today", /Monday, October 5/.test(br.rightNow) && /9:48 PM/.test(br.rightNow) && /only "tonight" if its start below says today/.test(br.rightNow));
check("nothing on file to offer -> an explicit 'don't offer an event'", /Don't offer an event/.test(br.findsNow));
const rendered = B.renderFinds({ available: true, lookingFor: "founder rooms", note: V.VOICE_NOTE, items: [{ name: "Haunted Agent + Infra Horror Night", details: ["Hosted by Heavybit."], link: "https://lu.ma/x", starts: w }] });
check("an offered event reads with its relative start and a link flag", /Haunted Agent \+ Infra Horror Night \| starts tomorrow, Tuesday, October 6 at 6:30 PM/.test(rendered) && /offer to text it/.test(rendered));
(pool as any).query = () => new Promise(() => {});
B.prebuildCallBriefing("slow", Date.now());
const t0 = Date.now();
const slow = await B.takeCallBriefing("slow", Date.now());
check("a lookup that never answers costs the call at most ~1.5s and is simply not offered (never a long pause after hello)", Date.now() - t0 < 2500 && /Don't offer an event/.test(slow.findsNow) && /Pacific/.test(slow.rightNow));

// ---- wiring
const co = src("routes/co.ts");
check("both ways a call is registered take the briefing and pass the clock and the finds", (co.match(/takeCallBriefing\(userId\)/g) ?? []).length === 2 && (co.match(/rightNow: briefing\.rightNow,\s+findsNow: briefing\.findsNow/g) ?? []).length === 2);
check("an outbound call builds the briefing while the phone rings", /prebuildCallBriefing\(userId\)/.test(src("services/callTrigger.ts")));
check("the post-call audit is told what was on file to offer, so a real offer isn't flagged as invented", /offered: typeof vars\.finds_now === "string"/.test(co) && /anything offered from this list is on file/.test(co));
check("the call summary takes company names from the member's lines, not the assistant's (Boardy, not Bumble)", /Names of companies and people come from what THEY said/.test(src("services/callContext.ts")) && /"Bumble" for the member's "Boardy"/.test(src("services/callContext.ts")));
check("the registration passes the two variables to ElevenLabs", /right_now: o\.rightNow \?\? ""/.test(src("services/elevenLabsCalls.ts")) && /finds_now: o\.findsNow/.test(src("services/elevenLabsCalls.ts")));

// ---- the call brain behind our own endpoint, with the direct path as the rollback
{
  const on: any = E.buildAgentConfig({ name: "Co", prompt, voiceId: "v", apiUrl: "https://x.test", proxy: { url: "https://x.test/co/el/llm", secretId: "sec_1" } });
  const p: any = on.conversation_config.agent.prompt;
  check("proxy on: the agent's LLM is the custom one, at our endpoint, with the workspace secret as its bearer", p.llm === "custom-llm" && p.custom_llm.url === "https://x.test/co/el/llm" && p.custom_llm.api_key.secret_id === "sec_1" && p.custom_llm.api_type === "chat_completions", p.custom_llm);
  check("proxy on: the endpoint serves the same model (Haiku 4.5), the tools stay on the agent", p.custom_llm.model_id === "claude-haiku-4-5" && p.tools.length === tools.length);
  check("proxy off (the rollback): the direct Haiku path, no custom_llm at all", ap.llm === "claude-haiku-4-5" && !("custom_llm" in ap));
  check("the call's user id and token may ride to our endpoint (custom_llm_extra_body), and registration sends them", cfg.platform_settings.overrides.custom_llm_extra_body === true && /customLlmExtraBody: \{ user_id: o\.userId, call_token: callToken \}/.test(src("services/elevenLabsCalls.ts")));
  const push = src("scripts/pushElevenLabsAgent.ts");
  check("the push script turns the proxy on only with ELEVENLABS_LLM_PROXY=1 and the shared secret, and keeps it as a workspace secret", /ELEVENLABS_LLM_PROXY !== "1"\) return null/.test(push) && /CALL_LLM_PROXY_SECRET/.test(push) && /co_call_llm_proxy/.test(push));
}

// ---- cadence, offers, promises, member state (in the prompt, in code, so a push carries them)
{
  const gd = E.SPEED_GUIDE;
  check("cadence: short sentence, a beat, a longer one, a short one to land it; periods, commas, question marks only", /short sentence, a beat, then one a little longer/.test(gd) && /periods, commas and question marks/.test(gd));
  check("cadence: no dash of any kind, no semicolon, no parentheses, 15 words at most", /Never write a dash of any kind/.test(gd) && /never a semicolon, never parentheses/.test(gd) && /No sentence runs past 15 words/.test(gd));
  check("cadence: carries the wrong/right example from the real call", /Wrong: "That's smart—keeping it warm/.test(gd) && /Right: "That's smart\. Keep it warm first\./.test(gd));
  check("offers: name an event only from the finds or their own words; no source line, no name", /Name an event, place or time only if it is in "What Co has found for them" or they said it/.test(gd));
  check("promises: a promise to text or send is a real task the moment it is said, said once", /A promise to text or send something is a real task the moment you say it/.test(gd));
  check("member state: drained or overwhelmed outranks the list: two sentences, no pitch, no recap, no list, no question that asks more", /If they say they are tired, drained, overwhelmed/.test(gd) && /Close warmly in two sentences/.test(gd) && /No pitch, no recap, no list of what you are carrying, no new event, no question/.test(gd));
  check("the guide reaches the agent (it is part of promptForElevenLabs)", E.promptForElevenLabs(prompt).includes("# Their state comes first") && E.promptForElevenLabs(prompt).includes("# Cadence"));
  const ids = (cfg.platform_settings.evaluation.criteria as any[]).map((x) => x.id);
  check("the post-call grade has the three new criteria", ["drops_stale_claims_on_pushback", "sends_what_it_promised", "member_state_outranks_agenda"].every((i) => ids.includes(i)), ids);
  check("the new criteria are written so success is the good outcome, with the failure named", (cfg.platform_settings.evaluation.criteria as any[]).filter((x) => ["drops_stale_claims_on_pushback", "sends_what_it_promised", "member_state_outranks_agenda"].includes(x.id)).every((x) => /^Success if/.test(x.conversation_goal_prompt) && /Failure if/.test(x.conversation_goal_prompt)));
}
{
  const co2 = src("routes/co.ts");
  check("post-call: the source check on every named event and the commitment fallback both run", /recordOfferSourceCheck\(userId, conversationId/.test(co2) && /trackCommitmentsFromTranscript\(user_id, cleanTranscript\)/.test(co2));
  check("the commitment check runs every 10 minutes", /"\*\/10 \* \* \* \*"[\s\S]{0,200}checkCallCommitments/.test(src("jobs/index.ts")));
}

console.log(`call config: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
