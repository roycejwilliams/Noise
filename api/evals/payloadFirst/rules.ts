// Model-free checks for payload first (harness/payloadFirst.ts, 2026-10-04):
// a proactive text that offers work Co could just do never ships as a
// question; the work goes to a task that sends the result. No API calls, no
// database:
//   npx tsx evals/payloadFirst/rules.ts
import { readFileSync } from "fs";
import { decidePayloadFirst, PAYLOAD_FIRST_EXEMPT, theirAskOf, theirText, type OfferRead } from "../../src/harness/payloadFirst.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const recent = [
  "User said: I need a caterer for 60 people by Friday, something casual",
  "Co replied: On it. Any budget I should know about?",
  "User said: under 40 a head",
].join("\n");
const theirs = theirText(recent);
const draft = "Hey Jordan, still want those caterer options for Friday?";
const read = (o: Partial<OfferRead>): OfferRead => ({ question: "still want those caterer options for Friday?", kind: "gather_options", work: "find three caterers for 60 people by Friday, under $40 a head", theirWords: "I need a caterer for 60 people by Friday", sameAsTask: null, ...o });

// The regression: an offer of work Co could do never ships as a question.
for (const kind of ["research", "gather_options"] as const) {
  check(`"${kind}" work offered as a question is done instead`, decidePayloadFirst(read({ kind }), draft, theirs, []).handOff);
}
// Questions that stay questions. Drafting and shortlisting too, until a live
// task test shows a task delivers them (review of #59).
for (const kind of ["draft", "shortlist", "member_action", "irreversible_or_visible", "only_they_know", "none"] as const) {
  check(`"${kind}" stays a question`, !decidePayloadFirst(read({ kind }), draft, theirs, []).handOff);
}
check("no question named, nothing to do", !decidePayloadFirst(read({ question: null }), draft, theirs, []).handOff && !decidePayloadFirst(null, draft, theirs, []).handOff);
check("the question named must be in the draft", !decidePayloadFirst(read({ question: "want me to book the caterer?" }), draft, theirs, []).handOff);
check("the question matches through punctuation and case", decidePayloadFirst(read({ question: "Still want those caterer options for Friday" }), draft, theirs, []).handOff);
check("work too thin to do isn't handed off", !decidePayloadFirst(read({ work: "find" }), draft, theirs, []).handOff);

// A new task needs their own words; Co's words don't count.
check("their words must be theirs for a new task", !decidePayloadFirst(read({ theirWords: "Any budget I should know about?" }), draft, theirs, []).handOff);
check("invented words don't count", !decidePayloadFirst(read({ theirWords: "I want a taco truck" }), draft, theirs, []).handOff);
check("only their lines count as theirs", theirs.includes("caterer for 60") && !theirs.includes("budget I should know"));
const older = theirText(["User said: can you find me a photographer for the launch party", "Co replied: On it."].join("\n") + "\n" + recent);
const photo = read({ question: "Still want photographer options?", theirWords: "a photographer for the launch party", work: "find three photographers for the launch party" });
check("an older ask, in their own older texts, still grounds the work", decidePayloadFirst(photo, "Hey! Still want photographer options?", older, []).handOff);
check("the ask as Cue restated it never counts as their words", !decidePayloadFirst(photo, "Hey! Still want photographer options?", theirs, []).handOff && !/theirAsk/.test(String(theirText)));
check("the ask comes from askText or asked (for the read's context)", theirAskOf({ askText: "a caterer" }) === "a caterer" && theirAskOf({ asked: "venues" }) === "venues" && theirAskOf({}) === null && theirAskOf(null) === null);

// Waking the task Co already has for it.
const same = decidePayloadFirst(read({ sameAsTask: 7, theirWords: null }), draft, theirs, [{ id: 7 }]);
check("a matching open task is woken, no words needed", same.handOff && same.taskId === 7);
check("a task id that isn't theirs isn't trusted", !decidePayloadFirst(read({ sameAsTask: 99, theirWords: null }), draft, theirs, [{ id: 7 }]).handOff);

// Kinds that must stay questions or already are the payload.
check("event offers, network teases, in-room nudges and companion check-ins are exempt", ["event_offer", "network_tease", "event_match_nudge", "companion"].every((k) => PAYLOAD_FIRST_EXEMPT.has(k)));
check("check-ins, follow-ups, debrief and post-call texts are checked", ["ask_checkin", "window_followup", "debrief", "post_call", "calendar_follow", "ask_solicitation", "pre_arrival", "product_update"].every((k) => !PAYLOAD_FIRST_EXEMPT.has(k)));

// Wiring: the step runs after the draft passes its checks and before anything is sent.
const src = readFileSync(new URL("../../src/harness/proactive.ts", import.meta.url), "utf8");
const at = src.indexOf("const pf = await payloadFirst(");
check("payload first runs after the draft checks and before the send", at > src.indexOf("if (!dg.ok) {\n    await pool.query(`UPDATE proactive_candidates SET attempts") && at < src.indexOf("result = await sendWithLedger(") && at < src.indexOf("const outgoing = draft.messages;"));
const block = src.slice(at, src.indexOf("let outgoing = draft.messages;"));
check("handed off: the question is dropped and the turn ends", /"handedTo" in pf\) \{[\s\S]*dropCandidate\(registry, c, "skipped"[\s\S]*return;/.test(block));
check("can't deliver it now: dropped (its source asks again later), not asked, and logged once", /"hold" in pf\) \{[\s\S]*dropCandidate\(registry, c, "skipped"[\s\S]*recordSkipOnce\([\s\S]*return;/.test(block) && !/"hold" in pf\) \{[\s\S]*SET due_at/.test(block));
check("after a hand-off nothing else goes out before the spacing window ends", /"handedTo" in pf\) \{[\s\S]*space_until[\s\S]*RULES\.minHoursBetweenTexts/.test(block) && /if \(heldNow\(member, now\)\) return;/.test(src) && /if \(s\.spaceUntil && s\.spaceUntil\.getTime\(\) > now\.getTime\(\)\) return "space";/.test(src));
check("a dry run says what it would do and sends nothing", /"wouldHandOff" in pf\) \{[\s\S]*return;/.test(block) && /dryRun: opts\.dryRun/.test(block));
check("every hand-off and hold is recorded", (block.match(/decision: "proactive\.payloadFirst"/g) ?? []).length === 2);
const pf = readFileSync(new URL("../../src/harness/payloadFirst.ts", import.meta.url), "utf8");
check("the task is made due now, so the next task wake (15 min) does it", /SET next_check_at = NOW\(\)/.test(pf));
check("only handed off when a task text could go out (20h gap, daily task-text limit)", /const can = mayText\(/.test(pf) && /if \(!can\.ok\) return \{ ok: false/.test(pf));
check("a woken task keeps its whole plan, after the hand-off, never cut off", /'Now: ' \|\| \$3 \|\| COALESCE\(' Then: ' \|\| plan_next, ''\)/.test(pf) && !/LEFT\(CASE/.test(pf));
check("a same-goal task woken from 'already working on that' gets the 20h check too", /const sameCan = mayText\(same, today/.test(pf) && /if \(!sameCan\.ok\) return \{ ok: false/.test(pf));
const reg = readFileSync(new URL("../../src/harness/proactiveRegistry.ts", import.meta.url), "utf8");
check("a payload-first drop moves the check-in count on, so that ask's check-ins come back", /async onDropped\(c, _status, reason\) \{\s*const next = \/\^payload first\/\.test\(reason \?\? ""\);[\s\S]*checkin_count = checkin_count \+ 1/.test(reg));
const mig = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
check("the spacing column exists", /ALTER TABLE proactive_user_state ADD COLUMN IF NOT EXISTS space_until TIMESTAMPTZ/.test(mig));
check("a read that fails sends the text as written (never blocks Cue)", /catch \(err: any\) \{\s*console\.error\("payloadFirst read failed/.test(pf) && /\.catch\(\(\) => null\)/.test(block));

console.log(`payload first rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
