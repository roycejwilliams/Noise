// The GPT-Live trial (Royce, 2026-10-31): a second Twilio number where Cue's calls run on OpenAI's gpt-live-1, a full-duplex
// voice model, side by side with the ElevenLabs number (which this never touches). Royce judges how natural it feels; the
// numbers (talk-over, latency, member_confused, hung_up_after_cue) compare in call_health and call.turn_latency.
//
// How it fits (design: ~/cue-worktrees/notes/gpt-live-trial-design.md):
//   - The trial number's Voice webhook is routes/co.ts /co/gpt-live/incoming-call: the same member check as /co/incoming-call,
//     the trial's minute cap, then TwiML that streams the call to services/gptLiveBridge.ts. Live only on that route: no switch.
//   - GPT-Live speaks. Its instructions are Cue's call prompt (the ElevenLabs agent's own, promptForElevenLabs over
//     prompts/co-system-prompt.md, filled with this member's values), adapted only in format, plus the three policy headings
//     OpenAI's prompting guide asks for.
//   - Thinking is Claude through the call brain (services/callLlmProxy.ts runCallLlm) with no tools: read-only. GPT-Live hands
//     a turn over (client delegation), the brain answers from the caller's own prompt and this call's transcript, and GPT-Live
//     says the answer. Nothing is sent or written mid-call; promises are picked up after it (services/callFollowThrough.ts).
//   - After the call the transcript runs the same post-call steps as ElevenLabs' webhook (routes/co.ts runGptLivePostCall).
import { randomBytes } from "crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { CALL_CRITERIA } from "./callEvals.js";
import { runCallLlm, type ARequest, type AnthropicEvent, type OaiRequest } from "./callLlmProxy.js";
import { AGENT_DEFAULTS, promptForElevenLabs, SPOKEN_ALOUD } from "./elevenLabsCalls.js";
import { CUE_GUIDE, stripCues } from "./voiceCues.js";
import { parseModelJson } from "./modelJson.js";

export const GPT_LIVE = {
  model: "gpt-live-1",
  url: "wss://api.openai.com/v1/live/sessions",
  defaultVoice: "marin",
  maxSessionMs: 30 * 60_000, // each trial session
  trialMinutesCap: 150, // all trial sessions together; past it new calls are refused
  linkTtlMs: 2 * 60_000, // the TwiML's one-time stream id
  leadMs: 300, // how far ahead of real time Cue's audio may be handed to Twilio (the rest waits here, so a barge-in stops sooner)
  catchUpMs: 400, // a delegation waits at most this long for the transcript to reach where it was made
  commentaryMaxChars: 1600, // OpenAI's limit is 500 tokens per append
  closeWaitMs: 5000, // after session.close, how long to wait for session.closed
} as const;
export const GPT_LIVE_STREAM_PATH = "/co/gpt-live/stream";
export const gptLiveVoice = (env: NodeJS.ProcessEnv = process.env): string => env.GPT_LIVE_VOICE?.trim() || GPT_LIVE.defaultVoice;

// The wss:// URL Twilio streams the trial call to (https://host -> wss://host/co/gpt-live/stream). Null without API_URL.
export function gptLiveStreamUrl(apiUrl: string | undefined): string | null {
  try {
    const u = new URL(apiUrl ?? "");
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}${u.pathname.replace(/\/+$/, "")}${GPT_LIVE_STREAM_PATH}`;
  } catch {
    return null;
  }
}
export const isGptLiveStreamPath = (url: string | undefined): boolean => {
  try {
    return new URL(url ?? "", "http://x").pathname === GPT_LIVE_STREAM_PATH;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- the prompts

// Pure: the ElevenLabs agent's prompt in GPT-Live's format. Same content, minus the bracketed voice cues ([laughs]), which are
// ElevenLabs v4 audio tags: GPT-Live would read them out.
export function liveCallPrompt(voiceLayer: string): string {
  return promptForElevenLabs(voiceLayer)
    .replace(`Everything you write is spoken aloud, except a cue in square brackets (below).\n${CUE_GUIDE}\n\n`, `${SPOKEN_ALOUD} `)
    .replace(`\n\n${CUE_GUIDE}`, "");
}
// Pure: {{name}} filled the way ElevenLabs fills the agent's dynamic variables; an unknown name stays as it is.
export const fillCallVars = (template: string, vars: Record<string, string>): string => template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));

// GPT-Live's own headings (OpenAI's prompting guide keeps these three and the literal <|SpawnThinking|>).
export const LIVE_POLICY = `# On this line
You are speaking out loud and listening at the same time. Your thinking (what you know about them, what's true, what to say on anything that matters) runs behind you: when it answers, say that answer in your own words and keep its facts exactly. You can't end the call or send anything; they hang up when they're done.

Backchannel policy: Light. A quiet "mm" or "yeah" while they work through something, never over their words when they pause to think.

Interruption policy: When they speak over you, stop right away and listen. Answer what they said; don't resume an answer they've replaced.

Delegation policy:
Backend tools:
- Cue's thinking: what you know about them and have found for them, what's true, advice, and what to say on anything real.

Generate <|SpawnThinking|> when:
- They tell you something real about their life, ask a question, or want help or advice.
- The answer depends on what you know about them: their plans, people, events, or anything found for them.
- They correct you or push back.
- Anything touches their safety.

Do not generate <|SpawnThinking|> when:
- It's a greeting, a thanks, a goodbye, or a brief "mm" or "yeah".
- You only need them to repeat a word you didn't catch.

Generate <|SpawnThinking|> before giving an answer that depends on backend work.
Do not guess the result while waiting. Never name an event, place, time or person that your thinking didn't give you or they didn't say.`;

// For Claude behind GPT-Live (OpenAI's "Voice conversation context" section, in Cue's terms).
export const BACKEND_NOTE = `# How this call runs
This is a live phone call, and you are the thinking behind the voice. A voice model speaks for you: it says what you write here in its own words, so write only what Cue says next, as plain spoken sentences (no lists, no brackets, no stage directions). The conversation comes from speech recognition both ways and can hold mistakes, half phrases and later corrections: go by the latest. Nothing can be sent, saved or done during this call; anything they want goes out by text right after it.`;

// Everything one trial call needs, built by the TwiML route for the verified caller only.
export type LiveCall = { userId: string; callSid: string | null; firstName: string; instructions: string; backendSystem: string; opening: string; given: { firstName: string; contextSummary: string; findsNow: string; rightNow: string } };

// Pure: the call's two prompts from the voice layer and this member's values (the same values registerElevenLabsCall sends).
export function buildLiveCall(o: { userId: string; callSid: string | null; firstName: string; voiceLayer: string; contextSummary: string; rightNow: string; findsNow: string; callReason: string; opening: string }): LiveCall {
  const findsNow = o.findsNow || "Nothing to offer right now. Don't offer an event.";
  const prompt = fillCallVars(liveCallPrompt(o.voiceLayer), { first_name: o.firstName || "there", context_summary: o.contextSummary, direction: "inbound", right_now: o.rightNow, finds_now: findsNow, call_reason: o.callReason, user_id: "", call_token: "" });
  return {
    userId: o.userId,
    callSid: o.callSid,
    firstName: o.firstName,
    instructions: `${prompt}\n\n${LIVE_POLICY}`,
    backendSystem: `${prompt}\n\n${BACKEND_NOTE}`,
    opening: o.opening,
    given: { firstName: o.firstName, contextSummary: o.contextSummary, findsNow, rightNow: o.rightNow },
  };
}

// Pure: the session.start event for the call. G.711 mu-law at 8 kHz both ways, Twilio's own format, so audio passes through.
export function sessionStart(call: LiveCall, voice: string): Record<string, unknown> {
  const greet = `Greet them now with this line, then pause and listen: "${call.opening}"`;
  return {
    type: "session.start",
    event_id: "start",
    session: {
      model: GPT_LIVE.model,
      instructions: call.instructions,
      input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: greet }] }],
      audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice } },
      delegation: { type: "client" },
    },
  };
}
export const greetingEvent = (call: LiveCall) => ({ type: "session.commentary.append", event_id: "greeting", delegation_id: null, content: `Greet them now with this line, then pause and listen: "${call.opening}"` });

// ---------------------------------------------------------------- the transcript

export type Frag = { who: "member" | "cue"; text: string; startMs: number; endMs: number };
export type LiveTurn = { who: "member" | "cue"; text: string; startMs: number; endMs: number; interrupted?: boolean };
// A "yeah" or "mm" while Cue talks is listening, not taking the turn (the ElevenLabs agent's own list, AGENT_DEFAULTS).
const LISTENING = new Set<string>(AGENT_DEFAULTS.interruptionIgnoreTerms);
export const listeningSound = (t: string): boolean => {
  const w = t.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/\s+/).filter(Boolean);
  return w.length > 0 && w.every((x) => LISTENING.has(x));
};

// Pure: fragments in timeline order, a speaker's run joined exactly as received (OpenAI: keep spaces as sent). A Cue turn is
// interrupted when the member started speaking (more than a listening sound) before it finished.
export function turnsFrom(frags: Frag[]): LiveTurn[] {
  const out: LiveTurn[] = [];
  for (const f of [...frags].sort((a, b) => a.startMs - b.startMs)) {
    const last = out[out.length - 1];
    if (last && last.who === f.who) { last.text += f.text; last.endMs = Math.max(last.endMs, f.endMs); }
    else out.push({ who: f.who, text: f.text, startMs: f.startMs, endMs: f.endMs });
  }
  const turns = out.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text);
  turns.forEach((t, i) => {
    if (t.who !== "cue") return;
    const next = turns.slice(i + 1).find((x) => x.who === "member" && !listeningSound(x.text));
    t.interrupted = !!next && next.startMs < t.endMs;
  });
  return turns;
}
// Pure: the ElevenLabs transcript shape the post-call steps read (routes/co.ts, services/callHealth.ts).
export const elTurnsOf = (turns: LiveTurn[]) => turns.map((t) => ({ role: t.who === "member" ? "user" : "agent", message: t.text, time_in_call_secs: Math.round(t.startMs / 100) / 10, interrupted: t.who === "cue" ? !!t.interrupted : undefined }));
// Pure: for each Cue reply after the member spoke, the gap from their last word to Cue's first (negative: Cue started over them).
// A listening sound on either side isn't a turn.
export function replyGaps(turns: LiveTurn[]): number[] {
  const gaps: number[] = [];
  turns.forEach((t, i) => {
    const prev = turns[i - 1];
    if (t.who === "cue" && !listeningSound(t.text) && prev?.who === "member" && !listeningSound(prev.text)) gaps.push(t.startMs - prev.endMs);
  });
  return gaps;
}

// ---------------------------------------------------------------- delegation (read-only)

// Pure: the call brain's request for a delegated turn: the caller's own prompt and this call's transcript, nothing else.
export function delegationRequest(call: LiveCall, turns: LiveTurn[]): OaiRequest {
  return { messages: [{ role: "system", content: call.backendSystem }, ...turns.map((t) => ({ role: t.who === "member" ? "user" : "assistant", content: t.text }))], stream: true, temperature: AGENT_DEFAULTS.temperature };
}
export type Upstream = (req: ARequest, userId: string) => AsyncIterable<AnthropicEvent>;
// One delegated turn through the call brain, with no tools: it can only think and answer. Its sentences are cleaned and checked
// as on the ElevenLabs path (speakable, offer guard); what it held back is reported.
export async function thinkOnCall(call: LiveCall, turns: LiveTurn[], upstream: Upstream, onDropped?: (sentence: string, why: string) => void) {
  let text = "";
  let timing: { upstreamFirstTokenMs: number; firstSentenceMs: number } | null = null;
  for await (const c of runCallLlm(delegationRequest(call, turns), { stream: (r) => upstream(r, call.userId), clean: true, tools: null, onFirstText: (t) => (timing = t), onDropped })) {
    const d = c.choices[0].delta as { content?: unknown };
    if (typeof d.content === "string") text += d.content;
  }
  return { text: stripCues(text).replace(/\s+/g, " ").trim().slice(0, GPT_LIVE.commentaryMaxChars), timing: timing as { upstreamFirstTokenMs: number; firstSentenceMs: number } | null };
}

// ---------------------------------------------------------------- one-time stream ids (in memory: Twilio logs TwiML)

const links = new Map<string, { call: LiveCall; expires: number }>();
export function issueLiveLink(call: LiveCall, now = Date.now()): string {
  for (const [k, v] of links) if (v.expires <= now) links.delete(k);
  const id = randomBytes(32).toString("base64url");
  links.set(id, { call, expires: now + GPT_LIVE.linkTtlMs });
  return id;
}
export function takeLiveLink(id: unknown, now = Date.now()): LiveCall | null {
  if (typeof id !== "string") return null;
  const hit = links.get(id);
  links.delete(id);
  return hit && hit.expires > now ? hit.call : null;
}

// ---------------------------------------------------------------- the minute cap

// Sessions running now (the bridge adds and removes them), so a cap check counts calls still on the line.
export const openSessions = new Map<string, number>();
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
// Minutes used by the whole trial: every finished session's logged seconds plus those running now.
export async function trialMinutesUsed(db: Db = pool, now = Date.now()): Promise<number> {
  const { rows } = await db.query(`SELECT COALESCE(SUM((proposal->>'seconds')::numeric), 0) AS s FROM harness_decisions WHERE decision = 'call.gpt_live_session'`);
  const open = [...openSessions.values()].reduce((a, t) => a + Math.max(0, now - t) / 1000, 0);
  return (Number(rows[0]?.s ?? 0) + open) / 60;
}
// Under the cap. A cap that can't be read refuses: the guard fails closed.
export async function trialOpen(db: Db = pool, now = Date.now()): Promise<boolean> {
  return trialMinutesUsed(db, now).then((m) => m < GPT_LIVE.trialMinutesCap).catch(() => false);
}

// ---------------------------------------------------------------- the grade

// ElevenLabs grades its calls against CALL_CRITERIA on its side; a GPT-Live call is graded here with the same criteria and the
// same model ElevenLabs uses (Sonnet), returned in the webhook's analysis shape for recordCallEvaluation.
export function gradePrompt(transcript: string): string {
  return `Grade a phone call by Cue against these criteria. You see only the call.

Criteria:
${CALL_CRITERIA.map((c) => `- ${c.id}: ${c.conversation_goal_prompt}`).join("\n")}

The call ("assistant" or "agent" is Cue, "user" is the member), whole:
${transcript.slice(-40000)}

Return ONLY JSON: {"results": [{"id": "criterion id", "result": "success" | "failure", "rationale": "one sentence; on a failure, quote Cue's exact words"}]}`;
}
export async function gradeLiveCall(transcript: string, read: (prompt: string) => Promise<string> = defaultRead): Promise<{ evaluation_criteria_results: Record<string, { criteria_id: string; result: string; rationale: string }> }> {
  const ids = new Set(CALL_CRITERIA.map((c) => c.id));
  const results = parseModelJson<{ results?: { id?: string; result?: string; rationale?: string }[] }>(await read(gradePrompt(transcript))).results ?? [];
  const kept = results.filter((r) => r && ids.has(String(r.id)) && (r.result === "success" || r.result === "failure"));
  return { evaluation_criteria_results: Object.fromEntries(kept.map((r) => [String(r.id), { criteria_id: String(r.id), result: String(r.result), rationale: String(r.rationale ?? "") }])) };
}
async function defaultRead(prompt: string): Promise<string> {
  const { text } = await generateText({ model: anthropic(MODELS.sonnet), providerOptions: { anthropic: { effort: "low" } }, maxOutputTokens: 2500, experimental_telemetry: { isEnabled: true, functionId: "call.evaluation.gpt_live", recordInputs: false, recordOutputs: false }, prompt });
  return text;
}
