// Model-free checks for delivery discipline (Royce, 2026-10-03): Co never asks
// what it can't answer, never dangles what it can't hand over, never asks again
// what they already answered, and never reacts twice to one message. Built from
// the real thread of 2026-10-02/03. No API calls, no database:
//   npx tsx evals/delivery/rules.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { candidateChecks, TYPE_POLICY } = await import("../../src/harness/proactive.js");
type Candidate = import("../../src/harness/proactive.js").Candidate;
const { repeatedQuestion, repeatQuestionCheck, sameQuestion, saidYes, turnsFromConversation } = await import("../../src/harness/repeatAsk.js");
const { codeChecks, createReplyFacts, offersLinkWithoutOne, stripUnsupported, addFact } = await import("../../src/harness/replyGrounding.js");
const { checkShareReason, TEMPLATE_PREFIX } = await import("../../src/harness/matchGate.js");
const { asksForLink, findLines, linkRequestInstruction, relevantFinds } = await import("../../src/services/researchFinds.js");
const { claimReaction, confirmReaction, REACTION_LEDGER_MS, reactedTo, releaseReaction, resetReactionLedger } = await import("../../src/services/tapbacks.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const read = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- the Pitch Protocol loop (10/02, 7:40-8:27 PM)
const pitch = [
  "Co replied: Found it: Pitch Protocol is agent-native VC infrastructure, built by GFV Studio, you submit once and get matched to thesis-aligned funds with a decision in about 48 hours.",
  "Co replied: That's more a funding-matching tool than a partnership play for your event, worth knowing but not obviously the business partner angle you're after. Want me to dig into whether they'd fit as an accelerator/VC lead instead?",
  "User said: Es",
].join("\n");
// What Co actually sent next (not word for word the first).
const reask = "Want me to dig into whether Pitch Protocol fits as an accelerator/VC lead?";
check("the real loop: after their 'Es', the question asked again in other words is caught", repeatedQuestion(reask, turnsFromConversation(pitch))?.question === reask);
check("...in the grounding check, with a reason that names the question", (() => { const c = repeatQuestionCheck(reask, pitch); return !c.pass && c.reason!.includes(reask); })());
check("a yes is recognised in its everyday forms and typos, not in other answers", ["Yes", "yeah", "Es", "Sure", "ok", "Send it", "I wanna try it", "yes please"].every(saidYes) && !["Not now", "What do you mean?", "Keep digging", "Hmm"].some(saidYes));
check("a different question, or the first time asking, is not", repeatedQuestion("Which accelerator are you leaning toward?", turnsFromConversation(pitch)) === null && repeatedQuestion(reask, turnsFromConversation(pitch.split("\n").slice(0, 2).join("\n"))) === null);
const noYes = pitch.replace("User said: Es", "User said: Hmm, what do you mean");
check("without a yes, only a near-copy is a repeat: a reworded question after a non-answer is a fair clarification", repeatedQuestion(reask, turnsFromConversation(noYes)) === null && repeatedQuestion("Want me to dig into whether they'd fit as an accelerator/VC lead instead?", turnsFromConversation(noYes)) !== null);
// Review of #59: these must never be blocked.
const askedTwice = (q: string, reply = "idk") => repeatedQuestion(q, turnsFromConversation(`Co replied: ${q}\nUser said: ${reply}`));
check("safety, consent and call questions can always be asked again", ["Are you safe right now?", "Are you thinking about hurting yourself?", "Is it ok if I text you tomorrow?", "Want to hop on a call?"].every((q) => askedTwice(q) === null && askedTwice(q, "yes") === null));
check("an ordinary check-in is never a loop without a yes, even asked twice", ["How are you holding up?", "How's your week going?", "What's going on with you these days?"].every((q) => askedTwice(q) === null));
check("...but a short offer they said yes to, asked again, still is", askedTwice("Want to hear who?", "Sure")?.question === "Want to hear who?");
check("a different subject after a yes isn't a repeat (the Nopa venue, then the SOMA loft)", repeatedQuestion("Want me to look into the SOMA loft?", turnsFromConversation("Co replied: Want me to look into the Nopa venue?\nUser said: yes")) === null);
check("a question they haven't had time to answer isn't a repeat (nothing from them since)", repeatedQuestion(reask, turnsFromConversation(pitch.split("\n").slice(0, 2).join("\n"))) === null);
check("a reply-to note on their text isn't read as what they said", turnsFromConversation("User said: Cool [Replying to Cue's text: \"Want to hear who?\"]")[0].text === "Cool");

// ---------------------------------------------------------------- the tease loop (10/03, 9:30 AM and 1:00 PM)
const tease = [
  "Co replied: Hey, know Friday's close and that's a lot to carry. Separate from that, someone in the network came to mind for you, fits what you've been looking for. Want to hear who?",
  "User said: Sure",
  "Co replied: Sorry for the false start.",
].join("\n");
check("'Want to hear who?' sent again after their yes and a non-answer is caught", repeatedQuestion("Someone came to mind for you, Royce. Want to hear who?", turnsFromConversation(tease))?.question === "Want to hear who?");
check("the sentence is cut from the reply and the rest stays", stripUnsupported("Someone came to mind. Want to hear who?", [{ name: "no_repeat_question", pass: false, reason: `asks again what they already answered: "Want to hear who?"` }]) === "Someone came to mind.");
check("short questions with too few words are never matched on a coincidence", !sameQuestion("Ready?", "Ready?") && !sameQuestion("Want it?", "Want it?"));
const cand = (type: string): Candidate => ({ id: "1", userId: "u", type, targetKey: `${type}:1`, topicKey: `${type}:1`, summary: "", priority: 50, dueAt: new Date(0), expiresAt: null, payload: {}, attempts: 0, createdAt: new Date(0) }) as unknown as Candidate;
const st = (undeliveredYes: boolean) => ({ now: new Date("2026-10-03T20:00:00Z"), sends: [], lastInboundAt: null, undeliveredYes }) as any;
check("a new tease is held while an earlier yes is still owed its answer", candidateChecks(cand("network_tease"), st(true)).some((c) => c.name === "no_undelivered_yes" && !c.pass));
check("...and goes once that clears; other kinds of text are never held by it", !candidateChecks(cand("network_tease"), st(false)).some((c) => c.name === "no_undelivered_yes") && !candidateChecks(cand("ask_checkin"), st(true)).some((c) => c.name === "no_undelivered_yes") && TYPE_POLICY.network_tease !== undefined);

// The privacy check no longer fails on Co's own wording (the 'what ve said' shingle).
const reason = `what they've said they're looking for: "Looking for good founder or tech events this weekend"`;
const facts = (privateTexts: string[]) => ({ shareReason: reason, candidateStatedAsks: ["Looking for good founder or tech events this weekend"], candidatePrivateTexts: privateTexts, alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true });
check("Cue's own template wording in the candidate's memories doesn't fail the reveal check", checkShareReason(facts(["Co replied: from what they've said they're looking for I thought of you"])).pass && TEMPLATE_PREFIX.test(reason));
check("but a real quote of their private text still does", !checkShareReason({ ...facts(["I keep thinking about founder or tech events"]), shareReason: `what they've said they're looking for: "founder or tech events this weekend"`, candidateStatedAsks: [] }).pass || !checkShareReason({ ...facts(["quietly raising money while burned out and worried about runway"]), shareReason: "quietly raising money while burned out and worried about runway" }).pass);

// The tease can't go out without its answer.
const reg = read("harness/proactiveRegistry.ts");
const nin = read("services/networkIntroNudge.ts");
check("a tease is checked and its reveal drafted before it's sent; if it can't be, it isn't", /const prepared = await prepareReveal\(c\.userId, person\.firstName, candidate\);[\s\S]{0,260}if \("why" in prepared\)/.test(reg) && /c\.payload\.preparedReveal = prepared\.message/.test(reg));
check("a failed draft retries in an hour; only a gate that said no is final", /prepared\.retry \? \{ defer: new Date\(Date\.now\(\) \+ 3_600_000\)/.test(reg) && /\{ why: "the reveal couldn't be drafted", retry: true \}/.test(nin) && /privacy check on the reveal wouldn't pass", retry: false/.test(nin));
check("a stored reveal is redrafted if the other person's consent changed since", /\(await networkOptedIn\(candidateId, userId\)\) === pending\.revealOptedIn/.test(nin) && /revealOptedIn: preparedRevealOptedIn === true/.test(reg));
check("the held-tease rule is rechecked at send time too", /undeliveredYes: c\.type === "network_tease" \? await import/.test(read("harness/proactive.ts")));
// Snapshot step 3: the text reply has no generic memory read left (it reads the snapshot), so find rows can't reach one.
check("find rows stay out of the generic memory reads (the text reply has none left)", !/FROM co_memories WHERE user_id = \$1 AND memory_type NOT IN/.test(read("routes/sendblue.ts")) && !/content_embedding <=>/.test(read("routes/sendblue.ts")));
check("the reveal is stored with the tease, and a yes sends that stored message", /preparedReveal \? \{ reveal: preparedReveal, revealOptedIn/.test(reg) && /pending\.reveal && stillConsented \? pending\.reveal : await draftReveal\(/.test(nin) && /gateNetworkCandidate\(userId, candidate\.candidate_id, candidate\.match_reason, "reveal"\)/.test(nin));
check("the undelivered-yes lookup is read before every pick", /import\("\.\.\/services\/networkIntroNudge\.js"\)\.then\(\(m\) => m\.lastTeaseUndelivered\(userId\)\)[\s\S]{0,1500}undeliveredYes,/.test(read("harness/proactive.ts")) && /const member = await memberSendState\(userId, person, now\);/.test(read("harness/proactive.ts")) && /s\.memory_type = 'network_intro_offer_pending' AND s\.created_at > r\.created_at/.test(nin));
check("proactive drafts get the repeat-question check too, so a repeat is redrafted or dropped", /const withRepeat = \(checks: GateCheck\[\], text: string\)/.test(read("harness/proactive.ts")) && (read("harness/proactive.ts").match(/withRepeat\(checkDraft\(/g) ?? []).length === 2);

// ---------------------------------------------------------------- the missing link (10/02, 8:26-8:27 PM)
const rf = createReplyFacts();
const none = codeChecks("Want me to send you the link?", rf, { recentConversation: "", message: "", sentThisTurn: [] } as any);
check("offering to send a link with none on file fails the check", none.some((c) => c.name === "no_link_offer_without_link" && !c.pass));
check("...and the offer sentence is cut from the reply", stripUnsupported("Found them. Want me to send you the link?", none) === "Found them.");
addFact(rf, "known", findLines([{ name: "Pitch Protocol", url: "https://pitchprotocol.vc", facts: "agent-native VC", at: "2026-10-03T03:40:00Z" }])[0]);
check("with the link on file the same offer is fine", !codeChecks("Want me to send you the link?", rf, { recentConversation: "", message: "", sentThisTurn: [] } as any).some((c) => c.name === "no_link_offer_without_link"));
check("offers that aren't about a link are left alone", offersLinkWithoutOne("Want me to look into them?", "") === null && offersLinkWithoutOne("I'll send you the link", "") !== null && offersLinkWithoutOne("I can share the site", "") !== null);
check("a researched find reads as a link Cue has and should send when asked", /have its link: https:\/\/pitchprotocol\.vc/.test(findLines([{ name: "Pitch Protocol", url: "https://pitchprotocol.vc", facts: "", at: "" }])[0]) && /send this link/.test(findLines([{ name: "x", url: "https://x.co", facts: "", at: "" }])[0]));
check("'send it' and 'send the link again' are asking for a link; ordinary texts, and sending something else, aren't", ["Send the link again", "Nah just send it", "Send it", "what's their website", "ok please send that"].every(asksForLink) && !["Plan out the event though", "Keep digging", "Yes", "I'll send it to my boss", "we'll be on site Friday", "Do you think we can send them an invite"].some(asksForLink));
const finds = [
  { name: "Pitch Protocol", url: "https://pitchprotocol.vc", facts: "", at: "3" },
  { name: "South Park Commons", url: "https://southparkcommons.com", facts: "", at: "2" },
  { name: "Nopa Private Events", url: "https://nopasf.com/private-events", facts: "", at: "1" },
];
check("only the finds that matter are shown: those named, plus the newest if they ask for a link; none otherwise", relevantFinds(finds, "Send it", "Cue: Pitch Protocol is a funding matchmaker", true)[0].name === "Pitch Protocol" && relevantFinds(finds, "How's the weather", "", false).length === 0 && relevantFinds(finds, "what about south park", "", false).map((f) => f.name).join() === "South Park Commons" && relevantFinds(Array.from({ length: 10 }, (_, i) => ({ name: `Thing${i}`, url: `https://t${i}.co`, facts: "", at: "" })), "send the link", "", true).length === 3);
check("offering an invite link is Cue's own to make, so it isn't cut for lacking a researched one", offersLinkWithoutOne("Want me to send you your invite link?", "") === null && offersLinkWithoutOne("Want me to send you the link?", "") !== null);
check("with a link on file Cue is told to send it; with none, to look it up now instead of shrugging", /send the one you have on file/.test(linkRequestInstruction("Send it", true) ?? "") && /look it up now/.test(linkRequestInstruction("Send it", false) ?? "") && /Don't ask permission and don't say you can't/.test(linkRequestInstruction("Send it", false) ?? "") && linkRequestInstruction("Keep digging", false) === null);
const lt = read("agent/loopTools.ts");
const rg = read("harness/replyGrounding.ts");
check("a web search stores what it kept, at research time, and every reply reads them back", /recordResearchFinds\(ctx\.userId, r\.kept\.map/.test(lt) && /for \(const line of findLines\(finds\)\) addFact\(rf, "known", line\)/.test(rg) && /linkRequestInstruction\(message, /.test(rg));

// ---------------------------------------------------------------- the double tapback
resetReactionLedger();
const t0 = 1_800_000_000_000;
check("the first reaction to a message is allowed, the second (any emoji, any path) is not", claimReaction("msg-A", t0) === true && claimReaction("msg-A", t0 + 1000) === false && claimReaction("msg-B", t0 + 1000) === true);
confirmReaction("msg-A");
check("a confirmed reaction counts as reacted", (await reactedTo("msg-A", t0 + 1500)) === true);
check("one still in flight counts only if it lands: the closing tool waits for it", await (async () => { const p = reactedTo("msg-B", t0 + 1500, 500); confirmReaction("msg-B"); return (await p) === true; })());
claimReaction("msg-C", t0 + 2000);
const failing = reactedTo("msg-C", t0 + 2100, 500);
releaseReaction("msg-C");
check("...and if it fails, the closing tool is free to react or reply (the review's silent-turn case)", (await failing) === false && claimReaction("msg-C", t0 + 2200) === true);
claimReaction("msg-D", t0);
check("a send that never settles doesn't hang the turn", (await reactedTo("msg-D", t0 + 10, 50)) === false);
check("the ledger forgets a message after a day", claimReaction("msg-A", t0 + REACTION_LEDGER_MS + 5000) === true);
const sb = read("services/sendblue.ts");
const ct = read("agent/conversationTools.ts");
check("every send goes through the ledger, is confirmed only when Sendblue accepts it, and a failed send releases it", /if \(!claimReaction\(messageHandle\)\)/.test(sb) && (sb.match(/releaseReaction\(messageHandle\)/g) ?? []).length >= 3 && /confirmReaction\(messageHandle\);\s*return true;\s*\} catch/.test(sb));
check("the closing tapback waits for an early one and doesn't add a second to a message that has one", /if \(!ctx\.dryRun && \(await reactedTo\(ctx\.messageHandle\)\)\)/.test(ct) && /already have a reaction from you on this message/.test(ct));
check("each reaction logs which message it was on, so a double can be audited", /handle: ackHandle\.slice\(-8\)/.test(read("routes/sendblue.ts")) && /handle: ctx\.messageHandle \? ctx\.messageHandle\.slice\(-8\) : null/.test(ct));

console.log(`delivery discipline rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
