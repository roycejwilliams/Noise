// The morning report is an email to Royce only, and no internal email goes to
// the team inbox (Royce, 2026-09-30).
//   npx tsx evals/review/email.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import path from "node:path";
const R = await import("../../src/services/reportEmail.js");
const D = await import("../../src/harness/devReview.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail = "") => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); } };

check("reports go to royce@copatible.com by default", R.reportRecipient({} as any) === "royce@copatible.com");
check("REPORT_EMAIL can change it, but never to the team inbox", R.reportRecipient({ REPORT_EMAIL: "me@example.com" } as any) === "me@example.com" && R.reportRecipient({ REPORT_EMAIL: "team@copatible.com" } as any) === "royce@copatible.com");

// No internal email is addressed to the team inbox anywhere in the code (member-facing
// help text that tells a member to email the team is fine; it isn't a send).
const root = new URL("../../src/", import.meta.url).pathname;
const offenders: string[] = [];
(function walk(d: string) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".ts")) {
      const t = fs.readFileSync(p, "utf8");
      if (/TEAM_ALERT_EMAIL/.test(t) || /\?\?\s*"team@copatible\.com"/.test(t) || /to:\s*\[?\s*"team@/.test(t)) offenders.push(path.relative(root, p));
    }
  }
})(root);
check("no internal email is sent to team@copatible.com", offenders.length === 0, offenders.join(", "));

const review = fs.readFileSync(path.join(root, "harness/devReview.ts"), "utf8");
const job = review.slice(review.indexOf("export async function runMorningReview"));
check("the morning report is emailed, not texted", /sendReportEmail\(email\.subject, email\.html, email\.text\)/.test(job) && !/sendblue|textDigest|phone_number/.test(job));

// The email itself
const now = new Date("2026-09-30T15:00:00Z");
const f = (type: any, severity: any, snippet: string, cause = "reply took 46s") => ({ userId: "u1", at: "2026-09-30T02:00:00Z", type, severity, snippet, decisionIds: [], cause, causeConfirmed: true, source: "log" as const });
const flags = [f("slow_reply", "high", "62s to reply to <script>alert(1)</script>"), f("slow_reply", "medium", "48s"), f("reply_rewritten", "low", "draft cut")];
const e = D.renderDigestEmail(flags as any, { u1: "Royce" }, { date: now, rejected: [{ name: "Kevin Hartz talk", why: "invite-only" }, { name: "kevin hartz talk", why: "dup" }] });
check("the subject says the date, the count and how many are high", /Co morning report, Wednesday, September 30: 3 flags, 1 high/.test(e.subject), e.subject);
check("every flag type is in the email, with its count", /Slow reply \(over the latency budget\)/.test(e.html) && /Reply rewritten by the grounding check/.test(e.html) && />× 2</.test(e.html.replace(/\s+/g, " ").replace(/× 2 /g, "× 2<")) || /× 2/.test(e.html));
check("member text is escaped, never raw HTML", !/<script>/.test(e.html) && /&lt;script&gt;/.test(e.html));
check("the worst example of each type is shown", /62s to reply/.test(e.html) && !/>48s</.test(e.html));
check("turned-down events are listed once each", (e.html.match(/Kevin Hartz talk/gi) ?? []).length === 1);
check("a plain-text version comes with it", /Slow reply \(over the latency budget\) x2 \(high\)/.test(e.text));
const empty = D.renderDigestEmail([], {}, { date: now });
check("a quiet day says nothing was flagged", /nothing flagged/.test(empty.subject) && /nothing flagged/.test(empty.html));

{
  const withStats = D.renderDigestEmail([], {}, { date: now, preArrival: { sent: 4, arrivedAfter: 3, sharedLocation: 2, metSomeone: 1 } });
  check("the report tracks the pre-arrival numbers, and says plainly what isn't tracked yet", /Checked in after the text: <b>3<\/b> of 4/.test(withStats.html) && /Opened the App Clip: <span[^>]*>not tracked yet/.test(withStats.html) && /Said they met someone: <b>1<\/b> of 4/.test(withStats.html));
}
console.log(`review email rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
