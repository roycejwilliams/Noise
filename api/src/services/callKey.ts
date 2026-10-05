// Which call something came from (second review, 2026-09-24). The promise
// search after a call (harness/callGrounding.ts) and the after-call text
// (jobs/postCallFollowUp.ts) are both started from the same cleaned call
// transcript, but at different times: the text's row is written at the end
// of call processing, while the search runs alongside and can finish before
// or after it. A time window can't tell two calls a few minutes apart
// apart; a fingerprint of the transcript can.
import { createHash } from "crypto";

export function callKey(transcript: string): string {
  return createHash("sha256").update(transcript).digest("hex").slice(0, 32);
}
