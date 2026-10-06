// What Co believes about a member, as claims with a label and a lifetime (Royce, 2026-10-06).
//
// Why: the nightly recap used to REVISE its own previous recap, so "preparing to pitch investors Friday" (said 9/29, for Friday
// 10/2) survived every night's revision until the 10/6 post-call text stated it back. Nothing ever expired it, and nothing said
// whether it was something they said or something Co made of it.
//
// Two labels on every claim:
//   provenance  user_said    they said it, and the claim carries their own words (a quote that is verifiably in what they sent)
//               co_inferred  Co concluded it: it can orient a draft, but is never stated back as "you told me" or "you've been prepping"
//   lifetime    enduring     who they are: what they're building, their city, their cofounder. Persists.
//               ephemeral    plans, deadlines, moods, explorations, worries, pending decisions. Expires on its own, in code,
//                            unless they say it again (re-confirmed) or it is dated, in which case it ends the day after the date.
// The model proposes a claim and its kind; CODE decides the lifetime from the kind, checks the quote is theirs (else the claim is
// downgraded to co_inferred), and resolves a relative day against when it was said.
import { DateTime } from "luxon";

export type Provenance = "user_said" | "co_inferred";
export type Lifetime = "enduring" | "ephemeral";

// kind -> lifetime, and how long an undated ephemeral claim lasts (days from when it was said or last re-confirmed).
export const KINDS = {
  identity: { lifetime: "enduring" },
  building: { lifetime: "enduring" },
  relationship: { lifetime: "enduring" },
  city: { lifetime: "enduring" },
  role: { lifetime: "enduring" },
  preference: { lifetime: "enduring" },
  plan: { lifetime: "ephemeral", ttlDays: 7 },
  deadline: { lifetime: "ephemeral", ttlDays: 3 },
  meeting: { lifetime: "ephemeral", ttlDays: 3 },
  mood: { lifetime: "ephemeral", ttlDays: 3 },
  exploring: { lifetime: "ephemeral", ttlDays: 10 },
  worry: { lifetime: "ephemeral", ttlDays: 10 },
  pending_decision: { lifetime: "ephemeral", ttlDays: 14 },
} as const;
export type Kind = keyof typeof KINDS;
export const KIND_LIST = Object.keys(KINDS) as Kind[];
// What Co concluded, rather than heard, decays faster than what they said.
export const INFERRED_MAX_DAYS = 7;

export type Claim = {
  text: string;
  provenance: Provenance;
  kind: Kind;
  quote: string | null;
  saidOn: string; // YYYY-MM-DD
  confirmedOn: string; // YYYY-MM-DD, last time they said it again
  expiresOn: string | null; // YYYY-MM-DD, null for enduring
};

const norm = (s: string) => ` ${String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;

// A user_said claim must carry their words, and the words must really be in what they sent. Otherwise it is Co's inference.
export function checkProvenance(p: Provenance, quote: string | null | undefined, theirText: string): { provenance: Provenance; quote: string | null } {
  const q = (quote ?? "").trim();
  if (p === "user_said" && q.length >= 8 && norm(theirText).includes(norm(q))) return { provenance: "user_said", quote: q };
  return { provenance: "co_inferred", quote: null };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// The date a claim is about, if its words name one, resolved against the day it was said ("Friday", said on a Tuesday, is the
// coming Friday; "Oct 9"; "2026-10-09"; "tomorrow"). Null when it names none.
export function resolveDate(words: string, saidOn: string, zone = "America/Los_Angeles"): string | null {
  const said = DateTime.fromISO(saidOn, { zone }).startOf("day");
  if (!said.isValid) return null;
  const t = words.toLowerCase();
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const md = t.match(new RegExp(`\\b(${MONTHS.map((m) => m.slice(0, 3)).join("|")})[a-z]*\\.?\\s+(\\d{1,2})\\b`));
  if (md) {
    const month = MONTHS.findIndex((m) => m.startsWith(md[1])) + 1;
    let d = DateTime.fromObject({ year: said.year, month, day: Number(md[2]) }, { zone });
    if (d.isValid && d < said.minus({ days: 1 })) d = d.plus({ years: 1 });
    if (d.isValid) return d.toISODate();
  }
  if (/\btomorrow\b/.test(t)) return said.plus({ days: 1 }).toISODate();
  if (/\b(today|tonight)\b/.test(t)) return said.toISODate();
  const wd = t.match(new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`));
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1]); // 0 = sunday
    const have = said.weekday % 7;
    const ahead = (target - have + 7) % 7; // the same weekday means today
    return said.plus({ days: ahead }).toISODate();
  }
  return null;
}

// When a claim ends. Enduring: never. A dated claim ends the day after its date. An undated ephemeral claim ends its kind's ttl
// after it was last said, and what Co only inferred ends sooner. Saying it again moves the clock.
export function expiresOn(c: { kind: Kind; provenance: Provenance; text: string; quote: string | null; saidOn: string; confirmedOn: string }, zone = "America/Los_Angeles"): string | null {
  const k = KINDS[c.kind];
  if (k.lifetime === "enduring") return null;
  const dated = resolveDate(`${c.text} ${c.quote ?? ""}`, c.saidOn, zone);
  if (dated) return DateTime.fromISO(dated, { zone }).plus({ days: 1 }).toISODate();
  const ttl = Math.min((k as { ttlDays: number }).ttlDays, c.provenance === "co_inferred" ? INFERRED_MAX_DAYS : 365);
  return DateTime.fromISO(c.confirmedOn, { zone }).plus({ days: ttl }).toISODate();
}

export function isLive(c: { expiresOn: string | null }, now: Date, zone = "America/Los_Angeles"): boolean {
  if (!c.expiresOn) return true;
  return DateTime.fromJSDate(now).setZone(zone).startOf("day") < DateTime.fromISO(c.expiresOn, { zone }).startOf("day");
}

// The same claim said again (same kind, mostly the same words): it is re-confirmed, not a new claim.
export function sameClaim(a: { kind: Kind; text: string }, b: { kind: Kind; text: string }): boolean {
  if (a.kind !== b.kind) return false;
  const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length >= 4));
  const x = words(a.text), y = words(b.text);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

// What a recap or a draft is allowed to hold: only live claims, labelled. Expired ones are gone, not carried.
export function renderLive(claims: (Claim & { id?: string })[], now: Date, zone = "America/Los_Angeles"): { theySaid: string[]; coInferred: string[]; enduring: string[] } {
  const live = claims.filter((c) => isLive(c, now, zone));
  const fmt = (c: Claim) => {
    const day = DateTime.fromISO(c.saidOn, { zone }).toFormat("LLL d");
    const until = c.expiresOn ? `, until ${DateTime.fromISO(c.expiresOn, { zone }).minus({ days: 1 }).toFormat("LLL d")}` : "";
    return `${c.text} (${c.provenance === "user_said" ? `they said, ${day}` : `Co's read, ${day}`}${until})`;
  };
  return {
    enduring: live.filter((c) => c.kind && KINDS[c.kind].lifetime === "enduring" && c.provenance === "user_said").map(fmt),
    theySaid: live.filter((c) => KINDS[c.kind].lifetime === "ephemeral" && c.provenance === "user_said").map(fmt),
    coInferred: live.filter((c) => c.provenance === "co_inferred").map(fmt),
  };
}
