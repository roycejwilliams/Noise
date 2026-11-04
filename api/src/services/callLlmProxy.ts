// The call brain's endpoint (Royce, 2026-10-06: "build the custom LLM endpoint between ElevenLabs and Haiku").
// ElevenLabs calls this once per turn in the OpenAI chat-completions shape, with the real prompt, the conversation and its tools.
// We call Haiku with them, and the text streams back through code before the voice sees it:
//   - services/speakable.ts: dashes, semicolons, parentheses become stops; sentences past 15 words close at a comma or
//     conjunction; a long reply is cut at a sentence; each COMPLETE sentence goes out the moment it is complete, so the first one
//     reaches the voice at Haiku's own speed and the voice never gets half a sentence
//   - services/offerGuard.ts: a sentence that names an event, place or time nothing backs is not said
//   - the caller is told of each sentence that goes out (a spoken "I'll text you the links" becomes a task: callCommitments.ts)
// Rollback: CALL_LLM_PROXY off (the agent config goes back to ElevenLabs' own Haiku; push the agent) or CALL_LLM_CLEAN=off here
// (the stream passes through untouched, no push needed).
import { SpeakableStream } from "./speakable.js";
import { stockSentence } from "../harness/stockLines.js";
import { HELD_LINE, SAFE_LINE, SPOKEN_COMMON, knownSections, prepareSource, sourceCorpus, spokenProblem, type SpokenSources } from "./offerGuard.js";
import { memberStateSignal } from "./memberState.js";
import { judgeCallTurn, ruledOut, type CallTurnDecision } from "../brain/index.js";
import { recordAnthropicUsage, recordUsage, scopeMember, asMemberId } from "./llmUsage.js";
import { classifyModelFailure, failureLabel, noteModelFailure } from "./modelKeyAlert.js";
import { plainPunctuation } from "./safetyText.js";
import { callReadInput, callSentenceMiss } from "../harness/moveCheck.js";
import type { ExchangeRecord } from "./exchangeRecord.js";
import { claimHeld, claimKind, emptyClaimState, jobBacked, jobClaimKind, SEND_TALK, type ClaimState, type JobState } from "./callClaims.js";
// After "texting it to you now" and a send that didn't go: approved copy (Royce, 2026-10-29), spoken by code so it's never missing.
export const FAILED_SEND_LINE = "That didn't go through, so I'll text it to you right after the call.";
// Said as coming right after the call.
const AFTER_CALL = /\b(?:right after|after (?:we|the call|this call|you hang up)|once we (?:hang up|'re done|are done)|when we hang up|as soon as we hang up)\b/i;
// What a send tool call is for: its names (shareLink on a call), else which page or deck.
const itemsOf = (input: unknown): string[] => { const i = (input ?? {}) as { what?: unknown; which?: unknown }; return Array.isArray(i.what) ? i.what.map(String).filter(Boolean) : typeof i.which === "string" && i.which ? [i.which] : []; };

// Co's own tools on a call, built for the call's member by services/callTools.ts (kept there, so this file stays free of the
// database and the tools' imports). One turn's bounds: at most CALL_TOOL_STEPS rounds of Co's tools, inside CALL_TOOL_BUDGET_MS from
// the request arriving. A tool still running at the budget keeps running on its own (its write lands, the guard logs it) and the
// model is told it isn't back yet. 3 rounds: say a line, act, maybe one follow-on (start the task after a refused document), answer.
// 8 seconds: a task or note write is ~50ms, a document's PDF and send a few seconds; past that the voice has waited long enough.
export const CALL_TOOL_STEPS = 3;
export const CALL_TOOL_BUDGET_MS = 8000;
export type CallToolset = {
  defs: { name: string; description: string; input_schema: unknown }[];
  names: Set<string>;
  // The system block for this turn: how to use the tools on a call, their open tasks and loops by id, what was done earlier on the call.
  note: string;
  // Co's records for this member, without the guide's wording: their open tasks and loops, what Co did earlier on the call. What
  // Co says aloud may stand on these (a promise about an open task is Co's own work, not an unasked one).
  records?: string;
  run: (name: string, input: unknown, toolUseId: string) => Promise<unknown>;
  // This turn only, after the member's words (never in the cached system block): e.g. they just gave a name that belongs on an open
  // task, so writing it down is expected now.
  turnNote?: string | null;
  // This turn's facts for its note (the stop list, their words, the open tasks); the brain writes the note from them (brain/index.ts
  // judgeCallTurn). A turnNote above, when given, is used as is (tests).
  turnFacts?: { turnWords: string; tasks: { id: number; goal: string }[]; avoid?: string[]; canWriteTasks: boolean };
  // When the turn is over: what was said aloud and which of Co's tools ran (services/callTools.ts records a fact Co acknowledged
  // but didn't write down). Not awaited: the voice never waits on it.
  afterTurn?: (t: { spoken: string[]; ran: string[] }) => Promise<unknown> | void;
  // Resolves once this turn's records of what's owed after the call are written (services/callTools.ts), so a spoken "I'll text it
  // right after" joins the promise opened for it instead of opening a second (routes/callLlm.ts).
  pending?: () => Promise<void>;
  // Whether a tool with this input texts them (a send): its "texting it now" line may be said while it runs, and only what it
  // delivered may be called sent (services/callClaims.ts).
  texts?: (name: string, input: unknown) => boolean;
  // Whether a tool starts durable work that texts them later (services/capabilities.ts startsWork): its done result backs a spoken
  // "I've started on it" or "I'll text you what I find" (services/callClaims.ts jobBacked).
  starts?: (name: string) => boolean;
  // Resolves once every send that didn't go is queued for after the call (its co_tasks row and ledger row written): true when all of
  // them were, false when one couldn't be. Only a queued one is promised aloud.
  owedDurable?: () => Promise<boolean>;
  // Job text only (callClaims.ts JobState): what a spoken "started" or "I'll text you" may stand on, never finds or loops on record.
  jobs?: { corpus: string; callJobs: string };
};

// Hume's brain (2026-10-08, Royce chose it over Haiku 5.5 for depth: ~1.4s to first words vs ~0.7s): Sonnet 4.6, temperature from the
// agent (1, as Hume ran it), no default thinking.
export const CALL_LLM_MODEL = process.env.CALL_LLM_MODEL ?? "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 500;
export const CALL_TOOL_MAX_TOKENS = 1000;

type OaiContent = string | { type?: string; text?: string }[] | null | undefined;
// A sentence that is a goodbye: a sign-off, not a thank-you or an answer.
// A line that carries safety help: never cut by the one-question rule. And a turn that checks on their safety, or answers a member
// whose words raise it, has no question limit at all (review of #110: "please reach out to the lifeline" was cut).
export const SAFETY_LINE = /\b(?:988|911|741741)\b|\bnine[- ]eight[- ]eight\b|\b(?:crisis|life|hot|help) ?line\b|\bemergency\b|\bsuicid\w*|\bsomeone you trust\b|\bare you safe\b|\bstay(?:ing)? (?:right )?(?:here|with you)\b/i;
// "safe" counts only as safety talk ("not safe", "are you safe", "I'm safe tonight"): a bare "safe" lifted the limit on a turn where
// the member called their old life "a little... safe?" (2026-10-08 call eval, new_member: two questions got through).
export const SAFETY_TURN = new RegExp([
  // Broad words count only in a first-person crisis frame: "drive safe", "cutting the guest list", "my feet are killing me" and
  // "did you miss me?" must not lift the limit (review of #111), or the one-question rule is off most of the time.
  String.raw`\bunsafe\b`,
  String.raw`(?:\bnot|n't|\bnever) (?:\w+ )?(?:feel(?:ing)?|felt) safe\b|\b(?:I|you) (?:\w+ )?(?:feel(?:ing)?|felt) (?:\w+ )?safe\b`,
  String.raw`\b(?:I'?m|I am|you'?re|you are) (?:not )?safe\b(?! to\b| on\b| bet\b)|\bare you (?:\w+ )?safe\b|\bsomewhere safe\b|\bsafe right now\b|\bsafe place to (?:go|stay|sleep)\b`,
  String.raw`\b(?:I|you)(?:'ll| will|'d| would)? (?:[\w']+ ){0,3}?(?:keep (?:myself|yourself|you|me) |stay |be )safe\b`,
  String.raw`\bwant to (?:end it|disappear)\b|\brather not be here\b|\bmake it through the night\b|\bgoodbye (?:note|letter)\b|\bsleep forever\b|\b(?:do|did) to myself\b|\b(?:bought|got) a gun\b`,
  String.raw`\b(?:hurt(?:ing)?|harm(?:ing)?|kill(?:ing)?) (?:yourself|myself)\b|\bharm (?:someone|others|people|me|the kids|my kids)\b`,
  String.raw`\b(?:he|she|they|partner|husband|wife|boyfriend|girlfriend)(?:'ll| will| might| would)? (?:hit|hits|hurt|hurts|harm|harms) (?:me|the kids|my kids)\b`,
  String.raw`\bself[- ]harm|\bI(?:'ve| have)? been cutting\b|\b(?:took|swallowed|taking) (?:a bunch of|too many|all (?:my|the|of my)) pills\b|\boverdos`,
  String.raw`\b(?:want(?:ed)? to|wanna|going to|gonna) die\b|\bwish I (?:was|were) dead\b|\bbetter off dead\b|\bsuicid`,
  String.raw`\bend(?:ing)? (?:it all|my life|your life)\b|\b(?:think|thinking|thought) (?:about|of) ending (?:it|things)\b|\bdon'?t want to (?:live|be alive|exist|wake up)\b|\bbe here anymore\b`,
  String.raw`\bcan'?t (?:do this|go on|take (?:it|this)) anymore\b|\bcan'?t go on\b|\bno way out\b|\bI'?m not okay\b(?! with)`,
  String.raw`\bif I (?:just )?(?:disappeared|was gone|were gone|wasn'?t here|died)\b|\b(?:nobody|no one) would (?:even )?(?:miss|notice|care)\b`,
  String.raw`\bbetter off without me\b|\bnot wake up\b|\b(?:I'?m|I am|feel like) a burden\b|\bdark thoughts\b|\bgiving up on (?:life|everything)\b`,
].join("|"), "i");
// The member closing the call, anywhere in their last words ("ok, talk soon", "I should probably get going"). Co never hangs up
// first (Royce, 2026-10-08): ElevenLabs' end_call passes only after this, or after Co's goodbye has had their reply.
export const MEMBER_CLOSING = /\b(?:bye|goodbye|good ?night|talk (?:to you )?(?:soon|later|tomorrow)|take care|see (?:you|ya)|catch you later|speak soon|ttyl|signing off|(?:gotta|got to|have to|need to|should(?: probably)?|better|i'?m gonna) (?:go|run|jump|hop off|head out|get going|bounce|jet)(?! (?:with|to|ahead|for|and|over|through|back|grab|get|find|check|look|pick|make|take|see)\b)|i'?ll let you go|i'?m off(?! (?:work|today|tomorrow|on|for|this|next|until|till)\b)|heading out|hang up|end the call|that'?s (?:it|all) (?:for now|from me|i (?:had|needed)))\b/i;
// A short closing on its own ("Later!", "Night.", "Cheers, Co.", "Peace."): only as the whole of their last sentence.
const SHORT_CLOSING = /^(?:(?:ok(?:ay)?|alright|thanks|anyway|no|nope|nah|all good|i'?m good)[,.!]?\s+)*(?:later|night|peace|cheers|ciao|ttyl|that'?s it|that'?s all|all good|i'?m good)\b[\s\w,'!.]{0,16}$/i;
// Pure: their last words close the call. Only the last sentence or two counts, so "I'll go with the first one" mid-thought never
// lifts the hold (review of #113).
export function memberClosed(theirLast: string): boolean {
  const sentences = theirLast.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const tail = sentences.slice(-2).join(" ");
  // Every closing phrase in the tail, each read in its place: "bye the way" is no bye; "don't hang up yet" and "how do I end the call with
  // the investor" are not requests to end; "gotta go grab the deck, one sec" is not leaving; and a bye followed in the same turn by a
  // question or "actually / wait / one more thing" is the start of something new, not the end.
  const re = new RegExp(MEMBER_CLOSING.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail))) {
    const before = tail.slice(Math.max(0, m.index - 30), m.index), after = tail.slice(m.index + m[0].length);
    if (/^bye$/i.test(m[0]) && /^\s+the\s+way\b/i.test(after)) continue;
    if (/(?:hang up|end the call)/i.test(m[0]) && (/\b(?:don'?t|do not|never|not|without|no)\b[^.?!]{0,25}$/i.test(before) || /\b(?:how|when|should i|can i|do i|to)\b[^.?!]{0,25}$/i.test(before) || /^\s+(?:with|for|on|when|to)\b/i.test(after))) continue;
    if (/(?:gotta|got to|have to|need to|should|better|gonna)/i.test(m[0]) && /\b(?:hang on|hold on|one sec(?:ond)?|give me a (?:sec|minute)|just a (?:sec|minute|moment))\b/i.test(tail)) continue;
    // Skipped only when what follows starts something new: "but what / can / could...", "also can you / what about...", "actually", "wait",
    // "one more thing", "oh and", or a real question about something else. Thanks or praise after it ("but thank you", "also thanks") never
    // cancels it, nor does a sign-off question ("talk to you tomorrow?", "see you Thursday then?").
    if (/^\W*(?:but|also|and)\s+(?:what|when|where|why|how|who|which|can|could|did|do|does|will|would|should|is|are|about)\b/i.test(after) || /\b(?:actually|wait|one (?:more )?thing|oh and)\b/i.test(after) || /\b(?:what|when|where|why|how|who|which|can|could|did|do|does|will|would|is|are)\b[^?]*\?/i.test(after)) continue;
    return true;
  }
  return SHORT_CLOSING.test((sentences[sentences.length - 1] ?? "").trim());
}
// Co's own goodbye in its last turn, however phrased ("Alright Royce, take care.", "Enjoy tonight, bye!", "Night!", "Cheers, Jordan.").
export const CO_CLOSING = /\b(?:bye|goodbye|good ?night|night|take care|talk (?:to you )?(?:soon|later|tomorrow)|speak soon|see you|catch you later|cheers|enjoy (?:tonight|the|your|it)|have a (?:good|great|nice|lovely) (?:night|evening|one|day|weekend|time|trip))\b/i;
// Pure: their words ask Co something, once a greeting's own question ("what's up?", "how's it going?", "how are you?") is set aside.
const GREETING_Q = /\b(?:what'?s up|what'?s new|what'?s going on|what'?s happening|how'?s it going|how are you(?: doing)?|how'?s (?:your|ur) (?:day|night|evening|week|weekend)|how have you been|you good|sup)\b(?: (?:with you|man|dude|co|cue))?\s*\?*/gi;
export function asksCo(said: string): boolean {
  const rest = said.replace(GREETING_Q, " ");
  // "What's up with the caterer" asks about something (it's not the greeting), and a question asked without a "?" still asks
  // (review of #114: "hey when's the open house again").
  if (/\bwhat'?s (?:up|going on|happening|new) (?:with|on|about) (?!you\b)\w/i.test(said)) return true;
  return /\?|\b(?:did you|have you|can you|could you|tell me|any (?:news|luck|update)|when'?s|when is|where'?s|where is|what'?s the|what time|who'?s|how (?:much|many|long)|is it|are we|do we)\b/i.test(rest);
}
// A line that says it's done or sent is true only once a send came back done (Royce's call, 2026-10-08: "Done, I'll send that over
// now", and nothing went out; 2026-10-29: Cue acts during calls, and says it did only after the tool returns). The families of claim
// and when each may be said are services/callClaims.ts. A leading "Done," or "Sent," with nothing behind it is taken off.
const DONE_LEAD = /^(\[[a-z ]+\]\s*)?(?:done|all done|sent|there you go|there we go)[,.!]\s+(?=\S)/i;
// sent / acted: the short form (a send came back done this turn; any tool did). state: the whole picture (services/callClaims.ts).
export function stripSendClaim(sentence: string, o: { sent?: boolean; acted?: boolean; state?: ClaimState } = {}): string | null {
  const st: ClaimState = o.state ?? { ...emptyClaimState(), deliveredCount: o.sent ? 1 : 0, acted: !!o.acted, sendContext: true };
  if (claimHeld(sentence, st)) return null;
  if (st.deliveredCount) return sentence;
  // A bare or leading "Sent" needs a send; a bare or leading "Done" needs a tool that came back done.
  const bare = st.acted ? /^(\[[a-z ]+\]\s*)?sent[.!]?\s*$/i : /^(\[[a-z ]+\]\s*)?(?:done|all done|sent)[.!]?\s*$/i;
  const lead = st.acted ? /^(\[[a-z ]+\]\s*)?sent[,.!]\s+(?=\S)/i : DONE_LEAD;
  const t = sentence.replace(bare, "");
  if (!t.trim()) return null;
  if (!lead.test(t)) return t;
  return t.replace(lead, (_m, tag) => tag ?? "").replace(/^(\[[a-z ]+\]\s*)?([a-z])/, (_m, tag, c) => `${tag ?? ""}${c.toUpperCase()}`);
}
// Co placed the call, so thanking them for calling is false (Jacqueline's call, 2026-10-10: "I'm really glad you called", mid-call,
// on an outbound call). On an outbound call the clause is taken off; a sentence that is only that is dropped. "Glad we got to talk"
// and "glad you picked up" are true and stay. Inbound calls are untouched.
// Only about calling Co (review of #140): the verb ends its clause, or takes only "me" and a time word. "Glad you called me out on
// that", "happy you called Sam back", "glad you reached out to her", "thanks for calling the venue first" are about something else
// and are never touched.
const ABOUT_CO_TAIL = String.raw`(?:\s+me)?(?:\s+(?:back|again|today|tonight|just now|earlier|so late|so early))?(?=\s*(?:[.!?,;]|$)|\s+(?:and|but|so|because)\b)`;
const THANKS_FOR_CALLING = new RegExp(
  [
    String.raw`(?:^|[,;]\s*|\s(?:and|but|so)\s+)(?:(?:i'?m|i am)\s+)?(?:(?:really|so|very)\s+)?(?:glad|happy|thrilled|stoked)\s+(?:that\s+)?you\s+(?:called|rang|reached out|gave me a call)${ABOUT_CO_TAIL}`,
    String.raw`(?:^|[,;]\s*)(?:thanks|thank you|appreciate (?:you|it))\s+(?:so much\s+)?(?:for\s+)?(?:calling|the call|reaching out|ringing)${ABOUT_CO_TAIL}`,
    String.raw`(?:^|[,;]\s*)(?:(?:it'?s|it is)\s+)?(?:good|nice|great|kind)\s+of\s+you\s+to\s+call${ABOUT_CO_TAIL}`,
  ].join("|"),
  "gi",
);
// Pure: an outbound call's sentence without "glad you called" / "thanks for calling"; null when nothing is left of it.
export function thanksForCallingCut(sentence: string): string | null {
  const flat = sentence.replace(/[’‘]/g, "'");
  if (!THANKS_FOR_CALLING.test(flat)) return sentence;
  THANKS_FOR_CALLING.lastIndex = 0;
  const tag = flat.match(/^(\[[a-z ]+\]\s*)/i)?.[1] ?? "";
  const rest = flat.slice(tag.length).replace(THANKS_FOR_CALLING, "").replace(/^[\s,;.!-]+/, "").replace(/^(?:and|but|so|because)\s+/i, "").replace(/\s+([,.!?])/g, "$1").trim();
  THANKS_FOR_CALLING.lastIndex = 0;
  if (!/[a-z]{2}/i.test(rest.replace(/^(?:honestly|really|so|and|but|hey|oh)[,.!]?$/i, ""))) return null;
  return `${tag}${rest.replace(/^([a-z])/, (c) => c.toUpperCase())}`;
}
export const isOutboundCall = (system: string): boolean => /This call is outbound\b|This call: you called them\b/i.test(system);

// Pure: a question that counts as the turn's one. A short one counts too ("What changed?", "Why not?", "Did you?"); only an
// interjection ("Honestly?", "Right?") or an echo of their words ("The dinner?") doesn't (2026-10-08 eval: "What changed? Did
// something just feel different...?" slipped through as two).
export function countsAsQuestion(sentence: string): boolean {
  const ws = sentence.replace(/\[[a-z ]+\]\s*/gi, "").replace(/[?"')\]]+$/g, "").split(/\s+/).filter(Boolean).map((w) => w.toLowerCase().replace(/[^a-z']/g, ""));
  if (ws.length > 2) return true;
  if (/^(?:what|whats|what's|why|how|hows|how's|who|where|when|which)$/.test(ws[0] ?? "")) return true;
  return /^(?:do|did|are|is|was|were|can|could|would|will|have|has|should)$/.test(ws[0] ?? "") && /^(?:you|they|we|i|it|she|he)$/.test(ws[1] ?? "");
}
// They pushed back on something Co said about them ("I don't think I mentioned that"): Co drops it, never insists they did
// (Royce, #115: never argue with the member about what they said, even when Co is right).
const PUSHBACK = /\b(?:i (?:don'?t think i|never|didn'?t) (?:said|say|mention(?:ed)?|told|tell)|i don'?t (?:remember|recall) (?:saying|telling|mentioning)|that'?s not what i said|what are you talking about|i didn'?t say that)\b/i;
const INSISTS = /\b(?:you (?:did|actually) (?:say|said|mention(?:ed)?|tell|told)|you did,? actually|actually,? you did|you (?:said|mentioned|told me) (?:that|it|this) (?:before|back|last|earlier|when)|back when we (?:talked|spoke))\b/i;
export function insistsAfterPushback(theirLast: string, sentence: string): boolean {
  return PUSHBACK.test(theirLast) && INSISTS.test(sentence);
}
export const GOODBYE = /^(?:\[[a-z ]+\]\s*)?(?:(?:ok(?:ay)?|alright|all right|great|perfect)[,.!]?\s+)?(?:take care|talk (?:to you )?soon|bye|goodbye|good night|goodnight|have a (?:good|great|nice) (?:night|evening|one|day|weekend)|see you|catch you later|speak soon)\b/i;
export type OaiMessage = { role: string; content?: OaiContent; tool_calls?: { id: string; type?: string; function: { name: string; arguments?: string } }[]; tool_call_id?: string };
export type OaiRequest = { model?: string; messages: OaiMessage[]; tools?: { type?: string; function: { name: string; description?: string; parameters?: unknown } }[]; stream?: boolean; temperature?: number; max_tokens?: number; max_completion_tokens?: number; elevenlabs_extra_body?: Record<string, any> };

const textOf = (c: OaiContent): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "");

type Cache = { cache_control?: { type: "ephemeral" } };
type ABlock = ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; tool_use_id: string; content: string }) & Cache;
export type AMessage = { role: "user" | "assistant"; content: ABlock[] };
export type ARequest = { model: string; max_tokens: number; temperature?: number; thinking?: { type: "disabled" }; system: { type: "text"; text: string; cache_control: { type: "ephemeral" } }[]; messages: AMessage[]; tools?: { name: string; description: string; input_schema: unknown }[]; tool_choice?: { type: "auto" | "none" | "any" }; stream: true };

export const takesTemperature = (model: string) => /^claude-(haiku|sonnet|opus)-4/.test(model);
// Haiku 5.x thinks by default (adaptive, effort medium). On a call that thinking is dead air: the 2026-10-07 replay measured ~1.5s
// of it before the first word (first token ~2.0s median against ~0.45s for the response headers), and on 2 of 8 turns it used the
// whole token cap and said nothing. Off is accepted at its default effort; Sonnet/Opus 5.x reject "disabled", so only Haiku gets it.
export const thinksByDefault = (model: string) => /^claude-haiku-5/.test(model);

// Pure: the OpenAI request as an Anthropic one (system cached, tool calls and results as blocks, roles alternating, starting with the member).
export function toAnthropic(b: OaiRequest, model = CALL_LLM_MODEL, note?: string): ARequest {
  const system = [...b.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)), note ?? ""].filter(Boolean).join("\n\n");
  const msgs: AMessage[] = [];
  const add = (role: "user" | "assistant", blocks: ABlock[]) => {
    if (!blocks.length) return;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else msgs.push({ role, content: [...blocks] });
  };
  for (const m of b.messages) {
    if (m.role === "system" || m.role === "developer") continue;
    if (m.role === "tool") { add("user", [{ type: "tool_result", tool_use_id: String(m.tool_call_id ?? ""), content: textOf(m.content) || "(no result)" }]); continue; }
    const text = textOf(m.content).trim();
    if (m.role === "assistant") {
      const blocks: ABlock[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {};
        try { input = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = {}; }
        blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input });
      }
      add("assistant", blocks);
    } else if (text) add("user", [{ type: "text", text }]);
  }
  // Every tool call needs its result right after it (Anthropic 400s otherwise). ElevenLabs doesn't always send one back for its own
  // system tools, so a call with none gets a plain placeholder rather than failing the turn.
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "assistant") continue;
    const ids = msgs[i].content.filter((x) => x.type === "tool_use").map((x) => (x as { id: string }).id);
    if (!ids.length) continue;
    if (!msgs[i + 1] || msgs[i + 1].role !== "user") msgs.splice(i + 1, 0, { role: "user", content: [] });
    const next = msgs[i + 1];
    const have = new Set(next.content.filter((x) => x.type === "tool_result").map((x) => (x as { tool_use_id: string }).tool_use_id));
    const missing: ABlock[] = ids.filter((id) => !have.has(id)).map((id) => ({ type: "tool_result", tool_use_id: id, content: "(done)" }));
    // Results lead the message, before any words of theirs.
    next.content = [...next.content.filter((x) => x.type === "tool_result"), ...missing, ...next.content.filter((x) => x.type !== "tool_result")];
  }
  // A call opens with Co's own greeting, and the model's turn must follow the member's: give it a quiet first line.
  if (!msgs.length || msgs[0].role !== "user") msgs.unshift({ role: "user", content: [{ type: "text", text: "(the call has just connected)" }] });
  if (msgs[msgs.length - 1].role === "assistant") msgs.push({ role: "user", content: [{ type: "text", text: "(go on)" }] });
  // The conversation is cached too, not only the system prompt: each turn re-sends the whole call so far, and the next turn reads
  // everything up to here from the cache (a 14-minute call carries ~10k tokens of history). A changed line only misses the cache.
  const lastMsg = msgs[msgs.length - 1];
  lastMsg.content[lastMsg.content.length - 1] = { ...lastMsg.content[lastMsg.content.length - 1], cache_control: { type: "ephemeral" } };
  const asked = b.max_completion_tokens ?? b.max_tokens;
  const tools = (b.tools ?? []).filter((t) => t?.function?.name).map((t) => ({ name: t.function.name, description: t.function.description ?? "", input_schema: t.function.parameters ?? { type: "object", properties: {} } }));
  return {
    model,
    max_tokens: asked && asked > 0 ? Math.min(asked, 800) : DEFAULT_MAX_TOKENS,
    // Haiku 5.5 refuses a temperature (400 "`temperature` is deprecated for this model"); only the 4.x models still take one.
    ...(typeof b.temperature === "number" && takesTemperature(model) ? { temperature: Math.min(1, Math.max(0, b.temperature)) } : {}),
    ...(thinksByDefault(model) ? { thinking: { type: "disabled" as const } } : {}),
    system: [{ type: "text", text: system || "(no instructions were sent)", cache_control: { type: "ephemeral" } }],
    messages: msgs,
    ...(tools.length ? { tools } : {}),
    stream: true,
  };
}

// What the guard may count as a source: the system prompt (context, finds, clock), the member's own lines and tool results.
export function corpusOf(b: OaiRequest): string {
  const system = b.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  return sourceCorpus({
    system,
    theirLines: b.messages.filter((m) => m.role === "user").map((m) => textOf(m.content)),
    toolResults: b.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content)),
  });
}

// What everything said aloud is checked against (offerGuard.ts spokenProblem), normalized once per turn and again when a tool
// returns. `records` is Co's own: its open tasks and loops, what it did earlier on the call (callTools.ts note). A name or number
// may stand on all of it; a promise of later work only on what they said on the call, the context and finds sections, what a tool
// returned this turn and Co's records, never on the prompt's own examples.
export function callSources(b: OaiRequest, records = "", toolResults = ""): SpokenSources {
  const system = b.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  const theirLines = b.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const tools = [...b.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content)), toolResults].filter(Boolean);
  return {
    all: prepareSource(sourceCorpus({ system: `${system}\n${records}\n${SPOKEN_COMMON}`, theirLines, toolResults: tools })),
    asked: prepareSource(sourceCorpus({ system: `${knownSections(system)}\n${records}`, theirLines, toolResults: tools })),
  };
}

export type AnthropicEvent = { type: string; index?: number; content_block?: { type: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string } };
export type OaiChunk = { id: string; object: "chat.completion.chunk"; created: number; model: string; choices: { index: 0; delta: Record<string, unknown>; finish_reason: string | null }[] };

export type ProxyDeps = {
  stream: (req: ARequest) => AsyncIterable<AnthropicEvent>;
  // Called with each sentence as it goes out to the voice.
  onSpoken?: (sentence: string) => void;
  // Called with what was kept from the voice and why (for the morning review).
  onDropped?: (sentence: string, why: string) => void;
  onFirstText?: (ms: { upstreamFirstTokenMs: number; firstSentenceMs: number }) => void;
  // Called when a turn ends on the last-resort line (nothing else could be said), for the daily failure count.
  onLastResort?: (line: string) => void;
  // Called when the member's last words say they are drained (the turn gets the note and a two-sentence cap).
  onState?: () => void;
  // The brain's decision for this turn (brain/index.ts judgeCallTurn), for the decision log.
  onDecision?: (d: CallTurnDecision) => void;
  clean?: boolean;
  // Voice only (Royce, 2026-10-08: the direct path had no way to keep dashes out of the voice or hold a turn to one question). The
  // stream is only made speakable (a dash becomes a full stop) and ends at its first question; nothing is fact-checked, held back,
  // regenerated or added (no tools, no turn notes). The model's words are its own.
  voiceOnly?: boolean;
  // Co's own tools for the call's member (services/callTools.ts), run here mid-turn. Without them a turn is text plus
  // ElevenLabs' tools, as before.
  tools?: CallToolset | null;
  maxToolSteps?: number;
  toolBudgetMs?: number;
  // Each of Co's tools as it comes back (or doesn't, inside the budget), and each round fed back to the model.
  onTool?: (t: { name: string; input: unknown; result: unknown; ms: number; timedOut: boolean }) => void;
  // overBudget: the turn had used its whole time budget (CALL_TOOL_BUDGET_MS) when the round ended.
  onToolRound?: (r: { step: number; last: boolean; overBudget: boolean }) => void;
  now?: () => number;
  // The live voice read's line for this turn (services/voiceRead.ts voiceLine, read by routes/callLlm.ts without waiting on
  // Hume): how they sound when it adds to their words, never a feeling's name. Absent when there is nothing strong.
  voiceRead?: string | null;
  // Calls whose voice says the thinking's words in its own (2026-11-02): a line that says work started, or promises later work or delivery, is said only once a job backs it
  // (services/callClaims.ts jobClaimKind, jobBacked). Never on a safety turn: nothing holds a safety answer back.
  jobClaims?: boolean;
  // The sentences the word cap kept from the voice (services/speakable.ts unsaid), so the next turn can carry on from them.
  onCapped?: (unsaid: string[]) => void;
  // This turn's own notes (no tools this turn, where the last answer stopped): after their words, past the cache breakpoint, like the
  // turn note, so the call's cached prefix is untouched (review of #365).
  turnNotes?: string[];
  // The whole exchange (services/exchangeRecord.ts), Royce 2026-11-03: a sentence that asks again what they answered (on this call or in
  // the record), offers again what was already sent, or reopens something they closed is held before it's spoken, and the turn answers
  // again in its own words (the #365 hold). Undefined: the check is off (the ElevenLabs path, tests that don't pass it).
  exchange?: ExchangeRecord | null;
  // The read of their latest words that the check waits for (services/exchangeRecord.ts readCallTurn): started with the turn, never
  // awaited by the voice. Until it lands, or when it fails or isn't given, nothing is held for repeating (review of #368).
  callRead?: (i: import("./exchangeRecord.js").CallReadInput) => Promise<import("./exchangeRecord.js").CallTurnRead | null>;
};

// What the member last said, for the safety check on the question rule.
// Once the call has touched their safety (anything they said, or Co's own safety line or question), it stays a safety call: no
// question limit for the rest of it, so a crisis phrasing the pattern misses later can't cut Co's follow-up (review of #111).
export function safetyCall(b: OaiRequest): boolean {
  return b.messages.some((m) => {
    // Read with phone punctuation made plain: a transcript or Co's own line can carry "don’t" (review of #283).
    const t = plainPunctuation(textOf(m.content ?? ""));
    return m.role === "user" ? SAFETY_TURN.test(t) : m.role === "assistant" && (SAFETY_LINE.test(t) || SAFETY_TURN.test(t));
  });
}

// Pure: whether end_call can pass on this request: their last words close the call (memberClosed), or, when Co's goodbye answered their own, their reply to it.
// A goodbye Co guessed at plus any reply is not a close. The same read runCallLlm makes for the turn's closed fact; a caller that hands sentences on before the answer is done uses it
// to hold a closing turn's words until it knows whether the call ends.
// An explicit request to end the call: needs no confirmation.
// An explicit request to end the call, about the call itself: "end the call", "hang up", "I need to go / hop off", "we can wrap up" with nothing
// after it, "I should let you go". "Let's stop this and go over the pitch", "wrap up the deck first" and "stop this whole plan" are not.
const EXPLICIT_END_RE = /\b(?:end (?:the|this|our) call|hang up|(?:i|we) (?:need|have|got|gotta) to (?:go|hop off|run|jump off)|i (?:should|gotta|better) (?:go|hop off|run|let you go)|let you go|(?:we (?:can|could)|let'?s|can we|could we|shall we|i think we should) (?:wrap(?: this| it)?(?: up)?|stop(?: this| here)?|end(?: this| it)?))(?=\W*$)/i;
export function explicitEnd(reply: string): boolean {
  return reply.split(/(?<=[.!?])\s+/).some((x) => {
    const t = x.trim();
    if (/\b(?:hang on|hold on|one sec(?:ond)?|give me a (?:sec|minute))\b/i.test(t)) return false;
    if (/\b(?:how|when|should)\b[^.?!]{0,25}\b(?:end|hang up)\b|\b(?:don'?t|do not|never|not|without)\b[^.?!]{0,25}\b(?:end|hang up)\b|end (?:the|this|our) call (?:with|for|on|when|to)\b/i.test(t)) return false;
    if (/\b(?:end (?:the|this|our) call|hang up)\b/i.test(t)) return true;
    return EXPLICIT_END_RE.test(t);
  });
}
export function callClosing(b: OaiRequest): boolean {
  const lastAt = b.messages.map((m) => m.role).lastIndexOf("user");
  if (lastAt < 0) return false;
  const reply = textOf(b.messages[lastAt]?.content ?? "");
  // "I'm good" / "all good" answering a question of Cue's ("how are you?", "want me to send it?") is an answer, not a goodbye.
  const cueAsked = b.messages.slice(0, lastAt).filter((m) => m.role === "assistant" && textOf(m.content ?? "").trim()).map((m) => textOf(m.content ?? "").trim()).pop();
  if (cueAsked && /\?["')\]]*$/.test(cueAsked) && /^\W*(?:(?:ok(?:ay)?|yeah|yes|no),?\s*)?(?:(?:i'?m|we'?re)\s+)?(?:good|fine|great|all good|ok(?:ay)?)(?:,?\s*thanks)?\W*$/i.test(reply)) return false;
  // The member's own goodbye, or their explicit "we can end the call", closes it, whatever Cue said before.
  if (memberClosed(reply) || explicitEnd(reply)) return true;
  // A reply to Cue's goodbye closes it only when Cue was answering THEIR goodbye. A goodbye Cue guessed at ("Talk soon, Jordan." after
  // two "yeah"s) plus any reply is not a close: the call goes on. A reply that opens something new never closes.
  const coAt = b.messages.slice(0, lastAt).map((m, i) => (m.role === "assistant" && textOf(m.content ?? "").trim() ? i : -1)).filter((i) => i >= 0).pop();
  if (coAt == null) return false;
  const coLastWords = textOf(b.messages[coAt].content ?? "").split(/(?<=[.!?])\s+/).slice(-2);
  if (!coLastWords.some((x) => GOODBYE.test(x.trim()) || CO_CLOSING.test(x))) return false;
  const theirBefore = [...b.messages.slice(0, coAt)].reverse().find((m) => m.role === "user");
  const opensNew = /\?|^\W*(?:wait|actually|hold on|one (?:more|last)|before you go|oh and|one thing|but|also|can you|could you|what about|how about)\b/i.test(reply);
  const theirText = textOf(theirBefore?.content ?? "");
  return !opensNew && (memberClosed(theirText) || explicitEnd(theirText));
}

// The stream of OpenAI chunks ElevenLabs reads. Text is cleaned and guarded sentence by sentence; a tool call passes through whole.
export async function* runCallLlm(b: OaiRequest, deps: ProxyDeps): AsyncGenerator<OaiChunk> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const id = `chatcmpl-co-${t0.toString(36)}`;
  const created = Math.floor(t0 / 1000);
  // Our model, whatever the agent's request names (2026-10-07: Haiku 5.5 without re-pushing the ElevenLabs agent).
  // CALL_LLM_MODEL is the one-variable rollback.
  const model = CALL_LLM_MODEL;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): OaiChunk => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  const clean = deps.clean !== false;
  const voiceOnly = !!deps.voiceOnly;
  const co = voiceOnly ? null : (deps.tools ?? null);
  let sources: SpokenSources | null = clean && !voiceOnly ? callSources(b, co?.records ?? "") : null;
  yield chunk({ role: "assistant", content: "" });

  // Their state outranks the agenda: the member's last words, not Co's, and only on the first request of a turn (a tool round passes through).
  const lastAt = b.messages.map((m) => m.role).lastIndexOf("user");
  // An inbound call's first reply (Co has said only its greeting): they lead, so the turn ends at Co's question to them
  // ("what's on your mind?"), never followed by Co's own topic (2026-10-08 call eval, casual_hello, twice).
  // Only their first words, and only when those don't ask Co something: an answer to "did you find a caterer?" is never cut
  // (review of #114).
  // Who placed the call (services/elevenLabsCalls.ts callSituation, and the prompt's {{direction}}).
  const outbound = isOutboundCall(b.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content ?? "")).join("\n"));
  const inboundFirst = /This call is inbound\b/i.test(b.messages.filter((m) => m.role === "system").map((m) => textOf(m.content ?? "")).join("\n")) && b.messages.filter((m) => m.role === "assistant" && textOf(m.content ?? "").trim()).length <= 1 && b.messages.filter((m) => m.role === "user").length === 1 && !asksCo(textOf(b.messages[lastAt]?.content ?? ""));
  const sameTurn = lastAt >= 0 && b.messages.slice(lastAt + 1).every((m) => m.role === "tool" || (m.role === "assistant" && !textOf(m.content).trim()));
  const drained = clean && !voiceOnly && sameTurn && memberStateSignal(textOf(b.messages[lastAt].content));
  if (drained) deps.onState?.();
  // A safety line is never held by the word cap (2026-11-02: a crisis instruction past 90 words was dropped like any sentence).
  // On a safety call or turn the cap is lifted entirely (review of #365): no step and no crisis sentence dropped or split.
  const mk = () => { const st = new SpeakableStream({ keep: (x) => SAFETY_LINE.test(plainPunctuation(x)) }); if (safetyTurn) st.lift(); return st; };
  // What the word cap kept from the voice this turn: said to the caller (onCapped), never lost silently.
  const capped: string[] = [];
  const endStream = (st: SpeakableStream): string[] => { const out = st.end(); capped.push(...st.unsaid()); return out; };
  let stream: SpeakableStream | null = null;
  let spokeAny = false, blanked = false, firstTokenAt = 0, firstSentenceAt = 0;
  let toolIndex = -1;
  let finish = "stop";
  // What was said aloud this turn, and whether an event offer was among what was held back (its fallback is SAFE_LINE).
  const spokenLines: string[] = [];
  // What they last said, and whether Co's previous line was already a goodbye (both from this request's own messages).
  const theirLast = textOf(b.messages[lastAt]?.content ?? "");
  const askedForSpecific = /\?\s*$|\b(?:what(?:'s| is| was)|who|which|how (?:much|many)|name|number|price|cost)\b/i.test(theirLast);
  const coBefore = [...b.messages.slice(0, lastAt)].reverse().find((m) => m.role === "assistant" && textOf(m.content ?? "").trim());
  const coLastWords = coBefore ? textOf(coBefore.content ?? "").split(/(?<=[.!?])\s+/).slice(-2) : [];
  const saidGoodbye = coLastWords.some((x) => GOODBYE.test(x.trim()));
  // The brain judges the turn from these facts (brain/index.ts judgeCallTurn); what it rules out is enforced below.
  const decision = judgeCallTurn({
    drained,
    safetyCall: safetyCall(b),
    inboundFirst,
    // Their goodbye now, or their reply to Co's own goodbye in any words (callClosing: one read, shared with callers that need it
    // before the turn runs).
    closed: callClosing(b),
    tools: co ? { note: co.note, ...(co.turnFacts ?? { turnWords: "", tasks: [], canWriteTasks: false }) } : null,
    givenTurnNote: co?.turnNote,
  });
  deps.onDecision?.(decision);
  let repeatGoodbye = false;
  const heldWhy: string[] = [];
  // A send came back done this turn (a link is in their texts), or any of Cue's tools came back done: only then may a line say so.
  // What may be claimed this turn (services/callClaims.ts): what a send that texted them delivered, what it tried and didn't, whether
  // one is in flight, whether any tool came back done, and whether the turn is about sending at all.
  // About sending: their last words, Cue's line before them ("Want me to text you the link?" / "Yes please"), or a send this turn.
  const claims: ClaimState = { ...emptyClaimState(), sendContext: SEND_TALK.test(theirLast) || SEND_TALK.test(textOf(coBefore?.content ?? "")) };
  // Work Cue may say it started or will deliver (jobClaims): the jobs that back it, from Cue's records (its open tasks, what
  // it started earlier on the call) and, as tools come back, what they started this turn.
  const jobCheck = clean && !voiceOnly && !!deps.jobClaims;
  const jobs: JobState = { thisTurn: 0, corpus: co?.jobs?.corpus ?? "", callJobs: co?.jobs?.callJobs ?? "", onCall: !!co?.jobs?.callJobs.trim(), need: co?.turnFacts?.turnWords || theirLast };
  // The draft against the whole exchange (harness/moveCheck.ts callSentenceMiss): the call so far as turns, Cue's and theirs.
  const moveCheck = clean && !voiceOnly && deps.exchange !== undefined;
  const callTurns = b.messages.slice(0, lastAt + 1).filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ from: m.role === "user" ? ("them" as const) : ("co" as const), text: textOf(m.content ?? "") })).filter((t) => t.text.trim());
  // The read of their latest words, started now; the check uses it only once it has landed.
  let callRead: import("./exchangeRecord.js").CallTurnRead | null = null;
  if (moveCheck && deps.callRead) deps.callRead(callReadInput(callTurns, deps.exchange ?? null, [])).then((r) => { callRead = r; }).catch(() => {});
  // A job line said before the tool that starts it, in this same reply: held until that tool comes back, then said if the job is real.
  let pendingJob: string[] = [];
  // A send that didn't go couldn't be queued for after the call: nothing may promise it later.
  let owedFailed = false;
  // Past the last round of tools (tool_choice none): nothing more can start this turn.
  let toolsOff = false;
  // The retries below are the model's last word: a held "texting it now" there has no send coming.
  let inRetry = false;
  // A "texting it to you now" line said before its send is called: held until the send is in flight in this same reply, else dropped.
  let pendingNow: string[] = [];
  let nowSaid = false;
  // The fixed line after a failed in-flight send has been said this turn.
  let owedLineSaid = false;
  // Lines said since the last round of tools came back (a failed send's next words must say it comes right after the call).
  let linesSinceTools: string[] = [];
  // Said anything since the last round of Cue's tools came back: a turn whose only words after a tool were held back (a "sent" that
  // wasn't) answers again, never ends on the line before the tool.
  let spokeSinceTools = true;
  const unsureSaid = new Set<string>();
  let heldEvent = false;
  // A stock-only sentence held back; said after all if it was the whole reply (never silence for style).
  let heldStock: string | null = null;
  // end_call held because they hadn't said goodbye.
  let heldEnd = false;
  const sayHeld = (): string | null => {
    const h = heldStock;
    heldStock = null;
    if (!h) return null;
    if (!firstSentenceAt) { firstSentenceAt = now(); deps.onFirstText?.({ upstreamFirstTokenMs: (firstTokenAt || firstSentenceAt) - t0, firstSentenceMs: firstSentenceAt - t0 }); }
    spokeAny = true;
    spokenLines.push(h.trim());
    deps.onSpoken?.(h.trim());
    return h;
  };
  // One question per turn, a hard rule in code (2026-10-08 call eval: 5 of 10 calls asked two in one turn): once a question is
  // said, the turn ends there ("Once you've asked it, stop", the call prompt).
  // After the turn's question, only further QUESTIONS are dropped (review of #110: dropping every later sentence cut real answers,
  // "The dinner? It's Friday at seven." came out as "The dinner?"). A one- or two-word rhetorical "Honestly?" isn't the question.
  // No limit once the call has touched their safety (safetyCall).
  let asked = false;
  let safetyTurn = safetyCall(b);
  const say = (s: string): string | null => {
    const sentence = s.trim();
    const isQuestion = /\?["')\]]*\s*$/.test(sentence);
    // The safety reads see phone punctuation made plain ("don’t", a no-break space); everything else reads the sentence as said.
    const plainS = plainPunctuation(sentence);
    if (clean && asked && ruledOut(decision, "after_question") && !safetyTurn && !SAFETY_LINE.test(plainS)) {
      deps.onDropped?.(sentence, "after the question on an inbound call's first reply: they lead");
      return null;
    }
    if (clean && asked && isQuestion && ruledOut(decision, "second_question") && !safetyTurn && !SAFETY_LINE.test(plainS)) {
      deps.onDropped?.(sentence, "a second question in the turn");
      return null;
    }
    if (clean && outbound) {
      const kept = thanksForCallingCut(sentence);
      if (kept === null) {
        deps.onDropped?.(sentence, "thanks them for calling on a call Cue placed");
        return null;
      }
      if (kept !== sentence) {
        deps.onDropped?.(sentence, "\"glad you called\" on a call Cue placed");
        return say(s.replace(sentence, kept));
      }
    }
    if (clean && insistsAfterPushback(theirLast, sentence)) {
      deps.onDropped?.(sentence, "insists they said something they say they didn't");
      return null;
    }
    if (moveCheck && !safetyTurn && !SAFETY_LINE.test(plainS) && !SAFETY_TURN.test(plainS)) {
      const miss = callSentenceMiss(sentence, { rec: deps.exchange ?? null, callTurns: [...callTurns, ...spokenLines.map((t) => ({ from: "co" as const, text: t }))], delivered: claims.delivered, read: callRead });
      if (miss) {
        const why = `move held: ${miss.why}`;
        deps.onDropped?.(sentence, why);
        heldWhy.push(why);
        blanked = true;
        return null;
      }
    }
    if (jobCheck && !safetyTurn && !SAFETY_LINE.test(plainS)) {
      const jk = jobClaimKind(sentence);
      if (jk && !jobBacked(sentence, jobs)) {
        if (!inRetry && co && !toolsOff && jk !== "booked") { pendingJob.push(s); return null; }
        const why = `claim held: ${jk === "booked" ? "says something was booked, bought, reserved or made public, and nothing on a call does that" : jk === "started" ? "says work started with no job behind it" : "promises later work with no job behind it"}`;
        deps.onDropped?.(sentence, why);
        heldWhy.push(why);
        blanked = true;
        return null;
      }
    }
    if (clean) {
      const held = claimHeld(sentence, claims);
      // "Texting it to you now", said just before the send is called: it waits for the send to start (a moment), then is said.
      if (held && /send is happening/.test(held) && !inRetry && co?.texts) {
        pendingNow.push(s);
        return null;
      }
      const kept = held ? null : stripSendClaim(sentence, { state: claims });
      if (kept === null) {
        const why = `claim held: ${held ?? "says it did something before a tool came back done"}`;
        deps.onDropped?.(sentence, why);
        // Never dead air for it: if nothing else is said this turn, Cue answers again without the claim (below). Voice-only mode
        // regenerates nothing, as before.
        if (!voiceOnly) {
          heldWhy.push(why);
          blanked = true;
        }
        return null;
      }
      if (kept !== sentence) {
        deps.onDropped?.(sentence, "claim held: a \"Done\" before anything was done");
        s = s.replace(sentence, kept);
        return say(s);
      }
    }
    // A sentence that is only a stock phrase ("And I hear you.") isn't said (harness/stockLines.ts stockSentence): the reply goes on
    // without it, the same way a dash is cleaned. Never on a safety call's help line.
    if (clean && stockSentence(sentence) && !SAFETY_LINE.test(plainS)) {
      deps.onDropped?.(sentence, "a stock line");
      heldStock ??= s;
      return null;
    }
    // Goodbye once (2026-10-08 live call: "Take care tonight." then, after "you too", "Take care, Royce."). Once Co has said
    // goodbye, another goodbye isn't spoken; ending the call is all that's left.
    if (saidGoodbye && GOODBYE.test(sentence)) {
      repeatGoodbye = true;
      return null;
    }
    let out = s;
    let line = sentence;
    if (sources) {
      // Every sentence, not only event offers: each name, place, time and number has to be backed, and a promise of later work
      // has to be about something asked or on record (offerGuard.ts spokenProblem). An unbacked name, time or number is said as
      // not known, once per turn; an event offer or an unasked promise is held back.
      const p = spokenProblem(sentence, sources);
      if (p) {
        const why = p.kind === "promise" ? `promises later work nobody asked for: ${p.missing.join(", ")}` : `names what nothing backs: ${p.missing.join(", ")}`;
        // "I'm not sure" only answers a question they asked for that name or number; said unprompted it's a non sequitur
        // (2026-10-08 live call: a dropped line came out as "...on your side. I'm not sure of the name.").
        // Never a line written for Co (2026-10-08, Royce: "the model controls the response, no scripted lines"): the sentence is
        // dropped, and if nothing else is said this turn Co says it again in its own words without it (below).
        deps.onDropped?.(sentence, why);
        heldWhy.push(why);
        if (p.kind === "event") heldEvent = true;
        blanked = true;
        return null;
      }
    }
    if (!firstSentenceAt) { firstSentenceAt = now(); deps.onFirstText?.({ upstreamFirstTokenMs: (firstTokenAt || firstSentenceAt) - t0, firstSentenceMs: firstSentenceAt - t0 }); }
    // Co checking on their safety makes the whole turn a safety turn: no question limit after it.
    if (SAFETY_LINE.test(plainS) || (isQuestion && SAFETY_TURN.test(plainS))) { safetyTurn = true; stream?.lift(); }
    if (isQuestion && countsAsQuestion(sentence)) asked = true;
    spokeAny = true;
    spokeSinceTools = true;
    linesSinceTools.push(line);
    if (claimKind(line, true) === "now") nowSaid = true;
    spokenLines.push(line);
    deps.onSpoken?.(line);
    return out;
  };

  // Co's own tools (services/callTools.ts) run here, mid-turn, and never reach ElevenLabs; its own tools (end_call,
  // voicemail_detection) still pass through as tool_calls. Bounded: maxToolSteps rounds, and toolBudgetMs from the request arriving.
  const ran: string[] = [];
  const maxSteps = deps.maxToolSteps ?? CALL_TOOL_STEPS;
  const budgetMs = deps.toolBudgetMs ?? CALL_TOOL_BUDGET_MS;
  let req = toAnthropic(b, undefined, decision.systemNote);
  // The sends started this turn, by tool call, with what each was for.
  const sendIds = new Map<string, string[]>();
  // Each of Cue's tools this turn, by tool call: its name and input (what a job it started was for).
  const runMeta = new Map<string, { name: string; input: unknown }>();
  const dropPendingJob = (why: string) => {
    for (const p of pendingJob) { deps.onDropped?.(p.trim(), `claim held: ${why}`); heldWhy.push(`claim held: ${why}`); blanked = true; }
    pendingJob = [];
  };
  // The held job lines, once this round's tools are back: said when a job now backs them, else kept from the voice.
  function* releasePending(): Generator<OaiChunk> {
    const held = pendingJob;
    pendingJob = [];
    for (const p of held) {
      if (jobBacked(p.trim(), jobs)) { const out = say(p); if (out) yield chunk({ content: out }); }
      else { const why = "claim held: says work started or promises it, and no job came back behind it"; deps.onDropped?.(p.trim(), why); heldWhy.push(why); blanked = true; }
    }
  }
  if (co) {
    // Co's own tools can take a longer input than a spoken line (a page; PR 6: at 500 a deck's input was cut off mid-write,
    // stop_reason max_tokens). Decks pass a brief on a call, so a little room is enough; spoken lines stay short by the call's rules.
    req.max_tokens = Math.max(req.max_tokens, CALL_TOOL_MAX_TOKENS);
    const theirs = new Set((req.tools ?? []).map((t) => t.name));
    req.tools = [...(req.tools ?? []), ...co.defs.filter((d) => !theirs.has(d.name))];
    // This turn's note goes after their words, past the cache breakpoint: the cached prefix (system and the call so far) is untouched.
    if (decision.turnNote) req.messages[req.messages.length - 1].content.push({ type: "text", text: decision.turnNote });
  }
  // The voice read goes after their words too, past the cache breakpoint, like the turn note. Voice-only mode adds nothing,
  // and on a safety call the voice is never used: it can't soften or outweigh serious words.
  if (deps.voiceRead && !voiceOnly && !safetyCall(b)) req.messages[req.messages.length - 1].content.push({ type: "text", text: deps.voiceRead });
  for (const n of deps.turnNotes ?? []) if (n) req.messages[req.messages.length - 1].content.push({ type: "text", text: n });
  // What Co's tools returned this turn also backs what Co says (an event searchEvents found can be named).
  let toolCorpus = "";
  for (let step = 0; ; step++) {
    const blocks: ABlock[] = [];
    const runs: Promise<{ block: ABlock; raw: unknown; timedOut: boolean }>[] = [];
    let cur: { kind: "text"; text: string } | { kind: "co"; id: string; name: string; json: string } | { kind: "el"; args: boolean } | { kind: "skip" } | null = null;
    let elCalled = false;
    for await (const ev of deps.stream(req)) {
      if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
        stream = mk();
        cur = { kind: "text", text: "" };
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        if (!firstTokenAt) firstTokenAt = now();
        if (!stream) stream = mk();
        if (cur?.kind === "text") cur.text += ev.delta.text;
        if (!clean) { const out = say(ev.delta.text); if (out) yield chunk({ content: out }); continue; }
        for (const s of stream.push(ev.delta.text)) { const out = say(s); if (out) yield chunk({ content: out }); }
      } else if (ev.type === "content_block_stop") {
        if (stream) {
          if (clean) for (const s of endStream(stream)) { const out = say(s); if (out) yield chunk({ content: out }); }
          stream = null;
        }
        if (cur?.kind === "text" && cur.text.trim()) blocks.push({ type: "text", text: cur.text });
        else if (cur?.kind === "co") {
          // Started the moment its input is complete, while the voice is still saying the line before it.
          let input: unknown = {};
          try { input = cur.json.trim() ? JSON.parse(cur.json) : {}; } catch { input = {}; }
          blocks.push({ type: "tool_use", id: cur.id, name: cur.name, input });
          ran.push(cur.name);
          runMeta.set(cur.id, { name: cur.name, input });
          // A send that texts them starts now: the turn is about sending, what it's for is tried, and a "texting it now" line held
          // for it is true and goes out.
          if (co!.names.has(cur.name) && co!.texts?.(cur.name, input)) {
            claims.sendContext = true;
            claims.inFlight = true;
            sendIds.set(cur.id, itemsOf(input));
            const release = pendingNow;
            pendingNow = [];
            for (const p of release) { const out = say(p); if (out) yield chunk({ content: out }); }
          }
          runs.push(runTool(co!,cur.id, cur.name, input, Math.max(0, budgetMs - (now() - t0)), deps.onTool));
        } else if (cur?.kind === "el" && !cur.args) {
          // A call tool with no input still sends valid JSON: ElevenLabs parses the arguments string.
          yield chunk({ tool_calls: [{ index: toolIndex, function: { arguments: "{}" } }] });
        }
        cur = null;
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        const name = String(ev.content_block.name ?? "");
        // With jobClaims (the thinking behind a voice that has no tools of its own), every tool but end_call is Cue's: one off this call's
        // list is refused by the toolset's own run ("No tool named ... on a call") and the model hears it, never passed on as the voice's.
        if (co?.names.has(name) || (jobCheck && co && name !== "end_call")) {
          // Past the cap a Co tool is never run, whatever the model sends (the request already said none).
          cur = toolsOff ? { kind: "skip" } : { kind: "co", id: String(ev.content_block.id ?? `co_${step}_${runs.length}`), name, json: "" };
          continue;
        }
        // end_call only once they've closed: their goodbye now, or any reply to Co's goodbye. Held, the call stays open a turn.
        // Held when they haven't closed, even on a turn that says nothing (review of #113: a bare end_call mid-call still hung up
        // first). A held turn with nothing said gets one more answer below, never dead air.
        if (name === "end_call" && ruledOut(decision, "end_call")) {
          deps.onDropped?.("end_call", "Cue never hangs up first: they haven't said goodbye");
          heldEnd = true;
          cur = { kind: "skip" };
          continue;
        }
        cur = { kind: "el", args: false };
        // A stock-only reply held back, then the call ends: say it first rather than hang up in silence (review of #112).
        if (heldStock && !spokeAny && !blanked) { const h = sayHeld(); if (h) yield chunk({ content: h }); }
        elCalled = true;
        toolIndex += 1;
        finish = "tool_calls";
        yield chunk({ tool_calls: [{ index: toolIndex, id: ev.content_block.id, type: "function", function: { name, arguments: "" } }] });
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
        if (cur?.kind === "co") { cur.json += ev.delta.partial_json ?? ""; continue; }
        if (cur?.kind === "skip") continue;
        if (cur?.kind === "el" && ev.delta.partial_json) cur.args = true;
        yield chunk({ tool_calls: [{ index: toolIndex, function: { arguments: ev.delta.partial_json ?? "" } }] });
      } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
        if (ev.delta.stop_reason === "max_tokens") finish = "length";
      }
    }
    if (stream && clean) for (const s of endStream(stream)) { const out = say(s); if (out) yield chunk({ content: out }); }
    stream = null;
    // A "texting it now" with no send behind it in this reply: never said.
    for (const p of pendingNow) {
      const why = "claim held: says a send is happening when none is in flight";
      deps.onDropped?.(p.trim(), why);
      if (!voiceOnly) { heldWhy.push(why); blanked = true; }
    }
    pendingNow = [];
    if (!runs.length) { if (pendingJob.length) dropPendingJob("says work started or promises it, and nothing was started"); break; }
    const settled = await Promise.all(runs);
    const results = settled.map((x) => x.block);
    for (const r of results) if (r.type === "tool_result") toolCorpus += `\n${r.content}`;
    // What came back done: only now may the turn's words say it went (services/callTools.ts marks a send that reached them delivered).
    claims.inFlight = false;
    let roundTried = 0, roundWent = 0;
    const owedThisRound: string[] = [];
    for (const x of settled) {
      const raw = x.raw as { ok?: unknown; delivered?: unknown; pending?: unknown; items?: { name?: unknown; url?: unknown; delivered?: unknown }[] } | null;
      const id = (x.block as { tool_use_id?: string }).tool_use_id ?? "";
      const tried = sendIds.get(id);
      if (tried) {
        // Per item: what went, and what was tried and didn't (failed, not back in time).
        const items = Array.isArray(raw?.items) ? raw!.items : [];
        const went = !x.timedOut && raw && raw.ok !== false && raw.delivered === true ? items.filter((i) => i?.delivered === true) : [];
        for (const i of went) claims.delivered.push(...[i.name, i.url].filter((v): v is string => typeof v === "string" && !!v));
        const wentCount = went.length || (!x.timedOut && raw?.ok !== false && raw?.delivered === true && !items.length ? 1 : 0);
        claims.deliveredCount += wentCount;
        roundTried++;
        roundWent += wentCount;
        const missed = items.length ? items.filter((i) => !went.includes(i)).map((i) => String(i?.name ?? "")).filter(Boolean) : went.length || raw?.delivered === true ? [] : tried;
        claims.undelivered.push(...(x.timedOut || !raw || raw.ok === false ? (missed.length ? missed : tried.length ? tried : ["it"]) : missed));
      }
      // A job that started (durable work that texts them later) backs what Cue says about it.
      const meta = runMeta.get(id);
      // A start that came back as a job already running (alreadyStarted): that job's own goal, never this call's input (review of #365,
      // round 2: "and a florist" returned as the caterers job would otherwise have backed "I'll text you the florists").
      if (meta && !x.timedOut && raw && raw.ok !== false && co?.starts?.(meta.name)) { const r2 = raw as { alreadyStarted?: unknown; goal?: unknown }; const t = r2.alreadyStarted === true ? `\n${typeof r2.goal === "string" ? r2.goal : ""}` : `\n${JSON.stringify(meta.input ?? {})}\n${JSON.stringify(raw).slice(0, 2000)}`; jobs.thisTurn++; jobs.corpus += t; jobs.callJobs += t; }
      if (tried && (raw as { owedAfterCall?: unknown } | null)?.owedAfterCall === true) owedThisRound.push(...(tried.length ? tried : ["it"]));
      if (x.timedOut || !raw || raw.ok === false) continue;
      if (raw.pending !== true) claims.acted = true;
    }
    // A send that didn't go is a job only once it's queued for after the call (its task and ledger rows written).
    let owedOk = true;
    if (owedThisRound.length && jobCheck) {
      owedOk = co?.owedDurable ? await co.owedDurable().catch(() => false) : false;
      if (!owedOk) owedFailed = true;
      if (owedOk) { const t = `\nOwed right after the call: ${owedThisRound.join(", ")}`; jobs.thisTurn++; jobs.corpus += t; jobs.callJobs += t; }
    }
    // What the tools returned backs what Co says next (an event searchEvents found can be named, a task it started can be promised).
    if (clean) sources = callSources(b, co?.records ?? "", toolCorpus);
    // ElevenLabs' own tool in the same message (a goodbye with end_call): Co's tools have run; the call's tool goes out as it is.
    if (elCalled) { yield* releasePending(); break; }
    const overBudget = now() - t0 >= budgetMs;
    const last = step + 1 >= maxSteps || overBudget;
    toolsOff = last;
    req = {
      ...req,
      messages: [...req.messages, { role: "assistant", content: blocks }, { role: "user", content: results }],
      // At the cap the model answers from what it has: no more tool rounds this turn.
      ...(last ? { tool_choice: { type: "none" as const } } : {}),
    };
    deps.onToolRound?.({ step: step + 1, last, overBudget });
    spokeSinceTools = false;
    linesSinceTools = [];
    // They just heard it was being texted and nothing went: the next thing they hear is that it comes right after the call, before
    // anything else the model says (a question included), in these approved words. The model is told it was said.
    // With jobClaims, only once it's really queued for after the call; if it couldn't be, the next words say plainly it didn't go.
    if (nowSaid && roundTried && !roundWent && !owedLineSaid && jobCheck && (!owedOk || !owedThisRound.length)) {
      owedLineSaid = true;
      heldWhy.push("the text you said was going didn't go through and couldn't be queued for later: say plainly it didn't go through, and don't promise it later");
      blanked = true;
    }
    if (nowSaid && roundTried && !roundWent && !owedLineSaid) {
      owedLineSaid = true;
      spokeAny = true;
      spokeSinceTools = true;
      spokenLines.push(FAILED_SEND_LINE);
      linesSinceTools.push(FAILED_SEND_LINE);
      deps.onSpoken?.(FAILED_SEND_LINE);
      yield chunk({ content: FAILED_SEND_LINE + " " });
      const lastMsg = req.messages[req.messages.length - 1];
      lastMsg.content = [...lastMsg.content, { type: "text", text: `(You just told them: "${FAILED_SEND_LINE}" Don't say it again or say it went; carry on.)` }];
    }
    yield* releasePending();
  }
  // Everything this turn was going to say was kept back: say the one safe thing, never silence.
  // An event offer held back gets the safe line (as before); anything else held back, a plain acknowledgement, never a new promise.
  if (repeatGoodbye && !spokeAny && finish !== "tool_calls") {
    // Both sides have said goodbye and nothing else was left to say: end the call (ElevenLabs' own end_call), in silence.
    yield chunk({ tool_calls: [{ index: 0, id: `call_end_${Date.now().toString(36)}`, type: "function", function: { name: "end_call", arguments: JSON.stringify({ reason: "goodbyes already said" }) } }] });
    yield chunk({}, "tool_calls");
    return;
  }
  // Held back and the turn is left without an answer (nothing said, or they asked for a name or number and that was what was held):
  // Co answers again, once, in its own words, without what it couldn't back. Never a line written for it.
  const heldAnswer = askedForSpecific && heldWhy.some((w) => /^names what nothing backs/.test(w));
  // They heard it was being texted, and it didn't go: the next words must say it comes right after the call.
  if (clean && !voiceOnly && nowSaid && claims.undelivered.length && !claims.deliveredCount && finish !== "tool_calls" && !owedFailed && !linesSinceTools.some((l) => AFTER_CALL.test(l))) {
    heldWhy.push("the text you said was going didn't go through: say plainly you'll text it right after the call, and don't say it went");
    blanked = true;
    spokeSinceTools = false;
  }
  if (blanked && finish !== "tool_calls" && heldWhy.length && (!spokeAny || heldAnswer || !spokeSinceTools)) {
    const already = spokenLines.length ? ` You already said: "${spokenLines.join(" ")}". Carry on from it; don't repeat it.` : "";
    // A sentence held only for repeating what's done, asked or closed gets its own note (review of #368), never the "can't back" one.
    const moveOnly = heldWhy.length > 0 && heldWhy.every((w) => w.startsWith("move held: "));
    const note = moveOnly ? `What you were about to say repeated something already said, sent or closed in this exchange (${[...new Set(heldWhy)].slice(0, 3).join("; ")}). Answer what they last said, in your own words, without repeating it.${already}` : `What you were about to say included something you can't back here (${[...new Set(heldWhy)].slice(0, 3).join("; ")}). Answer them again, in your own words, without it.${askedForSpecific ? " If they asked for a name, place or number you don't have, say plainly that you don't know it." : ""} Don't promise anything they didn't ask for.${already}`;
    const retry: ARequest = { ...req, system: [...req.system, { type: "text", text: note } as any], ...(req.tools?.length ? { tool_choice: { type: "none" as const } } : {}) } as ARequest;
    inRetry = true;
    let rs: SpeakableStream | null = null;
    try {
      for await (const ev of deps.stream(retry)) {
        if (ev.type === "content_block_start" && ev.content_block?.type === "text") rs = mk();
        else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          if (!rs) rs = mk();
          if (!clean) { const out = say(ev.delta.text); if (out) yield chunk({ content: out }); continue; }
          for (const x of rs.push(ev.delta.text)) { const out = say(x); if (out) yield chunk({ content: out }); }
        } else if (ev.type === "content_block_stop" && rs) {
          if (clean) for (const x of endStream(rs)) { const out = say(x); if (out) yield chunk({ content: out }); }
          rs = null;
        }
      }
    } catch (err: any) {
      console.error("call: the held-turn retry failed (non-fatal):", err?.message ?? err);
    }
  }
  if (heldStock && !spokeAny && !blanked && finish !== "tool_calls") { const h = sayHeld(); if (h) yield chunk({ content: h }); }
  // end_call was held and nothing else was said: Co answers them instead, once, in its own words (never a scripted line).
  if (heldEnd && !spokeAny && finish !== "tool_calls") {
    const note = "You were about to end the call, but they haven't said goodbye. Don't end it and don't say goodbye: answer what they last said.";
    const retry: ARequest = { ...req, system: [...req.system, { type: "text", text: note } as any], ...(req.tools?.length ? { tool_choice: { type: "none" as const } } : {}) } as ARequest;
    inRetry = true;
    let rs: SpeakableStream | null = null;
    try {
      for await (const ev of deps.stream(retry)) {
        if (ev.type === "content_block_start" && ev.content_block?.type === "text") rs = mk();
        else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          if (!rs) rs = mk();
          if (!clean) { const out = say(ev.delta.text); if (out) yield chunk({ content: out }); continue; }
          for (const x of rs.push(ev.delta.text)) { const out = say(x); if (out) yield chunk({ content: out }); }
        } else if (ev.type === "content_block_stop" && rs) {
          if (clean) for (const x of endStream(rs)) { const out = say(x); if (out) yield chunk({ content: out }); }
          rs = null;
        }
      }
    } catch (err: any) {
      console.error("call: the held-end retry failed (non-fatal):", err?.message ?? err);
    }
    if (heldStock && !spokeAny) { const h = sayHeld(); if (h) yield chunk({ content: h }); }
  }
  // Last resort only (the retry was held back too, or failed): one plain line, never silence.
  if ((blanked || heldEnd) && !spokeAny && finish !== "tool_calls") {
    const line = heldEvent ? SAFE_LINE : HELD_LINE;
    spokenLines.push(line);
    deps.onSpoken?.(line);
    deps.onLastResort?.(line);
    yield chunk({ content: line + " " });
  }
  if (capped.length) deps.onCapped?.(capped);
  if (co?.afterTurn) Promise.resolve().then(() => co.afterTurn!({ spoken: spokenLines, ran })).catch((err: any) => console.error("call: after-turn check failed (non-fatal):", err?.message ?? err));
  yield chunk({}, finish === "length" ? "stop" : finish);
}

export const TOOL_TOO_SLOW = "Not back yet: it keeps running on its own and lands when it's done, but it couldn't finish inside this turn of the call. Don't say it's done or sent; say it'll come by text right after the call, and if it's real looking they need, take it on with startTask.";

// One of Co's tools, inside what's left of the turn's budget. Past it, the tool is left to finish on its own (its write still lands
// and the guard still logs it) and the model is told it isn't back yet.
async function runTool(co: CallToolset, id: string, name: string, input: unknown, leftMs: number, onTool?: ProxyDeps["onTool"]): Promise<{ block: ABlock; raw: unknown; timedOut: boolean }> {
  const started = Date.now();
  const p = Promise.resolve()
    .then(() => co.run(name, input, id))
    .catch((err: any) => ({ ok: false, error: `It failed: ${String(err?.message ?? err).slice(0, 160)}. Say plainly it wasn't done.` }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TOOL_TOO_SLOW>((resolve) => { timer = setTimeout(() => resolve(TOOL_TOO_SLOW), leftMs); });
  const r = await Promise.race([p, late]);
  if (timer) clearTimeout(timer);
  // Past the turn's budget here, or past the tool's own timeout on a call (services/callTools.ts: stillRunning).
  const timedOut = r === TOOL_TOO_SLOW || (!!r && typeof r === "object" && (r as { stillRunning?: unknown }).stillRunning === true);
  onTool?.({ name, input, result: r === TOOL_TOO_SLOW ? null : r, ms: Date.now() - started, timedOut });
  const content = r === TOOL_TOO_SLOW ? JSON.stringify({ ok: false, stillRunning: true, note: TOOL_TOO_SLOW }) : JSON.stringify(r ?? { ok: true });
  return { block: { type: "tool_result", tool_use_id: id, content: content.slice(0, 6000) }, raw: r === TOOL_TOO_SLOW ? null : r, timedOut };
}

// The real upstream: Anthropic's streaming Messages API.
// Each request's usage (message_start carries the input side, message_delta the running output count) is written to llm_usage as
// "call.turn" when the stream ends, however it ends (2026-10-23: call turns were the one path with no cost row).
export async function* anthropicStream(req: ARequest, apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl: typeof fetch = fetch, userId: string | null = null): AsyncGenerator<AnthropicEvent> {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok || !res.body) {
    const detail = `anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
    // The refused request has its cost row too, saying it failed (kind and status only), and a refused key raises the team alert
    // (services/modelKeyAlert.ts).
    const failure = classifyModelFailure({ status: res.status, message: detail });
    noteModelFailure("anthropic", failure);
    recordUsage({ functionId: "call.turn", userId: userId === null ? null : (asMemberId(userId) ?? scopeMember()), traceId: null, model: req.model, inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, webSearches: 0, costUsd: 0, error: failureLabel(failure) });
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let usage: Record<string, any> | null = null;
  let model = req.model;
  let ended = false;
  let outChars = 0; // what the model wrote, for the output count when the stream is stopped before its final usage
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
        if (!data) continue;
        let ev: AnthropicEvent;
        try { ev = JSON.parse(data) as AnthropicEvent; } catch { continue; /* a partial or keep-alive line */ }
        usage = usageFromEvent(ev, usage);
        const dt = ev.delta?.text ?? ev.delta?.partial_json;
        if (typeof dt === "string") outChars += dt.length;
        if ((ev as any).type === "message_start" && typeof (ev as any).message?.model === "string") model = (ev as any).message.model;
        yield ev;
      }
    }
  } finally {
    // The reader stopped early (an answer the caller moved on from, 2026-11-02): the connection is closed, so the rest isn't
    // generated.
    if (!ended) void reader.cancel().catch(() => {});
    if (usage) recordAnthropicUsage("call.turn", model, ended ? usage : usageAtStop(usage, outChars), userId);
  }
}

// Pure: the usage of a stream stopped before its final message_delta. Only message_start's output count (about 1) has arrived, so the
// output is counted from what was received, at about 4 characters a token, never below what Anthropic reported. An estimate and a
// lower bound: a few tokens written after the last one received aren't seen.
export function usageAtStop(usage: Record<string, any>, outChars: number): Record<string, any> {
  const reported = Number(usage.output_tokens) || 0;
  return { ...usage, output_tokens: Math.max(reported, Math.ceil(outChars / 4)) };
}

// message_start holds the request's input counts (and output so far); each message_delta holds the running totals, so the last
// one wins field by field.
export function usageFromEvent(ev: AnthropicEvent, acc: Record<string, any> | null): Record<string, any> | null {
  const e = ev as any;
  const u = e?.type === "message_start" ? e.message?.usage : e?.type === "message_delta" ? e.usage : null;
  if (!u || typeof u !== "object") return acc;
  const next: Record<string, any> = { ...(acc ?? {}) };
  for (const [k, v] of Object.entries(u)) if (v !== null && v !== undefined) next[k] = v;
  return next;
}
