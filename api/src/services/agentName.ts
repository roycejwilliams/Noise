// The agent's name and the company's (Royce, 2026-10-14: "Rename the agent to Cue and the company to Noise"). Code names, file
// names and tables keep "co" (co_facts, coTasks, co_memories): only what a member sees or a model reads says Cue.
export const AGENT_NAME = "Cue";
export const OLD_AGENT_NAME = "Co";

// Members will keep calling it Co from habit for a while: until this day ends (Pacific), "hey co" is answered as Cue, and anything
// that listens for its name (the call's speech keywords) listens for both. A proposal pending Royce's confirmation.
export const CO_ALIAS_UNTIL = "2027-01-31";
const ALIAS_ENDS = Date.parse(`${CO_ALIAS_UNTIL}T23:59:59-08:00`);
export function coAliasActive(now: Date = new Date()): boolean {
  return now.getTime() <= ALIAS_ENDS;
}
// The names a member may call it by right now, lowercase.
export function addressNames(now: Date = new Date()): string[] {
  return coAliasActive(now) ? ["cue", "co"] : ["cue"];
}
