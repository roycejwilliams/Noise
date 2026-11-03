// Update announcements (services/announcements.ts, Royce 2026-10-19): the rename notice generalized, and "the shift" as the first one,
// held until Royce approves its words. Layer 1, zero tokens: once per member per key; one text, never two, for a member the rename
// hasn't reached (including two sends at once); members who joined after the change, archived and opted-out members skipped; nothing
// queued while the wording waits on approval; the try line picked by situation in code; expiry; a hard day waits and never cancels;
// nothing rides along. Test members are invented (Jordan, Noor, Ellis, Sarah Hao); nothing is sent: the ledger and Sendblue are
// faked (evals/lib/fakeLedger.ts), and the queue runs against a fake database.
//
//   npx tsx evals/proactive/announcements.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
import fs from "node:fs";
import { installFakeLedger } from "../lib/fakeLedger.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const AN = await import("../../src/services/announcements.js");
const NC = await import("../../src/services/nameChange.js");
const P = await import("../../src/harness/proactive.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const AR = await import("../../src/services/askRetire.js");
const { carryLaneNotes } = await import("../../src/services/laneMoves.js");
const { capitalizeSentences } = await import("../../src/services/textStyle.js");
const { PAYLOAD_FIRST_EXEMPT } = await import("../../src/harness/payloadFirst.js");
const { PROACTIVE_PURPOSE } = await import("../../src/harness/proactivePurpose.js");
const { default: pool } = await import("../../src/db/db.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");

const day = new Date();
const H = 3_600_000, D = 24 * H;
const cand = (o: { id: string; userId: string; type: string; targetKey: string; createdAt?: Date; expiresAt?: Date | null }): any => ({ topicKey: o.targetKey, summary: "", priority: 1, dueAt: new Date(day.getTime() - 60_000), expiresAt: null, payload: {}, attempts: 0, createdAt: day, ...o });
const checksFor = (c: any, extra: Record<string, unknown>) => P.candidateChecks(c, { now: day, sends: [], lastInboundAt: null, needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [], away: null, joinedAt: null, ...extra } as any);
const failedNames = (c: any, extra: Record<string, unknown>) => checksFor(c, extra).filter((k) => !k.pass).map((k) => k.name);
const shiftCand = (userId: string, id = "s1", more: Record<string, unknown> = {}) => cand({ id, userId, type: "announcement", targetKey: AN.SHIFT_KEY, ...more });
const renameCand = (userId: string, id = "n1") => cand({ id, userId, type: "name_change", targetKey: NC.NAME_CHANGE_KEY });

// ---------------------------------------------------------------- 1. the registry
check("registry: one key each, every key unique", new Set(AN.ANNOUNCEMENTS.map((a) => a.key)).size === AN.ANNOUNCEMENTS.length);
check("registry: the rename is ported as it was (its key, words, end, approved)", AN.RENAME.key === "name_change:cue" && AN.RENAME.type === "name_change" && AN.RENAME.lead === NC.NAME_CHANGE_TEXT && "at" in AN.RENAME.expires && AN.RENAME.expires.at.getTime() === NC.NAME_CHANGE_EXPIRES.getTime() && AN.RENAME.approved === true && AN.RENAME.summary === "Tell them, once, that it goes by Cue now");
check("registry: the shift is approved by Royce (2026-10-23), a code constant", AN.SHIFT_APPROVED === true && AN.SHIFT.approved === true && !/process\.env/.test(src("services/announcements.ts")));
check("registry: the shift is its own key, its own type, ends 21 days after it starts", AN.SHIFT.key === "announcement:shift" && AN.SHIFT.type === "announcement" && "daysAfterFirstQueued" in AN.SHIFT.expires && AN.SHIFT.expires.daysAfterFirstQueued === 21);
check("registry: the rename goes first, so a follow-up that carries it finds it queued", AN.ANNOUNCEMENTS[0] === AN.RENAME);

// ---------------------------------------------------------------- 2. the words (proposed, option A), and the try line
check("the shift's words are Royce's approved copy, as written", AN.SHIFT_LEAD === "We're Noise now, and I'm Cue." && AN.SHIFT_BODY === "Noise is for the stretches when life is shifting: a new city, a new role, starting something. My part is knowing what you're in the middle of and finding the person worth meeting for it, at a Noise night or between them. I only introduce you when you both say yes.");
check("the try lines are Royce's approved copy", AN.SHIFT_TRY_DEFAULT === "If something's shifting for you right now, tell me who'd be good to meet for it and I'll start looking." && AN.SHIFT_TRY_GOAL === "Tell me who'd be good to meet for what you're working on, and I'll start looking.");
check("the visible-knowledge line is not wired (dropped: not fully true on co-test, see the PR)", !/what I know about you/i.test(src("services/announcements.ts").replace(/^\s*\/\/.*$/gm, "")));
check("try line: a member with a goal of their own gets the goal line", AN.pickTryLine(AN.SHIFT, { hasOwnGoal: true }) === AN.SHIFT_TRY_GOAL);
check("try line: everyone else gets the default", AN.pickTryLine(AN.SHIFT, { hasOwnGoal: false }) === AN.SHIFT_TRY_DEFAULT);
check("try line: the same situation always picks the same line", [1, 2, 3].every(() => AN.pickTryLine(AN.SHIFT, { hasOwnGoal: true }) === AN.SHIFT_TRY_GOAL));
check("try line: the rename has none (its words are unchanged)", AN.pickTryLine(AN.RENAME, { hasOwnGoal: true }) === null && AN.announcementText(AN.RENAME, { hasOwnGoal: true }, { nameTold: false }) === NC.NAME_CHANGE_TEXT);
const variants = [true, false].flatMap((hasOwnGoal) => [true, false].map((nameTold) => ({ hasOwnGoal, nameTold, text: AN.announcementText(AN.SHIFT, { hasOwnGoal }, { nameTold }) })));
check("shape: what changed, what it means, one thing to try, in that order", variants.every((v) => v.text.indexOf(AN.SHIFT_BODY) > 0 && v.text.endsWith(AN.pickTryLine(AN.SHIFT, v)!)), variants);
check("told already: it opens 'We're Noise now, and I'm Cue.'", variants.filter((v) => v.nameTold).every((v) => v.text.startsWith(AN.SHIFT_LEAD) && !/going by Cue now/.test(v.text)));
check("not told yet: the same opening, which says the new name once (and claims the rename)", variants.filter((v) => !v.nameTold).every((v) => v.text.startsWith(AN.SHIFT_LEAD) && NC.carriesNameChange(v.text) && (v.text.match(/I'm Cue/g) ?? []).length === 1 && !/going by Cue now/.test(v.text)));
for (const v of variants) {
  const sent = capitalizeSentences(v.text);
  const bad = P.checkDraft(sent, AN.ANNOUNCEMENT_RULES).filter((k) => !k.pass);
  check(`passes the proactive draft checks as written (goal=${v.hasOwnGoal}, told=${v.nameTold})`, sent === v.text && bad.length === 0, { bad, len: v.text.length });
}
const all = variants.map((v) => v.text).join("\n");
check("voice: never 'Noise's AI', never a role (matchmaker, assistant, concierge)", !/noise'?s ai|\bmatchmak|\bassistant\b|\bconcierge\b|\bmy role\b/i.test(all));
check("voice: no emoji, no exclamation, no question", !/\p{Extended_Pictographic}/u.test(all) && !/[!?]/.test(all));
check("never a changelog or stats: no counts, versions, 'shipped', 'features', 'update'", !/\d|\bshipp|\bfeature|\bupdate|\bversion|\bnew in\b|\brelease/i.test(all));

// ---------------------------------------------------------------- 3. the harness knows it
check("a proactive type with its own policy: lowest but the rename, a week between two", P.TYPE_POLICY.announcement.priority === 2 && P.TYPE_POLICY.announcement.typeGapDays === 7 && Object.entries(P.TYPE_POLICY).filter(([t]) => t !== "announcement" && t !== "name_change").every(([, p]) => p.priority > 2));
check("purpose: ops; payload first never turns it into a task", PROACTIVE_PURPOSE.announcement === "ops" && PAYLOAD_FIRST_EXEMPT.has("announcement"));
check("drafted from the registry, not a model", /announcement: \{\s*async draft\(c\) \{\s*return \(await import\("\.\.\/services\/announcements\.js"\)\)\.draftAnnouncement\(c\);/.test(src("harness/proactiveRegistry.ts")));
check("a safety hold holds it", failedNames(shiftCand("u"), { safetyHold: true }).includes("safety_hold"));
check("already on the ledger: never again", failedNames(shiftCand("u"), { sends: [{ type: "announcement", targetKey: AN.SHIFT_KEY, topicKey: AN.SHIFT_KEY, sentAt: new Date(day.getTime() - 30 * D), exempt: false }] }).includes("not_sent_before"));
check("two announcements a week apart at least", failedNames(cand({ id: "x", userId: "u", type: "announcement", targetKey: "announcement:later" }), { sends: [{ type: "announcement", targetKey: AN.SHIFT_KEY, topicKey: AN.SHIFT_KEY, sentAt: new Date(day.getTime() - 3 * D), exempt: false }] }).includes("type_gap"));
check("eligible on a plain day", failedNames(shiftCand("u"), {}).length === 0, failedNames(shiftCand("u"), {}));

// ---------------------------------------------------------------- 4. a hard day: it waits, capped, never cancelled
check("a hard day holds it (the same hold as the rename notice: HOLD_WHILE_STRUGGLING)", P.HOLD_WHILE_STRUGGLING.has("announcement") && failedNames(shiftCand("u"), { needsCare: true }).includes("emotional_timing"));
check("a hard day only waits: the hold is a failed check, so it stays pending (nothing drops it for that)", !/needsCare|struggl|heavy|frustrat|emotion|mood/i.test(src("services/announcements.ts").replace(/^\s*\/\/.*$/gm, "")));
{
  // The draft never sees a feeling: same text with or without a hard day, and no read of it at all.
  const deps = { approved: true, told: async () => false, situation: async () => ({ hasOwnGoal: false }), now: () => day };
  const a = await AN.draftAnnouncement(shiftCand("u"), deps);
  check("the draft has no mood input and never skips for one", "messages" in a && a.messages[0] === AN.announcementText(AN.SHIFT, { hasOwnGoal: false }, { nameTold: false }), a);
}
// With the capped hold (services/moodHold.ts, #253): the cap releases it like every other held check-in. Only when that file is here.
const MH = await import("../../src/services/moodHold.js" as string).catch(() => null);
if (MH && typeof (P as any).heldForMood === "function") {
  const hardAt = new Date(day.getTime() - 50 * H);
  const capped = MH.moodHold({ needsCare: true, hardAt, hardSince: hardAt }, { now: day, lastInboundAt: null });
  check("capped: past the cap it goes, struggling or not", capped.state === "released_cap" && !failedNames(shiftCand("u"), { needsCare: true, moodHold: capped }).includes("emotional_timing"), capped);
  const held = MH.moodHold({ needsCare: true, hardAt: new Date(day.getTime() - 2 * H), hardSince: new Date(day.getTime() - 2 * H) }, { now: day, lastInboundAt: null });
  check("capped: inside the cap it waits", held.hold && failedNames(shiftCand("u"), { needsCare: true, moodHold: held }).includes("emotional_timing"));
}

// ---------------------------------------------------------------- 5. nothing rides along
const q = (type: string, id: string, ageH: number) => ({ id, type, createdAt: new Date(day.getTime() - ageH * H) }) as any;
check("quiet day only: with anything else ready, the announcement waits", AN.quietDayOnly([q("announcement", "s", 5), q("companion", "c", 1)]).map((x) => x.id).join() === "c");
check("quiet day only: alone, it goes", AN.quietDayOnly([q("announcement", "s", 5)]).map((x) => x.id).join() === "s");
check("quiet day only: two at once, the oldest, alone", AN.quietDayOnly([q("announcement", "new", 1), q("announcement", "old", 9)]).map((x) => x.id).join() === "old");
check("quiet day only: nothing ready, nothing", AN.quietDayOnly([]).length === 0);
check("never carries a stopped-looking line or the generic name ride (not a riding type)", !AR.NOTE_RIDES.has("announcement") && !AR.noteMayRide({ type: "announcement", payload: {} }, false));
check("never batched into a find bundle", P.pickSiblingOffers(cand({ id: "e", userId: "u", type: "event_offer", targetKey: "e:1" }), [shiftCand("u")]).length === 0);
const pr = src("harness/proactive.ts");
check("dispatch: the pick sees announcements only on a quiet day", /const withoutName = nameNotice && ev\.eligible\.length > 1 \? ev\.eligible\.filter\(\(x\) => x\.type !== "name_change"\) : ev\.eligible;/.test(pr) && /const quiet = \(await import\("\.\.\/services\/announcements\.js"\)\)\.quietDayOnly\(withoutName\);\n  const banded = topBand\(quiet, /.test(pr) && /choosePick\(pickable,/.test(pr));
check("dispatch: the only thing an announcement claims with it is the rename it carries, and never in a bundle", /if \(!composed && c\.type === "announcement"\) \{\s*const fold = \(await import\("\.\.\/services\/announcements\.js"\)\)\.nameFold\(c, sending, state\.candidates\);/.test(pr) && /if \(fold === "unfoldable"\) \{[\s\S]{0,400}?return;\s*\}\s*if \(fold\) nameRide = fold;/.test(pr));

// ---------------------------------------------------------------- 6. the draft at send time
{
  let reads = 0;
  const counting = { told: async () => (reads++, false), situation: async () => (reads++, { hasOwnGoal: false }), now: () => day };
  const d = await AN.draftAnnouncement(shiftCand("u"), { ...counting, approved: false });
  check("unapproved: the draft waits a day and reads nothing", "defer" in d && d.defer.getTime() === day.getTime() + D && reads === 0, d);
  const told = await AN.draftAnnouncement(shiftCand("u"), { approved: true, told: async (_u, k) => k === AN.SHIFT_KEY, situation: async () => ({ hasOwnGoal: true }), now: () => day });
  check("told already: nothing goes", "skip" in told, told);
  const past = await AN.draftAnnouncement(shiftCand("u", "s1", { expiresAt: new Date(day.getTime() - 1000) }), { approved: true, told: async () => false, situation: async () => ({ hasOwnGoal: true }), now: () => day });
  check("past its end: nothing goes", "skip" in past && /end/.test(past.skip), past);
  const renamed = await AN.draftAnnouncement(shiftCand("u"), { approved: true, told: async (_u, k) => k === NC.NAME_CHANGE_KEY, situation: async () => ({ hasOwnGoal: true }), now: () => day });
  check("rename reached them: the follow-up lead and their goal line", "messages" in renamed && renamed.messages.length === 1 && renamed.messages[0] === `${AN.SHIFT_LEAD} ${AN.SHIFT_BODY} ${AN.SHIFT_TRY_GOAL}`, renamed);
  const fresh = await AN.draftAnnouncement(shiftCand("u"), { approved: true, told: async () => false, situation: async () => ({ hasOwnGoal: false }), now: () => day });
  check("rename hasn't reached them: one text, the same opening (it says the new name)", "messages" in fresh && fresh.messages.length === 1 && fresh.messages[0] === `${AN.SHIFT_LEAD} ${AN.SHIFT_BODY} ${AN.SHIFT_TRY_DEFAULT}`, fresh);
  const odd = await AN.draftAnnouncement(cand({ id: "z", userId: "u", type: "announcement", targetKey: "announcement:unknown" }), { approved: true });
  check("an unknown key is never drafted", "skip" in odd);
  const sitFails = await AN.draftAnnouncement(shiftCand("u"), { approved: true, told: async () => true, situation: async () => { throw new Error("db down"); }, now: () => day }).catch(() => "threw");
  check("told check first: an already-told member costs no situation read", typeof sitFails === "object" && "skip" in sitFails);
}

// ---------------------------------------------------------------- 7. the queue
type Row = { id: string; created_at: Date; archived_at: Date | null; sms_opted_out: boolean | null; has_phone: boolean; identity_captured: boolean | null; told: boolean; queued: boolean };
const cutoff = new Date("2026-10-14T17:00:00Z");
const member = (id: string, o: Partial<Row> = {}): Row => ({ id, created_at: new Date("2026-09-01T00:00:00Z"), archived_at: null, sms_opted_out: false, has_phone: true, identity_captured: true, told: false, queued: false, ...o });
// What a wrong query could hand back: every kind of member who must be left out, beside two who must be told.
const ROWS: Row[] = [
  member("u-jordan"),
  member("u-noor"),
  member("u-late", { created_at: new Date("2026-10-15T00:00:00Z") }),
  member("u-archived", { archived_at: new Date("2026-10-01T00:00:00Z") }),
  member("u-optout", { sms_opted_out: true }),
  member("u-nophone", { has_phone: false }),
  member("u-unfinished", { identity_captured: false }),
  member("u-told", { told: true }),
  member("u-queued", { queued: true }),
];
function fakeDb(o: { renameFirst: Date | null; shiftFirst?: Date | null; rows?: Row[] }) {
  const seen: { sql: string; args: unknown[] }[] = [];
  return {
    seen,
    db: {
      query: async (sql: string, args: unknown[] = []) => {
        seen.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
        if (/WHERE type = 'name_change'/.test(sql)) return { rows: [{ at: o.renameFirst }] };
        if (/WHERE target_key = \$1/.test(sql)) return { rows: [{ at: args[0] === NC.NAME_CHANGE_KEY ? o.renameFirst : o.shiftFirst ?? null }] };
        if (/FROM users u/.test(sql)) return { rows: o.rows ?? ROWS };
        return { rows: [] };
      },
    },
  };
}
const enq = () => {
  const calls: any[] = [];
  return { calls, enqueue: async (i: any) => (calls.push(i), { queued: true }) };
};
const quiet = () => {};
{
  const e = enq(), f = fakeDb({ renameFirst: cutoff });
  const lines: string[] = [];
  const n = await AN.queueAnnouncement(AN.SHIFT, day, { db: f.db, enqueue: e.enqueue, log: (l) => lines.push(l), approved: false });
  check("unapproved: nothing queued, nothing read, said once in the log", n === 0 && e.calls.length === 0 && f.seen.length === 0 && lines.length === 1 && /waiting on Royce's approval/.test(lines[0]), { n, lines });
}
{
  const e = enq(), f = fakeDb({ renameFirst: cutoff, shiftFirst: null });
  const n = await AN.queueAnnouncement(AN.SHIFT, day, { db: f.db, enqueue: e.enqueue, log: quiet, approved: true });
  const ids = e.calls.map((c) => c.userId).sort().join();
  check("approved: queued for exactly the members who knew Co and haven't had it", n === 2 && ids === "u-jordan,u-noor", e.calls.map((c) => c.userId));
  check("approved: joined after the change, archived, opted out, no phone, unfinished, told or queued are skipped even if the query let them through", !e.calls.some((c) => /late|archived|optout|nophone|unfinished|told|queued/.test(c.userId)));
  check("approved: its own type and key, fixed summary, no payload", e.calls.every((c) => c.type === "announcement" && c.targetKey === AN.SHIFT_KEY && c.summary === AN.SHIFT.summary && JSON.stringify(c.payload) === "{}"));
  check("approved: ends 21 days after it first started (today here)", e.calls.every((c) => c.expiresAt.getTime() === day.getTime() + 21 * D) && e.calls.every((c) => c.dueAt.getTime() === day.getTime()));
  const users = f.seen.find((s) => /FROM users u/.test(s.sql))!;
  check("approved: the audience is the rename's: joined before the rename's first notice", (users.args[0] as Date).getTime() === cutoff.getTime() && users.args[1] === AN.SHIFT_KEY);
}
{
  const e = enq(), f = fakeDb({ renameFirst: cutoff, shiftFirst: new Date(day.getTime() - 10 * D) });
  await AN.queueAnnouncement(AN.SHIFT, day, { db: f.db, enqueue: e.enqueue, log: quiet, approved: true });
  check("expiry: a member queued later gets no fresh window (21 days from the first one)", e.calls.length === 2 && e.calls.every((c) => c.expiresAt.getTime() === day.getTime() + 11 * D));
}
{
  const e = enq(), f = fakeDb({ renameFirst: cutoff, shiftFirst: new Date(day.getTime() - 22 * D) });
  const n = await AN.queueAnnouncement(AN.SHIFT, day, { db: f.db, enqueue: e.enqueue, log: quiet, approved: true });
  check("expiry: past its 21 days, nothing more is queued", n === 0 && e.calls.length === 0 && !f.seen.some((s) => /FROM users u/.test(s.sql)));
}
{
  const e = enq(), f = fakeDb({ renameFirst: null });
  const n = await AN.queueAnnouncement(AN.SHIFT, day, { db: f.db, enqueue: e.enqueue, log: quiet, approved: true });
  check("no rename started yet: a follow-up queues nothing (nobody is known to have known Co)", n === 0 && e.calls.length === 0);
}
{
  // The rename, through the registry: as before, the first run fixes the cutoff at now, and it ends with the alias.
  const e = enq(), f = fakeDb({ renameFirst: null, rows: [member("u-ellis")] });
  const n = await AN.queueAnnouncement(AN.RENAME, day, { db: f.db, enqueue: e.enqueue, log: quiet });
  const users = f.seen.find((s) => /FROM users u/.test(s.sql))!;
  check("rename: first run, cutoff now, its type, key, summary and end as before", n === 1 && (users.args[0] as Date).getTime() === day.getTime() && users.args[1] === NC.NAME_CHANGE_KEY && e.calls[0].type === "name_change" && e.calls[0].targetKey === NC.NAME_CHANGE_KEY && e.calls[0].summary === "Tell them, once, that it goes by Cue now" && e.calls[0].expiresAt.getTime() === NC.NAME_CHANGE_EXPIRES.getTime(), e.calls);
}
{
  const e = enq(), f = fakeDb({ renameFirst: cutoff });
  await AN.queueAnnouncement(AN.SHIFT, day, { db: f.db, enqueue: async (i: any) => { e.calls.push(i); if (i.userId === "u-jordan") throw new Error("db"); return { queued: true }; }, log: quiet, approved: true });
  check("one member's queue failing never stops the others", e.calls.length === 2);
}
const an = src("services/announcements.ts");
check("queue SQL: only members who knew Co, never archived, opted out, without a number or unfinished, never twice", /u\.created_at < \$1 AND u\.archived_at IS NULL AND COALESCE\(u\.sms_opted_out, false\) = false/.test(an) && /u\.phone_number IS NOT NULL AND u\.identity_captured = true/.test(an) && /NOT EXISTS \(SELECT 1 FROM proactive_sends s WHERE s\.user_id = u\.id AND s\.target_key = \$2\)/.test(an) && /NOT EXISTS \(SELECT 1 FROM proactive_candidates c WHERE c\.user_id = u\.id AND c\.target_key = \$2\)/.test(an));
check("queue SQL: the cutoff is fixed by the rename's first queued notice", /SELECT MIN\(created_at\) AS at FROM proactive_candidates WHERE type = 'name_change'/.test(an));
check("the rename's own queue is the registry's, unchanged", /return A\.queueAnnouncement\(A\.RENAME, now\);/.test(src("services/nameChange.ts")));
check("job: the rename queues first, then the announcements, daily and once after start", /m\.queueNameChange\(\)[\s\S]{0,700}a\.queueUpdateAnnouncements\(\)/.test(src("jobs/index.ts")) && /cron\.schedule\("40 9 \* \* \*", queueNames/.test(src("jobs/index.ts")));
check("the announcements job never queues the rename a second way", /if \(a\.key !== NAME_CHANGE_KEY\) n \+= await queueAnnouncement\(a, now\);/.test(an));

// ---------------------------------------------------------------- 8. the send: once per member per key, never two texts
const told = (outbox: { content: string; to?: string }[], phone: string) => outbox.filter((m) => m.to === phone && NC.carriesNameChange(m.content)).length;
function zoneAtHour(hour: number): string {
  let off = (hour - new Date().getUTCHours() + 24) % 24;
  if (off > 14) off -= 24;
  return off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
}
const person = (name: string, phone: string) => ({ userId: `u-${name.toLowerCase().replace(/\s+/g, "")}`, firstName: name, phoneNumber: phone, city: "San Francisco", timezone: zoneAtHour(13) });
const leadA = `${AN.SHIFT_LEAD} ${AN.SHIFT_BODY} ${AN.SHIFT_TRY_DEFAULT}`;
const folded = leadA; // the opening says the new name, so every shift text carries the rename
check("fold: every shift text carries the rename, and its fallback is the same text", NC.carriesNameChange(leadA) && JSON.stringify(AN.unfolded(AN.SHIFT, [leadA])) === JSON.stringify([leadA]) && AN.unfolded(AN.RENAME, [leadA]) === null);
check("fold: a text that doesn't carry the rename claims nothing", AN.nameFold(shiftCand("u-x"), [`${AN.SHIFT_BODY} ${AN.SHIFT_TRY_DEFAULT}`], [renameCand("u-x")]) === null);
check("fold: a carried rename that can't be unfolded never goes", AN.nameFold(shiftCand("u-x"), [`${AN.SHIFT_LEAD} something else`, "x"], []) === "unfoldable");
{
  const f0 = AN.nameFold(shiftCand("u-x"), [folded], [renameCand("u-x", "n9"), renameCand("u-other", "n8")]);
  check("fold: claims the member's own queued rename notice", typeof f0 === "object" && f0 !== null && f0.candidate.id === "n9" && f0.candidate.type === "name_change" && JSON.stringify(f0.without) === JSON.stringify([leadA]), f0);
  const f1 = AN.nameFold(shiftCand("u-x", "s7"), [folded], [renameCand("u-other", "n8")]);
  check("fold: none queued for them, the rename's key is claimed under the announcement's own row", typeof f1 === "object" && f1 !== null && f1.candidate.id === "s7" && f1.candidate.type === "name_change" && f1.candidate.targetKey === NC.NAME_CHANGE_KEY && f1.candidate.topicKey === NC.NAME_CHANGE_KEY, f1);
}
{
  // Once: Jordan (told the name long ago) gets the shift once; a second send of the same candidate is refused at the ledger.
  const f = installFakeLedger(pool, sendblue);
  try {
    const jordan = person("Jordan", "+14155550301");
    f.ledger.sends.push({ user_id: jordan.userId, type: "name_change", target_key: NC.NAME_CHANGE_KEY, topic_key: NC.NAME_CHANGE_KEY, sent_at: new Date(day.getTime() - 20 * D), exempt: false, message: NC.NAME_CHANGE_TEXT });
    const c = shiftCand(jordan.userId, "s1");
    const drafted = await AN.draftAnnouncement(c, { approved: true, situation: async () => ({ hasOwnGoal: false }) });
    check("once: the draft (real ledger read) knows the rename reached him", "messages" in drafted && drafted.messages[0] === leadA, drafted);
    const first = await P.sendWithLedgerForTests(c, jordan, [leadA]);
    const second = await P.sendWithLedgerForTests(c, jordan, [leadA]);
    check("once: it goes once, as its own text", first.sent === true && f.ledger.outbox.filter((m: any) => m.to === jordan.phoneNumber).length === 1, f.ledger.outbox);
    check("once: the second try is refused at the ledger", second.sent === false);
    const again = await AN.draftAnnouncement(c, { approved: true, situation: async () => ({ hasOwnGoal: false }) });
    check("once: the draft re-reads the ledger and skips once told", "skip" in again, again);
    check("once: it counts as a paced text (not exempt), like the rename's own text", f.ledger.sends.some((s) => s.target_key === AN.SHIFT_KEY && !s.exempt));
  } finally {
    f.restore();
  }
}
{
  // Never two texts: Noor hasn't had the rename. The shift carries it; her queued rename is marked sent with it and never goes alone.
  const f = installFakeLedger(pool, sendblue);
  try {
    const noor = person("Noor", "+14155550302");
    const notice = renameCand(noor.userId, "n2");
    const c = shiftCand(noor.userId, "s2");
    const drafted = await AN.draftAnnouncement(c, { approved: true, situation: async () => ({ hasOwnGoal: false }) });
    check("not told: the draft (real ledger read) opens with the rename", "messages" in drafted && drafted.messages[0] === folded, drafted);
    const fold = AN.nameFold(c, [folded], [notice]);
    const sent = await P.sendWithLedgerForTests(c, noor, [folded], {}, [], fold as any);
    const own = await P.sendWithLedgerForTests(notice, noor, [NC.NAME_CHANGE_TEXT]);
    const renameDraft = await proactiveRegistry.name_change.draft(notice, noor);
    check("not told: one text, the name in it once", sent.sent === true && f.ledger.outbox.length === 1 && told(f.ledger.outbox, noor.phoneNumber) === 1, f.ledger.outbox);
    check("not told: the rename's key is ledgered with it and her queued notice marked sent", f.ledger.sends.filter((s) => s.target_key === NC.NAME_CHANGE_KEY).length === 1 && f.ledger.sentCandidates.includes("n2"), f.ledger);
    check("not told: the rename's own send afterwards is refused, and its draft skips", own.sent === false && "skip" in renameDraft && f.ledger.outbox.length === 1);
  } finally {
    f.restore();
  }
}
// After the fold, a later companion text with the rename riding finds the key taken and goes without it.
{
  const f = installFakeLedger(pool, sendblue);
  try {
    const ellis = person("Ellis", "+14155550303");
    const c = shiftCand(ellis.userId, "s3");
    const notice = renameCand(ellis.userId, "n3");
    await P.sendWithLedgerForTests(c, ellis, [folded], {}, [], AN.nameFold(c, [folded], [notice]) as any);
    const checkin = cand({ id: "c3", userId: ellis.userId, type: "companion", targetKey: "companion:after" });
    const without = ["Thinking of you before Thursday's demo."];
    const withLine = AR.rideAlong(without, NC.NAME_CHANGE_RIDE, (d, p) => carryLaneNotes(d, p));
    // A day later (the daily cap and the spacing rule would hold it today): the fake ledger's sends are "now", so move them back.
    f.ledger.sends.forEach((s) => (s.sent_at = new Date(Date.now() - 30 * H)));
    await P.sendWithLedgerForTests(checkin, ellis, withLine, {}, [], { candidate: notice, without });
    check("after the fold: a later text's riding line finds the key taken and goes without it", told(f.ledger.outbox, ellis.phoneNumber) === 1 && f.ledger.outbox.some((m: any) => m.content === without[0]), f.ledger.outbox);
  } finally {
    f.restore();
  }
}
{
  // A race: Sarah's companion text (rename riding) and the shift (rename folded) start together. The name is told exactly once, and
  // only the allowed shapes go: the check-in with or without the line, the shift folded or with its own lead.
  let twice = 0, never = 0, wrong = 0;
  for (let i = 0; i < 20; i++) {
    const f = installFakeLedger(pool, sendblue);
    try {
      const p = person("Sarah Hao", `+1415555${String(400 + i).padStart(4, "0")}`);
      const notice = renameCand(p.userId, `n${i}`);
      const c = shiftCand(p.userId, `s${i}`);
      const checkin = cand({ id: `c${i}`, userId: p.userId, type: "companion", targetKey: `companion:${i}` });
      const without = ["Hope the week's been kind."];
      const withLine = AR.rideAlong(without, NC.NAME_CHANGE_RIDE, (d, q2) => carryLaneNotes(d, q2));
      const sends = [() => P.sendWithLedgerForTests(checkin, p, withLine, {}, [], { candidate: notice, without }), () => P.sendWithLedgerForTests(c, p, [folded], {}, [], AN.nameFold(c, [folded], [notice]) as any)];
      await Promise.all(i % 2 ? sends.reverse().map((s) => s()) : sends.map((s) => s()));
      // The rename's own line ("going by Cue now") at most once; the shift's opening says the name too, by Royce's approved wording,
      // so a shift that lands after a riding rename line restates it once (allowed). Never lost: something said the name.
      const mine = f.ledger.outbox.filter((m: any) => m.to === p.phoneNumber);
      const renameLines = mine.filter((m: any) => /going by Cue now/i.test(m.content)).length;
      if (renameLines > 1) twice++;
      if (told(f.ledger.outbox, p.phoneNumber) === 0) never++;
      // Whatever went: only the two allowed shapes of the shift, and the check-in with or without the line.
      const ok = f.ledger.outbox.every((m: any) => [folded, leadA, without[0], withLine[0]].includes(m.content));
      if (!ok) wrong++;
    } finally {
      f.restore();
    }
  }
  check("race, 20 runs either way round: the rename line at most once, the name never lost, and only allowed texts", twice === 0 && never === 0 && wrong === 0, { twice, never, wrong });
}

// ---------------------------------------------------------------- 9. the 2026-11-02 update (Royce: "go with the list, drop the page")
{
  const U = AN.UPDATE_1102;
  const APPROVED = [
    "A few things changed on my side:",
    '· Calls feel like a real conversation now, and I answer sooner\n· Tell me how often or when to reach you, like "once a day" or "not on Sundays", and I\'ll keep to it\n· Send a voice memo anytime. If I reply in kind, it\'s the same voice as my calls',
    "Ask me to call you if you want to hear it.",
  ];
  check("11-02: in the registry, after the shift, approved by Royce (a code constant)", AN.ANNOUNCEMENTS.includes(U) && AN.ANNOUNCEMENTS.indexOf(U) > AN.ANNOUNCEMENTS.indexOf(AN.SHIFT) && AN.UPDATE_1102_APPROVED === true && U.approved === true);
  check("11-02: its own key and type, ends 21 days after it starts", U.key === "announcement:update-2026-11" && U.type === "announcement" && "daysAfterFirstQueued" in U.expires && U.expires.daysAfterFirstQueued === 21 && AN.announcementByKey(U.key) === U);
  check("11-02: Royce's approved copy, word for word, three texts in order", JSON.stringify(U.texts) === JSON.stringify(APPROVED), U.texts);
  check("11-02: texts only: no link, no page, no try line, no rename fold", !/https?:|www\.|\.com|\/\//.test(APPROVED.join(" ")) && U.tryLines.length === 0 && !U.foldLead);
  check("11-02: for members who joined before the first change landed (#345, 2026-11-02 18:45 UTC)", typeof U.audience === "object" && U.audience.joinedBefore.toISOString() === "2026-11-02T18:45:06.000Z");
  let reads = 0;
  const d = await AN.draftAnnouncement(cand({ id: "u1", userId: "u", type: "announcement", targetKey: U.key }), { told: async () => (reads++, false), situation: async () => { throw new Error("never read"); }, now: () => day });
  check("11-02 draft: the three texts as separate messages, one told read, no situation read", "messages" in d && JSON.stringify(d.messages) === JSON.stringify(APPROVED) && reads === 1, d);
  if ("messages" in d) {
    const bad = P.checkDraft(d.text, d.rules).filter((k) => !k.pass);
    check("11-02 draft: passes the proactive draft checks, and the dispatch's capitalizing leaves every word as approved", bad.length === 0 && d.messages.every((m) => capitalizeSentences(m) === m), bad);
  }
  check("11-02: the narration rule would refuse the opening ('on my side'); only that approved sentence is admitted, by exact match", P.checkDraft(APPROVED.join("\n"), AN.ANNOUNCEMENT_RULES).some((k) => k.name === "draft_narrates_state" && !k.pass) && JSON.stringify(U.narrationApproved) === JSON.stringify([APPROVED[0]]));
  check("narration admission is exact: a model draft with the same words in another sentence still fails", P.checkDraft("Nothing new on my side today.", { ...AN.ANNOUNCEMENT_RULES, approvedSentences: [APPROVED[0]] }).some((k) => k.name === "draft_narrates_state" && !k.pass) && P.checkDraft("A few things changed on my side: calls.", { ...AN.ANNOUNCEMENT_RULES, approvedSentences: [APPROVED[0]] }).some((k) => k.name === "draft_narrates_state" && !k.pass));
  const toldD = await AN.draftAnnouncement(cand({ id: "u2", userId: "u", type: "announcement", targetKey: U.key }), { told: async (_u, k) => k === U.key, now: () => day });
  check("11-02 draft: told already, nothing goes", "skip" in toldD);
  const unappr = await AN.draftAnnouncement(cand({ id: "u3", userId: "u", type: "announcement", targetKey: U.key }), { approved: false, told: async () => false, now: () => day });
  check("11-02 draft: unapproved waits", "defer" in unappr);
}
{
  // The queue: its own cutoff (no wait on the rename), test numbers and simulated members left out.
  const at = new Date("2026-11-04T17:40:00Z");
  const rows: Row[] = [
    member("u-jordan", { created_at: new Date("2026-10-01T00:00:00Z") }),
    member("u-after", { created_at: new Date("2026-11-03T01:00:00Z") }),
    { ...member("u-test"), phone_number: "+14155550142" } as any,
    { ...member("u-sim"), simulated: true } as any,
    member("u-archived", { archived_at: new Date("2026-10-01T00:00:00Z") }),
    member("u-optout", { sms_opted_out: true }),
  ];
  const e = enq(), f = fakeDb({ renameFirst: null, rows });
  const n = await AN.queueAnnouncement(AN.UPDATE_1102, at, { db: f.db, enqueue: e.enqueue, log: quiet });
  const users = f.seen.find((s) => /FROM users u/.test(s.sql));
  check("11-02 queue: its own cutoff, even before any rename", (users?.args[0] as Date)?.getTime() === AN.UPDATE_1102_JOINED_BEFORE.getTime() && users?.args[1] === AN.UPDATE_1102_KEY);
  check("11-02 queue: only the eligible member; joined after, test number, simulated, archived, opted out left out", n === 1 && e.calls.map((c) => c.userId).join() === "u-jordan" && e.calls[0].expiresAt.getTime() === at.getTime() + 21 * D, e.calls.map((c) => c.userId));
  check("audience reasons: each excluded member has its reason", AN.exclusionOf(rows[1], AN.UPDATE_1102_JOINED_BEFORE) === "joined_after" && AN.exclusionOf(rows[2] as any, AN.UPDATE_1102_JOINED_BEFORE) === "test_number" && AN.exclusionOf(rows[3] as any, AN.UPDATE_1102_JOINED_BEFORE) === "test_number" && AN.exclusionOf(rows[0], AN.UPDATE_1102_JOINED_BEFORE) === null);
  check("queue SQL reads the number and the simulated marker, so test members are left out in code", /u\.phone_number, COALESCE\(\(to_jsonb\(u\)->>'is_simulated'\)::boolean, false\) AS simulated/.test(src("services/announcements.ts")));
}
{
  // The monthly limit: one announcement a calendar month (Pacific), across every key.
  check("month: starts at Pacific midnight on the 1st", AN.monthStart(new Date("2026-11-04T17:40:00Z")).toISOString() === "2026-11-01T07:00:00.000Z" && AN.monthStart(new Date("2026-12-01T05:00:00Z")).toISOString() === "2026-11-01T07:00:00.000Z");
  check("month: nothing else this month, no block", AN.monthlyBlock(AN.UPDATE_1102_KEY, []) === null);
  check("month: its own sends never block it (it keeps going to the rest)", AN.monthlyBlock(AN.UPDATE_1102_KEY, [{ target_key: AN.UPDATE_1102_KEY, state: "sent", n: 3 }]) === null);
  check("month: another sent this month blocks it", /one announcement a month: announcement:shift went to 2 member/.test(AN.monthlyBlock(AN.UPDATE_1102_KEY, [{ target_key: AN.SHIFT_KEY, state: "sent", n: "2" }]) ?? ""));
  check("month: another still waiting to go blocks it", /still waits for 1/.test(AN.monthlyBlock(AN.UPDATE_1102_KEY, [{ target_key: AN.SHIFT_KEY, state: "pending", n: 1 }]) ?? ""));
  const blocking = (others: any[]) => {
    const seen: { sql: string; args: unknown[] }[] = [];
    return {
      seen,
      db: {
        query: async (sql: string, args: unknown[] = []) => {
          seen.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
          if (/target_key <> \$1/.test(sql)) return { rows: others };
          if (/FROM users u/.test(sql)) return { rows: [member("u-jordan")] };
          return { rows: [] };
        },
      },
    };
  };
  const at = new Date("2026-11-04T17:40:00Z");
  {
    const e = enq(), f = blocking([{ target_key: AN.SHIFT_KEY, state: "sent", n: 1 }]);
    const lines: string[] = [];
    const n = await AN.queueAnnouncement(AN.UPDATE_1102, at, { db: f.db, enqueue: e.enqueue, log: (l) => lines.push(l) });
    const q2 = f.seen.find((s) => /target_key <> \$1/.test(s.sql))!;
    check("month: another announcement went this month: nothing queued, said in the log, no member read", n === 0 && e.calls.length === 0 && !f.seen.some((s) => /FROM users u/.test(s.sql)) && lines.some((l) => /one announcement a month/.test(l)), lines);
    check("month: the read is from the 1st (Pacific), every other announcement key, sent or pending", q2.args[0] === AN.UPDATE_1102_KEY && (q2.args[1] as Date).toISOString() === "2026-11-01T07:00:00.000Z" && /type = 'announcement'/.test(q2.sql) && /status = 'pending'/.test(q2.sql));
  }
  {
    const e = enq(), f = blocking([]);
    const n = await AN.queueAnnouncement(AN.UPDATE_1102, at, { db: f.db, enqueue: e.enqueue, log: quiet });
    check("month: nothing else this month: queued", n === 1 && e.calls.length === 1);
  }
  {
    const e = enq(), f = blocking([{ target_key: AN.SHIFT_KEY, state: "sent", n: 1 }]);
    const n = await AN.queueAnnouncement(AN.RENAME, at, { db: f.db, enqueue: e.enqueue, log: quiet });
    check("month: the rename is its own notice, never held by the monthly limit", n === 1 && !f.seen.some((s) => /target_key <> \$1/.test(s.sql)));
  }
}
{
  // The preference gate (harness/notifyGate.ts, #356): a member's "none" rule holds an announcement, at the pick and inside the send lock.
  const NG = await import("../../src/harness/notifyGate.js");
  const MP = await import("../../src/services/memberPreferences.js");
  const none = { id: "7", area: "contact", covers: "all", channel: "all", basis: "explicit", type: "standing", words: ["no texts for now"], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: "America/Los_Angeles", state: "active", setAt: "", rule: MP.ruleFrom({ none: true }) } as any;
  const cls = NG.candidateClass("announcement", false, {});
  const held = NG.memberRuleCheck([none], { now: day, cls, channel: "text", sent: [] });
  check("gate: an announcement is Cue's own (unsolicited)", cls === "unsolicited");
  check("gate: a 'none' rule holds the 11-02 update", held.pass === false && /none while it lasts/.test(held.reason ?? ""), held);
  const unsolNone = NG.memberRuleCheck([{ ...none, covers: "unsolicited" }], { now: day, cls, channel: "text", sent: [] });
  check("gate: a 'none' rule on what Cue starts holds it too", unsolNone.pass === false);
  const checkinsOnly = NG.memberRuleCheck([{ ...none, area: "checkins", covers: "checkins" }], { now: day, cls, channel: "text", sent: [] });
  check("gate: a 'no check-ins' rule doesn't (an announcement isn't a check-in)", checkinsOnly.pass === true);
  check("gate: no rule, it passes", NG.memberRuleCheck([], { now: day, cls, channel: "text", sent: [] }).pass === true);
  const pr2 = src("harness/proactive.ts");
  check("gate: applied to every candidate before the pick and again inside the send lock", /memberRuleCheck\(state\.memberRules\.prefs, \{ now: state\.now, cls: candidateClass\(candidate\.type, answering, candidate\.payload\)/.test(pr2) && /const cls = candidateClass\(c\.type, answering, c\.payload\);\s*if \(!isSafetyFollowUp\(c\)\) \{\s*const \{ retryAt: _r, \.\.\.rule \} = await memberRuleGate\(client, \{ userId: person\.userId, now, cls, channel: "text" \}\);/.test(pr2));
}

console.log(`announcements: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
