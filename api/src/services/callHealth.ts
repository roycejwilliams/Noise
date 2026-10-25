// The after-call health check (Royce, 2026-10-23). Computed when the post-call webhook is processed (routes/co.ts), from facts only:
// the webhook's own transcript and metadata, what the call brain logged during the call (harness_decisions), and the call's emotion
// read. A flagged call is held at ElevenLabs (services/elevenLabsForget.ts) until someone marks it reviewed, and it shows in the
// morning review (harness/devReview.ts, "Call flagged by the after-call check"). Nothing here sends anything to anyone.
//
// What is stored per call (call_health): flagged, reasons (codes from REASONS only, never the member's words or Cue's), reviewed_at.
// Log lines carry the conversation id and the codes, nothing else.
//
// The reasons, each a fact:
//   not_stored          the call's processing failed, so nothing of it is stored on our side (flagNotStored, routes/co.ts): its copy
//                       at ElevenLabs may be the only one, so it is held until someone looks
//   short_call          the call lasted under CALL_HEALTH.shortCallSecs
//   cut_mid_sentence    Cue's last line doesn't end a sentence (no closing . ! ? or …)
//   abnormal_end        ElevenLabs says the call failed or ended on an error/timeout, or Twilio reported it failed or canceled
//   slow_turn           a call-brain turn hit its time budget (CALL_TOOL_BUDGET_MS) or a tool was still running at it (call.turn_health)
//   brain_error         a call-brain turn failed (the upstream model errored; call.turn_health)
//   tool_failed         one of Cue's tools came back not done (call.tool), a background build failed (call.background_tool), or an
//                       ElevenLabs tool result says is_error
//   line_blocked        offerGuard kept a sentence back (call.offer_unsourced)
//   repeated_line       Cue said the same sentence (CALL_HEALTH.repeatMinWords words or more) twice
//   talk_over           CALL_HEALTH.talkOverTurns or more of Cue's lines were interrupted (the transcript's interrupted flag)
//   member_confused     the member said one of CONFUSED_PHRASES (literal, below); a "hello?" counts only after their first line
//   frustrated_with_co  the call's emotion read has frustration aimed at Cue (target co), or ElevenLabs scored a line at or above
//                       CALL_FRUSTRATION.high
//   hung_up_after_cue   Cue had the last line and the call ended within CALL_HEALTH.hangUpSecs of it finishing, with no goodbye from
//                       them (MEMBER_CLOSING) and no end_call from Cue
// Found later, by the scheduled pass (refreshLateHealth), until CALL_HEALTH.lateHours after the call:
//   promise_unkept      a promise made on the call (callCommitments ledger, co_tasks source 'promise') was checked and not kept
//   member_reported     the member reported an issue (user_reported_issues) between the call's start and lateHours after it
//   tool_failed         a background build started on the call failed after the call ended
//
// The judge seam (judgeCallHealth): the rule decides by default; a model judge can be plugged in later (the voiceRead pattern:
// rule default, a judge that fails falls back to the rule and says so). Not wired: nothing passes a judge today.
import pool from "../db/db.js";
import { CALL_FRUSTRATION } from "../harness/emotion.js";
import { MEMBER_CLOSING } from "./callLlmProxy.js";

export const REASONS = [
  "not_stored",
  "abnormal_end",
  "brain_error",
  "member_reported",
  "frustrated_with_co",
  "member_confused",
  "promise_unkept",
  "tool_failed",
  "hung_up_after_cue",
  "cut_mid_sentence",
  "slow_turn",
  "line_blocked",
  "talk_over",
  "repeated_line",
  "short_call",
] as const;
export type HealthReason = (typeof REASONS)[number];
// The morning review ranks by these: a call with any of them is high, the rest medium. REASONS is in rank order.
export const HIGH_REASONS: ReadonlySet<HealthReason> = new Set(["not_stored", "abnormal_end", "brain_error", "member_reported", "frustrated_with_co", "member_confused", "promise_unkept", "tool_failed", "hung_up_after_cue"]);
export const isReason = (x: unknown): x is HealthReason => typeof x === "string" && (REASONS as readonly string[]).includes(x);
export const rankReasons = (rs: Iterable<HealthReason>): HealthReason[] => REASONS.filter((r) => new Set(rs).has(r));

export const CALL_HEALTH = {
  shortCallSecs: 20,
  repeatMinWords: 4,
  talkOverTurns: 2,
  hangUpSecs: 4,
  // Speaking pace for how long Cue's last line took to say (words per second).
  wordsPerSec: 2.5,
  // How long after a call the late signals are still looked for.
  lateHours: 48,
  // The call's decision rows: from a little before its start to a little after its end (a turn's row lands as the turn ends).
  windowBeforeSecs: 10,
  windowAfterSecs: 120,
  batch: 200,
} as const;

// Literal phrases, matched as plain substrings of a member line (lowercased, curly apostrophes made straight). Kept small on purpose:
// these say the call itself went wrong (they can't hear Cue, Cue isn't hearing them, Cue got it wrong).
export const CONFUSED_PHRASES = [
  "are you there",
  "you there?",
  "can you hear me",
  "you're not listening",
  "you are not listening",
  "not listening to me",
  "that's wrong",
  "that is wrong",
  "that's not right",
  "that's not what i said",
  "i didn't say that",
] as const;
// "hello?" opens many calls (answering the phone); it counts only after their first line.
export const HELLO_PHRASE = "hello?";

export type HealthTurn = {
  role?: string;
  message?: string | null;
  time_in_call_secs?: number | null;
  interrupted?: boolean | null;
  tool_calls?: { tool_name?: string; name?: string }[] | null;
  tool_results?: { is_error?: boolean | null }[] | null;
  analysis?: { user_frustration_score?: number | null } | null;
};
export type HealthDecision = { decision: string; outcome: string; action: string | null };
export type CallHealthFacts = {
  durationSecs: number | null;
  terminationReason: string | null;
  status: string | null;
  turns: HealthTurn[];
  decisions: HealthDecision[];
  // The call's emotion read had frustration aimed at Cue (emotion_signals target 'co', not low).
  frustratedWithCo: boolean;
};

const plain = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'");
const wordsOf = (s: string) => plain(s).replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
const sentencesOf = (t: string) => (t.match(/[^.!?…\n]+[.!?…]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
const said = (t: HealthTurn) => typeof t.message === "string" && t.message.trim() !== "";
const isCue = (t: HealthTurn) => t.role === "agent" || t.role === "assistant";

// Pure: the reasons this call is flagged, in rank order. Each rule reads facts; none reads intent beyond the listed literal phrases.
export function callHealthReasons(f: CallHealthFacts): HealthReason[] {
  const out = new Set<HealthReason>();
  const turns = Array.isArray(f.turns) ? f.turns : [];
  const cue = turns.filter((t) => isCue(t) && said(t));
  const member = turns.filter((t) => t.role === "user" && said(t));

  if (typeof f.durationSecs === "number" && f.durationSecs > 0 && f.durationSecs < CALL_HEALTH.shortCallSecs) out.add("short_call");
  const lastCue = cue[cue.length - 1];
  if (lastCue && !/[.!?…]["'”’)\]]*$/.test(lastCue.message!.trim())) out.add("cut_mid_sentence");
  if (/^failed$/i.test(f.status ?? "") || /error|fail|time ?out|timed out/i.test(f.terminationReason ?? "")) out.add("abnormal_end");
  for (const d of f.decisions) {
    if (d.decision === "call.gate" && /:(failed|canceled)$/.test(d.action ?? "")) out.add("abnormal_end");
    if (d.decision === "call.turn_health") {
      const codes = String(d.action ?? "").split(",");
      if (codes.includes("slow")) out.add("slow_turn");
      if (codes.includes("error")) out.add("brain_error");
    }
    if (d.decision === "call.tool" && d.outcome === "skip") out.add("tool_failed");
    if (d.decision === "call.background_tool" && d.action === "failed") out.add("tool_failed");
    if (d.decision === "call.offer_unsourced") out.add("line_blocked");
  }
  if (turns.some((t) => (t.tool_results ?? []).some((r) => r?.is_error === true))) out.add("tool_failed");

  const seen = new Set<string>();
  for (const t of cue)
    for (const s of sentencesOf(t.message!)) {
      const w = wordsOf(s);
      if (w.length < CALL_HEALTH.repeatMinWords) continue;
      const k = w.join(" ");
      if (seen.has(k)) out.add("repeated_line");
      seen.add(k);
    }
  if (cue.filter((t) => t.interrupted === true).length >= CALL_HEALTH.talkOverTurns) out.add("talk_over");

  member.forEach((t, i) => {
    const line = plain(t.message!);
    if (CONFUSED_PHRASES.some((p) => line.includes(p)) || (i > 0 && line.includes(HELLO_PHRASE))) out.add("member_confused");
  });
  if (f.frustratedWithCo || turns.some((t) => t.role === "user" && typeof t.analysis?.user_frustration_score === "number" && t.analysis.user_frustration_score >= CALL_FRUSTRATION.high)) out.add("frustrated_with_co");

  const last = [...turns].reverse().find(said);
  const lastMember = member[member.length - 1];
  const cueEnded = turns.some((t) => (t.tool_calls ?? []).some((c) => /end_call/i.test(c?.tool_name ?? c?.name ?? "")));
  if (last && isCue(last) && typeof last.time_in_call_secs === "number" && typeof f.durationSecs === "number" && !cueEnded && !(lastMember && MEMBER_CLOSING.test(lastMember.message!))) {
    const spoken = wordsOf(last.message!).length / CALL_HEALTH.wordsPerSec;
    if (f.durationSecs - (last.time_in_call_secs + spoken) <= CALL_HEALTH.hangUpSecs) out.add("hung_up_after_cue");
  }
  return rankReasons(out);
}

// ---------------------------------------------------------------- the judge seam (not wired)

export type CallHealthJudge = { name: string; judge: (facts: CallHealthFacts, ruled: HealthReason[]) => Promise<HealthReason[]> };
export const ruleCallHealthJudge: CallHealthJudge = { name: "rule", judge: async (f) => callHealthReasons(f) };

// The rule always runs; a judge given here gets the facts and the rule's reasons, and decides. Only known codes are kept. A judge
// that throws or answers something that isn't a list falls back to the rule, and says so.
export async function judgeCallHealth(facts: CallHealthFacts, judge: CallHealthJudge = ruleCallHealthJudge): Promise<{ reasons: HealthReason[]; judgedBy: string }> {
  const ruled = callHealthReasons(facts);
  if (judge === ruleCallHealthJudge) return { reasons: ruled, judgedBy: "rule" };
  try {
    const r = await judge.judge(facts, ruled);
    if (!Array.isArray(r)) throw new Error("not a list");
    return { reasons: rankReasons(r.filter(isReason)), judgedBy: judge.name };
  } catch {
    return { reasons: ruled, judgedBy: `rule (fallback from ${judge.name})` };
  }
}

// ---------------------------------------------------------------- store

export type HealthDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
export type HealthDeps = { db: HealthDb; log: (line: string) => void; now?: () => Date };
export const realHealthDeps = (): HealthDeps => ({ db: pool, log: (l) => console.log(l) });

// After the post-call webhook's processing (routes/co.ts, not awaited). Reads the call's decision rows and its emotion read, judges,
// stores codes only. Idempotent: a redelivered webhook changes nothing. Never throws.
export async function recordCallHealth(
  o: { userId: string; conversationId: string; turns: unknown; durationSecs: number | null; terminationReason: string | null; status: string | null; startedAt: Date | null; endedAt: Date | null },
  deps: HealthDeps = realHealthDeps(),
  judge?: CallHealthJudge,
): Promise<{ flagged: boolean; reasons: HealthReason[] } | null> {
  try {
    if (!o.conversationId) return null;
    const now = deps.now?.() ?? new Date();
    const ended = o.endedAt ?? now;
    const started = o.startedAt ?? new Date(ended.getTime() - (o.durationSecs ?? 0) * 1000);
    const from = new Date(started.getTime() - CALL_HEALTH.windowBeforeSecs * 1000);
    const to = new Date(ended.getTime() + CALL_HEALTH.windowAfterSecs * 1000);
    const [dec, emo] = await Promise.all([
      deps.db.query(
        `SELECT decision, outcome, action FROM harness_decisions
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
           AND decision IN ('call.turn_health', 'call.tool', 'call.background_tool', 'call.offer_unsourced', 'call.gate')`,
        [o.userId, from, to],
      ),
      deps.db.query(`SELECT 1 FROM emotion_signals WHERE user_id = $1 AND source = 'call' AND target = 'co' AND intensity <> 'low' AND created_at >= $2 LIMIT 1`, [o.userId, from]),
    ]);
    const facts: CallHealthFacts = {
      durationSecs: o.durationSecs,
      terminationReason: o.terminationReason,
      status: o.status,
      turns: Array.isArray(o.turns) ? (o.turns as HealthTurn[]) : [],
      decisions: dec.rows.map((r: any) => ({ decision: String(r.decision), outcome: String(r.outcome), action: r.action == null ? null : String(r.action) })),
      frustratedWithCo: emo.rows.length > 0,
    };
    const { reasons, judgedBy } = await judgeCallHealth(facts, judge);
    await deps.db.query(
      `INSERT INTO call_health (conversation_id, user_id, started_at, ended_at, flagged, reasons, judged_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (conversation_id) DO NOTHING`,
      [o.conversationId, o.userId, started, ended, reasons.length > 0, reasons, judgedBy],
    );
    deps.log(`call-health: ${o.conversationId} ${reasons.length ? `flagged: ${reasons.join(", ")}` : "clean"}`);
    return { flagged: reasons.length > 0, reasons };
  } catch (err: any) {
    deps.log(`call-health: ${o.conversationId} not recorded (${String(err?.message ?? err).slice(0, 80)})`);
    return null;
  }
}

// The call's processing failed before anything was stored (routes/co.ts): the call is flagged not_stored, whatever the health
// check finds or found, so its ElevenLabs copy is held until reviewed. Codes only. Never throws.
export async function flagNotStored(o: { userId: string; conversationId: string; startedAt: Date | null; endedAt: Date | null }, deps: HealthDeps = realHealthDeps()): Promise<boolean> {
  try {
    if (!o.conversationId) return false;
    const ended = o.endedAt ?? deps.now?.() ?? new Date();
    await deps.db.query(
      `INSERT INTO call_health (conversation_id, user_id, started_at, ended_at, flagged, reasons) VALUES ($1, $2, $3, $4, true, ARRAY['not_stored'])
       ON CONFLICT (conversation_id) DO UPDATE SET flagged = true, updated_at = NOW(),
         reasons = CASE WHEN 'not_stored' = ANY(call_health.reasons) THEN call_health.reasons ELSE ARRAY['not_stored'] || call_health.reasons END`,
      [o.conversationId, o.userId, o.startedAt ?? ended, ended],
    );
    deps.log(`call-health: ${o.conversationId} flagged: not_stored`);
    return true;
  } catch (err: any) {
    deps.log(`call-health: ${o.conversationId} not_stored not recorded (${String(err?.message ?? err).slice(0, 80)})`);
    return false;
  }
}

// Pure: the late reasons for one call, from its rows.
export function lateReasons(r: { unkeptPromises: number; reports: number; backgroundFailures: number }): HealthReason[] {
  const out: HealthReason[] = [];
  if (r.unkeptPromises > 0) out.push("promise_unkept");
  if (r.reports > 0) out.push("member_reported");
  if (r.backgroundFailures > 0) out.push("tool_failed");
  return rankReasons(out);
}

// The scheduled pass (jobs/index.ts, with the deletion pass): calls still inside their late window get the late signals. A code the
// call didn't have yet flags it (and a call reviewed before that code turned up is held again for review). Past the late window the
// call is closed for late signals (late_done_at), which the deletion pass waits for. Never throws.
export async function refreshLateHealth(deps: HealthDeps = realHealthDeps()): Promise<{ checked: number; newlyFlagged: number }> {
  let checked = 0, newlyFlagged = 0;
  try {
    const now = deps.now?.() ?? new Date();
    const { rows } = await deps.db.query(`SELECT conversation_id, user_id, started_at, ended_at, reasons FROM call_health WHERE late_done_at IS NULL ORDER BY ended_at LIMIT $1`, [CALL_HEALTH.batch]);
    for (const h of rows) {
      checked++;
      const started = new Date(h.started_at);
      const ended = new Date(h.ended_at);
      const lateUntil = new Date(ended.getTime() + CALL_HEALTH.lateHours * 3_600_000);
      const [promises, reports, bg] = await Promise.all([
        deps.db.query(
          `SELECT count(*)::int AS n FROM harness_decisions d JOIN co_tasks t ON t.id::text = d.proposal->>'taskId'
           WHERE d.user_id = $1 AND d.decision = 'call.commitment' AND d.action = 'unkept'
             AND t.user_id = $1 AND t.source = 'promise' AND t.created_at >= $2 AND t.created_at <= $3`,
          [h.user_id, started, new Date(ended.getTime() + CALL_HEALTH.windowAfterSecs * 1000)],
        ),
        deps.db.query(`SELECT count(*)::int AS n FROM user_reported_issues WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3`, [h.user_id, started, lateUntil]),
        deps.db.query(
          `SELECT count(*)::int AS n FROM harness_decisions WHERE user_id = $1 AND decision = 'call.background_tool' AND action = 'failed' AND created_at >= $2 AND created_at <= $3`,
          [h.user_id, started, new Date(ended.getTime() + 30 * 60_000)],
        ),
      ]);
      const had = new Set<string>((h.reasons ?? []).filter(isReason));
      const late = lateReasons({ unkeptPromises: Number(promises.rows[0]?.n ?? 0), reports: Number(reports.rows[0]?.n ?? 0), backgroundFailures: Number(bg.rows[0]?.n ?? 0) });
      const added = late.filter((r) => !had.has(r));
      const done = now >= lateUntil;
      if (!added.length && !done) continue;
      const reasons = rankReasons([...(had as Set<HealthReason>), ...added]);
      await deps.db.query(
        `UPDATE call_health SET reasons = $2, flagged = $3, reviewed_at = CASE WHEN $4 THEN NULL ELSE reviewed_at END, late_done_at = CASE WHEN $5 THEN $6::timestamptz ELSE late_done_at END, updated_at = NOW()
         WHERE conversation_id = $1`,
        [h.conversation_id, reasons, reasons.length > 0, added.length > 0, done, now],
      );
      if (added.length) {
        newlyFlagged++;
        deps.log(`call-health: ${h.conversation_id} flagged later: ${added.join(", ")}`);
      }
    }
  } catch (err: any) {
    deps.log(`call-health: late pass failed (${String(err?.message ?? err).slice(0, 80)})`);
  }
  return { checked, newlyFlagged };
}

// Marking a flagged call reviewed (scripts/callReviewed.ts, or on co-test the node one-liner there). After this, the call's normal
// deletion applies: the next deletion pass deletes it once its window has passed. Returns false when there was no such flagged call.
export async function markCallReviewed(conversationId: string, deps: Pick<HealthDeps, "db"> = realHealthDeps()): Promise<boolean> {
  const r = await deps.db.query(`UPDATE call_health SET reviewed_at = NOW(), updated_at = NOW() WHERE conversation_id = $1 AND flagged RETURNING conversation_id`, [conversationId]);
  return r.rows.length > 0;
}

export type FlaggedCall = { conversationId: string; userId: string; endedAt: string; reasons: HealthReason[] };
// Flagged and not yet reviewed, newest first: for the morning review and the script's list. Codes only. Every one still held is
// shown, however old (on co-test a hold never expires; days narrows it only when asked).
export async function flaggedCalls(o: { userId?: string; until?: Date; days?: number } = {}, deps: Pick<HealthDeps, "db"> = realHealthDeps()): Promise<FlaggedCall[]> {
  const until = o.until ?? new Date();
  const { rows } = await deps.db.query(
    `SELECT conversation_id, user_id, ended_at, reasons FROM call_health
     WHERE flagged AND reviewed_at IS NULL AND ended_at <= $1 AND ($2::int IS NULL OR ended_at > $1::timestamptz - make_interval(days => $2)) AND ($3::uuid IS NULL OR user_id = $3)
     ORDER BY ended_at DESC LIMIT 200`,
    [until, o.days ?? null, o.userId ?? null],
  );
  return rows.map((r: any) => ({ conversationId: String(r.conversation_id), userId: String(r.user_id), endedAt: new Date(r.ended_at).toISOString(), reasons: rankReasons((r.reasons ?? []).filter(isReason)) }));
}
