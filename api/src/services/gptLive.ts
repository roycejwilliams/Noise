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
  trialMinutesCap: 130, // all trial sessions together (Royce: under $10), enforced while calls run (admitSession)
  minAdmitMs: 60_000, // a call that would get less than this is refused
  startTimeoutMs: 10_000, // Twilio's start, then OpenAI's session.started, each within this or the call is ended cleanly
  heartbeatMs: 60_000, // a running session's minutes are written this often
  ackDelayMs: 800, // GPT-Live waits this long before its automatic "let me think" (we cancel it with an empty thinking append)
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

// Nothing happens on a trial call (no tools, no sends), so the agent prompt's lines that tell Cue to act on the call and say so are
// rewritten to "right after the call" (review of #325: leaving both in contradicts the honesty rule). A line that has moved makes
// GPT_LIVE_FORBIDDEN fail the layer-1 test (evals/calls/gptLive.ts), never a silent mismatch.
// (The help-over-days lines in the call guide and the capability sheet already say "right after you hang up" since #327: no rewrite.)
export const ON_CALL_REWRITES: [string, string][] = [
  ["do it now, on the call, and say plainly what you did.", "say plainly you'll do it right after the call."],
  ["When you start something with a tool, say what you started; when it's done, say what it is. ", ""],
  ["look it up now, or say you don't have it.", "say you don't have it, and that you'll look into it right after the call."],
  ["and text them the link to any of them while you talk", "and text them the links right after the call"],
  ["end the call with end_call and say nothing more", "say nothing more"],
];
// What the trial call's instructions must never say (the layer-1 test reads both prompts for these).
export const GPT_LIVE_FORBIDDEN = [/say it'?s set up/i, /look it up now/i, /set it up now, on the call/i, /then and there/i, /do it now, on the call/i, /\bend_call\b/, /link to any of them while you talk/i, /When you start something with a tool/i];
// Pure: the ElevenLabs agent's prompt in GPT-Live's format: minus the bracketed voice cues ([laughs], ElevenLabs v4 audio tags
// GPT-Live would read out), with the act-on-the-call lines rewritten (ON_CALL_REWRITES).
export function liveCallPrompt(voiceLayer: string): string {
  let p = promptForElevenLabs(voiceLayer)
    .replace(`Everything you write is spoken aloud, except a cue in square brackets (below).\n${CUE_GUIDE}\n\n`, `${SPOKEN_ALOUD} `)
    .replace(`\n\n${CUE_GUIDE}`, "");
  for (const [from, to] of ON_CALL_REWRITES) p = p.split(from).join(to);
  return p;
}
// Said to both models on a trial call (review of #325).
export const NOTHING_ON_THIS_CALL = "Nothing can be set up, looked up, sent or scheduled on this call, and you can't end it. When they want something done, say you'll do it right after the call. Never say it's done, set up, started or on its way.";
// Pure: {{name}} filled the way ElevenLabs fills the agent's dynamic variables; an unknown name stays as it is.
export const fillCallVars = (template: string, vars: Record<string, string>): string => template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));

// GPT-Live's own headings (OpenAI's prompting guide keeps these three and the literal <|SpawnThinking|>).
export const LIVE_POLICY = `# On this line
You are speaking out loud and listening at the same time. Your thinking (what you know about them, what's true, what to say on anything that matters) runs behind you: when it answers, say that answer in your own words and keep its facts exactly. ${NOTHING_ON_THIS_CALL} They hang up when they're done.

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
This is a live phone call, and you are the thinking behind the voice. A voice model speaks for you: it says what you write here in its own words, so write only what Cue says next, as plain spoken sentences (no lists, no brackets, no stage directions). The conversation comes from speech recognition both ways and can hold mistakes, half phrases and later corrections: go by the latest. ${NOTHING_ON_THIS_CALL} Anything they want goes out by text right after it.`;

// Everything one trial call needs, built by the TwiML route for the verified caller only.
export type LiveCall = { userId: string; callSid: string | null; firstName: string; instructions: string; backendSystem: string; opening: string; given: { firstName: string; contextSummary: string; findsNow: string; rightNow: string }; capMs?: number; trialLimited?: boolean };

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
      delegation: { type: "client", acknowledgement_delay_ms: GPT_LIVE.ackDelayMs },
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
// The stream id is the admission's own key (admitSession), so the reservation and the call are one thing.
export function issueLiveLink(call: LiveCall, now = Date.now(), id = randomBytes(32).toString("base64url")): string {
  for (const [k, v] of links) if (v.expires <= now) links.delete(k);
  links.set(id, { call, expires: now + GPT_LIVE.linkTtlMs });
  return id;
}
export function takeLiveLink(id: unknown, now = Date.now()): LiveCall | null {
  if (typeof id !== "string") return null;
  const hit = links.get(id);
  links.delete(id);
  return hit && hit.expires > now ? hit.call : null;
}

// How each trial call's stream went, by Twilio's call sid, for the <Connect> action (routes/co.ts /co/gpt-live/after-stream): a call
// whose session never started hears the ElevenLabs path's CANT_CONNECT_LINE and has its call_status released.
const callStates = new Map<string, { userId: string; state: "pending" | "started" | "failed"; at: number }>();
export function markCall(callSid: string | null | undefined, userId: string, state: "pending" | "started" | "failed", now = Date.now()): void {
  if (!callSid) return;
  for (const [k, v] of callStates) if (now - v.at > 3 * 3_600_000) callStates.delete(k);
  const had = callStates.get(callSid);
  if (had?.state === "started" && state === "failed") return; // a started call ended later is not a failed connect
  callStates.set(callSid, { userId, state, at: now });
}
export function takeCallState(callSid: unknown): { userId: string; state: "pending" | "started" | "failed" } | null {
  if (typeof callSid !== "string") return null;
  const hit = callStates.get(callSid) ?? null;
  callStates.delete(callSid);
  return hit;
}

// ---------------------------------------------------------------- the minute caps

// Each session: 30 minutes. The trial: GPT_LIVE.trialMinutesCap in all, held while calls run, not only when they start: a call is
// admitted with its own cap, min(30 min, what the trial has left after every minute logged and every open call's whole reservation),
// and the bridge closes it there. Minutes live in gpt_live_minutes (db/migrations.ts), one row per session, written as the call
// starts and about every minute after, so a restart mid-call still counts. That table has no user column and nothing prunes it, so
// neither the 60-day harness_decisions prune nor a member's deletion (ON DELETE CASCADE) can take minutes off the total.
export type Slot = { capMs: number; admittedAt: number; startedAt: number | null; sessionId: string | null };
export const openSessions = new Map<string, Slot>(); // by stream id
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
const pruneSlots = (now: number) => {
  for (const [k, v] of openSessions) if (v.startedAt == null && now - v.admittedAt > GPT_LIVE.linkTtlMs + 2 * GPT_LIVE.startTimeoutMs) openSessions.delete(k);
};
const loggedSeconds = async (db: Db): Promise<number> => {
  const running = [...openSessions.values()].map((v) => v.sessionId).filter((x): x is string => !!x);
  const { rows } = await db.query(`SELECT COALESCE(SUM(seconds), 0) AS s FROM gpt_live_minutes WHERE NOT (session_id = ANY($1::text[]))`, [running]);
  return Number(rows[0]?.s ?? 0);
};
// Minutes used so far: every session logged, plus the open ones' time on the line.
export async function trialMinutesUsed(db: Db = pool, now = Date.now()): Promise<number> {
  pruneSlots(now);
  const open = [...openSessions.values()].reduce((a, v) => a + (v.startedAt == null ? 0 : Math.max(0, now - v.startedAt) / 1000), 0);
  return ((await loggedSeconds(db)) + open) / 60;
}
let admitting: Promise<unknown> = Promise.resolve();
// Admits one call: its stream id and its own cap, or null when the trial can't give it a minute. One admission at a time, so two
// calls at once can't both take the last minutes. A total that can't be read refuses (fails closed).
export function admitSession(db: Db = pool, now = Date.now()): Promise<{ id: string; capMs: number; trialLimited: boolean } | null> {
  const run = admitting.then(async () => {
    pruneSlots(now);
    const reserved = [...openSessions.values()].reduce((a, v) => a + v.capMs, 0);
    const left = GPT_LIVE.trialMinutesCap * 60_000 - (await loggedSeconds(db)) * 1000 - reserved;
    const capMs = Math.min(GPT_LIVE.maxSessionMs, left);
    if (capMs < GPT_LIVE.minAdmitMs) return null;
    const id = randomBytes(32).toString("base64url");
    openSessions.set(id, { capMs, admittedAt: now, startedAt: null, sessionId: null });
    return { id, capMs, trialLimited: capMs < GPT_LIVE.maxSessionMs };
  }).catch(() => null);
  admitting = run;
  return run;
}
// A session's minutes so far (and how it ended, at the end). Never throws.
export async function writeMinutes(sessionId: string, seconds: number, endedBy: string | null, db: Db = pool): Promise<void> {
  await db
    .query(
      `INSERT INTO gpt_live_minutes (session_id, seconds, ended_by) VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET seconds = GREATEST(gpt_live_minutes.seconds, EXCLUDED.seconds), ended_by = COALESCE(EXCLUDED.ended_by, gpt_live_minutes.ended_by), updated_at = NOW()`,
      [sessionId, Math.round(seconds * 10) / 10, endedBy],
    )
    .catch((err: any) => console.error(`gpt-live: minutes for ${sessionId} not written (${String(err?.message ?? err).slice(0, 80)})`));
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
