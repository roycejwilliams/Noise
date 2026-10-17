// The daily failure count (harness/failureCount.ts, Royce 2026-10-17): what counts, who, the alert rule, its hours and text, and that a
// failure never loses the day's alert. Zero tokens, no database (a fake pool stands in), nothing sent (the alert number is a 555-01xx
// test number, logged and never sent, or a malformed one the send wrapper refuses).
//   npx tsx evals/review/failureCount.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.ALLOW_REAL_SMS = "true";
process.env.TEAM_ALERT_PHONE = "+14155550199";
globalThis.fetch = (async () => new Response("refused in tests", { status: 503 })) as any;
import { readFileSync } from "fs";
const F = await import("../../src/harness/failureCount.js");
const T = await import("../../src/services/turnFailure.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};
const flat = (s: string) => s.replace(/\s+/g, " ");
const read = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const SQL = flat(F.FAILURES_SQL);

// ---------------------------------------------------------------- what counts
check("every line that answers nothing is a fallback, as logged", [T.REPLY_NO_RETRY_NOTE, T.REPLY_DELAYED_NOTE, T.REPLY_GAVE_UP_NOTE, T.TURN_FAILED_NOTE, T.REPLY_PARTIAL_NOTE].every((l) => F.FALLBACK_LOGGED.includes(`Co replied: ${l}`)) && F.FALLBACK_LOGGED.length === T.OWED_AFTER.length);
check("fallbacks: Cue's own logged texts that are exactly one of those lines, inside the day", /m\.memory_type = 'text_exchange' AND m\.content = ANY\(\$3::text\[\]\) AND m\.created_at >= \$1 AND m\.created_at < \$2/.test(SQL));
check("a cut: the fact check left it empty, and nothing had answered them yet (the deliberate empty end isn't one, Royce a)", /d\.decision = 'reply\.grounding' AND btrim\(COALESCE\(d\.proposal->>'final', ''\)\) = '' AND COALESCE\(d\.proposal->>'alreadyAnswered', 'false'\) <> 'true'/.test(SQL) && /alreadyAnswered: \(src\.answeredThisTurn \?\? src\.sentThisTurn \?\? \[\]\)\.some\(\(m\) => m\.trim\(\)\.length > 0\)/.test(read("harness/replyGrounding.ts")));
check("Royce (2): what followed a cut decides it: a fallback or the 'not sure' line after it is counted there (covered), a real reply is redrafted fine, nothing is a failure", /WHEN EXISTS \(SELECT 1 FROM co_memories f WHERE .*f\.content = ANY\(\$3::text\[\]\) AND f\.user_id = d\.user_id AND f\.created_at >= d\.created_at AND f\.created_at < d\.created_at \+ INTERVAL '3 minutes'\) THEN 'covered'/.test(SQL) && /n\.proposal->>'notSure' = 'true' AND n\.user_id = d\.user_id .* THEN 'covered'/.test(SQL) && /r\.content LIKE 'Co replied:%' AND NOT \(r\.content = ANY\(\$3::text\[\]\)\) AND r\.user_id = d\.user_id .* THEN 'redrafted' ELSE 'nothing'/.test(SQL));
check("couldn't help (Royce b): the 'not sure' end only, never a stripped reply that still answered", /d\.action = 'stripped' AND d\.proposal->>'notSure' = 'true'/.test(SQL) && /notSure: !world && !workCut && after === "honest"/.test(read("harness/replyGrounding.ts")));
check("Royce (3): a call counts only when Cue's own voice setup failed it, never a member not picking up", /m\.memory_type = 'call_failure' AND m\.content LIKE '%own voice setup%'/.test(SQL) && /own voice setup/.test(read("services/elevenLabsCalls.ts")) && !/own voice setup[\s\S]{0,20}initiation/.test(read("services/elevenLabsCalls.ts")));
check("... and a call turn that ended on its last-resort line, logged where it's spoken", /d\.layer = 8 AND d\.decision = 'call\.last_resort'/.test(SQL) && /deps\.onLastResort\?\.\(line\);/.test(read("services/callLlmProxy.ts")) && /decision: "call\.last_resort"/.test(read("routes/callLlm.ts")));
check("who: member (not the team), team, or test/archived; a member-facing day is a member's own text", /team AS \(SELECT u\.id FROM users u WHERE .* AND u\.mo_approver = true\)/.test(SQL) && /THEN 'team' WHEN .* THEN 'member' ELSE 'test' END/.test(SQL) && /u\.mo_approver = false/.test(F.MEMBER_TEXTS_SQL) && /'User said:%'/.test(F.MEMBER_TEXTS_SQL));
{
  const b = F.dayBounds("2026-10-17");
  check("days are Pacific: 10-17 runs 07:00Z to 07:00Z; the fall-back day is 25 hours", b.start.toISOString() === "2026-10-17T07:00:00.000Z" && b.end.toISOString() === "2026-10-18T07:00:00.000Z" && F.dayBounds("2026-11-01").end.getTime() - F.dayBounds("2026-11-01").start.getTime() === 25 * 3_600_000);
  check("Royce (5): the alert's hours are 8am to 9pm Pacific", !F.alertHours(new Date("2026-10-18T14:59:00Z")) && F.alertHours(new Date("2026-10-18T15:00:00Z")) && F.alertHours(new Date("2026-10-19T03:59:00Z")) && !F.alertHours(new Date("2026-10-19T04:00:00Z")));
}

// ---------------------------------------------------------------- the count and the alert rule
const row = (kind: "fallback" | "cut" | "nohelp", who: "member" | "team" | "test", user_id: string, line: string | null = null) => ({ kind, who, user_id, line: kind === "fallback" ? `Co replied: ${line}` : line });
{
  const d = F.tally("2026-10-20", [row("cut", "member", "a", "nothing"), row("cut", "member", "b", "redrafted"), row("cut", "member", "c", "covered"), row("fallback", "member", "c", T.REPLY_NO_RETRY_NOTE)], 4);
  check("Royce (2): a cut redrafted fine is its own number, never a failure; a cut followed by a fallback counts once (the fallback)", d.cuts.member === 1 && d.redrafted.member === 1 && d.fallbacks.member === 1 && F.realFailures(d) === 2 && d.membersHit === 2, d);
  const fine = F.tally("2026-10-20", [row("cut", "member", "a", "redrafted"), row("cut", "team", "r", "redrafted")], 4);
  check("... a day of only redrafted-fine cuts never alerts", !F.failureAlertDue(fine) && fine.redrafted.member === 1 && fine.redrafted.team === 1);
  check("10-17's shape (the team only, no member texted): counted under the team, no alert (Royce d)", !F.failureAlertDue(F.tally("2026-10-17", [row("cut", "team", "r", "covered"), row("fallback", "team", "r", T.REPLY_NO_RETRY_NOTE)], 0)));
  check("Royce: team and test counts stay off the text: the team's or test members' failures alone never alert (they're on the dashboard)", !F.failureAlertDue(F.tally("d", [row("fallback", "team", "r", T.REPLY_DELAYED_NOTE)], 3)) && !F.failureAlertDue(F.tally("d", [...Array(33)].map((_, i) => row("fallback", "test", `t${i}`, T.REPLY_DELAYED_NOTE)), 9)) && F.failureAlertDue(F.tally("d", [row("fallback", "member", "a", T.REPLY_DELAYED_NOTE)], 3)));
  check("couldn't help alerts too", F.failureAlertDue(F.tally("d", [row("nohelp", "member", "a", `the fact check's "not sure" line`)], 2)));
  check("the dashboard shows team and test apart (the co-test failures view)", /router\.get\("\/failures"/.test(readFileSync(new URL("../../../co-test/src/routes/sweeps.ts", import.meta.url), "utf8")) && /members \/ team \/ test members/.test(readFileSync(new URL("../../../co-test/src/client/sweeps.ts", import.meta.url), "utf8")));
}
{
  const d = F.tally("2026-10-20", [row("cut", "member", "a", "nothing"), row("fallback", "member", "a", T.REPLY_NO_RETRY_NOTE), row("nohelp", "team", "r", "x"), row("cut", "member", "b", "redrafted"), row("fallback", "test", "t", T.REPLY_DELAYED_NOTE)], 5);
  const t = F.alertText(d, true);
  check("Royce's text, with the real numbers: members only, no team or test counts", t === "Cue alert: 1 member hit a failure today. Fallback lines 1, no reply at all 1. Team and test counts on the dashboard.", t);
  const two = F.tally("2026-10-20", [row("cut", "member", "a", "nothing"), row("fallback", "member", "b", T.REPLY_NO_RETRY_NOTE)], 5);
  check("... his example exactly, for 2 members", F.alertText(two, true) === "Cue alert: 2 members hit a failure today. Fallback lines 1, no reply at all 1. Team and test counts on the dashboard.", F.alertText(two, true));
  const help = F.alertText(F.tally("d", [row("nohelp", "member", "a", "x")], 1), true);
  check("... couldn't help joins the line only when there was one", help === "Cue alert: 1 member hit a failure today. Fallback lines 0, no reply at all 0, couldn't help 1. Team and test counts on the dashboard.", help);
  check("... and says yesterday when it's about yesterday (told at 8am)", /^Cue alert: 1 member hit a failure yesterday\./.test(F.alertText(F.tally("2026-10-19", [row("fallback", "member", "a", T.REPLY_NO_RETRY_NOTE)], 1), false)));
}

// ---------------------------------------------------------------- Royce (4): no email, text only, once a day, never lost
const src = read("harness/failureCount.ts");
const jobs = read("jobs/index.ts");
check("Royce (4): no email at all: no report email, no daily email", !/sendReportEmail|reportEmail|RESEND/.test(src));
check("the alert goes by text to the team number Royce sets, from Cue's number, recorded as a team text ('ops')", /sendblue\.messages\.send\(\{ number: to, content: text, from_number: process\.env\.SENDBLUE_PHONE_NUMBER! \}\)/.test(src) && /ON CONFLICT \(message_handle\) DO UPDATE SET sender = 'ops'/.test(src) && /sender = 'ops'/.test(read("services/inlineReply.ts")));
check("a process that can't text (sends off or no team number) never claims", /if \(!canAlert\(\) \|\| !alertHours\(now\)\) return;/.test(src) && F.canAlert());
check("scheduled: the daily numbers logged at 8:05 Pacific (no message), the alert check every 15 minutes", /cron\.schedule\("5 8 \* \* \*"[\s\S]{0,200}recordDailyFailures\(\)[\s\S]{0,120}America\/Los_Angeles/.test(jobs) && /cron\.schedule\("\*\/15 \* \* \* \*"[\s\S]{0,200}checkFailureAlert\(\)/.test(jobs) && !/sendDailyFailureCount/.test(jobs));
{
  const pool = (await import("../../src/db/db.js")).default as any;
  const real = pool.query.bind(pool);
  const claims = new Set<string>();
  const rowsByDay: Record<string, any[]> = {};
  const textsByDay: Record<string, number> = {};
  const looked: string[] = [];
  const decisions: any[] = [];
  const dayOf = (d: Date) => F.pacificDay(new Date(d.getTime() + 3_600_000));
  pool.query = async (sql: string, params: any[] = []) => {
    if (/INSERT INTO harness_alerts/.test(sql)) return claims.has(params[0]) ? { rows: [] } : (claims.add(params[0]), { rows: [{ signal_key: params[0] }] });
    if (/DELETE FROM harness_alerts/.test(sql)) return claims.delete(params[0]), { rows: [], rowCount: 1 };
    if (/SELECT 1 FROM harness_alerts/.test(sql)) return { rows: claims.has(params[0]) ? [{}] : [] };
    if (sql === F.FAILURES_SQL) return looked.push(dayOf(params[0])), { rows: rowsByDay[dayOf(params[0])] ?? [] };
    if (sql === F.MEMBER_TEXTS_SQL) return { rows: [{ n: textsByDay[dayOf(params[0])] ?? 0 }] };
    if (/INSERT INTO harness_decisions/.test(sql)) return decisions.push(params), { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  try {
    rowsByDay["2026-10-17"] = [row("fallback", "member", "a", T.REPLY_NO_RETRY_NOTE)];
    textsByDay["2026-10-17"] = 2;
    await F.checkFailureAlert(new Date("2026-10-18T07:15:00Z")); // 00:15 Pacific
    check("Royce (5): at 00:15 nothing is counted or sent", looked.length === 0 && claims.size === 0, { looked, claims: [...claims] });
    await F.checkFailureAlert(new Date("2026-10-18T15:05:00Z")); // 8:05 Pacific
    check("at 8:05 the late-night failure from yesterday is told, once (claimed)", looked.includes("2026-10-17") && claims.has("failures:alert:2026-10-17"), { looked, claims: [...claims] });
    looked.length = 0;
    await F.checkFailureAlert(new Date("2026-10-18T15:20:00Z"));
    check("... and never again that day", !looked.includes("2026-10-17"), looked);
    // A send that fails gives the claim back, so the next run tries again.
    process.env.TEAM_ALERT_PHONE = "+1555";
    rowsByDay["2026-10-18"] = [row("cut", "member", "b", "nothing")];
    textsByDay["2026-10-18"] = 1;
    await F.checkFailureAlert(new Date("2026-10-18T18:00:00Z"));
    check("a text that didn't go leaves no claim (tried again next run)", !claims.has("failures:alert:2026-10-18"), [...claims]);
    process.env.TEAM_ALERT_PHONE = "+14155550199";
    await F.recordDailyFailures(new Date("2026-10-19T15:05:00Z"));
    check("the daily numbers are logged with no message, redrafted-fine kept", decisions.length >= 1);
  } finally {
    pool.query = real;
  }
}

console.log(`failure count: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
