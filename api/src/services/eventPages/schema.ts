// A hosted event page as data (Royce, 2026-10-10: "The agent fills this as data (JSON), never freeform prose"; "no markdown
// blobs rendered into the page, every section is a field"). Co fills these fields; the template (template.ts) is the only thing
// that turns them into HTML. Every field is one plain line of text, length-capped, with no markdown, no HTML and no links, and
// this file is the only gate: the store refuses anything that hasn't passed it, and the page re-checks what it loads.
//
// Shared contract with the interaction layer: the names here (EventPageData, parseEventPageData) and the field names are fixed.

export type ScheduleBlock = { time: string; label: string; detail: string | null };

export type EventPageData = {
  title: string;
  // ISO 8601 with an explicit offset ("2026-10-24T19:30:00-07:00" or "...Z").
  startsAt: string;
  endsAt: string | null;
  // IANA zone the page shows times in ("America/Los_Angeles").
  timezone: string;
  venueName: string;
  address: string | null;
  schedule: ScheduleBlock[];
  whatToBring: string[];
  // Each one plain line.
  notes: string[];
  // "Hosted by Co", "Noor and Ellis invite you".
  hostLine: string | null;
  // Only for the link preview (og:image). https only.
  imageUrl: string | null;
};

export const EVENT_PAGE_LIMITS = {
  title: 80,
  venueName: 80,
  address: 160,
  hostLine: 100,
  timezone: 64,
  scheduleTime: 24,
  scheduleLabel: 80,
  scheduleDetail: 200,
  scheduleBlocks: 12,
  bringItem: 80,
  bringItems: 10,
  note: 240,
  notes: 8,
  imageUrl: 500,
} as const;

const KEYS = ["title", "startsAt", "endsAt", "timezone", "venueName", "address", "schedule", "whatToBring", "notes", "hostLine", "imageUrl"] as const;
const BLOCK_KEYS = ["time", "label", "detail"] as const;

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// What makes a line not plain text. Checked in this order, first hit named.
const NOT_PLAIN: { test: RegExp; why: string }[] = [
  { test: /[\u0000-\u0008\u000B-\u001F\u007F]/, why: "has control characters" },
  { test: /[\r\n]/, why: "has a line break (each field is one line; use another list item)" },
  { test: /<\s*\/?\s*[a-z!?]|<|>/i, why: "has HTML or angle brackets" },
  { test: /&(#\d+|#x[0-9a-f]+|[a-z]+);/i, why: "has an HTML entity" },
  { test: /\bhttps?:\/\/|\bwww\.\S/i, why: "has a link (links aren't a field)" },
  { test: /\*\*|__|~~|`/, why: "has markdown emphasis or code" },
  { test: /\[[^\]]*\]\([^)]*\)/, why: "has a markdown link" },
  { test: /^\s*(#{1,6}\s|[-*+]\s|>\s|\d+[.)]\s)/, why: "starts with a markdown heading, bullet or number" },
  { test: /[—]/, why: "has an em dash (Co doesn't use them)" },
  { test: /!/, why: "has an exclamation point (Co doesn't use them)" },
];

function plain(v: unknown, field: string, max: number, problems: string[], required: boolean): string | null {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) problems.push(`${field} is required`);
    return null;
  }
  if (typeof v !== "string") {
    problems.push(`${field} must be text`);
    return null;
  }
  const s = v.replace(/[ \t]+/g, " ").trim();
  const bad = NOT_PLAIN.find((p) => p.test.test(s));
  if (bad) {
    problems.push(`${field} ${bad.why}`);
    return null;
  }
  if (s.length > max) {
    problems.push(`${field} is ${s.length} characters; the most is ${max}`);
    return null;
  }
  return s;
}

function list(v: unknown, field: string, maxItems: number, problems: string[]): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    problems.push(`${field} must be a list`);
    return [];
  }
  if (v.length > maxItems) problems.push(`${field} has ${v.length} items; the most is ${maxItems}`);
  return v.slice(0, maxItems);
}

function instant(v: unknown, field: string, problems: string[], required: boolean): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) problems.push(`${field} is required`);
    return null;
  }
  if (typeof v !== "string" || !ISO_WITH_OFFSET.test(v.trim()) || Number.isNaN(Date.parse(v.trim()))) {
    problems.push(`${field} must be an ISO date and time with its offset, like 2026-10-24T19:30:00-07:00`);
    return null;
  }
  return v.trim();
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz);
  } catch {
    return false;
  }
}

function image(v: unknown, problems: string[]): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > EVENT_PAGE_LIMITS.imageUrl) {
    problems.push(`imageUrl must be an https link of at most ${EVENT_PAGE_LIMITS.imageUrl} characters`);
    return null;
  }
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" || u.username || u.password || /["'<>\s]/.test(v.trim())) throw new Error("not plain https");
    return u.toString();
  } catch {
    problems.push("imageUrl must be a plain https link");
    return null;
  }
}

// The one gate. Unknown keys are refused, not dropped, so a field the template doesn't have can't ride along unseen.
export function parseEventPageData(input: unknown): { ok: true; data: EventPageData } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, problems: ["an event page must be an object of fields"] };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(KEYS as readonly string[]).includes(k)) problems.push(`unknown field ${k}`);
  const L = EVENT_PAGE_LIMITS;

  const title = plain(o.title, "title", L.title, problems, true);
  const startsAt = instant(o.startsAt, "startsAt", problems, true);
  const endsAt = instant(o.endsAt, "endsAt", problems, false);
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) problems.push("endsAt must be after startsAt");
  const timezone = plain(o.timezone, "timezone", L.timezone, problems, true);
  if (timezone && !validTimeZone(timezone)) problems.push(`timezone ${timezone} isn't an IANA zone like America/Los_Angeles`);
  const venueName = plain(o.venueName, "venueName", L.venueName, problems, true);
  const address = plain(o.address, "address", L.address, problems, false);
  const hostLine = plain(o.hostLine, "hostLine", L.hostLine, problems, false);
  const imageUrl = image(o.imageUrl, problems);

  const schedule: ScheduleBlock[] = [];
  list(o.schedule, "schedule", L.scheduleBlocks, problems).forEach((b, i) => {
    if (!b || typeof b !== "object" || Array.isArray(b)) return void problems.push(`schedule[${i}] must be {time, label, detail}`);
    const r = b as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!(BLOCK_KEYS as readonly string[]).includes(k)) problems.push(`schedule[${i}] has unknown field ${k}`);
    const time = plain(r.time, `schedule[${i}].time`, L.scheduleTime, problems, true);
    const label = plain(r.label, `schedule[${i}].label`, L.scheduleLabel, problems, true);
    const detail = plain(r.detail, `schedule[${i}].detail`, L.scheduleDetail, problems, false);
    if (time && label) schedule.push({ time, label, detail });
  });
  const whatToBring = list(o.whatToBring, "whatToBring", L.bringItems, problems)
    .map((s, i) => plain(s, `whatToBring[${i}]`, L.bringItem, problems, true))
    .filter((s): s is string => !!s);
  const notes = list(o.notes, "notes", L.notes, problems)
    .map((s, i) => plain(s, `notes[${i}]`, L.note, problems, true))
    .filter((s): s is string => !!s);

  if (problems.length) return { ok: false, problems };
  return { ok: true, data: { title: title!, startsAt: startsAt!, endsAt, timezone: timezone!, venueName: venueName!, address, schedule, whatToBring, notes, hostLine, imageUrl } };
}
