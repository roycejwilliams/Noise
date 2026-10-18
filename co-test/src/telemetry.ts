import { NodeSDK } from "@opentelemetry/sdk-node";
import { langfuseWithoutText } from "../../api/src/services/langfuseNoText.js";
import { LlmUsageSpanProcessor } from "../../api/src/services/llmUsage.js";
import { onShutdown } from "../../api/src/services/shutdown.js";

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
  // Cost per Claude request goes to llm_usage whether or not Langfuse is set.
  const spanProcessors: any[] = [new LlmUsageSpanProcessor()];
  if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) {
    console.warn("LANGFUSE_SECRET_KEY/LANGFUSE_PUBLIC_KEY not set — LLM call tracing is disabled.");
  } else {
    // Always "development" — co-test is never production traffic, even
    // when NODE_ENV happens to be set to "production" on Railway. No prompt
    // or reply text goes to Langfuse (api/src/services/langfuseNoText.ts).
    spanProcessors.push(langfuseWithoutText("development"));
  }
  const sdk = new NodeSDK({ spanProcessors });
  sdk.start();
  // On a restart, send the last buffered cost rows and traces before exit.
  onShutdown(() => sdk.shutdown());
}
