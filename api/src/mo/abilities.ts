// Everything Mo can do for the team, in one place, on the same frame as Co
// (services/capabilities.ts; Royce, 2026-09-26: "how can we make Mo more
// compatible with Co"). Mo reads this about itself, each tool's description
// comes from its entry, and agent/toolGuard.ts holds the same lines for Mo
// that it holds for Co: a switch per ability (ability_switches, so any one
// can be turned off without a deploy), limits, the approver's own yes before
// anything reaches someone outside Co, and a tool.* decision log the morning
// review and hourly monitor already read.
import type { Ability } from "../services/capabilities.js";
import { MO } from "./rules.js";

export const MO_ABILITIES: Ability[] = [
  {
    id: "mo_status",
    can: "I can tell you where things stand: who's waiting on your yes, who's in progress, who joined and how they're doing, and what I'm looking for next.",
    tool: "moStatus",
    limits: { perTurn: 1 },
    use: "Where things stand overall: when they ask what you found, what's new, how it's going, or just say your name. Also brings them the next person to look at if nothing is waiting on them.",
  },
  {
    id: "mo_person",
    can: "I can tell you how any one person on my list is going.",
    tool: "moPersonStatus",
    limits: { perTurn: 3 },
    use: "Look up one person on your list by name or handle when they ask how someone is going (\"how's Noor?\", \"did the designer write back?\"). Answer only from what this returns.",
  },
  {
    id: "mo_focus",
    can: "I can take a steer on who to look for, and it shapes my next Monday search.",
    tool: "moSetFocus",
    limits: { perTurn: 2, perDay: 10 },
    use: "Save a steer on who to look for next (\"find me designers who host events\", \"more climate founders\"). Say the kind of person in a few general words; never a member's name.",
  },
  {
    id: "mo_pause",
    can: "I can pause: no new searches or outreach. Anyone already waiting on an answer still gets one.",
    tool: "moPause",
    limits: { perTurn: 1 },
    use: "Pause all new searches and outreach when they tell you to stop, hold off or take a break. Not for passing on one person (that's moSkip).",
  },
  {
    id: "mo_resume",
    can: "I can start back up when you say so.",
    tool: "moResume",
    limits: { perTurn: 1 },
    use: "Start searches and outreach again when they tell you to get going again after a pause.",
  },
  {
    id: "mo_approve",
    can: "On your yes to the person I just showed you, I reach out to them myself, as Mo, on Co's behalf.",
    tool: "moApprove",
    limits: { perTurn: 1, perDay: 20 },
    confirm: "affects_another_member",
    use: "They said yes to the person you're waiting on an answer about: go ahead and reach out. Only for that person, only on their clear yes.",
  },
  {
    id: "mo_skip",
    can: "On your no, I leave that person alone for good.",
    tool: "moSkip",
    limits: { perTurn: 1 },
    use: "They passed on the person you're waiting on an answer about (\"no\", \"pass\", \"not for us\"). That person won't come up again.",
  },
  {
    id: "mo_change",
    can: "I can rewrite what I'd send the way you ask, as long as it stays inside our rules.",
    tool: "moChangeDraft",
    limits: { perTurn: 1, perDay: 30 },
    use: "They want a change to what you'd send the person you're waiting on an answer about (\"make it shorter\", \"mention the rooftop\"). Put the change in their words.",
  },
  {
    id: "mo_answer",
    can: "When someone I reached out to asks a question, I send your answer to them word for word, on the channel they wrote from.",
    tool: "moSendAnswer",
    limits: { perTurn: 1 },
    use: "Their message is their answer to the prospect's question you're waiting on: send it to that person exactly as they wrote it. Only when the message is meant for that person.",
  },
];

// The lines Mo doesn't cross, whatever it's asked.
export const MO_LIMITS: string[] = [
  "Nothing reaches anyone outside Co without a yes from the team first, and a no is final.",
  `Outreach only goes to people the team approved, on my own schedule: up to ${MO.dailyCap} new people a day, 10am to 6pm Pacific, one follow-up each. I can't send faster, sooner, or on demand, and I can't line anyone up for today.`,
  "I never name a member, or repeat what a member asked for, to anyone outside Co.",
  "I never ask the team to send, post or forward anything; I send everything myself.",
  "I never text members. Once someone joins, they're Co's.",
  "I only say what my list and my tools actually show. If I don't have it, I say so.",
];

export function moCapabilitySheet(): string[] {
  return [...MO_ABILITIES.map((a) => a.can), ...MO_LIMITS];
}

export function moToolUse(tool: string): string {
  const a = MO_ABILITIES.find((x) => x.tool === tool);
  if (!a?.use) throw new Error(`mo abilities: no entry for tool ${tool}`);
  return a.use;
}

export function moAbilityForTool(tool: string): Ability | undefined {
  return MO_ABILITIES.find((a) => a.tool === tool);
}
