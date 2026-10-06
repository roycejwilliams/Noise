// What the call brain is handed besides the prompt (Royce, 2026-10-06, after the first ElevenLabs call):
//   - a capability sheet: what Co can actually do today (so it stops refusing things Co supports, and stops promising what it can't)
//   - the clock: what time and day it is for them right now (so it never calls tomorrow's event "tonight")
//   - what Co has found for them, prefetched while the phone rings (so no tool call, no pause, mid-conversation)
// The sheet is static and lives in the agent's prompt (cached). The clock and the finds are per call, and ride in as dynamic variables.
import { DateTime } from "luxon";
import { timelineFor } from "./timeline.js";
import { voiceFinds, type VoiceFinds } from "./voiceFinds.js";
import pool from "../db/db.js";

// One page. Written from services/capabilities.ts; every line is something Co does today or something it must not promise.
export const CAPABILITY_SHEET = `# What Co can do today (this is the whole list; never refuse what is on it, never promise what is not)

Finding things:
- Co finds events (its own Co events first, then the public SF feed), communities, and open programs or calls, and can search the web and X for fresh announcements. What it has found for them right now is under "What Co has found for them" below.
- Co can save something they want found, and its daily search keeps looking and texts them when something real fits (at most one text a day). It can list what it's keeping an eye out for, and stop suggesting a kind of thing they don't want.
- Co sends finds as links by text, with a short caption. On a call, offer to text the link; don't read a link out.

Working over days (by text):
- When they ask for something that takes more than one reply (lining up options, a venue by Friday, sponsors, getting ready for a pitch, comparing a few choices), Co takes it on as its own task, works on it over the following days (up to 30), and texts them what it finds, at most one text per task per day. It can write an email for them to send, or a one-page plan.
- Say yes to this on a call. Right after you hang up, Co sets up what they asked for as a task from their own words and works on it over the following days, texting what it finds. Say so: "I'll set that up when we hang up and text you what I find." Never say this is "not how I work", and never promise what it will find or when.
- After a call, Co does look into what you said you'd look into (events, communities, openings) and texts what it found, or says plainly that nothing good enough turned up.

People:
- Introductions go out as one email to both people, only after both say yes. Co can point someone toward another guest at a Co event. Co never starts a group text.
- Co can't find investors, sponsors or funders on demand, and can't promise to find a particular kind of advisor or mentor. It can keep that on file and look for events and rooms where such people show up. Say that, not "I'll find you an advisor".

Check-ins and calls:
- Co checks in by text every few days when it has something real to say. It can't promise a daily message, a time, or encouragement on a schedule. They can ask by text for a call and Co can schedule it.

Never:
- Never say when something happens unless it is in "What Co has found" or in what you know about them, with its day. Never invent an event, a time, a place or who will be there.
- Never ask for something you already know (their city, when they're free, what they're building, who their cofounder is, what they told you last time): say what you have and ask if it's still right ("You told me weekends, is that still true?"). Anything under "what you already know" below is known.`;

export function renderFinds(f: VoiceFinds): string {
  if (!f.available) return `Nothing to offer right now (${f.reason}). Don't offer an event; if they ask what's on, say you'll look after the call.`;
  const lines = f.items.map((i) => `- ${i.name}${i.starts ? ` | starts ${i.starts}` : ""}${i.details.length ? ` | ${i.details.join(" ")}` : ""}${i.link ? " | link on file (offer to text it)" : ""}`);
  return `${f.note}\nLooking for: ${f.lookingFor}\n${lines.join("\n")}`.slice(0, 2400);
}

export type CallBriefing = { rightNow: string; findsNow: string };

// Built while the phone rings (outbound) or alongside the context (inbound). Each part fails to a safe line, never to a guess.
export async function buildCallBriefing(userId: string, now: Date = new Date()): Promise<CallBriefing> {
  const { rows } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const city: string | null = rows[0]?.city ?? null;
  const [clock, finds] = await Promise.all([
    timelineFor(userId, city, now).catch(() => null),
    voiceFinds(userId, now).catch((): VoiceFinds => ({ available: false, reason: "the lookup didn't load" })),
  ]);
  const rightNow = clock
    ? `${clock.fact}${clock.note ? ` ${clock.note}` : ""} "Tonight" and "today" mean the hours left before they sleep; an event is only "tonight" if its start below says today.`
    : `It is ${DateTime.fromJSDate(now).setZone("America/Los_Angeles").toFormat("cccc, LLLL d, h:mm a")} Pacific. Don't assume that is their local time.`;
  return { rightNow, findsNow: renderFinds(finds) };
}

// Kept for 5 minutes per member, like the context (services/elevenLabsCalls.ts): outbound builds it while it rings.
const TTL_MS = 5 * 60 * 1000;
const prebuilt = new Map<string, { at: number; briefing: Promise<CallBriefing> }>();
const fallback = (now = new Date()): CallBriefing => ({ rightNow: `It is ${DateTime.fromJSDate(now).setZone("America/Los_Angeles").toFormat("cccc, LLLL d, h:mm a")} Pacific. Don't assume that is their local time.`, findsNow: "Nothing to offer right now. Don't offer an event; if they ask what's on, say you'll look after the call." });
export function prebuildCallBriefing(userId: string, now = Date.now()): void {
  prebuilt.set(userId, { at: now, briefing: buildCallBriefing(userId, new Date(now)).catch(() => fallback()) });
}
export async function takeCallBriefing(userId: string, now = Date.now()): Promise<CallBriefing> {
  const hit = prebuilt.get(userId);
  prebuilt.delete(userId);
  // Bounded: a slow lookup costs the call nothing (the finds are just not offered), never a pause after "hello".
  const bound = (p: Promise<CallBriefing>) => {
    let t: NodeJS.Timeout;
    return Promise.race([p, new Promise<CallBriefing>((r) => { t = setTimeout(() => r(fallback()), 1500); })]).finally(() => clearTimeout(t));
  };
  if (hit && now - hit.at < TTL_MS) return bound(hit.briefing);
  return bound(buildCallBriefing(userId, new Date(now)).catch(() => fallback()));
}
