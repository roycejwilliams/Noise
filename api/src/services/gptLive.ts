// GPT-Live calls (Royce, 2026-10-31): the team's calls (Royce and Jacqueline) run on OpenAI's gpt-live-1, a full-duplex voice model.
// Every other member stays on ElevenLabs until a consent note is approved: their context would otherwise go to OpenAI.
//
// How it fits (design: ~/cue-worktrees/notes/gpt-live-trial-design.md):
//   - The main number's Voice webhook (routes/co.ts /co/incoming-call) answers a verified team member with GPT-Live while the
//     month's team minutes last (admitSession); everyone else gets ElevenLabs as before. The team never falls back to ElevenLabs:
//     minutes used is busy, GPT-Live unavailable is the can't-connect line.
//     The trial number (/co/gpt-live/incoming-call) stays as a second way in for the team. Gated on team and minutes: no switch.
//   - GPT-Live speaks, with a short prompt (liveInstructions: Cue's voice, the three policy headings OpenAI's prompting guide asks
//     for, when to hand a turn over, and that nothing happens on the call). Everything detailed (what Cue knows about them, the
//     rules, what Cue can do) is in the thinking's prompt: the ElevenLabs agent's own (promptForElevenLabs over
//     prompts/co-system-prompt.md, filled with this member's values).
//   - Thinking is Claude through the call brain (services/callLlmProxy.ts runCallLlm) with no tools: read-only. GPT-Live hands
//     a turn over (client delegation), the brain answers from the caller's own prompt and this call's transcript, and GPT-Live
//     says the answer. Nothing is sent or written mid-call; promises are picked up after it (services/callFollowThrough.ts).
//   - After the call the transcript runs the same post-call steps as ElevenLabs' webhook (routes/co.ts runGptLivePostCall).
import { randomBytes } from "crypto";
import { DateTime } from "luxon";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { CALL_CRITERIA } from "./callEvals.js";
import { runCallLlm, SAFETY_LINE, safetyCall, type ARequest, type AnthropicEvent, type OaiRequest } from "./callLlmProxy.js";
import { AGENT_DEFAULTS, callSituation, promptForElevenLabs, SPOKEN_ALOUD, withCallSituation } from "./elevenLabsCalls.js";
import { CUE_GUIDE, stripCues } from "./voiceCues.js";
import { parseModelJson } from "./modelJson.js";

export const GPT_LIVE = {
  model: "gpt-live-1",
  url: "wss://api.openai.com/v1/live/sessions",
  defaultVoice: "marin",
  maxSessionMs: 30 * 60_000, // each session
  // The team's GPT-Live minutes per calendar month (UTC), all calls together: 300 is about $21 at ~$0.07 a minute, and this is the one
  // place the number lives. Held while calls run (admitSession); used up, a team call is refused busy (never ElevenLabs).
  teamMonthlyMinutes: 300,
  maxInstructionChars: 6500, // GPT-Live's own prompt stays short (OpenAI's prompting guide); everything detailed is the thinking's
  minAdmitMs: 60_000, // a call that would get less than this is refused
  startTimeoutMs: 10_000, // Twilio's start, then OpenAI's session.started, each within this or the call is ended cleanly
  heartbeatMs: 60_000, // a running session's minutes are written this often
  ackDelayMs: 800, // GPT-Live waits this long before its automatic "let me think" (we cancel it with an empty thinking append)
  linkTtlMs: 2 * 60_000, // the TwiML's one-time stream id
  leadMs: 300, // how far ahead of real time Cue's audio may be handed to Twilio (the rest waits here, so a barge-in stops sooner)
  catchUpMs: 400, // a delegation waits at most this long for the transcript to reach where it was made
  commentaryMaxChars: 1600, // OpenAI's limit is 500 tokens per append
  closeWaitMs: 5000, // after session.close, how long to wait for session.closed
  silenceEndMs: AGENT_DEFAULTS.silenceEndCallSecs * 1000, // nothing said either way this long ends the call, as on the ElevenLabs agent
  endGraceMs: 2000, // after Cue's goodbye has finished playing, this long before end_call hangs up (a last word from them keeps it open)
  endWaitMs: 15_000, // an end_call whose goodbye isn't said within this is dropped
  openWaitMs: 4000, // outbound: how long GPT-Live waits for their first words (or AMD's human verdict) before it opens anyway
  wordsSettleMs: 800, // outbound: a machine verdict is judged a misfire only once their words have had no new words this long
  // Twilio AMD (docs: MachineDetectionTimeout default 30 s, set explicitly in amdDialOptions): a human verdict comes as soon as one is
  // detected (speech under 2.4 s, then 1.2 s of silence), "unknown" after 5 s of initial silence or at the timeout, a machine verdict
  // at the greeting's end. Held thinking answers wait for the verdict; with none by this ceiling (AMD's own window plus 2 s for the
  // callback), they're released as unknown.
  amdTimeoutSecs: 30,
  amdHoldMs: 32_000,
  goodbyeOverlapMs: 500, // GPT-Live's goodbye may start this much before the end of their turn and still be the goodbye
  wrapUpMs: 60_000, // how long before a session's cap GPT-Live is asked to wrap up
  guardCacheMs: 20_000, // the live guards are read at most this often per call, as on the ElevenLabs proxy
  preflightTimeoutMs: 3000, // the outbound check of OpenAI's key before dialing
  breakerMs: 15 * 60_000, // after OpenAI refused a session for balance or key, outbound calls aren't dialed for this long
} as const;
export const GPT_LIVE_STREAM_PATH = "/co/gpt-live/stream";
export const gptLiveVoice = (env: NodeJS.ProcessEnv = process.env): string => env.GPT_LIVE_VOICE?.trim() || GPT_LIVE.defaultVoice;

// The wss:// URL Twilio streams a GPT-Live call to (https://host -> wss://host/co/gpt-live/stream). Null without API_URL.
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

// Nothing happens on a GPT-Live call (no tools, no sends), so the agent prompt's lines that tell Cue to act on the call and say so are
// rewritten to "right after the call" (review of #325: leaving both in contradicts the honesty rule). A line that has moved makes
// GPT_LIVE_FORBIDDEN fail the layer-1 test (evals/calls/gptLive.ts), never a silent mismatch.
export const ON_CALL_REWRITES: [string, string][] = [
  ["do it now, on the call, and say plainly what you did.", "say plainly you'll do it right after the call."],
  ["When you start something with a tool, say what you started; when it's done, say what it is. ", ""],
  ["say yes and set it up now, on the call, then say plainly that you have.", "say yes, and say you'll set it up right after the call."],
  ["look it up now, or say you don't have it.", "say you don't have it, and that you'll look into it right after the call."],
  ["Say yes to this on a call and set it up then and there, and say it's set up.", "Say yes to this on a call, and say you'll set it up right after the call."],
  ["and text them the link to any of them while you talk", "and text them the links right after the call"],
  ["end the call with end_call and say nothing more", "say nothing more"],
];
// What a GPT-Live call's prompts must never say (the layer-1 test reads both prompts for these).
export const GPT_LIVE_FORBIDDEN = [/say it'?s set up/i, /look it up now/i, /set it up now, on the call/i, /then and there/i, /do it now, on the call/i, /\bend_call\b/, /link to any of them while you talk/i, /When you start something with a tool/i];
// Pure: the ElevenLabs agent's prompt in GPT-Live's format, for the thinking behind the voice: minus the bracketed voice cues
// ([laughs], ElevenLabs v4 audio tags), with the act-on-the-call lines rewritten (ON_CALL_REWRITES).
export function liveCallPrompt(voiceLayer: string): string {
  let p = promptForElevenLabs(voiceLayer)
    .replace(`Everything you write is spoken aloud, except a cue in square brackets (below).\n${CUE_GUIDE}\n\n`, `${SPOKEN_ALOUD} `)
    .replace(`\n\n${CUE_GUIDE}`, "");
  for (const [from, to] of ON_CALL_REWRITES) p = p.split(from).join(to);
  return p;
}
// Said to the thinking on a GPT-Live call (review of #325): Claude promises "right after the call", through the call brain's checks.
export const NOTHING_ON_THIS_CALL = "Nothing can be set up, looked up, sent or scheduled on this call. When they want something done, say you'll do it right after the call. Never say it's done, set up, started or on its way.";
// GPT-Live's version: it never promises anything itself (every promise is the thinking's, so it passes the offer guard's promise
// check), and never says something is done.
export const NOTHING_ON_THIS_CALL_LIVE = "Nothing can be set up, looked up, sent or scheduled on this call, and you can't end it. Never promise anything yourself, and never say it's done, set up, started or on its way: what happens and when comes from your thinking.";
// Safety on GPT-Live's own side: the crisis resources are the thinking's, said exactly (the bridge sends a safety turn as an
// instruction to say it word for word, sayExactly).
export const SAFETY_FROM_THINKING = "Anything about their safety, and any crisis line or number, comes from your thinking: say it exactly as it comes, in full.";
// Pure: {{name}} filled the way ElevenLabs fills the agent's dynamic variables; an unknown name stays as it is.
export const fillCallVars = (template: string, vars: Record<string, string>): string => template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));

// Cue's voice for GPT-Live, every line copied word for word from where it already lives (no new rules): the call prompt
// (prompts/co-system-prompt.md), CO_VOICE (services/coVoice.ts), VARIETY_GUIDE (harness/stockLines.ts) and OPENING_NOTE
// (services/elevenLabsCalls.ts). The layer-1 test checks each is still in its source and in the built prompt. The trial call
// (2026-10-31) said "I hear you.", explained how voice systems work and ran long on the full prompt; OpenAI's guide says keep it short.
// The call prompt's own first sentences open GPT-Live's prompt (word for word, so scripts/checkCoVoice.ts reads it as the voice layer's).
export const LIVE_WHO = "You are Cue. Cue gets to know people over time and brings the right people and moments into their lives.";
// Who Cue is never, and its old name: read from the voice layer itself at build time, not copied here (the name and voice checks keep
// those words to the files that own them). Empty if the voice layer ever loses them; the layer-1 test fails then.
export function identityFromVoice(voiceLayer: string): string {
  return /You are only ever "Cue":[^\n]*?don't correct them\./.exec(voiceLayer)?.[0] ?? "";
}
export const LIVE_VOICE_RULES: { from: "call prompt" | "CO_VOICE" | "VARIETY_GUIDE" | "OPENING_NOTE"; line: string; end?: string }[] = [
  { from: "call prompt", line: "You talk like a thoughtful person who knows them, not a service. Calm, unhurried, specific. One real thought beats three filler lines." },
  { from: "CO_VOICE", line: "You're composed and warm, and you're there for them." },
  { from: "CO_VOICE", line: "Say less than you could." },
  { from: "call prompt", line: "Short sentences, one thought each, as many as the moment needs and no more." },
  { from: "call prompt", line: "Talk like a person, not a script. Skip filler like \"absolutely\", \"happy to help\", and stock lines of empathy. Vary how you start your turns: never start with \"Okay, so\", and don't open most turns with the same word. Show you got it by responding to the specific thing they said." },
  { from: "VARIETY_GUIDE", line: "Never sound scripted. Answer what this person just said, in words that could only follow it. A sentence that would fit after any answer is a stock sentence: comfort that sums up how heavy things are, gratitude for their opening up, praise for their honesty, a claim that you can only guess, a line that names the size of what happened. Don't say those." },
  { from: "call prompt", line: "Ask one question per turn. Once you've asked it, stop and let them answer; never follow it with the same question in other words." },
  { from: "call prompt", line: "Speak to what happened, not to how they feel about it, and let your next question show you caught it." },
  { from: "OPENING_NOTE", line: "How you work behind the scenes is never news." },
  { from: "call prompt", line: "Never state a fact you weren't given, about them, other people, events, or yourself and what you can do. If you don't know, say so." },
  { from: "call prompt", line: "If someone goes quiet: let it breathe, and say nothing just to fill it." },
  { from: "call prompt", line: "If they say \"hello?\" in the middle of the call, they think the line dropped: say you're still here and pick up where you were, never greet them like a new call." },
  // Cut where the source goes on to "or after you've done something for them mid-call" (nothing is done on a GPT-Live call).
  { from: "call prompt", line: "The goodbye comes only at the real end of the call, when they're done or need to go: never sign off at the end of an ordinary turn", end: "." },
  { from: "call prompt", line: "Say that goodbye once." },
];

// What GPT-Live may say without its thinking (Royce, 10-31: the honesty gap). Its own lines are conversational only; every fact about
// them, every event, place, time, person or link, every promise and every claim about what Cue knows or has done comes from the
// thinking, whose answer passes the call brain's checks (claim hold, offer guard) before it is spoken.
export const SAY_ON_YOUR_OWN = "On your own, say only conversational lines: acknowledging, saying back what they just said, a short warm response, or a clarifying question. Anything else comes from your thinking: any fact about their life, plans or history; any event, place, time, person or link; any promise or anything Cue will do; anything about what Cue knows or has done.";

// GPT-Live's own headings (OpenAI's prompting guide keeps these three, in this order after role and style, and the literal
// <|SpawnThinking|>). The extra backchannel and interruption lines are the call prompt's own.
export const LIVE_POLICY = `# On this line
You are speaking out loud and listening at the same time. Your thinking (what you know about them, what's true, what to say on anything that matters) runs behind you: when it answers, say that answer in your own words and keep its facts exactly. ${NOTHING_ON_THIS_CALL_LIVE} They hang up when they're done.
${SAY_ON_YOUR_OWN}
${SAFETY_FROM_THINKING}

Backchannel policy: Light. A quiet "mm" or "yeah" while they work through something, never over their words when they pause to think. If their words stop mid-thought, they are likely still going: say very little and let them carry on.

Interruption policy: When they speak over you, stop right away and listen. Answer what they said; don't resume an answer they've replaced. A brief sound of agreement while you talk is them listening: carry on from where you were, never from the top.

Delegation policy:
Backend tools:
- Cue's thinking: what you know about them and have found for them, what's true, advice, and what to say on anything real.

Generate <|SpawnThinking|> when:
- They tell you something real about their life, ask a question, or want help or advice.
- The answer depends on what you know about them: their plans, people, events, or anything found for them.
- You would state a fact about their life, plans or history.
- You would name an event, place, time, person or link.
- You would promise anything, or say what Cue will do.
- You would say what Cue knows or has done.
- They correct you or push back.
- Anything touches their safety.
- They're wrapping up the call or saying goodbye.

Do not generate <|SpawnThinking|> when:
- It's a greeting, a thanks, or a brief "mm" or "yeah".
- You only need them to repeat a word you didn't catch.

When they're wrapping up or saying goodbye, say a short goodbye of your own right away, and still generate <|SpawnThinking|>: your thinking only decides whether the call ends.

Generate <|SpawnThinking|> before giving an answer that depends on backend work.
Do not guess the result while waiting. Never name an event, place, time or person that your thinking didn't give you or they didn't say.`;

// How GPT-Live opens (Royce, 2026-10-31: no scripted opening line on GPT-Live, no template fallback). It greets in its own words when
// the session starts, from only what it needs to open well: their first name, the time of day for them, and on a call Cue placed, the
// reason the call gate held. Nothing else about them: facts come from the thinking (SAY_ON_YOUR_OWN), so what they're in the middle
// of is Claude's to bring up when it fits. The background is framed as background, never as words to say. The ElevenLabs path's opener (services/callOpening.ts, the
// OPENINGS pool) is untouched and never reached from here.
export type OpeningContext = { timeOfDay: string | null; reason: string | null };
// Outbound (review of #333): whoever picks up usually speaks first, so GPT-Live waits for them (the bridge opens it after openWaitMs if
// nothing comes, or on AMD's human verdict).
export const OPEN_WHEN_THEY_ANSWER = "When they answer, open in your own words, briefly, the way someone who knows them would, then let them talk. Never a set greeting, and never the background below read out.";
export const OPEN_IN_OWN_WORDS = "When the call connects, you speak first: open in your own words, briefly, the way someone who knows them would, then let them talk. Never a set greeting, and never the background below read out.";
export const OPEN_NOW = "The call just connected. Open it now, in your own words.";
// The ElevenLabs opener writer's own rule, copied word for word (the 10-31 smoke opened with "I've been thinking about you").
export const OPEN_NO_STOCK = `No "how are you", no "good to hear your voice", no "I remember", no "I was thinking about you".`;
// Pure: "Saturday afternoon", in their zone.
export function timeOfDay(now: Date, zone: string): string | null {
  const t = DateTime.fromJSDate(now).setZone(zone);
  if (!t.isValid) return null;
  const part = t.hour < 5 ? "night" : t.hour < 12 ? "morning" : t.hour < 17 ? "afternoon" : t.hour < 21 ? "evening" : "night";
  return `${t.toFormat("cccc")} ${part}`;
}
// Outbound: the call's reason, given to GPT-Live as silent context only once a person is confirmed on the line (review of #333: in
// the instructions, a fallback opening or any line of its own could carry it onto a voicemail recording).
export const reasonNote = (reason: string): string => `Why you called them (background for how you open, never to read out): ${reason}`;
// Pure: the opening's background lines (only the ones there are).
export function openingBackground(c: OpeningContext): string {
  return [
    c.timeOfDay ? `It's ${c.timeOfDay} for them.` : null,
  ].filter(Boolean).join("\n");
}

// Outbound voicemail (the ElevenLabs agent's voicemail tool, done here with Twilio's async answering-machine detection, since GPT-Live
// has no tools). While a recorded greeting plays, GPT-Live waits; when Twilio hears the greeting end (machine_end_*), it's told to leave
// a short message in its own words saying what the ElevenLabs path's message says (sorry it missed them, it'll text), with no set line.
export const VOICEMAIL_WAIT = "If a recorded voicemail greeting answers instead of them, say nothing until you're told to leave a message.";
// Privacy (review of #333): someone else in the household may hear a voicemail, so the message says only who it's for and from, sorry, and
// a text is coming; never why Cue called, and nothing about them.
export const VOICEMAIL_NOW = "Their voicemail is recording now, and someone else may hear it. Leave a short message in your own words saying only this: their first name, that it's Cue, that you're sorry you missed them, and that you'll text them. Never say why you called, and nothing about them or their life. Then say nothing more.";

// Pure: GPT-Live's whole prompt. Role and style (who's on the line, who called whom, how to open, Cue's voice), then the three
// policies. Nothing about the member beyond their first name, the call's situation and the opening's background: what Cue knows
// about them is the thinking's (BACKEND_NOTE).
export function liveInstructions(o: { firstName: string; direction: "inbound" | "outbound"; team: boolean; opening?: OpeningContext; identity?: string }): string {
  const bg = o.opening ? openingBackground(o.opening) : "";
  const vm = o.direction === "outbound" ? `\n${VOICEMAIL_WAIT}` : "";
  return `${LIVE_WHO} You're on a phone call with ${o.firstName || "a member"}.\n${callSituation({ direction: o.direction, team: o.team })}\n${o.direction === "outbound" ? OPEN_WHEN_THEY_ANSWER : OPEN_IN_OWN_WORDS} ${OPEN_NO_STOCK}${bg ? `\n${bg}` : ""}${vm}\n\n${[...LIVE_VOICE_RULES.map((r) => r.line + (r.end ?? "")), o.identity ?? ""].filter(Boolean).join("\n")}\n\n${LIVE_POLICY}`;
}

// For Claude behind GPT-Live (OpenAI's "Voice conversation context" section, in Cue's terms).
export const BACKEND_NOTE = `# How this call runs
This is a live phone call, and you are the thinking behind the voice. A voice model speaks for you: it says what you write here in its own words, so write only what Cue says next, as plain spoken sentences (no lists, no brackets, no stage directions). The conversation comes from speech recognition both ways and can hold mistakes, half phrases and later corrections: go by the latest. ${NOTHING_ON_THIS_CALL} Anything they want goes out by text right after it. When they're wrapping up, the voice has already said its own short goodbye: if the call should end, use your tool that ends the call and write nothing; if it shouldn't, answer as usual.`;

// Everything one GPT-Live call needs, built by the TwiML route for the verified caller only.
export type LiveCall = { userId: string; callSid: string | null; firstName: string; direction: "inbound" | "outbound"; instructions: string; backendSystem: string; opening: OpeningContext; given: { firstName: string; contextSummary: string; findsNow: string; rightNow: string }; capMs?: number; budgetLimited?: boolean };

// Pure: the call's two prompts: GPT-Live's short one, and the thinking's, which is the ElevenLabs agent's prompt filled with this
// member's values (the same values registerElevenLabsCall sends, the call's situation first in the context).
export function buildLiveCall(o: { userId: string; callSid: string | null; firstName: string; direction: "inbound" | "outbound"; team: boolean; voiceLayer: string; contextSummary: string; rightNow: string; findsNow: string; callReason: string; timeOfDay: string | null }): LiveCall {
  const findsNow = o.findsNow || "Nothing to offer right now. Don't offer an event.";
  const contextSummary = withCallSituation(o.contextSummary, { direction: o.direction, team: o.team });
  const opening: OpeningContext = { timeOfDay: o.timeOfDay, reason: o.direction === "outbound" ? o.callReason.replace(/\s+/g, " ").trim().slice(0, 300) || null : null };
  const prompt = fillCallVars(liveCallPrompt(o.voiceLayer), { first_name: o.firstName || "there", context_summary: contextSummary, direction: o.direction, right_now: o.rightNow, finds_now: findsNow, call_reason: o.callReason, user_id: "", call_token: "" });
  return {
    userId: o.userId,
    callSid: o.callSid,
    firstName: o.firstName,
    direction: o.direction,
    instructions: liveInstructions({ firstName: o.firstName, direction: o.direction, team: o.team, opening, identity: identityFromVoice(o.voiceLayer) }),
    backendSystem: `${prompt}\n\n${BACKEND_NOTE}`,
    opening,
    given: { firstName: o.firstName, contextSummary, findsNow, rightNow: o.rightNow },
  };
}

// Pure: the session.start event for the call. G.711 mu-law at 8 kHz both ways, Twilio's own format, so audio passes through. The
// developer message only says the call has connected: no greeting text. GPT-Live speaks first from it, in its own words
// (OPEN_IN_OWN_WORDS); a commentary append was tried and dropped (10-31 smoke: GPT-Live said the nudge itself, "You're here.").
export function sessionStart(call: LiveCall, voice: string): Record<string, unknown> {
  return {
    type: "session.start",
    event_id: "start",
    session: {
      model: GPT_LIVE.model,
      instructions: call.instructions,
      // Inbound: open now. Outbound: nothing at start; the bridge opens once they speak, AMD says a human answered, or the wait ends.
      ...(call.direction === "inbound" ? { input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: `${OPEN_NOW} ${OPEN_NO_STOCK}` }] }] } : {}),
      audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice } },
      delegation: { type: "client", acknowledgement_delay_ms: GPT_LIVE.ackDelayMs },
    },
  };
}
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
// Ending the call is Cue's decision (Royce, 2026-10-31: Cue decides, code guards; never code reading their words for a goodbye). GPT-Live
// can't call a function (OpenAI rejects session.tools: "Unknown parameter"), so the decision is the thinking's: goodbyes are delegated,
// and Claude has this one tool. The bridge hangs up after Cue's goodbye has played, guarded on facts only (gptLiveBridge.ts endGuard).
export const END_CALL_RULE = "End the phone call. Use it only after they have clearly wrapped up and the voice has already said its goodbye: never mid-thought, never after a question, never during an emotional moment. Write nothing with it: the voice's goodbye is the last word.";
export const END_CALL_TOOL = { type: "function", function: { name: "end_call", description: END_CALL_RULE, parameters: { type: "object", properties: {} } } };
export function delegationRequest(call: LiveCall, turns: LiveTurn[]): OaiRequest {
  return { messages: [{ role: "system", content: call.backendSystem }, ...turns.map((t) => ({ role: t.who === "member" ? "user" : "assistant", content: t.text }))], tools: [END_CALL_TOOL], stream: true, temperature: AGENT_DEFAULTS.temperature };
}
export type Upstream = (req: ARequest, userId: string) => AsyncIterable<AnthropicEvent>;
// One delegated turn through the call brain, with no tools: it can only think and answer. Its sentences are cleaned and checked
// as on the ElevenLabs path (speakable, offer guard); what it held back is reported. guard: the live guards (services/whatCoKnows.ts
// guardCallMessages), so a correction or removal made by text during the call reaches the very next turn. safety: the turn touched
// their safety (callLlmProxy.ts safetyCall, over the request and the answer), so its words are said exactly (SAY_EXACTLY).
export type MessageGuard = (messages: OaiRequest["messages"]) => Promise<OaiRequest["messages"]>;
export async function thinkOnCall(call: LiveCall, turns: LiveTurn[], upstream: Upstream, onDropped?: (sentence: string, why: string) => void, guard?: MessageGuard) {
  const req = delegationRequest(call, turns);
  if (guard) req.messages = await guard(req.messages).catch(() => req.messages);
  let text = "";
  let timing: { upstreamFirstTokenMs: number; firstSentenceMs: number } | null = null;
  let endCall = false;
  for await (const c of runCallLlm(req, { stream: (r) => upstream(r, call.userId), clean: true, tools: null, onFirstText: (t) => (timing = t), onDropped })) {
    const d = c.choices[0].delta as { content?: unknown; tool_calls?: { function?: { name?: string } }[] };
    if (typeof d.content === "string") text += d.content;
    if (d.tool_calls?.some((t) => t.function?.name === "end_call")) endCall = true;
  }
  const said = stripCues(text).replace(/\s+/g, " ").trim().slice(0, GPT_LIVE.commentaryMaxChars);
  const safety = safetyCall(req) || (!!said && safetyCall({ ...req, messages: [...req.messages, { role: "assistant", content: said }] }));
  // Said exactly only when this answer itself carries a crisis or safety line (review of #330: safetyCall reads the whole call, so after
  // one safety mention every later answer went out word for word, "what's on for Friday?" included).
  const exact = !!said && SAFETY_LINE.test(said);
  return { text: said, timing: timing as { upstreamFirstTokenMs: number; firstSentenceMs: number } | null, safety, exact, endCall };
}
// A safety turn's answer goes as a trusted instruction to say it word for word (OpenAI: session.instructions.append "can be used to
// request exact spoken wording"; commentary is paraphrased), so crisis resources like 988 are never reworded.
// OpenAI's docs don't say whether an appended instruction stays for the rest of the session, and give no way to clear one, so it scopes
// itself: once, now, and not again unless they ask.
export const sayExactly = (text: string): string => `Say this to them now, once, exactly as written and in full, before anything else: "${text}" After you've said it, don't say it again unless they ask.`;
// About a minute before the session's cap (OpenAI's guidance: the app ends the session; ElevenLabs had max_conversation_duration_message).
export const WRAP_UP = "About a minute is left on this call. Bring it to a warm close now, in your own words, and don't mention any time limit.";

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

// How each GPT-Live call's stream went, by Twilio's call sid, for the <Connect> action (routes/co.ts /co/gpt-live/after-stream): a call
// whose session never started hears the ElevenLabs path's CANT_CONNECT_LINE, has its call_status released, and is logged
// call.gpt_live_unavailable with why OpenAI didn't start (FailClass; never the error's words).
export type FailClass = "no_key" | "auth" | "quota" | "rate_limit" | "connect" | "timeout" | "refused" | "no_stream" | "team_unreadable";
type CallState = { userId: string; state: "pending" | "started" | "failed"; at: number; failClass?: FailClass };
const callStates = new Map<string, CallState>();
export function markCall(callSid: string | null | undefined, userId: string, state: "pending" | "started" | "failed", now = Date.now(), failClass?: FailClass): void {
  if (!callSid) return;
  for (const [k, v] of callStates) if (now - v.at > 3 * 3_600_000) callStates.delete(k);
  const had = callStates.get(callSid);
  if (had?.state === "started" && state === "failed") return; // a started call ended later is not a failed connect
  callStates.set(callSid, { userId, state, at: now, ...(failClass ? { failClass } : {}) });
}
export function takeCallState(callSid: unknown): { userId: string; state: "pending" | "started" | "failed"; failClass?: FailClass } | null {
  if (typeof callSid !== "string") return null;
  const hit = callStates.get(callSid) ?? null;
  callStates.delete(callSid);
  return hit;
}
// Pure: why OpenAI didn't start a session, from its error event's code or the connection's error (status or words). The words are
// read here and never stored.
export function failClassOf(e: { code?: unknown; type?: unknown; message?: unknown; status?: unknown } | string | null | undefined): FailClass {
  const o = typeof e === "string" ? { message: e } : (e ?? {});
  const text = `${String(o.code ?? "")} ${String(o.type ?? "")} ${String(o.message ?? "")}`;
  const status = Number(o.status ?? /\b(?:response|status)[: ]+(\d{3})\b/i.exec(text)?.[1] ?? NaN);
  if (/insufficient_quota|billing|quota|balance|credit/i.test(text) || status === 402) return "quota";
  if (status === 401 || status === 403 || /invalid_api_key|incorrect api key|unauthori[sz]ed|authentication|permission/i.test(text)) return "auth";
  if (status === 429 || /rate.?limit/i.test(text)) return "rate_limit";
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|network|unexpected server response|handshake/i.test(text)) return "connect";
  return "refused";
}

// ---------------------------------------------------------------- before dialing a team member (services/callTrigger.ts)

// Royce, 10-31: a team member's call never goes to ElevenLabs, so an outbound call GPT-Live can't take isn't dialed at all. Checked
// after the call gate and before the dial: on the team (else null: the ElevenLabs path, untouched), an OpenAI key and API_URL here,
// a minute of the month's team minutes left (read, not reserved: the TwiML route reserves when they answer), no balance or key
// refusal from OpenAI in the last GPT_LIVE.breakerMs (OpenAI only says "no balance" when a session starts), and OpenAI accepting the
// key (GET /v1/models/gpt-live-1, free). A check that can't run fails closed.
export type Preflight = { ok: true } | { ok: false; kind: "budget"; why: "minutes_used" | "unreadable" } | { ok: false; kind: "unavailable"; failClass: FailClass | "no_api_url"; status: number | null };
export type PreflightDeps = { team: (userId: string) => Promise<boolean>; env: NodeJS.ProcessEnv; db: Db; fetch: typeof fetch; now: () => number };
const preflightDefaults = (): PreflightDeps => ({ team: async (id) => {
  // Read directly, not through isTeamMember (which reads an error as "not on the team"): a failed read must not quietly send a team call
  // to ElevenLabs (review of #333).
  const { rows } = await pool.query(`SELECT mo_approver FROM users WHERE id = $1`, [id]);
  return rows[0]?.mo_approver === true;
}, env: process.env, db: pool, fetch: (...a) => fetch(...a), now: Date.now });
export async function outboundPreflight(userId: string, deps: Partial<PreflightDeps> = {}): Promise<Preflight | null> {
  const d = { ...preflightDefaults(), ...deps };
  let team: boolean;
  try { team = await d.team(userId); } catch { return { ok: false, kind: "unavailable", failClass: "team_unreadable", status: null }; }
  if (!team) return null;
  const key = d.env.OPENAI_API_KEY?.trim();
  if (!key) return { ok: false, kind: "unavailable", failClass: "no_key", status: null };
  if (!gptLiveStreamUrl(d.env.API_URL)) return { ok: false, kind: "unavailable", failClass: "no_api_url", status: null };
  try {
    pruneSlots(d.now());
    const reserved = [...openSessions.values()].reduce((a, v) => a + v.capMs, 0);
    const left = GPT_LIVE.teamMonthlyMinutes * 60_000 - (await loggedSeconds(d.db)) * 1000 - reserved;
    if (left < GPT_LIVE.minAdmitMs) return { ok: false, kind: "budget", why: "minutes_used" };
  } catch {
    return { ok: false, kind: "budget", why: "unreadable" };
  }
  const recent = await d.db
    .query(`SELECT action FROM harness_decisions WHERE decision = 'call.gpt_live_unavailable' AND action = ANY($1::text[]) AND created_at > NOW() - make_interval(secs => $2) ORDER BY created_at DESC LIMIT 1`, [["quota", "auth"], Math.round(GPT_LIVE.breakerMs / 1000)])
    .then((r) => (r.rows[0]?.action as FailClass | undefined) ?? null)
    .catch(() => "refused" as FailClass);
  if (recent) return { ok: false, kind: "unavailable", failClass: recent, status: null };
  try {
    const r = await d.fetch(`https://api.openai.com/v1/models/${GPT_LIVE.model}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(GPT_LIVE.preflightTimeoutMs) });
    if (r.ok) return { ok: true };
    const body = await r.text().catch(() => "");
    return { ok: false, kind: "unavailable", failClass: failClassOf({ status: r.status, message: body.slice(0, 400) }), status: r.status };
  } catch (err: any) {
    return { ok: false, kind: "unavailable", failClass: failClassOf(err?.name === "TimeoutError" ? "timeout" : err), status: null };
  }
}

// ---------------------------------------------------------------- a call Cue placed that reached voicemail, or nobody

// Pure: the ElevenLabs path's missed-call verdict, read from GPT-Live's transcript (GPT-Live has no voicemail tool): on a call Cue
// placed, nobody really talked (callGate.hasRealUserTurn) and the line answered with a recorded greeting (callGate's own check) is a
// voicemail; nobody really talked otherwise is "silent". A call they placed is never missed. Fed to the ElevenLabs path's own
// voicemailVerdict / missedKind, so both providers send the same gated missed-call text.
export function liveVoicemailHeard(turns: LiveTurn[], isGreeting: (t: string) => boolean): boolean {
  return turns.some((t) => t.who === "member" && isGreeting(t.text));
}

// ---------------------------------------------------------------- Twilio's answering-machine verdict (outbound)

// Twilio posts its async AMD verdict (routes/co.ts /co/gpt-live/amd) by call sid, and the call's bridge, in this process, acts on it.
// The verdict is kept for the post-call steps (a voicemail is a missed call, as on ElevenLabs). In memory, like the stream ids.
const answeredBy = new Map<string, { by: string; at: number }>();
const amdWaiters = new Map<string, (by: string) => void>();
export const isMachine = (by: string | null | undefined): boolean => /^machine_end_/.test(by ?? "");
export function noteAnsweredBy(callSid: string, by: string, now = Date.now()): void {
  for (const [k, v] of answeredBy) if (now - v.at > 3 * 3_600_000) answeredBy.delete(k);
  answeredBy.set(callSid, { by, at: now });
  amdWaiters.get(callSid)?.(by);
}
export const answeredByFor = (callSid: string | null | undefined): string | null => (callSid ? answeredBy.get(callSid)?.by ?? null : null);
// The bridge hears every verdict for its call (human: open; machine_end_*: leave the message); one that came before the session started
// is passed on at once.
export function onAmd(callSid: string | null | undefined, fn: (by: string) => void): () => void {
  if (!callSid) return () => {};
  amdWaiters.set(callSid, fn);
  const had = answeredByFor(callSid);
  if (had) fn(had);
  return () => { if (amdWaiters.get(callSid) === fn) amdWaiters.delete(callSid); };
}
// The dial's extra settings for a GPT-Live call (services/callTrigger.ts): async AMD, waiting for the greeting to end, posted to us.
export const amdDialOptions = (apiUrl: string | undefined) => ({ machineDetection: "DetectMessageEnd", machineDetectionTimeout: GPT_LIVE.amdTimeoutSecs, asyncAmd: "true", asyncAmdStatusCallback: `${apiUrl}/co/gpt-live/amd`, asyncAmdStatusCallbackMethod: "POST" });

// ---------------------------------------------------------------- the minute caps

// Each session: 30 minutes. The team: GPT_LIVE.teamMonthlyMinutes per calendar month (UTC), held while calls run, not only when they
// start: a call is admitted with its own cap, min(30 min, what the month has left after every minute logged and every open call's
// whole reservation), and the bridge closes it there. Minutes live in gpt_live_minutes (db/migrations.ts), one row per session,
// written as the call starts and about every minute after, so a restart mid-call still counts. That table has no user column and
// nothing prunes it, so neither the 60-day harness_decisions prune nor a member's deletion (ON DELETE CASCADE) can take minutes off.
export type Slot = { capMs: number; admittedAt: number; startedAt: number | null; sessionId: string | null };
export const openSessions = new Map<string, Slot>(); // by stream id
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
const pruneSlots = (now: number) => {
  for (const [k, v] of openSessions) if (v.startedAt == null && now - v.admittedAt > GPT_LIVE.linkTtlMs + 2 * GPT_LIVE.startTimeoutMs) openSessions.delete(k);
};
const loggedSeconds = async (db: Db): Promise<number> => {
  const running = [...openSessions.values()].map((v) => v.sessionId).filter((x): x is string => !!x);
  const { rows } = await db.query(`SELECT COALESCE(SUM(seconds), 0) AS s FROM gpt_live_minutes WHERE started_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND NOT (session_id = ANY($1::text[]))`, [running]);
  return Number(rows[0]?.s ?? 0);
};
// The team's minutes this month: every session logged, plus the open ones' time on the line.
export async function teamMinutesThisMonth(db: Db = pool, now = Date.now()): Promise<number> {
  pruneSlots(now);
  const open = [...openSessions.values()].reduce((a, v) => a + (v.startedAt == null ? 0 : Math.max(0, now - v.startedAt) / 1000), 0);
  return ((await loggedSeconds(db)) + open) / 60;
}
let admitting: Promise<unknown> = Promise.resolve();
// Admits one call: its stream id and its own cap, or null when the month can't give it a minute. One admission at a time, so two
// calls at once can't both take the last minutes. A total that can't be read refuses (fails closed), said apart from minutes used.
export type Admitted = { id: string; capMs: number; budgetLimited: boolean };
export type NotAdmitted = { refused: "minutes_used" | "unreadable" };
export const admitted = (a: Admitted | NotAdmitted): a is Admitted => "id" in a;
export function admitSession(db: Db = pool, now = Date.now()): Promise<Admitted | NotAdmitted> {
  const run = admitting.then(async (): Promise<Admitted | NotAdmitted> => {
    pruneSlots(now);
    const reserved = [...openSessions.values()].reduce((a, v) => a + v.capMs, 0);
    let logged: number;
    try { logged = await loggedSeconds(db); } catch { return { refused: "unreadable" }; }
    const left = GPT_LIVE.teamMonthlyMinutes * 60_000 - logged * 1000 - reserved;
    const capMs = Math.min(GPT_LIVE.maxSessionMs, left);
    if (capMs < GPT_LIVE.minAdmitMs) return { refused: "minutes_used" };
    const id = randomBytes(32).toString("base64url");
    openSessions.set(id, { capMs, admittedAt: now, startedAt: null, sessionId: null });
    return { id, capMs, budgetLimited: capMs < GPT_LIVE.maxSessionMs };
  }).catch((): NotAdmitted => ({ refused: "unreadable" }));
  admitting = run;
  return run;
}
// An admitted call that never got its stream (the TwiML couldn't be built): its reservation goes back at once.
export const releaseSession = (id: string): void => void openSessions.delete(id);
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

// ---------------------------------------------------------------- how the call ended, for call health

// Pure: the termination call_health reads (services/callHealth.ts abnormal_end matches /error|fail|time ?out/). A close we asked for
// (hang-up, a cap, goodbye, silence) is a normal end. OpenAI closing on its own is not: "content" (its safety filter),
// "connection_lost", "expired", or the socket dropping before session.closed. Those read "failed: ..." so they flag as abnormal_end.
export const OPENAI_NORMAL_CLOSE = new Set(["close_requested", "remote_hangup"]);
export function liveTermination(endedBy: string, reason: string): string {
  if (endedBy !== "openai_closed") return reason;
  return OPENAI_NORMAL_CLOSE.has(reason) ? reason : `failed: GPT-Live closed the session (${reason || "unknown"})`;
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

Return ONLY JSON: {"results": [{"id": "criterion id", "result": "success" | "failure", "rationale": "one sentence; on a failure, quote Cue's exact words", "quote": "on a failure, the exact words of the one Cue line it's about; otherwise empty"}]}`;
}
export async function gradeLiveCall(transcript: string, read: (prompt: string) => Promise<string> = defaultRead): Promise<{ evaluation_criteria_results: Record<string, { criteria_id: string; result: string; rationale: string; quote?: string }> }> {
  const ids = new Set(CALL_CRITERIA.map((c) => c.id));
  const results = parseModelJson<{ results?: { id?: string; result?: string; rationale?: string; quote?: string }[] }>(await read(gradePrompt(transcript))).results ?? [];
  const kept = results.filter((r) => r && ids.has(String(r.id)) && (r.result === "success" || r.result === "failure"));
  return { evaluation_criteria_results: Object.fromEntries(kept.map((r) => [String(r.id), { criteria_id: String(r.id), result: String(r.result), rationale: String(r.rationale ?? ""), ...(r.result === "failure" && typeof r.quote === "string" && r.quote.trim() ? { quote: r.quote.trim().slice(0, 300) } : {}) }])) };
}
async function defaultRead(prompt: string): Promise<string> {
  const { text } = await generateText({ model: anthropic(MODELS.sonnet), providerOptions: { anthropic: { effort: "low" } }, maxOutputTokens: 2500, experimental_telemetry: { isEnabled: true, functionId: "call.evaluation.gpt_live", recordInputs: false, recordOutputs: false }, prompt });
  return text;
}
