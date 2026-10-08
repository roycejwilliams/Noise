// Follow-ups handed to Co: does a due, relevant follow-up actually go out, without spamming? Metered, dry, read-only.
//   EVAL_REAL_MODELS=1 EVAL_COST_CAP_USD=1.5 EVAL_TOKEN_CAP=3000000 npm run eval:live -- evals/tasks/followupsDecideLive.ts [before|after]
// Two sets:
//   - real-shaped: each follow-up's FIRST look on the dev DB in the last 14 days, replayed as of that moment (the thread and
//     sends before it). No right answer is on record, so it reports the split and why "later" was picked: a deferral for the
//     hour or for how many texts went out is one the send path already enforces, and one with no text from them in the 2h
//     before has no thread reason to wait.
//   - invented controls with a right answer, including the ones where checking in would be spam (already told you, asked for
//     space, mid-conversation, the date is still ahead).
// "before" runs the original decider from a temporary copy (make it first, delete it after):
//   git show 4882d45:api/src/services/followUps.ts > src/services/_followUpsBefore.ts
// "after" runs the current one.
// 2026-10-07 (27 real first looks; 10 controls): before 2 now / 22 later / 3 skip, 17 of 22 "later" for the hour or text
// volume, controls 7/10; after 17 now / 8 later / 2 skip, 2 of 8 for the hour or volume, 1 of 17 "now" mid-conversation,
// controls 9/10. ~$0.31 a run.
// Nothing is written or sent: every tool is a stub. DB reads only, inside read-only sessions, on the Railway dev database.
// Prints counts and invented examples only, never a member's content.
import "../lib/requireMeter.js";
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";

const variant = process.argv[2] === "before" ? "before" : "after";
const { default: pool } = await import("../../src/db/db.js");
pool.on("connect", (c: any) => { c.query("SET default_transaction_read_only = on").catch(() => {}); });
const db = await pool.query(`SELECT current_database() AS d, current_setting('transaction_read_only') AS ro`);
const url = new URL(String(process.env.DATABASE_URL ?? "postgres://x@none/none"));
if (db.rows[0]?.d !== "railway" || db.rows[0]?.ro !== "on" || url.hostname !== "localhost" || url.port === "5432") {
  console.error("not the read-only Railway dev tunnel; stopping");
  process.exit(2);
}

const F: any = variant === "before" ? await import(["../../src/services", "_followUpsBefore.js"].join("/")) : await import("../../src/services/followUps.js");
const { memberSafe } = await import("../../src/services/memberSafeMemories.js");
const { withoutTeammateLines } = await import("../../src/services/teamLines.js");

type Out = { action: string; why: string };
async function decide(task: any, ctx: { firstName: string; recent: string; recentSends: string; dueSince?: string | null }, now: Date): Promise<Out> {
  const r = await F.runFollowUpTurnWith(task, { ...ctx, now: () => now, checkInNow: async () => true, later: async () => {}, skip: async () => {} });
  return { action: r.action, why: String(r.why ?? "") };
}
const TIME_OF_DAY = /\b(late|night|evening|asleep|early morning|early|hour|bedtime|wake)\b/i;
const VOLUME = /\b(a lot|several|many|multiple|frequent|already texted|texted (them|him|her) (first|recently)|unanswered|hasn'?t (replied|responded)|no reply|haven'?t heard|noise|spam)\b/i;

// ---------- real-shaped cases
const { rows: picks } = await pool.query(
  `SELECT DISTINCT ON ((d.proposal->>'taskId')::int) (d.proposal->>'taskId')::int AS tid, d.created_at AS at, d.action AS was
   FROM harness_decisions d WHERE d.decision = 'task.followup' AND d.action IN ('now', 'later', 'skip') AND d.created_at > NOW() - INTERVAL '14 days'
   ORDER BY (d.proposal->>'taskId')::int, d.created_at`,
);
const real: { now: number; later: number; skip: number; other: number; laterHourOrVolume: number; laterNoRecentText: number; was: Record<string, number> } = { now: 0, later: 0, skip: 0, other: 0, laterHourOrVolume: 0, laterNoRecentText: 0, was: {} };
let n = 0;
let nowWhileTalking = 0;
for (const p of picks) {
  const { rows } = await pool.query(`SELECT t.*, u.first_name FROM co_tasks t JOIN users u ON u.id = t.user_id WHERE t.id = $1 AND t.kind = 'followup'`, [p.tid]);
  const t = rows[0];
  if (!t) continue;
  const asOf = new Date(new Date(p.at).getTime() - 1000);
  const task = { id: Number(t.id), userId: t.user_id, goal: t.goal, wakes: 1, createdAt: new Date(t.created_at).toISOString(), nextCheckAt: null, followup: t.followup, notes: [], steps: [], theirWords: "" };
  let ctx: { firstName: string; recent: string; recentSends: string; dueSince?: string | null };
  if (variant === "before") {
    // The original loader, as of the moment of the decision.
    const { rows: convo } = await pool.query(`SELECT content, memory_type FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND created_at <= $2 ORDER BY created_at DESC LIMIT 14`, [t.user_id, asOf]);
    const { rows: sends } = await pool.query(`SELECT type, sent_at FROM proactive_sends WHERE user_id = $1 AND sent_at <= $2 AND sent_at > $2::timestamptz - INTERVAL '7 days' ORDER BY sent_at DESC LIMIT 6`, [t.user_id, asOf]);
    ctx = { firstName: t.first_name || "them", recent: withoutTeammateLines((await memberSafe(t.user_id, convo)).reverse().join("\n")).slice(-2500), recentSends: sends.map((s: any) => `- ${new Date(s.sent_at).toISOString().slice(0, 16)} ${s.type}`).join("\n") };
  } else {
    const c = await F.loadFollowUpContext(t.user_id, task, asOf);
    ctx = { firstName: t.first_name || "them", recent: c.recent, recentSends: c.recentSends, dueSince: c.dueSince };
  }
  const { rows: lastTheirs } = await pool.query(`SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND created_at <= $2 AND created_at > $2::timestamptz - INTERVAL '2 hours' LIMIT 1`, [t.user_id, asOf]);
  const r = await decide(task, ctx, asOf);
  n++;
  real.was[p.was] = (real.was[p.was] ?? 0) + 1;
  if (r.action === "now" || r.action === "later" || r.action === "skip") real[r.action]++;
  else real.other++;
  if (r.action === "later") {
    if (TIME_OF_DAY.test(r.why) || VOLUME.test(r.why)) real.laterHourOrVolume++;
    if (!lastTheirs.length) real.laterNoRecentText++;
  }
  if (r.action === "now") {
    const { rows: talking } = await pool.query(`SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND created_at <= $2 AND created_at > $2::timestamptz - INTERVAL '30 minutes' LIMIT 1`, [t.user_id, asOf]);
    if (talking.length) nowWhileTalking++;
  }
}
console.log(`[${variant}] real-shaped first looks: ${n} | now ${real.now}, later ${real.later}, skip ${real.skip}, no decision ${real.other} | on record then: ${JSON.stringify(real.was)}`);
console.log(`[${variant}]   "later" for the hour or text volume (enforced at send anyway): ${real.laterHourOrVolume}/${real.later}; "later" with no text from them in the 2h before: ${real.laterNoRecentText}/${real.later}; "now" while they texted in the last 30 min: ${nowWhileTalking}/${real.now}`);

// ---------- invented controls (with a right answer)
const now = new Date("2026-10-05T20:00:00Z");
type Line = [minutesAgo: number, text: string];
const fmt = (lines: Line[]) => (variant === "before" ? lines.map(([, l]) => l).join("\n") : lines.map(([m, l]) => `[${F.ago(new Date(now.getTime() - m * 60_000), now)}] ${l}`).join("\n"));
const sendsFmt = (s: [number, string][]) => (variant === "before" ? s.map(([m, ty]) => `- ${new Date(now.getTime() - m * 60_000).toISOString().slice(0, 16)} ${ty}`).join("\n") : s.map(([m, ty]) => `- ${F.ago(new Date(now.getTime() - m * 60_000), now)}: ${ty}`).join("\n"));
const mk = (summary: string, type: string, payload: any = {}, dueMinAgo = 30, wakes = 1) => ({ id: 1, userId: "u", goal: summary, wakes, createdAt: new Date(now.getTime() - dueMinAgo * 60_000).toISOString(), followup: { type, summary, payload } });
const D = 1440;
const controls: { label: string; task: any; recent: Line[]; sends?: [number, string][]; want: string[]; at?: Date }[] = [
  { label: "already told how it went", task: mk("Ask how the weekend went (they asked about events this weekend)", "window_followup", { label: "this weekend" }), recent: [[3 * D, "User said: anything fun this weekend?"], [3 * D - 2, "Co replied: Grok Bot x Notion Saturday."], [20 * 60, "User said: went to the Grok thing Saturday, it was great, met two founders"], [20 * 60 - 1, "Co replied: Love that. Who were they?"]], want: ["skip"] },
  { label: "mid-conversation right now", task: mk("Ask how the investor pitch ask went", "companion", { advice: "Write the ask as one sentence and say it early." }), recent: [[12, "User said: ok so about the block party venue, can you look at indoor spots"], [11, "Co replied: Yes. Indoor, for about forty?"], [4, "User said: yes and also need a DJ"]], sends: [[10, "task_update"]], want: ["later"] },
  { label: "quiet, and the pitch happened", task: mk("Ask how the investor pitch went (advice given 4 days ago)", "companion", { advice: "Write the ask as one sentence, say it early, then stop talking." }, 60), recent: [[4 * D, "User said: I am pitching investors Friday and I keep freezing on the ask"], [4 * D - 1, "Co replied: Write the ask as one sentence, say it early, then stop talking."], [4 * D - 5, "User said: ok will try"]], want: ["now"] },
  { label: "asked for space", task: mk("Check in on the venue search ask", "ask_checkin", { askText: "a rooftop for a birthday dinner" }), recent: [[2 * D, "User said: honestly I need a break from all the texts for a bit"], [2 * D - 1, "Co replied: Of course. I'm here when you want me."]], want: ["skip"] },
  { label: "the event is still three days off", task: mk("Debrief after the founders dinner", "debrief", { eventName: "Founders Supper Club", eventDate: "2026-10-08" }), recent: [[D, "User said: just RSVP'd to the founders supper thing on the 8th"], [D - 1, "Co replied: Good call. Small room, strong crowd."]], want: ["later"] },
  { label: "ask unanswered for days, thread quiet", task: mk("Check in on their ask: a private dining room for twelve in SF", "ask_checkin", { askText: "a private dining room for twelve in SF next month" }, 120), recent: [[3 * D, "User said: can you find a private dining room for twelve in SF next month"], [3 * D - 1, "Co replied: Yes. Any part of town you'd rule out?"], [3 * D - 30, "User said: not the marina"]], want: ["now"] },
  { label: "due, last exchange yesterday", task: mk("Ask how the coffee with the designer went", "window_followup", { label: "coffee Saturday", asked: "how it went" }, 90), recent: [[2 * D, "User said: grabbing coffee with a designer from the club Saturday"], [2 * D - 1, "Co replied: Nice. Ask what she's building next."], [20 * 60, "User said: thanks for the rooftop list btw"], [20 * 60 - 1, "Co replied: Anytime."]], want: ["now"] },
  { label: "Co texted first a few times, they answered", task: mk("Ask how the launch party went", "debrief", { eventName: "Launch party", eventDate: "2026-10-03" }, 180), recent: [[2 * D, "Co replied: Saw the launch is Friday. Want a couple of names to invite?"], [2 * D - 40, "User said: yes please"], [2 * D - 45, "Co replied: Sent them over."]], sends: [[2 * D, "companion"], [4 * D, "event_offer"], [5 * D, "network_tease"]], want: ["now"] },
  { label: "they already sorted it", task: mk("Check in on their ask: a photographer for the launch", "ask_checkin", { askText: "a photographer for the launch" }), recent: [[D, "User said: never mind on the photographer, my cofounder booked one"], [D - 1, "Co replied: Perfect, one less thing."]], want: ["skip"] },
  { label: "quiet and due, at 9pm their time (UTC clock reads 04:00)", task: mk("Ask how the board meeting went", "window_followup", { label: "board meeting Monday" }, 60), recent: [[2 * D, "User said: board meeting Monday, wish me luck"], [2 * D - 1, "Co replied: You've got this. Lead with the hiring plan."]], want: ["now"], at: new Date("2026-10-06T04:00:00Z") },
];
let right = 0;
const by: Record<string, number> = { now: 0, later: 0, skip: 0, defaulted: 0 };
for (const c of controls) {
  const at = c.at ?? now;
  const r = await decide(c.task, { firstName: "Sam", recent: fmt(c.recent), recentSends: sendsFmt(c.sends ?? []), dueSince: variant === "after" ? F.ago(new Date(c.task.createdAt), at) : undefined }, at);
  by[r.action] = (by[r.action] ?? 0) + 1;
  const ok = c.want.includes(r.action);
  if (ok) right++;
  console.log(`[${variant}] ${ok ? "ok  " : "BAD "} ${c.label}: ${r.action} (want ${c.want.join("/")}): ${r.why.slice(0, 140)}`);
}
console.log(`[${variant}] controls: ${right}/${controls.length} right | ${JSON.stringify(by)}`);
await pool.end();
process.exit(0);
