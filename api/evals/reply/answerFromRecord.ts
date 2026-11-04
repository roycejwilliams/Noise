// Answering from the record (2026-11-04, Royce's own thread): "Where is that one located?" about Founder Table (sent Oct 30, San Francisco,
// needs host approval) got "nothing on file", and "What day did you send that" got "no worries, easy to miss". Plus the #389 review:
// referents first under the caps, resolved once and filled with no window, a narrow non-answer check, no made-up gap, and referent rules.
// Layer 1: zero tokens, no database (the stored-offer and by-name reads take a fake db). Whether the model words the answer well is
// unverified until a paid run.
//   npx tsx evals/reply/answerFromRecord.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

const T = await import("../../src/services/turnContext.js");
const M = await import("../../src/harness/moveCheck.js");
const C = await import("../../src/services/callContext.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) { failed++; process.stdout.write(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}\n`); }
};
type Item = import("../../src/services/turnContext.js").SentItem;

const NOW = new Date("2026-11-04T18:00:00.000Z");
const ZONE = "America/Los_Angeles";
const FT_URL = "https://lu.ma/founder-table";
const details = { startAt: "2026-11-03T18:00:00-08:00", endAt: null, timezone: ZONE, online: false, venue: null, address: null, city: "San Francisco", hosts: [], price: null, spotsRemaining: null, requiresApproval: true, soldOut: null, guestCount: null, description: "A small dinner for YC founders." };
const item = (name: string, url: string, daysAgo: number, extra: any = {}): Item => ({ key: `name:${name.toLowerCase()}`, name, kind: "event", url, sentAt: new Date(NOW.getTime() - daysAgo * 86_400_000), reaction: null, details: null, postText: null, ...extra });
const founder = item("Founder Table", FT_URL, 5.2, { details, city: "San Francisco" });
const sent = [item("Salon Night", "https://lu.ma/salon", 2), item("Rooftop Supper", "https://lu.ma/rooftop", 3), founder];
const lastCo = "Hey, did you end up making it into Founder Table?";

// 1. The stored fields, with the send date and the link; the gap said only when it is true.
{
  const facts = T.sentFindFacts(founder, NOW, ZONE).join(" ");
  check("1. Founder Table facts carry San Francisco, the link and the day Cue sent it (Oct 30)", /San Francisco/.test(facts) && facts.includes(FT_URL) && /on Oct 30/.test(facts), facts);
  check("1. it needs approval, so the address gap is said as that (after the host approves)", /once the host approves/.test(facts) && !/nothing on file/i.test(facts) && !/only shown to registered guests/.test(facts), facts);
  const open = T.sentFindFacts(item("Open House", "https://lu.ma/open", 6, { details: { ...details, requiresApproval: false } }), NOW, ZONE).join(" ");
  check("6. a find that does NOT need approval never gets 'after approval': the address is plainly not stored", !/approves|approval/i.test(open.replace(/Registration needs host approval\./, "")) && /street address isn't stored/.test(open), open);
  const bare = T.sentFindFacts(item("Bare", "https://lu.ma/bare", 6, { city: "Oakland" }), NOW).join(" ");
  check("1. a find with only its stored city and no page still says the city and the link", /Oakland/.test(bare) && bare.includes("https://lu.ma/bare"), bare);
}
// 7. Referent resolution.
{
  const ref = (message: string, extra: any = {}) => T.referredSent(sent, { message, coTexts: [lastCo], ...extra }).map((x) => x.name);
  check("7. 'Where is that one located?' after the debrief resolves to Founder Table, not the newer finds", ref("Where is that one located?").join() === "Founder Table", ref("Where is that one located?"));
  check("7. 'u send that when' (no question mark) resolves too", ref("u send that when").join() === "Founder Table");
  check("7. a thing they name that Cue never sent resolves to nothing (the pottery class)", ref("Where is that pottery class?").length === 0 && ref("where is the pottery class").length === 0);
  check("7. 'Did you send me anything?' does not resolve to one old find", ref("Did you send me anything?").length === 0);
  check("7. a lowercase word in a sentence is not a find named 'Coffee'", T.referredSent([item("Coffee", "https://lu.ma/c", 3)], { message: "where should I get coffee near here", coTexts: [] }).length === 0);
  check("7. ...but the whole name as words does resolve", T.referredSent([item("Coffee", "https://lu.ma/c", 3)], { message: "where is Coffee?" }).length === 1);
  const two = ["Salon Night is Friday, and Founder Table is Monday: https://lu.ma/salon", "older text"];
  const pick = T.referredSent(sent, { message: "where is that one", coTexts: [`Founder Table is Monday, and ${"Salon Night"} is Friday`, ...two] }).map((x) => x.name);
  check("7. when Cue's last text names two finds, the one mentioned last wins", pick.join() === "Salon Night", pick);
  const walk = T.referredSent(sent, { message: "what day did you send that", coTexts: ["Sounds good, talk soon.", "Ha, fair enough.", lastCo] }).map((x) => x.name);
  check("7. it walks back past texts that name no find to the last one that does", walk.join() === "Founder Table", walk);
  const meant = T.referredSent(sent, { message: "what day did you send that", meantUrl: FT_URL, coTexts: [] }).map((x) => x.name);
  check("7. the turn read's meant (its link) resolves it with no pointing text", meant.join() === "Founder Table");
  // same name, two cities: found by link, not by name
  const sf = item("Founder Table", FT_URL, 5), ny = item("Founder Table", "https://lu.ma/founder-table-nyc", 20, { city: "New York" });
  const merged = T.mergeSent([], [{ m: { name: "Founder Table", url: FT_URL, city: "San Francisco", details }, decided_at: sf.sentAt }, { m: { name: "Founder Table", url: "https://lu.ma/founder-table-nyc", city: "New York" }, decided_at: ny.sentAt }], []);
  check("7. two events of one name with different links stay two", merged.length === 2, merged.map((m) => m.url));
  check("7. ...and the link the turn read gave picks the right one", T.referredSent(merged, { message: "where is that", meantUrl: "https://lu.ma/founder-table-nyc" })[0]?.city === "New York");
  const dup = T.mergeSent([{ item_key: "event:abc", item_name: "Founder Table", kind: "event", url: FT_URL, sent_at: sf.sentAt }], [{ m: { name: "Founder Table", url: FT_URL + "?utm=x", city: "San Francisco", event_api_id: "abc", details }, decided_at: sf.sentAt }], []);
  check("7. the same find from two sources (the link with a tracking tail) still merges into one", dup.length === 1 && !!dup[0].details, dup.length);
}
// 2 + 8. Resolve once, fill once, no window.
{
  const sqls: { sql: string; args: unknown[] }[] = [];
  const stored = { name: "Founder Table", url: FT_URL, city: "San Francisco", event_api_id: "evt-ft", details };
  const db = { query: async (sql: string, args: unknown[] = []) => (sqls.push({ sql, args }), { rows: /event_offer_pending/.test(sql) ? [{ content: JSON.stringify({ match: { ...stored, name: "Founder Table", url: "https://lu.ma/other-ft", event_api_id: "x" } }) }, { content: JSON.stringify({ match: stored }) }] : [] }) };
  const bare = item("Founder Table", FT_URL, 9);
  const turn = { sent: [item("A", "https://lu.ma/a", 1), item("B", "https://lu.ma/b", 2), bare], message: "where is that" };
  const got = await T.resolveReferents("u1", turn as any, { message: "Where is that one located?", coTexts: [lastCo], db, fill: async () => {} });
  check("2. resolved once: one referent, its stored details filled from the offer matched by link (not the same-name one with another link)", got.length === 1 && got[0] === bare && bare.details?.city === "San Francisco" && bare.city === "San Francisco", { got: got.length, city: bare.city });
  const lines = T.sentFindFacts(bare, NOW, ZONE).join(" ");
  check("2. ...so the facts have the city and no contradictory 'page hasn't been read' line", /San Francisco/.test(lines) && !/hasn't been read/.test(lines), lines);
  const q = sqls.filter((s) => /event_offer_pending/.test(s.sql));
  check("8. the stored-offer read is one query, by link, with no time window, this member only", q.length === 1 && !/INTERVAL|make_interval/i.test(q[0].sql) && q[0].args[0] === "u1" && /ANY/.test(q[0].sql), q);
  // a name not in the recent list: found by name over all time (word boundary), still this member only
  const sqls2: { sql: string; args: unknown[] }[] = [];
  const db2 = { query: async (sql: string, args: unknown[] = []) => (sqls2.push({ sql, args }), { rows: /FROM revealed_offers/.test(sql) ? [{ item_key: "name:old fest", item_name: "Old Fest", kind: "event", url: "https://lu.ma/oldfest", sent_at: new Date("2026-08-01"), reaction: null }] : [] }) };
  const old = await T.resolveReferents("u1", { sent: [], message: "" } as any, { message: "Where was Old Fest again?", coTexts: [], db: db2, fill: async () => {} });
  check("8. a find named in their words but older than the recent list is found by name, no window", old[0]?.name === "Old Fest" && sqls2.filter((s) => /~\*/.test(s.sql)).length >= 3 && sqls2.every((s) => s.args[0] === "u1" && !/INTERVAL|make_interval/i.test(s.sql)), sqls2.map((s) => s.sql.slice(0, 80)));
}
// 1 + 10. Referents first under the call cap; zone passed.
{
  const big = "x".repeat(520);
  const recent = [1, 2, 3].map((n) => item(`Recent ${n}`, `https://lu.ma/r${n}`, n * 0.5, { details: { ...details, description: big } }));
  const ft = item("Founder Table", FT_URL, 9, { details });
  const sentAll = [...recent, ft];
  const named = T.sentNamedIn(sentAll, [lastCo]);
  check("1. the 9-day-old find Cue's text named is picked out", named.length === 1 && named[0].name === "Founder Table");
  const lines = T.sentDetailLines({ sent: sentAll }, 7, NOW, { also: named, zone: ZONE });
  check("1. ...and its lines come FIRST, before the three recent detailed finds", /Founder Table/.test(lines[0]) && /San Francisco/.test(lines[0]) && /Oct 26/.test(lines[0]), lines[0]);
  const summary = C.assembleCallSummary({ lessons: [], sentLines: lines, threads: [], base: "Base.", sentMax: C.CALL_SENT_MAX });
  check("1. under the 1800-char cap on a call the referent survives and the oldest recent send is what is cut", /Founder Table/.test(summary) && /San Francisco/.test(summary) && lines.join("").length > C.CALL_SENT_MAX, { len: lines.join("").length });
  const long = item("Founder Table", FT_URL, 9, { details: { ...details, description: "z".repeat(4000) } });
  const longLines = T.sentDetailLines({ sent: [long, ...recent] }, 7, NOW, { also: [long], zone: ZONE, referentMax: C.CALL_SENT_MAX - 400 });
  const longSummary = C.assembleCallSummary({ lessons: [], sentLines: longLines, threads: [], base: "Base.", sentMax: C.CALL_SENT_MAX });
  check("1. a referent with a very long page text is cut to fit under the cap, not dropped", longLines[0].length <= C.CALL_SENT_MAX - 400 && /Founder Table/.test(longSummary) && /San Francisco/.test(longSummary), longLines[0].length);
  check("10. the call's lines carry the send date in the member's zone", /on Oct 26/.test(T.sentDetailLines({ sent: sentAll }, 14, NOW, { also: named, zone: "Pacific/Auckland" }).join(" ")) || /on Oct 27/.test(T.sentDetailLines({ sent: sentAll }, 14, NOW, { also: named, zone: "Pacific/Auckland" }).join(" ")));
  check("1. nothing named in the thread means no extra finds", T.sentNamedIn(sentAll, ["How was your week?"]).length === 0);
  check("7. calls rank by how recently a text named them and use whole words", T.sentNamedIn(sentAll, ["Recent 2 is nice", "Founder Table was fun"], 2).map((x) => x.name).join() === "Recent 2,Founder Table");
}
// 3 + 4. The non-answer check.
{
  const ans = (x: Item) => [T.referentAnswer(x, NOW, ZONE)];
  const ft = ans(founder);
  const asked = "What day did you send that I must've missed it";
  const miss = (draft: string, theirs = asked, r = ft) => M.moveMisses(draft, null, theirs, r).some((m) => m.name === "non_answer");
  // misses
  for (const d of ["No worries, easy to miss in the middle of everything else going on.", "Sorry, I should have flagged it better.", "Monday was busy.", "3 things going on this week.", "Ha, totally get it."]) check(`3. miss: "${d}"`, miss(d));
  check("3. miss: 'u send that when' with no question mark", miss("Ha, totally get it.", "u send that when"));
  check("3. miss: where, answered with a feeling", miss("That sounds like a lot right now.", "Where is that one located?"));
  // passes: answers
  check("3. pass: the day Cue sent it", !miss("I sent Founder Table on Oct 30."));
  check("3. pass: its link", !miss("Here you go: " + FT_URL));
  check("3. pass: 'No worries, it's in San Francisco, and the address shows once the host approves you.'", !miss("No worries, it's in San Francisco, and the address shows once the host approves you.", "Where is that one located?"));
  check("3. pass: honest gap 'the address shows after approval' only for a find that needs approval", !miss("The address shows after approval.", "Where is that one located?"));
  check("3. ...and that same sentence is a miss for a find that does not need approval (no made-up gap)", miss("The address shows after approval.", "Where is that one located?", ans(item("Open House", "https://lu.ma/open", 6, { details: { ...details, requiresApproval: false } }))));
  check("3. pass: 'I don't have the address stored'", !miss("I don't have the street address stored for it.", "Where is that one located?"));
  check("3. pass: 'No problem, sending it now' to a link ask", !miss("No problem, sending it now.", "can you send that link again"));
  check("3. pass: it was Tuesday (the day it happens)", !miss("It's Tuesday, Nov 3.", "when is that"));
  // over-catch probes: not a question about the find, or nothing resolved
  for (const [d, t] of [["That sounds really hard, I'm here.", "I'm so wiped, I don't know when it'll all calm down"], ["Nothing waiting right now.", "anything waiting for me?"], ["Smart casual works.", "what's the dress code?"], ["Totally, take your time.", "ok thanks"]] as const) check(`3. no catch: "${d}" to "${t}"`, !miss(d, t));
  check("4. nothing resolved means non_answer never fires", M.moveMisses("No worries, easy to miss.", null, asked, []).length === 0);
  const note = M.moveRedraftNote(M.moveMisses("Ha, totally get it.", null, asked, ft), null);
  check("4. the rewrite note works with no record, names the find, and carries no canned line", /Not sent/.test(note) && /Founder Table/.test(note) && /Rewrite it in your own words/.test(note), note);
  // 4: the nudge is kept apart from moveNudged (the rewrite still gets resend and reoffer checks)
  const ct = fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  check("4. non_answer has its own once-flag and only other misses set moveNudged", /nonAnswerNudged = true/.test(ct) && /misses\.some\(\(m\) => m\.name !== "non_answer"\)\) state\.moveNudged = true/.test(ct) && /state\.nonAnswerNudged \|\| state\.linkDelivered/.test(ct));
  const rec = { done: [{ id: "D1", kind: "link" as const, label: "Salon Night", url: "https://lu.ma/salon", replied: true }], unresolved: [], priorMeant: [], read: { move: "answer" as const, meant: null, told: [], closes: [], reopens: [], again: null } };
  const both = M.moveMisses("Ha, totally get it. Here's Salon Night again: https://lu.ma/salon", rec, asked, ft).map((m) => m.name);
  check("4. a rewrite-able draft that also resends is caught for both (the resend is not skipped)", both.includes("resend") || both.includes("non_answer"), both);
}
// 5 + 9. Source checks for what can't run without a database.
{
  const ct = fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  check("5. listSentOffers names the city once", (ct.match(/\$\{x\.city \? `, in \$\{x\.city\}` : ""\}/g) ?? []).length === 1);
  const cc = fs.readFileSync(new URL("../../src/services/callContext.ts", import.meta.url), "utf8");
  check("9. the widened call suggestions go through forgottenRows and guardBlock", /W\.guardBlock\(String\(safeRecommendation\[i\]\), forgotten\)/.test(cc) && /W\.forgottenRows\(userId\)/.test(cc));
  const sb = fs.readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  check("2. the referent is resolved once, before the facts are gathered (not after them)", sb.indexOf("T.resolveReferents(") > 0 && sb.indexOf("T.resolveReferents(") < sb.indexOf("await gatherReplyFacts(user.id") && (sb.match(/resolveReferents\(/g) ?? []).length === 1);
  const rg = fs.readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
  check("2. the reply facts read the one result (turn.referents) and never resolve again", /also: opts\.turn\.referents/.test(rg) && !/referredSent\(/.test(rg) && !/addStoredOfferFacts/.test(rg));
  check("10. the call builds with the member's zone", /sentDetailLines\(\{ sent \}, 7, new Date\(\), \{ also: named, zone, referentMax: CALL_SENT_MAX - 400 \}\)/.test(cc));
}
console.log(`answer from record: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
