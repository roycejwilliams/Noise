// The moved-prompt ledger (independent review of #318, 2026-10-29): a case that replays on moved wording passes only when the PR that
// moved it says so here, one entry per move: the allowlisted literal, its text hash before and after, the PR and the date. Replay fails a
// move with no entry, an entry older than 14 days (re-record by then), and a second move on the same recording (an entry from the
// stamped text to some other text: the recording is two moves behind; re-record). An entry nothing uses any more is listed to remove.
//   npm run evals:golden -- --ledger <PR number>    writes an entry for each move this replay saw, dated today
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type LedgerEntry = { chunk: string; from: string; to: string; pr: string; date: string };
export type Move = { id: string; from: string | null; to: string };
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
  if (exact) {
    const age = (nowMs - Date.parse(exact.date)) / DAY;
    return Number.isFinite(age) && age <= LEDGER_MAX_DAYS ? null : `${m.id} moved under ledger entry ${exact.pr} of ${exact.date}, past ${LEDGER_MAX_DAYS} days: re-record the case (npm run evals:golden:record -- --moved)`;
  }
  if (ledger.some((e) => e.chunk === m.id && e.from === m.from)) return `${m.id} moved again since its ledgered move (the recording is two moves behind): re-record the case (npm run evals:golden:record -- --moved)`;
  return `${m.id} moved with no ledger entry: re-record the case, or record the move in evals/golden/moved-ledger.json (npm run evals:golden -- --ledger <PR>)`;
}
