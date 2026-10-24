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

// ---------------------------------------------------------------- 1b. review of #245: no additive offer that could never be revealed
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: [ask("a growth marketer")] });
  const ellis = addMember({ first_name: "Ellis", intent: [ask("growth marketing roles", "offering")] });
  // Kai fits only through a private ask: high score, nothing shareable, so no share reason.
  const kai = addMember({ first_name: "Kai", intent: [ask("growth marketing for B2B, kept private", "offering", false)] });
  const ev = addEvent({ api_id: "ev-add", name: "Noise Supper" }, [{ m: jordan }, { m: ellis }]);
  W.scorer = (_a, cand) => (cand.id === ellis.id ? { score: 80, share: true } : cand.id === kai.id ? { score: 95, share: false } : { score: 0, share: false });
  W.scoringDebounce.clear();
  await S.scoreGuestListForEvent("ev-add");
  await settle();
  const first = W.sent.filter((t) => t.to === jordan.phone_number).length;
  ev.guests.push({ email: kai.email, phone: null, name: kai.first_name, approval_status: "approved" });
  W.scoringDebounce.clear();
  W.additiveDebounce.clear();
  await S.scoreGuestListForEvent("ev-add");
  await settle();
  check("additive: Jordan was nudged about Ellis first", first === 1 && W.nudges.some((n) => n.person_id === jordan.id && n.candidate_id === ellis.id), W.nudges);
  check("additive: a late arrival with no share reason triggers no additive offer (it could never be revealed)", W.sent.filter((t) => t.to === jordan.phone_number).length === 1 && !W.llmCalls.some((c) => c.kind === "additiveDraft"), W.sent);
}

// ---------------------------------------------------------------- 1c. review of #245: the sensitive-topic backstop's new words
{
  const words: [string, string][] = [
    ["He's HIV positive", "recently diagnosed HIV positive"], ["She got a DUI", "dealing with a DUI charge"], ["He just came out as gay", "coming out to my family as gay"],
    ["She's transitioning", "I'm trans and transitioning"], ["He's trans", "I'm trans"], ["She got laid off", "I was laid off in March"], ["He was let go", "I was let go in May"],
    ["Living on severance", "living on my severance"], ["She's between jobs", "between jobs right now"], ["He lost a friend to suicide", "my brother's suicide"],
    ["She left an abusive marriage", "getting out of an abusive marriage"], ["Her abortion", "I had an abortion"], ["His affair", "my husband's affair"],
  ];
  for (const [text, hidden] of words) check(`sensitive: "${text}" is refused against "${hidden}"`, !!E.hiddenEcho(text, [hidden], [], [], G.SENSITIVE));
  const reasonFacts = (a: string) => ({ shareReason: `what they've said they're looking for: "${a}"`, candidateStatedAsks: [a], candidatePrivateTexts: [], alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true });
  // Decided 2026-10-19: a member's own shareable ask, quoted word for word, is consented, even with one of these words.
  check("sensitive: their own shareable ask, word for word, may carry one of the new words (consented)", G.checkShareReason(reasonFacts("a fresh start after I was let go")).pass, G.checkShareReason(reasonFacts("a fresh start after I was let go")));
  check("sensitive: the older words stay refused even in their own ask (the 2026-09-15 rule)", !G.checkShareReason(reasonFacts("help with my anxiety before pitches")).pass && !G.checkShareReason(reasonFacts("a therapist who works with founders")).pass);
  check("sensitive: a non-verbatim reason with one of the new words is refused", !G.checkShareReason({ ...reasonFacts("a fresh start"), shareReason: `what they've said they're looking for: "a fresh start after I was let go"` }).pass);
  // Re-review of #245: shared asks that only look like those words must still pass (a refusal here is a lost connection).
  for (const a of ["investors for a startup coming out of stealth", "our app came out last month, want beta users", "trans-pacific shipping founders", "an engineer for anti-abuse tooling", "let go of perfectionism and ship", "hiring after layoffs at big tech", "a podcast guest on current affairs"]) {
    check(`sensitive: the shared ask "${a}" is not refused`, G.checkShareReason(reasonFacts(a)).pass, G.checkShareReason(reasonFacts(a)));
    check(`sensitive: "${a}" isn't read as a private topic in a draft either`, E.hiddenEcho(a, ["something else entirely private"], [], [], G.SENSITIVE) === null);
  }
  // The narrowed forms and the hyphen rule matter for echoes too: hidden texts that really are sensitive, drafts that only look it.
  check("sensitive (echo): \"coming out of stealth\" doesn't echo \"coming out to my parents\"", E.hiddenEcho("her startup is coming out of stealth", ["I'm coming out to my parents soon"], [], [], G.SENSITIVE) === null);
  check("sensitive (echo): \"let go of perfectionism\" doesn't echo \"I was let go\"", E.hiddenEcho("she said to let go of perfectionism", ["I was let go in May"], [], [], G.SENSITIVE) === null);
  check("sensitive (echo): \"trans-pacific\" doesn't echo \"I'm trans\" (a prefix is never the word)", E.hiddenEcho("trans-pacific shipping founders", ["I'm trans and transitioning"], [], [], G.SENSITIVE) === null);
  check("sensitive (echo): the older words still read through a hyphen (\"anti-anxiety\" carries anxiety)", !!E.hiddenEcho("she's on anti-anxiety meds", ["dealing with anxiety"], [], [], G.SENSITIVE));
  check("sensitive (share reason): the older words still read through a hyphen in their own ask (\"anti-depressants\")", !G.checkShareReason(reasonFacts("someone to talk anti-depressants with")).pass);
  // Decided 2026-10-19: their own shareable ask is consented.
  check("sensitive: \"a gay founders dinner\" and \"a severance lawyer\" as the member's own shareable ask are allowed", G.checkShareReason(reasonFacts("a gay founders dinner")).pass && G.checkShareReason(reasonFacts("a severance lawyer")).pass);
  check("sensitive: the same words only in someone's hidden part are still refused in a text another member reads", !!E.hiddenEcho("Noor is going to a gay founders dinner", ["a gay founders dinner"], [], ["Noor"], G.SENSITIVE) && !!E.hiddenEcho("He needs a severance lawyer", ["a severance lawyer"], [], [], G.SENSITIVE));
  check("sensitive: ... and when it is their shared ask, a draft quoting it passes the echo check", E.hiddenEcho("Noor is hosting a gay founders dinner", ["coming out to my family"], [], ["Noor"], G.SENSITIVE, ["a gay founders dinner"]) === null);
  // Review of #245 (2026-10-19): only the member's OWN shareable text lets a sensitive word through, never anyone else's words.
  check("sensitive (whose words): another person's text never lets a word through (hidden \"I'm gay, not out\", allowed \"a gay founders dinner\")", E.hiddenEcho("he is gay", ["I'm gay, not out"], ["a gay founders dinner"], [], G.SENSITIVE) === 'touches something they keep private ("gay")', E.hiddenEcho("he is gay", ["I'm gay, not out"], ["a gay founders dinner"], [], G.SENSITIVE));
  check("sensitive (whose words): ... even when the text quotes that other person's words exactly", !!E.hiddenEcho("Ellis would love a gay founders dinner", ["I'm gay, not out"], ["a gay founders dinner"], ["Ellis"], G.SENSITIVE));
  check("sensitive (whose words): ... nor a word of the same family from someone else (\"a severance lawyer\" never clears \"gay\")", !!E.hiddenEcho("he is gay", ["I'm gay, not out"], [], [], G.SENSITIVE, ["a severance lawyer"]));
  check("sensitive (whose words): their own shareable ask carries it, but their hidden part does too: only a word-for-word quote passes", !!E.hiddenEcho("he is gay", ["I'm gay, not out"], [], [], G.SENSITIVE, ["a gay founders dinner"]) && E.hiddenEcho("He's hosting a gay founders dinner", ["I'm gay, not out"], [], [], G.SENSITIVE, ["a gay founders dinner"]) === null);
  check("sensitive (whose words): a quote plus the bare word again is still refused", !!E.hiddenEcho("He's hosting a gay founders dinner because he is gay", ["I'm gay, not out"], [], [], G.SENSITIVE, ["a gay founders dinner"]));
  // Joined forms (review of #245, 2026-10-19): "depress\w*" missed "antidepressants".
  for (const w of ["antidepressants", "antidepressant", "antianxiety meds", "a psychotherapist", "a neuropsychiatrist", "she was misdiagnosed"]) {
    check(`sensitive (joined): "${w}" is refused as a share reason`, !G.checkShareReason(reasonFacts(`someone who gets ${w}`)).pass, G.checkShareReason(reasonFacts(`someone who gets ${w}`)));
    check(`sensitive (joined): "${w}" is refused against a hidden text carrying it`, !!E.hiddenEcho(`she's into ${w}`, [`dealing with ${w}`], [], [], G.SENSITIVE));
  }
  check("sensitive: the narrowed words still catch the private ones", ["he came out to his parents", "she was let go in May", "I was laid off", "abused as a kid", "she is trans"].every((t) => !!E.hiddenEcho(t, [t], [], [], G.SENSITIVE)));
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
  // Review of #245 (2026-10-19): the exact case, through every reader. Ellis keeps "I'm gay, not out" private; Sam's own words
  // (ctx.said, his shared ask, his goals) carry "gay"; none of them lets the word through about Ellis.
  const ellis = addMember({ first_name: "Ellis", blockers: ["I'm gay, not out"], intent: [ask("backing climate hardware founders at seed", "offering")] });
  const sam = addMember({ first_name: "Sam", intent: [ask("a gay founders dinner")] });
  const ectx = { otherUserIds: [ellis.id], said: ["a gay founders dinner"], facts: { otherFirstName: "Ellis", recipientFirstName: "Sam", otherStatedAsks: ["a gay founders dinner"] } as any };
  const gayDraft = await C.hiddenEchoCheck("Ellis is here tonight and he is gay too.", ectx);
  check("draft (whose words): ctx.said and the facts never let \"gay\" through about Ellis", gayDraft?.pass === false && /gay/.test(gayDraft?.reason ?? ""), gayDraft);
  check("draft (whose words): a clean nudge about Ellis still passes", (await C.hiddenEchoCheck("Ellis is here tonight and backs climate hardware founders at seed.", ectx))?.pass === true);
  const gayEmail = await N.introEmailHiddenCheck(`what they've said they're looking for: "a gay founders dinner"`, [sam.id, ellis.id]);
  check("email (whose words): Sam's own shared ask never clears the word in Ellis's hidden part", gayEmail.pass === false, gayEmail);
  const [vs, ve] = await Promise.all([RM.gatherValueSide(sam.id), RM.gatherValueSide(ellis.id)]);
  const samReads = (line: string) => {
    const j = { forFirst: line, forSecond: "Sam is putting together a founders dinner and would value your climate hardware view.", verdict: "strong" as const, why: "fit", judged: { first: true, second: true } };
    return RM.checkValueLines(j, { ...vs, goals: ["host a gay founders dinner"] }, { ...ve, privateTexts: [...ve.privateTexts, "I'm gay, not out"] }, G.SENSITIVE, ["Noise Supper", "Sam", "Ellis"]);
  };
  const vlGay = samReads("Ellis backs climate hardware founders at seed, and he's gay too, so he'd get your dinner.");
  check("value line (whose words): the reader's own goal and ask never clear a word the other keeps private", !vlGay.ok && vlGay.checks.some((c) => !c.pass && /^(?:hidden|sensitive)_first$/.test(c.name)), vlGay.checks.filter((c) => !c.pass));
  check("value line (whose words): the sensitive backstop alone refuses it too (privateTexts)", vlGay.checks.some((c) => c.name === "sensitive_first" && !c.pass), vlGay.checks);
}

// ---------------------------------------------------------------- 4. pins: the checks sit on every path, and no path proposes without a share reason
{
  const consent = src("src/harness/introConsent.ts");
  check("every consent draft runs the hidden check (checkWithPrivacy)", /const hid = await hiddenEchoCheck\(draft, ctx\);\n\s*if \(hid && !hid\.pass\) return/.test(consent));
  check("value lines run it for each side", /checkNoHiddenEcho\(line, other\.hiddenTexts \?\? \[\]/.test(src("src/services/roomMatching.ts")));
  check("share reasons stay pinned to a shared ask, word for word", /if \(!f\.candidateStatedAsks\.some\(\(a\) => norm\(a\) === norm\(quoted\)\)\) return \{ name, pass: false, reason: "not an ask they marked shareable" \};/.test(src("src/harness/matchGate.ts")));
  check("the network intro email runs it before sending", /checkBothYes\(aYes, bYes\), await introEmailHiddenCheck\(matchReason, \[a\.user_id, b\.user_id\]\)/.test(src("src/services/networkIntroNudge.ts")));
  check("the room path hands its private asks to the scorer as hidden, kept apart from the guests", /const hiddenAsks = new Map\(matched\.map\(\(g\) => \[g\.user_id, privateAskTexts\(g\.intent\)\] as const\)\);/.test(src("src/services/eventScoring.ts")) && /hints,\n\s*hiddenAsks,\n\s*\{ askerFirstName: person\.first_name(?:, failLoudly: true)? \},\n\s*\)/.test(src("src/services/eventScoring.ts")));
  check("the network sweep loads first names, so the name strip works there", /SELECT user_id, first_name, goals, blockers, activity_preferences, intent FROM \(\n\s*SELECT cp\.user_id, u\.first_name,/.test(src("src/services/relevance.ts")) && /first_name: r\.first_name \?\? undefined,/.test(src("src/services/relevance.ts")));
  check("no reason, no intro: the in-room nudge needs a share reason", /if \(!top\.shareReason\) return false;/.test(src("src/services/eventScoring.ts")));
  check("... the additive reveal too", /r\.shareReason && r\.score >= MATCH_NUDGE_MIN_SCORE/.test(src("src/services/eventGuestMatchHandoff.ts")));
  check("... the network intro too", /re\.share_reason IS NOT NULL AND re\.share_reason <> ''/.test(src("src/services/networkIntroNudge.ts")));
  check("... the event brief and the pre-arrival count too", /!r\.shareReason\?\.trim\(\)/.test(src("src/services/eventBrief.ts")) && /r\.score >= PRE_ARRIVAL\.strongScore && r\.shareReason/.test(src("src/services/preArrival.ts")));
}

// ================================================================ no trace text for a prompt with hidden asks (review of #245 x #247)
// The room scoring prompt carries other members' hidden asks; our trace text (services/llmTraceText.ts, 14 days) is filed under
// the member it ran for, so a private ask removed by its owner would outlive the removal there. The call records no text at all.
{
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const local: any[] = [];
  const sdk = new NodeSDK({ spanProcessors: [{ onStart() {}, onEnd: (sp: any) => void local.push(sp), forceFlush: async () => {}, shutdown: async () => {} }] });
  sdk.start();
  const PRIVATE = "OSPREY-LANTERN-5120";
  const frame: any = { asks: [{ type: "seeking", text: "a seed investor for climate hardware", status: "active", shareable: true }], goal: null };
  const cand = (id: string, shareable: boolean) => ({ user_id: id, first_name: "Ellis", goals: ["back climate founders"], intent: [{ type: "offering", text: shareable ? "backing climate hardware at seed" : `going through ${PRIVATE}`, status: "active", shareable }] });
  await M.scoreAgainstRoomFrame(frame, [cand("c-hidden", false)] as any);
  await M.scoreAgainstRoomFrame(frame, [cand("c-shared", true)] as any, undefined, undefined, new Map([["c-shared", [`and ${PRIVATE}-2`]]]));
  await M.scoreAgainstRoomFrame(frame, [cand("c-plain", true)] as any);
  await sdk.shutdown();
  const room = local.filter((sp) => sp.attributes?.["ai.telemetry.functionId"] === "matching.scoreAgainstRoomFrame" && /doGenerate|doStream/.test(sp.name));
  const text = (sp: any) => JSON.stringify(sp.attributes);
  check("room scoring with a hidden ask: the call ran (three request spans)", room.length === 3, room.length);
  check("... a candidate's private ask in the prompt: no prompt or answer is recorded on the span", !!room[0] && !("ai.prompt.messages" in room[0].attributes) && !("ai.prompt" in room[0].attributes) && !("ai.response.text" in room[0].attributes) && !text(room[0]).includes(PRIVATE));
  check("... a hidden ask handed in: the same", !!room[1] && !("ai.prompt.messages" in room[1].attributes) && !text(room[1]).includes(PRIVATE));
  check("... nothing hidden in the prompt: recorded as before", !!room[2] && "ai.prompt.messages" in room[2].attributes);
}

console.log(`matching hidden signals: ${results.total - results.failed}/${results.total} passed`);
process.exit(results.failed ? 1 : 0);
