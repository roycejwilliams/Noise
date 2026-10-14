// Test fixture: stands in for the real network UNDER the meter, so the meter can be exercised with zero tokens.
// It records every request body it receives and answers like Anthropic would.
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init) => {
  const body = JSON.parse(init?.body ?? "{}");
  appendFileSync(process.env.FAKE_SEEN, JSON.stringify({ url: String(input), model: body.model, headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()), body }) + "\n");
  // A streamed request gets a streamed answer (the golden recorder's stream path is checked with it).
  if (body.stream) {
    const events = [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 200 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1000, output_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
};
