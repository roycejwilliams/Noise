// The moved-prompt ledger (independent review of #318, 2026-10-29): a case that replays on moved wording passes only when the PR that
// moved it says so here, one entry per move: the allowlisted literal, its text hash before and after, the PR and the date. Replay fails a
// move with no entry, an entry older than 14 days (re-record by then) or dated in the future, and a second move on the same recording (an
// entry from the stamped text to some other text: the recording is two moves behind; re-record). An entry nothing uses any more is listed
// to remove.
//   npm run evals:golden -- --ledger <PR>                 lists each move this replay saw, with its before and after text; writes nothing
//   npm run evals:golden -- --ledger <PR> <chunkId...>    records the named moves, dated today, and prints each one's before and after
// --ledger refuses (and writes nothing) when a named literal already has an entry from the same text to other text (review round 2:
// adding a second entry beside the first made "moved again" pass).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type LedgerEntry = { chunk: string; from: string; to: string; pr: string; date: string };
export type Move = { id: string; from: string | null; to: string; before?: string | null };
export const LEDGER_PATH = new URL("./moved-ledger.json", import.meta.url).pathname;
export const LEDGER_MAX_DAYS = 14;
const DAY = 86_400_000;

export function readLedger(path = LEDGER_PATH): LedgerEntry[] {
  return existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")).entries ?? []) as LedgerEntry[]) : [];
}
export function writeLedger(entries: LedgerEntry[], path = LEDGER_PATH): void {
  writeFileSync(path, JSON.stringify({ _: "Moved-prompt ledger: see evals/golden/ledger.ts. One entry per allowlisted literal a PR rewords without re-recording; each expires after 14 days.", entries }, null, 2) + "\n");
}

// Why this move may not pass, or null when the ledger carries it and it's fresh.
export function moveProblem(m: Move, ledger: LedgerEntry[], nowMs: number): string | null {
  const exact = ledger.find((e) => e.chunk === m.id && e.from === m.from && e.to === m.to);
  // Two entries from the same stamped text: the recording is two moves behind, whichever one this run matches.
  if (ledger.some((e) => e.chunk === m.id && e.from === m.from && e.to !== m.to)) return `${m.id} moved again since its ledgered move (the recording is two moves behind): re-record the case (npm run evals:golden:record -- --moved)`;
  if (exact) {
    const age = (nowMs - Date.parse(exact.date)) / DAY;
    if (!Number.isFinite(age)) return `${m.id} has a ledger entry (${exact.pr}) with no readable date (${exact.date}): fix it or re-record the case`;
    // A day of slack for time zones; a later date is an entry that would never expire.
    if (age < -1) return `${m.id} has a ledger entry (${exact.pr}) dated in the future (${exact.date}): date it today (npm run evals:golden -- --ledger <PR> <chunkId>)`;
    return age <= LEDGER_MAX_DAYS ? null : `${m.id} moved under ledger entry ${exact.pr} of ${exact.date}, past ${LEDGER_MAX_DAYS} days: re-record the case (npm run evals:golden:record -- --moved)`;
  }
  return `${m.id} moved with no ledger entry: re-record the case, or record the move in evals/golden/moved-ledger.json (npm run evals:golden -- --ledger <PR> ${m.id})`;
}

// Adds one move to the ledger, or says why not: a move already ledgered is left as it is, and a literal that already moved from the same
// text to other text is refused (the recording would be two moves behind; re-record instead).
export function addToLedger(ledger: LedgerEntry[], m: Move, pr: string, date: string): { added: LedgerEntry | null; problem: string | null } {
  if (!m.from) return { added: null, problem: `${m.id} has no stamped text to move from: re-record the case` };
  if (ledger.some((e) => e.chunk === m.id && e.from === m.from && e.to === m.to)) return { added: null, problem: null };
  const other = ledger.find((e) => e.chunk === m.id && e.from === m.from && e.to !== m.to);
  if (other) return { added: null, problem: `${m.id} already has a ledger entry from the same text (${other.pr} of ${other.date}, to ${other.to}); this is a second move (to ${m.to}): re-record the case (npm run evals:golden:record -- --moved), don't add an entry` };
  const added = { chunk: m.id, from: m.from, to: m.to, pr, date };
  ledger.push(added);
  return { added, problem: null };
}

// --ledger's arguments: the PR, then the chunk ids to record (none: list the moves, write nothing). Null when --ledger isn't given.
export function ledgerArgs(argv: string[]): { pr: string; ids: string[] } | { error: string } | null {
  const i = argv.indexOf("--ledger");
  if (i < 0) return null;
  const rest: string[] = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) rest.push(argv[j]);
  const pr = (rest[0] ?? "").replace(/^#/, "");
  if (!/^\d+$/.test(pr)) return { error: "--ledger takes the PR number, then the chunk ids to record (npm run evals:golden -- --ledger 318 coVoice.ts:VOICE_TONE#0); with no ids it lists the moves and writes nothing" };
  return { pr, ids: [...new Set(rest.slice(1))] };
}
