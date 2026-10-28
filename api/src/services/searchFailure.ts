// Whether a search that failed would likely work an hour later (review of #293, 2026-10-28). The 9am sweep retries a search a place
// failed in (services/dailySweep.ts incompleteRetry), but only for a failure that clears on its own: a timeout, a network error, or the
// other side's server failing (5xx, overloaded). A key that's refused or missing (401, 403, not configured), an account out of credit
// (402), a rate limit or a budget used up (429, our own caps) fail the same way an hour later: those are shown on the team's /sweeps
// page as failed places, never retried. Read from the error's own text (a status, an error code, the words a timeout says), never
// from anything a member wrote.

// Pure: true for a timeout, a network error or a 5xx; false for anything else, unknown included (a retry is spent only on what clears).
export function transientFailure(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (!t) return false;
  // A status said in the text decides first: 5xx clears, any 4xx doesn't.
  const status = t.match(/\b(?:HTTP|Exa|status|statusCode)\s*:?\s*(\d{3})\b|\((\d{3})\)/i);
  const code = status ? Number(status[1] ?? status[2]) : null;
  if (code !== null && code >= 400) return code >= 500;
  if (/timed?\s?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|AbortError|aborted/i.test(t)) return true;
  // A dropped connection too (re-review of #293): "Cannot connect to API: other side closed", ECONNRESET, socket hang up.
  if (/couldn't be reached|cannot connect to API|other side closed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|UND_ERR_SOCKET/i.test(t) || /(?:^|\(|TypeError: )terminated(?:\)|$)/i.test(t.trim())) return true;
  if (/overloaded|internal server error|bad gateway|service unavailable|gateway timeout/i.test(t)) return true;
  return false;
}
