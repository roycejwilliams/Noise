// The member brief and the RSVP name question (services/eventBrief.ts). Model-free.
//   npx tsx evals/presence/brief.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const B = await import("../../src/services/eventBrief.js");
const pool = (await import("../../src/db/db.js")).default as any;
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const start = "2026-10-10T02:00:00.000Z"; // 7pm in San Francisco, Friday the 9th local
const rc = (id: string, score: number, shareReason?: string): any => ({ candidate_id: id, score, reason: "internal", shareReason, mutual: false, method: "ask" });
const members = [
  { user_id: "me", first_name: "Rae" },
  { user_id: "a", first_name: "Maya" },
  { user_id: "b", first_name: "Jordan" },
  { user_id: "c", first_name: "Ellis" },
  { user_id: "d", first_name: "Noor" },
  { user_id: "e", first_name: "Sam" },
];

// Timing
const w = B.briefWindow(start, "America/Los_Angeles")!;
check("it opens at 9am local the day before", w.from.toISOString() === "2026-10-08T16:00:00.000Z");
check("it closes 6 hours before the start, before the pre-arrival text (3 hours)", w.until.toISOString() === "2026-10-09T20:00:00.000Z" && B.BRIEF.closeBeforeStartMs > 3 * 3_600_000);
check("only registered members who haven't said they can't go, once, for a listed event", B.briefEligible({ registered: true, notGoing: false, alreadySent: false, eventListed: true }).ok && !B.briefEligible({ registered: false, notGoing: false, alreadySent: false, eventListed: true }).ok && !B.briefEligible({ registered: true, notGoing: true, alreadySent: false, eventListed: true }).ok && !B.briefEligible({ registered: true, notGoing: false, alreadySent: true, eventListed: true }).ok && !B.briefEligible({ registered: true, notGoing: false, alreadySent: false, eventListed: false }).ok);

// The question at RSVP
const now = new Date("2026-10-05T18:00:00Z");
check("the question goes once, to a registered member, while a brief is still ahead", B.nameAskDue({ registered: true, notGoing: false, alreadyAsked: false, startAt: start, now }) && !B.nameAskDue({ registered: true, notGoing: false, alreadyAsked: true, startAt: start, now }) && !B.nameAskDue({ registered: false, notGoing: false, alreadyAsked: false, startAt: start, now }) && !B.nameAskDue({ registered: true, notGoing: true, alreadyAsked: false, startAt: start, now }));
check("and not once it's too late for the answer to be used (10 hours before, so at least 4 hours before the brief closes)", !B.nameAskDue({ registered: true, notGoing: false, alreadyAsked: false, startAt: start, now: new Date("2026-10-09T21:00:00Z") }) && !B.nameAskDue({ registered: true, notGoing: false, alreadyAsked: false, startAt: start, now: new Date("2026-10-09T17:00:00Z") }) && B.nameAskDue({ registered: true, notGoing: false, alreadyAsked: false, startAt: start, now: new Date("2026-10-09T15:00:00Z") }));
const ask = B.nameAskMessages("Founders Night").join(" ");
check("the question is the agreed one, with no answer meaning no name", /can I mention you by name in the member brief\?/i.test(ask) && /If I don't hear, I won't/.test(ask) && B.NAME_QUESTION === "Can Co mention you by name in the member brief?");
check("their answer has to be their own clear yes or no", B.readNameAnswer("yes", "yes") === "yes" && B.readNameAnswer("yes please", "yes please!") === "yes" && B.readNameAnswer("no", "no thanks") === "no" && B.readNameAnswer("rather not", "I'd rather not") === "no" && B.readNameAnswer("yes", "no") === null && B.readNameAnswer("maybe", "maybe") === null && B.readNameAnswer("yes", "what is it for?") === null && B.readNameAnswer("", "yes") === null);
check("a yes with a no in it is not a yes", B.readNameAnswer("yes but don't use my last name", "yes but don't use my last name") === null);
check("the WHOLE message is read, not just the quote the model picked", B.readNameAnswer("yes", "yes I'm still coming but don't name me") === null && B.readNameAnswer("yes", "yes, leave my name out") === null && B.readNameAnswer("yes", "yes you can't use it") === null);
check("ok and please are not yeses on their own", B.readNameAnswer("ok", "ok") === null && B.readNameAnswer("please", "please leave my name out") === null && B.readNameAnswer("ok", "ok, leave me out") === null);
check("a long message is not a plain yes", B.readNameAnswer("yes", "yes " + "and then some other thing about my week ".repeat(6)) === null);
check("a plain no is a no, however it is said", B.readNameAnswer("no", "no thanks") === "no" && B.readNameAnswer("please don't", "please don't name me") === "no" && B.readNameAnswer("rather not", "I'd rather not") === "no");

// Who may be named
const named = B.pickNamed({
  ranked: [rc("a", 90, "raising a seed round"), rc("b", 80, "looking for a designer"), rc("c", 75, "wants robotics founders"), rc("d", 70, "hiring an engineer"), rc("e", 65, "looking for a lawyer")],
  recipientId: "me",
  members,
  nameOk: new Set(["a", "c", "d", "me"]),
  notGoing: new Set(["d"]),
});
check("only guests who said yes are named (b and e did not)", named.picks.map((p) => p.id).join() === "a,c");
check("a guest who said yes but can't go isn't named", !named.picks.some((p) => p.id === "d"));
check("everyone else who fits is counted, never named", named.unnamedFits === 2);
check("the reason is the guest's own words, nothing else", named.picks[0].reason === "raising a seed round" && named.picks[1].reason === "wants robotics founders");
const none = B.pickNamed({ ranked: [rc("a", 90, "raising a seed round")], recipientId: "me", members, nameOk: new Set(), notGoing: new Set() });
check("no answer means no name", none.picks.length === 0 && none.unnamedFits === 1);
check("never the recipient", B.pickNamed({ ranked: [rc("me", 99, "x")], recipientId: "me", members, nameOk: new Set(["me"]), notGoing: new Set() }).picks.length === 0);
check("no reason, no mention", B.pickNamed({ ranked: [rc("a", 90, "  "), rc("c", 90, undefined)], recipientId: "me", members, nameOk: new Set(["a", "c"]), notGoing: new Set() }).picks.length === 0);
check("below the in-room bar nobody is named or counted", B.pickNamed({ ranked: [rc("a", 59, "raising")], recipientId: "me", members, nameOk: new Set(["a"]), notGoing: new Set() }).picks.length === 0 && B.BRIEF.minScore === 60);
check("at most three are named", B.pickNamed({ ranked: ["a", "b", "c", "d", "e"].map((id, i) => rc(id, 95 - i, "reason " + id)), recipientId: "me", members, nameOk: new Set(["a", "b", "c", "d", "e"]), notGoing: new Set() }).picks.length === 3);
const dup = B.pickNamed({ ranked: [rc("a", 90, "raising")], recipientId: "me", members: [...members, { user_id: "z", first_name: "Maya" }], nameOk: new Set(["a"]), notGoing: new Set() });
check("a first name two guests share is never used (it could mean one who didn't say yes)", dup.picks.length === 0);
check("worth sending only with someone to name or a few who fit", B.worthSending(named.picks, 0) && B.worthSending([], 2) && !B.worthSending([], 1) && !B.worthSending([], 0));

// What it may say
const allowed = new Set(["a", "c"]);
check("a guest who didn't say yes is never named in the text", B.namesOutsiders("Maya is raising a seed round, and Jordan is looking for a designer.", members, allowed, "me") === "Jordan");
check("a guest who said yes may be", B.namesOutsiders("Maya is raising a seed round, and Ellis wants robotics founders.", members, allowed, "me") === null);
const accents = [...members, { user_id: "f", first_name: "José" }, { user_id: "g", first_name: "Anne-Marie" }, { user_id: "h", first_name: "Al" }];
check("accented, compound and two-letter names are caught too", B.namesOutsiders("Jose is raising a round.", accents, allowed, "me") === "José" && B.namesOutsiders("Anne is lovely.", accents, new Set(), "me") === "Anne-Marie" && B.namesOutsiders("Anne-Marie runs it.", accents, allowed, "me") === "Anne-Marie" && B.namesOutsiders("Al would love it.", accents, allowed, "me") === "Al");
check("the recipient's own name doesn't count", B.namesOutsiders("Rae, here's who's coming.", members, allowed, "me") === null);
check("the brief is a few bubbles, split on blank lines", B.briefBubbles("One.\n\nTwo.\n\n\nThree.").length === 3 && B.BRIEF.maxBubbles === 4);

// Wired
const reg = src("harness/proactiveRegistry.ts");
check("the brief names people only through pickNamed, then the in-room privacy gate per person, then the text checks", /B\.pickNamed\(/.test(reg) && /gateShareReason\(c\.userId, pk\.id, pk\.reason, "event_brief"\)/.test(reg) && /B\.namesOutsiders\(text, members, allowed, c\.userId\)/.test(reg) && /checkDraftFull\(text, \{ otherFirstName: pk\.firstName, otherOptedIn: false/.test(reg) && /privateFactLeak\(text, pk\.id\)/.test(reg));
check("a brief that breaks a rule twice is not sent", /brief broke a rule after one redraft/.test(reg));
check("the brief is drafted by the naming model", /model: MODELS\.sonnet/.test(reg));
check("the pre-arrival text still names no one", /return skip\(`named another guest/.test(reg) && /never name or describe another guest/.test(reg));
check("both are in the room lane, once per event each", /"pre_arrival", "event_brief", "brief_name_ask"[,\]]/.test(src("harness/proactive.ts")) && /targetKey: `event_brief:\$\{event\.api_id\}`/.test(src("services/eventBrief.ts")) && /targetKey: `brief_name_ask:\$\{event\.api_id\}`/.test(src("services/eventBrief.ts")));
check("the question is sent once and the send is recorded, with the event's start so a yes can't outlive the event", /name_asked_at = COALESCE\(event_presence\.name_asked_at, NOW\(\)\), name_ask_until = \$3/.test(reg) && /if \(f\.asked \|\| f\.notGoing\) return skip/.test(reg));
check("their answer is a tool Co chooses, guarded by their own words", /answerBriefName: tool\(/.test(src("agent/conversationTools.ts")) && /readNameAnswer\(theirWords, ctx\.resolvedContent\) !== answer/.test(src("agent/conversationTools.ts")) && /tool: "answerBriefName"/.test(src("services/capabilities.ts")));
check("the question, the brief and the pre-arrival text each have their own topic, so a silent member still gets the rest", /topicKey: `event_brief_ask:\$\{event\.api_id\}`/.test(src("services/eventBrief.ts")) && /topicKey: `event_brief:\$\{event\.api_id\}`/.test(src("services/eventBrief.ts")) && /topicKey: `event:\$\{event\.api_id\}`/.test(src("services/eventPresence.ts")));
check("a guest-list outage defers the brief instead of dropping it, and one event's failure never stops the others", /defer: new Date\(Date\.now\(\) \+ 30 \* 60_000\)/.test(reg) && /couldn't read the guests of/.test(src("services/eventBrief.ts")));
check("'others who fit' is only said when at least two do (one more would point at the third guest)", /unnamedFits >= B\.BRIEF\.minCountToMention \? \{/.test(reg) && !/\(picks\.length && unnamedFits\)/.test(reg));
check("the brief is not held for the payload-first step", /"brief_name_ask", "event_brief", "event_followthrough"/.test(src("harness/payloadFirst.ts")));
check("only an explicit yes is read as a yes in the data (no row, no answer, no all read as no)", /r\.name_ok === true/.test(src("services/eventBrief.ts")));

// Behavior against a fake database: an answer is recorded for the event they were asked about; no answer leaves them out
{
  const realQuery = pool.query;
  const calls: { q: string; p: any[] }[] = [];
  let asked: any[] = [{ event_api_id: "ev1" }];
  pool.query = async (q: string, p: any[]) => {
    calls.push({ q, p });
    if (/SELECT event_api_id FROM event_presence/.test(q)) return { rows: asked };
    if (/RETURNING event_api_id/.test(q)) return { rows: [{ event_api_id: "ev1" }, { event_api_id: "ev2" }] };
    if (/SELECT user_id, name_ok, not_going_at/.test(q)) return { rows: [{ user_id: "a", name_ok: true, not_going_at: null }, { user_id: "b", name_ok: false, not_going_at: null }, { user_id: "c", name_ok: null, not_going_at: null }] };
    return { rows: [], rowCount: 1 };
  };
  try {
    const r = await B.recordNameAnswer("u1", "yes", "yes please");
    const upd = calls.find((c) => /UPDATE event_presence SET name_ok = true/.test(c.q));
    check("a yes is recorded for the event they were asked about", r?.eventApiId === "ev1" && upd?.p[0] === "ev1" && upd?.p[1] === "u1" && /name_ok = true/.test(upd?.q ?? ""));
    calls.length = 0;
    await B.recordNameAnswer("u1", "no", "no thanks");
    const noUpd = calls.find((c) => /UPDATE event_presence SET name_ok = false/.test(c.q));
    check("a no is recorded for every event they were asked about, even after their own brief went out", !!noUpd && !/brief_sent_at/.test(noUpd.q) && /name_asked_at IS NOT NULL/.test(noUpd.q) && noUpd.p[0] === "u1");
    asked = [{ event_api_id: "evA" }, { event_api_id: "evB" }];
    calls.length = 0;
    const amb: any = await B.recordNameAnswer("u1", "yes", "yes");
    check("a yes with two questions open is ambiguous: nothing is recorded", amb && amb.ambiguous === true && !calls.some((c) => /UPDATE event_presence/.test(c.q)));
    check("a yes only counts for a question still open for an event ahead, and not yet answered", /name_ok IS NULL AND not_going_at IS NULL AND name_ask_until > NOW\(\)/.test(calls.find((c) => /SELECT event_api_id FROM event_presence/.test(c.q))!.q));
    asked = [{ event_api_id: "ev1" }];
    asked = [];
    calls.length = 0;
    check("with no question open nothing is recorded", (await B.recordNameAnswer("u1", "yes", "yes")) === null && !calls.some((c) => /UPDATE event_presence/.test(c.q)));
    const y = await B.namedYes("ev1", ["a", "b", "c", "x"]);
    check("only the explicit yes is in the set: a no, no answer and no row are all out", [...y.yes].join() === "a");
  } finally {
    pool.query = realQuery;
  }
}

console.log(`member brief rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
