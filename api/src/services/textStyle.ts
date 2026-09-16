// Capitalization enforced in code, not left to the prompt (2026-09-15).
// Replies were going out lowercase ("hey! good to hear from you. so, ...")
// because the model copied Co's own earlier lowercase texts in the thread.
// Since 2026-09-16 Co always writes in sentence case, whatever the person's
// own style: services/sendblue.ts cleanCoMessage applies this to every
// message on its way out. textsInLowercase is kept only for reading style
// hints, never for casing.

// Uppercases the first letter of the message and of each sentence. Leaves
// links, handles, and words with their own internal capitals ("iPhone")
// alone.
export function capitalizeSentences(text: string): string {
  return text.replace(/(^|[.!?]\s+|\n\s*)([a-z][^\s.!?]*)/g, (whole, lead: string, word: string, offset: number, str: string) => {
    const token = str.slice(offset + lead.length).split(/\s/)[0];
    if (/^(https?:|www\.|@)/i.test(token) || /[A-Z]/.test(word.slice(1))) return whole;
    return lead + word[0].toUpperCase() + word.slice(1);
  });
}

// True when the person's own recent texts are mostly all-lowercase,
// including their latest one (a switch to capitals wins right away). One
// text isn't enough to call it a style.
export function textsInLowercase(userLines: string[]): boolean {
  const lines = userLines.map((l) => l.trim()).filter((l) => /[a-z]/i.test(l)).slice(-4);
  if (lines.length < 2) return false;
  const isLower = (l: string) => l === l.toLowerCase();
  if (!isLower(lines[lines.length - 1])) return false;
  return lines.filter(isLower).length / lines.length >= 0.6;
}

// "User said: ..." lines from a recent-conversation block, plus the message
// being answered.
export function userLinesFrom(recentConversation: string, latestMessage?: string): string[] {
  const lines = recentConversation
    .split("\n")
    .filter((l) => l.startsWith("User said: "))
    .map((l) => l.replace(/^User said: /, ""));
  if (latestMessage && lines[lines.length - 1] !== latestMessage) lines.push(latestMessage);
  return lines;
}
