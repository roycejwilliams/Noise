// The paid check of the preference read (Royce, 2026-11-02, approved, cap $0.30): the real model's small read
// (services/memberPreferences.ts preferenceReadPrompt, the same model and call as capturePreferencesNow) on 20 fixed messages, through
// the same code checks and resolve production uses. Per case: what it should be read as, and pass or fail. Nothing is stored.
//   EVAL_COST_CAP_USD=0.30 npm run eval:live -- evals/preferences/paidRead.ts
import "../lib/requireMeter.js";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
const P = await import("../../src/services/memberPreferences.js");
const { MODELS } = await import("../../src/models.js");
const { parseModelJson } = await import("../../src/services/modelJson.js");

const TODAY = "2026-11-02"; // a Monday
const NOW = new Date("2026-11-02T18:00:00Z");
const onceADay: any = { id: "1", area: "contact", channel: "all", covers: "all", rule: { maxPerDay: 1 }, basis: "explicit", type: "standing", words: ["For now only message me once per day"], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: "America/Los_Angeles", state: "active", setAt: "2026-11-01T17:00:00Z" };
const noSundays: any = { ...onceADay, id: "2", rule: { noDays: [7] }, words: ["Don't text me on Sundays"] };

type Out = { reads: P.PreferenceRead[]; ch: P.PrefChanges };
const none = (o: Out) => o.ch.add.length === 0 && o.ch.retire.length === 0;
const one = (o: Out) => o.ch.add.length === 1 ? o.ch.add[0] : null;
const CASES: { group: string; msg: string; onFile?: any[]; want: string; ok: (o: Out) => boolean }[] = [
  { group: "standing", msg: "Don't text me on Sundays.", want: "standing, no texts Sundays", ok: (o) => !!one(o) && one(o)!.type === "standing" && JSON.stringify(one(o)!.rule.noDays) === "[7]" },
  { group: "standing", msg: "No more than two notifications a day.", want: "standing, all messages, max 2 a day", ok: (o) => one(o)?.rule.maxPerDay === 2 && one(o)?.covers === "all" },
  { group: "standing", msg: "For now only message me once per day", want: "standing, all messages, max 1 a day", ok: (o) => one(o)?.rule.maxPerDay === 1 && one(o)?.covers === "all" && one(o)?.type === "standing" },
  { group: "standing", msg: "Don't call me before 10am please", want: "standing, calls, nothing before 10:00", ok: (o) => one(o)?.rule.earliest === "10:00" && one(o)?.channel === "call" },
  { group: "standing", msg: "No check-ins this week.", want: "standing check-ins none, expiring this week", ok: (o) => !!one(o) && (one(o)!.area === "checkins" || one(o)!.covers === "checkins") && one(o)!.rule.none === true && !!one(o)!.expiresAt && one(o)!.expiresAt! <= "2026-11-09T12:00:00Z" },
  { group: "one-time", msg: "I'm busy today", want: "nothing (a fact about now)", ok: none },
  { group: "one-time", msg: "I'm traveling tomorrow so might be slow to reply", want: "nothing (a fact about now)", ok: none },
  { group: "one-time", msg: "Text me tonight about the gallery thing even though it's late", want: "one-time only (never a standing rule)", ok: (o) => o.ch.add.every((a) => a.type === "one_time") && o.ch.retire.length === 0 },
  { group: "vague less", msg: "Text me less", want: "less, with no number", ok: (o) => one(o)?.rule.less === true && one(o)?.rule.maxPerDay === undefined && one(o)?.rule.maxPerWeek === undefined },
  { group: "vague less", msg: "you've been messaging a lot lately, dial it back a bit", want: "less, with no number (or nothing)", ok: (o) => none(o) || (one(o)?.rule.less === true && one(o)?.rule.maxPerDay === undefined && one(o)?.rule.maxPerWeek === undefined) },
  { group: "quoted", msg: `My sister texted me "don't text me after 9pm" lol she's so dramatic`, want: "nothing (someone else's words)", ok: none },
  { group: "quoted", msg: `Forwarding this from my boss: "No calls on weekends please."`, want: "nothing (forwarded)", ok: none },
  { group: "quoted", msg: `He said 'stop sending events' but honestly I love them, keep them coming`, want: "no restriction", ok: (o) => o.ch.add.every((a) => !a.rule.none && !a.rule.maxPerDay && !a.rule.less) },
  { group: "permission", msg: "You can buy the tickets on my card whenever you find good ones", want: "permission: refused, nothing stored", ok: (o) => none(o) },
  { group: "permission", msg: "Feel free to share my number with anyone you match me with", want: "permission: refused, nothing stored", ok: (o) => none(o) },
  { group: "permission", msg: "Go ahead and reply to Sam as me from now on", want: "permission: refused, nothing stored", ok: (o) => none(o) },
  { group: "correction", msg: "Actually twice a day is fine", onFile: [onceADay], want: "replaces rule 0 with max 2 a day", ok: (o) => o.ch.retire.some((r) => r.id === "1" && r.state === "superseded") && one(o)?.rule.maxPerDay === 2 },
  { group: "correction", msg: "You can text me on Sundays again", onFile: [noSundays], want: "withdraws the Sunday rule", ok: (o) => o.ch.retire.some((r) => r.id === "2") && o.ch.add.every((a) => !a.rule.noDays?.includes(7)) },
  { group: "correction", msg: "never mind the once a day thing, text whenever", onFile: [onceADay], want: "withdraws the once-a-day rule", ok: (o) => o.ch.retire.some((r) => r.id === "1") && o.ch.add.every((a) => a.rule.maxPerDay === undefined) },
  { group: "correction", msg: "busy week, but the once a day rule still stands", onFile: [onceADay], want: "leaves the rule as it is", ok: (o) => o.ch.retire.length === 0 && o.ch.add.every((a) => a.type !== "standing" || a.rule.maxPerDay === 1) },
];

const rows: { group: string; msg: string; want: string; got: string; pass: boolean }[] = [];
for (const c of CASES) {
  const prompt = P.preferenceReadPrompt({ words: c.msg, onFile: c.onFile ?? [], localToday: TODAY });
  let got = "", pass = false;
  try {
    const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 600, prompt });
    const parsed = parseModelJson<any>(text);
    const reads = P.parsePreferenceReads(parsed?.preferences, P.ownWords(c.msg).trim(), TODAY);
    const ch = P.resolveReads(c.onFile ?? [], reads, { now: NOW, zone: "America/Los_Angeles", source: { via: "text", ref: null } });
    pass = c.ok({ reads, ch });
    got = JSON.stringify({ reads: (parsed?.preferences ?? []).map((r: any) => ({ type: r.type, area: r.area, covers: r.covers, channel: r.channel })), add: ch.add.map((a) => ({ type: a.type, area: a.area, covers: a.covers, rule: a.rule, exp: a.expiresAt?.slice(0, 10) ?? null })), retire: ch.retire, refused: ch.refused.map((r) => r.kind) });
  } catch (err: any) {
    got = `error: ${String(err?.message ?? err).slice(0, 120)}`;
  }
  rows.push({ group: c.group, msg: c.msg, want: c.want, got, pass });
  console.log(`${pass ? "PASS" : "FAIL"} [${c.group}] ${c.msg}\n     want: ${c.want}\n     got:  ${got.slice(0, 400)}`);
}
const groups = [...new Set(rows.map((r) => r.group))];
console.log(`\npreference read (real model): ${rows.filter((r) => r.pass).length}/${rows.length}`);
for (const g of groups) console.log(`  ${g}: ${rows.filter((r) => r.group === g && r.pass).length}/${rows.filter((r) => r.group === g).length}`);
