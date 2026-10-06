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

check("Haiku's habits are named in the prompt: short speech, no 'I appreciate' opener, no AI disclaimer, never 'not how I work' for multi-day help", /about 60 words at most/.test(ap.prompt) && /Never open with "I appreciate"/.test(ap.prompt) && /No disclaimers about being an AI/.test(ap.prompt) && /never say it isn't how you work: tell them to text what they want and by when/.test(ap.prompt));

// ---- 5. keywords
const kw: string[] = c.asr.keywords;
check("the recognizer is told the names it got wrong: Co, Boardy, and the others", ["Co", "Boardy", "CoPatible", "Instinct", "Muse", "Luma"].every((k) => kw.includes(k)));

// ---- 7. capability sheet and member context
const sheet = B.CAPABILITY_SHEET;
check("the sheet is in the call prompt", ap.prompt.includes("# What Co can do today"));
check("it says Co does multi-day work and how to ask for it by text, and bans 'not how I work'", /works on it over the following days \(up to 30\)/.test(sheet) && /Text me what you want and by when/.test(sheet) && /Never say this is "not how I work"/.test(sheet));
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

console.log(`call config: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
