// The ask lifecycle (services/askLifecycle.ts): open / waiting / closed / expired, closing on evidence, and a closed ask producing nothing.
// Layer 1: fake store, fake judge, zero tokens.   npx tsx evals/asks/lifecycle.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const A = await import("../../src/services/askLifecycle.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const P = await import("../../src/harness/proactive.js");
const PZ = await import("../../src/services/proactivePause.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const d = (iso: string) => new Date(`${iso}T20:00:00Z`);

// ---- states and dating
const base = { id: "i1", user_id: "u1", ask_id: "a1", ask_text: "Seeking the link to Pitch Protocol again", kind: "find", created_at: d("2026-10-02"), last_mentioned_at: null, resolved_at: null, expired_at: null, closed_reason: null, awaiting_response_since: null } as any;
check("an ask nobody has dealt with is open", A.askState(base) === "open" && A.askIsLive(base));
check("once a check-in went out and Co awaits their reply, it is waiting (still live)", A.askState({ ...base, awaiting_response_since: d("2026-10-05") }) === "waiting" && A.askIsLive({ ...base, awaiting_response_since: d("2026-10-05") }));
check("closed at their word, or on evidence, is closed", ["member", "answered", "delivered", "moved_on", "co"].every((r) => A.askState({ ...base, resolved_at: d("2026-10-05"), closed_reason: r }) === "closed") && !A.askIsLive({ ...base, resolved_at: d("2026-10-05"), closed_reason: "answered" }));
check("one whose window passed, or that sat 30 days, is expired (not closed)", A.askState({ ...base, resolved_at: d("2026-10-30"), expired_at: d("2026-10-30"), closed_reason: "expired" }) === "expired");
check("an ask is dated by when they last said it, else when it was first said", +A.askLastConfirmed({ ...base, last_mentioned_at: d("2026-10-05") }) === +d("2026-10-05") && +A.askLastConfirmed(base) === +d("2026-10-02"));

// ---- evidence needs a quote that is really there, on the right side, after the ask
const rowA = { id: "i1", ask_id: "a1", ask_text: "Seeking the link to Pitch Protocol again", created_at: d("2026-10-02") };
const rowB = { id: "i2", ask_id: "a2", ask_text: "Find sponsors for the event", created_at: d("2026-09-25") };
const rowC = { id: "i3", ask_id: "a3", ask_text: "Keep an eye out for founder dinners and let me know when one comes up", created_at: d("2026-09-25") };
const asks = [{ n: "A1", row: rowA }, { n: "A2", row: rowB }, { n: "A3", row: rowC }] as any;
const convo = [
  { at: d("2026-09-20"), side: "co", text: "Here is the Pitch Protocol link from before: https://www.pitchprotocol.vc/ and what it does." },
  { at: d("2026-10-03"), side: "co", text: "Here is the Pitch Protocol link again: https://www.pitchprotocol.vc/ it matches founders with VCs." },
  { at: d("2026-10-05"), side: "member", text: "The juice wasn't worth the squeeze so we are not doing the event anymore." },
  { at: d("2026-10-05"), side: "co", text: "Good call killing it if the squeeze wasn't there." },
] as any;
const ok1 = A.verifyClosures([{ ask: "A1", how: "answered", quote: "Here is the Pitch Protocol link again: https://www.pitchprotocol.vc/" }], asks, convo);
check("answered: the quote is in a Co message sent after the ask, so it closes, with the quote as proof", ok1.length === 1 && ok1[0].how === "answered" && /pitchprotocol/.test(ok1[0].evidence));
check("a quote the model made up closes nothing", A.verifyClosures([{ ask: "A1", how: "answered", quote: "I sent you the full Pitch Protocol deck yesterday afternoon" }], asks, convo).length === 0);
check("a Co message from BEFORE the ask can't answer it", A.verifyClosures([{ ask: "A1", how: "answered", quote: "Here is the Pitch Protocol link from before: https://www.pitchprotocol.vc/ and what it does." }], asks, convo).length === 0);
check("moved_on needs THEIR words: the member saying it's off closes it", A.verifyClosures([{ ask: "A2", how: "moved_on", quote: "we are not doing the event anymore" }], asks, convo).length === 1);
check("Co's words can't stand in for theirs, nor theirs for Co's", A.verifyClosures([{ ask: "A2", how: "moved_on", quote: "Good call killing it if the squeeze wasn't there" }], asks, convo).length === 0 && A.verifyClosures([{ ask: "A2", how: "answered", quote: "we are not doing the event anymore" }], asks, convo).length === 0);
check("an ask that asks Co to keep watching is never closed by one answer", A.verifyClosures([{ ask: "A3", how: "answered", quote: "Here is the Pitch Protocol link again: https://www.pitchprotocol.vc/" }], asks, convo).length === 0);
check("a too-short quote, an unknown ask, or an unknown way closes nothing", A.verifyClosures([{ ask: "A1", how: "answered", quote: "link" }, { ask: "A9", how: "answered", quote: "Here is the Pitch Protocol link again: https://www.pitchprotocol.vc/" }, { ask: "A1", how: "gone", quote: "Here is the Pitch Protocol link again: https://www.pitchprotocol.vc/" }], asks, convo).length === 0);

// ---- the flow, with a fake store
type Rec = { closed: { askId: string; how: string; evidence: string }[]; checked: string[]; judged: number };
function fake(o: { open: any[]; convo?: any[]; delivered?: Record<string, string>; raw?: any[] }): { deps: any; rec: Rec } {
  const rec: Rec = { closed: [], checked: [], judged: 0 };
  let open = [...o.open];
  const deps = {
    openAsks: async () => open,
    conversation: async () => o.convo ?? [],
    delivered: async (_u: string, a: any) => o.delivered?.[a.ask_id] ?? null,
    judge: async () => { rec.judged++; return o.raw ?? []; },
    close: async (_u: string, askId: string, how: string, evidence: string) => { rec.closed.push({ askId, how, evidence }); open = open.filter((x) => x.ask_id !== askId); },
    markChecked: async (_u: string, ids: string[]) => { rec.checked.push(...ids); },
  };
  return { deps, rec };
}
const full = (r: any, extra: any = {}) => ({ user_id: "u1", kind: "find", last_mentioned_at: null, resolved_at: null, expired_at: null, closed_reason: null, awaiting_response_since: null, ...r, ...extra });
{
  const { deps, rec } = fake({ open: [full(rowA), full(rowB)], convo, raw: [{ ask: "A1", how: "answered", quote: "Here is the Pitch Protocol link again: https://www.pitchprotocol.vc/" }, { ask: "A2", how: "moved_on", quote: "we are not doing the event anymore" }] });
  const got = await A.closeAnsweredAsks("u1", deps);
  check("answered and moved-on asks close with their reason and proof, with no confirmation step, and the rest are marked looked-at", got.length === 2 && rec.closed.length === 2 && rec.closed.map((c) => c.how).sort().join() === "answered,moved_on" && rec.closed.every((c) => c.evidence.length > 10) && rec.checked.length === 0);
  const one = fake({ open: [full(rowA), full(rowB)], convo, raw: [{ ask: "A1", how: "answered", quote: "Here is the Pitch Protocol link again: https://www.pitchprotocol.vc/" }] });
  await A.closeAnsweredAsks("u1", one.deps);
  check("the ask that stayed open is marked looked-at (so it is not re-judged every hour), the closed one is not", one.rec.closed.length === 1 && one.rec.checked.join() === "i2");
}
{
  const { deps, rec } = fake({ open: [full(rowA)], delivered: { a1: 'Sent them "Pitch Protocol" for this ask' } });
  const got = await A.proposeClosures("u1", deps);
  check("delivered: when Co sent the thing for this ask it closes on that alone (no model needed), and nothing is written by a proposal", got.length === 1 && got[0].how === "delivered" && rec.judged === 0 && rec.closed.length === 0);
  const ongoing = fake({ open: [full(rowC)], delivered: { a3: "Sent them a dinner" } });
  check("an ask meant to keep going is not closed by one find", (await A.proposeClosures("u1", ongoing.deps)).length === 0);
}
{
  const { deps, rec } = fake({ open: [full(rowA)], convo: [], raw: [{ ask: "A1", how: "answered", quote: "anything at all here" }] });
  await A.proposeClosures("u1", deps);
  check("no talk since the ask, no model call", rec.judged === 0);
  const boom: any = { ...deps, openAsks: async () => [full(rowA)], conversation: async () => convo, judge: async () => { throw new Error("model down"); } };
  const orig = console.error; console.error = () => {};
  const none = await A.closeAnsweredAsks("u1", boom);
  console.error = orig;
  check("a failing model closes nothing and throws nothing into the sweep", none.length === 0);
}

// ---- REGRESSION: an ask Co has already answered cannot produce a check-in
const payload = { askCheckinId: "i1", askId: "a1", askText: "Seeking the link to Pitch Protocol again", checkinCount: 0, hasMatches: false };
const cand: any = { id: "c1", userId: "u1", type: "ask_checkin", payload };
let drafted = 0;
P.setProactiveModelForTests(async () => { drafted++; return "Still looking for the Pitch Protocol link?"; });
{
  const { deps, rec } = fake({ open: [full(rowA)], convo, raw: [{ ask: "A1", how: "answered", quote: "Here is the Pitch Protocol link again: https://www.pitchprotocol.vc/" }] });
  A.setAskDepsForTests(deps);
  drafted = 0;
  const r: any = await proactiveRegistry.ask_checkin.draft(cand, { firstName: "Jordan", userId: "u1" } as any);
  check("REGRESSION: Co already answered the ask, so the check-in is skipped, the ask is closed 'answered' with the proof, and no text is written", !!r.skip && /ask closed: answered/.test(r.skip) && drafted === 0 && rec.closed.length === 1 && rec.closed[0].how === "answered");
}
{
  const { deps, rec } = fake({ open: [], convo, raw: [] });
  A.setAskDepsForTests(deps);
  drafted = 0;
  const r: any = await proactiveRegistry.ask_checkin.draft(cand, { firstName: "Jordan", userId: "u1" } as any);
  check("REGRESSION: an ask that is already closed makes no check-in and costs no model call", !!r.skip && /no longer open/.test(r.skip) && drafted === 0 && rec.judged === 0);
}
{
  const { deps, rec } = fake({ open: [full(rowA)], convo: [{ at: d("2026-10-03"), side: "co", text: "How is the week going?" }], raw: [] });
  A.setAskDepsForTests(deps);
  drafted = 0;
  const r: any = await proactiveRegistry.ask_checkin.draft(cand, { firstName: "Jordan", userId: "u1" } as any);
  check("an ask nobody has answered still gets its check-in", !r.skip && drafted === 1 && rec.closed.length === 0);
}
P.setProactiveModelForTests(null);
A.setAskDepsForTests(null);
{
  const g = await A.checkinGate("u1", "i1", fake({ open: [full(rowA, { resolved_at: d("2026-10-04"), closed_reason: "member" })] }).deps);
  check("the gate refuses a closed ask without asking a model", g.ok === false);
}

// ---- a closed ask produces nothing, anywhere
check("the check-in re-checks the ask at send time, before it writes a word", /checkinGate\(c\.userId, \(c\.payload as AskCheckinPayload\)\.askCheckinId\);\s*if \(!gate\.ok\) return skip\(gate\.why\);\s*const r = await draftAskCheckin/.test(src("harness/proactiveRegistry.ts")));
check("offers re-check too: event offers and network teases both skip a closed ask", /askStillOpen\(p\.askId\)\)\) return skip\("their ask has since closed"\)/.test(src("harness/proactiveRegistry.ts")) && /askIsOpenRef\(c\.userId, c\.payload\.askId\)\)\) return skip\("their ask has since closed"\)/.test(src("harness/proactiveRegistry.ts")));
check("searching: the sweep only reads asks that are not resolved", /WHERE ac\.resolved_at IS NULL AND ac\.kind IN \('find', 'person'\)\s+AND u\.archived_at IS NULL/.test(src("jobs/index.ts")));
check("the 7-day check-in cron only reads asks that are not resolved", /WHERE ac\.resolved_at IS NULL AND u\.sms_opted_out = false/.test(src("jobs/index.ts")));
check("nothing ever reopens a closed ask by itself (their restating makes a new one)", !/resolved_at = NULL|resolved_at=NULL|closed_reason = NULL/.test(["services/askKind.ts", "services/askExpiry.ts", "services/askLifecycle.ts", "services/profileExtraction.ts"].map(src).join("\n")));

// ---- one lifecycle, wired into the loops and every closer keeps its reason
check("every way of closing records why: member, expired, archived, co, and the evidence kinds", /closed_reason = COALESCE\(closed_reason, 'member'\)/.test(src("services/profileExtraction.ts")) && /closed_reason = COALESCE\(closed_reason, 'expired'\)/.test(src("services/askExpiry.ts")) && /'archived'/.test(src("services/accountArchive.ts")) && /'co'\)/.test(src("services/openLoops.ts")) && /closeAsk\(userId, askId, how, evidence\)/.test(src("services/askLifecycle.ts")));
check("the same states reach the loops: an ask whose check-in awaits a reply is a waiting loop, dated by when they last said it", /status: a\.waiting \? "waiting_on_reply" : "open"/.test(src("services/openLoops.ts")) && /signalAt: a\.lastMentionedAt/.test(src("services/openLoops.ts")));
check("ask loops are not also asked 'still on your plate' (the ask lifecycle owns them)", /o\.source <> 'ask'/.test(src("services/openLoops.ts")));
check("the hourly job closes answered asks before anything searches them", /closeAnsweredAsksAll\(\)/.test(src("jobs/index.ts")) && src("jobs/index.ts").indexOf("closeAnsweredAsksAll") < src("jobs/index.ts").indexOf("await classifyOpenAsks()"));
check("the migration adds closed_reason, closed_evidence, answered_checked_at", /ADD COLUMN IF NOT EXISTS closed_reason TEXT, ADD COLUMN IF NOT EXISTS closed_evidence TEXT, ADD COLUMN IF NOT EXISTS answered_checked_at TIMESTAMPTZ/.test(src("db/migrations.ts")));

// ---- per-type pause (ask check-ins held while the rest flows)
check("PROACTIVE_PAUSED_TYPES holds named types only", PZ.pausedTypes({ PROACTIVE_PAUSED_TYPES: "ask_checkin, window_followup" } as any).join() === "ask_checkin,window_followup" && PZ.pausedTypes({} as any).length === 0);
check("the dispatcher leaves paused types waiting (not dropped)", /status = 'pending' AND NOT \(type = ANY\(\$2::text\[\]\)\)`,\s*\[userId, pausedTypes\(\)\]/.test(src("harness/proactive.ts")));

console.log(`ask lifecycle: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
