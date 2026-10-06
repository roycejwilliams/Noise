// Member-facing Mo: the rules in code (mo/memberRules.ts). Model-free, database-free.
//   npx tsx evals/mo/memberRules.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const R = await import("../../src/mo/memberRules.js");
const F = await import("../../src/mo/memberFlow.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

// ---- the caps are what the spec says
const M = R.MEMBER_MO;
check("the caps are the spec's: 1 open batch, 3 people, 5 a week, 1 hunt a week, 10 a day, 30 days per stranger, 3-day batches", M.maxOpenBatches === 1 && M.perBatch === 3 && M.perMemberPerWeek === 5 && M.huntsPerMemberPerWeek === 1 && M.clubPerDay === 10 && M.strangerGapDays === 30 && M.batchLifeDays === 3 && M.followUpAfterDays === 7);

// ---- consent: the whole message
check("short phrases people use are yeses to Mo and its voice, but only when nothing in the message pushes back", R.readConsent("ok", "ok") === "yes" && R.readConsent("looks good", "looks good!") === "yes" && R.readConsent("perfect", "perfect") === "yes" && R.readConsent("ok", "ok but not my name") === null && R.readConsent("ok", "ok, leave me out") === null);
check("a plain yes or no, read from their message", R.readConsent("yes", "yes") === "yes" && R.readConsent("no", "no thanks") === "no");
check("'yes but not them' is never a yes, however the quote is cut", R.readConsent("yes", "yes but not them") === null && R.readConsent("yes", "yes, leave my name out") === null);
check("no answer, a hedge or a quote that isn't theirs is no answer", R.readConsent("maybe", "maybe") === null && R.readConsent("yes", "what is it for?") === null);
check("picks: numbers, all, none", JSON.stringify(R.readPicks("1 and 3", 3)) === "[1,3]" && JSON.stringify(R.readPicks("all", 3)) === "[1,2,3]" && JSON.stringify(R.readPicks("none", 3)) === "[]" && JSON.stringify(R.readPicks("2", 3)) === "[2]");
check("picks: ordinals and 'all but'", JSON.stringify(R.readPicks("the first and the third", 3)) === "[1,3]" && JSON.stringify(R.readPicks("all but 2", 3)) === "[1,3]" && JSON.stringify(R.readPicks("everyone except 1", 3)) === "[2,3]" && JSON.stringify(R.readPicks("just 2", 3)) === "[2]" && JSON.stringify(R.readPicks("2", 3)) === "[2]" && JSON.stringify(R.readPicks("yes, 1 and 3 please", 3)) === "[1,3]");
// The review's cases: each of these used to approve a stranger the member turned down, or everyone on a stray word.
for (const m of ["not all of them, just 2", "only 2, not 1 and 3", "I don't want 1 or 3", "no, not 1 or 3", "the second one", "that's all for now", "they each look good, let me think", "what's everyone's background?", "1, 3, not 2", "not 1", "skip 2", "all but 4", "all 1 and 2", "maybe 1?", "1?", "no 1", "no 1 and 3", "no, 1", "1 or 3 if you think so", "sure, whatever you think", "yes"]) check(`picks: "${m}" is unclear (null), never a guess`, R.readPicks(m, 3) === null);
check("picks: a number beyond the list or zero is unclear", R.readPicks("4", 3) === null && R.readPicks("0 and 1", 3) === null && R.readPicks("10", 3) === null);
check("picks: 'all three' only when there are three", JSON.stringify(R.readPicks("all three", 3)) === "[1,2,3]" && R.readPicks("all three", 2) === null);
check("picks: an unclear choice is null (Co asks again), never a guess", R.readPicks("sounds good", 3) === null && R.readPicks("number 4", 3) === null);
check("picks: 'no' and 'nobody' are none", JSON.stringify(R.readPicks("nobody", 3)) === "[]" && JSON.stringify(R.readPicks("none of them", 3)) === "[]");

// ---- the message a stranger reads
const good = F.composeApproach(F.DEFAULT_VOICE, { named: false, memberFirstName: "Rae", need: "a product designer for an early-stage app", why: "You wrote that you're taking on new design clients" });
const ctx = { memberFirstName: "Rae", memberMayBeNamed: false, otherMemberFirstNames: ["Jordan", "Maya"] };
check("the default message passes every check", R.approachProblem(good, ctx) === null && /I'm Mo/.test(good) && /A member of the club/.test(good) && !/Rae/.test(good));
check("the member is named only if they allowed it", F.composeApproach(F.DEFAULT_VOICE, { named: true, memberFirstName: "Rae", need: "a designer", why: "x" }).includes("Rae is looking for") && R.approachProblem(good.replace("A member of the club", "Rae"), ctx) !== null && R.approachProblem(good.replace("A member of the club", "Rae"), { ...ctx, memberMayBeNamed: true }) === null);
check("another member is never named", R.approachProblem(good.replace("made me think of you", "made me think of you and Jordan"), ctx) !== null);
check("it must give an easy way to say no", R.approachProblem(good.replace(/If it's not for you, no worries, I won't write again\. /, ""), ctx) !== null);
check("no email, phone, exclamation point or em dash", R.approachProblem(good + " Write to rae@x.com", ctx) !== null && R.approachProblem(good + " Call 415 555 1234", ctx) !== null && R.approachProblem(good.replace(".", "!"), ctx) !== null && R.approachProblem(good.replace(", and", " — and"), ctx) !== null);
check("it is capped in length", R.approachProblem(good + " " + "more words ".repeat(60), ctx) !== null);
check("it has to be Mo speaking, and ask", R.approachProblem(good.replace("I'm Mo", "I am a person"), ctx) !== null && R.approachProblem(good.replace(/Would you like an invite\?/, "Here is an invite."), ctx) !== null);

// ---- every reason a contact is refused
const now = new Date("2026-10-07T19:00:00Z"); // noon in San Francisco
const base: any = {
  step: "approach", now, localHour: 12, enabled: true, clubPaused: false, optIn: "yes", memberPaused: false, autoPaused: false, voiceApproved: true,
  candidateStatus: "approved", approvedAt: new Date("2026-10-06T00:00:00Z"), batchExpiresAt: new Date("2026-10-09T00:00:00Z"), batchStatus: "approved",
  memberSentThisWeek: 0, clubSentToday: 0, teamDailyCap: 5, strangerLastContactedAt: null, suppressed: false, contactedAt: null, followedUpAt: null, repliedAt: null, approachTextOk: true, approvedText: "the approved words", textNow: "the approved words",
};
const v = (over: any) => R.contactVerdict({ ...base, ...over });
check("a fully approved first contact goes out", v({}).ok === true);
const refuse = (label: string, over: any, why: RegExp) => { const r = v(over); check(`refused: ${label}`, r.ok === false && why.test(r.why ?? "")); };
refuse("the switch is off", { enabled: false }, /switched off/);
refuse("Mo is paused", { clubPaused: true }, /paused/);
refuse("the member never said yes to Mo", { optIn: null }, /has not said yes/);
refuse("the member said no", { optIn: "no" }, /has not said yes/);
refuse("the member told Mo to stop", { memberPaused: true }, /stop/);
refuse("auto-paused after too many no's", { autoPaused: true }, /too many contacts/);
refuse("the voice isn't approved", { voiceApproved: false }, /voice/);
refuse("the batch isn't approved", { batchStatus: "open" }, /not approved/);
refuse("what would be sent is not the text the member approved", { textNow: "different words" }, /not the text the member approved/);
refuse("no approved text on file", { approvedText: null }, /no approved text/);
refuse("the batch was cancelled", { batchStatus: "cancelled" }, /cancelled/);
refuse("the batch expired", { batchExpiresAt: new Date("2026-10-06T00:00:00Z") }, /expired/);
refuse("the person is on the do-not-contact list", { suppressed: true }, /do-not-contact/);
refuse("the member didn't approve this person", { approvedAt: null }, /didn't approve/);
refuse("the message fails the message check", { approachTextOk: false }, /message check/);
refuse("outside sending hours", { localHour: 7 }, /hours/);
refuse("outside sending hours (evening)", { localHour: 19 }, /hours/);
refuse("5 contacts for this member this week", { memberSentThisWeek: 5 }, /this week/);
refuse("the club's daily limit (10)", { clubSentToday: 10, teamDailyCap: 50 }, /daily limit/);
refuse("the team's lower daily cap wins", { clubSentToday: 5, teamDailyCap: 5 }, /daily limit/);
refuse("someone in the club contacted them 10 days ago", { strangerLastContactedAt: new Date("2026-09-27T00:00:00Z") }, /30 days/);
check("a stranger last contacted 40 days ago may be approached", v({ strangerLastContactedAt: new Date("2026-08-25T00:00:00Z") }).ok);
refuse("already contacted", { contactedAt: new Date("2026-10-06T00:00:00Z") }, /already contacted/);
refuse("not waiting for a first contact", { candidateStatus: "declined" }, /not waiting/);
const fu = { step: "follow_up", candidateStatus: "contacted", contactedAt: new Date("2026-09-29T00:00:00Z") };
check("one follow-up after 7 days with no reply", v(fu).ok);
check("a follow-up does not need the batch to be alive: the same yes carried on a week later (the batch expired after 3 days)", v({ ...fu, batchStatus: "expired", batchExpiresAt: new Date("2026-10-01T00:00:00Z") }).ok);
refuse("a follow-up too soon", { ...fu, contactedAt: new Date("2026-10-04T00:00:00Z") }, /too soon/);
refuse("a follow-up after they replied", { ...fu, repliedAt: new Date("2026-10-01T00:00:00Z") }, /replied/);
refuse("a second follow-up", { ...fu, followedUpAt: new Date("2026-10-05T00:00:00Z") }, /already followed up/);
refuse("a follow-up for someone who isn't contacted", { ...fu, candidateStatus: "approved" }, /not waiting for a follow-up/);
check("the order of checks: the switch, then consent, then the person, then limits", (() => { const r = v({ enabled: false, optIn: null, suppressed: true, memberSentThisWeek: 9 }); return /switched off/.test(r.why ?? ""); })());

// ---- auto-pause
check("two no's in the last five contacts pauses the member", R.shouldAutoPause([{ bad: true }, { bad: false }, { bad: true }]) && !R.shouldAutoPause([{ bad: true }, { bad: false }, { bad: false }, { bad: false }, { bad: false }, { bad: true }]) && !R.shouldAutoPause([]));

// ---- the hunt gate
const Hn = (o: any) => F.huntAllowed({ optIn: "yes", paused: false, lastHuntAt: null, openBatch: false, now, ...o });
check("a hunt needs a yes, no stop, no open batch, and a week since the last", Hn({}).ok && !Hn({ optIn: null }).ok && !Hn({ optIn: "no" }).ok && !Hn({ paused: true }).ok && !Hn({ openBatch: true }).ok && !Hn({ lastHuntAt: new Date("2026-10-04T00:00:00Z") }).ok && Hn({ lastHuntAt: new Date("2026-09-29T00:00:00Z") }).ok);

// ---- structure: the one door out, and what is read
const flow = src("mo/memberFlow.ts").replace(/\/\/.*$/gm, "");
check("every send goes through sendContact, which checks first and writes the receipt first", (flow.match(/\.sendDm\(/g) ?? []).length === 1 && /contactVerdict\(state\)/.test(flow) && flow.indexOf("INSERT INTO mo_contact_receipts") < flow.indexOf("d.sendDm(") && !/sendDm\(/.test(src("mo/memberJobs.ts").replace(/import[^\n]*\n/g, "").replace(/sendDm,\s*\n?/g, "").replace(/\n\s*sendDm,\n/g, "").replace(/  sendDm,\n/g, "").replace(/\bsendDm\(e\.senderId[^)]*\)/g, "")));
const flowSql = flow.replace(/\n/g, " ");
const protReads = [...flowSql.matchAll(/FROM mo_prospects[^`]*/g)].map((m) => m[0]);
check("the team's prospects are only counted in the flow, never read for a member", protReads.length >= 1 && protReads.every((r) => /^FROM mo_prospects WHERE (contacted_at|\(x_user_id)/.test(r)) && !/SELECT\s+(?:\*|[a-z_]+\.\*|name|x_handle|bio|reason|draft)[^`]*FROM mo_prospects/i.test(flowSql));
check("the hunt reads mo_prospects only as an existence check on one person", [...src("mo/memberHunt.ts").matchAll(/FROM mo_prospects[^`]*/g)].every((m) => /^FROM mo_prospects WHERE x_user_id IS NOT NULL AND x_user_id = \$1 LIMIT 1/.test(m[0])));
check("a first contact is claimed atomically before it is sent, and pending receipts count against the caps", /SET status = 'sending' WHERE id = \$1 AND status = 'approved' RETURNING id/.test(flow) && (flow.match(/outcome IN \('sent','pending'\)/g) ?? []).length >= 2);
check("a first contact goes out as the exact words approved, fixed at approval", /approved_text = \$3/.test(flow) && /c\.approved_text \?\? textNow/.test(flow));
check("a batch can be approved only after it was shown, and a yes lasts three days from approval", /!batch\.presented_at\) return null/.test(flow) && /expires_at = NOW\(\) \+ make_interval\(days => \$3\)/.test(flow));
check("the team never contacts, or finds again, someone a member's Mo has", /FROM mo_member_candidates WHERE x_user_id = \$1 AND contacted_at > NOW\(\) - INTERVAL '30 days'/.test(src("mo/outreach.ts")) && /memberHas\.rows\[0\]/.test(src("mo/find.ts")) && /memberSentToday/.test(src("mo/outreach.ts")));
check("a member's receipts are read only by their own id, and a pending one is never shown", /WHERE r\.user_id = \$1 AND r\.outcome <> 'pending'/.test(flow));
check("real sending needs both switches and Co's X keys, and email isn't used", /memberMoEnabled\(env\) && !proactivePaused\(env\) && xWriteConfigured\(env\)/.test(src("mo/memberJobs.ts")) && /sendEmail: async \(\) => false/.test(src("mo/memberJobs.ts")));
check("every member-facing job is a no-op unless MO_MEMBER_ENABLED is true", (src("mo/memberJobs.ts").match(/if \(!memberMoEnabled\(\)/g) ?? []).length >= 4 && /MO_MEMBER_ENABLED === "true" && moEnabled\(env\)/.test(src("mo/memberJobs.ts")));
check("a stranger is reached only from the club's account (never the member's), and only by X DM", !/from: .*member/i.test(flow) && /await d\.sendDm\(c\.x_user_id, body\)/.test(flow));
check("the tools are the member's own: every read is by ctx.userId", (() => { const t = src("agent/conversationTools.ts"); const i = t.indexOf("answerMoOptIn: tool("); const j = t.indexOf("updateGoing: tool("); const seg = t.slice(i, j); return !/\$1.*(?:req|other|input\.userId)/.test(seg) && (seg.match(/ctx\.userId/g) ?? []).length >= 12; })());

console.log(`member Mo rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
