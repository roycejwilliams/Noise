// Every refusal a file checker makes is logged with a short reason (Royce, 2026-10-18: "log a short reason for every refusal, so I can
// tell a right refusal from a wrong one without replaying anything"). One row in harness_decisions per refusal: the checker as the
// decision, outcome skip, action "refused", the reason a single line naming each refused line and what was missing (the checkers'
// own problem lines already say both), the problems in full, and what the checker had on file for them (whether it saw their name,
// how many goals; never the goals themselves).
import type { HarnessDecision, Layer } from "../harness/core.js";
import { recordSeen, type MemberRecord } from "./memberRecord.js";

export const REASON_CHARS = 600;

// Pure: the one-line reason. Each problem is already "<the line> ... <what's missing>"; joined, one line, capped.
export function refusalReason(problems: string[]): string {
  const ps = problems.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!ps.length) return "refused (no reason given)";
  const line = `${ps.length === 1 ? "1 problem" : `${ps.length} problems`}: ${ps.map((p) => p.slice(0, 200)).join(" | ")}`;
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 3)}...` : line;
}

// Pure: the row.
export function refusalRow(o: { checker: string; userId: string; problems: string[]; layer?: Layer; member?: MemberRecord | null; extra?: Record<string, unknown> }): HarnessDecision {
  return {
    layer: o.layer ?? 3,
    decision: o.checker,
    userId: o.userId,
    outcome: "skip",
    action: "refused",
    reason: refusalReason(o.problems),
    proposal: { problems: o.problems.slice(0, 7).map((p) => p.slice(0, 300)), saw: recordSeen(o.member), ...(o.extra ?? {}) },
  };
}

// Logged, never thrown: a refusal is still a refusal when its log row can't be written.
export async function logRefusal(o: Parameters<typeof refusalRow>[0], log?: (d: HarnessDecision) => Promise<unknown>): Promise<void> {
  try {
    const write = log ?? (await import("../harness/core.js")).recordDecision;
    await write(refusalRow(o));
  } catch (err: any) {
    console.error(`logRefusal(${o.checker}) failed (non-fatal):`, err?.message ?? err);
  }
}
