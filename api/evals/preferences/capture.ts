// Member preferences, PR A (services/memberPreferences.ts): capture, store, resolve, see and change, text and call alike. Zero tokens:
// the model's answer is given as the JSON the learning read returns, and everything after it runs for real on an in-memory co_facts.
//   npx tsx evals/preferences/capture.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
const P = await import("../../src/services/memberPreferences.js");
const TL = await import("../../src/services/turnLearning.js");
const CL = await import("../../src/services/callLearning.js");
const W = await import("../../src/services/whatCoKnows.js");
const CC = await import("../../src/services/callContext.js");
const { default: pool } = await import("../../src/db/db.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- an in-memory co_facts (only the statements this file makes)
type Row = { id: number; owner_user_id: string; relation: string; subject: string; object_label: string; happened_at: Date; retired_at: Date | null; meta: any };
const facts: Row[] = [];
const handle = async (raw: string, a: any[] = []) => {
  const sql = raw.replace(/\s+/g, " ").trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
  if (/^SELECT id, object_label, happened_at, retired_at, meta FROM co_facts/.test(sql)) {
    const rows = facts.filter((r) => r.owner_user_id === a[0] && r.relation === "prefers" && (/retired_at IS NULL/.test(sql) ? !r.retired_at : true));
    return { rows: rows.map((r) => ({ ...r, meta: JSON.parse(JSON.stringify(r.meta)) })), rowCount: rows.length };
  }
  if (/^INSERT INTO co_facts/.test(sql)) {
    const id = facts.length + 1;
    facts.push({ id, owner_user_id: a[0], relation: "prefers", subject: "member", object_label: a[1], happened_at: a[4], retired_at: null, meta: JSON.parse(a[5]) });
    return { rows: [{ id }], rowCount: 1 };
  }
  if (/^UPDATE co_facts SET retired_at/.test(sql)) {
    const r = facts.find((x) => String(x.id) === String(a[0]) && x.owner_user_id === a[1] && !x.retired_at);
    if (!r) return { rows: [], rowCount: 0 };
    r.retired_at = a[2];
    r.meta.state = /withdrawn/.test(sql) ? "withdrawn" : a[3];
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE co_facts SET meta = meta \|\| jsonb_build_object\('askedAt'/.test(sql)) {
    for (const r of facts) if (r.owner_user_id === a[0] && a[1].includes(r.id)) r.meta.askedAt = a[2];
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const NY = "America/New_York";
const now = new Date("2026-11-02T17:11:00Z"); // Monday 12:11pm New York
const learn = (user: string, json: string, message: string, via: "text" | "call" = "text", at = now) =>
  P.learnPreferences(user, TL.parseTurnLearning(json)!.preferences, { message, zone: NY, now: at, source: { via, ref: "h1" } });
const read = (o: any) => JSON.stringify({ profile: {}, preferences: [o] });
const active = (user: string, at = now) => P.activePreferences(user, at);

// ---------------------------------------------------------------- capture: the incident, and the spec's examples
await learn(A, read({ type: "standing", area: "contact", covers: "all", channel: "all", basis: "explicit", rule: { max_per_day: 1 }, quote: "only message me once per day" }), "Will check it out. For now only message me once per day");
let a = await active(A);
check("'only message me once per day' is a hard per-day rule for all messages, in their words", a.length === 1 && a[0].rule.maxPerDay === 1 && a[0].covers === "all" && a[0].words[0] === "only message me once per day" && a[0].source.ref === "h1");
check("it lasts until they change it (no expiry)", a[0].expiresAt === null && P.inForce(a[0], new Date("2027-06-01T00:00:00Z")));

await learn(A, read({ type: "standing", area: "contact", covers: "all", channel: "text", basis: "explicit", rule: { no_days: ["sunday"] }, quote: "Don't text me on Sundays" }), "Don't text me on Sundays.");
a = await active(A);
check("'don't text me on Sundays' is its own rule for texts (a different scope from the daily cap)", a.length === 2 && a.some((p) => p.rule.noDays?.[0] === 7 && p.channel === "text"));

await learn(A, read({ type: "standing", area: "checkins", covers: "checkins", channel: "all", basis: "explicit", rule: { none: true }, expires_on: "2026-11-08", quote: "No check-ins this week" }), "No check-ins this week please");
a = await active(A);
const weekRule = a.find((p) => p.area === "checkins")!;
check("'no check-ins this week' covers check-ins only and ends at the end of Sunday in their zone", weekRule.covers === "checkins" && weekRule.rule.none === true && weekRule.expiresAt === "2026-11-09T04:59:59.999Z");
check("it expires on its own: in force Sunday night New York, gone Monday", P.inForce(weekRule, new Date("2026-11-09T04:00:00Z")) && !P.inForce(weekRule, new Date("2026-11-09T05:00:00Z")));
check("expired rules leave the active read", (await active(A, new Date("2026-11-10T12:00:00Z"))).every((p) => p.area !== "checkins"));

// ---------------------------------------------------------------- facts, other people's words, quotes and permissions
const before = facts.length;
await learn(A, read({ type: "standing", area: "contact", covers: "all", channel: "all", basis: "explicit", rule: { none: true }, quote: "don't text me ever" }), "I'm busy today, talk tomorrow");
check("a read whose quote isn't in their message is dropped (\"I'm busy today\" never becomes 'never contact me')", facts.length === before);
await learn(A, read({ type: "standing", area: "contact", covers: "all", channel: "all", basis: "explicit", rule: { none: true }, quote: "stop texting me" }), "My cofounder keeps saying \"stop texting me\" to recruiters lol");
check("words only inside quotation marks in their message are someone else's: not stored", facts.length === before);
check("the prompt rules out quoted and other people's words, and the prompt says busy today isn't a rule", /not something they quote or forward, not what someone else said or wants/.test(P.preferencePromptItem({ n: 10, onFile: [], localToday: "2026-11-02" })) && /"I'm busy today" is never "don't contact me"/.test(P.preferencePromptItem({ n: 10, onFile: [], localToday: "2026-11-02" })));
const permBefore = facts.length;
await learn(A, read({ type: "permission", area: "other", quote: "you can buy the tickets on my card" }), "you can buy the tickets on my card whenever");
await learn(A, read({ type: "permission", area: "other", quote: "share my number with anyone you match me with" }), "share my number with anyone you match me with");
check("a preference never grants spending or sharing: a permission is refused, nothing stored", facts.length === permBefore);
check("no rule has an area that could authorize spending, sharing, access or acting as them", P.PREF_AREAS.every((x) => ["contact", "checkins", "search_area", "reply_style", "other"].includes(x)));
// Only these modules read the rules; none of them spends, shares, grants access or acts as the member.
const readers: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.ts$/.test(f) && /memberPreferences\.js/.test(readFileSync(p, "utf8"))) readers.push(p.replace(/^.*\/src\//, ""));
  }
};
walk(new URL("../../src", import.meta.url).pathname);
const ALLOWED_READERS = ["services/turnLearning.ts", "services/callLearning.ts", "services/whatCoKnows.ts", "harness/replyGrounding.ts", "services/memberKnowledge.ts", "services/memberLimits.ts", "services/callContext.ts", "harness/notifyGate.ts", "harness/proactive.ts", "harness/callGate.ts", "services/eventScoring.ts"];
check(`the rules are read only where they restrict or are shown (${readers.join(", ")})`, readers.every((r) => ALLOWED_READERS.includes(r)));

// ---------------------------------------------------------------- precedence and changes
facts.length = 0;
await learn(A, read({ type: "standing", area: "contact", covers: "all", channel: "all", basis: "explicit", rule: { max_per_day: 2, no_days: ["sun"] }, quote: "No more than two notifications a day, and none on Sundays" }), "No more than two notifications a day, and none on Sundays");
await learn(A, read({ type: "standing", area: "contact", covers: "all", channel: "all", basis: "explicit", rule: { max_per_day: 3 }, replaces: [0], quote: "actually three a day is fine" }), "actually three a day is fine");
a = await active(A);
check("a correction replaces only the part it names: three a day, still none on Sundays", a.length === 1 && a[0].rule.maxPerDay === 3 && a[0].rule.noDays?.[0] === 7 && a[0].words.length === 2);
check("the old version is retired as superseded, not deleted", facts.some((r) => r.retired_at && r.meta.state === "superseded"));

await learn(A, read({ type: "one_time", area: "contact", covers: "all", channel: "text", basis: "explicit", rule: { latest: "23:00" }, quote: "text me tonight about the dinner even if it's late" }), "text me tonight about the dinner even if it's late");
a = await active(A);
check("a one-time exception is stored on its own and doesn't erase the standing rule", a.length === 2 && a.some((p) => p.type === "one_time" && p.expiresAt) && a.some((p) => p.type === "standing" && p.rule.maxPerDay === 3));

const inf = facts.length;
await learn(A, read({ type: "standing", area: "contact", covers: "all", channel: "all", basis: "inferred", rule: { max_per_day: 1 }, quote: "ugh so many texts" }), "ugh so many texts");
check("an inferred read never replaces what they said outright", facts.length === inf && (await active(A)).find((p) => p.type === "standing")!.rule.maxPerDay === 3);

// Vague "less": no invented number, one ask.
await learn(B, read({ type: "standing", area: "contact", covers: "unsolicited", channel: "all", basis: "explicit", rule: { less: true }, quote: "text me less" }), "can you text me less");
let b = await active(B);
check("'text me less' never becomes a number", b.length === 1 && b[0].rule.less === true && b[0].rule.maxPerDay === undefined && b[0].rule.maxPerWeek === undefined);
let rf = P.replyPreferenceFacts(b, now);
check("the reply is told to ask once how often, never to suggest a number", rf.askIds.length === 1 && rf.instructions.some((l) => /Ask once/.test(l) && /Never suggest a number/.test(l)));
await P.markLessAsked(B, rf.askIds, now);
rf = P.replyPreferenceFacts(await active(B), now);
check("asked once: the next reply isn't told to ask again", rf.askIds.length === 0);
await learn(B, read({ type: "standing", area: "contact", covers: "unsolicited", channel: "all", basis: "explicit", rule: { max_per_week: 2 }, replaces: [0], quote: "twice a week is plenty" }), "twice a week is plenty");
b = await active(B);
check("their answer replaces the vague rule with their number", b.length === 1 && b[0].rule.maxPerWeek === 2 && !b[0].rule.less);

// ---------------------------------------------------------------- cross-member isolation
check("one member's rules are never another's", (await active(A)).every((p) => !p.words.includes("twice a week is plenty")) && (await active(B)).every((p) => !p.words.some((w) => /three a day/.test(w))));
const aId = (await active(A))[0].id;
check("a withdrawal under another member's id changes nothing", !(await P.withdrawPreference(pool as any, B, aId)));

// ---------------------------------------------------------------- see and change: what-Cue-knows, text and call alike
const items = W.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], prefs: (await active(A)).map((p) => ({ id: p.id, text: P.describePreference(p), quote: p.words[p.words.length - 1] })) });
const prefItem = items.find((i) => i.source === "pref" && /3/.test(i.text));
check("what-Cue-knows shows each rule in plain words with their latest words", !!prefItem && prefItem.text === "how you asked me to work: at most 3 messages from me a day; no messages from me on Sundays" && prefItem.theirWords === "actually three a day is fine");
const applied = await W.applyOne(pool as any, A, { prefs: [] } as any, prefItem!, "remove", null, "forget the three a day thing");
check("removing it there withdraws it (retired, state withdrawn)", "source" in applied && applied.source === "pref" && facts.find((r) => String(r.id) === prefItem!.ref.split(":")[1])?.meta.state === "withdrawn");
check("a withdrawn rule is gone from the active read", !(await active(A)).some((p) => p.id === prefItem!.ref.split(":")[1]));
check("a withdrawn rule can't come back from older words: a new rule needs a quote in the new message", P.parsePreferenceReads([{ type: "standing", area: "contact", rule: { max_per_day: 3 }, quote: "three a day is fine" }], "thanks!", "2026-11-02").length === 0);
check("the call path can see and change it too: whatCoKnows and correctWhatCoKnows are call tools", /tool: "whatCoKnows",\s*limits/.test(src("services/capabilities.ts")) && /onCall: true,\s*tool: "whatCoKnows"/.test(src("services/capabilities.ts")) && /onCall: true,\s*tool: "correctWhatCoKnows"/.test(src("services/capabilities.ts")));
check("a rule can only be removed there; a new one is said in conversation", prefItem!.canCorrect === false && W.fieldFor(prefItem!.ref) === "a rule they set for how Cue treats them");
check("a rule no path applies yet says so", P.describePreference({ area: "search_area", covers: "unsolicited", channel: "all", rule: { place: "SF" }, expiresAt: null, zone: NY, type: "standing", basis: "explicit" }) === "look for things in SF (noted, not applied yet)");

// ---------------------------------------------------------------- call parity: captured from calls, read on calls
const tp = TL.turnLearningPrompt({ transcript: "", message: "", today: "2026-11-02", onFile: null, openAsks: [], styleNotes: [], coSaidBefore: null });
const cp = CL.callLearningPrompt({ transcript: "user: no calls on weekends please", today: "2026-11-02", onFile: null, openAsks: [] });
check("text and call learning reads both ask for preferences, with the same JSON", /10\. preferences:/.test(tp) && /7\. preferences:/.test(cp) && tp.includes(P.PREFERENCE_JSON_SHAPE) && cp.includes(P.PREFERENCE_JSON_SHAPE));
check("on a call, quotes come from their own lines on the call", /in their own lines on this call/.test(cp) && /their own line on the call/.test(cp));
check("the call's learning stores them through the same resolve and store, quotes checked against their lines", /learnPreferences\(input\.userId, learned\.preferences, \{ message: theirLines\(input\.transcript\)/.test(src("services/callLearning.ts")) && /learnFromCall\(\{ userId: user_id, transcript: cleanTranscript, callRef:/.test(src("routes/co.ts")));
await learn(B, read({ type: "standing", area: "contact", covers: "unsolicited", channel: "call", basis: "explicit", rule: { no_days: ["sat", "sun"] }, quote: "no calls on weekends please" }), "user: no calls on weekends please", "call");
check("a rule said on a call is stored with the call as its source", (await active(B)).some((p) => p.source.via === "call" && p.channel === "call" && p.rule.noDays?.join() === "6,7"));
const lines = CC.callFitLines({ preferences: [], claims: [], identity: { zone: NY } as any, limits: { avoid: [], availability: null, rules: await active(B), verifiedAt: now.toISOString() } } as any);
const textFacts = P.replyPreferenceFacts(await active(B), new Date());
check("a call gets the same rule lines a text reply gets (callFitLines from the member record's limits)", lines.some((l) => /The rules they set/.test(l) && textFacts.known.every((k) => l.includes(k))));
check("both call engines read that context (ElevenLabs and GPT-Live through buildCallContextSummary), and the record carries the rules", /buildCallContextSummary/.test(src("services/callTrigger.ts")) && /takeCallContext\(userId, buildCallContextSummary\)/.test(src("routes/co.ts")) && /P\.activePreferences\(userId\)/.test(src("services/memberKnowledge.ts")) && /"limits"/.test(src("services/callContext.ts").match(/CALL_KNOWLEDGE[^\n]*/)![0]));
check("the call prompt tells the call to keep to them", /The rules they set for how you treat them are listed there too/.test(readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8")));
check("the text reply reads them (replyGrounding)", /replyPreferenceFacts\(prefs, new Date\(\)\)/.test(src("harness/replyGrounding.ts")));

// ---------------------------------------------------------------- logs carry ids, never their words
check("the decision log for a stored rule carries ids, kinds and fields, never their words", (() => { const s = src("services/memberPreferences.ts"); const block = s.slice(s.indexOf('decision: "member.preference",\n    userId,\n    outcome: "act"'), s.indexOf("return { added, retired };\n}")); return block.length > 0 && !/words|quote/.test(block.replace(/never their words/g, "")); })());

console.log(`preferences capture: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
