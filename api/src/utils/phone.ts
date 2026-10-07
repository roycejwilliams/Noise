import { parsePhoneNumberFromString } from "libphonenumber-js";

// Normalizes any phone number a user types (dashes, parens, spaces, missing
// country code, etc.) to E.164 — the exact format Sendblue's inbound webhook
// sends numbers in, and what Twilio expects for outbound calls. Without this,
// a number stored in a different format than what Sendblue/Twilio use will
// never match on lookup (see: the contact_verified lookup in sendblue.ts).
// Defaults to US since CoPatible is US-only today. Falls back to the raw
// input if parsing fails, rather than silently discarding a valid submission.
export function normalizePhone(raw: string): string {
  const parsed = parsePhoneNumberFromString(raw, "US");
  return parsed?.isValid() ? parsed.number : raw;
}

// A phone number someone else's system gave us (a Luma guest row: "+1 (415) 555-0123", "415.555.0123",
// "1 415 555 0123"), in the E.164 form users.phone_number is stored in, so a guest is matched however the number was
// typed. normalizePhone first; when that can't validate it (fictional test ranges, odd spacing), the digits with a US
// default. Nothing usable: null, never a guess.
export function matchablePhone(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = normalizePhone(s);
  if (n !== s && /^\+\d{8,15}$/.test(n)) return n;
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+")) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (s.startsWith("00") && d.length >= 10) return `+${d.slice(2)}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}
