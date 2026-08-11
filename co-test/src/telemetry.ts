import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// Same wiring as api/src/telemetry.ts — separate call because co-test is its
// own Node process with its own entry point, so api/'s initTelemetry() never
// runs here even though co-test imports several of api/'s own service files
// directly (profileExtraction, circleApproval, circleInvite, booking,
// places, scheduling all already carry `experimental_telemetry` flags from
// that file being the same file api/ uses — this just gives co-test's
// process the SDK registration those flags need to actually export
// anywhere). co-test's own forked/local generateText call sites (matching.ts,
// webhooks.ts, recommendation.ts, dynamicPlacementTest.ts, venues.ts) are
// instrumented separately since they're not shared files.
export function initTelemetry(): void {
  if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) {
    console.warn("LANGFUSE_SECRET_KEY/LANGFUSE_PUBLIC_KEY not set — LLM call tracing is disabled.");
    return;
  }
  const sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        // Always "development" — co-test is never production traffic, even
        // when NODE_ENV happens to be set to "production" on Railway.
        environment: "development",
      }),
    ],
  });
  sdk.start();
}
