// Match outcomes (Royce, 2026-11-02: "both accepted" isn't enough; did they meet, was it useful, would they keep talking). One
// record per pair (co_pairs a_evidence / b_evidence), filled only from what each member said (the no-show ask, the night-after
// check-in, a text, a call), feeding pair selection and the host read. Layer 1: an in-memory store, zero tokens, nothing sent.
// Invented people only.
//   npx tsx evals/matching/outcomes.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "ci";
process.env.SENDBLUE_API_API_SECRET ||= "ci";
process.env.ANTHROPIC_API_KEY ||= "ci";
process.env.OPENAI_API_KEY ||= "ci";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- the fake store
const JORDAN = "00000000-0000-4000-8000-0000000000a1";
const ELLIS = "00000000-0000-4000-8000-0000000000b2";
const NOOR = "00000000-0000-4000-8000-0000000000c3";
const SAM = "00000000-0000-4000-8000-0000000000d4";
const users = new Map([[JORDAN, "Jordan"], [ELLIS, "Ellis"], [NOOR, "Noor"], [SAM, "Sam"]]);
type Row = { id: number; event_id: string; a_id: string; b_id: string; asked_a_at: Date | null; asked_b_at: Date | null; intro_sent_at: Date | null; both_yes_at: Date | null; a_evidence: any; b_evidence: any; a_outcome: string | null; b_outcome: string | null; a_outcome_note: string | null; b_outcome_note: string | null; met_at: Date | null; state: string; value_line_a: string | null; value_line_b: string | null; updated_at: Date };
const T0 = new Date("2026-11-01T03:00:00Z");
const pair = (id: number, ev: string, x: string, y: string, o: Partial<Row> = {}): Row => {
  const [a, b] = x < y ? [x, y] : [y, x];
  return { id, event_id: ev, a_id: a, b_id: b, asked_a_at: T0, asked_b_at: T0, intro_sent_at: T0, both_yes_at: T0, a_evidence: {}, b_evidence: {}, a_outcome: null, b_outcome: null, a_outcome_note: null, b_outcome_note: null, met_at: null, state: "intro_sent", value_line_a: null, value_line_b: null, updated_at: new Date(T0.getTime() + id), ...o };
};
let pairs: Row[] = [];
const reset = () => {
  pairs = [
    pair(1, "ev-dinner", JORDAN, ELLIS, { value_line_a: "Ellis backs seed rounds for climate hardware founders, which is the raise you're working on.", value_line_b: "Jordan is building climate hardware and wants seed investors." }),
    pair(2, "ev-dinner", NOOR, SAM),
    pair(3, "ev-other", JORDAN, NOOR, { intro_sent_at: null, both_yes_at: null, state: "asked" }),
  ];
};
reset();
const sqls: string[] = [];
const clone = (x: any) => JSON.parse(JSON.stringify(x ?? {}));
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, p: any[] = []) => {
  sqls.push(sql);
  const byId = (id: any) => pairs.find((r) => r.id === Number(id));
  if (/^SELECT a_id, b_id, a_evidence, b_evidence FROM co_pairs WHERE id = \$1/.test(sql)) {
    const r = byId(p[0]);
    return { rows: r ? [{ a_id: r.a_id, b_id: r.b_id, a_evidence: clone(r.a_evidence), b_evidence: clone(r.b_evidence) }] : [] };
  }
  const ev = sql.match(/^\s*UPDATE co_pairs SET (a|b)_evidence = \$2::jsonb, met_at = CASE WHEN \$4/);
  if (ev) {
    const r = byId(p[0]);
    const side = ev[1] as "a" | "b";
    if (!r || JSON.stringify(r[`${side}_evidence`]) !== JSON.stringify(JSON.parse(p[2]))) return { rows: [] };
    r[`${side}_evidence`] = JSON.parse(p[1]);
    if (p[3]) r.met_at ??= new Date();
    return { rows: [{ id: r.id }] };
  }
  if (/^SELECT a_id, b_id FROM co_pairs WHERE id = \$1/.test(sql)) {
    const r = byId(p[0]);
    return { rows: r ? [{ a_id: r.a_id, b_id: r.b_id }] : [] };
  }
  const oc = sql.match(/^\s*UPDATE co_pairs SET (a|b)_outcome = \$2, \1_outcome_note = \$3/);
  if (oc) {
    const r = byId(p[0])!;
    const side = oc[1] as "a" | "b";
    r[`${side}_outcome`] = p[1];
    r[`${side}_outcome_note`] = p[2];
    if (p[3]) {
      r.met_at ??= new Date();
      r.state = "met";
    }
    return { rows: [] };
  }
  if (/FROM co_pairs p JOIN users u ON u\.id = CASE WHEN p\.a_id = \$1/.test(sql)) {
    const x = p[0];
    const rows = pairs
      .filter((r) => (r.a_id === x && (r.asked_a_at || r.intro_sent_at)) || (r.b_id === x && (r.asked_b_at || r.intro_sent_at)))
      .sort((m, n) => n.updated_at.getTime() - m.updated_at.getTime())
      .map((r) => {
        const other = r.a_id === x ? r.b_id : r.a_id;
        return { id: r.id, event_id: r.event_id, other_id: other, first_name: users.get(other) };
      });
    return { rows };
  }
  if (/^SELECT id FROM co_pairs WHERE a_id = \$1 AND b_id = \$2 AND intro_sent_at IS NOT NULL/.test(sql)) {
    const r = pairs.filter((q) => q.a_id === p[0] && q.b_id === p[1] && q.intro_sent_at).sort((m, n) => n.intro_sent_at!.getTime() - m.intro_sent_at!.getTime())[0];
    return { rows: r ? [{ id: r.id }] : [] };
  }
  if (/SELECT CASE WHEN a_id = \$1 THEN a_evidence ELSE b_evidence END AS ev/.test(sql)) {
    const x = p[0];
    return { rows: pairs.filter((r) => (r.a_id === x || r.b_id === x) && r.intro_sent_at).map((r) => ({ ev: clone(r.a_id === x ? r.a_evidence : r.b_evidence), line: r.a_id === x ? r.value_line_a : r.value_line_b })) };
  }
  if (/^SELECT a_evidence, b_evidence FROM co_pairs WHERE event_id = \$1 AND intro_sent_at IS NOT NULL/.test(sql)) {
    return { rows: pairs.filter((r) => r.event_id === p[0] && r.intro_sent_at).map((r) => ({ a_evidence: clone(r.a_evidence), b_evidence: clone(r.b_evidence) })) };
  }
  return { rows: [] };
};

const RM = await import("../../src/services/roomMatching.js");
const SC = await import("../../src/services/secondContact.js");
const CL = await import("../../src/services/callLearning.js");
const PR = await import("../../src/services/partnerReadout.js");
const MO = await import("../../src/scripts/eventOutcomeReport.js");
const side = (id: number, who: string) => {
  const r = pairs.find((q) => q.id === id)!;
  return r.a_id === who ? r.a_evidence : r.b_evidence;
};
const other = (id: number, who: string) => {
  const r = pairs.find((q) => q.id === id)!;
  return r.a_id === who ? r.b_evidence : r.a_evidence;
};

// ---------------------------------------------------------------- 1. the flow, end to end
{
  // The no-show ask: Noor said she didn't make it. Her side of her pair there: didn't meet, inferred. Sam's side: untouched.
  const n = await RM.notePairsNoShow("ev-dinner", NOOR);
  check("no-show 'said no': her side is met=no, inferred, from the no-show ask", n === 1 && side(2, NOOR).met?.value === "no" && side(2, NOOR).met?.how === "inferred" && side(2, NOOR).met?.source === "noshow_ask", side(2, NOOR));
  check("no-show: the other side stays unknown (her answer is never written on his side)", !Object.keys(other(2, NOOR)).length);
  check("no-show: only pairs at that event", !Object.keys(side(3, NOOR)).length);

  // The night-after check-in: Jordan names Ellis in a warm answer. Met, inferred (the read and the name), on Jordan's side only.
  const named = await RM.notePairsFromCheckin(JORDAN, "ev-dinner", "Great night. Loved meeting Ellis, we talked seed rounds for an hour.", true);
  check("check-in names Ellis: met=yes inferred from the check-in", named.length === 1 && named[0].firstName === "Ellis" && side(1, JORDAN).met?.value === "yes" && side(1, JORDAN).met?.how === "inferred" && side(1, JORDAN).met?.source === "checkin", side(1, JORDAN));
  check("check-in: Ellis's side untouched", !Object.keys(other(1, JORDAN)).length);
  check("an inferred met doesn't set met_at (only what someone said does)", pairs[0].met_at === null);

  // Then in a text, Jordan says it was great (noteRoomMeeting): stated, replaces the inference; useful is his own answer.
  await RM.notePairMet(JORDAN, 1, "met_good", "great talk about seed rounds", "text");
  check("text: met=yes stated replaces the inferred one", side(1, JORDAN).met?.how === "stated" && side(1, JORDAN).met?.source === "text", side(1, JORDAN));
  check("text: useful=yes stated, his own", side(1, JORDAN).useful?.value === "yes" && side(1, JORDAN).useful?.how === "stated");
  check("text: the older columns stay in step (a_outcome / met_at / state)", pairs[0].met_at !== null && pairs[0].state === "met" && (pairs[0].a_id === JORDAN ? pairs[0].a_outcome : pairs[0].b_outcome) === "met_good");

  // An inference never replaces what he said.
  const before = JSON.stringify(side(1, JORDAN));
  await RM.notePairEvidence(JORDAN, 1, "met", "no", "noshow_ask", "inferred");
  check("an inference never replaces what they said", JSON.stringify(side(1, JORDAN)) === before);
  // A newer word of his own replaces the older one.
  await RM.notePairMet(JORDAN, 1, "met_fine", null, "text");
  check("their newer word replaces their older one", side(1, JORDAN).useful?.value === "somewhat");

  // Kept talking: Ellis says (text, noteMetAgain) they've talked again since. His side only.
  await SC.notePairKeptTalking(ELLIS, JORDAN, "talked_again", "text");
  check("kept talking: Ellis's side, stated, from a text", side(1, ELLIS).kept_talking?.value === "yes" && side(1, ELLIS).kept_talking?.how === "stated" && side(1, ELLIS).met?.value === "yes", side(1, ELLIS));
  check("kept talking: Jordan's side has no kept_talking (Ellis's answer is Ellis's)", !side(1, JORDAN).kept_talking);
  check("kept talking only on a pair whose intro went", (await SC.notePairKeptTalking(JORDAN, NOOR, "talked_again", "text")) === false && !Object.keys(side(3, JORDAN)).length);
  check("not yet is kept as not_yet, never a yes", SC.keptTalkingValue("not_yet") === "not_yet" && SC.keptTalkingValue("not_going_to") === "no" && SC.keptTalkingValue("met_again") === "yes");
  check("recordSecondContact writes the pair record too", /await notePairKeptTalking\(userId, intro\.otherId, outcome, source, now\)/.test(src("src/services/secondContact.ts")));

  // The measurement: per event.
  const ev = MO.summarizeEvent(
    pairs.filter((r) => r.event_id === "ev-dinner").map((r) => ({ offered: true, both_yes: !!r.both_yes_at, intro_sent: !!r.intro_sent_at, origin: "co", a: r.a_evidence, b: r.b_evidence, a_outcome: r.a_outcome, b_outcome: r.b_outcome, met_at: !!r.met_at })),
    RM.pairOutcome,
  );
  check("measurement: 2 offered, 2 both yes, 2 sent; met yes 1 (said), no 1 (inferred no-show)", ev.offered === 2 && ev.bothYes === 2 && ev.introSent === 2 && ev.met.yes === 1 && ev.met.yesStated === 1 && ev.met.no === 1 && ev.met.unknown === 0, ev);
  check("measurement: useful counted per side (Jordan somewhat, the rest unknown)", ev.useful.somewhat === 1 && ev.useful.unknown === 3 && ev.useful.yes === 0, ev.useful);
  check("measurement: kept talking yes 1, unknown 1", ev.keptTalking.yes === 1 && ev.keptTalking.unknown === 1 && ev.keptTalking.no === 0, ev.keptTalking);
  check("measurement output carries counts only (no names, no member ids)", !/Jordan|Ellis|Noor|Sam|0000-4000/.test(MO.formatSummary("ev-dinner", "Founders Supper", ev)));
  check("measurement reads one read-only session", /SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY/.test(src("src/scripts/eventOutcomeReport.ts")) && !/\b(INSERT|UPDATE|DELETE)\b/.test(MO.MATCH_OUTCOMES_SQL));
}

// ---------------------------------------------------------------- 2. unknown stays unknown
{
  check("nothing said: met, useful, kept talking all unknown", JSON.stringify(RM.pairOutcome({}, {})) === JSON.stringify({ met: "unknown", usefulA: "unknown", usefulB: "unknown", keptTalking: "unknown" }));
  check("useful is never inferred", RM.mergeEvidence({}, "useful", { value: "yes", source: "checkin", at: "x", how: "inferred" }) === null);
  check("kept talking is never inferred (Cue can't see their messages)", RM.mergeEvidence({}, "kept_talking", { value: "no", source: "text", at: "x", how: "inferred" }) === null);
  check("a value outside the set is refused", RM.mergeEvidence({}, "met", { value: "maybe", source: "text", at: "x", how: "stated" }) === null);
  const ns = src("src/services/eventNoShow.ts");
  check("no-show: only a 'said no' writes (no answer or unclear writes nothing)", /if \(v === "said_no"\) await RM\.notePairsNoShow\(eventId, userId\)/.test(ns) && (ns.match(/notePairsNoShow/g) ?? []).length === 1);
  // A check-in that names him with a "didn't": nothing. A critical answer: nothing written (the name is still returned for Cue).
  reset();
  check("check-in 'didn't get to meet Ellis': not counted as met", (await RM.notePairsFromCheckin(JORDAN, "ev-dinner", "I didn't get to meet Ellis sadly.", true)).length === 0 && !Object.keys(side(1, JORDAN)).length);
  const crit = await RM.notePairsFromCheckin(JORDAN, "ev-dinner", "Ellis was there, the night was loud.", false);
  check("check-in read not warm: nothing written", crit.length === 1 && !Object.keys(side(1, JORDAN)).length);
  check("two people with one first name: nobody", RM.namedInCheckin("met Sam!", [{ pairId: 1, otherId: "x", firstName: "Sam" }, { pairId: 2, otherId: "y", firstName: "Sam" }]).length === 0);
  check("measurement: a sent pair with nothing said is unknown, not no", MO.summarizeEvent([{ offered: true, both_yes: true, intro_sent: true, origin: "co", a: {}, b: {}, a_outcome: null, b_outcome: null, met_at: false }], RM.pairOutcome).met.unknown === 1);
}

// ---------------------------------------------------------------- 3. one side's answer never reaches the other or the host
{
  reset();
  // Ellis says it wasn't useful; Jordan says it was.
  await RM.notePairMet(ELLIS, 1, "met_not_a_fit", "not what I need right now", "text");
  await RM.notePairMet(JORDAN, 1, "met_good", null, "text");
  const js = await RM.ownOutcomeSignals(JORDAN);
  const es = await RM.ownOutcomeSignals(ELLIS);
  check("Jordan's signals are his own answer (useful), never Ellis's 'not a fit'", js.length === 1 && js[0].kind === "useful", js);
  check("Ellis's signals are his own answer", es.length === 1 && es[0].kind === "not_useful", es);
  check("the signal read selects only the reader's own side", /CASE WHEN a_id = \$1 THEN a_evidence ELSE b_evidence END AS ev, CASE WHEN a_id = \$1 THEN value_line_a ELSE value_line_b END AS line/.test(src("src/services/roomMatching.ts")));
  // The value judge's past outcomes and the room meeting tool were already own-side; still true.
  check("value judge reads only their own outcome", /CASE WHEN p\.a_id = \$1 THEN p\.a_outcome ELSE p\.b_outcome END AS outcome/.test(src("src/services/roomMatching.ts")));
  // The check-in instruction names only someone Cue told THEM about, and says nothing of the other side.
  const sb = src("src/routes/sendblue.ts");
  check("check-in instruction: only names from their own told-about list, never the other side's answer", /notePairsFromCheckin\(user\.id, pendingCheckin\.event_api_id, resolvedContent, outcome === "named_positive"\)/.test(sb) && /never say anything about the other person's side/.test(sb));
  // Host: room-level only.
  const stats: any = { eventName: "Founders Supper", registered: 12, arrived: 10, walkins: 0, briefs: 0, nudged: 4, interested: 4, intros: 4, debriefReplies: 0, metSomeone: 0, conversationsTold: 0, followThroughMembers: 0, themes: {}, askCount: 0 };
  const g = await PR.gatherStats("ev-dinner", "Founders Supper", async () => "Something else", async () => [JORDAN, ELLIS, NOOR, SAM].map((user_id) => ({ user_id })));
  check("host read: pair outcomes are counts", g.pairOutcomes?.introduced === 2 && g.pairOutcomes?.useful === 1 && g.pairOutcomes?.usefulKnown === 2, g.pairOutcomes);
  const text = PR.renderText({ ...stats, pairOutcomes: g.pairOutcomes });
  check("host read: no names, no notes, no pair", !/Jordan|Ellis|Noor|Sam|not what I need|0000-4000/.test(text) && !/Jordan|Ellis|not what I need/.test(JSON.stringify(g.pairOutcomes)));
}

// ---------------------------------------------------------------- 4. host aggregates: minimum counts, no extremes, coarse bands
{
  const stated = (v: string) => ({ met: { value: v, how: "stated", source: "text", at: "x" } });
  const P = (n: number, met: number) => Array.from({ length: n }, (_, i) => ({ a: stated(i < met ? "yes" : "no"), b: {} }));
  check("4 introduced pairs: no outcome lines at all", PR.pairOutcomeLines(PR.pairRates(P(4, 2), RM.pairOutcome)).length === 0);
  check("5 answers, all met: no line (it would give away every answer)", PR.pairOutcomeLines(PR.pairRates(P(5, 5), RM.pairOutcome)).length === 0);
  check("5 answers, none met: no line", PR.pairOutcomeLines(PR.pairRates(P(5, 0), RM.pairOutcome)).length === 0);
  check("5 answers, 4 met: no line (only 1 said no)", PR.pairOutcomeLines(PR.pairRates(P(5, 4), RM.pairOutcome)).length === 0);
  const six = PR.pairOutcomeLines(PR.pairRates(P(6, 3), RM.pairOutcome));
  check("6 answers, 3 met: a coarse band (about half), no number", six.length === 1 && /about half met/.test(six[0]) && !/\d/.test(six[0]), six);
  check("bands: fewer than half / about half / more than half", PR.rateLine(3, 10) === "fewer than half" && PR.rateLine(5, 10) === "about half" && PR.rateLine(7, 10) === "more than half");
  check("rateLine: under the minimum or near an extreme says nothing", PR.rateLine(2, 4) === null && PR.rateLine(2, 10) === null && PR.rateLine(8, 10) === null);
  const inferred = Array.from({ length: 8 }, (_, i) => ({ a: { met: { value: i < 4 ? "yes" : "no", how: "inferred", source: "checkin", at: "x" } }, b: {} }));
  check("inferred met (a check-in read, a no-show) never counts in the host's met rate", PR.pairRates(inferred, RM.pairOutcome).metKnown === 0);
  const unknown = PR.pairRates(Array.from({ length: 8 }, () => ({ a: {}, b: {} })), RM.pairOutcome);
  check("unknowns are never counted as no: 8 pairs, nothing said, no rate line", PR.pairOutcomeLines(unknown).length === 0 && unknown.metKnown === 0);
  check("the minimums are part of READOUT", PR.READOUT.minPairsForRates === 5 && PR.READOUT.smallCell === 3);
}

// ---------------------------------------------------------------- 5. outcomes change selection, by the ask served, never past the bar
{
  const bar = 60;
  const asks = ["seed investors for climate hardware", "a founding designer for my consumer app"];
  const at = new Date("2026-11-01T00:00:00Z").toISOString();
  const now = new Date("2026-11-02T00:00:00Z");
  const line = "Ellis backs seed rounds for climate hardware founders, which is the raise you're working on.";
  const notUseful = [{ line, kind: "not_useful" as const, at }];
  const two = [...notUseful, { ...notUseful[0] }];
  const useful = [{ line, kind: "useful" as const, at }, { line, kind: "useful" as const, at }];
  const same = "an angel writing seed checks into climate hardware";
  const unrelated = "a product designer for consumer apps";
  const generic = "a founder building and raising for a fintech startup";
  const adj = (score: number, text: string, sig: any[]) => RM.outcomeAdjustedScore(score, text, sig, bar, asks, now);
  check("the theme is the member's own ask the pairing served", RM.themeOf(same, asks) === 0 && RM.themeOf(unrelated, asks) === 1 && RM.themeOf(line, asks) === 0);
  check("generic words (founder, building, raising) tie to no ask", RM.themeOf(generic, asks) === null);
  check("generic words count as generic after stemming too (raising, companies, business)", RM.themeOf("raising companies", ["raising for companies"]) === null && RM.themeOf("business raising", ["raising money for my business"]) === null);
  check("a generic-word candidate isn't moved by a 'not useful' about climate investors", adj(80, generic, two).moved === 0);
  check("same ask, two 'not useful's: moves down", adj(80, same, two).score < 80);
  check("one signal alone counts half", adj(80, same, notUseful).moved === Math.round(RM.OUTCOME_ADJUST.notUseful * RM.OUTCOME_ADJUST.single * Math.pow(0.5, 1 / RM.OUTCOME_ADJUST.halfLifeDays)));
  check("an old signal fades (a year on, much less)", Math.abs(RM.outcomeAdjustedScore(80, same, two, bar, asks, new Date("2027-11-01T00:00:00Z")).moved) < Math.abs(adj(80, same, two).moved));
  check("...and can fall below the bar (no longer proposed)", adj(70, same, [...two, ...two]).score < bar);
  check("a kind that was useful moves up", adj(70, same, useful).score > 70);
  check("never past the bar: a below-bar candidate is never lifted, whatever worked before", adj(55, same, useful).score === 55 && adj(59, same, [...useful, ...useful, ...useful]).score === 59);
  check("a zero (pruned or no fit) stays zero", adj(0, same, useful).score === 0);
  check("a different ask doesn't move", adj(80, unrelated, two).moved === 0);
  check("no asks or no text: no move", RM.outcomeAdjustedScore(80, same, two, bar, [], now).moved === 0 && adj(80, "", two).moved === 0);
  check("bounded: many 'not useful's cap the drop", adj(90, same, Array(10).fill(notUseful[0])).score === 90 + RM.OUTCOME_ADJUST.maxDown);
  check("signals carry a reason's shape, a kind and a time, never who", Object.keys(notUseful[0]).sort().join(",") === "at,kind,line");
  check("only stated evidence makes a signal; an inferred no-show doesn't", RM.signalOf({ met: { value: "no", how: "inferred", source: "noshow_ask", at: "x" } }) === null && RM.signalOf({ met: { value: "no", how: "stated", source: "text", at: "x" } }) === "not_met");
  const es = src("src/services/eventScoring.ts");
  check("the room scorer ranks on the adjusted score, with the bar and their frame's asks", /RMo\.outcomeAdjustedScore\(s\.score, `\$\{s\.reason\} \$\{s\.shareReason\}`, signals, MATCH_NUDGE_MIN_SCORE, frame\.asks\.map/.test(es) && /score: adj\.score,/.test(es) && /RMo\.ownOutcomeSignals\(person\.user_id\)/.test(es));
}

// ---------------------------------------------------------------- 5b. visible knowledge: their side shown, removable, really removed
{
  const W = await import("../../src/services/whatCoKnows.js");
  const raw: any = { profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], pairOutcomes: [{ id: "1", side: "a", eventName: "Founders Supper", evidence: { met: { value: "yes", how: "stated" }, useful: { value: "somewhat", how: "stated" }, kept_talking: { value: "yes", how: "stated" } }, note: "great talk about seed rounds" }, { id: "2", side: "b", eventName: null, evidence: { met: { value: "yes", how: "inferred" } }, note: null }] };
  const items = W.knownItems(raw).filter((i: any) => i.source === "pair");
  check("what Cue knows shows their side of each intro's outcome, their note as their words", items.length === 2 && /how an introduction I made at Founders Supper went for you: you met, it was fine, you've stayed in touch/.test(items[0].text) && items[0].theirWords === "great talk about seed rounds", items);
  check("an inference says it's Cue's read", /you met \(my read\)/.test(items[1].text));
  check("it names nobody", !items.some((i: any) => /Ellis|Jordan|Noor|Sam/.test(i.text)));
  check("it can be removed (never 'corrected' into something they didn't say)", items.every((i: any) => i.canCorrect === false) && W.fieldFor("pair:1:a") === "how an introduction went for them");
  // Removal at the source: their side cleared, note gone, met_at kept only on the other's stated yes, the kept-talking fact retired.
  const sqls: { sql: string; p: any[] }[] = [];
  const db = { query: async (sql: string, p: any[] = []) => { sqls.push({ sql, p }); return /UPDATE co_pairs/.test(sql) ? { rows: [{ other: ELLIS }], rowCount: 1 } : { rows: [], rowCount: 1 }; } };
  const r: any = await W.applyOne(db as any, JORDAN, raw, items[0], "remove", null, "forget how that intro went");
  const upd = sqls.find((x) => /UPDATE co_pairs/.test(x.sql))?.sql ?? "";
  check("removing clears their side at the source (evidence, outcome, note), only on their own side", r.source === "pair" && r.now === null && /SET a_evidence = '\{\}'::jsonb, a_outcome = NULL, a_outcome_note = NULL/.test(upd) && /WHERE id = \$2 AND a_id = \$1/.test(upd) && !/b_evidence = '\{\}'/.test(upd));
  check("met_at stays only when the other person said they met", /met_at = CASE WHEN b_evidence->'met'->>'value' = 'yes' AND b_evidence->'met'->>'how' = 'stated' THEN met_at ELSE NULL END/.test(upd));
  check("the kept-talking fact it came from is retired too", sqls.some((x) => /UPDATE co_facts SET retired_at = NOW\(\) WHERE owner_user_id = \$1 AND relation = 'second_contact'/.test(x.sql) && x.p[1] === ELLIS));
  // And nothing reads it again: an empty side makes no signal and no line.
  check("after removal: no signal, no line", RM.signalOf({}) === null && W.pairOutcomeLine({}) === "");
  check("the view reads their side only", /CASE WHEN p\.a_id = \$1 THEN p\.a_evidence ELSE p\.b_evidence END AS ev/.test(src("src/services/whatCoKnows.ts")));
}

// ---------------------------------------------------------------- 6. the call path captures an outcome mention (GPT-Live post-call)
{
  reset();
  const transcript = [
    "assistant: How did the dinner go?",
    "user: Honestly it was great. I met Ellis and it was really useful, we've already talked again since.",
    "assistant: Did you get to meet Noor too?",
    "user: No, I never found her.",
  ].join("\n");
  const names = ["Ellis", "Noor"];
  const raw = {
    introductions: [
      { name: "Ellis", met: "yes", useful: "yes", kept_talking: "yes", quote: "I met Ellis and it was really useful" },
      { name: "Noor", met: "no", useful: null, kept_talking: null, quote: "No, I never found her" },
      { name: "Sam", met: "yes", useful: "yes", kept_talking: null, quote: "I met Ellis and it was really useful" },
      { name: "Ellis", met: "yes", useful: "no", kept_talking: null, quote: "Did you get to meet Noor too" },
    ],
  };
  const said = CL.callIntroOutcomes(raw, transcript, names);
  check("the call read keeps Ellis and Noor (on the list, quoted from their lines)", said.length === 2 && said[0].name === "Ellis" && said[0].useful === "yes" && said[1].name === "Noor" && said[1].met === "no", said);
  check("someone not on the list is dropped", !said.some((s) => s.name === "Sam"));
  check("a quote from Cue's line is dropped", CL.callIntroOutcomes({ introductions: [raw.introductions[3]] }, transcript, names).length === 0);
  check("a bad value is unknown, not a guess", CL.callIntroOutcomes({ introductions: [{ name: "Ellis", met: "probably", useful: "great", kept_talking: "yes", quote: "we've already talked again since" }] }, transcript, names)[0]?.met === null);
  // The writes: Ellis is in a pair Cue told Jordan about at the dinner (and Noor isn't a pair of Jordan's with a sent intro there).
  const known = { names, pairs: [{ pairId: 1, otherId: ELLIS, firstName: "Ellis", eventId: "ev-dinner" }], intros: [] };
  await CL.saveCallIntroOutcomes(JORDAN, said, known as any, () => "I met Ellis and it was really useful");
  check("call: met and useful on Jordan's side, from the call, stated", side(1, JORDAN).met?.source === "call" && side(1, JORDAN).useful?.value === "yes" && side(1, JORDAN).useful?.how === "stated", side(1, JORDAN));
  check("call: kept talking on Jordan's side, from the call", side(1, JORDAN).kept_talking?.value === "yes" && side(1, JORDAN).kept_talking?.source === "call");
  check("call: Ellis's side untouched", !Object.keys(other(1, JORDAN)).length);
  {
    const withIntro = CL.callLearningPrompt({ transcript: "x", today: "2026-11-02", onFile: null, openAsks: [], introduced: ["Ellis"] });
    const plain = CL.callLearningPrompt({ transcript: "x", today: "2026-11-02", onFile: null, openAsks: [] });
    check("the call read keeps the preferences item (7) and its JSON; introductions are 8, after it", /\n7\. /.test(withIntro) && withIntro.indexOf("\n7. ") < withIntro.indexOf("8. introductions") && /"introductions": \[/.test(withIntro) && withIntro.indexOf('"introductions"') > withIntro.indexOf("lessons") && !/"introductions"/.test(plain));
  }
  check("the prompt has section 8 only for someone Cue introduced", /8\. introductions/.test(CL.callLearningPrompt({ transcript: "x", today: "2026-11-02", onFile: null, openAsks: [], introduced: ["Ellis"] })) && !/introductions/.test(CL.callLearningPrompt({ transcript: "x", today: "2026-11-02", onFile: null, openAsks: [] })));
  const cl = src("src/services/callLearning.ts");
  check("learnFromCall reads the names and saves what was said", /introduced: introduced\.names,/.test(cl) && /await saveCallIntroOutcomes\(input\.userId, introOutcomes, introduced/.test(cl));
  const co = src("src/routes/co.ts");
  check("GPT-Live's post-call goes through processEndedCall, which runs learnFromCall", /export async function runGptLivePostCall[\s\S]*?ended = await processEndedCall\(/.test(co) && /await learnFromCall\(\{ userId: user_id, transcript: cleanTranscript[,} ]/.test(co));
  check("on a call, noteMetAgain (a live call tool) records kept talking with source call", /recordSecondContact\(ctx\.userId, pick, said\.outcome, note \?\? null, new Date\(\), said\.metOn, ctx\.onCall \? "call" : "text", said\.plannedOn\)/.test(src("src/agent/conversationTools.ts")) && /noteMetAgain: SAVE/.test(src("src/services/capabilities.ts")));
  {
    const C = await import("../../src/services/capabilities.js");
    check("noteRoomMeeting runs on a call too (same record, source call)", C.callRunFor("noteRoomMeeting")?.run === "now" && C.callRunFor("noteMetAgain")?.run === "now");
  }
  check("text parity: noteRoomMeeting writes the same record (source text)", /await RM\.notePairMet\(ctx\.userId, told\[0\]\.pairId, outcome, note \?\? null, ctx\.onCall \? "call" : "text"\)/.test(src("src/agent/conversationTools.ts")) && /source: EvidenceSource = "text"/.test(src("src/services/roomMatching.ts")));
}

console.log(`match outcomes: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
