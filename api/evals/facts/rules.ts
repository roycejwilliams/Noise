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
check("a search is recorded as what was looked for", F.toolAction("searchEvents", { what: "run clubs in Oakland", when: "this weekend" })?.[0].label === "run clubs in Oakland, this weekend" && F.toolAction("webSearch", { queries: ["DJ for hire SF", "thebash DJ San Francisco"] })?.length === 2);
check("what the loop shares is recorded as sent, with its link", F.toolAction("shareFinds", { items: [{ link: "https://x.example/a", caption: "A loft in SoMa" }] })?.[0].url === "https://x.example/a" && F.toolAction("shareFinds", { items: [{ link: "https://x.example/a", caption: "A loft in SoMa" }] })?.[0].relation === "sent");
check("a drafted email is recorded as drafted, never as sent", /drafted an email to events@wave\.sf/.test(F.toolAction("draftEmail", { to: "events@wave.sf", subject: "Oct 10?" })?.[0].label ?? "") && F.toolAction("draftEmail", { to: "a@b.co", subject: "x" })?.[0].relation === "did");
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
  // (2026-10-01) The old event-only search couldn't find sponsors or investors; Co's web search can find sponsor programs and funds, checked on their own pages.
  check("Co knows its web search covers venues, vendors, people and programs", /search the web for venues to book, vendors \(DJs, caterers, photographers\), people, places, programs/.test(sheet));
  check("saving an ask says what isn't searched", /Finding sponsors, investors or funding themselves, and advice, are kept on file but not searched/.test(sheet));
  const rg = src("harness/replyGrounding.ts");
  check("every 'I can' is a capability claim, held to that exact thing", (/every "I can…" is one/.test(rg) && /A capability needs a capability FACT covering that exact thing/.test(rg)));
  check("background work is a promise too", /or is already doing in the background/.test(rg));
}

// ------------------------------------------------ missed reactions (2026-09-28)
{
  const R = await import("../../src/services/reactionCatchup.js");
  const sent = [{ name: "Rooftop evening" }, { name: "Mahjong After Dark" }];
  check("a reaction naming a send is a candidate", R.sentNamedIn("going to the rooftop evening thursday", sent).map((x) => x.name).join() === "Rooftop evening");
  check("a message naming nothing sent isn't", R.sentNamedIn("going to the gym tonight", sent).length === 0 && R.sentNamedIn("the event was fun", sent).length === 0);
  check("Co's tool and the safety net both see offers Co sent first, under the router's own keys", /FROM revealed_offers\s+WHERE user_id = \$1/.test(src("services/turnContext.ts")) && /return loadSentItems\(userId\)/.test(src("services/reactionCatchup.ts")) && /ctx\.turn\?\.sent \?\? \(await sentItems\(ctx\.userId\)\)/.test(src("agent/conversationTools.ts")) && /const sent = sentList \?\? \(await sentItems\(userId\)\);/.test(src("services/reactionCatchup.ts")) && /recordSuggestionOutcome\(userId, match\.kind, match\.key/.test(src("services/reactionCatchup.ts")));
  check("the catch-up and Co's tool store reactions the same way", /REACTION_RESULT\[reaction\]/.test(src("agent/conversationTools.ts")) && /REACTION_RESULT\[reaction\]/.test(src("services/reactionCatchup.ts")));
  check("it runs after the reply, only when Co didn't record one", /toolsCalled\.includes\("noteReaction"\)/.test(src("services/reactionCatchup.ts")) && src("routes/sendblue.ts").includes("catchUpReaction(user.id, resolvedContent, toolsCalled ?? [], inlineTarget?.fromCo ? `${inlineTarget.text} ${inlineTarget.what ?? \"\"}`.trim() : null, turn?.sent).catch"));
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
  check("the 'looking' line and the first find thread too", /if \(!sent\.length && loop\.holdSent\) ctx\.threadNext\?\.\(\);/.test(src("agent/loopTools.ts")) && /threadNext: \(\) => \{\s*threadNextSend = true;/.test(sb) && /sendCoReply: threadedSend,/.test(sb));
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
  const ownerOnly = (t: string) => (t.match(/\bSELECT\b/g) ?? []).length === (t.match(/WHERE (owner_)?user_id = \$1/g) ?? []).length && !/other_user|otherUser/.test(t);
  check("only their own asks, threads, sends and lessons are read, here and in the turn's one picture", ownerOnly(cd) && ownerOnly(src("services/turnContext.ts")));
  check("a thanks or sign-off leads nowhere: connections only when they share or react", /"small_talk" \(thanks, ok, a sign-off\)/.test(cd) && /DOTS_MODES: Mode\[\] = \["sharing", "reacting"\]/.test(cd) && /dots: forReply && !DOTS_MODES\.includes\(mode\) \? \[\] : dots/.test(cd));
  const sb = src("routes/sendblue.ts");
  check("replies: found alongside the router from the turn's picture, handed to Co before it drafts", /dotsP = turnP\.then\(\(t\) =>\s*readMoment\(/.test(sb) && /const dotsNote = dotsInstruction\(dots\);\s*if \(dotsNote\) \{\s*addInstruction\(replyFacts, dotsNote\);/.test(sb));
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
  check("captions carry the why, and never say who they are beyond what they told Co", /tied to what they told you they want and the reason behind it/.test(src("services/capabilities.ts")) && /stripUngroundedIdentity\(it\.caption, known\)/.test(src("agent/loopTools.ts")) && /their_why: why/.test(src("agent/eventDiscoverySurfacing.ts")));
  check("what kind of people events draw is advice; who specifically is there is a claim", (/what kind of people events like this tend to draw/.test(src("harness/replyGrounding.ts")) && /Saying specific people will be there, or that they're the member's people, is other_person/.test(src("harness/replyGrounding.ts"))));
}

// ------------------------------------------------ one picture per turn (2026-09-28, services/turnContext.ts)
{
  const T = await import("../../src/services/turnContext.js");
  const now = Date.now();
  const grok = { key: "event:evt-1", name: "Grok Bot x Notion for Product Builders night (SF)", kind: "event" as const, url: "https://lu.ma/grokbotproduct-sf", sentAt: new Date(now - 3_600_000), reaction: null, postText: null, details: { startAt: "2026-09-30T00:00:00.000Z", endAt: null, timezone: "America/Los_Angeles", online: false, venue: null, address: null, city: "San Francisco", hosts: [], price: null, spotsRemaining: null, requiresApproval: null, soldOut: null, guestCount: null, description: null } };
  const dayt = { key: "name:daytonaio ai builders demo night", name: "daytonaio AI Builders Demo Night", kind: "opportunity" as const, url: "https://x.com/i/status/1", sentAt: new Date(now - 3_600_000), reaction: null, postText: null, details: null };
  const lines = T.sentDetailLines({ sent: [grok, dayt] });
  check("a recent send's start time is on file for the reply", /Details on file for "Grok Bot x Notion[^"]*"[^.]*starts Tuesday, September 29 at 5:00 PM/.test(lines[0] ?? "") && /Not on file: address/.test(lines[0] ?? ""));
  check("...and what isn't on file is said plainly", /Co sent them "daytonaio AI Builders Demo Night".*hasn't been read yet, so Co has no start time or address/.test(lines[1] ?? ""));
  check("an older send isn't loaded as a recent detail", T.sentDetailLines({ sent: [{ ...grok, sentAt: new Date(now - 9 * 86_400_000) }] }).length === 0);
  check("a first offer is found by the name Co's tool uses", T.findSent([grok, dayt], "daytonaio AI Builders demo night")?.key === "name:daytonaio ai builders demo night" && T.findSent([grok, dayt], "Grok Bot x Notion")?.key === "event:evt-1" && T.findSent([grok], "pottery") === undefined);
  const rg = src("harness/replyGrounding.ts");
  check("reply facts come from the turn's picture: sends with details, asks, record; the summary is a hint", /if \(opts\.turn\) for \(const line of sentDetailLines\(opts\.turn\)\) addFact\(rf, "known", line\);/.test(rg) && /addOngoingSearchFacts\(rf, userId, opts\.turn\?\.asks\)/.test(rg) && /addHint\(rf, `Co's summary of what they've told it: \$\{line\}`\)/.test(rg));
  const sb = src("routes/sendblue.ts");
  check("no separate partial loads left in the text route", !/sentDetailFacts|lessonsFor\(|gatherDots\(/.test(sb) && /lessons = turn\?\.lessons \?\? \[\]/.test(sb) && /turn,\n/.test(sb));
}

// ------------------------------------------------ wiring
check("every tool Co uses goes on the record", /await recordToolAction\(ctx\.userId, name, input\)/.test(src("agent/toolGuard.ts")));
check("every find Co sends goes on the record", /await recordSentItems\(/.test(src("services/recommendation.ts")));
check("every unprompted text goes on the record", (src("harness/proactive.ts").match(/recordProactiveText\(/g) ?? []).length >= 3);
check("Co's replies read the record, including older things they name", /const ledger = opts\.turn\?\.ledger \?\? \(await ledgerFacts\(userId, opts\.context \?\? ""\)/.test(src("harness/replyGrounding.ts")) && /ledgerFacts\(userId, `\$\{message\}\\n\$\{opts\.ledgerContext \?\? ""\}`\)/.test(src("services/turnContext.ts")) && /turnP = assembleContext\(user\.id, resolvedContent, \{\s*inlineTarget,\s*ledgerContext:/.test(src("routes/sendblue.ts")) && /turn: turn \?\? undefined,/.test(src("routes/sendblue.ts")));
check("the record starts filled from what was already logged", /backfillCoActions\(\)/.test(src("db/migrations.ts")));

// 2026-09-30: replies promised results ("I'll get you real options before Friday") that no search had found.
{
  const RG = await import("../../src/harness/replyGrounding.js");
  const bad = ["I'll keep digging and get you a couple of real options before Friday.", "On it, I'll dig up a couple of real caterer options for 60 people and get back to you before Friday.", "I'll find you one more indoor option so you've got a real choice by Friday.", "You'll have options by Thursday."];
  const good = ["I'll look at indoor spots and text you Thursday.", "I'll send you the link.", "I'll check again before Friday.", "Want me to find a couple more options?", "I'll get back to you once I've looked."];
  check("a promised result is caught; a promised action isn't", bad.every((t) => !!RG.resultPromiseMatch(t)) && good.every((t) => !RG.resultPromiseMatch(t)));
  check("a promised result is cut, the rest of the reply kept", RG.stripUnsupported("Indoor it is. I'll get you a couple of real options before Friday.", [{ name: "no_result_promise", pass: false }] as any) === "Indoor it is.");
}
// ------------------------------------------------ the member's own life backs a reply
// Royce, 2026-10-01: memories about the member's own life (their people,
// preferences, history) are valid backing; the world-claim rule is only for
// people and facts outside it. Live proof: evals/memory/semanticLive.ts
// relationship and cross-user (Co had cut "Lena" and said nothing was on file).
{
  const RG2 = await import("../../src/harness/replyGrounding.js");
  const rf = RG2.baseReplyFacts();
  const mem = "User said: My mentor Lena reviews my hardware startup pitch every Friday. She is the person I call when I get stuck.";
  const s = { message: "Who do I usually turn to when my pitch has me stuck?", recentConversation: "", contextSummary: "", recentMemories: mem };
  const claim = (type: string, text: string, quote: string | null) => ({ text, type, supported: true, factId: null, quote }) as any;
  const [life] = RG2.claimChecks([claim("member_life", "your mentor Lena", "My mentor Lena reviews my hardware startup pitch")], rf, s);
  check("their own mentor, from their memories, backs the reply", life.pass);
  const [other] = RG2.claimChecks([claim("other_person", "Lena would love to help this week", "My mentor Lena reviews my hardware startup pitch")], rf, s);
  check("what that person wants or will do is still a world claim memories can't back", !other.pass);
  check("member_life isn't a world claim; other_person still is", !RG2.WORLD_CLAIMS.has("member_life") && RG2.WORLD_CLAIMS.has("other_person"));
  const [own] = RG2.claimChecks([claim("member_life", "your mentor Lena", "your mentor Lena")], rf, { ...s, recentMemories: "", sentThisTurn: ["Sounds like your mentor Lena is the one."] });
  check("their life can't be backed by Co's own words this turn", !own.pass);
  const [made] = RG2.claimChecks([claim("member_life", "your mentor Priya", "My mentor Priya")], rf, s);
  check("a person they never mentioned isn't backed", !made.pass);
  const [startup] = RG2.claimChecks([claim("member_life", "your startup ZEBRA-VAULT-941", "my confidential startup is called ZEBRA-VAULT-941")], rf, { ...s, recentMemories: "User said: My mentor is Ravi and my confidential startup is called ZEBRA-VAULT-941. I live in Miami." });
  check("their own startup's name, from their memories, backs the reply", startup.pass);
  check("saying nothing's on file gets the claim check; a plain reply still skips it", RG2.needsClaimCheck("I don't actually have anything like that on file for you, no mentor or startup name saved. Want to tell me about it?") && RG2.needsClaimCheck("Honestly, this is the first I'm hearing of it.") && !RG2.needsClaimCheck("That sounds hard. What's been the toughest part?"));
  check("the reply is told their memories are theirs to answer from", /It's theirs: when they ask about their own people, plans or history, answer from it\./.test(src("agent/conversationReply.ts")));
  const [absent] = RG2.claimChecks([claim("detail", "I don't have either of those on file yet", null)], rf, { ...s, recentMemories: "" });
  check("a true 'nothing on file' needs no citation", absent.pass);
  const [falseDenial] = RG2.claimChecks([{ ...claim("member_life", "I don't have a mentor on file for you", null), supported: false }], rf, s);
  check("a denial the reader found false is still cut", !falseDenial.pass);
  const denial = [{ name: "claim_member_life", pass: false, reason: 'member_life: "I don\'t have a mentor or startup name saved for you"' }] as any;
  check("a false 'nothing on file' about their life goes to the redraft, not a bare cut", RG2.deniesWhatTheyToldCo(denial, s) && !RG2.deniesWhatTheyToldCo(denial, { ...s, recentMemories: "" }) && !RG2.deniesWhatTheyToldCo([{ name: "claim_time", pass: false, reason: 'time: "I don\'t have the start time"' }] as any, s));
  check("the redraft may use their own words from memories, and its recheck still holds each detail to a source", /text\), theirOwnWords\(src\.recentMemories\)\]\.join/.test(src("harness/replyGrounding.ts")) && /!deniesWhatTheyToldCo\(effectiveFailed1, src\)/.test(src("harness/replyGrounding.ts")));
  const g = src("harness/replyGrounding.ts");
  check("the claim reader sees their own words from memories and knows member_life", /What they've told Co before \(their own words from older conversations\)/.test(g) && /- member_life: something about the member's own life/.test(g) && /nothing they've told Co before, gives X/.test(g) && /someone who's another member of Co is never part of their own life/.test(g));
  check("the redraft sees their own words and may not deny what they hold", /What they've told you before \(their own words about their own life\)/.test(g) && /never say you don't have something that what they've told you before gives/.test(g));

  // #49 review, 2026-10-01: the exact cases found.
  // 1. A Co-written memory about another member never backs a claim, whatever its label.
  const intro = "Co introduced them to Maya, another member, who is building grid storage software and wants to meet them.";
  const mayaQuote = "Maya, another member, who is building grid storage software";
  for (const type of ["member_life", "detail", "other_person"]) {
    const [r] = RG2.claimChecks([claim(type, "Maya's building grid storage software", mayaQuote)], rf, { ...s, recentMemories: intro });
    check(`review #1: another member's details from a Co-written memory don't pass as ${type}`, !r.pass);
  }
  check("review #1: only the member's own lines of a memory count", RG2.theirOwnWords(`${intro}\nUser said: My friend Maya builds grid storage.\nCo replied: Nice.`) === "My friend Maya builds grid storage.");
  const [friend] = RG2.claimChecks([claim("member_life", "your friend Maya builds grid storage", "My friend Maya builds grid storage")], rf, { ...s, recentMemories: `${intro}\nUser said: My friend Maya builds grid storage.` });
  check("review #1: what they said themselves about someone in their life still backs it", friend.pass);
  // 2. Only Co's own negated, first-person denial skips a citation.
  for (const t of ["The organizers don't have a start time posted yet", "Your mentor Lena is on file", "It's their first time hosting, so expect a small crowd"]) {
    const [r] = RG2.claimChecks([claim("detail", t, null)], rf, { ...s, recentMemories: "" });
    check(`review #2: uncited "${t}" still needs a source`, !r.pass);
  }
  for (const t of ["I don't have either of those on file yet", "Nothing saved about a mentor yet", "This is the first I'm hearing of it"]) {
    const [r] = RG2.claimChecks([claim("detail", t, null)], rf, { ...s, recentMemories: "" });
    check(`review #2: Co's own true denial "${t}" needs no citation`, r.pass);
  }
  // 3. Everyday companion lines don't buy the paid claim read; Co's denials do.
  for (const t of ["I don't know, what do you think?", "First time at one of these?", "Honestly I don't know how that feels, tell me more."])
    check(`review #3: "${t}" skips the claim read`, !RG2.needsClaimCheck(t));
  for (const t of ["I don't actually have anything like that on file for you, no mentor or startup name saved. Want to tell me about it?", "Honestly, this is the first I'm hearing of it.", "Your mentor Lena is on file."])
    check(`review #3: "${t.slice(0, 40)}…" gets the claim read`, RG2.needsClaimCheck(t));
}
console.log(`facts rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
