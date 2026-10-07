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
import { SAFE_LINE, sourceCorpus, unsourced } from "./offerGuard.js";
import { DRAINED_MAX_SENTENCES, DRAINED_NOTE, memberStateSignal } from "./memberState.js";

export const CALL_LLM_MODEL = process.env.CALL_LLM_MODEL ?? "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 500;

type OaiContent = string | { type?: string; text?: string }[] | null | undefined;
export type OaiMessage = { role: string; content?: OaiContent; tool_calls?: { id: string; type?: string; function: { name: string; arguments?: string } }[]; tool_call_id?: string };
export type OaiRequest = { model?: string; messages: OaiMessage[]; tools?: { type?: string; function: { name: string; description?: string; parameters?: unknown } }[]; stream?: boolean; temperature?: number; max_tokens?: number; max_completion_tokens?: number; elevenlabs_extra_body?: Record<string, any> };

const textOf = (c: OaiContent): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "");

type ABlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; tool_use_id: string; content: string };
export type AMessage = { role: "user" | "assistant"; content: ABlock[] };
export type ARequest = { model: string; max_tokens: number; temperature?: number; system: { type: "text"; text: string; cache_control: { type: "ephemeral" } }[]; messages: AMessage[]; tools?: { name: string; description: string; input_schema: unknown }[]; stream: true };

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
  // A call opens with Co's own greeting, and the model's turn must follow the member's: give it a quiet first line.
  if (!msgs.length || msgs[0].role !== "user") msgs.unshift({ role: "user", content: [{ type: "text", text: "(the call has just connected)" }] });
  if (msgs[msgs.length - 1].role === "assistant") msgs.push({ role: "user", content: [{ type: "text", text: "(go on)" }] });
  const asked = b.max_completion_tokens ?? b.max_tokens;
  const tools = (b.tools ?? []).filter((t) => t?.function?.name).map((t) => ({ name: t.function.name, description: t.function.description ?? "", input_schema: t.function.parameters ?? { type: "object", properties: {} } }));
  return {
    model,
    max_tokens: asked && asked > 0 ? Math.min(asked, 800) : DEFAULT_MAX_TOKENS,
    ...(typeof b.temperature === "number" ? { temperature: Math.min(1, Math.max(0, b.temperature)) } : {}),
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

export type AnthropicEvent = { type: string; index?: number; content_block?: { type: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string } };
export type OaiChunk = { id: string; object: "chat.completion.chunk"; created: number; model: string; choices: { index: 0; delta: Record<string, unknown>; finish_reason: string | null }[] };

export type ProxyDeps = {
  stream: (req: ARequest) => AsyncIterable<AnthropicEvent>;
  // Called with each sentence as it goes out to the voice.
  onSpoken?: (sentence: string) => void;
  // Called with what was kept from the voice and why (for the morning review).
  onDropped?: (sentence: string, why: string) => void;
  onFirstText?: (ms: { upstreamFirstTokenMs: number; firstSentenceMs: number }) => void;
  // Called when the member's last words say they are drained (the turn gets the note and a two-sentence cap).
  onState?: () => void;
  clean?: boolean;
  now?: () => number;
};

// The stream of OpenAI chunks ElevenLabs reads. Text is cleaned and guarded sentence by sentence; a tool call passes through whole.
export async function* runCallLlm(b: OaiRequest, deps: ProxyDeps): AsyncGenerator<OaiChunk> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const id = `chatcmpl-co-${t0.toString(36)}`;
  const created = Math.floor(t0 / 1000);
  const model = b.model ?? CALL_LLM_MODEL;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): OaiChunk => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  const clean = deps.clean !== false;
  const corpus = clean ? corpusOf(b) : "";
  yield chunk({ role: "assistant", content: "" });

  // Their state outranks the agenda: the member's last words, not Co's, and only on the first request of a turn (a tool round passes through).
  const lastAt = b.messages.map((m) => m.role).lastIndexOf("user");
  const sameTurn = lastAt >= 0 && b.messages.slice(lastAt + 1).every((m) => m.role === "tool" || (m.role === "assistant" && !textOf(m.content).trim()));
  const drained = clean && sameTurn && memberStateSignal(textOf(b.messages[lastAt].content));
  if (drained) deps.onState?.();
  const mk = () => new SpeakableStream(drained ? { maxSentences: DRAINED_MAX_SENTENCES } : {});
  let stream: SpeakableStream | null = null;
  let spokeAny = false, blanked = false, firstTokenAt = 0, firstSentenceAt = 0;
  let toolIndex = -1;
  let finish = "stop";
  const say = (s: string): string | null => {
    const sentence = s.trim();
    if (clean) {
      const bad = unsourced(sentence, corpus);
      if (bad.length) { deps.onDropped?.(sentence, `names what nothing backs: ${bad.map((m) => m.text).join(", ")}`); blanked = true; return null; }
    }
    if (!firstSentenceAt) { firstSentenceAt = now(); deps.onFirstText?.({ upstreamFirstTokenMs: (firstTokenAt || firstSentenceAt) - t0, firstSentenceMs: firstSentenceAt - t0 }); }
    spokeAny = true;
    deps.onSpoken?.(sentence);
    return s;
  };

  for await (const ev of deps.stream(toAnthropic(b, undefined, drained ? DRAINED_NOTE : undefined))) {
    if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
      stream = mk();
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      if (!firstTokenAt) firstTokenAt = now();
      if (!stream) stream = mk();
      if (!clean) { const out = say(ev.delta.text); if (out) yield chunk({ content: out }); continue; }
      for (const s of stream.push(ev.delta.text)) { const out = say(s); if (out) yield chunk({ content: out }); }
    } else if (ev.type === "content_block_stop" && stream) {
      if (clean) for (const s of stream.end()) { const out = say(s); if (out) yield chunk({ content: out }); }
      stream = null;
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      toolIndex += 1;
      finish = "tool_calls";
      yield chunk({ tool_calls: [{ index: toolIndex, id: ev.content_block.id, type: "function", function: { name: ev.content_block.name, arguments: "" } }] });
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
      yield chunk({ tool_calls: [{ index: toolIndex, function: { arguments: ev.delta.partial_json ?? "" } }] });
    } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
      if (ev.delta.stop_reason === "max_tokens") finish = "length";
    }
  }
  if (stream && clean) for (const s of stream.end()) { const out = say(s); if (out) yield chunk({ content: out }); }
  // Everything this turn was going to say was kept back: say the one safe thing, never silence.
  if (blanked && !spokeAny && finish !== "tool_calls") { deps.onSpoken?.(SAFE_LINE); yield chunk({ content: SAFE_LINE + " " }); }
  yield chunk({}, finish === "length" ? "stop" : finish);
}

// The real upstream: Anthropic's streaming Messages API.
export async function* anthropicStream(req: ARequest, apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl: typeof fetch = fetch): AsyncGenerator<AnthropicEvent> {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok || !res.body) throw new Error(`anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!data) continue;
      try { yield JSON.parse(data) as AnthropicEvent; } catch { /* a partial or keep-alive line */ }
    }
  }
}
