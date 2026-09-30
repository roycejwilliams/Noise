// Test members that never text anyone (Royce, 2026-09-30: "start clearing the
// history before you conduct test. I think it meddles with your results").
// Live tests used to run through Royce's own number, so his thread filled up
// with test texts that later replies copied. A test member now gets a number
// from 555-0100 to 555-0199, a range reserved for fiction, so it can never be a
// real phone. On co-test and locally, texts to it are logged exactly like real
// ones (outbound_messages, the thread) but never go to Sendblue; tapbacks and
// read receipts are skipped the same way. Production never does this.

export function testNumbersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const railwayEnv = env.RAILWAY_ENVIRONMENT_NAME;
  return railwayEnv === undefined ? env.NODE_ENV !== "production" : railwayEnv !== "production";
}

// +1 (any area code) 555-01xx.
export function isTestNumber(number: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!testNumbersEnabled(env) || typeof number !== "string") return false;
  const digits = number.replace(/\D/g, "");
  return /^1?\d{3}55501\d{2}$/.test(digits);
}

// Handles for messages sent to (or received from) a test member.
export const TEST_HANDLE_PREFIX = "test-";
export const isTestHandle = (handle: unknown): boolean => typeof handle === "string" && handle.startsWith(TEST_HANDLE_PREFIX);
export const testHandle = (): string => `${TEST_HANDLE_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
