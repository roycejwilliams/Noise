import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { createAskCheckinTools } from "./tools.js";
import type { CoverageNudgeProfile } from "../services/profileExtraction.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";

export type AskCheckinRow = {
  id: string;
  ask_text: string;
  checkin_count: number;
  user_id: string;
  first_name: string;
  phone_number: string;
  has_matches: boolean;
  life_chapters: string[] | null;
  goals: string[] | null;
  blockers: string[] | null;
  long_term_direction: string | null;
  city: string | null;
  topics_covered: Record<string, string> | null;
  topics_asked: Record<string, string> | null;
};

// Co Loop Stage 5, agentized: replaces the hardcoded escalation/topic-nudge
// branching that used to live in jobs/index.ts with a tool-calling loop that
// decides for itself — the cron still owns *when* a row is due (cadence is
// plumbing, not judgment), this owns *what to do about it*.
export async function runAskCheckinAgent(
  row: AskCheckinRow,
  opts: { dryRun?: boolean } = {},
): Promise<{ sent: boolean }> {
  const profile: CoverageNudgeProfile = {
    life_chapters: row.life_chapters,
    goals: row.goals,
    blockers: row.blockers,
    long_term_direction: row.long_term_direction,
    city: row.city,
    topics_covered: row.topics_covered,
    topics_asked: row.topics_asked,
  };

  const { tools, state } = createAskCheckinTools({
    userId: row.user_id,
    phoneNumber: row.phone_number,
    profile,
    dryRun: opts.dryRun ?? false,
  });

  const system = `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're following up on something ${row.first_name} told you about a while back: "${row.ask_text}"

Context:
- Co has checked in on this ${row.checkin_count} time(s) before with no resolution yet.
- ${row.has_matches ? "Co has some open leads for this, but nothing to introduce yet — don't imply anything is imminent." : "Co hasn't found a strong match for this yet. It's fine to say so honestly (e.g. \"still keeping an eye out\") — don't imply anything is imminent either way."}

Decide what to do, then act using your tools:
- If this still deserves a check-in right now, draft a short message (1-3 sentences, no em dashes, no exclamation points — calm and unhurried, like a private members club, not a survey) and send it with sendSms. The check-in question about their ask always comes first and matters most.
- If Co has already checked in multiple times with no resolution, consider asking whether this is still actually a priority for them, and give them an easy way to say "stop asking about this" — rather than just re-asking the same way again. Use your judgment on when this applies; there's no fixed threshold.
- Only when it's NOT an escalation: you may call checkTopicGap to see if there's a rapport topic worth gently working in. Only fold it in if it fits naturally after the check-in question — never force it, and never let it dilute an escalation message.
- If a check-in doesn't actually make sense for this person right now, it's fine to decide not to send anything this cycle — just skip sendSms.
- If you used a suggested topic in the message you sent, call markTopicAsked with that topic.
- Always finish by calling writeMemory once, with a short factual note of what you did (or why you skipped).`;

  await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system,
    prompt: "Decide what to do about this check-in and act.",
    tools,
    stopWhen: stepCountIs(6),
    experimental_telemetry: { isEnabled: true, functionId: "agent.askCheckin" },
  });

  return { sent: state.sent };
}
