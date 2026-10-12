// What the call brain is handed besides the prompt (Royce, 2026-10-06, after the first ElevenLabs call):
//   - a capability sheet: what Co can actually do today (so it stops refusing things Co supports, and stops promising what it can't)
//   - the clock: what time and day it is for them right now (so it never calls tomorrow's event "tonight")
//   - what Co has found for them, prefetched while the phone rings (so no tool call, no pause, mid-conversation)
// The sheet is static and lives in the agent's prompt (cached). The clock and the finds are per call, and ride in as dynamic variables.
import { timelineFor } from "./timeline.js";
import { voiceFinds, type VoiceFinds } from "./voiceFinds.js";
import { fallbackBriefing, judgeBriefing, logBriefing, type BriefingDecision, type CallBriefing } from "../brain/index.js";
import { callCapabilityList } from "./capabilities.js";

// One page. The list is generated from the capability registry (services/capabilities.ts callCapabilityList), from the same
// entries that enable the call's tools (services/callTools.ts CALL_TOOL_NAMES), so it can't leave out what the call can do
// (item 9, 2026-10-12: the hand-kept list said it was complete and left out pages, decks, documents and what Co knows).
// The rest is how to hold the list on a call: what never to promise.
export const CAPABILITY_SHEET = `# What Co can do today (this is the whole list; never refuse what is on it, never promise what is not)
Asked what you can do, answer from it completely in a few spoken sentences, what fits them first, not where their work stands.

${callCapabilityList()}

How to hold it:
- Offer to text a link; never read one out.
- A task: Co works on it over the following days (up to 30) and texts what it finds. Say yes to this on a call and set it up then and there, and say it's set up. Never say this is "not how I work", or promise what it will find or when.
- After a call, Co does look into what you said you'd look into and texts what it found, or that nothing good enough turned up.
- Co never starts a group text, and can't book or buy anything for them. Co can't find investors, sponsors or funders on demand, or a particular kind of advisor.
- Co can't promise a daily message or a set time for a check-in.
- Never say when something happens unless it is in "What Co has found" or in what you know about them, with its day. Never invent an event, a time, a place or who will be there.
- Never ask for something you already know: say what you have and ask, in your own words, whether it's still right. Anything under "what you already know" below is known.`;

// The judgment (what the call may offer, how it reads the clock) is the brain's (brain/index.ts judgeBriefing); this file gathers
// the facts it judges from and keeps the fallback a failed or slow build falls to.
export { renderFinds, type CallBriefing } from "../brain/index.js";

// How long the briefing waits on the call context's shared read before reading their city itself.
const SHARED_WAIT_MS = 1000;

// Built while the phone rings (outbound) or alongside the context (inbound). Each part fails to a safe line, never to a guess.
// The brain judges from what's gathered here (brain/index.ts judgeBriefing), and the guards veto after it: a safety hold
// (services/safety.ts, offers paused for 3 days) means the call is handed no finds, whatever is on file.
export async function planCallBriefing(userId: string, now: Date = new Date()): Promise<BriefingDecision> {
  // Their city from the one member-knowledge layer (services/memberKnowledge.ts): the call context's read when it's already under
  // way (services/callContext.ts, shared for the call's setup) and back within a second, else an identity-only read of its own.
  const own = () => import("./memberKnowledge.js").then((m) => m.memberKnowledge(userId, { now, include: [] }));
  // Wrapped, so awaiting the import doesn't also await the read.
  const shared = await import("./callContext.js").then((c) => ({ read: c.callKnowledgeInFlight(userId, now.getTime()) })).catch(() => ({ read: null }));
  const slow = new Promise<"slow">((r) => setTimeout(() => r("slow"), SHARED_WAIT_MS).unref?.());
  const k = await (shared.read ? Promise.race([shared.read, slow]).then((x) => (x === "slow" ? own() : x)) : own()).catch(() => null);
  const city: string | null = k?.identity.city ?? null;
  const [clock, finds, safetyHold] = await Promise.all([
    timelineFor(userId, city, now).catch(() => null),
    voiceFinds(userId, now).catch((): VoiceFinds => ({ available: false, reason: "the lookup didn't load" })),
    import("./safety.js").then((s) => s.safetyHoldActive(userId)).catch(() => false),
  ]);
  return judgeBriefing({ userId, now, clock, finds, vetoes: safetyHold ? [{ guard: "safety", why: "a safety hold is on: only care, no offers" }] : [] });
}
export async function buildCallBriefing(userId: string, now: Date = new Date()): Promise<CallBriefing> {
  return (await planCallBriefing(userId, now)).briefing;
}

// Kept for 5 minutes per member, like the context (services/elevenLabsCalls.ts): outbound builds it while it rings.
const TTL_MS = 5 * 60 * 1000;
const prebuilt = new Map<string, { at: number; plan: Promise<BriefingDecision> }>();
export function prebuildCallBriefing(userId: string, now = Date.now()): void {
  prebuilt.set(userId, { at: now, plan: planCallBriefing(userId, new Date(now)).catch(() => fallbackBriefing(new Date(), "the briefing failed to build")) });
}
// The call takes its briefing here, and the decision is logged now, with what the call actually got (built or fallback).
export async function takeCallBriefing(userId: string, now = Date.now()): Promise<CallBriefing> {
  const hit = prebuilt.get(userId);
  prebuilt.delete(userId);
  // Bounded: a slow lookup costs the call nothing (the finds are just not offered), never a pause after "hello".
  const bound = (p: Promise<BriefingDecision>) => {
    let t: NodeJS.Timeout;
    return Promise.race([p, new Promise<BriefingDecision>((r) => { t = setTimeout(() => r(fallbackBriefing(new Date(), "the briefing wasn't ready in time")), 1500); })]).finally(() => clearTimeout(t));
  };
  const used = await bound(hit && now - hit.at < TTL_MS ? hit.plan : planCallBriefing(userId, new Date(now)).catch(() => fallbackBriefing(new Date(), "the briefing failed to build")));
  logBriefing(userId, used);
  return used.briefing;
}
