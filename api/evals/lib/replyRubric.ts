// The model judge's rubric for a reply (Royce, 2026-10-29: the grader still rewarded short replies and at most one question, against
// the share and feedback guidance #310 shipped). One rubric, read by the golden quality run (evals/golden/run.ts --quality, three runs
// a case, majority) and the texting eval (evals/texting/grade.ts, pairwise.ts). It grades what a model has to: depth, tone, whether
// Cue added something. The lines Cue never crosses (invented facts, status lines, stock phrases, machinery talk, quoting itself) are
// code's, in evals/lib/hardRules.ts, free and on every run; the "honest" criterion here is the judge's second look at the same.
//
// The criteria follow the turn: a share or feedback turn has no length cap and may ask questions that build on each other (services/
// connectDots.ts SHARING_GUIDE, FEEDBACK_GUIDE); a check-in is presence plus one item of their world or an open question, no status; every
// other turn keeps the general length and one-question rules (agent/conversationReply.ts lengthLineFor).
import type { TurnKind } from "./hardRules.js";

export type Verdict = "pass" | "fail" | "na";
type Criterion = { text: string; applies?: readonly TurnKind[] };

export const RUBRIC = {
  specific: { text: "Specific to this person and this conversation, not a line that could be sent to anyone." },
  depth_fit: {
    text: "The depth fits the moment. On a share or feedback turn: matched to what they shared, with no length cap; a heavy or layered share gets real room, and a moment that's complete (good news landed, a sign-off) gets a short warm line and nothing pulled out of them. On a check-in, small talk or a short casual message that asks for nothing: one or two sentences. When they asked for depth (a plan, advice, a walkthrough), the whole answer in this reply.",
  },
  questions: {
    text: "Questions fit the moment. On a share or feedback turn, several questions are fine when they are one continuous thought, each building on the last; fail a questionnaire of unrelated questions, a question forced onto a complete moment, or re-asking what they already answered. On every other turn, at most one question, and never one they skipped or moved past.",
  },
  contributes: {
    text: "Adds something of its own (a specific reaction, an observation, a small opinion, a question that moves it forward) instead of mirroring: it does not open by restating what they said, hand their words back, or quote its own earlier line.",
  },
  one_idea_per_paragraph: { text: "Each paragraph carries one idea; no wall of text mixing several." },
  real_position: {
    text: "When giving advice or an opinion, takes a real position (picks one, says why) instead of hedging or listing options. Mark na if the reply gives no advice or opinion.",
  },
  honest: {
    text: "Never invents: no detail the member, the conversation or what Cue knew didn't give (don't fill in what they did, where they went, or why they feel it), no promise of work it won't do, no pretending.",
  },
  checkin_presence: {
    text: "A check-in gets presence plus ONE item of their world (something waiting on them, a running search, a live thread) or an open question when nothing waits; never a status report, a rundown of several things, or a line about Cue's own state ('nothing running', 'nothing new on my end'). Late at night, care first and no business.",
    applies: ["checkin"],
  },
  feedback_owned: {
    text: "Feedback about how Cue comes across is owned in a few words at most, then shown: the reply their earlier message deserved, with something of Cue's own in it. Fail an explanation of its tone or how it works, a long apology, or asking them to say it again.",
    applies: ["feedback"],
  },
} as const satisfies Record<string, Criterion>;
export type RubricKey = keyof typeof RUBRIC;
export type RubricGrade = Partial<Record<RubricKey, Verdict>> & { notes: string };

export const criteriaFor = (kind: TurnKind | null | undefined): RubricKey[] =>
  (Object.keys(RUBRIC) as RubricKey[]).filter((k) => {
    const c: Criterion = RUBRIC[k];
    return !c.applies || (kind != null && c.applies.includes(kind));
  });

const KIND_WORDS: Record<TurnKind, string> = {
  checkin: "a check-in (they're saying hi or checking in)",
  share: "a share (they're telling Cue about their life)",
  feedback: "feedback about how Cue is coming across",
  find: "a request for finds (events, places, things to do)",
  reply: "an ordinary turn",
};

export function rubricPrompt(t: { kind: TurnKind | null; message: string; recent: string; known?: string; firstName?: string }, reply: string): string {
  const keys = criteriaFor(t.kind);
  return `You're grading one text message from Cue, an AI companion that texts members of a private club over iMessage. Grade only the reply below, against each criterion. Be strict and consistent; a pass should read like a thoughtful real person texting on a phone.
${t.firstName ? `\nTheir first name is ${t.firstName}.\n` : ""}
What Cue knew before this reply (a fact from here is not invented):
${(t.known ?? "").slice(0, 4000) || "(nothing)"}

The conversation so far (oldest first):
${t.recent.slice(-3000) || "(none)"}

What they just sent${t.kind ? `, ${KIND_WORDS[t.kind]}` : ""}:
"${t.message}"

Cue's reply:
"${reply}"

Criteria:
${keys.map((k) => `- ${k}: ${RUBRIC[k].text}`).join("\n")}

Return ONLY JSON: {${keys.map((k) => `"${k}": "pass"|"fail"${k === "real_position" ? '|"na"' : ""}`).join(", ")}, "notes": "one short sentence on the biggest problem, or empty"}`;
}

// A grade is complete when every criterion for the turn has a verdict.
export const completeGrade = (g: any, kind: TurnKind | null): g is RubricGrade => !!g && criteriaFor(kind).every((k) => ["pass", "fail", "na"].includes(g[k]));
export const failedCriteria = (g: RubricGrade): RubricKey[] => (Object.keys(RUBRIC) as RubricKey[]).filter((k) => g[k] === "fail");

// The judge call itself (Sonnet, as the grader: GRADER_HEADERS). Two tries; a grade that never parses is a failure, never a pass.
export async function gradeReply(t: Parameters<typeof rubricPrompt>[0], reply: string): Promise<RubricGrade | null> {
  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { GRADER_MODEL, GRADER_HEADERS } = await import("../../src/models.js");
  const { parseModelJson } = await import("../../src/services/modelJson.js");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await generateText({ model: anthropic(GRADER_MODEL), headers: GRADER_HEADERS, maxOutputTokens: 600, prompt: rubricPrompt(t, reply) });
      const g = parseModelJson<RubricGrade>(text);
      if (completeGrade(g, t.kind)) return g;
    } catch {}
  }
  return null;
}
