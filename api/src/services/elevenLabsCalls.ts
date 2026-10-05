// Calls on ElevenLabs Agents (2026-10-03): Hume ends EVI and TTS on
// 2026-11-13, so Co's calls move here. Royce chose ElevenLabs Agents with
// the Eleven v4 Turbo voice and Claude behind the tools (the tool webhooks run
// Co's own code). The live voice started on Haiku 4.5 for speed; on 2026-10-04
// Royce chose Claude Sonnet 4.6 (what Hume ran) after the comparison: Haiku
// still said stock empathy lines ("I hear you", "I hear that") and opened its
// first question from the prompt's examples, Sonnet did neither, at about 0.7 s
// more per reply (median ~1.9 s against ~1.2 s). ELEVENLABS_LLM overrides it,
// so going back to Haiku is one variable.
//
// The call still goes out and comes in through Co's own Twilio number:
// Twilio asks us for TwiML, we register the call with ElevenLabs
// (register-call) and hand back the TwiML it returns, so Twilio's status
// callbacks keep working and no audio relay of our own is needed.
//
// Hume is gone (Royce, 2026-10-03: "remove Hume, no reason to use it if
// it's going to be deprecated"); every call runs here.
import { DISCRETION_GUIDE } from "../harness/discretion.js";
import { VARIETY_GUIDE } from "../harness/stockLines.js";
import { CUE_GUIDE, stripCues } from "./voiceCues.js";
import { createHmac, timingSafeEqual } from "crypto";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import pool from "../db/db.js";
import { DateTime } from "luxon";
import { getTimezoneForCity } from "./geocoding.js";

let client: ElevenLabsClient | null = null;
export function elevenLabs(): ElevenLabsClient {
  if (!client) client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  return client;
}

// ---------- per-call token
// The agent's tool webhooks and the post-call webhook carry {{user_id}} and
// {{call_token}} (dynamic variables set when the call is registered). The
// token proves the user id came from us, not from whoever can reach the
// tool URL. Stateless (an HMAC over the user id and issue time), so a
// redeploy mid-call doesn't break the call's tools. Valid for 2 hours: the
// agent's own max call length is 30 minutes.
export const CALL_TOKEN_TTL_SECS = 2 * 60 * 60;
function tokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.ELEVENLABS_TOOL_SECRET;
  if (!s) throw new Error("ELEVENLABS_TOOL_SECRET is not set");
  return s;
}
export function issueCallToken(userId: string, nowSecs = Math.floor(Date.now() / 1000), env: NodeJS.ProcessEnv = process.env): string {
  const mac = createHmac("sha256", tokenSecret(env)).update(`${userId}.${nowSecs}`).digest("hex");
  return `${nowSecs}.${mac}`;
}
export function verifyCallToken(userId: string, token: string | undefined | null, nowSecs = Math.floor(Date.now() / 1000), env: NodeJS.ProcessEnv = process.env): boolean {
  if (!userId || !token) return false;
  const [issued, mac] = token.split(".");
  const at = Number(issued);
  if (!Number.isFinite(at) || !mac || nowSecs - at > CALL_TOKEN_TTL_SECS || at - nowSecs > 60) return false;
  const want = createHmac("sha256", tokenSecret(env)).update(`${userId}.${at}`).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(want, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- registering a call
// Returns the TwiML that connects this Twilio call to Co's agent. The
// variables fill {{first_name}} / {{context_summary}} in the prompt and ride
// along on every tool call and on the post-call webhook.
export async function registerElevenLabsCall(o: {
  userId: string;
  firstName: string;
  contextSummary: string;
  from: string;
  to: string;
  direction: "inbound" | "outbound";
  opening?: string;
}): Promise<string> {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!agentId) throw new Error("ELEVENLABS_AGENT_ID is not set");
  return elevenLabs().conversationalAi.twilio.registerCall({
    agentId,
    fromNumber: o.from,
    toNumber: o.to,
    direction: o.direction,
    conversationInitiationClientData: {
      ...(o.opening ? { conversationConfigOverride: { agent: { firstMessage: o.opening } } } : {}),
      dynamicVariables: {
        user_id: o.userId,
        call_token: issueCallToken(o.userId),
        first_name: o.firstName,
        context_summary: o.contextSummary,
        direction: o.direction,
      },
    },
  } as any) as unknown as Promise<string>;
}

// ---------- after the call
export type ElevenLabsTurn = { role?: string; message?: string | null; time_in_call_secs?: number | null; tool_calls?: { tool_name?: string; name?: string }[] | null };

// Pure: the transcript in the shape the rest of Co reads ("user: ..." /
// "assistant: ..." lines, as Hume's was), turns with no words left out.
// Co's voice cues ("[softly]") are for its voice only: stripped from its lines
// here, so no transcript Co stores or reads carries them (services/voiceCues.ts).
export function transcriptFromTurns(turns: ElevenLabsTurn[] | null | undefined): string {
  return (turns ?? [])
    .map((t) => (t.role === "user" || typeof t.message !== "string" ? t : { ...t, message: stripCues(t.message) }))
    .filter((t) => typeof t.message === "string" && t.message.trim())
    .map((t) => `${t.role === "user" ? "user" : "assistant"}: ${t.message!.trim()}`)
    .join("\n");
}

// Pure: the live conversation from {{system__conversation_history}} (JSON;
// shape tolerated loosely: a list, or { messages | history | transcript }),
// as "user: ..." / "assistant: ..." lines. Empty when it can't be read.
export function transcriptFromHistory(raw: string | null | undefined): string {
  if (!raw) return "";
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return "";
  }
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.messages) ? j.messages : Array.isArray(j?.history) ? j.history : Array.isArray(j?.transcript) ? j.transcript : [];
  return transcriptFromTurns(
    list.map((t) => ({ role: t?.role === "user" ? "user" : "agent", message: typeof t?.message === "string" ? t.message : typeof t?.content === "string" ? t.content : typeof t?.text === "string" ? t.text : null })),
  );
}

// Pure: whether the agent's voicemail tool fired (it leaves the message and
// ends the call itself), so the post-call steps treat it as a missed call.
export function hitVoicemail(turns: ElevenLabsTurn[] | null | undefined, terminationReason?: string | null): boolean {
  if (/voicemail/i.test(terminationReason ?? "")) return true;
  return (turns ?? []).some((t) => (t.tool_calls ?? []).some((c) => /voicemail/i.test(c.tool_name ?? c.name ?? "")));
}

// Verifies the ElevenLabs-Signature header on a post-call webhook (SDK's
// HMAC check: "t=<secs>,v0=<hex>" over `${t}.${rawBody}`, 30 min tolerance).
export async function verifyPostCallWebhook(rawBody: string, signature: string | undefined): Promise<any | null> {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret || !signature) return null;
  try {
    return await elevenLabs().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return null;
  }
}

// ---------- the agent
// The call prompt is shared with the text persona and with Hume until the
// switch; ElevenLabs' end-the-call tool is named end_call, not hang_up.
// Co opens the moment the call connects (Royce wants it to feel instant;
// an empty opening left inbound callers in silence). The prompt's own
// openers start with "Hey {{first_name}}", so the agent's copy says the
// greeting is already done.
// Co's opening varies (Royce, 2026-10-03: "many different variations"): one is
// picked per call from a pool that fits the situation and is never the one
// used on that member's last call (pickOpening). The agent's stored line is
// only the fallback; registration overrides it per call.
export const OPENING_LINE = "Hey {{first_name}}, it's Co.";
// Said after the opening line, which is already spoken when the model's first turn comes
// (services/callOpening.ts writes it from what Co knows; the pool is the fallback).
// The old note sent the model to "your first real question", and it reached for the
// prompt's example openers (2026-10-04: "what's actually happening with you these days?").
export const OPENING_NOTE = "Your opening line has already been said, as the first thing in this conversation. Don't greet them again or repeat it. Carry on from it: stay with what it picked up, or, if it only said hello, pick up from something specific you know about them. Never fall back on a general \"how are things\" question when you know what they've been working on.";
// The cue guide goes in the call prompt's own "how you sound" section (where
// "everything you write is spoken aloud" now carries its one exception), not
// trailing at the end (review of #62). Texts never get it.
export const SPOKEN_ALOUD = "Everything you write is spoken aloud.";
// The shared prompt's example openers ("Hey {{first_name}}. Good to finally talk. I want
// to hear about where you are right now...") serve a first call. A model at temperature 0
// copies them word for word even when it knows the person, so a call's prompt leaves
// them out; texts, which read the same file, keep them.
export function withoutExampleOpeners(prompt: string): string {
  return prompt.replace(/Some ways this might sound:\n(?:"[^\n]*"\n)+Use your own words if none of these feel right in the moment[^\n]*\n/, "");
}
export function promptForElevenLabs(prompt: string): string {
  const base = withoutExampleOpeners(prompt)
    .replace("open as below instead.", "your first question is about what they're working on or what brought them to Co, in fresh words each time.")
    .replace(/\bhang_up\b/g, "end_call");
  const withCues = base.includes(SPOKEN_ALOUD)
    ? base.replace(new RegExp(`${SPOKEN_ALOUD.replace(/[.]/g, "\\.")} ?`), `Everything you write is spoken aloud, except a cue in square brackets (below).\n${CUE_GUIDE}\n\n`)
    : `${base}\n\n${CUE_GUIDE}`;
  // How Co keeps a confidence on a call (harness/discretion.ts): speech can't be
  // edited, so the model has to choose a discreet line itself.
  return `${withCues}\n\n${DISCRETION_GUIDE}\n\n${VARIETY_GUIDE}\n\n${OPENING_NOTE}`;
}

// The coverage check reads the newest part of the call (~6k tokens is plenty
// to see which Rapport topics came up recently).
export const COVERAGE_TRANSCRIPT_CHARS = 24_000;

export const VOICEMAIL_MESSAGE = "Hey {{first_name}}, it's Co. Sorry I missed you. I'll send you a text.";

export const AGENT_DEFAULTS = {
  llm: "claude-sonnet-4-6",
  // Hume ran Co at temperature 1. The agent was left at ElevenLabs' default of 0,
  // where the model repeats the prompt's own example lines almost word for word
  // (2026-10-04: "sounds scripted"). 0.8 keeps it varied; the rules the prompt
  // sets (one cue, no feeling labels) are re-measured at this temperature.
  temperature: 0.8,
  ttsModel: "eleven_v4_turbo",
  turnEagerness: "eager",
  maxDurationSecs: 1800,
  silenceEndCallSecs: 120,
} as const;

// Pure: the agent's whole config (ElevenLabs REST shape, snake_case), from
// the prompt and our settings. Phone audio is mu-law 8kHz both ways
// (register-call requires it). Tools call our webhooks with the call's
// user id and token, and the conversation so far for the coverage check.
export function buildAgentConfig(o: {
  name: string;
  prompt: string;
  voiceId: string;
  apiUrl: string;
  llm?: string;
  ttsModel?: string;
  turnEagerness?: string;
  temperature?: number;
}): Record<string, unknown> {
  const tool = (name: string, description: string, extra: Record<string, unknown> = {}) => ({
    type: "webhook",
    name,
    description,
    response_timeout_secs: 20,
    disable_interruptions: false,
    force_pre_tool_speech: false,
    api_schema: {
      url: `${o.apiUrl}/co/el/tool/${name}`,
      method: "POST",
      request_body_schema: {
        type: "object",
        properties: {
          user_id: { type: "string", dynamic_variable: "user_id" },
          call_token: { type: "string", dynamic_variable: "call_token" },
          conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
          call_duration_secs: { type: "string", dynamic_variable: "system__call_duration_secs" },
          // The conversation so far, so the coverage check needs no fetch
          // (the 9-19s check on Hume was mostly re-fetching the transcript).
          conversation_history: { type: "string", dynamic_variable: "system__conversation_history" },
          // The summary built at call start rides along (no rebuild per check).
          context_summary: { type: "string", dynamic_variable: "context_summary" },
          ...extra,
        },
        required: ["user_id", "call_token"],
      },
    },
  });
  return {
    name: o.name,
    // Each call picks its own opening line (pickOpening), so the first message
    // must be overridable per call.
    platform_settings: { overrides: { conversation_config_override: { agent: { first_message: true } } } },
    conversation_config: {
      asr: { user_input_audio_format: "ulaw_8000" },
      tts: {
        model_id: o.ttsModel ?? AGENT_DEFAULTS.ttsModel,
        voice_id: o.voiceId,
        agent_output_audio_format: "ulaw_8000",
      },
      turn: {
        turn_eagerness: o.turnEagerness ?? AGENT_DEFAULTS.turnEagerness,
        silence_end_call_timeout: AGENT_DEFAULTS.silenceEndCallSecs,
      },
      conversation: { max_duration_seconds: AGENT_DEFAULTS.maxDurationSecs },
      agent: {
        first_message: OPENING_LINE,
        language: "en",
        max_conversation_duration_message: "I need to wrap up for now. This was really good, I'll be in touch soon.",
        dynamic_variables: { dynamic_variable_placeholders: { first_name: "there", context_summary: "", user_id: "", call_token: "", direction: "" } },
        prompt: {
          prompt: promptForElevenLabs(o.prompt),
          llm: o.llm ?? AGENT_DEFAULTS.llm,
          temperature: o.temperature ?? AGENT_DEFAULTS.temperature,
          tools: [
            tool(
              "assess_conversation_coverage",
              "Silently check your own progress through the Rapport phase. Returns which required topics are still uncovered so you can decide what to ask next and whether you have enough to move into Confirm Understanding. Never mention that you are checking anything or calling a tool - just let the result quietly guide your next question.",
            ),
            tool(
              "surface_recommendation",
              "Call this when you have a real, specific, stated preference or want from this person and a genuine moment to offer something concrete, not during early rapport-building. Returns one grounded recommendation with a reason, or not-yet-available if there is not enough real signal. Never mention checking or calling a tool. Offer any result naturally as your own suggestion.",
            ),
            // ElevenLabs' own system tools ride in the same list (type "system");
            // the separate built_in_tools field silently stored nothing (2026-10-03).
            { type: "system", name: "end_call", description: "End the call once you've said a warm goodbye and given them a beat to respond.", params: { system_tool_type: "end_call" } },
            // Leaves this and ends the call; the post-call steps then send the missed-call text.
            {
              type: "system",
              name: "voicemail_detection",
              description: "Only when you hear a recorded voicemail greeting, a carrier message or a beep. A person saying \"hello?\", \"who's this?\" or anything back to you is a person: keep talking with them.",
              params: { system_tool_type: "voicemail_detection", voicemail_message: VOICEMAIL_MESSAGE },
            },
          ],
        },
      },
    },
  };
}

// A call that couldn't connect because of something on Co's side: recorded
// so Co can say so truthfully by text (harness/replyGrounding.ts reads
// call_failure), never blaming their phone. Once per 10 minutes. Carried over
// from the Hume bridge's noteCallFailure.
export function callFailureNote(kind: "registration" | "initiation"): string {
  const why = kind === "registration" ? "a problem with Co's own voice setup" : "a technical problem on Co's side";
  return `Co's call didn't connect because of ${why}, not anything on their phone.`;
}
export function noteCallFailure(userId: string, kind: "registration" | "initiation"): void {
  pool
    .query(
      `INSERT INTO co_memories (user_id, memory_type, content)
       SELECT $1, 'call_failure', $2
       WHERE NOT EXISTS (SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'call_failure' AND created_at > NOW() - INTERVAL '10 minutes')`,
      [userId, callFailureNote(kind)],
    )
    .catch(() => {});
}

// Said on the line when the call can't be connected to Co (Twilio's voice,
// since Co's own isn't reachable), so it's never dead air.
export const CANT_CONNECT_LINE = "Sorry, Co can't connect right now. Co will text you.";

// ---------- the opening line
export type OpeningSituation = { direction: "inbound" | "outbound"; firstCall: boolean; hour: number | null };
type OpeningTemplate = { text: string; when?: (s: OpeningSituation) => boolean };
const morning = (s: OpeningSituation) => s.hour !== null && s.hour >= 5 && s.hour < 12;
const evening = (s: OpeningSituation) => s.hour !== null && s.hour >= 17 && s.hour < 22;
// Calm, short, never a question (the prompt asks the first one). {name} is their first name.
export const OPENINGS: OpeningTemplate[] = [
  // outbound, a first call
  { text: "Hey {name}, it's Co. Good to finally talk.", when: (s) => s.direction === "outbound" && s.firstCall },
  { text: "Hi {name}, it's Co. I've been looking forward to this.", when: (s) => s.direction === "outbound" && s.firstCall },
  { text: "{name}, hi. It's Co. Glad we're doing this.", when: (s) => s.direction === "outbound" && s.firstCall },
  { text: "Hey {name}. It's Co, finally.", when: (s) => s.direction === "outbound" && s.firstCall },
  // outbound, they know Co
  { text: "Hey {name}, it's Co.", when: (s) => s.direction === "outbound" && !s.firstCall },
  { text: "{name}, hi. It's Co.", when: (s) => s.direction === "outbound" && !s.firstCall },
  { text: "Hi {name}, Co here.", when: (s) => s.direction === "outbound" && !s.firstCall },
  { text: "Hey {name}. Good to hear your voice.", when: (s) => s.direction === "outbound" && !s.firstCall },
  { text: "{name}. It's Co. Hope this is a good time.", when: (s) => s.direction === "outbound" && !s.firstCall },
  { text: "Morning, {name}. It's Co.", when: (s) => s.direction === "outbound" && !s.firstCall && morning(s) },
  { text: "Good morning, {name}. Co here.", when: (s) => s.direction === "outbound" && !s.firstCall && morning(s) },
  { text: "Evening, {name}. It's Co.", when: (s) => s.direction === "outbound" && !s.firstCall && evening(s) },
  { text: "Hey {name}, it's Co. Hope your evening's going well.", when: (s) => s.direction === "outbound" && !s.firstCall && evening(s) },
  // they called Co
  { text: "Hey {name}, it's Co. Glad you called.", when: (s) => s.direction === "inbound" },
  { text: "{name}, hi. This is Co.", when: (s) => s.direction === "inbound" },
  { text: "Hey {name}. You've got Co.", when: (s) => s.direction === "inbound" },
  { text: "Hi {name}, it's Co. I'm here.", when: (s) => s.direction === "inbound" },
  { text: "Morning, {name}. It's Co.", when: (s) => s.direction === "inbound" && morning(s) },
  { text: "Evening, {name}. It's Co.", when: (s) => s.direction === "inbound" && evening(s) },
];

// Pure: one opening for this call, never the template used last time with
// this member (when there's another to choose). rand is injectable for tests.
export function pickOpening(o: OpeningSituation & { firstName: string; last: string | null; rand?: () => number }): { template: string; line: string } {
  const fits = OPENINGS.filter((t) => !t.when || t.when(o));
  const fresh = fits.filter((t) => t.text !== o.last);
  const pool = fresh.length ? fresh : fits;
  const t = pool[Math.min(pool.length - 1, Math.floor((o.rand ?? Math.random)() * pool.length))];
  return { template: t.text, line: t.text.replace(/\{name\}/g, o.firstName || "there") };
}

// Pure-ish: a promise or, after ms, the fallback. The answer path must never
// wait on an opener (a geocode on a cache miss has no timeout of its own).
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}
export const OPENING_BUDGET_MS = 600;

// What this member's call looks like, and which opening they heard last.
// Always answers within OPENING_BUDGET_MS: the fixed greeting if anything is slow.
export function chooseOpening(userId: string, firstName: string, direction: "inbound" | "outbound"): Promise<string> {
  return withTimeout(chooseOpeningUnbounded(userId, firstName, direction), OPENING_BUDGET_MS, OPENING_LINE.replace("{{first_name}}", firstName || "there"));
}
async function chooseOpeningUnbounded(userId: string, firstName: string, direction: "inbound" | "outbound"): Promise<string> {
  try {
    const [{ rows: calls }, { rows: last }, { rows: prof }] = await Promise.all([
      pool.query(`SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'call_transcript' AND content NOT LIKE 'Co initiated call%' LIMIT 1`, [userId]),
      pool.query(`SELECT proposal->>'template' AS template FROM harness_decisions WHERE decision = 'call.opening' AND user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]),
      pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]),
    ]);
    const zone = prof[0]?.city ? await getTimezoneForCity(prof[0].city).catch(() => null) : null;
    const hour = zone ? DateTime.now().setZone(zone).hour : null;
    const pick = pickOpening({ direction, firstCall: calls.length === 0, hour, firstName, last: last[0]?.template ?? null });
    pool
      .query(`INSERT INTO harness_decisions (layer, decision, user_id, outcome, action, proposal) VALUES (8, 'call.opening', $1, 'act', $2, $3)`, [userId, direction, JSON.stringify({ template: pick.template, line: pick.line })])
      .catch(() => {});
    return pick.line;
  } catch {
    return OPENING_LINE.replace("{{first_name}}", firstName || "there");
  }
}

// ---------- context while it rings
// The call's context is built when Co dials (while the phone rings), not
// after they answer: building it in the answer webhook added up to ~1s of
// silence after "hello" (2026-10-03 voice-layer review). Kept for 5 minutes
// per member; the answer webhook falls back to building it if it's missing.
const PREBUILT_TTL_MS = 5 * 60 * 1000;
const prebuilt = new Map<string, { at: number; summary: Promise<string> }>();
export function prebuildCallContext(userId: string, build: (userId: string) => Promise<string>, now = Date.now()): Promise<string> {
  const summary = build(userId).catch(() => "");
  prebuilt.set(userId, { at: now, summary });
  return summary;
}
export async function takeCallContext(userId: string, build: (userId: string) => Promise<string>, now = Date.now()): Promise<{ summary: string; prebuilt: boolean }> {
  const hit = prebuilt.get(userId);
  prebuilt.delete(userId);
  if (hit && now - hit.at < PREBUILT_TTL_MS) return { summary: await hit.summary, prebuilt: true };
  return { summary: await build(userId).catch(() => ""), prebuilt: false };
}

// ---------- after the call: voicemail, checked
// The agent's voicemail tool is its own judgment, and a short "hello?" has
// been mistaken for a machine before (2026-09-07, on Twilio's detector). If
// the person actually talked, the call is a conversation whatever the tool
// said; the decision is logged so a misfire shows up in review.
export function voicemailVerdict(toolFired: boolean, personTalked: boolean): "voicemail" | "conversation" | "misfire" {
  if (!toolFired) return "conversation";
  return personTalked ? "misfire" : "voicemail";
}

// Whether a finished call is a missed call (gets the gated missed-call text)
// and which kind: a voicemail the agent detected, or a call Co placed where
// nobody ever spoke (a machine the agent didn't recognise, or a pickup and a
// hangup; with Twilio's detector gone this is the only net for it). A call
// they placed to Co that stayed silent is not a missed call.
export function missedKind(verdict: "voicemail" | "conversation" | "misfire", personTalked: boolean, direction: string | undefined): "voicemail" | "silent" | null {
  if (verdict === "voicemail") return "voicemail";
  if (verdict === "conversation" && !personTalked && direction === "outbound") return "silent";
  return null;
}

// What Co said into the voicemail box, with their name in it.
export function voicemailLeft(firstName: string): string {
  return VOICEMAIL_MESSAGE.replace(/\{\{first_name\}\}/g, firstName || "there");
}

// The conversation's turns as ElevenLabs keeps them (with its per-turn
// analysis), for when the post-call webhook's turns don't carry the scores.
// Null on any failure; never throws.
export async function fetchConversationTurns(conversationId: string, timeoutMs = 10_000): Promise<unknown[] | null> {
  if (!conversationId) return null;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return Array.isArray(j?.transcript) ? j.transcript : null;
  } catch {
    return null;
  }
}

// Where the call lives on ElevenLabs (audio and transcript), kept with the
// transcript since we don't store recordings ourselves.
export function conversationLink(conversationId: string): string | null {
  return conversationId ? `https://elevenlabs.io/app/agents/history/${conversationId}` : null;
}

// Twilio's status callbacks name the member's number as To on calls Co
// places and as From on calls they place to Co.
export function memberNumberOf(body: { To?: string; From?: string; Direction?: string }, coNumber = process.env.TWILIO_PHONE_NUMBER ?? ""): { number: string | null; inbound: boolean } {
  const inbound = /^inbound/i.test(body.Direction ?? "") || (!!coNumber && body.To === coNumber);
  return { number: (inbound ? body.From : body.To) ?? null, inbound };
}
