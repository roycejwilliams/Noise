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
check("only people they named and were positive about, once each (neutral and critical are not connections worth keeping)", kept.map((m) => m.name).join() === "Maya");
check("the note shown back as theirs has to be in their own message, else it is blanked", F.worthKeeping([met("Maya", "positive", "we clicked")], msg)[0].note === "we clicked" && F.worthKeeping([met("Maya", "positive", "she is a genius investor")], msg)[0].note === "");
check("at most three", F.worthKeeping(["A1", "B2", "C3", "D4"].map((n) => met(n, "positive")), "A1 B2 C3 D4 all great").length === 3);
check("nothing for a name that isn't theirs", F.worthKeeping([met("Ellis", "positive")], msg).length === 0);

// What a note may carry
const ctx = { theirNote: "we clicked, she runs a design studio", theirAsk: "seed investors in robotics", eventName: "Founders Night", theirFirstName: "Rae", otherName: "Maya" };
check("a note built from their own words passes", F.noteProblem("Maya, great meeting you at Founders Night. I'd love to hear more about your design studio. Coffee next week?", ctx) === null);
check("a company or number they didn't give fails", F.noteProblem("Maya, great meeting you. Loved hearing about Acme and your 40 clients.", ctx) !== null);
check("contact details in any common disguise fail", ["Call me at (415) 555-1234", "maya at acme dot com", "ping @mayachen", "see acme.com", "415.555.1234 works", "linkedin.com/in/x"].every((t) => F.noteProblem(`Maya, great meeting you. ${t}`, ctx) !== null));
check("a number with a sign or a suffix, or a lowercase-start name after a colon, fails", ["Maya, we should talk about the $40k round.", "Maya, 40% of it works.", "Maya, loved it: Acme was great.", "Maya, it was the 2nd time."].every((t) => F.noteProblem(t, ctx) !== null));
check("an em dash or an exclamation point fails", F.noteProblem("Maya, great meeting you — coffee soon?", ctx) !== null && F.noteProblem("Maya, great meeting you! Coffee soon?", ctx) !== null);
check("a third party in their message can't ride into this person's note (grounded in their words about THIS person only)", F.noteProblem("Maya, great meeting you. I heard Stripe is going through a rough patch.", ctx) !== null);
check("a link, email or number fails", F.noteProblem("Maya, great meeting you. Mine is rae@example.com", ctx) !== null && F.noteProblem("Great meeting you, see https://x.co", ctx) !== null && F.noteProblem("Call me on 415 555 1234", ctx) !== null);
check("a claim about what the other person said fails", F.noteProblem("Maya, you told me she wanted to meet investors.", ctx) !== null && F.noteProblem("Maya, Cue will follow up with you.", ctx) !== null);
check("too long fails", F.noteProblem("Maya, nice meeting you. ".repeat(40), ctx) !== null);
check("empty fails", F.noteProblem("  ", ctx) !== null);
check("their own ask and the names given are fair game", F.noteProblem("Maya, I'm looking for seed investors in robotics, and your studio could help. Coffee?", ctx) === null);

// The whole build, with fake model steps
const steps = (over: Partial<import("../../src/services/eventFollowThrough.js").Steps> = {}): any => ({
  alreadySent: async () => false,
  notGoing: async () => false,
  extractMet: async () => [met("Maya", "positive", "we clicked"), met("Jordan", "critical", "didn't connect"), met("Ellis", "positive", "invented"), met("Priya", "positive", "workshop")],
  theirVoice: async () => ["sounds good, thanks"],
  theirAsk: async () => "seed investors in robotics",
  draftNote: async (o: any) => `${o.other.name}, great meeting you at ${o.eventName}. Coffee next week?`,
  ...over,
});
const o = { userId: "u1", firstName: "Rae", eventId: "ev1", eventName: "Founders Night", theirMessage: msg };
const r: any = await F.buildFollowThrough(o, steps());
check("a recap in their words, then one note each for Maya and Priya (not Jordan, not the invented name)", r.people === 2 && r.messages.length === 3 && /Maya \(we clicked\)/.test(r.messages[0]) && /^Maya:\n/.test(r.messages[1]) && /^Priya:\n/.test(r.messages[2]) && !r.messages.some((m: string) => /Jordan|Ellis/.test(m)));
check("the recap says Cue won't send them", /I won't send them for you/.test(r.messages[0]));
let calls = 0;
const redo: any = await F.buildFollowThrough(o, steps({ draftNote: async (x: any) => { calls++; return calls % 2 === 1 ? `${x.other.name}, loved hearing about Acme.` : `${x.other.name}, great meeting you. Coffee?`; } }));
check("a draft that fails is redrafted once with the reason, and used when it then passes", redo.people === 2 && calls === 4);
const never: any = await F.buildFollowThrough(o, steps({ draftNote: async () => "Loved hearing about Acme, rae@example.com" }));
check("a draft that fails twice is dropped, and with none passing nothing is sent", "skip" in never);
const exc: any = await F.buildFollowThrough(o, steps({ draftNote: async () => { throw new Error("model down"); } }));
check("a model failure sends nothing", "skip" in exc);
check("nothing for someone who told Cue they weren't going", "skip" in ((await F.buildFollowThrough(o, steps({ notGoing: async () => true }))) as any));
check("only once per event", "skip" in ((await F.buildFollowThrough(o, steps({ alreadySent: async () => true }))) as any));
check("nothing when they named no one worth a note", "skip" in ((await F.buildFollowThrough(o, steps({ extractMet: async () => [met("Jordan", "critical")] }))) as any));
check("nothing when the model finds no one", "skip" in ((await F.buildFollowThrough(o, steps({ extractMet: async () => [] }))) as any));

// The voice sample is the member's own words only: Co's quoted text and photo lines are stripped
{
  const { default: pool } = await import("../../src/db/db.js");
  const realQ = (pool as any).query;
  (pool as any).query = async () => ({ rows: [
    { content: `User said: ok [Replying to Cue's text: "Maya: looking for seed investors in robotics"]` },
    { content: `User said: sounds good [They also sent a photo showing: a whiteboard with Acme]` },
    { content: `User said: [sent a photo showing: a menu]` },
    { content: `User said: can't do thursday` },
  ] });
  try {
    const v = await F.theirVoice("u1");
    check("quoted Cue text and photo descriptions never reach the draft as the member's voice", v.join("|") === "ok|sounds good|can't do thursday" && !v.some((l) => /Maya|investors|Acme|menu|Replying/.test(l)));
  } finally {
    (pool as any).query = realQ;
  }
}

// What the harness checks is the recap (Co's words), not the notes (theirs, checked line by line): a set for several people passes
{
  const { checkDraft } = await import("../../src/harness/proactive.js");
  const many: any = await F.buildFollowThrough(o, steps({ extractMet: async () => [met("Maya", "positive", "we clicked"), met("Priya", "positive", "workshop")], draftNote: async (x: any) => `${x.other.name}, great meeting you. Coffee next week?` }));
  const failed = checkDraft(many.messages[0], { maxSentences: 6, maxChars: 900, mustIncludeAny: ["founders"] }).filter((c) => !c.pass).map((c) => c.name);
  check("the recap for two people passes the harness's text rules (the notes' own question marks don't block the set)", many.people === 2 && failed.length === 0);
  const joined = checkDraft(many.messages.join("\n\n"), { maxSentences: 6, maxChars: 900, mustIncludeAny: ["founders"] }).filter((c) => !c.pass).map((c) => c.name);
  check("(and the joined text would have been blocked: why only the recap goes through the harness)", joined.includes("draft_one_question"));
  const dash: any = await F.buildFollowThrough({ ...o, theirMessage: msg.replace("we clicked", "we clicked — loved it!!") }, steps({ extractMet: async () => [met("Maya", "positive", "we clicked — loved it!!")] }));
  check("a dash or exclamation points in what they said can't break the recap", !/[—–]|!/.test(dash.messages[0]));
}

// Structure: it can only ever reach the member, and reads nothing about anyone else
const s = src("services/eventFollowThrough.ts").replace(/\/\/.*$/gm, "");
check("the harness is handed the recap as the text to check, not the notes", /text: r\.messages\[0\], rules: \{ maxSentences: 6, maxChars: 900/.test(src("harness/proactiveRegistry.ts")));
check("the follow-through is not held for payload-first and not for a not-going member", /"event_followthrough"[,\]]/.test(src("harness/payloadFirst.ts")) && /steps\.notGoing\(o\.userId, o\.eventId\)/.test(src("services/eventFollowThrough.ts")));
check("it has no way to text or email anyone", !/sendblue|Resend|resend|sendEmail|sendMessage|sendText/i.test(s));
check("it reads nothing about other people (no profiles, rankings, graph or matching)", !/co_profiles|event_guest_rankings|peopleGraph|matching\.js|eventScoring|event_guest_match|users WHERE|FROM users/i.test(s));
check("every read is of the member's own messages and ask", (s.match(/FROM co_memories WHERE user_id = \$1/g) ?? []).length === 1 && /statedAsk\(userId\)/.test(s));
check("what it keeps is a count, never a name", /people_count INT/.test(src("db/migrations.ts")) && !/names?\s+(TEXT|JSONB)/.test(src("db/migrations.ts").slice(src("db/migrations.ts").indexOf("event_follow_throughs"), src("db/migrations.ts").indexOf("event_follow_throughs") + 300)));
check("it is queued only when they named someone good, and is an answer to them (not a new ask)", /if \(outcome === "named_positive"\) \{\s*const \{ enqueueCandidate \}/.test(src("routes/sendblue.ts")) && /"post_call", "event_followthrough"[,\]]/.test(src("harness/proactive.ts")));
check("its model calls keep prompts out of the trace store", (src("services/eventFollowThrough.ts").match(/recordInputs: false, recordOutputs: false/g) ?? []).length === 2);
check("the model drafts in the member's register but is told not to say what the other person said", /Do not say what \$\{o\.other\.name\} said, felt or wants/.test(src("services/eventFollowThrough.ts")));

console.log(`follow-through rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
