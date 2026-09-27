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

// ------------------------------------------------ wiring
check("every tool Co uses goes on the record", /await recordToolAction\(ctx\.userId, name, input\)/.test(src("agent/toolGuard.ts")));
check("every find Co sends goes on the record", /await recordSentItems\(/.test(src("services/recommendation.ts")));
check("every unprompted text goes on the record", (src("harness/proactive.ts").match(/recordProactiveText\(/g) ?? []).length >= 3);
check("Co's replies read the record, including older things they name", /await ledgerFacts\(userId, opts\.context \?\? ""\)/.test(src("harness/replyGrounding.ts")) && /context: `\$\{resolvedContent\}/.test(src("routes/sendblue.ts")));
check("the record starts filled from what was already logged", /backfillCoActions\(\)/.test(src("db/migrations.ts")));

console.log(`facts rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
