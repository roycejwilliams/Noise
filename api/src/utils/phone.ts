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
