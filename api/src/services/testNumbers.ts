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

// The clean live-test member (scripts/testMember.ts reset): a +1 415 555-0100..0199 number AND the email reset writes,
// jordan.testNN@example.test. The number alone isn't enough (review of #271): a simulated inbound, a sim guest or a Luma guest can
// get a 415-555-01xx account too, and must never take the live-test member's place. The newest unarchived account with both is the
// member deliberate live tests run through; it keeps paid searches the other test members skip (services/testMemberSpend.ts).
export const LIVE_TEST_PHONE_LIKE = "+141555501%";
export const liveTestEmail = (tag: string): string => `jordan.test${tag}@example.test`;
export type LiveTestCandidate = { id: string; phone_number: string | null; email: string | null; archived_at: Date | string | null };
export const isLiveTestRow = (r: LiveTestCandidate): boolean =>
  !r.archived_at && /^\+141555501\d{2}$/.test(r.phone_number ?? "") && /^jordan\.test\d{2}@example\.test$/.test(r.email ?? "");
// Rows newest first (ORDER BY created_at DESC): the first with the marker, or null.
export const pickLiveTestMember = <T extends LiveTestCandidate>(rows: T[]): T | null => rows.find(isLiveTestRow) ?? null;
// One query for both readers (testMember.ts current(), testMemberSpend.ts): the candidates, newest first.
export const LIVE_TEST_CANDIDATES_SQL = `SELECT id, phone_number, email, archived_at, first_name FROM users WHERE phone_number LIKE '${LIVE_TEST_PHONE_LIKE}' AND archived_at IS NULL ORDER BY created_at DESC LIMIT 50`;

// The simulation tool sends a REAL inbound through the real webhook, and Co's reply is really texted. It may only ever be pointed at a
// test member (2026-10-06: a 9/29 run through Royce's own number left 16 test messages, their asks, tasks and a week-later chest-tightness
// check-in in his real account). Returns why a number is refused, or null when it may be used.
export function simulationBlockedReason(number: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isTestNumber(number, env)) return null;
  return `${typeof number === "string" ? number.slice(0, 5) + "…" : "that number"} is not a test member (a 555-01xx number, on co-test or locally only). The simulation tool sends a real inbound and a real reply, so it never runs against a real member. Create a test member with: node dist/api/src/scripts/testMember.js reset`;
}

// Handles for messages sent to (or received from) a test member.
export const TEST_HANDLE_PREFIX = "test-";
export const isTestHandle = (handle: unknown): boolean => typeof handle === "string" && handle.startsWith(TEST_HANDLE_PREFIX);
export const testHandle = (): string => `${TEST_HANDLE_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
