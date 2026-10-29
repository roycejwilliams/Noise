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

// ---- 3. the report: the cause is on the turn.failed row, and the morning review flags it
{
  const sb = src("routes/sendblue.ts");
  check("a crashed turn's report carries what the error said (nothing private)", /tellMemberTurnFailed\(lockKey, replay\?\.receivedAt \?\? turnStartedAt, "turn_error", \(error as any\)\?\.constructor\?\.name \?\? "Error", \{ detail: failureDetail\(error\) \}\)/.test(sb) && /proposal: \{ source, errorClass, \.\.\.\(o\.detail \? \{ detail: o\.detail \} : \{\}\) \}/.test(sb));
  check("each text reads its recent failures back from the decision log, null when the read fails", /decision = 'call\.dial' AND action = 'dial_failed'\) OR decision = 'turn\.failed'/.test(sb) && /\.catch\(\(\) => null\);\s*for \(const f of failureRecordFacts\(failureRows, \{ afterFailure: !!owed\?\.afterFailure, now: new Date\(\) \}\)\) addFact\(replyFacts, "known", f\);/.test(sb));
  const flags = D.logFlags({ userId: "u", firstName: "Jordan", messages: [{ at: "2026-10-28T22:54:04Z", from: "member", text: "Call me" } as any], decisions: [{ id: 1, at: "2026-10-28T22:54:09Z", decision: "turn.failed", outcome: "act", action: "told_member", reason: null, proposal: { source: "turn_error", errorClass: "RestException", detail: { status: 401, code: "8001", message: "actor doesn't have any assertions" } }, checks: [] } as any], emotions: [], issues: [] });
  const f = flags.find((x) => x.type === "turn_failed");
  check("a broken turn is a high flag in the morning review, with its cause", f?.severity === "high" && /RestException, HTTP 401, code 8001, actor doesn't have any assertions/.test(f?.cause ?? "") && f?.causeConfirmed === true, flags);
}

console.log(`failure record: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
