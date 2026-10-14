// Co never stops trying to understand them (Royce, 2026-09-28: "Co should
// never stop trying to understand our user. More proactive on how it can
// help"). Two things were missing:
//
// Knowledge went stale silently. A topic counted as covered forever, so what
// someone was "in the middle of" in September would still read as known in
// March. Now what changes fast (what's going on, goals, what they want) is
// worth catching up on after about five weeks; who they are and where they're
// headed after about four months.
//
// Co only learned when they texted first. A member who went quiet (Jacqueline
// skipped the call and sent four practical texts) taught Co nothing, and Co
// never reached out to learn. The companion check-in now carries one gap to
// be curious about, or one concrete way Co could help, when there's no open
// thread to ask about.
//
// Dependency-free, so model-free checks can read it.
import { RAPPORT_TOPIC_DESCRIPTIONS, RAPPORT_TOPICS, type RapportTopic } from "./profileTopics.js";

const DAY = 24 * 60 * 60 * 1000;

// How long what they said about each topic stays current.
export const STALE_AFTER_DAYS: Record<RapportTopic, number> = {
  current_situation: 35,
  goals_challenges: 35,
  looking_for: 35,
  location_availability: 60,
  people_to_meet: 60,
  major_transition: 60,
  ways_to_help: 120,
  personality: 120,
  boundaries_preferences: 120,
  long_term_direction: 120,
};

// Don't ask about the same topic again within this many days, whether or not
// they answered.
export const ASK_AGAIN_AFTER_DAYS = 14;

// What to be curious about first: what's going on for them before who they'd
// like to meet.
export const CURIOSITY_ORDER: RapportTopic[] = [
  "current_situation",
  "goals_challenges",
  "looking_for",
  "major_transition",
  "long_term_direction",
  "people_to_meet",
  "ways_to_help",
  "location_availability",
  "personality",
  "boundaries_preferences",
];

export type Gap = { topic: RapportTopic; kind: "unknown" | "stale"; lastHeard: string | null };

const ageDays = (iso: string | undefined, now: Date) => (iso ? (now.getTime() - new Date(iso).getTime()) / DAY : Infinity);

// Every topic Co doesn't know, or knew long enough ago that it may have
// changed, and hasn't asked about lately. Unknown before stale, then by order.
export function understandingGaps(
  covered: Partial<Record<string, string>> | null | undefined,
  asked: Partial<Record<string, string>> | null | undefined,
  now = new Date(),
): Gap[] {
  const gaps: Gap[] = [];
  for (const topic of CURIOSITY_ORDER) {
    if (ageDays(asked?.[topic] ?? undefined, now) < ASK_AGAIN_AFTER_DAYS) continue;
    const heard = covered?.[topic] ?? undefined;
    if (!heard) gaps.push({ topic, kind: "unknown", lastHeard: null });
    else if (ageDays(heard, now) >= STALE_AFTER_DAYS[topic]) gaps.push({ topic, kind: "stale", lastHeard: heard.slice(0, 10) });
  }
  return [...gaps.filter((g) => g.kind === "unknown"), ...gaps.filter((g) => g.kind === "stale")];
}

// How the gap reads to Co.
export function gapDescription(g: Gap): string {
  const what = RAPPORT_TOPIC_DESCRIPTIONS[g.topic];
  return g.kind === "stale" ? `what's changed with ${what} (Cue last heard about it on ${g.lastHeard}, so it may be different now)` : what;
}

// Nothing new learned about them in this long reads as Co no longer paying
// attention (the morning review counts these).
export const QUIET_UNDERSTANDING_DAYS = 21;

export function lastLearned(covered: Partial<Record<string, string>> | null | undefined): string | null {
  const all = Object.values(covered ?? {}).filter((v): v is string => typeof v === "string").sort();
  return all.length ? all[all.length - 1] : null;
}

export { RAPPORT_TOPICS };
