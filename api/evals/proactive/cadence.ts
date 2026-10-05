// Model-free checks for engagement-scaled pacing (harness/proactive.ts,
// brand fix 3): the caps stay the ceiling and the pace falls for someone who
// has gone quiet. No API calls, no database:
//   npx tsx evals/proactive/cadence.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const P = await import("../../src/harness/proactive.js");
const { userLevelChecks, engagementTier, unansweredPauseFor, CADENCE, ENGAGEMENT, RULES } = P;
import { readFileSync } from "fs";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const now = new Date("2026-10-07T18:00:00Z"); // 11am Pacific, a Wednesday
const hrs = (h: number) => new Date(now.getTime() - h * 3_600_000);
const days = (d: number) => hrs(d * 24);
const send = (h: number, type = "post_call"): any => ({ type, sentAt: hrs(h), targetKey: `${type}${h}`, topicKey: null, exempt: false });
const st = (sends: any[], lastInboundAt: Date | null) => ({ now, sends, lastInboundAt, timezone: "America/Los_Angeles", optedOut: false, needsCare: false }) as any;
const failedNames = (state: any, lane: "room" | "other" = "other") => userLevelChecks(state, { lane }).filter((c: any) => !c.pass).map((c: any) => c.name);

// ---- tiers
check("texted this week is engaged or active", engagementTier(now, days(1), 0) === "engaged" && engagementTier(now, days(5), 0) === "active");
check("a week to two quiet", engagementTier(now, days(10), 1) === "quiet");
check("two to four weeks is dormant", engagementTier(now, days(20), 1) === "dormant");
check("over a month is gone", engagementTier(now, days(40), 1) === "gone");
check("four texts with no reply is dormant even if they texted recently", engagementTier(now, days(5), 4) === "dormant");
check("four unanswered and long quiet is gone", engagementTier(now, days(20), 4) === "gone");
check("a new member with no history is not penalised", engagementTier(now, null, 0) === "active" && engagementTier(now, null, 1) === "active");
check("never replied to two is quiet", engagementTier(now, null, 2) === "quiet");

// ---- the pause grows with every unanswered text
check("24h, 72h, a week, two weeks", unansweredPauseFor(1) === 24 && unansweredPauseFor(2) === 72 && unansweredPauseFor(3) === 168 && unansweredPauseFor(4) === 336);

// ---- pace within the caps
const twoThisWeek = [send(100), send(50)];
check("an engaged member still gets the full weekly ceiling (third text allowed)", !failedNames(st(twoThisWeek, hrs(30))).includes("weekly_cap"));
check("a quiet member is held to two a week", failedNames(st(twoThisWeek, days(10))).includes("weekly_cap"));
check("a quiet member with one this week is fine", !failedNames(st([send(100)], days(10))).includes("weekly_cap"));
check("the room lane's four a week is not cut for an engaged member", !failedNames(st([send(150, "event_offer"), send(100, "event_offer"), send(60, "event_offer")], hrs(30)), "room").includes("weekly_cap"));
check("dormant: a text 3 days ago holds the next", failedNames(st([send(72)], days(20))).includes("engagement_pace"));
check("dormant: a week later it may go", !failedNames(st([send(8 * 24)], days(20))).includes("engagement_pace"));
check("gone: ten days is too soon", failedNames(st([send(10 * 24)], days(45))).includes("engagement_pace"));
check("gone: fifteen days is fine", !failedNames(st([send(15 * 24)], days(45))).includes("engagement_pace"));
check("a quiet member has no minimum gap beyond the usual", !failedNames(st([send(30)], days(10))).includes("engagement_pace"));
check("a text from them restores the full pace at once", !failedNames(st([send(72)], hrs(1))).includes("engagement_pace"));
check("nothing sent yet is never held", !failedNames(st([], days(60))).includes("engagement_pace"));
check("it applies to both lanes", failedNames(st([send(72, "event_offer")], days(20)), "room").includes("engagement_pace"));

// ---- ceilings and answers
check("the ceilings are unchanged: 1 a day, 3 a week, room 1 and 4", RULES.maxPerLocalDay === 1 && RULES.maxPer7Days === 3 && RULES.roomMaxPerLocalDay === 1 && RULES.roomMaxPer7Days === 4);
check("no tier raises a cap above its ceiling", Object.values(CADENCE).every((c: any) => c.weeklyCap === null || c.weeklyCap <= RULES.maxPer7Days));
check("the pace only falls as engagement falls", CADENCE.quiet.minGapHours <= CADENCE.dormant.minGapHours && CADENCE.dormant.minGapHours <= CADENCE.gone.minGapHours);
const src = readFileSync(new URL("../../src/harness/proactive.ts", import.meta.url), "utf8");
check("answering something they asked for is exempt from the pace, like the other quotas", /const QUOTA_CHECKS = new Set\(\[[^\]]*"engagement_pace"/.test(src));
check("the dormant gap is a week and the gone gap two", CADENCE.dormant.minGapHours === 168 && CADENCE.gone.minGapHours === 336 && ENGAGEMENT.dormantDays === 30);

console.log(`cadence rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
