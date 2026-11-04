// Network intros get the same per-pair outcome record as event intros (Royce, 2026-11-03): one co_pairs row ("network" event), written
// only once the intro went to both (after both said yes), each side's own answer only, feeding their own outcome signals the way an
// event pair does, and left out of the room count, the host read and the event report. "Met, not a fit" after a network intro lands
// there by text (noteRoomMeeting) and by call (the after-call read). Layer 1: a fake store, zero tokens, nothing sent. Invented members.
//   npx tsx evals/intros/networkOutcomes.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const JORDAN = "00000000-0000-4000-8000-0000000000a1";
const ELLIS = "00000000-0000-4000-8000-0000000000b2";
const names: Record<string, string> = { [JORDAN]: "Jordan", [ELLIS]: "Ellis" };
const REASON = "Ellis backs seed rounds for climate hardware founders, and Jordan is raising one for a battery startup.";

// ---------------------------------------------------------------- the fake store: co_pairs
type Row = Record<string, any>;
let pairs: Row[] = [];
let nextId = 1;
const clone = (x: any) => JSON.parse(JSON.stringify(x ?? {}));
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, p: any[] = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  const byId = (id: any) => pairs.find((r) => r.id === Number(id));
  if (/^INSERT INTO co_pairs \(event_id, a_id, b_id, origin, state, a_answer, a_answered_at, b_answer, b_answered_at, both_yes_at, intro_sent_at, value_line_a, value_line_b\) VALUES/.test(q)) {
    const had = pairs.find((r) => r.event_id === p[0] && r.a_id === p[1] && r.b_id === p[2]);
    if (had) {
      had.intro_sent_at ??= p[3];
      had.state = had.state === "met" ? "met" : "intro_sent";
    } else pairs.push({ id: nextId++, event_id: p[0], a_id: p[1], b_id: p[2], origin: "co", state: "intro_sent", a_answer: "yes", b_answer: "yes", both_yes_at: p[3], intro_sent_at: p[3], value_line_a: p[4], value_line_b: p[4], a_evidence: {}, b_evidence: {}, a_outcome: null, b_outcome: null, updated_at: new Date(Date.now() + nextId) });
    return { rows: [] };
  }
  if (/^SELECT p\.id, p\.event_id, CASE WHEN p\.a_id = \$1 THEN p\.b_id ELSE p\.a_id END AS other_id, u\.first_name FROM co_pairs p JOIN users u/.test(q)) {
    const x = p[0];
    return { rows: pairs.filter((r) => (r.a_id === x && (r.asked_a_at || r.intro_sent_at)) || (r.b_id === x && (r.asked_b_at || r.intro_sent_at))).map((r) => { const o = r.a_id === x ? r.b_id : r.a_id; return { id: r.id, event_id: r.event_id, other_id: o, first_name: names[o] }; }) };
  }
  if (/^SELECT a_id, b_id, a_evidence, b_evidence FROM co_pairs WHERE id = \$1/.test(q)) { const r = byId(p[0]); return { rows: r ? [{ a_id: r.a_id, b_id: r.b_id, a_evidence: clone(r.a_evidence), b_evidence: clone(r.b_evidence) }] : [] }; }
  if (/^SELECT a_id, b_id FROM co_pairs WHERE id = \$1/.test(q)) { const r = byId(p[0]); return { rows: r ? [{ a_id: r.a_id, b_id: r.b_id }] : [] }; }
  const ev = q.match(/^UPDATE co_pairs SET (a|b)_evidence = \$2::jsonb/);
  if (ev) {
    const r = byId(p[0]);
    if (!r || JSON.stringify(r[`${ev[1]}_evidence`]) !== JSON.stringify(JSON.parse(p[2]))) return { rows: [] };
    r[`${ev[1]}_evidence`] = JSON.parse(p[1]);
    return { rows: [{ id: r.id }] };
  }
  const oc = q.match(/^UPDATE co_pairs SET (a|b)_outcome = \$2, \1_outcome_note = \$3/);
  if (oc) { const r = byId(p[0])!; r[`${oc[1]}_outcome`] = p[1]; r[`${oc[1]}_outcome_note`] = p[2]; if (p[3]) r.state = "met"; return { rows: [] }; }
  if (/^SELECT CASE WHEN a_id = \$1 THEN a_evidence ELSE b_evidence END AS ev, CASE WHEN a_id = \$1 THEN value_line_a ELSE value_line_b END AS line FROM co_pairs/.test(q)) {
    const x = p[0];
    return { rows: pairs.filter((r) => (r.a_id === x || r.b_id === x) && r.intro_sent_at).map((r) => ({ ev: clone(r.a_id === x ? r.a_evidence : r.b_evidence), line: r.a_id === x ? r.value_line_a : r.value_line_b })) };
  }
  if (/^SELECT id FROM co_pairs WHERE a_id = \$1 AND b_id = \$2 AND intro_sent_at IS NOT NULL/.test(q)) return { rows: pairs.filter((r) => r.a_id === p[0] && r.b_id === p[1] && r.intro_sent_at).map((r) => ({ id: r.id })) };
  if (/INSERT INTO harness_decisions/.test(q)) return { rows: [{ id: "1", created_at: new Date() }] };
  return { rows: [] };
};
const RM = await import("../../src/services/roomMatching.js");
const CL = await import("../../src/services/callLearning.js");
const [A, Bid] = JORDAN < ELLIS ? [JORDAN, ELLIS] : [ELLIS, JORDAN];
const sideOf = (x: string) => (pairs[0].a_id === x ? "a" : "b");

// ---------------------------------------------------------------- 1. the record, once the intro went
check("the network intros share one event id, apart from every room", RM.NETWORK_PAIR_EVENT === "network");
check("written: intro sent, both yes, origin co, each side's line the reason both of them were sent", (await RM.noteNetworkPairIntroduced(ELLIS, JORDAN, REASON)) && pairs.length === 1 && pairs[0].event_id === "network" && pairs[0].a_id === A && pairs[0].b_id === Bid && pairs[0].state === "intro_sent" && pairs[0].a_answer === "yes" && pairs[0].b_answer === "yes" && pairs[0].value_line_a === REASON && pairs[0].value_line_b === REASON, pairs);
await RM.noteNetworkPairIntroduced(JORDAN, ELLIS, REASON);
check("written again (a retake): still one row, never a second pair", pairs.length === 1);
check("nobody, or someone with themself: nothing", !(await RM.noteNetworkPairIntroduced(JORDAN, JORDAN, REASON)) && !(await RM.noteNetworkPairIntroduced("", ELLIS, REASON)));
const nn = src("services/networkIntroNudge.ts");
const sendFn = nn.slice(nn.indexOf("async function sendNetworkIntroEmail"), nn.indexOf("async function scheduleIntroFollowUps"));
check("double opt-in: written only in the send, after both yeses are checked and the intro went (never on a held or failed send)", /checkBothYes\(aYes, bYes\)/.test(sendFn) && sendFn.indexOf("noteNetworkPairIntroduced") > sendFn.indexOf("recordConnection") && sendFn.indexOf("noteNetworkPairIntroduced") < sendFn.lastIndexOf('return "sent"') && (nn.match(/noteNetworkPairIntroduced/g) ?? []).length === 1);
{
  const mig = src("db/migrations.ts").replace(/\s+/g, " ");
  const block = mig.slice(mig.indexOf("SELECT 'network', n.person_a_id"), mig.indexOf("co_pairs network intro backfill failed"));
  check("intros made before this get it too: an idempotent backfill of only the ones whose intro went", block.length > 0 && /n\.status = 'introduced'/.test(block) && /\(n\.email_sent_at IS NOT NULL OR n\.email_claimed_at IS NULL\)/.test(block) && /ON CONFLICT \(event_id, a_id, b_id\) DO NOTHING/.test(block));
}

// ---------------------------------------------------------------- 2. "met, not a fit": text and call, their side only
const told = await RM.pairsToldAbout(JORDAN);
check("Jordan's people now include Ellis, from the network intro", told.length === 1 && told[0].firstName === "Ellis" && told[0].eventId === "network", told);
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const tools = createConversationTools({
  userId: JORDAN, phoneNumber: "+10000000000", resolvedContent: "Met Ellis for coffee, nice guy but honestly not a fit", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
  sendCoReply: async () => true, facts: { add: () => {}, text: () => "" },
} as any).tools as any;
const res = await quiet(() => tools.noteRoomMeeting.execute({ person: "Ellis", outcome: "met_not_a_fit", note: "nice but not a fit" }, { toolCallId: "t1", messages: [] }));
const mine = pairs[0][`${sideOf(JORDAN)}_evidence`];
const theirs = pairs[0][`${sideOf(ELLIS)}_evidence`];
check("text: the tool finds the network intro and records met, not useful, on Jordan's side, stated", res?.ok === true && mine.met?.value === "yes" && mine.useful?.value === "no" && mine.useful?.how === "stated" && mine.useful?.source === "text", { res, mine });
check("…and nothing on Ellis's side", JSON.stringify(theirs) === "{}");
const sig = await RM.ownOutcomeSignals(JORDAN);
check("it feeds Jordan's own outcome signals with the intro's line, as an event pair's does", sig.length === 1 && sig[0].kind === "not_useful" && sig[0].line === REASON, sig);
check("Ellis's signals are untouched (each side's own only)", (await RM.ownOutcomeSignals(ELLIS)).length === 0);
const adj = RM.outcomeAdjustedScore(80, "raising a seed round for a battery startup with climate hardware investors", sig, 60, ["raising a seed round for my climate hardware battery startup"]);
check("…and moves a like candidate down in scoring, never below the bar's rule", adj.moved < 0, adj);
check("kept talking finds the same pair (noteMetAgain's record)", (await RM.introducedPairId(JORDAN, ELLIS)) === pairs[0].id);
// The call: the after-call read's names come from pairsToldAbout, and its answer lands on the same pair, source call.
const known = { names: ["Ellis"], pairs: await RM.pairsToldAbout(ELLIS), intros: [] };
const n = await CL.saveCallIntroOutcomes(ELLIS, [{ name: "Jordan", met: "yes", useful: "no", keptTalking: null }], { names: ["Jordan"], pairs: known.pairs, intros: [] });
const ellisSide = pairs[0][`${sideOf(ELLIS)}_evidence`];
check("call: Ellis says on a call it wasn't a fit: his side, source call, stated", n === 1 && ellisSide.useful?.value === "no" && ellisSide.useful?.source === "call" && ellisSide.useful?.how === "stated", ellisSide);
check("…and Jordan's side is exactly as Jordan left it", JSON.stringify(pairs[0][`${sideOf(JORDAN)}_evidence`]) === JSON.stringify(mine));

// ---------------------------------------------------------------- 3. not a room
const ns = src("harness/northStar.ts");
check("the room count leaves network pairs out (they're counted once, as network intros)", /WHERE p\.intro_sent_at IS NOT NULL AND p\.event_id <> 'network'/.test(ns) && /p\.event_id <> 'network' AND p\.intro_sent_at < n\.introduced_at/.test(ns));
check("the host read is by event id (a network pair is never in a room's readout)", /FROM co_pairs WHERE event_id = \$1 AND intro_sent_at IS NOT NULL/.test(src("services/partnerReadout.ts")));
check("the event outcome report leaves network pairs out", /p\.event_id <> 'network'/.test(src("scripts/eventOutcomeReport.ts")));
const one = RM.pairOutcome(pairs[0].a_evidence, pairs[0].b_evidence);
check("the pair's outcome reads both sides for measurement only (met yes, each side's useful)", one.met === "yes" && one.usefulA === "no" && one.usefulB === "no");

console.log(`network outcomes: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
