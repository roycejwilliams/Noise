// Partners as configuration (Royce, 2026-10-14: "onboarding a new partner is configuration - their RSVP blurb, their door QR,
// their host read - never new code. Build it so the tenth partner costs nothing but a config entry.")
//
// A partner room is someone else's event with Cue's connection layer on top. Everything that makes one partner different from
// another is a row here, added and changed by the team with src/scripts/partners.ts, never a code change or a deploy:
//   partners         who they are (name, a short slug), their RSVP blurb, and where their host read goes (host name and email).
//                    ended_at closes every link of theirs when the agreement ends; the row is never deleted. The blurb is
//                    words guests read, so it's only handed out once someone on the team has signed it off (Royce, 2026-10-14:
//                    nothing a guest reads ships without Royce seeing it); changing it takes the sign-off away again.
//   partner_events   one of their nights: name, start and end, zone, venue, and that night's own entry code. Its own id
//                    ("partner-…"), because a partner event is not on Noise's Luma calendar and never needs to be (Luma gives no
//                    read-only guest list, so the RSVP link and the door QR are the way in, 2026-10-14).
//
// One night, one code (Royce, 2026-10-14):
//   1. created     the event is added; Cue makes its RSVP code and its door-only code (services/doorCodes.ts, Royce's ruling
//                  on #213) and the door QR. Every event gets its own; nothing is reused.
//   2. open        the partner opens intake (the team runs `open`): the RSVP code goes live on the RSVP page link, and the
//                  door code on the printed QR at the door (during the check-in window only). Each opens the page
//                  (/r/<code>, routes/partnerPage.ts), which fills in the guest's first text to Cue with that code in it. Sendblue only lets Cue answer a number that texted first, and Cue never
//                  cold-texts a non-member: the guest always starts.
//   3. over        the night has passed (the end every in-room reader uses, introConsent.effectiveEnd) or the room was closed
//                  (closed_at). The code is dead forever: nothing reopens it, and event times can't be edited after the
//                  fact. A late scan gets one graceful page: the night is over, and the partner's next open night if there is
//                  one. The partner's next event gets a fresh code and QR of its own.
//
// What is NOT configuration, on purpose: the privacy floors of the host read (services/partnerReadout.ts READOUT), the
// consent rules, and anything about who a guest is. A partner can't lower them, and no partner gets a special case: House of
// AI is partner #1 in the data, nothing more.
//
// This file holds the rules (pure, checked in evals/partners/config.ts) and the reads and writes. It sends nothing to anyone.
import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { effectiveEnd } from "../harness/introConsent.js";
import { copyFor } from "./partnerCopy.js";

export const PARTNER = {
  // Entry codes: 6 symbols from the invite alphabet (no 0/O, 1/I/L), always with a digit and a letter, so a code is never an
  // English word and never an 8-symbol invite code (services/inviteCodes.ts).
  codeLength: 6,
  maxName: 120,
  maxEventName: 80,
  maxBlurb: 600,
  maxVenue: 200,
  // A night longer than this is a typo, not an event.
  maxEventHours: 18,
} as const;

// The name guests text. The rename (PR #206) adds services/agentName.ts AGENT_NAME; this follows it once that lands.
export const AGENT = "Cue";

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const isPartnerEvent = (eventId: string) => eventId.startsWith("partner-");

export type Partner = {
  id: string;
  slug: string;
  name: string;
  rsvp_blurb: string;
  host_name: string | null;
  host_email: string | null;
  rsvp_blurb_approved_by: string | null;
  ended_at: Date | null;
};

export type PartnerEvent = {
  api_id: string;
  partner_id: string;
  name: string;
  start_at: string;
  end_at: string | null;
  timezone: string | null;
  venue: string | null;
  address: string | null;
  code: string;
  intake_opened_at: Date | null;
  closed_at: Date | null;
};

// ---------------------------------------------------------------- rules (pure)

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;
// The blurb's only placeholders. {link} is required: a blurb with no way in is no blurb.
const PLACEHOLDERS = new Set(["link", "event", "partner"]);
// The agent is only ever "Cue" to people (brand voice): never a matchmaker, or someone's AI.
const OFF_BRAND: { pattern: RegExp; why: string }[] = [
  { pattern: /\bmatch-?mak/i, why: 'calls Cue a "matchmaker"' },
  { pattern: /\b(Noise|CoPatible|Co)'s AI\b|\bAI behind\b/i, why: "describes Cue as a company's AI" },
];

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

export type PartnerInput = { slug: string; name: string; rsvp_blurb: string; host_name?: string | null; host_email?: string | null };
export type Checked<T> = { ok: true; value: T } | { ok: false; why: string };

// A blurb's problem, or null. The partner writes it; Cue's brand rules and the {link} still have to hold.
export function blurbProblem(blurb: string): string | null {
  const b = clean(blurb);
  if (!b) return "the RSVP blurb is empty";
  if (b.length > PARTNER.maxBlurb) return `the RSVP blurb is over ${PARTNER.maxBlurb} characters`;
  const names = [...b.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  const unknown = names.find((n) => !PLACEHOLDERS.has(n));
  if (unknown !== undefined) return `the RSVP blurb has {${unknown}}, and only {link}, {event} and {partner} are filled in`;
  const links = names.filter((n) => n === "link").length;
  if (links !== 1) return links ? "the RSVP blurb has {link} more than once" : "the RSVP blurb needs {link}, where the link to text Cue goes";
  if (/https?:\/\/|www\.|sms:/i.test(b)) return "the RSVP blurb has its own link; only {link} goes in it";
  for (const r of OFF_BRAND) if (r.pattern.test(b)) return `the RSVP blurb ${r.why}`;
  return null;
}

export function checkPartner(input: PartnerInput): Checked<PartnerInput> {
  const slug = clean(input.slug).toLowerCase();
  if (!SLUG.test(slug)) return { ok: false, why: "the slug is 1 to 40 lowercase letters, digits and dashes" };
  const name = clean(input.name);
  if (!name || name.length > PARTNER.maxName) return { ok: false, why: `the partner's name is 1 to ${PARTNER.maxName} characters` };
  const blurb = blurbProblem(input.rsvp_blurb);
  if (blurb) return { ok: false, why: blurb };
  const host_email = clean(input.host_email) || null;
  if (host_email && !EMAIL.test(host_email)) return { ok: false, why: "the host email doesn't look like an email" };
  const host_name = clean(input.host_name).slice(0, PARTNER.maxName) || null;
  return { ok: true, value: { slug, name, rsvp_blurb: input.rsvp_blurb.trim(), host_name, host_email } };
}

export type PartnerEventInput = { name: string; start_at: string; end_at?: string | null; timezone?: string | null; venue?: string | null; address?: string | null };
export type CheckedEvent = { name: string; start_at: string; end_at: string | null; timezone: string | null; venue: string | null; address: string | null };

export function checkPartnerEvent(input: PartnerEventInput): Checked<CheckedEvent> {
  const name = clean(input.name);
  if (!name || name.length > PARTNER.maxEventName) return { ok: false, why: `the event's name is 1 to ${PARTNER.maxEventName} characters` };
  // A time with no zone or offset would be read in the server's zone (UTC on Railway): never guessed.
  const startRaw = clean(input.start_at);
  if (!ZONED.test(startRaw)) return { ok: false, why: "the start needs a zone offset, like 2026-11-06T18:00:00-08:00" };
  const start = DateTime.fromISO(startRaw, { setZone: true });
  if (!start.isValid) return { ok: false, why: "the start isn't a date and time" };
  let end: DateTime | null = null;
  const endRaw = clean(input.end_at);
  if (endRaw) {
    if (!ZONED.test(endRaw)) return { ok: false, why: "the end needs a zone offset too" };
    end = DateTime.fromISO(endRaw, { setZone: true });
    if (!end.isValid) return { ok: false, why: "the end isn't a date and time" };
    const hours = end.diff(start, "hours").hours;
    if (hours <= 0) return { ok: false, why: "the end is before the start" };
    if (hours > PARTNER.maxEventHours) return { ok: false, why: `the event runs over ${PARTNER.maxEventHours} hours` };
  }
  const timezone = clean(input.timezone) || null;
  if (timezone && !DateTime.now().setZone(timezone).isValid) return { ok: false, why: `"${timezone}" isn't a time zone (use one like America/Los_Angeles)` };
  return {
    ok: true,
    value: {
      name,
      start_at: start.toUTC().toISO()!,
      end_at: end ? end.toUTC().toISO()! : null,
      timezone,
      venue: clean(input.venue).slice(0, PARTNER.maxVenue) || null,
      address: clean(input.address).slice(0, PARTNER.maxVenue) || null,
    },
  };
}

export function isEntryCode(code: string): boolean {
  return code.length === PARTNER.codeLength && [...code].every((c) => CODE_ALPHABET.includes(c)) && /\d/.test(code) && /[A-Z]/.test(code);
}

// One new entry code. rand is for the checks.
export function newEntryCode(rand: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  for (;;) {
    const code = Array.from(rand(PARTNER.codeLength), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    if (isEntryCode(code)) return code;
  }
}

// Every chunk of a text that could be an entry code, so the code still counts if a guest edits the words around it.
export function entryCodeCandidates(text: string): string[] {
  return [...new Set(text.toUpperCase().split(/[^A-Z0-9]+/).filter(isEntryCode))];
}

// The guest's first text, filled in by the page. The same text from the RSVP link before the night and from the door QR on
// it: the code says which night; the words around it are theirs to change. Null while its copy waits on Royce
// (services/partnerCopy.ts), and then the page offers no text at all.
export function entryText(eventName: string, code: string): string | null {
  return copyFor("entry_text", { agent: AGENT, event: clean(eventName).slice(0, PARTNER.maxEventName), code });
}

// The door QR's text: the same, with the night's door-only code (services/doorCodes.ts), which is what makes it an arrival.
export function doorEntryText(eventName: string, doorCode: string): string | null {
  return copyFor("door_entry_text", { agent: AGENT, event: clean(eventName).slice(0, PARTNER.maxEventName), code: doorCode });
}

// The page a code opens: the RSVP link and what the door QR encodes. Null without a public base URL: no link is better than a
// broken one.
export function entryUrl(code: string, baseUrl = process.env.API_URL): string | null {
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  return /^https?:\/\//.test(base) ? `${base}/r/${code}` : null;
}

// The partner's blurb for one night, ready for their RSVP page. Null until the blurb is signed off.
export function renderBlurb(partner: Pick<Partner, "name" | "rsvp_blurb" | "rsvp_blurb_approved_by">, event: Pick<PartnerEvent, "name">, link: string): string | null {
  if (!partner.rsvp_blurb_approved_by) return null;
  return partner.rsvp_blurb.replace(/\{(link|event|partner)\}/g, (_m, k: string) => (k === "link" ? link : k === "event" ? clean(event.name) : clean(partner.name)));
}

// Where a night's code stands. over and ended are for good: no step goes back from them.
//   not_open  created, and the partner hasn't opened intake yet
//   open      the code is live: the page opens a text to Cue
//   over      the night has passed (effectiveEnd) or its room was closed; dead forever
//   ended     the partner's agreement has ended
export type EntryState = "not_open" | "open" | "over" | "ended";
export function entryState(partner: Pick<Partner, "ended_at">, event: Pick<PartnerEvent, "start_at" | "end_at" | "timezone" | "intake_opened_at" | "closed_at">, now: Date): EntryState {
  const t = now.getTime();
  if (partner.ended_at && new Date(partner.ended_at).getTime() <= t) return "ended";
  if (event.closed_at && new Date(event.closed_at).getTime() <= t) return "over";
  if (t > new Date(effectiveEnd({ start_at: event.start_at, end_at: event.end_at, timezone: event.timezone })).getTime()) return "over";
  return event.intake_opened_at ? "open" : "not_open";
}

// ---------------------------------------------------------------- data

const PARTNER_COLS = `id, slug, name, rsvp_blurb, host_name, host_email, rsvp_blurb_approved_by, ended_at`;
const EVENT_COLS = `api_id, partner_id, name, start_at, end_at, timezone, venue, address, code, intake_opened_at, closed_at`;

const asEvent = (r: any): PartnerEvent => ({
  api_id: r.api_id,
  partner_id: r.partner_id,
  name: r.name,
  start_at: new Date(r.start_at).toISOString(),
  end_at: r.end_at ? new Date(r.end_at).toISOString() : null,
  timezone: r.timezone ?? null,
  venue: r.venue ?? null,
  address: r.address ?? null,
  code: r.code,
  intake_opened_at: r.intake_opened_at ? new Date(r.intake_opened_at) : null,
  closed_at: r.closed_at ? new Date(r.closed_at) : null,
});

export async function partnerBySlug(slug: string): Promise<Partner | null> {
  const { rows } = await pool.query(`SELECT ${PARTNER_COLS} FROM partners WHERE slug = $1`, [clean(slug).toLowerCase()]);
  return rows[0] ?? null;
}

export async function listPartners(): Promise<Partner[]> {
  const { rows } = await pool.query(`SELECT ${PARTNER_COLS} FROM partners ORDER BY created_at`);
  return rows;
}

export async function addPartner(input: PartnerInput): Promise<{ ok: true; partner: Partner } | { ok: false; why: string }> {
  const c = checkPartner(input);
  if (!c.ok) return c;
  const v = c.value;
  const { rows } = await pool.query(
    `INSERT INTO partners (slug, name, rsvp_blurb, host_name, host_email) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slug) DO NOTHING RETURNING ${PARTNER_COLS}`,
    [v.slug, v.name, v.rsvp_blurb, v.host_name, v.host_email],
  );
  return rows[0] ? { ok: true, partner: rows[0] } : { ok: false, why: `there's already a partner "${v.slug}"` };
}

// A change to a partner's config: whatever is given replaces what's there, and the whole is checked again.
export async function updatePartner(slug: string, change: Partial<Omit<PartnerInput, "slug">>): Promise<{ ok: true; partner: Partner } | { ok: false; why: string }> {
  const now = await partnerBySlug(slug);
  if (!now) return { ok: false, why: `no partner "${slug}"` };
  const c = checkPartner({
    slug: now.slug,
    name: change.name ?? now.name,
    rsvp_blurb: change.rsvp_blurb ?? now.rsvp_blurb,
    host_name: change.host_name === undefined ? now.host_name : change.host_name,
    host_email: change.host_email === undefined ? now.host_email : change.host_email,
  });
  if (!c.ok) return c;
  const v = c.value;
  // New blurb words need a new sign-off.
  const { rows } = await pool.query(
    `UPDATE partners SET name = $2, rsvp_blurb = $3, host_name = $4, host_email = $5, updated_at = NOW(),
       rsvp_blurb_approved_by = CASE WHEN rsvp_blurb = $3 THEN rsvp_blurb_approved_by END,
       rsvp_blurb_approved_at = CASE WHEN rsvp_blurb = $3 THEN rsvp_blurb_approved_at END
     WHERE id = $1 RETURNING ${PARTNER_COLS}`,
    [now.id, v.name, v.rsvp_blurb, v.host_name, v.host_email],
  );
  return { ok: true, partner: rows[0] };
}

// The sign-off on a partner's blurb, by name. Only the blurb as it reads now; any later change takes it away.
export async function approveBlurb(slug: string, by: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const who = clean(by);
  if (who.length < 2) return { ok: false, why: "say who is signing off the blurb" };
  const { rowCount } = await pool.query(
    `UPDATE partners SET rsvp_blurb_approved_by = $2, rsvp_blurb_approved_at = NOW(), updated_at = NOW() WHERE slug = $1`,
    [clean(slug).toLowerCase(), who.slice(0, 80)],
  );
  return (rowCount ?? 0) > 0 ? { ok: true } : { ok: false, why: `no partner "${slug}"` };
}

// The agreement ended: every link of theirs stops opening a text. Kept, never deleted, so past nights still have their partner.
export async function endPartner(slug: string): Promise<boolean> {
  const { rowCount } = await pool.query(`UPDATE partners SET ended_at = NOW(), updated_at = NOW() WHERE slug = $1 AND ended_at IS NULL`, [clean(slug).toLowerCase()]);
  return (rowCount ?? 0) > 0;
}

// One night of theirs, with its own new code. Not open yet: the partner opens intake when they post the link.
export async function addPartnerEvent(slug: string, input: PartnerEventInput, rand?: (n: number) => Uint8Array): Promise<{ ok: true; event: PartnerEvent } | { ok: false; why: string }> {
  const partner = await partnerBySlug(slug);
  if (!partner) return { ok: false, why: `no partner "${slug}"` };
  if (partner.ended_at) return { ok: false, why: `${partner.name}'s agreement has ended` };
  const c = checkPartnerEvent(input);
  if (!c.ok) return c;
  const v = c.value;
  // A code collision is about one in a billion; a conflict just takes another code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows } = await pool.query(
      `INSERT INTO partner_events (api_id, partner_id, name, start_at, end_at, timezone, venue, address, code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (code) DO NOTHING RETURNING ${EVENT_COLS}`,
      [`partner-${randomBytes(8).toString("hex")}`, partner.id, v.name, v.start_at, v.end_at, v.timezone, v.venue, v.address, newEntryCode(rand)],
    );
    if (rows[0]) {
      // Its door-only code too (#213). If this fails the night still exists, and `show` makes it.
      const { ensureDoorCode } = await import("./doorCodes.js");
      await ensureDoorCode(rows[0].api_id).catch((err: any) => console.error("partners: door code not made yet (show makes it):", err?.message ?? err));
      return { ok: true, event: asEvent(rows[0]) };
    }
  }
  return { ok: false, why: "couldn't make a code that isn't taken; try again" };
}

export async function partnerEvents(partnerId: string): Promise<PartnerEvent[]> {
  const { rows } = await pool.query(`SELECT ${EVENT_COLS} FROM partner_events WHERE partner_id = $1 ORDER BY start_at`, [partnerId]);
  return rows.map(asEvent);
}

// A partner event and its partner, by the event's id (the host read uses this to know whose night it was).
export async function partnerEvent(eventId: string): Promise<{ event: PartnerEvent; partner: Partner } | null> {
  if (!isPartnerEvent(eventId)) return null;
  const { rows } = await pool.query(
    `SELECT e.api_id, e.partner_id, e.name, e.start_at, e.end_at, e.timezone, e.venue, e.address, e.code, e.intake_opened_at, e.closed_at,
            p.id, p.slug, p.name AS partner_name, p.rsvp_blurb, p.host_name, p.host_email, p.rsvp_blurb_approved_by, p.ended_at
     FROM partner_events e JOIN partners p ON p.id = e.partner_id WHERE e.api_id = $1`,
    [eventId],
  );
  const r = rows[0];
  return r ? { event: asEvent(r), partner: { id: r.id, slug: r.slug, name: r.partner_name, rsvp_blurb: r.rsvp_blurb, host_name: r.host_name, host_email: r.host_email, rsvp_blurb_approved_by: r.rsvp_blurb_approved_by, ended_at: r.ended_at } } : null;
}

// The night a code (or a text carrying one) points to, whatever state it's in: a dead code still has a night, so a late scan
// gets the graceful answer rather than "not valid". Only a code from the table counts, so a stray six-symbol word never does.
// Two different nights' codes in one text: which they meant is unclear, so neither is guessed.
export async function resolveEntryCode(textOrCode: string): Promise<{ event: PartnerEvent; partner: Partner } | null> {
  const candidates = entryCodeCandidates(textOrCode);
  if (!candidates.length) return null;
  const { rows } = await pool.query(`SELECT api_id FROM partner_events WHERE code = ANY($1::text[])`, [candidates]);
  if (rows.length !== 1) return null;
  return partnerEvent(rows[0].api_id);
}

// The partner opens intake for one night: its code goes live. Only from not_open; a night that's over stays dead.
export async function openIntake(eventId: string, now = new Date()): Promise<{ ok: true } | { ok: false; why: string }> {
  const found = await partnerEvent(eventId);
  if (!found) return { ok: false, why: "no partner event with that id" };
  const state = entryState(found.partner, found.event, now);
  if (state === "open") return { ok: false, why: "intake is already open" };
  if (state !== "not_open") return { ok: false, why: state === "ended" ? `${found.partner.name}'s agreement has ended` : "that night is over, and its code stays dead; a new night gets a new code" };
  const { rowCount } = await pool.query(`UPDATE partner_events SET intake_opened_at = NOW() WHERE api_id = $1 AND intake_opened_at IS NULL AND closed_at IS NULL`, [eventId]);
  return (rowCount ?? 0) > 0 ? { ok: true } : { ok: false, why: "it changed while opening; look again" };
}

// The room closed (or the night was called off): the code dies for good. Never cleared by anything.
export async function closePartnerEvent(eventId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`UPDATE partner_events SET closed_at = NOW() WHERE api_id = $1 AND closed_at IS NULL`, [eventId]);
  return (rowCount ?? 0) > 0;
}

// The partner's next night whose code is live, other than this one: where a late scan is pointed.
export async function nextOpenNight(partner: Partner, notEventId: string, now = new Date()): Promise<PartnerEvent | null> {
  if (partner.ended_at) return null;
  const { rows } = await pool.query(
    `SELECT ${EVENT_COLS} FROM partner_events WHERE partner_id = $1 AND api_id <> $2 AND intake_opened_at IS NOT NULL AND closed_at IS NULL ORDER BY start_at`,
    [partner.id, notEventId],
  );
  return rows.map(asEvent).find((e: PartnerEvent) => entryState(partner, e, now) === "open") ?? null;
}
