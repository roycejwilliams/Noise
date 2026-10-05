// What a member actually waited in a turn, from what was logged as sent
// (2026-09-27: search turns logged no first-text time, because the hold
// line and results go out before the reply step). Pure, so evals can use it.

// ms to the first text of any kind, and to the first real answer (anything
// that isn't a hold line).
export function firstSendTimes(sent: { text: string; at: Date }[], inboundAt: Date, holdLines: string[]): { firstSentMs: number | null; firstAnswerMs: number | null } {
  const sorted = [...sent].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = sorted[0];
  const answer = sorted.find((x) => !holdLines.includes(x.text.trim()));
  const ms = (x?: { at: Date }) => (x ? Math.max(0, x.at.getTime() - inboundAt.getTime()) : null);
  return { firstSentMs: ms(first), firstAnswerMs: ms(answer) };
}
