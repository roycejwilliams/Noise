// Door codes (Royce's ruling on #213, 2026-10-14): every event, ours or a partner's, has one door-only code, and it is part of
// the event's config. The door QR's pre-filled text carries it. The code is the one thing that says someone is physically at
// the door: a valid door code, while the event is live, counts as arriving. The text the person sends is still their own
// consent and first contact; the scan alone is not. A check-in phrase without the code stays what it is today, a check-in,
// never an arrival, so someone typing the phrase from home can't put themselves in the room (the 10-07 rule).
//
// What keeps that true:
//   - unguessable: 7 symbols from the invite alphabet (no 0/O, 1/I/L), always a digit and a letter, about 27 billion codes, so
//     it's never a word, never a 6-symbol RSVP entry code (services/partners.ts) and never an 8-symbol invite code;
//   - one event only: the code maps to exactly one event id, and only a code from the table counts;
//   - live only while the event is: it arrives someone only inside the check-in window (eventWalkinCheckin.isCheckinOpen, 3
//     hours before the start until the event's end); outside it, it's no arrival;
//   - rotatable: if a photo of the QR leaks, the team rotates it (src/scripts/partners.ts rotate-door), the old code stops
//     at once, and the new QR is printed. A partner's night gets its door code when it's created; a Co event gets one when
//     the team asks for it (src/scripts/partners.ts door <eventId>).
// This file holds the rules (pure, checked in evals/partners/config.ts) and the store. It sends nothing.
import { randomBytes } from "node:crypto";
import pool from "../db/db.js";

export const DOOR = { length: 7 } as const;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function isDoorCode(code: string): boolean {
  return code.length === DOOR.length && [...code].every((c) => ALPHABET.includes(c)) && /\d/.test(code) && /[A-Z]/.test(code);
}

export function newDoorCode(rand: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  for (;;) {
    const code = Array.from(rand(DOOR.length), (b) => ALPHABET[b % ALPHABET.length]).join("");
    if (isDoorCode(code)) return code;
  }
}

export function doorCodeCandidates(text: string): string[] {
  return [...new Set(text.toUpperCase().split(/[^A-Z0-9]+/).filter(isDoorCode))];
}

// The event's door code, made the first time it's asked for. Never two for one event.
export async function ensureDoorCode(eventId: string, rand?: (n: number) => Uint8Array): Promise<string> {
  const { rows } = await pool.query(`SELECT code FROM event_door_codes WHERE event_api_id = $1`, [eventId]);
  if (rows[0]) return rows[0].code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ins = await pool.query(
      `INSERT INTO event_door_codes (event_api_id, code) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING code`,
      [eventId, newDoorCode(rand)],
    );
    if (ins.rows[0]) return ins.rows[0].code;
    // Another run made it first (the event's row), or the code was taken (another event's): read again, else retry.
    const again = await pool.query(`SELECT code FROM event_door_codes WHERE event_api_id = $1`, [eventId]);
    if (again.rows[0]) return again.rows[0].code;
  }
  throw new Error("couldn't make a door code that isn't taken");
}

// A leaked photo: a new code, and the old one stops at once (it's replaced, not kept).
export async function rotateDoorCode(eventId: string, rand?: (n: number) => Uint8Array): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await pool.query(`UPDATE event_door_codes SET code = $2, rotated_at = NOW() WHERE event_api_id = $1 RETURNING code`, [eventId, newDoorCode(rand)]);
      return rows[0]?.code ?? null;
    } catch (err: any) {
      if (err?.code !== "23505") throw err;
    }
  }
  return null;
}

// The one event a text's door code points to, or null (none, or two different events' codes in one text).
export async function eventForDoorCode(text: string): Promise<{ eventId: string; code: string } | null> {
  const candidates = doorCodeCandidates(text);
  if (!candidates.length) return null;
  const { rows } = await pool.query(`SELECT event_api_id, code FROM event_door_codes WHERE code = ANY($1::text[])`, [candidates]);
  return rows.length === 1 ? { eventId: String(rows[0].event_api_id), code: String(rows[0].code) } : null;
}
