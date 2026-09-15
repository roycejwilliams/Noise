// Layer 8 eval: the call gate and missed-call follow-ups (src/harness/callGate.ts).
// Pure code, no model.
//
//   npx tsx evals/voice/run.ts [--only v03,m02]
//
// Hard failures: a call placed without authorization, into a live call, to
// someone opted out, at night for a call Co started itself, or right after
// another call; a real, authorized call blocked by a stale status; a second
// missed-call text for the same call or within a day.
import { dirname } from "path";
import { fileURLToPath } from "url";
import { loadCases, runEval, type CaseScore, type EvalCase } from "../lib.js";
import {
  decideCall,
  decideMissedCallFollowUp,
  type CallAuthorization,
  type CallDecision,
  type CallState,
} from "../../src/harness/callGate.js";

const NOW = new Date("2026-09-14T18:00:00Z");
const minsAgo = (m: number | null) => (m === null ? null : new Date(NOW.getTime() - m * 60000));

type CallCase = EvalCase & {
  kind: "call";
  auth: CallAuthorization | null;
  state: Omit<CallState, "callStatusUpdatedAt" | "lastCallAt"> & { statusMinsAgo: number | null; lastCallMinsAgo: number | null };
  expect: { allowed: boolean };
};
type MissedCase = EvalCase & {
  kind: "missed";
  state: { alreadyHandledThisCall: boolean; pendingQueued: boolean; lastFollowUpMinsAgo: number | null };
  expect: { send: boolean };
};
type Case = CallCase | MissedCase;

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const onlyIdx = args.indexOf("--only");
const only = onlyIdx === -1 ? undefined : args[onlyIdx + 1]?.split(",");

async function run(c: Case): Promise<{ call?: CallDecision; send?: boolean }> {
  if (c.kind === "missed") {
    return {
      send: decideMissedCallFollowUp(
        {
          alreadyHandledThisCall: c.state.alreadyHandledThisCall,
          pendingQueued: c.state.pendingQueued,
          lastMissedFollowUpAt: minsAgo(c.state.lastFollowUpMinsAgo),
        },
        NOW,
      ).send,
    };
  }
  const { statusMinsAgo, lastCallMinsAgo, ...rest } = c.state;
  return { call: decideCall({ ...rest, callStatusUpdatedAt: minsAgo(statusMinsAgo), lastCallAt: minsAgo(lastCallMinsAgo) }, c.auth, NOW) };
}

function score(c: Case, r: Awaited<ReturnType<typeof run>>): CaseScore {
  const hard: string[] = [];
  if (c.kind === "missed") {
    if (r.send && !c.expect.send) hard.push("sent another missed-call text");
    return { hard, soft: [{ name: "missed_send", ok: r.send === c.expect.send }] };
  }
  const d = r.call!;
  const why = d.checks.filter((x) => !x.pass).map((x) => x.reason ?? x.name).join("; ");
  if (d.allowed && !c.expect.allowed) hard.push(`placed a call it shouldn't (${d.authorization ?? "no auth"})`);
  if (!d.allowed && c.expect.allowed) hard.push(`blocked a call that should go through: ${why}`);
  return { hard, soft: [{ name: "call_allowed", ok: d.allowed === c.expect.allowed }] };
}

const cases = loadCases<Case>(dir);
await runEval({ name: "voice", dir, cases, run, score, only });
