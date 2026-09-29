// One read of the moment (Royce, 2026-09-28: "Simplify how Co builds a
// reply: fewer layers, one shared picture of the moment"). Each text used to
// be read six separate times before Co drafted anything: the router, whether
// they want help or to be heard, how they feel (and whether it's about Co),
// what Co still doesn't know about them, the moment read (mode, topic,
// pushback, connections), and a word filter plus classifier for feedback.
// Each saw a different slice and they could disagree: a logistics question
// got tied to his Oct 10 event; a regex dropped "We should find time and date
// for any event we surface".
//
// Now one call. Its router part is the router's own prompt, word for word, so
// decideActions and its gates get exactly what they got before; the rest is
// added alongside, read from the same turn context (services/turnContext.ts).
// The privacy alert (Jev, zero-retention) and the crisis phrase backstop stay
// separate on purpose. READ_TURN=off runs the old separate reads.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { extractFirstJsonObject } from "./modelJson.js";
import { buildRouterPrompt, parseRouterOutput, ROUTER_MODEL, type RouteInput, type RouterOutput } from "./messageRouter.js";
import { DOTS_MODES, type Dot, type Mode, type Moment } from "./connectDots.js";
import { RAPPORT_TOPICS, RAPPORT_TOPIC_DESCRIPTIONS, type RapportTopic } from "./profileTopics.js";
import type { CoverageAssessment } from "./profileExtraction.js";
import type { EmotionTarget, Intensity, TextEmotion, Valence } from "../harness/emotion.js";
import type { TurnContext } from "./turnContext.js";

// What Co's reaction says it is doing. Meanings, not scripts: the read picks
// the one that fits, code sends only these.
export const ACK_EMOJIS = ["👀", "✍️", "🫡", "🚀", "👍"] as const;

export function parseAck(v: unknown): string | null {
  const bare = (s: string) => s.replace(/\uFE0F/g, "").trim();
  const s = typeof v === "string" ? bare(v) : "";
  return ACK_EMOJIS.find((e) => bare(e) === s) ?? null;
}

export function readTurnEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.READ_TURN !== "off";
}

export type TurnRead = {
  router: RouterOutput;
  latencyMs: number;
  emotion: TextEmotion;
  seeking: "solving" | null;
  moment: Moment;
  // Feedback about how Co works, one sentence per distinct piece. A reminder
  // for Co to save each with its tool; never a veto.
  feedback: string[];
  // The thing Co sent that this turn is about, by its name in the sent list.
  aboutSent: string | null;
  // The emoji Co reacts to their message with right away, to show what it's
  // about to do (Royce, 2026-09-29, from Instinct); null for most messages.
  ack: string | null;
  coverage: CoverageAssessment | null;
};

const MODES: Mode[] = ["sharing", "reacting", "asking", "logistics", "feedback", "planning", "small_talk"];

// The part added to the router's prompt.
export function turnReadAddendum(ctx: Pick<TurnContext, "asks" | "threads" | "offersThisWeek" | "sent"> | null, priorContext: string | null): string {
  const asks = ctx?.asks.map((a) => `- ${a.text}`).join("\n") || "- (nothing open)";
  const threads = ctx?.threads.map((t) => `- ${t.text}${t.feeling ? ` (feeling: ${t.feeling})` : ""}`).join("\n") || "- (nothing open)";
  const sent = ctx?.sent.slice(0, 12).map((s) => `- ${s.name}${s.url ? ` (${s.url})` : ""}`).join("\n") || "- (nothing recently)";
  const topics = RAPPORT_TOPICS.map((t) => `- ${t}: ${RAPPORT_TOPIC_DESCRIPTIONS[t]}`).join("\n");
  return `

ALSO, in the same JSON object, add these fields. They describe the same message and never change the fields above.

What they've asked Co for (their words):
${asks}

What they're in the middle of:
${threads}

Things Co sent them recently (newest first):
${sent}

Event offers Co has texted them in the last 7 days: ${ctx?.offersThisWeek ?? 0}
${priorContext ? `What was already known about them before this conversation: ${priorContext}\n` : ""}
"mode": what they're doing right now: "sharing" (telling Co about their life or feelings), "reacting" (responding to something Co sent), "asking" (a question), "logistics" (times, places, details), "feedback" (about how Co works), "planning", or "small_talk" (thanks, ok, a sign-off).
"topic": what this part of the conversation is about, in a few words.
"pushback": if their message corrects or pushes back on something Co just said, what, in a few words; otherwise null.
"lesson": only when there's pushback, one short standing note about how Co should be with them from now on, general enough to apply next time ("when he asks about logistics, answer the logistics; don't tie it to his own event"); otherwise null.
"dots": at most two connections what's happening now clearly leads to, only when they're sharing or reacting: {"kind": "mention" (one thing serving two of their asks or bearing on a decision they're stuck on) | "shape" (how they're doing should change how Co responds right now, not something to say), "link": "one short plain sentence", "why": "which ask or thread it ties to"}. Only real, specific links from what's written above; never invent facts. Otherwise [].
"emotion": does the latest message carry a real feeling Co should respond to (stressed, anxious, discouraged, lonely, frustrated, excited, proud, relieved)? Use the conversation: "fine" after bad news isn't fine. Ignore plain logistics, greetings and tone you aren't confident about; most messages have none. If none, null; else {"emotion": "one or two words", "intensity": "low" | "medium" | "high", "valence": "negative" | "positive" | "mixed", "about": "what it's about, only from what they said", "target": "co" when it's about Co itself (what Co found or didn't, its suggestions, replies, speed or mistakes, like "you keep finding nothing" or "that's not what I asked"), else "life"}.
"seeking": "solving" only if you're genuinely confident they want a real answer or help deciding right now, not just to be heard (weighing options out loud, stuck on a decision, clearly past venting); ordinary sharing, updates and venting are "none", far more often than not.
"feedback": each distinct piece of feedback they're giving about how Co works or should work, or asking Co to pass to the team, as one clear sentence the team could act on; [] if none.
"ack": whether Co should react to their message with an emoji right away to show what it is about to do. Only when the reply will take a moment, or they just gave Co something to do, or they confirmed something. "👀" when Co is about to look something up or read something they sent; "✍️" when Co is about to write something for them (a draft, a plan, a pitch, a walkthrough); "🫡" when they've asked Co to take something on; "🚀" when they've told Co to go ahead and send or do something it prepared; "👍" for a plain confirmation of something Co did or proposed. null for everything else, including ordinary conversation, feelings, thanks and sign-offs: most messages.
"about_sent": if this message is about one specific thing in "Things Co sent them recently" (asking about it, reacting to it), its name exactly as listed; otherwise null.
"covered_now": topic keys (from the list below) they addressed in this conversation itself, not just in what was known before; [] if none.
"missing": topic keys not yet covered, counting what was already known.
Topics:
${topics}`;
}

const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim().slice(0, n) : null);

export function parseTurnRead(obj: any, sentNames: string[]): Omit<TurnRead, "latencyMs"> {
  const router = parseRouterOutput(obj);
  const mode: Mode = MODES.includes(obj?.mode) ? obj.mode : "asking";
  const dots: Dot[] = (Array.isArray(obj?.dots) ? obj.dots : [])
    .filter((d: any) => typeof d?.link === "string" && d.link.trim())
    .slice(0, 2)
    .map((d: any) => ({ link: String(d.link).trim().slice(0, 240), why: String(d.why ?? "").trim().slice(0, 160), kind: d.kind === "shape" ? ("shape" as const) : ("mention" as const) }));
  const pushback = str(obj?.pushback, 200);
  const e = obj?.emotion;
  const emotion: TextEmotion =
    e && typeof e === "object" && typeof e.emotion === "string" && e.emotion.trim()
      ? {
          emotion: e.emotion.toLowerCase().slice(0, 40),
          intensity: (e.intensity === "high" || e.intensity === "medium" ? e.intensity : "low") as Intensity,
          valence: (e.valence === "negative" || e.valence === "positive" ? e.valence : "mixed") as Valence,
          about: typeof e.about === "string" ? e.about.slice(0, 80) : null,
          target: (e.target === "co" ? "co" : "life") as EmotionTarget,
        }
      : null;
  const topicList = (v: unknown): RapportTopic[] => (Array.isArray(v) ? v.filter((t): t is RapportTopic => RAPPORT_TOPICS.includes(t as RapportTopic)) : []);
  const aboutRaw = str(obj?.about_sent, 200);
  const aboutSent = aboutRaw ? sentNames.find((n) => n.toLowerCase() === aboutRaw.toLowerCase()) ?? null : null;
  return {
    router,
    emotion,
    seeking: obj?.seeking === "solving" ? "solving" : null,
    moment: {
      mode,
      topic: str(obj?.topic, 120) ?? "",
      pushback,
      lesson: pushback ? str(obj?.lesson, 240) : null,
      // A reply only connects the dots when they're sharing or reacting (code holds this on the read's own mode).
      dots: DOTS_MODES.includes(mode) ? dots : [],
    },
    feedback: (Array.isArray(obj?.feedback) ? obj.feedback : []).filter((f: any) => typeof f === "string" && f.trim()).slice(0, 4).map((f: string) => f.trim().slice(0, 300)),
    aboutSent,
    ack: mode === "small_talk" ? null : parseAck(obj?.ack),
    coverage: Array.isArray(obj?.missing) ? { missing_topics: topicList(obj.missing), fresh_topics: topicList(obj?.covered_now), ready_to_summarize: false } : null,
  };
}

export async function readTurn(
  routeInput: RouteInput,
  ctx: Pick<TurnContext, "asks" | "threads" | "offersThisWeek" | "sent"> | null,
  priorContext: string | null,
  opts: { model?: string } = {},
): Promise<TurnRead> {
  const model = opts.model ?? ROUTER_MODEL;
  const started = Date.now();
  const { text } = await generateText({
    model: anthropic(model),
    maxOutputTokens: 4000,
    providerOptions: !model.startsWith("claude-haiku") ? { anthropic: { effort: "low" } } : undefined,
    experimental_telemetry: { isEnabled: true, functionId: "readTurn" },
    prompt: buildRouterPrompt(routeInput) + turnReadAddendum(ctx, priorContext),
  });
  const json = extractFirstJsonObject(text.replace(/```(?:json)?/g, ""));
  if (!json) throw new Error(`readTurn returned no JSON: ${text.slice(0, 200)}`);
  return { ...parseTurnRead(JSON.parse(json), (ctx?.sent ?? []).map((s) => s.name)), latencyMs: Date.now() - started };
}

// Their feedback, as a reminder for Co to save each piece (the tool decides; nothing is vetoed).
export function feedbackInstruction(feedback: string[]): string | null {
  if (!feedback.length) return null;
  return `They're giving feedback about how Co works: ${feedback.map((f) => `"${f}"`).join("; ")}. Save each distinct piece with saveFeedbackForTeam before saying it's been passed along.`;
}
