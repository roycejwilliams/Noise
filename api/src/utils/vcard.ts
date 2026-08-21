import { CO_ICON_PNG_BASE64 } from "../assets/coIcon.js";

// vCard 3.0 (RFC 2426 section 2.6) folds any physical line longer than 75
// octets: continuation lines start with a single leading space. Needed here
// because the base64 PHOTO line is thousands of characters long — most
// parsers (including Apple's) reject or mishandle an unfolded PHOTO line.
function foldLine(line: string, limit = 75): string {
  if (line.length <= limit) return line;
  const parts: string[] = [line.slice(0, limit)];
  let rest = line.slice(limit);
  while (rest.length > 0) {
    parts.push(" " + rest.slice(0, limit - 1));
    rest = rest.slice(limit - 1);
  }
  return parts.join("\r\n");
}

// Shared by api/src/server.ts and co-test/src/server.ts's /co.vcf routes —
// same contact card in both environments.
export function buildCoVCard(phone: string): string {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Co",
    `TEL:${phone}`,
    "URL:https://app.copatible.com",
    "EMAIL:support@copatible.com",
    "NOTE:A personal AI that gets to know you and helps you move forward with what matters most.",
    `PHOTO;ENCODING=b;TYPE=PNG:${CO_ICON_PNG_BASE64}`,
    "END:VCARD",
  ]
    .map((line) => foldLine(line))
    .join("\r\n");
}
