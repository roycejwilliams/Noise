// Away from home (Jacqueline, 2026-10-11 08:58: "Right now imt raveling but interested when im back in sf"). Her snapshot said
// "currently traveling", and tasks 164 and 165 kept looking for San Francisco events and rooms on their own clocks, with sends
// scheduled. Nothing in code knew she was away: services/memberTime.ts says it outright ("The city on file is the only travel
// signal; there is no travel detection").
//
// Judgment-light, by design: their own words saying they're away ("I'm traveling", "out of town", "when I'm back", "away until
// the 20th") are a fact, written the moment they say it as a claim of its own kind ("away", services/factLabels.ts), with its
// own lifetime: until the day they named, else a week from when they said it, renewed when they say it again, and ended the
// moment they say they're back. While it holds, finds tied to where they live wait:
//   - dispatch holds event offers and in-room nudges (harness/proactive.ts candidateChecks, "away_hold"), and a goal's discovery
//     sweep doesn't run (SWEEP_BLOCKERS), so nothing piles up to send the day they land;
//   - a task's text that carries an event it found is refused with a note to look again once they're back (services/taskTurn.ts).
// Nothing else changes: Co still talks with them, answers them, and sends what isn't tied to a place (a role, a document).
// Pure, except noteAwayFromText (injectable db).
import { DateTime } from "luxon";
import { expiresOn, isLive, resolveDate, type Claim } from "./factLabels.js";
import { FALLBACK_ZONE } from "./localHours.js";

export type AwayState = { until: string | null; quote: string | null; text: string };

const flat = (t: string) => String(t ?? "").replace(/[’‘]/g, "'");

// First person, now, in real travel words (review of #140: "when I get back from the gym", "back to back with meetings" and a trip
// on Friday all started a week's hold; when it's unclear, nothing is held, since holding wrongly keeps a member out of rooms):
//   "I'm traveling" (and "imt raveling", her own typo), "I'm out of town", "I'm on a trip / vacation", "I'm abroad",
//   "away until ...", "when I'm back in SF" / "back home" / "back from my trip", "I'll be back in SF on the 20th".
// Never "I'm away" alone, never "back from" an errand, never a trip still ahead.
const PLACE_BACK = String.raw`(?:in (?:town|sf|the city|the bay|(?!(?:the |my )?(?:office|gym|studio|class|school|loop|room|meeting|game|swing|saddle)\b)[a-z][a-z.'-]{1,20}(?: [a-z][a-z.'-]{1,20})?)|home|to (?:town|sf|the city)|from (?:my |the |a |this )?(?:trip|travels|travel|vacation|holiday|honeymoon))`;
const AWAY: RegExp[] = [
  /\b(?:i'?m|i am|im|we'?re|we are)\s*(?:currently\s+|still\s+|actually\s+|now\s+)?t?\s*ravel{1,2}ing\b/i,
  /\b(?:i'?m|i am|im|we'?re|we are)\s+(?:currently\s+|still\s+|actually\s+|now\s+)?(?:out of town|on (?:a |my )?(?:trip|vacation|holiday|work trip)|abroad|overseas|out of the country)\b/i,
  new RegExp(String.raw`\b(?:when|once|after|until|till) (?:i'?m|i am|im|i get|we'?re|we get) back ${PLACE_BACK}`, "i"),
  /\b(?:away|traveling|travelling|out of town) (?:until|till|through|thru)\b/i,
  new RegExp(String.raw`\b(?:i'?ll|i will|i'?m|im) (?:be )?back ${PLACE_BACK} (?:on|by|next|this|the|around)\b`, "i"),
  // Without the "I'm": "out of town for the weekend", "back in SF on Sunday" (a return date says they're away until then).
  /(?:^|[.!?,]\s*)(?:out of town|t?ravel{1,2}ing|on (?:a |my )?(?:trip|vacation|holiday))(?=\s*(?:$|[.!?,]|(?:until|till|through|thru|for|right now|now|at the moment|in|this)\b))/i,
  new RegExp(String.raw`\bback (?:in (?:town|sf|the city|the bay)|home|to (?:town|sf|the city)) (?:on|by|around)\b`, "i"),
];
// A trip still ahead ("traveling to LA tomorrow", "traveling on Friday", "out of town next week", "this weekend" said midweek): not
// away now. "until tomorrow" is the date it ends, and stays away.
const WEEKDAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
const NOT_NOW = new RegExp(String.raw`\baway from (?:my|the) (?:desk|phone|computer|laptop|keyboard)\b|\b(?:traveling|travelling|out of town|on (?:a |my )?trip|leaving|flying)\s+(?:to [a-z .'-]{1,20}?\s+)?(?:next (?:week|month|weekend)|tomorrow|later (?:this|today)|starting|soon|on ${WEEKDAY}|on the \d|in \d+ days|in a (?:few days|week))\b`, "i");
const NOT_AWAY = /\b(?:not|no longer|done|finished)\s+(?:traveling|travelling|away|out of town)\b|\b(?:i'?m|im|i am) not (?:away|traveling)\b/i;
// "for the weekend" / "this weekend": ends that Sunday when said Friday to Sunday; said earlier in the week, it's still ahead.
const WEEKEND = /\b(?:for|this|over) the weekend\b|\bthis weekend\b/i;
// Back: "I'm back", "just got back", "back in SF", "home now". Never "back to work", "back to back", "back on track".
const BACK = /\b(?:i'?m|im|i am|just got|got|finally|we'?re)\s+back\b(?!\s+(?:to (?:back|work|it|normal|the grind|school|you)|on (?:track|it)|at it|and forth|from (?:the |my )?(?:gym|lunch|work|class|office|run|walk|meeting|errands?|store|dinner|coffee)))|^\s*back (?:in|home)\b|\b(?:i'?m|im) home now\b/i;

// Pure: what their words say about being away, or null. A date they named ("until the 20th", "back Sunday") becomes `until`.
export function awayFromWords(text: string, saidOn: string, zone: string = FALLBACK_ZONE): AwayState | null {
  const t = flat(text);
  if (NOT_AWAY.test(t) || NOT_NOW.test(t)) return null;
  const hit = AWAY.map((re) => t.match(re)).find(Boolean);
  if (!hit) return null;
  // The words after "until / back ... on", read for a date.
  const tail = t.match(/\b(?:until|till|through|thru|back(?: in [a-z .'-]{1,24}?| home)? (?:on|by|around)?)\s+([^.!?\n]{1,40})/i)?.[1] ?? "";
  let until = tail ? dateFrom(tail, saidOn, zone) : null;
  if (!until && WEEKEND.test(t)) {
    const said = DateTime.fromISO(saidOn, { zone });
    // Friday (5), Saturday (6), Sunday (7): this weekend's Sunday. Earlier in the week the weekend is still ahead: not away now.
    if (said.weekday < 5) return null;
    until = said.plus({ days: 7 - said.weekday }).toISODate();
  }
  const quote = quoteAround(t, hit.index ?? 0, hit[0].length);
  return { until, quote, text: until ? `They're away from home (traveling) until ${until}.` : "They're away from home right now (traveling)." };
}

// Pure: they said they're back (and nothing in the same words says they're away).
export function backFromWords(text: string): boolean {
  const t = flat(text);
  return BACK.test(t) && !AWAY.some((re) => re.test(t));
}

// "the 20th", "20th" (the next such day), or anything resolveDate reads (a month and day, a weekday, tomorrow).
function dateFrom(words: string, saidOn: string, zone: string): string | null {
  const nth = words.match(/^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (nth) {
    const said = DateTime.fromISO(saidOn, { zone });
    let d = said.set({ day: Number(nth[1]) });
    if (!d.isValid || d < said) d = said.plus({ months: 1 }).set({ day: Number(nth[1]) });
    return d.isValid ? d.toISODate() : null;
  }
  return resolveDate(words, saidOn, zone);
}

// Their own words around the match (at least 8 characters, so the claim is user_said, services/factLabels.ts checkProvenance).
function quoteAround(t: string, at: number, len: number): string {
  const start = Math.max(0, t.lastIndexOf(" ", Math.max(0, at - 12)) + 1);
  const end = Math.min(t.length, at + len + 40);
  return t.slice(start, end).replace(/\s+\S*$/, (m) => (end === t.length ? m : "")).trim().slice(0, 120);
}

// Pure: the claim it is stored as. Its lifetime is the claim machinery's: the day after `until`, else the kind's week.
export function awayClaim(a: AwayState, saidOn: string, zone: string = FALLBACK_ZONE): Claim {
  const base = { text: a.text, provenance: "user_said" as const, kind: "away" as const, quote: a.quote, saidOn, confirmedOn: saidOn };
  return { ...base, expiresOn: expiresOn(base, zone) };
}

// Pure: the away state from held claims (live only), or null.
// Only their own words count (review of #140): a claim Co inferred, or one a rebuild wrote, never holds anything. Code writes the one
// away claim from their latest statement (noteAwayFromText replaces it), and the nightly model read can't propose one.
export function awayFromClaims(claims: { kind: string; text: string; quote: string | null; expiresOn: string | null; provenance?: string | null }[], now: Date, zone: string = FALLBACK_ZONE): AwayState | null {
  const c = claims.find((x) => x.kind === "away" && x.provenance === "user_said" && !!x.quote && isLive({ expiresOn: x.expiresOn }, now, zone));
  if (!c) return null;
  const until = c.text.match(/until (\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  return { until, quote: c.quote, text: c.text };
}

// What waits while they're away: finds that bring them into a room where they live. Not answers about a place they're visiting
// (no such type exists yet), not intros, not check-ins, not documents.
export const LOCATION_BOUND_TYPES: ReadonlySet<string> = new Set(["event_offer", "event_match_nudge"]);
// Pure: whether a candidate waits while they're away. Only Co-initiated, place-bound discovery (review of #140): an answer to their
// own ask ("I'm in NYC, any founder dinners this week?") always goes, wherever it is, because they asked. The member's home city
// isn't on the dispatch state, so a profile find in another city waits too; that errs toward quiet for discovery only.
export function awayHoldsCandidate(c: { type: string; payload?: unknown }): boolean {
  if (!LOCATION_BOUND_TYPES.has(c.type)) return false;
  const p = (c.payload ?? {}) as { askId?: string | null; fromProfile?: boolean };
  const answersTheirAsk = c.type === "event_offer" && !!p.askId && p.askId !== "profile" && p.fromProfile !== true;
  return !answersTheirAsk;
}
// Pure: whether a task's find waits. Only a look-out Co started on its own word; what they asked for (an ask task, a look-out they
// requested) and what Co promised them (#131's owed deliveries) always go.
export function awayHoldsTask(t: { source?: string | null; lookoutOrigin?: string | null }): boolean {
  return t.source === "lookout" && t.lookoutOrigin !== "member";
}
export const awayHoldReason = (a: AwayState) => `they said they're away${a.until ? ` until ${a.until}` : ""}${a.quote ? ` ("${a.quote.slice(0, 80)}")` : ""}; finds tied to where they live wait until they're back`;

// The words a task gets when a text carrying a find is refused.
export function awayTaskNote(a: AwayState): string {
  return `Held, not sent: ${awayHoldReason(a)}. Note what you found and schedule your next look for ${a.until ? `the day after ${a.until}` : "about a week from now"}, or close the task if it was only for now.`;
}

// ---------------------------------------------------------------- written the moment they say it
type Client = { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }>; release?: () => void };
type Db = { connect: () => Promise<Client> };

// Away: their one away claim replaced with this one. Back: it's removed. Under the claims table's own lock (services/claims.ts
// refreshClaims takes the same one), so the nightly rewrite never races it; the nightly rewrite keeps it, since it merges what's held.
export async function noteAwayFromText(db: Db, userId: string, text: string, now = new Date(), zone: string | null = null): Promise<"away" | "back" | null> {
  const z = zone ?? FALLBACK_ZONE;
  const saidOn = DateTime.fromJSDate(now).setZone(z).toISODate()!;
  const away = awayFromWords(text, saidOn, z);
  const back = !away && backFromWords(text);
  if (!away && !back) return null;
  const client = await db.connect();
  try {
    await client.query("BEGIN", []);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('member_claims:' || $1))`, [userId]);
    await client.query(`DELETE FROM member_claims WHERE user_id = $1 AND kind = 'away'`, [userId]);
    if (away) {
      const c = awayClaim(away, saidOn, z);
      await client.query(
        `INSERT INTO member_claims (user_id, text, provenance, kind, quote, said_on, confirmed_on, expires_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [userId, c.text, c.provenance, c.kind, c.quote, c.saidOn, c.confirmedOn, c.expiresOn],
      );
    }
    await client.query("COMMIT", []);
    return away ? "away" : "back";
  } catch (err) {
    await client.query("ROLLBACK", []).catch(() => {});
    throw err;
  } finally {
    client.release?.();
  }
}
