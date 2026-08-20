// Standard SMS opt-out/opt-in keywords (matching the CTIA/carrier-recognized
// set, not just "STOP") — checked as the ENTIRE trimmed message, not a
// substring, so "let's stop for today" doesn't unsubscribe someone.
const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN_KEYWORDS = new Set(["START", "UNSTOP", "SUBSCRIBE"]);

export function isOptOutKeyword(content: string): boolean {
  return OPT_OUT_KEYWORDS.has(content.trim().toUpperCase());
}

export function isOptInKeyword(content: string): boolean {
  return OPT_IN_KEYWORDS.has(content.trim().toUpperCase());
}
