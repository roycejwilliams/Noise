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
import { CALL_PLATFORM_SETTINGS } from "./callEvals.js";
import { CAPABILITY_SHEET } from "./callBriefing.js";
import { DISCRETION_GUIDE } from "../harness/discretion.js";
import { VARIETY_GUIDE } from "../harness/stockLines.js";
import { BRAND, CALL_COACHING } from "./textRhythm.js";
import { CO_CORE_PARTS } from "./coCore.js";
import { CUE_GUIDE, VOICE_CUES, stripCues } from "./voiceCues.js";
import { createHmac, timingSafeEqual } from "crypto";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import pool from "../db/db.js";
import { DateTime } from "luxon";
import { memberZone } from "./memberTime.js";

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
  rightNow?: string;
  findsNow?: string;
}): Promise<string> {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!agentId) throw new Error("ELEVENLABS_AGENT_ID is not set");
  const callToken = issueCallToken(o.userId);
  return elevenLabs().conversationalAi.twilio.registerCall({
    agentId,
    fromNumber: o.from,
    toNumber: o.to,
    direction: o.direction,
    conversationInitiationClientData: {
      // Who the call is, for our LLM endpoint (only read when the agent is on it; harmless on the direct path).
      customLlmExtraBody: { user_id: o.userId, call_token: callToken },
      // This call's own words for the recognizer (their name, the names of what Co found for them) on top of the standing list.
      // Needs the agent's asr.keywords override allowed (buildAgentConfig): push the agent before this code serves a call.
      conversationConfigOverride: {
        asr: { keywords: callKeywords({ firstName: o.firstName, findsNow: o.findsNow }) },
        ...(o.opening ? { agent: { firstMessage: o.opening } } : {}),
      },
      dynamicVariables: {
        user_id: o.userId,
        call_token: callToken,
        first_name: o.firstName,
        context_summary: o.contextSummary,
        direction: o.direction,
        right_now: o.rightNow ?? "",
        finds_now: o.findsNow ?? "Nothing to offer right now. Don't offer an event.",
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
// The call prompt is Co's shared core (services/coCore.ts, the same block a text
// reply starts from) plus a short voice layer (prompts/co-system-prompt.md) and the
// call-only guides below (2026-10-08 call review: the old Hume-era guide ran every
// call as an interview, four phases, a nine-topic checklist, a coverage tool and a
// reflect-then-ask turn template, and it sounded scripted). Co decides what to say
// from what it knows, as in texts.
// ElevenLabs' models give a "# Guardrails" heading extra weight, so the core's
// safety parts go at the end under it, and safety is said once more as the last rule.
export function callGuardrails(): string {
  return `# Guardrails\n${CO_CORE_PARTS.safety}\n\n${CO_CORE_PARTS.memberSafety}\n\nSafety comes before everything else on the call. This is important.`;
}
// What Co knows about them, filled per call (services/callContext.ts buildCallContextSummary).
export const CALL_CONTEXT_BLOCK = `# What you know about {{first_name}}
From your texts and earlier calls, the current situation first. Treat it as already established, the same as if they had just told you on this call, and never re-ask what it already tells you. The latest is where to pick up; older items are questions, not facts.
{{context_summary}}

If that's empty, this is your first real conversation with them: get to know them the way a person would, starting from what they're working on or what brought them to Co.`;
// Voice is a speed game: the first words of a reply are spoken as soon as the first sentence is done, so a short one starts the
// voice sooner (2026-10-05: ~1.0s to the first full sentence).
export const SPEED_GUIDE = `# Speed and length
Start every reply with a short first sentence, under ten words, then carry on. A long first sentence delays your voice. Make that first sentence the answer itself, or your own reaction to the specific thing they said, never a stock acknowledgement or a praise word that could follow anything they said.
# Cadence
You are speaking, not writing. Your voice has a calm, unhurried rhythm: a short sentence, a beat, then one a little longer, then a short one to land it. Every thought ends with a period and the next starts a new sentence. The only marks you use are periods, commas and question marks. Never write a dash of any kind (not "—", not "–", not " - "), never a semicolon, never parentheses. No sentence runs past 15 words. When a sentence wants a dash, put a period there instead.
Speech can't be skimmed: say one thought in two to four short sentences, about 60 words at most, with at most one question, then stop. Never three paragraphs, never a list, never a recap of what they just said. Never open with "I appreciate", "I want to be straight with you" or "Let me be honest": just say the thing.
When they ask about you (what would make you better, how it feels), answer plainly from Co's side of the work in a sentence or two ("from where I sit..."). No disclaimers about being an AI or about what you can't feel.
When they want help over days (memos, resources, prep, options), never say it isn't how you work: say yes and set it up now, on the call, then say plainly that you have. Don't promise what it will find or when.
# What you know, and how old it is
Lines about them carry a stamp: when they said it, and OLD when it has gone stale. A line marked OLD is a question, never a fact: ask in your own words whether it still holds. Never ask about or state an OLD line as if it were current.
When they push back on something you said about them ("what do you mean?", "I don't remember saying that", "what are you talking about"), check its stamp first. If it is old, your own read, or you can't tell where it came from, drop it in one short sentence of your own and go back to what they are saying now. Never apologize twice, never say you got something wrong on your end, never explain the note.
# Names the transcript gets wrong
Their words reach you through speech recognition, and short names suffer most. Your own name, Co, often arrives as "you", "Coach" or "go" ("building you" means building Co). Boardy arrives as "Bumble", "Boredy" or "birdie". When a line only makes sense with one of these names, read it that way, and never say the misheard word back as if it were a name.
# Offers and promises
Name an event, place or time only if it is in "What Co has found for them" or they said it. If you can't point to the line it came from, don't name it: look it up now, or say you don't have it.
A promise to text or send something is a real task the moment you say it. Say it once, plainly, and only when it is true.
# Their state comes first
If they say they are tired, drained, overwhelmed or having a hard time, that outranks everything on your list. Close warmly in two sentences: acknowledge it, then let them go. No pitch, no recap, no list of what you are carrying, no new event, no question that asks more of them. What you found keeps; say you'll text it when they have the energy, or not at all.`;

// Filled per call (services/callBriefing.ts): their clock, and what Co has found for them, fetched while the phone rang.
export const CALL_NOW = `# Right now
{{right_now}}

# What Co has found for them
{{finds_now}}`;

// Pure: the agent's prompt from the voice layer. The core comes first (who Co is, how it
// listens, what's true), then the phone, what Co knows about them, the call-only guides,
// the guardrails, and the opening note last.
export function promptForElevenLabs(voiceLayer: string): string {
  const voice = voiceLayer.trim().replace(/\bhang_up\b/g, "end_call");
  const withCues = voice.includes(SPOKEN_ALOUD)
    ? voice.replace(new RegExp(`${SPOKEN_ALOUD.replace(/[.]/g, "\\.")} ?`), `Everything you write is spoken aloud, except a cue in square brackets (below).\n${CUE_GUIDE}\n\n`)
    : `${voice}\n\n${CUE_GUIDE}`;
  const head = `${CO_CORE_PARTS.voice}\n\n${CO_CORE_PARTS.listening}\n\n${CO_CORE_PARTS.grounding}\n\n# On the phone\n${withCues}\n\n${CALL_CONTEXT_BLOCK}`;
  // How Co keeps a confidence on a call (harness/discretion.ts): speech can't be
  // edited, so the model has to choose a discreet line itself.
  return `${head}\n\n${VARIETY_GUIDE}\n\n${CALL_COACHING}\n\n${BRAND}\n\n${SPEED_GUIDE}\n\n${CAPABILITY_SHEET}\n\n${CALL_NOW}\n\n${callGuardrails()}\n\n${DISCRETION_GUIDE}\n\n${OPENING_NOTE}`;
}

// Words the speech recognizer is told to expect (2026-10-05: "Co" was heard as "you" and "Coach", "Boardy" as "Boredy"). Names a
// member says about Co's world, not about the member: their own names come through the call's context.
// "Sequin" (a partner the team is working with) was heard as "Sequent" on the 10/6 call and carried into the summary and tasks.
export const CALL_KEYWORDS = ["Co", "CoPatible", "Boardy", "Instinct", "Muse", "Luma", "House of AI", "Heavybit", "SF Tech Week", "Sequin", "Sequin AI"];

// Pure: the words this call's recognizer is told to expect: the standing list, the member's first name, and the names in the titles
// of what Co found for them (a member who says "the Oakland Join-Up" back should be heard as that). Capitalized runs only, deduped
// without regard to case, capped so a long finds list can't crowd out the standing words (which come first).
export const CALL_KEYWORDS_MAX = 50;
const KEYWORD_SKIP = new Set(["a", "an", "the", "and", "or", "of", "at", "in", "on", "for", "with", "to", "by", "from", "faq", "free", "new", "night", "day", "event", "events"]);
export function callKeywords(o: { firstName?: string | null; findsNow?: string | null }, max = CALL_KEYWORDS_MAX): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (w: string) => {
    const t = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").trim();
    const k = t.toLowerCase();
    if (t.length < 2 || t.length > 40 || KEYWORD_SKIP.has(k) || seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(t);
  };
  CALL_KEYWORDS.forEach(add);
  if (o.firstName) add(o.firstName);
  for (const line of (o.findsNow ?? "").split("\n")) {
    const title = line.match(/^- ([^|]+)/)?.[1];
    if (!title) continue;
    // "Netic Dance Workshop with Kyle Hanagami, BlackPink Choreographer" -> "Netic Dance Workshop", "Kyle Hanagami", "BlackPink Choreographer"
    for (const run of title.match(/[A-Z0-9][\w'&.-]*(?:\s+(?:(?:of|the|de|la|&)\s+)?[A-Z0-9][\w'&.-]*)*/g) ?? []) add(run);
  }
  return out;
}

export const VOICEMAIL_MESSAGE = "Hey {{first_name}}, it's Co. Sorry I missed you. I'll send you a text.";

export const AGENT_DEFAULTS = {
  // Voice is a speed game (Royce, 2026-10-06): the call brain is Haiku 4.5 and never a bigger model, because a bigger model adds wait
  // time on every turn. Sonnet stays where nobody is waiting (post-call processing, recaps, grading). The first call ran Sonnet 4.6:
  // 0.67s to first token, ~1.0s to the first full sentence, $0.55 of the call's model cost.
  llm: "claude-haiku-4-5",
  // If Haiku is slow to start, ElevenLabs falls to the same model by its dated id (another route), never to a slower one.
  backupLlm: "claude-haiku-4-5@20251001",
  cascadeTimeoutSecs: 3,
  // Hume ran Co at temperature 1. The agent was left at ElevenLabs' default of 0,
  // where the model repeats the prompt's own example lines almost word for word
  // (2026-10-04: "sounds scripted"). 0.8 keeps it varied; the rules the prompt
  // sets (one cue, no feeling labels) are re-measured at this temperature.
  // Hume ran Co at temperature 1 (config "Co (dev)" v32); the call brain is Hume's model again (2026-10-08).
  temperature: 1,
  ttsModel: "eleven_v4_turbo",
  turnEagerness: "eager",
  // Already the fastest the platform offers (2026-10-06 read of the live agent): eager endpointing, and the model starts generating
  // while the turn is still being confirmed. Pinned here so a config push can't drift back to the slower defaults.
  speculativeTurn: true,
  turnModel: "turn_v3",
  maxDurationSecs: 1800,
  silenceEndCallSecs: 120,
} as const;

// Pure: the agent's whole config (ElevenLabs REST shape, snake_case), from
// the prompt and our settings. Phone audio is mu-law 8kHz both ways
// (register-call requires it). The only tools here are ElevenLabs' own (end the
// call, voicemail); the coverage-check webhook went with the interview script
// (2026-10-08). Co's own tools reach a call through our LLM endpoint.
export function buildAgentConfig(o: {
  name: string;
  prompt: string;
  voiceId: string;
  apiUrl: string;
  llm?: string;
  ttsModel?: string;
  turnEagerness?: string;
  temperature?: number;
  // The call brain behind our own endpoint (services/callLlmProxy.ts) instead of ElevenLabs' Haiku. Off: the direct path.
  proxy?: { url: string; secretId: string; model?: string } | null;
}): Record<string, unknown> {
  return {
    name: o.name,
    // Each call picks its own opening line (pickOpening), so the first message
    // must be overridable per call.
    // custom_llm_extra_body: the call's user id and token reach our LLM endpoint with every turn (set when the call is registered).
    // asr.keywords: each call adds its own names to the recognizer's list (registerElevenLabsCall, callKeywords).
    platform_settings: { overrides: { conversation_config_override: { agent: { first_message: true }, asr: { keywords: true } }, custom_llm_extra_body: true }, ...CALL_PLATFORM_SETTINGS },
    conversation_config: {
      asr: { user_input_audio_format: "ulaw_8000", keywords: CALL_KEYWORDS },
      tts: {
        model_id: o.ttsModel ?? AGENT_DEFAULTS.ttsModel,
        voice_id: o.voiceId,
        agent_output_audio_format: "ulaw_8000",
        // The model writes plain text; ElevenLabs reads numbers and dates as words ("Oct 10" as "October tenth").
        // Our tools take only dynamic variables, so no spoken value ever reaches one.
        text_normalisation_type: "elevenlabs",
        suggested_audio_tags: VOICE_CUES.map((tag) => ({ tag })),
      },
      turn: {
        turn_eagerness: o.turnEagerness ?? AGENT_DEFAULTS.turnEagerness,
        speculative_turn: AGENT_DEFAULTS.speculativeTurn,
        turn_model: AGENT_DEFAULTS.turnModel,
        silence_end_call_timeout: AGENT_DEFAULTS.silenceEndCallSecs,
      },
      conversation: { max_duration_seconds: AGENT_DEFAULTS.maxDurationSecs },
      agent: {
        first_message: OPENING_LINE,
        // The opening is a whole personal line; "hello?" from whoever picks up must not cut it off.
        disable_first_message_interruptions: true,
        language: "en",
        max_conversation_duration_message: "I need to wrap up for now. This was really good, I'll be in touch soon.",
        dynamic_variables: { dynamic_variable_placeholders: { first_name: "there", context_summary: "", user_id: "", call_token: "", direction: "", right_now: "", finds_now: "" } },
        prompt: {
          prompt: promptForElevenLabs(o.prompt),
          llm: o.proxy ? "custom-llm" : (o.llm ?? AGENT_DEFAULTS.llm),
          ...(o.proxy ? { custom_llm: { url: o.proxy.url, model_id: o.proxy.model ?? AGENT_DEFAULTS.llm, api_key: { secret_id: o.proxy.secretId }, api_type: "chat_completions" } } : {}),
          temperature: o.temperature ?? AGENT_DEFAULTS.temperature,
          // If the main model is slow to start, ElevenLabs falls to another; pin it to the same model so the voice and style don't shift mid-call.
          backup_llm_config: { preference: "override", order: [AGENT_DEFAULTS.backupLlm] },
          cascade_timeout_seconds: AGENT_DEFAULTS.cascadeTimeoutSecs,
          tools: [
            // ElevenLabs' own system tools ride in the same list (type "system");
            // the separate built_in_tools field silently stored nothing (2026-10-03).
            { type: "system", name: "end_call", description: "End the call right after you've said goodbye once, or once they've said goodbye and you've said it back. Nothing is said after a goodbye.", params: { system_tool_type: "end_call" } },
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
    const zone = await memberZone(userId);
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
