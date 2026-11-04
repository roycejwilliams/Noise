// An offer to write something up waits out a hard time; it is never cancelled by one (Royce, 2026-10-19: "feelings change timing and
// tone, never cancel... it still happens, later or gentler, with a capped wait so it never waits forever"). The place:
// services/documentOffer.ts offerGate, which blocked every offer (a document, a plan sheet, a venue brief, a corrected version) while
// they were struggling (needsCare), with nothing to bring it back but the read clearing. Now it waits on the shared capped hold
// (offerMoodHeld, services/moodHold.ts): the offerDocument tool's re-check and any caller without the reply's moment. In a reply the
// moment gate (harness/replyGrounding.ts heavyHold, #262) is the one mood gate: it logs (heavy_offer_hold) and adds the gentle tone at
// release; this PR keeps the notice owed under it (the context is computed without the mood gate) and never gates it twice.
// Covered: mood on -> delayed, not dropped (nothing recorded, still owed next reply); released early when okay; released at the cap even
// if still struggling; non-mood reasons unchanged; safety unchanged; logs carry no member text and come under one rule; the pin that this
// place can't cancel on mood.
// Layer 1: pure functions, the real reads and the reply facts on a fake store. Zero tokens, no DB, nothing sent.
//   npx tsx evals/docs/offerMoodHold.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const O = await import("../../src/services/documentOffer.js");
const MH = await import("../../src/services/moodHold.js");
const E = await import("../../src/harness/emotion.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = new Date("2026-10-19T19:00:00Z");
const ago = (h: number, from = NOW) => new Date(from.getTime() - h * HOUR);
type Sig = import("../../src/harness/emotion.js").EmotionSignal;
// Their words, so the log checks can look for them.
const THEIR_WORDS = "my dad is back in the hospital and I can't think";
const GUIDE = "seeking guidance on how to split the cofounder roles with Jacqueline";
const hardSig = (h: number, from = NOW): Sig => ({ source: "text", emotion: "scared", intensity: "high", valence: "negative", about: "their dad in the hospital", quote: THEIR_WORDS, at: ago(h, from), target: "life" });
const read = (sigs: Sig[], lastInboundAt: Date | null, now = NOW) => MH.moodHold(E.summarizeSignals(sigs, now), { now, lastInboundAt });
const HELD = read([hardSig(2)], ago(2.1));
const OKAY = read([hardSig(8)], ago(1));
const CAPPED = read([hardSig(1), hardSig(20), hardSig(40), hardSig(49)], ago(1.5));
const state = (o: Partial<import("../../src/services/documentOffer.js").OfferState> = {}) => ({ now: NOW, helpAsks: [{ text: GUIDE, ageDays: 3 }], threads: [], recurring: [], needsCare: false, history: [], ...o });
const SETTLED = { kind: "venue", what: "dinner", picked: "Rich Table", when: "Friday", headcount: 12, city: "San Francisco", area: null, updatedAt: ago(1) };
const CO_LINES = ["Drinks at Spruce at 7pm, then Rich Table at 8:15pm."];

// ================================================================ 1. the gate: waits, released when okay, released at the cap
{
  check("the reads used here: held, okay again, at the cap", HELD.state === "held" && OKAY.state === "released_okay" && CAPPED.state === "released_cap", [HELD, OKAY, CAPPED]);
  const held = O.documentOfferDue(state({ needsCare: true, moodHold: HELD }));
  check("mood on: the document offer waits (not now), and the reason says it waits, capped", !held.due && held.why === O.OFFER_MOOD_WAIT && /waits until they're okay, at most 48h/.test(held.why), held);
  check("the wait uses the one cap (MOOD_HOLD_CAP_HOURS), no second clock", O.OFFER_MOOD_WAIT.includes(`${MH.MOOD_HOLD_CAP_HOURS}h`) && !/process\.env/.test(src("services/moodHold.ts")));
  check("released early: they texted normally since, so it's due", O.documentOfferDue(state({ needsCare: true, moodHold: OKAY })).due === true);
  check("released at the cap even though the read still says struggling", O.documentOfferDue(state({ needsCare: true, moodHold: CAPPED })).due === true);
  check("not struggling: due, as before", O.documentOfferDue(state()).due === true);
  check("no times on the read (a state built without them): struggling holds, as before", O.documentOfferDue(state({ needsCare: true })).due === false && O.offerMoodHeld({ needsCare: true }) && !O.offerMoodHeld({ needsCare: false, moodHold: HELD }));
  // The other offers share the gate: a plan sheet, a venue brief, a corrected version.
  const art = { now: NOW, helpAsks: [], threads: [], recurring: [], needsCare: false, history: [] as any[], notes: SETTLED, delivered: [], openWork: [], drift: [], message: "", coLines: CO_LINES };
  check("plan sheet and venue brief: never offered now, held or released (they were removed, 2026-11-04)", !O.artifactOfferDue("plan", { ...art, needsCare: true, moodHold: OKAY }).due && !O.artifactOfferDue("plan", { ...art, needsCare: true, moodHold: CAPPED }).due);
  const host = { ...art, notes: null, coLines: [], message: "I'm hosting a dinner for 14 founders on Oct 28 in Hayes Valley" };
  check("a hosting message gets no brief offer either", !O.artifactOfferDue("brief", { ...host, needsCare: true, moodHold: OKAY }).due && !O.artifactOfferDue("brief", { ...host, needsCare: false }).due);
  check("a heavy moment waits too (heavyNow, the reply's capped heavyHold), with a reason that says so", O.offerGate({ now: NOW, needsCare: false, heavyNow: true, history: [] }) === "this message is a heavy moment; the offer waits for a later reply");
}

// ================================================================ 2. the reply lines: one mood gate (the moment), the notice owed
{
  const ctx = (o: Record<string, unknown> = {}) => ({ due: { topic: GUIDE, why: "they asked for guidance on this 3 days ago" }, pending: null, history: [], needsCare: true, moodHold: HELD, ...o }) as any;
  const moment = (heavyNow: boolean) => ({ moment: { heavyNow, coLines: [] } });
  check("in a reply the moment decides: heavy (held) -> no hint", O.docOfferLines(ctx(moment(true)), "ok").hint === null);
  check("in a reply the moment decides: released -> the hint, though the context's older read still says held (never gated twice)", /offerDocument/.test(O.docOfferLines(ctx(moment(false)), "ok").hint ?? ""));
  const plan = (o: Record<string, unknown>) => ({ due: null, pending: null, history: [], needsCare: true, moodHold: HELD, signals: { notes: SETTLED, delivered: [], openWork: [], drift: [] }, ...o }) as any;
  check("a plan sheet in a reply: never offered, whatever the moment", !O.docOfferLines(plan(moment(true)), "sounds good", { now: NOW, coLines: CO_LINES }).offer && !O.docOfferLines(plan(moment(false)), "sounds good", { now: NOW, coLines: CO_LINES }).offer);
  check("no moment (a caller without one): the context's capped hold decides, held", O.docOfferLines(ctx(), "ok").hint === null && !O.docOfferLines(plan({}), "sounds good", { now: NOW, coLines: CO_LINES }).offer);
  check("no moment, released (okay or the cap): it goes", /offerDocument/.test(O.docOfferLines(ctx({ moodHold: OKAY }), "ok").hint ?? "") && /offerDocument/.test(O.docOfferLines(ctx({ moodHold: CAPPED }), "ok").hint ?? ""));
  check("not struggling: the hint as before", /offerDocument/.test(O.docOfferLines(ctx({ needsCare: false, moodHold: null }), "ok").hint ?? ""));
  check("the context keeps the notice owed under a hard time (computed without the mood gate)", /const d = documentOfferDue\(\{ \.\.\.state, needsCare: false \}\);/.test(src("services/documentOffer.ts")));
  check("their own ask for a document is never held by mood (the ask line, not an offer)", !!O.docOfferLines(ctx(moment(true)), "can you make me a pdf of this?").ask);
}

// ================================================================ 3. non-mood reasons unchanged
{
  const hist = (topic: string, d: number, status: "offered" | "accepted" = "offered") => ({ topic, source: "offered" as const, status, at: new Date(NOW.getTime() - d * DAY) });
  const released = { needsCare: true, moodHold: OKAY };
  check("an offer waiting on its answer still blocks, released or not", /waiting on their answer/.test(O.documentOfferDue(state({ ...released, history: [hist(GUIDE, 1)] })).why));
  check("the fortnight cooldown still holds", O.documentOfferDue(state({ ...released, helpAsks: [{ text: "figuring out how to price the first event", ageDays: 4 }], history: [hist(GUIDE, 6)] })).due === false);
  check("never the same topic twice", O.documentOfferDue(state({ ...released, history: [hist(GUIDE, 60)] })).due === false);
  check("its own clock still ends it: an ask that closed is no longer owed", O.documentOfferDue(state({ ...released, helpAsks: [] })).due === false);
  check("offerDocument re-checks the same gate at tool time, from the live read with its times", /documentOfferDue\(await loadOfferState\(ctx\.userId\)\)/.test(src("agent/loopTools.ts")) && /moodHold: moodHold\(emo, \{ now, lastInboundAt: inbound \}\)/.test(src("services/documentOffer.ts")));
}

// ================================================================ 4. safety unchanged
{
  check("safety is not mood: the offer gate reads no safety state, before or after", !/safety/i.test(src("services/documentOffer.ts")));
  check("the safety hold on proactive offers is untouched", /if \(state\.safetyHold && \(PROACTIVE_PURPOSE_MAP\[c\.type\] === "offer" \|\| c\.type === "name_change" \|\| c\.type === "announcement"\)\)/.test(src("harness/proactive.ts")));
  check("the mood rule list has no safety entry", !Object.keys(MH.MOOD_RULES).some((k) => /safety/.test(k)));
}

// ================================================================ 5. the real read on a fake store (loadOfferState, loadDocOfferContext)
{
  const realQuery = pool.query;
  const writes: string[] = [];
  let sigs: Sig[] = [];
  let inbound: Date | null = null;
  (pool as any).query = async (sql: string) => {
    const q = String(sql);
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(q)) { writes.push(q.trim()); return { rows: [], rowCount: 0 }; }
    if (/FROM ask_checkins/.test(q)) return { rows: [{ ask_text: GUIDE, created_at: new Date(Date.now() - 3 * DAY) }] };
    if (/FROM emotion_signals/.test(q)) return { rows: sigs.map((s) => ({ source: s.source, emotion: s.emotion, intensity: s.intensity, valence: s.valence, about: s.about, quote: s.quote, created_at: s.at, target: s.target, basis: null })) };
    if (/MAX\(created_at\) AS at FROM co_memories/.test(q)) return { rows: [{ at: inbound }] };
    return { rows: [] };
  };
  const now = new Date();
  try {
    sigs = [hardSig(2, now)]; inbound = ago(2.1, now);
    const sHeld = await O.loadOfferState("u-jordan", now);
    const cHeld = await O.loadDocOfferContext("u-jordan", now);
    check("live read, struggling: the tool's gate says wait", sHeld.needsCare && sHeld.moodHold?.state === "held" && O.documentOfferDue(sHeld).why === O.OFFER_MOOD_WAIT, sHeld.moodHold);
    check("live read, struggling: the reply context still carries the offer as owed, with the hold beside it", cHeld.due?.topic === GUIDE && cHeld.needsCare === true && cHeld.moodHold?.state === "held" && O.docOfferLines(cHeld, "ok").hint === null, cHeld);
    sigs = [hardSig(8, now)]; inbound = ago(1, now);
    const sOkay = await O.loadOfferState("u-jordan", now);
    check("live read, they texted normally since: released, due again", sOkay.moodHold?.state === "released_okay" && O.documentOfferDue(sOkay).due === true, sOkay.moodHold);
    sigs = [hardSig(1, now), hardSig(20, now), hardSig(40, now), hardSig(49, now)]; inbound = ago(1.5, now);
    const sCap = await O.loadOfferState("u-jordan", now);
    check("live read, the cap: released though still struggling, due", sCap.needsCare && sCap.moodHold?.state === "released_cap" && O.documentOfferDue(sCap).due === true, sCap.moodHold);
    check("a held offer writes nothing (not recorded, not dropped)", writes.length === 0, writes);
  } finally {
    (pool as any).query = realQuery;
  }
}

// ================================================================ 6. the reply: one gate, one log rule, gentle at release, ids only
{
  const { gatherReplyFacts } = await import("../../src/harness/replyGrounding.js");
  const realQuery = pool.query;
  const writes: string[] = [];
  (pool as any).query = async (sql: string) => { if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push(String(sql).trim()); return { rows: [], rowCount: 0 }; };
  const now = new Date();
  const turnWith = (s: Sig[]) => ({
    userId: "u-jordan", message: "ok", profile: null, snapshot: null, sent: [], asks: [], threads: [], offersThisWeek: 0, emotional: E.summarizeSignals(s, now), lessons: [], inlineTarget: null,
    ledger: { lines: [], named: [] }, capabilities: [], google: [], kit: {}, story: [], advice: [], tasks: [], briefs: [], goals: [], deliveries: [], goalSetAsides: [], carrying: [], recentDocs: [], drift: [],
    // The context as turnContext loads it: owed (computed without the mood gate), and its own earlier read says struggling.
    docOffer: { due: { topic: GUIDE, why: "they asked for guidance on this 3 days ago" }, pending: null, history: [], needsCare: true, moodHold: { state: "held", hold: true, heldHours: 2 } },
    knowledge: null, rules: null,
  } as any);
  MH.resetMoodHoldLog();
  const printed: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  const rHeld = await gatherReplyFacts("u-jordan", { turn: turnWith([hardSig(2, now)]) }).catch((e: any) => ({ threw: e?.message }) as any);
  const rOkay = await gatherReplyFacts("u-jordan", { turn: turnWith([hardSig(8, now)]) }).catch((e: any) => ({ threw: e?.message }) as any);
  MH.resetMoodHoldLog();
  const rHeld2 = await gatherReplyFacts("u-jordan", { turn: turnWith([hardSig(3, now)]) }).catch((e: any) => ({ threw: e?.message }) as any);
  const rCap = await gatherReplyFacts("u-jordan", { turn: turnWith([hardSig(0.5, now), hardSig(20, now), hardSig(40, now), hardSig(49, now)]) }).catch((e: any) => ({ threw: e?.message }) as any);
  console.log = log; console.error = err;
  (pool as any).query = realQuery;
  const offered = (r: any) => JSON.stringify(r).includes("offerDocument");
  const gentle = (r: any) => JSON.stringify(r).includes(MH.GENTLE_AFTER_HARD.slice(0, 40));
  check("reply: the facts were gathered on a fake store", ![rHeld, rOkay, rHeld2, rCap].some((r) => r.threw), [rHeld, rOkay, rHeld2, rCap].map((r) => r.threw ?? "ok"));
  check("reply: struggling, no offer this reply", !offered(rHeld) && !offered(rHeld2));
  check("reply: released early when this message comes 6h+ after the hard read (the context's older read doesn't hold it again)", offered(rOkay) && gentle(rOkay));
  check("reply: released at the cap even if still struggling, gently", offered(rCap) && gentle(rCap));
  check("reply: a held offer writes nothing", writes.length === 0, writes);
  const lines = printed.filter((l) => l.startsWith("mood hold:"));
  const docLines = lines.filter((l) => /kind=document_offer/.test(l));
  check("reply: one log rule for the document offer (heavy_offer_hold), never a second line for it", docLines.length > 0 && docLines.every((l) => /rule=heavy_offer_hold/.test(l)) && !lines.some((l) => /doc_offer_hold/.test(l)), lines);
  check("reply: hold and release each logged once", docLines.filter((l) => / held/.test(l)).length === 2 && docLines.some((l) => /released: they texted normally/.test(l)) && docLines.some((l) => /released: the 48h cap/.test(l)), docLines);
  check("reply: logs carry no member text (not their words, not the topic)", lines.every((l) => !l.includes("hospital") && !l.includes("cofounder") && !l.includes("Jacqueline")), lines);
}

// ================================================================ 7. the pin: this place can't cancel on mood
{
  const doc = src("services/documentOffer.ts");
  const rg = src("harness/replyGrounding.ts");
  check("offerGate's mood line is the capped wait (offerMoodHeld), never a bare needsCare block", /if \(offerMoodHeld\(s\)\) return OFFER_MOOD_WAIT;/.test(doc) && !/if \(s\.needsCare\) return/.test(doc) && !/having a hard time; their state comes first/.test(doc));
  check("offerMoodHeld follows the shared hold (released when okay or at the cap)", /return !!s\.needsCare && \(s\.moodHold \? s\.moodHold\.hold : true\);/.test(doc));
  check("a held offer is never recorded or dropped: no write sits behind the mood check", !/offerMoodHeld[^\n]*(INSERT|UPDATE|recordOffer|recordArtifactOffer)/.test(doc));
  check("one gate in a reply: the moment is #262's heavyHold, with no second per-message block from this PR", /opts\.turn\.docOffer\.moment = \{ heavyNow: heavyHold\(opts\.turn\.emotional, new Date\(\)\)\.hold,/.test(rg) && !/strongNow/.test(rg) && !/doc_offer_hold/.test(rg));
  check("ruled under the one rule (heavy_offer_hold names offerGate) and off the not-changed list", MH.MOOD_RULES.heavy_offer_hold.where.includes("services/documentOffer.ts offerGate") && !MH.FEELING_PICKS_NOT_CHANGED.some((o) => o.where.includes("documentOffer.ts")) && !("doc_offer_hold" in MH.MOOD_RULES));
  for (const mh of [HELD, OKAY, CAPPED, { state: "none" as const, hold: false, heldHours: null }]) {
    const d = O.documentOfferDue(state({ needsCare: mh.state !== "none", moodHold: mh }));
    check(`mood state ${mh.state}: ${mh.hold ? "waits (never a cancel)" : "due"}`, mh.hold ? !d.due && d.why === O.OFFER_MOOD_WAIT : d.due === true, d);
  }
  check("no member-facing words added: the module's new lines are reasons only", !/sendText|sendWithLedger|messages:/.test(doc));
}

console.log(`\noffer mood hold: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
