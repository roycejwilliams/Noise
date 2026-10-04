// Model-free checks for reading a call's feelings from what the member said
// (harness/emotion.ts callEmotionMoments, 2026-10-03). The read itself is the
// text path's (readTextEmotion), faked here. No API calls, no database:
//   npx tsx evals/emotion/callRules.ts
import { readFileSync } from "fs";
import { callEmotionMoments, callLinesToRead, CALL_EMOTION_MAX_MOMENTS, CALL_EMOTION_MAX_READS, CALL_FRUSTRATION, frustrationMoments, frustrationScores, summarizeSignals, type EmotionSignal, type TextEmotion } from "../../src/harness/emotion.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const transcript = [
  "assistant: Hey Jordan, it's Co. What's actually going on with you these days?",
  "user: Honestly I'm exhausted, the move has taken everything out of me",
  "assistant: That sounds like a lot.",
  "user: yeah",
  "user: And my cofounder just told me he wants out, which I did not see coming",
  "assistant: I'm sorry. How are you holding up?",
  "user: I'm trying to stay excited about the demo day though, it's next week",
].join("\n");

const lines = callLinesToRead(transcript);
check("only the member's lines are read, and a bare 'yeah' isn't", lines.length === 3 && lines.every((l) => !/^assistant/i.test(l.text)) && !lines.some((l) => l.text === "yeah"));
check("each line comes with what was said before it, labelled Them and Co", /Co: Hey Jordan/.test(lines[0].context) && /Them: Honestly I'm exhausted/.test(lines[1].context) && /Co: I'm sorry/.test(lines[2].context));
check("the lines stay in call order", lines.map((l) => l.index).join() === "1,4,6");
const long = Array.from({ length: 50 }, (_, i) => `user: ${"word ".repeat(3 + (i % 7))}number ${i}`).join("\n");
const capped = callLinesToRead(long);
const all = callLinesToRead(long, 50);
const keptIdx = new Set(capped.map((l) => l.index));
check("a long call reads at most the cap, the longest lines, still in order", capped.length === CALL_EMOTION_MAX_READS && capped.every((l, i) => i === 0 || capped[i - 1].index < l.index) && Math.min(...capped.map((l) => l.text.length)) >= Math.max(...all.filter((x) => !keptIdx.has(x.index)).map((l) => l.text.length)));

const feel = (emotion: string, intensity: "low" | "medium" | "high", valence: "negative" | "positive" | "mixed", about: string | null = "the move", target: "co" | "life" = "life"): TextEmotion => ({ emotion, intensity, valence, about, target });
const fake = (m: Record<string, TextEmotion>, seen?: { id: string[]; ctx: string[] }) => async (message: string, ctx: string, id: string): Promise<TextEmotion> => {
  seen?.id.push(id);
  seen?.ctx.push(ctx);
  for (const [k, v] of Object.entries(m)) if (message.includes(k)) return v;
  return null;
};
const seen = { id: [] as string[], ctx: [] as string[] };
const moments = await callEmotionMoments(transcript, fake({ exhausted: feel("exhausted", "high", "negative"), "wants out": feel("shocked", "medium", "negative", "his cofounder"), "demo day": feel("hopeful", "low", "positive", "demo day") }, seen));
check("the feelings come back strongest first, as call moments with what they said", moments.map((m) => m.emotion).join() === "exhausted,shocked,hopeful" && moments.every((m) => m.source === "call") && /exhausted, the move/.test(moments[0].quote ?? "") && moments[1].about === "his cofounder");
check("it's the text path's read: asked through the same function with a call id, with context", seen.id.length === 3 && seen.id.every((i) => i === "call.readTextEmotion") && seen.ctx.every((c) => c.length > 0));
const many = await callEmotionMoments(transcript, async () => feel("tired", "high", "negative"));
check("one moment per feeling, so one feeling doesn't crowd out the rest", many.length === 1);
const dist = await callEmotionMoments([1, 2, 3, 4, 5].map((i) => `user: this line number ${i} has enough words in it`).join("\n"), (() => { let n = 0; return async () => feel(`feeling${n++}`, "medium", "negative"); })());
check("at most three moments are kept", dist.length === CALL_EMOTION_MAX_MOMENTS);
check("a frustration with Co keeps its target, as on the text path", (await callEmotionMoments(transcript, fake({ exhausted: feel("frustrated", "high", "negative", "what Co found", "co") })))[0].target === "co");
check("a read that fails or finds nothing leaves no moment and never throws", (await callEmotionMoments(transcript, async () => { throw new Error("boom"); })).length === 0 && (await callEmotionMoments(transcript, async () => null)).length === 0);

// The loop treats them as it treated Hume's moments.
const now = new Date("2026-10-03T20:00:00Z");
const at = (m: number) => new Date(now.getTime() - m * 60_000);
const sig = (o: Partial<EmotionSignal>): EmotionSignal => ({ source: "call", emotion: "exhausted", intensity: "high", valence: "negative", about: "the move", quote: "q", at: at(30), target: "life", ...o });
const ctx = summarizeSignals([sig({}), sig({ emotion: "hopeful", intensity: "low", valence: "positive", about: "demo day" })], now);
check("the loop reads the call: strongest moment is current, the call's moments are listed", ctx.lastCall?.moments.length === 2 && ctx.current?.emotion === "exhausted");
check("a negative life moment from a call makes needsCare (a later positive one clears it)", summarizeSignals([sig({})], now).needsCare === true && summarizeSignals([sig({}), sig({ emotion: "hopeful", valence: "positive", intensity: "medium", at: at(10) })], now).needsCare === false);
check("a frustration with Co on a call counts as frustration with Co", summarizeSignals([sig({ emotion: "frustrated", target: "co", about: "what Co found" })], now).withCo.frustrated === true);

// Wiring.
const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
check("the call's feelings are read alongside profile learning, recorded with the transcript's id, and awaited before the call is finished", co.indexOf("const emotionDone = (async () => {") > 0 && co.indexOf("const emotionDone") < co.indexOf("await learnFromCall(") && co.indexOf("await emotionDone;") > co.indexOf("await learnFromCall(") && co.indexOf("await emotionDone;") < co.indexOf("captureIntent(user_id") && /memoryId: transcriptMemoryId/.test(co));
check("a retried delivery doesn't record them twice, and a failure can't fail the call", /SELECT 1 FROM emotion_signals WHERE memory_id = \$1 AND basis IS DISTINCT FROM 'sound_tag' LIMIT 1/.test(co) && /reading the call's feelings failed \(non-fatal\)/.test(co));

// ElevenLabs' frustration score, beside the text read (2026-10-04). Shapes from a real co-test call.
const elTurns = [
  { role: "agent", message: "Hey Jordan, it's Co.", analysis: null },
  { role: "user", message: "It's been a hard week.", analysis: { user_sentiment_score: -0.5, user_frustration_score: 0.1 } },
  { role: "user", message: "Oh, perfect. That's just perfect.", analysis: { user_sentiment_score: -0.6, user_frustration_score: 0.5 } },
  { role: "user", message: "I'm so done with this. My co-founder pushed the release again.", analysis: { user_sentiment_score: -0.8, user_frustration_score: 0.7 } },
  { role: "user", message: "No, it's great, really. Everything's great.", analysis: { user_sentiment_score: -0.4, user_frustration_score: 0.4 } },
  { role: "user", message: "Yeah, I'm fine.", analysis: { user_sentiment_score: -0.2, user_frustration_score: 0.3 } },
  { role: "user", message: "no score here" },
];
const scored = frustrationScores(elTurns);
check("only the caller's scored lines are read", scored.length === 5 && !scored.some((l) => /Jordan, it's Co/.test(l.text)));
check("frustrationScores tolerates a missing or odd transcript", frustrationScores(null).length === 0 && frustrationScores({}).length === 0);
const textRead = [{ valence: "negative" as const, quote: "I'm so done with this. My co-founder pushed the release again." }];
const fr = frustrationMoments(scored, textRead);
check(`a line scored ${CALL_FRUSTRATION.min}+ the text read missed becomes a frustrated moment ("that's just perfect")`, fr.some((m) => /just perfect/.test(m.quote ?? "") && m.emotion === "frustrated" && m.valence === "negative" && m.source === "call"));
check("a line the text read already called negative isn't counted twice", !fr.some((m) => /so done with this/.test(m.quote ?? "")));
check(`below ${CALL_FRUSTRATION.min} isn't a moment ("Yeah, I'm fine" at 0.3)`, !fr.some((m) => /I'm fine/.test(m.quote ?? "")));
check(`at most ${CALL_FRUSTRATION.maxMoments}, strongest first, and ${CALL_FRUSTRATION.high}+ is high`, fr.length <= CALL_FRUSTRATION.maxMoments && fr[0].quote!.includes("just perfect") && fr[0].intensity === "medium" && frustrationMoments([{ text: "ugh this again", frustration: 0.7 }], [])[0].intensity === "high");
check(`a line alone below ${CALL_FRUSTRATION.min} is never a moment`, frustrationMoments([{ text: "Yeah, I'm fine.", frustration: 0.39 }], []).length === 0 && frustrationMoments([{ text: "Yeah, I'm fine.", frustration: 0.4 }], []).length === 1);
check(`never more than ${CALL_FRUSTRATION.maxMoments} a call, the strongest kept`, (() => { const m = frustrationMoments([0.45, 0.9, 0.5, 0.8].map((f, i) => ({ text: `line number ${i} about the release again`, frustration: f })), []); return m.length === CALL_FRUSTRATION.maxMoments && m[0].quote!.includes("number 1") && m[1].quote!.includes("number 3"); })());
check("a positive text-read line doesn't block it", frustrationMoments([{ text: "Oh, perfect. That's just perfect.", frustration: 0.5 }], [{ valence: "positive", quote: "Oh, perfect. That's just perfect." }]).length === 1);
check("recorded with the text read's moments, same transcript id, inside the non-fatal block", /const frustrated = frustrationMoments\(scored, moments\);/.test(co) && /recordEmotionSignals\(user_id, \[\.\.\.moments, \.\.\.frustrated\]/.test(co) && co.indexOf("frustrationMoments(scored, moments)") > co.indexOf("const emotionDone = (async () => {") && co.indexOf("frustrationMoments(scored, moments)") < co.indexOf("reading the call's feelings failed (non-fatal)"));
check("the scores come from the webhook's turns, else the conversation fetched once (never fails the call)", /const here = frustrationScores\(turns\);[\s\S]*fetchConversationTurns\(conversationId\)/.test(co) && /frustration\(\)\.catch\(\(\) => \[\]/.test(co));
// Review of #61: a score can't tell frustration with Co from frustration with
// life, so alone it never marks a hard day (needsCare holds some check-ins).
check("score moments are tagged frustration_score", fr.every((m) => (m as any).basis === "frustration_score"));
const nowT = new Date("2026-10-04T20:00:00Z");
const scoreRow = { source: "call" as const, emotion: "frustrated", intensity: "high" as const, valence: "negative" as const, about: null, quote: "Oh, perfect.", at: new Date("2026-10-04T19:00:00Z") };
check("a frustration score alone never sets needsCare", summarizeSignals([{ ...scoreRow, basis: "frustration_score" as const }], nowT).needsCare === false);
check("the same feeling from the text read still does", summarizeSignals([scoreRow], nowT).needsCare === true);
check("Co still sees the score moment from the call", summarizeSignals([{ ...scoreRow, basis: "frustration_score" as const }], nowT).lastCall?.moments.length === 1);
const emo = readFileSync(new URL("../../src/harness/emotion.ts", import.meta.url), "utf8");
const migs = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
const metr = readFileSync(new URL("../../src/harness/metrics.ts", import.meta.url), "utf8");
check("the tag is stored and read back, and the column exists", /INSERT INTO emotion_signals \([^)]*basis\)/.test(emo) && /basis: s\.basis \?\? null/.test(emo) && /target, basis FROM emotion_signals/.test(emo) && /ALTER TABLE emotion_signals ADD COLUMN IF NOT EXISTS basis TEXT/.test(migs));
check("the 'shared how life is going' metric doesn't count scores", /es\.target = 'life' AND es\.basis IS NULL/.test(metr));
check("the scores are fetched alongside the text read, and which path supplied them is logged", co.indexOf("const scoring = frustration") < co.indexOf("const moments = await callEmotionMoments(cleanTranscript);") && /frustration scores for \$\{conversationId\} from/.test(co));
const elc = readFileSync(new URL("../../src/services/elevenLabsCalls.ts", import.meta.url), "utf8");
check("the fetch has a timeout and returns null on any failure", /export async function fetchConversationTurns[\s\S]*AbortSignal\.timeout\(timeoutMs\)[\s\S]*catch \{\s*return null;/.test(elc));

console.log(`call emotion rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
