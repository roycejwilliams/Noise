import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// Traces every Claude call the Vercel AI SDK makes (generateText across
// profileExtraction/matching/circleInvite/circleApproval/booking/scheduling/
// places/co/sendblue/ai) into Langfuse. LangfuseSpanProcessor recognizes the
// AI SDK's own OTEL Gen AI spans directly — every call site just needs
// `experimental_telemetry: { isEnabled: true, functionId: "..." }` to start
// showing up here; nothing else has to change for that baseline. Call sites
// that also have a user_id in scope wrap the call in propagateAttributes
// (see e.g. profileExtraction.ts) to attach userId/traceName so traces are
// filterable/groupable per user in the Langfuse UI.
//
// LangfuseSpanProcessor reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY /
// LANGFUSE_BASE_URL from env itself — nothing to pass explicitly. Must be
// called before any generateText call fires, so this is imported and
// invoked at the very top of server.ts, after dotenv/config loads the env
// but before any route/service module that might call generateText.
export function initTelemetry(): void {
  if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) {
    console.warn("LANGFUSE_SECRET_KEY/LANGFUSE_PUBLIC_KEY not set — LLM call tracing is disabled.");
    return;
  }
  const sdk = new NodeSDK({
    // Tags every trace so local/dev runs never mix into the "production"
    // view in Langfuse — reuses the same NODE_ENV check the rest of this
    // codebase already relies on (e.g. validateTwilioSignature in co.ts).
    spanProcessors: [
      new LangfuseSpanProcessor({
        environment: process.env.NODE_ENV === "production" ? "production" : "development",
      }),
    ],
  });
  sdk.start();
}
