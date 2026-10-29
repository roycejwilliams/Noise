import "../lib/requireMeter.js";
// Diagnoses a failing Jev gateway call: prints the error's status, type and
// message (never the key). One tiny request, with and without zero data retention.
import { experimental_evaluate as evaluate } from "ai7";
import { createGateway } from "@ai-sdk/gateway";
const key = process.env.AI_GATEWAY_API_KEY ?? "";
console.log("key set:", !!key, "length:", key.length, "prefix:", key.slice(0, 4));
const provider = createGateway({ apiKey: key });
for (const zdr of [true, false]) {
  try {
    const r: any = await evaluate({
      model: provider.evaluationModel("typesafe-ai/jev"),
      state: { latest_message: "thanks!" } as any,
      questions: { closing: { type: "boolean", instructions: "Is `latest_message` just closing the conversation?" } } as any,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(8000),
      ...(zdr ? { providerOptions: { gateway: { zeroDataRetention: true } } } : {}),
    });
    console.log(`zdr=${zdr}: OK`, JSON.stringify(r?.answers));
  } catch (e: any) {
    console.log(`zdr=${zdr}: ${e?.constructor?.name} status=${e?.statusCode ?? e?.status} type=${e?.type ?? ""}`);
    console.log("  message:", String(e?.message ?? "").slice(0, 400));
    const body = e?.responseBody ?? e?.cause?.responseBody ?? e?.data;
    if (body) console.log("  body:", String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 400));
  }
}
