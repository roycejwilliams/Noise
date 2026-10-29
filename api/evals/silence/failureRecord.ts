// "I've flagged it" only when the failure's report is really on record (2026-10-28). Royce's "Call me" crashed the turn (Twilio refused
// the dial), he asked "What happened?", and Cue said "I've flagged it so it gets looked at". Nothing had reported the failure: the
// turn.failed row said only "Error", and the one thing saved for the team that turn was his own question, turned into a suggestion by
// saveFeedbackForTeam, whose receipt then backed the flag claim; the honest sentence ("the call just didn't go through on my end") was
// cut as machinery talk. Layer 1: no model, no network.
//   TZ=UTC node evals/runLayer1.mjs evals/silence/failureRecord.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const F = await import("../../src/services/turnFailure.js");
const R = await import("../../src/services/callReasons.js");
const G = await import("../../src/harness/replyGrounding.js");
const D = await import("../../src/harness/devReview.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const empty = { message: "What happened?", recentConversation: "", contextSummary: "", recentMemories: "", sentThisTurn: [] };
const now = new Date("2026-10-28T22:54:48Z");

// ---- 1. what the next reply is told, read back from the record
{
  const dial = F.failureRecordFacts([{ decision: "call.dial", at: new Date("2026-10-28T22:54:09Z") }], { afterFailure: false, now });
  check("a call that never started, on record: the fact says so and that it's on record", dial.length === 1 && dial[0].startsWith(F.FAILURE_RECORD_PREFIX) && /never started/.test(dial[0]) && dial[0].endsWith(R.FAILURE_ON_RECORD), dial);
  const turn = F.failureRecordFacts([{ decision: "turn.failed", at: new Date("2026-10-28T22:50:48Z") }], { afterFailure: true, now });
  check("a broken turn, on record: the same, with how long ago", turn.length === 1 && /4 minutes ago/.test(turn[0]) && turn[0].endsWith(R.FAILURE_ON_RECORD), turn);
  const none = F.failureRecordFacts([], { afterFailure: true, now });
  check("Cue said something broke but nothing is in the record: it's told the failure isn't on record", none.length === 1 && none[0].endsWith(R.FAILURE_NOT_ON_RECORD) && !none[0].includes(R.FAILURE_ON_RECORD), none);
  const unread = F.failureRecordFacts(null, { afterFailure: true, now });
  check("the record couldn't be read: it's told that, never that it's on record", unread.length === 1 && unread[0].endsWith(F.FAILURE_RECORD_UNKNOWN) && !unread[0].includes(R.FAILURE_ON_RECORD), unread);
  check("no failure and nothing broke: nothing is added (the golden cases' turns are unchanged)", F.failureRecordFacts([], { afterFailure: false, now }).length === 0 && F.failureRecordFacts(null, { afterFailure: false, now }).length === 0);
  check("the facts never use a word that reads as Cue having done something (sent, saved...), so admissions stay open", ![...dial, ...turn, ...none, ...unread].some((t) => /\b(sent|delivered|texted|emailed|went out|saved|made them)\b/i.test(t)));
}

// ---- 2. the 2026-10-28 reply, through the fact check
function incidentFacts(record: string[]) {
  const rf = G.createReplyFacts();
  G.addFact(rf, "did_this_turn", `Saved for the team: "When a call attempt fails, Cue should be able to explain what went wrong instead of just apologizing."`);
  for (const t of record) G.addFact(rf, "known", t);
  return rf;
}
const flagged = { text: "I've flagged it so it gets looked at.", type: "past_action" as const, supported: true, factId: "F1", quote: null };
const honest = { text: "the call just didn't go through on my end", type: "past_action" as const, supported: false, factId: null, quote: null };
{
  const rf = incidentFacts(F.failureRecordFacts([], { afterFailure: true, now }));
  const [flag, adm] = G.claimChecks([flagged, honest], rf, empty as any);
  check("failure not on record: 'I've flagged it' is cut, even citing the feedback receipt", flag.pass === false && /no report of it is on record/.test(flag.reason ?? ""), flag);
  check("and the honest line stays: the call didn't go through", adm.pass === true, adm);
  const draft = "I honestly don't have a clear answer, the call just didn't go through on my end and I don't have more detail than that. I've flagged it so it gets looked at.";
  const cut = G.stripUnsupported(draft, [flag, adm].filter((c) => !c.pass), { allow: (s) => F.failureAdmitted(rf.facts, s) });
  check("what goes out keeps the true part and drops the flag claim", /didn't go through/.test(cut) && !/flagged/.test(cut), cut);
  const narr = G.codeChecks(draft.replace(" I've flagged it so it gets looked at.", ""), rf, empty as any).find((c) => c.name === "no_internal_narration");
  check("'didn't go through on my end' isn't cut as machinery talk while the failure is in view", !narr, narr);
}
{
  const rf = incidentFacts(F.failureRecordFacts(null, { afterFailure: true, now }));
  const [flag] = G.claimChecks([flagged], rf, empty as any);
  check("record unreadable: 'I've flagged it' is cut too", flag.pass === false, flag);
}
{
  const rf = incidentFacts(F.failureRecordFacts([{ decision: "turn.failed", at: new Date("2026-10-28T22:54:09Z") }], { afterFailure: true, now }));
  const onRecordFact = rf.facts.find((f) => f.text.endsWith(R.FAILURE_ON_RECORD))!;
  const [flag] = G.claimChecks([{ ...flagged, factId: onRecordFact.id }], rf, empty as any);
  check("failure on record: 'I've flagged it', citing that record, stands", flag.pass === true, flag);
}
{
  // The same turn as the call: services/callReasons.ts says whether the call.dial report landed.
  const rf = G.createReplyFacts();
  for (const f of R.callNotPlacedFacts(R.dialFailureError({ stage: "dial", status: 401, code: "8001", message: "x" }, false))) G.addFact(rf, f.kind, f.text);
  const [flag] = G.claimChecks([{ text: "I've logged it for the team.", type: "past_action", supported: true, factId: "F1", quote: null }], rf, empty as any);
  check("the call's own turn: a dial report that didn't land can't be called logged", flag.pass === false, flag);
}
{
  const rf = G.createReplyFacts();
  G.addFact(rf, "did_this_turn", `Saved for the team: "Replies feel dry."`);
  const [pass] = G.claimChecks([{ text: "I've passed that along to the team.", type: "past_action", supported: false, factId: null, quote: null }], rf, empty as any);
  check("no failure in view: passing their feedback to the team still stands on its receipt", pass.pass === true, pass);
  const [adm] = G.claimChecks([honest], G.createReplyFacts(), empty as any);
  check("no failure in view: 'the call didn't go through' still needs a source", adm.pass === false, adm);
  check("an admission it wasn't flagged isn't a flag claim", !F.flagClaim("I haven't flagged it yet.") && F.flagClaim("I've flagged it so it gets looked at.") && F.flagClaim("It's been logged.") && F.flagClaim("I passed it along."));
}

// ---- 2b. review of #303 (2026-10-28)
// 1. A flag claim next to an admission, or after a negation in another clause, is still a flag claim.
{
  const both = "The call didn't go through on my end, and I've flagged it so it gets looked at.";
  const nothing = "Nothing you did, I've flagged it.";
  check("a negation in another clause doesn't hide the flag claim", F.flagClaim(both) && F.flagClaim(nothing) && !F.flagClaim("I haven't flagged it yet."));
  const notOn = incidentFacts(F.failureRecordFacts([], { afterFailure: true, now }));
  const asClaims = [both, nothing].map((text) => ({ text, type: "past_action" as const, supported: true, factId: "F1", quote: null }));
  const cutChecks = G.claimChecks(asClaims, notOn, empty as any);
  check("not on record: both are cut, whatever they cite", cutChecks.every((c) => c.pass === false), cutChecks);
  check("an admission that also claims a report is never passed as its own failure", !F.failureAdmitted(notOn.facts, both));
  const cutBoth = G.stripUnsupported(`${both} ${nothing}`, cutChecks.filter((c) => !c.pass), { allow: (x) => F.failureSpoken(notOn.facts, x) });
  check("not on record: neither sentence goes out", !/flagged/.test(cutBoth), cutBoth);
  const on = incidentFacts(F.failureRecordFacts([{ decision: "turn.failed", at: new Date("2026-10-28T22:54:09Z"), action: "told_member" }], { afterFailure: true, now }));
  const onId = on.facts.find((f) => f.text.endsWith(R.FAILURE_ON_RECORD))!.id;
  const keptChecks = G.claimChecks(asClaims.map((c) => ({ ...c, factId: onId })), on, empty as any);
  check("on record: both stand, citing the record", keptChecks.every((c) => c.pass === true), keptChecks);
  const narr = G.codeChecks(both, on, empty as any).find((c) => c.name === "no_internal_narration");
  check("on record: 'didn't go through on my end, and I've flagged it' isn't cut as machinery talk", !narr, narr);
}
// 2. The call's fact says who asked for it.
{
  const at = new Date("2026-10-28T22:50:48Z");
  const asked = F.failureRecordFacts([{ decision: "call.dial", at, requested: "router_decision" }], { afterFailure: false, now });
  const app = F.failureRecordFacts([{ decision: "call.dial", at, requested: "user_initiated" }], { afterFailure: false, now });
  check("a call they asked for is called that", /the call they asked for 4 minutes ago never started/.test(asked[0]) && /the call they asked for/.test(app[0]), asked);
  for (const kind of ["auto_intake", "checkin_cadence", "scheduled_call"]) {
    const own = F.failureRecordFacts([{ decision: "call.dial", at, requested: kind }], { afterFailure: false, now });
    check(`a call Cue started on its own (${kind}) is never "the call they asked for"`, /a call Cue started on its own 4 minutes ago \(they didn't ask for it\) never started/.test(own[0]) && !/they asked for/.test(own[0]), own);
  }
  const unknown = F.failureRecordFacts([{ decision: "call.dial", at, requested: null }], { afterFailure: false, now });
  check("a call with no recorded asker says neither", /a call to them 4 minutes ago never started/.test(unknown[0]), unknown);
  const sb = src("routes/sendblue.ts");
  check("the record read selects who asked for the call", /hd\.proposal->>'requested' AS requested/.test(sb) && /requested: x\.requested/.test(sb));
}
// 3. Only reports of the failure itself, only admissions of Cue's own failure, and only a turn that's still unanswered.
{
  const notOn = incidentFacts(F.failureRecordFacts([], { afterFailure: true, now }));
  const honest = ["I logged your 5k", "I let them know you're coming", "I passed it along to Sarah", "I flagged the two events you might like", "I flagged it for you", "I noted that you're vegetarian"];
  const hc = G.claimChecks(honest.map((text) => ({ text, type: "past_action" as const, supported: true, factId: "F1", quote: null })), notOn, empty as any);
  check("honest past actions about other things aren't cut as flag claims", hc.every((c) => c.pass === true), hc.filter((c) => !c.pass));
  for (const t of ["I've flagged it.", "It's been logged.", "I passed it along.", "I let the team know.", "I sent it to the team.", "I reported the issue."]) check(`"${t}" is a flag claim`, F.flagClaim(t));
  const notAdm = ["Something went wrong with your landlord", "That didn't work for you, huh", "It didn't work out with the venue."];
  check("a failure in their life is not Cue admitting its own", notAdm.every((t) => !F.failureAdmitted(notOn.facts, t) && !F.failureSpoken(notOn.facts, t)));
  const nc = G.claimChecks(notAdm.map((text) => ({ text, type: "past_action" as const, supported: false, factId: null, quote: null })), notOn, empty as any);
  check("so those still need their own source", nc.every((c) => c.pass === false), nc);
  for (const t of ["the call just didn't go through on my end", "I couldn't get the call out", "Something broke on my end.", "My last reply broke."]) check(`"${t}" is Cue admitting its own failure`, F.failureAdmitted(notOn.facts, t));
  const at = new Date("2026-10-28T22:54:09Z");
  check("a broken turn the replay answered isn't carried", F.failureRecordFacts([{ decision: "turn.failed", at, action: "told_member", answeredSince: true }], { afterFailure: false, now }).length === 0);
  check("nor one Cue had already answered", F.failureRecordFacts([{ decision: "turn.failed", at, action: "already_answered" }], { afterFailure: false, now }).length === 0);
  check("one still unanswered is", F.failureRecordFacts([{ decision: "turn.failed", at, action: "told_member", answeredSince: false }], { afterFailure: false, now }).length === 1);
  const sb = src("routes/sendblue.ts");
  check("the record read checks for a real reply since (not a hold or 'something broke' line)", /AS answered_since/.test(sb) && /\[\.\.\.HOLD_LINES, \.\.\.OWED_AFTER\]\.map\(\(l\) => `Co replied: \$\{l\}`\)\],\s*\)\s*\.then/.test(sb) && /answeredSince: !!x\.answered_since/.test(sb));
}
// 5. The call-failure instruction splits by cause (Royce's copy, 2026-10-28).
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
}
// 6. The co-test dashboard's call route: a call that never started is 502, like the app's.
check("co-test's call route answers 502 for a dial that never started", /res\.status\(result\.dialFailed \? 502 : 404\)/.test(fs.readFileSync(new URL("../../../co-test/src/routes/phone.ts", import.meta.url), "utf8")));

// ---- 3. the report: the cause is on the turn.failed row, and the morning review flags it
{
  const sb = src("routes/sendblue.ts");
  check("a crashed turn's report carries what the error said (nothing private)", /tellMemberTurnFailed\(lockKey, replay\?\.receivedAt \?\? turnStartedAt, "turn_error", \(error as any\)\?\.constructor\?\.name \?\? "Error", \{ detail: failureDetail\(error\) \}\)/.test(sb) && /proposal: \{ source, errorClass, \.\.\.\(o\.detail \? \{ detail: o\.detail \} : \{\}\) \}/.test(sb));
  check("each text reads its recent failures back from the decision log, null when the read fails", /hd\.decision = 'call\.dial' AND hd\.action = 'dial_failed'\) OR hd\.decision = 'turn\.failed'/.test(sb) && /\.catch\(\(\) => null\);\s*for \(const f of failureRecordFacts\(failureRows, \{ afterFailure: !!owed\?\.afterFailure, now: new Date\(\) \}\)\) addFact\(replyFacts, "known", f\);/.test(sb));
  const flags = D.logFlags({ userId: "u", firstName: "Jordan", messages: [{ at: "2026-10-28T22:54:04Z", from: "member", text: "Call me" } as any], decisions: [{ id: 1, at: "2026-10-28T22:54:09Z", decision: "turn.failed", outcome: "act", action: "told_member", reason: null, proposal: { source: "turn_error", errorClass: "RestException", detail: { status: 401, code: "8001", message: "actor doesn't have any assertions" } }, checks: [] } as any], emotions: [], issues: [] });
  const f = flags.find((x) => x.type === "turn_failed");
  check("a broken turn is a high flag in the morning review, with its cause", f?.severity === "high" && /RestException, HTTP 401, code 8001, actor doesn't have any assertions/.test(f?.cause ?? "") && f?.causeConfirmed === true, flags);
}

console.log(`failure record: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
