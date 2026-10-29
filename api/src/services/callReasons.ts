// Turning the call gate's reason into what Co tells the member (2026-10-01).

// A dial that never started (2026-10-28: "Call me" crashed the whole turn when Twilio refused the dial, 401 code 8001, so Cue sent
// "something broke" and later claimed it had "flagged it"). services/callTrigger.ts returns this as the error, with whether its
// report reached the decision log (call.dial, read by the morning review), so what Cue says about it is only what's on record.
export const CALL_NEVER_STARTED = "Call never started:";
// Whether a report of a failure is on record, said the same way wherever Cue is told about one (here and services/turnFailure.ts), so
// the fact check reads it from the facts: an honest "it didn't go through on my end" cites that fact, and "I've flagged it" is only
// supported by one that says a report is on record.
export const FAILURE_ON_RECORD = "A report of it is on record for the team.";
export const FAILURE_NOT_ON_RECORD = "No report of it is on record for the team.";
export const FAILURE_RECORD_UNKNOWN = "Whether a report of it is on record couldn't be checked.";
// A failure of Cue's own is told to the reply as two facts, read structurally by harness/replyGrounding.ts: what failed (this prefix:
// what, and that Cue tried), which backs an honest "it didn't go through on my end"; and its report status (the next prefix and one of
// the three lines above), which backs "I've flagged it" only when it says a report IS on record. A status fact saying there's no report,
// or that it couldn't be checked, backs nothing.
export const FAILURE_FACT_PREFIX = "Cue's own failure:";
export const FAILURE_REPORT_PREFIX = "Report status of Cue's own failure:";
export type FailureReport = "on_record" | "not_on_record" | "unknown";
export function failureReportFact(r: FailureReport): string {
  return `${FAILURE_REPORT_PREFIX} ${r === "on_record" ? FAILURE_ON_RECORD : r === "not_on_record" ? FAILURE_NOT_ON_RECORD : FAILURE_RECORD_UNKNOWN}`;
}
export type DialFailure = { stage: "link" | "dial"; status: number | null; code: string | null; message: string };

// What a vendor or database error says, without anything private: no phone numbers or other long digit runs, no email addresses,
// nothing quoted (an error can quote the value it choked on), at most 160 characters. The status and code stay: they name the cause.
// An error with neither a status nor a code isn't from a vendor or the database: it's one of Cue's own throws, and those can carry
// model or member text unquoted ("readTurn returned no JSON: <the model's text>", the leaked-commentary refusal with the reply in it).
// Its message is withheld; the error's class (kept by the caller) and this fixed line say what it was.
export const DETAIL_WITHHELD = "message withheld (no vendor status or code, so it may carry member or model text)";
export function failureDetail(err: unknown): { status: number | null; code: string | null; message: string } {
  const e: any = err ?? {};
  const status = typeof e.status === "number" ? e.status : null;
  const code = e.code === undefined || e.code === null ? null : String(e.code).slice(0, 40);
  if (status === null && code === null) return { status, code, message: DETAIL_WITHHELD };
  const message = String(e.message ?? e)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    // A quoted value may hold an apostrophe ('Jordan's number'), and one left open is scrubbed to the end.
    .replace(/"[^"]*(?:"|$)|“[^”]*(?:”|$)|(?<!\w)'(?:[^']|'(?=\w))*(?:'(?!\w)|$)|(?<!\w)‘(?:[^’]|’(?=\w))*(?:’(?!\w)|$)|`[^`]*(?:`|$)/g, "[quoted]")
    .replace(/\+?\d[\d\s().-]{5,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return { status, code, message };
}

// The error triggerCallForUser returns for a dial that never started, and its reading back.
export function dialFailureError(f: DialFailure, reported: boolean): string {
  const what = f.stage === "link" ? "setting up the call failed" : `the phone service turned the dial down (${[f.status !== null ? `HTTP ${f.status}` : null, f.code !== null ? `code ${f.code}` : null].filter(Boolean).join(", ") || "no code"})`;
  return `${CALL_NEVER_STARTED} ${what}. ${reported ? FAILURE_ON_RECORD : FAILURE_NOT_ON_RECORD}`;
}
export function parseDialFailure(error: string | null | undefined): { stage: "link" | "dial"; setup: boolean; reported: boolean } | null {
  const e = String(error ?? "");
  if (!e.startsWith(CALL_NEVER_STARTED)) return null;
  const stage = /phone service turned the dial down/.test(e) ? "dial" : "link";
  // 401/403 is Cue's own account or key: asking again won't change it until someone fixes the setting.
  return { stage, setup: /HTTP 40[13]\b/.test(e), reported: e.includes(FAILURE_ON_RECORD) };
}

// What failed, without whether it was reported.
function dialFailureBody(dial: { stage: "link" | "dial"; setup: boolean }): string {
  return `${dial.stage === "dial" ? "the phone service Cue calls through turned it down" : "setting it up failed"} on Cue's side, before their phone rang, and nothing they did caused it.${dial.setup ? " It's a setup problem on Cue's side, so asking again right away would hit the same problem." : ""}`;
}

// Why a requested call wasn't placed, said the way Co can tell them.
export function callNotPlacedReason(error: string | null | undefined): string {
  const e = String(error ?? "");
  const dial = parseDialFailure(e);
  if (dial) return `${dialFailureBody(dial)} ${dial.reported ? FAILURE_ON_RECORD : FAILURE_NOT_ON_RECORD}`;
  const recent = e.match(/Co called (\d+) min ago \(needs (\d+)\)/);
  if (recent) return `Cue called them ${recent[1]} minute${recent[1] === "1" ? "" : "s"} ago and waits ${recent[2]} minutes between calls, so it can call again in about ${Math.max(1, Number(recent[2]) - Number(recent[1]))} minute${Math.max(1, Number(recent[2]) - Number(recent[1])) === 1 ? "" : "s"}.`;
  if (/already in progress/i.test(e)) return "A call to them still shows as in progress, so a second one can't start yet.";
  if (/subscription/i.test(e)) return "Their membership isn't active, so calls are paused.";
  if (/8am-9pm|UTC|outside .*time/i.test(e)) return "It's outside the hours Cue calls (8am to 9pm their time).";
  if (/opted out/i.test(e)) return "They've opted out of calls and texts.";
  return "Something stopped the call before it was placed; the reason isn't clear.";
}

// The same reason as facts Co can cite: what it did before (the recent call)
// and what's true now. Not a "not_done" fact, which can't back a timing claim.
export function callNotPlacedFacts(error: string | null | undefined): { kind: "did_before" | "known"; text: string }[] {
  const e = String(error ?? "");
  const recent = e.match(/Co called (\d+) min ago \(needs (\d+)\)/);
  const out: { kind: "did_before" | "known"; text: string }[] = [];
  if (recent) {
    const left = Math.max(1, Number(recent[2]) - Number(recent[1]));
    out.push({ kind: "did_before", text: `Cue called them ${recent[1]} minute${recent[1] === "1" ? "" : "s"} ago.` });
    out.push({ kind: "known", text: `No new call was placed this turn: Cue waits ${recent[2]} minutes between calls, so it can call them again in about ${left} minute${left === 1 ? "" : "s"} if they ask (text "call me" again).` });
    return out;
  }
  // A dial that never started is Cue's own failure (Cue tried): what failed, and its report status, as two facts.
  const dial = parseDialFailure(e);
  if (dial) {
    out.push({ kind: "known", text: `${FAILURE_FACT_PREFIX} Cue tried to call them just now, and the call didn't go through: ${dialFailureBody(dial)}` });
    out.push({ kind: "known", text: failureReportFact(dial.reported ? "on_record" : "not_on_record") });
    return out;
  }
  out.push({ kind: "known", text: `No call was placed this turn. ${callNotPlacedReason(e)}` });
  return out;
}
