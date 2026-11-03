// Restraint for texts Co starts itself (Royce, 2026-10-09; issue #126). Zero tokens.
//   1. Co-initiated task/window texts wait on spacing, pace, the unanswered pause and kind backoff; only an owed text is exempt
//      (the 11:30 replay: a task update 15 minutes after another text is held, and rescheduled)
//   2. no chasing: a task never re-asks while its last text has no reply, and never "circles back"
//   3. a debrief asks whether they went unless a check-in, a walk-in or their own words say they did
//   npx tsx evals/proactive/restraint126.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const P = await import("../../src/harness/proactive.js");
const T = await import("../../src/services/taskTurn.js");
const R = await import("../../src/harness/proactiveRegistry.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const at = (hm: string) => new Date(`2026-10-09T${hm}:00-07:00`);
const rec = (type: string, when: string, exempt = false) => ({ type, targetKey: `${type}:${when}`, topicKey: null, sentAt: at(when), exempt });

// 1. Co-initiated texts wait like every other.
{
  // 10-09: a debrief went at 11:15 (counted); the task update came at 11:30.
  const state = { now: at("11:30"), timezone: "America/Los_Angeles", optedOut: false, sends: [rec("debrief", "11:15")], lastInboundAt: at("09:00"), suppressedKinds: [] as any[] };
  const failedChecks = P.coInitiatedChecks(state, null).filter((c) => !c.pass).map((c) => c.name);
  check("the 11:30 replay: a task update 15 minutes after a debrief is held on spacing", failedChecks.includes("spacing"), failedChecks);
  const retry = P.coInitiatedRetryAt(state);
  check("it's rescheduled for when spacing clears (11:15 + 3h = 2:15pm)", retry.getTime() === at("14:15").getTime(), retry.toISOString());
  const clear = { ...state, now: at("15:00"), lastInboundAt: at("14:00") };
  check("once spacing clears and they've replied, it goes", P.coInitiatedChecks(clear, null).every((c) => c.pass), P.coInitiatedChecks(clear, null));
  check("a kind they keep letting pass is held (a lookout's finds)", P.coInitiatedChecks({ ...clear, suppressedKinds: ["find"] }, "find").some((c) => c.name === "kind_restraint" && !c.pass));
  check("a kind they haven't backed off from isn't", P.coInitiatedChecks({ ...clear, suppressedKinds: ["goal_nudge"] }, "find").every((c) => c.pass));
  check("the daily and weekly caps aren't applied (a task text was never in the offer quota)", P.coInitiatedChecks(state, null).every((c) => c.name !== "daily_cap" && c.name !== "weekly_cap"));
  check("the retry is at least an hour out, even with nothing to space from", P.coInitiatedRetryAt({ now: at("12:00"), sends: [] }).getTime() === at("13:00").getTime());
  // Review of #129: the retry follows the gate that held it, so a paused member isn't woken hourly.
  check("held on the unanswered pause: next look a day out, not an hour", P.coInitiatedRetryAt({ now: at("12:00"), sends: [] }, ["unanswered_pause"]).getTime() === at("12:00").getTime() + 24 * 3_600_000);
  check("held on kind backoff: a week out", P.coInitiatedRetryAt({ now: at("12:00"), sends: [] }, ["kind_restraint"]).getTime() === at("12:00").getTime() + 7 * 24 * 3_600_000);
  check("held on spacing and pause: the later of the two", P.coInitiatedRetryAt(state, ["spacing", "unanswered_pause"]).getTime() === at("11:30").getTime() + 24 * 3_600_000);
  // Review of #129: task texts space later texts too (a find 15 minutes after a task update was the 11:30 incident reversed).
  check("a task update spaces the next text Cue starts", !P.spacingCheck({ now: at("11:45"), sends: [rec("task_update", "11:30", true)] }).pass);
  check("an event-change notice still doesn't", P.spacingCheck({ now: at("11:45"), sends: [rec("event_change", "11:30", true)] }).pass);
  const px = src("harness/proactive.ts");
  check("sendExempt reads the gates inside the lock (coInitiatedHold on the locked client) and holds a Co-initiated text with its reason, logged", /if \(opts\.coInitiated\) \{[\s\S]{0,300}coInitiatedHold\(client, /.test(px) && /async function coInitiatedHold\(client: Queryable[\s\S]{0,200}loadSends\(client, o\.userId\)/.test(px) && /record\("skip", "held_co_initiated", reason\)/.test(px));
  check("a backoff it can't read holds a send with a kind (fails closed); one without a kind never reads it", /couldn't read their backoff/.test(px) && /const suppressed = o\.kind \? await loadKindRestraint\(/.test(px));
  check("the kind goes on the ledger so restraint learns from task texts", /VALUES \(\$1, \$2, \$3, \$3, \$4, true, \$5(, \$6)?\)/.test(px));
  const tt = src("services/taskTurn.ts");
  check("task updates pass owed; anything else goes as Co-initiated, kinded by the look-out's recorded origin (Royce, 2026-10-09)", /const coInitiated = o\?\.owed \? undefined : \{ kind: lookoutKind\(task\) \}/.test(tt));
  check("the window warning is owed: held, it would land after the time it's about (review of #129)", /type: "task_window"(?![^\n]*coInitiated)/.test(tt));
  check("a promise stays owed until it's kept, and links for an ask are its delivery (review of #129)", /const owed = task\.source === "promise" \|\| task\.lookoutOrigin === "member" \|\| owedText\(asOfNow, deps\.now\(\)\);/.test(tt) && /deps\.send\(messages, \{ owed: owed \|\| task\.source !== "lookout"(?:, endsAt)? \}\)/.test(tt));
  check("the turn is told it was held and when it's next", /Held, not sent: \$\{r\.reason \?\? "pacing"\}/.test(tt));
}

// 1b. What's owed.
{
  const now = at("12:00");
  check("a promise's first text is owed", T.owedText({ source: "promise", lastTextedAt: null, theirReplyAt: null }, now));
  check("the first result of something they asked for is owed", T.owedText({ source: "ask", lastTextedAt: null, theirReplyAt: null }, now));
  check("a lookout's first text is Co-initiated", !T.owedText({ source: "lookout", lastTextedAt: null, theirReplyAt: null }, now));
  check("a second update with no reply is Co-initiated", !T.owedText({ source: "ask", lastTextedAt: at("09:00").toISOString(), theirReplyAt: null }, now));
  check("an answer to their reply is owed", T.owedText({ source: "ask", lastTextedAt: at("09:00").toISOString(), theirReplyAt: at("10:00").toISOString() }, now));
  check("the last check before their deadline is owed", T.owedText({ source: "ask", lastTextedAt: at("09:00").toISOString(), theirReplyAt: null, finalCheckAt: at("11:55").toISOString(), finalTold: false }, now));
}

// 2. No chasing.
{
  const waiting = { lastTextedAt: at("09:00").toISOString(), theirReplyAt: null };
  const answered = { lastTextedAt: at("09:00").toISOString(), theirReplyAt: at("10:00").toISOString() };
  check("a question while the last text has no reply is a re-ask", T.chases("Did you want the 7pm or the 8pm one?", waiting) !== null);
  check("the same question after they replied is fine", T.chases("Did you want the 7pm or the 8pm one?", answered) === null);
  check("a plain delivery while waiting isn't a chase", T.chases("Here's the shortlist: three caterers who do 40 people in the Mission.", waiting) === null);
  const chase = ["Circling back on the caterers", "Just following up on my last text", "Bumping this in case you missed it", "Any thoughts on my earlier message?", "Did you see my last text?"];
  check("chase wording is never sent, even after a reply", chase.every((t) => T.chases(t, answered) !== null), chase.filter((t) => T.chases(t, answered) === null));
  check("ordinary wording isn't chase wording", ["Following the run club's schedule, Saturday works", "Back to you with the venue tonight"].every((t) => !T.CHASE.test(t)));
  check("awaitingThem: no text yet means nothing pending", !T.awaitingThem({ lastTextedAt: null, theirReplyAt: null }));
  const tt = src("services/taskTurn.ts");
  check("tell refuses a chase in its draft (not its intent: review of #129)", !/if \(CHASE\.test\(what\)\)/.test(tt) && /const chase = chases\(text, asOfNow, \{ final \}\);/.test(tt));
  check("a delivery's closing question is dropped when it would re-ask (the links still go)", /if \(closing && chases\(closing, asOfNow, \{ final \}\)\) closing = null;/.test(tt));
  check("the last check before their deadline may ask what they want next", T.chases("Still want me to keep looking?", waiting, { final: true }) === null && T.chases("Circling back: still want me to look?", waiting, { final: true }) !== null);
}

// 3. Debriefs ask whether they went.
{
  const p = { eventName: "Claude Founder Salon", checkinFollowupIds: [] as string[], walkinCheckinIds: [] as string[] };
  // Founder-approved 2026-10-12 (memory provenance): "went" comes only from a door check-in, a walk-in, or their stated went (a
  // stated helped / didn't help row for that item). Their texts are never read for it: "going to practice my pitch before the
  // launch" read as having gone, and a stated "I'm going" is a plan. Everything else gets the question.
  check("Cue suggested it and nothing more: not confirmed", !R.wentOnRecord(p, []));
  check("a stated going is a plan, not having gone: the debrief asks", !R.wentOnRecord(p, [{ result: "acted", provenance: "stated" }]));
  check("Cue's own read of their words (no provenance, or inferred) never counts", !R.wentOnRecord(p, [{ result: "helped", provenance: null }]) && !R.wentOnRecord(p, [{ result: "didnt_help", provenance: "inferred" }]) && !R.wentOnRecord(p, [{ result: "acted", provenance: null }]));
  check("interest or a pass never counts", !R.wentOnRecord(p, [{ result: "interested", provenance: "stated" }, { result: "declined", provenance: "stated" }]));
  check("their stated went and liked it: confirmed", R.wentOnRecord(p, [{ result: "helped", provenance: "stated" }]));
  check("their stated went and didn't: confirmed", R.wentOnRecord(p, [{ result: "didnt_help", provenance: "stated" }]));
  check("a check-in at the door: confirmed", R.wentOnRecord({ ...p, checkinFollowupIds: ["c1"] }, []));
  check("a walk-in: confirmed", R.wentOnRecord({ ...p, walkinCheckinIds: ["w1"] }, []));
  const presumes = ["How was the Claude Founder Salon?", "Anyone stood out?", "Who did you meet there?", "Did you have fun at the salon?", "How'd the salon go?", "How\u2019d it go?", "Meet anyone interesting?"];
  const asks = ["Did you end up making it to the Claude Founder Salon?", "Were you able to get to the founder salon last night?"];
  check("lines that take for granted they went are caught", presumes.every((t) => R.PRESUMES_THEY_WENT.test(t)), presumes.filter((t) => !R.PRESUMES_THEY_WENT.test(t)));
  check("asking whether they made it passes", asks.every((t) => !R.PRESUMES_THEY_WENT.test(t)), asks.filter((t) => R.PRESUMES_THEY_WENT.test(t)));
  const reg = src("harness/proactiveRegistry.ts");
  check("an unconfirmed event's debrief is told to ask whether they made it", /nothing says they went\. Ask, lightly, whether they ended up making it/.test(reg));
  check("code backstop: an unconfirmed debrief that assumes they went is skipped", /if \(!went && !isOpportunity && PRESUMES_THEY_WENT\.test\(text\)\) return skip/.test(reg));
  const draft = reg.slice(reg.indexOf("async function draftDebrief("), reg.indexOf("async function debriefItemKeys("));
  check("the debrief decides went from the record only: this debrief's stated outcomes, never their texts", /wentOnRecord\(p, rows\)/.test(draft) && /FROM suggestion_outcomes WHERE user_id = \$1 AND item_key = ANY\(\$2::text\[\]\)/.test(draft) && !/text_exchange|attendanceConfirmed\(/.test(draft));
  check("the went rule reads only a stated helped / didn't help", /\(r\.result === "helped" \|\| r\.result === "didnt_help"\) && isStated\(r\.provenance\)/.test(reg));
}

console.log(`restraint for Co-started texts: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
