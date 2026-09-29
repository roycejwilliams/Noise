// What a member says to a teammate agent (Mo) is not a statement about their
// life (2026-09-29: Royce's texts to Mo, logged as "User said: … [to Mo]", were
// read by the person snapshot as facts, and it wrote that he was building Co
// "with cofounders Mo and Jacqueline"; Co then asked which of them to talk to
// about equity). The learning reads skip those lines.
//
// Logged by routes/sendblue.ts as "User said: <text> [to Mo]"; Mo's own texts
// are "Mo replied: …" and Co's tag is "Co tagged Mo: …".

// SQL: true for a member's line that was not addressed to a teammate. Pass the
// table alias ("m") when the column needs one.
export function notToTeammate(alias = ""): string {
  const col = alias ? `${alias}.content` : "content";
  return String.raw`${col} !~ ' \[to [A-Za-z]+\]$'`;
}

// Text: drops the lines that belong to the member's talk with a teammate:
// what they said to it, its replies, and Co's tag.
const isTeammateLine = (l: string) =>
  / \[to [A-Za-z]+\]\s*$/.test(l) || /^Co tagged \w+:/.test(l) || (/^\w+ replied:/.test(l) && !/^Co replied:/.test(l));
export function withoutTeammateLines(text: string): string {
  return text.split("\n").filter((l) => !isTeammateLine(l)).join("\n");
}
