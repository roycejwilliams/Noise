// What the checkers know about the member whose file it is (A+H, Royce 2026-10-18: "the checkers see my goals and name. The judge
// needs my goals as context for checking facts, so lines like 'partnering with Sequin AI' and 'Bootstrapped, pre-seed' can pass. A
// name from a goal still doesn't clear a name check. Third-party claims stay refused. Put the name and goals first in what the judge
// reads, since it only reads the first 6,000 characters.").
//
// One record, read from the member's own rows only: their name (users.first_name, last_name) and their active goals on file, through
// the one member-knowledge layer (services/memberKnowledge.ts), so a goal naming another member comes stripped the way every reader
// gets it. No company field exists on the record (users, co_profiles), so none is added: their own company counts when their words
// name it.
//
// Two uses, never mixed:
//   - the judges (coPages/deckClaims.ts, documentClaims.ts) read memberHeader FIRST, then their words: name and goals as context;
//   - the code checks (coPages/grounding.ts, documentSheet.ts) read withOwnName: their own FIRST NAME only, never a goal or a last
//     name (ruling iii: "the code may clear a missing name only for the member's own first name"). A name that is only in a goal is
//     still a name they never gave, as far as code is concerned.
// Pure parts first; the loader imports member knowledge and the database only when it runs, so the code checks that import this
// stay pure.
import type { KnowledgeDeps, MemberKnowledge } from "./memberKnowledge.js";

export type MemberRecord = { firstName: string | null; lastName: string | null; goals: string[] };

// The header never crowds out their words: at most 1,200 characters (a fifth of the deck judge's 6,000), six goals, 200 characters
// a goal. A goal cut short says so ("...").
export const HEADER_LIMITS = { chars: 1200, goals: 6, goalChars: 200 } as const;
export const HEADER_TITLE = "On file for them (their own record, from what they told Cue):";

const oneLine = (s: string) => s.replace(/\s+/g, " ").replace(/"/g, "'").trim();
const cut = (s: string, n: number) => {
  if (s.length <= n) return s;
  const at = s.slice(0, n - 3).replace(/\s+\S*$/, "");
  return `${at || s.slice(0, n - 3)}...`;
};

// Pure: the header, or "" when there's nothing on file. Name first, then goals as aims, in their own wording.
export function memberHeader(r: MemberRecord | null | undefined): string {
  if (!r) return "";
  const name = [r.firstName, r.lastName].map((x) => oneLine(x ?? "")).filter(Boolean).join(" ").slice(0, 120);
  const lines: string[] = [HEADER_TITLE];
  if (name) lines.push(`- Their name: ${name}`);
  const goals = [...new Set(r.goals.map((g) => oneLine(g)).filter(Boolean))];
  if (goals.length) {
    lines.push("- Their goals (aims they are working toward, not things already done):");
    let used = lines.join("\n").length;
    let n = 0;
    for (const g of goals) {
      if (n >= HEADER_LIMITS.goals) break;
      const line = `  - "${cut(g, HEADER_LIMITS.goalChars)}"`;
      if (used + 1 + line.length > HEADER_LIMITS.chars) break;
      lines.push(line);
      used += 1 + line.length;
      n++;
    }
    if (!n) lines.pop();
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// Pure: what a judge reads as their words, header first. The header is capped (HEADER_LIMITS), so it always lands inside the judge's
// window and their words keep the rest.
export const headerFirst = (header: string, words: string) => (header ? `${header}\n\n${words}` : words);
export const withHeader = (r: MemberRecord | null | undefined, words: string) => headerFirst(memberHeader(r), words);

// The judges' rules for the header (both judges, only when there is one): the record is what they told Cue; their own name and
// company are not a third party (but back no fact about them); their own goal, said as an aim, is backed; another person's or
// organization's act or role needs their words or goal; a goal is never a result; a detail beyond the goal is not backed by it.
export const MEMBER_RECORD_RULES = `At the top of what they said is what Cue has on file for them: their name and their goals, from their own record. Read them as things they told Cue:
- their own name, and their own company or project, are theirs, not a third party; a line naming them still needs their words for any fact it states about them;
- a line restating their own goal or plan, as an aim or a plan, is backed ("Partnering with X" when a goal of theirs is partnering with X);
- a claim that another person or organization did something, agreed to, confirmed, funded or sponsored something, or is a partner or customer, is backed ONLY if their own words or their goal say so;
- a goal is an aim, not a result: a line stating it as done ("X confirmed", "Signed with X", "X is sponsoring") is not backed by a goal of partnering with X;
- a detail beyond the goal (a dollar figure, a date, "confirmed", "signed", a count) is not backed by the goal.`;

// Pure: what a code check reads as their words: their own first name, first, then their words. Only the first name (ruling iii).
export function withOwnName(theirs: string, r: MemberRecord | null | undefined): string {
  const first = oneLine(r?.firstName ?? "");
  return first.length >= 2 ? `${first}\n${theirs}` : theirs;
}

// Pure: what's on file, in a few words, for a refusal's log row (never the goals themselves).
export const recordSeen = (r: MemberRecord | null | undefined) => ({ name: !!r?.firstName, goals: r?.goals.length ?? 0 });

// Pure: the goals a header carries: active and on file, as they wrote them. Member knowledge strips every goal that names a member
// they were linked with (it becomes "<name>, another member, came up here..."); a goal it rewrote is no goal of theirs to check a line
// against, so it's left out (its hash, taken before the strip, no longer matches its text). hash: goalEdges.ts goalHash.
export function activeGoals(k: Pick<MemberKnowledge, "goals">, hash: (text: string) => string): string[] {
  return k.goals.filter((g) => g.state === "active" && g.onFile && hash(g.text) === g.hash).map((g) => g.text.trim()).filter(Boolean);
}

export type RecordDeps = {
  names: (userId: string) => Promise<{ firstName: string | null; lastName: string | null } | null>;
  goals: (userId: string) => Promise<string[]>;
};

// The goals through member knowledge (goals only), with its deps injectable so a test can run the real strip on a fake store.
export async function knowledgeGoals(userId: string, deps: Partial<KnowledgeDeps> = {}): Promise<string[]> {
  const [{ memberKnowledge }, { goalHash }] = await Promise.all([import("./memberKnowledge.js"), import("./goalEdges.js")]);
  return activeGoals(await memberKnowledge(userId, { include: ["goals"] }, deps), goalHash);
}

export const realRecordDeps: RecordDeps = {
  names: async (userId) => {
    const pool = (await import("../db/db.js")).default;
    const r = (await pool.query(`SELECT first_name, last_name FROM users WHERE id = $1`, [userId])).rows[0];
    return r ? { firstName: r.first_name ?? null, lastName: r.last_name ?? null } : null;
  },
  goals: (userId) => knowledgeGoals(userId),
};

// Their record, or null when neither part could be read. Each part fails on its own: a failed goals read (member knowledge fails
// closed when the other members' names can't be read) gives no goals, never unstripped ones.
export async function loadMemberRecord(userId: string, deps: RecordDeps = realRecordDeps): Promise<MemberRecord | null> {
  if (!userId) return null;
  const [names, goals] = await Promise.all([deps.names(userId).catch(() => null), deps.goals(userId).catch(() => null)]);
  if (!names && !goals) return null;
  return { firstName: names?.firstName?.trim() || null, lastName: names?.lastName?.trim() || null, goals: goals ?? [] };
}
