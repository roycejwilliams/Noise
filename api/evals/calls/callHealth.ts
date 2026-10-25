// Model-free checks for the after-call health check (services/callHealth.ts, 2026-10-23): each signal fires on its fixture and not
// on a clean call, only codes are stored or logged, the late signals, the judge seam, and the morning review's flags. An in-memory
// database; no API calls, nothing sent.
//   npx tsx evals/calls/callHealth.ts
import { readFileSync } from "fs";
import {
  CALL_HEALTH,
  CONFUSED_PHRASES,
  HIGH_REASONS,
  REASONS,
  callHealthReasons,
  flaggedCalls,
  judgeCallHealth,
  lateReasons,
  flagNotStored,
  markCallReviewed,
  recordCallHealth,
  refreshLateHealth,
  ruleCallHealthJudge,
  type CallHealthFacts,
  type HealthTurn,
} from "../../src/services/callHealth.js";
import { callHealthFlags, FLAG_LABELS, renderDigest } from "../../src/harness/devReview.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  }
};

// Words that must never be stored or logged: the member's and Cue's.
const SECRET = "my sister's diagnosis";
const clean: HealthTurn[] = [
  { role: "agent", message: "Hey Jordan, good to hear you.", time_in_call_secs: 0 },
  { role: "user", message: `Hello? Hi. I wanted to talk about ${SECRET}.`, time_in_call_secs: 3 },
  { role: "agent", message: "I'm glad you told me. How are you holding up?", time_in_call_secs: 9 },
  { role: "user", message: "Okay I think. Anyway, talk soon, bye.", time_in_call_secs: 20, analysis: { user_frustration_score: 0.1 } },
  { role: "agent", message: "Bye Jordan, take care.", time_in_call_secs: 25 },
];
const facts = (o: Partial<CallHealthFacts> = {}): CallHealthFacts => ({ durationSecs: 90, terminationReason: "Call ended by remote party", status: "done", turns: clean, decisions: [], frustratedWithCo: false, ...o });
const only = (f: CallHealthFacts, r: string) => {
  const got = callHealthReasons(f);
  return got.length === 1 && got[0] === r;
};

// 1. A clean call: nothing.
check("1a a clean call (with an opening 'Hello?', a goodbye and a hang-up after it) is not flagged", callHealthReasons(facts()).length === 0, callHealthReasons(facts()));

// 2. Each signal on its own fixture.
check("2a short_call", only(facts({ durationSecs: CALL_HEALTH.shortCallSecs - 1 }), "short_call"), callHealthReasons(facts({ durationSecs: CALL_HEALTH.shortCallSecs - 1 })));
check("2a' a call of exactly the threshold isn't short", !callHealthReasons(facts({ durationSecs: CALL_HEALTH.shortCallSecs })).includes("short_call"));
const cut = [...clean.slice(0, 4), { role: "agent", message: "Before you go, I wanted to mention the", time_in_call_secs: 25 }];
check("2b cut_mid_sentence: Cue's last line doesn't end a sentence", callHealthReasons(facts({ turns: cut })).includes("cut_mid_sentence"));
check("2b' a last line ending in a quote after the stop is complete", !callHealthReasons(facts({ turns: [...clean.slice(0, 4), { role: "agent", message: 'You said "talk soon."', time_in_call_secs: 25 }] })).includes("cut_mid_sentence"));
check("2c abnormal_end: ElevenLabs status failed", only(facts({ status: "failed" }), "abnormal_end"));
check("2c' abnormal_end: termination on an error", only(facts({ terminationReason: "LLM error: upstream timed out" }), "abnormal_end"));
check("2c'' abnormal_end: Twilio said failed", only(facts({ decisions: [{ decision: "call.gate", outcome: "skip", action: "missed_call_followup:failed" }] }), "abnormal_end"));
check("2d slow_turn: a turn hit its budget", only(facts({ decisions: [{ decision: "call.turn_health", outcome: "skip", action: "slow" }] }), "slow_turn"));
check("2e brain_error: a turn failed", only(facts({ decisions: [{ decision: "call.turn_health", outcome: "skip", action: "error" }] }), "brain_error"));
check("2e' both on one turn", JSON.stringify(callHealthReasons(facts({ decisions: [{ decision: "call.turn_health", outcome: "skip", action: "slow,error" }] }))) === JSON.stringify(["brain_error", "slow_turn"]));
check("2f tool_failed: a Cue tool came back not done", only(facts({ decisions: [{ decision: "call.tool", outcome: "skip", action: "startTask" }] }), "tool_failed"));
check("2f' a tool that worked is not a failure", callHealthReasons(facts({ decisions: [{ decision: "call.tool", outcome: "act", action: "startTask" }] })).length === 0);
check("2f'' tool_failed: a background build failed", only(facts({ decisions: [{ decision: "call.background_tool", outcome: "skip", action: "failed" }] }), "tool_failed"));
check("2f''' tool_failed: an ElevenLabs tool result is_error", only(facts({ turns: [clean[0], { ...clean[1], tool_results: [{ is_error: true }] }, ...clean.slice(2)] }), "tool_failed"));
check("2g line_blocked: offerGuard kept a sentence back", only(facts({ decisions: [{ decision: "call.offer_unsourced", outcome: "skip", action: "dropped_sentence" }] }), "line_blocked"));
const repeated = [clean[0], clean[1], { role: "agent", message: "Tell me more about how the week went.", time_in_call_secs: 9 }, { role: "user", message: "Uh, sure.", time_in_call_secs: 14 }, { role: "agent", message: "Okay. Tell me more about how the week went!", time_in_call_secs: 16 }, clean[3], clean[4]];
check("2h repeated_line: Cue said the same sentence twice", only(facts({ turns: repeated }), "repeated_line"));
check("2h' a short line said twice ('Got it.') is not a repeat", callHealthReasons(facts({ turns: [clean[0], { role: "agent", message: "Got it.", time_in_call_secs: 4 }, clean[1], { role: "agent", message: "Got it.", time_in_call_secs: 8 }, ...clean.slice(2)] })).length === 0);
const over = clean.map((t) => (t.role === "agent" && t.time_in_call_secs! < 20 ? { ...t, interrupted: true } : t));
check("2i talk_over: two of Cue's lines interrupted", only(facts({ turns: over }), "talk_over"));
check("2i' one interruption is not talk-over", callHealthReasons(facts({ turns: clean.map((t, i) => (i === 0 ? { ...t, interrupted: true } : t)) })).length === 0);
for (const phrase of CONFUSED_PHRASES) {
  const t = [...clean.slice(0, 3), { role: "user", message: `Hmm, ${phrase} Anyway, talk soon, bye.`, time_in_call_secs: 20 }, clean[4]];
  check(`2j member_confused: "${phrase}"`, only(facts({ turns: t }), "member_confused"));
}
check("2j' 'hello?' after their first line counts", only(facts({ turns: [...clean.slice(0, 3), { role: "user", message: "Hello? Okay, talk soon, bye.", time_in_call_secs: 20 }, clean[4]] }), "member_confused"));
check("2j'' a curly apostrophe still matches", only(facts({ turns: [...clean.slice(0, 3), { role: "user", message: "That’s wrong. Talk soon, bye.", time_in_call_secs: 20 }, clean[4]] }), "member_confused"));
check("2k frustrated_with_co: the emotion read aimed at Cue", only(facts({ frustratedWithCo: true }), "frustrated_with_co"));
check("2k' frustrated_with_co: ElevenLabs' score at the high mark", only(facts({ turns: clean.map((t, i) => (i === 3 ? { ...t, analysis: { user_frustration_score: 0.6 } } : t)) }), "frustrated_with_co"));
check("2k'' a score below the high mark is not", callHealthReasons(facts({ turns: clean.map((t, i) => (i === 3 ? { ...t, analysis: { user_frustration_score: 0.59 } } : t)) })).length === 0);
const hangUp = [...clean.slice(0, 3), { role: "user", message: "Sure.", time_in_call_secs: 20 }, { role: "agent", message: "Great, so I found three dinners this week.", time_in_call_secs: 22 }];
check("2l hung_up_after_cue: the call ended right after Cue's line, no goodbye", only(facts({ turns: hangUp, durationSecs: 26 }), "hung_up_after_cue"));
check("2l' after their goodbye it isn't", callHealthReasons(facts({ durationSecs: 27 })).length === 0);
check("2l'' a long silence after Cue's line isn't a hang-up on it", !callHealthReasons(facts({ turns: hangUp, durationSecs: 60 })).includes("hung_up_after_cue"));
check("2l''' Cue ending the call itself isn't", !callHealthReasons(facts({ turns: [...hangUp.slice(0, 4), { ...hangUp[4], tool_calls: [{ tool_name: "end_call" }] }], durationSecs: 26 })).includes("hung_up_after_cue"));
check("2m reasons come back in rank order, codes only", JSON.stringify(callHealthReasons(facts({ status: "failed", durationSecs: 10, decisions: [{ decision: "call.offer_unsourced", outcome: "skip", action: "x" }] }))) === JSON.stringify(["abnormal_end", "line_blocked", "short_call"]));
check("2n every code is in REASONS, and HIGH_REASONS is a subset", [...HIGH_REASONS].every((r) => (REASONS as readonly string[]).includes(r)));
check("2o unknown decision rows and junk turns are ignored", callHealthReasons(facts({ decisions: [{ decision: "call.cues", outcome: "skip", action: "cue_rules_broken" }], turns: [...clean, { role: "user" }, { role: "agent", message: "" } as HealthTurn] })).length === 0);

// 3. The judge seam: the rule by default; a judge decides when given, falls back when it fails. Not wired.
{
  const f = facts({ durationSecs: 10 });
  const r = await judgeCallHealth(f);
  check("3a the rule judges by default", r.judgedBy === "rule" && JSON.stringify(r.reasons) === JSON.stringify(["short_call"]) && ruleCallHealthJudge.name === "rule");
  const j = await judgeCallHealth(f, { name: "jev-fake", judge: async (_f, ruled) => [...ruled, "talk_over", "made_up_code" as any] });
  check("3b a judge decides; only known codes are kept, in rank order", j.judgedBy === "jev-fake" && JSON.stringify(j.reasons) === JSON.stringify(["talk_over", "short_call"]));
  const t = await judgeCallHealth(f, { name: "jev-fake", judge: async () => { throw new Error("busy"); } });
  check("3c a failing judge falls back to the rule, and says so", t.judgedBy === "rule (fallback from jev-fake)" && JSON.stringify(t.reasons) === JSON.stringify(["short_call"]));
  const n = await judgeCallHealth(f, { name: "jev-fake", judge: async () => "flag it" as any });
  check("3d a judge answering something that isn't a list falls back too", n.judgedBy === "rule (fallback from jev-fake)");
  const svc = readFileSync(new URL("../../src/services/callHealth.ts", import.meta.url), "utf8");
  const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
  check("3e not wired: nothing imports a model or the gateway, and the route passes no judge", !/jevGateway|generateText|anthropic/.test(svc) && /recordCallHealth\(\{[^}]*?\n\s*\}\)\.catch\(\(\) => \{\}\);/.test(co));
}

// 4. recordCallHealth: reads the call's rows, stores codes only, logs codes only, idempotent, never throws.
type HRow = { conversation_id: string; user_id: string; started_at: Date; ended_at: Date; flagged: boolean; reasons: string[]; judged_by: string; reviewed_at: Date | null; late_done_at: Date | null };
function healthWorld(o: { decisions?: { decision: string; outcome: string; action: string; at: number }[]; emotionCo?: boolean; unkept?: number; reports?: number; bg?: number; throwOn?: RegExp } = {}) {
  const rows = new Map<string, HRow>();
  const params: unknown[][] = [];
  let now = Date.UTC(2026, 9, 20, 18, 0, 0);
  const db = {
    async query(sql: string, p: any[] = []): Promise<{ rows: any[] }> {
      params.push(p);
      if (o.throwOn?.test(sql)) throw new Error("connection refused");
      if (/FROM harness_decisions\s+WHERE user_id = \$1 AND created_at >= \$2/.test(sql)) return { rows: (o.decisions ?? []).filter((d) => d.at >= p[1].getTime() && d.at <= p[2].getTime()) };
      if (/FROM emotion_signals/.test(sql)) return { rows: o.emotionCo ? [{ "?column?": 1 }] : [] };
      if (/INSERT INTO call_health[\s\S]*ARRAY\['not_stored'\][\s\S]*ON CONFLICT \(conversation_id\) DO UPDATE/.test(sql)) {
        const r = rows.get(p[0]);
        if (!r) rows.set(p[0], { conversation_id: p[0], user_id: p[1], started_at: p[2], ended_at: p[3], flagged: true, reasons: ["not_stored"], judged_by: "", reviewed_at: null, late_done_at: null });
        else {
          r.flagged = true;
          if (!r.reasons.includes("not_stored")) r.reasons = ["not_stored", ...r.reasons];
        }
        return { rows: [] };
      }
      if (/INSERT INTO call_health/.test(sql)) {
        if (!rows.has(p[0])) rows.set(p[0], { conversation_id: p[0], user_id: p[1], started_at: p[2], ended_at: p[3], flagged: p[4], reasons: p[5], judged_by: p[6], reviewed_at: null, late_done_at: null });
        return { rows: [] };
      }
      if (/FROM call_health WHERE late_done_at IS NULL/.test(sql)) return { rows: [...rows.values()].filter((r) => r.late_done_at === null) };
      if (/decision = 'call\.commitment'/.test(sql)) return { rows: [{ n: o.unkept ?? 0 }] };
      if (/FROM user_reported_issues/.test(sql)) return { rows: [{ n: o.reports ?? 0 }] };
      if (/decision = 'call\.background_tool'/.test(sql)) return { rows: [{ n: o.bg ?? 0 }] };
      if (/UPDATE call_health SET reasons/.test(sql)) {
        const r = rows.get(p[0])!;
        r.reasons = p[1];
        r.flagged = p[2];
        if (p[3]) r.reviewed_at = null;
        if (p[4]) r.late_done_at = p[5];
        return { rows: [] };
      }
      if (/UPDATE call_health SET reviewed_at = NOW\(\)/.test(sql)) {
        const r = rows.get(p[0]);
        if (!r?.flagged) return { rows: [] };
        r.reviewed_at = new Date(now);
        return { rows: [{ conversation_id: p[0] }] };
      }
      if (/FROM call_health\s+WHERE flagged AND reviewed_at IS NULL/.test(sql))
        return { rows: [...rows.values()].filter((r) => r.flagged && !r.reviewed_at && r.ended_at <= p[0] && (p[1] === null || +r.ended_at > +p[0] - p[1] * 86_400_000) && (p[2] === null || r.user_id === p[2])).sort((a, b) => +b.ended_at - +a.ended_at) };
      throw new Error(`fake db: unexpected query ${sql.slice(0, 60)}`);
    },
  };
  return { db, rows, params, advanceHours: (h: number) => (now += h * 3_600_000), now: () => new Date(now) };
}
const U = "00000000-0000-0000-0000-0000000000aa";
const START = new Date(Date.UTC(2026, 9, 20, 17, 0, 0));
const END = new Date(START.getTime() + 90_000);
const input = (o: Partial<Parameters<typeof recordCallHealth>[0]> = {}) => ({ userId: U, conversationId: "conv_h", turns: clean as unknown, durationSecs: 90, terminationReason: "Call ended by remote party", status: "done", startedAt: START, endedAt: END, ...o });
{
  const w = healthWorld({ decisions: [{ decision: "call.turn_health", outcome: "skip", action: "slow", at: START.getTime() + 30_000 }, { decision: "call.tool", outcome: "skip", action: "startTask", at: START.getTime() - 3_600_000 }] });
  const logs: string[] = [];
  const r = await recordCallHealth(input({ turns: [...clean.slice(0, 3), { role: "user", message: `${SECRET}, that's wrong. Talk soon, bye.`, time_in_call_secs: 20 }, clean[4]] }), { db: w.db, log: (l) => logs.push(l) });
  const row = w.rows.get("conv_h")!;
  check("4a flagged from the webhook and the call's own decision rows only (an hour-old tool row is outside the window)", r?.flagged === true && JSON.stringify(row.reasons) === JSON.stringify(["member_confused", "slow_turn"]) && row.flagged && row.judged_by === "rule", row);
  check("4b stored: codes only, never their words", row.reasons.every((x) => (REASONS as readonly string[]).includes(x)) && !JSON.stringify(row).includes("sister") && !JSON.stringify(row).includes("wrong"));
  check("4c logged: the id and the codes, never their words", logs.length === 1 && logs[0] === "call-health: conv_h flagged: member_confused, slow_turn");
  check("4d nothing written carries their words", !JSON.stringify(w.params).includes("sister"));
  await recordCallHealth(input({ turns: clean, durationSecs: 5 }), { db: w.db, log: () => {} });
  check("4e a redelivered webhook changes nothing", JSON.stringify(w.rows.get("conv_h")!.reasons) === JSON.stringify(["member_confused", "slow_turn"]));
}
{
  const w = healthWorld({ emotionCo: true });
  await recordCallHealth(input(), { db: w.db, log: () => {} });
  check("4f the emotion read's frustration at Cue is read from the store", JSON.stringify(w.rows.get("conv_h")!.reasons) === JSON.stringify(["frustrated_with_co"]));
}
{
  const w = healthWorld();
  const logs: string[] = [];
  await recordCallHealth(input(), { db: w.db, log: (l) => logs.push(l) });
  check("4g a clean call is stored unflagged, logged clean", w.rows.get("conv_h")!.flagged === false && w.rows.get("conv_h")!.reasons.length === 0 && logs[0] === "call-health: conv_h clean");
}
{
  const w = healthWorld({ throwOn: /INSERT INTO call_health/ });
  const logs: string[] = [];
  let threw = false;
  const r = await recordCallHealth(input({ turns: [{ role: "user", message: SECRET }] }), { db: w.db, log: (l) => logs.push(l) }).catch(() => { threw = true; });
  check("4h a failing store never throws, and its log has no words", !threw && r === null && logs.every((l) => !l.includes("sister")));
  check("4i no conversation id: nothing", (await recordCallHealth(input({ conversationId: "" }), { db: w.db, log: () => {} })) === null);
}

// 5. Late signals: an unkept promise, a member's report, a background failure; a review reset by a new code; closed after 48h.
check("5a lateReasons maps counts to codes", JSON.stringify(lateReasons({ unkeptPromises: 1, reports: 2, backgroundFailures: 1 })) === JSON.stringify(["member_reported", "promise_unkept", "tool_failed"]) && lateReasons({ unkeptPromises: 0, reports: 0, backgroundFailures: 0 }).length === 0);
{
  const w = healthWorld({ unkept: 1 });
  await recordCallHealth(input(), { db: w.db, log: () => {} });
  const row = w.rows.get("conv_h")!;
  row.flagged = false;
  const logs: string[] = [];
  const r = await refreshLateHealth({ db: w.db, log: (l) => logs.push(l), now: () => new Date(END.getTime() + 3_600_000) });
  check("5b an unkept promise from the call flags it later", r.newlyFlagged === 1 && row.flagged && JSON.stringify(row.reasons) === JSON.stringify(["promise_unkept"]) && row.late_done_at === null);
  check("5c logged with codes only", logs[0] === "call-health: conv_h flagged later: promise_unkept");
  const again = await refreshLateHealth({ db: w.db, log: () => {}, now: () => new Date(END.getTime() + 2 * 3_600_000) });
  check("5d the same code again changes nothing", again.newlyFlagged === 0);
  await refreshLateHealth({ db: w.db, log: () => {}, now: () => new Date(END.getTime() + (CALL_HEALTH.lateHours + 1) * 3_600_000) });
  check("5e past the late window the call is closed for late signals", row.late_done_at !== null);
}
{
  const w = healthWorld({ reports: 1 });
  await recordCallHealth(input({ durationSecs: 10 }), { db: w.db, log: () => {} });
  const row = w.rows.get("conv_h")!;
  row.reviewed_at = new Date(END.getTime() + 600_000);
  await refreshLateHealth({ db: w.db, log: () => {}, now: () => new Date(END.getTime() + 3_600_000) });
  check("5f a member's report after a review: held again for review", row.reviewed_at === null && JSON.stringify(row.reasons) === JSON.stringify(["member_reported", "short_call"]));
  check("5g marking it reviewed", (await markCallReviewed("conv_h", { db: w.db })) && row.reviewed_at !== null);
}
{
  const w = healthWorld({ bg: 1 });
  await recordCallHealth(input(), { db: w.db, log: () => {} });
  await refreshLateHealth({ db: w.db, log: () => {}, now: () => new Date(END.getTime() + 3_600_000) });
  check("5h a background build that failed after the call flags it", JSON.stringify(w.rows.get("conv_h")!.reasons) === JSON.stringify(["tool_failed"]));
}
{
  const w = healthWorld();
  await recordCallHealth(input(), { db: w.db, log: () => {} });
  await refreshLateHealth({ db: w.db, log: () => {}, now: () => new Date(END.getTime() + 3_600_000) });
  const open = w.rows.get("conv_h")!.late_done_at === null && !w.rows.get("conv_h")!.flagged;
  await refreshLateHealth({ db: w.db, log: () => {}, now: () => new Date(END.getTime() + (CALL_HEALTH.lateHours + 1) * 3_600_000) });
  check("5i a clean call stays clean, and is closed after the late window", open && w.rows.get("conv_h")!.late_done_at !== null && !w.rows.get("conv_h")!.flagged);
}
{
  const w = healthWorld({ throwOn: /FROM call_health WHERE late_done_at IS NULL/ });
  check("5j a failing late pass never throws", (await refreshLateHealth({ db: w.db, log: () => {} })).checked === 0);
}
{
  const svc = readFileSync(new URL("../../src/services/callHealth.ts", import.meta.url), "utf8");
  const late = svc.slice(svc.indexOf("export async function refreshLateHealth("), svc.indexOf("export async function markCallReviewed("));
  check("5k the promise query ties the unkept check to this call's own promise tasks", /d\.decision = 'call\.commitment' AND d\.action = 'unkept'/.test(late) && /t\.source = 'promise' AND t\.created_at >= \$2 AND t\.created_at <= \$3/.test(late) && /t\.id::text = d\.proposal->>'taskId'/.test(late));
  check("5l reports count from the call's start to the late window's end", /FROM user_reported_issues WHERE user_id = \$1 AND created_at >= \$2 AND created_at <= \$3`, \[h\.user_id, started, lateUntil\]/.test(late));
}

// 6. The morning review: one flag per unreviewed flagged call, codes only, ranked; reviewed calls drop off.
{
  const w = healthWorld();
  await recordCallHealth(input({ conversationId: "conv_hi", status: "failed", turns: [{ role: "user", message: SECRET, time_in_call_secs: 1 }, { role: "agent", message: "Okay.", time_in_call_secs: 3 }] }), { db: w.db, log: () => {} });
  await recordCallHealth(input({ conversationId: "conv_med", durationSecs: 12 }), { db: w.db, log: () => {} });
  await recordCallHealth(input({ conversationId: "conv_ok" }), { db: w.db, log: () => {} });
  const calls = await flaggedCalls({ until: new Date(END.getTime() + 3_600_000) }, { db: w.db });
  const flags = callHealthFlags(calls);
  check("6a every unreviewed flagged call is a flag; clean ones aren't", flags.length === 2 && flags.every((f) => f.type === "call_flagged"));
  const hi = flags.find((f) => f.snippet.includes("conv_hi"))!;
  const med = flags.find((f) => f.snippet.includes("conv_med"))!;
  check("6b high when a high reason is there, medium otherwise", hi.severity === "high" && med.severity === "medium");
  check("6c codes only in the flag, with how to mark it reviewed", !JSON.stringify(flags).includes("sister") && /call conv_med: short_call/.test(med.snippet) && /scripts\/callReviewed\.ts conv_med/.test(med.cause));
  const digest = renderDigest(flags, { [U]: "Jordan" }, "last 24h").join("\n");
  check("6d it shows in the morning digest under its own label", digest.includes(FLAG_LABELS.call_flagged) && /×2 \(high\)/.test(digest));
  await recordCallHealth(input({ conversationId: "conv_old", durationSecs: 12, startedAt: new Date(START.getTime() - 60 * 86_400_000), endedAt: new Date(END.getTime() - 60 * 86_400_000) }), { db: w.db, log: () => {} });
  check("6d2 a call held 60 days still shows (the digest shows every held call)", (await flaggedCalls({ until: new Date(END.getTime() + 3_600_000) }, { db: w.db })).some((c) => c.conversationId === "conv_old"));
  check("6d3 days narrows only when asked", !(await flaggedCalls({ until: new Date(END.getTime() + 3_600_000), days: 30 }, { db: w.db })).some((c) => c.conversationId === "conv_old"));
  await markCallReviewed("conv_old", { db: w.db });
  await markCallReviewed("conv_hi", { db: w.db });
  check("6e reviewed: off the review", (await flaggedCalls({ until: new Date(END.getTime() + 3_600_000) }, { db: w.db })).map((c) => c.conversationId).join() === "conv_med");
  const dr = readFileSync(new URL("../../src/harness/devReview.ts", import.meta.url), "utf8");
  const win = dr.slice(dr.indexOf("export async function reviewWindow("), dr.indexOf("export type FlagGroup"));
  check("6f the review reads flagged calls for each member, and a failed read never breaks it", /callHealthFlags\(await flaggedCalls\(\{ userId, until \}\)\.catch\(\(\) => \[\] as FlaggedCall\[\]\)\)/.test(win));
  check("6g no email: the health check never sends", !/sendReportEmail|sendEmail|resend|sendblue|textThem/i.test(readFileSync(new URL("../../src/services/callHealth.ts", import.meta.url), "utf8")));
}

// 7. Wiring: the post-call route and the call brain's per-turn record.
{
  const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
  const route = co.slice(co.indexOf('router.post("/el/post-call"'), co.indexOf("// Root-cause guard"));
  const at = route.indexOf("recordCallHealth(");
  check("7a the route records the health check after processing, not awaited, caught", at > route.indexOf("await processEndedCall(") && at < route.indexOf("return res.status(ended.status)") && !/await recordCallHealth/.test(route) && /\}\)\.catch\(\(\) => \{\}\);\n\s*\/\/ Forget by default/.test(route));
  const llm = readFileSync(new URL("../../src/routes/callLlm.ts", import.meta.url), "utf8");
  check("7b the call brain records a slow or failed turn as codes, not awaited", /decision: "call\.turn_health"[^\n]*action: \[slow \? "slow" : null, brainError \? "error" : null\]/.test(llm) && /onToolRound: \(r\) => \{ if \(r\.overBudget\) slow = true; \}/.test(llm) && /if \(t\.timedOut\) slow = true;/.test(llm) && /brainError = true;/.test(llm));
  const mig = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
  check("7c the table: flagged, reasons as codes, reviewed_at, no words column", /CREATE TABLE IF NOT EXISTS call_health \(/.test(mig) && /reasons TEXT\[\] NOT NULL/.test(mig) && /reviewed_at TIMESTAMPTZ/.test(mig) && !/call_health \([^)]*\b(content|quote|message|transcript)\b/.test(mig));
  const script = readFileSync(new URL("../../src/scripts/callReviewed.ts", import.meta.url), "utf8");
  check("7d the review script marks one reviewed or lists them", /markCallReviewed\(id\)/.test(script) && /flaggedCalls\(\)/.test(script));
}

// 8. A call whose processing failed (nothing stored on our side) is flagged not_stored, so its ElevenLabs copy, maybe the only one,
// is held until someone has looked.
{
  const w = healthWorld();
  const until = new Date(END.getTime() + 3_600_000);
  check("8a flagNotStored: a new row, flagged, the one code", (await flagNotStored({ userId: U, conversationId: "conv_lost", startedAt: START, endedAt: END }, { db: w.db, log: () => {} })) && w.rows.get("conv_lost")?.flagged === true && w.rows.get("conv_lost")?.reasons.join() === "not_stored");
  const flags = callHealthFlags(await flaggedCalls({ until }, { db: w.db }));
  check("8b it is high in the morning review", flags.length === 1 && flags[0].severity === "high" && /not_stored/.test(flags[0].snippet) && HIGH_REASONS.has("not_stored"));
  await recordCallHealth(input({ conversationId: "conv_lost" }), { db: w.db, log: () => {} });
  check("8c a health check after it never clears the flag", w.rows.get("conv_lost")?.flagged === true && w.rows.get("conv_lost")!.reasons.includes("not_stored"));
  await recordCallHealth(input({ conversationId: "conv_clean_first" }), { db: w.db, log: () => {} });
  await flagNotStored({ userId: U, conversationId: "conv_clean_first", startedAt: START, endedAt: END }, { db: w.db, log: () => {} });
  await flagNotStored({ userId: U, conversationId: "conv_clean_first", startedAt: START, endedAt: END }, { db: w.db, log: () => {} });
  check("8d a clean row is flagged after, the code added once", w.rows.get("conv_clean_first")?.flagged === true && w.rows.get("conv_clean_first")?.reasons.filter((r) => r === "not_stored").length === 1);
  const bad = healthWorld({ throwOn: /INSERT INTO call_health/ });
  const lines: string[] = [];
  check("8e never throws, and logs codes only", (await flagNotStored({ userId: U, conversationId: "conv_x", startedAt: null, endedAt: null }, { db: bad.db, log: (l) => lines.push(l) })) === false && lines.every((l) => !l.includes("sister")));
  const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
  const route = co.slice(co.indexOf('router.post("/el/post-call"'), co.indexOf("// Root-cause guard"));
  const fail = route.slice(route.indexOf("await processEndedCall("), route.indexOf("throw err;"));
  check("8f the route flags it when processing throws, not awaited, caught, before the throw", /\} catch \(err\) \{[\s\S]*if \(u\[0\]\) flagNotStored\(\{ userId, conversationId, startedAt: callStart, endedAt: callEnd \}\)\.catch\(\(\) => \{\}\);/.test(fail) && !/await flagNotStored/.test(route));
}

console.log(`call health rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
