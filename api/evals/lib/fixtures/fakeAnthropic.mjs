// Test fixture: stands in for the real network UNDER the meter, so the meter can be exercised with zero tokens.
// It records every request body it receives and answers like Anthropic would.
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init) => {
  const body = JSON.parse(init?.body ?? "{}");
  appendFileSync(process.env.FAKE_SEEN, JSON.stringify({ url: String(input), model: body.model, headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()), body }) + "\n");
  return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1000, output_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
};
