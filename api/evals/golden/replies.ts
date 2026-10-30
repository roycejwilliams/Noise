// Every reply a golden case produces passes the hard rules (evals/lib/hardRules.ts), whatever the case itself asserts. The case's reply
// helper (cases/checkins.ts, reply.ts, finds.ts, moments.ts) notes each turn here with what the turn stood on; the runner (run.ts) takes
// the notes after each attempt and fails the case on a hard-rule miss, in replay and live alike. In the quality run (run.ts --quality)
// the same notes are what the model judge grades (evals/lib/replyRubric.ts).
import { hardRuleMisses, type HardRuleInput, type Send, type TurnKind } from "../lib/hardRules.js";

export type NotedReply = HardRuleInput & { message: string; recent: string; hard: string[] };
let noted: NotedReply[] = [];

export function noteReply(i: HardRuleInput & { message: string; recent: string }): string[] {
  // A turn that threw (a replay miss, a timeout) already fails its case; its error text is not a reply to check.
  const hard = /^ERROR /.test(i.text) ? [] : hardRuleMisses(i);
  noted.push({ ...i, hard });
  return hard;
}
// The runner's: what the attempt noted, cleared for the next one.
export function takeReplies(): NotedReply[] {
  const out = noted;
  noted = [];
  return out;
}

// The sends a dry-run reply turn prints (agent/conversationTools.ts sendReply, agent/loopTools.ts say, the fallback), captured in order
// while `fn` runs. Anything else printed passes through.
const SEND_LINE = /^\[conversationReply dryRun\] (would reply to [^:]+: "|would send to [^:]+: |fallback would send to [^:]+: "|would share link (\S+) with )([\s\S]*?)"?$/;
export async function captureSends<T>(fn: () => Promise<T>): Promise<{ value: T; sends: Send[] }> {
  const sends: Send[] = [];
  const log = console.log;
  console.log = (...a: any[]) => {
    const s = a.map(String).join(" ");
    const m = s.match(SEND_LINE);
    if (!m) return log(...a);
    if (m[2]) sends.push({ kind: "link", text: m[2] });
    else sends.push({ kind: m[1].startsWith("would reply") ? "reply" : m[1].startsWith("fallback") ? "fallback" : "find", text: m[3] });
  };
  try {
    return { value: await fn(), sends };
  } finally {
    console.log = log;
  }
}

// The member's lines and Cue's lines of a "User said: / Co replied:" thread.
export function linesOf(recent: string): { theirs: string[]; cue: string[] } {
  const theirs: string[] = [];
  const cue: string[] = [];
  for (const l of recent.split("\n")) {
    const m = l.match(/^(User said|Co replied|Cue replied): ?(.*)$/);
    if (m) (m[1] === "User said" ? theirs : cue).push(m[2]);
  }
  return { theirs, cue };
}

export type { TurnKind };
