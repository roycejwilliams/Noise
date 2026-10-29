// "I've flagged it" only when a report of the failure is really on record (2026-10-28). Royce's "Call me" crashed the turn (Twilio
// refused the dial), he asked "What happened?", and Cue said "I've flagged it so it gets looked at". Nothing had reported the failure:
// the one thing saved for the team that turn was his own question, turned into a suggestion by saveFeedbackForTeam, and its generic
// "Saved for the team" receipt backed the claim, while the honest "the call just didn't go through on my end" was cut as machinery talk.
//
// The fix guards facts, not phrasings (re-review of #303): the failure is a plain fact in the turn (what failed, that Cue tried, whether a
// report is on record), the feedback receipt says exactly what was saved, and the fact check judges Cue's words against those facts.
// Every probe sentence goes through the real grounding (groundReply: claimChecks, codeChecks, the cut) with the model scripted to
// answer what a model plausibly answers, including the whole sentence as one claim and supported:true citing the feedback receipt.
// Layer 1: no real model, no network.
//   TZ=UTC node evals/runLayer1.mjs evals/silence/failureRecord.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";

type ScriptClaim = { text: string; type: string; supported: boolean; factId: string | null; quote?: string | null };
// The claim read's answer: every scripted claim whose text is in the message it was asked about (a recheck reads only part of it).
let script: ScriptClaim[] = [];
// Claims the admission judge calls "only an admission it didn't happen": the worst case for a false denial, from the start (the judge's
// answers are cached per claim for the whole run).
let admits = new Set<string>(["On my side nothing broke", "It didn't go through on my end", "The call just didn't go through on my end", "The call didn't go through"]);
let claimReads = 0;
const norm = (s: string) => s.replace(/\\"/g, '"').replace(/[’‘]/g, "'").toLowerCase();
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const body = String(init?.body ?? "");
  let text = "";
  if (/You check a text message Cue is about to send/.test(body)) {
    claimReads++;
    const about = norm(body.split("Message Cue is about to send:").pop() ?? "");
    text = JSON.stringify({ claims: script.filter((c) => about.includes(norm(c.text))).map((c) => ({ quote: null, ...c })) });
  } else if (/Does this line assert anything that happened/.test(body)) {
    // The one line it's asked about, exactly: a longer line that only starts with an admission is not one.
    const line = norm(body).match(/about to send this line:\\n"(.*?)"\\n/)?.[1] ?? "";
    text = JSON.stringify({ onlyAdmission: [...admits].some((a) => norm(a) === line) });
  } else if (/Only the member knows where it stands/.test(body)) {
    text = JSON.stringify({ reports: [] });
  }
  // Redrafts and anything else get nothing: what's left of the draft is what goes out.
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "scripted", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const F = await import("../../src/services/turnFailure.js");
const R = await import("../../src/services/callReasons.js");
const G = await import("../../src/harness/replyGrounding.js");
const D = await import("../../src/harness/devReview.js");
const CT = await import("../../src/agent/conversationTools.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const now = new Date("2026-10-28T22:54:48Z");
const crashedAt = new Date("2026-10-28T22:54:09Z");

// ---- 1. the facts the reply is given: what failed, and its report status, as two facts
const what = (facts: string[]) => facts.filter((t) => t.startsWith(R.FAILURE_FACT_PREFIX));
const status = (facts: string[]) => facts.filter((t) => t.startsWith(R.FAILURE_REPORT_PREFIX));
{
  const asked = F.failureRecordFacts([{ decision: "call.dial", at: new Date("2026-10-28T22:50:48Z"), requested: "router_decision" }], { afterFailure: false, now });
  check("a call they asked for that failed: what failed (Cue tried, Cue's side), and separately that a report is on record", what(asked).length === 1 && /Cue tried to place the call they asked for 4 minutes ago, and the call didn't go through/.test(what(asked)[0]) && !/report/i.test(what(asked)[0]) && status(asked).length === 1 && status(asked)[0].endsWith(R.FAILURE_ON_RECORD), asked);
  check("a scheduled call is one they asked for", /the call they asked for/.test(what(F.failureRecordFacts([{ decision: "call.dial", at: crashedAt, requested: "scheduled_call" }], { afterFailure: false, now }))[0]));
  for (const kind of ["auto_intake", "checkin_cadence"]) {
    const own = what(F.failureRecordFacts([{ decision: "call.dial", at: crashedAt, requested: kind }], { afterFailure: false, now }));
    check(`a call Cue started on its own (${kind}) is never "the call they asked for"`, /a call to them on its own just now \(they didn't ask for it\)/.test(own[0]) && !/they asked for/.test(own[0]), own);
  }
  check("a call with no recorded asker says neither", /Cue tried to place a call to them just now, and/.test(what(F.failureRecordFacts([{ decision: "call.dial", at: crashedAt, requested: null }], { afterFailure: false, now }))[0]));
  const turn = F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "told_member" }], { afterFailure: true, now });
  check("a broken turn, on record", /Cue's answer to their text just now broke on Cue's side/.test(what(turn)[0] ?? "") && status(turn)[0]?.endsWith(R.FAILURE_ON_RECORD), turn);
  const none = F.failureRecordFacts([], { afterFailure: true, now });
  check("Cue said something broke but nothing is in the record: no report", what(none).length === 1 && status(none)[0]?.endsWith(R.FAILURE_NOT_ON_RECORD), none);
  const unread = F.failureRecordFacts(null, { afterFailure: true, now });
  check("the record couldn't be read: said so", what(unread).length === 1 && status(unread)[0]?.endsWith(R.FAILURE_RECORD_UNKNOWN), unread);
  check("no failure and nothing broke: nothing is added (the golden cases' turns are unchanged)", F.failureRecordFacts([], { afterFailure: false, now }).length === 0 && F.failureRecordFacts(null, { afterFailure: false, now }).length === 0);
  check("a broken turn a real reply came after isn't carried", F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "told_member", answeredSince: true }], { afterFailure: false, now }).length === 0);
  check("nor one Cue had already answered", F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "already_answered" }], { afterFailure: false, now }).length === 0);
  check("nor a failed call a real reply came after (member-asked or Cue's own)", ["router_decision", "auto_intake"].every((k) => F.failureRecordFacts([{ decision: "call.dial", at: crashedAt, requested: k, answeredSince: true }], { afterFailure: false, now }).length === 0));
  check("while their last line from Cue is still the 'something broke' note, its turn is carried, as on record", status(F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "told_member", answeredSince: true }], { afterFailure: true, now }))[0]?.endsWith(R.FAILURE_ON_RECORD));
  const sb = src("routes/sendblue.ts");
  check("one window for both reads: owedAnswer looks back as far as the failure record", F.FAILURE_RECORD_WINDOW_MINUTES === 30 && /created_at > NOW\(\) - make_interval\(mins => \$2\)\s*ORDER BY created_at DESC LIMIT 6`,\s*\/\/[^\n]*\n\s*\[userId, FAILURE_RECORD_WINDOW_MINUTES\]/.test(sb));
  check("the failure read starts with the turn's other reads, before the reply target is awaited", sb.indexOf("const failureRowsP = hasText ? readFailureRows(") > 0 && sb.indexOf("const failureRowsP = hasText ? readFailureRows(") < sb.indexOf("const inlineTarget = await repliedToP;") && /const failureRows = await failureRowsP;/.test(sb));
  const sameTurn = R.callNotPlacedFacts(R.dialFailureError({ stage: "dial", status: 401, code: "8001", message: "x" }, false));
  check("the call's own turn: what failed (Cue tried, a setup problem on Cue's side) and, separately, no report", sameTurn.length === 2 && sameTurn[0].text.startsWith(`${R.FAILURE_FACT_PREFIX} Cue tried to call them just now, and the call didn't go through`) && /setup problem on Cue's side/.test(sameTurn[0].text) && !/report/i.test(sameTurn[0].text) && sameTurn[1].text === R.failureReportFact("not_on_record"), sameTurn);
  check("the gate's own blocks are not failures of Cue's", !R.callNotPlacedFacts("Call blocked: outside 8am-9pm their time").some(F.isFailureFact));
  check("the failure facts never use a word that reads as Cue having done something (so admissions elsewhere stay open)", ![...asked, ...turn, ...none, ...unread, ...sameTurn.map((x) => x.text)].some((t) => /\b(sent|delivered|texted|emailed|went out|saved|made them)\b/i.test(t)));
  const receipt = CT.feedbackReceipt("When a call attempt fails, Cue should be able to explain what went wrong instead of just apologizing.");
  check("the feedback receipt says exactly what was saved: their feedback, by its summary, and that it is not a report of a failure", /^Saved for the team: their feedback, summarized as "When a call attempt fails/.test(receipt) && /Only that feedback was saved; it is not a report of anything that broke on Cue's side\./.test(receipt));
  check("the tool writes that receipt (live and dry run)", (src("agent/conversationTools.ts").match(/ctx\.facts\?\.add\("did_this_turn", feedbackReceipt\(feedback\)\)/g) ?? []).length === 2);
}

// ---- 2. every probe sentence, through the real grounding
type RecState = "unreported" | "reported" | "unknown" | "call_unreported" | "call_reported";
const ON_RECORD = new Set<string>(["reported", "call_reported"]);
// F1 the feedback receipt (the 10-28 one), F2 what failed, F3 its report status, F4..F8 honest things Cue did this turn.
function facts(record: RecState | "none") {
  const rf = G.createReplyFacts();
  G.addFact(rf, "did_this_turn", CT.feedbackReceipt("When a call attempt fails, Cue should be able to explain what went wrong instead of just apologizing."));
  const pair: string[] =
    record === "unreported" ? F.failureRecordFacts([], { afterFailure: true, now })
    : record === "reported" ? F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "told_member" }], { afterFailure: true, now })
    : record === "unknown" ? F.failureRecordFacts(null, { afterFailure: true, now })
    : record === "call_unreported" ? R.callNotPlacedFacts(R.dialFailureError({ stage: "dial", status: 401, code: "8001", message: "x" }, false)).map((x) => x.text)
    : record === "call_reported" ? R.callNotPlacedFacts(R.dialFailureError({ stage: "dial", status: 401, code: "8001", message: "x" }, true)).map((x) => x.text)
    : ["They're in San Francisco.", "They like live jazz."];
  for (const t of pair) G.addFact(rf, "known", t);
  G.addFact(rf, "did_this_turn", "Logged their 5k run from this morning.");
  G.addFact(rf, "did_this_turn", "Flagged their Friday grant deadline in their plan.");
  G.addFact(rf, "did_this_turn", "Let Sarah's host know they're coming Saturday.");
  G.addFact(rf, "did_this_turn", "Passed their dinner idea along to Sarah.");
  G.addFact(rf, "did_this_turn", "Flagged two events they might like this weekend.");
  return rf;
}
const srcFor = { message: "What happened?", recentConversation: `User said: Call me\nCo replied: ${F.TURN_FAILED_NOTE}` };
async function ground(sentence: string, record: RecState | "none", claims: ScriptClaim[]) {
  script = claims;
  const rf = facts(record);
  const r = await G.groundReply(`Thanks for asking. ${sentence}`, rf, srcFor as any, { userId: null, record: false });
  return { final: r.final, kept: norm(r.final).includes(norm(sentence).replace(/[.?!]$/, "")), checks: r.checks };
}
const whole = (text: string, factId: string | null, supported = true, type = "past_action"): ScriptClaim => ({ text: text.replace(/[.?]$/, ""), type, supported, factId });
const outcome = async (label: string, sentence: string, rec: RecState | "none", claims: ScriptClaim[], keep: boolean) => {
  const r = await ground(sentence, rec, claims);
  if (process.env.SHOW_FINALS) console.log(`[${rec}] ${keep ? "KEEP" : "CUT "} ${label} ${JSON.stringify(r.final)}`);
  check(`[${rec}] ${label}: "${sentence}" is ${keep ? "kept" : "cut"}`, r.kept === keep, { final: r.final, failed: r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.reason}`) });
};
const ALL: RecState[] = ["unreported", "unknown", "call_unreported", "reported", "call_reported"];

// Honest admissions of the failure. The judge reads them as only admitting it; they cite what failed, or (the 10-28 shape) the reader
// marks them supported with nothing to cite. Kept in every record state, and never cut as machinery talk.
for (const s of ["It didn't go through on my end.", "The call just didn't go through on my end."]) {
  for (const rec of ALL) {
    await outcome("citing what failed", s, rec, [whole(s, "F2")], true);
    await outcome("supported, nothing cited", s, rec, [whole(s, null)], true);
  }
}
for (const rec of ["call_unreported", "call_reported"] as RecState[]) await outcome("citing what failed", "It's a setup problem on my side.", rec, [whole("It's a setup problem on my side.", "F2", true, "detail")], true);
for (const rec of ["call_unreported", "unreported", "reported"] as RecState[]) await outcome("citing what failed", "That's on my side, not you.", rec, [whole("That's on my side, not you.", "F2", true, "detail")], true);
// An admission carrying an invented action, and false admissions.
for (const rec of ["unreported", "reported", "call_unreported"] as RecState[]) {
  await outcome("one claim, unsupported", "The call didn't go through, so I booked the table instead.", rec, [whole("The call didn't go through, so I booked the table instead.", null, false)], false);
  const split = await ground("The call didn't go through, so I booked the table.", rec, [whole("The call didn't go through", "F2"), whole("I booked the table", null, false)]);
  check(`[${rec}] split: the invented booking never goes out`, !/booked/.test(split.final), split.final);
  await outcome("about their life", "Your call with Maya didn't go through?", rec, [whole("Your call with Maya didn't go through", null, false, "other_person")], false);
  await outcome("a denial the failure contradicts", "On my side nothing broke.", rec, [whole("On my side nothing broke.", null, false)], false);
}
// Reports of the failure, each scripted citing the feedback receipt (F1), what failed (F2) and the report status (F3). Kept only when a
// report is on record and the claim cites the status (or, with a report on record, the receipt); what failed never backs a report.
const reports = ["I've flagged it so it gets looked at.", "Nothing you did, I've flagged it.", "The call didn't go through - I've flagged it.", "I've shared it with the team.", "The team has it.", "Flagged.", "I've let the right people know."];
for (const s of reports) {
  for (const rec of ALL) {
    await outcome("citing the feedback receipt", s, rec, [whole(s, "F1")], ON_RECORD.has(rec));
    await outcome("citing what failed", s, rec, [whole(s, "F2")], false);
    await outcome("citing the report status", s, rec, [whole(s, "F3")], ON_RECORD.has(rec));
    // With a report on record, TEAM_PASS's force-pass on the feedback receipt works as before; with none, it's skipped.
    await outcome("unsupported", s, rec, [whole(s, null, false)], ON_RECORD.has(rec) && G.TEAM_PASS.test(s) && !G.TEAM_PASS_PLUS.test(s));
  }
}
// A report said with an admission in machinery words: only what-failed citations exempt a sentence from the machinery-talk cut, so it
// never goes out whole, as one claim or split, whatever it cites.
const both = "The call didn't go through on my end, and I've flagged it so it gets looked at.";
for (const rec of ALL) {
  for (const cite of ["F1", "F2", "F3"]) await outcome(`one claim citing ${cite}`, both, rec, [whole(both, cite)], false);
  for (const cite of ["F1", "F2", "F3"]) await outcome(`split, the report citing ${cite}`, both, rec, [whole("The call didn't go through on my end", "F2"), whole("I've flagged it so it gets looked at", cite)], false);
}
// Honest past actions about other things: they stand on their own facts, failure or not.
const honest: [string, string][] = [["I logged that run for you.", "F4"], ["I flagged that deadline.", "F5"], ["I let them know you're coming.", "F6"], ["I passed it along to Sarah.", "F7"], ["I flagged the two events you might like.", "F8"]];
for (const [s, cite] of honest) for (const rec of ["unreported", "reported", "none"] as (RecState | "none")[]) await outcome(`citing ${cite}`, s, rec, [whole(s, cite)], true);

// ---- 3. what the claim check does on its own, without a phrase list
{
  // Only the failure in the facts (no feedback receipt, nothing "saved" or "sent"), so nothing else counts as on record.
  const rf = G.createReplyFacts();
  for (const t of F.failureRecordFacts([], { afterFailure: true, now })) G.addFact(rf, "known", t);
  const denialClaim = { text: "On my side nothing broke", type: "past_action" as const, supported: false, factId: null, quote: null };
  const [denial] = G.claimChecks([denialClaim], rf, srcFor as any, await G.admissionsFor([denialClaim]));
  check("a denial the judge calls an admission still needs support while a failure is in view", denial.pass === false, denial);
  const [noFailure] = G.claimChecks([denialClaim], G.createReplyFacts(), srcFor as any, await G.admissionsFor([denialClaim]));
  check("(with no failure in view, the judge's admission stands as before)", noFailure.pass === true, noFailure);
  const [statusOnly] = G.claimChecks([{ text: "There's no report of it yet", type: "detail", supported: true, factId: "F2", quote: null }], rf, srcFor as any);
  check("a 'no report' status fact supports nothing, not even a claim restating it", statusOnly.pass === false, statusOnly);
  const team = facts("unreported");
  const [pass] = G.claimChecks([{ text: "I've passed that along to the team.", type: "past_action", supported: false, factId: null, quote: null }], team, srcFor as any);
  check("with a failure unreported, the feedback receipt doesn't force-pass a team claim (TEAM_PASS skipped)", pass.pass === false, pass);
  const quiet = facts("none");
  const [plain] = G.claimChecks([{ text: "I've passed that along to the team.", type: "past_action", supported: false, factId: null, quote: null }], quiet, srcFor as any);
  check("with no failure in view, passing their feedback to the team still stands on its receipt", plain.pass === true, plain);
  const [cited] = G.claimChecks([{ text: "I've passed your note on tone to the team.", type: "past_action", supported: true, factId: "F1", quote: null }], quiet, srcFor as any);
  check("and citing the receipt for it works as before", cited.pass === true, cited);
  check("no phrase classifier for flag claims or admissions is left", !/FLAG_CLAIM|FAILURE_ADMISSION|failureAdmitted|failureSpoken|flagClaim/.test(src("services/turnFailure.ts") + src("harness/replyGrounding.ts")));
  // The narration exemption: only a sentence whose claims all rest on what failed.
  const mixed = facts("reported");
  const adm = { text: "It didn't go through on my end", type: "past_action" as const, supported: true, factId: "F2", quote: null };
  G.claimChecks([adm, { text: "my end is clear now", type: "detail", supported: true, factId: "F4", quote: null }, { text: "I've flagged it on my end", type: "past_action", supported: true, factId: "F3", quote: null }], mixed, srcFor as any, await G.admissionsFor([adm]));
  check("a sentence whose claims all rest on what failed is exempt from the machinery-talk cut", G.failureBackedSentence(mixed, "It didn't go through on my end."));
  check("one with a claim resting on anything else is not", !G.failureBackedSentence(mixed, "It didn't go through on my end, and my end is clear now."));
  check("a claim resting on the report status (even on record) exempts nothing", !G.failureBackedSentence(mixed, "I've flagged it on my end."));
  check("nor a sentence the claim read found nothing in", !G.failureBackedSentence(mixed, "On my end, all good."));
  check("nor a fragment of a backed claim said on its own", !G.failureBackedSentence(mixed, "On my end."));
  // A machinery-sounding line on a failure turn is read for claims even when it isn't claim-shaped, so it can stand on what failed.
  claimReads = 0;
  script = [whole("That's on my side, not you.", "F2", true, "detail")];
  await G.groundReply("That's on my side, not you.", facts("call_unreported"), srcFor as any, { userId: null, record: false });
  check("with a failure in view, a machinery-sounding line gets a claim read", claimReads > 0);
}

// ---- 4. the call-failure instruction splits by cause (Royce's copy, 2026-10-28)
{
  const sb = src("routes/sendblue.ts");
  const m = sb.match(/dialFailure\s*\?\s*(`[^`]*`)\s*:\s*(`[^`]*`),/);
  const dial = m?.[1] ?? "", gate = m?.[2] ?? "";
  check("a dial failure gets its own instruction", /const dialFailure = parseDialFailure\(callResult\.error\);/.test(sb) && !!m);
  check("dial failure: it says the call didn't go through, on Cue's side, in a line", /Cue did try, but the call didn't go through/.test(dial) && /Say plainly, in a line, that the call didn't go through and that it's a problem on Cue's side\./.test(dial));
  check("dial failure: on a 401/403, asking again right now won't help", /\$\{dialFailure\.setup \? " Add that asking again right now won't help\." : ""\}/.test(dial));
  check("dial failure: never sends them to ask again, never promises a callback, never 'calling you now'", /Don't suggest they ask again, don't promise to call back on your own, and never say you're calling them now\./.test(dial) && !/call me/.test(dial));
  check("dial failure: no quoted example lines", !/"/.test(dial.replace(/\$\{[^}]*\}/g, "")));
  check("a gate block keeps today's meaning: no call went out, why, ask again once allowed, never say you tried", /no call went out this time: \$\{why\}/.test(gate) && /text "call me" again once it's allowed/.test(gate) && /Never say you tried or that it didn't go through/.test(gate));
  check("co-test's call route answers 502 for a dial that never started", /res\.status\(result\.dialFailed \? 502 : 404\)/.test(fs.readFileSync(new URL("../../../co-test/src/routes/phone.ts", import.meta.url), "utf8")));
}

// ---- 5. the report: the cause is on the turn.failed row, and the morning review flags it
{
  const sb = src("routes/sendblue.ts");
  check("a crashed turn's report carries what the error said (nothing private)", /tellMemberTurnFailed\(lockKey, replay\?\.receivedAt \?\? turnStartedAt, "turn_error", \(error as any\)\?\.constructor\?\.name \?\? "Error", \{ detail: failureDetail\(error\) \}\)/.test(sb) && /proposal: \{ source, errorClass, \.\.\.\(o\.detail \? \{ detail: o\.detail \} : \{\}\) \}/.test(sb));
  check("each text reads its recent failures back and adds them as facts", /for \(const f of failureRecordFacts\(failureRows, \{ afterFailure: !!owed\?\.afterFailure, now: new Date\(\) \}\)\) addFact\(replyFacts, "known", f\);/.test(sb));
  const flags = D.logFlags({ userId: "u", firstName: "Jordan", messages: [{ at: "2026-10-28T22:54:04Z", from: "member", text: "Call me" } as any], decisions: [{ id: 1, at: "2026-10-28T22:54:09Z", decision: "turn.failed", outcome: "act", action: "told_member", reason: null, proposal: { source: "turn_error", errorClass: "RestException", detail: { status: 401, code: "8001", message: "actor doesn't have any assertions" } }, checks: [] } as any], emotions: [], issues: [] });
  const f = flags.find((x) => x.type === "turn_failed");
  check("a broken turn is a high flag in the morning review, with its cause", f?.severity === "high" && /RestException, HTTP 401, code 8001, actor doesn't have any assertions/.test(f?.cause ?? "") && f?.causeConfirmed === true, flags);
}

console.log(`failure record: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
