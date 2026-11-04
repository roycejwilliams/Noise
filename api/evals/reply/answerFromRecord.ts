// Answering from the record (2026-11-04, Royce's own thread): "Where is that one located?" about Founder Table (sent Oct 30, San Francisco,
// needs host approval) got "nothing on file", and "What day did you send that" got "no worries, easy to miss". Layer 1: zero tokens, no
// database (the one stored-offer read takes a fake db). Whether the model words the answer well is unverified until a paid run.
//   npx tsx evals/reply/answerFromRecord.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";

const T = await import("../../src/services/turnContext.js");
const G = await import("../../src/harness/replyGrounding.js");
const M = await import("../../src/harness/moveCheck.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) { failed++; process.stdout.write(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}\n`); }
};

const NOW = new Date("2026-11-04T18:00:00.000Z");
const FT_URL = "https://lu.ma/founder-table";
const details = { startAt: "2026-11-03T18:00:00-08:00", endAt: null, timezone: "America/Los_Angeles", online: false, venue: null, address: null, city: "San Francisco", hosts: [], price: null, spotsRemaining: null, requiresApproval: true, soldOut: null, guestCount: null, description: "A small dinner for YC founders." };
const item = (name: string, url: string, daysAgo: number, extra: any = {}): import("../../src/services/turnContext.js").SentItem => ({ key: `name:${name.toLowerCase()}`, name, kind: "event", url, sentAt: new Date(NOW.getTime() - daysAgo * 86_400_000), reaction: null, details: null, postText: null, ...extra });
const founder = item("Founder Table", FT_URL, 5.2, { details, city: "San Francisco" });
const sent = [item("Salon Night", "https://lu.ma/salon", 2), item("Rooftop Supper", "https://lu.ma/rooftop", 3), founder];
const DEBRIEF = "User said: ok\nCo replied: Hey, did you end up making it into Founder Table?";
const lastCo = "Hey, did you end up making it into Founder Table?";

// 1. The find's stored fields, with the send date and the link.
{
  const facts = T.sentFindFacts(founder, NOW, "America/Los_Angeles").join(" ");
  check("1. Founder Table facts carry San Francisco, the link and the day Cue sent it (Oct 30)", /San Francisco/.test(facts) && facts.includes(FT_URL) && /on Oct 30/.test(facts), facts);
  check("1. ...and say the street address is only shown to registered guests, not 'nothing on file'", /only shown to registered guests/.test(facts) && /needs host approval/i.test(facts) && !/nothing on file/i.test(facts), facts);
  const bare = T.sentFindFacts(item("Bare", "https://lu.ma/bare", 6, { city: "Oakland" }), NOW).join(" ");
  check("1. a find with only its stored city (no saved page) still says the city and the link", /Oakland/.test(bare) && bare.includes("https://lu.ma/bare"), bare);
}
// 2. The five-day window used to drop it; the referent keeps it.
{
  const plain = T.sentDetailLines({ sent }, 5, NOW).join(" ");
  check("2. without a referent a find past five days is not in the lines (the old window)", !/Founder Table/.test(plain));
  const ref = T.referredSent(sent, { message: "Where is that one located?", lastCoText: lastCo });
  check("2. 'Where is that one located?' after the debrief resolves to Founder Table, not the two newer finds", ref.length === 1 && ref[0].name === "Founder Table", ref.map((r) => r.name));
  const lines = T.sentDetailLines({ sent }, 5, NOW, { also: ref }).join(" ");
  check("2. ...and its city and link are in the reply's lines though newer finds exist", /San Francisco/.test(lines) && lines.includes(FT_URL), lines);
  const viaMeant = T.referredSent(sent, { message: "what day did you send that", meantLabel: "Founder Table", meantUrl: null });
  check("2. the turn read's referent (meant) resolves it with no name in the question", viaMeant[0]?.name === "Founder Table");
  check("2. 'what day did you send that' gets Oct 30 in the same facts", /on Oct 30/.test(T.sentFindFacts(viaMeant[0], NOW, "America/Los_Angeles").join(" ")));
  check("2. a question with no find in the thread and no name resolves to nothing (no guess)", T.referredSent(sent, { message: "where should I eat tonight?", lastCoText: "Sounds good." }).length === 0);
}
// 3. The stored offer, by name, back to when it went out (not the newest one in the last three days).
{
  const rowFor = (name: string, city: string, url: string) => ({ content: JSON.stringify({ match: { name, url, city, kind: "co_event", details: { ...details, city } } }) });
  const sqls: { sql: string; args: unknown[] }[] = [];
  const db = { query: async (sql: string, args: unknown[] = []) => (sqls.push({ sql, args }), { rows: [rowFor("Founder Table Extra", "Austin", "https://lu.ma/other"), rowFor("Founder Table", "San Francisco", FT_URL)] }) };
  const rf: any = { facts: [], instructions: [] };
  const found = await G.addStoredOfferFacts(rf, "u1", "Founder Table", "America/Los_Angeles", db);
  const text = rf.facts.map((f: any) => f.text).join(" ");
  check("3. the stored offer is found by name and gives San Francisco and the link", found && /San Francisco/.test(text) && text.includes(FT_URL) && !/Austin/.test(text), text);
  check("3. the read is by name over 45 days with no LIMIT 1 and the member's own user id", /45 days/.test(sqls[0].sql) && !/LIMIT 1\b/.test(sqls[0].sql) && sqls[0].args[0] === "u1" && /ILIKE/.test(sqls[0].sql), sqls[0]);
}
// 4. The non-answer.
{
  const q = "What day did you send that I must've missed it";
  const dodge = "No worries, easy to miss in the middle of everything else going on.";
  check("4. 'No worries, easy to miss' to 'what day did you send that' is a miss (no record needed)", M.moveMisses(dodge, null, q).some((m) => m.name === "non_answer"));
  check("4. ...also with a record whose read says answer", M.moveMisses(dodge, { done: [], unresolved: [], priorMeant: [], read: { move: "answer", meant: null, told: [], closes: [], reopens: [], again: null } }, q).some((m) => m.name === "non_answer"));
  check("4. the answer passes", M.moveMisses("I sent Founder Table on Oct 30. Here's the link: " + FT_URL, null, q).length === 0);
  check("4. an honest 'the address shows after approval, here's the link' passes", M.moveMisses("It's in San Francisco, and the address only shows after the host approves you. Here's the link: " + FT_URL, null, "Where is that one located?").length === 0);
  check("4. a brief honest 'I don't know' passes even with a reassurance", M.moveMisses("No worries, I don't have the exact day in front of me, but the link is " + FT_URL, null, q).length === 0);
  check("4. a reassurance to a plain statement (no question) is not a miss", M.moveMisses("No worries, easy to miss.", null, "sorry I missed your text").length === 0);
  const note = M.moveRedraftNote(M.moveMisses(dodge, null, q), null);
  check("4. the rewrite note works with no record and carries no canned line", /Not sent/.test(note) && /Rewrite it in your own words/.test(note), note);
}
// 5. Calls: the same facts (callContext builds its lines from the same functions, with the finds Cue's recent texts named).
{
  const named = T.sentNamedIn(sent, ["Hey, did you end up making it into Founder Table?"]);
  check("5. call: the find Cue's last text named is picked out of the sent list though it is past five days", named.length === 1 && named[0].name === "Founder Table", named.map((n) => n.name));
  const lines = T.sentDetailLines({ sent }, 7, NOW, { also: named, zone: "America/Los_Angeles" }).join(" ");
  check("5. call: its lines have San Francisco, the link and Oct 30", /San Francisco/.test(lines) && lines.includes(FT_URL) && /Oct 30/.test(lines), lines);
  check("5. call: nothing named in the thread means no extra finds", T.sentNamedIn(sent, ["How was your week?"]).length === 0);
}
console.log(`answer from record: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
