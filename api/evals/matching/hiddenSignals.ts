// The hidden part, end to end (Royce, 2026-10-18: "It should never be mentioned to another user what that person is going
// through"). A member's private asks and blockers reach the matching scorer as a marked hidden signal on every path, rooms
// included; they may raise a match, are never its basis, and no text another member reads echoes them: share reasons, value
// lines, nudges and other consent drafts, and the network intro email. Zero tokens: the in-room fake world (evals/inroom/world.ts)
// answers the database, Anthropic and Luma; nothing is sent. Invented people only.
//   npx tsx evals/matching/hiddenSignals.ts
import { readFileSync } from "fs";
import { W, reset, addMember, addEvent, ask, check, results } from "../inroom/world.js";

// The clock is pinned to 18:00 UTC today, as in evals/inroom/flow.ts.
{
  const RealDate = Date;
  const pinned = new RealDate();
  pinned.setUTCHours(18, 0, 0, 0);
  const offset = pinned.getTime() - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...a: any[]) {
      super(...((a.length ? a : [RealDate.now() + offset]) as [any]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  (globalThis as any).Date = PinnedDate;
}

const S = await import("../../src/services/eventScoring.js");
const M = await import("../../src/services/matching.js");
const G = await import("../../src/harness/matchGate.js");
const E = await import("../../src/harness/hiddenEcho.js");
const RM = await import("../../src/services/roomMatching.js");
const C = await import("../../src/harness/introConsent.js");
const N = await import("../../src/services/networkIntroNudge.js");
const { default: pool } = await import("../../src/db/db.js");
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const settle = () => new Promise((r) => setTimeout(r, 30));

const PRIVATE_ASK = "a quiet move to Lisbon before my lease ends";
const BLOCKER = "my divorce is dragging on";

// ---------------------------------------------------------------- 1. the room path: the hidden part reaches the scorer, and nothing else
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware")] });
  const noor = addMember({ first_name: "Noor", blockers: [BLOCKER], intent: [ask("backing climate hardware founders at seed", "offering"), ask(PRIVATE_ASK, "seeking", false)] });
  W.scorer = () => ({ score: 88, share: true });
  addEvent({ api_id: "evh", name: "Noise Supper" }, [{ m: jordan }, { m: noor }]);
  W.scoringDebounce.clear();
  await S.scoreGuestListForEvent("evh");
  await settle();
  const scorePrompts = W.llmCalls.filter((c) => c.kind === "score").map((c) => c.prompt);
  const lineFor = (p: string, id: string) => (p.split("one per line:\n")[1] ?? "").split("\n").find((l) => l.includes(`tag${id.slice(-6)}`)) ?? "";
  const noorLine = scorePrompts.map((p) => lineFor(p, noor.id)).find(Boolean) ?? "";
  const [shown, hidden] = noorLine.split(` | ${M.HIDDEN_LABEL}`);
  check("room: Noor's private ask reaches the scorer, in her line's hidden part", (hidden ?? "").includes(`private ask "${PRIVATE_ASK}"`), noorLine);
  check("room: Noor's blocker reaches the scorer, in her hidden part", (hidden ?? "").includes(`going through "${BLOCKER}"`), noorLine);
  check("room: neither appears outside the hidden part", !shown.includes("Lisbon") && !shown.includes("divorce"), shown);
  check("room: the scorer is told never to mention or cite it", scorePrompts.every((p) => p.includes(M.HIDDEN_RULE)));
  check("room: the match still happens on Noor's shared ask", W.nudges.some((n) => n.person_id === jordan.id && n.candidate_id === noor.id), W.nudges);
  check("room: no text sent to anyone mentions Noor's private ask or blocker", W.sent.length > 0 && W.sent.every((t) => !/lisbon|divorc|lease/i.test(t.content)), W.sent);
  check("room: the frame is still shareable asks only (a private ask is never anyone's frame)", scorePrompts.every((p) => !(p.split("one per line:")[0] ?? "").includes("Lisbon")));
}

// ---------------------------------------------------------------- 2. the echo check itself (pure)
{
  const hidden = [PRIVATE_ASK, BLOCKER];
  const sens = G.SENSITIVE;
  const e = (t: string, allowed: string[] = [], allow: string[] = []) => E.hiddenEcho(t, hidden, allowed, allow, sens);
  check("echo: word for word is rejected", !!e("Noor is after a quiet move to Lisbon before her lease ends"));
  check("echo: a paraphrase sharing its distinctive words is rejected ('moving to Lisbon')", !!e("You two should talk, she's moving to Lisbon soon"));
  check("echo: a hint at what they're going through is rejected ('going through a divorce')", !!e("Go easy, she's going through a divorce"));
  check("echo: a different word for it, a sensitive topic, is rejected ('the custody fight')", !!E.hiddenEcho("She's in the middle of a custody fight", ["custody of my kids"], [], [], sens));
  check("echo: one distinctive word is enough when it's the hidden text's only one", !!E.hiddenEcho("She's into ceramics", ["ceramics"], [], [], sens));
  check("echo: an unrelated reason passes", e("Noor backs climate hardware founders at seed, which is what you're after") === null);
  check("echo: words they shared themselves are allowed", E.hiddenEcho("She's opening a studio in Lisbon", ["a quiet move to Lisbon"], ["opening a studio in Lisbon next spring"], [], sens) === null);
  check("echo: the reader's own words are allowed (allowedTexts)", E.hiddenEcho("You said you want to move to Lisbon too", [PRIVATE_ASK], ["I want to move to Lisbon"], [], sens) === null);
  check("echo: the event's name and first names never count (allow)", E.hiddenEcho("See you at Lisbon Supper Club, Noor", ["dinner at Lisbon Supper Club"], [], ["Lisbon Supper Club", "Noor"], sens) === null);
  check("echo: accents and case don't hide it", !!e("SHE'S MOVING TO LISBÖN"));
}

// ---------------------------------------------------------------- 3. every text another member reads is checked
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: [ask("a seed investor for climate hardware")] });
  const noor = addMember({ first_name: "Noor", blockers: [BLOCKER], intent: [ask("backing climate hardware founders at seed", "offering"), ask(PRIVATE_ASK, "seeking", false)] });
  // Share reasons (the network and in-room gate).
  const facts = await G.gatherNetworkFacts(jordan.id, noor.id, `what they've said they can offer: "backing climate hardware founders at seed"`);
  check("share reason: their own shared ask passes", G.checkShareReason(facts).pass, G.checkShareReason(facts));
  const echoReason = { ...facts, shareReason: `what they've said they can offer: "backing climate hardware founders at seed, before a quiet move to Lisbon"` };
  check("share reason: one that echoes a private ask is refused (only a shared ask, word for word, is ever a reason)", !G.checkShareReason(echoReason).pass, G.checkShareReason(echoReason));
  const privateAsReason = { ...facts, shareReason: `what they've said they're looking for: "${PRIVATE_ASK}"` };
  check("share reason: a private ask itself is never a reason", !G.checkShareReason(privateAsReason).pass);
  const sharedEcho = { ...facts, candidateStatedAsks: ["backing climate hardware founders before my divorce is final"], shareReason: `what they've said they can offer: "backing climate hardware founders before my divorce is final"` };
  check("share reason: a shared ask that touches what they're going through is still refused (sensitive topic)", !G.checkShareReason(sharedEcho).pass, G.checkShareReason(sharedEcho));
  // Value lines (in-room).
  const [sj, sn] = await Promise.all([RM.gatherValueSide(jordan.id), RM.gatherValueSide(noor.id)]);
  check("value line: Noor's side carries her hidden part", JSON.stringify(sn.hiddenTexts) === JSON.stringify([PRIVATE_ASK, BLOCKER]), sn.hiddenTexts);
  const judged = (forFirst: string) => ({ forFirst, forSecond: "Jordan is building climate hardware and looking for exactly the seed backing you offer.", verdict: "strong" as const, why: "fit", judged: { first: true, second: true } });
  const jFirst = jordan.id < noor.id;
  const vl = (line: string) => (jFirst ? RM.checkValueLines(judged(line), sj, sn, G.SENSITIVE, ["Noise Supper", "Jordan", "Noor"]) : RM.checkValueLines({ ...judged(line), forFirst: judged(line).forSecond, forSecond: line }, sn, sj, G.SENSITIVE, ["Noise Supper", "Jordan", "Noor"]));
  check("value line: one resting on her shared ask passes", vl("Noor backs climate hardware founders at seed, which is exactly the check you're raising.").ok, vl("Noor backs climate hardware founders at seed, which is exactly the check you're raising.").checks.filter((c) => !c.pass));
  check("value line: one hinting at her move refuses the intro", !vl("Noor backs climate hardware founders at seed, and she's moving to Lisbon soon, so catch her tonight.").ok);
  // Consent drafts (nudges, direct asks, reveals): the shared check every draft passes through.
  const ctx = { otherUserIds: [noor.id], said: ["backing climate hardware founders at seed"], facts: { otherFirstName: "Noor", recipientFirstName: "Jordan" } as any };
  check("draft: a clean nudge passes", (await C.hiddenEchoCheck("Noor is here tonight and backs climate hardware founders at seed.", ctx))?.pass === true);
  check("draft: a nudge echoing her blocker is refused", (await C.hiddenEchoCheck("Noor is here tonight. Her divorce is dragging on, so be kind.", ctx))?.pass === false);
  check("draft: a nudge paraphrasing her private ask is refused", (await C.hiddenEchoCheck("Noor is here tonight, before she moves to Lisbon.", ctx))?.pass === false);
  const sentBefore = W.sent.length;
  const drafted = await C.draftWithConsent(
    { decision: "eval.hiddenSignals", recipientId: jordan.id, facts: { otherFirstName: "Noor", otherOptedIn: false, recipientOptedIn: false, recipientFirstName: "Jordan", otherStatedAsks: ["backing climate hardware founders at seed"] } as any, otherUserIds: [noor.id], said: ["backing climate hardware founders at seed"] },
    async () => "Noor backs climate hardware founders at seed. Heads up, she's moving to Lisbon when her lease ends.",
  );
  check("draft: draftWithConsent sends nothing when every draft echoes the hidden part", drafted === null && W.sent.length === sentBefore, drafted);
  // A failed read withholds the draft and the email (fails closed).
  const real = (pool as any).query;
  (pool as any).query = async (sql: string, p?: any[]) => (/FROM co_profiles WHERE user_id = \$1/.test(sql) ? Promise.reject(new Error("db down")) : real(sql, p));
  const failedDraft = await C.hiddenEchoCheck("Noor is here tonight.", ctx);
  const failedEmail = await N.introEmailHiddenCheck(`what they've said they can offer: "backing climate hardware founders at seed"`, [jordan.id, noor.id]);
  (pool as any).query = real;
  check("draft: a failed read of the hidden part withholds the draft", failedDraft?.pass === false, failedDraft);
  check("email: a failed read holds the network intro email", failedEmail.pass === false, failedEmail);
  // The network intro email's reason, against both members' hidden parts.
  check("email: a shared-ask reason passes", (await N.introEmailHiddenCheck(`what they've said they can offer: "backing climate hardware founders at seed"`, [jordan.id, noor.id])).pass);
  check("email: a reason echoing either member's hidden part is held", !(await N.introEmailHiddenCheck("backing climate hardware founders, before a quiet move to Lisbon", [jordan.id, noor.id])).pass);
}

// ---------------------------------------------------------------- 4. pins: the checks sit on every path, and no path proposes without a share reason
{
  const consent = src("src/harness/introConsent.ts");
  check("every consent draft runs the hidden check (checkWithPrivacy)", /const hid = await hiddenEchoCheck\(draft, ctx\);\n\s*if \(hid && !hid\.pass\) return/.test(consent));
  check("value lines run it for each side", /checkNoHiddenEcho\(line, other\.hiddenTexts \?\? \[\]/.test(src("src/services/roomMatching.ts")));
  check("share reasons stay pinned to a shared ask, word for word", /if \(!f\.candidateStatedAsks\.some\(\(a\) => norm\(a\) === norm\(quoted\)\)\) return \{ name, pass: false, reason: "not an ask they marked shareable" \};/.test(src("src/harness/matchGate.ts")));
  check("the network intro email runs it before sending", /checkBothYes\(aYes, bYes\), await introEmailHiddenCheck\(matchReason, \[a\.user_id, b\.user_id\]\)/.test(src("src/services/networkIntroNudge.ts")));
  check("the room path hands its private asks to the scorer as hidden, kept apart from the guests", /const hiddenAsks = new Map\(matched\.map\(\(g\) => \[g\.user_id, privateAskTexts\(g\.intent\)\] as const\)\);/.test(src("src/services/eventScoring.ts")) && /hints,\n\s*hiddenAsks,\n\s*\);/.test(src("src/services/eventScoring.ts")));
  check("the network sweep loads first names, so the name strip works there", /SELECT user_id, first_name, goals, blockers, activity_preferences, intent FROM \(\n\s*SELECT cp\.user_id, u\.first_name,/.test(src("src/services/relevance.ts")) && /first_name: r\.first_name \?\? undefined,/.test(src("src/services/relevance.ts")));
  check("no reason, no intro: the in-room nudge needs a share reason", /if \(!top\.shareReason\) return false;/.test(src("src/services/eventScoring.ts")));
  check("... the additive reveal too", /r\.shareReason && r\.score >= MATCH_NUDGE_MIN_SCORE/.test(src("src/services/eventGuestMatchHandoff.ts")));
  check("... the network intro too", /re\.share_reason IS NOT NULL AND re\.share_reason <> ''/.test(src("src/services/networkIntroNudge.ts")));
  check("... the event brief and the pre-arrival count too", /!r\.shareReason\?\.trim\(\)/.test(src("src/services/eventBrief.ts")) && /r\.score >= PRE_ARRIVAL\.strongScore && r\.shareReason/.test(src("src/services/preArrival.ts")));
}

console.log(`matching hidden signals: ${results.total - results.failed}/${results.total} passed`);
process.exit(results.failed ? 1 : 0);
