// Every word a guest reads in the partner-room flow, in one place (Royce, 2026-10-14: "nothing a guest or member ever reads
// ships without Royce seeing it", and copy never gets a default).
//
// Each line starts as PENDING. A pending line is never shown to anyone: copyFor returns null and the caller shows no words at
// all (the page answers with its status and no text). Royce writes or approves each line, and only then is it filled in here.
// The PR that adds a line lists it under "Copy" with where and when it's seen.
//
// Placeholders a line may use, filled by code: {agent} (the name guests text), {event} (the night's name), {partner} (the
// partner's name), {code} (the night's entry code), {next} (the partner's next live night). A line that names one the caller
// can't fill is not shown either.
export const PENDING = "PENDING_ROYCE_COPY";

export const PARTNER_COPY = {
  // The guest's first text to Cue, filled in by the page (they can edit it before sending). Must carry {code}.
  // Seen: in Messages, when the guest taps the button on a live page (RSVP link before the night, door QR on it).
  entry_text: PENDING,
  // The live page: what texting Cue means, said before they send it (that one text is their consent, intake and arrival).
  // Seen: the RSVP link or the door QR, while the night's code is live.
  page_open_terms: PENDING,
  // The live page's button label. Seen: same page.
  page_open_button: PENDING,
  // A code that exists but whose intake the partner hasn't opened yet. Seen: the RSVP link or QR, before intake opens.
  page_not_open: PENDING,
  // A late scan, the partner has a next live night: the one graceful line. May use {event}, {partner}, {next}.
  // Seen: the RSVP link or QR after the night is over.
  page_over_next: PENDING,
  // The late scan's button to the next night's page. May use {next}. Seen: same page.
  page_over_next_button: PENDING,
  // A late scan with no next live night (Royce's "here's the door to the club"). May use {event}, {partner}.
  // Seen: the RSVP link or QR after the night is over, or once the partner's agreement has ended.
  page_over: PENDING,
  // A link whose code doesn't exist. Seen: a mistyped or made-up /r/ link.
  page_invalid: PENDING,
} as const satisfies Record<string, string>;

export type CopyKey = keyof typeof PARTNER_COPY;
export type CopyVars = Partial<Record<"agent" | "event" | "partner" | "code" | "next", string>>;

// The line, filled in; null while it's pending, or when it names a placeholder the caller didn't fill. table is for the checks.
export function copyFor(key: CopyKey, vars: CopyVars = {}, table: Record<CopyKey, string> = PARTNER_COPY): string | null {
  const line = table[key];
  if (!line || line.includes(PENDING)) return null;
  let missing = false;
  const out = line.replace(/\{(agent|event|partner|code|next)\}/g, (_m, k: keyof CopyVars) => {
    const v = vars[k]?.trim();
    if (!v) missing = true;
    return v ?? "";
  });
  if (missing || /\{[a-z]+\}/.test(out)) return null;
  // The entry text is how Cue knows the night: without the code it's no entry text.
  if (key === "entry_text" && vars.code && !out.includes(vars.code)) return null;
  return out;
}

// Keys still waiting on Royce, for the team's script and the PR.
export function pendingCopy(table: Record<CopyKey, string> = PARTNER_COPY): CopyKey[] {
  return (Object.keys(table) as CopyKey[]).filter((k) => !table[k] || table[k].includes(PENDING));
}
