// Silence is never a fact (Royce, 2026-11-04/05; Cue Memory Spec step 9). Zero tokens, no database: pure functions and a stubbed store.
//   1. A goal's unanswered recheck does not stale it or retire its asks; a stated done still closes it.
//   2. A paused kind is visible in what-Cue-knows as pacing, removable, and removal lifts the pause for good.
//   3. Unanswered research finds weigh 0 for the member and for everyone; real answers still count.
//   4. A call-only member is active; quiet never excludes; an unanswered suggestion doesn't block a pair forever; a decline does.
//   5. Asks don't close on a clock.
//   npx tsx evals/silence/silenceNotAFact.ts
process.env.SENDBLUE_API_API_KEY ||= "ci";
process.env.SENDBLUE_API_API_SECRET ||= "ci";
process.env.ANTHROPIC_API_KEY ||= "ci";
process.env.OPENAI_API_KEY ||= "ci";
process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
import fs from "node:fs";
import { DateTime } from "luxon";
const R = await import("../../src/services/goalRecheck.js");
const G = await import("../../src/services/goalEdges.js");
const A = await import("../../src/services/askRetire.js");
const K = await import("../../src/services/kindRestraint.js");
const W = await import("../../src/services/whatCoKnows.js");
const Q = await import("../../src/services/researchQuality.js");
const M = await import("../../src/harness/matchGate.js");
const AE = await import("../../src/services/askExpiry.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const DAY = 86_400_000;
const NOW = new Date("2026-11-20T18:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

// ---- 1. goals and their asks
{
  const GOAL = "find a running club in the Marina";
  const row = (o: any = {}) => ({ goalHash: G.goalHash(GOAL), goal: GOAL, state: "active" as const, reason: "", source: "context" as const, changedAt: ago(60), lastSignalAt: ago(30), recheckAskedAt: ago(8), searched: true, ...o });
  for (const days of [8, 30, 120]) {
    const s = R.recheckDecide({ rows: [row({ recheckAskedAt: ago(days) })], now: NOW, signals: [], lastExchangeAt: ago(1), held: [], pendingText: [] })[0];
    check(`${days} days after an unanswered recheck: no idle, the goal stays active`, s.action !== "idle", s);
  }
  const answered = R.recheckDecide({ rows: [row()], now: NOW, signals: [{ goalHash: G.goalHash(GOAL), at: ago(2), kind: "text" }], lastExchangeAt: ago(1), held: [], pendingText: [] })[0];
  check("an answer still clears the ask", answered.action === "signal" && answered.clearAsk, answered);
  check("the stopped-looking note is not written for silence (the idle writer is unreachable from the decision)", !/action: "idle"/.test(src("services/goalRecheck.ts").replace(/\/\/.*$/gm, "").split("export function recheckDecide")[1]?.split("export function textSignals")[0] ?? ""));
  // The ask: a question out 8 days with no answer stays asked, never idle.
  const ask = { id: "a1", text: "find a running club", kind: "find", retiredAt: null, holdUntil: null, dueAt: ago(20), askedAt: ago(8), goals: [G.goalHash(GOAL)], hints: 0 } as any;
  const steps = A.retireDecide({ asks: [ask], goals: [{ goalHash: G.goalHash(GOAL), goal: GOAL, state: "active", reason: "", source: "context", toldAt: null, changedAt: ago(60), recheckAskedAt: null, lastSignalAt: ago(30) } as any], goalSteps: [], now: NOW, signals: [], lastAskAt: null, lastExchangeAt: ago(1), held: [], pendingText: [] });
  check("an ask whose question went unanswered for a week is not retired", steps[0].action !== "idle" && steps[0].action !== "idle_with_goal", steps[0]);
  // A stated done closes: markGoal still writes done (the path is untouched and not silence).
  check("a stated done still closes a goal (markGoal 'done' state exists)", /"done"/.test(src("services/goalEdges.ts")));
}

// ---- 2. a paused kind is visible and removable
{
  const items = W.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], paces: [{ kind: "find", line: `I'm holding off on ${K.PACE_LABELS.find} for a bit` }] } as any);
  const it = items.find((i: any) => i.source === "pace");
  check("a paused kind is listed in what-Cue-knows", !!it && it.ref === "pace:find", items);
  check("it reads as pacing, not taste", !!it && /holding off/.test(it.text) && !/don't like|not interested|lost interest|not your thing/i.test(it.text), it);
  check("the member can remove it (the removal path knows the kind)", W.fieldFor("pace:find") !== "pace" && /removePace/.test(src("services/whatCoKnows.ts")));
  // Removal: the pause lifts and what was let pass before it no longer re-suppresses.
  const sends = [1, 2].map((n) => ({ id: `s${n}`, kind: "find" as const, sentAt: ago(40 - n * 5), message: `find ${n}` }));
  const pausedStored = [{ kind: "find" as const, state: "suppressed" as const, suppressedAt: ago(30), enabledAt: null, evidence: ["s1", "s2"] }];
  const before = K.evaluateKindRestraint({ sends, inbound: [], stored: pausedStored, now: NOW }).get("find")!;
  check("two let pass: the kind is paused", before.suppressed || !!before.trial, before);
  const lifted = [{ ...pausedStored[0], state: "enabled" as const, enabledAt: ago(1) }];
  const after = K.evaluateKindRestraint({ sends, inbound: [], stored: lifted, now: NOW }).get("find")!;
  check("after their removal the same history does not pause it again", !after.suppressed && !after.trial, after);
  const newer = [...sends, { id: "s3", kind: "find" as const, sentAt: ago(0.5 + 3), message: "f3" }];
  check("one more let pass after the removal is not enough either", !K.evaluateKindRestraint({ sends: newer, inbound: [], stored: lifted, now: NOW }).get("find")!.suppressed);
}

// ---- 3. unanswered research finds
{
  check("an ignored find weighs 0", Q.OUTCOME_WEIGHT.ignored === 0);
  check("real answers still count", Q.OUTCOME_WEIGHT.yes > 0 && Q.OUTCOME_WEIGHT.no < 0 && Q.OUTCOME_WEIGHT.not_like_that < Q.OUTCOME_WEIGHT.no);
  const stats = Q.featureStats([{ features: ["site:a.com"], outcome: "ignored" }, { features: ["site:a.com"], outcome: "ignored" }, { features: ["site:b.com"], outcome: "yes" }]);
  check("ignored rows add nothing to the stats (not even to the count that dilutes a real answer)", !stats["site:a.com"] && stats["site:b.com"].n === 1, stats);
  const sql = src("services/researchQuality.ts");
  check("the member's and everyone's signal both leave ignored rows out", /outcome <> 'ignored'/.test(sql));
}

// ---- 4. matching
{
  const base = { shareReason: "what they've said they're looking for: \"Looking to meet climate founders\"", candidateStatedAsks: ["Looking to meet climate founders"], candidatePrivateTexts: [], alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true };
  const quiet = M.evaluateNetworkCandidate({ ...base, askerQuiet: true, candidateQuiet: true } as any);
  check("a member quiet for 90+ days is still a candidate: less contact, not excluded", quiet.ok, quiet.checks);
  check("an opted-out or unreachable member is still excluded", !M.evaluateNetworkCandidate({ ...base, candidateActive: false } as any).ok);
  const g = src("harness/matchGate.ts");
  check("activity counts calls as well as texts", /LIKE '\[Call\]%'/.test(g) && /LIKE 'User %'/.test(g));
  check("reachability no longer reads their last message", !/EXISTS \(\s*SELECT 1 FROM co_memories m WHERE m.user_id = u.id/.test(g));
  check("a declined, introduced or both-yes pair blocks for good", /status IN \('declined', 'introduced', 'both_interested'\)/.test(M.PAIR_BLOCKED_SQL));
  check("an unanswered or one-sided suggestion blocks only while recent", new RegExp(`GREATEST\\(created_at, a_interested_at, b_interested_at\\) > NOW\\(\\) - INTERVAL '${M.PAIR_RETRY_DAYS} days'`).test(M.PAIR_BLOCKED_SQL));
  check("the intro nudge reads the same rule", /PAIR_BLOCKED_SQL/.test(src("services/networkIntroNudge.ts")));
  check("passing on a teased intro still declines the pair even over an unanswered row", /DO UPDATE SET status = 'declined' WHERE network_introductions.status IN \('suggested'/.test(src("services/networkIntroNudge.ts")));
}

// ---- 5. asks don't close on a clock
{
  const said = DateTime.fromISO("2026-11-01T10:00:00", { zone: "UTC" });
  check("an ask with no named time has no clock", AE.askExpiresAt("anyone doing good climate meetups", said) === null);
  const named = AE.askExpiresAt("a founders dinner this Friday", said);
  check("an ask with a named time still ends a day after it", named instanceof Date, named);
  check("the 30-day lifespan is gone", !("ASK_LIFESPAN_DAYS" in AE));
  const e = src("services/askExpiry.ts").replace(/\/\/.*$/gm, "");
  check("the expiry job closes only asks whose named time passed", /if \(!named\)/.test(e) && !/memberSilence/.test(e) && !/INTERVAL '1 day'/.test(e));
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
