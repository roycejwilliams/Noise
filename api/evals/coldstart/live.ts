// Cold start, live (Haiku via the meter, well under $0.05): does a realistic opening exchange, given the steering instruction, get a
// natural question that lets them name something findable? And does the answer land as a find request?
//   EVAL_COST_CAP_USD=0.05 npm run -s eval:live -- evals/coldstart/live.ts
// A proxy, not the production reply: Co's core and the text channel, the facts block with the steering instruction, their message.
import "../lib/requireMeter.js";
import "dotenv/config";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../../src/models.js";
import { CO_CORE } from "../../src/services/coCore.js";
import { CO_TEXT_CHANNEL } from "../../src/services/coVoice.js";
import { addColdStartSteer, createReplyFacts, renderReplyFacts, todayFact } from "../../src/harness/replyGrounding.js";
import { countSeeds } from "../../src/services/coldStart.js";
import { questionsIn } from "../../src/harness/repeatAsk.js";
import { captureIntentPrompt, normalizeCapturedAsks } from "../../src/services/profileExtraction.js";
import { parseModelJson } from "../../src/services/modelJson.js";

let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail !== undefined ? `\n     ${JSON.stringify(detail).slice(0, 500)}` : ""}`); };

const rf = createReplyFacts();
rf.facts.push({ id: "F1", kind: "known", text: todayFact("America/Los_Angeles") });
addColdStartSteer(rf, { seeds: countSeeds({ goals: [], findAsks: [] }), history: [], joinedAt: new Date() }, { emotional: null });
const message = "Just moved here from New York for a job at a climate startup. Still figuring out the city honestly.";
const { text: reply } = await generateText({
  model: anthropic(MODELS.haiku),
  maxOutputTokens: 300,
  system: `${CO_CORE}\n\nYou are replying by iMessage to Jordan, a new member. ${CO_TEXT_CHANNEL}`,
  prompt: `${renderReplyFacts(rf)}\n\nRecent conversation:\nCo replied: Glad you're here, Jordan. Texting works great.\n\nThey just said: "${message}"\n\nWrite only the text you'd send.`,
});
console.log(`\nreply: ${reply}\n`);
const qs = questionsIn(reply);
check("one question at most", qs.length <= 1, qs);
check("it asks something that lets them name a findable interest (people, rooms, scenes, what they miss)", qs.length === 1 && /people|room|scene|crowd|miss|meet|into|find|spots?|places?|community|group/i.test(qs[0]), qs);
check("follows their topic (the move, the city, the job)", /new york|nyc|move|moved|city|sf|san francisco|climate|job|startup/i.test(reply));
check("no survey phrasing", !/your (interests|hobbies)|what are you interested in/i.test(reply));
check("no em dashes, no exclamation points", !/[—–!]/.test(reply), reply);

// The answer to such a question, through the capture prompt (the saveAsk and call path).
const transcript = `assistant: ${reply.replace(/\n+/g, " ")}\nuser: Honestly I miss the small founder dinners we had in NYC. Nothing like that here yet that I've found.`;
const { text: raw } = await generateText({ model: anthropic(MODELS.haikuPinned), maxOutputTokens: 400, prompt: captureIntentPrompt(transcript, "last_user_message") });
let asks: { text: string; type: string }[] = [];
try { asks = normalizeCapturedAsks(parseModelJson(raw), "last_user_message"); } catch {}
console.log(`\ncaptured: ${JSON.stringify(asks)}\n`);
check("an interest named in answer to Co's question lands as a seeking ask", asks.length === 1 && asks[0].type === "seeking" && /dinner/i.test(asks[0].text), asks);

console.log(failed ? `cold start live: ${failed} failed` : "cold start live: all passed");
if (failed) process.exit(1);
