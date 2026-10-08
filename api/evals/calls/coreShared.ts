// Model-free checks for "calls use the same brain as texts" (2026-10-08 call review). No API calls, no database:
//   npx tsx evals/calls/coreShared.ts
// 1. The call prompt and the text reply's prompt are built from the same core constants (import, not copy).
// 2. No interview script is left: no phases, no topic checklist, no coverage tool, no turn template.
// 3. The call context: current situation first, corrected items never listed as current, the last calls dated.
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const core = await import("../../src/services/coCore.js");
const { CO_VOICE } = await import("../../src/services/coVoice.js");
const { DISCRETION_GUIDE } = await import("../../src/harness/discretion.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const CC = await import("../../src/services/callContext.js");
const O = await import("../../src/services/callOpening.js");
const { TEXT_LISTENING } = await import("../../src/agent/conversationReply.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${String(detail).slice(0, 400)}` : ""}`); } };
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

// ---- 1. one core, imported by both
const voiceLayer = read("prompts/co-system-prompt.md");
const callPrompt = E.promptForElevenLabs(voiceLayer);
const reply = read("src/agent/conversationReply.ts");
const elSrc = read("src/services/elevenLabsCalls.ts");
const parts = core.CO_CORE_PARTS;
check("the core's identity part is CO_VOICE itself (one definition of who Co is)", parts.voice === CO_VOICE);
check("the core is exactly its parts, in order", core.CO_CORE === [parts.voice, parts.listening, parts.grounding, parts.memberSafety, parts.safety].join("\n\n"));
check("texts: the reply's shared system block starts from CO_CORE, imported from coCore", /import \{ CO_CORE, CO_LISTENING \} from "\.\.\/services\/coCore\.js";/.test(reply) && /const sharedSystem = `\$\{CO_CORE\}\n/.test(reply));
check("texts: the listening block is the core's own constant (the old name kept for imports)", TEXT_LISTENING === core.CO_LISTENING && /export const TEXT_LISTENING = CO_LISTENING;/.test(reply));
check("calls: the facts and safety come from the same constants, imported from coCore", /import \{ CO_CORE_PARTS \} from "\.\/coCore\.js";/.test(elSrc) && /CO_CORE_PARTS\.grounding/.test(elSrc) && /CO_CORE_PARTS\.safety/.test(elSrc) && /CO_CORE_PARTS\.memberSafety/.test(elSrc));
// 2026-10-08 (Royce, after Co hung up on him): Hume's prompt is the call's voice. The text voice and listening blocks stay out of
// calls; what's true, safety and other members are shared, verbatim, once. The core's time and advice paragraphs ride along.
check("calls: what's true, safety and other members reach the call prompt verbatim, each once", [parts.grounding, parts.safety, parts.memberSafety].every((p) => callPrompt.split(p).length === 2));
check("calls: the text voice and listening blocks stay out (Hume's prompt is the voice)", !callPrompt.includes(parts.voice) && !callPrompt.includes(parts.listening) && !/bring them progress, a blocker/.test(callPrompt) && !/Say less than you could/.test(callPrompt));
check("calls: the core's time and advice paragraphs and its check-in rule ride along, verbatim", E.CALL_FROM_CORE.split("\n\n").every((x: string) => parts.voice.includes(x) || parts.listening.includes(x)) && E.CALL_FROM_CORE.split("\n\n").length === 3 && callPrompt.includes(E.CALL_FROM_CORE) && /when a professional should make the call/.test(callPrompt));
check("calls: Hume's prompt leads, then what Co knows, then what's true", callPrompt.startsWith("# On the phone\nYou are Co.") && callPrompt.indexOf("# What you know about") < callPrompt.indexOf(parts.grounding));
check("calls: the safety and other-member parts sit under the guardrails heading, and the discretion lines follow", callPrompt.indexOf("# Guardrails") < callPrompt.indexOf(parts.safety) && callPrompt.indexOf(parts.safety) < callPrompt.indexOf(parts.memberSafety) && callPrompt.indexOf(parts.memberSafety) < callPrompt.indexOf(DISCRETION_GUIDE));
// Not copied: no core sentence is typed out again in either channel's own files.
const sentencesOf = (t: string) => t.split(/(?<=[.!?:])\s+|\n/).map((s) => s.replace(/^- /, "").trim()).filter((s) => s.split(/\s+/).length >= 8);
const coreSentences = [parts.listening, parts.grounding, parts.memberSafety, parts.safety].flatMap(sentencesOf);
const copied = (src: string) => coreSentences.filter((s) => src.includes(s));
check("not copied: no core sentence is retyped in the reply, the call code or the voice layer", [reply, elSrc, voiceLayer].every((s) => copied(s).length === 0), [reply, elSrc, voiceLayer].flatMap(copied).join(" | "));
check("the safety rules stay as strict as the call guide's were", /everything else stops/.test(parts.safety) && /Ask plainly: "Are you safe right now\?"/.test(parts.safety) && /call or text 988, any time, free/.test(parts.safety) && /immediate danger, 911/.test(parts.safety) && /don't hand them off and leave/.test(parts.safety) && /for as long as they want to talk/.test(parts.safety) && /wanting to disappear, everyone being better off without them, not wanting to wake up/.test(parts.safety));
check("no role noun for Co anywhere, except in the voice layer's own \"never a concierge, a matchmaker...\" line", !/\b(concierge|assistant|matchmaker)\b/i.test([parts.listening, parts.grounding, parts.memberSafety, parts.safety, voiceLayer.replace(/never a concierge, a matchmaker, a therapist, an assistant, or an AI product/i, "")].join("\n")));

// ---- 2. no interview script
// 2026-10-08 (Royce): Hume's prompt is back, phases and all, as how Co organizes its attention. What stays out: the coverage tool,
// the 15-minute wrap-up, and any ready-made line for Co to say.
const script = /assess_conversation_coverage|elapsed_minutes|ready to summarize|"So it sounds like|"Of everything we just talked about|"That's what I needed|"Take your time\."|"Still there\?"|takes courage to sit with|finding your footing/i;
check("no coverage tool, wrap-up timer or ready-made line in the voice layer", !script.test(voiceLayer), voiceLayer.match(script)?.[0]);
check("no coverage tool, wrap-up timer or ready-made line in the built call prompt", !script.test(callPrompt), callPrompt.match(script)?.[0]);
check("no coverage tool on the agent", !JSON.stringify(E.buildAgentConfig({ name: "t", prompt: voiceLayer, voiceId: "v", apiUrl: "https://x.test" })).includes("assess_conversation_coverage"));
check("one question per turn, and any reflection is in Co's own words, new every time", /Ask one question per turn/.test(voiceLayer) && /in your own words, new every time/.test(voiceLayer) && /never a stock phrase that would fit anyone/.test(voiceLayer));
check("the phone basics hold: short spoken sentences, names as on file, goodbye once then end_call", /Short sentences, one thought each/.test(voiceLayer) && /use the spelling in what you know about them/.test(voiceLayer) && /Say that goodbye once/.test(voiceLayer) && /end_call/.test(voiceLayer) && /never asking whether they're still there/.test(voiceLayer));
check("calls act on the call: no 'after we hang up' instruction left (2026-10-08: calls run Co's tools)", !/when (?:we|you) hang up|after we hang up|look after the call/i.test(callPrompt), callPrompt.match(/[^.\n]*(?:hang up|after the call)[^.\n]*/i)?.[0]);
check("the voice layer is Hume's length, not a whole second prompt", voiceLayer.split(/\s+/).length < 4000, voiceLayer.split(/\s+/).length);

// ---- 3. the call context
const NOW = new Date("2026-10-08T01:00:00Z"); // Oct 7, 6pm Pacific
const corrections = [
  { field: "goals", old_value: "get Co's first paying customer/check", new_value: "pivoting to a partnership with Sequin AI after canceling the October launch date", corrected_at: "2026-10-07T17:00:00Z" },
  { field: "partner name", old_value: "Sequent AI", new_value: "Sequin AI", corrected_at: "2026-10-07T16:48:00Z" },
  { field: "goals", old_value: "launch Co's first in-person event (Oct 10th)", new_value: "shifting focus to a November event partnership with Jeremy/House of AI", corrected_at: "2026-10-05T17:00:00Z" },
  { field: "goals", old_value: "shifting focus to a November event partnership with Jeremy/House of AI", new_value: "partnering with Sequin AI for a November launch party", corrected_at: "2026-10-06T17:00:00Z" },
  { field: "goals", old_value: "solve venue/cost/permit issue via Civic Joy Fund or indoor space", new_value: null, corrected_at: "2025-09-25T17:00:00Z" },
];
check("a thread restating a corrected goal is retired", !!CC.retiredBy("figuring out how to get their first paying customer/check for Co", corrections, "2026-09-28T07:00:00Z"));
check("a thread about a plan they said was wrong is retired", !!CC.retiredBy("Civic Joy Fund no longer an option; still trying to find other sponsors for the event", corrections, "2025-09-24T07:00:00Z"));
check("a thread that says the corrected version is current", CC.retiredBy("partnering with Sequin AI for a November launch party at House of AI", corrections, "2026-10-07T20:00:00Z") === null);
check("a thread that came up again after the correction is current", CC.retiredBy("figuring out how to get their first paying customer/check for Co", corrections, "2026-10-07T20:00:00Z") === null);
check("an unrelated thread is current", CC.retiredBy("looking for a builder/founder community to connect with", corrections) === null && CC.retiredBy("looking for a dependable friend to go through the founder journey with", corrections) === null);
const settled = CC.renderSettled(corrections);
check("settled: the new version first, the old one only as (not ...), dated", /- goal, Oct 7: pivoting to a partnership with Sequin AI after canceling the October launch date \(not "get Co's first paying customer\/check"\)/.test(settled) && /- partner name, Oct 7: Sequin AI \(not "Sequent AI"\)/.test(settled), settled);
check("settled: a correction whose new version was itself corrected later is covered by the later one", !/Oct 5: shifting focus/.test(settled) && /Oct 6: partnering with Sequin AI/.test(settled), settled);
check("settled: a 'that's wrong' correction shows as not X", /not "solve venue\/cost\/permit issue via Civic Joy Fund or indoor space" \(they said that's wrong\)/.test(settled));
check("a corrected name is written the right way in Co's notes", CC.withCorrectedNames("A November partnership with Sequent AI, whose founder...", corrections) === "A November partnership with Sequin AI, whose founder..." && CC.withCorrectedNames("get Co's first paying customer", corrections) === "get Co's first paying customer");

const rows = [
  { created_at: "2026-10-08T00:30:52Z", memory_type: "text_exchange", content: "[Call] Royce has canceled Co's October launch date and is now planning a November event with Sequin AI, held at House of AI, and asked Co to draft a plan on Co's presence after the event." },
  { created_at: "2026-10-08T00:30:18Z", memory_type: "call_transcript", content: "assistant: Hey Royce, it's Co.\nuser: Uh, no. Our pivot now is the Sequin AI partnership in November." },
  { created_at: "2026-10-07T01:31:10Z", memory_type: "text_exchange", content: "[Call] Royce canceled an October event after Civic Joy Fund fell through and is shifting focus to a November partnership with Sequent AI, whose founder is throwing a launch party." },
  { created_at: "2026-10-07T01:30:23Z", memory_type: "call_transcript", content: "assistant: Hey Royce.\nuser: We're actually canceling the event, so that's out the window." },
  { created_at: "2026-10-03T21:07:29Z", memory_type: "text_exchange", content: "[Call] Royce called back and greeted Co." },
  { created_at: "2026-10-03T21:06:00Z", memory_type: "call_transcript", content: "assistant: Hi Royce.\nuser: Hey, I wanted to talk through the sponsor list for the party." },
];
const calls = CC.pairCalls(rows);
check("each call is paired with the summary written right after it, newest first", calls.length === 3 && /November event with Sequin AI/.test(calls[0].summary ?? "") && /Civic Joy Fund/.test(calls[1].summary ?? ""), JSON.stringify(calls));
check("a note too short to be a summary falls back to their own first words", calls[2].summary === null && /sponsor list for the party/.test(calls[2].theirWords.join(" ")));
const lastCalls = CC.renderLastCalls(calls.map((c) => ({ ...c, summary: c.summary ? CC.withCorrectedNames(c.summary, corrections) : null })), NOW);
check("the last calls are dated (day, and how long ago)", /^- Oct 7, today: Royce has canceled/.test(lastCalls) && /\n- Oct 6, yesterday: /.test(lastCalls) && /\n- Oct 3, 4 days ago: no summary on file; they said: "Hey, I wanted to talk through the sponsor list for the party\."/.test(lastCalls), lastCalls);
check("an older call's misheard name is written as corrected", !/Sequent/.test(lastCalls));

const summary = CC.assembleCallSummary({
  now: "What you're carrying for them and where each stands:\n- Offering to partner with Sequin AI on a November event at House of AI: in progress",
  lastCalls,
  settled,
  lessons: ["Use the correct partner name 'Sequin AI', not 'Sequent'."],
  sentLines: [],
  threads: [{ text: "looking for a builder/founder community (they said Sep 21, 16 days ago; OLD, so ask whether it is still true and never state it as current)" }],
  base: "Who they are:\nWork: Founder building Co",
});
const at = (h: string) => summary.indexOf(h);
check("the current situation comes first, then the last calls, then settled corrections", at("Where things stand now") === 0 && at("Where things stand now") < at("Your last calls with them") && at("Your last calls with them") < at("Settled (") && at("Settled (") < at("Who they are"), summary.slice(0, 300));
check("the corrected goal never appears as current: only inside its settled line", summary.split("\n").filter((l) => /first paying customer/.test(l)).every((l) => /\(not "get Co's first paying customer\/check"\)/.test(l)));
check("an OLD thread is listed as a question, after everything current", !/What they're in the middle of/.test(summary) && at("Older threads, not current") > at("Who they are"));
const forOpening = O.openingContext(summary);
check("the opening is written from the current part only: no older threads, no old side of a settled correction", !/Older threads|builder\/founder community|first paying customer|"Sequent AI"/.test(forOpening) && /Sequin AI/.test(forOpening), forOpening);
check("the opening is told to pick up one real thing (not always the same one), not something already off or done", /whatever a friend who knows them would naturally bring up/.test(O.openingPrompt({ firstName: "Royce", direction: "outbound", summary: forOpening })) && /Never pick up something they've already told Co is off, changed or done/.test(O.openingPrompt({ firstName: "Royce", direction: "outbound", summary: forOpening })));
// The 2026-10-08 rebuild wrote "I drafted the planning doc..." for a plan the after-call check had found nothing good enough to send for.
const pad = " pad".repeat(80);
check("the opening can't claim work Co didn't do", O.openingProblems("Hey Royce, it's Co. I drafted the plan for Sequin AI, want it?", forOpening + pad, "Royce") !== null && O.openingProblems("Hey Royce, it's Co. How is the Sequin AI plan coming?", "Co sent them the Sequin AI notes." + pad, "Royce") === null);
// 2026-10-08 (Royce): even work Co did is never the opening ("the PDF went out, wanted to make sure it landed"); this used to pass.
check("the opening never leads with Co's homework, even work the record shows", O.openingProblems("Hey Royce, it's Co. I sent the Sequin AI notes, did they land?", "Co sent them the Sequin AI notes." + pad, "Royce") === "leads with Co's homework");
check("the opening keeps its grounding checks", O.openingProblems("Hey Royce, it's Co. How did Berkeley go?", forOpening + pad, "Royce") !== null && O.openingProblems("Hey Royce, it's Co. How is the Sequin AI plan coming?", forOpening + pad, "Royce") === null);
const ctxSrc = read("src/services/callContext.ts");
check("the call context reads the same model of the person as texting, and the dated call rows", /personModelParts\(userId\)/.test(ctxSrc) && /memberType|memory_type = 'call_transcript'/.test(ctxSrc) && /content LIKE '\[Call\]%'/.test(ctxSrc));
check("every call-only part goes through the member strip", /const strip = async/.test(ctxSrc) && /stripOne\(c\.summary\)/.test(ctxSrc) && /strip\(c\.theirWords\)/.test(ctxSrc) && /strip\(stamped\)/.test(ctxSrc) && /strip\(carried\.open/.test(ctxSrc) && /strip\(carried\.theyHaveIt\)/.test(ctxSrc));

console.log(`calls share the text brain: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
