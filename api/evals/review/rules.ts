import { readFileSync } from "fs";
// Model-free checks for the dev-only "what broke" review (harness/devReview.ts),
// built from real co-test turns on 2026-09-18. No API calls, no database:
//   npx tsx evals/review/rules.ts
import {
  conversationFlags,
  findQuoted,
  groupFlags,
  heldBackFlags,
  loggedActions,
  logFlags,
  reactionFlags,
  renderDigest,
  renderRejectedSample,
  reviewEnabled,
  topicWords,
  type ReviewData,
  type ReviewDecision,
  type ReviewMessage,
} from "../../src/harness/devReview.js";
import { metricLines, rate, renderMetricsHtml, type Metrics } from "../../src/harness/metrics.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

let n = 0;
const msg = (at: string, from: ReviewMessage["from"], text: string): ReviewMessage => ({ id: String(++n), at, from, text });
const dec = (id: number, at: string, decision: string, outcome: string, action: string | null, proposal: any = {}, checks: any = []): ReviewDecision => ({ id, at, decision, outcome, action, reason: null, proposal, checks });
const base = (over: Partial<ReviewData>): ReviewData => ({ userId: "u1", firstName: "Royce", messages: [], decisions: [], emotions: [], issues: [], ...over });

// --- The tech week turn: five passed the gate, one sent, "just that one".
const techWeek = base({
  messages: [
    msg("2026-09-18T19:55:00Z", "member", "What does the SF tech week look like? Oct 5th - Oct 11th?"),
    msg("2026-09-18T19:55:40Z", "co", "https://lu.ma/g5sdw0b6"),
    msg("2026-09-18T19:55:42Z", "co", "Hardware FYI: SF Tech Week Edition, Friday Oct 9 at Dogpatch Studios. Fireside chat on AI/robotics/manufacturing, then drinks with hardware founders."),
    msg("2026-09-18T19:55:50Z", "co", "Already sent you Hardware FYI: SF Tech Week Edition, Fri Oct 9 at Dogpatch Studios, that's the one from that window that actually fits. Beyond that I don't have a full tech week lineup yet, just that one so far."),
  ],
  decisions: [
    ...["Hardware FYI: SF Tech Week Edition", "SF Tech Week Agent Day", "Demo Night @ WorkOS (October)", "init() by WorkOS", "Ship it & Sip it"].map((name, i) => dec(100 + i, "2026-09-18T19:55:29Z", "match.gate", "act", "offer:tier2", { name })),
    dec(110, "2026-09-18T19:55:39Z", "recommendation.search", "act", "sent_matches", { message: "What does the SF tech week look like? Oct 5th - Oct 11th?", scope: { xQuery: "SF tech week Oct 5-11 (founder event OR builder meetup OR startup mixer)" }, matches: [{ name: "Hardware FYI: SF Tech Week Edition", fits: true }] }),
    dec(111, "2026-09-18T19:55:52Z", "turn.latency", "act", "reply_with_search", { ms: 44456, searchMs: 17689, replyMs: 6015, routerMs: 2295 }, [{ name: "within_budget", pass: false }]),
  ],
});
const twConv = conversationFlags(techWeek);
check("tech week: the 'Already sent you' message is flagged as restating", twConv.some((f) => f.type === "restated_own_message" && f.snippet.includes("Already sent you")));
check("tech week: 'just that one' with five through the gate is flagged", twConv.some((f) => f.type === "only_one_claim" && f.decisionIds.length === 5));
// The previous turn's gate rows don't count toward this one (2026-09-18: the
// hike search's six were added to tech week's six, "12 passed").
const twoTurns = base({
  messages: [msg("2026-09-18T19:53:48Z", "member", "Is there anything going on tomorrow?"), ...techWeek.messages],
  decisions: [...[1, 2, 3, 4, 5, 6].map((i) => dec(90 + i, "2026-09-18T19:54:10Z", "match.gate", "act", "offer:tier2", { name: `hike ${i}` })), ...techWeek.decisions],
});
check("only this turn's gate rows are counted", conversationFlags(twoTurns).find((f) => f.type === "only_one_claim")?.decisionIds.length === 5);
check("a log flag's rows stop at the member's next message", !logFlags(twoTurns).some((f) => f.decisionIds.some((id) => id >= 91 && id <= 96)));
check("tech week: a link-only message is never flagged as restating", !twConv.some((f) => f.type === "restated_own_message" && f.snippet.startsWith('"https')));
const twLog = logFlags(techWeek);
check("tech week: 44s turn is a slow reply, cause from the log", twLog.some((f) => f.type === "slow_reply" && f.severity === "medium" && f.causeConfirmed && f.cause.startsWith("search")));
check("tech week: the query shares the topic, not off-topic", !twLog.some((f) => f.type === "off_topic_search"));

// --- The VC turn: "Yeah, just sent you one, check it above."
const vc = base({
  messages: [
    msg("2026-09-18T20:00:48Z", "member", "Did you see anything about VC looking to fund?"),
    msg("2026-09-18T20:01:15Z", "co", "https://x.com/i/status/2098877025356316809"),
    msg("2026-09-18T20:01:17Z", "co", "1517 Fund does pre-seed checks starting at $50K, up to $400K average, which lines up with what you're looking for right now."),
    msg("2026-09-18T20:01:25Z", "co", "Yeah, just sent you one, check it above. Pre-seed checks, dropout/deep-tech leaning, worth a look for your stage."),
  ],
  decisions: [dec(200, "2026-09-18T20:01:14Z", "recommendation.search", "act", "sent_matches", { message: "Did you see anything about VC looking to fund?", scope: { xQuery: "pre-seed VC funding (founder OR builder)" }, matches: [{ name: "1517 Fund", fits: true }] })],
});
check("VC: 'just sent you one, check it above' is flagged", conversationFlags(vc).some((f) => f.type === "restated_own_message"));
check("VC: 'VC funding' query shares the topic of 'VC looking to fund'", !logFlags(vc).some((f) => f.type === "off_topic_search"));

// --- The hiring turn: the openings query searched funding.
const hiring = base({
  messages: [msg("2026-09-18T20:02:12Z", "member", "Anyone hiring a design engineer?")],
  decisions: [dec(300, "2026-09-18T20:02:30Z", "recommendation.search", "act", "sent_matches", { message: "Anyone hiring a design engineer?", scope: { xQuery: "pre-seed funding SF OR early stage investors Bay Area" }, matches: [{ name: "all-female hacker house in SF", fits: false, why: "a funding story, not hiring" }] })],
});
const hiringLog = logFlags(hiring);
check("hiring: a funding query for a hiring question is off-topic, marked a guess", hiringLog.some((f) => f.type === "off_topic_search" && f.severity === "high" && !f.causeConfirmed));
check("hiring: sending something that didn't fit is a stretch send", hiringLog.some((f) => f.type === "stretch_send"));
check("a browse question with no topic of its own is never called off-topic", !logFlags(base({ decisions: [dec(301, "2026-09-18T19:53:00Z", "recommendation.search", "act", "sent_matches", { message: "Is there anything going on tomorrow?", scope: { xQuery: "founder meetup" } })] })).some((f) => f.type === "off_topic_search"));
check("topic words drop filler, time words, and endings", [...topicWords("Did you see anything about VC looking to fund?")].sort().join(",") === "fund,vc");

// --- Other log checks.
const misc = base({
  decisions: [
    dec(400, "2026-09-18T19:40:01Z", "recommendation.lateResult", "skip", "none_fit_told_them", { askText: "grants for a founder event", found: ["Real-Time Video Agents Hack"] }),
    dec(401, "2026-09-18T19:41:00Z", "recommendation.search", "skip", "nothing_fit", { message: "any grants?", scope: { gatedOut: [] } }),
    dec(402, "2026-09-18T19:42:00Z", "recommendation.search", "skip", "nothing_found", { message: "anything Sep 24?", scope: { gatedOut: [{ name: "Founder Friends", reasons: ["sold out"] }] } }),
    dec(403, "2026-09-18T19:43:00Z", "reply.grounding", "act", "redrafted", { draft: "I sent you three events yesterday", final: "Here's what I found" }),
    dec(404, "2026-09-18T19:43:30Z", "reply.grounding", "act", "as_drafted", { draft: "Same", final: "Same" }),
    dec(405, "2026-09-18T19:44:00Z", "router.decideActions", "act", "none", { confidence: "low", reason: "unclear" }),
    dec(406, "2026-09-18T19:44:30Z", "router.decideActions", "act", "none", { confidence: "high" }),
    dec(407, "2026-09-18T19:45:00Z", "turn.latency", "act", "reply", { ms: 9000 }, [{ name: "within_budget", pass: true }]),
  ],
});
const miscTypes = logFlags(misc).map((f) => f.type);
check("a 'came up empty' text is flagged", miscTypes.includes("came_up_empty_text"));
check("a search that sent nothing is flagged", miscTypes.includes("search_sent_nothing"));
check("a search with everything turned away is flagged separately", miscTypes.includes("found_but_turned_away"));
check("a rewritten reply is flagged, an unchanged one isn't", miscTypes.filter((t) => t === "reply_rewritten").length === 1);
check("only a low-confidence router read is flagged", miscTypes.filter((t) => t === "router_unsure").length === 1);
check("a reply within budget isn't flagged", !miscTypes.includes("slow_reply"));

// --- Reactions.
const reactions = base({
  messages: [
    msg("2026-09-18T21:00:00Z", "co", "Here's a pottery class Thursday."),
    msg("2026-09-18T21:01:00Z", "member", "That's not what I asked, I wanted founder events"),
    msg("2026-09-18T21:05:00Z", "member", "Rough day at work honestly"),
  ],
  emotions: [
    { at: "2026-09-18T21:01:05Z", source: "text", emotion: "frustrated", intensity: "high", about: "Co's search results", quote: "That's not what I asked", target: "co" },
    { at: "2026-09-18T21:05:05Z", source: "text", emotion: "stressed", intensity: "medium", about: "work", quote: null, target: "life" },
  ],
});
const rf = reactionFlags(reactions);
check("frustration with Co is flagged", rf.some((f) => f.type === "member_frustrated_with_co" && f.severity === "high"));
check("a hard day in their life is not a flag about Co", rf.filter((f) => f.type === "member_frustrated_with_co").length === 1);
check("'that's not what I asked' is flagged with Co's message before it", rf.some((f) => f.type === "member_called_out_miss" && f.snippet.includes("pottery")));
check("a callout already in user_reported_issues is counted once", !reactionFlags({ ...reactions, issues: [{ at: "2026-09-18T21:01:10Z", message: "That's not what I asked", summary: "Sent the wrong kind of event", category: "behavior", severity: "high" }] }).some((f) => f.type === "member_called_out_miss"));

// --- Model flags must quote real messages.
check("a real quote is found in the conversation", !!findQuoted("that's the one from that window that actually fits", techWeek.messages));
check("smart quotes and spacing don't matter", !!findQuoted("Already sent you  Hardware FYI", techWeek.messages));
check("an invented quote is rejected", !findQuoted("I searched every calendar in SF", techWeek.messages));
check("a tiny quote can't match by accident", !findQuoted("the", techWeek.messages));

// --- Grouping and the morning text.
const all = [...twConv, ...conversationFlags(vc), ...hiringLog, ...logFlags(misc)];
const groups = groupFlags(all);
check("groups rank by how often each happened", groups[0].type === "restated_own_message" && groups[0].count === 2);
const digest = renderDigest(all, { u1: "Royce" }, "last 24h");
check("the digest opens with the count and ends with how to get detail", digest[0].startsWith("Co review, last 24h:") && digest[digest.length - 1].includes("what broke since"));
check("the digest is short enough for a text", digest.join("\n").length < 3000);
const manyTypes = ["slow_reply", "search_sent_nothing", "found_but_turned_away", "stretch_send", "came_up_empty_text", "reply_rewritten", "router_unsure", "off_topic_search"].map((type, i) => ({ userId: "u1", at: `2026-09-18T1${i}:00:00Z`, type, severity: "low", snippet: "x", decisionIds: [], cause: "c", causeConfirmed: true, source: "log" }) as any);
const trimmed = renderDigest(manyTypes, { u1: "Royce" }, "last 24h").join("\n");
check("the digest lists at most 6 types and points to the rest", (trimmed.match(/^• /gm) ?? []).length === 6 && trimmed.includes("Plus 2 less frequent types"));
check("an empty day says so plainly", renderDigest([], {}, "last 24h")[0] === "Co review, last 24h: nothing flagged.");

// --- The model review sees asks saved on earlier days.
const withAsks = loggedActions(base({ openAsks: [{ text: "Looking for grants for a founder event", savedAt: "2026-09-15T18:00:00Z" }] }));
check("open asks from earlier days are in the log the model reads", withAsks.includes("[saved 2026-09-15] open ask") && withAsks.includes("grants for a founder event"));

// --- Dev only.
check("never outside co-test", !reviewEnabled({ RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_SERVICE_NAME: "CoPatible", DEV_REVIEW: "true" } as any));
check("not on co-test without the flag", !reviewEnabled({ RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "co-test" } as any));
check("on co-test with the flag", reviewEnabled({ RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "co-test", DEV_REVIEW: "true" } as any));

// Rejected events shown in the morning digest (2026-09-21).
{
  const r = renderRejectedSample([{ name: "Sergey Levine fireside", why: "single founder fireside chat" }, { name: "Mahjong After Dark", why: null }, { name: "sergey levine fireside", why: "again" }]);
  check("rejected sample lists each event once with its reason", !!r && r.includes("Sergey Levine fireside: single founder fireside chat") && (r.match(/fireside/gi) ?? []).length === 2 && r.includes("(2)"));
  check("an event with no reason still shows", !!r && r.includes("• Mahjong After Dark"));
  check("nothing rejected means no section", renderRejectedSample([]) === null);
  const many = renderRejectedSample(Array.from({ length: 9 }, (_, i) => ({ name: `E${i}`, why: "x" })), 6);
  check("the list is capped and says how many more", !!many && many.includes("Plus 3 more.") && !many.includes("E6"));
}

// The business numbers (harness/metrics.ts, 2026-09-22): a rate always carries its counts, a
// small sample never becomes a percentage, and an empty denominator never prints NaN.
{
  check("a small sample is shown as counts, not a percentage", rate(3, 4) === "3 of 4");
  check("a large enough sample gets a percentage with its counts", rate(15, 20) === "75% (15 of 20)");
  check("an empty denominator says so instead of NaN or 0%", rate(0, 0) === "none yet");
  const m: Metrics = {
    days: 30,
    members: { total: 2, newInWindow: 2, joinedByInvite: 2 },
    invites: { issued: 4, redeemed: 3 },
    engagement: { activeLast7: 2, retainedEligible: 0, retainedActive: 0 },
    offers: { sent: 24, reacted: 0, interested: 0, notInterested: 0, alreadyDid: 0 },
    outcomes: { acted: 0, helped: 0, didntHelp: 0 },
    intros: { inRoomYes: 0, inRoomNo: 0, introEmails: 0, networkIntroduced: 0 },
    debriefs: { total: 0, positive: 0, critical: 0 },
    relationship: { memberStarts: 3, coStarts: 6, companionSent: 2, companionReplied: 2, offerSent: 4, offerReplied: 2, sharedPersonal14d: 1 },
  };
  const lines = metricLines(m);
  check("every metric gets a line", lines.length === 12);
  check("no line prints NaN or undefined", !lines.some((l) => /NaN|undefined/.test(l)));
  check("only the one large sample (24 offers) gets a percentage", lines.filter((l) => /%/.test(l)).length === 1 && lines.some((l) => l.includes("0% (0 of 24)")));
  check("who starts the conversation reads as counts", lines.some((l) => l.includes("members started 3 of 9")));
  check("companion replies and offer replies are reported separately", lines.some((l) => l.startsWith("Replies within a day to companion messages") && l.includes("2 of 2")) && lines.some((l) => l.startsWith("Replies within a day to offers") && l.includes("2 of 4")));
  check("personal shares are counted against all members", lines.some((l) => l.includes("not an ask") && l.includes("1 of 2")));
  check("retention with nobody old enough says so", lines.some((l) => l.includes("Still active after two weeks") && l.includes("none yet")));
  const html = renderMetricsHtml(m);
  check("the relationship comes first in the Monday email", html.indexOf("The relationship") < html.indexOf("Growth, offers and intros"));
}

// The week before (2026-09-26): true references to earlier sends and to what
// they said earlier aren't flagged as invented.
{
  const { reviewDataFromRows, modelReviewPrompt, earlierRecord } = await import("../../src/harness/devReview.js");
  const d = reviewDataFromRows({
    userId: "u", firstName: "Royce", msgs: [], decisions: [], emotions: [], issues: [], asks: [],
    earlierMem: [
      { created_at: "2026-09-24T22:26:00Z", memory_type: "text_exchange", content: "Co replied: Thursday rooftop mixer in SF, Sui's pulling together founders." },
      { created_at: "2026-09-24T22:26:00Z", memory_type: "recommendation_offered", content: JSON.stringify({ name: "SVVR #102: Meta Connect Meetup + Party" }) },
      { created_at: "2026-09-24T22:17:00Z", memory_type: "text_exchange", content: "User said: maybe it's time to figure out how to get into an accelerator or in touch with VCs" },
    ],
    earlierSends: [{ sent_at: "2026-09-23T17:00:00Z", type: "event_offer", message: "https://lu.ma/x  A dinner" }],
  });
  const rec = earlierRecord(d);
  check("earlier: what Co sent, in its own words", /recommended "SVVR #102: Meta Connect Meetup \+ Party"/.test(rec) && /Thursday rooftop mixer/.test(rec) && /texted them unprompted \(event_offer\)/.test(rec));
  check("earlier: what they told Co", /accelerator or in touch with VCs/.test(rec));
  const pr = modelReviewPrompt(d);
  check("prompt: the week before is in, and counts as backing", /The 7 days before today/.test(pr) && /neither today's decision log nor the earlier record backs up/.test(pr));
  check("prompt: Co's own rules are in, so stating them isn't flagged", /What Co can do and its standing rules/.test(pr) && /5 invites each/.test(pr));
  check("review has room to answer after thinking", /maxOutputTokens: 16_000/.test(readFileSync(new URL("../../src/harness/devReview.ts", import.meta.url), "utf8")));
}

{
  // Held back (2026-10-02), shaped like Royce's queue on 10/2: ask check-ins
  // queued days ago, nothing sent since 9/30, every pick blocked on the weekly cap.
  const now = new Date("2026-10-02T20:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const held = [1, 2, 3, 4, 5].map((i) => ({ id: String(50 + i), type: "ask_checkin", createdAt: ago(3), summary: `ask ${i}` })).concat([{ id: "71", type: "companion", createdAt: ago(2.5), summary: "advice" }]);
  const picks = [{ at: ago(0.2), candidates: [...held.slice(0, 5).map((h) => ({ id: h.id, failed: ["weekly_cap"] })), { id: "71", failed: ["type_gap"] }] }];
  const f = heldBackFlags({ userId: "u", now, held, lastSendAt: ago(2.1), picks });
  check("held 2+ days with nothing sent: flagged, high with 5+ items", f.length === 1 && f[0].type === "held_back" && f[0].severity === "high");
  check("...naming the checks that held them, most first", f[0]?.cause === "held by weekly_cap ×5, type_gap ×1" && f[0].causeConfirmed);
  check("a text in the last 2 days: no flag", heldBackFlags({ userId: "u", now, held, lastSendAt: ago(1), picks }).length === 0);
  check("items queued under 2 days ago don't count", heldBackFlags({ userId: "u", now, held: held.map((h) => ({ ...h, createdAt: ago(1) })), lastSendAt: ago(5), picks }).length === 0);
  check("no pick at all in 2 days is named as the cause", heldBackFlags({ userId: "u", now, held, lastSendAt: ago(3), picks: [] })[0]?.cause === "no daily pick ran for them in 2 days");
  check("eligible but never picked is named too", /2 eligible but never picked/.test(heldBackFlags({ userId: "u", now, held: held.slice(0, 2), lastSendAt: ago(3), picks: [{ at: ago(0.5), candidates: held.slice(0, 2).map((h) => ({ id: h.id, failed: [] })) }] })[0]?.cause ?? ""));
  check("opt-out or local hours holding the person is named, not 'eligible but never picked'", heldBackFlags({ userId: "u", now, held: held.slice(0, 2), lastSendAt: ago(3), picks: [{ at: ago(0.5), personBlocked: ["not_opted_out"], candidates: held.slice(0, 2).map((h) => ({ id: h.id, failed: [] })) }] })[0]?.cause === "held by not_opted_out ×2");
  check("a night-time pick (local hours) doesn't hide the daytime cause", heldBackFlags({ userId: "u", now, held: held.slice(0, 2), lastSendAt: ago(3), picks: [{ at: ago(0.1), personBlocked: ["local_hours"], candidates: held.slice(0, 2).map((h) => ({ id: h.id, failed: [] })) }, { at: ago(0.6), candidates: held.slice(0, 2).map((h) => ({ id: h.id, failed: ["weekly_cap"] })) }] })[0]?.cause === "held by weekly_cap ×2");
  check("an item picked and then put off is named as that", /picked, then put off ×1/.test(heldBackFlags({ userId: "u", now, held: held.slice(0, 1), lastSendAt: ago(3), picks: [{ at: ago(0.5), picked: held[0].id, action: "defer:ask_checkin", candidates: [{ id: held[0].id, failed: [] }] }] })[0]?.cause ?? ""));
  check("a member never sent anything, small queue: medium, not high", heldBackFlags({ userId: "u", now, held: held.slice(0, 2), lastSendAt: null, picks })[0]?.severity === "medium");
  check("one held item, quiet 2 days: medium", heldBackFlags({ userId: "u", now, held: held.slice(0, 1), lastSendAt: ago(2.5), picks })[0]?.severity === "medium");
}

console.log(`review rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
