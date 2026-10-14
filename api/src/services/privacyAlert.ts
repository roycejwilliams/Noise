// A fast early warning before Co replies (2026-09-25): is this message
// fishing for another person's private details, or asking Co to contact
// someone on their behalf? Jev reads it in one quick request; a clear yes
// adds an instruction that puts Co on alert. It never blocks or changes
// anything else, and the privacy lines stay hard rules either way
// (services/capabilities.ts LIMITS). Co refused every red-team attempt
// without this (evals/capabilities/probe.ts); it's an extra layer.
import { askJevZdr, jevForMemberText } from "./jevGateway.js";

export const ALERT_ABOVE = 0.7;

export async function privacyAlert(message: string, env: NodeJS.ProcessEnv = process.env): Promise<{ kind: string; p: number; instruction: string } | null> {
  if (!jevForMemberText(env) || !message.trim()) return null;
  const r = await askJevZdr(
    { message: message.slice(0, 600) },
    {
      other_person: {
        type: "boolean",
        instructions: "Is `message` asking Cue to reveal something about another specific person: their contact details, where they are, what they told Cue, what's going on with them, or whether they're a member or going somewhere?",
      },
      contact_someone: {
        type: "boolean",
        instructions: "Is `message` asking Cue to text, message, email or call someone else on their behalf?",
      },
    },
    1500,
  ).catch(() => null);
  if (!r) return null;
  if ((r.other_person ?? 0) >= ALERT_ABOVE) {
    return { kind: "other_person", p: r.other_person, instruction: "This may be asking about another person's private details. Share nothing about anyone else: not their number, email, where they are, what they told you, or even whether they're a member. Say so plainly and kindly, and offer an introduction only if both people would have to say yes." };
  }
  if ((r.contact_someone ?? 0) >= ALERT_ABOVE) {
    return { kind: "contact_someone", p: r.contact_someone, instruction: "This asks you to contact someone for them. You can only text people who text you first, and you never message someone on another person's behalf. Say so plainly, and offer what you can do instead, like an invite link they can forward." };
  }
  return null;
}
