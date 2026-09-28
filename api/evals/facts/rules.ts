// Model-free checks for Co's connected facts (services/coFacts.ts,
// services/peopleGraph.ts, 2026-09-26): the record of Co's actions, the
// people graph, and who may see what. No model, no DB.
//
//   npx tsx evals/facts/rules.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const F = await import("../../src/services/coFacts.js");
const G = await import("../../src/services/peopleGraph.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ------------------------------------------------ Co's actions
check("a shared link is a send, with its url", JSON.stringify(F.toolAction("shareLink", { urls: ["https://lu.ma/x"] })) === JSON.stringify([{ relation: "sent", label: "the link https://lu.ma/x", url: "https://lu.ma/x" }]));
check("a search is recorded as what was looked for", F.toolAction("searchNow", { what: "run clubs in Oakland" })?.[0].label === "run clubs in Oakland");
check("saving an ask is recorded in their words", F.toolAction("saveAsk", { what: "a hardware cofounder" })?.[0].label === "saved an ask to keep looking for: a hardware cofounder");
check("an intro names who it was with", /with Sam$/.test(F.toolAction("requestEventIntro", { personName: "Sam" })?.[0].label ?? ""));
check("tools that only read aren't actions", F.toolAction("listOpenAsks", {}) === null && F.toolAction("checkInvitesLeft", {}) === null && F.toolAction("sendReply", { message: "hi" }) === null);

const rows = [
  { relation: "sent", label: "AgentFi demo day at The Avalon during SF Tech Week", url: "https://x.com/i/status/1", at: new Date("2026-09-21T16:25:00Z") },
  { relation: "sent", label: "Mahjong After Dark", url: "https://lu.ma/mahjongafterdark", at: new Date("2026-09-24T23:00:00Z") },
  { relation: "searched", label: "chess or board game nights", url: null, at: new Date("2026-09-20T10:00:00Z") },
];
check("an older send is found when their message names it", F.rowsNamedIn(rows, "you never sent me the agentfi thing").map((r) => r.label).join() === "AgentFi demo day at The Avalon during SF Tech Week");
check("…or when Co's own last line named it", F.rowsNamedIn(rows, "Did anything come of AgentFi demo day at The Avalon?").length === 1);
check("common words don't pull in everything", F.rowsNamedIn(rows, "what did you send me about that event").length === 0);
check("a first text that carried a link reads as sending it", F.ledgerLine({ relation: "texted", label: "https://x.com/i/status/1 AgentFi demo day, Oct 7.", url: null, at: new Date("2026-09-21T16:25:00Z") }, "2026-09-27") === 'On 2026-09-21 Co sent them this link, unprompted: https://x.com/i/status/1, with: "AgentFi demo day, Oct 7."');
check("whole words only", F.rowsNamedIn([{ relation: "sent", label: "whatever you need", url: null, at: new Date() }], "did you ever send it").length === 0 && F.rowsNamedIn(rows, "the AgentFi thing").length === 1);
check("the same action recorded twice shows once", F.dedupeRows([rows[0], { ...rows[0], at: new Date(rows[0].at.getTime() + 60_000) }, rows[1]]).length === 2);
check("sends their message names, for answering from the record", F.sendsNamedIn(rows, "did you send me agentfi").length === 1 && F.sendsNamedIn(rows, "hey").length === 0);
check("the line says when and what, with the link", F.ledgerLine(rows[0]) === 'On 2026-09-21 Co sent them "AgentFi demo day at The Avalon during SF Tech Week" (https://x.com/i/status/1).');

// ------------------------------------------------ privacy
const priv = ["technical cofounder with hardware experience for robotics", "raising a pre seed round next month"];
check("a draft carrying a private fact is caught", F.carriesFact("You two should meet, they're raising a pre seed round next month", priv) !== null);
check("a draft without one passes", F.carriesFact("You two should meet, you're both building in robotics", priv) === null);
check("their own stated ask may be shared, even where a private fact overlaps it", F.carriesFact("What they've said they're looking for: a technical cofounder with hardware experience for robotics", priv, ["a technical cofounder with hardware experience for robotics"]) === null);
const ic = src("harness/introConsent.ts");
check("every consent draft is checked for the other member's private facts", /let result = await checkWithPrivacy\(text, ctx\);/.test(ic) && /const retryResult = await checkWithPrivacy\(retry, ctx\);/.test(ic));
const withOthers = ["services/eventScoring.ts", "services/eventGuestMatchHandoff.ts", "services/networkIntroNudge.ts"].map(src).join("\n");
check("every draft about another member names them for the check", (withOthers.match(/otherUserIds: \[/g) ?? []).length + (withOthers.match(/otherUserIds: newCandidates/g) ?? []).length >= 6);
check("the share-reason check treats inferred facts as private", /\.\.\.graphFacts,/.test(src("harness/matchGate.ts")));

// ------------------------------------------------ people graph
check("lists: short, plain, at most five", JSON.stringify(G.cleanList(["  ML engineer  ", "x", "a".repeat(3), "one two three four five six seven eight nine ten eleven twelve thirteen", 5, "b1", "c", "d", "e", "f", "g"])) === JSON.stringify(["ML engineer", "aaa"]));
const edges = G.bestEdges("A", [
  { wantOwner: "A", offerOwner: "B", want: "technical cofounder", offer: "ML engineering", sim: 0.72 },
  { wantOwner: "A", offerOwner: "B", want: "technical cofounder", offer: "runs a supper club", sim: 0.2 },
  { wantOwner: "B", offerOwner: "A", want: "product design help", offer: "product designer", sim: 0.8 },
  { wantOwner: "A", offerOwner: "C", want: "technical cofounder", offer: "pottery", sim: 0.1 },
  { wantOwner: "D", offerOwner: "A", want: "product design help", offer: "product designer", sim: 0.6 },
]);
check("the best link per person, both ways", edges.get("B")?.offer === "ML engineering" && edges.get("B")?.mutual === true && edges.get("B")?.score === 0.8);
check("a weak link isn't a link", !edges.has("C"));
check("only they want what the asker offers: a link, not a stated overlap", edges.get("D")?.want === null && edges.get("D")?.mutual === false);
check("the scorer's hint names both sides", /asker wants "technical cofounder" and this person offers "ML engineering" \(and it goes both ways\)/.test(G.edgeHint(edges.get("B")) ?? ""));
check("inferred wants and offers are owner-only", /'owner', 'peopleGraph'/.test(src("services/peopleGraph.ts")));
const es = src("services/eventScoring.ts");
check("scoring refreshes the room, reads the links, and hints the scorer", /await refreshRoom\(matched\.map/.test(es) && /await roomEdges\(person\.user_id/.test(es) && /askerContextParts\.join\("; "\) : undefined,\s*hints,/.test(es));
check("the shown reason is still their own stated ask", /shareReasonFromOwnAsk\(candidates\[r\.index\]\.intent\)/.test(src("services/matching.ts")));

// ------------------------------------------------ overpromising (2026-09-26)
{
  const { ongoingFactsFor } = await import("../../src/harness/replyGrounding.js");
  const { capabilitySheet } = await import("../../src/services/capabilities.js");
  const help = ongoingFactsFor([{ text: "Find sponsors for the event", kind: "help" }]);
  check("a help ask is never called searched", !help.some((f) => f.kind === "ongoing") && help.some((f) => /not something Co's search looks for/.test(f.text) && /nothing is being looked for or worked on in the background/.test(f.text)));
  const both = ongoingFactsFor([{ text: "a run club in Oakland", kind: "find" }, { text: "Find sponsors", kind: "help" }]);
  check("a find ask is, and only it", both.some((f) => f.kind === "ongoing" && /run club/.test(f.text) && !/sponsors/.test(f.text)));
  const sheet = capabilitySheet().join(" ");
  check("search says what it can't find, and what it can instead", /It can't find sponsors, investors, or funders themselves, but it can find events where they show up/.test(sheet));
  check("saving an ask says what isn't searched", /Finding sponsors, investors or funding themselves, and advice, are kept on file but not searched/.test(sheet));
  const rg = src("harness/replyGrounding.ts");
  check("every 'I can' is a capability claim, held to that exact thing", /every "I can…" is one, supported only by a capability FACT that covers that exact thing/.test(rg));
  check("background work is a promise too", /or says it's already doing in the background/.test(rg));
}

// ------------------------------------------------ missed reactions (2026-09-28)
{
  const R = await import("../../src/services/reactionCatchup.js");
  const sent = [{ name: "Rooftop evening" }, { name: "Mahjong After Dark" }];
  check("a reaction naming a send is a candidate", R.sentNamedIn("going to the rooftop evening thursday", sent).map((x) => x.name).join() === "Rooftop evening");
  check("a message naming nothing sent isn't", R.sentNamedIn("going to the gym tonight", sent).length === 0 && R.sentNamedIn("the event was fun", sent).length === 0);
  check("Co's tool and the safety net both see offers Co sent first, under the router's own keys", /FROM revealed_offers WHERE user_id = \$1/.test(src("services/reactionCatchup.ts")) && /await sentItems\(ctx\.userId\)/.test(src("agent/conversationTools.ts")) && /const sent = await sentItems\(userId\);/.test(src("services/reactionCatchup.ts")) && /recordSuggestionOutcome\(userId, match\.kind, match\.key/.test(src("services/reactionCatchup.ts")));
  check("the catch-up and Co's tool store reactions the same way", /REACTION_RESULT\[reaction\]/.test(src("agent/conversationTools.ts")) && /REACTION_RESULT\[reaction\]/.test(src("services/reactionCatchup.ts")));
  check("it runs after the reply, only when Co didn't record one", /toolsCalled\.includes\("noteReaction"\)/.test(src("services/reactionCatchup.ts")) && src("routes/sendblue.ts").includes("catchUpReaction(user.id, resolvedContent, toolsCalled ?? [], inlineTarget?.fromCo ? `${inlineTarget.text} ${inlineTarget.what ?? \"\"}`.trim() : null).catch"));
}

// ------------------------------------------------ inline replies (2026-09-28)
{
  const I = await import("../../src/services/inlineReply.js");
  const me = "+15551234567";
  check("a reply to Co's text in their thread is read", I.targetFromMessage({ content: "Rooftop evening Thursday: https://lu.ma/roof", is_outbound: true, number: me }, me)?.fromCo === true);
  check("a reply to their own text is read as theirs", I.targetFromMessage({ content: "can you find me a run club", is_outbound: false, from_number: me }, me)?.fromCo === false);
  check("a message from another member's thread is never read", I.targetFromMessage({ content: "Sam is raising a seed round", is_outbound: true, number: "+15559990000" }, me) === null && I.targetFromMessage({ content: "hi", is_outbound: false, from_number: "+15559990000" }, me) === null);
  check("an empty or missing message is nothing", I.targetFromMessage(null, me) === null && I.targetFromMessage({ content: " ", is_outbound: true, number: me }, me) === null);
  check("Co threads when they did, or when they've texted since", I.threadReason({ theyRepliedInline: true, newerTextSince: false }) === "mirror" && I.threadReason({ theyRepliedInline: false, newerTextSince: true }) === "newer_text");
  check("…and not otherwise, and never in a group", I.threadReason({ theyRepliedInline: false, newerTextSince: false }) === null && I.threadReason({ theyRepliedInline: true, newerTextSince: true, isGroup: true }) === null);
  const sb = src("routes/sendblue.ts");
  check("a refused inline reply goes again as a plain text", /reply_to: \{ message_handle: params\.replyTo \}/.test(sb) && /inline reply refused, sending it plain/.test(sb) && /await sendblue\.messages\.send\(body\);/.test(sb));
  check("the replied-to text reaches Co's facts and the record lookup", /addFact\(replyFacts, "known", repliedToFact\(inlineTarget\)\)/.test(sb) && /\$\{inlineTarget \? `\$\{inlineTarget\.text\}\\n` : ""\}/.test(sb));
  check("Co's reply sends through the threading check", /sendCoReply: threadedSend,/.test(sb));
  check("a bare link is recognized, a sentence with a link isn't", I.bareLink("https://lu.ma/grokbotproduct-sf") === "https://lu.ma/grokbotproduct-sf" && I.bareLink("see https://lu.ma/x for more") === null);
  check("the pressed text and the event it was for reach Co and the router", /They pressed Reply on this earlier text from Co/.test(I.repliedToFact({ text: "https://lu.ma/g", fromCo: true, what: "Grok Bot x Notion night", alsoInThread: "Testing" })) && /Grok Bot x Notion night/.test(I.inlineNote({ text: "https://lu.ma/g", fromCo: true, what: "Grok Bot x Notion night" })) && /message: inlineTarget \? `\$\{resolvedContent\} \$\{inlineNote\(inlineTarget\)\}` : resolvedContent,/.test(sb));
  check("the replied-to text is kept with their message", I.inlineNote({ text: "Rooftop evening, Thursday", fromCo: true }) === '[Replying to Co\'s text: "Rooftop evening, Thursday"]' && /\$\{inlineTarget \? ` \$\{inlineNote\(inlineTarget\)\}` : ""\}`;/.test(sb));
  check("a long replied-to text is shortened in the record", I.inlineNote({ text: "x".repeat(300), fromCo: false }).length < 260);
  check("the hold line and the first search result thread too", /await threadedSendAndLog\(holdLine\)/.test(sb) && /threadNextSend = true;\s*if \(prepared\.length > 1\)/.test(sb) && /await threadedSendAndLog\(m\.url\)/.test(sb));
}

// ------------------------------------------------ safety (2026-09-28)
{
  const S = await import("../../src/services/safetyText.js");
  const hits = ["honestly I don't want to be alive anymore", "everyone would be better off without me tbh", "I want to kill myself", "thinking about ending my life", "I'm not safe with myself tonight", "I've been suicidal lately"];
  const misses = ["this week is literally killing me lol", "I'd die for a good ramen spot", "killing it at work today", "my grandma passed last week", "I'm dying to see that show", "that set killed", "I want to end it with my cofounder"];
  check("unmistakable crisis wording is caught", hits.every((t) => S.soundsLikeCrisis(t)));
  check("figures of speech and ordinary sadness aren't", misses.every((t) => !S.soundsLikeCrisis(t)));
  check("the resource names 988 and 911", /\b988\b/.test(S.CRISIS_RESOURCES) && /\b911\b/.test(S.CRISIS_RESOURCES));
  const { capabilitySheet } = await import("../../src/services/capabilities.js");
  check("Co knows the resource as a fact, so the fact check never cuts it", capabilitySheet().some((l) => l.includes(S.CRISIS_RESOURCES)));
  const sb = src("routes/sendblue.ts");
  check("crisis wording adds the guidance and alerts, and Co's tool covers the rest", /if \(crisisWording\) \{\s*addInstruction\(replyFacts, SAFETY_INSTRUCTION\);\s*recordSafetyConcern\(/.test(sb) && /safetyConcern: crisisWording,/.test(sb) && /flagSafetyConcern: tool\(/.test(src("agent/conversationTools.ts")));
  check("no tapback in place of a reply when they may not be safe", /if \(ctx\.safetyConcern \|\| state\.safetyFlagged\) \{/.test(src("agent/conversationTools.ts")));
  const pr = src("harness/proactive.ts");
  check("offers wait while a safety hold is on; the next-day check-in doesn't wait on the last one", /state\.safetyHold && PROACTIVE_PURPOSE_MAP\[c\.type\] === "offer"/.test(pr) && /safetyFollowUp === true/.test(pr));
  check("calls: the prompt covers it, and their side of the transcript is checked after", /IF THEY MAY NOT BE SAFE/.test(readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8")) && /if \(soundsLikeCrisis\(theirLines\)\)/.test(src("routes/co.ts")));
  check("the team email never carries their message", !/\$\{note\}|\$\{what\}/.test(src("services/safety.ts").slice(src("services/safety.ts").indexOf("alertTeamNow("))));
}

// ------------------------------------------------ connecting the dots (2026-09-28)
{
  const D = await import("../../src/services/connectDots.js");
  check("no connections, nothing added", D.dotsInstruction([]) === null);
  const both = D.dotsInstruction([{ kind: "shape", link: "burned out; check in first", why: "taking a break" }, { kind: "mention", link: "the builders night is the 0-to-1 crowd", why: "builder community" }]) ?? "";
  check("a connection to make comes first, and how they're doing shapes the reply without silencing it", /^A connection worth making/.test(both) && /doesn't mean saying less/.test(both) && /don't lecture them/.test(both));
  const cd = src("services/connectDots.ts");
  check("only their own asks, threads and sends are read", (cd.match(/WHERE user_id = \$1/g) ?? []).length === 3 && !/other_user|otherUser/.test(cd));
  check("a thanks or sign-off leads nowhere", /A thanks, an ok, a sign-off or pure logistics leads nowhere: return none/.test(cd) && /parsed\?\.leads_somewhere !== false/.test(cd));
  const sb = src("routes/sendblue.ts");
  check("replies: found alongside the router, handed to Co before it drafts", /knownP = gatherDots\(user\.id\);\s*dotsP = knownP\.then/.test(sb) && /const dotsNote = dotsInstruction\(dots\);\s*if \(dotsNote\) \{\s*addInstruction\(replyFacts, dotsNote\);/.test(sb));
  const ev = src("agent/eventDiscoverySurfacing.ts");
  check("event offers: the connection can be the reason it fits, and isn't stripped as an identity claim", /how_this_connects_to_the_rest_of_their_life/.test(ev) && /stripUngroundedIdentity\(text, `\$\{askText\}\\n\$\{match\.name\}\\n\$\{dots\.join\("\\n"\)\}\\n\$\{why\}`\)/.test(ev));
}

// ------------------------------------------------ every link ties back to their why (2026-09-28)
{
  const { CO_WHY } = await import("../../src/services/coVoice.js");
  const D = await import("../../src/services/connectDots.js");
  check("the why rule: their words, where it could take them, never a promised outcome", /in their words/.test(CO_WHY) && /never a promised outcome/.test(CO_WHY) && /right track/.test(CO_WHY));
  check("their why reads as their asks and what they're in the middle of", D.whyContext({ asks: ["a builder community"], threads: [{ text: "deciding on accelerators", feeling: null }] }) === 'What they\'ve asked Co for: "a builder community". What they\'re in the middle of: deciding on accelerators.' && D.whyContext({ asks: [], threads: [] }) === "");
  const sb = src("routes/sendblue.ts");
  check("reacting to a link or an offer ties the reply back to their why", /reactingToSent = true;/.test(sb) && /if \(reactingToSent\) \{/.test(sb) && /They're reacting to something Co sent them\. \$\{CO_WHY\}/.test(sb));
  check("search captions and first offers carry the why, and it isn't stripped as an identity claim", /\$\{CO_WHY\}\$\{matchCount > 1/.test(sb) && /\\n\$\{em\.whyItFits \?\? ""\}\\n\$\{why\}`\)/.test(sb) && /their_why: why/.test(src("agent/eventDiscoverySurfacing.ts")));
  check("what kind of people events draw is advice; who specifically is there is a claim", /Not a claim: what kind of people events like this tend to draw/.test(src("harness/replyGrounding.ts")));
}

// ------------------------------------------------ wiring
check("every tool Co uses goes on the record", /await recordToolAction\(ctx\.userId, name, input\)/.test(src("agent/toolGuard.ts")));
check("every find Co sends goes on the record", /await recordSentItems\(/.test(src("services/recommendation.ts")));
check("every unprompted text goes on the record", (src("harness/proactive.ts").match(/recordProactiveText\(/g) ?? []).length >= 3);
check("Co's replies read the record, including older things they name", /const ledger = await ledgerFacts\(userId, opts\.context \?\? ""\)/.test(src("harness/replyGrounding.ts")) && /context: `\$\{resolvedContent\}/.test(src("routes/sendblue.ts")));
check("the record starts filled from what was already logged", /backfillCoActions\(\)/.test(src("db/migrations.ts")));

console.log(`facts rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
