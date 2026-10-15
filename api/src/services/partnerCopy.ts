// Every word a guest reads in the partner-room flow, in one place (Royce, 2026-10-14: "nothing a guest or member ever reads
// ships without Royce seeing it", and copy never gets a default).
//
// Each line starts as PENDING. A pending line is never shown to anyone: copyFor returns null and the caller shows no words at
// all (the page answers with its status and no text). Royce writes or approves each line, and only then is it filled in here.
// The PR that adds a line lists it under "Copy" with where and when it's seen.
//
// Placeholders a line may use, filled by code: {agent} (the name guests text), {event} (the night's name), {partner} (the
// partner's name), {code} (the night's entry code), {next} (the partner's next live night), {link} (that next night's page),
// {name} (the name the guest gave, in their own words). A line that names one the caller can't fill is not shown either.
export const PENDING = "PENDING_ROYCE_COPY";

export const PARTNER_COPY = {
  // The guest's first text to Cue from the RSVP link, filled in by the page (they can edit it before sending). Must carry
  // {code} (the night's RSVP code). Seen: in Messages, when they tap the button on the live RSVP page.
  entry_text: PENDING,
  // The first text from the door QR at a partner night, filled in by the page. Must carry {code} (the night's door-only
  // code: sending it is arriving, #213). Seen: in Messages, when they tap the button on the door page during the night.
  door_entry_text: PENDING,
  // The door QR's pre-filled text at one of our own (Luma) events. Must carry {code}. Seen: in Messages, when someone scans the
  // door QR at a Noise event.
  co_door_text: PENDING,
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

  // ---- texts to a guest (services/partnerGuests.ts). Only ever a reply to a text the guest just sent: Cue never texts a guest
  // first. Each question is asked at most once, and only while the night's code is live or the night is on.
  // The first question, right after their first text (the one that carried the code). Seen: the guest's first reply from Cue.
  guest_ask_who: PENDING,
  // What they do. Seen: after they answer the question before, unless they already said.
  guest_ask_work: PENDING,
  // Who they're hoping to meet. Seen: after the question before, unless they already said. May use {name}.
  guest_ask_hoping: PENDING,
  // Intake finished: what happens now. Seen: once, after the last answer. May use {name}, {event}.
  guest_intake_done: PENDING,
  // A guest who did intake from the RSVP link scans the door QR on the night. Seen: once, at that scan. May use {name}.
  guest_arrived: PENDING,
  // A guest texts during the night after intake is done (Cue doesn't work for guests beyond the night's intros). Seen: at most
  // once every 3 hours.
  guest_during_night: PENDING,
  // A code for a night whose intake isn't open yet. Seen: at most once a day.
  guest_not_open: PENDING,
  // A late scan by text: a code for a night that's over (Royce: "that event's over, here's the door to the club or the
  // partner's next event"). With {next} and {link} when the partner has a next live night. Seen: at most once a day.
  guest_late_next: PENDING,
  // The same, with no next live night. Seen: at most once a day.
  guest_late: PENDING,
  // After the cutoff: a former guest texts. Warm, and Cue doesn't work for them (Royce: "that was the event version. The full
  // thing is the club, and the door's here"). Seen: at most once a day.
  guest_after_cutoff: PENDING,
} as const satisfies Record<string, string>;

export type CopyKey = keyof typeof PARTNER_COPY;
export type CopyVars = Partial<Record<"agent" | "event" | "partner" | "code" | "next" | "link" | "name", string>>;

// The line, filled in; null while it's pending, or when it names a placeholder the caller didn't fill. table is for the checks.
export function copyFor(key: CopyKey, vars: CopyVars = {}, table: Record<CopyKey, string> = PARTNER_COPY): string | null {
  const line = table[key];
  if (!line || line.includes(PENDING)) return null;
  let missing = false;
  const out = line.replace(/\{(agent|event|partner|code|next|link|name)\}/g, (_m, k: keyof CopyVars) => {
    const v = vars[k]?.trim();
    if (!v) missing = true;
    return v ?? "";
  });
  if (missing || /\{[a-z]+\}/.test(out)) return null;
  // An entry or door text is how Cue knows the night (and, at the door, that they're there): without its code it's nothing.
  if ((key === "entry_text" || key === "door_entry_text" || key === "co_door_text") && (!vars.code || !out.includes(vars.code))) return null;
  return out;
}

// Keys still waiting on Royce, for the team's script and the PR.
export function pendingCopy(table: Record<CopyKey, string> = PARTNER_COPY): CopyKey[] {
  return (Object.keys(table) as CopyKey[]).filter((k) => !table[k] || table[k].includes(PENDING));
}
