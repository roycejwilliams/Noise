// Layer 1 eval: identity intake gate + OTP attempts (src/harness/intake.ts).
//
//   npx tsx evals/intake/run.ts                 # code gates only (no model)
//   npx tsx evals/intake/run.ts --live          # also run the real Haiku extraction on `message` cases
//   npx tsx evals/intake/run.ts --only i03,o02
//
// Hard failures: writing the wrong identity (a wrong or taken email, a name
// they never gave), re-asking for a field already on file, repeating Co's
// last line word for word, looping past the retry cap without explaining,
// alerting the team twice for one lock, or accepting an expired code.
import "dotenv/config";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { loadCases, runEval, type CaseScore, type EvalCase } from "../lib.js";
import {
  INTAKE_EXTRACT_MODEL,
  buildIntakeExtractionPrompt,
  decideIntake,
  decideOtpAttempt,
  isValidEmail,
  parseIntakeProposal,
  type IntakeDecision,
  type IntakeProposal,
  type IntakeState,
  type OtpDecision,
} from "../../src/harness/intake.js";
// --live makes real model calls: only through the meter (evals/README.md).
if (process.argv.includes("--live")) await import("../lib/requireMeter.js");

type IntakeCase = EvalCase & {
  kind: "intake";
  state: Omit<IntakeState, "userId">;
  message?: string;
  proposal?: IntakeProposal;
  emailTaken?: boolean;
  expect: { action: "capture" | "ask"; name?: string; email?: string; mustNotAskFor?: ("name" | "email")[]; explain?: boolean };
};
type OtpCase = EvalCase & {
  kind: "otp";
  state: { storedCode: string | null; expiresInSec: number | null; attempts: number; locked: boolean; lockedAgoMin: number | null };
  submitted: string;
  expect: { result: OtpDecision["result"]; alertTeam: boolean };
};
type Case = IntakeCase | OtpCase;

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const live = args.includes("--live");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx === -1 ? undefined : args[onlyIdx + 1]?.split(",");

async function run(c: Case): Promise<{ intake?: IntakeDecision; proposal?: IntakeProposal; otp?: OtpDecision }> {
  if (c.kind === "otp") {
    const now = new Date("2026-09-14T12:00:00Z");
    return {
      otp: decideOtpAttempt(
        {
          storedCode: c.state.storedCode,
          expiresAt: c.state.expiresInSec === null ? null : new Date(now.getTime() + c.state.expiresInSec * 1000),
          attempts: c.state.attempts,
          locked: c.state.locked,
          lockedAt: c.state.lockedAgoMin === null ? null : new Date(now.getTime() - c.state.lockedAgoMin * 60000),
        },
        c.submitted,
        now,
      ),
    };
  }
  let proposal = c.proposal ?? { full_name: null, email: null };
  if (live && c.message !== undefined) {
    const { text } = await generateText({ model: anthropic(INTAKE_EXTRACT_MODEL), prompt: buildIntakeExtractionPrompt(c.state, c.message) });
    proposal = parseIntakeProposal(text);
  } else if (!c.proposal) {
    throw new Error("case has no proposal; run with --live");
  }
  const emailTaken = !!c.emailTaken && isValidEmail(proposal.email);
  return {
    proposal,
    intake: decideIntake({ userId: "eval", ...c.state }, proposal, {
      emailTakenByOtherAccount: emailTaken,
      seed: 0.5,
      replyText: c.message ?? null,
    }),
  };
}

function score(c: Case, r: Awaited<ReturnType<typeof run>>): CaseScore {
  const hard: string[] = [];
  const soft: { name: string; ok: boolean }[] = [];
  if (c.kind === "otp") {
    const d = r.otp!;
    if (d.result === "verified" && c.expect.result !== "verified") hard.push(`accepted a code it shouldn't (${c.expect.result})`);
    if (d.alertTeam && !c.expect.alertTeam) hard.push("alerted the team when this attempt didn't cause a lock");
    if (!d.alertTeam && c.expect.alertTeam) hard.push("didn't alert the team on the attempt that locked");
    soft.push({ name: "otp_result", ok: d.result === c.expect.result });
    return { hard, soft };
  }
  const d = r.intake!;
  const e = c.expect;
  if (d.action === "capture") {
    if (e.action !== "capture") hard.push(`captured identity (${d.name} / ${d.email}) when it should ask`);
    if (e.email && d.email?.toLowerCase() !== e.email.toLowerCase()) hard.push(`wrote email ${d.email}, expected ${e.email}`);
    if (e.name && d.name !== e.name) soft.push({ name: "captured_name_exact", ok: false });
    if (c.emailTaken && d.email?.toLowerCase() === (r.proposal?.email ?? "").toLowerCase()) hard.push("wrote an email that belongs to another account");
  } else {
    if (e.action === "capture") soft.push({ name: "missed_capture", ok: false });
    for (const f of e.mustNotAskFor ?? []) if (d.missing.includes(f)) hard.push(`re-asked for ${f}, which is already on file`);
    if (d.reply && d.reply === c.state.lastCoLine) hard.push("repeated Cue's last line word for word");
    const explains = /\b(only use|how I|reason I'm asking|is how)\b/i.test(d.reply ?? "");
    if (e.explain && !explains) hard.push("past the retry cap but still asking the same way");
    if (e.explain === false && explains) soft.push({ name: "explained_too_early", ok: false });
    if (d.savePartialEmail && e.email && d.savePartialEmail.toLowerCase() !== e.email.toLowerCase()) hard.push(`held the wrong partial email ${d.savePartialEmail}`);
    if (e.email && !d.savePartialEmail && !c.state.partialEmail && !c.state.knownEmail && !c.emailTaken) hard.push("dropped a valid email they sent");
  }
  soft.push({ name: "action", ok: d.action === e.action });
  return { hard, soft };
}

const cases = loadCases<Case>(dir);
await runEval({ name: `intake${live ? " (live extraction)" : ""}`, dir, cases, run, score, only, concurrency: 4 });
