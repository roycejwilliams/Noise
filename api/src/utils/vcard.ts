import { createHash } from "node:crypto";
import { CO_ICON_PNG_BASE64 } from "../assets/coIcon.js";
import { CUE_MARK_JPEG_BASE64 } from "../assets/cueMark.js";

// Cue's contact card, by version (2026-11-02). Each version is fixed: its fields, the note that goes with it when it is pushed to
// members who hold an older one, and Royce's approval record. The card everyone is served (/co.vcf: onboarding and "send me your
// card") is the newest APPROVED version; a version waiting on approval is never served, never sent, never pushed. Whether a revision
// is needed is decided separately (services/cardReissue.ts decideReissue), and deciding it never approves it.

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

// RFC 2426 text values: backslash, comma, semicolon and newline are escaped.
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\r?\n/g, "\\n");
}

// One UID for Cue's card, for every version, forever: a contact app that matches cards by UID (CardDAV, some Android and desktop
// apps) sees each version as the same contact. iOS Messages does not merge by it: the member taps the card and picks "Add to
// Existing Contact" (see the PR). Never change it.
export const CARD_UID = "urn:uuid:6b86f31c-2764-460b-9f98-984f91f7fa52";

export type PhotoAsset = "co_wordmark_png" | "cue_mark_jpeg";
const PHOTO: Record<PhotoAsset, { type: "PNG" | "JPEG"; base64: string; label: string }> = {
  co_wordmark_png: { type: "PNG", base64: CO_ICON_PNG_BASE64, label: "the pre-rename wordmark, black on white, 256x256 PNG (assets/coIcon.ts)" },
  cue_mark_jpeg: { type: "JPEG", base64: CUE_MARK_JPEG_BASE64, label: '"Cue." mark, paper on claret, 512x512 JPEG (assets/cue-mark-512.jpg, Figma 344:5600)' },
};

// Where a phone number comes from: an env NAME, read when the card is served. The numbers themselves are never in code.
export type PhoneSource = "SENDBLUE_PHONE_NUMBER" | "TWILIO_PHONE_NUMBER";
export type CardPhone = { source: PhoneSource; label?: string; types?: string[] };

// The card's fields, as data: what the diff, the reissue decision and the renderer all read.
export type CardFields = {
  fn: string;
  n?: string;
  org?: string;
  // Never set: Cue is never introduced by a role. Kept in the type so the diff shows it was considered.
  title?: never;
  note: string;
  phones: CardPhone[];
  // Optional: version 2 has neither (Royce, 2026-11-02: the email and homepage aren't set up yet).
  email?: string;
  url?: string;
  photo: PhotoAsset | null;
  uid?: string;
  rev?: string;
};

export type CardApproval = {
  by: "Royce Williams";
  on: string; // YYYY-MM-DD
  // cardSha(version) at approval: any change to the fields or the note after this voids it.
  contentSha: string;
  // The last four digits of each number the card was approved with; a send refuses when the env's number has changed since
  // (a changed number is a contact change: a new version, not a quiet swap).
  telLast4: Partial<Record<PhoneSource, string>>;
  // Where he said yes (the PR comment or message), for the record.
  ref: string;
};

export type CardVersion = {
  version: number;
  fields: CardFields;
  // The words that go with the card when it is pushed (one text, the card attached). Fixed; never model-written.
  memberNote: string | null;
  // Why this revision exists (services/cardReissue.ts ChangeKind), for the record.
  basis: string[];
  // "legacy": served before versions existed (6f4bcc89, 2026-08-21); it is what members hold today. Never pushed.
  approval: CardApproval | "legacy" | null;
};

// ---------------------------------------------------------------- the versions

// Version 1: the card served since 6f4bcc89 (2026-08-21), FN changed to Cue on 2026-10-14. Rendered by its own function below, byte
// for byte as before, so nothing a member is served changes until version 2 is approved.
export const V1: CardVersion = {
  version: 1,
  fields: {
    fn: "Cue",
    note: "A personal AI that gets to know you and helps you move forward with what matters most.",
    phones: [{ source: "SENDBLUE_PHONE_NUMBER" }],
    email: "support@copatible.com",
    url: "https://app.copatible.com",
    photo: "co_wordmark_png",
  },
  memberNote: null,
  basis: [],
  approval: "legacy",
};

// Version 2 (2026-11-02; the card and its note approved by Royce, the send not yet: see the approval below). What changes and why:
//   PHOTO  the "Co." wordmark names an old identity; Royce's redesigned "Cue." mark replaces it (branding).
//   TEL    the calling line is a different number from the texting one (services/capabilities.ts callLine), and calling the texting
//          number doesn't reach Cue; v1 only had the texting number, so Cue's calls showed as an unknown number (contact).
//   N/ORG  the structured name vCard 3.0 requires, and the company it belongs to now, Noise (identity).
//   NOTE   v1 describes "a personal AI" and nothing of what Cue is for now; the proposed line comes from Royce's approved shift copy
//          (services/announcements.ts SHIFT_BODY) (description).
//   UID/REV a stable UID across versions, and the revision date.
//   EMAIL/URL dropped (Royce, 2026-11-02: "The email and homepage aren't set up yet so if we can do without it just move passed it").
export const V2: CardVersion = {
  version: 2,
  fields: {
    fn: "Cue",
    n: ";Cue;;;",
    org: "Noise",
    note: "Knowing what you're in the middle of, and finding the person worth meeting for it.",
    phones: [
      { source: "SENDBLUE_PHONE_NUMBER", label: "Texts", types: ["CELL", "pref"] },
      { source: "TWILIO_PHONE_NUMBER", label: "Calls", types: ["VOICE"] },
    ],
    photo: "cue_mark_jpeg",
    uid: CARD_UID,
    rev: "2026-11-02T00:00:00Z",
  },
  // Approved as written by Royce, 2026-11-02, with the card (one record, below).
  memberNote: "A new card for your contacts, with the number I call from, so it shows as me when I ring. Tap it, then Add to Existing Contact.",
  basis: ["branding", "contact", "identity", "description"],
  // The card and the note, approved. This makes v2 the card /co.vcf serves once deployed. It does NOT approve the push: a run still
  // needs his --approved flag (services/cardReissue.ts sendPermission), and he hasn't given it. The numbers are the co-test lines'
  // last four digits (texting ...8080, calling ...1762); a send refuses if either has changed.
  approval: {
    by: "Royce Williams",
    on: "2026-11-02",
    contentSha: "5ba374a6402d6a9beaf565a7621fa1d36dd01cab9665db5b0c13d5022f0b9123",
    telLast4: { SENDBLUE_PHONE_NUMBER: "8080", TWILIO_PHONE_NUMBER: "1762" },
    ref: "PR #342 decision, relayed by the coordinator 2026-11-02: \"go with your recommendations on the card\"; the member note approved as written",
  },
};

export const CARD_VERSIONS: readonly CardVersion[] = [V1, V2];
export function cardVersion(n: number): CardVersion | null {
  return CARD_VERSIONS.find((v) => v.version === n) ?? null;
}

// ---------------------------------------------------------------- render

export type Phones = Partial<Record<PhoneSource, string | null | undefined>>;
export function phonesFromEnv(env: NodeJS.ProcessEnv = process.env): Phones {
  return { SENDBLUE_PHONE_NUMBER: env.SENDBLUE_PHONE_NUMBER ?? "", TWILIO_PHONE_NUMBER: env.TWILIO_PHONE_NUMBER ?? null };
}

// Version 1, exactly as it was served (the old buildCoVCard body).
function renderV1(phone: string): string {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Cue",
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

// Version 2 on. A number whose env is empty is left off (never a blank TEL). Labels use Apple's grouped X-ABLabel, which other
// apps ignore (they show the TYPE instead).
function renderFields(f: CardFields, phones: Phones): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  if (f.n) lines.push(`N:${f.n}`);
  lines.push(`FN:${escapeText(f.fn)}`);
  if (f.org) lines.push(`ORG:${escapeText(f.org)}`);
  let item = 0;
  for (const p of f.phones) {
    const number = String(phones[p.source] ?? "").trim();
    if (!number) continue;
    const types = (p.types ?? []).map((t) => `;type=${t}`).join("");
    if (p.label) {
      item++;
      lines.push(`item${item}.TEL${types}:${number}`, `item${item}.X-ABLabel:${escapeText(p.label)}`);
    } else {
      lines.push(`TEL${types}:${number}`);
    }
  }
  if (f.email) lines.push(`EMAIL;type=INTERNET:${f.email}`);
  if (f.url) lines.push(`URL:${f.url}`);
  lines.push(`NOTE:${escapeText(f.note)}`);
  if (f.photo) lines.push(`PHOTO;ENCODING=b;TYPE=${PHOTO[f.photo].type}:${PHOTO[f.photo].base64}`);
  if (f.uid) lines.push(`UID:${f.uid}`);
  if (f.rev) lines.push(`REV:${f.rev}`);
  lines.push("END:VCARD");
  return lines.map((line) => foldLine(line)).join("\r\n");
}

export function renderCard(v: CardVersion, phones: Phones): string {
  return v.version === 1 ? renderV1(String(phones.SENDBLUE_PHONE_NUMBER ?? "")) : renderFields(v.fields, phones);
}

// ---------------------------------------------------------------- approval

// What an approval covers: the card as rendered with the numbers left as their env names, and the note that goes with it.
export function cardSha(v: CardVersion): string {
  const card = renderCard(v, { SENDBLUE_PHONE_NUMBER: "{SENDBLUE_PHONE_NUMBER}", TWILIO_PHONE_NUMBER: "{TWILIO_PHONE_NUMBER}" });
  return createHash("sha256").update(card).update("\n--note--\n").update(v.memberNote ?? "").digest("hex");
}
export function isApproved(v: CardVersion): boolean {
  if (v.approval === "legacy") return true;
  return !!v.approval && v.approval.by === "Royce Williams" && /^\d{4}-\d{2}-\d{2}$/.test(v.approval.on) && v.approval.contentSha === cardSha(v);
}
// The numbers it was approved with still the env's numbers. A legacy or unapproved version: false (never pushed).
export function numbersStillApproved(v: CardVersion, phones: Phones): boolean {
  if (!v.approval || v.approval === "legacy") return false;
  const last4 = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "").slice(-4);
  return v.fields.phones.every((p) => {
    const want = v.approval && v.approval !== "legacy" ? v.approval.telLast4[p.source] : undefined;
    return !!want && last4(phones[p.source]) === want;
  });
}

// The card everyone is served: the newest approved version.
export function liveVersion(versions: readonly CardVersion[] = CARD_VERSIONS): CardVersion {
  return [...versions].sort((a, b) => b.version - a.version).find(isApproved) ?? V1;
}

// Shared by api/src/server.ts and co-test/src/server.ts's /co.vcf routes —
// same contact card in both environments.
export function buildCoVCard(phone: string, calls: string | null = process.env.TWILIO_PHONE_NUMBER ?? null): string {
  return renderCard(liveVersion(), { SENDBLUE_PHONE_NUMBER: phone, TWILIO_PHONE_NUMBER: calls });
}

// A version's own card (/cards/v<n>/Cue.vcf), so a push links the exact version it means, past any cache of /co.vcf. Null for a
// version that isn't approved: never served.
export function buildVersionedVCard(n: number, phones: Phones = phonesFromEnv()): string | null {
  const v = cardVersion(n);
  return v && isApproved(v) ? renderCard(v, phones) : null;
}

// ---------------------------------------------------------------- the diff

export const DIFF_FIELDS = ["FN", "N", "ORG", "TITLE", "NOTE", "TEL", "EMAIL", "URL", "PHOTO", "UID", "REV"] as const;
export type DiffField = (typeof DIFF_FIELDS)[number];
// One value per field, as a person reads it (numbers by their env name; the photo by what it is).
export function fieldSummary(f: CardFields): Record<DiffField, string> {
  return {
    FN: f.fn,
    N: f.n ?? "(none)",
    ORG: f.org ?? "(none)",
    TITLE: "(none)",
    NOTE: f.note,
    TEL: f.phones.map((p) => `${p.source}${p.label ? ` "${p.label}"` : ""}${p.types?.length ? ` [${p.types.join(",")}]` : ""}`).join(" + "),
    EMAIL: f.email ?? "(none)",
    URL: f.url ?? "(none)",
    PHOTO: f.photo ? PHOTO[f.photo].label : "(none)",
    UID: f.uid ?? "(none)",
    REV: f.rev ?? "(none)",
  };
}
export function cardDiff(a: CardVersion, b: CardVersion): { field: DiffField; from: string; to: string; changed: boolean }[] {
  const x = fieldSummary(a.fields), y = fieldSummary(b.fields);
  return DIFF_FIELDS.map((field) => ({ field, from: x[field], to: y[field], changed: x[field] !== y[field] }));
}
