// Jev in shadow (Royce, 2026-09-28: "Couldn't we use jev to start labeling
// what function it needs to go to?"). Jev labels every text alongside the one
// Sonnet read (services/readTurn.ts): what they're doing and what it needs.
// Nothing here touches the reply; both reads are logged side by side
// (jev.shadow.turn) so a few days of real texts show where Jev agrees closely
// enough to take over cheap cases (a "thanks!" skipping the Sonnet read).
// Member text goes to Jev only through the zero-retention gateway, and only
// when JEV_MEMBER=on (services/jevGateway.ts).
import { recordDecision } from "../harness/core.js";
import { askJevZdr, jevForMemberText, type JevBool } from "./jevGateway.js";
import type { TurnRead } from "./readTurn.js";

// One request, every label (the gateway rate-limits requests, not questions).
export const JEV_TURN_QUESTIONS: Record<string, JevBool> = {
  small_talk: { type: "boolean", instructions: "Is `latest_message` only small talk that closes or acknowledges (thanks, ok, cool, a laugh, a sign-off), needing nothing back?" },
  logistics: { type: "boolean", instructions: "Is `latest_message` a question or note about logistics: a time, date, place, address, price, or how to get somewhere?" },
  sharing: { type: "boolean", instructions: "Is `latest_message` them sharing something about their own life, work, or feelings?" },
  reacting: { type: "boolean", instructions: "Is `latest_message` a reaction to something Co sent them (an event, a link, an offer): interested, going, not for them, how it went?" },
  feedback: { type: "boolean", instructions: "Is `latest_message` feedback about how Co itself works, or a request to pass something to the team?" },
  pushback: { type: "boolean", instructions: "Does `latest_message` correct or push back on what Co just said in `co_last_message`?" },
  wants_search: { type: "boolean", instructions: "Is `latest_message` asking Co to find, look for, or recommend events, people, communities, or opportunities now?" },
  wants_call: { type: "boolean", instructions: "Is `latest_message` asking Co for a phone call, now or at a set time?" },
};

export type JevTurnLabels = Record<keyof typeof JEV_TURN_QUESTIONS, number>;

export function startJevShadow(message: string, coLastMessage: string | null, repliedToCo: boolean): Promise<{ labels: JevTurnLabels | null; ms: number }> | null {
  if (!jevForMemberText() || !message.trim()) return null;
  const started = Date.now();
  return askJevZdr({ latest_message: message.slice(0, 1000), co_last_message: (coLastMessage ?? "").slice(0, 600), replied_inline_to_co: repliedToCo }, JEV_TURN_QUESTIONS, 3000)
    .then((labels) => ({ labels: labels as JevTurnLabels | null, ms: Date.now() - started }))
    .catch(() => ({ labels: null, ms: Date.now() - started }));
}

// What the Sonnet read said, in the same terms.
export function readLabels(read: TurnRead): Record<keyof typeof JEV_TURN_QUESTIONS, boolean> {
  const mode = read.moment?.mode;
  return {
    small_talk: mode === "small_talk",
    logistics: mode === "logistics",
    sharing: mode === "sharing",
    reacting: mode === "reacting",
    feedback: read.feedback.length > 0 || mode === "feedback",
    pushback: !!read.moment?.pushback,
    wants_search: !!read.router?.wantsRecommendation,
    wants_call: !!read.router?.call && read.router.call !== "none",
  };
}

// Agreement per label at Jev's confident cutoffs (JEV_SURE-style: yes ≥ 0.8, no ≤ 0.2).
export function compare(jev: JevTurnLabels, read: Record<string, boolean>): Record<string, "agree" | "disagree" | "unsure"> {
  const out: Record<string, "agree" | "disagree" | "unsure"> = {};
  for (const k of Object.keys(JEV_TURN_QUESTIONS)) {
    const p = jev[k as keyof JevTurnLabels];
    if (typeof p !== "number" || (p > 0.2 && p < 0.8)) out[k] = "unsure";
    else out[k] = (p >= 0.8) === !!read[k] ? "agree" : "disagree";
  }
  return out;
}

export function logJevShadow(userId: string, jevP: ReturnType<typeof startJevShadow>, read: TurnRead | null): void {
  if (!jevP || !read) return;
  jevP
    .then(({ labels, ms }) => {
      const sonnet = readLabels(read);
      return recordDecision({
        layer: 2,
        decision: "jev.shadow.turn",
        userId,
        outcome: labels ? "act" : "skip",
        action: labels ? "labeled" : "unavailable",
        proposal: { jev: labels, sonnet, agreement: labels ? compare(labels, sonnet) : null, jevMs: ms, sonnetMs: read.latencyMs },
      });
    })
    .catch(() => {});
}
