// heavy_offer_hold (Royce, 2026-10-19: "feelings change timing and tone, never cancel"). A heavy moment used to keep the door, the
// cold-start question and a document offer out of a reply for as long as the moment lasted, with no limit (replyGrounding.ts
// heavyMoment). Now it's heavyHold: they stay owed and come up in a later reply once they're okay again, or when the hard stretch
// reaches MOOD_HOLD_CAP_HOURS, even if the read still says struggling. Other reasons still decline them as before. Safety is unchanged.
// Each hold and release is logged once with the rule and the kind, never their words.
// Layer 1: pure functions, the reply facts on a fake store. Zero tokens, no DB, nothing sent.
//   npx tsx evals/proactive/moodHeavyOffers.ts
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const MH = await import("../../src/services/moodHold.js");
const E = await import("../../src/harness/emotion.js");
const RG = await import("../../src/harness/replyGrounding.js");
const C = await import("../../src/services/coldStart.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = new Date();
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);
type Sig = import("../../src/harness/emotion.js").EmotionSignal;
const THEIR_WORDS = "my dad is back in the hospital and I can't think";
const hard = (h: number): Sig => ({ source: "text", emotion: "scared", intensity: "high", valence: "negative", about: "their dad in the hospital", quote: THEIR_WORDS, at: ago(h), target: "life" });
const callHard = (h: number): Sig => ({ source: "call", emotion: "grief", intensity: "high", valence: "negative", about: "a loss", quote: THEIR_WORDS, at: ago(h), target: "life" });
const emo = (sigs: Sig[]) => E.summarizeSignals(sigs, NOW);
const CALM = emo([]);
const HELD = emo([hard(2)]);
const OKAY = emo([hard(8)]);
const CAP = emo([hard(1), hard(20), hard(40), hard(49)]);

// ================================================================ 1. the read
{
  check("not heavy: no hold", RG.heavyHold(CALM, NOW).state === "none");
  check("a heavy moment holds", RG.heavyHold(HELD, NOW).hold && RG.heavyMoment(HELD));
  check("released early: this message is them texting normally 6h+ after the hard read", RG.heavyHold(OKAY, NOW).state === "released_okay" && RG.heavyMoment(OKAY));
  check("released at the cap even though the read still says struggling", RG.heavyHold(CAP, NOW).state === "released_cap" && CAP.needsCare && RG.heavyMoment(CAP));
  const call = emo([callHard(30)]);
  check("a strong hard call moment without a hard day holds while it's their current feeling", !call.needsCare && RG.heavyMoment(call) && RG.heavyHold(call, NOW).hold);
  check("...and is no longer current after 48h (the cap's length): no hold", !RG.heavyMoment(emo([callHard(49)])) && !RG.heavyHold(emo([callHard(49)]), NOW).hold);
  check("an older state without the read's times holds, as before", RG.heavyHold({ ...CALM, needsCare: true } as any, NOW).hold);
}

// ================================================================ 2. the door (a new member's first read)
{
  const view = { joinedAt: ago(30), givenAt: null, theirTexts: 4 };
  const door = (e: any, otherQuestion: string | null = null) => { const rf = RG.createReplyFacts(); return { rf, d: RG.addDoorMoment(rf, view, { firstName: "Jordan", emotional: e, otherQuestion, now: NOW }) }; };
  const held = door(HELD);
  check("heavy: not this reply, and still owed (the door stays open, recorded why)", held.d?.offered === false && held.d?.why === "a heavy moment" && !!held.d && held.rf.instructions.length === 0);
  check("released early when they're okay: offered", door(OKAY).d?.offered === true && !!door(OKAY).d?.instruction);
  check("released at the cap even if still struggling: offered", door(CAP).d?.offered === true);
  check("not heavy: offered as before", door(CALM).d?.offered === true);
  check("a non-mood decline still works: another question this reply", door(CALM, "a document offer").d?.offered === false && /something else to offer/.test(door(CALM, "a document offer").d!.why));
  check("its own clock still ends it: given, or no longer new, closes it whatever the mood", (() => { const rf = RG.createReplyFacts(); return RG.addDoorMoment(rf, { ...view, givenAt: ago(1) }, { emotional: CAP, now: NOW }) === null && RG.addDoorMoment(RG.createReplyFacts(), { ...view, joinedAt: ago(60 * 24) }, { emotional: CAP, now: NOW }) === null; })());
}

// ================================================================ 3. the cold-start question
{
  const EMPTY = C.countSeeds({ goals: [], findAsks: [] });
  const cs = (history: any[] = []) => ({ seeds: EMPTY, history, joinedAt: ago(30) });
  const steer = (e: any, history: any[] = [], otherQuestion: string | null = null) => RG.addColdStartSteer(RG.createReplyFacts(), cs(history), { emotional: e, otherQuestion, now: NOW });
  check("heavy: not this reply, recorded why (it stays owed: the next reply decides again)", steer(HELD)?.offered === false && steer(HELD)?.why === "a heavy moment");
  check("released early when they're okay", steer(OKAY)?.offered === true);
  check("released at the cap even if still struggling", steer(CAP)?.offered === true);
  check("a non-mood decline still works: never two replies in a row", steer(CALM, [{ action: "steered", at: ago(0.1), question: "What kind of rooms do you like?" }])?.offered === false);
}

// ================================================================ 4. the document offer's moment, safety, and what didn't change
{
  check("the door and the steer read the capped hold, never the bare heavy moment", (src("harness/replyGrounding.ts").match(/heavy: heavyHold\(o\.emotional, o\.now \?\? new Date\(\)\)\.hold/g) ?? []).length === 2 && !/heavy: heavyMoment\(/.test(src("harness/replyGrounding.ts")));
  check("the door's and the steer's own rules are unchanged (heavy and frustration still checked where they were)", /if \(o\.heavy\) return \{ offer: false, why: "a heavy moment" \};/.test(src("services/theDoor.ts")) && /if \(o\.heavy\) return \{ steer: false, why: "a heavy moment" \};/.test(src("services/coldStart.ts")));
  check("safety unchanged: the reply's safety rule and the proactive safety hold are as they were", /if \(state\.safetyHold && \(PROACTIVE_PURPOSE_MAP\[c\.type\] === "offer" \|\| c\.type === "name_change" \|\| c\.type === "announcement"\)\) \{/.test(src("harness/proactive.ts")) && /SAFETY_INSTRUCTION/.test(src("harness/replyGrounding.ts")));
  check("no new member-facing words: the instructions given at release are the existing ones", RG.addDoorMoment(RG.createReplyFacts(), { joinedAt: ago(30), givenAt: null, theirTexts: 4 }, { firstName: "Jordan", emotional: CAP, now: NOW })?.instruction === RG.addDoorMoment(RG.createReplyFacts(), { joinedAt: ago(30), givenAt: null, theirTexts: 4 }, { firstName: "Jordan", emotional: CALM, now: NOW })?.instruction);
}

// ================================================================ 5. the reply: kept owed, logged once, rule and kind, no member text
{
  const { gatherReplyFacts } = await import("../../src/harness/replyGrounding.js");
  const realQuery = pool.query;
  (pool as any).query = async () => ({ rows: [], rowCount: 0 });
  const turnWith = (e: any) => ({
    userId: "u-jordan", message: "ok", profile: null, snapshot: null, sent: [], asks: [], threads: [], offersThisWeek: 0, emotional: e, lessons: [], inlineTarget: null,
    ledger: { lines: [], named: [] }, capabilities: [], google: [], kit: {}, story: [], advice: [], tasks: [], briefs: [], goals: [], deliveries: [], goalSetAsides: [], carrying: [], recentDocs: [], drift: [],
    door: { joinedAt: ago(30), givenAt: null, theirTexts: 4 }, coldStart: { seeds: C.countSeeds({ goals: [], findAsks: [] }), history: [], joinedAt: ago(30) }, knowledge: null, rules: null,
  } as any);
  MH.resetMoodHoldLog();
  const printed: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  const r1 = await gatherReplyFacts("u-jordan", { turn: turnWith(HELD) }).catch((e: any) => ({ threw: e?.message }) as any);
  const r2 = await gatherReplyFacts("u-jordan", { turn: turnWith(HELD) }).catch((e: any) => ({ threw: e?.message }) as any);
  const r3 = await gatherReplyFacts("u-jordan", { turn: turnWith(CAP) }).catch((e: any) => ({ threw: e?.message }) as any);
  const r4 = await gatherReplyFacts("u-jordan", { turn: turnWith(OKAY) }).catch((e: any) => ({ threw: e?.message }) as any);
  const r5 = await gatherReplyFacts("u-jordan", { turn: turnWith(CALM) }).catch((e: any) => ({ threw: e?.message }) as any);
  console.log = log; console.error = err;
  (pool as any).query = realQuery;
  check("the facts were gathered on a fake store", ![r1, r2, r3, r4, r5].some((r) => r.threw), [r1, r2, r3, r4, r5].map((r) => r.threw ?? "ok"));
  const gentle = (r: any) => (r.instructions ?? []).includes(MH.GENTLE_AFTER_HARD);
  check("released at the cap or early: what waited goes gently (the tone line is in the reply's instructions)", gentle(r3) && gentle(r4), { cap: gentle(r3), okay: gentle(r4) });
  check("held, or never heavy: no tone line", !gentle(r1) && !gentle(r5));
  check("the tone line is model-facing guidance, never a line for the member (no quotes, an instruction)", /bring it up gently/.test(MH.GENTLE_AFTER_HARD) && !/"/.test(MH.GENTLE_AFTER_HARD));
  check("heavy: the door and the question wait (still owed, not offered)", r1.door?.offered === false && r1.coldStart?.offered === false);
  check("at the cap: one of them comes up (the door, then the question waits only for the door's turn)", r3.door?.offered === true || r3.coldStart?.offered === true, { door: r3.door, cs: r3.coldStart });
  const lines = printed.filter((l) => l.startsWith("mood hold:"));
  check("held logged once per kind over two replies", ["door", "cold_start"].every((k) => lines.filter((l) => new RegExp(`rule=heavy_offer_hold kind=${k} ref=u-jordan:${k} held`).test(l)).length === 1), lines);
  check("released logged at the cap", lines.some((l) => /rule=heavy_offer_hold kind=door .*released: the 48h cap/.test(l)), lines);
  check("logs carry no member text", lines.length > 0 && lines.every((l) => !l.includes("hospital") && !l.includes("dad") && !l.includes("Jordan")), lines);
}

console.log(`\nheavy offers wait: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
