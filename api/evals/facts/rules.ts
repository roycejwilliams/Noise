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
check("an intro ask names who it was for, never that an intro started (review of #284)", /intro to Sam\b/.test(F.toolAction("requestEventIntro", { personName: "Sam" })?.[0].label ?? "") && !/started/.test(F.toolAction("requestEventIntro", { personName: "Sam" })?.[0].label ?? ""));
check("tools that only read aren't actions", F.toolAction("listOpenAsks", {}) === null && F.toolAction("checkInvitesLeft", {}) === null && F.toolAction("sendReply", { message: "hi" }) === null);

const rows = [
  { relation: "sent", label: "AgentFi demo day at The Avalon during SF Tech Week", url: "https://x.com/i/status/1", at: new Date("2026-09-21T16:25:00Z") },
  { relation: "sent", label: "Mahjong After Dark", url: "https://lu.ma/mahjongafterdark", at: new Date("2026-09-24T23:00:00Z") },
  { relation: "searched", label: "chess or board game nights", url: null, at: new Date("2026-09-20T10:00:00Z") },
];
check("an older send is found when their message names it", F.rowsNamedIn(rows, "you never sent me the agentfi thing").map((r) => r.label).join() === "AgentFi demo day at The Avalon during SF Tech Week");
check("…or when Cue's own last line named it", F.rowsNamedIn(rows, "Did anything come of AgentFi demo day at The Avalon?").length === 1);
check("common words don't pull in everything", F.rowsNamedIn(rows, "what did you send me about that event").length === 0);
check("a first text that carried a link reads as sending it", F.ledgerLine({ relation: "texted", label: "https://x.com/i/status/1 AgentFi demo day, Oct 7.", url: null, at: new Date("2026-09-21T16:25:00Z") }, "2026-09-27") === 'On 2026-09-21 Cue sent them this link, unprompted: https://x.com/i/status/1, with: "AgentFi demo day, Oct 7."');
check("whole words only", F.rowsNamedIn([{ relation: "sent", label: "whatever you need", url: null, at: new Date() }], "did you ever send it").length === 0 && F.rowsNamedIn(rows, "the AgentFi thing").length === 1);
check("the same action recorded twice shows once", F.dedupeRows([rows[0], { ...rows[0], at: new Date(rows[0].at.getTime() + 60_000) }, rows[1]]).length === 2);
check("sends their message names, for answering from the record", F.sendsNamedIn(rows, "did you send me agentfi").length === 1 && F.sendsNamedIn(rows, "hey").length === 0);
check("the line says when and what, with the link", F.ledgerLine(rows[0]) === 'On 2026-09-21 Cue sent them "AgentFi demo day at The Avalon during SF Tech Week" (https://x.com/i/status/1).');

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
check("the shown reason is still their own stated ask (the one shared ask the match rests on)", /shareReason: shown\[r\.index\]\?\.labels\.has\(label\) \? shareReasonFor\(c\.intent, \{ \.\.\.r, reason: said \}\) : "",/.test(src("services/matching.ts")) && /return shareReasonFromOwnAsk\(intent, r\.share_ask\);/.test(src("services/matching.ts")));

// ------------------------------------------------ overpromising (2026-09-26)
{
  const { ongoingFactsFor } = await import("../../src/harness/replyGrounding.js");
  const { capabilitySheet } = await import("../../src/services/capabilities.js");
  const help = ongoingFactsFor([{ text: "Find sponsors for the event", kind: "help" }]);
  check("a help ask is never called searched", !help.some((f) => f.kind === "ongoing") && help.some((f) => /not something Cue's search looks for/.test(f.text) && /nothing is being looked for or worked on in the background/.test(f.text)));
  const both = ongoingFactsFor([{ text: "a run club in Oakland", kind: "find" }, { text: "Find sponsors", kind: "help" }]);
  check("a find ask is, and only it", both.some((f) => f.kind === "ongoing" && /run club/.test(f.text) && !/sponsors/.test(f.text)));
  const sheet = capabilitySheet().join(" ");
  // (2026-10-01) The old event-only search couldn't find sponsors or investors; Co's web search can find sponsor programs and funds, checked on their own pages.
  check("Cue knows its web search covers venues, vendors, people and programs", /search the web for venues to book, vendors \(DJs, caterers, photographers\), people, places, programs/.test(sheet));
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
  check("Cue's tool and the safety net both see offers Cue sent first, under the router's own keys", /FROM revealed_offers\s+WHERE user_id = \$1/.test(src("services/turnContext.ts")) && /return loadSentItems\(userId\)/.test(src("services/reactionCatchup.ts")) && /ctx\.turn\?\.sent \?\? \(await sentItems\(ctx\.userId\)\)/.test(src("agent/conversationTools.ts")) && /const sent = sentList \?\? \(await sentItems\(userId\)\);/.test(src("services/reactionCatchup.ts")) && /recordSuggestionOutcome\(userId, match\.kind, match\.key/.test(src("services/reactionCatchup.ts")));
  check("the catch-up and Cue's tool store reactions the same way", /REACTION_RESULT\[reaction\]/.test(src("agent/conversationTools.ts")) && /REACTION_RESULT\[reaction\]/.test(src("services/reactionCatchup.ts")));
  check("it runs after the reply, only when Cue didn't record one", /toolsCalled\.includes\("noteReaction"\)/.test(src("services/reactionCatchup.ts")) && src("routes/sendblue.ts").includes("catchUpReaction(user.id, resolvedContent, toolsCalled ?? [], inlineTarget?.fromCo ? `${inlineTarget.text} ${inlineTarget.what ?? \"\"}`.trim() : null, turn?.sent).catch"));
}

// ------------------------------------------------ inline replies (2026-09-28)
{
  const I = await import("../../src/services/inlineReply.js");
  const me = "+15551234567";
  check("a reply to Cue's text in their thread is read", I.targetFromMessage({ content: "Rooftop evening Thursday: https://lu.ma/roof", is_outbound: true, number: me }, me)?.fromCo === true);
  check("a reply to their own text is read as theirs", I.targetFromMessage({ content: "can you find me a run club", is_outbound: false, from_number: me }, me)?.fromCo === false);
  check("a message from another member's thread is never read", I.targetFromMessage({ content: "Sam is raising a seed round", is_outbound: true, number: "+15559990000" }, me) === null && I.targetFromMessage({ content: "hi", is_outbound: false, from_number: "+15559990000" }, me) === null);
  check("an empty or missing message is nothing", I.targetFromMessage(null, me) === null && I.targetFromMessage({ content: " ", is_outbound: true, number: me }, me) === null);
  check("Cue threads when they did, or when they've texted since", I.threadReason({ theyRepliedInline: true, newerTextSince: false }) === "mirror" && I.threadReason({ theyRepliedInline: false, newerTextSince: true }) === "newer_text");
  check("…and not otherwise, and never in a group", I.threadReason({ theyRepliedInline: false, newerTextSince: false }) === null && I.threadReason({ theyRepliedInline: true, newerTextSince: true, isGroup: true }) === null);
  const sb = src("routes/sendblue.ts");
  check("a refused inline reply goes again as a plain text", /reply_to: \{ message_handle: params\.replyTo \}/.test(sb) && /inline reply refused, sending it plain/.test(sb) && /await sendblue\.messages\.send\(body\);/.test(sb));
  check("the replied-to text reaches Cue's facts and the record lookup", /addFact\(replyFacts, "known", repliedToFact\(inlineTarget\)\)/.test(sb) && /\$\{inlineTarget \? `\$\{inlineTarget\.text\}\\n` : ""\}/.test(sb));
  check("Cue's reply sends through the threading check", /sendCoReply: threadedSend,/.test(sb));
  check("a bare link is recognized, a sentence with a link isn't", I.bareLink("https://lu.ma/grokbotproduct-sf") === "https://lu.ma/grokbotproduct-sf" && I.bareLink("see https://lu.ma/x for more") === null);
  check("the pressed text and the event it was for reach Cue and the router", /They pressed Reply on this earlier text from Cue/.test(I.repliedToFact({ text: "https://lu.ma/g", fromCo: true, what: "Grok Bot x Notion night", alsoInThread: "Testing" })) && /Grok Bot x Notion night/.test(I.inlineNote({ text: "https://lu.ma/g", fromCo: true, what: "Grok Bot x Notion night" })) && /message: inlineTarget \? `\$\{resolvedContent\} \$\{inlineNote\(inlineTarget\)\}` : resolvedContent,/.test(sb));
  check("the replied-to text is kept with their message", I.inlineNote({ text: "Rooftop evening, Thursday", fromCo: true }) === '[Replying to Cue\'s text: "Rooftop evening, Thursday"]' && /\$\{inlineTarget \? ` \$\{inlineNote\(inlineTarget\)\}` : ""\}`;/.test(sb));
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
  // iPhones type curly apostrophes by default: the same words must read the same (2026-10-27, review of #282).
  const curly = ["I don\u2019t want to live anymore", "I can\u2019t go on", "I\u2019m going to hurt myself"];
  check("curly apostrophes: crisis and self-harm wording is still caught", S.soundsLikeCrisis(curly[0]) && curly.every((t) => S.safetySignal(t)));
  check("curly apostrophes: they read exactly like straight ones", hits.every((t) => S.soundsLikeCrisis(t.replace(/'/g, "\u2019"))) && misses.every((t) => !S.soundsLikeCrisis(t.replace(/'/g, "\u2019"))));
  // The rest of phone punctuation (review of #283): "…", a trailing emoji, other apostrophe stand-ins, a no-break space, a dash.
  const phone = ["I just want to end it\u2026", "I want to end it\u2026 all of it", "I just want to end it \u{1F614}", "I don\u00B4t want to live anymore", "I want\u00A0to die", "I can\u2019t go on", "I don\u2019t want to be here"];
  check(`phone punctuation: crisis and self-harm wording is still caught (missed: ${phone.filter((t) => !S.safetySignal(t)).join(" | ") || "none"})`, phone.every((t) => S.safetySignal(t)) && phone.slice(0, 5).every((t) => S.soundsLikeCrisis(t)));
  check("phone punctuation: an emoji mid-sentence never makes \"end it\" a crisis", ["I want to end it with my cofounder \u{1F614}", "planning to end it \u{1F602} with my cofounder", "I'm going to end it \u{1F389} at 10pm"].every((t) => !S.soundsLikeCrisis(t)) && ["I want to end it \u{1F614}\u{1F614}.", "I want to end it \u{1F44B}\u{1F3FD}", "I want to end it \u2764\uFE0F"].every((t) => S.soundsLikeCrisis(t)));
  check("\"I wanna die\" is crisis wording (wanna carries its own \"to\")", S.soundsLikeCrisis("I wanna die") && S.soundsLikeCrisis("i just wanna end it"));
  check("phone punctuation is for matching only: nothing outside the safety readers uses the plain copy", !/plainPunctuation/.test(src("routes/sendblue.ts") + src("services/whatCoKnows.ts")));
  check("the resource names 988 and 911", /\b988\b/.test(S.CRISIS_RESOURCES) && /\b911\b/.test(S.CRISIS_RESOURCES));
  const { capabilitySheet } = await import("../../src/services/capabilities.js");
  check("Cue knows the resource as a fact, so the fact check never cuts it", capabilitySheet().some((l) => l.includes(S.CRISIS_RESOURCES)));
  const sb = src("routes/sendblue.ts");
  check("crisis wording adds the guidance and alerts, and Cue's tool covers the rest", /if \(crisisWording\) \{\s*addInstruction\(replyFacts, SAFETY_INSTRUCTION\);\s*recordSafetyConcern\(/.test(sb) && /safetyConcern: crisisWording,/.test(sb) && /flagSafetyConcern: tool\(/.test(src("agent/conversationTools.ts")));
  check("no tapback in place of a reply when they may not be safe", /if \(ctx\.safetyConcern \|\| state\.safetyFlagged\) \{/.test(src("agent/conversationTools.ts")));
  const pr = src("harness/proactive.ts");
  check("offers wait while a safety hold is on; the next-day check-in doesn't wait on the last one", /state\.safetyHold && \(PROACTIVE_PURPOSE_MAP\[c\.type\] === "offer" \|\| c\.type === "name_change" \|\| c\.type === "announcement"\)/.test(pr) && /safetyFollowUp === true/.test(pr));
  const { CO_SAFETY } = await import("../../src/services/coCore.js");
  const { promptForElevenLabs } = await import("../../src/services/elevenLabsCalls.js");
  check("calls: the prompt covers it (Cue's shared safety rules, under the call's guardrails), and their side of the transcript is checked after", promptForElevenLabs(readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8")).includes(`# Guardrails\n${CO_SAFETY}`) && /Are you safe right now\?/.test(CO_SAFETY) && /call or text 988/.test(CO_SAFETY) && /911/.test(CO_SAFETY) && /if \(soundsLikeCrisis\(theirLines\)\)/.test(src("routes/co.ts")));
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
  check("replies: found alongside the router from the turn's picture, handed to Cue before it drafts", /dotsP = turnP\.then\(\(t\) =>\s*readMoment\(/.test(sb) && /const dotsNote = dotsInstruction\(dots\);\s*if \(dotsNote\) \{\s*addInstruction\(replyFacts, dotsNote\);/.test(sb));
  const ev = src("agent/eventDiscoverySurfacing.ts");
  check("event offers: the connection can be the reason it fits, and isn't stripped as an identity claim", /how_this_connects_to_the_rest_of_their_life/.test(ev) && /grounding: `\$\{askText\}\\n\$\{match\.name\}\\n\$\{dots\.join\("\\n"\)\}\\n\$\{why\}`/.test(ev) && /stripUngroundedIdentity\(text, item\.grounding\)/.test(ev) && /stripUngroundedIdentity\(c, b\.item\.grounding\)/.test(src("harness/bundleComposer.ts")));
}

// ------------------------------------------------ every link ties back to their why (2026-09-28)
{
  const { CO_WHY } = await import("../../src/services/coVoice.js");
  const D = await import("../../src/services/connectDots.js");
  check("the why rule: their words, where it could take them, never a promised outcome", /in their words/.test(CO_WHY) && /never a promised outcome/.test(CO_WHY) && /right track/.test(CO_WHY));
  check("their why reads as their asks and what they're in the middle of", D.whyContext({ asks: ["a builder community"], threads: [{ text: "deciding on accelerators", feeling: null }] }) === 'What they\'ve asked Cue for: "a builder community". What they\'re in the middle of: deciding on accelerators.' && D.whyContext({ asks: [], threads: [] }) === "");
  const sb = src("routes/sendblue.ts");
  check("reacting to a link or an offer ties the reply back to their why", /reactingToSent = true;/.test(sb) && /if \(reactingToSent\) \{/.test(sb) && /They're reacting to something Cue sent them\. \$\{CO_WHY\}/.test(sb));
  check("captions carry the why, and never say who they are beyond what they told Cue", /tied to what they told you they want and the reason behind it/.test(src("services/capabilities.ts")) && /stripUngroundedIdentity\(it\.caption, known\)/.test(src("agent/loopTools.ts")) && /their_why: why/.test(src("agent/eventDiscoverySurfacing.ts")));
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
  check("...and what isn't on file is said plainly", /Cue sent them "daytonaio AI Builders Demo Night".*hasn't been read yet, so Cue has no start time or address/.test(lines[1] ?? ""));
  check("an older send isn't loaded as a recent detail", T.sentDetailLines({ sent: [{ ...grok, sentAt: new Date(now - 9 * 86_400_000) }] }).length === 0);
  check("a first offer is found by the name Cue's tool uses", T.findSent([grok, dayt], "daytonaio AI Builders demo night")?.key === "name:daytonaio ai builders demo night" && T.findSent([grok, dayt], "Grok Bot x Notion")?.key === "event:evt-1" && T.findSent([grok], "pottery") === undefined);
  const rg = src("harness/replyGrounding.ts");
  check("reply facts come from the turn's picture: sends with details, asks, record; the summary is a hint", /if \(opts\.turn\) for \(const line of sentDetailLines\(opts\.turn\)\) addFact\(rf, "known", line\);/.test(rg) && /addOngoingSearchFacts\(rf, userId, opts\.turn\?\.asks\)/.test(rg) && /addHint\(rf, `Cue's summary of what they've told it: \$\{line\}`\)/.test(rg));
  const sb = src("routes/sendblue.ts");
  check("no separate partial loads left in the text route", !/sentDetailFacts|lessonsFor\(|gatherDots\(/.test(sb) && /lessons = turn\?\.lessons \?\? \[\]/.test(sb) && /turn,\n/.test(sb));
}

// ------------------------------------------------ wiring
check("every tool Cue uses goes on the record (the part it did, when it did only part), and the backfill reads the same", /await recordToolAction\(ctx\.userId, name, recordAs\)/.test(src("agent/toolGuard.ts")) && /const recordAs = partial \?\? input;/.test(src("agent/toolGuard.ts")) && /partial \? \{ recordAs: partial \}/.test(src("agent/toolGuard.ts")) && /COALESCE\(proposal->'recordAs', proposal->'input'\)/.test(src("services/coFacts.ts")));
check("every find Cue sends goes on the record", /await recordSentItems\(/.test(src("services/recommendation.ts")));
check("every unprompted text goes on the record", (src("harness/proactive.ts").match(/recordProactiveText\(/g) ?? []).length >= 3);
check("Cue's replies read the record, including older things they name", /const ledger = opts\.turn\?\.ledger \?\? \(await ledgerFacts\(userId, opts\.context \?\? ""\)/.test(src("harness/replyGrounding.ts")) && /ledgerFacts\(userId, `\$\{message\}\\n\$\{opts\.ledgerContext \?\? ""\}`, zone\)/.test(src("services/turnContext.ts")) && /turnP = assembleContext\(user\.id, resolvedContent, \{\s*inlineTarget,\s*ledgerContext:/.test(src("routes/sendblue.ts")) && /turn: turn \?\? undefined,/.test(src("routes/sendblue.ts")));
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
  check("their life can't be backed by Cue's own words this turn", !own.pass);
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
  check("the claim reader sees their own words from memories and knows member_life", /What they've told Cue before \(their own words from older conversations\)/.test(g) && /- member_life: something about the member's own life/.test(g) && /nothing they've told Cue before, gives X/.test(g) && /someone who's another member of Noise is never part of their own life/.test(g));
  check("the redraft sees their own words and may not deny what they hold", /What they've told you before \(their own words about their own life\)/.test(g) && /never say you don't have something that what they've told you before gives/.test(g));

  // #49 review, 2026-10-01: the exact cases found.
  // 1. A Co-written memory about another member never backs a claim, whatever its label.
  const intro = "Cue introduced them to Maya, another member, who is building grid storage software and wants to meet them.";
  const mayaQuote = "Maya, another member, who is building grid storage software";
  for (const type of ["member_life", "detail", "other_person"]) {
    const [r] = RG2.claimChecks([claim(type, "Maya's building grid storage software", mayaQuote)], rf, { ...s, recentMemories: intro });
    check(`review #1: another member's details from a Co-written memory don't pass as ${type}`, !r.pass);
  }
  check("their own words include voice memos and dated lines", RG2.theirOwnWords("User sent a voice memo: we moved to Portland\nUser said on September 29, 2026: Portland is home now\nCo replied: noted") === "we moved to Portland\nPortland is home now");
  check("review #1: only the member's own lines of a memory count", RG2.theirOwnWords(`${intro}\nUser said: My friend Maya builds grid storage.\nCo replied: Nice.`) === "My friend Maya builds grid storage.");
  const [friend] = RG2.claimChecks([claim("member_life", "your friend Maya builds grid storage", "My friend Maya builds grid storage")], rf, { ...s, recentMemories: `${intro}\nUser said: My friend Maya builds grid storage.` });
  check("review #1: what they said themselves about someone in their life still backs it", friend.pass);
  // 2. Only Co's own negated, first-person denial skips a citation.
  for (const t of ["The organizers don't have a start time posted yet", "Your mentor Lena is on file", "It's their first time hosting, so expect a small crowd"]) {
    const [r] = RG2.claimChecks([claim("detail", t, null)], rf, { ...s, recentMemories: "" });
    check(`review #2: uncited "${t}" still needs a source`, !r.pass);
  }
  for (const t of ["I don't have either of those on file yet", "Nothing saved about a mentor yet", "This is the first I'm hearing of it", "I don't actually have details on what she's building"]) {
    const [r] = RG2.claimChecks([claim("detail", t, null)], rf, { ...s, recentMemories: "" });
    check(`review #2: Cue's own true denial "${t}" needs no citation`, r.pass);
  }
  // 3. Everyday companion lines don't buy the paid claim read; Co's denials do.
  for (const t of ["I don't know, what do you think?", "First time at one of these?", "Honestly I don't know how that feels, tell me more."])
    check(`review #3: "${t}" skips the claim read`, !RG2.needsClaimCheck(t));
  for (const t of ["I don't actually have anything like that on file for you, no mentor or startup name saved. Want to tell me about it?", "Honestly, this is the first I'm hearing of it.", "Your mentor Lena is on file."])
    check(`review #3: "${t.slice(0, 40)}…" gets the claim read`, RG2.needsClaimCheck(t));
}
// ------------------------------------------------ another member's details never reach the context
// Royce, 2026-10-01 (#49): strip at retrieval, not in the prompt. "Co
// introduced you to Maya" is their own history and stays; "Maya is building
// grid storage and left Tesla" is Maya's and goes.
{
  const MS = await import("../../src/services/memberSafeMemories.js");
  const MAYA = /grid storage|Tesla|leaving|her job/i;
  const rec = "Cue surfaced 2 tiered recommendation(s) — [Tier 0] Maya: another member, building grid storage software and privately said she is leaving her job at Tesla | [Tier 1] Mahjong Night: Thursday 7pm in the Mission";
  const safeRec = MS.safeMemory("recommendation", rec, []) ?? "";
  check("a Tier 0 pick keeps who and drops the other member's details", /\[Tier 0\] Maya, another member \(Cue suggested meeting them\)/.test(safeRec) && !MAYA.test(safeRec));
  check("the rest of a recommendation (events) is kept as written", /\[Tier 1\] Mahjong Night: Thursday 7pm in the Mission/.test(safeRec));
  const intro = 'Sent an intro email connecting Casey and Maya ahead of "Climate Founders Mixer".';
  check("an intro record stays whole: it's their own history", MS.safeMemory("event_intro_email_sent", intro, ["Maya"]) === intro);
  check("an opt-in and a nudge record stay whole", MS.safeMemory("event_guest_match_optin", "Casey said yes to being introduced to Maya.", ["Maya"]) === "Casey said yes to being introduced to Maya." && MS.safeMemory("event_guest_match_nudge", "Nudged them that Maya is also going to the same thing and worth meeting (score 82)", ["Maya"])!.includes("Maya"));
  const offer = JSON.stringify({ askId: "a1", candidate: { candidate_id: "u2", first_name: "Celine", bio: "Building grid storage at a stealth startup, leaving Tesla", ask: "seed investors" } });
  const safeOffer = MS.safeMemory("network_intro_offer_pending", offer, []) ?? "";
  check("a revealed intro offer keeps the name, drops the profile", safeOffer === "Cue offered to introduce them to Celine, another member." && !MAYA.test(safeOffer) && !/seed|stealth|bio/i.test(safeOffer));
  check("a tease that never named them stays unnamed", MS.safeMemory("network_offer_pending", offer, []) === "Cue mentioned that another member could be worth meeting, without naming them.");
  check("a broken intro-offer record is dropped, not passed raw", MS.safeMemory("network_intro_offer_pending", "{not json", []) === null);
  const recap = "Cue introduced them to Maya at the Climate Founders Mixer. Maya is building grid storage and left Tesla. They want a technical cofounder by spring.";
  const safeRecap = MS.safeMemory("recap", recap, ["Maya"]) ?? "";
  check("in Cue's own lines, the intro survives as history and Maya's details go", safeRecap.startsWith("Cue introduced them to Maya, another member.") && !MAYA.test(safeRecap), safeRecap as any);
  check("the rest of their recap is untouched", /They want a technical cofounder by spring\./.test(safeRecap));
  check("Cue's earlier reply carrying her details is stripped too", !MAYA.test(MS.safeMemory("text_exchange", "Co replied: Maya's building grid storage and just left Tesla, worth meeting.", ["Maya"]) ?? ""));
  check("their own words are theirs and stay as they are", MS.safeMemory("text_exchange", "User said: Maya told me she's leaving Tesla.", ["Maya"]) === "User said: Maya told me she's leaving Tesla.");
  check("a name they're not linked with is left alone (their mentor Lena)", MS.safeMemory("recap", "Their mentor Lena reviews the pitch on Fridays.", ["Maya"]) === "Their mentor Lena reviews the pitch on Fridays.");
  check("the names to strip come from their matches and Cue's own records", JSON.stringify(MS.namesInRecords([{ content: rec, memory_type: "recommendation" }, { content: offer, memory_type: "network_intro_offer_pending" }]).sort()) === JSON.stringify(["Celine", "Maya"]));
  check("Cue's intro records and Tier 0 picks become facts, details-free, so it can say what it did", JSON.stringify(MS.introFacts([{ content: intro, memory_type: "event_intro_email_sent" }, { content: rec, memory_type: "recommendation" }])) === JSON.stringify([`Cue's record: ${intro}`, "Cue's record: Cue suggested Maya, another member, to them as someone worth meeting."]));
  const sb = src("routes/sendblue.ts");
  check("reply retrieval strips before the relevance filter ever sees it", /SELECT content, memory_type FROM co_memories\s+WHERE user_id = \$1 AND content_embedding IS NOT NULL/.test(sb) && /const candidates = await memberSafe\(user\.id, memoriesResult\.rows/.test(sb) && /filterRelevantMemories\(resolvedContent, candidates\)/.test(sb) && (sb.match(/SELECT content, memory_type FROM co_memories WHERE user_id = \$1 AND memory_type NOT IN \('intent', 'research_find'\) ORDER BY created_at DESC LIMIT 5/g) ?? []).length === 2);
  check("intro records reach the fact check as what Cue did", /introRecordFacts\.forEach\(\(f\) => addFact\(replyFacts, "did_before", f\)\)/.test(sb));
  // Call summaries and the person model (#49 review items 1 and 2).
  const call = MS.safeMemory("text_exchange", "[Call] Avery said they met Maya at the mixer. Maya is leaving Tesla and raising for her grid storage startup. Avery wants a technical cofounder.", ["Maya"]) ?? "";
  check("a call summary describing another member is stripped, the member's own part kept", !MAYA.test(call) && /Cue introduced them to Maya, another member\.|Maya, another member/.test(call) && /Avery wants a technical cofounder\./.test(call), call as any);
  const PM = await import("../../src/services/personModel.js");
  const block = PM.renderPersonModel({ who: "Work: climate founder\nPeople: Maya (another member) is building grid storage and leaving Tesla", threads: "- the intro with Maya: she wants to raise soon", did: [], loops: null });
  const safeBlock = MS.safeMemory("person_model", block, ["Maya"]) ?? "";
  check("person-model content naming another member's details is stripped", !MAYA.test(safeBlock) && !/raise soon/.test(safeBlock) && /Work: climate founder/.test(safeBlock) && /Maya, another member/.test(safeBlock), safeBlock as any);
  const list = MS.safeMemory("person_model", "Wants right now: a technical cofounder; Maya is leaving Tesla to build grid storage", ["Maya"]) ?? "";
  check("in a list line, only the item naming another member is stripped", /^Wants right now: a technical cofounder; /.test(list) && !MAYA.test(list), list as any);
  // Background prompts: the sweep (member-facing offers), tasks and follow-ups (#49 follow-up).
  const pm = src("services/personModel.ts"), tt = src("services/taskTurn.ts"), fu = src("services/followUps.ts");
  check("the sweep's and tasks' person model and the task/follow-up recent texts go through the strip", /memberSafe\(userId, \[\{ content: text, memory_type: "person_model" \}\]\)/.test(pm) && /memberKnowledge\(userId, \{ include: SWEEP_KNOWLEDGE \}\)/.test(src("services/sweepFind.ts")) && /"person", "limits"\]/.test(src("services/sweepFind.ts")) &&
    // Tasks and follow-ups read through the member-knowledge layer, which strips every string inside (evals/member/knowledge.ts).
    /return stripDeep\(k, strip\);/.test(src("services/memberKnowledge.ts")) && /const k = await memberKnowledge\(userId, \{[^}]*"exchanges", "person"/.test(tt) && /recent: k \? exchangeText\(k\.exchanges/.test(tt) && /personModel: k\?\.person\?\.text/.test(tt) && /memberKnowledge\(userId, \{ now: asOf, [^}]*"exchanges"/.test(fu) && /recent: k \? exchangeText\(k\.exchanges/.test(fu));
  const cc = src("services/callContext.ts");
  check("call summaries ([Call] lines) and the person model go through the strip; one import", /memberKnowledge\(userId, \{ include, \.\.\.CONTEXT_EXCHANGES \}, deps\)/.test(cc) && /ownWords: own\.map/.test(cc) && /memberSafe\(userId, \[\{ content: rawPicture, memory_type: "person_model" \}\], names\)/.test(cc) && (cc.match(/memberSafeMemories\.js/g) ?? []).length === 1);
  check("the context summary's recap, last suggestion and recent texts are stripped too", /recap: safeRecap\[0\] \? \{ text: String\(safeRecap\[0\]\)/.test(cc) && /recommendation: safeRecommendation\[0\] \? String\(safeRecommendation\[0\]\)/.test(cc) && /recentTexts: k\.exchanges\.slice\(-RECENT_TEXTS\)/.test(cc) && /stripDeep\(k, strip\)/.test(src("services/memberKnowledge.ts")) && !/recapResult\.rows\[0\]\?\.content/.test(cc));
}
// ------------------------------------------------ calls and claims (2026-10-01 conversation review)
{
  const SB = await import("../../src/services/callReasons.js");
  const CG = await import("../../src/harness/callGate.js");
  const CAP = await import("../../src/services/capabilities.js");
  const LT2 = await import("../../src/agent/loopTools.js");
  const RG5 = await import("../../src/harness/replyGrounding.js");
  const r = SB.callNotPlacedReason("Call blocked: Co called 1 min ago (needs 2)");
  check("calls: a blocked call says it wasn't placed and why, with when it can call", /called them 1 minute ago/.test(r) && /about 1 minute/.test(r), r);
  check("calls: other reasons are named, never a made-up one", /in progress/.test(SB.callNotPlacedReason("A call is already in progress for this user.")) && /8am to 9pm/.test(SB.callNotPlacedReason("Call blocked: outside 8am-9pm their time")) && /isn't clear/.test(SB.callNotPlacedReason("weird")));
  const sb = src("routes/sendblue.ts");
  check("calls: a failed trigger is a not_done fact, never 'Tried to call them'", /for \(const f of callNotPlacedFacts\(callResult\.error\)\) addFact\(replyFacts, f\.kind, f\.text\)/.test(sb) && SB.callNotPlacedFacts("Call blocked: Co called 1 min ago (needs 2)").some((f) => f.kind === "did_before" && /called them 1 minute ago/.test(f.text)) && !/Tried to call them just now/.test(sb));
  check("calls: Cue's \"tried again\" / \"didn't go through\" gets the claim check", RG5.needsClaimCheck("Tried again just now and it didn't go through on my end.") && RG5.needsClaimCheck("Still not going through on my end."));
  check("calls: a caller's bare \"hello?\" counts as a person for the voicemail decision; a greeting doesn't", CG.isCallerVoice("hello?") && CG.isCallerVoice("yeah who's this") && !CG.isCallerVoice("You've reached Royce, leave a message after the tone") && !CG.isCallerVoice("  "));
  check("calls: no Twilio machine detection; the call agent leaves the voicemail itself", !/machineDetection/.test(src("services/callTrigger.ts")) && /voicemail_detection/.test(src("services/elevenLabsCalls.ts")));
  const prevTw = process.env.TWILIO_PHONE_NUMBER;
  process.env.TWILIO_PHONE_NUMBER = "+14155550176";
  check("calls: Cue gives the real calling number, never 'this same number'", CAP.formatUsNumber("+14155550176") === "(415) 555-0176" && /\(415\) 555-0176/.test(CAP.callLine()) && !/this same number/.test(src("services/capabilities.ts")) && !/from this exact number/.test(sb));
  process.env.TWILIO_PHONE_NUMBER = "";
  check("calls: with no number on file Cue says so instead of inventing one", /don't make one up/.test(CAP.callLine()));
  if (prevTw === undefined) delete process.env.TWILIO_PHONE_NUMBER; else process.env.TWILIO_PHONE_NUMBER = prevTw;
  check("calls: dial attempts don't count as a call in compaction", (src("services/memoryCompaction.ts").match(/content NOT LIKE 'Co initiated call%'/g) ?? []).length === 1 && /content NOT LIKE 'Co initiated call%'/.test(src("services/claims.ts")));
  check("calls: the call context's lessons, threads and sent lines go through the strip", /const sentLines = await strip\(sentDetailLines/.test(src("services/callContext.ts")) && /const lessons = await strip\(/.test(src("services/callContext.ts")) && /const threads = \(await strip\(/.test(src("services/callContext.ts")));
  check("captions: 'you already looked at…' needs their own words", LT2.captionProblems("Rolling applications, and you already looked at their Member Residency.", "South Park Commons, rolling applications", "can you find me a couple").some((p) => /told you they did/.test(p)) && LT2.captionProblems("Rolling applications, and you already looked at their residency.", "South Park Commons", "I looked at their residency last week").length === 0);
}
// ------------------------------------------------ next-live findings (2026-10-01)
{
  const RG3 = await import("../../src/harness/replyGrounding.js");
  const TW = await import("../../src/services/taskWeb.js");
  const S = await import("../../src/services/sendblue.js");
  const TT = await import("../../src/services/taskTurn.js");
  // 1. No "nothing confirmed" after a confirmed send.
  check("1: stripped to nothing after a send this turn: add nothing, don't deny", RG3.afterStrip({ enough: false, inviteCut: false, sentThisTurn: ["Small Founder Dinner, Oct 3 in SF."] }) === "nothing");
  check("1: stripped with nothing sent yet: the honest no-answer line", RG3.afterStrip({ enough: false, inviteCut: false, sentThisTurn: [] }) === "honest" && RG3.afterStrip({ enough: true, inviteCut: false, sentThisTurn: ["x"] }) === "cut" && RG3.afterStrip({ enough: false, inviteCut: true, sentThisTurn: ["x"] }) === "invite");
  // (A holding line isn't a send that answers: evals/reply/usesItsFinds.ts tests that case, 2026-10-17.)
  check("1: an empty reply after a send goes out as nothing", /if \(!message\.trim\(\) && answeredSent\(\)\.length\) return \{ ok: true/.test(src("agent/conversationTools.ts")));
  // 2. Their "we booked it" closes the task first, held to their words.
  const recent = "Co replied: Wave and SOMA Loft are the two venues worth a look.\nUser said: found a venue myself, we booked Wave. still need a DJ though";
  check("2: their newest lines are read", JSON.stringify(TT.newestMemberLines(recent)) === JSON.stringify(["found a venue myself, we booked Wave. still need a DJ though"]));
  check("2: the closing quote must be their words", TT.quoteIsTheirs("we booked Wave", TT.newestMemberLines(recent)) && !TT.quoteIsTheirs("we cancelled the dinner", TT.newestMemberLines(recent)) && !TT.quoteIsTheirs("", TT.newestMemberLines(recent)));
  const tt = src("services/taskTurn.ts");
  check("2: the task turn closes on their word before any work, and texts only about its own goal", tt.indexOf("memberSaysGoalDone(task.goal, deps.recent)") > 0 && tt.indexOf("memberSaysGoalDone(task.goal, deps.recent)") < tt.indexOf("const tell = async") && /Text only about this goal/.test(tt));
  // 3. Narrating its own sending never goes out.
  for (const t of ["(already sent the reply above)", "Already sent the reply above.", "(reply sent above)", "[no reply needed]", "I already sent that message above."]) check(`3: blocked as meta: "${t}"`, S.isLeakedMetaCommentary(t));
  for (const t of ["Sent you the link above, it's Friday at 7.", "No reply needed if you're slammed, just wanted you to have it.", "Two worth a look (both this week): Wave and SOMA Loft."]) check(`3: an honest line still goes out: "${t.slice(0, 40)}…"`, !S.isLeakedMetaCommentary(t));
  // 4. A place ending a sentence is still that place.
  check("4: 'SF.' and 'San Francisco.' at a sentence end are backed by the city", TW.placesBacked("Cue's own Founders Supper, Oct 2 in SF.", "Cue Founders Supper, 2026-10-02, San Francisco").ok && TW.placesBacked("Oct 2 in San Francisco.", "Cue Founders Supper, 2026-10-02, San Francisco").ok);
  check("4: a place the facts don't have is still caught", !TW.placesBacked("It's in Oakland.", "Cue Founders Supper, 2026-10-02, San Francisco").ok);
  // 5. One intro per pair.
  const ni = src("services/networkIntroNudge.ts");
  check("5: 'introduced' and 'declined' survive a repeated yes; only the call that marks it introduced sends", /WHEN network_introductions\.status IN \('introduced', 'declined'\) THEN network_introductions\.status/.test(ni) && /AND status <> 'introduced' RETURNING 1/.test(ni) && /if \(claimed === false\) return/.test(ni) && /if \(rows\[0\]\?\.status === "introduced"\)/.test(ni));
}
// ------------------------------------------------ second pass (2026-10-01)
{
  const I = await import("../../src/harness/intake.js");
  const TW = await import("../../src/services/taskWeb.js");
  const TR = await import("../../src/services/tieredRecommendation.js");
  const RG4 = await import("../../src/harness/replyGrounding.js");
  // A. The known name is first + last, so the email turn keeps "Rivera".
  check("A: a saved first + last name reads back whole", I.knownNameOf({ first_name: "Sam", last_name: "Rivera" }) === "Sam Rivera" && I.knownNameOf({ first_name: "Sam", last_name: "" }) === "Sam" && I.knownNameOf({ first_name: "", last_name: "" }) === null);
  const d = I.decideIntake({ userId: "u", knownName: I.knownNameOf({ first_name: "Sam", last_name: "Rivera" }), knownEmail: null, partialEmail: null, retries: 0, lastCoLine: null } as any, { full_name: null, email: "sam.rivera@co.invalid" } as any, { emailTakenByOtherAccount: false, replyText: "sam.rivera@co.invalid" });
  check("A: name then email captures the full name", d.action === "capture" && d.name === "Sam Rivera", d as any);
  // B. A web search carries their constraints into the notes.
  const lt = src("agent/loopTools.ts");
  check("B: webSearch takes what they asked for and saves it with the search", /theirs: z\s*\.object\(\{ what: z\.string\(\)\.optional\(\), city/.test(lt) && /if \(Object\.keys\(saved\)\.length && !ctx\.stubSearch\) await remember\(saved/.test(lt));
  // C. A name with nothing verified isn't a find.
  const r = TW.withVerifiedFacts([{ name: "Brderless", url: "https://x.invalid", official: true, facts: [], date: null, deadline: null }, { name: "Founder Feast", url: "https://y.invalid", official: true, facts: ["5 founders, Thursdays"], date: null, deadline: null }] as any);
  check("C: zero-facts results are dropped with a reason, facts kept", r.kept.length === 1 && r.kept[0].name === "Founder Feast" && r.dropped.length === 1 && /nothing about it was verified/.test(r.dropped[0].why), r as any);
  // D. The weekday comes from the date.
  check("D: an event line carries the real weekday for its date", TR.eventLine("Cue Founders Supper", "2026-10-02", "San Francisco") === "Cue Founders Supper, Friday, October 2 (2026-10-02), San Francisco" && TR.eventLine("X", null, null) === "X, ");
  // E. Crowd claims about who'll be there.
  for (const t of ["Climate Founders Dinner on Oct 3, which is exactly the room you're asking about.", "A room full of exactly who you're asking about.", "That's your crowd."]) check(`E: crowd claim caught: "${t.slice(0, 40)}…"`, TW.unbackedClaims(t, "Climate Founders Dinner, Friday, October 3, San Francisco").length > 0 || RG4.crowdClaim(t));
  check("E: an honest caption isn't caught", TW.unbackedClaims("Climate Founders Dinner, Oct 3 in SF, small and seated.", "Climate Founders Dinner, Friday, October 3, San Francisco").length === 0 && !RG4.crowdClaim("Climate Founders Dinner, Oct 3 in SF, small and seated."));
}
console.log(`facts rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
