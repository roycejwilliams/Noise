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
let admits = new Set<string>(["On my side nothing broke"]);
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
    text = JSON.stringify({ onlyAdmission: [...admits].some((a) => norm(body).includes(norm(a))) });
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

// ---- 1. the facts the reply is given
{
  const asked = F.failureRecordFacts([{ decision: "call.dial", at: new Date("2026-10-28T22:50:48Z"), requested: "router_decision" }], { afterFailure: false, now });
  check("a call they asked for that failed: a plain fact, that Cue tried, that it failed on Cue's side, and that a report is on record", asked.length === 1 && asked[0].startsWith(R.FAILURE_FACT_PREFIX) && /Cue tried to place the call they asked for 4 minutes ago, and the call didn't go through/.test(asked[0]) && asked[0].endsWith(R.FAILURE_ON_RECORD), asked);
  const scheduled = F.failureRecordFacts([{ decision: "call.dial", at: crashedAt, requested: "scheduled_call" }], { afterFailure: false, now });
  check("a scheduled call is one they asked for", /the call they asked for/.test(scheduled[0]), scheduled);
  for (const kind of ["auto_intake", "checkin_cadence"]) {
    const own = F.failureRecordFacts([{ decision: "call.dial", at: crashedAt, requested: kind }], { afterFailure: false, now });
    check(`a call Cue started on its own (${kind}) is never "the call they asked for"`, /a call to them on its own just now \(they didn't ask for it\)/.test(own[0]) && !/they asked for/.test(own[0]), own);
  }
  check("a call with no recorded asker says neither", /Cue tried to place a call to them just now, and/.test(F.failureRecordFacts([{ decision: "call.dial", at: crashedAt, requested: null }], { afterFailure: false, now })[0]));
  const turn = F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "told_member" }], { afterFailure: true, now });
  check("a broken turn, on record", turn.length === 1 && /Cue's answer to their text just now broke on Cue's side/.test(turn[0]) && turn[0].endsWith(R.FAILURE_ON_RECORD), turn);
  const none = F.failureRecordFacts([], { afterFailure: true, now });
  check("Cue said something broke but nothing is in the record: the fact says no report of it is on record", none.length === 1 && none[0].endsWith(R.FAILURE_NOT_ON_RECORD), none);
  const unread = F.failureRecordFacts(null, { afterFailure: true, now });
  check("the record couldn't be read: the fact says so", unread.length === 1 && unread[0].endsWith(R.FAILURE_RECORD_UNKNOWN), unread);
  check("no failure and nothing broke: nothing is added (the golden cases' turns are unchanged)", F.failureRecordFacts([], { afterFailure: false, now }).length === 0 && F.failureRecordFacts(null, { afterFailure: false, now }).length === 0);
  check("a broken turn the replay answered isn't carried", F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "told_member", answeredSince: true }], { afterFailure: false, now }).length === 0);
  check("nor one Cue had already answered", F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "already_answered" }], { afterFailure: false, now }).length === 0);
  check("while their last line from Cue is still the 'something broke' note, it is", F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "told_member", answeredSince: true }], { afterFailure: true, now }).length === 1);
  const sameTurn = R.callNotPlacedFacts(R.dialFailureError({ stage: "dial", status: 401, code: "8001", message: "x" }, false));
  check("the call's own turn: one failure fact, Cue tried, a setup problem on Cue's side, no report on record", sameTurn.length === 1 && sameTurn[0].text.startsWith(`${R.FAILURE_FACT_PREFIX} Cue tried to call them just now, and the call didn't go through`) && /setup problem on Cue's side/.test(sameTurn[0].text) && sameTurn[0].text.endsWith(R.FAILURE_NOT_ON_RECORD), sameTurn);
  check("the gate's own blocks are not failures of Cue's", !R.callNotPlacedFacts("Call blocked: outside 8am-9pm their time").some(F.isFailureFact));
  check("the failure facts never use a word that reads as Cue having done something (so admissions elsewhere stay open)", ![...asked, ...turn, ...none, ...unread, sameTurn[0].text].some((t) => /\b(sent|delivered|texted|emailed|went out|saved|made them)\b/i.test(t)));
  const receipt = CT.feedbackReceipt("When a call attempt fails, Cue should be able to explain what went wrong instead of just apologizing.");
  check("the feedback receipt says exactly what was saved: their feedback, by its summary, and that it is not a report of a failure", /^Saved for the team: their feedback, summarized as "When a call attempt fails/.test(receipt) && /Only that feedback was saved; it is not a report of anything that broke on Cue's side\./.test(receipt));
  check("the tool writes that receipt (live and dry run)", (src("agent/conversationTools.ts").match(/ctx\.facts\?\.add\("did_this_turn", feedbackReceipt\(feedback\)\)/g) ?? []).length === 2);
}

// ---- 2. every probe sentence, through the real grounding
type RecState = "unreported" | "reported" | "unknown" | "call_unreported" | "call_reported";
// F1 the feedback receipt (the 10-28 one), F2 the failure, F3..F7 honest things Cue did this turn.
function facts(record: RecState | "none") {
  const rf = G.createReplyFacts();
  G.addFact(rf, "did_this_turn", CT.feedbackReceipt("When a call attempt fails, Cue should be able to explain what went wrong instead of just apologizing."));
  const failure =
    record === "unreported" ? F.failureRecordFacts([], { afterFailure: true, now })[0]
    : record === "reported" ? F.failureRecordFacts([{ decision: "turn.failed", at: crashedAt, action: "told_member" }], { afterFailure: true, now })[0]
    : record === "unknown" ? F.failureRecordFacts(null, { afterFailure: true, now })[0]
    : record === "call_unreported" ? R.callNotPlacedFacts(R.dialFailureError({ stage: "dial", status: 401, code: "8001", message: "x" }, false))[0].text
    : record === "call_reported" ? R.callNotPlacedFacts(R.dialFailureError({ stage: "dial", status: 401, code: "8001", message: "x" }, true))[0].text
    : "They're in San Francisco.";
  G.addFact(rf, "known", failure);
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

// [sentence, the claims a model plausibly returns per record state, kept?]
type Probe = { s: string; claims: (rec: RecState | "none") => ScriptClaim[]; keep: Partial<Record<RecState | "none", boolean>> };
// A report claim: with no report on record a model plausibly cites the feedback receipt (F1); with one on record, the failure (F2).
const reportClaim = (s: string, extra: ScriptClaim[] = []) => (rec: RecState | "none") => [whole(s, rec === "reported" || rec === "call_reported" ? "F2" : "F1"), ...extra];
const probes: Probe[] = [
  // Honest admissions of the failure: the failure fact backs them, whatever its record says, and they aren't cut as machinery talk.
  { s: "It didn't go through on my end.", claims: () => [whole("It didn't go through on my end.", "F2")], keep: { call_unreported: true, call_reported: true, unreported: true, reported: true, unknown: true } },
  { s: "It's a setup problem on my side.", claims: () => [whole("It's a setup problem on my side.", "F2", true, "detail")], keep: { call_unreported: true, call_reported: true } },
  { s: "That's on my side, not you.", claims: () => [whole("That's on my side, not you.", "F2", true, "detail")], keep: { call_unreported: true, unreported: true, reported: true } },
  { s: "The call just didn't go through on my end.", claims: () => [whole("The call just didn't go through on my end.", "F2")], keep: { call_unreported: true, unreported: true, reported: true } },
  // An admission that carries an invented action: the model finds the action unsupported (as one claim or split), and it's cut.
  { s: "The call didn't go through, so I booked the table instead.", claims: () => [whole("The call didn't go through, so I booked the table instead.", null, false)], keep: { unreported: false, reported: false, call_unreported: false } },
  { s: "The call didn't go through, so I booked the table.", claims: () => [whole("The call didn't go through", "F2"), whole("I booked the table", null, false)], keep: { unreported: false, reported: false } },
  // False admissions: about their life, or a denial the failure fact contradicts.
  { s: "Your call with Maya didn't go through?", claims: () => [whole("Your call with Maya didn't go through", null, false, "other_person")], keep: { unreported: false, reported: false } },
  { s: "On my side nothing broke.", claims: () => [whole("On my side nothing broke.", null, false)], keep: { unreported: false, reported: false, call_unreported: false } },
  // Reports of the failure: cut unless a report of it is on record.
  { s: "I've flagged it so it gets looked at.", claims: reportClaim("I've flagged it so it gets looked at."), keep: { unreported: false, unknown: false, call_unreported: false, reported: true, call_reported: true } },
  { s: "The call didn't go through on my end, and I've flagged it so it gets looked at.", claims: reportClaim("The call didn't go through on my end, and I've flagged it so it gets looked at."), keep: { unreported: false, call_unreported: false, reported: true, call_reported: true } },
  { s: "Nothing you did, I've flagged it.", claims: reportClaim("Nothing you did, I've flagged it."), keep: { unreported: false, reported: true } },
  { s: "The call didn't go through - I've flagged it.", claims: reportClaim("The call didn't go through - I've flagged it."), keep: { unreported: false, reported: true } },
  { s: "I've shared it with the team.", claims: (rec) => [whole("I've shared it with the team.", rec === "reported" ? "F2" : null, rec === "reported")], keep: { unreported: false, unknown: false, reported: true } },
  { s: "The team has it.", claims: (rec) => [whole("The team has it.", rec === "reported" ? "F2" : null, rec === "reported")], keep: { unreported: false, reported: true } },
  { s: "Flagged.", claims: reportClaim("Flagged."), keep: { unreported: false, reported: true } },
  { s: "I've let the right people know.", claims: reportClaim("I've let the right people know."), keep: { unreported: false, call_unreported: false, reported: true } },
  // Honest past actions about other things: they stand on their own facts, failure or not.
  { s: "I logged that run for you.", claims: () => [whole("I logged that run for you.", "F3")], keep: { unreported: true, reported: true, none: true } },
  { s: "I flagged that deadline.", claims: () => [whole("I flagged that deadline.", "F4")], keep: { unreported: true, reported: true } },
  { s: "I let them know you're coming.", claims: () => [whole("I let them know you're coming.", "F5")], keep: { unreported: true } },
  { s: "I passed it along to Sarah.", claims: () => [whole("I passed it along to Sarah.", "F6")], keep: { unreported: true } },
  { s: "I flagged the two events you might like.", claims: () => [whole("I flagged the two events you might like.", "F7")], keep: { unreported: true } },
];
for (const p of probes) {
  for (const [rec, keep] of Object.entries(p.keep) as [RecState | "none", boolean][]) {
    const r = await ground(p.s, rec, p.claims(rec));
    if (process.env.SHOW_FINALS) console.log(`[${rec}] ${keep ? "KEEP" : "CUT "} ${JSON.stringify(r.final)}`);
    check(`[${rec}] "${p.s}" is ${keep ? "kept" : "cut"}`, r.kept === keep, { final: r.final, failed: r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.reason}`) });
  }
}

// ---- 3. what the claim check does on its own, without a phrase list
{
  // Only the failure in the facts (no feedback receipt, nothing "saved" or "sent"), so nothing else counts as on record.
  const rf = G.createReplyFacts();
  G.addFact(rf, "known", F.failureRecordFacts([], { afterFailure: true, now })[0]);
  const [denial] = G.claimChecks([{ text: "On my side nothing broke", type: "past_action", supported: false, factId: null, quote: null }], rf, srcFor as any, await G.admissionsFor([{ text: "On my side nothing broke", type: "past_action", supported: false, factId: null, quote: null }]));
  check("a denial the judge calls an admission still needs support while a failure is in view", denial.pass === false, denial);
  const rfQuiet = G.createReplyFacts();
  const [noFailure] = G.claimChecks([{ text: "On my side nothing broke", type: "past_action", supported: false, factId: null, quote: null }], rfQuiet, srcFor as any, await G.admissionsFor([{ text: "On my side nothing broke", type: "past_action", supported: false, factId: null, quote: null }]));
  check("(with no failure in view, the judge's admission stands as before)", noFailure.pass === true, noFailure);
  const team = facts("unreported");
  const [pass] = G.claimChecks([{ text: "I've passed that along to the team.", type: "past_action", supported: false, factId: null, quote: null }], team, srcFor as any);
  check("with a failure unreported, the feedback receipt doesn't force-pass a team claim (TEAM_PASS skipped)", pass.pass === false, pass);
  const quiet = facts("none");
  const [plain] = G.claimChecks([{ text: "I've passed that along to the team.", type: "past_action", supported: false, factId: null, quote: null }], quiet, srcFor as any);
  check("with no failure in view, passing their feedback to the team still stands on its receipt", plain.pass === true, plain);
  const [cited] = G.claimChecks([{ text: "I've passed your note on tone to the team.", type: "past_action", supported: true, factId: "F1", quote: null }], quiet, srcFor as any);
  check("and citing the receipt for it works as before", cited.pass === true, cited);
  check("no phrase classifier for flag claims or admissions is left", !/FLAG_CLAIM|FAILURE_ADMISSION|failureAdmitted|failureSpoken|flagClaim/.test(src("services/turnFailure.ts") + src("harness/replyGrounding.ts")));
  // The narration exemption: only a sentence whose claims all stand on the failure fact.
  const mixed = facts("reported");
  G.claimChecks([{ text: "It didn't go through on my end", type: "past_action", supported: true, factId: "F2", quote: null }, { text: "my end is clear now", type: "detail", supported: true, factId: "F3", quote: null }], mixed, srcFor as any);
  check("a sentence whose claims all cite the failure fact is exempt from the machinery-talk cut", G.failureBackedSentence(mixed, "It didn't go through on my end."));
  check("one with a claim resting on anything else is not", !G.failureBackedSentence(mixed, "It didn't go through on my end, and my end is clear now."));
  check("nor a sentence the claim read found nothing in", !G.failureBackedSentence(mixed, "On my end, all good."));
  check("nor a fragment of a backed claim said on its own", !G.failureBackedSentence(mixed, "On my end."));
  // The incident line is read for claims even though it isn't claim-shaped, so it can stand on the failure fact.
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
