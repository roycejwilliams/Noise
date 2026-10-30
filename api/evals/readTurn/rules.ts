// Model-free checks for the one read of the moment (services/readTurn.ts)
// and threading under the thing being discussed (2026-09-28).
//
//   npx tsx evals/readTurn/rules.ts
import { readFileSync } from "fs";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const R = await import("../../src/services/readTurn.js");
const I = await import("../../src/services/inlineReply.js");
const { buildRouterPrompt } = await import("../../src/services/messageRouter.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const base = { reason: "asking about timing", answers: null, ambiguousBetween: [], call: "none", wantsRecommendation: false, confidence: "high" };
const sent = ["Grok Bot x Notion for Product Builders night (SF)", "daytonaio AI Builders Demo Night"];
const read = R.parseTurnRead({ ...base, mode: "logistics", topic: "whether Tuesday's two events overlap", pushback: null, lesson: "ignored", dots: [{ kind: "mention", link: "ties to Oct 10 sponsors", why: "sponsors" }], emotion: null, seeking: "none", feedback: [], about_sent: "grok bot x notion for product builders night (sf)", covered_now: [], missing: ["personality", "nope"] }, sent);
check("the router part comes out exactly as the router's own", read.router.call === "none" && read.router.answers === null && read.router.confidence === "high");
check("a logistics turn carries no connections (code holds the model's own mode)", read.moment.mode === "logistics" && read.moment.dots.length === 0);
check("no lesson without pushback", read.moment.lesson === null);
check("about_sent matches a real sent item, whatever its case", read.aboutSent === "Grok Bot x Notion for Product Builders night (SF)");
check("an unknown thing is never about_sent", R.parseTurnRead({ ...base, about_sent: "Some other event" }, sent).aboutSent === null);
check("coverage keeps only real topic keys", JSON.stringify(read.coverage?.missing_topics) === '["personality"]' && read.coverage?.fresh_topics?.length === 0);
const share = R.parseTurnRead({ ...base, mode: "sharing", pushback: "tied it to Oct 10", lesson: "answer logistics as logistics", dots: [{ kind: "shape", link: "burned out", why: "break" }], emotion: { emotion: "Frustrated", intensity: "medium", valence: "negative", about: "Cue's answer", target: "co" }, seeking: "solving", feedback: ["Get the time for every event Cue surfaces"] }, sent);
check("sharing keeps connections; pushback keeps its lesson", share.moment.dots.length === 1 && share.moment.lesson === "answer logistics as logistics");
check("feelings aimed at Cue are read as Cue's", share.emotion?.target === "co" && share.emotion?.emotion === "frustrated" && share.seeking === "solving");
check("feedback becomes a reminder to save each piece, never a veto", /saveFeedbackForTeam/.test(R.feedbackInstruction(share.feedback) ?? "") && R.feedbackInstruction([]) === null);
const prompt = buildRouterPrompt({ message: "hi", recentConversation: "", openItems: [] }) + R.turnReadAddendum(null, null);
check("the read is the router's own prompt plus fields that never change it", prompt.startsWith(buildRouterPrompt({ message: "hi", recentConversation: "", openItems: [] })) && /never change the fields above/.test(prompt));

check("threads under their message first, then the thing it's about", I.threadReason({ theyRepliedInline: true, newerTextSince: false, aboutSentHandle: "h" }) === "mirror" && I.threadReason({ theyRepliedInline: false, newerTextSince: false, aboutSentHandle: "h" }) === "about_sent" && I.threadReason({ theyRepliedInline: false, newerTextSince: false }) === null);
const sb = src("routes/sendblue.ts");
// 2026-10-29: the READ_TURN=off fallback (separate seeking, feeling, moment and issue reads) is gone; every text gets the one read.
check("one read for every text, with no switch back to the separate reads", /const readP: Promise<TurnRead> \| null =\s*hasText && turnP/.test(sb) && !/READ_TURN|readTurnEnabled|oneRead|seekingAndEmotion|detectSeekingMode|captureIssueReport|readMoment\(/.test(sb) && !("readTurnEnabled" in R));
check("a voice memo or photo alone (no text read) is still routed", /\} else \{\s*const routed = await propagateAttributes\(\{ userId: user\.id, traceName: "sendblue\.router\.route" \}, \(\) => routeMessage\(routeInput\)\);/.test(sb));
check("coverage, the moment and emotion all come from the read", /readP\.then\(\(r\) => coverageNudgeFrom\(user\.id, profile, r\.coverage\)\)/.test(sb) && /dotsP = Promise\.resolve\(turnRead\.moment\)/.test(sb) && /const seekingMode = turnRead\?\.seeking \?\? null;\s*const textEmotion = turnRead\?\.emotion \?\? null;/.test(sb));
check("threading about a sent thing uses Cue's own message, found for this member only", /return why === "about_sent" \? aboutSentHandle : why \? ownHandle : null;/.test(sb) && /WHERE user_id = \$1 AND sent_at > NOW\(\) - INTERVAL '45 days'/.test(src("services/inlineReply.ts")));
check("every message Cue sends is kept by its handle", /if \(res\?\.message_handle\) recordOutbound\(/.test(src("services/sendblue.ts")) && /CREATE TABLE IF NOT EXISTS outbound_messages/.test(src("db/migrations.ts")));

console.log(`readTurn rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
