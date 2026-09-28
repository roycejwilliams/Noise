// Model-free checks for making Co adaptable (2026-09-26): living asks,
// per-member texting style, and learning from how things landed.
//
//   npx tsx evals/adaptable/rules.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { mergeNotes, styleLearningPrompt, MAX_NOTES } = await import("../../src/services/textingStyle.js");
const { ABILITIES } = await import("../../src/services/capabilities.js");

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// ---- living asks
const jobs = src("src/jobs/index.ts");
check("only asks a search can find are searched", /WHERE ac\.resolved_at IS NULL AND ac\.kind = 'find'/.test(jobs));
check("what they brought up in the last few days is searched first", /ORDER BY \(COALESCE\(ac\.last_mentioned_at, ac\.created_at\) > NOW\(\) - INTERVAL '3 days'\) DESC,\s*ac\.last_attempted_at ASC NULLS FIRST/.test(jobs));
check("asks are classified and profiles synced before each sweep", /await classifyOpenAsks\(\)[\s\S]{0,200}await syncClosedAsks\(\)/.test(jobs));
const pe = src("src/services/profileExtraction.ts");
check("a new ask is classified and marked mentioned", /INSERT INTO ask_checkins \(user_id, ask_id, ask_text, expires_at, kind, kind_checked_at, last_mentioned_at\)/.test(pe) && /classifyAsk\(ask\.text\)/.test(pe));
check("restating an ask marks it mentioned again", /expires_at = COALESCE\(\$4::timestamptz, expires_at\), last_mentioned_at = NOW\(\)/.test(pe));
check("an ask resolved from what they said closes in the profile too", /markIntentResolved\(user_id, resolvedAskIds\)/.test(pe));
const ak = src("src/services/askKind.ts");
check("closing an ask updates both places and retires its matches", /UPDATE ask_checkins SET resolved_at[\s\S]{0,200}markIntentResolved\(userId, \[askId\]\)[\s\S]{0,300}UPDATE relevance_edges SET status = 'retired'/.test(ak));
check("unsure asks keep being searched", /return "find";\s*\}\s*\}/.test(ak));
check("instant searches of a new ask only for find asks", /ac\.last_attempted_at IS NULL AND ac\.kind = 'find'/.test(src("src/services/eventSurfacingSweep.ts")));
const tools = src("src/agent/conversationTools.ts");
check("Co can close an ask, matched to exactly one open ask, with a receipt", /closeAsk: tool\(\{[\s\S]{0,1600}hits\.length !== 1[\s\S]{0,200}notDone\(/.test(tools));

// ---- texting style
check("style notes are deduped and capped", JSON.stringify(mergeNotes(["Keep it short", "keep it short", "", "Lead with the answer", "a", "b", "c", "d", "e"])) === JSON.stringify(["Lead with the answer", "a", "b", "c", "d", "e"].slice(-MAX_NOTES)) && mergeNotes(null).length === 0);
const sp = styleLearningPrompt(["Keep it short"], "Here are three options…", "just tell me which one");
check("only a clear preference about how Co texts becomes a note", /A normal reply is not a preference/.test(sp) && /Never note anything about their life or plans here/.test(sp));
check("a new note replaces one it contradicts", /drop any older note the new one contradicts/.test(sp));
check("Co reads the notes before every reply", /textingStyleFor\(userId\)[\s\S]{0,200}How they've told you they like to be texted, follow it/.test(src("src/harness/replyGrounding.ts")));
check("learning runs in the background after each message", /if \(hasText\) learnTextingStyle\(user\.id, lastCoLine\(recentConversation\), resolvedContent\)\.catch/.test(src("src/routes/sendblue.ts")));

// ---- outcomes
check("Co records how things landed, only for things it really sent", /noteReaction: tool\(\{[\s\S]{0,2200}memory_type = 'recommendation_offered'[\s\S]{0,900}isn't something Co sent them recently/.test(tools));
check("reactions map to outcomes the search already learns from", /interested: "interested", going: "acted", went_liked: "helped", went_disliked: "didnt_help", not_for_me: "declined"/.test(readFileSync(new URL("../../src/services/reactionCatchup.ts", import.meta.url), "utf8")) && /REACTION_RESULT\[reaction\]/.test(tools));
check("what's landed feeds replies and Co's choice of what to send first", /tasteSummary\(userId\)/.test(src("src/harness/replyGrounding.ts")) && /What's landed with them before: \$\{about\.taste/.test(src("src/harness/proactive.ts")));

// ---- registry
for (const t of ["closeAsk", "noteReaction", "checkInvitesLeft"]) check(`${t} is in Co's registry`, ABILITIES.some((a) => a.tool === t));

console.log(`adaptable rules: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
