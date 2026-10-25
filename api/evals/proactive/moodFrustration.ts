// frustration_hold (Royce, 2026-10-19: "feelings change timing and tone, never cancel"). Frustration with Cue used to keep the door
// and the cold-start question out of every reply for 48 hours after the last such read, again and again, with no cap. Now
// frustrationHold: one capped wait per item, measured from the first frustration read since the item was owed; it ends early once
// they're okay (a text 6h+ after the last frustration read, or the read clears) and at MOOD_HOLD_CAP_HOURS even if they're still
// frustrated. The item stays owed. Other declines are unchanged; safety is unchanged; logs are rule and kind, never their words.
// Layer 1: pure functions, the reply facts on a fake store. Zero tokens, no DB, nothing sent.
//   npx tsx evals/proactive/moodFrustration.ts
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const MH = await import("../../src/services/moodHold.js");
const E = await import("../../src/harness/emotion.js");
const RG = await import("../../src/harness/replyGrounding.js");
const C = await import("../../src/services/coldStart.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const HOUR = 3_600_000;
const NOW = new Date();
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);
type Sig = import("../../src/harness/emotion.js").EmotionSignal;
const THEIR_WORDS = "you keep sending me garbage, this is useless";
const atCo = (h: number): Sig => ({ source: "text", emotion: "frustrated", intensity: "high", valence: "negative", about: "what Cue found", quote: THEIR_WORDS, at: ago(h), target: "co" });
const goodCo = (h: number): Sig => ({ source: "text", emotion: "pleased", intensity: "medium", valence: "positive", about: "a find", quote: "ok this one is great", at: ago(h), target: "co" });
const emo = (sigs: Sig[]) => E.summarizeSignals(sigs, NOW);
const JOINED = ago(24 * 5);
const FRESH = emo([atCo(1)]);
const OKAY = emo([atCo(7)]);
const CAP = emo([atCo(1), atCo(20), atCo(40), atCo(49)]);
const CLEARED = emo([goodCo(0.5), atCo(1)]);

// ================================================================ 1. the read
{
  check("the read carries timestamps only: the latest frustration read and all of them", FRESH.withCo.frustrated && FRESH.withCo.at?.getTime() === ago(1).getTime() && FRESH.withCo.reads?.length === 1);
  check("frustrated: held", RG.frustrationHold(FRESH, JOINED, NOW).state === "held");
  check("released early when they're okay: this message comes 6h+ after the last frustration read", RG.frustrationHold(OKAY, JOINED, NOW).state === "released_okay");
  check("released early when the read clears (a positive read about Cue after)", RG.frustrationHold(CLEARED, JOINED, NOW).state === "none");
  check("released at the cap from when it was first held, even if still frustrated", CAP.withCo.frustrated && RG.frustrationHold(CAP, JOINED, NOW).state === "released_cap", RG.frustrationHold(CAP, JOINED, NOW));
  check("one wait per item: a new frustration read after its wait never starts a second one", RG.frustrationHold(emo([atCo(0.5), atCo(60)]), JOINED, NOW).state === "released_cap");
  check("frustration before the item was owed doesn't count against its wait", RG.frustrationHold(emo([atCo(0.5), atCo(60)]), ago(10), NOW).state === "held");
  check("a read without times (an older state) holds, as before", RG.frustrationHold({ withCo: { frustrated: true, about: null, count: 1 } } as any, JOINED, NOW).hold);
  check("the cold-start question is owed since its last steer record, else since they joined", RG.steerOwedSince({ history: [{ action: "steered", at: ago(30), question: "q" }, { action: "skipped", at: ago(10), question: null }] as any, joinedAt: JOINED })?.getTime() === ago(10).getTime() && RG.steerOwedSince({ history: [], joinedAt: JOINED })?.getTime() === JOINED.getTime());
}

// ================================================================ 2. the door and the question: wait, stay owed, go
{
  const view = { joinedAt: JOINED, givenAt: null, theirTexts: 4 };
  const door = (e: any, otherQuestion: string | null = null) => RG.addDoorMoment(RG.createReplyFacts(), view, { firstName: "Jordan", emotional: e, otherQuestion, now: NOW });
  check("door: frustrated, not this reply and still owed", door(FRESH)?.offered === false && door(FRESH)?.why === "frustrated with Cue right now");
  check("door: released early when they're okay", door(OKAY)?.offered === true);
  check("door: released at the cap even if still frustrated", door(CAP)?.offered === true);
  check("door: a non-mood decline still works (another question this reply)", door(emo([]), "a document offer")?.offered === false);
  check("door: its own clock still closes it, whatever the mood", RG.addDoorMoment(RG.createReplyFacts(), { ...view, givenAt: ago(1) }, { emotional: CAP, now: NOW }) === null);
  const EMPTY = C.countSeeds({ goals: [], findAsks: [] });
  const steer = (e: any, history: any[] = []) => RG.addColdStartSteer(RG.createReplyFacts(), { seeds: EMPTY, history, joinedAt: JOINED }, { emotional: e, now: NOW });
  check("question: frustrated, not this reply", steer(FRESH)?.offered === false && steer(FRESH)?.why === "frustrated with Cue right now");
  check("question: released early when they're okay, and at the cap", steer(OKAY)?.offered === true && steer(CAP)?.offered === true);
  check("question: a non-mood decline still works (never two replies in a row)", steer(emo([]), [{ action: "steered", at: ago(0.1), question: "What kind of rooms do you like?" }])?.offered === false);
  check("a heavy moment still holds on its own rule (unchanged by this)", door(emo([{ ...atCo(1), target: "life", about: "a loss" }]))?.why === "a heavy moment");
}

// ================================================================ 3. no bare frustration read gates anything; safety unchanged
{
  const rg = src("harness/replyGrounding.ts");
  check("door and question read the capped hold, never the bare frustration read", (rg.match(/frustrated: frustrationHold\(/g) ?? []).length === 2 && !/frustrated: !!o\.emotional\?\.withCo\?\.frustrated/.test(rg));
  check("no other code passes the bare frustration read into a decision", !/frustrated: !!\w+(?:\.\w+)*\?\.withCo\?\.frustrated/.test(fs.readdirSync(new URL("../../src/harness/", import.meta.url)).filter((f) => f.endsWith(".ts")).map((f) => src(`harness/${f}`)).join("\n")));
  check("the door's and the steer's own rules are unchanged", /if \(o\.frustrated\) return \{ offer: false, why: "frustrated with Cue right now" \};/.test(src("services/theDoor.ts")) && /if \(o\.frustrated\) return \{ steer: false, why: "frustrated with Cue right now" \};/.test(src("services/coldStart.ts")));
  check("safety unchanged", /if \(state\.safetyHold && \(PROACTIVE_PURPOSE_MAP\[c\.type\] === "offer" \|\| c\.type === "name_change" \|\| c\.type === "announcement"\)\) \{/.test(src("harness/proactive.ts")) && /SAFETY_INSTRUCTION/.test(rg));
  check("moved: ruled, and no longer listed as not changed", "frustration_hold" in MH.MOOD_RULES && !MH.FEELING_PICKS_NOT_CHANGED.some((o) => /frustrated/.test(o.where)));
  check("the feeling block they draft from still names the frustration (tone, not whether)", /look wider and try harder rather than going quiet or getting smaller/.test(src("harness/emotion.ts")));
}

// ================================================================ 4. the reply: logged once, rule and kind, no member text
{
  const { gatherReplyFacts } = await import("../../src/harness/replyGrounding.js");
  const realQuery = pool.query;
  (pool as any).query = async () => ({ rows: [], rowCount: 0 });
  const turnWith = (e: any) => ({
    userId: "u-jordan", message: "ok", profile: null, snapshot: null, sent: [], asks: [], threads: [], offersThisWeek: 0, emotional: e, lessons: [], inlineTarget: null,
    ledger: { lines: [], named: [] }, capabilities: [], google: [], kit: {}, story: [], advice: [], tasks: [], briefs: [], goals: [], deliveries: [], goalSetAsides: [], carrying: [], recentDocs: [], drift: [],
    door: { joinedAt: JOINED, givenAt: null, theirTexts: 4 }, coldStart: { seeds: C.countSeeds({ goals: [], findAsks: [] }), history: [], joinedAt: JOINED }, knowledge: null, rules: null,
  } as any);
  MH.resetMoodHoldLog();
  const printed: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  const r1 = await gatherReplyFacts("u-jordan", { turn: turnWith(FRESH) }).catch((e: any) => ({ threw: e?.message }) as any);
  const r2 = await gatherReplyFacts("u-jordan", { turn: turnWith(FRESH) }).catch((e: any) => ({ threw: e?.message }) as any);
  const r3 = await gatherReplyFacts("u-jordan", { turn: turnWith(CAP) }).catch((e: any) => ({ threw: e?.message }) as any);
  console.log = log; console.error = err;
  (pool as any).query = realQuery;
  check("the facts were gathered on a fake store", ![r1, r2, r3].some((r) => r.threw), [r1, r2, r3].map((r) => r.threw ?? "ok"));
  check("frustrated: the door and the question wait (still owed)", r1.door?.offered === false && r1.coldStart?.offered === false);
  check("at the cap: they come up", r3.door?.offered === true || r3.coldStart?.offered === true);
  const lines = printed.filter((l) => l.startsWith("mood hold:"));
  check("held logged once per kind over two replies", ["door", "cold_start"].every((k) => lines.filter((l) => new RegExp(`rule=frustration_hold kind=${k} ref=u-jordan:${k} held`).test(l)).length === 1), lines);
  check("release logged at the cap", lines.some((l) => /rule=frustration_hold kind=door .*released: the 48h cap/.test(l)), lines);
  check("logs carry no member text", lines.length > 0 && lines.every((l) => !l.includes("garbage") && !l.includes("useless") && !l.includes("Jordan")), lines);
}

console.log(`\nfrustration hold: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
