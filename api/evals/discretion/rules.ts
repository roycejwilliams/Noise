// Model-free checks for discretion (harness/discretion.ts, 2026-10-04): when a
// privacy or consent block trips, Co shows discretion, never an apology for
// nothing, a false start, a fragment or the machinery's words. No API calls, no
// database:
//   npx tsx evals/discretion/rules.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const D = await import("../../src/harness/discretion.js");
const { DISCRETION_GUIDE, DISCRETION_LINES, DISCRETION_MARK, NEUTRAL_LINES, NEUTRAL_MARK, apologyOnly, discreetFinal, discretionInstruction, discretionProblems, isDiscreetTurn, isNeutralTurn, pickDiscretion, usesApprovedLine } = D;
const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const { promptForElevenLabs } = await import("../../src/services/elevenLabsCalls.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

// ---- the approved set
check("a small set: between 6 and 10 lines", DISCRETION_LINES.length >= 6 && DISCRETION_LINES.length <= 10);
for (const l of DISCRETION_LINES) check(`approved line passes its own checks: "${l.slice(0, 48)}…"`, discretionProblems(l).length === 0);
check("no two lines are the same, and each stands alone (ends a sentence, no colon frame)", new Set(DISCRETION_LINES).size === DISCRETION_LINES.length && DISCRETION_LINES.every((l) => /[.]$/.test(l) && !/:\s*$/.test(l)));
check("no line apologizes, retracts, explains or names a rule", DISCRETION_LINES.every((l) => !/sorry|apolog|mistake|false start|privacy|policy|allowed|blocked|can't share|unable/i.test(l)));
check("no line claims anything about the other person or promises an action", DISCRETION_LINES.every((l) => !/\b(?:they|he|she)\s+(?:is|are|was|were|wants?|said|thinks?|feels?|will)\b/i.test(l) && !/\bI'll\b|\bI will\b|\bI'm (?:looking|working|checking)\b/i.test(l)));

// ---- what can never be sent after a block
const real = "Turns out that one's not available anymore, so I can't put you two in touch. Sorry for the false start.";
check("the real 10-03 reply is refused (explains, apologizes, false start)", discretionProblems(real).length >= 2);
check("so is what was left of it after the cut: a bare apology", discretionProblems("Sorry for the false start.").some((p) => /apology|fragment/.test(p)));
check("an apology for nothing is refused, however it's phrased", ["I'm sorry about that. That's theirs to tell, not mine. What I can speak to is what you've told me, and what I can do with it.", "My bad, scratch that. I keep what people tell me to myself. What I can say is what I know about you, and I'm glad to start there.", "Oops, forgive me. What someone else has shared stays with them. I can tell you what I know about you."].every((t) => discretionProblems(t).some((p) => /apology/.test(p))));
check("the reversal tell ('turns out ...') is refused on its own", discretionProblems(`Turns out that one isn't mine to tell. ${DISCRETION_LINES[0]}`).some((p) => /apology or a retraction/.test(p)));
check("a false start or retraction is refused", ["Let me redo that. Some things stay with the person who said them. I can tell you what I know about you.", "Actually, never mind that one. I'd rather let them speak for themselves. What I can do is go from what you've told me."].every((t) => discretionProblems(t).length > 0));
check("the machinery's words are refused", ["I can't share that because of privacy. I won't speak for them. What I can say comes from your side: what you've asked me for.", "That's blocked by my filter, so I won't speak for them. What I can say comes from your side: what you've asked me for.", "I'm not allowed to say. What someone else has shared stays with them. I can tell you what I know about you.", "That introduction fell through. What someone else has shared stays with them. I can tell you what I know about you."].every((t) => discretionProblems(t).some((p) => /machinery/.test(p))));
check("the flat dead end the grounding falls to is refused", discretionProblems("Honestly, I'm not sure on that one.").length > 0 && discretionProblems("Honestly, I'm not sure on that one. That one's theirs to tell, not mine. What I can speak to is what you've told me, and what I can do with it.").some((p) => /dead end/.test(p)));
check("a fragment and an empty reply are refused", discretionProblems("Got it.").some((p) => /fragment/.test(p)) && discretionProblems("")[0] === "empty");
check("naming or describing the other person is refused", discretionProblems(`${DISCRETION_LINES[0]} Maya sounded keen though.`, { otherNames: ["Maya"] }).some((p) => /names the other person/.test(p)));
check("a reply that isn't one of the approved lines is refused, even if polite", discretionProblems("I'd better not say anything about that, if that's alright with you.").some((p) => /approved/.test(p)));
check("an approved line, with one more short sentence of its own, passes", discretionProblems(`${DISCRETION_LINES[1]} Want to tell me more about what you're after?`).length === 0);
check("lines are matched through punctuation and case", usesApprovedLine(DISCRETION_LINES[2].toUpperCase().replace(/'/g, "’")));

// ---- review of #65
const [, , , , , , , , neutralA, neutralB] = DISCRETION_LINES;
check("two neutral lines exist for when they're waiting on Co's own offer, and say nothing of a secret", DISCRETION_LINES.length === 10 && /as far as I can take/.test(neutralA) && /stays where it is/.test(neutralB) && ![neutralA, neutralB].some((l) => /theirs|someone else|person who said|keep what people/i.test(l)));
const nInst = discretionInstruction("x", { neutral: true });
check("the neutral instruction offers only the two neutral lines and marks the turn neutral; the plain one offers all", NEUTRAL_LINES.every((l) => nInst.includes(l)) && !DISCRETION_LINES.slice(0, 8).some((l) => nInst.includes(l)) && nInst.includes(NEUTRAL_MARK) && isNeutralTurn([nInst]) && isDiscreetTurn([nInst]) && !isNeutralTurn([discretionInstruction("x")]) && DISCRETION_LINES.every((l) => discretionInstruction("x").includes(l)));
check("on a neutral turn only a neutral line is approved, and the backstop picks only from them", discretionProblems(DISCRETION_LINES[0], { lines: NEUTRAL_LINES }).some((p) => /approved/.test(p)) && discretionProblems(NEUTRAL_LINES[0], { lines: NEUTRAL_LINES }).length === 0 && Array.from({ length: 40 }, (_, i) => discreetFinal(real, `seed ${i}`, [], true, true).final).every((f) => NEUTRAL_LINES.includes(f as never)));
check("harmless extra sentences after an approved line are no longer wiped", ["I'm sorry to hear the week's been that rough.", "Turns out you already know half the founders going.", "I've blocked off time on Thursday for it.", "I'll ask your permission before I send anything.", "The system you built sounds solid.", "I'm not able to stop thinking about your pitch."].every((extra) => discretionProblems(`${DISCRETION_LINES[1]} ${extra}`).length === 0));
check("but a real retraction or machinery after the line still is", discretionProblems(`${DISCRETION_LINES[1]} Turns out that one isn't happening anymore.`).length > 0 && discretionProblems(`${DISCRETION_LINES[1]} That's blocked by my filter.`).length > 0 && discretionProblems(`${DISCRETION_LINES[1]} Sorry about the mix-up.`).length > 0 && discretionProblems(`${DISCRETION_LINES[1]} I'm not able to share that.`).length > 0);
const first = discreetFinal(real, "Sure! Also find me dinner Friday", [], true);
const later = discreetFinal("Want me to look at Friday dinner spots?", "Sure! Also find me dinner Friday", [], false);
check("on a turn with two replies, the first must be an approved line, a later real question is kept", first.replaced && usesApprovedLine(first.final) && !later.replaced && later.final === "Want me to look at Friday dinner spots?");
check("a later reply that apologizes or uses the machinery is dropped, not turned into the same line again", discreetFinal("Sorry about that, it fell through.", "x", [], false).final === "" && discreetFinal("Sorry about that, it fell through.", "x", [], false).replaced);
check("the other person's name is refused when the turn carries it", discretionProblems(`${DISCRETION_LINES[0]} Celine would love it.`, { otherNames: ["Celine"] }).some((p) => /names the other person/.test(p)) && discreetFinal(`${DISCRETION_LINES[0]} Celine would love it.`, "x", ["Celine"]).replaced);
check("the guide covers other members of Co only, and people in their own life are talked about freely", /another member of Co/.test(DISCRETION_GUIDE) && /only about members of Co/.test(DISCRETION_GUIDE) && /their boss, a date, family/.test(DISCRETION_GUIDE) && /freely/.test(DISCRETION_GUIDE));
const rg = read("src/harness/replyGrounding.ts");
const sb = read("src/routes/sendblue.ts");
check("a blocked tease reply gets no false 'sent a message naming them' fact, and the name is carried to the guard", /if \(isDiscreetTurn\(\[context\]\)\) \{[\s\S]*?replyFacts\.privateNames = \[\.\.\.\(replyFacts\.privateNames \?\? \[\]\), resolvedTease\.item\.ref\.pending\.candidate\.first_name\];\s*\} else if \(classification === "interested"\) \{\s*addFact\(replyFacts, "did_this_turn"/.test(sb));
check("grounding passes the names, the neutral set, and lets only a later discreet reply through the light check", /discreetFinal\(result\.final, src\.message, rf\.privateNames \?\? \[\], !rf\.discretionDone, isNeutralTurn\(rf\.instructions\)\)/.test(rg) && /if \(d\.final\.trim\(\)\) rf\.discretionDone = true;/.test(rg));
check("a link or card sent earlier in the turn doesn't exempt the first reply from the approved-line rule", !/sentThisTurn\?\.length\)\);/.test(rg.slice(rg.indexOf("isDiscreetTurn(rf.instructions)"), rg.indexOf("isDiscreetTurn(rf.instructions)") + 700)));
check("the tease-stage outcome is recorded without the name (a later reply reads it back as a fact)", /"an intro from the network \(name not shared\)"/.test(sb) && !/`an intro to \$\{teaseCandidate\.first_name\}`/.test(sb));

// ---- second review of #65
const after = (extra: string) => discretionProblems(`${DISCRETION_LINES[1]} ${extra}`);
check("claims about the other member are refused, after the line or alone", ["They said no.", "They're not open to it.", "They'd rather not be introduced.", "Something came up on their end.", "She passed on it.", "He declined."].every((x) => after(x).some((p) => /claim about the other person/.test(p)) && discretionProblems(x, { requireLine: false }).length > 0));
check("dead ends are refused", ["I can't put you two in touch.", "That intro won't happen.", "It's not happening.", "That's no longer an option.", "It got cancelled."].every((x) => after(x).length > 0));
check("retractions and hedges are refused", ["I spoke too soon.", "I jumped the gun.", "Ignore my last message.", "It was a mix-up.", "Unfortunately that's not possible.", "Unfortunately that's where it stands.", "That fell apart.", "It didn't work out.", "I shouldn't say.", "That's off limits.", "I'd get in trouble."].every((x) => after(x).length > 0));
check("over-blocks from the review pass now", ["Sorry you had to deal with that.", "I can't tell you how happy that makes me.", "I can't say I've been there.", "The road was blocked.", "How was dinner?", "I'd need permission from your manager to send that."].every((x) => after(x).length === 0));
check("a hyphenated or two-part name is caught", discretionProblems(`${DISCRETION_LINES[0]} Mary-Ann would love it.`, { otherNames: ["Mary-Ann"] }).some((p) => /names the other person/.test(p)) && discretionProblems(`${DISCRETION_LINES[0]} Mary Ann would love it.`, { otherNames: ["Mary-Ann"] }).some((p) => /names the other person/.test(p)));

// ---- the residue guard
check("a cut that leaves only an apology is caught", apologyOnly("Sorry for the false start.") && apologyOnly("Sorry about that.") && apologyOnly("My bad. Sorry for the mix-up."));
check("a real reply that also apologizes is not 'only an apology'", !apologyOnly("Sorry about that. Here's the link: https://lu.ma/abc and the start time is 6pm.") && !apologyOnly("") && !apologyOnly("Here's the link."));

// ---- what goes out on a blocked turn
const seed = "yes please";
const bad = discreetFinal(real, seed);
check("a bad reply to a block is replaced by an approved line", bad.replaced && usesApprovedLine(bad.final) && discretionProblems(bad.final).length === 0);
const good = discreetFinal(DISCRETION_LINES[3], seed);
check("a discreet reply from the model goes out as it wrote it", !good.replaced && good.final === DISCRETION_LINES[3]);
check("the fallback is the same for the same message, never the line used last", pickDiscretion(seed) === pickDiscretion(seed) && pickDiscretion(seed, pickDiscretion(seed)) !== pickDiscretion(seed));
check("an empty reply on a blocked turn becomes an approved line", discreetFinal("", seed).replaced);

// ---- the gate hands the model the lines, not an improvisation
const inst = discretionInstruction("They said yes to hearing who it was, and you can't go further on that one.");
check("the instruction offers every approved line and marks the turn", DISCRETION_LINES.every((l) => inst.includes(l)) && isDiscreetTurn([inst]) && inst.includes(DISCRETION_MARK));
check("it forbids apologies, 'fell through', reasons, machinery and naming", /Never apologize/.test(inst) && /fell through, isn't available, was a mistake or a false start/.test(inst) && /never explain or hint at a reason/.test(inst) && /never name, describe or guess/.test(inst));
check("it tells the model there is nothing to apologize for", /nothing to apologize for/.test(inst));
const nudge = read("src/services/networkIntroNudge.ts");
check("the reveal gate's block now uses it (no 'say so briefly and honestly', no 'isn't available anymore')", /const cantReveal = discretionInstruction\(/.test(nudge) && !/Say so briefly/.test(nudge) && !/isn't available anymore/.test(nudge));
check("the reveal block asks for the neutral lines (nothing suggests a secret when they're waiting on Co's own offer)", /discretionInstruction\([^;]*\{ neutral: true \}\);/.test(nudge));
check("both ways the reveal can be blocked use it (privacy check, and a reveal that couldn't be drafted)", (nudge.match(/return cantReveal;/g) ?? []).length === 2);

// ---- grounding
check("a blocked turn is held to the discretion checks before the reply is recorded", rg.indexOf("isDiscreetTurn(rf.instructions)") > rg.indexOf("const final = after ===") && rg.indexOf("isDiscreetTurn(rf.instructions)") < rg.indexOf('decision: "reply.grounding"') && /d\.replaced/.test(rg));
check("a cut that leaves only an apology is not shipped (it goes to the rewrite)", /enoughLeft\(cut, draft\) && !apologyOnly\(cut\)/.test(rg));
check("every text reply knows the lines (baseReplyFacts)", baseReplyFacts().instructions.some((i) => i === DISCRETION_GUIDE.trim()));
check("and so does every call", promptForElevenLabs("x").includes(DISCRETION_GUIDE));
check("the guide is for when someone asks Co to speak for another member, and keeps the no-apology rule", /never speak for another member/.test(DISCRETION_GUIDE) && /Never apologize for keeping a confidence/.test(DISCRETION_GUIDE));

console.log(`discretion rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
