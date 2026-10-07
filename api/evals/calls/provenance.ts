// Provenance at storage (services/factLabels.ts stampOf, harness/memberThreads.ts renderThreads, services/callContext.ts).
// Layer 1: no model, no network. The 10/6 call asked about "your first paying customer" from a thread last touched 9/28 that the
// call briefing printed without its date; the text-side labels never reached that pipe.
//   npx tsx evals/calls/provenance.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const F = await import("../../src/services/factLabels.js");
const T = await import("../../src/harness/memberThreads.js");
const CC = await import("../../src/services/callContext.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

const now = new Date("2026-10-06T18:21:00-07:00"); // the call
// The real thread: said 9/28, never touched again.
const paying = { saidOn: new Date("2026-09-28T07:00:00Z"), confirmedOn: new Date("2026-09-28T07:00:00Z"), dueOn: null };
const st = F.stampOf(paying, now);
check("the 9/28 'first paying customer' thread shows its date and its age", /they said Sep 28/.test(st.label) && /8 days ago/.test(st.label), st.label);
check("and is OLD: to be asked about, never stated", st.stale && /OLD/.test(st.label) && !st.drop);
const fresh = F.stampOf({ saidOn: new Date("2026-10-05T12:00:00Z"), confirmedOn: new Date("2026-10-05T12:00:00Z") }, now);
check("yesterday's is not old", !fresh.stale && !/OLD/.test(fresh.label), fresh.label);
const passed = F.stampOf({ saidOn: "2026-09-22", confirmedOn: "2026-10-05", dueOn: "2026-10-04" }, now);
check("a thread whose own date has passed is old even if touched yesterday", passed.stale && passed.datePassed && /has passed/.test(passed.label), passed.label);
check("three weeks untouched: a call briefing leaves it out", F.stampOf({ saidOn: "2026-09-10", confirmedOn: "2026-09-12" }, now).drop);
check("a row with no date at all is unconfirmed, never current", F.stampOf({}, now).stale && /undated/.test(F.stampOf({}, now).label));
check("a stamped line carries the text and the stamp", F.stampedLine("figuring out how to get their first paying customer", paying, now).startsWith("figuring out how to get their first paying customer (they said Sep 28"));

// ---- every reader inherits it
const thread: any = { id: "1", text: "figuring out how to get their first paying customer/check for Co", openedQuote: "How should I think about getting my first check with Co?", openedAt: "2026-09-28T07:00:00.000Z", status: "open", feeling: null, dueDate: null, nextStep: "check_in", kind: "thread", closedQuote: null, lastTouchedAt: "2026-09-28T07:00:00.000Z" };
const rendered = T.renderThreads([thread], now);
check("text side (recaps, drafts, reflection): the thread is rendered with its date and OLD", /they said Sep 28/.test(rendered) && /OLD/.test(rendered) && /first check with Co/.test(rendered), rendered);
const summary = CC.assembleCallSummary({ lessons: [], sentLines: [], base: "", threads: [{ text: "x", line: "figuring out how to get their first paying customer (they said Sep 28, 8 days ago; OLD, so ask whether it is still true and never state it as current)" }] });
check("call side: the briefing prints the stamped line, not the bare text", /first paying customer \(they said Sep 28, 8 days ago; OLD/.test(summary), summary);
const tc = src("services/turnContext.ts");
check("the thread read for the call selects its dates and stamps it where it is read", /SELECT text, feeling, opened_at, last_touched_at, due_date FROM member_threads/.test(tc) && /stampOf\(/.test(tc) && /st\.drop \? \[\]/.test(tc));
check("the call summary builder hands the stamped line on (not the bare text)", /t\.line \?\? t\.text/.test(src("services/callContext.ts")) && /String\(t\.line \?\? t\.text/.test(src("services/callContext.ts")));
check("the recap threads reader (personModel) goes through renderThreads", /renderThreads\(threads/.test(src("services/personModel.ts")));

// ---- the behaviour on pushback is in the call prompt
const g = E.SPEED_GUIDE;
check("the prompt tells Co to read the stamp: an OLD line is a question, never a fact", /A line marked OLD is a question, never a fact/.test(g));
check("when a member challenges a claim: check its stamp, drop it in ONE sentence, move on", /push back on something you said about them/.test(g) && /drop it in one short sentence/.test(g) && /go back to what they are saying now/.test(g));
check("and never apologize twice or say it got something wrong 'on my end'", /Never apologize twice, never say you got something wrong on your end/.test(g));
const c = fs.readFileSync(new URL("./callEvals.ts", import.meta.url), "utf8");
check("the post-call grade checks it: a challenged claim must be dropped in one sentence", /drops_stale_claims_on_pushback/.test(src("services/callEvals.ts")) && /apologized or explained across two or more turns/.test(src("services/callEvals.ts")) && c.length > 0);

console.log(`provenance: ${total - failed}/${total} checks`);
if (failed) process.exit(1);
