// Long-run consistency, model-free (Royce, 2026-09-29): a simulated member
// over 13 weeks, ticked week by week through the same pure milestone logic
// the weekly cron uses. What must hold across the whole stretch: each moment
// is marked once, never faster than every 7 days, never from a backlog, never
// without evidence, and the story Co can tell only grows.
//
//   npx tsx evals/companion/longRun.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const M = await import("../../src/services/milestones.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const DAY = 86_400_000;
const start = new Date("2026-07-01T12:00:00Z");
const at = (d: number) => new Date(start.getTime() + d * DAY).toISOString();

// Their life with Co: things happen on these days.
const wentOn = [{ itemKey: "luma:founders-dinner", name: "Founders Dinner", day: 12 }, { itemKey: "luma:demo-night", name: "Demo Night", day: 55 }];
const threadsOn = [
  { id: "t1", text: "the pitch on Friday", openedQuote: "I have a big pitch Friday and I'm nervous", closedQuote: "the pitch went really well", day: 9 },
  { id: "t2", text: "deciding on a cofounder", openedQuote: "not sure about bringing on a cofounder", closedQuote: "I signed with Maya as cofounder", day: 40 },
  { id: "t3", text: "moving apartments", openedQuote: "I might move next month", closedQuote: null, day: 70 },
];

type Store = Map<string, M.Milestone>;
const store: Store = new Map();
const markedOn: { key: string; day: number }[] = [];
let storyLen = 0;
let storyShrank = false;

// One weekly tick, exactly like syncMilestones + pickToMark, without the DB.
function tick(day: number, firstRun: boolean) {
  const now = new Date(start.getTime() + day * DAY);
  const src: M.Source = {
    joinedAt: start.toISOString(),
    now: now.toISOString(),
    went: wentOn.filter((w) => w.day <= day).map((w) => ({ itemKey: w.itemKey, name: w.name, at: at(w.day) })),
    closed: threadsOn.filter((t) => t.day <= day).map((t) => ({ id: t.id, text: t.text, openedQuote: t.openedQuote, closedQuote: t.closedQuote, at: at(t.day) })),
  };
  for (const m of M.deriveMilestones(src)) {
    if (store.has(m.key)) continue;
    const stale = now.getTime() - new Date(m.happenedAt).getTime() > M.ANNOUNCE_WITHIN_DAYS * DAY;
    store.set(m.key, { ...m, markedAt: stale ? now.toISOString() : null });
  }
  const pick = M.pickToMark([...store.values()], now);
  if (pick) {
    store.set(pick.key, { ...pick, markedAt: now.toISOString() });
    markedOn.push({ key: pick.key, day });
  }
  const lines = M.storyLines([...store.values()], 100).length;
  if (lines < storyLen) storyShrank = true;
  storyLen = lines;
  void firstRun;
}

for (let day = 0; day <= 91; day += 7) tick(day, day === 0);

check("every moment is marked at most once", new Set(markedOn.map((m) => m.key)).size === markedOn.length);
check("never faster than every 7 days", markedOn.every((m, i) => i === 0 || m.day - markedOn[i - 1].day >= M.MARK_EVERY_DAYS));
check("the pitch (day 9) is marked in its week", markedOn.some((m) => m.key === "thread:t1" && m.day <= 21));
check("the cofounder decision is marked", markedOn.some((m) => m.key === "thread:t2"));
check("the events they went to are marked", markedOn.some((m) => m.key === "went:luma:founders-dinner") || store.get("went:luma:founders-dinner")?.markedAt);
check("a thread with no closing words of theirs is never a moment", !store.has("thread:t3"));
check("the 30, 90-day marks exist once they're reached, and 180 doesn't yet", store.has("days:30") && store.has("days:90") && !store.has("days:180"));
check("nothing is marked for a moment that's already old when found", (() => {
  const s = new Map<string, M.Milestone>();
  const old = M.deriveMilestones({ joinedAt: at(0), now: at(400), went: [], closed: [] });
  return old.every((m) => new Date(at(400)).getTime() - new Date(m.happenedAt).getTime() > M.ANNOUNCE_WITHIN_DAYS * DAY) && M.pickToMark(old.map((m) => ({ ...m, markedAt: null })), new Date(at(400))) === null && s.size === 0;
})());
check("the story Co can tell only grows across the stretch", !storyShrank && storyLen >= 5);
check("the story carries their own words, not Co's", M.storyLines([...store.values()], 20).some((l) => /the pitch went really well/.test(l) && /nervous/.test(l)));
check("with several moments waiting, the newest fresh one goes first", (() => {
  const a: M.Milestone = { key: "a", kind: "went", text: "a", then: null, now: null, happenedAt: at(10), markedAt: null };
  const b: M.Milestone = { key: "b", kind: "went", text: "b", then: null, now: null, happenedAt: at(12), markedAt: null };
  return M.pickToMark([a, b], new Date(at(14)))?.key === "b";
})());
check("after one is marked, the next waits a week", (() => {
  const a: M.Milestone = { key: "a", kind: "went", text: "a", then: null, now: null, happenedAt: at(10), markedAt: at(11) };
  const b: M.Milestone = { key: "b", kind: "went", text: "b", then: null, now: null, happenedAt: at(12), markedAt: null };
  return M.pickToMark([a, b], new Date(at(15))) === null && M.pickToMark([a, b], new Date(at(19)))?.key === "b";
})());

// Wiring: the same cron path, the send hook, and the reply facts.
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
check("the weekly job marks a moment before checking in", /queueMilestone\(r\.id\)/.test(src("harness/memberReflection.ts")) && /!marked\.has\(r\.id\)/.test(src("harness/memberReflection.ts")));
check("a moment is marked only once it's actually sent", /markMilestone\(c\.userId, c\.payload\.story\.key\)/.test(src("harness/proactiveRegistry.ts")));
check("the story is drafted from the record only", /Use only what_happened and their words/.test(src("agent/companionCheckin.ts")));
check("replies know the story", /storyLines\(m, 4\)/.test(src("harness/replyGrounding.ts")) && /storyLines\(m, 4\)/.test(src("services/turnContext.ts")));

console.log(`long-run rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
