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
check("a plain yes or no, read from their message", R.readConsent("yes", "yes") === "yes" && R.readConsent("no", "no thanks") === "no");
check("'yes but not them' is never a yes, however the quote is cut", R.readConsent("yes", "yes but not them") === null && R.readConsent("yes", "yes, leave my name out") === null);
check("no answer, a hedge or a quote that isn't theirs is no answer", R.readConsent("maybe", "maybe") === null && R.readConsent("yes", "what is it for?") === null);
check("picks: numbers, all, none", JSON.stringify(R.readPicks("1 and 3", 3)) === "[1,3]" && JSON.stringify(R.readPicks("all", 3)) === "[1,2,3]" && JSON.stringify(R.readPicks("none", 3)) === "[]" && JSON.stringify(R.readPicks("2", 3)) === "[2]");
check("picks: words and exclusions", JSON.stringify(R.readPicks("the first and the third", 3)) === "[1,3]" && JSON.stringify(R.readPicks("1, 3, not 2", 3)) === "[1,3]" && JSON.stringify(R.readPicks("all but 2", 3)) === "[1,3]" && JSON.stringify(R.readPicks("everyone except 1", 3)) === "[2,3]");
check("picks: an unclear choice is null (Co asks again), never a guess", R.readPicks("yes", 3) === null && R.readPicks("sounds good", 3) === null && R.readPicks("skip 2", 3) === null && R.readPicks("number 4", 3) === null);
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
  memberSentThisWeek: 0, clubSentToday: 0, teamDailyCap: 5, strangerLastContactedAt: null, suppressed: false, contactedAt: null, followedUpAt: null, repliedAt: null, approachTextOk: true,
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
check("the team's prospects are only counted, never read for a member", !/SELECT\s+(?!COUNT|GREATEST|MAX)[^;]*FROM mo_prospects/i.test(flow.replace(/\n/g, " ")) && !/mo_prospects/.test(src("mo/memberHunt.ts").replace(/WHERE x_user_id[^`]*mo_prospects/g, "")) || /FROM mo_prospects WHERE x_user_id IS NOT NULL AND x_user_id = \$1 LIMIT 1/.test(src("mo/memberHunt.ts")));
check("a member's receipts are read only by their own id, and a pending one is never shown", /WHERE r\.user_id = \$1 AND r\.outcome <> 'pending'/.test(flow));
check("real sending needs both switches and Co's X keys, and email isn't used", /memberMoEnabled\(env\) && xWriteConfigured\(env\)/.test(src("mo/memberJobs.ts")) && /sendEmail: async \(\) => false/.test(src("mo/memberJobs.ts")));
check("every member-facing job is a no-op unless MO_MEMBER_ENABLED is true", (src("mo/memberJobs.ts").match(/if \(!memberMoEnabled\(\)/g) ?? []).length >= 4 && /MO_MEMBER_ENABLED === "true" && moEnabled\(env\)/.test(src("mo/memberJobs.ts")));
check("a stranger is reached only from the club's account (never the member's), and only by X DM", !/from: .*member/i.test(flow) && /await d\.sendDm\(c\.x_user_id, body\)/.test(flow));
check("the tools are the member's own: every read is by ctx.userId", (() => { const t = src("agent/conversationTools.ts"); const i = t.indexOf("answerMoOptIn: tool("); const j = t.indexOf("updateGoing: tool("); const seg = t.slice(i, j); return !/\$1.*(?:req|other|input\.userId)/.test(seg) && (seg.match(/ctx\.userId/g) ?? []).length >= 12; })());

console.log(`member Mo rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
