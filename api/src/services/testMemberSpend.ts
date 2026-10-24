// Test members don't spend on paid search (cost per member, Phase C1, 2026-10-23). In the 14 days to 10-18, two thirds of the task
// web search spend came from test members: 555-01xx numbers, simulated members and archived test accounts. The paid paths (the
// sweep's search loop, task web searches, official-page lookups, Exa, X and the web search budget) now skip them, gated on the
// fact (who the member is), not on a switch.
//
// One exception: the clean live-test member (scripts/testMember.ts: the newest unarchived +1 415 555-01xx account with the email
// each `testMember.js reset` writes) keeps every search, so a deliberate live test still runs the real path. Real members and team accounts are
// never skipped, and a lookup that fails never skips (it can't tell, so it spends as before).
import { isTestNumber, LIVE_TEST_CANDIDATES_SQL, pickLiveTestMember } from "./testNumbers.js";

export type MemberFacts = { phone_number: string | null; archived_phone: string | null; archived_at: Date | string | null; live_test_id: string | null };
export type FactsLookup = (userId: string) => Promise<MemberFacts | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The rule, pure: a test member (a 555-01xx number now or before archiving, or an archived account) skips, unless it is the current
// live-test member.
export function skipsForFacts(userId: string, f: MemberFacts | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!f) return false;
  const test = isTestNumber(f.phone_number, env) || isTestNumber(f.archived_phone, env) || !!f.archived_at;
  if (!test) return false;
  return !(f.live_test_id && f.live_test_id === userId && !f.archived_at);
}

const realLookup: FactsLookup = async (userId) => {
  const { default: pool } = await import("../db/db.js");
  const [{ rows }, live] = await Promise.all([
    pool.query(`SELECT phone_number, archived_phone, archived_at FROM users WHERE id = $1`, [userId]),
    pool.query(LIVE_TEST_CANDIDATES_SQL),
  ]);
  return rows[0] ? { ...rows[0], live_test_id: pickLiveTestMember(live.rows)?.id ?? null } : null;
};
let lookup: FactsLookup = realLookup;
export function setTestMemberLookupForTests(fn: FactsLookup | null): void {
  lookup = fn ?? realLookup;
  cache.clear();
}

// Read at most every 10 minutes per member (a reset makes a new live-test member; it is picked up within that).
const cache = new Map<string, { skip: boolean; at: number }>();
const TTL_MS = 10 * 60_000;

// True when this member's paid search should be skipped; logs one line (an 8-character id prefix only) each time it is.
export async function skipsPaidSearch(userId: string | null | undefined, path: string): Promise<boolean> {
  if (!userId || !UUID.test(userId)) return false;
  const now = Date.now();
  let hit = cache.get(userId);
  if (!hit || now - hit.at > TTL_MS) {
    const facts = await lookup(userId).catch((err: any) => {
      console.error(`testMemberSpend: member lookup failed, searching as usual (non-fatal): ${err?.message ?? err}`);
      return undefined;
    });
    if (facts === undefined) return false;
    hit = { skip: skipsForFacts(userId, facts), at: now };
    if (cache.size > 2000) cache.clear();
    cache.set(userId, hit);
  }
  if (hit.skip) console.log(`paid search skipped: test member ${userId.slice(0, 8)} (${path})`);
  return hit.skip;
}
