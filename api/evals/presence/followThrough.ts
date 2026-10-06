// Post-event follow-through (services/eventFollowThrough.ts). Model-free: the model steps are swapped for fakes.
//   npx tsx evals/presence/followThrough.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const F = await import("../../src/services/eventFollowThrough.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

const msg = "Met Maya, she runs a design studio and we clicked. Jordan was fine but we didn't connect. Also Priya from the workshop, would love to follow up";
const met = (name: string, tone: any, note = "") => ({ name, tone, note });

// Who gets a note
check("a name has to be in their own message", F.nameIsTheirs("Maya", msg) && !F.nameIsTheirs("Ellis", msg) && !F.nameIsTheirs("May", msg));
const kept = F.worthKeeping([met("Maya", "positive", "we clicked"), met("Jordan", "critical"), met("Priya", "neutral"), met("Ellis", "positive"), met("maya", "positive")], msg);
check("only people they named and weren't critical of, once each", kept.map((m) => m.name).join() === "Maya,Priya");
check("at most three", F.worthKeeping(["A1", "B2", "C3", "D4"].map((n) => met(n, "positive")), "A1 B2 C3 D4 all great").length === 3);
check("nothing for a name that isn't theirs", F.worthKeeping([met("Ellis", "positive")], msg).length === 0);

// What a note may carry
const ctx = { theirMessage: msg, theirAsk: "seed investors in robotics", eventName: "Founders Night", theirFirstName: "Rae", otherName: "Maya", theirVoiceSample: ["sounds good, thanks", "can't do thursday"] };
check("a note built from their own words passes", F.noteProblem("Maya, great meeting you at Founders Night. I'd love to hear more about your design studio. Coffee next week?", ctx) === null);
check("a company or number they didn't give fails", F.noteProblem("Maya, great meeting you. Loved hearing about Acme and your 40 clients.", ctx) !== null);
check("a link, email or number fails", F.noteProblem("Maya, great meeting you. Mine is rae@example.com", ctx) !== null && F.noteProblem("Great meeting you, see https://x.co", ctx) !== null && F.noteProblem("Call me on 415 555 1234", ctx) !== null);
check("a claim about what the other person said fails", F.noteProblem("Maya, you told me she wanted to meet investors.", ctx) !== null && F.noteProblem("Maya, Co will follow up with you.", ctx) !== null);
check("too long fails", F.noteProblem("Maya, nice meeting you. ".repeat(40), ctx) !== null);
check("empty fails", F.noteProblem("  ", ctx) !== null);
check("their own ask and the names given are fair game", F.noteProblem("Maya, I'm looking for seed investors in robotics, and your studio could help. Coffee?", ctx) === null);

// The whole build, with fake model steps
const steps = (over: Partial<import("../../src/services/eventFollowThrough.js").Steps> = {}): any => ({
  alreadySent: async () => false,
  extractMet: async () => [met("Maya", "positive", "we clicked"), met("Jordan", "critical", "didn't connect"), met("Ellis", "positive", "invented"), met("Priya", "neutral", "workshop")],
  theirVoice: async () => ["sounds good, thanks"],
  theirAsk: async () => "seed investors in robotics",
  draftNote: async (o: any) => `${o.other.name}, great meeting you at ${o.eventName}. Coffee next week?`,
  ...over,
});
const o = { userId: "u1", firstName: "Rae", eventId: "ev1", eventName: "Founders Night", theirMessage: msg };
const r: any = await F.buildFollowThrough(o, steps());
check("a recap in their words, then one note each for Maya and Priya (not Jordan, not the invented name)", r.people === 2 && r.messages.length === 3 && /Maya \(we clicked\)/.test(r.messages[0]) && /^Maya:\n/.test(r.messages[1]) && /^Priya:\n/.test(r.messages[2]) && !r.messages.some((m: string) => /Jordan|Ellis/.test(m)));
check("the recap says Co won't send them", /I won't send them for you/.test(r.messages[0]));
let calls = 0;
const redo: any = await F.buildFollowThrough(o, steps({ draftNote: async (x: any) => { calls++; return calls % 2 === 1 ? `${x.other.name}, loved hearing about Acme.` : `${x.other.name}, great meeting you. Coffee?`; } }));
check("a draft that fails is redrafted once with the reason, and used when it then passes", redo.people === 2 && calls === 4);
const never: any = await F.buildFollowThrough(o, steps({ draftNote: async () => "Loved hearing about Acme, rae@example.com" }));
check("a draft that fails twice is dropped, and with none passing nothing is sent", "skip" in never);
const exc: any = await F.buildFollowThrough(o, steps({ draftNote: async () => { throw new Error("model down"); } }));
check("a model failure sends nothing", "skip" in exc);
check("only once per event", "skip" in ((await F.buildFollowThrough(o, steps({ alreadySent: async () => true }))) as any));
check("nothing when they named no one worth a note", "skip" in ((await F.buildFollowThrough(o, steps({ extractMet: async () => [met("Jordan", "critical")] }))) as any));
check("nothing when the model finds no one", "skip" in ((await F.buildFollowThrough(o, steps({ extractMet: async () => [] }))) as any));

// Structure: it can only ever reach the member, and reads nothing about anyone else
const s = src("services/eventFollowThrough.ts").replace(/\/\/.*$/gm, "");
check("it has no way to text or email anyone", !/sendblue|Resend|resend|sendEmail|sendMessage|sendText/i.test(s));
check("it reads nothing about other people (no profiles, rankings, graph or matching)", !/co_profiles|event_guest_rankings|peopleGraph|matching\.js|eventScoring|event_guest_match|users WHERE|FROM users/i.test(s));
check("every read is of the member's own messages and ask", (s.match(/FROM co_memories WHERE user_id = \$1/g) ?? []).length === 1 && /statedAsk\(userId\)/.test(s));
check("what it keeps is a count, never a name", /people_count INT/.test(src("db/migrations.ts")) && !/names?\s+(TEXT|JSONB)/.test(src("db/migrations.ts").slice(src("db/migrations.ts").indexOf("event_follow_throughs"), src("db/migrations.ts").indexOf("event_follow_throughs") + 300)));
check("it is queued only when they named someone good, and is an answer to them (not a new ask)", /if \(outcome === "named_positive"\) \{\s*const \{ enqueueCandidate \}/.test(src("routes/sendblue.ts")) && /"post_call", "event_followthrough"\]/.test(src("harness/proactive.ts")));
check("its model calls keep prompts out of the trace store", (src("services/eventFollowThrough.ts").match(/recordInputs: false, recordOutputs: false/g) ?? []).length === 2);
check("the model drafts in the member's register but is told not to say what the other person said", /Do not say what \$\{o\.other\.name\} said, felt or wants/.test(src("services/eventFollowThrough.ts")));

console.log(`follow-through rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
