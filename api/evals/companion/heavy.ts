// Model-free checks for the next-day check-in (services/heavyMoment.ts):
// which readings count as a hard episode, when it is due, and how it is wired
// into the proactive flow. No API calls, no database:
//   npx tsx evals/companion/heavy.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { pickEpisode, HEAVY, HEAVY_KEY_PREFIX } = await import("../../src/services/heavyMoment.js");
const { TYPE_POLICY, RULES } = await import("../../src/harness/proactive.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

const TZ = "America/Los_Angeles";
// Tuesday 2026-10-06, 9pm Pacific = 04:00Z Wednesday.
const night = new Date("2026-10-07T04:00:00Z");
const hoursBefore = (h: number, from = night) => new Date(from.getTime() - h * 3_600_000);
const sig = (o: Partial<any> = {}) => ({ source: "text", emotion: "distress", intensity: "high", valence: "negative", about: "losing the funding", quote: "it all fell apart today", target: "life", basis: null, at: hoursBefore(1), ...o });

// ---- what counts
check("one high negative reading about their life is an episode", pickEpisode([sig()], night, TZ) !== null);
check("a single medium reading is an everyday complaint, not an episode", pickEpisode([sig({ intensity: "medium" })], night, TZ) === null);
check("two medium readings together are an episode", pickEpisode([sig({ intensity: "medium", at: hoursBefore(3) }), sig({ intensity: "medium", at: hoursBefore(1) })], night, TZ) !== null);
check("a low reading is never an episode", pickEpisode([sig({ intensity: "low" }), sig({ intensity: "low", at: hoursBefore(2) })], night, TZ) === null);
check("a positive reading is not an episode", pickEpisode([sig({ valence: "positive" })], night, TZ) === null);
check("frustration with Co is not their life", pickEpisode([sig({ target: "co" })], night, TZ) === null);
check("the voice frustration score alone is not an episode", pickEpisode([sig({ basis: "frustration_score" })], night, TZ) === null);
check("older than the lookback is not an episode", pickEpisode([sig({ at: hoursBefore(HEAVY.lookbackHours + 1) })], night, TZ) === null);
check("a good moment afterwards means it already passed", pickEpisode([sig({ at: hoursBefore(3) }), sig({ valence: "positive", intensity: "medium", at: hoursBefore(1) })], night, TZ) === null);
check("a bad moment after a good one still counts", pickEpisode([sig({ valence: "positive", at: hoursBefore(5) }), sig({ at: hoursBefore(1) })], night, TZ) !== null);
for (const w of ["I want to kill myself", "everyone is better off without me", "I just want to disappear", "thinking about ending it all"]) {
  check(`self-harm is left to the conversation: ${w}`, pickEpisode([sig({ quote: w })], night, TZ) === null);
}

check("frustration about Co\'s calls is not their life", pickEpisode([sig({ about: "phone calls not connecting, wasted time", quote: "What\'s breaking?", emotion: "frustrated" })], night, TZ) === null);
check("asking Co to take the lead is not a hard moment", pickEpisode([sig({ about: "needing someone to take ownership and execute", quote: "plan out the event and take lead" })], night, TZ) === null);
check("a real one about money still counts", pickEpisode([sig({ about: "lack of funding and bootstrapping constraints", quote: "we\'re unfunded" })], night, TZ) !== null);
check("only one heavy check-in waits at a time", /pc\.status = 'pending'/.test(read("src/services/heavyMoment.ts")));

// ---- when it is due
const ep = pickEpisode([sig()], night, TZ)!;
const localDue = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hour12: false }).format(ep.dueAt);
check("due the next local day at 10", /Wed/.test(localDue) && /10/.test(localDue));
check("never the same night", ep.dueAt.getTime() - night.getTime() > 8 * 3_600_000);
const earlyHours = new Date("2026-10-07T09:30:00Z"); // 2:30am Pacific Wednesday
const early = pickEpisode([sig({ at: hoursBefore(0.5, earlyHours) })], earlyHours, TZ)!;
check("a 2am vent is checked on the next day, not that morning", new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(early.dueAt) === "Thu");
check("it expires the same day it is due", ep.expiresAt.getTime() - ep.dueAt.getTime() === HEAVY.expiresAfterHours * 3_600_000);
{
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
  const ms = (s: string) => new Date(`${s}T12:00:00Z`).getTime();
  check("yesterday is true when it is read: the due day is one after the episode", (ms(day(ep.dueAt)) - ms(day(ep.endedAt))) / 86_400_000 === 1 && ep.when === "yesterday");
  const early2 = pickEpisode([sig({ at: hoursBefore(0.5, earlyHours) })], earlyHours, TZ)!;
  check("also for a 2am vent", (ms(day(early2.dueAt)) - ms(day(early2.endedAt))) / 86_400_000 === 1);
}
check("unknown time zone falls back and still returns a Pacific morning", pickEpisode([sig()], night, null) !== null);

// ---- one per episode
const a = pickEpisode([sig({ at: hoursBefore(10) }), sig({ at: hoursBefore(1) })], night, TZ)!;
const b = pickEpisode([sig({ at: hoursBefore(10) })], night, TZ)!;
check("readings of one evening are one episode with one key", a.key === b.key);
check("a reading the day before an earlier unrelated one starts its own episode", (() => {
  const day = pickEpisode([sig({ at: hoursBefore(34) }), sig({ at: hoursBefore(1) })], night, TZ)!;
  return day.key !== pickEpisode([sig({ at: hoursBefore(34) })], night, TZ)!.key;
})());
check("the key is the day, shared by the queue and the send record", HEAVY_KEY_PREFIX === "companion:heavy:");

// ---- wiring: same caps, never stacking
const flow = read("src/harness/proactive.ts");
const registry = read("src/harness/proactiveRegistry.ts");
const jobs = read("src/jobs/index.ts");
const service = read("src/services/heavyMoment.ts");
const draft = read("src/agent/companionCheckin.ts");
check("it is a companion candidate, so every cap applies", /type: "companion"/.test(service) && !/exempt|sendExempt/.test(service));
check("the companion gap and the daily cap still stand", TYPE_POLICY.companion.typeGapDays === 4 && RULES.maxPerLocalDay === 1);
check("the registry hands the heavy payload to the draft", /c\.payload\.heavy \?\? null/.test(registry));
check("the draft is skipped for self-harm and takes no events or links", /return SKIP/.test(draft) && /offer anything \(no events, links/.test(draft));
check("the hourly job queues it", /queueHeavyCheckins\(\)/.test(jobs));
check("a second check-in is held off for days after one is sent", HEAVY.quietDaysAfterSend >= 3 && /proactive_sends/.test(service));
check("it only reads that member's own readings", /WHERE user_id = \$1/.test(service) && !/memberSafe|other_person/.test(service));
check("the drafting task quotes no example wording", !/"[A-Z][^"]{15,}"/.test(draft.slice(draft.indexOf("async function draftFromHeavy"), draft.indexOf("// Advice Co gave"))));
check("the draft is forbidden from claiming it was thinking about them", /thinking\|thought\) \(\?:about\|of\)/.test(draft));
check("yesterday is only when they told Co, never when the thing happens", /when_they_told_you/.test(draft) && /not when the thing itself happens/.test(draft));
check("a draft about Co itself is skipped", /frustration with Co itself/.test(draft));
const prompt = read("prompts/co-system-prompt.md");
check("the prompt tells Co never to promise a later check-in", /Never tell them you'll check in on them later/.test(prompt));

console.log(`next-day check-in rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
