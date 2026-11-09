// Considered follow-through after a call (Royce, 2026-11-09): the text after a call works out what they actually asked or struggled
// with and sends the one thing that helps them move (a grounded take, a step that's theirs, a reflection when they mostly needed to
// say it) or nothing. Never a suggested person or introduction it can't check, never an automatic comforting text in place of a SKIP.
// Layer 1: synthetic member (invented names), the model stubbed through the draft's own seam, no database, no network.
//   npx tsx evals/followThrough/postCallTake.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const PC = await import("../../src/jobs/postCallFollowUp.js");
const P = await import("../../src/harness/proactive.js");
const { CHECKIN_TONE } = await import("../../src/services/coVoice.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };

// A stuck decision on a call: they asked for a read and the call ended before one landed.
const STUCK = `assistant: Hey Jordan, it's Cue. How's the week going?
user: Honestly I'm stuck. I have two offers, one at a seed-stage climate startup and one at a big design firm, and I have to answer the firm by the end of the month.
assistant: That's a real fork. What's pulling you each way?
user: The startup is the work I actually care about, but the firm is the safer money and my partner is nervous about the move. I keep going back and forth. What would you do?
assistant: Let's keep talking about it. Got to run in a minute?
user: Yeah, I have to jump. Thanks.`;
// Mostly needing to say it: a hard week, no ask.
const VENT = `assistant: Hey Noor, it's Cue. How are you?
user: Rough week. My cofounder and I had the same argument again about hiring and I'm just tired of it.
assistant: That sounds draining.
user: It is. I don't need fixing, I just needed to say it out loud to someone.
assistant: I'm glad you did.
user: Okay. Thanks for listening.`;

const prompts: string[] = [];
const draftWith = async (answer: string, transcript: string) => {
  P.setProactiveModelForTests(async (p) => { prompts.push(p); return answer; });
  try { return await PC.draftPostCallText("Jordan", transcript, ""); } finally { P.setProactiveModelForTests(null); }
};

// ---------------------------------------------------------------- 1. the task: reason past the last exchange, a take is enough
{
  const t = PC.POST_CALL_TASK;
  check("the task works out what they actually asked or struggled with, and what they wanted from the call", /what they actually asked about or struggled with/.test(t) && /what they wanted from talking it through/.test(t) && /whether the call already got them there/.test(t));
  check("a grounded take or a step that's theirs is a whole follow-up; a question is optional", /your own grounded take/.test(t) && /A take is enough on its own; a question is optional\./.test(t));
  check("venting and help aren't separate boxes: receive it first, no pushed solution, no withheld one", /These aren't separate boxes/.test(t) && /Receive what they felt first/.test(t) && /Never push a solution at someone who only wanted to be heard, and never hold back a useful one from someone who clearly wanted it\./.test(t));
  check("a read under what they said is tentative and theirs to correct; no deeper problem they didn't voice", /offer it tentatively, as yours to be corrected/.test(t) && /Never name a deeper problem, motive or feeling they didn't express\./.test(t));
  check("silence is a fine answer: SKIP when the call landed it, the texts since covered it, or it would only echo them", /return SKIP\. Silence is a fine answer\./.test(t) && /your texts with them since the call already covered it/.test(t));
  check("no claimed reflection: never announce or imply time spent thinking", /Never announce or imply that you were thinking about it or took time with it/.test(t));
  check("not every problem goes to matching: no steering to a person or event they weren't asking about, no specific one named", /Don't steer it toward meeting someone or going to an event unless that's what they were asking about/.test(t) && /never name or suggest a specific person, event, community or introduction here/.test(t));
  check("the check-in tone rides (no grading, no required question, real quotes only)", t.includes(CHECKIN_TONE));
  check("what's stated about them is still only what they said on the call (the 10-06 guard stays)", /What you say about them comes only from what THEY said on the call/.test(t) && /never restate it as something they said/.test(t));
  check("the old 'a real follow-up every time' is gone (silence is valid now)", !/a real follow-up every time/.test(t));
  check("the draft is given the task, with the correction and the member's picture after it as before", /task: `\$\{POST_CALL_TASK\}\$\{correcting \? `\\n\\n\$\{CALL_CORRECTION_TASK\}` : ""\}\$\{knowledge \? `\\n\\n\$\{postCallKnowledgeSection\(knowledge\)\}` : ""\}`/.test(src("jobs/postCallFollowUp.ts")));
}

// ---------------------------------------------------------------- 2. a worthwhile later contribution goes, through the usual checks
{
  const take = "Two offers and a clock on one of them is a lot to carry. If the startup is the work you care about, I'd ask them for one concrete thing that lowers the risk for you and your partner, like a few months of runway in writing, before you answer the firm.";
  const r = await draftWith(take, STUCK);
  check("a grounded take after a stuck decision is drafted and comes back whole", r?.text === take, r);
  const checks = r ? P.checkDraft(r.text, r.rules) : [];
  check("and it passes the post-call draft checks (no question needed, no intro, within length)", checks.length > 0 && checks.every((c) => c.pass), checks.filter((c) => !c.pass));
  check("the draft saw the task and the transcript", prompts.at(-1)!.includes(PC.POST_CALL_TASK) && prompts.at(-1)!.includes("What would you do?"));
}

// ---------------------------------------------------------------- 3. venting: SKIP is honored and is a fit skip, never a comfort line
{
  const r = await draftWith("SKIP", VENT);
  check("a SKIP after a call where they only needed to be heard drafts nothing", r === null, r);
  check("the registry records a post-call SKIP with its reason (a fit skip)", /skip\(POST_CALL_SKIP\)/.test(src("harness/proactiveRegistry.ts")) && /^model chose SKIP:\s*\S/.test(PC.POST_CALL_SKIP));
  const hardSince = new Date("2026-11-08T12:00:00Z");
  const state = { now: new Date("2026-11-09T18:00:00Z"), needsCare: true, moodHold: { state: "held" as const, hold: true, heldHours: 30 }, safetyHold: false, sends: [] as any[] };
  const after = P.moodFallbackDecision({ candidate: { type: "post_call", payload: { moodDraftSkipAt: "2026-11-09T12:00:00Z" } }, skip: PC.POST_CALL_SKIP, state, hardSince });
  check("on a hard day, a post-call SKIP never becomes the automatic fallback line", after.send === false && /fit skip/.test((after as { why: string }).why), after);
  const bare = P.moodFallbackDecision({ candidate: { type: "post_call", payload: { moodDraftSkipAt: "2026-11-09T12:00:00Z" } }, skip: "model chose SKIP", state, hardSince });
  check("(the bare SKIP it used to record would have sent that line: the change is what stops it)", bare.send === true, bare);
  // Known and kept: the dispatch's one mood wait (firstDraftMoodWait) still applies to a reasoned SKIP, so a post-call SKIP on a hard
  // day is drafted once more later (bounded by the 24h expiry); a second SKIP is dropped, never replaced by the fallback line.
  check("(its one mood wait still applies: one later redraft, then silence)", P.firstDraftMoodWait({ payload: {} }, PC.POST_CALL_SKIP, state) === true);
}

// ---------------------------------------------------------------- 4. a suggestion whose fit can't be verified isn't sent as a claim
{
  const intro = "Sounds like you're weighing safety against the work you care about. I can introduce you to Dana, who made the same jump last year.";
  const r = await draftWith(intro, STUCK);
  const failedChecks = r ? P.checkDraft(r.text, r.rules).filter((c) => !c.pass) : [];
  check("a post-call draft that offers an introduction fails its checks (matching has its own double opt-in)", failedChecks.some((c) => c.name === "draft_forbidden" && /double opt-in/.test(c.reason ?? "")), failedChecks);
  for (const s of ["Want me to connect you with someone who's done this?", "I could put you in touch with a founder in climate.", "Happy to make an intro to a hiring lead there."]) {
    check(`the intro guard catches: "${s}"`, PC.POST_CALL_NO_INTRO.pattern.test(s));
  }
  for (const s of ["I'd talk to your partner about the runway before you answer.", "Worth asking the founder what the next raise looks like.", "Meet with your cofounder before the hiring call."]) {
    check(`advice to talk to someone they named passes: "${s}"`, !PC.POST_CALL_NO_INTRO.pattern.test(s));
  }
  const withCorrection = await (async () => {
    P.setProactiveModelForTests(async () => intro);
    try { return await PC.draftPostCallText("Jordan", STUCK, "", [], { theySaid: [], coInferred: [] }, null, null, [], [{ id: "c1", quote: "the dinner is Friday", type: "invented_fact", note: null, callKey: null, source: "audit", deliveredAt: null }]); } finally { P.setProactiveModelForTests(null); }
  })();
  check("the guard rides a text that carries a correction too", !!withCorrection && withCorrection.rules.forbidden?.includes(PC.POST_CALL_NO_INTRO) === true, withCorrection?.rules);
}

console.log(`post-call take: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
